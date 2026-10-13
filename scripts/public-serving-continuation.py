# SPDX-License-Identifier: MPL-2.0
"""Read-only source and journal custody for an explicit serving continuation."""
import re
from pathlib import Path


def process_context(data):
    if type(data) is not bytes or not 0 < len(data) <= 257:
        raise RuntimeError('Bounded native process label required')
    # procfs may terminate a security context with one NUL. Only that terminal
    # byte is framing; embedded/repeated NUL and arbitrary whitespace refuse.
    if data.endswith(b'\0'):
        data = data[:-1]
    elif data.endswith(b'\n'):
        data = data[:-1]
    text = data.decode('ascii')
    if not re.fullmatch(r'[A-Za-z0-9_]+:[A-Za-z0-9_]+:[A-Za-z0-9_]+:s[0-9]+(?::c[0-9]+(?:[,.]c?[0-9]+)*)?', text):
        raise RuntimeError('Canonical native SELinux context required')
    return text


def owner_model_label(stage, observed, expected, owner):
    old, actual = expected['root']['selinuxLabel'], observed['root']['selinuxLabel']
    if actual != old:
        if old is None or actual is None or actual.split(':', 3)[:3] != old.split(':', 3)[:3]:
            raise RuntimeError('Model filesystem label type/identity changed')
        current = process_context(stage.remote(['exec', '-n', stage.namespace, owner['metadata']['name'], '-c', stage.container, '--', 'cat', '/proc/1/attr/current']))
        if current.split(':', 3)[3] != actual.split(':', 3)[3]:
            raise RuntimeError('New model MCS label does not belong to verified native owner')
        expected['root']['selinuxLabel'] = actual


