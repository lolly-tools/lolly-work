#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Read-only continuation of a fresh completed checkpoint under the same owner.

There is no publication, rollback, allocation or deletion action in this CLI.
Original failed journals remain held; a new exclusive intent records only reads.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import sys
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True
MAX_AGE_NS = 900 * 1_000_000_000
STATUS = 'REVIEWED_SAME_OWNER_PUBLIC_OBSERVATION_CONTINUATION_NOT_EXECUTED'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def fresh_window(need, checkpoint, now):
    need(type(checkpoint) is int and type(now) is int and 0 < checkpoint <= now
         and now - checkpoint <= MAX_AGE_NS, 'Same-owner checkpoint expired or clock moved backwards')


def process_program(container):
    if not re.fullmatch('[a-f0-9]{64}', container): raise RuntimeError('Exact native container required')
    return '''import json,pathlib,subprocess
c=''' + repr(container) + '''
r=subprocess.run(['/usr/local/bin/k3s','crictl','inspect','-o','go-template','--template','{{.info.pid}}',c],capture_output=True,timeout=30)
if r.returncode or len(r.stdout)>64 or r.stderr:raise RuntimeError('NATIVE_PROCESS_REFUSED')
pid=int(r.stdout);p=pathlib.Path('/proc')/str(pid)
def snap():
 s=(p/'stat').read_text().rsplit(')',1)[1].split();u=(p/'status').read_text()
 if pid<=1 or '\\nUid:\\t101\\t'not in u or c not in(p/'cgroup').read_text():raise RuntimeError('NATIVE_IDENTITY_REFUSED')
 pair=lambda q:[q.stat().st_dev,q.stat().st_ino]
 return {'container':c,'pid':pid,'startedTicks':int(s[19]),'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'net':pair(p/'ns/net'),'mount':pair(p/'ns/mnt'),'exe':pair(p/'exe'),'root':pair(p/'root')}
a=snap()
if a!=snap():raise RuntimeError('NATIVE_PROCESS_CHANGED')
print(json.dumps(a,sort_keys=True,separators=(',',':')))
'''


def host_argv(target, code):
    t = target['transport']; args = ['python3', '-c', code]
    if t['type'] == 'local': return args
    if t.get('sudo'): args = ['sudo', '-n', *args]
    ssh = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=12', '-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=' + t['knownHostsFile']]
    if t.get('jump'): ssh += ['-J', t['jump']]
    return [*ssh, t['host'], shlex.join(args)]


def process_sample(stage):
    container = stage.owner['status']['containerStatuses'][0]['containerID'].removeprefix('containerd://')
    data = stage.host_python(process_program(container))
    return {'command': stage.events[-1], 'value': json.loads(data)}


def verify_process(l, sample, commands, owner, target):
    l.exact(sample, {'command', 'value'}); l.need(sample['command'] in commands, 'Native process command missing')
    c = l.held(sample['command']); container = owner['process']['containerID'].removeprefix('containerd://')
    l.need(c['argv'] == host_argv(target, process_program(container)) and c.get('exitCode') == 0
           and c.get('complete') is True and c.get('failure') is None, 'Exact read-only native process command required')
    data = l.a.read_ref(c['stdout']); l.need(l.a.read_ref(c['stderr']) == b'' and l.a.parsed(data) == sample['value'], 'Native process original differs')
    v = sample['value']; l.exact(v, {'container', 'pid', 'startedTicks', 'bootId', 'net', 'mount', 'exe', 'root'})
    l.need(v['container'] == container and type(v['pid']) is int and v['pid'] > 1 and type(v['startedTicks']) is int and v['startedTicks'] > 0
           and type(v['bootId']) is str and re.fullmatch('[a-f0-9-]{36}', v['bootId'])
           and all(type(v[k]) is list and len(v[k]) == 2 and all(type(n) is int and n >= 0 for n in v[k]) for k in ['net','mount','exe','root']), 'Native PID/start/namespace identity differs')
    return v


