#!/usr/bin/env python3
"""Bounded anonymous final-8080 static checks, full retained bytes plus samples.

Every retained body is hashed. Representative candidate/retained routes also
exercise native HEAD, full-SHA conditional and Range/If-Range. This helper uses
only the separately reviewed model verifier's loopback transport and never
follows redirects or serializes credentials.
"""
from __future__ import annotations
import hashlib
import json
import re

# Matches public-delivery-overlay.MAX_BYTES. This is transfer, not live RAM.
MAX_RETAINED_BYTES = 8 * 1024**3


def need(value,message):
    if not value:raise RuntimeError(message)


def row(value):
    need(type(value)is dict and set(value)=={'path','size','sha256'} and type(value['path'])is str
         and re.fullmatch(r'[A-Za-z0-9._@/+,[\]()-]+',value['path']) and not value['path'].startswith('/')
         and all(p not in {'','.','..'}for p in value['path'].split('/')) and type(value['size'])is int
         and 0<=value['size']<=2*1024**3 and type(value['sha256'])is str and re.fullmatch('[0-9a-f]{64}',value['sha256']),
         'Exact safe static size/full SHA row required')
    return value


def immutable(path):
    return bool(re.match(r'(?:_app/|ort-hf/[^/]+/|info/docs\.[a-zA-Z0-9_-]{6,40}\.(?:css|js)$|tools/[a-zA-Z0-9-]+@[0-9a-f]{16}/|models/.+@[0-9a-f]{16}/)',path)
                or re.fullmatch(r'.*\.[0-9a-f]{16}\.[a-zA-Z0-9]{1,16}',path))


