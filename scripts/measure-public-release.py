#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Measure one explicitly reviewed release command, never advance a release.

The wrapped adapter retains all of its own approvals, guards and receipts. This
journal records process time including constructors; it grants no acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

STATUS = 'REVIEWED_SINGLE_PUBLIC_RELEASE_OPERATION'
ACTIVITIES = {'preparation', 'staging', 'publication', 'verification'}
LIMIT = 1024 * 1024


def need(value, message):
    if not value: raise RuntimeError(message)


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def sha(path):
    with Path(path).open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def held(ref, parsed=False):
    need(type(ref) is dict and set(ref) == {'path', 'sha256'}, 'Closed held file required')
    path = Path(ref['path'])
    need(path.is_absolute() and path.resolve(strict=True) == path and path.is_file() and not path.is_symlink()
         and re.fullmatch('[a-f0-9]{64}', ref['sha256']) and sha(path) == ref['sha256'], 'Original file changed')
    if not parsed: return path
    need(path.stat().st_size <= LIMIT, 'Bounded metadata required')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'Duplicate JSON key'); result[key] = value
        return result
    return json.loads(path.read_bytes(), object_pairs_hook=unique, parse_constant=lambda _: need(False, 'Nonfinite JSON'))


def reference(path):
    path = Path(path).resolve(strict=True); return {'path': str(path), 'sha256': sha(path)}


def save(path, value):
    with Path(path).open('xb') as stream:
        os.chmod(path, 0o600); stream.write(raw(value)); stream.flush(); os.fsync(stream.fileno())
    return reference(path)


def clock_identity():
    if sys.platform == 'darwin':
        result = subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.boottime'], capture_output=True, timeout=5, check=True)
        value = result.stdout.decode().strip(); need(re.fullmatch(r'\{ sec = [0-9]+, usec = [0-9]+ \}.*', value), 'Kernel boot identity missing')
    else:
        value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        need(re.fullmatch('[a-f0-9-]{36}', value), 'Kernel boot identity missing')
    return {'host': socket.gethostname(), 'system': sys.platform, 'boot': value}


def request(ref):
    value = held(ref, True)
    need(set(value) == {'version', 'status', 'releaseId', 'activity', 'program', 'entrypoint', 'interpreterArguments', 'arguments', 'inputFiles', 'httpTimingPaths', 'timeoutSeconds', 'outputDirectory', 'cwd'}
         and type(value['version']) is int and value['version'] == 1 and value['status'] == STATUS, 'Closed reviewed operation required')
    need(type(value['releaseId']) is str and re.fullmatch('[a-z0-9][a-z0-9._-]{0,127}', value['releaseId']) and value['activity'] in ACTIVITIES, 'Release identity/activity missing')
    cwd = Path(value['cwd']); need(cwd.is_absolute() and cwd.resolve(strict=True) == cwd and cwd.is_dir(), 'Exact working directory required')
    program, script = held(value['program']), held(value['entrypoint'])
    need(re.fullmatch(r'python3(?:\.[0-9]+)?|node', program.name) and script.suffix in {'.py', '.js', '.mjs', '.ts'}, 'Reviewed Python or Node entrypoint required')
    flags = value['interpreterArguments']; need(type(flags) is list and len(flags) <= 3 and len(set(flags)) == len(flags)
         and all(v in {'-B', '-O'} for v in flags) if program.name.startswith('python') else type(flags) is list and not flags, 'Interpreter flags may not select another program')
    args = value['arguments']; need(type(args) is list and len(args) <= 128 and all(type(v) is str and len(v) <= 8192 and '\0' not in v for v in args), 'Bounded literal argument vector required')
    need(type(value['inputFiles']) is list and len(value['inputFiles']) <= 2048, 'Bounded exact input closure required')
    for item in value['inputFiles']: held(item)
    paths = value['httpTimingPaths']; need(type(paths) is list and len(paths) <= 64 and len(set(paths)) == len(paths), 'Distinct HTTP timing paths required')
    for name in paths:
        path = Path(name); need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'Canonical HTTP timing path required')
    need(type(value['timeoutSeconds']) is int and 1 <= value['timeoutSeconds'] <= 43200, 'Explicit operation timeout required')
    return value, [str(program), *flags, str(script), *args]


