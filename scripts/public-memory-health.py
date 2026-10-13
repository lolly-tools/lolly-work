# SPDX-License-Identifier: MPL-2.0
"""Bounded cgroup v2 health; distinguish reclaimable file cache from working set."""
import re, hashlib, subprocess, time, uuid, shlex
from pathlib import Path

PROFILE = {'version': 1, 'name': 'CGROUP_V2_CACHE_AWARE_HEADROOM', 'minimumHeadroomBytes': 64*1024**2,
           'headroomDivisor': 8, 'zeroOOM': True, 'zeroSwap': True, 'peakWithinExactLimit': True}
SCRIPT = r'''set -eu
printf 'M\tcurrentBefore\t';cat /sys/fs/cgroup/memory.current
printf 'M\tpeak\t';cat /sys/fs/cgroup/memory.peak
printf 'M\tmax\t';cat /sys/fs/cgroup/memory.max
printf 'M\tswap\t';cat /sys/fs/cgroup/memory.swap.current
while read -r key value;do printf 'S\t%s\t%s\n' "$key" "$value";done < /sys/fs/cgroup/memory.stat
while read -r key value;do printf 'E\t%s\t%s\n' "$key" "$value";done < /sys/fs/cgroup/memory.events
for status in /proc/[0-9]*/status;do
 [ -r "$status" ]||continue
 name=$(sed -n 's/^Name:[[:space:]]*//p' "$status")
 [ "$name" = nginx ]||continue
 pid=${status#/proc/};pid=${pid%/status}
 uid=$(sed -n 's/^Uid:[[:space:]]*//p' "$status")
 rss=$(sed -n 's/^VmRSS:[[:space:]]*//p' "$status")
 printf 'P\t%s\t%s\t%s\n' "$pid" "$uid" "$rss"
 pss=$(sed -n 's/^Pss:[[:space:]]*//p' "/proc/$pid/smaps_rollup")
 printf 'Q\t%s\t%s\n' "$pid" "$pss"
done
printf 'M\tcurrentAfter\t';cat /sys/fs/cgroup/memory.current
printf 'END\tCACHE_AWARE_CGROUP_AND_NGINX_OBSERVED\n'
'''

def need(value, message):
    if not value: raise RuntimeError(message)

