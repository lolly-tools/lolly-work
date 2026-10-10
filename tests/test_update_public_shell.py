#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Real offline CLI/contracts with synthetic API/runtime and test-only P-256 keys.

No fixture authenticates provider origins, qualifies Nginx or executes a target.
Only the literal read-only transport and phase orchestration use stubs.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


f = load('public_update_fixture',Path(__file__).with_name('test_publish_public_shell.py'))
m = load('public_update_test',HERE/'scripts/update-public-shell.py')
SCRIPT = HERE/'scripts/update-public-shell.py'
NODE = os.environ.get('LOLLY_TEST_NODE','node')
REFUSALS = (m.Refusal,m.stage.private.Refusal,m.updater.Refusal,m.stage.resources.Refusal)


class Update(f.PublicationFixture):
    for _name in dir(f.PublicationFixture):
        if _name.startswith('test_'): locals()[_name] = None

    def setUp(self):
        super().setUp()
        self.profile = {'version':1,'status':'REVIEWED_PUBLIC_SHELL_UPDATE_PROFILE','name':'synthetic-public',
                        'target':self.stage_value['target'],'previous':self.evidence['previous'],'publicKey':self.pin,
                        'preflight':self.stage_value['preflight'],'hostProbe':self.stage_value['hostProbe'],
                        'storage':self.stage_value['storage'],'minimumFreeBytes':self.stage_value['minimumFreeBytes'],
                        'maximumWriteBytes':self.stage_value['maximumWriteBytes'],'stageNamePrefix':'fixture',
                        'selection':{k:self.selection[k] for k in ('container','shellVolume')},
                        'probePolicy':{'paths':sorted(['index.html','catalog/tools/index.json','catalog/tools/index.sig.json']),'lazyChunks':1,'allOrigins':True},
                        'sourceFiles':[m.file_ref(HERE/'scripts'/n) for n in sorted(m.DEPENDENCIES)]+[self.stage_value[k] for k in ('preflight','hostProbe')]}
        self.profile_ref = self.absolute(self.file('synthetic-update-profile',self.profile)); self.prepared_ref = self.absolute(self.prepared_ref)
        self.capture_ref = self.capture_fixture(False)

    def absolute(self, ref):
        return {**ref,'path':str(self.base/ref['path'])}

    def operation(self):
        return m.Update(self.profile_ref['path'],self.profile_ref['sha256'],self.prepared_ref['path'],self.prepared_ref['sha256'],m.file_ref(SCRIPT)['sha256'],NODE)

    def capture_fixture(self, after):
        deployments = copy.deepcopy(self.baseline['deployments'])
        for d in deployments:
            d['metadata']['generation'] = 1
            d['status'] = {'readyReplicas':1,'updatedReplicas':1,'availableReplicas':1,'observedGeneration':1}
        meta = lambda n,u: {'apiVersion':'v1','kind':'Namespace','metadata':{'name':n,'uid':u,'resourceVersion':'1'}}
        collection = f.f.collection
        ns = sorted({c['namespace'] for c in self.target['components'].values()})
        policies = json.loads((self.base/self.previous['policyInventory']['path']).read_bytes())
        services = json.loads((self.base/self.previous['serviceInventory']['path']).read_bytes())
        def rows(values, kind, api):
            return [{'apiVersion':api,'kind':kind,'metadata':{'name':n,'namespace':'public','uid':r['uid'],'resourceVersion':'2'},'spec':r['spec']} for n,r in values.items()]
        x = {'version':1,'status':'READ_ONLY_PUBLIC_SHELL_RESOURCES_CAPTURED','targetSha256':self.profile['target']['sha256'],
             'systemNamespace':self.file('synthetic-system',meta('kube-system','fixture-cluster')),
             'node':self.file('synthetic-node',{'apiVersion':'v1','kind':'Node','metadata':{'name':'fixture-node','uid':'fixture-node-uid','resourceVersion':'2'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}),
             'namespaces':{n:self.file('synthetic-namespace',meta(n,n+'-uid')) for n in ns},
             'deployments':{n:self.file('synthetic-deployments',collection('Deployment',[d for d in deployments if d['metadata']['namespace']==n])) for n in ns},
             'pods':self.file('synthetic-pods',self.baseline['pods']),
             'claims':self.file('synthetic-global-pvc',collection('PersistentVolumeClaim',self.baseline['claims']['items']+([self.claim] if after else []))),
             'volumes':self.file('synthetic-global-pv',collection('PersistentVolume',self.baseline['pvs']['items']+([self.pv] if after else []))),
             'storageClass':self.file('synthetic-class',self.baseline['storageClass']),'replicaSet':self.file('synthetic-rs',self.baseline['replicaSet']),
             'nginxConfig':self.previous['nginxConfig'],
             'policies':self.file('synthetic-policies',collection('NetworkPolicy',rows(policies,'NetworkPolicy','networking.k8s.io/v1'))),
             'services':self.file('synthetic-services',collection('Service',rows(services,'Service','v1')))}
        return self.absolute(self.file('synthetic-public-capture',x))

    def checked(self):
        op = self.operation(); out = m.private_new_directory(self.base/'checked')
        return op,op.assemble_check(self.capture_ref,out)

    def retired_for(self, checked):
        checked_value=json.loads(Path(checked['path']).read_bytes()); stage_ref=checked_value['stageInput']
        s=m.stage.Stage(stage_ref['path'],stage_ref['sha256'],checked_value['stageOperator']['sha256'])
        proof=copy.deepcopy(self.proof); proof['stageInput']=stage_ref
        proof['writer']=f.f.actual_pod(s.desired['writer'],'writer-uid'); proof['qualifier']=f.f.actual_pod(s.desired['qualifier'],'qualifier-uid')
        proof['policy']=copy.deepcopy(s.desired['policy']); proof['policy']['metadata'].update(uid='deny-uid',resourceVersion='17')
        proof['runtime'].update(inputSha256=stage_ref['sha256'],operatorSha256=s.operator_sha,pod=proof['qualifier'])
        return self.absolute(self.file('synthetic-retired-new-stage',proof))

    def test_real_check_and_plan_cli_recompute_contract_and_never_contact_target(self):
        args=['--profile',self.profile_ref['path'],'--profile-sha256',self.profile_ref['sha256'],'--prepared',self.prepared_ref['path'],
              '--prepared-sha256',self.prepared_ref['sha256'],'--operator-sha256',m.file_ref(SCRIPT)['sha256'],'--node',NODE]
        checked_dir=self.base/'cli-check'
        cmd=[sys.executable,'-B',*(['-O'] if sys.flags.optimize else []),str(SCRIPT),'check',*args,'--capture',self.capture_ref['path'],'--capture-sha256',self.capture_ref['sha256'],'--out',str(checked_dir)]
        result=subprocess.run(cmd,capture_output=True,timeout=90); self.assertEqual(result.returncode,0,result.stderr.decode())
        checked=m.file_ref(checked_dir/'check.actual.json'); value=json.loads(Path(checked['path']).read_bytes())
        self.assertFalse(value['targetCalls']); self.assertFalse((checked_dir/'stage-execution').exists())
        self.assertEqual(json.loads(Path(value['baseline']['path']).read_bytes())['claims']['metadata']['resourceVersion'],'')
        retired=self.retired_for(checked); after=self.capture_fixture(True)
        planned=self.base/'cli-plan'
        cmd=[sys.executable,'-B',*(['-O'] if sys.flags.optimize else []),str(SCRIPT),'plan',*args,'--capture',after['path'],'--capture-sha256',after['sha256'],
             '--check',checked['path'],'--check-sha256',checked['sha256'],'--stage',retired['path'],'--stage-sha256',retired['sha256'],'--out',str(planned)]
        result=subprocess.run(cmd,capture_output=True,timeout=90); self.assertEqual(result.returncode,0,result.stderr.decode())
        plan=json.loads((planned/'plan.actual.json').read_bytes()); self.assertFalse(plan['productionMutation'])
        pub=json.loads(Path(plan['publicationInput']['path']).read_bytes())
        self.assertEqual(pub['sourceFiles'],self.operation().source_refs(m.stage.SOURCE_NAMES|{'publish-public-shell.py'}))
        self.assertFalse((planned/'publication-execution').exists())
        self.assertEqual(subprocess.run(cmd,capture_output=True,timeout=90).returncode,1)

    def changed_capture(self, key, change):
        x=json.loads(Path(self.capture_ref['path']).read_bytes()); value=json.loads((self.base/x[key]['path']).read_bytes())
        change(value); x[key]=self.file('changed-original-'+key,value)
        return self.absolute(self.file('changed-capture',x))

    def test_incomplete_wrong_api_scope_duplicates_and_node_replacement_refuse(self):
        op=self.operation()
        for key,change in [('claims',lambda x:x['metadata'].update({'continue':'next'})),
                           ('claims',lambda x:x['items'][0].update(apiVersion='apps/v1')),
                           ('claims',lambda x:x['items'].append(copy.deepcopy(x['items'][0]))),
                           ('pods',lambda x:x['items'][0]['metadata'].update(namespace='other')),
                           ('node',lambda x:x['metadata'].update(uid='replacement')),
                           ('services',lambda x:x['items'][0]['spec'].update(type='ExternalName'))]:
            with self.assertRaises(REFUSALS): op.capture(self.changed_capture(key,change))

    def test_profile_and_prepared_mutations_cannot_override_accepted_boundaries(self):
        for key,value in [('selection',{'container':'other','shellVolume':'public-shell'}),('stageNamePrefix','x'*33),('image','registry.example/unreviewed'),('settings',{})]:
            altered=copy.deepcopy(self.profile); altered[key]=value
            ref=self.absolute(self.file('changed-profile',altered))
            with self.assertRaises(REFUSALS): m.Update(ref['path'],ref['sha256'],self.prepared_ref['path'],self.prepared_ref['sha256'],m.file_ref(SCRIPT)['sha256'],NODE)
        for key,value in [('image','registry.example/changed@sha256:'+'a'*64),('catalog',{}),('settings',{}),('profile','private')]:
            altered=copy.deepcopy(self.result); altered[key]=value; ref=self.absolute(self.file('changed-prepared',altered))
            with self.assertRaises(REFUSALS): m.Update(self.profile_ref['path'],self.profile_ref['sha256'],ref['path'],ref['sha256'],m.file_ref(SCRIPT)['sha256'],NODE)

    def test_config_models_claim_collision_and_owner_drift_refuse(self):
        op=self.operation()
        controls=[('nginxConfig',lambda x:x.update(binaryData={'extra':'changed'})),('claims',lambda x:x['items'][0]['spec'].update(volumeName='other')),
                  ('pods',lambda x:x['items'][0]['spec'].update(enableServiceLinks=False)),('claims',lambda x:x['items'].append(self.claim))]
        for key,change in controls:
            with self.assertRaises(REFUSALS): op.capture(self.changed_capture(key,change))

    def test_poststage_extra_global_storage_and_other_deployment_changes_refuse(self):
        op,checked=self.checked(); retired=self.retired_for(checked); after=self.capture_fixture(True)
        x=json.loads(Path(after['path']).read_bytes()); rows=json.loads((self.base/x['volumes']['path']).read_bytes())
        extra=copy.deepcopy(self.pv); extra['metadata'].update(name='unrelated',uid='unrelated'); extra['spec']['local']['path']='/unrelated'
        rows['items'].append(extra); x['volumes']=self.file('changed-global-pv',rows); changed=self.absolute(self.file('changed-after',x))
        with self.assertRaises(REFUSALS): op.assemble_plan(checked,changed,retired,m.private_new_directory(self.base/'refused-plan'))
        x=json.loads(Path(after['path']).read_bytes()); rows=json.loads((self.base/x['deployments']['other']['path']).read_bytes())
        rows['items'][0]['spec']['template']['spec']['containers'][0]['image']='registry.example/changed@sha256:'+'b'*64
        x['deployments']['other']=self.file('changed-other-deployments',rows); changed=self.absolute(self.file('changed-after-deployment',x))
        with self.assertRaises(REFUSALS): op.assemble_plan(checked,changed,retired,m.private_new_directory(self.base/'refused-plan-2'))

    def transport(self, capture, calls, fail=None):
        x=json.loads(Path(capture['path']).read_bytes()); values={}
        for label,key in [('system-namespace','systemNamespace'),('node','node'),('pods','pods'),('claims','claims'),('volumes','volumes'),('storage-class','storageClass'),('nginx-config','nginxConfig'),('policies','policies'),('services','services'),('replica-set','replicaSet')]:
            values[label]=(self.base/x[key]['path']).read_bytes()
        for ns,ref in x['namespaces'].items(): values['namespace-'+ns]=(self.base/ref['path']).read_bytes()
        for ns,ref in x['deployments'].items(): values['deployments-'+ns]=(self.base/ref['path']).read_bytes()
        # read_capture has a fixed original order independent of JSON ordering.
        queue=['system-namespace','node',*['namespace-'+n for n in sorted(x['namespaces'])],*['deployments-'+n for n in sorted(x['deployments'])],
               'pods','claims','volumes','storage-class','nginx-config','policies','services','replica-set']
        def runner(argv,**kwargs):
            label=queue[len(calls)]; calls.append(argv)
            self.assertIn('get',argv); self.assertNotIn('patch',argv); self.assertNotIn('create',argv)
            if label=='claims': self.assertIn('--all-namespaces',argv)
            return subprocess.CompletedProcess(argv,1 if label==fail else 0,values[label],b'bounded refusal' if label==fail else b'')
        return runner

    def test_literal_get_capture_preserves_original_bytes_and_global_scope(self):
        op=self.operation(); calls=[]; out=m.private_new_directory(self.base/'capture-run')
        ref=op.read_capture(out,runner=self.transport(self.capture_ref,calls)); actual=json.loads(Path(ref['path']).read_bytes())
        self.assertEqual(len(calls),14); self.assertEqual(actual['status'],'READ_ONLY_PUBLIC_SHELL_RESOURCES_CAPTURED')
        outcome=json.loads((out/'capture.actual.json').read_bytes()); self.assertEqual(len(outcome['commands']),14)
        self.assertTrue(all(json.loads(Path(r['path']).read_bytes())['returncode']==0 for r in outcome['commands']))
        with self.assertRaises(REFUSALS): op.read_capture(out,runner=self.transport(self.capture_ref,[]))

    def test_failed_get_preserves_response_and_stops_without_retry(self):
        op=self.operation(); calls=[]; out=m.private_new_directory(self.base/'failed-capture')
        with self.assertRaises(REFUSALS): op.read_capture(out,runner=self.transport(self.capture_ref,calls,'claims'))
        self.assertEqual(len(calls),8); self.assertEqual((out/'claims.stderr.original').read_bytes(),b'bounded refusal')
        self.assertTrue((out/'capture.uncertain.json').is_file()); self.assertFalse((out/'capture.actual.json').exists())

    def test_stale_source_closure_and_unsafe_probe_policy_refuse(self):
        op=self.operation(); Path(self.stage_value['preflight']['path']).write_bytes(b'changed guard')
        with self.assertRaises(REFUSALS): op.source_check()
        # Source closure drift is held even when another profile field changes.
        altered=copy.deepcopy(self.profile); altered['probePolicy']['paths'].append('models/private.bin')
        ref=self.absolute(self.file('unsafe-probe-policy',altered))
        with self.assertRaises(REFUSALS): m.Update(ref['path'],ref['sha256'],self.prepared_ref['path'],self.prepared_ref['sha256'],m.file_ref(SCRIPT)['sha256'],NODE)

    def test_changed_chunk_precedes_lexicographic_retained_control(self):
        op=self.operation(); row={**op.old_files['_app/old.js'],'path':'_app/000-retained.js'}
        op.effective.files['_app/000-retained.js']=row
        op.old_files['_app/000-retained.js']=row
        paths=[r['path'] for r in op.probes()]
        self.assertIn('_app/new.js',paths); self.assertIn('_app/000-retained.js',paths)
        self.assertLess(paths.index('_app/new.js'),paths.index('_app/000-retained.js'))

    def test_next_profile_requires_maintained_emitted_actual_acceptance(self):
        op,checked=self.checked(); retired=self.retired_for(checked)
        plan_ref=op.assemble_plan(checked,self.capture_fixture(True),retired,m.private_new_directory(self.base/'next-plan'))
        plan=json.loads(Path(plan_ref['path']).read_bytes()); pub=m.publisher.Publication(plan['publicationInput']['path'],plan['publicationInput']['sha256'],plan['publicationOperator']['sha256'])
        pub.out.mkdir(); current=copy.deepcopy(self.before); current['spec']=copy.deepcopy(self.result['desiredSpec']); current['metadata']['resourceVersion']='901'
        pod=f.f.actual_pod({'apiVersion':'v1','kind':'Pod','metadata':{'name':'new-owner','namespace':'public','labels':{'app':'public'}},'spec':pub.expected_owner_spec},'new-owner-uid')
        rs=copy.deepcopy(self.baseline['replicaSet']); rs['metadata'].update(uid='new-rs-uid',name='new-rs')
        pod['metadata']['ownerReferences']=[{'kind':'ReplicaSet','name':'new-rs','uid':'new-rs-uid','controller':True}]
        owner=self.file('synthetic-new-owner',{'deployment':current,'pod':pod,'replicaSet':rs}); tls=self.file('synthetic-new-tls',{'verified':True})
        accepted=pub.accepted_previous(current,pod,rs,self.static,self.hashes,self.proof['runtime']['catalog'],owner,tls,{'https://public.example/index.html':{'status':200,'verifiedTlsAndHostname':True}})
        out=m.private_new_directory(self.base/'next-profile'); next_ref=op.next_profile(accepted,out)
        next_profile=json.loads(Path(next_ref['path']).read_bytes()); self.assertEqual(next_profile['previous'],accepted)
        self.assertEqual(next_profile['selection'],op.profile['selection']); self.assertEqual(next_profile['target'],op.profile['target'])
        bad=json.loads(Path(accepted['path']).read_bytes()); bad['publicCatalog']['indexSha256']='0'*64
        ref=self.absolute(self.file('synthetic-invalid-next',bad))
        with self.assertRaises(REFUSALS): op.next_profile(ref,m.private_new_directory(self.base/'invalid-next'))

    def test_run_rejects_nonprivate_nonempty_and_symlinked_output_before_capture(self):
        op=self.operation(); calls=[]; op.read_capture=lambda *args,**kwargs:calls.append('unexpected')
        public_out=self.base/'public-mode'; public_out.mkdir(mode=0o755)
        nonempty=m.private_new_directory(self.base/'nonempty'); (nonempty/'owned-original').write_bytes(b'preserve')
        real=m.private_new_directory(self.base/'real-output'); link=self.base/'linked-output'; link.symlink_to(real,target_is_directory=True)
        for out in (public_out,nonempty,link):
            with self.assertRaises(REFUSALS): op.run(out)
        self.assertEqual(calls,[]); self.assertEqual((nonempty/'owned-original').read_bytes(),b'preserve')
        self.assertFalse((real/'run.started.json').exists())

    def test_run_refuses_unknown_or_uncertain_stage_boundary_without_publication(self):
        original_stage=m.stage.Stage
        for result in ({'stage':self.publication_value['stage'],'claimRetained':False,'productionDeploymentMutated':False},
                       {'stage':self.publication_value['stage'],'claimRetained':True,'productionDeploymentMutated':False,'extra':'unreviewed'}):
            op=self.operation(); captures=[]
            def capture(out,staged=None):
                captures.append(out); return self.capture_fixture(False)
            op.read_capture=capture
            class StageOnce(original_stage):
                def execute(instance, action):
                    return super().execute(action) if action=='check' else result
            out=m.private_new_directory(self.base/('bad-stage-'+str(len(result))+str(result['claimRetained'])))
            with patch.object(m.stage,'Stage',StageOnce),patch.object(m.publisher,'Publication',side_effect=AssertionError('Publication must not start')):
                with self.assertRaises(REFUSALS): op.run(out)
            self.assertEqual(len(captures),1); self.assertFalse((out/'instance-profile.next.json').exists())
            self.assertEqual(json.loads((out/'run.uncertain.json').read_bytes())['phase'],'stage')

    def test_run_success_and_each_publication_failure_are_single_use(self):
        original_stage, original_pub = m.stage.Stage,m.publisher.Publication
        for failed in ('dryrun','apply','observe',None):
            with self.subTest(failed=failed):
                op=self.operation(); op.read_capture=lambda out,staged=None: self.capture_fixture(staged is not None)
                calls=[]
                class StageOnce(original_stage):
                    def execute(instance, action):
                        if action=='check': return super().execute(action)
                        calls.append('stage')
                        return {'stage':self.retired_for(m.file_ref(instance.input_path.parent/'check.actual.json')),'claimRetained':True,'productionDeploymentMutated':False}
                class PublicationOnce(original_pub):
                    def execute(instance, action, timeout=180):
                        if action=='check': return super().execute(action)
                        calls.append(action)
                        if action=='dryrun': instance.out.mkdir(mode=0o700)
                        def body():
                            if action==failed: raise m.Refusal('Synthetic uncertain phase')
                            if action=='observe':
                                current=copy.deepcopy(self.before); current['spec']=copy.deepcopy(self.result['desiredSpec'])
                                current['metadata']['resourceVersion']='901'
                                pod=f.f.actual_pod({'apiVersion':'v1','kind':'Pod','metadata':{'name':'next-owner','namespace':'public','labels':{'app':'public'}},'spec':instance.expected_owner_spec},'next-owner-uid')
                                rs=copy.deepcopy(self.baseline['replicaSet']); rs['metadata'].update(name='next-rs',uid='next-rs-uid')
                                pod['metadata']['ownerReferences']=[{'kind':'ReplicaSet','name':'next-rs','uid':'next-rs-uid','controller':True}]
                                owner=self.file('synthetic-next-owner',{'deployment':current,'pod':pod,'replicaSet':rs}); tls=self.file('synthetic-next-tls',{'verified':True})
                                accepted=instance.accepted_previous(current,pod,rs,self.static,self.hashes,self.proof['runtime']['catalog'],owner,tls,
                                    {'https://public.example/index.html':{'status':200,'verifiedTlsAndHostname':True}})
                                return {'status':'PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED','acceptedPrevious':accepted,'remainingAcceptance':['Synthetic fixture is not runtime qualification']}
                            return {'status':'PUBLIC_SHELL_ADMISSION_DRY_RUN_ACCEPTED' if action=='dryrun' else 'ATOMIC_PUBLIC_SHELL_PATCH_COMMITTED_ACCEPTANCE_PENDING'}
                        return instance.phase(action,body)
                out=m.private_new_directory(self.base/('phase-run-'+str(failed)))
                with patch.object(m.stage,'Stage',StageOnce),patch.object(m.publisher,'Publication',PublicationOnce):
                    if failed:
                        with self.assertRaises(REFUSALS): op.run(out)
                    else:
                        receipt=op.run(out); actual=json.loads(Path(receipt['path']).read_bytes())
                        self.assertEqual(set(actual['elapsedSecondsByPhase']),{'capture-before','stage-check','stage','capture-after','publication-plan','dryrun','apply','observe'})
                        self.assertTrue(all(value>=0 for value in actual['elapsedSecondsByPhase'].values()))
                expected=['stage','dryrun','apply','observe']
                self.assertEqual(calls,expected if failed is None else expected[:expected.index(failed)+1])
                self.assertEqual((out/'instance-profile.next.json').exists(),failed is None)
                self.assertEqual((out/'run.actual.json').exists(),failed is None)
                with self.assertRaises(REFUSALS): op.run(out)
                self.assertEqual(calls,expected if failed is None else expected[:expected.index(failed)+1])

    def test_run_calls_each_maintained_phase_once_and_never_replays_failure(self):
        op=self.operation(); op.read_capture=lambda out,staged=None: self.capture_fixture(staged is not None)
        original_stage=m.stage.Stage; calls=[]
        class StageOnce(original_stage):
            def execute(instance, action):
                if action=='check': return super().execute(action)
                self.assertEqual(action,'run'); calls.append('stage')
                checked=m.file_ref(instance.input_path.parent/'check.actual.json')
                return {'stage':self.retired_for(checked),'claimRetained':True,'productionDeploymentMutated':False}
        original_pub=m.publisher.Publication
        class PublicationOnce(original_pub):
            def execute(instance, action, timeout=180):
                if action=='check': return super().execute(action)
                calls.append(action)
                if action=='apply': raise m.Refusal('Synthetic ambiguous apply')
                return {'fixtureOnly':True}
        out=m.private_new_directory(self.base/'failed-run')
        with patch.object(m.stage,'Stage',StageOnce),patch.object(m.publisher,'Publication',PublicationOnce):
            with self.assertRaises(REFUSALS): op.run(out)
        self.assertEqual(calls,['stage','dryrun','apply']); self.assertTrue((out/'run.uncertain.json').is_file()); self.assertFalse((out/'run.actual.json').exists())
        with self.assertRaises(REFUSALS): op.run(out)
        self.assertEqual(calls,['stage','dryrun','apply'])


if __name__ == '__main__': unittest.main()
