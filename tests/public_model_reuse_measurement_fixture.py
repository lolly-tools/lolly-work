#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Real loopback HTTP body measurements; synthetic content, no production/TLS claim."""
import argparse, hashlib, importlib.util, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

S=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('measured_models',S/'public-delivery-model-http.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BODIES={f'/models/unit/{name}.bin':bytes([byte])*size for name,size,byte in [('empty',0,1),('large',8*1024**2,2),('small',65536,3),('threshold',65537,4)]}
ROWS=[{'url':name,'size':len(body),'sha256':hashlib.sha256(body).hexdigest()} for name,body in sorted(BODIES.items())]

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_HEAD(self):self.respond()
    def do_GET(self):self.respond()
    def do_OPTIONS(self):self.respond()
    def respond(self):
        body=b'';status=200;headers={}
        if self.path=='/healthz':body=b'ok\n'
        elif self.path not in BODIES:status=404;headers={'Cache-Control':m.PRIVATE,'CDN-Cache-Control':'no-store'}
        else:
            source=BODIES[self.path];size=len(source);etag='"'+hashlib.sha256(source).hexdigest()+'"'
            cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':m.CORS_METHODS,'Access-Control-Allow-Headers':m.CORS_HEADERS,'Access-Control-Expose-Headers':m.CORS_EXPOSE}
            headers={**cors,'Cache-Control':m.REVALIDATE,'CDN-Cache-Control':'max-age=0, must-revalidate, no-transform','ETag':etag,'X-Content-Type-Options':'nosniff','Content-Length':str(size),'Accept-Ranges':'bytes'}
            if self.command=='HEAD':pass
            elif self.command=='OPTIONS':status=204;headers['Content-Length']='0'
            elif self.headers.get('If-None-Match') in [etag,'W/'+etag]:status=304;headers.pop('Content-Length')
            elif self.headers.get('Range') and self.headers.get('If-Range',etag)==etag:
                first,last=map(int,self.headers['Range'].removeprefix('bytes=').split('-'))
                if first>=size:status=416;headers={**cors,'Cache-Control':m.PRIVATE,'CDN-Cache-Control':'no-store','Content-Range':f'bytes */{size}'}
                else:status=206;body=source[first:last+1];headers.update({'Content-Range':f'bytes {first}-{last}/{size}','Content-Length':str(len(body))})
            else:body=source
        if 'Content-Length' not in headers and status!=304:headers['Content-Length']=str(len(body))
        self.send_response(status)
        for key,value in headers.items():self.send_header(key,value)
        self.end_headers()
        if self.command!='HEAD' and body:self.wfile.write(body)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out-dir',required=True);args=parser.parse_args()
    out=Path(args.out_dir);out.mkdir(mode=0o700)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    config={'version':1,'origin':f'http://127.0.0.1:{server.server_port}','files':ROWS,'inventorySha256':hashlib.sha256(json.dumps(ROWS,separators=(',',':')).encode()).hexdigest()}
    actual=m.request;measurements=[]
    def phase(name,prior=None):
        counts={'requestsStarted':0,'responsesCompleted':0,'bodyBytesRead':0}
        def counted(*args,**kwargs):
            counts['requestsStarted']+=1;result=actual(*args,**kwargs);counts['responsesCompleted']+=1;counts['bodyBytesRead']+=result['size'];return result
        m.request=counted;start=time.monotonic();report=m.verify(config) if prior is None else m.verify_repeat(config,prior);elapsed=time.monotonic()-start
        (out/(name+'.report.json')).write_text(json.dumps(report,sort_keys=True)+'\n')
        timing={'version':1,'activity':'model-http','clock':'LOCAL_MONOTONIC_ELAPSED_TIME','elapsedSeconds':elapsed,**counts,'checksCompleted':True,'byteAccounting':'RESPONSE_BODY_BYTES_READ_INCLUDES_PARTIAL_FAILURES_EXCLUDES_HEADERS_AND_TLS','qualificationClaimed':False}
        (out/(name+'.timing.json')).write_text(json.dumps(timing,sort_keys=True)+'\n');measurements.append({'name':name,**timing});return report
    try:
        baseline=phase('full');reused=phase('same-owner-reuse',baseline)
        m.validate_repeat_report(config,baseline,reused)
        # A new-owner publication never receives original=, regardless of a
        # staging reuse option. This is a full-path transfer control only.
        full_again=phase('full-publication-control')
        assert baseline==full_again
        assert measurements[1]['bodyBytesRead'] < measurements[0]['bodyBytesRead']
        assert measurements[0]['bodyBytesRead']==measurements[2]['bodyBytesRead']
        result={'version':1,'status':'LOCAL_LOOPBACK_HTTP_FIXTURE_MEASUREMENT_NOT_PRODUCTION_QUALIFICATION','pid':os.getpid(),'serverAddress':'127.0.0.1','logicalModelBytes':sum(r['size']for r in ROWS),'files':len(ROWS),'measurements':measurements,'tlsMeasured':False,'productionCalls':False,'ownerCustodyQualified':False,'fullPublicationTransferRetained':True}
        (out/'measurement.actual.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    finally:m.request=actual;server.shutdown();server.server_close();thread.join()

if __name__=='__main__':main()
