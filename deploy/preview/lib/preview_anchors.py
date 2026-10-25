# SPDX-License-Identifier: MPL-2.0
"""Trust anchors for the preview deploy command.

Everything that decides WHAT may be deployed lives here, in reviewed code, and
never in the private instance profile: the repositories, workflow paths, image
package, receipt artifact name, signing pin, served origins and resource names.
The profile carries only instance identifiers (UIDs, SSH route), page lists and
thresholds. A changed anchor is a reviewed pull request plus a new tool lock.
"""

from __future__ import annotations

# lolly.tools (Phase 1b). Preview builds use their own workflow, package and key.
TOOLS = {
    "site": "lolly.tools",
    "repository": "lolly-tools/lolly",
    "buildWorkflowFile": "preview-web.yml",
    "buildWorkflowPath": ".github/workflows/preview-web.yml",
    "ciWorkflowFile": "ci.yml",
    "ciWorkflowPath": ".github/workflows/ci.yml",
    "branch": "main",
    "buildRunTitle": "Preview web {sha}",
    "buildSourceInput": "source",
    "receiptArtifactPrefix": "preview-web-receipts-attempt-",
    "imageRepository": "ghcr.io/lolly-tools/lolly-web-preview",
    "registryHost": "ghcr.io",
    "registryName": "lolly-tools/lolly-web-preview",
    "profile": "lolly-demo",
    "receiptTarget": "web",
    "origin": "https://lolly.tools",
    "host": "lolly.tools",
    "wwwOrigin": "https://www.lolly.tools",
    "namespace": "lolly-public",
    "deployment": "sovereign-web",
    "container": "web",
    "component": "public-web",
    "requiredLabels": {"app.kubernetes.io/component": "web", "app.kubernetes.io/instance": "sovereign",
                       "app.kubernetes.io/name": "lolly-sovereign"},
    # check-target.py (patched with --site) names the identities this Deployment is checked against.
    "checkTargetDeployment": "lolly-public/sovereign-web",
    "forbiddenIdPrefix": "suse",
    # Files read from the source commit. Their paths are part of the contract.
    "securityHeadersPath": "deploy/docker/security-headers.conf",
    "nginxConfPath": "deploy/docker/nginx.conf",
    "deliveryMapsPath": "deploy/docker/delivery-maps.conf",
    "deliveryHeadersPath": "deploy/docker/delivery-headers.conf",
    "modelsManifestPath": "shells/web/models-manifest.json",
    "connectorOriginsVariable": "VITE_CONNECTOR_ORIGINS",
    # Volumes the one-time conversion removes (PROPOSAL 3.6), by volume name.
    "conversionVolumes": {"public-delivery": "persistentVolumeClaim", "nginx": "configMap"},
    "conversionMountCounts": {"public-delivery": 3, "nginx": 4},
    "modelsVolume": "models",
    "modelsMountPath": "/usr/share/nginx/html/models",
    "modelsReleaseAnnotation": "lolly.tools/models-release",
    "revisionHistoryLimit": 5,
}

# Only conversion, adoption and rollback may use the old release package.
TOOLS_LEGACY = dict(TOOLS, buildWorkflowFile="deployment-suse.yml",
                    buildWorkflowPath=".github/workflows/deployment-suse.yml",
                    receiptArtifactPrefix="public-candidate-web-receipts-attempt-",
                    imageRepository="ghcr.io/lolly-tools/lolly-web", registryName="lolly-tools/lolly-web")
TOOLS_LEGACY.pop("buildRunTitle")
TOOLS_LEGACY.pop("buildSourceInput")

