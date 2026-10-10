#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Clone reviewed regular files into an exclusive local artifact; never hardlink."""
import ctypes
import hashlib
import json
import shutil
try:
    import fcntl
except ImportError:
    fcntl = None
import os
from pathlib import Path
import stat
import sys


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    require(len(sys.argv) == 3, 'Expected exact clone input and SHA256')
    spec = Path(sys.argv[1]); data = spec.read_bytes()
    require(hashlib.sha256(data).hexdigest() == sys.argv[2], 'Clone input custody differs')
    value = json.loads(data)
    require(set(value) == {'version', 'destination', 'files'} and value['version'] == 1, 'Invalid clone contract')
    destination = Path(value['destination'])
    require(destination.resolve(strict=True) == destination and destination.is_dir(), 'Canonical owned destination required')
    clone = None
    if sys.platform == 'darwin':
        lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        clone = lib.clonefile; clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]; clone.restype = ctypes.c_int
    cloned, copied, seen, identities = 0, 0, set(), []
    remaining = sum(row['size'] for row in value['files'])
    for row in value['files']:
        require(set(row) == {'source', 'path', 'size', 'sha256'}, 'Invalid cloned file')
        relative = row['path']; parts = relative.split('/')
        require(relative and not relative.startswith('/') and '\\' not in relative and all(p not in {'', '.', '..'} for p in parts)
                and len(relative.encode()) <= 1024 and not any(ord(c) < 32 or ord(c) == 127 for c in relative), 'Unsafe clone path')
        require(relative not in seen, 'Duplicate cloned file'); seen.add(relative)
        source = Path(row['source']); before = source.lstat()
        require(source.resolve(strict=True) == source and stat.S_ISREG(before.st_mode) and before.st_size == row['size']
                and sha(source) == row['sha256'], 'Clone source differs')
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(target.parent.resolve(strict=True) == target.parent and not target.exists() and not target.is_symlink(), 'Clone output must be new and contained')
        success = False
        if clone is not None:
            success = clone(os.fsencode(source), os.fsencode(target), 0) == 0
        elif sys.platform == 'linux':
            source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                try:
                    fcntl.ioctl(target_fd, 0x40049409, source_fd)  # Linux FICLONE
                    success = True
                except OSError:
                    pass
            finally:
                os.close(source_fd); os.close(target_fd)
            if not success:
                target.unlink()
        if success:
            cloned += 1
        else:
            # Copy only when the complete remaining batch fits above the safety floor.
            require(shutil.disk_usage(destination).free >= remaining + 2 * 1024**3,
                    'Clone unavailable and fallback would breach the free-space floor')
            with source.open('rb') as original, target.open('xb') as output:
                shutil.copyfileobj(original, output, 1024 * 1024)
            target.chmod(0o600); copied += 1
        remaining -= row['size']
        after = source.lstat(); actual = target.lstat()
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'Clone source changed')
        require(stat.S_ISREG(actual.st_mode) and (actual.st_dev, actual.st_ino) != (before.st_dev, before.st_ino)
                and actual.st_size == row['size'] and sha(target) == row['sha256'], 'Clone output differs or shares an inode')
        identities.append({'path': relative, 'dev': str(actual.st_dev), 'ino': str(actual.st_ino)})
    print(json.dumps({'version': 1, 'status': 'EXCLUSIVE_FILES_PREPARED', 'files': len(seen), 'clonedFiles': cloned, 'copiedFiles': copied, 'hardlinks': False, 'identities': identities}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'REFUSED', 'reason': 'Local clone inputs, capacity or custody failed.'}), file=sys.stderr)
        raise SystemExit(1)