def binding(l, request, proof=None):
    l.exact(request, {'input', 'operator'}); x = l.held(request['input']); l.a.read_ref(request['operator'])
    l.exact(x, {'version', 'status', 'checkpointProof', 'failedObservation', 'originalCommands', 'outputDirectory'})
    l.need(x['version'] == 1 and x['status'] == STATUS, 'Closed same-owner continuation input required')
    cp = x['checkpointProof']; l.exact(cp, {'version', 'input', 'operator', 'phases'})
    l.need(Path(request['operator']['path']).name == 'continue-public-observation.py'
           and Path(request['operator']['path']).parent == Path(cp['operator']['path']).parent, 'Original adjacent continuation operator required')
    baseline = l.publication_baseline(cp, _checkpoint=True)
    publication = l.held(cp['input']); runtime = l.held(publication['stageInput']); prepared = l.held(runtime['prepared'])
    l.need(request['operator'] in runtime['sources'], 'Continuation source must have been reviewed before original publication')
    checkpoint = l.held(cp['phases']['observe']['accepted']); original = Path(publication['outputDirectory']); out = Path(x['outputDirectory'])
    l.need(out.is_absolute() and out.resolve() == out and out.parent.resolve(strict=True) == out.parent
           and out != original and original not in out.parents and out not in original.parents
           and out != Path(runtime['outputDirectory']) and Path(runtime['outputDirectory']) not in out.parents,
           'Distinct canonical continuation journal required')
    l.exact(x['failedObservation'], {'started', 'uncertain'})
    l.need(x['failedObservation']['started'] == cp['phases']['observe']['started']
           and x['failedObservation']['uncertain']['path'] == str(original/'observe.uncertain.json'), 'Original failed observation required')
    failed = l.held(x['failedObservation']['uncertain']); l.exact(failed, {'status','failureType'})
    l.need(failed['status'] == 'REFUSED_NO_REPLAY' and failed['failureType'] in {'RuntimeError','Refusal','OSError'}, 'Closed later diagnostic failure required')
    for name in ['observe.accepted.json','handoff.started.json','handoff.accepted.json','rollback.started.json','rollback.accepted.json','rollback.uncertain.json']:
        p = original/name; l.need(not p.exists() and not p.is_symlink(), 'Original attempt already accepted, handed off or rolled back')
    refs = x['originalCommands']; l.need(type(refs) is list and refs and [r['path'] for r in refs] == sorted(str(p) for p in original.glob('command-*.actual.json')), 'Complete preserved failed-attempt command closure required')
    l.need(len({r['path'] for r in refs}) == len(refs) and all(r in refs for r in checkpoint['commands']), 'Checkpoint command custody incomplete')
    for r in refs:
        command = l.held(r)
        for key in ['stdout','stderr']:
            l.need(Path(command[key]['path']).parent == original, 'Original stream escaped failed journal'); l.a.read_ref(command[key])
    original_owner = l.serving_binding(l.held(checkpoint['evidence']['ownerAfter']), prepared, l.held(runtime['target'])['node']['name'])
    process = verify_process(l, checkpoint['ownerProcess'], checkpoint['commands'], original_owner, l.held(runtime['target']))
    before_process = verify_process(l, checkpoint['ownerProcessBefore'], checkpoint['commands'], original_owner, l.held(runtime['target']))
    l.need(process == before_process and checkpoint['commands'].index(checkpoint['ownerProcessBefore']['command']) < checkpoint['commands'].index(checkpoint['ownerProcess']['command']), 'Original process bookends changed or reversed')
    l.need(type(checkpoint['completedAtUnixNs']) is int and checkpoint['completedAtUnixNs'] > 0, 'Completed checkpoint timestamp required')
    http = module('repeat_http_oracle', 'public-delivery-model-http.py'); models = l.held(prepared['refs']['models'])['files']
    http.validate_reuse({'files': models, 'inventorySha256': hashlib.sha256(json.dumps(models,separators=(',',':')).encode()).hexdigest()}, l.held(checkpoint['evidence']['modelsTLS']))
    if proof is not None:
        l.need(proof['input'] == cp['input'] and proof['operator'] == cp['operator']
               and all(proof['phases'][k] == cp['phases'][k] for k in ['dryrun','publish']), 'Continuation cannot select another original switch')
    return {**request, 'output':out, 'checkpoint':checkpoint, 'owner':original_owner, 'process':process, 'prepared':prepared, 'runtime':runtime, 'original':x, 'baseline':baseline}


