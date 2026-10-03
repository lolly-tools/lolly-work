// SPDX-License-Identifier: MPL-2.0
/**
 * deploy/vm/rotate-secrets.sh, which the operator runs to replace
 * LW_SESSION_SECRET and LW_LINK_SECRET on the VM and on the Vercel rollback.
 * Static checks (strict mode, no tracing, umask, no value echoed or put on a
 * command line), then runs against stand-ins for ssh, sudo, docker, curl and
 * vercel: the audit head is recorded before anything changes, the VM's .env is
 * rewritten in place with every other line kept, Vercel gets the same values
 * on standard input in one overwrite per variable, the server is recreated,
 * and neither value appears in any output or argument list. When a run stops
 * part way, by a failure or Ctrl-C, it reports the state of each side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'vm', 'rotate-secrets.sh');
const text = readFileSync(SCRIPT, 'utf8');
const HEAD_HASH = 'ab'.repeat(32);

test('rotate-secrets.sh: strict mode, no tracing, private umask, and it parses', () => {
  assert.match(text, /^#!\/usr\/bin\/env bash\n/);
  assert.match(text, /^set -euo pipefail$/m);
  assert.match(text, /^set \+x$/m);
  assert.match(text, /^umask 077$/m);
  assert.match(text, /^trap 'on_exit \$\?' EXIT$/m, 'a stop at any point reports the state');
  assert.match(text, /^trap 'exit 130' INT$/m);
  assert.ok(statSync(SCRIPT).mode & 0o100, 'executable');
  assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
  const shellcheck = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
  if (!shellcheck.error) assert.equal(shellcheck.status, 0, shellcheck.stdout);
});

test('rotate-secrets.sh: no value is echoed, and values reach ssh and vercel on standard input only', () => {
  const lines = text.split('\n');
  assert.ok(!lines.some((l) => /\becho\b.*\$\{?(session|link)\b/.test(l)), 'no echo of a secret variable');
  assert.ok(!/set -x/.test(text.replace(/^set \+x$/gm, '')), 'never traces');
  // Every ssh invocation: none carries a value in its arguments.
  for (const line of lines.filter((l) => /\bssh\b/.test(l) && !/^\s*#/.test(l))) {
    assert.ok(!/\$\{?(session|link)\b/.test(line), `no value on an ssh command line: ${line}`);
  }
  // The values go into ssh's standard input from a printf group.
  assert.match(text, /\{\n  printf 'LW_SESSION_SECRET=%s\\n' "\$session"\n  printf 'LW_LINK_SECRET=%s\\n' "\$link"\n\} \| ssh "\$target" /);
  // Vercel: piped in, stored sensitive, overwritten in one call, never --value (argv).
  assert.match(text, /printf '%s' "\$session" \| vc env add LW_SESSION_SECRET production --sensitive --force/);
  assert.match(text, /printf '%s' "\$link" \| vc env add LW_LINK_SECRET production --sensitive --force/);
  assert.ok(!/vc env rm\b/.test(text), 'no remove-then-add: a failed add would leave the variable missing');
  assert.ok(!/--value\b/.test(text), 'no --value');
  // The generator.
  assert.equal(text.match(/^(session|link)=\$\(openssl rand -base64 48 \| tr -d '\\n'\)$/gm)?.length, 2);
});

interface Setup {
  ls?: Array<{ key: string; target: string[] }>;
  head?: Record<string, unknown>;
  headRc?: number;
  failOn?: string;
  hangOn?: string;
  healthzFails?: boolean;
  noScripts?: boolean;
}

/** Stand-ins first on PATH, and a fake VM directory for /opt/lolly-ing. */
function setup(opts: Setup = {}) {
  const realBase64 = spawnSync('bash', ['-c', 'command -v base64'], { encoding: 'utf8' }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'lw-rotate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const ls = opts.ls ?? [{ key: 'LW_SESSION_SECRET', target: ['production'] }];
  const lsJson = JSON.stringify({ envs: [...ls.map((e) => ({ ...e, type: 'sensitive' })), { key: 'PLAIN_SETTING', value: 'shown', type: 'plain', target: ['production'] }] });
  const files: Record<string, string> = {
    // ssh runs the remote command here, with /opt/lolly-ing pointed at the fake
    // VM directory; argv is logged so the test can look for values in it.
    ssh: [
      'printf "ssh %s\\n" "$*" >> "$CALLS"',
      'while [ "${1:-}" = -n ]; do shift; exec </dev/null; done',
      'shift',
      'exec bash -c "${1//\\/opt\\/lolly-ing/$VM_DIR}"',
    ].join('\n'),
    // base64 -d on "the VM" rewrites the fixed path inside the decoded script.
    base64: `if [ "\${1:-}" = -d ]; then "${realBase64}" -d | sed "s#/opt/lolly-ing#$VM_DIR#g"; else exec "${realBase64}" "$@"; fi`,
    sudo: '[ "$1" = -n ] || { echo "sudo without -n" >&2; exit 1; }\nshift\nprintf "sudo %s\\n" "$*" >> "$CALLS"\nexec "$@"',
    docker: [
      'printf "docker %s\\n" "$*" >> "$CALLS"',
      'case "$*" in *audit-head.ts*) printf "%s\\n" "$HEAD_JSON"; exit "${HEAD_RC:-0}" ;; esac',
    ].join('\n'),
    curl: opts.healthzFails ? 'exit 7' : 'exit 0',
    vercel: [
      'printf "vercel %s [project=%s org=%s]\\n" "$*" "$VERCEL_PROJECT_ID" "$VERCEL_ORG_ID" >> "$CALLS"',
      'if [ -n "${FAIL_ON:-}" ] && [ "$*" = "$FAIL_ON" ]; then cat >/dev/null; echo "Error: simulated API failure" >&2; exit 1; fi',
      'if [ -n "${HANG_ON:-}" ] && [ "$*" = "$HANG_ON" ]; then cat >/dev/null; : > "$CALLS.hanging"; /bin/sleep 20; exit 0; fi',
      'case "$1 $2" in',
      '  "whoami ") echo tester ;;',
      `  "env ls") printf '%s' '${lsJson}' ;;`,
      '  "env add") cat > "$CALLS.$3" ;;',
      'esac',
    ].join('\n'),
  };
  // The restart waits up to 60 x 3 s for /healthz; make a failing wait quick.
  if (opts.healthzFails) Object.assign(files, { seq: 'echo 1', sleep: 'exit 0' });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const vm = join(dir, 'vm');
  mkdirSync(join(vm, 'src', 'scripts'), { recursive: true });
  if (!opts.noScripts) {
    writeFileSync(join(vm, 'src', 'scripts', 'audit-retire-key.ts'), '');
    writeFileSync(join(vm, 'src', 'scripts', 'audit-head.ts'), '');
  }
  const before = [
    '# lolly.ing',
    "DATABASE_URL='postgres://u:p@db.example/neon'",
    "LW_SESSION_SECRET='old-session-value-0123456789abcdef0123'",
    "LW_SESSION_SECRET_PREVIOUS='an-older-value-kept'",
    "LW_IDP_CLIENT_SECRET='idp'",
    "LW_LINK_SECRET='old-link-value-0123456789abcdef01234567'",
    'LW_BACKGROUND_POLL_MS=0',
  ];
  writeFileSync(join(vm, '.env'), before.join('\n') + '\n');
  chmodSync(join(vm, '.env'), 0o600);
  const head = opts.head ?? { seq: 42, hash: HEAD_HASH, at: '2026-10-03T12:00:00.000Z', count: 42, chainIntact: true, unkeyed: 0, linksIntact: true, keyChecked: true };
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`, CALLS: calls, VM_DIR: vm, VERCEL_ORG_ID: 'team_test', HOME: dir,
    HEAD_JSON: JSON.stringify(head), HEAD_RC: String(opts.headRc ?? 0),
    ...(opts.failOn ? { FAIL_ON: opts.failOn } : {}),
    ...(opts.hangOn ? { HANG_ON: opts.hangOn } : {}),
  };
  const log = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
  const vercelCalls = () => log().filter((l) => l.startsWith('vercel ')).map((l) => l.replace(/ \[project=.*$/, ''));
  const envFile = () => readFileSync(join(vm, '.env'), 'utf8');
  return { dir, vm, calls, env, before, log, vercelCalls, envFile };
}

const run = (env: Record<string, string>, ...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });

test('rotate-secrets.sh: one run records the audit head, rewrites the VM .env in place, sets the same values on Vercel, and recreates the server', () => {
  const s = setup();
  const r = run(s.env, '192.0.2.10', '--yes');
  assert.equal(r.status, 0, r.stderr);

  const after = s.envFile().trimEnd().split('\n');
  const value = (key: string) => /^[A-Z_]+='(.*)'$/.exec(after.find((l) => l.startsWith(`${key}=`)) ?? '')?.[1] ?? '';
  const session = value('LW_SESSION_SECRET');
  const link = value('LW_LINK_SECRET');
  assert.match(session, /^[A-Za-z0-9+/]{64}$/, '48 random bytes, base64');
  assert.match(link, /^[A-Za-z0-9+/]{64}$/);
  assert.notEqual(session, link);
  // Same lines, same order; only the two values changed (PREVIOUS kept by default).
  const mask = (l: string) => l.replace(/^(LW_SESSION_SECRET|LW_LINK_SECRET)='.*'$/, '$1=…');
  assert.deepEqual(after.map(mask), s.before.map(mask));
  assert.equal(statSync(join(s.vm, '.env')).mode & 0o777, 0o600);

  // Vercel received exactly the values the VM has, on standard input, in one
  // overwrite per variable whether or not it existed before.
  assert.equal(readFileSync(`${s.calls}.LW_SESSION_SECRET`, 'utf8'), session);
  assert.equal(readFileSync(`${s.calls}.LW_LINK_SECRET`, 'utf8'), link);
  const log = s.log();
  assert.ok(log.filter((l) => l.startsWith('vercel ')).every((l) => l.endsWith('[project=lolly-ing org=team_test]')), 'every vercel call names the project');
  assert.deepEqual(s.vercelCalls(), [
    'vercel whoami',
    'vercel env ls production --format json',
    'vercel env add LW_SESSION_SECRET production --sensitive --force',
    'vercel env add LW_LINK_SECRET production --sensitive --force',
  ]);
  const at = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('docker compose exec -T server node scripts/audit-head.ts --json') >= 0, 'the head is read inside the running server');
  assert.ok(at('docker compose exec -T server node scripts/audit-head.ts') < at('ssh sles@192.0.2.10 bash -c'), 'the head before the VM file');
  assert.ok(at('ssh sles@192.0.2.10 bash -c') < at('vercel env add'), 'the VM file before Vercel');
  assert.ok(at('vercel env add LW_LINK_SECRET') < at('docker compose up'), 'restart last');
  assert.ok(log.includes('docker compose up -d --no-deps --force-recreate server'));

  for (const secret of [session, link]) {
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'never printed');
    assert.ok(!log.some((l) => l.includes(secret)), 'never in an argument list');
  }
  assert.ok(!r.stdout.includes('an-older-value-kept') && !r.stderr.includes('an-older-value-kept'), 'PREVIOUS is named, never shown');
  assert.match(r.stdout, /updated .*\.env \(mode 600, owner .*\): LW_SESSION_SECRET and LW_LINK_SECRET replaced, 5 other lines kept\n/);
  assert.match(r.stdout, /audit head #42 \((ab)+\): every row verifies under the VM's current secret/);
  assert.match(r.stderr, /NOTE: the VM \.env also sets LW_SESSION_SECRET_PREVIOUS\. .*--drop-previous/);
  // Next steps: redeploy, sign in, then retire with the recorded head and with
  // the older PREVIOUS value kept out of the check.
  const retire = `exec -T -e LW_SESSION_SECRET_PREVIOUS= server node scripts/audit-retire-key.ts --reason "secret rotation `;
  assert.ok(r.stdout.includes(retire), r.stdout);
  assert.ok(r.stdout.includes(`--expect-head 42:${HEAD_HASH} --dry-run'`));
  assert.ok(r.stdout.indexOf('vercel redeploy') < r.stdout.indexOf('Sign in once'));
  assert.ok(r.stdout.indexOf('Sign in once') < r.stdout.indexOf('audit-retire-key.ts'));
  assert.ok(!r.stderr.includes('STOPPED'), 'a finished run reports no state');
});