def request(l, value, original_proof=None):
    need, exact, held = l.need, l.exact, l.held
    prior = value.get('priorForwardObservation')
    exact(value, {'version', 'status', 'originalInput', 'originalOperator', 'originalPhases', 'failedObservation',
                  'originalCommands', 'failureEvidence', 'sources', 'outputDirectory'} | ({'priorForwardObservation'} if prior is not None else set()))
    need(value['version'] == 1 and value['status'] == 'REVIEWED_PUBLIC_FORWARD_SERVING_OBSERVATION_NOT_EXECUTED', 'Explicit forward observation request required')
    original = held(value['originalInput']); l.a.read_ref(value['originalOperator'])
    directory = Path(original['outputDirectory']); output = Path(value['outputDirectory'])
    need(output.is_absolute() and output.resolve() == output and output != directory
         and directory not in output.parents and output not in directory.parents, 'Separate canonical forward journal required')
    exact(value['originalPhases'], {'dryrun', 'publish'})
    for name, refs in value['originalPhases'].items():
        exact(refs, {'started', 'accepted'})
        need(not (directory / (name + '.uncertain.json')).exists(), 'Uncertain original switch cannot continue')
        for kind, ref in refs.items():
            need(ref['path'] == str(directory / (name + '.' + kind + '.json')), 'Exact original switch journal required')
            row = held(ref)
            need(row['inputSha256'] == value['originalInput']['sha256'] and row['operatorSha256'] == value['originalOperator']['sha256'], 'Original switch source/input differs')
        row = held(refs['accepted'])
        need(row['status'] == ('ACTUAL_MATCHED_SERVER_DRYRUN_NOT_PUBLISHED' if name == 'dryrun' else 'ACTUAL_MATCHED_PATCHED_ACCEPTANCE_PENDING')
             and row['productionMutation'] is (name == 'publish'), 'Actual successful original switch required')
    exact(value['failedObservation'], {'started', 'uncertain'})
    for kind, ref in value['failedObservation'].items():
        need(ref['path'] == str(directory / ('observe.' + kind + '.json')), 'Original failed observation must remain visible')
    started, uncertain = [held(value['failedObservation'][k]) for k in ['started', 'uncertain']]
    need(started == {'status': 'STARTED_NO_REPLAY', 'inputSha256': value['originalInput']['sha256'], 'operatorSha256': value['originalOperator']['sha256']}
         and uncertain == {'status': 'REFUSED_NO_REPLAY', 'failureType': 'Refusal'}, 'Exact original observation refusal required')
    need(not (directory / 'observe.accepted.json').exists() and not (directory / 'handoff.accepted.json').exists(), 'Original refusal cannot become ordinary acceptance')
    refs = value['originalCommands']; need(type(refs) is list and refs, 'Complete original command journal required')
    paths = [r['path'] for r in refs]
    need(paths == sorted(str(p) for p in directory.glob('command-*.actual.json')) and len(paths) == len(set(paths)), 'Complete unchanged original command set required')
    for ref in refs:
        row = held(ref)
        need(row.get('complete') is True, 'Complete original command streams required')
        for stream in ['stdout', 'stderr']:
            need(Path(row[stream]['path']).parent == directory, 'Original command stream escaped journal'); l.a.read_ref(row[stream])
    exact(value['failureEvidence'], {'process', 'modelRoot'})
    process_ref, root_ref = [value['failureEvidence'][k] for k in ['process', 'modelRoot']]
    need(process_ref in refs and root_ref in refs, 'Original label failure commands must be retained')
    process, root_command = held(process_ref), held(root_ref)
    need(process['exitCode'] == root_command['exitCode'] == 0 and process.get('failure') is None and root_command.get('failure') is None, 'Successful original label reads required')
    raw = l.a.read_ref(process['stdout']); root = held(root_command['stdout'])
    need(raw.endswith(b'\0') and raw.count(b'\0') == 1 and process_context(raw).split(':', 3)[3] == root['root']['selinuxLabel'].split(':', 3)[3], 'Original failure is not the exact terminal-NUL framing case')
    need(type(value['sources']) is list and value['sources'] and len({r['path'] for r in value['sources']}) == len(value['sources']), 'Closed unique forward source closure required')
    for ref in value['sources']: l.a.read_ref(ref)
    observers = [r for r in value['sources'] if Path(r['path']).name == 'observe-forward.py']
    helpers = [r for r in value['sources'] if Path(r['path']).name == 'public-serving-continuation.py']
    need(len(observers) == len(helpers) == 1 and Path(helpers[0]['path']) == Path(observers[0]['path']).parent / 'sources/public-serving-continuation.py', 'Original continuation validator is outside held observer closure')
    if prior is not None:
        exact(prior, {'input', 'operator', 'started', 'uncertain', 'commands', 'ownerBefore'})
        previous = held(prior['input']); need('priorForwardObservation' not in previous, 'Only one original failed forward observation may continue')
        previous_binding = request(l, previous)
        for key in ['originalInput', 'originalOperator', 'originalPhases', 'failedObservation', 'originalCommands', 'failureEvidence']:
            need(previous[key] == value[key], 'Forward attempts must retain identical original switch lineage')
        need(prior['operator'] in previous['sources'] and Path(prior['operator']['path']).name == 'observe-forward.py', 'Exact prior forward source required')
        prior_directory = Path(previous['outputDirectory'])
        need(output != prior_directory and output not in prior_directory.parents and prior_directory not in output.parents, 'Forward journals must remain separate')
        for kind in ['started', 'uncertain']:
            need(prior[kind]['path'] == str(prior_directory / ('observe.' + kind + '.json')), 'Exact failed forward journal required')
        need(held(prior['started']) == {'status': 'STARTED_NO_REPLAY', 'inputSha256': prior['input']['sha256'], 'operatorSha256': prior['operator']['sha256']}
             and held(prior['uncertain']) == {'status': 'REFUSED_NO_REPLAY', 'failureType': 'Refusal'}, 'Actual failed forward observation required')
        need(not (prior_directory/'observe.accepted.json').exists() and not (prior_directory/'accepted-release.actual.json').exists(), 'Failed forward attempt cannot be restamped')
        need(type(prior['commands']) is list and prior['commands']
             and [r['path'] for r in prior['commands']] == sorted(str(p) for p in prior_directory.glob('command-*.actual.json')), 'Complete failed forward command journal required')
        for ref in prior['commands']:
            row = held(ref); need(row.get('complete') is True, 'Complete failed forward command required')
            for stream in ['stdout', 'stderr']:
                need(Path(row[stream]['path']).parent == prior_directory, 'Prior forward stream escaped journal'); l.a.read_ref(row[stream])
        need(prior['ownerBefore']['path'] == str(prior_directory/'owner-before.original.json'), 'Actual failed owner bookend required')
        owner = held(prior['ownerBefore']); exact(owner, {'deployment', 'pod', 'replicaSet'})
    if original_proof is not None:
        need(value['originalInput'] == original_proof['input'] and value['originalOperator'] == original_proof['operator']
             and all(value['originalPhases'][name] == original_proof['phases'][name] for name in ['dryrun', 'publish']), 'Forward observation changes original switch ancestry')
    return {'original': original, 'directory': directory, 'output': output}


def binding(l, forward, original_proof):
    l.exact(forward, {'version', 'input', 'operator'})
    l.need(forward['version'] == 1, 'Closed forward proof required')
    value = l.held(forward['input']); result = request(l, value, original_proof)
    l.a.read_ref(forward['operator'])
    l.need(forward['operator'] in value['sources'] and Path(forward['operator']['path']).name == 'observe-forward.py', 'Reviewed forward observer source required')
    return {**result, 'input': forward['input'], 'operator': forward['operator']}