def final_binding(l, repeat, observed, owner, evidence):
    cp = repeat['checkpoint']; l.need(owner == repeat['owner'] and observed['physical'] == cp['physical'], 'Repeated observation changed owner or complete physical bytes')
    l.exact(observed['repeatWindow'], {'startedAtUnixNs','completedAtUnixNs','elapsedMonotonicNs','processBefore','processAfter'})
    w = observed['repeatWindow']
    fresh_window(l.need, cp['completedAtUnixNs'], w['startedAtUnixNs']); fresh_window(l.need, cp['completedAtUnixNs'], w['completedAtUnixNs'])
    l.need(type(w['elapsedMonotonicNs']) is int and w['elapsedMonotonicNs'] >= 0
           and w['completedAtUnixNs'] >= w['startedAtUnixNs']
           and abs(w['completedAtUnixNs']-w['startedAtUnixNs']-w['elapsedMonotonicNs']) <= 1_000_000_000, 'Continuation clock moved or exceeded freshness')
    target = l.held(repeat['runtime']['target'])
    l.need(w['processBefore']['command'] in observed['commands'] and w['processAfter']['command'] in observed['commands']
           and observed['commands'].index(w['processBefore']['command']) < observed['commands'].index(w['processAfter']['command']),
           'Repeated process bookends must be distinct and ordered')
    for key in ['processBefore','processAfter']:
        l.need(verify_process(l,w[key],observed['commands'],owner,target) == repeat['process'], 'Owning native process changed')
    fresh = evidence['modelsRepeatTLS']; old = evidence['modelsTLS']
    models = l.held(repeat['prepared']['refs']['models'])['files']
    oracle = module('repeat_final_http_oracle', 'public-delivery-model-http.py')
    oracle.validate_repeat_report({'version':1,'origin':l.held(repeat['runtime']['context'])['origin'],
        'inventorySha256':old['inventorySha256'],'files':models},old,fresh)
    l.need(fresh['status'] == 'SAME_OWNER_MODEL_HTTP_PROTOCOL_RECHECK_WITH_EXPLICIT_BODY_REUSE'
           and fresh['inventorySha256'] == old['inventorySha256'] and fresh['files'] == old['files']
           and fresh['logicalBytes'] == old['logicalBytes'] and fresh['openErrata'] == [], 'Fresh per-model protocol proof required')
    l.need(len(fresh['rows']) == len(old['rows']), 'Complete repeated model rows required')
    for row, previous in zip(fresh['rows'],old['rows']):
        l.need(all(row[k] == previous[k] for k in ['url','size','sha256']) and row['largeFullBodyProofReused'] is (row['size'] > 65536), 'Repeated model inventory or reuse class changed')
        current = {v['check']:v for v in row['responses']}; old_checks = {v['check']:v for v in previous['responses']}
        if row['largeFullBodyProofReused']:
            for check in ['GET full body','GET mismatching If-Range full body']:
                l.need(current.get('REUSED '+check) == {'check':'REUSED '+check,'original':old_checks[check]}, 'Original large-body proof was restamped')
        l.need('HEAD Origin:https://lolly.ing' in current and 'OPTIONS Range/If-Range/If-None-Match preflight' in current
               and sum(k.startswith('GET Range ') for k in current) == (3 if row['size'] else 0), 'Fresh model validators/ranges missing')


MAX_STAGE_AGE_NS = 24 * 60 * 60 * 1_000_000_000
STAGE_STATUS = 'REVIEWED_ACCEPTED_MODEL_CHECKPOINT_REUSE_NOT_EXECUTED'


def stage_window(l, checkpoint, now):
    l.need(type(checkpoint) is int and type(now) is int and 0 < checkpoint <= now
           and now - checkpoint <= MAX_STAGE_AGE_NS, 'Accepted model checkpoint exceeds the explicit 24 hour window')