def http_timing(ref):
    value = held(ref, True)
    keys = {'version', 'activity', 'clock', 'elapsedSeconds', 'requestsStarted', 'responsesCompleted', 'bodyBytesRead', 'checksCompleted', 'byteAccounting', 'qualificationClaimed'}
    need(set(value) == keys and value['version'] == 1 and value['activity'] == 'model-http'
         and value['clock'] == 'LOCAL_MONOTONIC_ELAPSED_TIME' and value['qualificationClaimed'] is False
         and value['byteAccounting'] == 'RESPONSE_BODY_BYTES_READ_INCLUDES_PARTIAL_FAILURES_EXCLUDES_HEADERS_AND_TLS', 'Exact diagnostic HTTP sidecar required')
    need(type(value['elapsedSeconds']) in (int, float) and 0 <= value['elapsedSeconds'] <= 43200
         and all(type(value[k]) is int and value[k] >= 0 for k in ['requestsStarted', 'responsesCompleted', 'bodyBytesRead'])
         and value['responsesCompleted'] <= value['requestsStarted'] and type(value['checksCompleted']) is bool, 'Invalid HTTP time or counters')
    return value


def run(input_ref, operator_ref):
    held(operator_ref); need(operator_ref == reference(__file__), 'Exact reviewed measurement source required')
    value, argv = request(input_ref); out = Path(value['outputDirectory'])
    need(out.is_absolute() and out.resolve() == out and out.parent.is_dir() and not out.exists(), 'New exclusive timing journal required')
    need(all(not Path(p).exists() for p in value['httpTimingPaths']), 'Timing sidecars must belong to this new command')
    out.mkdir(mode=0o700); clock = clock_identity()
    save(out/'started.json', {'version': 1, 'status': 'STARTED_NO_REPLAY', 'input': input_ref, 'operator': operator_ref, 'argv': argv, 'cwd': value['cwd'], 'clockIdentity': clock})
    stdout, stderr = out/'stdout.original', out/'stderr.original'
    wall_start, start = time.time_ns(), time.monotonic_ns(); code = None; failure = None
    with stdout.open('xb') as output, stderr.open('xb') as error:
        os.chmod(stdout, 0o600); os.chmod(stderr, 0o600)
        try: code = subprocess.run(argv, cwd=value['cwd'], stdout=output, stderr=error, timeout=value['timeoutSeconds'], check=False).returncode
        except (OSError, subprocess.TimeoutExpired) as exc: failure = type(exc).__name__
    end, wall_end = time.monotonic_ns(), time.time_ns()
    command = save(out/'command.actual.json', {'version': 1, 'argv': argv, 'cwd': value['cwd'], 'exitCode': code, 'failureType': failure,
        'startedUnixNs': wall_start, 'endedUnixNs': wall_end, 'startedMonotonicNs': start, 'endedMonotonicNs': end,
        'elapsedNanoseconds': end-start, 'clockIdentity': clock, 'stdout': reference(stdout), 'stderr': reference(stderr)})
    sidecars = []; diagnostic_error = None
    try:
        request(input_ref); held(operator_ref); need(clock_identity() == clock, 'Local clock identity changed')
        for name in value['httpTimingPaths']:
            if not Path(name).exists():
                need(code != 0 or failure is not None, 'Successful operation omitted expected HTTP telemetry'); continue
            ref = reference(name); data = http_timing(ref)
            need(data['elapsedSeconds'] <= (end-start)/1e9 + 1, 'Nested model interval exceeds operation interval')
            sidecars.append(ref)
    except Exception as exc: diagnostic_error = type(exc).__name__
    receipt = save(out/'operation.actual.json', {'version': 1, 'status': 'PUBLIC_RELEASE_OPERATION_MEASURED' if diagnostic_error is None else 'PUBLIC_RELEASE_OPERATION_TELEMETRY_REFUSED',
        'releaseId': value['releaseId'], 'activity': value['activity'], 'input': input_ref, 'operator': operator_ref,
        'command': command, 'httpTimings': sidecars, 'diagnosticFailureType': diagnostic_error, 'qualificationClaimed': False})
    return receipt, 0 if code == 0 and failure is None and diagnostic_error is None else 1