# lolly.ing (Phase 2, PROPOSAL section 4). One private instance image holds the Work
# server, the SUSE shell and the pack. suse-lolly's private lolly-ing-preview.yml builds
# and signs it (two approvals of lolly-ing-signing per build), and the Mac streams it to
# the node; no registry credential is ever on the node. The deploy input is a Work commit:
# its engine pin names the Lolly commit, and suse-lolly is built at its main head.
ING = {
    "site": "lolly.ing",
    "repository": "lolly-tools/suse-lolly",
    "buildWorkflowFile": "lolly-ing-preview.yml",
    "buildWorkflowPath": ".github/workflows/lolly-ing-preview.yml",
    "buildEvents": ("workflow_dispatch",),
    "branch": "main",
    "workRepository": "lolly-tools/lolly-work",
    "lollyRepository": "lolly-tools/lolly",
    "manifestKind": "lolly-ing-instance-image",
    "manifestArtifact": "lolly-ing-instance-manifest",
    "manifestFile": "lolly-ing-instance.manifest.json",
    "archiveArtifact": "lolly-ing-instance-archive",
    # lolly-ing-instance-<run id>-<attempt>.oci.tar, written by `docker save` (OCI layout).
    "archivePattern": r"lolly-ing-instance-{run}-{attempt}\.oci\.tar",
    # The tag the workflow builds; ctr import --base-name keeps it, and --digests adds <name>@<digest>.
    "refNamePattern": "docker.io/library/lolly-ing-instance:run-{run}-{attempt}",
    # A maintenance migration needs an approval of this environment in the same run (R20 S7).
    "maintenanceEnvironment": "lolly-ing-maintenance",
    "receiptProfile": "suse",
    "receiptTarget": "web",
    # First-party repositories whose changes are listed before a switch (R21 R3).
    "sourceRepositories": {"suse": "lolly-tools/suse-lolly", "work": "lolly-tools/lolly-work", "lolly": "lolly-tools/lolly"},
    "imageName": "docker.io/library/lolly-ing-instance",
    "imageRepository": "docker.io/library/lolly-ing-instance",  # the same name, for the shared retention code
    "origin": "https://lolly.ing",
    "host": "lolly.ing",
    "wwwOrigin": "https://www.lolly.ing",
    "instanceName": "lolly.ing",
    "namespace": "lolly-private",
    "deployment": "lolly-work",
    "container": "server",
    "component": "work",
    "requiredLabels": {"app.kubernetes.io/instance": "lolly-work", "app.kubernetes.io/name": "lolly-work"},
    "checkTargetDeployment": "lolly-private/lolly-work",
    # instance.json, mounted from an immutable ConfigMap per generation.
    "configVolume": "config",
    "configKey": "instance.json",
    "configMountPath": "/app/instance.json",
    "generationPath": ("instance", "catalogPublicationGeneration"),
    "configNamePrefix": "lolly-ing-config-",
    # The one-time cut-over (PROPOSAL 4.8) drops these claim and pin mounts.
    "conversionVolumes": {"pack": "persistentVolumeClaim", "shell": "persistentVolumeClaim", "engine-pin": "configMap"},
    "conversionMountPaths": {"pack": "/app/packs/lolly-ing", "shell": "/app/shell", "engine-pin": "/app/engine-pin.json"},
    # Volumes a Job from the instance image may copy from the server: ConfigMaps only, never a Secret.
    "jobConfigMapVolumes": ("postgres-ca", "tmp"),
    "databaseEnv": ("DATABASE_URL", "DATABASE_URL_UNPOOLED"),
    "backupCronJob": "lolly-postgres-offhost-backup",
    "backupContainer": "encrypt-upload-verify",
    "backupObjectPattern": r"lolly-ing/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]{12,16}Z-[a-f0-9]{16}\.lwbackup",
    "backupMaxBytes": 128 * 1024 * 1024,  # the restore rehearsal's own bound (#208)
    # The restore rehearsal (deploy/preview/restore-rehearsal.py, lib/preview_rehearsal.py) runs in its own namespace.
    "rehearsalNamespace": "lolly-restore-rehearsal",
    "rehearsalSecret": "restore-rehearsal-backup-read",
    # The PostgreSQL 18 image the live database runs (Work deploy/suse/appco-postgresql.lock.json).
    "postgresImage": "dp.apps.rancher.io/containers/postgresql@sha256:24210933acadcefb3775a122818d5d3b888fe5b2687eaa5b0e0867bd82a211d6",
    "jobPodLabels": {"app.kubernetes.io/part-of": "lolly-work", "app.kubernetes.io/component": "preview-migrate",
                     "lolly.tools/managed-by": "preview-deploy"},
    "revisionHistoryLimit": 10,
}

# Work's migration classifier (lolly-work PR #207), run from the instance image with
# `--only <pending>`; it prints one JSON document. The runner honours LW_MIGRATE_EXPECT.
MIGRATION_CLASSIFIER = ("node", "scripts/classify-migrations.ts", "--json", "--only")
MIGRATION_RUNNER = ("node", "scripts/migrate.ts")
MIGRATION_LOCK_BUDGET_SECONDS = 30
# Byte for byte server/src/store/migrate.ts migrationManifest and preview_rehearsal.migration_manifest.
MIGRATION_MANIFEST_HEADER = "lolly-work migration manifest v1\n"
REHEARSAL_DEADLINE_SECONDS = 900

