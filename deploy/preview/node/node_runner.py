#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Entry point for lolly-preview-deploy.service on the node.

    node_runner.py run REQUEST        ExecStart: one deploy, rollback, conversion or gc run
    node_runner.py stop-post REQUEST  ExecStopPost: roll back a switch the run did not verify

It runs from the uploaded, lock-pinned tool bundle and imports Work's
scripts/app-update.py from that same bundle.
"""

import sys

sys.dont_write_bytecode = True
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))

import preview_node  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(preview_node.main(sys.argv[1:], app_update_path=HERE.parent / "app-update.py"))
