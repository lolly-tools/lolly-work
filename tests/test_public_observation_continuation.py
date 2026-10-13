# SPDX-License-Identifier: MPL-2.0
"""Synthetic transport/owner fixtures; real hashes and receipt validation, no targets."""
import contextlib,copy,hashlib,importlib.util,io,json,time,unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
S=Path(__file__).resolve().parents[1]/'scripts'
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
h=load('repeat_models',S/'public-delivery-model-http.py')
c=load('repeat_continuation',S/'continue-public-observation.py')
f=load('repeat_lifecycle_fixture',Path(__file__).with_name('test_public_delivery_lifecycle.py'));l=f.l

def transport(rows):
 bodies={r['url']:b'abc' if r['size']==3 else bytes(i%251 for i in range(r['size'])) for r in rows};calls=[]
 def request(origin,method,path,headers,maximum,origin_header='https://lolly.ing'):
  row=next((r for r in rows if r['url']==path),None);body=b'';status=200
  if path=='/healthz': body=b'ok\n';heads={}
  elif row is None: status=404;heads={'cache-control':h.PRIVATE,'cdn-cache-control':'no-store'}
  else:
   size=row['size'];etag='"'+row['sha256']+'"';heads={'cache-control':h.REVALIDATE,'cdn-cache-control':'max-age=0, must-revalidate, no-transform','etag':etag,'access-control-allow-origin':'*','access-control-allow-methods':h.CORS_METHODS,'access-control-allow-headers':h.CORS_HEADERS,'access-control-expose-headers':h.CORS_EXPOSE,'x-content-type-options':'nosniff','content-length':str(size),'accept-ranges':'bytes'}
   if method=='OPTIONS':status=204;heads['content-length']='0'
   elif method=='HEAD':pass
   elif headers.get('If-None-Match') in (etag,'W/'+etag):status=304
   elif 'Range'in headers and headers.get('If-Range',etag)==etag:
    a,b=map(int,headers['Range'][6:].split('-'))
    if a>=size:
     status=416;heads={k:v for k,v in heads.items() if k.startswith('access-control-')};heads.update({'cache-control':h.PRIVATE,'cdn-cache-control':'no-store','content-range':f'bytes */{size}'})
    else:status=206;body=bodies[path][a:b+1];heads.update({'content-length':str(len(body)),'content-range':f'bytes {a}-{b}/{size}'})
   else:body=bodies[path]
  calls.append((method,path,dict(headers),len(body)));assert len(body)<=maximum
  return {'status':status,'headers':heads,'originalHeaders':[[k,v]for k,v in heads.items()],'knownDuplicateCors416':False,'size':len(body),'sha256':hashlib.sha256(body).hexdigest(),'prefix':body[:32]}
 return request,calls

