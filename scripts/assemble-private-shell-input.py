#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Assemble private preparation evidence from original local build and CI receipts.

Offline only: read held files and immutable Git objects, then write a new protected
input directory. The maintained preparer still verifies complete trees, catalogue
signatures and compatibility. This adapter neither builds nor executes profiles.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

shell = module('input_shell', 'prepare-private-shell.py')
update = module('input_update', 'update-private-shell.py')
cohort = shell.cohort
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
STATUS = 'PRIVATE_SHELL_INPUT_ASSEMBLED_NOT_PREPARED_NOT_APPLIED'
PROFILE_KEYS = {'version', 'status', 'instance', 'work', 'brand', 'profile', 'settings', 'rawPack', 'selection', 'publicPinSha256', 'producerSourceSha256'}
PRODUCER_KEYS = {'version', 'status', 'lollySource', 'engineSource', 'previousShellSource', 'workSource', 'brandCommit', 'profile', 'enginePinSha256', 'shellManifestSha256', 'settings', 'workspaceModules', 'originalReport', 'classification', 'engineClassification', 'custody', 'previousAcceptance', 'ci', 'publicKey', 'previous', 'candidate', 'shell', 'delta', 'retention', 'webGate', 'catalog', 'producer', 'originAuthenticatedByThisCommand', 'normalCIQualified', 'runtimeQualified', 'promotionAttempted', 'outstanding'}
CUSTODY_KEYS = {'version', 'engineSource', 'workSource', 'brandCommit', 'enginePinSha256', 'profile', 'settings', 'previousManifest', 'previousAcceptance', 'ci', 'publicKeySha256'}
PREFIXES = ('engine/', 'packages/core/', 'packages/node-shell/', 'packages/rondo/', 'packages/audio-dock/')
BOUNDARY = {'originAuthenticatedByThisCommand': False, 'runtimeQualified': False, 'productionMutation': False, 'buildOrSigningPerformed': False, 'targetContacted': False}
DEPENDENCIES = ('assemble-private-shell-input.py', *update.DEPENDENCIES, 'prepare-shell-update.ts', 'shell-update-vite.mjs')


