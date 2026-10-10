#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Prepare or execute one reviewed public frontend update without image builds.

check/plan consume local originals; they never contact a target. run captures
fresh complete inventories, then invokes the maintained stage and publisher
once. Uncertain attempts retain originals and require separate reconciliation.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


publisher = module('public_update_publisher', 'publish-public-shell.py')
stage, public = publisher.stage, publisher.public
cohort, updater = stage.cohort, stage.updater
require, exact, Refusal = cohort.require, cohort.exact, cohort.Refusal
DEPENDENCIES = stage.SOURCE_NAMES | {'publish-public-shell.py', 'update-public-shell.py'}
PROFILE_KEYS = {'version','status','name','target','previous','publicKey','preflight','hostProbe','storage',
                'minimumFreeBytes','maximumWriteBytes','sourceFiles','stageNamePrefix','selection','probePolicy'}
CAPTURE_KEYS = {'version','status','targetSha256','systemNamespace','node','namespaces','deployments','pods',
                'claims','volumes','storageClass','replicaSet','nginxConfig','policies','services'}
CHECK_KEYS = {'version','status','profile','prepared','capture','stageInput','stageOperator','baseline','resources',
              'targetCalls','productionMutation','originAuthenticatedByThisCommand'}


def file_ref(path):
    path = Path(os.path.abspath(path))
    return {'path':str(path),'sha256':hashlib.sha256(cohort.read_file(path)[0]).hexdigest()}


def private_new_directory(path):
    path = Path(os.path.abspath(path))
    require(path.resolve() == path and path.parent.resolve(strict=True) == path.parent and not path.exists(), 'New canonical exclusive output required')
    path.mkdir(mode=0o700); return path


def save_raw(directory, name, data):
    require(Path(name).name == name and type(data) is bytes and len(data) <= 32 * 1024**2, 'Bounded original output required')
    path = directory / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd,'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    return {'path':str(path),'sha256':hashlib.sha256(data).hexdigest()}


def save(directory, name, value):
    return save_raw(directory,name,cohort.canonical(value) + b'\n')


def named(value, kind, api, namespace=None):
    return public.resource(value,api,kind,namespace)


def payload(value):
    return {k:v for k,v in value.items() if k not in {'metadata','status'}}


