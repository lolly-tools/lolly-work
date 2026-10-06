// SPDX-License-Identifier: MPL-2.0
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CADDYFILE_PATH } from '../scripts/build-caddyfile.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/build-caddyfile.ts');
const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

function outputFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-caddy-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'Caddyfile');
}

test('the documented relay CLI generates a custom native shell and checks it without writing', t => {
  const out = outputFile(t);
  const args = ['--domain', 'workspace.example.test', '--serve-shell', '--live-relay-upstream', 'live-relay:8790', '--out', out];
  const generated = cli(...args);
  assert.equal(generated.status, 0, generated.stderr);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^workspace\.example\.test \{$/m);
  assert.doesNotMatch(text, /www\.lolly\.ing/);
  const relay = text.slice(text.indexOf('\thandle @live_relay'), text.indexOf('\t@shell_functions'));
  assert.match(relay, /reverse_proxy live-relay:8790 \{/);
  assert.match(relay, /header_up -Cookie/);
  assert.doesNotMatch(relay, /-Authorization/, 'relay bearer credentials are preserved');
  assert.ok(text.indexOf('handle @live_relay') < text.indexOf('handle @shell_functions'));
  const fallback = text.slice(text.lastIndexOf('\thandle {'));
  assert.match(fallback, /reverse_proxy server:8787/);
  assert.equal(cli(...args, '--check').status, 0);
  assert.equal(readFileSync(out, 'utf8'), text);

  const stale = `${text}# operator change\n`;
  writeFileSync(out, stale);
  const checked = cli(...args, '--check');
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /is not current/);
  assert.equal(readFileSync(out, 'utf8'), stale, '--check never overwrites an operator change');
});

test('relay CLI also preserves the proxied shell mode and the default Caddyfile', t => {
  const out = outputFile(t);
  const original = readFileSync(CADDYFILE_PATH, 'utf8');
  const generated = cli('--live-relay-upstream', '[::1]:8790', '--out', out);
  assert.equal(generated.status, 0, generated.stderr);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /^www\.lolly\.ing \{$/m);
  assert.match(text, /reverse_proxy \[::1\]:8790/);
  assert.match(text.slice(text.lastIndexOf('\thandle {')), /reverse_proxy https:\/\/lolly\.tools/);
  assert.equal(cli('--check').status, 0, 'the relay remains opt-in');
  assert.equal(readFileSync(CADDYFILE_PATH, 'utf8'), original);
});

test('relay CLI refuses malformed addresses before overwriting an output file', t => {
  const out = outputFile(t);
  const sentinel = '# preserve this operator file\n';
  writeFileSync(out, sentinel);
  for (const upstream of ['https://live-relay:8790', 'live-relay:8790/live', 'user@live-relay:8790',
    'live-relay:0', 'live-relay:65536', 'live-relay:8790\nrespond hacked', 'live-relay:8790 {',
    '{$RELAY}:8790', 'live-relay:8790 other:8790', '[not-an-ip]:8790', '999.1.1.1:8790']) {
    const result = cli('--out', out, '--live-relay-upstream', upstream);
    assert.equal(result.status, 1, upstream);
    assert.match(result.stderr, /live relay upstream must be host:port/, upstream);
    assert.equal(readFileSync(out, 'utf8'), sentinel, upstream);
  }
  const missing = cli('--out', out, '--live-relay-upstream', '--serve-shell');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--live-relay-upstream needs a value/);
  assert.equal(readFileSync(out, 'utf8'), sentinel);
});
