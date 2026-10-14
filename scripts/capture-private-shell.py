#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Fresh bounded read bundles, with literal command originals retained separately.

The remote program accepts only a bounded array of Kubernetes GET selectors.
Every call starts new processes. Nothing is shared between guard passes, and
callers still perform their existing complete inventory and identity checks.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import uuid

MAX_INPUT = 64 * 1024
MAX_QUERIES = 64
STREAM_LIMIT = 32 * 1024**2
REPORT_LIMIT = 96 * 1024**2
COMMAND_SECONDS = 60
BUNDLE_SECONDS = 120
WORKERS = 4
KINDS = {'namespace', 'node', 'deployment', 'deployments', 'pvc', 'pv', 'pods', 'pod', 'replicaset',
         'storageclass', 'networkpolicy', 'networkpolicies', 'ConfigMap', 'PersistentVolumeClaim', 'persistentvolumeclaims', 'persistentvolumes'}
CLUSTER_KINDS = {'namespace', 'node', 'pv', 'persistentvolumes', 'storageclass'}
COLLECTIONS = {'deployment', 'deployments', 'pvc', 'pv', 'pods', 'pod', 'networkpolicies', 'persistentvolumeclaims', 'persistentvolumes'}
NAME = re.compile(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\Z')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate capture JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite capture number')))


def query_args(query):
    require(type(query) in (list, tuple) and len(query) == 3, 'Exact GET selector required')
    kind, name, namespace = query
    require(kind in KINDS and (name is None or type(name) is str and NAME.fullmatch(name)), 'Unknown kind or name')
    require(name is not None or kind in COLLECTIONS, 'Unknown collection selector')
    require((namespace is None if kind in CLUSTER_KINDS else type(namespace) is str and NAME.fullmatch(namespace)), 'Exact GET scope required')
    return ['get', kind, *([name] if name is not None else []), '-o', 'json', *(['--namespace', namespace] if namespace is not None else [])]


def validate_request(value):
    require(type(value) is dict and set(value) == {'version', 'prefix', 'queries'} and type(value['version']) is int and value['version'] == 1,
            'Unknown capture request')
    prefix = value['prefix']
    require(type(prefix) is list and 1 <= len(prefix) <= 20 and all(type(x) is str and 0 < len(x) <= 4096 and '\0' not in x for x in prefix),
            'Bounded literal kubectl prefix required')
    queries = value['queries']
    require(type(queries) is list and 1 <= len(queries) <= MAX_QUERIES, 'Bounded capture selectors required')
    for query in queries:
        query_args(query)
    require(len({tuple(q) for q in queries}) == len(queries), 'Duplicate capture selector')
    return value


def bounded_process(argv, payload, timeout, limit):
    """Drain both pipes without unbounded RAM, disk files, or child run time."""
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    observed = {'stdout': 0, 'stderr': 0}
    timed_out, exceeded, launch_error = False, False, None
    deadline = time.monotonic() + timeout
    with tempfile.TemporaryFile() as incoming:
        if payload is not None:
            incoming.write(payload)
        incoming.seek(0)
        try:
            process = subprocess.Popen(argv, stdin=incoming, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as error:
            return {'stdout': b'', 'stderr': b'', 'observed': observed, 'exitCode': None, 'timedOut': False,
                    'complete': False, 'launchError': type(error).__name__}
        with selectors.DefaultSelector() as selector:
            for name in output:
                selector.register(getattr(process, name), selectors.EVENT_READ, name)
            killed = False
            while selector.get_map():
                if not killed and (time.monotonic() >= deadline or exceeded):
                    timed_out = time.monotonic() >= deadline
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    killed = True
                for key, _ in selector.select(0.05):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    name = key.data
                    observed[name] += len(chunk)
                    remaining = limit - len(output[name])
                    output[name].extend(chunk[:max(remaining, 0)])
                    exceeded = exceeded or observed[name] > limit
            try:
                code = process.wait(timeout=max(deadline - time.monotonic(), 0.01))
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = process.wait()
    return {**{key: bytes(value) for key, value in output.items()}, 'observed': observed, 'exitCode': code,
            'timedOut': timed_out, 'complete': not exceeded, 'launchError': launch_error}


def remote_main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    require(len(raw) <= MAX_INPUT, 'Capture stdin exceeded bound')
    request = validate_request(strict_json(raw))
    deadline = time.monotonic() + BUNDLE_SECONDS
    def run(index, query):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            result = {'stdout': b'', 'stderr': b'', 'observed': {'stdout': 0, 'stderr': 0},
                      'exitCode': None, 'timedOut': True, 'complete': True, 'launchError': None}
        else:
            result = bounded_process([*request['prefix'], *query_args(query)], None, min(COMMAND_SECONDS, remaining), STREAM_LIMIT)
        result['stdout'] = base64.b64encode(result['stdout']).decode('ascii')
        result['stderr'] = base64.b64encode(result['stderr']).decode('ascii')
        return {'index': index, 'query': query, **result}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(run, index, query) for index, query in enumerate(request['queries'])]
        for future in as_completed(futures):
            print(json.dumps(future.result(), separators=(',', ':')), flush=True)
    print(json.dumps({'complete': True, 'count': len(request['queries'])}), flush=True)


