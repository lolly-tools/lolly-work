# SPDX-License-Identifier: MPL-2.0
# Program the preview deploy command sends to the node over SSH as
# `sudo -n python3 -`, with one JSON payload appended by the command. It must
# stay importable by older Pythons long enough to refuse them, so it uses no
# syntax newer than Python 3.6. It never prints Kubernetes objects or secrets.
import sys

# The program arrives on stdin, so the working directory would lead sys.path.
# Drop it before any other import, so no file in the SSH user's home is loaded.
sys.path[:] = [entry for entry in sys.path if entry not in ("", ".")]
sys.dont_write_bytecode = True

import base64  # noqa: E402
import fcntl  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import tarfile  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

ROOT = "/var/lib/lolly-preview"
RUN = ROOT + "/run"
RESULTS = ROOT + "/results"
TMP = ROOT + "/tmp"
UNIT = "lolly-preview-deploy.service"
UNIT_PATH = "/run/systemd/system/" + UNIT
LOCK_DIR = "/run/lolly-preview"
LOCK = LOCK_DIR + "/deploy.lock"
START_LOCK = LOCK_DIR + "/start.lock"
SYSTEMCTL = "/usr/bin/systemctl"
BUSY = ("active", "activating", "deactivating", "reloading", "refreshing")
DEPLOY_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}\Z")


def out(value):
    sys.stdout.write(json.dumps(value, sort_keys=True) + "\n")
    sys.stdout.flush()


def refuse(code, message):
    out({"result": "REFUSED", "code": code, "reason": message})
    sys.exit(0)


def unpack(bundle, destination):
    """Extract regular files and directories only; no links, devices or paths outside."""
    data = base64.b64decode(bundle)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            name = member.name
            if name.startswith("/") or ".." in name.split("/") or not (member.isfile() or member.isdir()):
                refuse("BAD_BUNDLE", "the tool bundle holds an unsafe entry")
            target = os.path.join(destination, name)
            if member.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            source = archive.extractfile(member)
            with open(target, "wb") as handle:
                handle.write(source.read())
            os.chmod(target, 0o500 if member.mode & 0o100 else 0o400)


def unit_property(name):
    done = subprocess.run([SYSTEMCTL, "show", "-p", name, "--value", UNIT],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    return done.stdout.decode().strip()


def unit_state():
    return unit_property("ActiveState")


def deploy_id(value):
    if not isinstance(value, str) or not DEPLOY_ID.match(value):
        refuse("BAD_REQUEST", "deploy id is malformed")
    return value


def lock_dir():
    """Root-owned 0700, never a symbolic link; /run/lock is writable by others."""
    os.makedirs(LOCK_DIR, mode=0o700, exist_ok=True)
    info = os.lstat(LOCK_DIR)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        refuse("LOCK_UNSAFE", "the lock directory is not private to root")


def open_lock(path):
    return os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)


def lock_free(path):
    descriptor = open_lock(path)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    finally:
        os.close(descriptor)
    return True


def start(payload):
    request = payload["request"]
    identifier = deploy_id(request.get("deployId"))
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    for directory in (RESULTS, TMP):
        os.makedirs(directory, mode=0o700, exist_ok=True)
    lock_dir()
    gate = open_lock(START_LOCK)
    try:
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        refuse("LOCK_HELD", "another preview command is starting a run")
    state = unit_state()
    if state in BUSY or unit_property("Job"):
        refuse("LOCK_HELD", "lolly-preview-deploy.service is " + (state if state in BUSY else "queued"))
    if not lock_free(LOCK):
        refuse("LOCK_HELD", "the node lock is held by a manual change")
    if os.path.exists(os.path.join(RESULTS, identifier + ".json")):
        refuse("DUPLICATE_RUN", "this deploy id already ran")
    previous_request = RUN + "/request.json"
    if os.path.exists(previous_request):
        # Never delete a run's request: keep it beside its result for the record.
        with open(previous_request) as handle:
            earlier = deploy_id(json.load(handle).get("deployId"))
        shutil.copyfile(previous_request, os.path.join(RESULTS, earlier + ".request.json"))
    if os.path.isdir(RUN):
        shutil.rmtree(RUN)
    os.makedirs(RUN, mode=0o700)
    unpack(payload["bundle"], RUN + "/tool")
    descriptor = os.open(RUN + "/request.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(request, handle, sort_keys=True)
    shutil.copyfile(RUN + "/tool/node/" + UNIT, UNIT_PATH + ".tmp")
    os.chmod(UNIT_PATH + ".tmp", 0o644)
    os.replace(UNIT_PATH + ".tmp", UNIT_PATH)
    subprocess.run([SYSTEMCTL, "daemon-reload"], check=True, timeout=60)
    subprocess.run([SYSTEMCTL, "reset-failed", UNIT], stderr=subprocess.DEVNULL, timeout=30)
    subprocess.run([SYSTEMCTL, "start", "--no-block", UNIT], check=True, timeout=60)
    deadline = time.monotonic() + 30
    while unit_state() == "inactive" and not os.path.exists(os.path.join(RESULTS, identifier + ".json")):
        if time.monotonic() > deadline:
            refuse("NOT_STARTED", "the unit did not start within 30 seconds; inspect with status")
        time.sleep(0.5)
    out({"result": "STARTED", "deployId": identifier})


def poll(payload):
    identifier, offset = deploy_id(payload.get("deployId")), int(payload.get("offset", 0))
    lines, size = [], offset
    progress = RUN + "/progress.jsonl"
    current = None
    request_path = RUN + "/request.json"
    if os.path.exists(request_path):
        with open(request_path) as handle:
            current = json.load(handle).get("deployId")
    if current == identifier and os.path.exists(progress):
        with open(progress, "rb") as handle:
            handle.seek(offset)
            chunk = handle.read(262144)
        size = offset + len(chunk)
        lines = [line for line in chunk.decode("utf-8", "replace").splitlines() if line]
    result = None
    result_path = os.path.join(RESULTS, identifier + ".json")
    if os.path.exists(result_path):
        with open(result_path) as handle:
            result = json.load(handle)
    out({"unit": unit_state(), "progress": lines, "offset": size, "result": result, "current": current})


def read(payload):
    os.makedirs(TMP, mode=0o700, exist_ok=True)
    work = tempfile.mkdtemp(dir=TMP)
    try:
        unpack(payload["bundle"], work)
        sys.path.insert(0, os.path.join(work, "lib"))
        import preview_node  # noqa: E402
        au = preview_node.load_app_update(os.path.join(work, "app-update.py"))
        out({"result": "OK", "data": preview_node.read(payload["query"], au)})
    except Exception as exc:  # report the reason code only
        out({"result": "REFUSED", "code": getattr(exc, "code", type(exc).__name__),
             "reason": getattr(exc, "message", "read failed")})
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(payload):
    if sys.version_info < (3, 9):
        refuse("NODE_PYTHON_TOO_OLD", "the node needs Python 3.9 or newer")
    if os.geteuid() != 0:
        refuse("NOT_ROOT", "run through sudo")
    os.chdir("/")
    action = payload.get("action")
    if action == "start":
        start(payload)
    elif action == "poll":
        poll(payload)
    elif action == "read":
        read(payload)
    else:
        refuse("BAD_REQUEST", "unknown action")
