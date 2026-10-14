# SPDX-License-Identifier: MPL-2.0
"""Real local files/processes/HTTP; no cluster adapter or production acceptance."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPT=Path(__file__).with_name('public_release_end_to_end_fixture.py')
spec=importlib.util.spec_from_file_location('complete_local_fixture',SCRIPT)
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class CompleteLocalMeasurement(unittest.TestCase):
    def test_all_real_operations_same_owner_reuse_and_replacement_full_transfer(self):
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary).resolve()/'run'
            result=subprocess.run([sys.executable,'-B',str(SCRIPT),'run','--out-dir',str(out)],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            summary=f.read(out/'summary.actual.json');measurement=f.read(out/'benchmark.actual.json')
            self.assertTrue(summary['coversPreparationStagingPublication']);self.assertTrue(summary['allCommandsSucceeded'])
            self.assertEqual(sum(summary['activityNanoseconds'].values()),summary['activeNanoseconds'])
            self.assertEqual(summary['activeNanoseconds']+summary['unmeasuredGapNanoseconds'],summary['elapsedNanoseconds'])
            self.assertTrue(all(v>0 for v in summary['activityNanoseconds'].values()))
            before=f.read(out/'verification.result.json');stage=f.read(out/'staging.result.json');after=f.read(out/'publication.result.json')
            self.assertEqual(before['owner'],stage['owner']);self.assertNotEqual(before['owner']['pid'],after['owner']['pid'])
            self.assertEqual(stage['modelScans'],3);self.assertFalse(after['fullBodyProofReused'])
            sizes={k:v['bodyBytesRead']for k,v in measurement['models'].items()}
            self.assertEqual(sizes['verification'],sizes['publication']);self.assertGreater(sizes['verification'],sizes['staging'])
            self.assertEqual(f.timer.summarize(summary['operations']),summary)
            self.assertFalse(measurement['productionCalls']);self.assertFalse(measurement['tlsMeasured']);self.assertFalse(measurement['clusterCustodyQualified'])
            for operation in summary['operations']:
                value=f.timer.held(operation,True);command=f.timer.held(value['command'],True)
                self.assertEqual(command['exitCode'],0);self.assertIsNone(command['failureType'])

    def test_owner_readiness_is_published_only_after_complete_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary).resolve()/'owner.json'
            value={'pid':123,'address':'127.0.0.1','port':1234,'startedUnixNs':1}
            original=f.json.dump
            def partial(value, stream, **kwargs):
                stream.write('{');stream.flush()
                self.assertFalse(path.exists())
                stream.seek(0);stream.truncate()
                return original(value,stream,**kwargs)
            with patch.object(f.json,'dump',side_effect=partial):f.publish_owner(path,value)
            self.assertEqual(f.read(path),value)
            self.assertFalse(path.with_name(path.name+'.pending').exists())
            with self.assertRaises(FileExistsError):f.publish_owner(path,{'pid':999})
            self.assertEqual(f.read(path),value)

    def test_failed_phase_exposes_held_bounded_child_diagnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary).resolve()
            stderr=out/'stderr.original';stderr.write_text('x'*20000+'specific child predicate')
            command=out/'command.json';f.save(command,{'stderr':f.ref(stderr)})
            operation=out/'operation.json';f.save(operation,{'command':f.ref(command)})
            with self.assertRaisesRegex(RuntimeError,'specific child predicate') as error:
                f.phase_failure('publication',f.ref(operation))
            self.assertLess(len(str(error.exception)),16500)
            self.assertEqual(stderr.stat().st_size,20000+len('specific child predicate'))

    def test_changed_physical_model_refuses_without_http_or_success_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary).resolve();f.phase(out,'preparation')
            expected=f.read(out/'models.json')['files'];path=out/'model-root/models/unit/small.bin'
            path.write_bytes(b'wrong'+path.read_bytes()[5:])
            with self.assertRaisesRegex(RuntimeError,'Complete local model bytes changed'):
                f.scan(out/'model-root',expected)
            self.assertFalse((out/'verification.report.json').exists());self.assertFalse((out/'benchmark.actual.json').exists())


    def test_real_failed_body_counts_partial_bytes_and_retains_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary).resolve();f.phase(out,'preparation')
            class Broken(f.m.Handler):
                def do_GET(self):
                    if self.path!='/models/unit/large.bin' or self.headers.get('Range') or self.headers.get('If-None-Match'):
                        return self.respond()
                    source=f.m.BODIES[self.path]
                    headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':f.m.m.CORS_METHODS,
                             'Access-Control-Allow-Headers':f.m.m.CORS_HEADERS,'Access-Control-Expose-Headers':f.m.m.CORS_EXPOSE,
                             'Cache-Control':f.m.m.REVALIDATE,'CDN-Cache-Control':'max-age=0, must-revalidate, no-transform',
                             'ETag':'"'+f.hashlib.sha256(source).hexdigest()+'"','X-Content-Type-Options':'nosniff',
                             'Content-Length':str(len(source)),'Accept-Ranges':'bytes'}
                    self.send_response(200)
                    for key,value in headers.items():self.send_header(key,value)
                    self.end_headers();self.wfile.write(source[:65553]);self.wfile.flush();self.close_connection=True
            server=f.ThreadingHTTPServer(('127.0.0.1',0),Broken)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                with self.assertRaisesRegex(RuntimeError,'Actual HTTP model bytes differ'):
                    f.http(out,'broken',{'port':server.server_port})
            finally:server.shutdown();server.server_close();thread.join()
            timing=f.read(out/'broken.timing.json')
            self.assertFalse(timing['checksCompleted']);self.assertEqual(timing['bodyBytesRead'],65553)
            self.assertGreater(timing['bodyBytesRead'],len(b'ok\n'))
            self.assertFalse((out/'broken.report.json').exists())

if __name__=='__main__':unittest.main()
