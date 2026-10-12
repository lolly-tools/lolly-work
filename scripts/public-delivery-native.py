# SPDX-License-Identifier: MPL-2.0
"""Bounded native inventories and memory observations; never change storage."""
import re
import shlex
import hashlib
import json


def need(value, reason):
    if not value: raise RuntimeError(reason)


def physical_program(root, exclude_models=False):
    need(root in {'/run/lolly-public-overlay/site', '/usr/share/nginx/html', '/usr/share/nginx/html/models'}, 'Fixed native root required')
    skip = 'case "$path" in models/*)continue;;esac' if exclude_models else ':'
    directories = ('find "$root" -type d -print0 | sort -z | while IFS= read -r -d "" file; do\n'
        ' path=${file#"$root/"}; [ "$file" != "$root" ] || path=.\n'
        ' printf "D\\t%s\\t%s\\n" "$path" "$(stat -c "%f %u %g %Y %i %d" "$file")"\ndone\n') if root.endswith('/models') else ''
    return ('set -eu; set -o pipefail; export LC_ALL=C TZ=UTC\nroot=' + shlex.quote(root) + '\n'
        '[ -z "$(find "$root" -type l -print -quit)" ]; [ -z "$(find "$root" ! -type f ! -type d -print -quit)" ]\n'
        + directories +
        'find "$root" -type f -print0 | sort -z | while IFS= read -r -d "" file; do\n'
        ' path=${file#"$root/"}; ' + skip + '\n'
        ' before=$(stat -c "%s %f %u %g %Y %i %d %h" "$file"); hash=$(sha256sum "$file"); hash=${hash%% *}\n'
        ' [ "$before" = "$(stat -c "%s %f %u %g %Y %i %d %h" "$file")" ]\n'
        ' printf "F\\t%s\\t%s\\t%s\\n" "$path" "$before" "$hash"\ndone\n'
        'printf "END\\tFULL_PHYSICAL_COMPLETE\\n"').encode()


def physical(data, expected, models=False):
    """Prove full hashes and all link membership inside the model root only."""
    lines = data.decode().splitlines(); need(lines and lines[-1] == 'END\tFULL_PHYSICAL_COMPLETE', 'Complete native inventory required')
    owner = {'uid': 101, 'gid': 101}
    rows, links, directories = {}, {}, {}; previous = ''; previous_directory = ''
    for line in lines[:-1]:
        parts = line.split('\t')
        if parts[0] == 'D':
            need(models and len(parts) == 3 and not rows, 'Model directory rows precede complete file inventory')
            path, fields = parts[1:]; values = fields.split(' ')
            need(path > previous_directory and len(values) == 6 and int(values[0], 16) & 0o170000 == 0o040000
                and int(values[0], 16) & 0o022 == 0 and values[1:4] == ['101', '101', '0'], 'Model directory UID/DAC/epoch differs')
            directories[path] = values; previous_directory = path; continue
        need(len(parts) == 4 and parts[0] == 'F', 'Exact physical row required')
        path, fields, sha = parts[1:]; values = fields.split(' ')
        need(path > previous and len(values) == 8 and int(values[1], 16) & 0o170000 == 0o100000
             and int(values[1], 16) & 0o022 == 0 and values[2:5] == [str(owner['uid']), str(owner['gid']), '0']
             and re.fullmatch('[a-f0-9]{64}', sha), 'Physical path/mode/UID/epoch/hash differs')
        size, count = int(values[0]), int(values[7]); need(size >= 0 and count > 0, 'Physical sizes/link counts must be positive')
        rows[path] = {'size': size, 'sha256': sha}; previous = path
        if models:
            group = links.setdefault((values[6], values[5]), {'count': count, 'body': rows[path], 'paths': []})
            need(group['count'] == count and group['body'] == rows[path], 'Model hardlink group has conflicting identities')
            group['paths'].append(path)
        else: need(count == 1, 'New static root cannot share mutable hardlinks')
    wanted = {(r['url'][8:] if models else r['path']): {'size': r['size'], 'sha256': r['sha256']} for r in expected}
    need(len(wanted) == len(expected) and rows == wanted, 'Complete native physical closure differs')
    if models:
        parents = {'.'} | {'/'.join(path.split('/')[:i]) for path in wanted for i in range(1, len(path.split('/')))}
        need(set(directories) == parents, 'Complete model directory closure differs')
    need(not models or all(v['count'] == len(v['paths']) for v in links.values()), 'A model inode has a link outside the complete owned root')
    if models: need(len({(v['body']['size'], v['body']['sha256']) for v in links.values()}) == len(links), 'Identical model bodies must match the accepted deduplicated inode grouping')
    return {'files': len(rows), 'bytes': sum(r['size'] for r in rows.values()), 'physicalEpoch': 0, **owner,
            'allPhysicalHashesVerified': True, 'modelLinkClosureVerified': models, 'hardLinkedFiles': sum(len(v['paths']) for v in links.values() if v['count'] > 1),
            'modelInodeFingerprint': hashlib.sha256(json.dumps({'directories': directories, 'files': sorted((device, inode, v['count'], v['body'], v['paths']) for (device, inode), v in links.items())}, sort_keys=True, separators=(',', ':')).encode()).hexdigest() if models else None}