test('rotate-secrets.sh: --drop-previous removes the older values too', () => {
  const s = setup();
  const r = run(s.env, '192.0.2.10', '--yes', '--drop-previous');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!s.envFile().includes('LW_SESSION_SECRET_PREVIOUS'));
  assert.equal(s.envFile().trimEnd().split('\n').length, s.before.length - 1);
  assert.match(r.stdout, /4 other lines kept, removed LW_SESSION_SECRET_PREVIOUS\n/);
  assert.ok(!r.stdout.includes('-e LW_SESSION_SECRET_PREVIOUS='), 'nothing left to keep out of the check');
});

const untouched = (s: ReturnType<typeof setup>) => {
  assert.equal(s.envFile(), s.before.join('\n') + '\n', '.env untouched');
  assert.ok(!/vercel env add|docker compose up/.test(s.log().join('\n')), 'no change anywhere');
};

test('rotate-secrets.sh: refuses before changing anything when a Vercel variable spans more than production', () => {
  const s = setup({ ls: [{ key: 'LW_LINK_SECRET', target: ['production', 'preview'] }] });
  const r = run(s.env, 'sles@192.0.2.10', '--yes');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LW_LINK_SECRET on lolly-ing applies to production,preview/);
  assert.match(r.stderr, /stopped \(exit 1\); nothing changed/);
  untouched(s);
});

