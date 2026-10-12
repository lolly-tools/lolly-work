#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Local-only full static assembly with original signed bytes and paired maps.

This produces artifacts, not runtime acceptance. No target, claim, Pod, image,
configuration or DNS is touched. A real public-profile build is required; a
private instance's static tree cannot be relabeled as a public release.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('public_overlay_boundary', Path(__file__).with_name('public-delivery-overlay.py'))
overlay = importlib.util.module_from_spec(spec); spec.loader.exec_module(overlay)
need, Refusal = overlay.need, overlay.Refusal
spec = importlib.util.spec_from_file_location('public_build_contract', Path(__file__).with_name('prepare-public-shell.py'))
build_contract = importlib.util.module_from_spec(spec); spec.loader.exec_module(build_contract)


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'Closed assembly input required')


def fingerprint(path):
    value = path.lstat()
    need(stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode), 'Regular original file required')
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode)


def checksum(path):
    before = fingerprint(path); digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(65536), b''): digest.update(block)
    need(fingerprint(path) == before, 'File changed while hashing')
    return digest.hexdigest()


def read_ref(ref, maximum=64 * 1024**2):
    exact(ref, {'path', 'sha256'})
    path = Path(ref['path'])
    need(path.is_absolute() and str(path.resolve(strict=True)) == str(path)
         and type(ref['sha256']) is str and overlay.SHA.fullmatch(ref['sha256']), 'Exact non-link original reference required')
    need(fingerprint(path)[2] <= maximum and checksum(path) == ref['sha256'], 'Original reference size/hash differs')
    return path.read_bytes()


def parsed(data):
    def object_pairs(values):
        result = {}
        for key, value in values:
            need(key not in result, 'Duplicate JSON field'); result[key] = value
        return result
    return json.loads(data, object_pairs_hook=object_pairs, parse_constant=lambda _value: (_ for _ in ()).throw(Refusal('Nonfinite JSON refused')))


def physical(root, expected, epoch=False):
    """Complete lexical path/size/SHA proof; no links, sockets or hidden aliases."""
    root = Path(root)
    need(root.is_absolute() and str(root.resolve(strict=True)) == str(root) and root.is_dir(), 'Exact physical release root required')
    rows = overlay.manifest(expected); found = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort(); files.sort()
        for name in directories:
            path = Path(directory, name)
            need(stat.S_ISDIR(path.lstat().st_mode) and not path.is_symlink(), 'Directory link refused')
        for name in files:
            path = Path(directory, name); relative = path.relative_to(root).as_posix()
            overlay.safe_path(relative)
            stamp = fingerprint(path)
            if epoch: need(stamp[3] == 0 and path.stat().st_nlink == 1, 'Assembled file must have epoch-zero metadata and one link')
            found[relative] = {'path': relative, 'size': stamp[2], 'sha256': checksum(path)}
            need(len(found) <= overlay.MAX_FILES, 'Physical file count exceeds bound')
    need(found == rows, 'Complete physical tree differs from original manifest')
    return rows


def immutable(path):
    identity = overlay.coding_identity(path) or path
    return identity.startswith('_app/') or bool(re.fullmatch(r'(?:ort-hf/[^/]+/.+|info/docs\.[A-Za-z0-9_-]{6,40}\.(?:css|js)|tools/[a-z0-9-]+@[a-f0-9]{16}/.+|.+\.[a-f0-9]{16}\.[A-Za-z0-9]{1,16})', identity))


def union(candidate, previous):
    """Keep old immutable identity/wire files; never replace signed current indexes."""
    rows = dict(candidate); retained = []
    for path, row in previous.items():
        if not immutable(path): continue
        if path in rows:
            need(rows[path] == row, 'Immutable physical release collision')
        else:
            rows[path] = row; retained.append(path)
    overlay.coding_pairs(rows)
    return rows, sorted(retained)


def tree(rows):
    files = [rows[path] for path in sorted(rows)]
    return {'version': 1, 'files': files, 'totalBytes': sum(row['size'] for row in files)}


