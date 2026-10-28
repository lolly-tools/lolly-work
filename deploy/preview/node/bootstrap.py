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
import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import tarfile  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import zipfile  # noqa: E402
import zlib  # noqa: E402

ROOT = "/var/lib/lolly-preview"
RUN = ROOT + "/run"
RESULTS = ROOT + "/results"
TMP = ROOT + "/tmp"
UNIT = "lolly-preview-deploy.service"
UNIT_PATH = "/run/systemd/system/" + UNIT
LOCK_DIR = "/run/lolly-preview"
LOCK = LOCK_DIR + "/deploy.lock"
START_LOCK = LOCK_DIR + "/start.lock"
SPOOL = ROOT + "/spool"
MAX_ARCHIVE = 6 * 1024 ** 3
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MIB = 1024 * 1024
SYSTEMCTL = "/usr/bin/systemctl"
BUSY = ("active", "activating", "deactivating", "reloading", "refreshing")
DEPLOY_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}\Z")
# The fetch: GitHub keeps run artifacts in Azure Blob Storage and hands out a signed download address that expires a
# minute after it is issued. Four ranges in parallel measured 33 MB/s on the preview node (2026-10-28); one ran at 8.
ARTIFACT_HOST = re.compile(r"[a-z0-9]{3,24}\.blob\.core\.windows\.net\Z")
ARCHIVE_NAME = re.compile(r"lolly-ing-instance-[0-9]{1,20}-[0-9]{1,4}\.oci\.tar\Z")
FETCH_PARTS = 4
FETCH_SECONDS = 900
FETCH_READ_SECONDS = 60


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


def above_reserve(path):
    """Bytes free above the image-GC reserve (total // 4 + 512 MiB) on the filesystem holding path."""
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize - (info.f_blocks * info.f_frsize // 4 + 512 * MIB)


def claim_spool(header, extra=0):
    """The checks the upload and the fetch share. The start lock is held until the process ends, so no run starts
    while an archive is arriving. Returns the spooled file's path, or None after printing ALREADY_UPLOADED."""
    sha, size = header.get("sha256"), header.get("bytes")
    if not isinstance(sha, str) or not HEX64.match(sha) or type(size) is not int or not 0 < size <= MAX_ARCHIVE:
        refuse("BAD_REQUEST", "the archive header is malformed")
    deploy_id(header.get("deployId"))
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    lock_dir()
    gate = open_lock(START_LOCK)
    try:
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        refuse("LOCK_HELD", "another preview command is starting a run")
    if unit_state() in BUSY:
        refuse("LOCK_HELD", "a preview run is active; upload after it ends")
    os.makedirs(SPOOL, mode=0o700, exist_ok=True)
    info = os.lstat(SPOOL)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        refuse("SPOOL_UNSAFE", "the spool directory is not private to root")
    final = SPOOL + "/" + sha + ".oci.tar"
    if os.path.lexists(final):
        found = os.lstat(final)
        if stat.S_ISREG(found.st_mode) and found.st_size == size:
            out({"result": "ALREADY_UPLOADED", "sha256": sha, "bytes": size})
            return None
        refuse("SPOOL_UNSAFE", "a spooled file of that name is not the expected archive")
    if above_reserve(SPOOL) < 2 * size + extra:
        refuse("LOW_CAPACITY", "not enough space above the image-GC reserve for the archive and its import; run gc")
    return final


def upload(header):
    """Receive one instance-image archive on stdin into the root-only spool (PROPOSAL 4.3 step 3).

    The bytes are hashed while they are written. A wrong size or sha256 deletes the
    partial file. The unit hashes the spooled file again before ctr imports it.
    """
    if sys.version_info < (3, 9):
        refuse("NODE_PYTHON_TOO_OLD", "the node needs Python 3.9 or newer")
    if os.geteuid() != 0:
        refuse("NOT_ROOT", "run through sudo")
    os.chdir("/")
    final = claim_spool(header)
    if final is None:
        return
    sha, size = header["sha256"], header["bytes"]
    partial = SPOOL + "/" + sha + ".partial"
    if os.path.lexists(partial):
        os.unlink(partial)
    descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    digest, received, stream = hashlib.sha256(), 0, sys.stdin.buffer
    try:
        while received <= size:
            chunk = stream.read(min(MIB, size + 1 - received))
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(descriptor, view):]
            received += len(chunk)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if received != size or digest.hexdigest() != sha:
        os.unlink(partial)
        refuse("ARCHIVE_MISMATCH", "the received archive does not match its manifest; it was deleted")
    os.rename(partial, final)
    out({"result": "UPLOADED", "sha256": sha, "bytes": size})


def artifact_address(url):
    """An https address on GitHub's artifact store, with no user, password or other port."""
    import urllib.parse
    if not isinstance(url, str) or len(url) > 4096 or not url.isprintable() or " " in url:
        return False
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return parts.scheme == "https" and parts.username is None and parts.password is None and port in (None, 443) \
        and ARTIFACT_HOST.match(parts.hostname or "") is not None