# lolly.ing's own catalog key (PROPOSAL 4.7). Generated at the Phase 2 cut-over; it is
# pinned here in a reviewed change. Until then every lolly.ing run refuses.
ING_PUBLIC_KEY_JWK = None
# GitHub logins whose approval in the private run admits a maintenance migration.
# Andy's own login once agents have their own account (decision 3). Empty refuses all.
ING_MAINTENANCE_APPROVERS = ()
ING_ARCHIVE_MAX_BYTES = 6 * 1024 ** 3
# The smoke account's session cookie: a root-only file on the node, never printed.
NODE_ING_SMOKE_COOKIE = "/etc/lolly-preview/lolly.ing-smoke-session"
NODE_SPOOL_DIR = "/var/lib/lolly-preview/spool"

# Lolly's release catalog pin, LOLLY_RELEASE_PUBLIC_KEY_JWK in lolly-tools/lolly.
# Kept for old-image rollback and for lolly.ing to refuse the release key.
RELEASE_PUBLIC_KEY_JWK = {
    "kty": "EC",
    "crv": "P-256",
    "x": "fHdyfof2ppicYg3eoDbeNxdnxjbt9KhBLsjVGso6eqo",
    "y": "SWK6wsAVjRAad2w8MxmIkTGdgNMFHhhSNdeEqfH5cVg",
}
RELEASE_PUBLIC_KEY_THUMBPRINT = "5zVngG6s-652_L8Zdok5PTfQ6vxdPAYfcpBWxMtzs5c"

# Andy's lolly.tools preview key (generated 2026-10-25, private half only in the
# preview-catalog-signing environment of lolly-tools/lolly), LOLLY_PREVIEW_PUBLIC_KEY_JWK.
PREVIEW_PUBLIC_KEY_JWK = {
    "kty": "EC",
    "crv": "P-256",
    "x": "IeLSk-4i--bwu4VU0lZerw6m-RtnUN5kb1aUVBSfHnU",
    "y": "w6mzJvJ7TogpxQMuysRzB7533aKXg45YFX-0AzKx4Jo",
}
PREVIEW_PUBLIC_KEY_THUMBPRINT = "X3pjltp8_C-Swm8jOpPnv29qzQ2ZtLwqORMSHgMn-lk"


def preview_pin():
    from preview_common import require
    from preview_receipt import jwk_thumbprint, public_point
    require(isinstance(PREVIEW_PUBLIC_KEY_JWK, dict) and isinstance(PREVIEW_PUBLIC_KEY_THUMBPRINT, str),
            "PREVIEW_PIN_MISSING", "lolly.tools preview key is not pinned in the tool; nothing was changed")
    public_point(PREVIEW_PUBLIC_KEY_JWK)
    thumbprint = jwk_thumbprint(PREVIEW_PUBLIC_KEY_JWK)
    require(thumbprint != RELEASE_PUBLIC_KEY_THUMBPRINT and thumbprint != jwk_thumbprint(RELEASE_PUBLIC_KEY_JWK),
            "RELEASE_KEY", "lolly.tools preview builds need their own key, separate from the release key")
    require(thumbprint == PREVIEW_PUBLIC_KEY_THUMBPRINT, "PREVIEW_PIN_INVALID", "preview pin thumbprint differs")
    return PREVIEW_PUBLIC_KEY_JWK, thumbprint


def catalog_pin(thumbprint):
    """Resolve a recorded or requested thumbprint against the reviewed keys."""
    from preview_common import Refusal
    if thumbprint == RELEASE_PUBLIC_KEY_THUMBPRINT:
        return RELEASE_PUBLIC_KEY_JWK
    if PREVIEW_PUBLIC_KEY_THUMBPRINT is not None and thumbprint == PREVIEW_PUBLIC_KEY_THUMBPRINT:
        return preview_pin()[0]
    raise Refusal("CATALOG_PIN_INVALID", "catalog pin is neither anchored key")


