#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Measure real local release work; never emit production acceptance or call a cluster."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


m = module('local_model_fixture', Path(__file__).with_name('public_model_reuse_measurement_fixture.py'))
timer = module('local_operation_timer', ROOT/'scripts/measure-public-release.py')


def need(value, reason):
    if not value: raise RuntimeError(reason)


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, sort_keys=True, indent=2); stream.write('\n')


def read(path):
    return json.loads(path.read_bytes())


def ref(path):
    return timer.reference(path)


def scan(root, expected):
    rows = []
    for path in sorted(root.rglob('*')):
        need(not path.is_symlink(), 'Fixture symlink refused')
        if path.is_file():
            rows.append({'url':'/'+path.relative_to(root).as_posix(), 'size':path.stat().st_size,
                         'sha256':timer.sha(path)})
    need(rows == expected, 'Complete local model bytes changed')
    return sum(row['size'] for row in rows)


def owner(path):
    value = read(path)
    need(value['address'] == '127.0.0.1' and type(value['pid']) is int and value['pid'] > 0, 'Loopback process identity required')
    os.kill(value['pid'], 0)
    return value


def start_server(out, name):
    identity = out/(name+'.owner.json')
    log = (out/(name+'.server.stderr.original')).open('xb')
    process = subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve()),'serve','--out-dir',str(out),'--name',name],
                               stdout=subprocess.DEVNULL,stderr=log)
    deadline = time.monotonic()+10
    while not identity.exists():
        need(process.poll() is None and time.monotonic()<deadline, 'Local server failed to start')
        time.sleep(.01)
    return process, log, identity


def stop_server(process, log):
    if process.poll() is None:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
    log.close()


def http(out, name, current, previous=None):
    config=read(out/'models.json');config['origin']=f"http://127.0.0.1:{current['port']}"
    actual=m.m.request;counts={'requestsStarted':0,'responsesCompleted':0,'bodyBytesRead':0}
    original_read=m.m.http.client.HTTPResponse.read
    def counted_read(response, *args, **kwargs):
        try: block=original_read(response,*args,**kwargs)
        except m.m.http.client.IncompleteRead as error:
            counts['bodyBytesRead']+=len(error.partial);raise
        counts['bodyBytesRead']+=len(block);return block
    def counted(*args, **kwargs):
        counts['requestsStarted']+=1;result=actual(*args, **kwargs)
        counts['responsesCompleted']+=1;return result
    m.m.request=counted;started=time.monotonic();completed=False
    try:
        with patch.object(m.m.http.client.HTTPResponse,'read',counted_read):
            result=m.m.verify(config) if previous is None else m.m.verify_repeat(config,previous)
        if previous is not None:m.m.validate_repeat_report(config,previous,result)
        save(out/(name+'.report.json'),result);completed=True;return result
    finally:
        m.m.request=actual
        save(out/(name+'.timing.json'),{'version':1,'activity':'model-http','clock':'LOCAL_MONOTONIC_ELAPSED_TIME',
             'elapsedSeconds':time.monotonic()-started,**counts,'checksCompleted':completed,
             'byteAccounting':'RESPONSE_BODY_BYTES_READ_INCLUDES_PARTIAL_FAILURES_EXCLUDES_HEADERS_AND_TLS','qualificationClaimed':False})


def phase(out, name):
    if name=='preparation':
        models=out/'model-root';models.mkdir()
        for path,body in m.BODIES.items():
            target=models/path.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
        rows=m.ROWS
        save(out/'models.json',{'version':1,'files':rows,'inventorySha256':hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()})
        candidate=out/'candidate-static';candidate.mkdir()
        (candidate/'index.html').write_bytes(b'<!doctype html><title>Local release fixture</title>')
        (candidate/'app.js').write_bytes(b'/* synthetic frontend */\n'+b'a'*512*1024)
        save(out/'static-manifest.json',[{'path':p.name,'size':p.stat().st_size,'sha256':timer.sha(p)}for p in sorted(candidate.iterdir())])
        save(out/'preparation.result.json',{'modelBytesHashed':scan(models,rows),'staticBytesWritten':sum(p.stat().st_size for p in candidate.iterdir()),'qualificationClaimed':False})
        return
    rows=read(out/'models.json')['files'];hashed=0
    if name in {'verification','staging'}:
        before=owner(out/'original.owner.json');current=before
        if name=='staging':
            checkpoint=read(out/'verification.result.json')
            need(checkpoint['owner']==before,'Changed owner requires the full path')
            shutil.copytree(out/'candidate-static',out/'staged-static')
            for row in read(out/'static-manifest.json'):
                p=out/'staged-static'/row['path'];need(p.stat().st_size==row['size'] and timer.sha(p)==row['sha256'],'Static stage copy changed')
        hashed+=scan(out/'model-root',rows)
        if name=='staging':hashed+=scan(out/'model-root',rows)
        http(out,name,current,read(out/'verification.report.json') if name=='staging' else None)
        hashed+=scan(out/'model-root',rows)
        need(owner(out/'original.owner.json')==before,'Owner changed during local verification')
        save(out/(name+'.result.json'),{'owner':current,'physicalBytesHashed':hashed,'modelScans':3 if name=='staging' else 2,'fullBodyProofReused':name=='staging','qualificationClaimed':False})
        return
    need(name=='publication','Unknown local phase')
    shutil.copytree(out/'staged-static',out/'published-static')
    for row in read(out/'static-manifest.json'):
        p=out/'published-static'/row['path'];need(p.stat().st_size==row['size'] and timer.sha(p)==row['sha256'],'Published static copy changed')
    process,log,path=start_server(out,'replacement')
    try:
        current=owner(path);previous=read(out/'verification.result.json')['owner']
        need(current['pid']!=previous['pid'] and current['startedUnixNs']>previous['startedUnixNs'],'Distinct actual replacement process required')
        hashed+=scan(out/'model-root',rows)
        http(out,name,current)
        hashed+=scan(out/'model-root',rows)
        need(process.poll() is None and owner(path)==current,'Replacement process changed')
        save(out/'publication.result.json',{'owner':current,'previousOwner':previous,'physicalBytesHashed':hashed,'modelScans':2,'fullBodyProofReused':False,'qualificationClaimed':False})
    finally:stop_server(process,log)


