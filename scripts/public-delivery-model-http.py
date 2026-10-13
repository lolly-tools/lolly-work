#!/usr/bin/env python3
"""Read-only, bounded HTTP model checks inside the isolated qualifier network.

Only loopback is accepted. No cookies, credentials, redirects or external hosts
are used. This proves HTTP bytes/validators, not Kubernetes mount custody.
"""
import hashlib
import http.client
import json
import re
import sys
from urllib.parse import urlsplit


def need(value, message):
    if not value:
        raise RuntimeError(message)


IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable, no-transform'
REVALIDATE = 'public, max-age=0, s-maxage=0, must-revalidate, no-transform'
PRIVATE = 'private, no-store, max-age=0, no-transform'
CORS_METHODS = 'GET, HEAD, OPTIONS'
CORS_HEADERS = 'Range, If-Range, If-None-Match'
CORS_EXPOSE = 'ETag, Content-Range, Accept-Ranges'


def request(origin, method, path, headers, maximum, origin_header='https://lolly.ing'):
    """Stream full responses without buffering weights; never follow a redirect."""
    u = urlsplit(origin)
    need(u.scheme == 'http' and u.hostname == '127.0.0.1' and u.port
         and not u.username and not u.password and not u.query and not u.fragment
         and u.path in {'', '/'}, 'Only explicit HTTP loopback is accepted')
    connection = http.client.HTTPConnection('127.0.0.1', u.port, timeout=60)
    try:
        sent = {'Accept-Encoding': 'gzip, br', **headers}
        if origin_header is not None:
            sent['Origin'] = origin_header
        connection.request(method, path, headers=sent)
        response = connection.getresponse()
        original_headers = response.getheaders()
        grouped = {}
        for key, value in original_headers:
            key = key.lower()
            grouped.setdefault(key, []).append(value)
        need(len(original_headers) <= 64 and sum(len(k) + len(v) for k, v in original_headers) <= 32768,
             'Response headers exceed bounded original capture')
        duplicates = {key: values for key, values in grouped.items() if len(values) > 1}
        known_cors = {'access-control-allow-origin': '*', 'access-control-allow-methods': CORS_METHODS,
                      'access-control-allow-headers': CORS_HEADERS, 'access-control-expose-headers': CORS_EXPOSE}
        known_range_error = response.status == 416 and set(duplicates) == set(known_cors) \
            and all(values == [known_cors[key], known_cors[key]] for key, values in duplicates.items())
        # Only this exact independently observed fail-closed 416 erratum is
        # admitted. Successful CORS and every other duplicated header stay strict.
        need(not duplicates, 'Unexpected duplicate response header; historical 416 erratum is not admitted for EA')
        values = {key: items[0] for key, items in grouped.items()}
        digest = hashlib.sha256()
        prefix = bytearray()
        size = 0
        while True:
            block = response.read(min(65536, maximum - size + 1))
            if not block:
                break
            size += len(block)
            need(size <= maximum, 'HTTP body exceeds exact reviewed bound')
            digest.update(block)
            if len(prefix) < 32:
                prefix.extend(block[:32 - len(prefix)])
        return {'status': response.status, 'headers': values, 'originalHeaders': original_headers,
                'knownDuplicateCors416': known_range_error, 'size': size,
                'sha256': digest.hexdigest(), 'prefix': bytes(prefix)}
    finally:
        connection.close()


def policy(response, row, status):
    need(response['status'] == status, 'Unexpected HTTP status for ' + row['url'])
    h = response['headers']
    addressed = bool(re.match(r'/models/[a-z0-9-]+@[0-9a-f]{16}/', row['url']))
    need(h.get('cache-control') == (IMMUTABLE if addressed else REVALIDATE), 'Model cache policy differs')
    need(h.get('cdn-cache-control') == ('max-age=31536000, no-transform' if addressed
         else 'max-age=0, must-revalidate, no-transform'), 'Model CDN policy differs')
    need(h.get('etag') == '"' + row['sha256'] + '"', 'Full SHA256 strong ETag differs')
    need(h.get('access-control-allow-origin') == '*', 'Constant wildcard CORS is required')
    need(h.get('access-control-allow-methods') == CORS_METHODS
         and h.get('access-control-allow-headers') == CORS_HEADERS
         and h.get('access-control-expose-headers') == CORS_EXPOSE, 'Browser model validators/ranges require complete CORS headers')
    need(not any(k in h for k in ('content-encoding', 'last-modified', 'vary', 'set-cookie',
         'access-control-allow-credentials', 'age', 'surrogate-key', 'cache-tag')),
         'Models must be identity-only, anonymous and date-validator-free')
    need(h.get('x-content-type-options') == 'nosniff', 'Model response lost security headers')