# Shell stored formats (R21 R7). A manual rollback that lowers one is refused.
STORED_FORMATS = {
    "indexedDb": ("shells/web/src/bridge/db.ts", r"\bconst DB_VERSION = (\d+);"),
    "revisionArchive": ("shells/web/src/bridge/revision-archive-format.ts",
                        r"export interface RevisionArchive \{\s*version: (\d+);"),
    "channelMessage": ("shells/web/src/collab/join-route.ts", r"export const CHANNEL_MESSAGE_VERSION = (\d+);"),
    "session": ("engine/src/session-record.ts", r"export const SESSION_FORMAT_VERSION = (\d+);"),
}

# The edge (Caddy) sets these itself; today it sends the same values as the image.
# The smoke compares them with what the edge served before the switch, and the
# CSP exactly with the source (review C-M2).
EDGE_OWNED_HEADERS = ("Referrer-Policy", "X-Content-Type-Options", "Cross-Origin-Opener-Policy",
                      "Cross-Origin-Embedder-Policy", "Permissions-Policy")

# The private state directory: <...>/lolly-private/production/preview. check-target.py
# must be its parent's check-target.py (review S-H1).
STATE_DIR_SUFFIX = ("lolly-private", "production", "preview")
TOOL_REPOSITORY = "lolly-tools/lolly-work"

# Node-side fixed paths. Root-owned; the runner never takes them from input.
NODE_ROOT = "/var/lib/lolly-preview"
NODE_RUN_DIR = NODE_ROOT + "/run"
NODE_RESULTS_DIR = NODE_ROOT + "/results"
NODE_TMP_DIR = NODE_ROOT + "/tmp"
NODE_RETENTION_ARMED = NODE_ROOT + "/retention-armed"
NODE_UNIT = "lolly-preview-deploy.service"
NODE_UNIT_PATH = "/run/systemd/system/" + NODE_UNIT
NODE_LOCK_DIR = "/run/lolly-preview"  # root-owned 0700; never /run/lock, which others can write
NODE_LOCK = NODE_LOCK_DIR + "/deploy.lock"
NODE_START_LOCK = NODE_LOCK_DIR + "/start.lock"
NODE_SYSTEMCTL = "/usr/bin/systemctl"
NODE_IMAGE_FILESYSTEM = "/var/lib/rancher/k3s/agent/containerd"
PINNED_LABEL = "io.cri-containerd.pinned=pinned"
# Labels on images this command pulled or pinned itself. Retention never unpins or
# removes an image without them, so pins made by other procedures stay (review S-M1).
PULLED_LABEL = "lolly.tools/preview-pulled=true"
OWN_PIN_LABEL = "lolly.tools/preview-pin=true"

# Time budget of one unit run (review C-L1, S-L5). RuntimeMaxSec covers a pull, a
# switch, the smoke, the longest watch and a rollback with margin; ExecStopPost gets
# its own TimeoutStopSec for one rollback. tests/test_preview_deploy.py checks the
# unit file against these numbers.
PULL_TIMEOUT_SECONDS = 600
MAX_ROLLOUT_SECONDS = 600
MAX_WATCH_MINUTES = 15
SMOKE_BUDGET_SECONDS = 300
# crictl gives every CRI call a client deadline of 2 s unless --timeout is set. A pull is
# the exception: the CRI client never puts a deadline on it, so the subprocess timeout
# above bounds it. A large image can take longer than 2 s to remove; crictl then reports
# DeadlineExceeded while containerd finishes the removal anyway. So every crictl call
# passes --timeout, and a failed removal is checked by image ID before it is reported.
CRICTL_READ_TIMEOUT_SECONDS = 30
CRICTL_WRITE_TIMEOUT_SECONDS = 120  # rmi, and the connection of a pull
# The subprocess timeout is crictl's own deadline plus this, so crictl reports first.
CRICTL_SLACK_SECONDS = 30
# How long a failed removal is checked before it is reported as still present.
REMOVE_VERIFY_SECONDS = 60
# The longest one removal takes: crictl rmi, then the check, whose last read may start
# just before the check ends.
REMOVE_WORST_SECONDS = (CRICTL_WRITE_TIMEOUT_SECONDS + REMOVE_VERIFY_SECONDS + CRICTL_READ_TIMEOUT_SECONDS
                        + 2 * CRICTL_SLACK_SECONDS)
# Retention after an accepted deploy starts a removal only while this budget allows a
# whole one; images left over wait for the next deploy or gc.
RETENTION_AFTER_DEPLOY_SECONDS = REMOVE_WORST_SECONDS + 60
TOOLS_RUNTIME_MAX_SECONDS = (2 * PULL_TIMEOUT_SECONDS + 2 * MAX_ROLLOUT_SECONDS + MAX_WATCH_MINUTES * 60 + 3 * SMOKE_BUDGET_SECONDS
                             + RETENTION_AFTER_DEPLOY_SECONDS + 600)