def stage_binding(l, request, prepared, target, context):
    """Read accepted custody; never adopt an incomplete attempt or another owner."""
    x = l.held(request); l.exact(x, {'version', 'status', 'acceptedRelease', 'checkpointProof'})
    l.need(x['version'] == 1 and x['status'] == STAGE_STATUS
           and x['acceptedRelease'] == prepared['refs']['acceptedRelease'], 'Exact accepted model reuse request required')
    accepted = l.held(x['acceptedRelease']); proof = accepted['publication']; cp = x['checkpointProof']
    l.exact(proof, {'version', 'input', 'operator', 'phases'})
    l.need(l.publication_baseline(proof) == accepted, 'Genuine complete original publication acceptance required')
    l.publication_baseline(cp, _checkpoint=True)
    l.need(all(cp[k] == proof[k] for k in ['version', 'input', 'operator'])
           and all(cp['phases'][k] == proof['phases'][k] for k in ['dryrun', 'publish'])
           and cp['phases']['observe']['started'] == proof['phases']['observe']['started'], 'Accepted checkpoint belongs to another publication')
    checkpoint = l.held(cp['phases']['observe']['accepted']); observed = l.held(proof['phases']['observe']['accepted'])
    ignored = {'status', 'commands', 'memory', 'completedAtUnixNs', 'ownerProcess', 'ownerProcessBefore'}
    l.need({k:v for k,v in checkpoint.items() if k not in ignored} == {k:v for k,v in observed.items() if k not in ignored}
           and observed['commands'][:len(checkpoint['commands'])] == checkpoint['commands'], 'Accepted observation does not complete the original full checkpoint')
    publication = l.held(proof['input']); runtime = l.held(publication['stageInput']); old = l.held(runtime['prepared'])
    l.need(not list(Path(publication['outputDirectory']).glob('rollback*')), 'Rollback intent or outcome invalidates accepted model reuse')
    l.need(l.held(runtime['target']) == target and l.held(runtime['context'])['origin'] == context['origin']
           and old['refs']['models'] == prepared['refs']['models'] and old['refs']['configs'] == prepared['refs']['configs'], 'Target, origin, model recipe or configuration changed')
    owner = l.serving_binding(l.held(checkpoint['evidence']['ownerAfter']), old, target['node']['name'])
    current = {'deployment':l.held(prepared['refs']['deployment']), 'pod':context['owner'], 'replicaSet':context['replicaSet']}
    l.need(l.serving_binding(current, old, target['node']['name']) == owner, 'Owner replacement requires full model qualification')
    # A same-name claim is insufficient: retain the complete accepted binding.
    def model_pair(value):
        deployment=l.held(value['refs']['deployment']); baseline=l.held(value['refs']['baseline'])
        name=next(v['persistentVolumeClaim']['claimName'] for v in deployment['spec']['template']['spec']['volumes'] if v['name']=='models')
        claims=[p for p in baseline['pvcs']['items'] if p['metadata'].get('namespace')==deployment['metadata']['namespace'] and p['metadata']['name']==name]
        l.need(len(claims)==1, 'Unique model claim required'); claim=claims[0]
        pvs=[p for p in baseline['pvs']['items'] if p['metadata']['name']==claim['spec']['volumeName']]
        l.need(len(pvs)==1, 'Unique model PV required'); pv=pvs[0]
        return {'claimUID':claim['metadata']['uid'],'claimSpec':claim['spec'],'pvUID':pv['metadata']['uid'],'pvSpec':pv['spec']}
    l.need(model_pair(old)==model_pair(prepared), 'Accepted model PVC/PV binding changed')
    process=verify_process(l,checkpoint['ownerProcess'],checkpoint['commands'],owner,target)
    l.need(verify_process(l,checkpoint['ownerProcessBefore'],checkpoint['commands'],owner,target)==process
           and checkpoint['commands'].index(checkpoint['ownerProcessBefore']['command']) < checkpoint['commands'].index(checkpoint['ownerProcess']['command']), 'Original process bookends differ')
    models=l.held(prepared['refs']['models'])['files']; original=l.held(checkpoint['evidence']['modelsTLS'])
    module('stage_original_model_http','public-delivery-model-http.py').validate_reuse({'files':models,'inventorySha256':hashlib.sha256(json.dumps(models,separators=(',',':')).encode()).hexdigest()},original)
    return {'request':request,'checkpoint':checkpoint,'owner':owner,'process':process,'modelsTLS':original,
            'physical':checkpoint['physical']['models'],'oldPrepared':old,'target':target,'context':context,'models':models}


