#!/usr/bin/env python3
"""Additional actual gzip wire+decoded identity check, unchanged native oracle.

Transport is loopback-only, bounded and credential-free. Wire strong SHA and
fully decoded identity SHA must both match the same actual reviewed sample.
"""
import hashlib,http.client,zlib
from urllib.parse import urlsplit


def verify_decoded(origin,samples):
    u=urlsplit(origin)
    if u.scheme!='http' or u.hostname!='127.0.0.1' or not u.port or u.username or u.password or u.query or u.fragment or u.path not in {'','/'}:raise RuntimeError('Loopback only')
    results=[]
    for sample in samples:
        coding=sample['gzip']
        if coding is None:continue
        row=sample['identity'];connection=http.client.HTTPConnection('127.0.0.1',u.port,timeout=60)
        wire,identity=hashlib.sha256(),hashlib.sha256();wire_size=identity_size=0;decoder=zlib.decompressobj(16+zlib.MAX_WBITS)
        try:
            connection.request('GET','/'+row['path'],headers={'Accept-Encoding':'gzip'})
            response=connection.getresponse();headers=response.getheaders();names=[k.lower()for k,_ in headers]
            if len(names)!=len(set(names)) or response.status!=200 or response.getheader('Content-Encoding')!='gzip' or response.getheader('ETag')!='"'+coding['sha256']+'"':raise RuntimeError('Exact gzip wire/header identity required')
            while block:=response.read(65536):
                wire_size+=len(block)
                if wire_size>coding['size']:raise RuntimeError('Gzip wire bound')
                wire.update(block);decoded=decoder.decompress(block,row['size']-identity_size+1);identity_size+=len(decoded);identity.update(decoded)
                if identity_size>row['size'] or decoder.unconsumed_tail:raise RuntimeError('Decoded identity bound')
            decoded=decoder.flush();identity_size+=len(decoded);identity.update(decoded)
            if not decoder.eof or decoder.unused_data or wire_size!=coding['size'] or identity_size!=row['size'] or wire.hexdigest()!=coding['sha256'] or identity.hexdigest()!=row['sha256']:raise RuntimeError('Exact complete wire/decoded SHA required')
            results.append({'path':row['path'],'wireBytes':wire_size,'wireSha256':wire.hexdigest(),'decodedBytes':identity_size,'decodedSha256':identity.hexdigest(),'originalHeaders':headers})
        finally:connection.close()
    if not results:raise RuntimeError('At least one real gzip sample is required')
    return {'status':'ACTUAL_LOOPBACK_GZIP_WIRE_AND_DECODED_IDENTITY_VERIFIED','samples':results,'runtimePublicationQualified':False}
