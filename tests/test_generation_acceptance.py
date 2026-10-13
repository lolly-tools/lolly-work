#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic generation protocol fixtures; no real infrastructure or receipts."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('shell_fixture', Path(__file__).with_name('test_prepare_private_shell.py'))
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)
m = f.m


class Generation(f.Shell):
    def setUp(self):
        super().setUp()
        original, context, report = self.authenticated_fixture()
        proof = original['authenticatedCatalogProof']
        read = lambda ref: json.loads((self.base / ref['path']).read_bytes())
        self.owner = read(original['originalEvidence'][0])
        self.content = read(original['originalEvidence'][1])
        self.tls = read(original['originalEvidence'][2])
        before = copy.deepcopy(self.before)
        before['spec']['template']['spec']['volumes'].append({'name':'config', 'configMap':{'name':'generation-2'}})
        before['spec']['template']['spec']['containers'][0]['volumeMounts'].append({'name':'config','mountPath':'/app/config','readOnly':True})
        self.before = before
        self.owner['deployment'] = copy.deepcopy(before)
        self.owner['pod']['spec'] = copy.deepcopy(before['spec']['template']['spec'])
        self.owner['replicaSet']['spec']['template'] = copy.deepcopy(before['spec']['template'])
        self.owner['pod']['status']['containerStatuses'][0]['image'] = 'sha256:' + 'f' * 64  # CRI config alias; manifest imageID is authoritative.
        self.previous['deployment'] = self.file('generation-deployment', before)
        self.previous['deploymentSpecSha256'] = m.cohort.digest(before['spec'])
        config = {'apiVersion':'v1', 'kind':'ConfigMap', 'immutable':True, 'metadata':{'name':'generation-2','namespace':'private','uid':'config-uid','resourceVersion':'9'},'data':{'instance.json':'{"generation":2}'}}
        guard = {'kind':'ConfigMap', **config['metadata'], 'immutable':True, 'dataSha256':m.cohort.digest(config['data'])}
        generation = {'candidate':guard, 'current':{**guard,'name':'generation-1'}, 'generation':2, 'key':'instance.json','volume':'config','path':f"/spec/template/spec/volumes/{len(before['spec']['template']['spec']['volumes'])-1}/configMap/name"}
        sources = {k:v for k,v in context['sources'].items() if k != 'engine'}
        selection = {**context['selection'], 'shellClaim':'old-shell', 'packClaim':'old-pack', 'pinConfigMap':'old-pin'}
        guards = [guard, *[{'kind':'ConfigMap' if family == 'pin' else 'PersistentVolumeClaim','namespace':'private','name':self.previous[family]['name'],'uid':self.previous[family]['uid']} for family in ('shell','pack','pin')]]
        prepared = self.file('generation-qualified-cohort', {'status':m.cohort.STATUS,'sources':sources,'image':self.previous['image'],'enginePinSha256':self.previous['enginePin']['sha256'],'resolverPinSha256':self.previous['resolverPin']['sha256'],'shell':{'manifestSha256':self.previous['shell']['manifestSha256']},'rawPack':{'manifestSha256':self.previous['pack']['manifestSha256']}})
        self.plan = {'sources':sources,'desiredSpec':before['spec'],'desiredSpecSha256':self.previous['deploymentSpecSha256'],'deploymentUID':before['metadata']['uid'],'generationReference':generation,'resourceGuards':guards,'selection':selection,'sourceCohortSha256':prepared['sha256']}
        plan_ref = self.file('generation-plan', self.plan)
        planning_ref = self.file('generation-planning', {'generationActual':self.file('generation-config',config)})
        self.auth_input = {'sourceBindingSha256':report['oracle']['sourceBindingSha256'], 'sourceFiles':[proof['source']], 'prepared':prepared,'refs':{'plan':plan_ref,'enginePin':self.previous['enginePin'],'resolverPin':self.previous['resolverPin']}}
        classifier = self.binary('classifier.ts',b'// synthetic classifier')
        stripped = self.binary('classifier.js',b'// synthetic stripped classifier')
        policy_source = self.binary('snapshot.ts',b'// synthetic byte policy source')
        policy = self.file('asset-byte-policy',{'status':'MAINTAINED_EA_FRONTEND_BYTE_POLICY_SOURCE_ONLY','productionCalls':False,'runtimeQualified':False,'assetMaximumBytes':16*1024**2,'indexMaximumBytes':2*1024**2,'envelopeMaximumBytes':2*1024**2,'slimMaximumBytes':2*1024**2,'source':{'commit':self.engine_source,'repositoryPath':'shells/web/src/catalog/snapshot.ts','file':policy_source}})
        self.auth_input['refs'].update(classifier=classifier,strippedClassifier=stripped,bytePolicy=policy,bytePolicySourceEA=policy_source)
        self.auth_input['sourceFiles'] += [classifier,stripped,policy_source,policy]
        report.update(assetCatalog={'path':'catalog/assets/index.json','url':'https://private.example/catalog/assets/index.json','status':200,'verifiedTlsAndHostname':True,'authentication':'TEMPORARY_MEMORY_SESSION','bytes':123,'sha256':'c'*64,'signedAssetIndexHash':'c'*64,'envelopeSha256':report['oracle']['envelopeSha256'],'signatureVerified':True,'maximumBytes':16*1024**2},bytePolicy=policy,providerMetadata={'status':'EA_DESCRIPTOR_ADMISSION_PASSED','lollySource':self.engine_source,'repositoryPath':'shells/web/src/catalog/asset-integrity.ts','sourceSha256':classifier['sha256'],'strippedSha256':stripped['sha256'],'assetRows':10,'providerAssets':8,'providerFormats':16,'contentFormats':2,'multiFormatProviderAssets':8,'invalidFormats':0,'negativeControls':8,'providerBytesVerified':False,'immutableFilesDownloaded':False,'runtimeQualified':False,'assetIndexSha256':'c'*64,'signedCatalogScope':True})
        proof['input'] = self.file('generation-auth-input', self.auth_input)
        invocation = {'source':proof['source'],'input':proof['input'],'profile':m.AUTH_PROFILE,'argv':['/usr/bin/python3',str(self.base/proof['source']['path']),'--input',str(self.base/proof['input']['path']),'--input-sha256',proof['input']['sha256']]}
        publication = {'version':1,'status':'REVIEWED_PRIVATE_GENERATION_COHORT_PUBLICATION_INPUT','sourceFiles':[proof['source'],proof['input']],'authenticatedStaticProbe':invocation,'refs':{'plan':plan_ref,'generationPlanningInput':planning_ref,'enginePin':self.previous['enginePin'],'shellManifest':context['shellManifest'],'packManifest':context['packManifest']}}
        proof['publicationInput'] = self.file('generation-publication',publication)
        owner_ref = self.file('generation-owner',self.owner)
        context.update(owner=self.owner,ownerEvidence=owner_ref,sources=sources,selection=selection,planSha256=plan_ref['sha256'],publicationInputSha256=proof['publicationInput']['sha256'])
        self.context = context
        proof['context'] = self.file('generation-context',context)
        report.update(contextSha256=m.cohort.digest(context),inputSha256=proof['input']['sha256'])
        self.report = report
        proof['report'] = self.file('generation-report',report)
        proof['command'] = self.file('generation-command',{'returncode':0,'stdout':json.dumps(report),'stderr':''})
        self.tls['authenticatedCatalogProof'] = copy.deepcopy(proof)
        tls_ref = self.file('generation-tls',self.tls)
        self.runtime = {'version':1,'status':'ACTUAL_PRIVATE_COHORT_SOURCE_PIN_GENERATION_PG_READY_READONLY','sources':sources,'image':self.previous['image'],'publicationGeneration':2,'configSha256':hashlib.sha256(config['data']['instance.json'].encode()).hexdigest(),'enginePinSha256':self.previous['enginePin']['sha256'],'resolverPinSha256':self.previous['resolverPin']['sha256'],'engineVersion':'1.248.0','coreVersion':'1.1.0','sourceFiles':2,'storage':'pg','readyStatus':200,'uid':1000,'gid':1000,**{k:True for k in ('bakedMountedPinEqual','productionConfigParsed','schemaMatches','sourceFilesVerified','vendorContentMatches')},**{k:False for k in ('databaseDirectQueries','fileWrites','physicalGpuClaimed','secretValuesPrinted','serviceSpawned')}}
        runtime_ref = self.file('generation-runtime',self.runtime)
        self.generation = {'version':1,'status':'PRIVATE_GENERATION_COHORT_OWNER_CONTENT_AUTHENTICATED_TLS_VERIFIED_FULL_ACCEPTANCE_PENDING','sources':sources,'image':self.previous['image'],'observedImageId':self.previous['image'],'publicationGeneration':2,'configReference':generation,'deploymentUID':before['metadata']['uid'],'deploymentSpecSha256':self.previous['deploymentSpecSha256'],'podUID':self.owner['pod']['metadata']['uid'],'enginePinSha256':self.previous['enginePin']['sha256'],'resolverPinSha256':self.previous['resolverPin']['sha256'],'shellManifestSha256':self.previous['shell']['manifestSha256'],'packManifestSha256':self.previous['pack']['manifestSha256'],'originalEvidence':[owner_ref,original['originalEvidence'][1],tls_ref,runtime_ref,original['originalEvidence'][3],planning_ref,self.binary('generation-observer.py',b'# synthetic inert observer\n')],'authenticatedCatalogProof':proof,'ociImageSignatureClaimed':False,'runtimeAcceptanceComplete':False,'qualificationScope':'REAL_NEW_IMAGE_PINS_SOURCE_NATIVE_STAGE_AND_OWNING_FULL_BYTES_GENERATION_PG_READINESS_NORMAL_TLS','remainingAcceptance':['Export, agent and browser acceptance is separate']}
        self.wrapper = {'version':1,'status':'RUNTIME_ACCEPTED','deploymentUID':before['metadata']['uid'],'deploymentSpecSha256':self.previous['deploymentSpecSha256'],'lollySource':self.engine_source,'workSource':self.previous['workSource'],'image':self.previous['image'],'enginePinSha256':self.previous['enginePin']['sha256'],'shellManifestSha256':self.previous['shell']['manifestSha256'],'packManifestSha256':self.previous['pack']['manifestSha256'],'originalEvidence':[]}
        self.previous = {k:v for k,v in self.previous.items() if k not in ('shellSource','engineSource','resolverPin')}
        self.previous['lollySource'] = self.engine_source

    def parse_generation(self):
        self.wrapper['originalEvidence'] = [self.file('generation-original',self.generation), *self.generation['originalEvidence'][2:4]]
        self.previous['acceptance'] = self.file('generation-wrapper',self.wrapper)
        ref = self.file('generation-previous',self.previous)
        self.evidence['previous'] = ref
        inputs = m.cohort.Inputs(self.base)
        result = m.previous_record(ref,inputs)
        inputs.unchanged()
        return result, inputs

    def test_generation_original_protocol_is_read_without_rewriting_scope(self):
        (view,before),inputs = self.parse_generation()
        self.assertEqual(view['shellSource'],self.engine_source)
        self.assertEqual(view['engineSource'],self.engine_source)
        self.assertNotIn('lollySource',view)
        self.assertEqual(before,self.before)
        self.assertFalse(self.generation['runtimeAcceptanceComplete'])
        self.assertIn('FULL_ACCEPTANCE_PENDING',self.generation['status'])
        self.assertGreater(len(inputs.reads),15)
        self.assertEqual(m.accepted_owner_ids(self.generation,inputs),('accepted-pod-uid','accepted-rs-uid'))
        prepared, checked = self.prepare()
        checked.unchanged()
        self.assertEqual(prepared['status'],m.STATUS)
        self.assertFalse(prepared['qualificationBoundary']['runtimeQualified'])

    def test_original_scope_source_owner_and_pins_tampering_refuses(self):
        baseline=copy.deepcopy(self.generation)
        for mutate in (lambda v:v.update(runtimeAcceptanceComplete=True),lambda v:v.update(ociImageSignatureClaimed=True),lambda v:v.update(remainingAcceptance=[]),lambda v:v['sources'].update(lolly='f'*40),lambda v:v.update(deploymentUID='different'),lambda v:v.update(podUID='different'),lambda v:v.update(observedImageId='wrong'),lambda v:v.update(enginePinSha256='f'*64),lambda v:v.update(resolverPinSha256='f'*64),lambda v:v.update(publicationGeneration=3)):
            with self.subTest(mutate=mutate):
                self.generation=copy.deepcopy(baseline);mutate(self.generation)
                with self.assertRaises(m.Refusal):self.parse_generation()

    def test_consistently_rehashed_owner_runtime_or_content_tampering_refuses(self):
        baseline=copy.deepcopy(self.generation)
        for index,mutate in ((0,lambda v:v['pod']['status']['containerStatuses'][0].update(restartCount=1)),(0,lambda v:v['pod']['metadata']['ownerReferences'][0].update(uid='wrong')),(0,lambda v:v['pod']['spec']['containers'][0]['volumeMounts'][0].update(mountPath='/wrong')),(0,lambda v:v['replicaSet']['spec']['template']['spec']['containers'][0]['volumeMounts'][0].update(subPath='wrong')), (1,lambda v:v['shell']['files'][0].update(sha256='f'*64)),(3,lambda v:v.update(configSha256='f'*64)),(3,lambda v:v.update(schemaMatches=False))):
            with self.subTest(index=index):
                self.generation=copy.deepcopy(baseline)
                self.patch(self.generation['originalEvidence'],index,mutate)
                with self.assertRaises(m.Refusal):self.parse_generation()

    def test_consistent_owner_context_cannot_redirect_protected_mounts(self):
        original, owner, context, report, tls = [copy.deepcopy(v) for v in (self.generation,self.owner,self.context,self.report,self.tls)]
        for kind, field, value in (('pod','mountPath','/wrong'),('pod','subPath','wrong'),('replicaSet','readOnly',False)):
            with self.subTest(kind=kind,field=field):
                self.generation=copy.deepcopy(original)
                changed_owner=copy.deepcopy(owner)
                spec=changed_owner[kind]['spec'] if kind=='pod' else changed_owner[kind]['spec']['template']['spec']
                spec['containers'][0]['volumeMounts'][0][field]=value
                owner_ref=self.file('generation-consistent-wrong-owner',changed_owner)
                self.generation['originalEvidence'][0]=owner_ref
                changed_context=copy.deepcopy(context);changed_context.update(owner=changed_owner,ownerEvidence=owner_ref)
                changed_report=copy.deepcopy(report);changed_report['contextSha256']=m.cohort.digest(changed_context)
                proof=self.generation['authenticatedCatalogProof']
                proof['context']=self.file('generation-consistent-wrong-context',changed_context)
                proof['report']=self.file('generation-consistent-wrong-report',changed_report)
                proof['command']=self.file('generation-consistent-wrong-command',{'returncode':0,'stdout':json.dumps(changed_report),'stderr':''})
                changed_tls=copy.deepcopy(tls);changed_tls['authenticatedCatalogProof']=copy.deepcopy(proof)
                self.generation['originalEvidence'][2]=self.file('generation-consistent-wrong-tls',changed_tls)
                with self.assertRaisesRegex(m.Refusal,'protected owning mount'):
                    self.parse_generation()

    def test_successor_invocation_requires_exact_hash_bound_original_command(self):
        proof=self.generation['authenticatedCatalogProof']
        publication=json.loads((self.base/proof['publicationInput']['path']).read_text())
        invocation=copy.deepcopy(publication['authenticatedStaticProbe'])
        publication['authenticatedStaticProbe']['input']={'path':'old-input.json','sha256':'0'*64}
        proof['publicationInput']=self.file('generation-original-publication-with-old-probe',publication)
        self.context['publicationInputSha256']=proof['publicationInput']['sha256']
        proof['context']=self.file('generation-successor-context',self.context)
        self.report['contextSha256']=m.cohort.digest(self.context)
        proof['report']=self.file('generation-successor-report',self.report)
        proof['command']=self.file('generation-successor-command',{'returncode':0,'stdout':json.dumps(self.report),'stderr':''})
        self.tls['authenticatedCatalogProof']=copy.deepcopy(proof)
        self.generation['originalEvidence'][2]=self.file('generation-successor-tls',self.tls)
        self.generation['originalEvidence'].append(self.file('generation-successor-invocation',invocation))
        self.parse_generation()
        invocation['argv'][-1]='0'*64
        self.generation['originalEvidence'][-1]=self.file('generation-wrong-invocation',invocation)
        with self.assertRaisesRegex(m.Refusal,'original probe invocation differs'):
            self.parse_generation()

    def test_opaque_custody_corruption_refuses_before_json_interpretation(self):
        ref=self.generation['originalEvidence'][-1]
        (self.base/ref['path']).write_bytes(b'# tampered\n')
        with self.assertRaises(m.Refusal):self.parse_generation()

    def test_asset_extension_cannot_claim_unverified_provider_bytes(self):
        changed=copy.deepcopy(self.report);changed['providerMetadata']['providerBytesVerified']=True
        proof=self.generation['authenticatedCatalogProof']
        proof['report']=self.file('generation-bad-assets-report',changed)
        proof['command']=self.file('generation-bad-assets-command',{'returncode':0,'stdout':json.dumps(changed),'stderr':''})
        self.tls['authenticatedCatalogProof']=copy.deepcopy(proof)
        self.generation['originalEvidence'][2]=self.file('generation-bad-assets-tls',self.tls)
        with self.assertRaises(m.Refusal):self.parse_generation()

    def test_consistently_rehashed_command_oracle_tampering_refuses(self):
        changed=copy.deepcopy(self.report);changed['oracle']['signatureVerified']=False
        proof=self.generation['authenticatedCatalogProof']
        proof['report']=self.file('generation-bad-report',changed)
        proof['command']=self.file('generation-bad-command',{'returncode':0,'stdout':json.dumps(changed),'stderr':''})
        self.tls['authenticatedCatalogProof']=copy.deepcopy(proof)
        self.generation['originalEvidence'][2]=self.file('generation-bad-tls',self.tls)
        with self.assertRaises(m.Refusal):self.parse_generation()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Generation(name) for name in Generation.__dict__ if name.startswith('test_'))
if __name__ == '__main__':unittest.main()