def stage_begin(stage, bound, physical):
    # Stage modules expose l globally rather than as an instance attribute.
    l=module('stage_reuse_lifecycle','public-delivery-lifecycle.py')
    current={'deployment':stage.before,'pod':stage.owner,'replicaSet':stage.replica}
    l.need(l.serving_binding(current,bound['oldPrepared'],stage.target['node']['name'])==bound['owner'] and physical==bound['physical'], 'Accepted model owner or complete physical bytes changed')
    now=time.time_ns();mono=time.monotonic_ns();stage_window(l,bound['checkpoint']['completedAtUnixNs'],now)
    command_start=len(stage.events)
    process=process_sample(stage);l.need(process['value']==bound['process'],'Accepted native model process changed')
    return {'startedAtUnixNs':now,'monotonicStartNs':mono,'processBefore':process,'commandStart':command_start}


def stage_finish(stage, bound, start, physical, http_ref):
    l=module('stage_reuse_lifecycle_finish','public-delivery-lifecycle.py')
    current={'deployment':stage.before,'pod':stage.owner,'replicaSet':stage.replica}
    l.need(l.serving_binding(current,bound['oldPrepared'],stage.target['node']['name'])==bound['owner'] and physical==bound['physical'], 'Model proof changed during qualification')
    process=process_sample(stage);l.need(process['value']==bound['process'],'Native process changed during qualification')
    done=time.time_ns();stage_window(l,bound['checkpoint']['completedAtUnixNs'],done)
    l.need(type(start['commandStart']) is int and 0<=start['commandStart']<len(stage.events), 'Exact reuse command interval required')
    result={'version':1,'status':'SAME_ACCEPTED_OWNER_MODEL_PROTOCOL_RECHECK_WITH_ORIGINAL_BODY_PROOF',
        'request':bound['request'],'runtimeInput':{'path':str(stage.path),'sha256':stage.input_sha},
        'physical':physical,'http':http_ref,'commands':list(stage.events[start['commandStart']:]),
        'window':{'startedAtUnixNs':start['startedAtUnixNs'],'completedAtUnixNs':done,
                  'elapsedMonotonicNs':time.monotonic_ns()-start['monotonicStartNs'],
                  'processBefore':start['processBefore'],'processAfter':process}}
    stage_proof(l,result,bound)
    return result


def stage_proof(l, proof, bound):
    l.exact(proof,{'version','status','request','runtimeInput','physical','http','commands','window'})
    l.need(proof['version']==1 and proof['status']=='SAME_ACCEPTED_OWNER_MODEL_PROTOCOL_RECHECK_WITH_ORIGINAL_BODY_PROOF'
           and proof['request']==bound['request'] and proof['physical']==bound['physical'], 'Exact accepted model reuse proof required')
    w=proof['window'];l.exact(w,{'startedAtUnixNs','completedAtUnixNs','elapsedMonotonicNs','processBefore','processAfter'})
    for k in ['startedAtUnixNs','completedAtUnixNs']:stage_window(l,bound['checkpoint']['completedAtUnixNs'],w[k])
    l.need(type(w['elapsedMonotonicNs']) is int and w['elapsedMonotonicNs']>=0 and w['completedAtUnixNs']>=w['startedAtUnixNs']
           and abs(w['completedAtUnixNs']-w['startedAtUnixNs']-w['elapsedMonotonicNs'])<=1_000_000_000, 'Model reuse clock moved')
    commands=proof['commands'];l.need(type(commands)is list and len({r['path']for r in commands})==len(commands), 'Distinct model proof commands required')
    l.need(len(commands)>=2 and w['processBefore']['command']==commands[0] and w['processAfter']['command']==commands[-1], 'Ordered native process bookends required')
    for k in ['processBefore','processAfter']:
        l.need(verify_process(l,w[k],commands,bound['owner'],bound['target'])==bound['process'],'Native model process replacement refuses reuse')
    module('stage_reuse_http_verify','public-delivery-model-http.py').validate_repeat_report(
        {'version':1,'origin':bound['context']['origin'],'inventorySha256':bound['modelsTLS']['inventorySha256'],'files':bound['models']},bound['modelsTLS'],l.held(proof['http']))