def summarize(refs):
    need(type(refs) is list and 1 <= len(refs) <= 256, 'Bounded original operations required')
    records = []; identity = None; release = None; body_refs = set(); totals = {k: 0 for k in ACTIVITIES}; model_time = 0.; body_bytes = 0; succeeded = True
    for ref in refs:
        value = held(ref, True); need(value['version'] == 1 and value['qualificationClaimed'] is False and value['status'] == 'PUBLIC_RELEASE_OPERATION_MEASURED', 'No invalid telemetry may enter total')
        req, argv = request(value['input']); held(value['operator']); command = held(value['command'], True)
        need(value['releaseId'] == req['releaseId'] and value['activity'] == req['activity'] and command['argv'] == argv and command['cwd'] == req['cwd'], 'Operation differs from reviewed command')
        held(command['stdout']); held(command['stderr'])
        need(type(command['exitCode']) is int or command['exitCode'] is None, 'Actual exit code must be integer or unavailable')
        expected = set(req['httpTimingPaths']); actual = {v['path'] for v in value['httpTimings']}
        need(actual <= expected and len(actual) == len(value['httpTimings']), 'HTTP telemetry references differ')
        if command['exitCode'] == 0 and command['failureType'] is None:
            need(actual == expected, 'Successful operation must retain every expected HTTP sidecar')
        if identity is None: identity, release = command['clockIdentity'], value['releaseId']
        need(command['clockIdentity'] == identity and value['releaseId'] == release, 'Only one release and one host boot can be totaled')
        start, end = command['startedMonotonicNs'], command['endedMonotonicNs']
        need(type(start) is int and type(end) is int and 0 < start <= end and command['elapsedNanoseconds'] == end-start, 'Operation interval differs')
        need(abs(command['endedUnixNs']-command['startedUnixNs']-(end-start)) <= 1_000_000_000, 'Clock changed during operation')
        records.append((start, end)); totals[value['activity']] += end-start
        succeeded &= command['exitCode'] == 0 and command['failureType'] is None
        for item in value['httpTimings']:
            need(item['path'] in req['httpTimingPaths'] and item['path'] not in body_refs, 'Nested HTTP timing duplicated or outside original operation')
            body_refs.add(item['path']); data = http_timing(item); need(data['elapsedSeconds'] <= (end-start)/1e9 + 1, 'Nested HTTP interval exceeds operation')
            model_time += data['elapsedSeconds']; body_bytes += data['bodyBytesRead']
    records.sort(); need(all(a[1] <= b[0] for a,b in zip(records, records[1:])), 'Operations overlap; elapsed time cannot be added')
    return {'version': 1, 'status': 'PUBLIC_RELEASE_TIMING_DIAGNOSTIC_ONLY', 'releaseId': release, 'operations': refs,
        'activityNanoseconds': totals, 'activeNanoseconds': sum(totals.values()), 'elapsedNanoseconds': records[-1][1]-records[0][0],
        'unmeasuredGapNanoseconds': records[-1][1]-records[0][0]-sum(totals.values()), 'modelHttpSecondsNestedNotAdditive': model_time,
        'modelResponseBodyBytes': body_bytes, 'allCommandsSucceeded': succeeded,
        'coversPreparationStagingPublication': all(totals[k] > 0 for k in ['preparation','staging','publication']), 'qualificationClaimed': False}


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('action', choices=['run','summarize']); p.add_argument('--input', required=True); p.add_argument('--reviewed-input-sha256', required=True); p.add_argument('--reviewed-operator-sha256', required=True); p.add_argument('--output')
    args = p.parse_args(); ir = {'path': str(Path(args.input).resolve()), 'sha256': args.reviewed_input_sha256}; op = {'path': str(Path(__file__).resolve()), 'sha256': args.reviewed_operator_sha256}; held(op)
    if args.action == 'run':
        need(args.output is None, 'Run output is bound in reviewed input'); result, code = run(ir, op); print(json.dumps(result)); return code
    need(args.output is not None, 'New summary output required'); result = summarize(held(ir, True)); print(json.dumps(save(Path(args.output), result))); return 0

if __name__ == '__main__': raise SystemExit(main())