test('rotate-secrets.sh: the audit head check stops a rotation over a chain that is already broken', () => {
  const links = setup({ head: { seq: 42, hash: HEAD_HASH, chainIntact: false, badSeq: 7, linksIntact: false, linksBadSeq: 7, keyChecked: true }, headRc: 2 });
  const r1 = run(links.env, '192.0.2.10', '--yes', '--allow-unverified-audit');
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /hash chain is already broken at #7, before any rotation/);
  untouched(links);

  const macs = setup({ head: { seq: 42, hash: HEAD_HASH, chainIntact: false, badSeq: 1, linksIntact: true, keyChecked: true }, headRc: 2 });
  const r2 = run(macs.env, '192.0.2.10', '--yes');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /do not all verify under the VM's current LW_SESSION_SECRET \(first failure #1\).*--allow-unverified-audit/s);
  untouched(macs);
  const r3 = run(macs.env, '192.0.2.10', '--yes', '--allow-unverified-audit');
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(r3.stderr, /going ahead \(--allow-unverified-audit\)\. Head #42 is recorded/);
  assert.ok(r3.stdout.includes(`--expect-head 42:${HEAD_HASH}`));

  const old = setup({ noScripts: true });
  const r4 = run(old.env, '192.0.2.10', '--yes');
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /no scripts\/audit-head\.ts or scripts\/audit-retire-key\.ts.*push\.sh/);
  untouched(old);
});

