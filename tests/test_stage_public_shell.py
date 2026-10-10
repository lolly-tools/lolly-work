#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline synthetic cluster captures; genuine Git/crypto/archive operations only.

No fixture authenticates a live CI origin or qualifies Nginx/production. Tests
exercise maintained check CLIs and mutation ordering with in-memory transports.
"""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name,path); value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


m = load('public_stage_test',HERE/'scripts/stage-public-shell.py')
fixture = load('public_preparation_fixture',Path(__file__).with_name('test_prepare_public_shell.py'))
NODE = os.environ.get('LOLLY_TEST_NODE','node')
REFUSALS = (m.Refusal,m.private.Refusal,m.updater.Refusal,m.resources.Refusal)


def root_proof(target, claim, pv):
    path=pv['spec']['local']['path']
    def row(p): return {'path':str(p),'device':17,'inode':int(hashlib.sha256(str(p).encode()).hexdigest()[:8],16)+1,'mode':0o2770,'uid':0,'gid':101}
    return {'version':1,'status':'READ_ONLY_PUBLIC_LOCAL_PV_ROOT_METADATA_OBSERVED','clusterUID':target['clusterUID'],'node':target['node'],
            'claimUID':claim['metadata']['uid'],'pvUID':pv['metadata']['uid'],'pvSpecSha256':m.cohort.digest(pv['spec']),
            'root':{**row(path),'selinuxLabel':'system_u:object_r:container_file_t:s0:c1,c2'},
            'ancestors':[row(p) for p in reversed(Path(path).parents)],'readOnly':True,'productionMutation':False}


def ref(path): return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def collection(kind, rows):
    return {'apiVersion':'v1','kind':'List','metadata':{'resourceVersion':''},'items':copy.deepcopy(rows)}


def actual_pod(want, uid):
    pod = copy.deepcopy(want); pod['metadata'].update(uid=uid,resourceVersion='7')
    pod['spec'].update(dnsPolicy='ClusterFirst',schedulerName='default-scheduler',terminationGracePeriodSeconds=30,serviceAccountName='default',priority=0,preemptionPolicy='PreemptLowerPriority')
    pod['status'] = {'containerStatuses':[{'name':pod['spec']['containers'][0]['name'],'ready':True,'restartCount':0,'imageID':pod['spec']['containers'][0]['image']}]}
    return pod


def tar_bytes(content):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as tar:
        for name,data in content.items():
            info=tarfile.TarInfo(name); info.size=len(data); info.mode=0o644; info.uid=info.gid=101
            tar.addfile(info,io.BytesIO(data))
    return raw.getvalue()


class CompressedArchive(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'owner.tar.gz'
        self.content={'_app/one.js':b'first asset'*137,'catalog/tools/index.json':b'{"fixture":true}'}
        self.expected={p:{'path':p,'size':len(b),'sha256':hashlib.sha256(b).hexdigest()} for p,b in self.content.items()}
        self.raw=tar_bytes(self.content)
        self.body_end=sum(512+(len(b)+511)//512*512 for b in self.content.values())

    def validate(self, raw=None, compressed=None, expected=None, maximum=m.cohort.MAX_BYTES):
        self.path.write_bytes(compressed if compressed is not None else gzip.compress(self.raw if raw is None else raw,mtime=0))
        return m.validate_archive(self.path,self.expected if expected is None else expected,maximum)

    def test_complete_single_gzip_preserves_exact_files_and_two_tar_end_blocks(self):
        for raw in (self.raw,self.raw[:self.body_end+1024]):
            proof=self.validate(raw)
            self.assertEqual(proof['files'],2); self.assertEqual(proof['uncompressedBytes'],len(raw))
            self.assertTrue(proof['gzipIntegrityVerified']); self.assertTrue(proof['tarEndBlocksVerified']); self.assertTrue(proof['fullFileHashesVerified'])

    def test_omitted_whole_file_and_complete_payload_without_end_blocks_refuse(self):
        first=512+(len(self.content['_app/one.js'])+511)//512*512
        for raw,expected in ((self.raw[:first],self.expected),(self.raw[:first],{'_app/one.js':self.expected['_app/one.js']}),
                             (self.raw[:self.body_end],self.expected),(self.raw[:self.body_end+512],self.expected),
                             (self.raw[:self.body_end+1023],self.expected)):
            with self.assertRaises(m.Refusal): self.validate(raw,expected=expected)
        # A well-formed gzip/tar with a whole accepted file missing still refuses.
        with self.assertRaises(m.Refusal): self.validate(tar_bytes({'_app/one.js':self.content['_app/one.js']}))

    def test_truncated_gzip_tail_crc_size_and_noncompressed_input_refuse(self):
        encoded=gzip.compress(self.raw,mtime=0)
        crc=bytearray(encoded); crc[-8]^=1
        size=bytearray(encoded); size[-4]^=1
        for value in (encoded[:-1],encoded[:-8],encoded[:len(encoded)//2],bytes(crc),bytes(size),self.raw):
            with self.assertRaises(m.Refusal): self.validate(compressed=value)

    def test_extra_member_compressed_suffix_or_nonzero_tar_suffix_refuse(self):
        encoded=gzip.compress(self.raw,mtime=0)
        for value in (encoded+gzip.compress(b'',mtime=0),encoded+b'\0',encoded+b'foreign bytes'):
            with self.assertRaises(m.Refusal): self.validate(compressed=value)
        for raw in (self.raw[:self.body_end+1024]+b'foreign'+b'\0'*505,self.raw[:self.body_end]+b'\0'*(512*21)):
            with self.assertRaises(m.Refusal): self.validate(raw)

    def test_streaming_large_file_and_inflation_and_compressed_bounds(self):
        content={'_app/large.js':b'bounded output\n'*180000}; raw=tar_bytes(content)
        expected={p:{'path':p,'size':len(b),'sha256':hashlib.sha256(b).hexdigest()} for p,b in content.items()}
        self.assertEqual(self.validate(raw,expected=expected)['uncompressedBytes'],len(raw))
        with self.assertRaises(m.Refusal): self.validate(raw,expected=expected,maximum=len(raw)-1)
        encoded=gzip.compress(self.raw,mtime=0)
        with self.assertRaises(m.Refusal): self.validate(compressed=encoded,maximum=len(encoded)-1)
        with self.assertRaises(m.Refusal): self.validate(compressed=gzip.compress(b'\0'*200000,mtime=0))

    def test_checksum_content_padding_and_extended_header_changes_refuse(self):
        malformed=bytearray(self.raw); malformed[0]^=1
        content=bytearray(self.raw); content[512]^=1
        padding=bytearray(self.raw); padding[512+len(self.content['_app/one.js'])]=1
        for value in (bytes(malformed),bytes(content),bytes(padding)):
            with self.assertRaises(m.Refusal): self.validate(value)
        raw=io.BytesIO()
        with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as tar:
            info=tarfile.TarInfo('_app/one.js'); info.size=len(self.content['_app/one.js']); info.mode=0o644; info.pax_headers={'comment':'unreviewed'}
            tar.addfile(info,io.BytesIO(self.content['_app/one.js']))
        with self.assertRaises(m.Refusal): self.validate(raw.getvalue())


class RootReader(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.base=Path(self.tmp.name).resolve()
        self.root=self.base/'overlay'; self.root.mkdir()
        self.kube=self.base/'offline-kube.py'
        self.kube.write_text('import json,sys\nx=json.loads(sys.argv[1]);a=sys.argv[2:];print(json.dumps(x[a[a.index("get")+1]]))\n')
        self.resources={'namespace':{'metadata':{'uid':'cluster-uid'}},'node':{'metadata':{'name':'node','uid':'node-uid'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}}
        self.config={'version':1,'kubectl':[],'clusterUID':'cluster-uid','node':{'name':'node','uid':'node-uid'},
                     'claim':{'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':{'name':'shell','namespace':'public','uid':'claim-uid','resourceVersion':'3'},'spec':{'volumeName':'pv'},'status':{'phase':'Bound'}},
                     'pv':{'apiVersion':'v1','kind':'PersistentVolume','metadata':{'name':'pv','uid':'pv-uid','resourceVersion':'4'},'spec':{'local':{'path':str(self.root)}},'status':{'phase':'Bound'}},
                     'storageClass':{'apiVersion':'storage.k8s.io/v1','kind':'StorageClass','metadata':{'name':'local-path','uid':'class-uid','resourceVersion':'5'},'provisioner':'rancher.io/local-path'}}
        for field in ('claim','pv','storageClass'): self.resources[self.config[field]['kind']]=copy.deepcopy(self.config[field])

    def run_reader(self):
        x=copy.deepcopy(self.config); x['kubectl']=[sys.executable,str(self.kube),json.dumps(self.resources)]
        return subprocess.run([sys.executable,'-B','-c',m.ROOT_METADATA_SCRIPT,m.cohort.canonical(x).decode()],capture_output=True)

    def test_actual_reader_observes_existing_root_without_permissions_or_contents_changes(self):
        self.root.chmod(0o2750); before=self.root.stat(); result=self.run_reader(); self.assertEqual(result.returncode,0,result.stderr.decode())
        value=json.loads(result.stdout); self.assertEqual(value['root']['mode'],0o2750); self.assertEqual(value['root']['gid'],before.st_gid)
        self.assertEqual(value['root']['inode'],before.st_ino); self.assertEqual([v['path'] for v in value['ancestors']],[str(p) for p in reversed(self.root.parents)])
        self.assertEqual(self.root.stat(),before); self.assertEqual(list(self.root.iterdir()),[])

    def test_actual_reader_refuses_symlink_leaf_and_ancestor(self):
        other=self.base/'actual'; other.mkdir(); self.root.rmdir(); self.root.symlink_to(other,target_is_directory=True)
        self.assertNotEqual(self.run_reader().returncode,0)
        self.root.unlink(); parent=self.base/'link'; parent.symlink_to(other,target_is_directory=True); child=other/'nested'; child.mkdir()
        self.config['pv']['spec']['local']['path']=str(parent/'nested'); self.resources['PersistentVolume']['spec']=copy.deepcopy(self.config['pv']['spec'])
        self.assertNotEqual(self.run_reader().returncode,0)

    def test_actual_reader_refuses_replaced_or_changed_bound_api_resources(self):
        for field,key,value in (('PersistentVolume','uid','replacement'),('PersistentVolumeClaim','deletionTimestamp','now')):
            old=copy.deepcopy(self.resources); self.resources[field]['metadata'][key]=value
            self.assertNotEqual(self.run_reader().returncode,0); self.resources=old
        self.resources['PersistentVolume']['spec']['local']['path']=str(self.base)
        self.assertNotEqual(self.run_reader().returncode,0)


class PublicFixture(fixture.Public):
    for _name in dir(fixture.Public):
        if _name.startswith('test_'): locals()[_name] = None

    def setUp(self):
        super().setUp()
        pv = json.loads((self.base/self.previous['modelsPV']['path']).read_bytes())
        pv['spec'].update(accessModes=['ReadWriteOnce'],storageClassName='local-path',volumeMode='Filesystem',nodeAffinity={'required':{'nodeSelectorTerms':[{'matchExpressions':[{'key':'kubernetes.io/hostname','operator':'In','values':['fixture-node']}]}]}})
        self.previous['modelsPV'] = self.file('synthetic-complete-models-pv',pv)
        prepared = json.loads((self.base/self.previous['originalEvidence'][1]['path']).read_bytes()); prepared['modelsPV'] = pv
        self.previous['originalEvidence'][1] = self.file('synthetic-complete-image-plan',prepared)
        owner = actual_pod({'apiVersion':'v1','kind':'Pod','metadata':{'name':'fixture-owner','namespace':'public','labels':{'app':'public'}},'spec':{**copy.deepcopy(self.before['spec']['template']['spec']),'nodeName':'fixture-node'}},'actual-fixture-pod')
        # Genuine public647's template omits this field; its admitted owner has
        # true. Keep that real shape in this explicitly synthetic fixture.
        owner['spec']['enableServiceLinks'] = True
        owner['metadata']['ownerReferences'] = [{'apiVersion':'apps/v1','kind':'ReplicaSet','name':'fixture-rs','uid':'fixture-rs-uid','controller':True}]
        replica = {'apiVersion':'apps/v1','kind':'ReplicaSet','metadata':{'name':'fixture-rs','namespace':'public','uid':'fixture-rs-uid','resourceVersion':'9','ownerReferences':[{'apiVersion':'apps/v1','kind':'Deployment','name':'web','uid':'web-uid','controller':True}]},'spec':{'template':self.before['spec']['template']}}
        accepted = json.loads((self.base/self.previous['originalEvidence'][0]['path']).read_bytes())
        accepted['preparedSha256'] = self.previous['originalEvidence'][1]['sha256']; accepted['runtime']['podSpecSha256'] = m.cohort.digest(owner['spec'])
        self.previous['originalEvidence'][0] = self.file('synthetic-complete-acceptance',accepted); self.refresh_previous()
        self.producer['previousAcceptance'] = self.previous['originalEvidence'][0]
        custody = json.loads((self.base/self.producer['custody']['path']).read_bytes()); custody['previousAcceptance'] = self.producer['previousAcceptance']
        self.producer['custody'] = self.file('synthetic-complete-producer-custody',custody); self.refresh_producer()
        self.result,self.inputs = self.prepare()
        evidence_ref = self.file('reviewed-synthetic-public-evidence',self.evidence); evidence_ref['path'] = str(self.base/evidence_ref['path'])
        self.result['reviewedEvidenceSha256'] = evidence_ref['sha256']; self.result['evidence'].append(evidence_ref); self.result['evidence'].sort(key=lambda r:r['path'])
        self.prepared_ref = self.file('synthetic-maintained-public-plan',self.result)
        components = {}; deployments = []
        for name in sorted(m.updater.COMPONENTS):
            if name == 'public-web': d = copy.deepcopy(self.before); ns = 'public'; container = 'web'
            else:
                ns = 'other'; container = 'adapter' if name == 'admission-rest' else 'server'; deployment = 'admission-adapter' if name == 'admission-rest' else name
                labels = m.updater.ADMISSION_LABELS if name == 'admission-rest' else {}
                d = {'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':deployment,'namespace':ns,'uid':name+'-uid','resourceVersion':'1','labels':labels},'spec':{'replicas':1,'template':{'metadata':{'labels':labels},'spec':{'containers':[{'name':container,'image':self.previous['image']}]}}}}
            deployments.append(d)
            components[name] = {'namespace':ns,'namespaceUID':ns+'-uid','deployment':d['metadata']['name'],'deploymentUID':d['metadata']['uid'],'images':[{'kind':'container','name':container}],**({'requiredLabels':m.updater.ADMISSION_LABELS} if name == 'admission-rest' else {})}
        components['public-web']['healthURLs'] = ['https://public.example/health']
        self.target = {'version':2,'clusterUID':'fixture-cluster','node':{'name':'fixture-node','uid':'fixture-node-uid'},'transport':{'type':'local','kubectl':['/never-kubectl-offline-fixture'],'kubeconfig':'/never-read-offline-fixture','context':'fixture'},'components':components}
        claim = json.loads((self.base/self.previous['modelsClaim']['path']).read_bytes())
        self.baseline = {'version':1,'deployments':deployments,'claims':collection('PersistentVolumeClaim',[claim]),'pvs':collection('PersistentVolume',[pv]),'pods':collection('Pod',[owner]),'owner':owner,'replicaSet':replica,
                         'storageClass':{'apiVersion':'storage.k8s.io/v1','kind':'StorageClass','metadata':{'name':'local-path','uid':'class-uid','resourceVersion':'1'},'provisioner':'rancher.io/local-path','volumeBindingMode':'WaitForFirstConsumer'}}
        for filename in ('fixture-preflight.py','fixture-host-probe.py'):
            (self.base/filename).write_bytes(b'raise SystemExit("OFFLINE fixture must never contact a target")\n'); (self.base/filename).chmod(0o600)
        preflight,host = ref(self.base/'fixture-preflight.py'),ref(self.base/'fixture-host-probe.py')
        self.stage_value = {'version':1,'target':self.file('synthetic-target',self.target),'prepared':self.prepared_ref,'planningEvidence':evidence_ref,'baseline':self.file('synthetic-complete-baseline',self.baseline),'publicKey':self.pin,
                            'preflight':preflight,'hostProbe':host,'names':{'writer':'public-writer','qualifier':'public-qualifier','policy':'public-stage'},'storage':{'storageClassName':'local-path','bytes':1024**3},
                            'minimumFreeBytes':8*1024**3,'maximumWriteBytes':64*1024**2,'outputDirectory':str(self.base/'stage-output'),'node':NODE,
                            'sourceFiles':[ref(HERE/'scripts'/n) for n in sorted(m.SOURCE_NAMES)]}
        self.stage_ref = self.file('reviewed-synthetic-stage-input',self.stage_value); self.stage_ref['path'] = str(self.base/self.stage_ref['path'])

    def stage(self): return m.Stage(self.stage_ref['path'],self.stage_ref['sha256'],m.checksum(HERE/'scripts/stage-public-shell.py'))


class Boundaries(PublicFixture):
    # Inherited planner cases are intentionally disabled here; their maintained
    # suite runs separately. This class owns the staging-specific boundaries.
    for _name in dir(fixture.Public):
        if _name.startswith('test_'): locals()[_name] = None

    def test_actual_offline_check_cli_recomputes_public_contract_without_target(self):
        args = [sys.executable,'-B',*(['-O'] if sys.flags.optimize else []),str(HERE/'scripts/stage-public-shell.py'),'check','--inputs',self.stage_ref['path'],'--sha256',self.stage_ref['sha256'],'--operator-sha256',m.checksum(HERE/'scripts/stage-public-shell.py')]
        result = subprocess.run(args,capture_output=True); self.assertEqual(result.returncode,0,result.stderr.decode())
        self.assertFalse(json.loads(result.stdout)['productionMutation']); self.assertFalse((self.base/'stage-output').exists())

    def test_models_active_shell_secrets_and_extra_mounts_never_enter_stage(self):
        s = self.stage()
        for role in ('writer','qualifier'):
            p = s.desired[role]; m.validate_public_pod(actual_pod(p,role+'-uid'),p,True)
            claims = [v['persistentVolumeClaim']['claimName'] for v in p['spec']['volumes'] if 'persistentVolumeClaim' in v]
            self.assertEqual(claims,['new-public-shell']); self.assertNotIn('env',p['spec']['containers'][0]); self.assertFalse(p['spec']['automountServiceAccountToken'])
        mounts = s.desired['qualifier']['spec']['containers'][0]['volumeMounts']
        self.assertEqual([v['subPath'] for v in mounts if 'subPath' in v and v['name']=='public-shell'],list(m.public.PATHS))
        for change in (lambda p:p['spec']['volumes'][0]['persistentVolumeClaim'].update(claimName='models'),lambda p:p['spec'].update(hostNetwork=True),lambda p:p['spec']['containers'][0].update(envFrom=[{'secretRef':{'name':'private'}}]),lambda p:p['spec']['containers'][0]['volumeMounts'][1].update(readOnly=False)):
            bad = actual_pod(s.desired['qualifier'],'bad'); change(bad)
            with self.assertRaises(REFUSALS): m.validate_public_pod(bad,s.desired['qualifier'],True)

    def test_qualifier_has_managed_source_whole_anchor_and_exact_readonly_mounts(self):
        s=self.stage(); selected=s.prepared['selection']; original=copy.deepcopy(s.desired)
        writer=s.desired['writer']; qualifier=s.desired['qualifier']
        self.assertEqual(writer['spec']['volumes'][0]['persistentVolumeClaim'],{'claimName':selected['shellClaim']})
        self.assertEqual(qualifier['spec']['volumes'][0]['persistentVolumeClaim'],{'claimName':selected['shellClaim']})
        self.assertEqual(qualifier['spec']['securityContext']['fsGroupChangePolicy'],'OnRootMismatch')
        self.assertNotIn('fsGroupChangePolicy',writer['spec']['securityContext'])
        writer_mount=next(mt for mt in writer['spec']['containers'][0]['volumeMounts'] if mt['name']==selected['shellVolume'])
        self.assertFalse(writer_mount.get('readOnly',False))
        qualifier_mounts=[mt for mt in qualifier['spec']['containers'][0]['volumeMounts'] if mt['name']==selected['shellVolume']]
        self.assertEqual(qualifier_mounts,m.public.overlay_mounts(selected['shellVolume']))
        self.assertEqual(qualifier_mounts[0],{'name':selected['shellVolume'],'mountPath':m.public.OVERLAY_ANCHOR,'readOnly':True})
        self.assertEqual(len(qualifier_mounts),6); self.assertTrue(all(mt['readOnly'] is True for mt in qualifier_mounts))
        self.assertEqual(s.desired,original)
        for dry_run in (False,True):
            actual=actual_pod(qualifier,'qualifier-uid')
            if dry_run:
                del actual['metadata']['uid']; del actual['metadata']['resourceVersion']
            held=copy.deepcopy(actual); self.assertIs(m.validate_public_create(actual,qualifier,dry_run),actual); self.assertEqual(actual,held)
            for change in (lambda v:v['spec']['volumes'][0]['persistentVolumeClaim'].update(readOnly=True),
                           lambda v:v['spec']['securityContext'].update(fsGroupChangePolicy='Always'),
                           lambda v:v['spec']['containers'][0]['volumeMounts'].__delitem__(1),
                           lambda v:v['spec']['containers'][0]['volumeMounts'][1].update(readOnly=False)):
                bad=copy.deepcopy(actual)
                change(bad)
                with self.assertRaises(REFUSALS): m.validate_public_create(bad,qualifier,dry_run)

    def test_qualifier_admission_refuses_unmanaged_source_before_live_create(self):
        s=self.stage(); s.out.mkdir(); calls=[]; want=s.desired['qualifier']
        s.absent=lambda *args:True; s.verify_bindings=lambda:calls.append('bindings'); s.preflight=lambda:calls.append('preflight')
        def remote(argv,data=None):
            calls.append(argv); checked=actual_pod(want,'dry-run-uid'); del checked['metadata']['uid']; del checked['metadata']['resourceVersion']
            checked['spec']['volumes'][0]['persistentVolumeClaim']['readOnly']=True
            return m.cohort.canonical(checked)
        s.remote=remote
        with self.assertRaises(REFUSALS): s.admitted_pod(want)
        self.assertEqual(calls[:2],['bindings','preflight']); self.assertEqual(len(calls),3)
        self.assertIn('--dry-run=server',calls[-1]); self.assertFalse((s.out/('dry-run-'+want['metadata']['name']+'.reviewed.json')).exists())

    def test_qualifier_owned_readback_requires_managed_source_and_original_uid(self):
        s=self.stage(); actual=actual_pod(s.desired['qualifier'],'qualifier-uid'); s.identities=lambda:{'qualifier':copy.deepcopy(actual)}
        s.get=lambda *args:copy.deepcopy(actual); self.assertEqual(s.owned('qualifier'),actual)
        for change in (lambda p:p['spec']['volumes'][0]['persistentVolumeClaim'].update(readOnly=True),lambda p:p['metadata'].update(uid='replacement')):
            bad=copy.deepcopy(actual); change(bad); s.get=lambda *args:bad
            with self.assertRaises(REFUSALS): s.owned('qualifier')

    def test_generic_full_collections_refuse_partial_wrong_scope_duplicate_uid_and_missing_rv(self):
        rows = self.baseline['claims']; m.complete_list(rows,'PersistentVolumeClaim','*')
        for change in (lambda v:v['metadata'].update(continue_='x',**{'continue':'x'}),lambda v:v['metadata'].update(remainingItemCount=True),lambda v:v['metadata'].update(remainingItemCount=1),
                       lambda v:v['items'].append(copy.deepcopy(v['items'][0])),lambda v:v['items'][0]['metadata'].update(resourceVersion=''),lambda v:v['items'][0].update(kind='Secret')):
            bad = copy.deepcopy(rows); change(bad)
            with self.assertRaises(m.Refusal): m.complete_list(bad,'PersistentVolumeClaim','*')

    def test_global_dormant_backing_alias_is_refused_before_any_pod(self):
        s = self.stage(); pv = copy.deepcopy(self.baseline['pvs']['items'][0]); claim = copy.deepcopy(self.baseline['claims']['items'][0])
        claim['metadata'].update(name='new-public-shell',uid='new-uid'); claim['spec']['volumeName']='new-pv'
        pv['metadata'].update(name='new-pv',uid='new-pv-uid'); pv['spec']['claimRef'].update(name='new-public-shell',uid='new-uid')
        with self.assertRaises(m.Refusal): m.isolated_backing(claim,collection('PersistentVolume',[*self.baseline['pvs']['items'],pv]),'public')
        pv['spec']['local']['path']='/isolated-new'; m.isolated_backing(claim,collection('PersistentVolume',[*self.baseline['pvs']['items'],pv]),'public')

    def test_stage_names_are_distinct_and_public_owner_managed_source_is_exact(self):
        s=self.stage(); names={**s.value['names'],'writer':s.value['names']['qualifier']}
        with self.assertRaises(m.Refusal): m.make_resources(s.prepared,s.accepted_deployment,s.target,names,s.value['storage'])
        want={'apiVersion':'v1','kind':'Pod','metadata':{'name':'next-owner','namespace':'public','labels':{'app':'public'}},
              'spec':{**copy.deepcopy(s.prepared['desiredSpec']['template']['spec']),'nodeName':'fixture-node'}}
        actual=actual_pod(want,'next-owner-uid'); original=copy.deepcopy(actual)
        m.validate_public_pod(actual,want,True); self.assertEqual(actual,original)
        index=next(i for i,v in enumerate(want['spec']['volumes']) if v['name']==s.prepared['selection']['shellVolume'])
        for value in (True,'false'):
            bad=copy.deepcopy(actual)
            bad['spec']['volumes'][index]['persistentVolumeClaim']['readOnly']=value
            with self.assertRaises(REFUSALS): m.validate_public_pod(bad,want,True)

    def test_local_root_metadata_refuses_missing_group_bits_alias_and_changed_identity(self):
        claim=self.baseline['claims']['items'][0]; pv=self.baseline['pvs']['items'][0]
        value=root_proof(self.target,claim,pv); self.assertIs(m.validate_root_metadata(value,self.target,claim,pv),value)
        for change in (lambda v:v['root'].update(gid=1000),lambda v:v['root'].update(mode=0o2750),lambda v:v['root'].update(mode=0o770),
                       lambda v:v['root'].update(mode=True),lambda v:v['root'].update(path='/wrong-root'),lambda v:v.update(pvUID='replacement'),
                       lambda v:v['ancestors'].clear(),lambda v:v.update(productionMutation=True),lambda v:v.update(extra='unreviewed')):
            bad=copy.deepcopy(value); change(bad)
            with self.assertRaises(m.Refusal): m.validate_root_metadata(bad,self.target,claim,pv)
        relabeled=copy.deepcopy(value); relabeled['root']['selinuxLabel']='system_u:object_r:container_file_t:s0:c3,c4'; m.same_root(value,relabeled)
        for key in ('mode','gid','device','inode'):
            bad=copy.deepcopy(relabeled); bad['root'][key]+=1
            with self.assertRaises(m.Refusal): m.same_root(value,bad)

    def test_root_reader_preserves_transport_exact_local_plugin_and_original_raw_output(self):
        s=self.stage(); s.out.mkdir(); claim=self.baseline['claims']['items'][0]; pv=self.baseline['pvs']['items'][0]; calls=[]
        s.get=lambda kind,*args:copy.deepcopy(claim if kind=='pvc' else self.baseline['storageClass'])
        value=root_proof(self.target,claim,pv)
        s.events=[{'path':'synthetic-command-link','sha256':'a'*64}]
        s.run=lambda argv,**kw:(calls.append(argv) or m.cohort.canonical(value))
        record=s.root_metadata(models=True); self.assertEqual(json.loads(Path(record['path']).read_bytes()),{'metadata':value,'originalCommand':s.events[0]})
        command=calls[0]; self.assertEqual(command[:3],['python3','-c',m.ROOT_METADATA_SCRIPT])
        expected=json.loads(command[3]); self.assertEqual(expected['pv'],pv); self.assertEqual(expected['claim'],claim)
        self.assertEqual(expected['kubectl'],['/never-kubectl-offline-fixture','--kubeconfig','/never-read-offline-fixture','--context','fixture'])
        s.baseline['storageClass']['provisioner']='unreviewed.csi'
        with self.assertRaises(m.Refusal): s.root_metadata(models=True)
        self.assertEqual(len(calls),1)

    def test_allocation_preflight_immediately_precedes_uid_rv_spec_patch_and_global_alias_refuses(self):
        s=self.stage(); s.out.mkdir(); calls=[]
        pending=copy.deepcopy(s.desired['shellClaim']); pending['metadata'].update(uid='new-claim-uid',resourceVersion='19'); pending['status']={'phase':'Pending'}
        bound=copy.deepcopy(pending); bound['spec']['volumeName']='new-pv'; bound['status']={'phase':'Bound'}
        pv=copy.deepcopy(self.baseline['pvs']['items'][0]); pv['metadata'].update(name='new-pv',uid='new-pv-uid'); pv['spec']['claimRef'].update(name='new-public-shell',uid='new-claim-uid')
        ids={'shellClaim':pending}; s.identities=lambda:ids
        gets=iter([pending,bound]); s.get=lambda kind,*args:next(gets) if kind=='pvc' else collection('PersistentVolume',[*self.baseline['pvs']['items'],pv])
        s.preflight=lambda *_:calls.append('preflight')
        def remote(argv,data=None,timeout=None):
            calls.append(argv)
            if argv[0]=='patch':
                patch_=json.loads(argv[argv.index('--patch')+1]); self.assertEqual(patch_[:3],[{'op':'test','path':'/metadata/uid','value':'new-claim-uid'},{'op':'test','path':'/metadata/resourceVersion','value':'19'},{'op':'test','path':'/spec','value':pending['spec']}])
                result=copy.deepcopy(pending); result['metadata']['annotations']={'volume.kubernetes.io/selected-node':'fixture-node'}; return m.cohort.canonical(result)
            return b''
        s.remote=remote
        with self.assertRaises(m.Refusal): s.allocate_claims()
        self.assertEqual(calls[0],'preflight'); self.assertEqual([v[0] for v in calls if isinstance(v,list)],['patch','wait'])
        self.assertTrue((s.out/'allocation.original.json').exists()); self.assertFalse((s.out/'claims.bound.actual.json').exists())

    def test_owner_overlay_archive_exact_bytes_and_all_link_escape_duplicate_missing_refuse(self):
        s = self.stage(); path = self.base/'archive.tar.gz'
        def archive(change=None):
            with tarfile.open(path,'w:gz',format=tarfile.USTAR_FORMAT) as tar:
                for i,(p,row) in enumerate(s.old_overlay.items()):
                    info=tarfile.TarInfo(p); info.size=row['size']; info.mode=0o644
                    if change and i == 0: change(info)
                    tar.addfile(info,io.BytesIO((s.old.root/p).read_bytes()) if info.isfile() else None)
        archive(); m.validate_archive(path,s.old_overlay)
        for change in (lambda i:setattr(i,'name','../outside'),lambda i:setattr(i,'type',tarfile.SYMTYPE),lambda i:setattr(i,'type',tarfile.LNKTYPE),lambda i:setattr(i,'name','catalog/tools/index.json')):
            archive(change)
            with self.assertRaises((m.Refusal,KeyError)): m.validate_archive(path,s.old_overlay)
        archive()
        with self.assertRaises(m.Refusal): m.validate_archive(path,{**s.old_overlay,'_app/missing.js':{'path':'_app/missing.js','size':0,'sha256':'a'*64}})

    def test_owner_snapshot_compresses_before_transport_and_keeps_truncation_originals(self):
        s=self.stage(); s.out.mkdir(); calls=[]
        raw=tar_bytes({p:(s.old.root/p).read_bytes() for p in s.old_overlay}); compressed=gzip.compress(raw,mtime=0)
        s.transport=lambda argv:argv
        def produce(argv,stdout,stderr):
            calls.append(argv); stdout.write(compressed); stderr.write(b'original diagnostic\n')
            child=type('Completed',(),{'returncode':0,'poll':lambda _:0})(); return child
        with patch.object(m.subprocess,'Popen',produce),patch.object(m.shutil,'disk_usage',return_value=type('Usage',(),{'free':32*1024**3})()):
            path,receipt=s.snapshot()
        self.assertEqual(path.read_bytes(),compressed); self.assertIn('-czf',calls[0]); self.assertNotIn('-cf',calls[0])
        self.assertEqual(calls[0][-len(m.public.PATHS):],list(m.public.PATHS)); self.assertEqual(path.stat().st_mode&0o777,0o600)
        command=json.loads(Path(receipt['path']).read_bytes()); self.assertEqual(command['argv'],calls[0]); self.assertEqual(command['encoding'],'gzip')
        self.assertTrue((s.out/'snapshot.archive-verified.actual.json').exists())
        s.out=self.base/'truncated-output'; s.out.mkdir(); compressed=compressed[:-8]
        with patch.object(m.subprocess,'Popen',produce),patch.object(m.shutil,'disk_usage',return_value=type('Usage',(),{'free':32*1024**3})()):
            with self.assertRaises(m.Refusal): s.snapshot()
        self.assertEqual((s.out/'owning-overlay.original.tar.gz').read_bytes(),compressed)
        self.assertEqual(json.loads((s.out/'snapshot.command.actual.json').read_bytes())['exitCode'],0)
        self.assertFalse((s.out/'snapshot.archive-verified.actual.json').exists())

    def test_writer_extracts_gzip_snapshot_only_after_fresh_final_preflight(self):
        s=self.stage(); s.out.mkdir(); calls=[]; writer=actual_pod(s.desired['writer'],'writer-uid')
        s.prior=lambda _:None; s.owned=lambda _:writer; s.fresh=lambda _:calls.append('fresh')
        s.full_tree=lambda *args,**kwargs:({},{}); s.verify_bindings=lambda:calls.append('bindings')
        s.preflight=lambda _:calls.append('preflight')
        path=self.base/'copy-fixture.tar.gz'; path.write_bytes(gzip.compress(tar_bytes({p:(s.old.root/p).read_bytes() for p in s.old_overlay}),mtime=0))
        s.snapshot=lambda:(path,ref(path))
        def remote(argv,data=None,timeout=None):
            self.assertEqual(calls[-1],'preflight'); calls.append(argv)
            if len([v for v in calls if isinstance(v,list)])==1:
                self.assertEqual(data,path.read_bytes()); self.assertIn('-xzf',argv)
            else: self.assertIn('-xf',argv)
            return b''
        s.remote=remote; s.copy()
        self.assertEqual(len([v for v in calls if isinstance(v,list)]),2)

    def test_truncated_copy_never_writes_and_retains_exclusive_failed_intent(self):
        s=self.stage(); s.out.mkdir(); writer=actual_pod(s.desired['writer'],'writer-uid'); calls=[]
        s.prior=lambda _:None; s.owned=lambda _:writer; s.fresh=lambda _:None; s.full_tree=lambda *args,**kwargs:({},{}); s.transport=lambda argv:argv
        compressed=gzip.compress(tar_bytes({p:(s.old.root/p).read_bytes() for p in s.old_overlay}),mtime=0)[:-8]
        def produce(argv,stdout,stderr):
            calls.append(argv); stdout.write(compressed); return type('Completed',(),{'returncode':0,'poll':lambda _:0})()
        s.remote=lambda *args,**kwargs:self.fail('No writer extraction after refused snapshot')
        with patch.object(m.subprocess,'Popen',produce),patch.object(m.shutil,'disk_usage',return_value=type('Usage',(),{'free':32*1024**3})()):
            with self.assertRaises(m.Refusal): s.copy()
            with self.assertRaises(FileExistsError): s.copy()
        self.assertEqual(len(calls),1); self.assertTrue((s.out/'copy.started.json').exists()); self.assertTrue((s.out/'copy.uncertain.json').exists())
        self.assertFalse((s.out/'copy.actual.json').exists()); self.assertTrue((s.out/'snapshot.command.actual.json').exists())
        self.assertEqual((s.out/'owning-overlay.original.tar.gz').read_bytes(),compressed)

    def test_actual_inventory_exact_sizes_hashes_modes_and_model_exclusion(self):
        s=self.stage(); raw=''.join(f"{r['size']} 644 10 0\t{r['sha256']}  ./{p}\t./{p}\n" for p,r in reversed(list(s.effective.files.items()))).encode()
        actual=m.inventory(raw,s.effective.files); self.assertEqual(len(actual['files']),len(s.effective.files))
        for bad in (raw+raw.splitlines(keepends=True)[0],raw.replace(b' 644 ',b' 664 ',1),raw.replace(b' 644 ',b' 775 ',1),raw.replace(b' 644 ',b' 777 ',1),raw.replace(b'\t',b' ',1),raw.replace(b'  ./index.html',b'  ./models/model.onnx',1)):
            with self.assertRaises(m.Refusal): m.inventory(bad,s.effective.files)

    def test_actual_catalog_crypto_refuses_modified_signature_or_actual_signed_map(self):
        s=self.stage(); index=s.effective.data('catalog/tools/index.json'); envelope=s.effective.data('catalog/tools/index.sig.json')
        m.catalog_bytes(index,envelope,s.public_key,s.prepared['catalog'],s.effective.files,NODE)
        bad=json.loads(envelope); bad['signature']='A'*86; encoded=m.cohort.canonical(bad)
        expected={**s.prepared['catalog'],'envelopeSha256':hashlib.sha256(encoded).hexdigest()}
        with self.assertRaises(m.Refusal): m.catalog_bytes(index,encoded,s.public_key,expected,s.effective.files,NODE)
        files=copy.deepcopy(s.effective.files); files['tools/public-fixture/tool.json']['sha256']='0'*64
        with self.assertRaises(m.Refusal): m.catalog_bytes(index,envelope,s.public_key,s.prepared['catalog'],files,NODE)

    def test_new_claim_admission_refuses_active_storage_before_actual_create(self):
        s=self.stage(); s.out.mkdir(); calls=[]; s.absent=lambda *_:True; s.verify_bindings=lambda:calls.append('backings'); s.preflight=lambda *_:calls.append('preflight')
        def remote(args,data=None,timeout=None):
            calls.append(args); desired=json.loads(data); desired['spec']['volumes'][0]['persistentVolumeClaim']['claimName']='models'; return m.cohort.canonical(desired)
        s.remote=remote
        with self.assertRaises(m.private.Refusal): s.admitted_pod(s.desired['qualifier'])
        self.assertEqual(len([c for c in calls if isinstance(c,list)]),1); self.assertEqual(calls[-2],'preflight')

    def test_ambiguous_phase_keeps_original_outputs_and_cannot_replay(self):
        s=self.stage(); s.out.mkdir(); calls=[]
        def body(): calls.append(1); s.run([sys.executable,'-c','import sys;print("original stdout");print("original stderr",file=sys.stderr);sys.exit(7)'])
        with self.assertRaises(m.private.Refusal): s.phase('copy',body)
        with self.assertRaises(OSError): s.phase('copy',body)
        self.assertEqual(calls,[1]); self.assertTrue((s.out/'copy.uncertain.json').exists())
        receipt=json.loads(next(s.out.glob('command-*.json')).read_text()); self.assertEqual(receipt['exitCode'],7)
        self.assertEqual(Path(receipt['originals']['stdout']['path']).read_text(),'original stdout\n')

    def test_source_envelope_drift_after_check_refuses(self):
        s=self.stage(); p=Path(self.stage_ref['path']); p.write_text(p.read_text()+' ')
        with self.assertRaises(m.Refusal): s.source_check()


if __name__ == '__main__': unittest.main()
