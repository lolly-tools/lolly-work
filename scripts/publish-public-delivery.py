#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Publish only an actual qualified and retired complete frontend root.

UID, fresh resourceVersion and the whole current spec guard one atomic patch.
The native image/config/models remain selected unchanged. A failed/started
phase never replays; rollback requires the actual published owning spec.
"""
import argparse
from pathlib import Path
import sys
import time
import uuid
import copy
import importlib.util

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('delivery_stage', Path(__file__).with_name('stage-public-delivery.py'))
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
need, exact, raw = s.need, s.exact, s.raw


def patch(before, desired):
    return [{'op': 'test', 'path': '/metadata/uid', 'value': before['metadata']['uid']},
        {'op': 'test', 'path': '/metadata/resourceVersion', 'value': before['metadata']['resourceVersion']},
        {'op': 'test', 'path': '/spec', 'value': before['spec']}, {'op': 'replace', 'path': '/spec', 'value': desired}]


class Publication:
    def __init__(self, path, input_sha, operator_sha):
        self.path = Path(path); self.input_sha = input_sha; self.operator_sha = operator_sha
        need(s.l.a.checksum(self.path) == input_sha and s.l.a.checksum(Path(__file__)) == operator_sha, 'Reviewed publication source/input required')
        self.value = s.l.held({'path': str(self.path), 'sha256': input_sha})
        exact(self.value, {'version', 'status', 'stageInput', 'stageSource', 'retirement', 'outputDirectory'})
        need(self.value['version'] == 1 and self.value['status'] == 'REVIEWED_ACTUAL_FRONTEND_ROOT_PUBLICATION_NOT_EXECUTED', 'Actual retired-root publication input required')
        need(Path(self.value['stageSource']['path']) == Path(__file__).with_name('stage-public-delivery.py'), 'Exact adjacent source-bound stage adapter required')
        self.stage = s.Stage(self.value['stageInput']['path'], self.value['stageInput']['sha256'], self.value['stageSource']['sha256'])
        need(self.value['retirement']['path'] == str(self.stage.out / 'runtime.qualified-and-retired.actual.json'), 'Genuine original final stage receipt required')
        self.receipt = s.l.held(self.value['retirement']); s.l.admit(self.stage.prepared, self.receipt)
        self.desired = self.stage.prepared['desiredSpec']; self.stage.policy_retired = True
        self.original_out = self.stage.out; self.out = Path(self.value['outputDirectory'])
        need(self.out.is_absolute() and self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent
            and self.out != self.original_out and self.original_out not in self.out.parents and self.out not in self.original_out.parents
            and self.out != self.stage.root and self.stage.root not in self.out.parents and self.out not in self.stage.root.parents,
            'Exclusive publication output required')

    def save(self, name, value): return s.l.a.write_new(self.out / name, raw(value) + b'\n')
    def load(self, name): return s.l.a.parsed((self.out / name).read_bytes())
    def phase(self, name, fn):
        started = time.monotonic()
        need(s.l.a.checksum(self.path) == self.input_sha and s.l.a.checksum(Path(__file__)) == self.operator_sha, 'Reviewed publication source/input changed')
        self.save(name + '.started.json', {'status': 'STARTED_NO_REPLAY', 'inputSha256': self.input_sha, 'operatorSha256': self.operator_sha})
        try:
            start = len(self.stage.events); result = fn()
            self.save(name + '.timing.actual.json', {'version': 1, 'activity': 'publication:' + name, 'elapsedSeconds': time.monotonic() - started, 'clock': 'LOCAL_MONOTONIC_ELAPSED_TIME', 'phaseBodyCompleted': True, 'qualificationClaimed': False})
            return self.save(name + '.accepted.json', {'version': 1, 'inputSha256': self.input_sha,
                'operatorSha256': self.operator_sha, 'commands': self.stage.events[start:], **result})
        except BaseException as error:
            self.save(name + '.uncertain.json', {'status': 'REFUSED_NO_REPLAY', 'failureType': type(error).__name__})
            try:
                if not (self.out / (name + '.timing.actual.json')).exists():
                    self.save(name + '.timing.actual.json', {'version': 1, 'activity': 'publication:' + name, 'elapsedSeconds': time.monotonic() - started, 'clock': 'LOCAL_MONOTONIC_ELAPSED_TIME', 'phaseBodyCompleted': False, 'qualificationClaimed': False})
            except Exception as timing_error:
                error.add_note('Phase timing capture failed: ' + type(timing_error).__name__)
            raise
    def prior(self, name):
        value = self.load(name + '.accepted.json'); need(value['inputSha256'] == self.input_sha and value['operatorSha256'] == self.operator_sha, 'Different accepted publication phase'); return value

    def with_journal(self, fn):
        # Target observations belong to this execution, never to the retired stage.
        old_save = self.stage.save; old_run = self.stage.run
        self.stage.save = self.save
        def run(argv, data=None, timeout=240):
            original = self.stage.out; self.stage.out = self.out
            try: return old_run(argv, data, timeout)
            finally: self.stage.out = original
        self.stage.run = run
        try: return fn()
        finally: self.stage.save = old_save; self.stage.run = old_run

    def fresh(self, after=False):
        self.stage.fresh(after=self.desired if after else None)
        need(self.stage.absent('pod', self.stage.names['writer']) and self.stage.absent('pod', self.stage.names['qualifier']) and self.stage.absent('networkpolicy', self.stage.names['policy']), 'Retired staging resources reappeared')
        for phase in ['retire-writer', 'retire']: self.stage.mount_release(self.stage.prior(phase)['podUID'])
        actual = self.stage.get('deployment', self.stage.before['metadata']['name'], self.stage.namespace)
        need(actual['metadata']['uid'] == self.stage.before['metadata']['uid'] and actual['spec'] == (self.desired if after else self.stage.before['spec']), 'Selected Deployment no longer has exact owning tuple')
        return actual

    def preflight(self, after=False):
        before = self.fresh(after); self.stage.image_available()
        self.stage.run([sys.executable, '-B', self.stage.value['programs']['preflight']['path']], timeout=180)
        return before

    def dryrun(self):
        need(not self.out.exists(), 'Publication attempt cannot replay'); self.out.mkdir(mode=0o700)
        def fn():
            before = self.fresh(); before_ref = self.save('dryrun.before.original.json', before)
            prepared = patch(before, self.desired); patch_ref = self.save('dryrun.patch.original.json', prepared)
            response = s.cohort.parse_json(self.stage.remote(['patch', 'deployment', before['metadata']['name'], '-n', self.stage.namespace, '--type=json', '--dry-run=server', '--patch-file=/dev/stdin', '-o', 'json'], raw(prepared)))
            need(response['metadata']['uid'] == before['metadata']['uid'] and response['spec'] == self.desired, 'Server dryrun altered selected fields')
            response_ref = self.save('dryrun.response.original.json', response)
            return {'status': 'ACTUAL_FRONTEND_SERVER_DRYRUN_NOT_PUBLISHED', 'productionMutation': False,
                'before': before_ref, 'patch': patch_ref, 'response': response_ref}
        return self.with_journal(lambda: self.phase('dryrun', fn))

    def publish(self):
        self.prior('dryrun')
        def fn():
            need(self.load('dryrun.response.original.json')['spec'] == self.desired, 'Dryrun tuple changed')
            before = self.preflight(); before_ref = self.save('publish.before.original.json', before)
            prepared = patch(before, self.desired); patch_ref = self.save('publish.patch.original.json', prepared)
            # Saving a local receipt is not another target call. The immediately
            # preceding remote operation is the maintained target preflight.
            response = s.cohort.parse_json(self.stage.remote(['patch', 'deployment', before['metadata']['name'], '-n', self.stage.namespace, '--type=json', '--patch-file=/dev/stdin', '-o', 'json'], raw(prepared)))
            need(response['metadata']['uid'] == before['metadata']['uid'] and response['spec'] == self.desired, 'Atomic frontend patch differs')
            response_ref = self.save('publish.response.original.json', response)
            return {'status': 'ACTUAL_FRONTEND_PATCHED_ACCEPTANCE_PENDING', 'productionMutation': True,
                'before': before_ref, 'patch': patch_ref, 'response': response_ref}
        return self.with_journal(lambda: self.phase('publish', fn))

    def observe(self):
        self.prior('publish')
        def fn():
            self.stage.remote(['rollout', 'status', 'deployment/' + self.stage.before['metadata']['name'], '-n', self.stage.namespace, '--timeout=240s'], timeout=260)
            actual = self.fresh(True)
            owner_before = self.save('owner-before.original.json', {'deployment': actual, 'pod': self.stage.owner, 'replicaSet': self.stage.replica})
            binding = s.l.serving_binding(s.l.held(owner_before), self.stage.prepared, self.stage.target['node']['name'])
            physical = {'static': self.stage.physical('qualifier', owner=True), 'models': self.stage.physical('qualifier', models=True, owner=True)}
            memory = self.stage.measure(owner=True)
            native_http = self.save('owning-native-http.actual.json', self.stage.native_http(self.stage.owner))
            http = s.module('delivery_publication_http', 'public-delivery-http.py')
            models = http.verify_models_tls(self.stage.context['origin'], self.stage.models, telemetry=lambda value: self.save('owning-models-tls.timing.actual.json', value))
            models_ref = self.save('owning-models-tls.actual.json', models)
            static_ref = self.save('owning-static-tls.actual.json', http.verify_static_tls(self.stage.context['origin'], [v for v in self.stage.rows if v['path'] in s.l.a.overlay.FIXED]))
            need(self.stage.physical('qualifier', owner=True) == physical['static']
                and self.stage.physical('qualifier', models=True, owner=True) == physical['models'],
                'Published static/model inode and full byte closure changed during HTTP')
            final = self.fresh(True)
            owner_after = self.save('owner.original.json', {'deployment': final, 'pod': self.stage.owner, 'replicaSet': self.stage.replica})
            need(binding == s.l.serving_binding(s.l.held(owner_after), self.stage.prepared, self.stage.target['node']['name']),
                 'Published owner/process changed across serving observation')
            return {'status': 'ACTUAL_FRONTEND_ROOT_SERVING_VERIFIED', 'deploymentUID': actual['metadata']['uid'], 'deploymentSpecSha256': s.l.digest(actual['spec']),
                'source': self.stage.prepared['source'], 'manifest': self.stage.prepared['manifest'], 'mapSha256': self.stage.prepared['mapSha256'],
                'physical': physical, 'memory': memory,
                'evidence': {'ownerBefore': owner_before, 'ownerAfter': owner_after, 'nativeHTTP': native_http,
                    'staticTLS': static_ref, 'modelsTLS': models_ref},
                'modelsMountedByStaging': False, 'allProtectedSpecsVerified': True, 'browserAcceptanceClaimed': False, 'productionMutation': False}
        observed = self.with_journal(lambda: self.phase('observe', fn))
        def handoff():
            ref = lambda name: {'path': str(self.out / name), 'sha256': s.l.a.checksum(self.out / name)}
            proof = {'version': 1, 'input': {'path': str(self.path), 'sha256': self.input_sha},
                'operator': {'path': str(Path(__file__).resolve()), 'sha256': self.operator_sha},
                'phases': {name: {kind: ref(name + '.' + kind + '.json') for kind in ['started', 'accepted']}
                    for name in ['dryrun', 'publish', 'observe']}}
            accepted = s.l.publication_baseline(proof)
            return {'status': 'ACTUAL_SERVING_BASELINE_RECORDED', 'acceptedRelease': self.save('accepted-release.actual.json', accepted),
                'observation': observed, 'productionMutation': False, 'browserAcceptanceClaimed': False}
        self.phase('handoff', handoff)
        return observed

    def rollback(self):
        self.prior('publish')
        def fn():
            before = self.preflight(True); original = self.stage.before['spec']; prepared = patch(before, original); self.save('rollback.patch.original.json', prepared)
            response = s.cohort.parse_json(self.stage.remote(['patch', 'deployment', before['metadata']['name'], '-n', self.stage.namespace, '--type=json', '--patch-file=/dev/stdin', '-o', 'json'], raw(prepared)))
            need(response['metadata']['uid'] == before['metadata']['uid'] and response['spec'] == original, 'Guarded actual inverse patch differs'); self.save('rollback.response.original.json', response)
            return {'status': 'ACTUAL_FRONTEND_INVERSE_PATCHED_RUNTIME_ACCEPTANCE_PENDING', 'productionMutation': True, 'claimsDeleted': False}
        return self.with_journal(lambda: self.phase('rollback', fn))


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action', choices=['check', 'dryrun', 'publish', 'observe', 'rollback'])
    parser.add_argument('--input', required=True); parser.add_argument('--reviewed-input-sha256', required=True); parser.add_argument('--reviewed-operator-sha256', required=True)
    args = parser.parse_args(); op = Publication(args.input, args.reviewed_input_sha256, args.reviewed_operator_sha256)
    print(raw({'status': 'ACTUAL_RETIRED_FRONTEND_BOUND_NOT_PUBLISHED'} if args.action == 'check' else getattr(op, args.action)()).decode())


if __name__ == '__main__':
    try: main()
    except Exception as error: print('Public frontend publication refused: ' + str(error), file=sys.stderr); raise SystemExit(1)
