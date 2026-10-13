# SPDX-License-Identifier: MPL-2.0
"""Real local child processes, exclusively temporary files; no deployment calls."""
import copy, importlib.util, json, pathlib, sys, tempfile, unittest

S = pathlib.Path(__file__).resolve().parents[1]/'scripts'
spec = importlib.util.spec_from_file_location('release_measurement', S/'measure-public-release.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Measurement(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.tmp.name).resolve(); self.count = 0
        self.op = m.reference(S/'measure-public-release.py')
    def tearDown(self): self.tmp.cleanup()
    def sidecar(self):
        return {'version':1,'activity':'model-http','clock':'LOCAL_MONOTONIC_ELAPSED_TIME','elapsedSeconds':0.001,
            'requestsStarted':2,'responsesCompleted':2,'bodyBytesRead':123,'checksCompleted':True,
            'byteAccounting':'RESPONSE_BODY_BYTES_READ_INCLUDES_PARTIAL_FAILURES_EXCLUDES_HEADERS_AND_TLS','qualificationClaimed':False}
    def command(self, activity='staging', code=0, sidecar=None, missing=False):
        self.count += 1; base=self.root/str(self.count);base.mkdir();script=base/'fixture.py';timing=base/'http.json'
        source='import pathlib,sys,time\ntime.sleep(0.01)\nprint("original stdout")\nprint("original stderr",file=sys.stderr)\n'
        if sidecar is not None: source += 'pathlib.Path('+repr(str(timing))+').write_text('+repr(json.dumps(sidecar))+')\n'
        source += 'raise SystemExit('+str(code)+')\n';script.write_text(source)
        value={'version':1,'status':m.STATUS,'releaseId':'local-fixture','activity':activity,'program':m.reference(pathlib.Path(sys.executable).resolve()),'entrypoint':m.reference(script),
            'interpreterArguments':['-B'],'arguments':[],'inputFiles':[],'httpTimingPaths':[str(timing)] if sidecar is not None or missing else [],'timeoutSeconds':10,'outputDirectory':str(base/'out'),'cwd':str(base)}
        inp=base/'input.json';inp.write_bytes(m.raw(value));return m.run(m.reference(inp),self.op)
    def test_one_explicit_command_preserves_process_exit_and_streams(self):
        ref,code=self.command();self.assertEqual(code,0);value=m.held(ref,True);command=m.held(value['command'],True)
        self.assertEqual(command['exitCode'],0);self.assertIn(b'original stdout',m.held(command['stdout']).read_bytes());self.assertIn(b'original stderr',m.held(command['stderr']).read_bytes())
        self.assertGreater(command['elapsedNanoseconds'],10_000_000);self.assertFalse(value['qualificationClaimed'])
        with self.assertRaises(RuntimeError):m.run(value['input'],self.op)
    def test_failed_command_preserved_without_next_action(self):
        ref,code=self.command(code=7);self.assertEqual(code,1);value=m.held(ref,True)
        self.assertEqual(m.held(value['command'],True)['exitCode'],7);self.assertFalse(m.summarize([ref])['allCommandsSucceeded'])
        self.assertEqual(self.count,1)
    def test_disjoint_full_operation_time_and_nested_bytes(self):
        refs=[self.command(k,sidecar=self.sidecar() if k=='staging' else None)[0] for k in ['preparation','staging','publication']]
        result=m.summarize(refs);self.assertTrue(result['coversPreparationStagingPublication']);self.assertTrue(result['allCommandsSucceeded'])
        self.assertEqual(result['modelResponseBodyBytes'],123);self.assertEqual(result['modelHttpSecondsNestedNotAdditive'],0.001)
        self.assertEqual(result['activeNanoseconds'],sum(result['activityNanoseconds'].values()));self.assertGreaterEqual(result['elapsedNanoseconds'],result['activeNanoseconds'])
    def test_corrupt_or_missing_sidecar_preserves_actual_success_but_refuses_telemetry(self):
        bad=self.sidecar();bad['bodyBytesRead']=-1
        for kwargs in [{'sidecar':bad},{'missing':True}]:
            ref,code=self.command(**kwargs);self.assertEqual(code,1);v=m.held(ref,True)
            self.assertEqual(m.held(v['command'],True)['exitCode'],0);self.assertEqual(v['status'],'PUBLIC_RELEASE_OPERATION_TELEMETRY_REFUSED')
            with self.assertRaises(RuntimeError):m.summarize([ref])
    def test_overlap_and_changed_original_stream_refused(self):
        ref,_=self.command(sidecar=self.sidecar())
        with self.assertRaises(RuntimeError):m.summarize([ref,ref])
        value=m.held(ref,True);command=m.held(value['command'],True);m.held(command['stdout']).write_bytes(b'changed')
        with self.assertRaises(RuntimeError):m.summarize([ref])
    def test_rehashed_dropped_sidecar_and_boolean_exit_refused(self):
        ref,_=self.command(sidecar=self.sidecar());value=m.held(ref,True)
        changed=copy.deepcopy(value);changed['httpTimings']=[]
        path=self.root/'altered-operation.json';path.write_bytes(m.raw(changed))
        with self.assertRaises(RuntimeError):m.summarize([m.reference(path)])
        command=m.held(value['command'],True);command['exitCode']=False
        command_path=self.root/'altered-command.json';command_path.write_bytes(m.raw(command))
        value['command']=m.reference(command_path);path.write_bytes(m.raw(value))
        with self.assertRaises(RuntimeError):m.summarize([m.reference(path)])

    def test_interrupted_http_bytes_remain_diagnostic(self):
        data=self.sidecar();data.update(requestsStarted=1,responsesCompleted=0,bodyBytesRead=19,checksCompleted=False)
        ref,code=self.command(code=4,sidecar=data);self.assertEqual(code,1);result=m.summarize([ref])
        self.assertEqual(result['modelResponseBodyBytes'],19);self.assertFalse(result['allCommandsSucceeded'])

if __name__=='__main__':unittest.main()
