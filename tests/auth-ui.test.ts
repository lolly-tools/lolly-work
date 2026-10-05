// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { idpChooserHtml } from '../server/src/iam/activate-page.ts';
import { invitePageHtml } from '../server/src/access/pages.ts';
import { authThemeCss, pickAuthFont } from '../server/src/brand/auth-theme.ts';
import { parseConfig } from '../server/src/config/instance.ts';

test('sign-in and invitation pages use local theme assets, provider marks, and inert pending providers', () => {
  const html = idpChooserHtml('lolly.ing', [{ href: '/api/auth/login?idp=primary&returnTo=%2Fproject', label: 'Sign in with Google', provider: 'Google' }], { inviteOnly: true, pending: ['SUSE ID'] });
  assert.match(html, /href="\/admin\/theme.css"/); assert.match(html, /href="\/api\/brand\/auth.css"/);
  assert.match(html, /class="provider-icon"/); assert.match(html, /disabled aria-label="SUSE ID \(pending\)"/);
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('idp=suse'));
  assert.ok(html.includes('returnTo=%2Fproject'), 'provider choice preserves the destination');
  const invite = invitePageHtml({ workspace: 'lolly.ing', token: 'secret-token', inviter: 'Andy', project: { name: 'SKO-Keynote', role: 'editor' }, email: 'ravan@suse.com', now: Date.now() }, { csrf: 'nonce', choices: [{ idp: 'google', label: 'Continue with Google', provider: 'Google' }, { idp: '', label: 'SUSE ID', provider: 'SUSE ID', pending: true }], passwordSetup: false, passwordSignIn: null, github: false });
  assert.match(invite, /SUSE ID<\/span><span class="auth-pending">\(pending\)/);
  assert.equal((invite.match(/name="action" value="start"/g) ?? []).length, 1, 'pending sign-in cannot submit an authentication request');
  assert.ok(!invite.includes('ravan@suse.com'), 'invitation address stays masked');
});

test('server theme resolves DTCG aliases, excludes CSS injection, and keeps usable contrast', () => {
  const tokens = { base: { color: { brand: { pine: { $value: '#0c322c' }, jungle: { $value: '#30ba78' } } } }, light: { color: { semantic: { primary: { $value: '{color.brand.pine}' }, surface: { $value: '#ffffff' } } } }, dark: { color: { semantic: { primary: { $value: '{color.brand.jungle}' }, surface: { $value: '#0c322c' } } } } };
  const css = authThemeCss(tokens, { family: 'SUSE', file: 'SUSE[wght].woff2' });
  assert.match(css, /--pack-accent-light:#0c322c/); assert.match(css, /--pack-accent-dark:#30ba78/);
  assert.match(css, /--pack-on-accent-light:#fff/); assert.match(css, /--pack-on-accent-dark:#000/);
  assert.match(css, /\/api\/brand\/font\/SUSE%5Bwght%5D.woff2/);
  const unsafe = authThemeCss({ light: { color: { semantic: { primary: { $value: '#ffffff; background:url(https://evil.test)' } } } } }, { family: "x'}", file: 'external.woff2' });
  assert.ok(!unsafe.includes('evil.test')); assert.ok(!unsafe.includes('@font-face'));
  assert.throws(() => parseConfig(JSON.stringify({ idp: { pending: [''] } })), /idp.pending/);
});


test('authentication selects the active UI family and maps variable and static weights truthfully', () => {
  const tokens = { base: { font: { brand: { $value: '{font.ui}' }, ui: { $value: 'SUSE' } } } };
  const font = pickAuthFont(tokens, ['SUSE-Black.woff2', 'SUSE-Italic[wght].woff2', 'Other-Variable.woff2', 'SUSE[wght].woff2', 'SUSE-Regular.woff2']);
  assert.deepEqual(font, { family: 'SUSE', file: 'SUSE[wght].woff2' });
  assert.match(authThemeCss(tokens, font), /font-weight:100 900;font-style:normal/);
  const regular = pickAuthFont(tokens, ['SUSE-Black.woff2', 'SUSE-Regular.woff2']);
  assert.equal(regular?.file, 'SUSE-Regular.woff2');
  assert.match(authThemeCss(tokens, regular), /font-weight:400;font-style:normal/);
  assert.equal(pickAuthFont(tokens, ['SUSE-Black.woff2', 'Other-Variable.woff2']), null);
  assert.equal(pickAuthFont({}, ['SUSE-Black.woff2']), null);
  assert.equal(pickAuthFont({ base: { font: { brand: { $value: '{font.brand}' } } } }, ['SUSE[wght].woff2']), null);
});