def copy_owned(source, target):
    before = fingerprint(source)
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    # APFS clone creates independent inodes without sharing mutable hard links.
    if sys.platform == 'darwin':
        result = subprocess.run(['/bin/cp', '-c', str(source), str(target)], capture_output=True, timeout=60)
        need(result.returncode == 0 and result.stdout == b'' and result.stderr == b'', 'APFS independent clone refused')
    else: shutil.copyfile(source, target, follow_symlinks=False)
    need(fingerprint(source) == before, 'Source changed during independent copy')
    os.chmod(target, 0o644); os.utime(target, ns=(0, 0), follow_symlinks=False)
    need(target.stat().st_nlink == 1, 'Output cannot share hard links')


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    return {'path': str(path), 'sha256': hashlib.sha256(data).hexdigest()}


def node_command(node, program, value, timeout=300):
    binary = Path(node['path']); need(checksum(binary) == node['sha256'], 'Reviewed Node executable changed')
    result = subprocess.run([str(binary), str(program)], input=raw(value), capture_output=True,
                            timeout=timeout, env={'PATH': str(binary.parent) + ':/usr/bin:/bin'})
    need(result.returncode == 0 and len(result.stdout) <= 65 * 1024**2 and len(result.stderr) <= 65536,
         'Reviewed physical coding/map program refused')
    return parsed(result.stdout), result


def candidate_build(binding, physical_bytes=True):
    """Keep the maintained build descriptor, never infer its source from CI."""
    exact(binding, {'root', 'manifest', 'originalCustody'})
    descriptor = parsed(read_ref(binding['originalCustody']))
    exact(descriptor, build_contract.PRODUCER_KEYS)
    need(descriptor['version'] == 1 and descriptor['status'] == 'LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED'
        and descriptor['artifactClass'] == 'public-shell-overlay' and descriptor['profile'] == 'lolly-start'
        and type(descriptor['lollySource']) is str and re.fullmatch('[a-f0-9]{40}', descriptor['lollySource'])
        and all(descriptor[key] is False for key in ['originAuthenticatedByThisCommand', 'normalCIQualified', 'runtimeQualified', 'promotionAttempted']),
        'Original maintained public build descriptor required; no handwritten source stamp')
    need(descriptor['candidate'] == {'root': binding['root'], 'manifest': binding['manifest']}, 'Original candidate root/manifest custody differs')
    manifest = parsed(read_ref(binding['manifest']))
    if physical_bytes: physical(binding['root'], manifest)
    refs = descriptor['producerSourceFiles']; need(type(refs) is list and len(refs) == len(build_contract.PRODUCER_SOURCES), 'Complete original public builder source closure required')
    sources = {}
    for ref in refs:
        read_ref(ref); path = Path(ref['path'])
        need(path.name in build_contract.PRODUCER_SOURCES and path.name not in sources
            and checksum(Path(__file__).with_name(path.name)) == ref['sha256'], 'Original builder differs from reviewed maintained helper bytes')
        sources[path.name] = ref
    need(sources.get('prepare-public-shell-update.ts') == descriptor['producer'], 'Original public producer is outside its source closure')
    report = parsed(read_ref(descriptor['originalReport'])); command = report.get('command')
    need(report.get('exitCode') == 0 and report.get('signal') is None and report.get('error') is None
        and type(command) is list and len(command) == 4 and command[1] == sources['shell-update-vite.mjs']['path'], 'Original successful maintained Vite command required')
    runner = parsed(read_ref({'path': command[2], 'sha256': command[3]}))
    exact(runner, {'source', 'sourceCommit', 'output', 'prerequisites', 'moduleReceipt'})
    need(runner['sourceCommit'] == descriptor['lollySource'] and runner['output'] == binding['root']
        and runner['moduleReceipt'] == descriptor['workspaceModules']['path'], 'Original Vite source/output/module custody differs')
    modules = parsed(read_ref(descriptor['workspaceModules']))
    need(modules.get('version') == 1 and modules.get('source') == runner['source'] and modules.get('guardIncludesWorkerGraph') is True
        and modules.get('normalCIQualified') is False and modules.get('productionAuthority') is False, 'Original source-bound workspace graph required')
    shared = build_contract.cohort
    checkout = shared.local_path(runner['source'], Path.cwd())
    git = build_contract.shared.git_command
    need(checkout.is_dir() and Path(git(['git', 'rev-parse', '--show-toplevel'], checkout)) == checkout
        and git(['git', 'rev-parse', 'HEAD'], checkout) == descriptor['lollySource']
        and git(['git', 'cat-file', '-t', descriptor['lollySource']], checkout) == 'commit'
        and git(['git', 'status', '--porcelain'], checkout) == '', 'Original Vite checkout is dirty or differs from its declared source/root')
    common = Path(os.path.abspath(checkout / git(['git', 'rev-parse', '--git-common-dir'], checkout)))
    need(common.resolve(strict=True) == common and not (common / 'info/grafts').exists() and not (common / 'info/grafts').is_symlink(), 'Local Git metadata aliases or ancestry grafts refuse source custody')
    compiled = modules.get('modules'); need(type(compiled) is list and 1 <= len(compiled) <= 5000, 'Complete bounded compiled workspace graph required')
    seen = set()
    for row in compiled:
        exact(row, {'path', 'bytes', 'sha256'}); path = shared.local_path(row['path'], Path.cwd())
        need(path.is_relative_to(checkout) and str(path) not in seen and type(row['bytes']) is int and row['bytes'] >= 0
            and path.relative_to(checkout).as_posix().startswith(('engine/', 'packages/core/', 'packages/node-shell/', 'packages/rondo/', 'packages/audio-dock/')),
            'Duplicate or escaped compiled workspace module')
        data = shared.git_bytes(checkout, descriptor['lollySource'], path.relative_to(checkout).as_posix(), git)
        need(len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == shared.sha(row['sha256']), 'Compiled workspace bytes differ from immutable candidate Git')
        seen.add(str(path))
    ci = parsed(read_ref(descriptor['ci']))
    need(ci.get('head_sha') == descriptor['lollySource'] and ci.get('head_branch') == 'main'
        and ci.get('status') == 'completed' and ci.get('conclusion') == 'success', 'Original candidate CI run differs from its source')
    for key in ['classification', 'imageClassification', 'custody', 'previousAcceptance', 'ci', 'publicKey', 'retention', 'webGate']:
        read_ref(descriptor[key])
    catalog = descriptor['catalog']; exact(catalog, {'previous', 'candidate', 'signatureReused', 'newSigning'})
    need(catalog['signatureReused'] is True and catalog['newSigning'] is False, 'Original unchanged signed catalog custody required')
    for key in ['previous', 'candidate']: read_ref(catalog[key])
    return {**binding, 'source': descriptor['lollySource'], 'profile': descriptor['profile']}