def serve(out,name):
    m.BODIES={row['url']:(out/'model-root'/row['url'].lstrip('/')).read_bytes() for row in read(out/'models.json')['files']}
    server=ThreadingHTTPServer(('127.0.0.1',0),m.Handler)
    save(out/(name+'.owner.json'),{'pid':os.getpid(),'startedUnixNs':time.time_ns(),'address':'127.0.0.1','port':server.server_port})
    server.serve_forever()


def benchmark(out):
    out.mkdir(mode=0o700);operations=[]
    sources=[Path(__file__).resolve(),Path(m.__file__),ROOT/'scripts/public-delivery-model-http.py',ROOT/'scripts/measure-public-release.py']
    def measured(name):
        request={'version':1,'status':timer.STATUS,'releaseId':'issue115-local-complete-qualification','activity':name,
                 'program':ref(Path(sys.executable).resolve()),'entrypoint':ref(Path(__file__).resolve()),'interpreterArguments':['-B'],
                 'arguments':[name,'--out-dir',str(out)],'inputFiles':[ref(p)for p in sources],
                 'httpTimingPaths':[] if name=='preparation' else [str(out/(name+'.timing.json'))],
                 'timeoutSeconds':120,'outputDirectory':str(out/(name+'.operation')),'cwd':str(ROOT)}
        path=out/(name+'.input.json');save(path,request)
        receipt,code=timer.run(ref(path),ref(ROOT/'scripts/measure-public-release.py'));operations.append(receipt)
        need(code==0,'Local phase failed; originals retained')
    measured('preparation');process,log,_=start_server(out,'original')
    try:measured('verification');measured('staging')
    finally:stop_server(process,log)
    measured('publication')
    summary=timer.summarize(operations);save(out/'summary.actual.json',summary)
    values={name:read(out/(name+'.timing.json')) for name in ['verification','staging','publication']}
    need(values['verification']['bodyBytesRead']==values['publication']['bodyBytesRead']>values['staging']['bodyBytesRead'],'Full replacement transfer must remain')
    save(out/'benchmark.actual.json',{'version':1,'status':'LOCAL_COMPLETE_FILESYSTEM_AND_HTTP_QUALIFICATION_BENCHMARK_NOT_PRODUCTION_ACCEPTANCE',
         'platform':platform.platform(),'python':platform.python_version(),'logicalModelBytes':sum(r['size']for r in m.ROWS),
         'staticBytes':sum(r['size']for r in read(out/'static-manifest.json')),'sources':[ref(p)for p in sources],
         'operations':operations,'summary':ref(out/'summary.actual.json'),'models':values,
         'distinctPublicationProcess':True,'tlsMeasured':False,'clusterCustodyQualified':False,'productionCalls':False})
    print(json.dumps({'benchmark':ref(out/'benchmark.actual.json'),'summary':summary}))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['run','serve','preparation','staging','verification','publication']);p.add_argument('--out-dir',required=True);p.add_argument('--name');args=p.parse_args()
    out=Path(args.out_dir);need(out.is_absolute() and out.resolve()==out,'Canonical local output required')
    if args.action=='run':benchmark(out)
    elif args.action=='serve':need(args.name in {'original','replacement'},'Known fixture server');serve(out,args.name)
    else:phase(out,args.action)

if __name__=='__main__':main()
