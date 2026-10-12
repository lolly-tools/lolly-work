# SPDX-License-Identifier: MPL-2.0
"""Real native loopback and normal-TLS HTTP checks without credentials."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import ssl
from urllib.parse import urlsplit

# Includes every component and stored newline within the strict cohort parser.
HTTP_REPORT_LIMIT = 32 * 1024**2


def report_bytes(value):
    data = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode() + b'\n'
    if len(data) > HTTP_REPORT_LIMIT: raise RuntimeError('Complete HTTP report exceeds 32 MiB envelope')
    return data


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def verify_models_tls(origin, files):
    """Use the same strict model oracle with authenticated server TLS transport."""
    u = urlsplit(origin)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in {'', '/'}: raise RuntimeError('Exact normal TLS origin required')
    verifier = module('delivery_tls_models', 'public-delivery-model-http.py')
    def request(actual_origin, method, path, headers, maximum, origin_header='https://example.net'):
        if actual_origin != origin or not (path.startswith('/models/') or path in {'/.delivery-etags.conf', '/healthz'}): raise RuntimeError('Model origin/path changed')
        connection = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=60, context=ssl.create_default_context())
        try:
            sent = {'Accept-Encoding': 'gzip, br', **headers}
            if origin_header is not None: sent['Origin'] = origin_header
            connection.request(method, path, headers=sent); response = connection.getresponse(); original = response.getheaders()
            if len(original) > 64 or sum(len(k) + len(v) for k, v in original) > 32768: raise RuntimeError('Bounded original TLS response headers required')
            grouped = {}
            for key, value in original: grouped.setdefault(key.lower(), []).append(value)
            if any(len(values) != 1 for values in grouped.values()): raise RuntimeError('Duplicate TLS response header refused')
            digest, prefix, size = hashlib.sha256(), bytearray(), 0
            while block := response.read(min(65536, maximum - size + 1)):
                size += len(block)
                if size > maximum: raise RuntimeError('Exact TLS response byte bound exceeded')
                digest.update(block)
                if len(prefix) < 32: prefix.extend(block[:32 - len(prefix)])
            return {'status': response.status, 'headers': {k: v[0] for k, v in grouped.items()}, 'originalHeaders': original,
                'knownDuplicateCors416': False, 'size': size, 'sha256': digest.hexdigest(), 'prefix': bytes(prefix)}
        finally: connection.close()
    verifier.request = request
    encoded = json.dumps(files, separators=(',', ':')).encode()
    return verifier.verify({'version': 1, 'origin': origin, 'inventorySha256': hashlib.sha256(encoded).hexdigest(), 'files': files})


def verify_static_tls(origin, rows):
    u = urlsplit(origin)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in {'', '/'}: raise RuntimeError('Exact normal TLS origin required')
    model = module('delivery_static_tls_policy', 'public-delivery-model-http.py')
    static = module('delivery_static_tls_assertions', 'public-delivery-static-http.py')
    records = []
    if len(rows) != 4: raise RuntimeError('All four mutable static identities required')
    for row in rows:
        connection = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=60, context=ssl.create_default_context())
        try:
            connection.request('GET', '/' + row['path'], headers={'Accept-Encoding': 'identity'})
            response = connection.getresponse(); headers = response.getheaders(); names = [k.lower() for k, _ in headers]
            if len(headers) > 64 or len(names) != len(set(names)) or sum(len(k) + len(v) for k, v in headers) > 32768: raise RuntimeError('Bounded duplicate-free static TLS headers required')
            size, digest = 0, hashlib.sha256()
            while block := response.read(min(65536, row['size'] - size + 1)):
                size += len(block)
                if size > row['size']: raise RuntimeError('Exact static TLS body bound')
                digest.update(block)
            value = {'status': response.status, 'headers': {k.lower(): v for k, v in headers}, 'originalHeaders': headers, 'size': size, 'sha256': digest.hexdigest()}
            static.policy(value, row, 200, model.__dict__)
            if size != row['size'] or value['sha256'] != row['sha256']: raise RuntimeError('Complete normal TLS static identity differs')
            records.append({'path': row['path'], **value})
        finally: connection.close()
    return {'status': 'ACTUAL_NORMAL_TLS_MUTABLE_ROOT_IDENTITIES_VERIFIED', 'rows': records}


def payload(rows, retained):
    lookup = {row['path']: row for row in rows}; paths = ['index.html', 'precache.json', 'sw.js', 'portable/player.js']
    for family in ['_app/', 'catalog/', 'tools/', 'info/']:
        candidates = [p for p in sorted(lookup) if p.startswith(family) and not p.endswith(('.gz', '.br'))]
        if not candidates: raise RuntimeError('Required native static family missing')
        paths += candidates[:3]
    identities = [lookup[p] for p in retained if not p.endswith(('.gz', '.br'))]
    # A frontend build may already include every retained body; still exercise
    # an actual immutable route rather than invent an empty positive oracle.
    if not identities: identities = [lookup[next(p for p in sorted(lookup) if p.startswith('_app/') and not p.endswith(('.gz', '.br')))]]
    budget = module('delivery_static_metadata_budget', 'public-delivery-static-http.py').retained_budget(identities)
    return {'samples': [{'identity': lookup[p], 'gzip': lookup.get(p + '.gz')} for p in dict.fromkeys(paths)], 'retained': identities, 'retainedBudget': budget}


NAMESPACE_HTTP = r'''import json,pathlib,subprocess,sys
x=json.load(sys.stdin);r=subprocess.run(['/usr/local/bin/k3s','crictl','inspect','-o','go-template','--template','{{.info.pid}}',x['container']],capture_output=True,timeout=30)
if r.returncode or len(r.stdout)>64 or len(r.stderr)>4096:raise RuntimeError('Actual native PID lookup refused')
pid=int(r.stdout);p=pathlib.Path('/proc')/str(pid);before=p.stat();net=(p/'ns/net').stat();start=(p/'stat').read_text().rsplit(')',1)[1].split()[19]
if pid<=1 or '\nUid:\t101\t'not in(p/'status').read_text() or x['container'] not in(p/'cgroup').read_text():raise RuntimeError('Actual native UID101/container membership refused')
program="import json,sys;x=json.load(sys.stdin);m={'__name__':'models'};s={'__name__':'static'};d={'__name__':'decoded'};exec(x['sources']['public-delivery-model-http.py'],m);exec(x['sources']['public-delivery-static-http.py'],s);exec(x['sources']['public-delivery-decoded-http.py'],d);origin='http://127.0.0.1:8080';print(json.dumps({'static':s['verify_static']({'origin':origin,**x['payload']},m),'decoded':d['verify_decoded'](origin,x['payload']['samples'])},separators=(',',':')))"
child=subprocess.run(['nsenter','--target',str(pid),'--net','python3','-c',program],input=json.dumps(x,separators=(',',':')).encode(),capture_output=True,timeout=2400,env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'})
if p.stat().st_ino!=before.st_ino or(p/'ns/net').stat().st_ino!=net.st_ino or(p/'stat').read_text().rsplit(')',1)[1].split()[19]!=start or child.returncode or len(child.stdout)>__HTTP_REPORT_LIMIT__-1 or len(child.stderr)>65536:raise RuntimeError('Actual namespace native HTTP refused')
print(child.stdout.decode())
'''.replace('__HTTP_REPORT_LIMIT__', str(HTTP_REPORT_LIMIT))
