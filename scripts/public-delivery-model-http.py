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


def verify(config):
    need(type(config) is dict and set(config) == {'version', 'origin', 'inventorySha256', 'files'}
         and type(config['version']) is int and config['version'] == 1, 'Exact HTTP verification input required')
    rows = config['files']
    validate_rows(rows)
    encoded = json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
    need(hashlib.sha256(encoded).hexdigest() == config['inventorySha256'], 'HTTP inventory pin differs')
    origin = config['origin']
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
                need(partial['size'] == count and partial['prefix'] == full['prefix'][:count]
                     and partial['headers'].get('content-length') == str(count)
                     and partial['headers'].get('content-range') == f'bytes 0-{count - 1}/{size}',
                     'Identity Range or strong If-Range differs')
                observed.append(observation('GET Range ' + json.dumps(extra, sort_keys=True), partial))
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
        result = {'url': url, 'size': size, 'sha256': full['sha256'],
                        'head': True, 'conditional304': True, 'strongIfRange': bool(size),
                        'mismatchedIfRange200': bool(size), 'identityOnly': True,
                        'successfulResponseWildcardCors': True, 'lastModifiedIntentionallyAbsent': True,
                        'range416BrowserReadableCors': True if size else None,
                        'responses': observed}
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
    return {'version': 1, 'status': 'ISOLATED_MODEL_HTTP_BYTES_VERIFIED_ONLY',
            'inventorySha256': config['inventorySha256'], 'files': len(results),
            'logicalBytes': sum(r['size'] for r in rows), 'rows': results,
            'forbiddenPaths404': forbidden, 'forbiddenResponses': forbidden_observed,
            'physicalEpochNotEstablishedByHttp': True,
            'lastModifiedIntentionallyAbsent': True, 'kubernetesMountCustodyEstablished': False,
            'openErrata': [],
            'productionPublicationQualified': False, 'readOnly': True}


if __name__ == '__main__':
    try:
        value = sys.stdin.buffer.read(1024**2 + 1)
        need(len(value) <= 1024**2, 'HTTP verification input exceeds bound')
        print(json.dumps(verify(json.loads(value)), sort_keys=True, separators=(',', ':')))
    except Exception:
        print('REFUSED: HTTP model bytes, headers, validators or forbidden paths differ', file=sys.stderr)
        raise SystemExit(1)
