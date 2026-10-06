// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as buildCaddy } from '../scripts/build-caddyfile.ts';
import { resolveCaddyRoute } from '../scripts/vercel-routes.ts';
import { vmDomain } from '../scripts/vm-domain.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary: string[] = [];
after(() => { for (const directory of temporary) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'lw-vm-domain-')); temporary.push(path); return path; };
const config = (baseUrl: unknown) => JSON.stringify({ instance: { baseUrl } });

test('the VM domain comes from a canonical bare HTTPS instance origin', () => {
  assert.equal(vmDomain(config('https://workspace.example.com')), 'workspace.example.com');
  assert.equal(vmDomain(config('https://workspace.example.com/')), 'workspace.example.com');
  for (const value of [undefined, 42, 'http://workspace.example.com', 'https://workspace.example.com:8443',
    'https://u:p@workspace.example.com', 'https://workspace.example.com/app', 'https://workspace.example.com?x=1',
    'https://workspace.example.com#section', 'https://workspace.example.com?', 'https://workspace.example.com\\bad',
    'https://bad;host.example.com', 'https://workspace.example.com\n', 'https://localhost']) {
    assert.throws(() => vmDomain(config(value)), /VM instance.baseUrl/, String(value));
  }
});

test('a custom Caddy domain has only explicitly requested aliases and retains private auth routing', () => {
  const out = join(directory(), 'Caddyfile');
  assert.equal(buildCaddy(['--domain', 'workspace.example.com', '--serve-shell', '--out', out]), 0);
  let text = readFileSync(out, 'utf8');
  assert.match(text, /^workspace\.example\.com \{$/m);
  assert.doesNotMatch(text, /www\.lolly\.ing|redir https:/);
  assert.equal(buildCaddy(['--domain', 'workspace.example.com', '--redirect', 'design.example.com', '--out', out]), 0);
  text = readFileSync(out, 'utf8');
  assert.match(text, /^design\.example\.com \{\n\tredir https:\/\/workspace\.example\.com\{uri\} 308/m);
  assert.doesNotMatch(text, /www\.lolly\.ing/);
  for (const path of ['/api/auth/login', '/api/auth/callback', '/api/v1/agents/activity', '/ws/collab/test']) {
    assert.deepEqual(resolveCaddyRoute({ shellOrigin: 'https://lolly.tools' }, path), { to: 'server', path });
  }
});

function smokeFixture() {
  const dir = directory();
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls.jsonl'); writeFileSync(calls, '');
  const curl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
const destination = new URL(args.at(-1));
const domain = process.env.TEST_DOMAIN || 'lolly.ing';
const auth = process.env.TEST_AUTHORIZE_ORIGIN || 'https://accounts.google.com';
let status = 200, body = 'healthy', location = '';
if (destination.hostname !== domain) { status = 308; location = 'https://' + domain + destination.pathname + destination.search; }
else if (destination.pathname === '/api/auth/login') {
  if (destination.searchParams.has('idp') || process.env.TEST_CHOOSER_REDIRECT === '1') {
    status = 302;
    location = auth + '/authorize?redirect_uri=' + encodeURIComponent('https://' + (process.env.TEST_CALLBACK_DOMAIN || domain) + '/api/auth/callback');
  } else body = '<h1>Sign in</h1><p>Email and password</p>';
} else if (['/catalog/tools/index.json', '/api/v1/agents/activity', '/ws/collab/smoke-test'].includes(destination.pathname)) status = 401;
else if (destination.pathname === '/sw.js') body = "const CACHE = 'lolly-test'; self.addEventListener('fetch', () => {});";
fs.writeFileSync(args[args.indexOf('-D') + 1], 'HTTP/1.1 ' + status + '\\r\\nStrict-Transport-Security: max-age=63072000\\r\\n' + (location ? 'Location: ' + location + '\\r\\n' : '') + '\\r\\n');
fs.writeFileSync(args[args.indexOf('-o') + 1], body);
process.stdout.write(String(status));
`;
  writeFileSync(join(bin, 'curl'), curl); chmodSync(join(bin, 'curl'), 0o755);
  return {
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]),
    run: (args: string[], env: Record<string, string> = {}) => spawnSync('bash', [join(ROOT, 'deploy/vm/smoke.sh'), '192.0.2.1', ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, CALLS: calls, ...env },
    }),
  };
}

test('smoke retains lolly.ing Google and www checks by default', () => {
  const fixture = smokeFixture();
  const result = fixture.run([]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const urls = fixture.calls().map(args => args.at(-1)!);
  assert.ok(urls.includes('https://lolly.ing/api/auth/login?idp=primary&returnTo=%2F'));
  assert.ok(urls.includes('https://www.lolly.ing/t/qr-code?x=1'));
});

test('a password-only custom instance is checked without assuming Google or an unconfigured www alias', () => {
  const fixture = smokeFixture();
  const result = fixture.run(['--domain', 'workspace.example.com'], { TEST_DOMAIN: 'workspace.example.com' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SKIP.*external provider redirect/);
  const calls = fixture.calls();
  assert.ok(calls.every(args => !args.join(' ').includes('lolly.ing')));
  assert.ok(calls.every(args => !args.at(-1)!.includes('idp=') && !args.at(-1)!.includes('www.')));
  assert.ok(calls.every(args => args.includes('workspace.example.com:443:192.0.2.1')));
});

test('an explicit non-Google provider and alias are checked with the custom callback; a foreign callback fails', () => {
  const fixture = smokeFixture();
  const args = ['--domain', 'workspace.example.com', '--redirect', 'design.example.com', '--idp', 'github', '--authorize-origin', 'https://github.com'];
  const env = { TEST_DOMAIN: 'workspace.example.com', TEST_AUTHORIZE_ORIGIN: 'https://github.com', TEST_CHOOSER_REDIRECT: '1' };
  const result = fixture.run(args, env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fixture.calls().some(args => args.at(-1) === 'https://workspace.example.com/api/auth/login?idp=github&returnTo=%2F'));
  assert.ok(fixture.calls().some(args => args.at(-1) === 'https://design.example.com/t/qr-code?x=1'));
  const wrong = fixture.run(args, { ...env, TEST_CALLBACK_DOMAIN: 'lolly.ing' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /FAIL.*github.*callback/);
});

test('unsafe domains and incomplete provider expectations fail before a request', () => {
  for (const args of [['--domain', 'https://workspace.example.com'], ['--domain', 'bad;host.example.com'],
    ['--domain', 'workspace.example.com', '--idp', 'github'],
    ['--domain', 'workspace.example.com', '--idp', 'github', '--authorize-origin', 'http://github.com']]) {
    const fixture = smokeFixture();
    const result = fixture.run(args);
    assert.equal(result.status, 1);
    assert.deepEqual(fixture.calls(), []);
  }
});

test('remote deploy uses the instance domain and refuses a mismatched render origin before service changes', () => {
  const source = readFileSync(join(ROOT, 'deploy/vm/push.sh'), 'utf8');
  assert.match(source, /domain=\$\(node scripts\/vm-domain.ts deploy\/vm\/instance.json\)/);
  const script = /<<'REMOTE_SCRIPT' \|\| true\n([\s\S]*?)\nREMOTE_SCRIPT\n/.exec(source)?.[1];
  assert.ok(script);
  const dir = directory();
  for (const path of ['src', 'packs/lolly-ing', 'caddy']) mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, '.env'), 'EXAMPLE_PRIVATE_SECRET=do-not-print\n');
  writeFileSync(join(dir, 'instance.json'), '{}');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls'); writeFileSync(calls, '');
  const files = {
    sudo: '[ "$1" = -n ] || exit 1\nshift\nexec "$@"',
    docker: `echo "docker $*" >> "$CALLS"
case "$*" in *'--profile render config --format json'*) printf '{"services":{"render-worker":{"environment":{"LOLLY_WEB_BASE":"%s"}}}}' "$TEST_RENDER_ORIGIN" ;; esac`,
    curl: 'echo "curl $*" >> "$CALLS"',
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`); chmodSync(join(bin, name), 0o755);
  }
  const local = script.replaceAll('/opt/lolly-ing', dir);
  const run = (origin: string) => spawnSync('bash', ['-c', local, 'push-remote', 'internal', '1', 'workspace.example.com'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, TEST_RENDER_ORIGIN: origin },
  });
  const wrong = run('https://lolly.ing');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /set LOLLY_WEB_BASE.*match instance.baseUrl/);
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /build|up -d|force-recreate/);
  assert.doesNotMatch(wrong.stdout + wrong.stderr, /do-not-print/);
  writeFileSync(calls, '');
  const valid = run('https://workspace.example.com');
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(readFileSync(calls, 'utf8'), /--resolve workspace.example.com:443:127.0.0.1 https:\/\/workspace.example.com\/healthz/);
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /lolly.ing\/healthz/);
});
