# SPDX-License-Identifier: MPL-2.0
"""Trust anchors for the preview deploy command.

Everything that decides WHAT may be deployed lives here, in reviewed code, and
never in the private instance profile: the repositories, workflow paths, image
package, receipt artifact name, signing pin, served origins and resource names.
The profile carries only instance identifiers (UIDs, SSH route), page lists and
thresholds. A changed anchor is a reviewed pull request plus a new tool lock.
"""

from __future__ import annotations

# lolly.tools (Phase 1). The build is the existing candidate workflow, unchanged.
TOOLS = {
    "site": "lolly.tools",
    "repository": "lolly-tools/lolly",
    "buildWorkflowFile": "deployment-suse.yml",
    "buildWorkflowPath": ".github/workflows/deployment-suse.yml",
    "ciWorkflowFile": "ci.yml",
    "ciWorkflowPath": ".github/workflows/ci.yml",
    "branch": "main",
    "receiptArtifactPrefix": "public-candidate-web-receipts-attempt-",
    "imageRepository": "ghcr.io/lolly-tools/lolly-web",
    "registryHost": "ghcr.io",
    "registryName": "lolly-tools/lolly-web",
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

# Lolly's release catalog pin, LOLLY_RELEASE_PUBLIC_KEY_JWK in lolly-tools/lolly.
# Phase 1 keeps the release key (decision 5). Phase 1b replaces this anchor with
# the preview key in a reviewed change.
RELEASE_PUBLIC_KEY_JWK = {
    "kty": "EC",
    "crv": "P-256",
    "x": "fHdyfof2ppicYg3eoDbeNxdnxjbt9KhBLsjVGso6eqo",
    "y": "SWK6wsAVjRAad2w8MxmIkTGdgNMFHhhSNdeEqfH5cVg",
}
RELEASE_PUBLIC_KEY_THUMBPRINT = "5zVngG6s-652_L8Zdok5PTfQ6vxdPAYfcpBWxMtzs5c"

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
UNIT_RUNTIME_MAX_SECONDS = 2 * PULL_TIMEOUT_SECONDS + 2 * MAX_ROLLOUT_SECONDS + MAX_WATCH_MINUTES * 60 + 3 * SMOKE_BUDGET_SECONDS + 600
UNIT_STOP_TIMEOUT_SECONDS = PULL_TIMEOUT_SECONDS + MAX_ROLLOUT_SECONDS + SMOKE_BUDGET_SECONDS + 300

# Deployment metadata annotations written by the command. Metadata, not the Pod
# template, so writing them never starts a rollout.
ANNOTATION_PREFIX = "lolly.tools/preview-"
PHASES = ("switching", "switched-unverified", "accepted", "rolling-back", "rolled-back",
          "rollback-unhealthy", "aborted", "converting")
UNCERTAIN_PHASES = ("switching", "switched-unverified", "rolling-back", "converting")
# Phases whose records describe the image that is live (review C-H2).
SETTLED_PHASES = ("accepted", "rolled-back", "aborted")

SITES = {"lolly.tools": TOOLS, "lolly.ing": None}

PHASE_2_MESSAGE = ("lolly.ing is Phase 2 of the preview fast-deploy design and is not built. "
                   "It needs the instance image, its own catalog key, the backup and migration "
                   "guard and the generation rule first. Nothing was changed.")


def site_anchors(site):
    from preview_common import Refusal
    if site not in SITES:
        raise Refusal("UNKNOWN_SITE", "site must be lolly.tools or lolly.ing")
    if SITES[site] is None:
        raise Refusal("SITE_PHASE_2", PHASE_2_MESSAGE)
    return SITES[site]
