#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline adversarial staging boundaries; synthetic captures never qualify live."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
SCRIPT = HERE / 'scripts/stage-private-shell.py'
spec = importlib.util.spec_from_file_location('stage', SCRIPT)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
spec = importlib.util.spec_from_file_location('shell_plan_fixture', Path(__file__).with_name('test_plan_private_shell.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
NODE = os.environ.get('LOLLY_TEST_NODE', 'node')


def ref(path):
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def simple():
    source = 'a' * 40; image = 'registry.example/work@sha256:' + 'b' * 64
    prepared = {'image':image,'sources':{'engine':source,'work':source},'selection':{'shellClaim':'new-shell'}}
    previous = {'image':image,'engineSource':source,'workSource':source,'shell':{'name':'old-shell'},'pack':{'name':'old-pack'},'pin':{'name':'old-pin'}}
    target = {'node':{'name':'fixture-node','uid':'fixture-node-uid'},'components':{'work':{'namespace':'private'}}}
    names = {'writer':'shell-writer','qualifier':'shell-qualifier','packClaim':'temporary-pack','policy':'shell-policy'}
    storage = {'storageClassName':'local-path','shellBytes':1024**3,'packBytes':1024**3}
    return m.make_resources(prepared,previous,target,names,storage)


def actual_pod(want):
    pod = copy.deepcopy(want); pod['metadata'].update(uid='synthetic-uid',resourceVersion='7')
    pod['spec'].update(dnsPolicy='ClusterFirst',schedulerName='default-scheduler',terminationGracePeriodSeconds=30,serviceAccountName='default',priority=0,
                       preemptionPolicy='PreemptLowerPriority',tolerations=[{'key':'node.kubernetes.io/not-ready','operator':'Exists','effect':'NoExecute','tolerationSeconds':300}])
    container = pod['spec']['containers'][0]; container.update(terminationMessagePath='/dev/termination-log',terminationMessagePolicy='File')
    for volume in pod['spec']['volumes']:
        if 'configMap' in volume: volume['configMap']['defaultMode'] = 420
    pod['status'] = {'containerStatuses':[{'name':'stager','ready':True,'restartCount':0,'imageID':container['image']}]}
    return pod


class Boundaries(unittest.TestCase):
    def test_defaulted_pod_is_exact_nonroot_and_qualifier_mounts_only_isolated_readonly_content(self):
        desired = simple(); m.validate_pod(actual_pod(desired['writer']),desired['writer'],True)
        m.validate_pod(actual_pod(desired['qualifier']),desired['qualifier'],True)
        for role in ('writer','qualifier'):
            spec = desired[role]['spec']; self.assertNotIn('env',spec['containers'][0]); self.assertNotIn('initContainers',spec)
            claims = [v['persistentVolumeClaim']['claimName'] for v in spec['volumes'] if 'persistentVolumeClaim' in v]
            self.assertEqual(claims,['new-shell','temporary-pack'])
        self.assertTrue(all(v.get('readOnly') for v in desired['qualifier']['spec']['containers'][0]['volumeMounts'] if v['name'] != 'tmp'))

    def test_pod_admission_active_claim_secret_sidecar_host_image_or_hook_refuses(self):
        want = simple()['qualifier']
        changes = [lambda p:p['spec']['volumes'][0]['persistentVolumeClaim'].update(claimName='old-shell'),
                   lambda p:p['spec'].update(initContainers=[{'name':'unsafe','image':'unknown'}]),
                   lambda p:p['spec'].update(imagePullSecrets=[{'name':'credentials'}]),
                   lambda p:p['spec'].update(hostNetwork=True), lambda p:p['spec'].update(serviceAccountName='production-admin'),
                   lambda p:p['spec']['containers'].append({'name':'sidecar','image':'unknown'}),
                   lambda p:p['spec']['containers'][0].update(env=[{'name':'DATABASE_URL','valueFrom':{'secretKeyRef':{'name':'database','key':'url'}}}]),
                   lambda p:p['spec']['containers'][0].update(lifecycle={'postStart':{'exec':{'command':['sh']}}}),
                   lambda p:p['spec']['containers'][0].update(image='registry.example/work@sha256:'+'c'*64),
                   lambda p:p['spec']['containers'][0]['volumeMounts'][0].update(readOnly=False),
                   lambda p:p['spec']['containers'][0]['securityContext'].update(privileged=True),
                   lambda p:p['status']['containerStatuses'][0].update(imageID='registry.example/work@sha256:'+'c'*64)]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                p = actual_pod(want); change(p)
                with self.assertRaises(m.Refusal): m.validate_pod(p,want,True)

    def test_new_claim_prebound_datasource_selector_and_wrong_storage_refuse(self):
        want = simple()['shellClaim']; actual = copy.deepcopy(want); actual['metadata'].update(uid='new',resourceVersion='1'); actual['status']={'phase':'Pending'}
        actual['spec']['resources']['requests']['storage']='1Gi'; m.validate_create(actual,want)
        for change in (lambda p:p['spec'].update(volumeName='active-pv'),lambda p:p['spec'].update(dataSource={'kind':'PersistentVolumeClaim','name':'old-shell'}),
                       lambda p:p['spec'].update(selector={'matchLabels':{'active':'yes'}}),lambda p:p['spec']['resources']['requests'].update(storage='2Gi')):
            p = copy.deepcopy(actual); change(p)
            with self.assertRaises(m.Refusal): m.validate_create(p,want)

    def test_actual_deny_policy_omits_empty_rules_and_injected_rules_refuse(self):
        want = simple()['policy']; actual = copy.deepcopy(want); actual['metadata'].update(uid='policy-uid',resourceVersion='1')
        self.assertNotIn('ingress',actual['spec']); self.assertNotIn('egress',actual['spec']); m.validate_create(actual,want)
        for field in ('ingress','egress'):
            altered = copy.deepcopy(actual); altered['spec'][field] = [{}]
            with self.assertRaises(m.Refusal): m.validate_create(altered,want)

    def test_ambiguous_phase_never_replays_and_records_original_command_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = m.Stage.__new__(m.Stage); stage.out=Path(tmp); stage.input_sha='a'*64; stage.operator_sha='b'*64; stage.events=[]
            calls=[]
            def failed():
                calls.append('attempt'); stage.run([sys.executable,'-c','import sys; print("original output"); print("original error",file=sys.stderr); sys.exit(7)'])
            with self.assertRaises(m.Refusal): stage.phase('copy',failed)
            with self.assertRaises(OSError): stage.phase('copy',failed)
            self.assertEqual(calls,['attempt']); self.assertTrue((stage.out/'copy.uncertain.json').exists())
            receipt=json.loads(next(stage.out.glob('command-*.json')).read_bytes()); self.assertEqual(receipt['exitCode'],7)
            self.assertEqual(Path(receipt['originals']['stdout']['path']).read_text(),'original output\n')
            self.assertEqual(Path(receipt['originals']['stderr']['path']).read_text(),'original error\n')

    def test_delete_requires_original_current_uid_resourceversion_and_cannot_delete_replacement(self):
        pod=actual_pod(simple()['writer']); result=m.delete_options(pod)
        self.assertEqual(result['preconditions'],{'uid':'synthetic-uid','resourceVersion':'7'})
        for key in ('uid','resourceVersion'):
            p=copy.deepcopy(pod); del p['metadata'][key]
            with self.assertRaises(m.Refusal): m.delete_options(p)
        pod['metadata']['deletionTimestamp']='now'
        with self.assertRaises(m.Refusal): m.delete_options(pod)

    def test_server_dryrun_injected_active_pvc_refuses_before_actual_pod_create(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage=m.Stage.__new__(m.Stage); stage.out=Path(tmp); stage.namespace='private'; calls=[]
            stage.absent=lambda *_:True; stage.verify_bindings=lambda:calls.append('bindings'); stage.preflight=lambda *_:calls.append('preflight')
            want=simple()['writer']; admission=copy.deepcopy(want); admission['spec']['volumes'][0]['persistentVolumeClaim']['claimName']='old-shell'
            def remote(argv,data=None): calls.append(argv); return m.cohort.canonical(admission)
            stage.remote=remote
            with self.assertRaises(m.Refusal): stage.admitted_pod(want)
            commands=[v for v in calls if isinstance(v,list)]; self.assertEqual(len(commands),1); self.assertIn('--dry-run=server',commands[0])
            self.assertEqual(calls[-2],'preflight')

    def test_complete_real_node_hash_refuses_missing_seal_extra_file_and_links(self):
        helper=HERE/'scripts/shell-stage-hash.mjs'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); (root/'asset.txt').write_bytes(b'accepted')
            payload={'root':str(root),'files':[{'path':'asset.txt','size':8,'sha256':hashlib.sha256(b'accepted').hexdigest()}],'allowSeal':False}
            def run(): return subprocess.run([NODE,str(helper)],input=json.dumps(payload).encode(),capture_output=True)
            result=run(); self.assertEqual(result.returncode,0,result.stderr); self.assertEqual(json.loads(result.stdout)['files'],1)
            payload.update(allowSeal=True,sealSha256='a'*64); self.assertNotEqual(run().returncode,0)
            seal=b'original accepted seal'; payload['sealSha256']=hashlib.sha256(seal).hexdigest(); (root/'.__lolly_release_seal.json').write_bytes(seal)
            self.assertEqual(run().returncode,0)
            (root/'unexpected').write_bytes(b'unknown'); self.assertNotEqual(run().returncode,0); (root/'unexpected').unlink()
            (root/'asset.txt').unlink(); (root/'asset.txt').symlink_to(root/'.__lolly_release_seal.json'); self.assertNotEqual(run().returncode,0)

    def test_allocate_before_mount_uses_exact_uid_rv_spec_patch_and_keeps_preflight_last(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage=m.Stage.__new__(m.Stage); stage.out=Path(tmp); stage.namespace='private'; stage.target={'node':{'name':'fixture-node'}}
            stage.desired=simple(); stage.baseline={'storageClass':{'volumeBindingMode':'WaitForFirstConsumer'}}; calls=[]; records={}; pvs=[]
            ids={key:copy.deepcopy(stage.desired[key]) for key in ('shellClaim','packClaim','policy')}
            for key,value in ids.items(): value['metadata'].update(uid=key+'-uid',resourceVersion='10'); value['status']={'phase':'Pending'}
            stage.identities=lambda:ids; stage.get=lambda kind,name=None,namespace=None:copy.deepcopy(next(v for v in ids.values() if v['metadata']['name']==name)) if kind=='pvc' else {'apiVersion':'v1','kind':'List','metadata':{'resourceVersion':''},'items':copy.deepcopy(pvs)}
            stage.preflight=lambda *_:calls.append('preflight'); stage.verify_bindings=lambda:calls.append('isolated-bindings-before-any-pod')
            stage.save=lambda name,value:records.setdefault(name,copy.deepcopy(value))
            def remote(argv,data=None,timeout=None):
                calls.append(argv)
                if argv[0]=='wait': return b''
                self.assertEqual(argv[:2],['patch','pvc']); payload=json.loads(argv[argv.index('--patch')+1]); claim=next(v for v in ids.values() if v['metadata']['name']==argv[2])
                self.assertEqual(payload[:3],[{'op':'test','path':'/metadata/uid','value':claim['metadata']['uid']},{'op':'test','path':'/metadata/resourceVersion','value':'10'},{'op':'test','path':'/spec','value':claim['spec']}])
                self.assertEqual(payload[-1]['value']['volume.kubernetes.io/selected-node'],'fixture-node')
                claim['metadata']['annotations']=payload[-1]['value']; claim['status']['phase']='Bound'; claim['spec']['volumeName']='pv-'+claim['metadata']['name']
                pv={'apiVersion':'v1','kind':'PersistentVolume','metadata':{'name':claim['spec']['volumeName'],'uid':'pv-'+claim['metadata']['uid'],'resourceVersion':'11'},
                    'status':{'phase':'Bound'},'spec':{'accessModes':['ReadWriteOnce'],'volumeMode':'Filesystem','storageClassName':'local-path','claimRef':{'name':claim['metadata']['name'],'namespace':'private','uid':claim['metadata']['uid']},
                    'local':{'path':'/new-only/'+claim['metadata']['uid']},'nodeAffinity':{'required':{'nodeSelectorTerms':[{'matchExpressions':[{'key':'kubernetes.io/hostname','operator':'In','values':['fixture-node']}]}]}}}}
                pvs.append(pv); return m.cohort.canonical(claim)
            stage.remote=remote; stage.allocate_claims()
            for i,call in enumerate(calls):
                if isinstance(call,list) and call[0]=='patch': self.assertEqual(calls[i-1],'preflight')
            self.assertTrue(all(call[0]!='create' for call in calls if isinstance(call,list)))
            self.assertIn('claims.bound.actual.json',records); self.assertEqual(calls[-2:],['isolated-bindings-before-any-pod','preflight'])

    def test_unsupported_allocation_timeout_cannot_create_mounting_writer_or_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage=m.Stage.__new__(m.Stage); stage.out=Path(tmp); stage.input_sha='a'*64; stage.operator_sha='b'*64; calls=[]
            stage.namespace='private'; stage.target={'node':{'name':'fixture-node'}}; stage.desired=simple(); stage.baseline={'storageClass':{'volumeBindingMode':'Immediate'}}
            claim=copy.deepcopy(stage.desired['shellClaim']); claim['metadata'].update(uid='new-uid',resourceVersion='1'); claim['status']={'phase':'Pending'}
            stage.identities=lambda:{'shellClaim':claim}; stage.get=lambda *_:claim; stage.preflight=lambda *_:calls.append('preflight')
            def remote(argv,data=None,timeout=None): calls.append(argv); raise m.Refusal('synthetic provisioner did not allocate')
            stage.remote=remote
            with self.assertRaises(m.Refusal): stage.phase('create',stage.allocate_claims)
            with self.assertRaises(OSError): stage.phase('create',stage.allocate_claims)
            self.assertEqual(len(calls),1); self.assertEqual(calls[0][0],'wait'); self.assertNotIn('Pod',str(calls))

    def test_real_getters_preserve_generic_or_typed_collection_and_raw_stdout(self):
        for selector,item_kind,namespace in (('pods','Pod','private'),('pvc','PersistentVolumeClaim','private'),('pv','PersistentVolume',None),('deployments','Deployment','private')):
            item_api='apps/v1' if item_kind=='Deployment' else 'v1'
            for collection_kind in ('List',item_kind+'List'):
                with self.subTest(selector=selector,kind=collection_kind), tempfile.TemporaryDirectory() as tmp:
                    item={'apiVersion':item_api,'kind':item_kind,'metadata':{'name':'synthetic-item','uid':'synthetic-uid','resourceVersion':'7'}}
                    if namespace: item['metadata']['namespace']=namespace
                    value={'apiVersion':'v1' if collection_kind=='List' else item_api,'kind':collection_kind,'metadata':{'resourceVersion':''},'items':[item]}; raw=json.dumps(value).encode()+b'\n'
                    stage=m.Stage.__new__(m.Stage); stage.out=Path(tmp); stage.events=[]
                    stage.transport=lambda argv:[sys.executable,'-c','import sys; sys.stdout.buffer.write('+repr(raw)+')']
                    self.assertEqual(stage.get(selector,namespace=namespace),value)
                    receipt=json.loads(next(stage.out.glob('command-*.json')).read_bytes())
                    self.assertEqual(Path(receipt['originals']['stdout']['path']).read_bytes(),raw)
                    self.assertIs(m.complete_list(value,item_kind,namespace),value)
        empty={'apiVersion':'v1','kind':'List','metadata':{'resourceVersion':''},'items':[]}
        self.assertIs(m.complete_list(empty,'Pod','private'),empty)

    def test_missing_wrong_kind_api_scope_duplicates_or_incomplete_collections_refuse(self):
        item={'apiVersion':'v1','kind':'Pod','metadata':{'name':'one','uid':'one-uid','namespace':'private','resourceVersion':'7'}}
        original={'apiVersion':'v1','kind':'List','metadata':{'resourceVersion':''},'items':[item]}
        changes=(lambda v:v.pop('items'),lambda v:v.update(apiVersion='v2'),lambda v:v.update(kind='PersistentVolumeClaimList'),
                 lambda v:v['items'][0].pop('kind'),lambda v:v['items'][0].pop('apiVersion'),lambda v:v['items'][0].update(kind='Secret'),
                 lambda v:v['items'][0].update(apiVersion='v2'),lambda v:v['items'][0]['metadata'].update(namespace='other'),
                 lambda v:v['items'][0]['metadata'].pop('name'),lambda v:v['items'][0]['metadata'].pop('uid'),
                 lambda v:v['items'].append(copy.deepcopy(v['items'][0])),lambda v:v['items'].append({**copy.deepcopy(item),'metadata':{'name':'other','uid':'one-uid','namespace':'private'}}),
                 lambda v:v['metadata'].update({'continue':'next-token'}),lambda v:v['metadata'].update(remainingItemCount=2),lambda v:v['metadata'].update(remainingItemCount=False))
        for change in changes:
            with self.subTest(change=changes.index(change)):
                value=copy.deepcopy(original); change(value)
                with self.assertRaises((m.Refusal,m.resources.Refusal)): m.complete_list(value,'Pod','private')
        for kind,namespace in (('Pod','private'),('PersistentVolumeClaim','private'),('PersistentVolume',None),('Deployment','private')):
            for rv in (None,'',7):
                value=copy.deepcopy(original); value['items'][0]['kind']=kind; value['items'][0]['metadata']['resourceVersion']=rv
                if kind=='Deployment': value['items'][0]['apiVersion']='apps/v1'
                if namespace is None: value['items'][0]['metadata'].pop('namespace')
                with self.subTest(kind=kind,rv=rv), self.assertRaises(m.resources.Refusal): m.complete_list(value,kind,namespace)

    def test_deployment_collection_api_scope_unknown_items_and_pagination_refuse(self):
        item={'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'one','uid':'one-uid','namespace':'private','resourceVersion':'7'}}
        original={'apiVersion':'apps/v1','kind':'DeploymentList','metadata':{'resourceVersion':'12'},'items':[item]}
        changes=(lambda v:v.update(apiVersion='v1'),lambda v:v.update(kind='List'),lambda v:v['items'][0].update(apiVersion='v1'),
                 lambda v:v['items'][0].update(kind='Secret'),lambda v:v['items'][0]['metadata'].update(namespace='elsewhere'),
                 lambda v:v['items'].append(copy.deepcopy(item)),lambda v:v['metadata'].update({'continue':'next'}),
                 lambda v:v['metadata'].update(remainingItemCount=1),lambda v:v['items'][0]['metadata'].update(uid=''),
                 lambda v:v['items'][0]['metadata'].update(name=None),lambda v:v.update(unreviewed='extra'))
        for change in changes:
            value=copy.deepcopy(original); change(value)
            with self.subTest(change=changes.index(change)), self.assertRaises((m.Refusal,m.resources.Refusal)): m.complete_list(value,'Deployment','private')
        with self.assertRaises(m.Refusal): m.complete_list({'apiVersion':'v1','kind':'List','metadata':{},'items':[]},'Secret','private')

    def test_mount_release_waits_readonly_preserves_failed_original_and_rejects_wrong_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); target=root/'target.json'; target.write_text('{}')
            probe=root/'probe.py'; count=root/'observations'
            uid='writer-uid'; proof={'podUid':uid,'nodeUID':'node-uid','unmounted':True,'mountsReleased':True}
            probe.write_text('import pathlib,sys\np=pathlib.Path('+repr(str(count))+')\n'
                             'if not p.exists():\n p.write_text("1"); print("Owned kubelet Pod directory remains",file=sys.stderr); sys.exit(1)\n'
                             'print('+repr(json.dumps(proof))+')\n')
            stage=m.Stage.__new__(m.Stage); stage.out=root; stage.events=[]; stage.input_path=root/'input.json'
            stage.host_probe=probe; stage.target={'node':{'uid':'node-uid'}}; stage.value={'target':ref(target),'hostProbe':ref(probe)}
            stage.inputs=m.cohort.Inputs(root); stage.inputs.file(ref(target)); stage.inputs.file(ref(probe),False)
            with patch.object(m.time,'sleep'):
                self.assertEqual(stage.mount_release(uid),proof)
            receipts=[json.loads(p.read_bytes()) for p in root.glob('command-*.json')]
            self.assertEqual(sorted(r['exitCode'] for r in receipts),[0,1])
            failed=next(r for r in receipts if r['exitCode']==1)
            self.assertIn(b'Owned kubelet Pod directory remains',Path(failed['originals']['stderr']['path']).read_bytes())
            calls=[]
            def wrong(argv,**kwargs): calls.append(argv); return m.cohort.canonical({**proof,'nodeUID':'wrong-node'})
            stage.run=wrong
            with self.assertRaises(m.Refusal): stage.mount_release(uid)
            self.assertEqual(len(calls),1); self.assertEqual(calls[0][3],'mounts')
            stage.run=lambda *_,**kwargs:m.cohort.canonical(proof)
            with patch.object(m.time,'monotonic',side_effect=[0,0,121]):
                with self.assertRaises(m.Refusal): stage.mount_release(uid)

    def test_permanent_mount_failure_stops_before_qualifier_or_policy_mutation_and_no_delete_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); target=root/'target.json'; target.write_text('{}'); probe=root/'probe.py'; probe.write_text('fixture only')
            stage=m.Stage.__new__(m.Stage); stage.out=root; stage.input_path=root/'input.json'; stage.namespace='private'
            stage.input_sha='a'*64; stage.operator_sha='b'*64; stage.host_probe=probe; stage.target={'node':{'uid':'node-uid'}}
            stage.value={'target':ref(target),'hostProbe':ref(probe),'names':{'writer':'writer'}}
            stage.inputs=m.cohort.Inputs(root); stage.inputs.file(ref(target)); stage.inputs.file(ref(probe),False)
            stage.prior=lambda _:{}; stage.identities=lambda:{'writer':{'metadata':{'uid':'writer-uid'}}}; calls=[]
            stage.absent=lambda *_:True
            def fail(argv,**kwargs): calls.append(argv); raise m.Refusal('synthetic asynchronous cleanup still incomplete')
            stage.run=fail; stage.admitted_pod=lambda *_:self.fail('mounting qualifier must never be created')
            with patch.object(m.time,'monotonic',side_effect=[0,0,1,1,121]),patch.object(m.time,'sleep'):
                with self.assertRaises(m.Refusal): stage.create_qualifier()
            self.assertEqual(len(calls),1); self.assertTrue(all('mounts' in command and 'delete' not in command and 'create' not in command for command in calls))
            with self.assertRaises(OSError): stage.create_qualifier()
            self.assertEqual(len(calls),1)


class Inputs(fixture.Plan):
    def setUp(self):
        super().setUp()
        self.target={'version':1,'transport':{'type':'local','kubectl':['kubectl'],'kubeconfig':'/synthetic/no-network.kubeconfig','context':'synthetic-only'},
                     'clusterUID':'cluster-uid','node':{'name':'fixture-node','uid':'node-uid'},'components':{'work':{'namespace':'private','namespaceUID':'namespace-uid','deployment':'work','deploymentUID':'deployment-uid','container':'server','requiredLabels':{},'healthURLs':[]}}}
        resources=[r for r in self.facts['resources'] if r['metadata']['name'] not in {'new-shell','temporary-pack','pv-new-shell','pv-temporary-pack'}]
        owner=copy.deepcopy(self.facts['pods']['items'][0]); owner['metadata']['ownerReferences']=[{'kind':'ReplicaSet','name':'work-rs','uid':'accepted-rs-uid','controller':True}]
        owner['status']={'containerStatuses':[{'name':'server','ready':True,'imageID':self.previous['image']}]}
        self.baseline={'version':1,'deployments':[self.before],'resources':resources,'pods':{'apiVersion':'v1','kind':'PodList','metadata':{'resourceVersion':'1'},'items':[owner]},
                       'claims':{'apiVersion':'v1','kind':'PersistentVolumeClaimList','metadata':{'resourceVersion':'1'},'items':[r for r in resources if r['kind']=='PersistentVolumeClaim']},
                       'storageClass':{'apiVersion':'storage.k8s.io/v1','kind':'StorageClass','metadata':{'name':'local-path','uid':'class-uid','resourceVersion':'1'},'provisioner':'synthetic.example/fixture-only','volumeBindingMode':'WaitForFirstConsumer'}}
        self.preflight=self.base/'no-network-preflight.py'; self.preflight.write_text('print("synthetic fixture only")\n')
        sourcefiles=[SCRIPT,*[HERE/'scripts'/name for name in ('app-update.py','prepare-private-shell.py','prepare-private-cohort.py','prepare-paired-release.py','plan-private-cohort.py')]]
        self.stage_input={'version':1,'target':self.file('stage-target',self.target),'prepared':self.file('stage-prepared',self.prepared),'previous':self.prepare_evidence['previous'],
                          'baseline':self.file('stage-baseline',self.baseline),'previousShell':self.prepare_evidence['previousShell'],'shell':self.prepare_evidence['shell'],'rawPack':self.prepare_evidence['rawPack'],
                          'publicKey':self.prepare_evidence['publicPin'],'sourceMap':self.file('synthetic-reviewed-source-map',{'fixture':{'mode':'644','bytes':0,'sha256':'a'*64}}),
                          'preflight':ref(self.preflight),'hostProbe':ref(self.preflight),'programs':{k:ref(HERE/'scripts'/name) for k,name in [('hash','shell-stage-hash.mjs'),('native','shell-stage-native.mjs'),('boot','shell-stage-memory-boot.mjs')]},
                          'names':{'writer':'fixture-writer','qualifier':'fixture-qualifier','packClaim':'temporary-pack','policy':'fixture-deny'},'storage':{'storageClassName':'local-path','shellBytes':1024**3,'packBytes':1024**3},
                          'minimumFreeBytes':8*1024**3,'maximumWriteBytes':3*1024**3,'ownerSealSha256':None,'outputDirectory':str(self.base/'new-exclusive-stage'), 'sourceFiles':[ref(p) for p in sourcefiles]}

    def operator(self):
        file=self.file('stage-input',self.stage_input); path=self.base/file['path']
        return m.Stage(path,file['sha256'],ref(SCRIPT)['sha256'])

    def guard_objects(self, stage):
        """Complete original captures for the actual fresh() getter boundary."""
        namespace=stage.namespace
        collection=lambda api,kind,items:{'apiVersion':api,'kind':kind,'metadata':{'resourceVersion':''},'items':copy.deepcopy(items)}
        objects={('namespace','kube-system',None):{'metadata':{'uid':'cluster-uid'}},
                 ('node','fixture-node',None):{'metadata':{'uid':'node-uid'},'status':{'conditions':[{'type':'Ready','status':'True'}]}},
                 ('pvc',None,namespace):copy.deepcopy(self.baseline['claims']),
                 ('pv',None,None):collection('v1','List',[r for r in self.baseline['resources'] if r['kind']=='PersistentVolume']),
                 ('pods',None,namespace):copy.deepcopy(self.baseline['pods']),
                 ('storageclass','local-path',None):copy.deepcopy(self.baseline['storageClass']),
                 ('replicaset','work-rs',namespace):{'metadata':{'uid':'accepted-rs-uid','ownerReferences':[{'kind':'Deployment','uid':'deployment-uid'}]}},
                 ('networkpolicy','fixture-deny',namespace):{'metadata':{'uid':'policy-uid'},'spec':copy.deepcopy(stage.desired['policy']['spec'])}}
        for ns in {c['namespace'] for c in stage.target['components'].values()}:
            components=[c for c in stage.target['components'].values() if c['namespace']==ns]
            objects[('namespace',ns,None)]={'metadata':{'uid':components[0]['namespaceUID']}}
            items=[d for d in stage.baseline_deployments.values() if d['metadata']['namespace']==ns]
            objects[('deployments',None,ns)]=collection('apps/v1','DeploymentList',items)
        objects.update({(r['kind'],r['metadata']['name'],r['metadata'].get('namespace')):copy.deepcopy(r) for r in self.baseline['resources'] if r['kind']=='ConfigMap'})
        return objects

    def test_real_cli_check_binds_preparer_output_and_never_calls_cluster_or_creates_output(self):
        self.baseline['pods']['kind']='List'; self.baseline['pods']['metadata']['resourceVersion']=''
        self.baseline['claims']['kind']='List'; self.baseline['claims']['metadata']['resourceVersion']=''
        self.stage_input['baseline']=self.file('actual-generic-shape-baseline',self.baseline)
        input_ref=self.file('stage-cli-input',self.stage_input)
        result=subprocess.run([sys.executable,'-B',str(SCRIPT),'check','--inputs',str(self.base/input_ref['path']),'--sha256',input_ref['sha256'],'--operator-sha256',ref(SCRIPT)['sha256']],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr); receipt=json.loads(result.stdout)
        self.assertEqual(receipt['status'],'LOCAL_STAGE_INPUTS_BOUND_NOT_EXECUTED'); self.assertFalse(receipt['productionMutation']); self.assertFalse(Path(self.stage_input['outputDirectory']).exists())

    def test_source_closure_dropped_resources_incomplete_pvc_or_active_claim_refuse_offline(self):
        for change in (lambda v:v.update(sourceFiles=[]),lambda v:v['names'].update(packClaim='old-pack'),lambda v:v.update(minimumFreeBytes=1),lambda v:v.update(version=True)):
            old=copy.deepcopy(self.stage_input); change(self.stage_input)
            with self.assertRaises((m.Refusal,m.updater.Refusal,m.resources.Refusal,ValueError,KeyError)): self.operator()
            self.stage_input=old
        changed=copy.deepcopy(self.baseline); changed['resources']=[r for r in changed['resources'] if r['metadata']['name']!='dormant-rollback']
        self.stage_input['baseline']=self.file('missing-baseline-resource',changed)
        with self.assertRaises(m.Refusal): self.operator()

    def test_fresh_complete_claim_policy_and_owner_fences(self):
        stage=self.operator(); stage.out.mkdir(); stage.save('create-policy.original.json',{'kind':'NetworkPolicy','metadata':{'name':'fixture-deny','namespace':'private','uid':'policy-uid'},'spec':stage.desired['policy']['spec']})
        objects=self.guard_objects(stage)
        stage.get=lambda kind,name=None,namespace=None:copy.deepcopy(objects[(kind,name,namespace)])
        stage.kube=stage; stage.fresh()
        for key in (('pvc',None,'private'),('pods',None,'private'),('deployments',None,'private')):
            objects[key]['apiVersion']='v1'; objects[key]['kind']='List'; objects[key]['metadata']['resourceVersion']=''
        stage.fresh()
        original=copy.deepcopy(objects)
        for change in (lambda:objects[('pvc',None,'private')]['items'].append({'metadata':{'name':'unexpected','uid':'foreign'}}),
                       lambda:objects[('networkpolicy','fixture-deny','private')]['spec'].update(egress=[{}]),
                       lambda:objects[('pods',None,'private')]['items'].append({'metadata':{'uid':'foreign'},'spec':{'volumes':[{'name':'old','persistentVolumeClaim':{'claimName':'old-shell'}}]}}),
                       lambda:objects[('storageclass','local-path',None)].update(provisioner='unexpected.example/changed')):
            objects=copy.deepcopy(original); change()
            with self.assertRaises(m.Refusal): stage.fresh()

    def test_batched_fresh_reads_are_complete_originals_and_never_cached_across_passes(self):
        stage=self.operator(); stage.out.mkdir(); stage.events=[]
        # Nine owned Deployments, with one more namespace than the live target.
        for i in range(1,9):
            namespace=('private','public','demo','admission','extra')[i%5]
            component=copy.deepcopy(stage.component); component.update(namespace=namespace,namespaceUID='namespace-uid' if namespace=='private' else namespace+'-uid',deployment='app-'+str(i),deploymentUID='deployment-'+str(i)+'-uid')
            stage.target['components']['app-'+str(i)]=component
            deployment=copy.deepcopy(self.before); deployment['metadata'].update(namespace=namespace,name=component['deployment'],uid=component['deploymentUID'])
            stage.baseline_deployments[('Deployment',namespace,component['deployment'])]=deployment
        objects=self.guard_objects(stage); calls=[]; originals=[]
        unselected=copy.deepcopy(self.before); unselected['metadata'].update(name='unselected',uid='unselected-uid')
        objects[('deployments',None,'private')]['items'].append(unselected)
        def transport(argv):
            self.assertEqual(argv[0],'get'); selector=argv[1]; named=argv[2] if argv[2]!='-o' else None
            namespace=argv[argv.index('--namespace')+1] if '--namespace' in argv else None
            calls.append((selector,named,namespace)); raw=json.dumps(objects[(selector,named,namespace)],indent=1).encode()+b'\n'; originals.append(raw)
            return [sys.executable,'-c','import sys; sys.stdout.buffer.write('+repr(raw)+')']
        stage.transport=transport; stage.kube=stage; stage.fresh()
        self.assertEqual(len(calls),18); self.assertEqual(sum(c[0]=='deployments' for c in calls),5)
        self.assertEqual(sum(c[0]=='pvc' for c in calls),1); self.assertEqual(sum(c[0]=='pv' for c in calls),1)
        self.assertFalse(any(c[0] in {'deployment','PersistentVolumeClaim','PersistentVolume'} for c in calls))
        preserved=[Path(e['path']).read_bytes() for e in stage.events]
        stdout=[Path(json.loads(raw)['originals']['stdout']['path']).read_bytes() for raw in preserved]
        self.assertEqual(stdout,originals)
        stage.fresh(); self.assertEqual(len(calls),36)
        objects[('deployments',None,'private')]['items'][0]['spec']['replicas']=2
        with self.assertRaises(m.Refusal): stage.fresh()
        self.assertEqual(len(calls),48)  # Fresh cluster/node plus all five namespace/Deployment pairs.

    def test_batched_original_items_keep_all_identity_payload_namespace_and_inventory_guards(self):
        stage=self.operator(); stage.out.mkdir(); original=self.guard_objects(stage); objects=copy.deepcopy(original)
        stage.get=lambda kind,name=None,namespace=None:copy.deepcopy(objects[(kind,name,namespace)])
        stage.kube=stage
        dep=('deployments',None,'private'); claims=('pvc',None,'private'); pvs=('pv',None,None)
        pin=next(k for k in objects if k[0]=='ConfigMap')
        changes=(lambda:objects[dep]['items'].clear(),lambda:objects[dep]['items'][0]['metadata'].update(uid='replacement'),
                 lambda:objects[dep]['items'][0]['metadata'].update(deletionTimestamp='now'),
                 lambda:objects[dep]['items'][0]['metadata'].update(labels={'app.kubernetes.io/name':'postgresql'}),
                 lambda:objects[('namespace','private',None)]['metadata'].update(uid='replacement'),
                 lambda:objects[dep]['items'][0]['spec']['template']['spec'].update(hostNetwork=True),
                 lambda:objects[claims]['items'].pop(),lambda:objects[claims]['items'][0]['metadata'].update(uid='replacement'),
                 lambda:objects[claims]['items'][0]['spec'].update(volumeName='replacement-pv'),
                 lambda:objects[pvs]['items'].pop(),lambda:objects[pvs]['items'][0]['metadata'].update(uid='replacement'),
                 lambda:objects[pvs]['items'][0]['spec'].update(local={'path':'/foreign'}),
                 lambda:objects[pin].update(immutable=False),lambda:objects[pin].update(binaryData={'foreign':'YQ=='}),
                 lambda:objects[pin].update(data={'foreign':'pin'}),lambda:objects[pvs]['metadata'].update({'continue':'remaining'}))
        stage.fresh()
        for change in changes:
            objects=copy.deepcopy(original); change()
            with self.subTest(change=changes.index(change)), self.assertRaises((m.Refusal,m.updater.Refusal,m.resources.Refusal)): stage.fresh()
        # Additional well-formed namespace claims still refuse exact inventory,
        # even though they did not replace any protected resource.
        objects=copy.deepcopy(original); extra=copy.deepcopy(objects[claims]['items'][0]); extra['metadata'].update(name='foreign',uid='foreign-uid'); objects[claims]['items'].append(extra)
        with self.assertRaises(m.Refusal): stage.fresh()


if __name__ == '__main__':
    suite=unittest.TestSuite()
    for cls in (Boundaries,Inputs):
        for name in cls.__dict__:
            if name.startswith('test_'): suite.addTest(cls(name))
    result=unittest.TextTestRunner(verbosity=2).run(suite); raise SystemExit(not result.wasSuccessful())
