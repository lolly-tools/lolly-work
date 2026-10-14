#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Publish a prepared shell; resume only phases with original successful receipts.

The maintained preparer owns artifact verification. This command reuses that
artifact, serializes an instance, checks capacity and current CI, then calls the
existing guarded stage and publisher. An uncertain mutation always stops.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


update = module('deploy_update', 'update-private-shell.py')
qualification = module('deploy_qualification', 'verify-shell-qualification.py')
need, Refusal = update.require, update.Refusal
STAGES = ('create', 'copy', 'retire-writer', 'create-qualifier', 'qualify', 'retire')
PUBLICATION = {'dryrun': 'SERVER_DRYRUN_FULL_SPEC_ACCEPTED',
               'apply': 'ATOMIC_PRIVATE_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING',
               'observe': 'ACTUAL_PRIVATE_SHELL_OWNER_CONTENT_AND_TLS_VERIFIED_ACCEPTANCE_PENDING'}


def load(ref):
    need(type(ref) is dict and set(ref) == {'path', 'sha256'} and update.file_ref(ref['path']) == ref, 'Held input changed')
    return json.loads(Path(ref['path']).read_bytes())


def successful_phase(operator, name, expected=None):
    """A started command without accepted output is never silently retried."""
    actual, intent, uncertain = [operator.out / (name + suffix) for suffix in ('.actual.json', '.started.json', '.uncertain.json')]
    need(not uncertain.exists(), f'{name} is uncertain; reconcile the original attempt')
    if actual.exists():
        need(intent.exists(), 'Successful phase lacks its original intent')
        return operator.prior(name, expected) if expected else operator.prior(name)
    need(not intent.exists(), f'{name} was interrupted; reconcile before another mutation')
    return None


def capacity(operation, out, minimum_local):
    need(shutil.disk_usage(out).free >= minimum_local, 'Local capacity reserve refused')
    operation.source_check()
    command = [sys.executable, '-B', operation.profile['hostProbe']['path'], 'capacity', '--target', operation.profile['target']['path']]
    started = time.monotonic()
    result = subprocess.run(command, capture_output=True, timeout=120)
    need(len(result.stdout) <= 1024**2 and len(result.stderr) <= 1024**2, 'Capacity response exceeds bound')
    original = {'argv': command, 'exitCode': result.returncode, 'stdout': result.stdout.decode(), 'stderr': result.stderr.decode(),
                'seconds': time.monotonic() - started}
    ref = update.save(out, 'capacity-' + uuid.uuid4().hex + '.original.json', original)
    need(result.returncode == 0, 'Host capacity read failed')
    value = json.loads(result.stdout)
    need(value.get('nodeUID') == operation.target['node']['uid'] and value.get('nodeName') == operation.target['node']['name']
         and type(value.get('freeBytes')) is int and value['freeBytes'] >= operation.profile['minimumFreeBytes'] + operation.profile['maximumWriteBytes'],
         'Host capacity reserve and candidate write budget refused')
    return ref