# lolly.ing steps (PROPOSAL 4.3): import, backup, read-only checks, rehearsal, migrate Job.
ING_IMPORT_TIMEOUT_SECONDS = 900
JOB_TIMEOUT_SECONDS = 300
BACKUP_TIMEOUT_SECONDS = 660
REHEARSAL_TIMEOUT_SECONDS = 1500
MIGRATE_TIMEOUT_SECONDS = 900
BACKUP_MAX_AGE_SECONDS = 6 * 3600
MAINTENANCE_BACKUP_MAX_AGE_SECONDS = 3600
ING_ROLLBACK_SECONDS = MAX_ROLLOUT_SECONDS + SMOKE_BUDGET_SECONDS + JOB_TIMEOUT_SECONDS
ING_MIGRATION_SECONDS = JOB_TIMEOUT_SECONDS + REHEARSAL_TIMEOUT_SECONDS + MIGRATE_TIMEOUT_SECONDS + JOB_TIMEOUT_SECONDS
ING_RUNTIME_MAX_SECONDS = (ING_IMPORT_TIMEOUT_SECONDS + BACKUP_TIMEOUT_SECONDS + JOB_TIMEOUT_SECONDS + ING_MIGRATION_SECONDS
                           + MAX_ROLLOUT_SECONDS + SMOKE_BUDGET_SECONDS + JOB_TIMEOUT_SECONDS + MAX_WATCH_MINUTES * 60
                           + ING_ROLLBACK_SECONDS + RETENTION_AFTER_DEPLOY_SECONDS + 600)
# One unit serves both sites, so it gets the longer of the two budgets.
UNIT_RUNTIME_MAX_SECONDS = max(TOOLS_RUNTIME_MAX_SECONDS, ING_RUNTIME_MAX_SECONDS)
UNIT_STOP_TIMEOUT_SECONDS = PULL_TIMEOUT_SECONDS + MAX_ROLLOUT_SECONDS + SMOKE_BUDGET_SECONDS + 300

# Deployment metadata annotations written by the command. Metadata, not the Pod
# template, so writing them never starts a rollout.
ANNOTATION_PREFIX = "lolly.tools/preview-"
PHASES = ("switching", "switched-unverified", "accepted", "rolling-back", "rolled-back",
          "rollback-unhealthy", "aborted", "converting", "adopted-unhealthy", "maintenance-unverified",
          "maintenance-applied-unswitched")
UNCERTAIN_PHASES = ("switching", "switched-unverified", "rolling-back", "converting")
# Phases that stop every later run until a human passes --clear-hold.
# maintenance-unverified: a lolly.ing switch after a maintenance migration failed its smoke.
# Automatic rollback is off then (PROPOSAL 4.4), because recovery would be a restore.
# maintenance-applied-unswitched: a maintenance migration ran but no switch that includes it was accepted, so the
# old image runs on a schema it was not built for. The marker annotation stays until such a switch is accepted.
HOLD_PHASES = UNCERTAIN_PHASES + ("rollback-unhealthy", "adopted-unhealthy", "maintenance-unverified",
                                  "maintenance-applied-unswitched")
# Phases whose records describe the image that is live (review C-H2). `adopt` writes
# adopted-unhealthy when a human adopts a live build that fails its smoke (review N2).
# A lolly.ing switch held after a maintenance migration (maintenance-unverified) also describes the
# live image, so a forward fix can follow it with --clear-hold.
SETTLED_PHASES = ("accepted", "rolled-back", "aborted", "adopted-unhealthy", "maintenance-unverified",
                  "maintenance-applied-unswitched")
# The longest a gc run takes, for the backup-window check before it starts. Removals
# start only while a whole one still fits; the reads before them get the rest.
GC_BUDGET_SECONDS = 900
GC_REMOVE_BUDGET_SECONDS = GC_BUDGET_SECONDS - 300

SITES = {"lolly.tools": TOOLS, "lolly.ing": ING}


def site_anchors(site):
    from preview_common import Refusal
    if site not in SITES:
        raise Refusal("UNKNOWN_SITE", "site must be lolly.tools or lolly.ing")
    return SITES[site]
