#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Read-only original matched-release custody for later frontend baselines.

No historical Python is executed. The maintained lifecycle rederives resources
and consumes original stage/publication proof using these narrow OCI helpers.
This module does not expose matched preparation or deployment commands.
"""
from __future__ import annotations
import base64, copy, hashlib, importlib.util, json, re
from pathlib import Path
q=importlib.util.spec_from_file_location('matched_assembly',Path(__file__).with_name('assemble-public-delivery.py'))
a=importlib.util.module_from_spec(q);q.loader.exec_module(a)
need,exact,raw=a.need,a.exact,a.raw

def held(ref):return a.parsed(a.read_ref(ref))
def digest(v):return hashlib.sha256(raw(v)).hexdigest()
def model_rows(value):
    rows=value['files'] if type(value)is dict else value
    need(type(rows)is list and 0 < len(rows) <= 10000,'A complete bounded model recipe is required')
    seen=set()
    for r in rows:
        exact(r,{'url','size','sha256'})
        need(type(r['url'])is str and r['url'].startswith('/models/') and not any(x in {'','.','..'} for x in r['url'][1:].split('/'))
             and r['url'] not in seen and type(r['size'])is int and r['size']>=0 and re.fullmatch('[a-f0-9]{64}',r['sha256']),'Closed unique model recipe')
        seen.add(r['url'])
    return sorted(rows,key=lambda r:r['url'])

def model_config(before,after,models,previous_models):
    need(model_rows(models)==model_rows(previous_models),'Any model row change requires a different deployment protocol')
    need(type(before)is list and len(before)==1 and type(after)is list and len(after)==1,'Exactly one existing native ConfigMap')
    left,right=before[0],after[0]
    need(left.get('kind')==right.get('kind')=='ConfigMap' and left.get('immutable')is True and right.get('immutable')is True
         and left.get('data')==right.get('data') and not left.get('binaryData') and not right.get('binaryData')
         and all(left['metadata'].get(k)==right['metadata'].get(k) for k in ['name','namespace']),
         'Keep all existing native Nginx config bytes and selected ConfigMap; new runtime is qualified separately')
    need(set(left['data'])=={'default.conf','security-headers.conf','delivery-maps.conf','delivery-headers.conf'},'All four selected native config leaves')
    return True

def retained_union(native,old,map_row):
    """All old immutable WIRE bytes win only where underlying identity is equal.

    The final root must also pass full gzip/br decoding and map recompilation.
    An immutable identity collision always refuses, including same-size changes.
    """
    rows=dict(native);restored=[];added=[]
    for path,row in old.items():
        if not a.immutable(path):continue
        if path not in rows:rows[path]=row;added.append(path);continue
        if rows[path]==row:continue
        identity=a.overlay.coding_identity(path)
        need(identity is not None and native.get(identity)==old.get(identity) and identity in native,
             'Immutable identity differs; cannot repair by replacing encoded bytes')
        rows[path]=row;restored.append(path)
    rows[a.overlay.MAP]=map_row
    a.overlay.coding_pairs(rows)
    need(all(rows.get(p)==r for p,r in old.items() if a.immutable(p)), 'Every retained immutable wire row must stay exact')
    return rows,sorted(added),sorted(restored)

def accepted(value,before,refs):
    exact(value,{'version','status','originalAcceptance','originalStageInput','models','configs','publicPin'})
    need(value['version']==3 and value['status']=='DERIVED_0359_ACCEPTED_BASELINE_NOT_NEW_ACCEPTANCE'
         ,
         'Original bootstrap serving acceptance and stage are required')
    original=held(value['originalAcceptance']);stage=held(value['originalStageInput']);candidate=held(stage['candidate'])
    need(original['status']=='ACTUAL_0359_PUBLIC_SERVING_REVISION_CONTINUATION_VERIFIED'
         and re.fullmatch('[a-f0-9]{40}',original['source']) and original['profile']=='lolly-start'
         and original['all13ProtectedSpecsGuarded']is True and original['models177ActuallySelected']is True
         and original['normalTlsBodyVerified']is True and original['productionMutation']is False,
         'Original acceptance scope cannot be inferred from successful staging')
    need(original['deploymentUID']==before['metadata']['uid'] and original['deploymentSpecSha256']==digest(before['spec'])
         and original['image']==before['spec']['template']['spec']['containers'][0]['image'], 'Fresh selected spec must still equal accepted0359')
    need(candidate['manifest']==refs['previousManifest'] and value['models']==refs['models'] and value['configs']==refs['configs'], 'Accepted source manifest/config/model bindings differ')
    model_config([held(stage['config'])],held(value['configs']),held(value['models']),held(candidate['modelInventory']))
    need(held(value['publicPin'])==held(stage['publicKey']) ,'Existing public signer pin only')
    return {'version':1,'status':'ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED','deploymentUID':original['deploymentUID'],
        'deploymentSpecSha256':original['deploymentSpecSha256'],'ownerPodUID':original['ownerPodUID'],'image':original['image'],
        'manifestSha256':candidate['manifest']['sha256'],'mapSha256':candidate['mapSha256'],
        'models':value['models'],'configs':value['configs'],'publicPin':value['publicPin']}

def command(ref,producer,stdout_ref,file_output=False):
    x=held(ref)
    need(x.get('exitCode')==0 and x.get('failure')is None and x.get('signal')is None and type(x.get('argv'))is list
         and producer['path'] in x['argv'],'Original actual successful producer command required')
    if file_output:
        need('--output' in x['argv'] and x['argv'][x['argv'].index('--output')+1]==stdout_ref['path'], 'Exact actual output file argument')
        summary=held(x['stdout']);need(summary.get('path')==stdout_ref['path'] and summary.get('sha256')==stdout_ref['sha256'],'Actual metadata producer output custody')
    else:need(x.get('stdout')==stdout_ref,'Exact original signature stdout required')
    a.read_ref(producer);a.read_ref(x['stdout']);a.read_ref(x['stderr']);return x

def producer_arguments(c, native, signature, metadata_command, signature_command, pin_ref, pin):
    need(Path(metadata_command['argv'][0]).is_absolute() and metadata_command['argv'][1:]==['-B',native['metadataSource']['path'],'--archive-proof',c['archiveProof']['path'],'--archive-proof-sha256',c['archiveProof']['sha256'],'--output',c['nativeMetadata']['path']], 'Exact original archive metadata command required')
    need(Path(signature_command['argv'][0]).is_absolute() and signature_command['argv'][1:]==[c['signatureProducer']['path'],c['nativeMetadata']['path'],pin_ref['path']], 'Exact original pinned signature command required')
    need(signature['publicPinSha256']==hashlib.sha256(json.dumps({k:pin[k] for k in ['kty','crv','x','y']},separators=(',',':')).encode()).hexdigest(), 'Actual signature proof uses another pin')

def candidate(report,refs,bound,physical=True):
    exact(report,{'version','protocol','status','mode','root','manifest','map','retained','restoredCodings','candidateCustody',
                  'runtimeQualified','productionMutation','published','originalSignedBytesChanged','physicalEpoch','hardLinkedFiles'})
    need(report['version']==2 and report['protocol']=='PUBLIC_MATCHED_NATIVE_FULL_ROOT_DELIVERY'
         and report['status']=='LOCAL_PHYSICAL_MATCHED_ASSEMBLY_NOT_RUNTIME_ACCEPTANCE' and report['mode']=='matched'
         and all(report[k]is False for k in ['runtimeQualified','productionMutation','published','originalSignedBytesChanged'])
         and report['physicalEpoch']==report['hardLinkedFiles']==0,'Explicit genuine matched assembly required')
    c=held(report['candidateCustody']);exact(c,{'version','status','source','profile','image','imageId','nativeMetadata','archiveProof','signatureProof','metadataCommand','signatureCommand','signatureProducer'})
    need(c['version']==1 and c['status']=='ACTUAL_NATIVE_PUBLIC_SOURCE_CUSTODY_NOT_RUNTIME' and c['source']==bound['qualifiedSource']['source'] and c['profile']=='lolly-start'
         and re.fullmatch('ghcr.io/lolly-tools/lolly-web@sha256:[a-f0-9]{64}',c['image']) and re.fullmatch('sha256:[a-f0-9]{64}',c['imageId']), 'Actual source/image neutral profile only')
    native=held(c['nativeMetadata']);proof=held(c['archiveProof']);signature=held(c['signatureProof'])
    for r,name in [(native['metadataSource'],'public-image-metadata.py'),(proof['verifier'],'verify-public-archive.py'),(c['signatureProducer'],'verify-public-metadata.mjs')]:
        need(Path(r['path']).name==name and r in bound['adapterReview']['sources'],'Original producer is outside reviewed source closure');a.read_ref(r)
    need(native.get('status')=='ACTUAL_DECODED_NATIVE_PUBLIC_ROOT_METADATA_NOT_STAGED' and native['source']==c['source'] and native['profile']=='lolly-start'
         and native['image']==c['image'] and native['imageId']==c['imageId'] and native['archiveProof']==c['archiveProof']
         and native['fullRootExtracted']is False and native['runtimeQualified']is False and native['productionMutation']is False,'Genuine whole OCI decoded file metadata')
    need(proof.get('status')=='ARCHIVE_AND_STREAMED_OCI_VERIFIED_NOT_IMPORTED' and proof['source']==c['source'] and proof['profile']=='lolly-start'
         and proof['qualifiedRegistryImage']==c['image'] and proof['imageId']==c['imageId'] and proof['layerDecoded']is True
         and proof['oci']['decodedDiffIdsVerified']is True and proof['runtimeQualified']is False,'Actual encoded+DiffID OCI closure required')
    for r in [proof['input'],proof['verifier'],*proof['originals'].values()]:a.read_ref(r)
    archive_input=held(proof['input']);web_run=held(archive_input['qualificationRun']);need(web_run.get('head_sha')==c['source'] and web_run.get('status')=='completed' and web_run.get('conclusion')=='success','Exact successful web qualification source')
    need(signature.get('status')=='ACTUAL_DECODED_PUBLIC_CATALOG_P256_FULL_FILE_HASH_VERIFIED_NOT_RUNTIME'
         and signature['verified']is True and signature['source']==c['source'] and signature['profile']=='lolly-start' and signature['image']==c['image']
         and signature['runtimeQualified']is False and signature['files']>0 and signature['tools']>0,'Actual independent pinned full catalog verification')
    old_stage=held(bound['acceptedRelease']['originalStageInput']);old_candidate=held(old_stage['candidate']);old_native=held(old_candidate['nativeMetadata'])
    need(native['configOriginals']==old_native['configOriginals'], 'New native image changes baked Nginx routing/config; requires a separately reviewed config migration')
    for key,encoded in native['configOriginals'].items():
        need(type(encoded)is str and base64.b64encode(base64.b64decode(encoded,validate=True)).decode()==encoded, 'Canonical complete native config original bytes')
    metadata_command = command(c['metadataCommand'],native['metadataSource'],c['nativeMetadata'],file_output=True)
    signature_command = command(c['signatureCommand'],c['signatureProducer'],c['signatureProof'])
    pin_ref=bound['acceptedRelease']['publicPin'];pin=held(pin_ref)
    producer_arguments(c, native, signature, metadata_command, signature_command, pin_ref, pin)
    source=bound['qualifiedSource'];need(source['source']==c['source'] and held(source['run'])['head_sha']==c['source'],'Exact ordinary CI source custody')
    manifest=held(report['manifest']);rows=a.physical(report['root'],manifest,epoch=True) if physical else a.overlay.manifest(manifest)
    original=a.overlay.manifest({'version':1,'files':native['files'],'totalBytes':native['totalBytes']})
    old=a.overlay.manifest(bound['previousManifest']);expected,added,restored=retained_union(original,old,report['map'])
    need(rows==expected and report['retained']==added and report['restoredCodings']==restored and rows[a.overlay.MAP]==report['map'],
         'Full matched root must exactly derive from OCI rows plus accepted immutable wire bytes and paired map')
    need(not any(p.startswith('models/') for p in rows), 'No model payload enters candidate static root')
    return c

def desired_image(want,image):
    result=copy.deepcopy(want);web=result['template']['spec']['containers'][0]
    need(web['resources']['limits']['memory']=='512Mi', 'Only accepted512Mi to reviewed768Mi memory limit delta allowed')
    web['image']=image;web['resources']['limits']['memory']='768Mi';return result

def capacity(value, request, source, adapter, manifest):
    exact(value, {'version','status','source','adapterSource','reserveBytes','maximumStaticWriteBytes','allImagesAlreadyImported','activeAndRollbackPVCsPreserved','modelCopyBytes','productionMutation'})
    need(value['version']==1 and value['status']=='ROOT_REVIEWED_MATCHED_PHASE_CAPACITY_POLICY'
         and value['source']==source['source'] and value['adapterSource']==adapter['source']
         and value['reserveBytes']==request['minimumFreeBytes'] and type(request['minimumFreeBytes']) is int and request['minimumFreeBytes']>=6*1024**3
         and value['maximumStaticWriteBytes']==manifest['totalBytes'] and value['modelCopyBytes']==0
         and value['allImagesAlreadyImported'] is True and value['activeAndRollbackPVCsPreserved'] is True and value['productionMutation'] is False,
         'Exact historical root-reviewed capacity policy required')