class Deployment:
    def __init__(self, config_ref, journal):
        self.config_ref = config_ref; self.config = load(config_ref)
        update.exact(self.config, {'version', 'profile', 'prepared', 'request', 'operatorSha256', 'qualificationVerifierSha256', 'minimumLocalFreeBytes', 'lockDirectory'})
        need(self.config['version'] == 1 and self.config['operatorSha256'] == update.file_ref(__file__)['sha256']
             and self.config['qualificationVerifierSha256'] == update.file_ref(HERE / 'verify-shell-qualification.py')['sha256'], 'Reviewed deployment helper changed')
        need(type(self.config['minimumLocalFreeBytes']) is int and self.config['minimumLocalFreeBytes'] >= 256 * 1024**2, 'Explicit local capacity reserve required')
        for name in ('profile', 'prepared', 'request'):
            load(self.config[name])
        self.out = Path(os.path.abspath(journal))
        need(self.out.resolve() == self.out and self.out.parent.resolve(strict=True) == self.out.parent, 'Canonical journal parent required')
        self.request = load(self.config['request'])
        prepared = load(self.config['prepared'])
        need(prepared['sources']['lolly'] == self.request['qualification']['source'], 'Prepared bytes belong to another source')
        tier = self.request['qualification']['qualificationTier']
        need(tier in {'public-ready', 'release-ready'} and (tier != 'release-ready' or prepared['status'] == update.stage.shell.STATUS),
             'A public-ready preparation cannot claim full qualification')
        self.lock_dir = Path(self.config['lockDirectory'])
        need(self.lock_dir.is_absolute() and self.lock_dir.resolve(strict=True) == self.lock_dir and self.lock_dir.is_dir()
             and not self.lock_dir.stat().st_mode & 0o077, 'Existing private instance lock directory required')
        profile = load(self.config['profile'])
        target = load(profile['target'])
        component = target['components']['work']
        identity = [target['clusterUID'], component['namespace'], component['deploymentUID']]
        self.lock_name = hashlib.sha256(json.dumps(identity).encode()).hexdigest() + '.lock'

    def operation(self):
        cfg = self.config
        return update.Update(cfg['profile']['path'], cfg['profile']['sha256'], cfg['prepared']['path'], cfg['prepared']['sha256'],
                             update.file_ref(HERE / 'update-private-shell.py')['sha256'])

    def unchanged(self):
        need(load(self.config_ref) == self.config, 'Deployment configuration changed')
        for key in ('profile', 'prepared', 'request'):
            load(self.config[key])
        need(update.file_ref(__file__)['sha256'] == self.config['operatorSha256']
             and update.file_ref(HERE / 'verify-shell-qualification.py')['sha256'] == self.config['qualificationVerifierSha256'], 'Deployment source changed')

    def checkpoint(self, name, action):
        path = self.out / (name + '.checkpoint.json')
        if path.exists():
            value = json.loads(path.read_bytes())
            need(value['config'] == self.config_ref, 'Checkpoint belongs to another deployment')
            load(value['result'])
            return value['result']
        directory = update.private_new_directory(self.out / (name + '-' + uuid.uuid4().hex))
        start = time.monotonic(); result = action(directory)
        load(result)
        update.save(self.out, path.name, {'config': self.config_ref, 'result': result, 'seconds': time.monotonic() - start})
        return result

    def fresh_ci(self):
        self.unchanged()
        value = qualification.verify(self.request)
        return update.save(self.out, 'ci-' + uuid.uuid4().hex + '.original.json', value)

    def run(self):
        descriptor = os.open(self.lock_dir / self.lock_name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self.locked_run()
        except BlockingIOError as error:
            raise Refusal('Another operator holds this instance publication lock') from error
        finally:
            os.close(descriptor)

    def locked_run(self):
        if not self.out.exists():
            update.private_new_directory(self.out)
            update.save(self.out, 'intent.json', {'version': 1, 'config': self.config_ref})
        need(self.out.is_dir() and not self.out.stat().st_mode & 0o077
             and json.loads((self.out / 'intent.json').read_bytes()) == {'version': 1, 'config': self.config_ref}, 'Existing journal configuration differs')
        self.unchanged()
        complete = self.out / 'accepted.json'
        if complete.exists():
            value = json.loads(complete.read_bytes())
            load(value['acceptedPrevious']); load(value['nextProfile'])
            return update.file_ref(complete)
        operation = self.operation()
        plan_checkpoint = self.out / 'publication.checkpoint.json'
        plan_ref = json.loads(plan_checkpoint.read_bytes())['result'] if plan_checkpoint.exists() else None
        planned = load(plan_ref) if plan_ref else None
        applied = planned and (Path(planned['executionDirectory']) / 'apply.actual.json').exists()
        if not applied:
            self.fresh_ci()
            capacity(operation, self.out, self.config['minimumLocalFreeBytes'])
        check = self.checkpoint('stage-check', lambda directory: operation.assemble_check(
            operation.read_capture(update.private_new_directory(directory / 'capture')), update.private_new_directory(directory / 'check')))
        checked = load(check)
        stager = update.stage.Stage(checked['stageInput']['path'], checked['stageInput']['sha256'], checked['stageOperator']['sha256'])
        staged = None
        for name in STAGES:
            operation.source_check(); self.unchanged()
            staged = successful_phase(stager, name)
            if staged is None:
                print('Stage: ' + name, flush=True)
                staged = stager.execute(name)
        need(staged['claimsRetained'] is True and staged['activeProductionTupleMutated'] is False, 'Unexpected staging boundary')
        stage_ref = staged['stage']; load(stage_ref)
        planned_ref = self.checkpoint('publication', lambda directory: operation.assemble_plan(check,
            operation.read_capture(update.private_new_directory(directory / 'capture')), stage_ref, update.private_new_directory(directory / 'plan')))
        planned = load(planned_ref)
        publication = update.publisher.Publication(planned['publicationInput']['path'], planned['publicationInput']['sha256'],
                                                  planned['publicationOperator']['sha256'], planned['executionDirectory'])
        for name, expected in PUBLICATION.items():
            operation.source_check(); self.unchanged()
            if successful_phase(publication, name, expected) is None:
                if name == 'apply':
                    self.fresh_ci()
                print('Publication: ' + name, flush=True)
                try:
                    getattr(publication, name)()
                except Exception:
                    marker = publication.out / (name + '.started.json')
                    if marker.exists() and not (publication.out / (name + '.uncertain.json')).exists():
                        publication.save(name + '.uncertain.json', {**publication.header('REFUSED_NO_REPLAY_RECONCILE_ORIGINAL_STATE')})
                    raise
        observed = publication.prior('observe', PUBLICATION['observe'])
        accepted = operation.ref(observed['acceptedPrevious'], operation.inputs.base)
        next_profile = self.checkpoint('next-profile', lambda directory: operation.next_profile(accepted, directory))
        return update.save(self.out, 'accepted.json', {'version': 1, 'status': 'PRIVATE_SHELL_UPDATE_RUNTIME_ACCEPTED',
            'config': self.config_ref, 'acceptedPrevious': accepted, 'nextProfile': next_profile, 'prepared': self.config['prepared'],
            'qualificationTier': self.request['qualification']['qualificationTier'], 'productionMutation': True,
            'remainingAcceptance': ['Authenticated export and document-agent canaries', 'Signed-in reconnect and visual checks']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True); parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--journal', required=True)
    args = parser.parse_args()
    deployment = Deployment({'path': args.config, 'sha256': args.config_sha256}, args.journal)
    result = deployment.run()
    print(json.dumps({'status': 'RUNTIME_ACCEPTED_CANARIES_PENDING', 'receipt': result}, sort_keys=True))


if __name__ == '__main__':
    main()