def stage_admit(l, prepared, receipt, model):
    proof=l.held(model['reuse']);runtime=l.held(proof['runtimeInput'])
    l.exact(runtime,{'version','status','prepared','target','context','programs','sources','outputDirectory','modelReuse'})
    l.need(runtime['version']==1 and runtime['status']=='REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED'
           and runtime['prepared']==receipt['prepared'] and runtime['modelReuse']==proof['request'], 'Exact reviewed runtime opt-in required')
    adapter=l.held(prepared['refs']['adapterReview'])
    l.need(runtime['sources']==adapter['sources'] and receipt['adapter']==adapter['source'], 'Model proof execution source closure differs')
    for ref in runtime['sources']:l.a.read_ref(ref)
    bound=stage_binding(l,runtime['modelReuse'],prepared,l.held(runtime['target']),l.held(runtime['context']))
    qualification=l.held(receipt['phases'][4]);out=Path(runtime['outputDirectory'])
    l.need(len({r['path'] for r in qualification['commands']})==len(qualification['commands']) and proof['commands'] and proof['commands'][0] in qualification['commands'], 'Reuse command interval missing')
    start=qualification['commands'].index(proof['commands'][0])
    l.need(qualification['phase']=='qualify' and proof['commands']==qualification['commands'][start:start+len(proof['commands'])]
           and model['reuse']['path']==str(out/'model-reuse.actual.json') and proof['http']['path']==str(out/'models-http.original.json'), 'Model reuse belongs to another qualification journal')
    stage_proof(l,proof,bound)
    return proof['runtimeInput']