def transport(target):
    t = target['transport']
    prefix = [*t['kubectl'], '--kubeconfig', t['kubeconfig'], '--context', t['context']]
    source = Path(__file__).read_text()
    if t['type'] == 'local':
        return [sys.executable, '-B', '-c', source, '--remote'], prefix
    require(t['type'] == 'ssh', 'Known capture transport required')
    if t.get('sudo'):
        prefix = ['sudo', '-n', *prefix]
    ssh = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=12', '-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=' + t['knownHostsFile']]
    if t.get('jump'):
        ssh += ['-J', t['jump']]
    return [*ssh, t['host'], shlex.join(['python3', '-B', '-c', source, '--remote'])], prefix


def write(directory, name, raw):
    path = directory / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}


def record(directory, tag, result, extra=None):
    refs = {}
    for name in ('stdout', 'stderr'):
        raw = result[name]
        refs[name] = {**write(directory, tag + '.' + name, raw), 'observedBytes': result['observed'][name],
                      'complete': len(raw) == result['observed'][name]}
    value = {'exitCode': result['exitCode'], 'timedOut': result['timedOut'], 'complete': result['complete'],
             'launchError': result['launchError'], 'originals': refs, **(extra or {})}
    return write(directory, tag + '.json', json.dumps(value, sort_keys=True).encode() + b'\n')


class Snapshot:
    """A caller-owned single-pass inventory; missing selectors always refuse."""
    def __init__(self, outputs, receipts, accepted):
        self.outputs, self.receipts, self.accepted = outputs, receipts, accepted

    def get(self, kind, name=None, namespace=None):
        require((kind, name, namespace) in self.outputs, 'Uncaptured resource selector')
        return strict_json(self.outputs[(kind, name, namespace)])

    def run(self, args):
        for query, raw in self.outputs.items():
            if query_args(query) == args:
                return raw.decode('utf-8')
        raise ValueError('Uncaptured resource command')


def capture(target, queries, directory):
    """Keep partial transport and command originals before refusing any result."""
    directory = Path(directory)
    require(directory.resolve(strict=True) == directory and directory.is_dir(), 'Canonical capture directory required')
    command, prefix = transport(target)
    request = validate_request({'version': 1, 'prefix': prefix, 'queries': [list(q) for q in queries]})
    payload = json.dumps(request, separators=(',', ':')).encode()
    require(len(payload) <= MAX_INPUT, 'Capture stdin exceeded bound')
    tag = 'capture-' + uuid.uuid4().hex
    result = bounded_process(command, payload, BUNDLE_SECONDS + 20, REPORT_LIMIT)
    receipts = [record(directory, tag + '-transport', result)]
    outputs, indexes, final, valid = {}, set(), False, True
    lines = result['stdout'].splitlines(keepends=True)
    for line in lines:
        if not line.endswith(b'\n'):
            valid = False
            continue
        try:
            value = strict_json(line)
            if set(value) == {'complete', 'count'}:
                require(not final and value['complete'] is True and type(value['count']) is int and value['count'] == len(queries), 'Capture trailer differs')
                final = True
                continue
            require(not final and set(value) == {'index', 'query', 'stdout', 'stderr', 'observed', 'exitCode', 'timedOut', 'complete', 'launchError'},
                    'Unknown capture result')
            index = value['index']
            require(type(index) is int and 0 <= index < len(queries) and index not in indexes and value['query'] == list(queries[index]),
                    'Capture selector order or identity differs')
            for name in ('stdout', 'stderr'):
                value[name] = base64.b64decode(value[name], validate=True)
            require(type(value['observed']) is dict and set(value['observed']) == {'stdout', 'stderr'} and
                    all(type(value['observed'][name]) is int and value['observed'][name] >= len(value[name]) and len(value[name]) <= STREAM_LIMIT
                        for name in ('stdout', 'stderr')), 'Capture stream bound differs')
            require(type(value['timedOut']) is bool and type(value['complete']) is bool and
                    (value['exitCode'] is None or type(value['exitCode']) is int) and
                    (value['launchError'] is None or type(value['launchError']) is str), 'Capture command result differs')
            refs = record(directory, tag + '-command-' + str(index), value, {'query': value['query']})
            receipts.append(refs)
            indexes.add(index)
            outputs[tuple(value['query'])] = value['stdout']
            valid = valid and value['exitCode'] == 0 and not value['timedOut'] and value['complete'] and value['launchError'] is None and all(
                value['observed'][name] == len(value[name]) for name in ('stdout', 'stderr'))
        except (ValueError, TypeError, KeyError):
            valid = False
    accepted = valid and final and len(indexes) == len(queries) and result['exitCode'] == 0 and not result['timedOut'] and result['complete'] and result['launchError'] is None
    return Snapshot(outputs, receipts, accepted)


if __name__ == '__main__':
    require(sys.argv[1:] == ['--remote'], 'Only the internal bounded read protocol is supported')
    remote_main()