def config(size=70000):
 body=b'abc'if size==3 else bytes(i%251 for i in range(size));rows=[{'url':'/models/ocr/model.onnx','size':size,'sha256':hashlib.sha256(body).hexdigest()}]
 return {'version':1,'origin':'https://unit.invalid','files':rows,'inventorySha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()}

class ReadOnlyCLI(unittest.TestCase):
 def test_mutation_actions_refused_before_constructor(self):
  for action in ['apply','publish','rollback','create','delete','retire']:
   with self.subTest(action=action),patch.object(c.sys,'argv',['continue-public-observation.py',action]),patch.object(c,'Continuation',side_effect=AssertionError('No constructor for a write action')),contextlib.redirect_stderr(io.StringIO()):
    with self.assertRaises(SystemExit)as result:c.main()
    self.assertEqual(result.exception.code,2)

class HttpRepeat(unittest.TestCase):
 def setUp(self):
  self.x=config();self.request,self.calls=transport(self.x['files'])
  with patch.object(h,'request',self.request):self.original=h.verify(self.x)
 def test_only_large_bodies_reused_fresh_real_range_hashes_and_policies(self):
  self.calls.clear()
  with patch.object(h,'request',self.request):fresh=h.verify_repeat(self.x,self.original)
  self.assertEqual(fresh['status'],'SAME_OWNER_MODEL_HTTP_PROTOCOL_RECHECK_WITH_EXPLICIT_BODY_REUSE')
  self.assertTrue(fresh['rows'][0]['largeFullBodyProofReused']);self.assertLess(sum(r[3]for r in self.calls),1024)
  self.assertEqual(sum(r[0]=='GET'and'Range'in r[2]for r in self.calls),4)
  with patch.object(h,'request',side_effect=AssertionError('network forbidden')):h.validate_repeat_report(self.x,self.original,fresh)
 def test_small_files_still_get_two_complete_bodies(self):
  x=config(3);request,calls=transport(x['files'])
  with patch.object(h,'request',request):old=h.verify(x);calls.clear();fresh=h.verify_repeat(x,old)
  self.assertFalse(fresh['rows'][0]['largeFullBodyProofReused']);self.assertEqual(sum(v[3]==3 for v in calls),6)
  h.validate_repeat_report(x,old,fresh)
 def test_changed_bytes_redirect_cache_policy_and_interruption_refuse(self):
  for kind in ['body','redirect','etag','cache','interrupt']:
   def changed(*a,**kw):
    if kind=='interrupt':raise OSError('interrupted')
    v=self.request(*a,**kw)
    if kind=='body'and v['status']==206:v['sha256']='a'*64
    if kind=='redirect':v['status']=302
    if kind=='etag':v['headers']['etag']='"wrong"'
    if kind=='cache':v['headers']['cache-control']='public'
    return v
   with self.subTest(kind=kind),patch.object(h,'request',changed),self.assertRaises((RuntimeError,OSError)):h.verify_repeat(self.x,self.original)
 def test_original_or_fresh_receipt_tampering_refuses(self):
  for change in [lambda r:r.update(status='INCOMPLETE'),lambda r:r['rows'][0]['responses'].pop(6),lambda r:r['rows'][0].update(sha256='b'*64)]:
   original=copy.deepcopy(self.original);change(original)
   with self.assertRaises(RuntimeError):h.verify_repeat(self.x,original)
  with patch.object(h,'request',self.request):fresh=h.verify_repeat(self.x,self.original)
  for change in [lambda r:r['rows'][0]['responses'].pop(0),lambda r:r['healthResponse'].update(sha256='a'*64),lambda r:r['rows'][0]['responses'][-2].update(sha256='a'*64)]:
   changed=copy.deepcopy(fresh);change(changed)
   with self.assertRaises((RuntimeError,StopIteration,KeyError)):h.validate_repeat_report(self.x,self.original,changed)

class Custody(unittest.TestCase):
 def setUp(self):
  self.f=f.PublicationHandoff();self.f.setUp();fixture=self.f
  self.cp=copy.deepcopy(fixture.proof);phase=l.held(self.cp['phases']['observe']['accepted']);Path(self.cp['phases']['observe']['accepted']['path']).unlink()
  rows=l.held(fixture.f.models)['files'];x={'version':1,'origin':'https://unit.invalid','files':rows,'inventorySha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()};request,_=transport(rows)
  with patch.object(h,'request',request):original=h.verify(x)
  fixture.replace(phase['evidence']['modelsTLS'],lambda v:(v.clear(),v.update(original)))
  owner=l.serving_binding(fixture.bundle,fixture.prepared,'customer-node');self.owner=owner
  proc={'container':'1'*64,'pid':44,'startedTicks':123,'bootId':'12345678-1234-1234-1234-123456789012','net':[4,5],'mount':[4,6],'exe':[4,7],'root':[4,8]};self.process=proc
  stdout=fixture.save('process.stdout.original',proc);empty=fixture.out/'process.stderr.original';empty.write_bytes(b'')
  self.process_command=fixture.save('command-process.actual.json',{'argv':c.host_argv({'transport':{'type':'local'}},c.process_program('1'*64)),'exitCode':0,'failure':None,'complete':True,'stdout':stdout,'stderr':{'path':str(empty),'sha256':l.a.checksum(empty)}})
  first=fixture.save('command-process-first.actual.json',l.held(self.process_command));phase['commands'].insert(0,first)
  phase.update(ownerProcessBefore={'command':first,'value':proc},status='ACTUAL_FRONTEND_ROOT_SERVING_CHECKPOINT_NOT_ACCEPTANCE',completedAtUnixNs=time.time_ns(),ownerProcess={'command':self.process_command,'value':proc});phase['commands'].append(self.process_command)
  self.cp['phases']['observe']['accepted']=fixture.save('observe.checkpoint.actual.json',phase)
  uncertain=fixture.save('observe.uncertain.json',{'status':'REFUSED_NO_REPLAY','failureType':'RuntimeError'})
  self.input={'version':1,'status':c.STATUS,'checkpointProof':self.cp,'failedObservation':{'started':self.cp['phases']['observe']['started'],'uncertain':uncertain},'originalCommands':[{'path':str(p),'sha256':l.a.checksum(p)}for p in sorted(fixture.out.glob('command-*.actual.json'))],'outputDirectory':str(fixture.f.base/'repeat')}
  self.operator={'path':str(S/'continue-public-observation.py'),'sha256':l.a.checksum(S/'continue-public-observation.py')}
 def tearDown(self):self.f.tearDown()
 def binding(self,value=None):return c.binding(l,{'input':self.f.f.put(value or self.input),'operator':self.operator})
 def test_checkpoint_is_not_acceptance_and_original_failure_remains(self):
  b=self.binding();self.assertEqual(b['baseline']['status'],'FULL_PUBLIC_OBSERVATION_CHECKPOINT_NOT_ACCEPTANCE')
  self.assertEqual(b['owner'],self.owner);self.assertEqual(b['process'],self.process)
  with self.assertRaises(l.a.Refusal):l.publication_baseline(self.cp)
  self.assertTrue((self.f.out/'observe.uncertain.json').exists());self.assertFalse((self.f.out/'observe.accepted.json').exists())
 def test_missing_source_command_accepted_attempt_rollback_and_other_owner_refuse(self):
  for change in [lambda x:x['originalCommands'].pop(),lambda x:x['checkpointProof']['operator'].update(sha256='a'*64),lambda x:x.update(outputDirectory=str(self.f.out)),lambda x:x['failedObservation']['uncertain'].update(path=str(self.f.out/'wrong.json'))]:
   v=copy.deepcopy(self.input);change(v)
   with self.assertRaises((RuntimeError,FileNotFoundError)):self.binding(v)
  for name in ['observe.accepted.json','rollback.started.json','handoff.started.json']:
   p=self.f.out/name;p.write_bytes(b'{}')
   with self.assertRaises(RuntimeError):self.binding()
   p.unlink()
  self.f.replace(l.held(self.cp['phases']['observe']['accepted'])['evidence']['ownerAfter'],lambda v:v['pod']['status']['containerStatuses'][0].update(restartCount=1))
  with self.assertRaises(RuntimeError):self.binding()
 def test_native_source_script_or_pid_proof_tampering_refuses(self):
  b=self.binding();sample=l.held(self.cp['phases']['observe']['accepted'])['ownerProcess'];commands=[self.process_command];target={'transport':{'type':'local'}}
  for field in ['pid','startedTicks','bootId','net','mount','exe','root','container']:
   v=copy.deepcopy(sample);v['value'][field]='changed'
   with self.subTest(field=field),self.assertRaises(RuntimeError):c.verify_process(l,v,commands,self.owner,target)
  row=l.held(self.process_command);row['argv'][-1]+='\nprint("altered")';new=self.f.f.put(row);sample={**sample,'command':new}
  with self.assertRaises(RuntimeError):c.verify_process(l,sample,[new],self.owner,target)
 def repeated_fixture(self):
  request={'input':self.f.f.put(self.input),'operator':self.operator};bound=c.binding(l,request)
  out=Path(self.input['outputDirectory']);out.mkdir();cp=l.held(self.cp['phases']['observe']['accepted'])
  def save(name,value):
   path=out/name;path.write_bytes(l.raw(value)+b'\n');return {'path':str(path),'sha256':l.a.checksum(path)}
  evidence={}
  for key,ref in cp['evidence'].items():
   evidence[key]=ref if key=='modelsTLS'else save(Path(ref['path']).name,l.held(ref))
  rows=l.held(self.f.f.models)['files'];cfg={'version':1,'origin':'https://unit.invalid','files':rows,'inventorySha256':l.held(evidence['modelsTLS'])['inventorySha256']};transport_request,_=transport(rows)
  with patch.object(h,'request',transport_request):fresh=h.verify_repeat(cfg,l.held(evidence['modelsTLS']))
  evidence['modelsRepeatTLS']=save('owning-models-repeat-tls.actual.json',fresh)
  empty=out/'empty.original';empty.write_bytes(b'');empty_ref={'path':str(empty),'sha256':l.a.checksum(empty)}
  def command(name):
   stdout=save(name+'.stdout.original',self.process)
   return save('command-'+name+'.actual.json',{'argv':c.host_argv({'transport':{'type':'local'}},c.process_program('1'*64)),'exitCode':0,'complete':True,'failure':None,'stdout':stdout,'stderr':empty_ref})
  first,last=command('first'),command('last');start={'status':'STARTED_NO_REPLAY','inputSha256':request['input']['sha256'],'operatorSha256':request['operator']['sha256']}
  now=cp['completedAtUnixNs']+1000
  observed={k:copy.deepcopy(v)for k,v in cp.items()if k not in {'completedAtUnixNs','ownerProcess','ownerProcessBefore'}}
  observed.update(status='ACTUAL_FRONTEND_ROOT_REPEAT_SERVING_VERIFIED',inputSha256=start['inputSha256'],operatorSha256=start['operatorSha256'],commands=[first,last],evidence=evidence,
   repeatWindow={'startedAtUnixNs':now,'completedAtUnixNs':now+1000,'elapsedMonotonicNs':1000,'processBefore':{'command':first,'value':self.process},'processAfter':{'command':last,'value':self.process}})
  proof=copy.deepcopy(self.cp);proof['repeat']=request;proof['phases']['observe']={'started':save('observe.started.json',start),'accepted':save('observe.accepted.json',observed)}
  return proof,observed,save
 def test_complete_distinct_continuation_accepted_without_erasing_failure(self):
  proof,observed,save=self.repeated_fixture()
  with patch.object(h,'request',side_effect=AssertionError('Historical validation is read-only')):result=l.publication_baseline(proof)
  self.assertEqual(result['status'],'ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED');self.assertEqual(result['publication'],proof)
  self.assertTrue((self.f.out/'observe.uncertain.json').exists());self.assertFalse((self.f.out/'observe.accepted.json').exists())
 def test_repeated_owner_process_bytes_freshness_and_protocol_changes_refuse(self):
  proof,observed,save=self.repeated_fixture()
  changes=[lambda v:v['physical']['models'].update(modelInodeFingerprint='b'*64),lambda v:v['repeatWindow'].update(completedAtUnixNs=v['repeatWindow']['startedAtUnixNs']+c.MAX_AGE_NS+1),lambda v:v['repeatWindow'].update(elapsedMonotonicNs=2_000_000_000),lambda v:v['repeatWindow'].update(processAfter=v['repeatWindow']['processBefore']),lambda v:v['commands'].reverse(),lambda v:v.update(deploymentUID='another-owner')]
  for index,change in enumerate(changes):
   value=copy.deepcopy(observed);change(value);proof['phases']['observe']['accepted']=save('observe.accepted.json',value)
   with self.subTest(index=index),self.assertRaises(RuntimeError):l.publication_baseline(proof)
  proof['phases']['observe']['accepted']=save('observe.accepted.json',observed)
  altered=l.held(observed['evidence']['modelsRepeatTLS']);altered['rows'][0]['responses'].pop(0)
  observed['evidence']['modelsRepeatTLS']=save('owning-models-repeat-tls.actual.json',altered);proof['phases']['observe']['accepted']=save('observe.accepted.json',observed)
  with self.assertRaises(RuntimeError):l.publication_baseline(proof)
 def test_freshness_strict_boundary_and_clock_backwards(self):
  for age in [0,c.MAX_AGE_NS]:c.fresh_window(l.need,100,100+age)
  for now in [99,100+c.MAX_AGE_NS+1,True,None]:
   with self.assertRaises(RuntimeError):c.fresh_window(l.need,100,now)

class AcceptedStage(Custody):
 def accepted_fixture(self):
  cp=l.held(self.cp['phases']['observe']['accepted']); original=copy.deepcopy(self.cp)
  phase={k:copy.deepcopy(v) for k,v in cp.items() if k not in {'completedAtUnixNs','ownerProcess','ownerProcessBefore'}}
  phase['status']='ACTUAL_FRONTEND_ROOT_SERVING_VERIFIED'
  (self.f.out/'observe.uncertain.json').unlink()
  original['phases']['observe']['accepted']=self.f.save('observe.accepted.json',phase)
  accepted=l.publication_baseline(original);accepted_ref=self.f.f.put(accepted)
  request=self.f.f.put({'version':1,'status':c.STAGE_STATUS,'acceptedRelease':accepted_ref,'checkpointProof':self.cp})
  prepared=copy.deepcopy(self.f.prepared);prepared['refs']['acceptedRelease']=accepted_ref
  prepared['refs']['deployment']=self.f.f.put(self.f.bundle['deployment'])
  baseline=l.held(prepared['refs']['baseline']);baseline['pods']['items']=[self.f.bundle['pod']];prepared['refs']['baseline']=self.f.f.put(baseline)
  runtime=l.held(l.held(original['input'])['stageInput']);target=l.held(runtime['target']);context=l.held(runtime['context'])
  context.update(owner=self.f.bundle['pod'],replicaSet=self.f.bundle['replicaSet'])
  return request,prepared,target,context
 def test_successful_checkpoint_binds_current_owner_and_full_prior_protocol(self):
  request,prepared,target,context=self.accepted_fixture();bound=c.stage_binding(l,request,prepared,target,context)
  self.assertEqual(bound['process'],self.process);self.assertEqual(bound['physical'],l.held(self.cp['phases']['observe']['accepted'])['physical']['models'])
  self.assertEqual(bound['modelsTLS']['status'],'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY')
 def test_replacement_owner_configuration_storage_or_acceptance_refused(self):
  request,prepared,target,context=self.accepted_fixture()
  cases=[]
  value=copy.deepcopy(context);value['owner']['status']['containerStatuses'][0]['containerID']='containerd://'+'f'*64;cases.append((prepared,target,value))
  value=copy.deepcopy(context);value['origin']='https://other.invalid';cases.append((prepared,target,value))
  value=copy.deepcopy(prepared);value['refs']['configs']=self.f.f.put([]);cases.append((value,target,context))
  value=copy.deepcopy(prepared);base=l.held(value['refs']['baseline']);base['pvs']['items'][0]['metadata']['uid']='changed';value['refs']['baseline']=self.f.f.put(base);cases.append((value,target,context))
  for args in cases:
   with self.subTest(args=args),self.assertRaises((RuntimeError,KeyError)):c.stage_binding(l,request,*args)
  value=l.held(request);value['acceptedRelease']=self.f.f.put({});bad=self.f.f.put(value)
  with self.assertRaises(RuntimeError):c.stage_binding(l,bad,prepared,target,context)
 def test_pending_failed_or_completed_rollback_invalidates_successful_checkpoint(self):
  request,prepared,target,context=self.accepted_fixture()
  for name in ['rollback-intent.started.json','rollback.started.json','rollback.accepted.json','rollback.uncertain.json']:
   marker=self.f.out/name;marker.write_text('{}')
   with self.subTest(name=name),self.assertRaises(RuntimeError):c.stage_binding(l,request,prepared,target,context)
   marker.unlink()
 def test_real_stage_bookends_and_admission_preserve_prior_phase_commands(self):
  request,prepared,target,context=self.accepted_fixture();bound=c.stage_binding(l,request,prepared,target,context)
  out=self.f.f.base/'stage-reuse';out.mkdir()
  def save(name,value):
   path=out/name;path.write_bytes(l.raw(value)+b'\n');return {'path':str(path),'sha256':l.a.checksum(path)}
  runtime={'version':1,'status':'REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED','prepared':self.f.f.put(prepared),'target':self.f.f.put(target),'context':self.f.f.put(context),'programs':{},'sources':l.held(prepared['refs']['adapterReview'])['sources'],'outputDirectory':str(out),'modelReuse':request}
  runtime_ref=self.f.f.put(runtime)
  stage=SimpleNamespace(before=l.held(prepared['refs']['deployment']),owner=context['owner'],replica=context['replicaSet'],target=target,path=Path(runtime_ref['path']),input_sha=runtime_ref['sha256'],events=[self.process_command])
  empty=out/'empty.original';empty.write_bytes(b'');emptyref={'path':str(empty),'sha256':l.a.checksum(empty)}
  def host(code):
   number=len(stage.events);stdout=save(str(number)+'.stdout.original',self.process)
   ref=save('command-'+str(number)+'.actual.json',{'argv':c.host_argv(target,code),'exitCode':0,'complete':True,'failure':None,'stdout':stdout,'stderr':emptyref});stage.events.append(ref)
   return l.raw(self.process)
  stage.host_python=host
  start=c.stage_begin(stage,bound,bound['physical'])
  cfg={'version':1,'origin':context['origin'],'files':bound['models'],'inventorySha256':bound['modelsTLS']['inventorySha256']};transport_request,_=transport(cfg['files'])
  with patch.object(h,'request',transport_request):fresh=h.verify_repeat(cfg,bound['modelsTLS'])
  http=save('models-http.original.json',fresh);proof=c.stage_finish(stage,bound,start,bound['physical'],http)
  self.assertEqual(proof['commands'],stage.events[1:]);self.assertNotIn(self.process_command,proof['commands'])
  phase=save('qualify.accepted.json',{'phase':'qualify','commands':stage.events})
  receipt={'prepared':runtime['prepared'],'adapter':l.held(prepared['refs']['adapterReview'])['source'],'phases':[None]*4+[phase]}
  model={'reuse':save('model-reuse.actual.json',proof)}
  self.assertEqual(c.stage_admit(l,prepared,receipt,model),runtime_ref)
  for change in [lambda v:v['commands'].reverse(),lambda v:v['physical'].update(modelInodeFingerprint='f'*64),lambda v:v['window'].update(elapsedMonotonicNs=3_000_000_000),lambda v:v.update(runtimeInput=self.f.f.put({**runtime,'modelReuse':self.f.f.put({})}))]:
   changed=copy.deepcopy(proof);change(changed);model['reuse']=save('model-reuse.actual.json',changed)
   with self.assertRaises(RuntimeError):c.stage_admit(l,prepared,receipt,model)
 def test_successful_window_is_explicit_24h_retry_remains_15m(self):
  self.assertEqual(c.MAX_STAGE_AGE_NS,24*3600*10**9);self.assertEqual(c.MAX_AGE_NS,900*10**9)
  for age in [0,c.MAX_STAGE_AGE_NS]:c.stage_window(l,100,100+age)
  for now in [99,100+c.MAX_STAGE_AGE_NS+1,True]:
   with self.assertRaises(RuntimeError):c.stage_window(l,100,now)

if __name__=='__main__':unittest.main()
