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


def legacy_peak_refusal(l, data, limit):
    need=l.need
    need(type(data)is bytes and 0<len(data)<=65536,'Bounded original memory observation required')
    lines=data.decode('ascii').splitlines();need(lines[-1]=='END\tCGROUP_AND_NGINX_PROCESS_MEMORY_OBSERVED','Complete original memory observation required')
    values,events,processes={},{},[]
    for line in lines[:-1]:
        parts=line.split('\t')
        if parts[0]in{'M','E'}:
            need(len(parts)==3 and parts[2].isdigit(),'Malformed original memory/event row')
            target=values if parts[0]=='M'else events;need(parts[1]not in target,'Duplicate original memory/event row');target[parts[1]]=int(parts[2])
        else:
            need(len(parts)in{4,7}and parts[0]=='P'and parts[1].isdigit(),'Malformed original process row')
            uids=parts[2:-1]if len(parts)==7 else parts[2].split();rss=parts[-1].split()
            need(uids==['101']*4 and len(rss)==2 and rss[0].isdigit()and rss[1]=='kB','Original native UID/RSS differs')
            processes.append((int(parts[1]),int(rss[0])*1024))
    need(set(values)=={'current','peak','max'}and values['max']==limit
         and 0<values['current']<=values['peak']==limit and 1<=len(processes)<=16
         and events.get('oom')==events.get('oom_kill')==0 and len({p[0]for p in processes})==len(processes),
         'Original refusal must be solely historic peak equal to exact limit')
    need(0<max(p[1]for p in processes)<=values['current'],'Original RSS exceeds actual cgroup bound')


def request(l, value, original_proof=None, depth=0):
    need, exact, held = l.need, l.exact, l.held
    need(type(depth) is int and 0 <= depth < 8, 'Bounded failed forward ancestry required')
    prior = value.get('priorForwardObservation')
    trust = value.get('tlsTrust')
    memory = value.get('memoryProfile')
    exact(value, {'version', 'status', 'originalInput', 'originalOperator', 'originalPhases', 'failedObservation',
                  'originalCommands', 'failureEvidence', 'sources', 'outputDirectory'} | ({'priorForwardObservation'} if prior is not None else set()) | ({'tlsTrust'} if trust is not None else set()) | ({'memoryProfile'} if memory is not None else set()))
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
        for stream in ['stdout', 'stderr'] + (['stdin'] if 'stdin' in row else []):
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
        previous = held(prior['input'])
        request(l, previous, depth=depth+1)
        for key in ['originalInput', 'originalOperator', 'originalPhases', 'failedObservation', 'originalCommands', 'failureEvidence']:
            need(previous[key] == value[key], 'Forward attempts must retain identical original switch lineage')
        need(prior['operator'] in previous['sources'] and Path(prior['operator']['path']).name == 'observe-forward.py', 'Exact prior forward source required')
        prior_directory = Path(previous['outputDirectory'])
        need(output != prior_directory and output not in prior_directory.parents and prior_directory not in output.parents, 'Forward journals must remain separate')
        for kind in ['started', 'uncertain']:
            need(prior[kind]['path'] == str(prior_directory / ('observe.' + kind + '.json')), 'Exact failed forward journal required')
        need(held(prior['started']) == {'status': 'STARTED_NO_REPLAY', 'inputSha256': prior['input']['sha256'], 'operatorSha256': prior['operator']['sha256']}
             and held(prior['uncertain']) in [{'status': 'REFUSED_NO_REPLAY', 'failureType': kind} for kind in ['Refusal', 'SSLCertVerificationError', 'RuntimeError']], 'Actual failed forward observation required')
        need(not (prior_directory/'observe.accepted.json').exists() and not (prior_directory/'accepted-release.actual.json').exists(), 'Failed forward attempt cannot be restamped')
        need(type(prior['commands']) is list and prior['commands']
             and [r['path'] for r in prior['commands']] == sorted(str(p) for p in prior_directory.glob('command-*.actual.json')), 'Complete failed forward command journal required')
        for ref in prior['commands']:
            row = held(ref); need(row.get('complete') is True, 'Complete failed forward command required')
            for stream in ['stdout', 'stderr'] + (['stdin'] if 'stdin' in row else []):
                need(Path(row[stream]['path']).parent == prior_directory, 'Prior forward stream escaped journal'); l.a.read_ref(row[stream])
        if held(prior['uncertain'])['failureType']=='RuntimeError':
            owner=held(prior['ownerBefore'])['pod'];containers=owner['spec']['containers'];need(len(containers)==1,'Exact original public container required')
            container=containers[0];limit=re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)',container['resources']['limits']['memory']);need(limit,'Exact original configured memory limit required')
            configured=int(limit[1])*(1024**2 if limit[2]=='Mi'else 1024**3);samples=[]
            for ref in prior['commands']:
                row=held(ref)
                if row.get('exitCode')!=0:continue
                data=l.a.read_ref(row['stdout'])
                if data.endswith(b'END\tCGROUP_AND_NGINX_PROCESS_MEMORY_OBSERVED\n'):
                    need(row.get('failure')is None and row['argv'][-1].endswith(' exec -i -n '+owner['metadata']['namespace']+' '+owner['metadata']['name']+' -c '+container['name']+' -- /bin/sh -s'),'Original memory sample targets another owner')
                    legacy_peak_refusal(l,data,configured);samples.append(ref)
            need(len(samples)==1,'Exactly one genuine bounded-cache peak refusal required')
        need(prior['ownerBefore']['path'] == str(prior_directory/'owner-before.original.json'), 'Actual failed owner bookend required')
        owner = held(prior['ownerBefore']); exact(owner, {'deployment', 'pod', 'replicaSet'})
    if trust is not None:
        exact(trust, {'caFile', 'certificateRequired', 'hostnameVerification'})
        need(trust['certificateRequired'] is True and trust['hostnameVerification'] is True, 'Verified certificate and hostname are mandatory')
        data = l.a.read_ref(trust['caFile'])
        need(0 < len(data) <= 2*1024**2 and b'-----BEGIN CERTIFICATE-----' in data, 'Bounded explicit CA bundle required')
    if memory is not None:
        need(memory == {'version':1,'name':'CGROUP_V2_CACHE_AWARE_HEADROOM','minimumHeadroomBytes':64*1024**2,
            'headroomDivisor':8,'zeroOOM':True,'zeroSwap':True,'peakWithinExactLimit':True},'Explicit reviewed memory profile differs')
        memory_sources=[r for r in value['sources']if Path(r['path']).name=='public-memory-health.py']
        need(len(memory_sources)==1 and Path(memory_sources[0]['path'])==Path(observers[0]['path']).parent/'sources/public-memory-health.py','Adjacent memory profile source must be held')
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
