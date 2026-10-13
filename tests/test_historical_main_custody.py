#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Synthetic provider originals; no network or fabricated deployment evidence."""
import copy,importlib.util,json
from pathlib import Path
import sys,unittest
sys.dont_write_bytecode=True

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
HERE=Path(__file__).parent
fixture=load('historical_paired_fixture',HERE/'test_prepare_paired_release.py')
cohort_fixture=load('historical_cohort_fixture',HERE/'test_prepare_private_cohort.py')
m=fixture.m

def historical(f,value):
 source=value['source'];head='f'*40;repo=value['repository'];api='https://api.github.com/repos/'+repo
 return {'version':1,'status':'HISTORICAL_MAIN_SOURCE_QUALIFIED','repository':repo,'source':source,
  'currentMain':f.file('current-provider-ref',{'ref':'refs/heads/main','url':api+'/git/refs/heads/main','object':{'type':'commit','sha':head}}),
  'mergedPullRequest':f.file('merged-provider-pr',{'number':114,'url':api+'/pulls/114','merged':True,'merged_at':'2026-10-13T13:00:00Z','state':'closed','merge_commit_sha':source,'base':{'ref':'main','repo':{'full_name':repo}}}),
  'comparison':f.file('provider-comparison',{'url':api+'/compare/'+source+'...'+head,'base_commit':{'sha':source},'merge_base_commit':{'sha':source},'behind_by':0,'ahead_by':1,'total_commits':1,'status':'ahead','commits':[{'sha':head}]})}

class Historical(fixture.Preparation):
 def test_explicit_history_keeps_exact_source_ci_and_artifacts(self):
  v=self.evidence['work'];proof=historical(self,v);v['main']=self.file('historical-proof',proof)
  root,run=m.source_record(v,self.base,self.runner)
  self.assertEqual(run['head_sha'],v['source']);self.assertEqual(str(root),v['root'])
  self.patch_file(v,'ciRun',lambda r:r.update(event='pull_request'))
  with self.assertRaises(m.Refusal):m.source_record(v,self.base,self.runner)
 def test_each_provider_identity_or_ancestry_tamper_refuses(self):
  v=self.evidence['work'];original=historical(self,v)
  changes=[('currentMain',lambda x:x.update(url='https://api.github.com/repos/other/repo/git/refs/heads/main')),
   ('mergedPullRequest',lambda x:x.update(merged=False)),('mergedPullRequest',lambda x:x.update(merge_commit_sha='e'*40)),
   ('mergedPullRequest',lambda x:x['base'].update(ref='other')),('mergedPullRequest',lambda x:x['base']['repo'].update(full_name='other/repo')),
   ('comparison',lambda x:x['merge_base_commit'].update(sha='e'*40)),('comparison',lambda x:x.update(status='diverged')),
   ('comparison',lambda x:x.update(behind_by=1)),('comparison',lambda x:x.update(commits=[])),
   ('comparison',lambda x:x['commits'][0].update(sha='e'*40)),('comparison',lambda x:x.update(ahead_by=True))]
  for i,(key,change) in enumerate(changes):
   wrong=copy.deepcopy(original);data=json.loads((self.base/wrong[key]['path']).read_bytes());change(data);wrong[key]=self.file('tamper-'+str(i),data)
   with self.subTest(key=key,index=i),self.assertRaises(m.Refusal):m.main_record(wrong,v,self.base)
  wrong=copy.deepcopy(original);wrong['skipCI']=True
  with self.assertRaises(m.Refusal):m.main_record(wrong,v,self.base)
 def test_legacy_stale_main_still_refuses(self):
  self.patch_file(self.evidence['work'],'main',lambda x:x['object'].update(sha='f'*40))
  with self.assertRaisesRegex(m.Refusal,'stale'):m.source_record(self.evidence['work'],self.base,self.runner)

class Closure(cohort_fixture.Cohort):
 def test_planner_rechecks_nested_provider_custody(self):
  planner=load('historical_planner',HERE.parent/'scripts/plan-private-cohort.py')
  prepared,_=self.prepare();original=copy.deepcopy(self.evidence)
  proof=historical(self,original['work']);original['work']['main']=self.file('historical-work-proof',proof)
  envelope=self.file('historical-envelope',original);prepared['reviewedEvidenceSha256']=envelope['sha256']
  for ref in [envelope,original['work']['main'],*[proof[k]for k in ('currentMain','mergedPullRequest','comparison')]]:
   prepared['evidence'].append({'path':str(self.base/ref['path']),'sha256':ref['sha256']})
  planner.cli_evidence(prepared,planner.cohort.Inputs(self.base))
  wrong=copy.deepcopy(prepared);wrong['evidence']=[r for r in wrong['evidence']if r['sha256']!=proof['comparison']['sha256']]
  with self.assertRaises(planner.Refusal):planner.cli_evidence(wrong,planner.cohort.Inputs(self.base))
  (self.base/proof['comparison']['path']).write_text('{}')
  with self.assertRaises(planner.Refusal):planner.cli_evidence(prepared,planner.cohort.Inputs(self.base))
 def test_nested_provider_files_are_held_by_unchanged(self):
  value=copy.deepcopy(self.evidence['work']);proof=historical(self,value);value['main']=self.file('historical-work-proof',proof)
  inputs=cohort_fixture.m.Inputs(self.base)
  cohort_fixture.m.source_record(value,inputs,cohort_fixture.m.git_command,'work')
  for key in ('currentMain','mergedPullRequest','comparison'):
   self.assertIn(self.base/proof[key]['path'],inputs.reads)
  inputs.unchanged()
  (self.base/proof['comparison']['path']).write_text('{}')
  with self.assertRaises(cohort_fixture.m.Refusal):inputs.unchanged()

def load_tests(loader,tests,pattern):return unittest.TestSuite(c(n)for c in(Historical,Closure)for n in c.__dict__ if n.startswith('test_'))
if __name__=='__main__':unittest.main()
