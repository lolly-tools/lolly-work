# SPDX-License-Identifier: MPL-2.0
"""Explicit forward-only writer-retirement lineage. No target calls or mutation."""
import hashlib,json,shlex,gzip
from pathlib import Path

def validate(l, value, prepared):
    held,need,exact=l.held,l.need,l.exact
    exact(value,{'version','status','originalInput','originalSource','create','copy','retireStarted','retireUncertain','physical','delete','absent','failedProbe','captures'})
    need(value['version']==1 and value['status']=='REVIEWED_FORWARD_WRITER_RETIREMENT_NOT_EXECUTED','Closed forward-only lineage required')
    original=held(value['originalInput']);source=value['originalSource'];l.a.read_ref(source)
    need(source in original['sources'] and Path(source['path']).name=='stage-public-delivery.py','Original source closure required')
    for source_ref in original['sources']:l.a.read_ref(source_ref)
    old=held(original['prepared']);adapter=held(old['refs']['adapterReview'])
    need(adapter['source']==source and adapter['sources']==original['sources'],'Original reviewed adapter differs')
    stable=set(old)-{'preparer','preparationInput','refs'}
    need({k:old[k]for k in stable}=={k:prepared[k]for k in stable},'Continuation changes actual resources/spec/content')
    need({k:v for k,v in old['refs'].items()if k not in {'adapterReview','capacityReview'}}=={k:v for k,v in prepared['refs'].items()if k not in {'adapterReview','capacityReview'}},'Continuation changes protected input custody')
    directory=Path(original['outputDirectory'])
    exact(value['captures'],FILES)
    for name,capture in value['captures'].items():
        need(capture['path']==str(directory/name),'Exact original capture path required');l.a.read_ref(capture)
    for phase in ('create','copy'):
        need(not (directory/(phase+'.uncertain.json')).exists(),'Uncertain original phase cannot be adopted')
        need(value[phase]['path']==str(directory/(phase+'.accepted.json')),'Original phase path required')
        accepted=held(value[phase]);exact(accepted,{'version','phase','status','prepared','source','commands'})
        need(accepted['version']==1 and accepted['phase']==phase and accepted['status']=='ACTUAL_PHASE_ACCEPTED' and accepted['prepared']==original['prepared'] and accepted['source']==source,'Only original successful create/copy may be adopted')
        need(accepted['commands'],'Original actual phase commands required')
        for command_ref in accepted['commands']:command(l,command_ref,directory)
    need(value['retireStarted']['path']==str(directory/'retire-writer.started.json') and value['retireUncertain']['path']==str(directory/'retire-writer.uncertain.json'),'Original failed phase must remain visible')
    started,uncertain=held(value['retireStarted']),held(value['retireUncertain'])
    need(started=={'status':'STARTED_NO_REPLAY','inputSha256':value['originalInput']['sha256'],'operatorSha256':source['sha256']} and uncertain=={'status':'REFUSED_NO_REPLAY','failureType':'Refusal','inputSha256':value['originalInput']['sha256']},'Exact failed attempt required')
    need(not (directory/'retire-writer.accepted.json').exists(),'Original failed phase cannot be relabeled completed')
    writer=held(value['captures']['create-writer.original.json']);uid=writer['metadata']['uid'];name=writer['metadata']['name'];ns=writer['metadata']['namespace']
    physical=command(l,value['physical'],directory);deleted=command(l,value['delete'],directory);absent=command(l,value['absent'],directory)
    failed=held(value['failedProbe']);need(Path(value['failedProbe']['path']).parent==directory,'Failed command must remain in original journal');need(failed.get('exitCode')==1 and failed.get('complete')is True,'Original failed read-only probe required')
    for key in ('stdout','stderr'):
        need(Path(failed[key]['path']).parent==directory,'Failed original command stream escaped journal');l.a.read_ref(failed[key])
    need(Path(failed['argv'][0]).is_absolute() and failed['argv'][1:]==['-B',original['programs']['hostProbe']['path'],'mounts','--target',original['target']['path'],'--pod-uid',uid],'Exact original failing read-only probe required')
    def tail(row):return shlex.split(row['argv'][-1])
    need(tail(physical)[-10:]==['exec','-i','-n',ns,name,'-c','writer','--','/bin/sh','-s'],'Exact original physical writer scan required')
    need(tail(deleted)[-5:]==['delete','--raw','/api/v1/namespaces/'+ns+'/pods/'+name,'-f','-'],'Only exact original writer delete may be adopted')
    response=held(deleted['stdout']);need(response['metadata']['uid']==uid and response['metadata']['name']==name and response['metadata']['namespace']==ns and response['metadata'].get('deletionTimestamp'),'Original successful deletion response UID differs')
    need(tail(absent)[-8:]==['get','pod',name,'-n',ns,'--ignore-not-found','-o','json'] and l.a.read_ref(absent['stdout'])==b'','Original post-delete absence required')
    # Recheck actual physical proof, never infer intact bytes from copy success.
    import importlib.util
    spec=importlib.util.spec_from_file_location('continuation_native',Path(__file__).with_name('public-delivery-native.py'));native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
    data=l.a.read_ref(physical['stdout']);data=gzip.decompress(data) if physical['stdout']['path'].endswith('.gz') else data
    need(len(data)==physical['decoded']['stdout']['size'] and hashlib.sha256(data).hexdigest()==physical['decoded']['stdout']['sha256'],'Complete original decoded physical proof differs')
    native.physical(data,held(prepared['manifest'])['files'])
    return {'input':original,'prepared':old,'directory':directory,'writerUID':uid,'writer':writer}

def command(l,ref,directory):
    need=l.need;row=l.held(ref)
    need(Path(ref['path']).parent==directory and row.get('exitCode')==0 and row.get('failure')is None and row.get('complete')is True,'Successful original command in original journal required')
    for key in ('stdout','stderr'):
        need(Path(row[key]['path']).parent==directory,'Original command stream escaped journal');l.a.read_ref(row[key])
    return row

def ref(path):return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}

# Original immutable resource captures reused by the unchanged remaining bodies.
FILES={'create-policy.original.json','create-claim.original.json','create-writer.original.json','allocation.original.json','bound.original.json','root-after-writer.original.json','global-before.actual.json','create.details.actual.json','copy.details.actual.json'}
