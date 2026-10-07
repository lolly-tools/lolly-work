#!/usr/bin/env python3
"""Render an opt-in, suspended PostgreSQL/off-host backup CronJob. No credentials."""
import argparse
import json
import pathlib
import re
import sys


def image_ref(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}", value):
        raise argparse.ArgumentTypeError("image must be a repository@sha256:<64 lowercase hex characters>")
    return value


def resource_name(value):
    if len(value) > 63 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", value):
        raise argparse.ArgumentTypeError("resource name must be a DNS label of at most 63 characters")
    return value


def manifest(args):
    security = {
        "runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000,
        "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"},
    }
    container_security = {
        "allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
        "capabilities": {"drop": ["ALL"]},
    }
    dump_command = """set -euo pipefail
umask 077
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD
cp /run/postgres-backup/pg_service.conf /tmp/pg_service.conf
cp /run/postgres-backup/pgpass /tmp/pgpass
chmod 600 /tmp/pg_service.conf /tmp/pgpass
export PGSERVICEFILE=/tmp/pg_service.conf PGPASSFILE=/tmp/pgpass PGSERVICE=backup
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=300000 -c lock_timeout=5000'
export PGCONNECT_TIMEOUT=5
tls=''
# Service and NetworkPolicy convergence can briefly refuse a fresh pod's socket.
# Retry connections finitely; a connected, unencrypted session still fails closed.
for attempt in {1..10}; do
  if tls=$(PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' psql --no-password -X -qAt --set=ON_ERROR_STOP=1 --command='SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()' 2>/tmp/preflight.log); then break; fi
  if [ "$attempt" -lt 10 ]; then sleep 2; fi
done
if [ "$tls" != t ]; then printf '%s\\n' 'Database backup requires TLS.' >&2; exit 1; fi
if ! bash /operator/postgres-backup.sh backup /archive/database.dump >/tmp/backup.log 2>&1; then
  printf '%s\\n' 'Database snapshot or checksum failed.' >&2; exit 1
fi
printf '%s\\n' 'Private PostgreSQL snapshot and checksum prepared.'
"""
    pg = {
        "name": "database-snapshot", "image": args.pg_image,
        "imagePullPolicy": "IfNotPresent", "command": ["bash", "-c", dump_command],
        "securityContext": container_security,
        "resources": {
            "requests": {"cpu": "50m", "memory": "128Mi", "ephemeral-storage": "256Mi"},
            "limits": {"cpu": "1", "memory": "256Mi", "ephemeral-storage": "512Mi"},
        },
        "volumeMounts": [
            {"name": "database-connection", "mountPath": "/run/postgres-backup", "readOnly": True},
            {"name": "database-ca", "mountPath": "/etc/lolly/postgres", "readOnly": True},
            {"name": "dump-helper", "mountPath": "/operator", "readOnly": True},
            {"name": "archive", "mountPath": "/archive"},
            {"name": "dump-scratch", "mountPath": "/tmp"},
        ],
    }
    upload = {
        "name": "encrypt-upload-verify", "image": args.node_image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["node", "--max-old-space-size=128", "/operator/backup-object.mjs", "upload",
                    "--credentials", "/run/backup/storage.json",
                    "--key", "/run/backup/encryption-key.txt",
                    "--input", "/archive/database.dump"],
        "securityContext": container_security,
        "resources": {
            "requests": {"cpu": "50m", "memory": "256Mi", "ephemeral-storage": "256Mi"},
            "limits": {"cpu": "1", "memory": "768Mi", "ephemeral-storage": "512Mi"},
        },
        "volumeMounts": [
            {"name": "upload-credentials", "mountPath": "/run/backup", "readOnly": True},
            {"name": "upload-helper", "mountPath": "/operator", "readOnly": True},
            {"name": "archive", "mountPath": "/archive", "readOnly": True},
            {"name": "upload-scratch", "mountPath": "/tmp"},
        ],
    }
    labels = {"app.kubernetes.io/name": args.name, "app.kubernetes.io/component": "postgres-backup"}
    return {
        "apiVersion": "batch/v1", "kind": "CronJob",
        "metadata": {"name": args.name, "namespace": args.namespace},
        "spec": {
            "schedule": "0 2 * * *", "timeZone": "Etc/UTC", "suspend": True,
            "concurrencyPolicy": "Forbid", "startingDeadlineSeconds": 300,
            "successfulJobsHistoryLimit": 1, "failedJobsHistoryLimit": 2,
            "jobTemplate": {"spec": {
                "backoffLimit": 0, "activeDeadlineSeconds": 600, "ttlSecondsAfterFinished": 86400,
                "template": {"metadata": {"labels": labels}, "spec": {
                    "restartPolicy": "Never", "automountServiceAccountToken": False,
                    "securityContext": security,
                    "imagePullSecrets": [{"name": args.pull_secret}],
                    "initContainers": [pg], "containers": [upload],
                    "volumes": [
                        {"name": "archive", "emptyDir": {"sizeLimit": "256Mi"}},
                        {"name": "dump-scratch", "emptyDir": {"sizeLimit": "32Mi"}},
                        {"name": "upload-scratch", "emptyDir": {"sizeLimit": "32Mi"}},
                        {"name": "database-connection", "secret": {
                            "secretName": args.connection_secret, "defaultMode": 0o440}},
                        {"name": "database-ca", "configMap": {"name": args.ca_configmap}},
                        {"name": "upload-credentials", "secret": {
                            "secretName": args.upload_secret, "defaultMode": 0o440}},
                        {"name": "dump-helper", "configMap": {"name": args.helper_configmap,
                            "items": [{"key": "postgres-backup.sh", "path": "postgres-backup.sh"}]}},
                        {"name": "upload-helper", "configMap": {"name": args.helper_configmap,
                            "items": [{"key": "backup-object.mjs", "path": "backup-object.mjs"}]}},
                    ],
                }},
            }},
        },
    }


def main():
    lock = json.loads((pathlib.Path(__file__).resolve().parent / "appco-postgresql.lock.json").read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-image", required=True, type=image_ref)
    parser.add_argument("--pg-image", type=image_ref, default=lock["image"]["repository"] + "@" + lock["image"]["digest"])
    for option, default in [
        ("namespace", "lolly-private"), ("name", "lolly-postgres-offhost-backup"),
        ("pull-secret", "application-collection"),
        ("connection-secret", "lolly-postgres-backup-connection"),
        ("upload-secret", "lolly-backup-upload"), ("ca-configmap", "lolly-postgres-ca"),
        ("helper-configmap", "lolly-backup-operator"),
    ]:
        parser.add_argument("--" + option, type=resource_name, default=default)
    json.dump(manifest(parser.parse_args()), sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
