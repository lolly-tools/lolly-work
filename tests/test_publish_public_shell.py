#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Adversarial offline promotion and next-baseline handoff; no live target calls.

Cluster/runtime/HTTPS captures are explicitly synthetic. Maintained parsers, Git,
P-256 verification and check CLIs are real. Passing fixtures are not deployment
or Nginx acceptance and do not authenticate their claimed origin.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
sys.dont_write_bytecode = True
spec = __import__('importlib.util').util.spec_from_file_location('public_stage_fixture',Path(__file__).with_name('test_stage_public_shell.py'))
f = __import__('importlib.util').util.module_from_spec(spec); spec.loader.exec_module(f)
p = f.load('public_publication_test',f.HERE/'scripts/publish-public-shell.py')
m = p.stage


class PublicationFixture(f.PublicFixture):
    def metadata_ref(self, name, guard, claim, pv):
        value=f.root_proof(guard.target,claim,pv); t=guard.target['transport']
        config={'version':1,'kubectl':[*t['kubectl'],'--kubeconfig',t['kubeconfig'],'--context',t['context']],
                'clusterUID':guard.target['clusterUID'],'node':guard.target['node'],'claim':claim,'pv':pv,'storageClass':guard.baseline['storageClass']}
        stdout=self.binary(name+'-stdout',m.cohort.canonical(value)+b'\n'); stderr=self.binary(name+'-stderr',b'')
        command=self.file(name+'-command',{'exitCode':0,'timedOut':False,'argv':m.root_command(guard,config),'readOnlyMountProbe':False,
                         'originals':{'stdout':{**stdout,'observedBytes':Path(stdout['path']).stat().st_size,'complete':True},'stderr':{**stderr,'observedBytes':0,'complete':True}}})
        return self.file(name,{'metadata':value,'originalCommand':command})

    def setUp(self):
        super().setUp(); self.s = self.stage()
        self.writer = f.actual_pod(self.s.desired['writer'],'writer-uid'); self.qualifier = f.actual_pod(self.s.desired['qualifier'],'qualifier-uid')
        self.claim = copy.deepcopy(self.s.desired['shellClaim']); self.claim['metadata'].update(uid='overlay-uid',resourceVersion='15'); self.claim['spec']['volumeName']='overlay-pv'; self.claim['status']={'phase':'Bound'}
        self.pv = copy.deepcopy(self.baseline['pvs']['items'][0]); self.pv['metadata'].update(name='overlay-pv',uid='overlay-pv-uid',resourceVersion='16')
        self.pv['spec']['claimRef'].update(name='new-public-shell',uid='overlay-uid'); self.pv['spec']['local']['path']='/new-isolated-overlay'
        self.policy = copy.deepcopy(self.s.desired['policy']); self.policy['metadata'].update(uid='deny-uid',resourceVersion='17')
        static = {'htmlRoot':m.public.ROOT[1:],'files':{path:{'mode':0o644,'size':row['size'],'sha256':row['sha256']} for path,row in self.s.effective.files.items()}}
        self.static = self.file('synthetic-original-qualifier-static',static)
        self.hashes = self.binary('synthetic-derived-qualifier-hashes',''.join(row['sha256']+'  '+m.public.ROOT+'/'+path+'\n' for path,row in self.s.effective.files.items()).encode())
        catalog = self.file('synthetic-actual-catalog-check',{'catalog':self.s.prepared['catalog'],'verified':True,'actualIndexSha256':self.catalog['indexSha256'],'actualEnvelopeSha256':self.catalog['envelopeSha256'],'signedMapBoundToActualFullInventory':True})
        root_before=self.metadata_ref('synthetic-root-before-handoff',self.s,self.claim,self.pv)
        root_after=self.metadata_ref('synthetic-root-after-handoff',self.s,self.claim,self.pv)
        stdout,stderr = self.binary('synthetic-original-command-stdout',b'fixture bytes\n'),self.binary('synthetic-original-command-stderr',b'')
        command = self.file('synthetic-original-command',{'exitCode':0,'timedOut':False,'originals':{'stdout':{**stdout,'observedBytes':14,'complete':True},'stderr':{**stderr,'observedBytes':0,'complete':True}}})
        runtime = {'version':1,'status':'PHASE_ACCEPTED','runtimeStatus':'ISOLATED_PUBLIC_SHELL_RUNTIME_VERIFIED','inputSha256':self.s.input_sha,'operatorSha256':self.s.operator_sha,'pod':self.qualifier,'image':self.result['image'],'sources':self.result['sources'],
                   'static':self.static,'hashes':self.hashes,'catalog':catalog,'staticManifestSha256':self.producer['shell']['manifest']['sha256'],'overlayManifestSha256':self.s.new.manifest_sha,
                   'fullStaticHashesVerified':True,'publicCatalogSignatureVerified':True,'nginxLoopbackIndexVerified':True,'modelsMounted':False,'rootMetadata':{'before':root_before,'after':root_after},'originalCommands':[command]}
        def mounts(uid): return {'podUid':uid,'nodeUID':'fixture-node-uid','unmounted':True,'mountsReleased':True}
        self.proof = {'version':1,'status':'ISOLATED_PUBLIC_SHELL_ACCEPTED_AND_RETIRED','preparedSha256':self.prepared_ref['sha256'],'image':self.result['image'],'sources':self.result['sources'],'overlayManifestSha256':self.s.new.manifest_sha,'staticManifestSha256':self.producer['shell']['manifest']['sha256'],
                      'claim':self.claim,'pv':self.pv,'writer':self.writer,'qualifier':self.qualifier,'policy':self.policy,'writerMountProof':mounts('writer-uid'),'qualifierMountProof':mounts('qualifier-uid'),'writerAbsent':True,'qualifierAbsent':True,'policyAbsent':True,'mountsReleased':True,'runtime':runtime,'stageInput':self.stage_ref}
        probes=[{'url':'https://public.example/'+path,**self.s.effective.files[path]} for path in ['index.html','catalog/tools/index.json','catalog/tools/index.sig.json','_app/new.js']]
        self.publication_value = {'version':1,'status':'REVIEWED_PUBLIC_SHELL_PUBLICATION_INPUT','stageInput':self.stage_ref,'stage':self.file('synthetic-original-retired-stage',self.proof),'preflight':self.stage_value['preflight'],'staticProbes':probes,'outputDirectory':str(self.base/'publication-output'),
                                  'sourceFiles':[f.ref(f.HERE/'scripts'/n) for n in sorted(m.SOURCE_NAMES|{'publish-public-shell.py'})]}
        self.publication_ref = self.file('reviewed-synthetic-publication-input',self.publication_value); self.publication_ref['path']=str(self.base/self.publication_ref['path'])

    def publisher(self): return p.Publication(self.publication_ref['path'],self.publication_ref['sha256'],m.checksum(f.HERE/'scripts/publish-public-shell.py'))
    def refresh(self):
        self.publication_value['stage']=self.file('changed-synthetic-retired-stage',self.proof)
        self.publication_ref=self.file('changed-synthetic-publication-input',self.publication_value); self.publication_ref['path']=str(self.base/self.publication_ref['path'])

    def transport(self, pub, extra_pv=None, extra_pod=None):
        # Complete original-like in-memory API captures. No kubectl is executed.
        rows=copy.deepcopy(self.baseline['deployments']); namespaces={c['namespace']:c['namespaceUID'] for c in self.target['components'].values()}
        config=json.loads((self.base/self.previous['nginxConfig']['path']).read_bytes()); models=self.baseline['claims']['items'][0]
        policies=json.loads((self.base/self.previous['policyInventory']['path']).read_bytes()); services=json.loads((self.base/self.previous['serviceInventory']['path']).read_bytes())
        def get(kind,name=None,namespace=None):
            if kind=='namespace': return {'metadata':{'uid':'fixture-cluster' if name=='kube-system' else namespaces[name]}}
            if kind=='node': return {'metadata':{'uid':'fixture-node-uid'},'status':{'conditions':[{'type':'Ready','status':'True'}]}}
            if kind=='deployments': return f.collection('Deployment',[d for d in rows if d['metadata']['namespace']==namespace])
            if kind=='deployment': return next(copy.deepcopy(d) for d in rows if d['metadata']['name']==name and d['metadata']['namespace']==namespace)
            if kind=='pvc': return f.collection('PersistentVolumeClaim',[*self.baseline['claims']['items'],self.claim])
            if kind=='pv': return f.collection('PersistentVolume',[*self.baseline['pvs']['items'],self.pv,*([extra_pv] if extra_pv else [])])
            if kind=='pods': return f.collection('Pod',[self.baseline['owner'],*([extra_pod] if extra_pod else [])])
            if kind=='replicaset': return copy.deepcopy(self.baseline['replicaSet'])
            if kind=='ConfigMap': return copy.deepcopy(config)
            if kind=='PersistentVolumeClaim': return copy.deepcopy(models)
            if kind=='PersistentVolume': return copy.deepcopy(self.baseline['pvs']['items'][0])
            if kind in ('networkpolicies','services'):
                values=policies if kind=='networkpolicies' else services; api='networking.k8s.io/v1' if kind=='networkpolicies' else 'v1'; item='NetworkPolicy' if kind=='networkpolicies' else 'Service'
                return f.collection(item,[{'apiVersion':api,'kind':item,'metadata':{'name':n,'namespace':'public','uid':v['uid'],'resourceVersion':'18'},'spec':v['spec']} for n,v in values.items()])
            if kind=='storageclass': return copy.deepcopy(self.baseline['storageClass'])
            raise AssertionError((kind,name,namespace))
        pub.guard.get=get; pub.guard.kube=type('OfflineKube',(),{'get':staticmethod(get)})(); return get