def parse(data, limit):
    need(type(data) is bytes and 0<len(data)<=65536 and type(limit)is int and limit>=128*1024**2, 'Bounded native cgroup sample/limit required')
    lines=data.decode('ascii').splitlines();need(lines[-1]=='END\tCACHE_AWARE_CGROUP_AND_NGINX_OBSERVED','Complete memory sample required')
    values,stats,events,processes,pss={},{},{},[],{}
    for line in lines[:-1]:
        row=line.split('\t')
        if row[0] in {'M','S','E'}:
            need(len(row)==3 and re.fullmatch(r'[a-zA-Z_]+',row[1]) and row[2].isdigit() and int(row[2])<2**63,'Malformed memory counter')
            target={'M':values,'S':stats,'E':events}[row[0]];need(row[1] not in target,'Duplicate memory counter');target[row[1]]=int(row[2])
        elif row[0]=='Q':
            need(len(row)==3 and row[1].isdigit() and row[1]not in pss,'Unique PSS process required')
            item=row[2].split();need(len(item)==2 and item[0].isdigit() and item[1]=='kB','Actual PSS required');pss[row[1]]=int(item[0])*1024
        else:
            need(len(row)in{4,7} and row[0]=='P' and row[1].isdigit(),'Malformed Nginx process')
            uids=row[2:-1]if len(row)==7 else row[2].split();rss=row[-1].split()
            need(uids==['101']*4 and len(rss)==2 and rss[0].isdigit() and rss[1]=='kB','Nginx UID/RSS differs')
            processes.append({'pid':int(row[1]),'rssBytes':int(rss[0])*1024})
    need(set(values)=={'currentBefore','currentAfter','peak','max','swap'} and values['max']==limit and values['swap']==0,'Exact limit and zero swap required')
    current=max(values['currentBefore'],values['currentAfter'])
    need(0<min(values['currentBefore'],values['currentAfter'])<=current<=values['peak']<=limit,'Cgroup current/peak exceeds exact limit')
    need({'anon','kernel','file','shmem','inactive_file','file_dirty','file_writeback','unevictable'}<=set(stats),'Required native memory.stat counters missing')
    need({'oom','oom_kill','oom_group_kill','max'}<=set(events) and all(events[k]==0 for k in ['oom','oom_kill','oom_group_kill']),'Any OOM event refuses health')
    need(1<=len(processes)<=16 and len({p['pid']for p in processes})==len(processes),'Unique bounded Nginx processes required')
    need(set(pss)=={str(p['pid'])for p in processes},'PSS process membership differs')
    pss_total=sum(pss.values());need(0<pss_total<=current,'Actual proportional resident memory exceeds cgroup')
    rss=max(p['rssBytes']for p in processes);need(0<rss<=current,'Nginx RSS exceeds cgroup memory')
    # Type and LRU-list counters are not a partition. Subtract only the smaller
    # file/inactive-file counter, conservatively retaining dirty/shared/locked bytes.
    clean=max(0,min(stats['file'],stats['inactive_file'])-stats['shmem']-stats['file_dirty']-stats['file_writeback']-stats['unevictable'])
    need(clean<=current and all(stats[k]<=limit for k in ['anon','kernel','file','shmem','inactive_file']),'Native counter bounds differ')
    working=current-clean;resident=stats['anon']+stats['kernel']+stats['shmem'];reserve=max(PROFILE['minimumHeadroomBytes'],limit//PROFILE['headroomDivisor'])
    need(0<working<=limit-reserve and 0<resident<=limit-reserve and pss_total<=limit-reserve,'Resident or conservative working set lacks required headroom')
    return {'currentBytes':current,'peakBytes':values['peak'],'limitBytes':limit,'swapBytes':0,'values':values,'stats':stats,'events':events,
            'processes':processes,'pssBytes':pss,'totalPssBytes':pss_total,'rssBytes':rss,'cleanInactiveFileBytes':clean,'workingSetBytes':working,'residentBytes':resident,'requiredHeadroomBytes':reserve}

def measure(stage):
    pod=stage.owner;configured=stage.resources['qualifier']['spec']['containers'][0]['resources']['limits']['memory']
    match=re.fullmatch(r'([1-9][0-9]*)(Mi|Gi)',configured);need(match,'Explicit native memory limit required')
    limit=int(match[1])*(1024**2 if match[2]=='Mi'else 1024**3)
    argv=stage.transport(['exec','-i','-n',stage.namespace,pod['metadata']['name'],'-c',stage.container,'--','/bin/sh','-s'])
    tag='command-'+uuid.uuid4().hex;script=SCRIPT.encode();stdin=None
    # The stage's unchanged command runner has no stdin custody. This bounded
    # read-only recorder includes the exact script and otherwise uses its schema.
    if stdin is None:
        path=stage.out/(tag+'.stdin.original')
        with path.open('xb') as handle:handle.write(script)
        stdin={'path':str(path),'sha256':hashlib.sha256(script).hexdigest()}
    begin=time.monotonic();failure=None
    try:
        actual=subprocess.run(argv,input=script,capture_output=True,timeout=30);out,err,code=actual.stdout,actual.stderr,actual.returncode
    except subprocess.TimeoutExpired as error:
        out,err,code=error.stdout or b'',error.stderr or b'',None;failure='TIMEOUT_NO_REPLAY'
    complete=len(out)<=65536 and len(err)<=65536;streams={}
    for key,data in [('stdout',out),('stderr',err)]:
        path=stage.out/(tag+'.'+key+'.original')
        with path.open('xb') as handle:handle.write(data[:65536])
        streams[key]={'path':str(path),'sha256':hashlib.sha256(data[:65536]).hexdigest()}
    command=stage.save(tag+'.actual.json',{'argv':argv,'stdin':stdin,'exitCode':code,'failure':failure,'complete':complete,
        'elapsedSeconds':time.monotonic()-begin,**streams,
        'decoded':{k:{'size':len(v),'sha256':hashlib.sha256(v).hexdigest()}for k,v in [('stdout',out),('stderr',err)]}})
    stage.events.append(command);need(code==0 and failure is None and complete,'Actual bounded memory command failed')
    return {'sample':parse(out,limit),'command':command}

def argv(target,namespace,pod,container):
    t=target['transport'];args=['exec','-i','-n',namespace,pod,'-c',container,'--','/bin/sh','-s']
    command=[*t['kubectl'],'--kubeconfig',t['kubeconfig'],'--context',t['context'],*args]
    if t['type']=='local':return command
    need(t['type']=='ssh','Reviewed native transport required')
    if t.get('sudo'):command=['sudo','-n',*command]
    ssh=['ssh','-oBatchMode=yes','-oConnectTimeout=12','-oStrictHostKeyChecking=yes','-oUserKnownHostsFile='+t['knownHostsFile']]
    if t.get('jump'):ssh+=['-J',t['jump']]
    return [*ssh,t['host'],shlex.join(command)]

def verify(l,memory,limit,pod_uid,commands,namespace,pod_name,container,target):
    l.exact(memory,{'version','profile','podUID','limitBytes','beforeHTTP','afterHTTP'})
    need(memory['version']==2 and memory['profile']==PROFILE and memory['podUID']==pod_uid and memory['limitBytes']==limit,'Exact cache-aware memory profile required')
    samples=[]
    for name in ['beforeHTTP','afterHTTP']:
        item=memory[name];l.exact(item,{'sample','command'});need(item['command']in commands,'Memory sample outside observation journal')
        command=l.held(item['command']);need(command['exitCode']==0 and command['failure']is None and command['complete']is True,'Complete actual memory command required')
        need(command['argv']==argv(target,namespace,pod_name,container),'Memory command targets another owner')
        need(l.a.read_ref(command['stdin'])==SCRIPT.encode(),'Exact read-only memory script required')
        need(Path(command['stdin']['path']).parent==Path(item['command']['path']).parent,'Memory stdin escaped journal')
        sample=parse(l.a.read_ref(command['stdout']),limit);need(sample==item['sample'],'Memory health must rederive from exact raw observation');samples.append(sample)
    need(commands.index(memory['beforeHTTP']['command'])<commands.index(memory['afterHTTP']['command']),'Ordered distinct before/after HTTP memory observations required')
    need(samples[1]['events']['max']>=samples[0]['events']['max'] and samples[1]['peakBytes']>=samples[0]['peakBytes'],'Cgroup history reset or owner changed')
    need({p['pid']for p in samples[0]['processes']}=={p['pid']for p in samples[1]['processes']},'Nginx process set changed during observation')