def retained_budget(retained):
    need(type(retained)is list and 0<len(retained)<=20000,'Bounded complete retained identity rows required')
    previous='';total=0;canonical=[]
    for value in retained:
        row(value);need(value['path']>previous and immutable(value['path']),'Retained paths must be sorted unique immutable')
        previous=value['path'];total+=value['size'];need(total<=MAX_RETAINED_BYTES,'Retained transfer exceeds complete-root bound')
        canonical.append({'path':value['path'],'size':value['size'],'sha256':value['sha256']})
    encoded=json.dumps(canonical,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode()
    return {'count':len(canonical),'bytes':total,'sha256':hashlib.sha256(encoded).hexdigest()}


def policy(value,expected,status,verifier,coding=None):
    need(value['status']==status,'Actual static HTTP status differs for '+expected['path'])
    h=value['headers'];etag='"'+expected['sha256']+'"'
    if expected['path']=='sw.js':cache,cdn='no-cache, s-maxage=0, no-transform','no-store'
    elif immutable(expected['path']):cache,cdn=verifier['IMMUTABLE'],'max-age=31536000, no-transform'
    else:cache,cdn=verifier['REVALIDATE'],'max-age=0, must-revalidate, no-transform'
    need(h.get('cache-control')==cache and h.get('cdn-cache-control')==cdn and h.get('etag')==etag,
         'Actual static cache/full-SHA validator differs for '+expected['path'])
    need(h.get('x-content-type-options')=='nosniff' and not any(k in h for k in ['last-modified','set-cookie','age','cache-tag','surrogate-key','access-control-allow-credentials']),
         'Unexpected static privacy/date-transform headers')
    # A 304 has no representation body. Native Nginx omits Content-Encoding
    # there; the exact coding-specific strong ETag and Vary still bind selection.
    need(h.get('content-encoding') in {None,coding} if status==304 else h.get('content-encoding')==coding,
         'Actual coding is not the reviewed wire representation')
    if coding:need(h.get('vary','').lower()=='accept-encoding','Coded bytes require exact Accept-Encoding variance')


def verify_static(config,verifier):
    need(type(config)is dict and set(config)=={'origin','retained','retainedBudget','samples'},'Closed anonymous static check input required')
    retained,samples=config['retained'],config['samples'];need(type(retained)is list and 0<len(retained)<=20000 and type(samples)is list and 1<=len(samples)<=64,'Bounded static projection/sample set required')
    budget=config['retainedBudget'];expected=retained_budget(retained)
    need(type(budget)is dict and set(budget)=={'count','bytes','sha256'}
         and type(budget['count'])is int and type(budget['bytes'])is int
         and type(budget['sha256'])is str and budget==expected,
         'Retained count/bytes/full metadata digest differs from reviewed rows')
    total=budget['bytes']
    request,observe=verifier['request'],verifier['observation'];origin=config['origin'];observed=[];captured=0
    def get(method,r,headers,maximum):return request(origin,method,'/'+r['path'],{'Accept-Encoding':'identity',**headers},maximum,origin_header=None)
    for r in retained:
        value=get('GET',r,{},r['size']);policy(value,r,200,verifier)
        need(value['size']==r['size'] and value['sha256']==r['sha256'],'Actual retained HTTP full bytes differ')
        entry={'path':r['path'],'size':value['size'],'sha256':value['sha256'],'response':observe('GET every retained full body',value)}
        captured+=len(json.dumps(entry,separators=(',',':')).encode());need(captured<=24*1024**2,'Retained original response capture exceeds bound');observed.append(entry)
    sample_observed=[]
    for item in samples:
        need(type(item)is dict and set(item)=={'identity','gzip'},'Exact static identity/coding sample required')
        r=row(item['identity']);etag='"'+r['sha256']+'"';responses=[]
        head=get('HEAD',r,{},0);policy(head,r,200,verifier);need(head['headers'].get('content-length')==str(r['size']),'Native static HEAD size differs');responses.append(observe('HEAD',head))
        full=get('GET',r,{},r['size']);policy(full,r,200,verifier);need(full['size']==r['size']and full['sha256']==r['sha256'],'Candidate/retained sample full bytes differ');responses.append(observe('GET full identity',full))
        for token in [etag,'W/'+etag]:
            same=get('GET',r,{'If-None-Match':token},0);policy(same,r,304,verifier);need(same['size']==0,'Conditional body was not empty');responses.append(observe('GET If-None-Match:'+token,same))
        if r['size']:
            count=min(r['size'],32)
            for extra in [{},{'If-Range':etag}]:
                part=get('GET',r,{'Range':f'bytes=0-{count-1}',**extra},count);policy(part,r,206,verifier)
                need(part['size']==count and part['prefix']==full['prefix'][:count] and part['headers'].get('content-range')==f'bytes 0-{count-1}/{r["size"]}', 'Native static Range/strong If-Range differs');responses.append(observe('GET Range '+json.dumps(extra),part))
            mismatch=get('GET',r,{'Range':'bytes=0-0','If-Range':'"unknown-full-SHA"'},r['size']);policy(mismatch,r,200,verifier)
            need(mismatch['size']==r['size']and mismatch['sha256']==r['sha256']and'content-range'not in mismatch['headers'],'Mismatched If-Range failed to serve complete current body');responses.append(observe('GET mismatched If-Range full body',mismatch))
        coding=item['gzip']
        if coding is not None:
            row(coding);need(coding['path']==r['path']+'.gz','Exact gzip sibling required')
            encoded=get('GET',r,{'Accept-Encoding':'gzip'},coding['size']);wire={**coding,'path':r['path']};policy(encoded,wire,200,verifier,'gzip')
            need(encoded['size']==coding['size']and encoded['sha256']==coding['sha256'],'Precompressed exact full wire bytes differ');responses.append(observe('GET gzip exact wire full SHA',encoded))
            conditional=get('GET',r,{'Accept-Encoding':'gzip','If-None-Match':'"'+coding['sha256']+'"'},0);policy(conditional,wire,304,verifier,'gzip');need(conditional['size']==0,'Coded conditional contains bytes');responses.append(observe('GET gzip strong wire conditional',conditional))
            cross=get('GET',r,{'Accept-Encoding':'gzip','If-None-Match':etag},coding['size']);policy(cross,wire,200,verifier,'gzip')
            need(cross['size']==coding['size']and cross['sha256']==coding['sha256'],'Identity ETag incorrectly matched a different gzip representation');responses.append(observe('GET cross-coding conditional miss full wire SHA',cross))
        sample_observed.append({'path':r['path'],'sha256':r['sha256'],'responses':responses})
    forbidden=[]
    for path in ['/.delivery-etags.conf','/_app/nonexistent-plan300.js','/tools/missing@0000000000000000/missing.js','/api/','/tool/','/live/']:
        response=request(origin,'GET',path,{'Accept-Encoding':'identity'},65536,origin_header=None)
        need(response['status']==404 and response['headers'].get('cache-control')==verifier['PRIVATE']and response['headers'].get('cdn-cache-control')=='no-store'
             and not any(k in response['headers']for k in ['etag','last-modified','set-cookie','age','cache-tag','surrogate-key']), 'Missing/control API path was exposed or publicly cached')
        forbidden.append({'path':path,'response':observe('GET missing/control',response)})
    return {'version':1,'status':'ISOLATED_STATIC_HTTP_RETAINED_FULL_BYTES_AND_SAMPLES_VERIFIED_ONLY','retainedFiles':len(retained),'retainedBytes':total,'retainedBudget':budget,'retained':observed,'samples':sample_observed,'forbidden':forbidden,'allCandidateHttpBodiesClaimed':False,'publicDeploymentMutated':False,'published':False}