class Boundaries(PublicationFixture):
    def test_actual_offline_publisher_cli_preserves_explicit_no_execution(self):
        args=[sys.executable,'-B',*(['-O'] if sys.flags.optimize else []),str(f.HERE/'scripts/publish-public-shell.py'),'check','--inputs',self.publication_ref['path'],'--sha256',self.publication_ref['sha256'],'--operator-sha256',m.checksum(f.HERE/'scripts/publish-public-shell.py')]
        result=subprocess.run(args,capture_output=True); self.assertEqual(result.returncode,0,result.stderr.decode()); self.assertFalse(json.loads(result.stdout)['productionMutation']); self.assertFalse((self.base/'publication-output').exists())

    def test_full_original_owner_defaults_survive_and_any_new_default_or_unselected_drift_refuses(self):
        pub=self.publisher(); self.assertNotIn('enableServiceLinks',self.before['spec']['template']['spec'])
        self.assertTrue(pub.expected_owner_spec['enableServiceLinks']); self.assertFalse(pub.guard.desired['qualifier']['spec']['enableServiceLinks'])
        want={'apiVersion':'v1','kind':'Pod','metadata':{'name':'next-owner','namespace':'public','labels':{'app':'public'}},'spec':pub.expected_owner_spec}
        actual=f.actual_pod(want,'next-owner-uid'); m.validate_public_pod(actual,want,True)
        for change in (lambda v:v['spec'].update(enableServiceLinks=False),lambda v:v['spec'].pop('enableServiceLinks'),lambda v:v['spec'].update(serviceAccountName='other'),lambda v:v['spec']['containers'][0]['resources']['limits'].update(memory='1Gi'),lambda v:v['spec']['volumes'][1]['configMap'].update(name='replacement')):
            bad=copy.deepcopy(actual); change(bad)
            with self.assertRaises((m.Refusal,m.private.Refusal)): m.validate_public_pod(bad,want,True)
        changed=copy.deepcopy(pub.guard.prepared); changed['desiredSpec']['template']['spec']['enableServiceLinks']=False; pub.guard.prepared=changed
        with self.assertRaises(m.Refusal): p.expected_owner_spec(pub.guard)

    def test_retirement_wrong_uid_mount_release_private_status_or_models_mount_refuse(self):
        for change in (lambda v:v.update(status='ISOLATED_SHELL_ACCEPTED_AND_RETIRED'),lambda v:v['writerMountProof'].update(podUid='other'),lambda v:v['qualifierMountProof'].update(mountsReleased=False),lambda v:v['runtime'].update(modelsMounted=True),lambda v:v['qualifier']['spec']['volumes'][0]['persistentVolumeClaim'].update(claimName='models')):
            old=copy.deepcopy(self.proof); change(self.proof); self.refresh()
            with self.assertRaises(RuntimeError): self.publisher()
            self.proof=old

    def test_retirement_qualifier_managed_source_anchor_and_root_proof_are_required(self):
        original=copy.deepcopy(self.proof)
        self.assertIs(p.review_retirement(self.proof,self.s),self.proof)
        self.assertEqual(self.proof,original)
        self.assertNotIn('readOnly',self.proof['qualifier']['spec']['volumes'][0]['persistentVolumeClaim'])
        self.assertNotIn('readOnly',self.proof['writer']['spec']['volumes'][0]['persistentVolumeClaim'])
        for value in (True,'false'):
            bad=copy.deepcopy(self.proof); volume=bad['qualifier']['spec']['volumes'][0]['persistentVolumeClaim']
            volume['readOnly']=value
            self.assertEqual(bad['runtime']['pod'],bad['qualifier'])
            with self.assertRaises((m.Refusal,m.private.Refusal)):
                p.review_retirement(bad,self.s)
        for change in (lambda v:v['runtime'].pop('rootMetadata'),lambda v:v['qualifier']['spec']['containers'][0]['volumeMounts'].__delitem__(1)):
            bad=copy.deepcopy(self.proof); change(bad)
            with self.assertRaises((m.Refusal,m.private.Refusal)): p.review_retirement(bad,self.s)
        self.assertEqual(self.proof,original)

    def test_root_proof_requires_exact_program_target_and_actual_original_metadata_bytes(self):
        pub=self.publisher(); ref=self.proof['runtime']['rootMetadata']['before']
        held=pub.guard.inputs.file(ref); self.assertEqual(m.root_proof(ref,pub.guard,self.claim,self.pv),held['metadata'])
        for change in (lambda v:v['metadata']['root'].update(mode=0o2775),lambda v:v['metadata']['root'].update(inode=999)):
            bad=copy.deepcopy(held); change(bad); fake=self.file('synthetic-unbound-root-metadata',bad)
            with self.assertRaises(m.Refusal): m.root_proof(fake,pub.guard,self.claim,self.pv)
        original=pub.guard.inputs.file(held['originalCommand'])
        for change in (lambda v:v['argv'].__setitem__(2,'print("forged label")'),lambda v:v.update(timedOut=True),
                       lambda v:v['originals']['stdout'].update(complete=False),lambda v:v['originals']['stdout'].update(observedBytes=1)):
            bad=copy.deepcopy(original); change(bad)
            fake=self.file('synthetic-bad-root-command',{**held,'originalCommand':self.file('synthetic-root-command-counterexample',bad)})
            with self.assertRaises(m.Refusal): m.root_proof(fake,pub.guard,self.claim,self.pv)
        wrong=copy.deepcopy(original); config=json.loads(wrong['argv'][-1]); config['pv']['metadata']['uid']='wrong-pv'
        wrong['argv'][-1]=m.cohort.canonical(config).decode()
        fake=self.file('synthetic-wrong-root-resource',{**held,'originalCommand':self.file('synthetic-wrong-root-resource-command',wrong)})
        with self.assertRaises(m.Refusal): m.root_proof(fake,pub.guard,self.claim,self.pv)

    def test_root_mismatch_refuses_before_preflight_or_patch_and_never_repairs(self):
        pub=self.publisher(); pub.out.mkdir(); calls=[]; pub.source_check=lambda:None
        pub.guard.run=lambda *a,**k:calls.append('preflight'); pub.guard.remote=lambda *a,**k:calls.append('patch')
        def roots(): calls.append('roots'); raise m.Refusal('Observed model group/mode mismatch')
        pub.root_metadata=roots
        with self.assertRaises(m.Refusal): pub.patch(p.patch_for(pub.prepared,self.before),True)
        self.assertEqual(calls,['roots']); self.assertFalse((pub.out/'dryrun.response.original.json').exists())

    def test_only_fs_group_policy_changes_and_actual_security_defaults_remain_exact(self):
        pub=self.publisher(); guard=pub.guard
        guard.owner['spec']['securityContext']['supplementalGroups']=[777]
        expected=p.expected_owner_spec(guard)
        self.assertEqual(expected['securityContext']['supplementalGroups'],[777]); self.assertEqual(expected['securityContext']['fsGroupChangePolicy'],'OnRootMismatch')
        for change in (lambda v:v['securityContext'].update(fsGroup=1000),lambda v:v['securityContext'].update(seLinuxOptions={'level':'s0'}),
                       lambda v:v['securityContext'].update(fsGroupChangePolicy='Always')):
            prior=copy.deepcopy(guard.prepared); change(guard.prepared['desiredSpec']['template']['spec'])
            with self.assertRaises(m.Refusal): p.expected_owner_spec(guard)
            guard.prepared=prior

    def test_fresh_global_alias_added_after_stage_and_temp_holder_reappearance_refuse(self):
        pub=self.publisher(); alias=copy.deepcopy(self.pv); alias['metadata'].update(name='dormant-alias',uid='dormant-uid'); self.transport(pub,extra_pv=alias)
        with self.assertRaises(m.Refusal): pub.guard.fresh()
        alias['spec']['local']['path']='/unrelated-unclaimed'; pub=self.publisher(); self.transport(pub,extra_pv=alias)
        with self.assertRaises(m.Refusal): pub.guard.fresh()
        pub=self.publisher(); self.transport(pub,extra_pod=self.qualifier)
        with self.assertRaises(m.Refusal): pub.guard.fresh()

    def test_fresh_capture_preserves_models_nginx_config_and_all_nine_specs(self):
        pub=self.publisher(); self.transport(pub); self.assertEqual(len(pub.guard.fresh()['items']),1)
        original=pub.guard.get
        def changed(kind,name=None,namespace=None):
            value=original(kind,name,namespace)
            if kind=='ConfigMap': value['data']['default.conf']='changed'
            return value
        pub.guard.get=changed
        with self.assertRaises(m.Refusal): pub.guard.fresh()

    def test_patch_uses_current_rv_and_full_spec_and_refuses_replaced_uid(self):
        current=copy.deepcopy(self.before); current['metadata']['resourceVersion']='900'
        patch_=p.patch_for(self.result,current); self.assertEqual(patch_[1]['value'],'900'); self.assertEqual(patch_[2]['value'],current['spec']); self.assertEqual(patch_[3]['value'],self.result['desiredSpec'])
        current['metadata']['uid']='replacement'
        with self.assertRaises(p.Refusal): p.patch_for(self.result,current)

    def test_preflight_is_last_then_apply_once_and_original_bad_api_response_is_retained(self):
        pub=self.publisher(); pub.out.mkdir(); calls=[]
        pub.fresh=lambda *a,**kw:(copy.deepcopy(self.before),None); pub.source_check=lambda:None
        pub.root_metadata=lambda:(calls.append('roots') or {'overlay':self.proof['runtime']['rootMetadata']['after'],'models':self.proof['runtime']['rootMetadata']['after']})
        pub.guard.run=lambda argv,**kw:calls.append('preflight')
        def remote(argv,data=None,timeout=None):
            calls.append(argv); result=copy.deepcopy(self.before); result['spec']=copy.deepcopy(self.result['desiredSpec']); result['spec']['replicas']=2; return m.cohort.canonical(result)
        pub.guard.remote=remote
        with self.assertRaises(p.Refusal): pub.phase('dryrun',lambda:{'deployment':pub.patch(p.patch_for(pub.prepared,self.before),True)})
        self.assertEqual(calls[:2],['roots','preflight']); self.assertEqual(len(calls),3); self.assertTrue((pub.out/'dryrun.response.original.json').exists()); self.assertTrue((pub.out/'dryrun.uncertain.json').exists())
        with self.assertRaises(OSError): pub.phase('dryrun',lambda:calls.append('replayed'))
        self.assertEqual(len(calls),3)

    def test_failed_mutation_receipt_cannot_be_hidden_as_successful_readonly_observation(self):
        command={'exitCode':7,'timedOut':False,'originals':{k:{**self.binary('synthetic-failed-'+k,b''),'observedBytes':0,'complete':True} for k in ('stdout','stderr')},'readOnlyMountProbe':False,'argv':['unsafe-patch']}
        self.proof['runtime']['originalCommands'].append(self.file('synthetic-failed-mutation',command)); self.refresh()
        with self.assertRaises(p.Refusal): self.publisher()

    def test_failed_readonly_mount_observation_retains_exact_program_target_and_retired_uid(self):
        prefix=[sys.executable,'-B',str(self.s.host_probe),'mounts','--target',str(m.cohort.local_path(self.s.value['target']['path'],self.s.input_path.parent)),'--pod-uid']
        command={'exitCode':1,'timedOut':False,'originals':{k:{**self.binary('synthetic-mount-wait-'+k,b''),'observedBytes':0,'complete':True} for k in ('stdout','stderr')},'readOnlyMountProbe':True,'argv':[*prefix,'writer-uid']}
        self.proof['runtime']['originalCommands'].append(self.file('synthetic-original-mount-wait',command)); self.refresh(); self.publisher()
        for argv in ([*prefix,'unrelated-uid'],['replacement-program',*prefix[1:],'writer-uid']):
            bad={**command,'argv':argv}; self.proof['runtime']['originalCommands'][-1]=self.file('synthetic-mount-wrong-origin',bad); self.refresh()
            with self.assertRaises(p.Refusal): self.publisher()

    def test_probe_credentials_unknown_host_and_wrong_chunk_bytes_refuse(self):
        for change in (lambda v:v['staticProbes'][0].update(url='https://user:secret@public.example/index.html'),lambda v:v['staticProbes'][0].update(url='https://other.example/index.html'),lambda v:v['staticProbes'][-1].update(sha256='0'*64)):
            old=copy.deepcopy(self.publication_value); change(self.publication_value); self.refresh()
            with self.assertRaises(p.Refusal): self.publisher()
            self.publication_value=old

    def test_next_accepted_previous_is_consumed_by_the_actual_offline_public_baseline_parser(self):
        pub=self.publisher(); pub.out.mkdir(); current=copy.deepcopy(self.before); current['spec']=copy.deepcopy(self.result['desiredSpec']); current['metadata']['resourceVersion']='901'
        pod=f.actual_pod({'apiVersion':'v1','kind':'Pod','metadata':{'name':'new-owner','namespace':'public','labels':{'app':'public'}},'spec':pub.expected_owner_spec},'new-owner-uid')
        replica=copy.deepcopy(self.baseline['replicaSet']); replica['metadata'].update(uid='new-rs-uid',name='new-rs')
        pod['metadata']['ownerReferences']=[{'kind':'ReplicaSet','name':'new-rs','uid':'new-rs-uid','controller':True}]
        owner=self.file('synthetic-new-owning-capture',{'deployment':current,'pod':pod,'replicaSet':replica})
        catalog=self.proof['runtime']['catalog']; tls=self.file('synthetic-new-https',{'verified':True})
        probes={'https://public.example/index.html':{'status':200,'verifiedTlsAndHostname':True}}
        result=pub.accepted_previous(current,pod,replica,self.static,self.hashes,catalog,owner,tls,probes)
        accepted=json.loads(Path(result['path']).read_bytes()); before,files,_,_,_=m.public.baseline(accepted,pub.guard.inputs)
        self.assertEqual(before['spec'],self.result['desiredSpec']); self.assertEqual(files,self.s.effective.files); self.assertEqual(accepted['overlay']['claimUID'],'overlay-uid')
        self.assertEqual(accepted['originalEvidence'][1],self.previous['originalEvidence'][1]); self.assertEqual(len(accepted['originalEvidence']),5)
        # Exercise the whole next preparation, not only its baseline helper.
        # The third source commit and classifiers are genuine; the local build
        # and CI records remain explicitly synthetic fixture originals.
        self.put(self.root,'shells/web/src/main.ts',b'export const title="third";'); next_source=self.commit(); self.sources['lolly']=next_source
        next_lolly=copy.deepcopy(self.lolly); next_lolly['source']=next_source
        next_lolly['main']=self.file('synthetic-next-main',{'ref':'refs/heads/main','object':{'type':'commit','sha':next_source}})
        run=self.ci_run(21,'lolly'); next_lolly['ciRun']=self.file('synthetic-next-run',run)
        jobs=json.loads((self.base/self.lolly['ciJobs']['path']).read_bytes())
        for job in jobs['jobs']: job.update(run_id=run['id'],head_sha=next_source)
        next_lolly['ciJobs']=self.file('synthetic-next-jobs',jobs)
        old={path:(self.s.effective.root/path).read_bytes() for path in files}
        candidate={**old,'index.html':b'third public index','_app/third.js':b'third lazy chunk'}; del candidate['_app/old.js']
        merged={**candidate,'_app/old.js':old['_app/old.js']}
        trees={'previous':self.tree('next-accepted',old),'candidate':self.tree('next-candidate',candidate),'shell':self.tree('next-retained',merged),
               'overlay':self.tree('next-overlay',{path:data for path,data in merged.items() if m.public.overlay_path(path)}),
               'delta':self.tree('next-delta',{path:data for path,data in candidate.items() if old.get(path)!=data})}
        producer=copy.deepcopy(self.producer); producer.update(**trees,lollySource=next_source,previousShellSource=self.source,shellManifestSha256=trees['shell']['manifest']['sha256'],previousAcceptance=accepted['originalEvidence'][0],ci=next_lolly['ciRun'])
        classify=[f.NODE,str(f.HERE/'scripts/classify-application-release.ts'),'--repo',str(self.root),'--base']
        for key,base in (('classification',self.source),('imageClassification',self.image_source)):
            classified=json.loads(subprocess.run([*classify,base,'--candidate',next_source],capture_output=True,check=True).stdout)
            producer[key]=self.file('actual-next-'+key,classified)
        custody=json.loads((self.base/self.producer['custody']['path']).read_bytes())
        custody.update(previousShellSource=self.source,previousManifest=accepted['staticManifest'],previousAcceptance=accepted['originalEvidence'][0],ci=next_lolly['ciRun'])
        producer['custody']=self.file('synthetic-next-producer-custody',custody)
        report=json.loads((self.base/self.producer['originalReport']['path']).read_bytes()); runner=json.loads(Path(report['command'][2]).read_bytes())
        runner.update(sourceCommit=next_source,output=trees['candidate']['root']); runner_ref=self.file('synthetic-next-vite-input',runner)
        report['command'][2:]=[str(self.base/runner_ref['path']),runner_ref['sha256']]; producer['originalReport']=self.file('synthetic-next-vite-report',report)
        for key in ('previous','candidate'):
            report=json.loads((self.base/self.producer['catalog'][key]['path']).read_bytes()); report['command'][3]=trees[key]['root']
            producer['catalog'][key]=self.file('synthetic-next-'+key+'-catalog-report',report)
        selection={**self.selection,'shellClaim':'third-public-shell'}
        desired=m.public.desired_spec({**accepted,'modelsName':'models','nginxName':'nginx'},current,selection,next_source,trees['overlay']['manifest']['sha256'])
        envelope={'version':1,'lolly':next_lolly,'producer':self.file('synthetic-next-producer',producer),'previous':result,'selection':selection,'desiredSpec':self.file('next-requested-desired',desired)}
        next_plan,held=m.public.prepare(envelope,self.base,f.NODE); held.unchanged()
        self.assertEqual(next_plan['sources'],{'shell':next_source,'image':self.image_source}); self.assertEqual(next_plan['selection']['shellClaim'],'third-public-shell')
        self.assertEqual(next_plan['beforeSpecSha256'],self.result['desiredSpecSha256'])
        evidence_ref=self.file('reviewed-synthetic-next-evidence',envelope); evidence_ref['path']=str(self.base/evidence_ref['path'])
        next_plan['reviewedEvidenceSha256']=evidence_ref['sha256']; next_plan['evidence'].append(evidence_ref); next_plan['evidence'].sort(key=lambda r:r['path'])
        prepared_ref=self.file('synthetic-maintained-next-plan',next_plan)
        baseline=copy.deepcopy(self.baseline); baseline.update(owner=pod,replicaSet=replica,pods=f.collection('Pod',[pod]),
            claims=f.collection('PersistentVolumeClaim',[*self.baseline['claims']['items'],self.claim]),pvs=f.collection('PersistentVolume',[*self.baseline['pvs']['items'],self.pv]))
        baseline['deployments']=[current if d['metadata']['namespace']=='public' else d for d in baseline['deployments']]
        stage_value={**self.stage_value,'prepared':prepared_ref,'planningEvidence':evidence_ref,'baseline':self.file('synthetic-complete-next-baseline',baseline),
                     'names':{'writer':'next-writer','qualifier':'next-qualifier','policy':'next-stage'},'outputDirectory':str(self.base/'next-stage-output')}
        stage_ref=self.file('reviewed-synthetic-next-stage-input',stage_value); stage_ref['path']=str(self.base/stage_ref['path'])
        guard=m.Stage(stage_ref['path'],stage_ref['sha256'],m.checksum(f.HERE/'scripts/stage-public-shell.py')); guard.source_check()
        # A complete synthetic retired stage also exercises the subsequent
        # publisher constructor and its exact default-preserving derivation.
        next_claim=copy.deepcopy(guard.desired['shellClaim']); next_claim['metadata'].update(uid='third-claim-uid',resourceVersion='25')
        next_claim['spec']['volumeName']='third-pv'; next_claim['status']={'phase':'Bound'}
        next_pv=copy.deepcopy(self.pv); next_pv['metadata'].update(name='third-pv',uid='third-pv-uid',resourceVersion='26')
        next_pv['spec']['claimRef'].update(name='third-public-shell',uid='third-claim-uid'); next_pv['spec']['local']['path']='/third-isolated-overlay'
        writer=f.actual_pod(guard.desired['writer'],'next-writer-uid'); qualifier=f.actual_pod(guard.desired['qualifier'],'next-qualifier-uid')
        policy=copy.deepcopy(guard.desired['policy']); policy['metadata'].update(uid='next-policy-uid',resourceVersion='27')
        static=self.file('synthetic-next-qualifier-static',{'htmlRoot':m.public.ROOT[1:],'files':{path:{'mode':0o644,'size':row['size'],'sha256':row['sha256']} for path,row in guard.effective.files.items()}})
        hashes=self.binary('synthetic-next-derived-qualifier-hashes',''.join(row['sha256']+'  '+m.public.ROOT+'/'+path+'\n' for path,row in guard.effective.files.items()).encode())
        runtime={**self.proof['runtime'],'inputSha256':guard.input_sha,'operatorSha256':guard.operator_sha,'pod':qualifier,'sources':guard.prepared['sources'],
                 'static':static,'hashes':hashes,'staticManifestSha256':guard.producer['shell']['manifest']['sha256'],'overlayManifestSha256':guard.new.manifest_sha,
                 'rootMetadata':{key:self.metadata_ref('synthetic-next-root-'+key,guard,next_claim,next_pv) for key in ('before','after')}}
        proof={**self.proof,'preparedSha256':prepared_ref['sha256'],'stageInput':stage_ref,'sources':guard.prepared['sources'],'claim':next_claim,'pv':next_pv,'writer':writer,'qualifier':qualifier,'policy':policy,
               'writerMountProof':{**self.proof['writerMountProof'],'podUid':'next-writer-uid'},'qualifierMountProof':{**self.proof['qualifierMountProof'],'podUid':'next-qualifier-uid'},
               'runtime':runtime,'overlayManifestSha256':guard.new.manifest_sha,'staticManifestSha256':guard.producer['shell']['manifest']['sha256']}
        probes=[{'url':'https://public.example/'+path,**guard.effective.files[path]} for path in ['index.html','catalog/tools/index.json','catalog/tools/index.sig.json','_app/third.js']]
        publication={**self.publication_value,'stageInput':stage_ref,'stage':self.file('synthetic-original-next-retired-stage',proof),'staticProbes':probes,'outputDirectory':str(self.base/'next-publication-output')}
        publication_ref=self.file('reviewed-synthetic-next-publication-input',publication)
        next_pub=p.Publication(self.base/publication_ref['path'],publication_ref['sha256'],m.checksum(f.HERE/'scripts/publish-public-shell.py'))
        expected=copy.deepcopy(pod['spec']); expected['volumes'][-1]['persistentVolumeClaim']['claimName']='third-public-shell'
        self.assertEqual(next_pub.expected_owner_spec,expected); self.assertTrue(next_pub.expected_owner_spec['enableServiceLinks'])

    def test_publication_nested_original_evidence_drift_refuses_before_next_phase(self):
        pub=self.publisher(); path=Path(self.hashes['path']); path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaises(p.Refusal): pub.source_check()


if __name__ == '__main__': unittest.main()
