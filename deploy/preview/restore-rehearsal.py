#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Restore rehearsal operator: restore a backup into a throwaway PostgreSQL Pod,
apply the pending migrations with the new image's runner, check what it applied and
the lock budget, boot the previous image on the result for one save round trip,
and delete everything. See deploy/preview/REHEARSAL.md.

  restore-rehearsal.py setup --egress-cidr CIDR [...]       print the one-time namespace objects (applies nothing)
  restore-rehearsal.py plan  <run options>                  print one run's ConfigMap and Pod (contacts nothing)
  restore-rehearsal.py run   <run options> --kubectl ARGV --on-production-host
                                                            run one rehearsal; print the result as JSON
  restore-rehearsal.py cleanup --kubectl ARGV --on-production-host
                                                            remove what a crashed run left

`run` and `cleanup` create or delete workloads on the production K3s node. They refuse without
--on-production-host and run `check-target.py --site lolly.ing` first (--check-target overrides the path).

Run options:
  --backup FILE            the backup uploader's VERIFIED result line (JSON)
  --pending FILE|none      the pending migration files, JSON [{"name", "sha256"}], or none
  --new-image REF          the Work image to deploy (repository@sha256:...)
  --previous-image REF     the Work image live now (repository@sha256:...)
  --postgres-image REF     the PostgreSQL 18 image the live database runs (repository@sha256:...)
  --storage-host HOST      the backup store's host name, as in the backup credential
  --storage-address IP     its address, inside the namespace's egress rule (a public host, never private space)
  --lock-budget SECONDS    per file, 1-30; more needs --allow-long-lock-budget (recorded in the result)

Exit status: 0 passed, 1 failed, 2 refused or bad input, 3 passed or failed but
something it created is still present.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

import preview_rehearsal as R  # noqa: E402
from preview_common import Refusal, strict_json  # noqa: E402

LIMIT = 1024 * 1024


def read_json(path, label):
    data = Path(path).read_bytes()
    if len(data) > LIMIT:
        raise Refusal("BAD_INPUT", f"{label} is larger than 1 MiB")
    return strict_json(data.decode("utf-8"), label)


def inputs_from(args):
    pending = [] if args.pending == "none" else read_json(args.pending, "pending files")
    return R.Inputs(backup=read_json(args.backup, "backup record"), pending=pending, new_image=args.new_image,
                    previous_image=args.previous_image, postgres_image=args.postgres_image,
                    storage_host=args.storage_host, storage_address=args.storage_address, namespace=args.namespace,
                    secret=args.secret, run_id=args.run_id, lock_budget_seconds=args.lock_budget,
                    deadline_seconds=args.deadline, pgdata_size=args.pgdata_size, pull_secret=args.pull_secret,
                    lock_budget_override=args.allow_long_lock_budget)


def kubectl_from(text):
    try:
        argv = json.loads(text)
    except ValueError as exc:
        raise Refusal("BAD_INPUT", "--kubectl must be a JSON array, e.g. [\"/usr/local/bin/k3s\", \"kubectl\"]") from exc
    return R.Kubectl(argv)


def production_flags(parser):
    parser.add_argument("--on-production-host", action="store_true",
                        help="confirm this creates workloads on the production K3s node")
    parser.add_argument("--check-target", default=R.CHECK_TARGET_DEFAULT,
                        help="lolly-private/production/check-target.py (default: %(default)s)")


def require_production(args):
    if not args.on_production_host:
        raise Refusal("PRODUCTION_HOST_FLAG", f"`{args.command}` creates or deletes workloads on the production K3s node; "
                      "pass --on-production-host to confirm")
    return R.production_preflight(args.check_target)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Restore rehearsal operator", allow_abbrev=False)
    sub = parser.add_subparsers(dest="command", required=True)
    setup = sub.add_parser("setup", allow_abbrev=False)
    setup.add_argument("--namespace", default=R.NAMESPACE)
    setup.add_argument("--secret", default=R.SECRET)
    setup.add_argument("--egress-cidr", action="append", required=True)
    for name in ("plan", "run"):
        p = sub.add_parser(name, allow_abbrev=False)
        p.add_argument("--backup", required=True)
        p.add_argument("--pending", required=True)
        p.add_argument("--new-image", required=True)
        p.add_argument("--previous-image", required=True)
        p.add_argument("--postgres-image", required=True)
        p.add_argument("--storage-host", required=True)
        p.add_argument("--storage-address", required=True)
        p.add_argument("--namespace", default=R.NAMESPACE)
        p.add_argument("--secret", default=R.SECRET)
        p.add_argument("--pull-secret")
        p.add_argument("--run-id")
        p.add_argument("--lock-budget", type=int, default=R.LOCK_BUDGET_SECONDS)
        p.add_argument("--deadline", type=int, default=R.DEADLINE_SECONDS)
        p.add_argument("--pgdata-size", default="4Gi")
        p.add_argument("--allow-long-lock-budget", action="store_true",
                       help=f"allow --lock-budget above {R.LOCK_BUDGET_SECONDS}; the override is recorded")
        if name == "run":
            p.add_argument("--kubectl", required=True)
            production_flags(p)
    clean = sub.add_parser("cleanup", allow_abbrev=False)
    clean.add_argument("--namespace", default=R.NAMESPACE)
    clean.add_argument("--kubectl", required=True)
    production_flags(clean)
    args = parser.parse_args(argv)
    try:
        if args.command == "setup":
            print(json.dumps(R.setup_manifests(args.namespace, args.egress_cidr, args.secret), indent=2))
            print(f"Then create Secret {args.secret} in {args.namespace} by hand with the read-only backup "
                  "credential (storage.json, encryption-key.txt); see REHEARSAL.md.", file=sys.stderr)
            return 0
        if args.command == "cleanup":
            require_production(args)
            print(json.dumps({"result": "CLEANED", "removed": R.cleanup(kubectl_from(args.kubectl), args.namespace)}, indent=2))
            return 0
        inputs = inputs_from(args)
        if args.command == "plan":
            config_map, pod = R.run_manifests(inputs, R.read_programs())
            print(json.dumps({"apiVersion": "v1", "kind": "List", "items": [config_map, pod]}, indent=2))
            return 0
        preflight = require_production(args)
        result = R.Rehearsal(kubectl_from(args.kubectl), inputs).run()
        result["productionPreflight"] = preflight
    except Refusal as refusal:
        print(json.dumps({"result": "REFUSED", "code": refusal.code, "reason": refusal.message}))
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result.get("teardownComplete"):
        return 3
    return {"PASSED": 0, "FAILED": 1}.get(result["result"], 2)


if __name__ == "__main__":
    sys.exit(main())