MEMORY = r'''set -eu
printf 'M\tcurrent\t';cat /sys/fs/cgroup/memory.current
printf 'M\tpeak\t';cat /sys/fs/cgroup/memory.peak
printf 'M\tmax\t';cat /sys/fs/cgroup/memory.max
while read -r key value;do printf 'E\t%s\t%s\n' "$key" "$value";done < /sys/fs/cgroup/memory.events
for status in /proc/[0-9]*/status;do
  [ -r "$status" ]||continue
  name=$(sed -n 's/^Name:[[:space:]]*//p' "$status")
  [ "$name" = nginx ]||continue
  pid=${status#/proc/};pid=${pid%/status}
  uid=$(sed -n 's/^Uid:[[:space:]]*//p' "$status")
  rss=$(sed -n 's/^VmRSS:[[:space:]]*//p' "$status")
  printf 'P\t%s\t%s\t%s\n' "$pid" "$uid" "$rss"
done
printf 'END\tCGROUP_AND_NGINX_PROCESS_MEMORY_OBSERVED\n'
'''


def memory(data, limit, pod_uid):
    lines = data.decode().splitlines(); need(lines and lines[-1] == 'END\tCGROUP_AND_NGINX_PROCESS_MEMORY_OBSERVED', 'Incomplete native memory observation')
    values, events, processes = {}, {}, []
    for line in lines[:-1]:
        parts = line.split('\t')
        if parts[0] in {'M', 'E'}:
            need(len(parts) == 3 and parts[2].isdigit(), 'Malformed memory/event row')
            target = values if parts[0] == 'M' else events; need(parts[1] not in target, 'Duplicate memory/event row'); target[parts[1]] = int(parts[2])
        else:
            need(len(parts) in {4, 7} and parts[0] == 'P' and parts[1].isdigit(), 'Malformed native process row')
            uids = parts[2:-1] if len(parts) == 7 else parts[2].split(); rss = parts[-1].split()
            need(uids == ['101'] * 4 and len(rss) == 2 and rss[0].isdigit() and rss[1] == 'kB', 'Actual native UID/RSS differs')
            processes.append({'pid': int(parts[1]), 'rssBytes': int(rss[0]) * 1024})
    need(set(values) == {'current', 'peak', 'max'} and values['max'] == limit
         and 0 < values['current'] <= values['peak'] < limit and 1 <= len(processes) <= 16
         and events.get('oom') == events.get('oom_kill') == 0 and len({p['pid'] for p in processes}) == len(processes),
         'Actual native cgroup current/peak/limit/zeroOOM differs')
    # Individual process RSS is recorded; summing shared pages would overcount.
    rss = max(p['rssBytes'] for p in processes); need(0 < rss <= values['current'], 'Individual native RSS exceeds the observed cgroup bound')
    return {'version': 1, 'podUID': pod_uid, 'limitBytes': limit, 'currentBytes': values['current'], 'peakBytes': values['peak'],
            'oom': events['oom'], 'oomKill': events['oom_kill'], 'rssBytes': rss}