def manifest_id(manifest):
    exact(manifest, {'version', 'files', 'totalBytes'})
    require(type(manifest['version']) is int and manifest['version'] == 1 and type(manifest['files']) is list and 1 <= len(manifest['files']) <= cohort.MAX_FILES and type(manifest['totalBytes']) is int, 'Bounded complete manifest required')
    files = {}
    for row in manifest['files']:
        exact(row, {'path', 'size', 'sha256'}); path = cohort.safe_path(row['path'])
        require(path not in files and type(row['size']) is int and 0 <= row['size'] <= cohort.MAX_BYTES, 'Unique bounded manifest entry required')
        files[path] = {**row, 'sha256': cohort.sha(row['sha256'])}
    require(list(files) == sorted(files) and sum(row['size'] for row in files.values()) == manifest['totalBytes'] <= cohort.MAX_BYTES, 'Complete manifest total/order differs')
    # Match the established JavaScript UTF-16 depth-first release-ID order.
    ordered = sorted(files, key=lambda path: tuple(part.encode('utf-16-be') for part in path.split('/')))
    import json
    return 'release-' + hashlib.sha256(json.dumps([[path, files[path]['sha256']] for path in ordered], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()[:16]


class Adapter:
    def __init__(self, profile, instance, candidate, producer, claim, operator_sha):
        self.inputs = cohort.Inputs(Path.cwd()); self.tree_roots = set()
        own = self.ref({'path': str(Path(__file__).absolute()), 'sha256': cohort.sha(operator_sha)}, False)
        self.source_files = [own]
        for filename in dict.fromkeys(DEPENDENCIES):
            if filename != Path(__file__).name:
                path = Path(__file__).with_name(filename)
                self.source_files.append(self.ref({'path': str(path), 'sha256': hashlib.sha256(cohort.read_file(path)[0]).hexdigest()}, False))
        self.profile_ref = self.ref(profile); profile = self.inputs.file(self.profile_ref)
        self.inputs.base = Path(self.profile_ref['path']).parent
        exact(profile, PROFILE_KEYS)
        require(type(profile['version']) is int and profile['version'] == 1 and profile['status'] == 'REVIEWED_PRIVATE_SHELL_PREPARATION_PROFILE', 'Reviewed preparation profile required')
        self.instance_ref = self.ref(instance); instance = self.inputs.file(self.instance_ref)
        exact(instance, update.PROFILE_KEYS, {'authenticatedStaticProbe', 'authenticatedCatalog', 'stageNamePrefix'})
        require(type(instance['version']) is int and instance['version'] == 1 and instance['status'] == 'REVIEWED_PRIVATE_SHELL_UPDATE_PROFILE', 'Reviewed execution profile required')
        exact(profile['instance'], {'name', 'targetSha256'})
        require(profile['instance']['name'] == instance['name'] and profile['instance']['targetSha256'] == instance['target']['sha256'], 'Preparation and execution instance differ')
        self.ref(instance['target'], base=Path(self.instance_ref['path']).parent)
        self.candidate_ref = self.ref(candidate); candidate = self.inputs.file(self.candidate_ref)
        self.candidate = self.source(candidate, Path(self.candidate_ref['path']).parent)
        self.work = self.source(profile['work'], Path(self.profile_ref['path']).parent)
        self.root, run = cohort.source_record(self.candidate, self.inputs, shell.git_command, 'lolly')
        work_root, _ = cohort.source_record(self.work, self.inputs, shell.git_command, 'work')
        previous_ref = self.ref(instance['previous'], base=Path(self.instance_ref['path']).parent)
        previous, before = shell.previous_record(previous_ref, self.inputs)
        require(self.work['source'] == previous['workSource'], 'Accepted image Work source changed')
        engine_pin, resolver_pin = [self.ref(previous[key], base=Path(previous_ref['path']).parent) for key in ('enginePin', 'resolverPin')]
        for ref, filename in ((engine_pin, 'engine-pin.json'), (resolver_pin, 'content-resolver-pin.json')):
            require(cohort.git_bytes(work_root, previous['workSource'], filename, shell.git_command) == cohort.read_file(Path(ref['path']))[0], 'Accepted pin differs from committed Work')
        exact(profile['brand'], {'path', 'commit'})
        require(cohort.safe_path(profile['brand']['path']).startswith('brands/') and shell.git_command(['git', 'ls-tree', self.candidate['source'], '--', profile['brand']['path']], self.root).strip().split() == ['160000', 'commit', cohort.commit(profile['brand']['commit']), profile['brand']['path']], 'Private brand source differs')
        require(type(profile['profile']) is str and cohort.NAME.fullmatch(profile['profile']) and profile['profile'] not in {'neutral', 'community', 'public'}, 'Private brand profile required')
        exact(profile['settings'], {'catalogTrustMode', 'requireAiPolicy', 'liveRelay', 'siteUrl'})
        require(profile['settings']['catalogTrustMode'] == 'verified' and profile['settings']['requireAiPolicy'] is True and re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]{1,5})?/live', profile['settings']['liveRelay']) and re.fullmatch(r'https://[a-z0-9.-]+(?::[0-9]{1,5})?', profile['settings']['siteUrl']), 'Verified private HTTPS settings required')
        public_pin = self.ref(instance['publicKey'], base=Path(self.instance_ref['path']).parent)
        public = self.inputs.file(public_pin); exact(public, {'kty', 'crv', 'x', 'y'})
        require(public['kty'] == 'EC' and public['crv'] == 'P-256' and cohort.digest(public) == cohort.sha(profile['publicPinSha256']), 'Public-only P256 pin differs')
        self.producer_ref = self.ref(producer); produced = self.inputs.file(self.producer_ref)
        exact(produced, PRODUCER_KEYS)
        require(type(produced['version']) is int and produced['version'] == 1 and produced['status'] == 'LOCAL_PRIVATE_SHELL_UPDATE_PREPARED_UNQUALIFIED' and all(produced[key] is False for key in ('originAuthenticatedByThisCommand', 'normalCIQualified', 'runtimeQualified', 'promotionAttempted')), 'Original unqualified producer boundary differs')
        require(all(produced[key] == value for key, value in {'lollySource': self.candidate['source'], 'engineSource': previous['engineSource'], 'previousShellSource': previous['shellSource'], 'workSource': previous['workSource'], 'brandCommit': profile['brand']['commit'], 'profile': profile['profile'], 'enginePinSha256': engine_pin['sha256'], 'settings': profile['settings']}.items()), 'Producer candidate or accepted settings differ')
        base = Path(self.producer_ref['path']).parent
        custody_ref = self.ref(produced['custody'], base=base); custody = self.inputs.file(custody_ref); exact(custody, CUSTODY_KEYS)
        require(type(custody['version']) is int and custody['version'] == 1 and all(custody[key] == produced[key] for key in ('engineSource', 'workSource', 'brandCommit', 'enginePinSha256', 'profile', 'settings')), 'Original producer custody differs')
        accepted_ref = self.ref(previous['acceptance'], base=Path(previous_ref['path']).parent)
        acceptance = self.inputs.file(accepted_ref)
        require(self.ref(produced['previousAcceptance'], base=base) == self.ref(custody['previousAcceptance'], base=Path(custody_ref['path']).parent) == self.ref(acceptance['originalEvidence'][0], base=Path(accepted_ref['path']).parent), 'Producer used another accepted runtime')
        require(self.ref(produced['ci'], base=base) == self.ref(custody['ci'], base=Path(custody_ref['path']).parent) == self.candidate['ciRun'], 'Producer used another normal CI run')
        require(self.ref(produced['publicKey'], base=base) == public_pin and custody['publicKeySha256'] == public_pin['sha256'], 'Producer public pin differs')
        old = self.tree(instance['previousShell'], Path(self.instance_ref['path']).parent)
        candidate_tree, retained = [self.tree(produced[key], base, producer=True) for key in ('candidate', 'shell')]
        producer_old = self.tree(produced['previous'], base, producer=True)
        require(producer_old['root'] == old['root'] and producer_old['manifest']['sha256'] == old['manifest']['sha256'] and old['manifest']['sha256'] == previous['shell']['manifestSha256'] and self.ref(custody['previousManifest'], base=Path(custody_ref['path']).parent) == old['manifest'] and produced['shellManifestSha256'] == retained['manifest']['sha256'], 'Producer accepted snapshot/manifest differs')
        raw_pack = self.tree(profile['rawPack'], Path(self.profile_ref['path']).parent)
        require(raw_pack['manifest']['sha256'] == previous['pack']['manifestSha256'], 'Accepted raw pack differs')
        producer_source = self.sized_ref(produced['producer'], base)
        require(Path(producer_source['path']).name == 'prepare-shell-update.ts' and producer_source['sha256'] == cohort.sha(profile['producerSourceSha256']) == hashlib.sha256(cohort.read_file(Path(__file__).with_name('prepare-shell-update.ts'))[0]).hexdigest(), 'Reviewed producer implementation differs')
        classification = self.ref(produced['classification'], base=base)
        shell.compatibility(self.root, previous, self.candidate['source'], self.inputs.file(classification), shell.git_command)
        engine_classification = self.inputs.file(self.ref(produced['engineClassification'], base=base))
        shell.compatibility(self.root, {**previous, 'shellSource': previous['engineSource']}, self.candidate['source'], engine_classification, shell.git_command)
        release_classification = self.inputs.file(classification)
        require(release_classification.get('base') == previous['shellSource'] and release_classification.get('candidate') == self.candidate['source'] and release_classification.get('classification') == 'web-shell-only', 'Producer release classification differs')
        modules_ref = self.sized_ref(produced['workspaceModules'], base); modules = self.inputs.file(modules_ref)
        exact(modules, {'version', 'source', 'modules', 'guardIncludesWorkerGraph', 'normalCIQualified', 'productionAuthority'})
        require(type(modules['version']) is int and modules['version'] == 1 and modules['source'] == str(self.root) and modules['guardIncludesWorkerGraph'] is True and modules['normalCIQualified'] is False and modules['productionAuthority'] is False and type(modules['modules']) is list and 1 <= len(modules['modules']) <= 5000, 'Compiled worker/module graph differs')
        reviewed_modules, seen = [], set()
        for row in modules['modules']:
            exact(row, {'path', 'bytes', 'sha256'})
            require(type(row['path']) is str and row['path'].startswith(str(self.root) + '/'), 'Compiled module is outside candidate')
            relative = cohort.safe_path(row['path'][len(str(self.root)) + 1:]); data = cohort.git_bytes(self.root, self.candidate['source'], relative, shell.git_command)
            require(relative.startswith(PREFIXES) and relative not in seen and type(row['bytes']) is int and row['bytes'] == len(data) and hashlib.sha256(data).hexdigest() == cohort.sha(row['sha256']), 'Compiled immutable module differs')
            seen.add(relative); reviewed_modules.append({'path': relative, 'sha256': row['sha256']})
        original_build = self.ref(produced['originalReport'], base=base); build = self.command(original_build)
        require(len(build['command']) == 4 and Path(build['command'][1]).name == 'shell-update-vite.mjs' and Path(build['command'][1]).parent == Path(producer_source['path']).parent, 'Original Vite invocation differs')
        self.ref({'path': build['command'][1], 'sha256': hashlib.sha256(cohort.read_file(Path(__file__).with_name('shell-update-vite.mjs'))[0]).hexdigest()}, False)
        runner_ref = self.ref({'path': build['command'][2], 'sha256': build['command'][3]}, base=base); runner = self.inputs.file(runner_ref)
        exact(runner, {'source', 'sourceCommit', 'output', 'prerequisites', 'moduleReceipt'})
        require(runner['source'] == str(self.root) and runner['sourceCommit'] == self.candidate['source'] and runner['output'] == candidate_tree['root'] and runner['moduleReceipt'] == modules_ref['path'], 'Original Vite candidate/modules binding differs')
        original_gate = self.ref(produced['webGate'], base=base); gate = self.command(original_gate)
        require(gate['command'][0] == build['command'][0] and len(gate['command']) == 4 and gate['stderr'] == '' and gate['command'][1:] == ['scripts/webgpu-release-gate.ts', '--scope', 'web'] and gate['stdout'] in {'WebGPU release gate (web): docs/supported-environments.md covers 3 required environments; platform/version limits remain as published.\n', 'WebGPU release gate: the web shell does not require WebGPU at startup; nothing to check.\n'}, 'Original explicit web gate differs')
        exact(profile['selection'], {'container', 'shellVolume', 'packVolume', 'pinVolume'})
        require(type(claim) is str and cohort.NAME.fullmatch(claim) and claim not in {previous['shell']['name'], previous['pack']['name'], previous['pin']['name']}, 'Unused explicit shell claim required')
        selection = {**profile['selection'], 'shellClaim': claim}
        shell.change_tuple(before, previous, selection, self.candidate['source'], produced['shell']['shellId'])
        self.build = {'version': 1, 'status': 'PRIVATE_WEB_BUILD_REVIEWED', **{key: produced[key] for key in ('lollySource', 'engineSource', 'workSource', 'brandCommit', 'profile', 'enginePinSha256')}, 'shellManifestSha256': candidate_tree['manifest']['sha256'], 'settings': {'scope': 'web', 'requireCatalogSignature': True, 'requireAiPolicy': True, 'relayOrigin': profile['settings']['liveRelay']}, 'workspaceModules': reviewed_modules, 'originalReport': original_build}
        self.gate = {'version': 1, 'status': 'PASS', 'source': self.candidate['source'], 'scope': 'web', 'scriptSha256': hashlib.sha256(cohort.git_bytes(self.root, self.candidate['source'], 'scripts/webgpu-release-gate.ts', shell.git_command)).hexdigest(), 'originalReport': original_gate}
        self.evidence = {'version': 1, 'lolly': self.candidate, 'work': self.work, 'enginePin': engine_pin, 'resolverPin': resolver_pin, 'brand': profile['brand'], 'profile': profile['profile'], 'publicPin': public_pin, 'candidateShell': candidate_tree, 'previousShell': old, 'shell': retained, 'rawPack': raw_pack, 'previous': previous_ref, 'selection': selection, 'classification': classification}
        self.public_pin_sha = profile['publicPinSha256']; self.inputs.unchanged()

    def ref(self, value, as_json=True, base=None):
        exact(value, {'path', 'sha256'})
        ref = {'path': str(cohort.local_path(value['path'], base or self.inputs.base)), 'sha256': cohort.sha(value['sha256'])}
        self.inputs.file(ref, as_json); return ref

    def source(self, value, base):
        exact(value, {'root', 'source', 'repository', 'main', 'ciRun', 'ciJobs'})
        return {**value, 'root': str(cohort.local_path(value['root'], base)), **{key: self.ref(value[key], base=base) for key in ('main', 'ciRun', 'ciJobs')}}

    def sized_ref(self, value, base):
        exact(value, {'path', 'sha256', 'size'})
        ref = self.ref({key: value[key] for key in ('path', 'sha256')}, False, base)
        require(type(value['size']) is int and Path(ref['path']).stat().st_size == value['size'], 'Original sized file differs')
        return ref

    def tree(self, value, base, producer=False):
        exact(value, {'root', 'manifest', 'shellId', 'files'} if producer else {'root', 'manifest'})
        result = {'root': str(cohort.local_path(value['root'], base)), 'manifest': self.ref(value['manifest'], base=base)}
        self.tree_roots.add(Path(result['root']))
        manifest = self.inputs.file(result['manifest']); identity = manifest_id(manifest)
        require(type(manifest.get('version')) is int and manifest['version'] == 1 and type(manifest.get('files')) is list and len(manifest['files']) > 0, 'Complete original tree manifest required')
        if producer:
            require(type(value['files']) is int and value['files'] == len(manifest['files']) and value['shellId'] == identity, 'Producer tree count/identity differs')
        return result

    def command(self, ref):
        value = self.inputs.file(ref); exact(value, {'command', 'exitCode', 'signal', 'seconds', 'stdout', 'stderr', 'error'})
        require(type(value['command']) is list and len(value['command']) > 0 and all(type(x) is str and x for x in value['command']) and Path(value['command'][0]).is_absolute() and type(value['exitCode']) is int and value['exitCode'] == 0 and value['signal'] is None and value['error'] is None and type(value['seconds']) in {int, float} and value['seconds'] >= 0 and type(value['stdout']) is str and type(value['stderr']) is str, 'Original local command did not succeed')
        return value

    def publish(self, directory):
        self.inputs.unchanged(); wanted = Path(os.path.abspath(directory))
        roots = self.tree_roots | set(self.inputs.source_roots)
        require(all(wanted != root and root not in wanted.parents and wanted not in root.parents for root in roots), 'Assembly output must not overlap accepted/build/source trees')
        out = update.private_new_directory(wanted)
        update.save(out, 'assembly.started.json', {'version': 1, 'status': 'PRIVATE_SHELL_INPUT_ASSEMBLY_STARTED', 'profile': self.profile_ref, 'instance': self.instance_ref, 'candidate': self.candidate_ref, 'producer': self.producer_ref, 'sourceFiles': self.source_files, 'qualificationBoundary': BOUNDARY})
        self.inputs.unchanged()
        evidence = {**self.evidence, 'build': update.save(out, 'build.reviewed.json', self.build), 'webGate': update.save(out, 'web-gate.reviewed.json', self.gate)}
        evidence_ref = update.save(out, 'shell-input.reviewed.json', evidence)
        self.inputs.unchanged()
        return update.save(out, 'assembly.actual.json', {'version': 1, 'status': STATUS, 'evidence': evidence_ref, 'existingPublicPinSha256': self.public_pin_sha, 'qualificationBoundary': BOUNDARY, 'originalInputs': [{'path': str(path), 'sha256': sha} for path, (_, sha) in sorted(self.inputs.reads.items())], 'requiredNext': 'Run unchanged prepare-private-shell.py against this exact reviewed evidence before any execution'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('preparation-profile', 'instance-profile', 'candidate', 'producer'):
        parser.add_argument('--' + key, required=True); parser.add_argument('--' + key + '-sha256', required=True)
    parser.add_argument('--shell-claim', required=True); parser.add_argument('--operator-sha256', required=True); parser.add_argument('--out-dir', required=True)
    args = parser.parse_args()
    refs = [{'path': getattr(args, key), 'sha256': getattr(args, key + '_sha256')} for key in ('preparation_profile', 'instance_profile', 'candidate', 'producer')]
    result = Adapter(*refs, args.shell_claim, args.operator_sha256).publish(args.out_dir)
    print(cohort.canonical({'status': STATUS, 'assemblySha256': result['sha256'], **BOUNDARY}).decode())

if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print('REFUSED: original build, CI, accepted baseline or reviewed profile differs; preserve partial outputs', file=sys.stderr)
        raise SystemExit(1)