def observation(name, response):
    """Keep original status/header values and streamed hashes, never model bytes."""
    return {'check': name, **{key: response[key] for key in ('status', 'originalHeaders', 'size', 'sha256', 'knownDuplicateCors416')}}


def validate_rows(rows):
    need(type(rows) is list and 0 < len(rows) <= 4096, 'Bounded reviewed model inventory required')
    previous = ''
    total = 0
    for row in rows:
        need(type(row) is dict and set(row) == {'url', 'size', 'sha256'}, 'Exact model row required')
        need(type(row['url']) is str and re.fullmatch(r'/models/[a-z0-9-]+(?:@[0-9a-f]{16})?/[A-Za-z0-9_./-]+', row['url'])
             and all(part and not part.startswith('.') for part in row['url'][8:].split('/'))
             and not row['url'].endswith(('.gz', '.br')) and row['url'] > previous,
             'Model paths must be safe, sorted and unique')
        need(type(row['size']) is int and 0 <= row['size'] <= 2 * 1024**3
             and type(row['sha256']) is str and re.fullmatch('[0-9a-f]{64}', row['sha256']),
             'Exact bounded size and full SHA256 required')
        previous = row['url']
        total += row['size']
    need(total <= 8 * 1024**3, 'Logical model bytes exceed qualification bound')


