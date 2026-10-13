# SPDX-License-Identifier: MPL-2.0
"""Synthetic read-only ancestry controls; never runtime acceptance."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
SCRIPTS=Path(__file__).resolve().parents[1]/'scripts'
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
l=load('serving_lifecycle',SCRIPTS/'public-delivery-lifecycle.py')
h=load('serving_continuation',SCRIPTS/'public-serving-continuation.py')
class Ancestry(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.base=Path(self.temp.name).resolve(); self.attempt=1
        self.old=self.base/'old'; self.old.mkdir()
        self.value={'version':1,'status':'REVIEWED_PUBLIC_FORWARD_SERVING_OBSERVATION_NOT_EXECUTED',
            'originalInput':self.put(self.base/'original.json',{'outputDirectory':str(self.old)}),
            'originalOperator':self.put(self.base/'publish-public-delivery.py',b'# synthetic unit source; not executed\n'),
            'originalPhases':{},'failedObservation':{},'originalCommands':[], 'failureEvidence':{},
            'sources':[], 'outputDirectory':str(self.base/'attempt-one')}
        binding={'inputSha256':self.value['originalInput']['sha256'],'operatorSha256':self.value['originalOperator']['sha256']}
        for phase,status in [('dryrun','ACTUAL_MATCHED_SERVER_DRYRUN_NOT_PUBLISHED'),('publish','ACTUAL_MATCHED_PATCHED_ACCEPTANCE_PENDING')]:
            self.value['originalPhases'][phase]={
                'started':self.put(self.old/(phase+'.started.json'),{'status':'STARTED_NO_REPLAY',**binding}),
                'accepted':self.put(self.old/(phase+'.accepted.json'),{'status':status,'productionMutation':phase=='publish',**binding})}
        self.value['failedObservation']={'started':self.put(self.old/'observe.started.json',{'status':'STARTED_NO_REPLAY',**binding}),
            'uncertain':self.put(self.old/'observe.uncertain.json',{'status':'REFUSED_NO_REPLAY','failureType':'Refusal'})}
        for key,body in [('process',b'system_u:system_r:container_t:s0:c1,c2\0'),('modelRoot',{'root':{'selinuxLabel':'system_u:object_r:container_file_t:s0:c1,c2'}})]:
            ref=self.command(self.old,key,body); self.value['failureEvidence'][key]=ref; self.value['originalCommands'].append(ref)
        self.value['originalCommands'].sort(key=lambda r:r['path'])
        helper=self.base/'reader/sources/public-serving-continuation.py'; helper.parent.mkdir(parents=True)
        self.value['sources']=[self.put(helper,(SCRIPTS/helper.name).read_bytes()),self.put(self.base/'reader/observe-forward.py',b'# synthetic observer; never executed\n')]
    def tearDown(self):self.temp.cleanup()
    def put(self,path,value):
        body=value if type(value)is bytes else (json.dumps(value)+'\n').encode(); path.write_bytes(body)
        return {'path':str(path),'sha256':hashlib.sha256(body).hexdigest()}
    def command(self,directory,key,body):
        return self.put(directory/('command-'+key+'.actual.json'),{'complete':True,'exitCode':0,'failure':None,
            'stdout':self.put(directory/(key+'.stdout.original'),body),'stderr':self.put(directory/(key+'.stderr.original'),b'')})
    def prior(self):
        previous=copy.deepcopy(self.value); prior_dir=Path(previous['outputDirectory']); prior_dir.mkdir()
        request=self.put(self.base/('prior-'+str(self.attempt)+'.input.json'),previous); source=previous['sources'][1]
        self.attempt+=1; self.value['outputDirectory']=str(self.base/('attempt-'+str(self.attempt)))
        self.value['priorForwardObservation']={'input':request,'operator':source,
            'started':self.put(prior_dir/'observe.started.json',{'status':'STARTED_NO_REPLAY','inputSha256':request['sha256'],'operatorSha256':source['sha256']}),
            'uncertain':self.put(prior_dir/'observe.uncertain.json',{'status':'REFUSED_NO_REPLAY','failureType':'Refusal'}),
            'commands':[self.command(prior_dir,'read',b'synthetic read result')],
            'ownerBefore':self.put(prior_dir/'owner-before.original.json',{'deployment':{},'pod':{},'replicaSet':{}})}
        return prior_dir
    def test_original_and_explicit_prior_failed_journal(self):
        h.request(l,self.value); self.prior(); h.request(l,self.value)
    def test_recursive_failed_attempts_are_bounded_and_keep_trust(self):
        self.prior(); self.prior(); h.request(l,self.value)
        with self.assertRaises(RuntimeError):h.request(l,self.value,depth=8)
        self.value['tlsTrust']={'caFile':self.put(self.base/'unit-roots.pem',b'-----BEGIN CERTIFICATE-----\nsynthetic fixture only\n'),
            'certificateRequired':True,'hostnameVerification':True}
        h.request(l,self.value)
        for field in ['certificateRequired','hostnameVerification']:
            value=copy.deepcopy(self.value);value['tlsTrust'][field]=False
            with self.assertRaises(RuntimeError):h.request(l,value)
        value=copy.deepcopy(self.value);value['tlsTrust']['caFile']['sha256']='0'*64
        with self.assertRaises(RuntimeError):h.request(l,value)
    def test_reader_location_is_not_historical_custody(self):
        path=self.base/'copied-reader.py'; path.write_bytes((SCRIPTS/'public-serving-continuation.py').read_bytes())
        self.assertEqual(load('copied_reader',path).request(l,self.value),h.request(l,self.value))
    def test_missing_or_changed_prior_ancestry_refuses(self):
        self.prior()
        for field in ['input','operator','started','uncertain','ownerBefore']:
            value=copy.deepcopy(self.value); value['priorForwardObservation'][field]['sha256']='0'*64
            with self.subTest(field=field),self.assertRaises(RuntimeError):h.request(l,value)
        value=copy.deepcopy(self.value); value['priorForwardObservation']['commands']=[]
        with self.assertRaises(RuntimeError):h.request(l,value)
    def test_failed_attempt_cannot_be_restamped_successful(self):
        prior_dir=self.prior(); self.put(prior_dir/'observe.accepted.json',{'synthetic':'unexpected success'})
        with self.assertRaises(RuntimeError):h.request(l,self.value)
    def test_unrelated_switch_and_missing_helper_refuse(self):
        self.prior(); value=copy.deepcopy(self.value); value['originalCommands'].pop()
        with self.assertRaises(RuntimeError):h.request(l,value)
        value=copy.deepcopy(self.value); value['sources']=value['sources'][1:]
        with self.assertRaises(RuntimeError):h.request(l,value)
if __name__=='__main__':unittest.main()