class Continuation:
    def __init__(self,path,input_sha,operator_sha):
        self.p = module('repeat_publication','publish-public-delivery.py'); self.l = self.p.s.l
        self.ref = {'input':{'path':str(Path(path).resolve()),'sha256':input_sha},'operator':{'path':str(Path(__file__).resolve()),'sha256':operator_sha}}
        self.bound = binding(self.l,self.ref); cp = self.bound['original']['checkpointProof']
        self.original = self.p.Publication(cp['input']['path'],cp['input']['sha256'],cp['operator']['sha256'])
        self.original.prior('publish'); self.out = self.bound['output']; self.stage = self.original.stage
        self.original.out = self.out
        fresh_window(self.l.need,self.bound['checkpoint']['completedAtUnixNs'],time.time_ns())

    def save(self,name,value): return self.original.save(name,value)
    def check(self):
        self.l.a.read_ref(self.ref['input']); self.l.a.read_ref(self.ref['operator']); self.stage.unchanged()
        binding(self.l,self.ref); fresh_window(self.l.need,self.bound['checkpoint']['completedAtUnixNs'],time.time_ns())
    def run(self):
        self.l.need(not self.out.exists(), 'Continuation intent never replays'); self.out.mkdir(mode=0o700)
        start = {'status':'STARTED_NO_REPLAY','inputSha256':self.ref['input']['sha256'],'operatorSha256':self.ref['operator']['sha256']}
        self.save('observe.started.json',start)
        try:
            result = self.original.with_journal(self.observe)
            observed = self.save('observe.accepted.json',{'version':1,**{k:v for k,v in start.items() if k!='status'},'commands':self.stage.events,**result})
            cp = copy.deepcopy(self.bound['original']['checkpointProof']); cp['repeat']=self.ref
            cp['phases']['observe']={'started':{'path':str(self.out/'observe.started.json'),'sha256':self.l.a.checksum(self.out/'observe.started.json')},'accepted':observed}
            accepted = self.l.publication_baseline(cp)
            return self.save('accepted-release.actual.json',accepted)
        except BaseException as error:
            self.save('observe.uncertain.json',{'status':'REFUSED_NO_REPLAY','failureType':type(error).__name__}); raise
    def observe(self):
        self.check(); started = time.time_ns(); mono = time.monotonic_ns(); stage=self.stage; cp=self.bound['checkpoint']
        actual = self.original.fresh(True)
        before = self.save('owner-before.original.json',{'deployment':actual,'pod':stage.owner,'replicaSet':stage.replica})
        owner = self.l.serving_binding(self.l.held(before),stage.prepared,stage.target['node']['name'])
        self.l.need(owner == self.bound['owner'], 'Owner replacement requires full qualification')
        process_before = process_sample(stage); self.l.need(process_before['value'] == self.bound['process'], 'Process replacement requires full qualification')
        physical={'static':stage.physical('qualifier',owner=True),'models':stage.physical('qualifier',models=True,owner=True)}
        self.l.need(physical == cp['physical'], 'Changed content requires full qualification')
        memory=stage.measure(owner=True); native=self.save('owning-native-http.actual.json',stage.native_http(stage.owner))
        http=module('repeat_public_http','public-delivery-http.py')
        models=self.save('owning-models-repeat-tls.actual.json',http.verify_models_tls(stage.context['origin'],stage.models,
            telemetry=lambda value:self.save('owning-models-repeat-tls.timing.actual.json',value),original=self.l.held(cp['evidence']['modelsTLS'])))
        static=self.save('owning-static-tls.actual.json',http.verify_static_tls(stage.context['origin'],[v for v in stage.rows if v['path'] in self.l.a.overlay.FIXED]))
        self.l.need(stage.physical('qualifier',owner=True)==physical['static'] and stage.physical('qualifier',models=True,owner=True)==physical['models'],'Repeated HTTP content changed')
        memory=stage.measure(owner=True); final=self.original.fresh(True)
        after=self.save('owner.original.json',{'deployment':final,'pod':stage.owner,'replicaSet':stage.replica})
        self.l.need(self.l.serving_binding(self.l.held(after),stage.prepared,stage.target['node']['name'])==owner,'Owner changed during continuation')
        process_after=process_sample(stage);self.l.need(process_after['value']==self.bound['process'],'Native process changed during continuation')
        self.check(); done=time.time_ns(); elapsed=time.monotonic_ns()-mono
        fresh_window(self.l.need,cp['completedAtUnixNs'],done)
        return {'status':'ACTUAL_FRONTEND_ROOT_REPEAT_SERVING_VERIFIED','deploymentUID':owner['deploymentUID'],'deploymentSpecSha256':owner['deploymentSpecSha256'],
            'source':stage.prepared['source'],'manifest':stage.prepared['manifest'],'mapSha256':stage.prepared['mapSha256'],'physical':physical,'memory':memory,
            'evidence':{'ownerBefore':before,'ownerAfter':after,'nativeHTTP':native,'staticTLS':static,'modelsTLS':cp['evidence']['modelsTLS'],'modelsRepeatTLS':models},
            'repeatWindow':{'startedAtUnixNs':started,'completedAtUnixNs':done,'elapsedMonotonicNs':elapsed,'processBefore':process_before,'processAfter':process_after},
            'modelsMountedByStaging':False,'allProtectedSpecsVerified':True,'browserAcceptanceClaimed':False,'productionMutation':False}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['check','observe']);p.add_argument('--input',required=True);p.add_argument('--reviewed-input-sha256',required=True);p.add_argument('--reviewed-operator-sha256',required=True);a=p.parse_args()
    op=Continuation(a.input,a.reviewed_input_sha256,a.reviewed_operator_sha256)
    print(json.dumps(op.run() if a.action=='observe' else {'status':'SAME_OWNER_CONTINUATION_CHECKED_NOT_EXECUTED'}))
if __name__=='__main__':main()