def verify(config, *, _reuse=None):
    need(type(config) is dict and set(config) == {'version', 'origin', 'inventorySha256', 'files'}
         and type(config['version']) is int and config['version'] == 1, 'Exact HTTP verification input required')
    rows = config['files']
    validate_rows(rows)
    encoded = json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
    need(hashlib.sha256(encoded).hexdigest() == config['inventorySha256'], 'HTTP inventory pin differs')
    origin = config['origin']
    prior = validate_reuse(config, _reuse) if _reuse is not None else None
    results = []
    captured = 0
    for row in rows:
        url, size, etag = row['url'], row['size'], '"' + row['sha256'] + '"'
        head = request(origin, 'HEAD', url, {}, 0)
        policy(head, row, 200)
        need(head['size'] == 0 and head['headers'].get('content-length') == str(size)
             and head['headers'].get('accept-ranges') == 'bytes', 'Native model HEAD differs')
        observed = [observation('HEAD Origin:https://lolly.ing', head)]
        for cors_origin in (None, 'null', 'https://lolly.tools', 'https://example.net'):
            cors = request(origin, 'HEAD', url, {}, 0, origin_header=cors_origin)
            policy(cors, row, 200)
            need(cors['headers'].get('content-length') == str(size), 'Anonymous CORS matrix HEAD size differs')
            observed.append(observation('HEAD Origin:' + str(cors_origin), cors))
        preflight = request(origin, 'OPTIONS', url, {'Access-Control-Request-Method': 'GET',
                            'Access-Control-Request-Headers': CORS_HEADERS}, 0)
        h = preflight['headers']
        need(preflight['status'] == 204 and preflight['size'] == 0
             and h.get('access-control-allow-origin') == '*'
             and h.get('access-control-allow-methods') == CORS_METHODS
             and h.get('access-control-allow-headers') == CORS_HEADERS
             and h.get('access-control-expose-headers') == CORS_EXPOSE
             and h.get('cache-control') == REVALIDATE
             and h.get('cdn-cache-control') == 'max-age=0, must-revalidate, no-transform'
             and h.get('etag') == etag
             and not any(key in h for key in ('last-modified', 'vary', 'content-encoding',
                         'access-control-allow-credentials', 'set-cookie', 'age', 'cache-tag', 'surrogate-key')),
             'Anonymous Range/If-Range browser preflight requires zero-TTL cache policy and complete CORS')
        observed.append(observation('OPTIONS Range/If-Range/If-None-Match preflight', preflight))
        reuse = prior is not None and size > 65536
        if reuse:
            observed.append({'check': 'REUSED GET full body', 'original': prior[url]['GET full body']})
        else:
            full = request(origin, 'GET', url, {}, size)
            policy(full, row, 200)
            need(full['size'] == size and full['sha256'] == row['sha256']
                 and full['headers'].get('content-length') == str(size), 'Actual HTTP model bytes differ')
            observed.append(observation('GET full body', full))
        for candidate in (etag, 'W/' + etag):
            same = request(origin, 'GET', url, {'If-None-Match': candidate}, 0)
            policy(same, row, 304)
            need(same['size'] == 0, 'Conditional model response contains a body')
            observed.append(observation('GET If-None-Match:' + candidate, same))
        if size:
            count = min(size, 32)
            for extra in ({}, {'If-Range': etag}, {'If-None-Match': '"unrecognized-full-model-hash"'}):
                partial = request(origin, 'GET', url, {'Range': f'bytes=0-{count - 1}', **extra}, count)
                policy(partial, row, 206)
                need(partial['size'] == count and (partial['sha256'] == prior[url]['GET Range ' + json.dumps(extra, sort_keys=True)]['sha256'] if reuse else partial['prefix'] == full['prefix'][:count])
                     and partial['headers'].get('content-length') == str(count)
                     and partial['headers'].get('content-range') == f'bytes 0-{count - 1}/{size}',
                     'Identity Range or strong If-Range differs')
                observed.append(observation('GET Range ' + json.dumps(extra, sort_keys=True), partial))
            if reuse:
                observed.append({'check': 'REUSED GET mismatching If-Range full body', 'original': prior[url]['GET mismatching If-Range full body']})
            else:
                mismatch = request(origin, 'GET', url, {'Range': 'bytes=0-0', 'If-Range': '"unrecognized-full-model-hash"'}, size)
                policy(mismatch, row, 200)
                need(mismatch['size'] == size and mismatch['sha256'] == row['sha256']
                     and 'content-range' not in mismatch['headers'], 'Mismatched If-Range must return the entire current file')
                observed.append(observation('GET mismatching If-Range full body', mismatch))
            invalid = request(origin, 'GET', url, {'Range': f'bytes={size}-{size + 1}'}, 65536)
            need(invalid['status'] == 416 and invalid['headers'].get('cache-control') == PRIVATE
                 and invalid['headers'].get('cdn-cache-control') == 'no-store'
                 and invalid['headers'].get('content-range') == f'bytes */{size}'
                 and invalid['knownDuplicateCors416'] is False
                 and invalid['headers'].get('access-control-allow-origin') == '*'
                 and invalid['headers'].get('access-control-allow-methods') == CORS_METHODS
                 and invalid['headers'].get('access-control-allow-headers') == CORS_HEADERS
                 and invalid['headers'].get('access-control-expose-headers') == CORS_EXPOSE
                 and not any(key in invalid['headers'] for key in ('etag', 'last-modified', 'content-encoding',
                             'set-cookie', 'age', 'vary', 'cache-tag', 'surrogate-key', 'access-control-allow-credentials')),
                 'Strict single-CORS negative Range must remain private/no-store with no ETag')
            observed.append(observation('GET unsatisfiable Range', invalid))
        result = {'url': url, 'size': size, 'sha256': row['sha256'],
                        'head': True, 'conditional304': True, 'strongIfRange': bool(size),
                        'mismatchedIfRange200': bool(size), 'identityOnly': True,
                        'successfulResponseWildcardCors': True, 'lastModifiedIntentionallyAbsent': True,
                        'range416BrowserReadableCors': True if size else None,
                        'responses': observed, **({'largeFullBodyProofReused': reuse} if prior is not None else {})}
        captured += len(json.dumps(result, separators=(',', ':')).encode())
        need(captured <= 12 * 1024**2, 'Original HTTP receipt exceeds bounded aggregate capture')
        results.append(result)
    forbidden = ['/models/model-manifest.json', '/models/models-release.json',
                 '/models/.lolly-model-release.json', '/models/.delivery-etags.conf',
                 '/models/.operator-receipt.json', '/.delivery-etags.conf',
                 '/models/nonexistent@0000000000000000/missing.onnx']
    forbidden_observed = []
    for url in forbidden:
        response = request(origin, 'GET', url, {}, 65536)
        need(response['status'] == 404 and response['headers'].get('cache-control') == PRIVATE
             and response['headers'].get('cdn-cache-control') == 'no-store'
             and not any(k in response['headers'] for k in ('etag', 'set-cookie', 'age', 'cache-tag', 'surrogate-key')),
             'Missing or operator control file was exposed or publicly cached')
        forbidden_observed.append({'url': url, **observation('GET forbidden', response)})
    health = request(origin, 'GET', '/healthz', {}, 16)
    need(health['status'] == 200 and health['prefix'] == b'ok\n', 'Isolated static server is unhealthy')
    return {'version': 1, 'status': ('SAME_OWNER_MODEL_HTTP_PROTOCOL_RECHECK_WITH_EXPLICIT_BODY_REUSE' if prior is not None else 'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY'),
            'inventorySha256': config['inventorySha256'], 'files': len(results),
            'logicalBytes': sum(r['size'] for r in rows), 'rows': results,
            'forbiddenPaths404': forbidden, 'forbiddenResponses': forbidden_observed,
            'physicalEpochNotEstablishedByHttp': True,
            'lastModifiedIntentionallyAbsent': True, 'kubernetesMountCustodyEstablished': False,
            'openErrata': [],
            'productionPublicationQualified': False, 'readOnly': True,
            **({'healthResponse': observation('GET health', health)} if prior is not None else {})}