def open_range(url, first, last):
    """GET bytes first..last of the artifact. A redirect is refused, not followed. The tests replace this function."""
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    request = urllib.request.Request(url, headers={"Range": "bytes=%d-%d" % (first, last), "User-Agent": "lolly-preview"})
    return urllib.request.build_opener(NoRedirect).open(request, timeout=FETCH_READ_SECONDS)


def fetch_range(url, descriptor, first, last, total, deadline, failures):
    """Download one range into its place in the zip. A failure is recorded by kind only: an error message could
    carry the signed address."""
    try:
        response = open_range(url, first, last)
        try:
            if getattr(response, "status", None) != 206 or response.headers.get("Content-Range") != "bytes %d-%d/%d" % (first, last, total):
                failures.append("the artifact store did not answer the range request")
                return
            offset = first
            while offset <= last:
                if time.monotonic() > deadline:
                    failures.append("the download took longer than %d seconds" % FETCH_SECONDS)
                    return
                chunk = response.read(min(MIB, last + 1 - offset))
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.pwrite(descriptor, view, offset)
                    view, offset = view[written:], offset + written
            if offset != last + 1:
                failures.append("a range ended early")
        finally:
            response.close()
    except Exception as exc:  # urllib, socket and TLS errors alike
        code = getattr(exc, "code", None)
        failures.append("the download failed (%s%s)" % (type(exc).__name__, " %d" % code if isinstance(code, int) else ""))


def unpack_member(path, name, sha, size, final):
    """Unpack the zip's one member into the spool while hashing it, as the upload hashes what it receives."""
    partial = SPOOL + "/" + sha + ".partial"
    if os.path.lexists(partial):
        os.unlink(partial)
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if [m.filename for m in members] != [name] or members[0].file_size != size \
                    or members[0].compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                refuse("ARCHIVE_INVALID", "the artifact does not hold exactly the archive its manifest names")
            descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            digest, received = hashlib.sha256(), 0
            try:
                with archive.open(members[0]) as stream:
                    while received <= size:
                        chunk = stream.read(min(MIB, size + 1 - received))
                        if not chunk:
                            break
                        digest.update(chunk)
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(descriptor, view):]
                        received += len(chunk)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except (zipfile.BadZipFile, zlib.error, EOFError):
        if os.path.lexists(partial):
            os.unlink(partial)
        refuse("ARCHIVE_MISMATCH", "the fetched artifact is damaged; it was deleted")
    except OSError as exc:
        if os.path.lexists(partial):
            os.unlink(partial)
        refuse("FETCH_FAILED", "the archive could not be unpacked into the spool (%s)" % (exc.strerror or type(exc).__name__))
    except SystemExit:
        if os.path.lexists(partial):
            os.unlink(partial)
        raise
    if received != size or digest.hexdigest() != sha:
        os.unlink(partial)
        refuse("ARCHIVE_MISMATCH", "the fetched archive does not match its manifest; it was deleted")
    os.rename(partial, final)


def fetch(payload):
    """Fetch one instance-image archive into the root-only spool from the artifact's signed download address, which
    the Mac reads from GitHub and passes here. It expires a minute after GitHub issues it, and no credential is sent or
    kept. The zip arrives in parallel ranges; its one member is then unpacked and hashed exactly as an upload is. The
    zip is always deleted. A refusal names a kind of failure and never the address."""
    archive = payload.get("archive")
    if not isinstance(archive, dict):
        refuse("BAD_REQUEST", "the fetch request is malformed")
    url, name, total = archive.get("url"), archive.get("name"), archive.get("zipBytes")
    if not isinstance(name, str) or not ARCHIVE_NAME.match(name) or type(total) is not int \
            or not 0 < total <= MAX_ARCHIVE + 64 * MIB:
        refuse("BAD_REQUEST", "the fetch request is malformed")
    if not artifact_address(url):
        refuse("FETCH_REFUSED", "the download address is not on GitHub's artifact store")
    final = claim_spool(archive, extra=total)
    if final is None:
        return
    sha, size = archive["sha256"], archive["bytes"]
    started = time.monotonic()
    deadline = started + FETCH_SECONDS
    path = SPOOL + "/" + sha + ".zip.partial"
    if os.path.lexists(path):
        os.unlink(path)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            count = min(FETCH_PARTS, total)
            step = -(-total // count)
            failures, threads = [], []
            for first in range(0, total, step):
                thread = threading.Thread(target=fetch_range, args=(url, descriptor, first, min(total, first + step) - 1,
                                                                    total, deadline, failures), daemon=True)
                thread.start()
                threads.append(thread)
            for thread in threads:
                thread.join(max(1.0, deadline - time.monotonic()))
            if any(thread.is_alive() for thread in threads):
                failures.append("the download took longer than %d seconds" % FETCH_SECONDS)
            if failures:
                refuse("FETCH_FAILED", failures[0])
            if os.fstat(descriptor).st_size != total:
                refuse("FETCH_FAILED", "the downloaded artifact has the wrong size")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        unpack_member(path, name, sha, size, final)
    finally:
        if os.path.lexists(path):
            os.unlink(path)
    out({"result": "FETCHED", "sha256": sha, "bytes": size, "seconds": int(time.monotonic() - started)})


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
    elif action == "fetch":
        fetch(payload)
    else:
        refuse("BAD_REQUEST", "unknown action")