test('rotate-secrets.sh: a Vercel failure part way reports the state of each side', () => {
  const s = setup({ ls: [{ key: 'LW_SESSION_SECRET', target: ['production'] }, { key: 'LW_LINK_SECRET', target: ['production'] }], failOn: 'env add LW_LINK_SECRET production --sensitive --force' });
  const r = run(s.env, '192.0.2.10', '--yes');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Error: simulated API failure/);
  assert.match(r.stderr, /STOPPED PART WAY \(exit 1\)/);
  assert.match(r.stderr, /VM \/opt\/lolly-ing\/\.env: +NEW values \(applied when the server container is recreated\)/);
  assert.match(r.stderr, /VM server: +running on the old values/);
  assert.match(r.stderr, /Vercel LW_SESSION_SECRET: +NEW value/);
  assert.match(r.stderr, /Vercel LW_LINK_SECRET: +UNKNOWN: the update did not finish/);
  assert.match(r.stderr, /Run\nthis script again/);
  assert.ok(!s.log().some((l) => l.includes('docker compose up')), 'no restart after a failure');
});

test('rotate-secrets.sh: a server that does not come back is reported as recreated, not as untouched', () => {
  const s = setup({ healthzFails: true });
  const r = run(s.env, '192.0.2.10', '--yes');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VM server: +recreated on the new values, but \/healthz did not answer within 3 minutes/);
  assert.match(r.stderr, /Vercel LW_LINK_SECRET: +NEW value/);
});

test('rotate-secrets.sh: Ctrl-C part way still reports the state of each side', async () => {
  const s = setup({ hangOn: 'env add LW_LINK_SECRET production --sensitive --force' });
  const child = spawn('bash', [SCRIPT, '192.0.2.10', '--yes'], { env: s.env, detached: true });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  child.stdout.resume();
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  try {
    for (let i = 0; i < 200 && !existsSync(`${s.calls}.hanging`); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(`${s.calls}.hanging`), 'reached the second Vercel update');
    process.kill(-child.pid!, 'SIGINT'); // the whole group, as a terminal's Ctrl-C does
    assert.equal(await closed, 130);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(`${s.calls}.hanging`, { force: true });
  }
  assert.match(stderr, /STOPPED PART WAY \(exit 130\)/);
  assert.match(stderr, /Vercel LW_SESSION_SECRET: +NEW value/);
  assert.match(stderr, /Vercel LW_LINK_SECRET: +UNKNOWN/);
  assert.match(stderr, /VM server: +running on the old values/);
});

test('rotate-secrets.sh: root is refused, and a bare address logs in as sles', () => {
  const r = spawnSync('bash', [SCRIPT, 'root@192.0.2.10'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /root cannot log in on the VM/);
  assert.ok(text.includes('*) target=${LOLLY_VM_USER:-sles}@$target ;;'));
});