def validate_reuse(config, proof):
    """Prior bytes remain explicitly prior; never fabricate a current response."""
    need(type(proof) is dict and proof.get('version') == 1
         and proof.get('status') == 'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY'
         and proof.get('inventorySha256') == config['inventorySha256']
         and proof.get('files') == len(config['files'])
         and proof.get('logicalBytes') == sum(r['size'] for r in config['files'])
         and proof.get('openErrata') == [] and proof.get('readOnly') is True,
         'Complete original full-body model proof required')
    need(type(proof.get('rows')) is list and len(proof['rows']) == len(config['files']), 'Original model rows missing')
    out = {}
    for expected, row in zip(config['files'], proof['rows']):
        need(all(row.get(k) == expected[k] for k in ['url', 'size', 'sha256']), 'Original model inventory changed')
        responses = row.get('responses'); need(type(responses) is list and responses, 'Original response custody missing')
        checks = {r['check']: r for r in responses}
        need(len(checks) == len(responses), 'Duplicate original HTTP check')
        for name in ['GET full body'] + (['GET mismatching If-Range full body'] if expected['size'] else []):
            r = checks.get(name, {}); need(r.get('status') == 200 and r.get('size') == expected['size'] and r.get('sha256') == expected['sha256'], 'Original complete body differs')
            headers = r.get('originalHeaders', []); need(len(headers) == len({k.lower() for k, _ in headers}), 'Original duplicated headers')
            policy({'status': r['status'], 'headers': {k.lower(): v for k, v in headers}}, expected, 200)
        if expected['size']:
            for extra in ({}, {'If-Range': '"' + expected['sha256'] + '"'}, {'If-None-Match': '"unrecognized-full-model-hash"'}):
                r = checks.get('GET Range ' + json.dumps(extra, sort_keys=True), {})
                need(r.get('status') == 206 and r.get('size') == min(expected['size'], 32)
                     and type(r.get('sha256')) is str and re.fullmatch('[a-f0-9]{64}', r['sha256']), 'Original bounded range proof differs')
        out[row['url']] = checks
    return out


def verify_repeat(config, original):
    return verify(config, _reuse=original)



def validate_repeat_report(config, original, fresh):
    """Re-run the same pure protocol oracle over held observations, no network."""
    prior = validate_reuse(config, original)
    need(type(fresh) is dict and fresh.get('status') == 'SAME_OWNER_MODEL_HTTP_PROTOCOL_RECHECK_WITH_EXPLICIT_BODY_REUSE', 'Explicit repeated HTTP report required')
    queues = {}
    for row in fresh['rows']:
        need(row['url'] in prior and row['url'] not in queues, 'Repeated model URL differs')
        queues[row['url']] = iter([v for v in row['responses'] if not v['check'].startswith('REUSED ')])
        for response in row['responses']:
            if response['check'].startswith('GET Range '):
                need(response['sha256'] == prior[row['url']][response['check']]['sha256'], 'Actual repeated range bytes differ from original')
    for response in fresh['forbiddenResponses']:
        need(response['url'] not in queues, 'Repeated forbidden URL duplicated'); queues[response['url']] = iter([response])
    health = fresh['healthResponse']; need(health['status'] == 200 and health['size'] == 3 and health['sha256'] == hashlib.sha256(b'ok\n').hexdigest(), 'Actual repeated health body differs')
    queues['/healthz'] = iter([health])
    def held_request(_origin, _method, path, _headers, maximum, origin_header='https://lolly.ing'):
        need(path in queues, 'Repeated HTTP response missing'); r = next(queues[path])
        headers = r['originalHeaders']; need(len(headers) <= 64 and len(headers) == len({k.lower() for k, _ in headers}) and r['size'] <= maximum, 'Repeated response headers/size differ')
        return {**r, 'headers': {k.lower():v for k,v in headers},
                'prefix': b'ok\n' if path == '/healthz' else b'\0' * min(r['size'],32)}
    global request
    old = request
    try:
        request = held_request
        expected = verify_repeat(config, original)
        need(expected == fresh, 'Repeated HTTP report does not rederive from complete original observations')
        for queue in queues.values(): need(next(queue, None) is None, 'Unexpected repeated HTTP response')
    finally: request = old


if __name__ == '__main__':
    try:
        value = sys.stdin.buffer.read(1024**2 + 1)
        need(len(value) <= 1024**2, 'HTTP verification input exceeds bound')
        print(json.dumps(verify(json.loads(value)), sort_keys=True, separators=(',', ':')))
    except Exception:
        print('REFUSED: HTTP model bytes, headers, validators or forbidden paths differ', file=sys.stderr)
        raise SystemExit(1)