class Update:
    """The constructor binds artifacts; only run may read or mutate a target."""
    def __init__(self, profile_path, profile_sha, prepared_path, prepared_sha, operator_sha, node='node'):
        require(file_ref(__file__)['sha256'] == cohort.sha(operator_sha), 'Reviewed facade source changed')
        self.operator_sha, self.node = operator_sha, node
        self.profile_path = cohort.local_path(str(profile_path),Path.cwd()); self.inputs = cohort.Inputs(self.profile_path.parent)
        self.profile_ref = {'path':str(self.profile_path),'sha256':cohort.sha(profile_sha)}
        raw = self.inputs.file(self.profile_ref); exact(raw,PROFILE_KEYS)
        require(type(raw['version']) is int and raw['version'] == 1 and raw['status'] == 'REVIEWED_PUBLIC_SHELL_UPDATE_PROFILE', 'Reviewed public profile required')
        stage.resources.name(raw['name']); stage.resources.name(raw['stageNamePrefix'])
        require(len(raw['stageNamePrefix']) <= 32, 'Bounded exclusive stage prefix required')
        self.profile = copy.deepcopy(raw)
        for key in ('target','previous','publicKey','preflight','hostProbe'):
            self.profile[key] = self.ref(raw[key],self.profile_path.parent,key not in {'preflight','hostProbe'})
        self.sources = [self.ref(r,self.profile_path.parent,False) for r in raw['sourceFiles']]
        require(type(raw['sourceFiles']) is list and 1 <= len(self.sources) <= 500 and len({r['path'] for r in self.sources}) == len(self.sources), 'Complete distinct reviewed source closure required')
        required = {str(HERE / n) for n in DEPENDENCIES} | {self.profile[k]['path'] for k in ('preflight','hostProbe')}
        require({r['path'] for r in self.sources} >= required, 'Maintained facade/helper/guard source closure missing')
        self.profile['sourceFiles'] = self.sources
        exact(raw['selection'],{'container','shellVolume'})
        for name in raw['selection'].values(): stage.resources.name(name)
        exact(raw['probePolicy'],{'paths','lazyChunks','allOrigins'})
        policy = raw['probePolicy']; paths = policy['paths']
        require(type(paths) is list and 3 <= len(paths) <= 40 and paths == sorted(set(paths)) and
                {'index.html','catalog/tools/index.json','catalog/tools/index.sig.json'} <= set(paths) and
                all(type(p) is str and cohort.safe_path(p) == p and not p.startswith('models/') for p in paths) and
                type(policy['lazyChunks']) is int and 1 <= policy['lazyChunks'] <= 20 and policy['allOrigins'] is True, 'Explicit normal-TLS entry/catalog/lazy probe policy required')
        self.target = updater.validate_target(self.inputs.file(self.profile['target']))
        require(set(self.target['components']) == updater.COMPONENTS, 'All nine protected components required')
        self.component = self.target['components']['public-web']; self.namespace = self.component['namespace']
        self.previous = self.inputs.file(self.profile['previous'])
        self.before, self.old_files, self.config, self.models, self.models_pv = public.baseline(self.previous,self.inputs)
        self.prepared_ref = {'path':str(cohort.local_path(str(prepared_path),Path.cwd())),'sha256':cohort.sha(prepared_sha)}
        prepared = self.inputs.file(self.prepared_ref)
        matches = [r for r in prepared.get('evidence',[]) if r.get('sha256') == prepared.get('reviewedEvidenceSha256')]
        require(len(matches) == 1, 'Unique original maintained preparation evidence required')
        self.evidence_ref = self.ref(matches[0],Path(self.prepared_ref['path']).parent)
        self.prepared, self.evidence = stage.bind_prepared(self.inputs,self.prepared_ref,self.evidence_ref,node)
        evidence_base = Path(self.evidence_ref['path']).parent
        require(self.ref(self.evidence['previous'],evidence_base) == self.profile['previous'] and
                self.prepared['previousBaselineSha256'] == self.profile['previous']['sha256'] and
                self.profile['publicKey']['sha256'] == self.previous['publicKeySha256'] and
                {k:self.prepared['selection'][k] for k in raw['selection']} == raw['selection'], 'Accepted baseline/pin/container/volume differs')
        self.producer = self.inputs.file(self.ref(self.evidence['producer'],evidence_base))
        self.effective = cohort.Tree(self.producer['shell'],self.inputs)
        self.runtime = self.inputs.file(self.ref(self.previous['originalEvidence'][0],self.profile_path.parent))['runtime']
        prefix = raw['stageNamePrefix'] + '-' + self.prepared_ref['sha256'][:16]
        self.names = {'writer':prefix+'-writer','qualifier':prefix+'-check','policy':prefix+'-deny'}
        stage.make_resources(self.prepared,self.before,self.target,self.names,raw['storage'])
        require(type(raw['minimumFreeBytes']) is int and raw['minimumFreeBytes'] >= 8*1024**3 and
                type(raw['maximumWriteBytes']) is int and 0 < raw['maximumWriteBytes'] <= 1024**3 and
                self.prepared['overlay']['totalBytes'] <= min(raw['maximumWriteBytes'],raw['storage']['bytes']), 'Reviewed storage floor/write budget differs')
        self.source_check()

    def ref(self, value, base, json_file=True):
        exact(value,{'path','sha256'})
        ref = {'path':str(cohort.local_path(value['path'],base)),'sha256':cohort.sha(value['sha256'])}
        self.inputs.file(ref,json_file); return ref

    def source_check(self):
        require(file_ref(__file__)['sha256'] == self.operator_sha, 'Reviewed update source drifted')
        self.inputs.unchanged()

    def source_refs(self, names):
        rows = [r for r in self.sources if r['path'] in {str(HERE / n) for n in names}]
        require(len(rows) == len(names), 'Exact maintained helper closure missing'); return rows

    def capture(self, ref, staged=None):
        x = self.inputs.file(ref); exact(x,CAPTURE_KEYS)
        require(type(x['version']) is int and x['version'] == 1 and x['status'] == 'READ_ONLY_PUBLIC_SHELL_RESOURCES_CAPTURED' and
                x['targetSha256'] == self.profile['target']['sha256'], 'Captured target identity differs')
        base = Path(ref['path']).parent
        load = lambda r: self.inputs.file(self.ref(r,base))
        wanted = {c['namespace'] for c in self.target['components'].values()}
        require(set(x['namespaces']) == set(x['deployments']) == wanted, 'Complete protected namespace captures required')
        namespaces = {n:named(load(r),'Namespace','v1') for n,r in x['namespaces'].items()}
        require(all(r['metadata']['name'] == n for n,r in namespaces.items()), 'Captured namespace name differs')
        system, node = named(load(x['systemNamespace']),'Namespace','v1'), named(load(x['node']),'Node','v1')
        require(system['metadata']['name'] == 'kube-system' and system['metadata']['uid'] == self.target['clusterUID'] and
                node['metadata']['name'] == self.target['node']['name'] and node['metadata']['uid'] == self.target['node']['uid'] and
                any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in node.get('status',{}).get('conditions',[])), 'Captured cluster/node not ready or replaced')
        full = {}
        for ns,r in x['deployments'].items():
            full.update({(ns,d['metadata']['name']):d for d in stage.complete_list(load(r),'Deployment',ns)['items']})
        inventory = stage.private.DeploymentInventory(namespaces,full)
        deployments = {role:updater.deployment_identity(c,inventory) for role,c in self.target['components'].items()}
        require(deployments['public-web']['spec'] == self.before['spec'], 'Accepted public full spec changed')
        for d in deployments.values():
            replicas = d['spec'].get('replicas',1); s = d.get('status',{})
            require(all(s.get(k) == replicas for k in ('readyReplicas','updatedReplicas','availableReplicas')) and
                    s.get('observedGeneration') == d['metadata'].get('generation') and type(d['metadata'].get('generation')) is int, 'A protected application is not fully ready')
        pods = stage.complete_list(load(x['pods']),'Pod',self.namespace)
        claims = stage.complete_list(load(x['claims']),'PersistentVolumeClaim','*'); pvs = stage.complete_list(load(x['volumes']),'PersistentVolume')
        owners = [p for p in pods['items'] if p['metadata']['uid'] == self.runtime['podUID']]
        require(len(owners) == 1 and cohort.digest(owners[0]['spec']) == self.runtime['podSpecSha256'], 'Accepted full owner spec differs')
        owner = owners[0]; rs = named(load(x['replicaSet']),'ReplicaSet','apps/v1',self.namespace)
        stage.Stage.owner_chain(owner,rs,deployments['public-web'])
        status = [s for s in owner.get('status',{}).get('containerStatuses',[]) if s.get('name') == self.prepared['selection']['container']]
        require(owner['spec'].get('nodeName') == self.target['node']['name'] and len(status) == 1 and status[0].get('ready') is True and
                status[0].get('restartCount') == 0 and status[0].get('imageID','').removeprefix('docker-pullable://') == self.previous['image'], 'Accepted owning image/node/readiness differs')
        config = named(load(x['nginxConfig']),'ConfigMap','v1',self.namespace)
        require(config['metadata']['uid'] == self.config['metadata']['uid'] and payload(config) == payload(self.config), 'Nginx data/binaryData/config changed')
        by_claim = {stage.private.resource_key(c):c for c in claims['items']}; by_pv = {p['metadata']['name']:p for p in pvs['items']}
        for expected in (self.models,self.models_pv):
            actual = by_claim.get(stage.private.resource_key(expected)) if expected['kind'] == 'PersistentVolumeClaim' else by_pv.get(expected['metadata']['name'])
            require(actual and actual['metadata']['uid'] == expected['metadata']['uid'] and payload(actual) == payload(expected) and actual.get('status',{}).get('phase') == 'Bound', 'Protected models changed')
        protected = {self.models['metadata']['name']}
        if self.previous['overlay']:
            old = self.previous['overlay']; protected.add(old['claim'])
            claim = by_claim.get(('PersistentVolumeClaim',self.namespace,old['claim']))
            require(claim and claim['metadata']['uid'] == old['claimUID'], 'Accepted overlay claim replaced')
            stage.isolated_backing(claim,pvs,self.namespace)
        selected = self.prepared['selection']['shellClaim']; new = by_claim.get(('PersistentVolumeClaim',self.namespace,selected))
        require((new is None) if staged is None else (new and new['metadata']['uid'] == staged['claim']['metadata']['uid'] and new['spec'] == staged['claim']['spec']), 'New claim collision or actual retired tuple differs')
        for pod in pods['items']:
            for volume in stage.resources.active_volumes(pod['spec']):
                claim = volume.get('persistentVolumeClaim',{}).get('claimName')
                require(claim != selected and (claim not in protected or pod['metadata']['uid'] == owner['metadata']['uid']), 'Staging/model/old overlay has an unexpected owner')
        for key,kind,old_key in (('policies','NetworkPolicy','policyInventory'),('services','Service','serviceInventory')):
            rows = stage.complete_list(load(x[key]),kind,self.namespace)['items']
            require({r['metadata']['name']:{'uid':r['metadata']['uid'],'spec':r['spec']} for r in rows} == self.inputs.file(self.ref(self.previous[old_key],self.profile_path.parent)), 'Complete public policy/service inventory changed')
        storage = named(load(x['storageClass']),'StorageClass','storage.k8s.io/v1')
        require(storage['metadata']['name'] == self.profile['storage']['storageClassName'], 'Reviewed storage class differs')
        self.source_check()
        return {'raw':x,'deployments':deployments,'pods':pods,'claims':claims,'pvs':pvs,'owner':owner,'replicaSet':rs,'storageClass':storage,'config':config}

    def assemble_check(self, capture_ref, out):
        capture_ref = self.ref(capture_ref,self.inputs.base); c = self.capture(capture_ref)
        baseline = {'version':1,'deployments':[c['deployments'][k] for k in sorted(c['deployments'])],
                    **{k:c[k] for k in ('pods','claims','pvs','owner','replicaSet','storageClass')}}
        baseline_ref = save(out,'stage.baseline.json',baseline)
        value = {'version':1,'target':self.profile['target'],'prepared':self.prepared_ref,'planningEvidence':self.evidence_ref,
                 'baseline':baseline_ref,'publicKey':self.profile['publicKey'],'preflight':self.profile['preflight'],'hostProbe':self.profile['hostProbe'],
                 'names':self.names,'storage':self.profile['storage'],'minimumFreeBytes':self.profile['minimumFreeBytes'],
                 'maximumWriteBytes':self.profile['maximumWriteBytes'],'outputDirectory':str(out/'stage-execution'),'node':self.node,
                 'sourceFiles':self.source_refs(stage.SOURCE_NAMES)}
        stage_ref = save(out,'stage.input.json',value); operator = file_ref(HERE/'stage-public-shell.py')
        checked = stage.Stage(stage_ref['path'],stage_ref['sha256'],operator['sha256']).execute('check')
        require(checked['status'] == 'PUBLIC_STAGE_INPUTS_BOUND_NOT_EXECUTED' and checked['productionMutation'] is False, 'Maintained offline stage check differs')
        resources = save(out,'stage.resources.proposed.json',checked['desired']); self.source_check()
        return save(out,'check.actual.json',{'version':1,'status':'OFFLINE_PUBLIC_SHELL_UPDATE_CHECKED_NOT_EXECUTED','profile':self.profile_ref,
                    'prepared':self.prepared_ref,'capture':capture_ref,'stageInput':stage_ref,'stageOperator':operator,'baseline':baseline_ref,'resources':resources,
                    'targetCalls':False,'productionMutation':False,'originAuthenticatedByThisCommand':False})

    def probes(self):
        policy = self.profile['probePolicy']; paths = list(policy['paths'])
        chunks = [p for p in sorted(self.effective.files) if p.startswith('_app/') and p.endswith('.js')]
        changed = [p for p in chunks if self.effective.files[p] != self.old_files.get(p)]
        retained = [p for p in chunks if p not in changed]
        require(len(chunks) >= policy['lazyChunks'], 'Reviewed lazy chunk count unavailable')
        selected = [*(changed + retained)[:policy['lazyChunks']], *retained[:1]]
        paths += [p for p in dict.fromkeys(selected) if p not in paths]
        origins = sorted({urllib.parse.urlsplit(u).netloc for u in self.component.get('healthURLs',[])})
        require(origins and len(origins)*len(paths) <= 100, 'Bounded explicit public normal-HTTPS origins required')
        result = []
        for origin in origins:
            for path in paths:
                row = self.effective.files.get(path)
                require(row and row['size'] <= 8*1024**2, 'Exact prepared probe bytes required')
                result.append({'url':'https://'+origin+'/'+urllib.parse.quote(path,safe='/'),**row})
        return result

    def assemble_plan(self, check_ref, capture_ref, stage_ref, out):
        check_ref, capture_ref, stage_ref = [self.ref(r,self.inputs.base) for r in (check_ref,capture_ref,stage_ref)]
        checked = self.inputs.file(check_ref); exact(checked,CHECK_KEYS)
        require(checked['status'] == 'OFFLINE_PUBLIC_SHELL_UPDATE_CHECKED_NOT_EXECUTED' and type(checked['version']) is int and checked['version'] == 1 and
                checked['profile'] == self.profile_ref and checked['prepared'] == self.prepared_ref and all(checked[k] is False for k in ('targetCalls','productionMutation','originAuthenticatedByThisCommand')), 'Original offline check binding differs')
        require(checked['stageOperator'] == file_ref(HERE/'stage-public-shell.py'), 'Checked operator differs from immutable helper closure')
        guard = stage.Stage(checked['stageInput']['path'],checked['stageInput']['sha256'],checked['stageOperator']['sha256'])
        before_capture = self.capture(self.ref(checked['capture'],Path(check_ref['path']).parent))
        expected_baseline = {'version':1,'deployments':[before_capture['deployments'][k] for k in sorted(before_capture['deployments'])],
                             **{k:before_capture[k] for k in ('pods','claims','pvs','owner','replicaSet','storageClass')}}
        require(guard.baseline == expected_baseline and self.inputs.file(self.ref(checked['baseline'],Path(check_ref['path']).parent)) == expected_baseline and
                self.inputs.file(self.ref(checked['resources'],Path(check_ref['path']).parent)) == guard.desired, 'Original check baseline/resources differ from original capture')
        require(guard.value['prepared'] == self.prepared_ref and guard.value['target'] == self.profile['target'] and guard.value['names'] == self.names and
                guard.value['preflight'] == self.profile['preflight'] and guard.value['hostProbe'] == self.profile['hostProbe'] and
                guard.value['storage'] == self.profile['storage'] and guard.value['publicKey'] == self.profile['publicKey'] and
                guard.value['minimumFreeBytes'] == self.profile['minimumFreeBytes'] and guard.value['maximumWriteBytes'] == self.profile['maximumWriteBytes'] and
                guard.value['node'] == self.node and guard.value['sourceFiles'] == self.source_refs(stage.SOURCE_NAMES) and
                guard.value['outputDirectory'] == str(Path(check_ref['path']).parent/'stage-execution'), 'Checked stage differs from reviewed profile')
        proof = publisher.review_retirement(self.inputs.file(stage_ref),guard); after = self.capture(capture_ref,proof)
        old = guard.baseline
        for d in old['deployments']:
            current = after['deployments'][next(k for k,c in self.target['components'].items() if (c['namespace'],c['deployment']) == (d['metadata']['namespace'],d['metadata']['name']))]
            require(current['metadata']['uid'] == d['metadata']['uid'] and current['spec'] == d['spec'], 'Protected Deployment changed across staging')
        for key,kind,added in (('claims','PersistentVolumeClaim',proof['claim']),('pvs','PersistentVolume',proof['pv'])):
            expected = {stage.private.resource_key(r):r for r in old[key]['items']}; expected[stage.private.resource_key(added)] = added
            actual = {stage.private.resource_key(r):r for r in after[key]['items']}
            require(set(actual) == set(expected) and all(actual[k]['metadata']['uid'] == r['metadata']['uid'] and payload(actual[k]) == payload(r) for k,r in expected.items()), 'Complete global storage changed outside the exact new tuple')
        require(payload(after['storageClass']) == payload(old['storageClass']) and after['storageClass']['metadata']['uid'] == old['storageClass']['metadata']['uid'] and
                after['owner']['spec'] == old['owner']['spec'] and after['replicaSet']['metadata']['uid'] == old['replicaSet']['metadata']['uid'] and
                payload(after['replicaSet']) == payload(old['replicaSet']), 'Storage class or accepted owner changed across staging')
        value = {'version':1,'status':'REVIEWED_PUBLIC_SHELL_PUBLICATION_INPUT','stageInput':checked['stageInput'],'stage':stage_ref,
                 'preflight':self.profile['preflight'],'staticProbes':self.probes(),'outputDirectory':str(out/'publication-execution'),
                 'sourceFiles':self.source_refs(stage.SOURCE_NAMES|{'publish-public-shell.py'})}
        publication_ref = save(out,'publication.input.json',value); operator = file_ref(HERE/'publish-public-shell.py')
        result = publisher.Publication(publication_ref['path'],publication_ref['sha256'],operator['sha256']).execute('check')
        require(result['status'] == 'PUBLIC_PUBLICATION_INPUTS_BOUND_NOT_EXECUTED' and result['productionMutation'] is False, 'Maintained publisher offline check differs')
        self.source_check()
        return save(out,'plan.actual.json',{'version':1,'status':'OFFLINE_PUBLIC_SHELL_PUBLICATION_ASSEMBLED_NOT_APPLIED','profile':self.profile_ref,
                    'prepared':self.prepared_ref,'check':check_ref,'capture':capture_ref,'stage':stage_ref,'publicationInput':publication_ref,
                    'publicationOperator':operator,'targetCalls':False,'productionMutation':False,'originAuthenticatedByThisCommand':False})

    def read_capture(self, out, staged=None, runner=None):
        """Literal GET-only transport; every response is retained before parsing."""
        require(out.is_dir() and not any(out.iterdir()) and not out.stat().st_mode & 0o077, 'New private capture output required')
        events = []; runner = runner or subprocess.run
        save(out,'capture.started.json',{'version':1,'status':'READ_ONLY_CAPTURE_STARTED_NO_REPLAY','profile':self.profile_ref,'prepared':self.prepared_ref})
        def get(label, kind, name=None, namespace=None):
            self.source_check()
            allowed = {'namespace','node','deployments','pods','pvc','pv','configmap','storageclass','replicaset','networkpolicies','services'}
            require(kind in allowed, 'Only reviewed GET selectors allowed')
            if name: stage.resources.name(name)
            args = ['get',kind,*([name] if name else []),'-o','json']
            if namespace == '*': args += ['--all-namespaces']
            elif namespace: stage.resources.name(namespace); args += ['--namespace',namespace]
            argv = stage.Stage.transport(self,args); intent = save(out,label+'.started.json',{'version':1,'argv':argv,'status':'READ_ONLY_GET_STARTED_NO_REPLAY'})
            timed, failure = False, None
            try:
                result = runner(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=100,check=False)
                stdout, stderr, code = result.stdout,result.stderr,result.returncode
            except subprocess.TimeoutExpired as error:
                stdout,stderr,code,timed = error.stdout or b'',error.stderr or b'',None,True
            except OSError as error:
                stdout,stderr,code,failure = b'',b'',None,type(error).__name__
            require(type(stdout) is bytes and type(stderr) is bytes, 'Original command bytes required')
            refs = {k:{**save_raw(out,label+'.'+k+'.original',raw[:32*1024**2]),'observedBytes':len(raw),'complete':len(raw) <= 32*1024**2}
                    for k,raw in (('stdout',stdout),('stderr',stderr))}
            event = save(out,label+'.command.original.json',{'version':1,'argv':argv,'intent':intent,'returncode':code,'timedOut':timed,'failureType':failure,'originals':refs}); events.append(event)
            require(not timed and failure is None and type(code) is int and code == 0 and all(r['complete'] for r in refs.values()), 'GET failed; never replay')
            return {k:refs['stdout'][k] for k in ('path','sha256')}
        try:
            scopes = sorted({c['namespace'] for c in self.target['components'].values()})
            x = {'version':1,'status':'READ_ONLY_PUBLIC_SHELL_RESOURCES_CAPTURED','targetSha256':self.profile['target']['sha256'],
                 'systemNamespace':get('system-namespace','namespace','kube-system'),'node':get('node','node',self.target['node']['name']),
                 'namespaces':{ns:get('namespace-'+ns,'namespace',ns) for ns in scopes},
                 'deployments':{ns:get('deployments-'+ns,'deployments',namespace=ns) for ns in scopes},
                 'pods':get('pods','pods',namespace=self.namespace),'claims':get('claims','pvc',namespace='*'),'volumes':get('volumes','pv'),
                 'storageClass':get('storage-class','storageclass',self.profile['storage']['storageClassName']),
                 'nginxConfig':get('nginx-config','configmap',self.config['metadata']['name'],self.namespace),
                 'policies':get('policies','networkpolicies',namespace=self.namespace),'services':get('services','services',namespace=self.namespace)}
            pods = stage.complete_list(self.inputs.file(x['pods']),'Pod',self.namespace)
            owners = [p for p in pods['items'] if p['metadata']['uid'] == self.runtime['podUID']]
            require(len(owners) == 1 and len(owners[0]['metadata'].get('ownerReferences',[])) == 1, 'Accepted owner/controller absent')
            x['replicaSet'] = get('replica-set','replicaset',owners[0]['metadata']['ownerReferences'][0]['name'],self.namespace)
            ref = save(out,'capture.original.json',x); self.capture(ref,staged); self.source_check()
            save(out,'capture.actual.json',{'version':1,'status':'READ_ONLY_CAPTURE_VALIDATED','capture':ref,'commands':events,'productionMutation':False,'originAuthenticatedByThisCommand':False})
            return ref
        except Exception as error:
            save(out,'capture.uncertain.json',{'version':1,'status':'READ_ONLY_CAPTURE_REFUSED_NO_REPLAY','failureType':type(error).__name__,'commands':events,'productionMutation':False}); raise

    def next_profile(self, accepted, out):
        ref = self.ref(accepted,self.inputs.base); previous = self.inputs.file(ref); public.baseline(previous,self.inputs)
        require(previous['shellSource'] == self.prepared['sources']['shell'] and previous['image'] == self.previous['image'] and
                all(previous[k] == self.previous[k] for k in ('imageSource','settings','profile','publicKeySha256','publicCatalog')) and
                self.ref(previous['staticManifest'],Path(ref['path']).parent) == self.ref(self.producer['shell']['manifest'],Path(self.evidence_ref['path']).parent) and previous['overlay']['claim'] == self.prepared['selection']['shellClaim'], 'Actual next accepted public baseline differs')
        value = copy.deepcopy(self.profile); value['previous'] = ref; self.source_check()
        return save(out,'instance-profile.next.json',value)

    def run(self, out):
        """One owned attempt; maintained operators retain every mutation original."""
        self.source_check()
        require(out.is_dir() and out.resolve(strict=True) == out and not out.stat().st_mode & 0o077 and not any(out.iterdir()), 'Execution requires a new empty canonical private directory')
        require(self.prepared['sources']['shell'] != self.previous['shellSource'], 'An already accepted release is not replayable')
        self.probes()
        started = time.monotonic(); phase_started = started; phase = 'capture-before'; timings = {}
        save(out,'run.started.json',{'version':1,'status':'PUBLIC_SHELL_UPDATE_STARTED_NO_REPLAY','profile':self.profile_ref,'prepared':self.prepared_ref,'operatorSha256':self.operator_sha})
        def timed(label):
            nonlocal phase_started
            timings[label] = time.monotonic()-phase_started
            save(out,label+'.timing.actual.json',{'version':1,'phase':label,'elapsedSeconds':timings[label],'origin':'LOCAL_MONOTONIC_ELAPSED_TIME','qualificationClaimed':False})
            phase_started = time.monotonic()
        try:
            capture = self.read_capture(private_new_directory(out/'capture-before')); timed(phase)
            phase = 'stage-check'
            checked = self.assemble_check(capture,private_new_directory(out/'stage-preparation')); check = self.inputs.file(checked); timed(phase)
            phase = 'stage'; self.source_check()
            result = stage.Stage(check['stageInput']['path'],check['stageInput']['sha256'],check['stageOperator']['sha256']).execute('run')
            exact(result,{'stage','claimRetained','productionDeploymentMutated'})
            require(result['claimRetained'] is True and result['productionDeploymentMutated'] is False, 'Retired stage boundary differs')
            stage_ref = self.ref(result['stage'],out); proof = self.inputs.file(stage_ref)
            save(out,'stage.handoff.actual.json',{'stage':stage_ref,'check':checked}); timed(phase)
            phase = 'capture-after'; capture = self.read_capture(private_new_directory(out/'capture-after'),proof); timed(phase)
            phase = 'publication-plan'
            plan_ref = self.assemble_plan(checked,capture,stage_ref,private_new_directory(out/'publication-plan')); plan = self.inputs.file(plan_ref); timed(phase)
            publication = publisher.Publication(plan['publicationInput']['path'],plan['publicationInput']['sha256'],plan['publicationOperator']['sha256'])
            for phase in ('dryrun','apply','observe'):
                self.source_check(); publication.execute(phase)
                save(out,phase+'.handoff.actual.json',{'version':1,'phase':phase,'publicationInput':plan['publicationInput'],'status':'MAINTAINED_PHASE_RETURNED'}); timed(phase)
            observed = publication.prior('observe','PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED')
            next_ref = self.next_profile(observed['acceptedPrevious'],out)
            self.source_check()
            return save(out,'run.actual.json',{'version':1,'status':'PUBLIC_SHELL_UPDATE_RUNTIME_ACCEPTED','profile':self.profile_ref,'prepared':self.prepared_ref,
                        'stage':stage_ref,'publication':plan_ref,'acceptedPrevious':observed['acceptedPrevious'],'nextProfile':next_ref,
                        'elapsedSeconds':time.monotonic()-started,'elapsedSecondsByPhase':timings,'productionMutation':True,
                        'imageRebuilt':False,'infrastructureProvisioned':False,'originAuthenticatedByThisCommand':False,'remainingAcceptance':observed['remainingAcceptance']})
        except Exception as error:
            save(out,'run.uncertain.json',{'version':1,'status':'REFUSED_NO_REPLAY_READ_ONLY_RECONCILIATION_REQUIRED','phase':phase,'failureType':type(error).__name__,
                        'profile':self.profile_ref,'prepared':self.prepared_ref,'elapsedSeconds':time.monotonic()-started,'elapsedSecondsByCompletedPhase':timings,
                        'uncertainPhaseElapsedSeconds':time.monotonic()-phase_started}); raise


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['check','plan','run'])
    for name in ('profile','profile-sha256','prepared','prepared-sha256','operator-sha256','out'): parser.add_argument('--'+name,required=True)
    for name in ('capture','capture-sha256','check','check-sha256','stage','stage-sha256'): parser.add_argument('--'+name)
    parser.add_argument('--node',default='node'); args = parser.parse_args()
    operation = Update(args.profile,args.profile_sha256,args.prepared,args.prepared_sha256,args.operator_sha256,args.node)
    if args.action == 'run':
        require(not any(getattr(args,key) for key in ('capture','capture_sha256','check','check_sha256','stage','stage_sha256')), 'run obtains only fresh original captures')
    else: require(args.capture and args.capture_sha256, 'Local complete capture and digest required')
    if args.action == 'plan': require(args.check and args.check_sha256 and args.stage and args.stage_sha256, 'Original check and genuine retired stage required')
    if args.action == 'check': require(not any(getattr(args,key) for key in ('check','check_sha256','stage','stage_sha256')), 'check cannot consume runtime handoff')
    out = private_new_directory(args.out)
    if args.action == 'run': result = operation.run(out)
    elif args.action == 'check': result = operation.assemble_check({'path':args.capture,'sha256':args.capture_sha256},out)
    else: result = operation.assemble_plan({'path':args.check,'sha256':args.check_sha256},{'path':args.capture,'sha256':args.capture_sha256},{'path':args.stage,'sha256':args.stage_sha256},out)
    print(json.dumps({'receipt':result,'action':args.action},sort_keys=True))


if __name__ == '__main__':
    try: main()
    except (Refusal,stage.private.Refusal,updater.Refusal,stage.resources.Refusal,OSError,ValueError,KeyError,TypeError,StopIteration,subprocess.SubprocessError):
        print('REFUSED: public update custody or phase differs; preserve originals and never replay',file=sys.stderr); raise SystemExit(1)
