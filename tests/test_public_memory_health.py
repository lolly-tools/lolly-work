# SPDX-License-Identifier: MPL-2.0
import copy, importlib.util, json, re, unittest, hashlib
from types import SimpleNamespace
from pathlib import Path
P=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('memory',P/'scripts/public-memory-health.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
LIMIT=768*1024**2
def fixture():
 # Synthetic Linux-counter fixture reproduces a bounded file-cache-heavy case.
 values={'currentBefore':800600064,'currentAfter':800600064,'peak':805306368,'max':805306368,'swap':0}
 stats={'anon':77262848,'kernel':19333120,'file':704151552,'shmem':4096,'inactive_file':149839872,'active_file':554307584,'file_dirty':0,'file_writeback':0,'unevictable':0}
 events={'oom':0,'oom_kill':0,'oom_group_kill':0,'max':241}
 rows=[prefix+'\t'+key+'\t'+str(value)for prefix,group in [('M',values),('S',stats),('E',events)]for key,value in group.items()]
 for pid,pss in [(1,17489),(21,15437),(22,15437),(23,15435),(24,15435)]:
  rows.extend(['P\t'+str(pid)+'\t101\t101\t101\t101\t74900 kB','Q\t'+str(pid)+'\t'+str(pss)+' kB'])
 return ('\n'.join(rows)+'\nEND\tCACHE_AWARE_CGROUP_AND_NGINX_OBSERVED\n').encode()
class Memory(unittest.TestCase):
 def changed(self,data,key,val):return re.sub(rb'^'+key+rb'\t[^\n]+$',key+b'\t'+str(val).encode(),data,flags=re.M)
 def test_cache_heavy_counter_fixture(self):
  v=m.parse(fixture(),LIMIT);self.assertEqual(v['totalPssBytes'],81134592);self.assertEqual(v['requiredHeadroomBytes'],96*1024**2);self.assertEqual(v['workingSetBytes'],650764288);self.assertEqual(v['residentBytes'],96600064)
 def test_peak_equal_is_only_cache_aware(self):self.assertEqual(m.parse(fixture(),LIMIT)['peakBytes'],LIMIT)
 def test_oom(self):
  for key in [b'E\toom',b'E\toom_kill',b'E\toom_group_kill']:
   with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),key,1),LIMIT)
 def test_swap(self):
  with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),b'M\tswap',4096),LIMIT)
 def test_peak_over_limit(self):
  with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),b'M\tpeak',LIMIT+1),LIMIT)
 def test_no_inactive_headroom(self):
  with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),b'S\tinactive_file',1),LIMIT)
 def test_resident_headroom(self):
  with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),b'S\tanon',LIMIT),LIMIT)
 def test_dirty_shared_not_subtracted(self):
  for key in [b'S\tfile_dirty',b'S\tfile_writeback',b'S\tshmem',b'S\tunevictable']:
   with self.assertRaises(RuntimeError):m.parse(self.changed(fixture(),key,120*1024**2),LIMIT)
 def test_active_file_not_credit(self):
  self.assertEqual(m.parse(self.changed(fixture(),b'S\tactive_file',0),LIMIT)['workingSetBytes'],m.parse(fixture(),LIMIT)['workingSetBytes'])
 def test_type_and_lru_not_partition(self):
  self.assertEqual(m.parse(self.changed(fixture(),b'S\tfile',500*1024**2),LIMIT)['workingSetBytes'],m.parse(fixture(),LIMIT)['workingSetBytes'])
 def test_uid_and_pss(self):
  with self.assertRaises(RuntimeError):m.parse(fixture().replace(b'P\t1\t101',b'P\t1\t0'),LIMIT)
  with self.assertRaises(RuntimeError):m.parse(fixture().replace(b'Q\t1\t',b'Q\t99\t'),LIMIT)
 def test_bound_missing_duplicate(self):
  for data in [fixture()[:-30],fixture()+b'x'*65536,fixture().replace(b'M\tmax\t',b'M\tpeak\t'),fixture().replace(b'S\tanon\t',b'S\tother\t')]:
   with self.assertRaises(RuntimeError):m.parse(data,LIMIT)
 def test_raw_command_and_owner_binding(self):
  target={'transport':{'type':'local','kubectl':['kubectl'],'kubeconfig':'held','context':'production'}}
  held={};raw={};commands=[]
  def ref(name,value,binary=False):
   data=value if binary else json.dumps(value).encode();r={'path':'/journal/'+name,'sha256':hashlib.sha256(data).hexdigest()};(raw if binary else held)[name]=value;return r
  stdin=ref('stdin',m.SCRIPT.encode(),True);stdout=ref('stdout',fixture(),True)
  for name in ['before','after']:
   commands.append(ref(name,{'argv':m.argv(target,'ns','pod','web'),'stdin':stdin,'stdout':stdout,'exitCode':0,'failure':None,'complete':True}))
  memory={'version':2,'profile':m.PROFILE,'podUID':'uid','limitBytes':LIMIT,'beforeHTTP':{'sample':m.parse(fixture(),LIMIT),'command':commands[0]},'afterHTTP':{'sample':m.parse(fixture(),LIMIT),'command':commands[1]}}
  def exact(value,keys):m.need(set(value)==set(keys),'Exact fields required')
  l=SimpleNamespace(exact=exact,held=lambda r:held[Path(r['path']).name],a=SimpleNamespace(read_ref=lambda r:raw[Path(r['path']).name]))
  def check(v=memory):m.verify(l,v,LIMIT,'uid',commands,'ns','pod','web',target)
  check()
  held['after']['argv']=m.argv(target,'ns','other','web')
  with self.assertRaises(RuntimeError):check()
  held['after']['argv']=m.argv(target,'ns','pod','web');raw['stdin']=b'false'
  with self.assertRaises(RuntimeError):check()
  raw['stdin']=m.SCRIPT.encode();swapped=copy.deepcopy(memory);swapped['beforeHTTP'],swapped['afterHTTP']=swapped['afterHTTP'],swapped['beforeHTTP']
  with self.assertRaises(RuntimeError):check(swapped)
  changed=copy.deepcopy(memory);changed['beforeHTTP']['sample']['workingSetBytes']=1
  with self.assertRaises(RuntimeError):check(changed)
if __name__=='__main__':unittest.main()
