#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""preview-deploy: ship one main commit to the lolly.tools preview, with smoke, watch and rollback.

Run it through lolly-private/production/preview/launch.py, which refuses a tool
tree whose hash differs from tool.lock.json. See deploy/preview/README.md.
"""

import sys

sys.dont_write_bytecode = True
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

import preview_mac  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(preview_mac.main(sys.argv[1:]))