def verify_candidate_build(value, physical_bytes=True):
    exact(value, {'root', 'manifest', 'originalCustody', 'source', 'profile'})
    binding = {key: value[key] for key in ['root', 'manifest', 'originalCustody']}
    need(candidate_build(binding, physical_bytes) == value, 'Candidate build provenance changed since assembly')
    return value


def assemble(candidate_root, previous_root, candidate, previous, models, output, compiler, node, mode='matched', candidate_custody=None):
    need(mode in {'matched', 'frontend'}, 'Explicit full-cohort or application-only assembly required')
    current = physical(candidate_root, candidate); old = physical(previous_root, previous)
    build = candidate_build(candidate_custody) if candidate_custody is not None else None
    if build is not None:
        need(build['root'] == candidate_root and parsed(read_ref(build['manifest'])) == candidate, 'Assembly candidate differs from original build custody')
    merged, retained = union(current, old)
    output = Path(output)
    need(output.is_absolute() and output.resolve() == output and not output.exists()
         and not any(output == root or root in output.parents or output in root.parents for root in [Path(candidate_root), Path(previous_root)]),
         'Fresh nonoverlapping exclusive assembly output required')
    byte_count = sum(row['size'] for path, row in merged.items() if path != overlay.MAP)
    need(shutil.disk_usage(output.parent).free >= byte_count + overlay.MAX_MAP_BYTES + 256 * 1024**2, 'Conservative independent copy capacity floor refused')
    output.mkdir(mode=0o700); site = output / 'site'; site.mkdir(mode=0o755)
    for path in sorted(merged):
        if path == overlay.MAP: continue
        source = Path(candidate_root if path in current else previous_root, path)
        copy_owned(source, site / path)
    value, process = node_command(node, compiler, {'version': 1, 'root': str(site),
        'files': [merged[path] for path in sorted(merged) if path != overlay.MAP], 'models': models})
    exact(value, {'version', 'mapBytes', 'mapSha256', 'decodedCodings'})
    map_path = site / overlay.MAP
    need(type(value['mapBytes']) is int and 0 < value['mapBytes'] <= overlay.MAX_MAP_BYTES
         and value['version'] == 1 and map_path.stat().st_size == value['mapBytes']
         and checksum(map_path) == value['mapSha256']
         and value['decodedCodings'] == len(overlay.coding_pairs(merged)), 'Actual coding/map proof differs')
    merged[overlay.MAP] = {'path': overlay.MAP, 'size': value['mapBytes'], 'sha256': value['mapSha256']}
    result = tree(merged); physical(site, result, epoch=True)
    boundary = None
    if mode == 'frontend':
        changes = {path: row for path, row in merged.items() if old.get(path) != row}
        boundary = overlay.plan(previous, result, result, tree(changes), sorted(set(old) - set(merged)))
    need(physical(candidate_root, candidate) == current and physical(previous_root, previous) == old, 'Original release changed during assembly')
    if build is not None: verify_candidate_build(build)
    manifest_ref = write_new(output / 'static.manifest.actual.json', raw(result) + b'\n')
    stdout = write_new(output / 'map-and-coding.stdout.original', process.stdout)
    stderr = write_new(output / 'map-and-coding.stderr.original', process.stderr)
    report = {'version': 2, 'protocol': 'PUBLIC_FULL_ROOT_DELIVERY_OVERLAY', 'status': 'LOCAL_PHYSICAL_ASSEMBLY_NOT_RUNTIME_ACCEPTANCE',
        'root': str(site), 'manifest': manifest_ref, 'mode': mode, 'frontendBoundary': boundary,
        'candidateBuild': build,
        'retained': retained, 'files': len(merged), 'bytes': result['totalBytes'],
        'map': merged[overlay.MAP], 'decodedCodings': value['decodedCodings'], 'originalSignedBytesChanged': False,
        'mapCommand': {'exitCode': process.returncode, 'stdout': stdout, 'stderr': stderr},
        'physicalEpoch': 0, 'hardLinkedFiles': 0, 'runtimeQualified': False, 'productionMutation': False, 'published': False}
    return write_new(output / 'assembly.actual.json', raw(report) + b'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True); parser.add_argument('--input-sha256', required=True)
    parser.add_argument('--operator-sha256', required=True)
    args = parser.parse_args()
    try:
        need(checksum(Path(__file__)) == args.operator_sha256, 'Reviewed assembler source changed')
        value = parsed(read_ref({'path': args.input, 'sha256': args.input_sha256}))
        exact(value, {'version', 'mode', 'candidate', 'previous', 'models', 'compiler', 'boundary', 'node', 'outputDirectory'})
        need(type(value['version']) is int and value['version'] == 2, 'Assembly protocol2 required')
        for field in ['candidate', 'previous']:
            exact(value[field], {'root', 'manifest', 'originalCustody'})
            read_ref(value[field]['originalCustody']); read_ref(value[field]['manifest'])
        candidate_build(value['candidate'])
        compiler = Path(value['compiler']['path']); read_ref(value['compiler'])
        need(compiler == Path(__file__).with_name('public-delivery-map.mjs'), 'Reviewed adjacent map/coding helper required')
        read_ref(value['boundary']); need(Path(value['boundary']['path']) == Path(__file__).with_name('public-delivery-overlay.py'), 'Reviewed boundary source required')
        exact(value['node'], {'path', 'sha256'})
        model_inventory = parsed(read_ref(value['models']))
        exact(model_inventory, {'version', 'files'}); need(model_inventory['version'] == 1, 'Reviewed model union schema required')
        result = assemble(value['candidate']['root'], value['previous']['root'], parsed(read_ref(value['candidate']['manifest'])),
            parsed(read_ref(value['previous']['manifest'])), model_inventory['files'], value['outputDirectory'], compiler, value['node'], value['mode'], value['candidate'])
        print(raw({'assembly': result, 'runtimeQualified': False, 'productionMutation': False}).decode())
        return 0
    except Exception as error:
        print('Public full-root assembly refused: ' + str(error), file=sys.stderr); return 1


if __name__ == '__main__': raise SystemExit(main())
