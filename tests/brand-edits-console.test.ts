// SPDX-License-Identifier: MPL-2.0
/** What the console says about an edit, in each state, and what its switches send. */
import test from 'node:test';
import assert from 'node:assert/strict';
const jsdom: string = 'jsdom', modulePath: string = '../console/brand-edits.js';
const { JSDOM } = await import(jsdom);
const { brandEditsCard } = await import(modulePath);

const dom = new JSDOM('<body/>');
const document = dom.window.document;
const el = (tag: string, attrs: Record<string, any> = {}, ...children: any[]) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};
const base = {
  available: true, limitation: null, sourceId: 'mounted', sourceLabel: 'Wefthouse', revision: 3, baseChecksum: 'a'.repeat(64), maxDocumentBytes: 1,
  edit: null, pending: null, revisions: [], settings: { approvalChain: null, lookAfterImage: false }, canChangeSettings: true, chains: [{ id: 'brand', name: 'Brand review' }], connect: 'none',
};
const live = { state: 'current', overlaps: [], gone: [], revision: 2, digest: 'b'.repeat(64), baseChecksum: 'a'.repeat(64), ask: false, sentBy: 'u1', sentByName: 'Manager', liveAt: '2026-11-06T00:00:00.000Z' };
function render(state: Record<string, unknown>) {
  const calls: Array<{ path: string; options: any }> = [];
  const card = brandEditsCard({ ...base, ...state }, {
    el, toast: () => {}, changed: async () => {}, relTime: () => 'just now', lollyHref: (path: string) => path,
    armConfirmButton: (attrs: Record<string, unknown>, idle: string, _armed: string, onConfirm: (disarm: () => void) => unknown) => el('button', { ...attrs, onclick: () => onConfirm(() => {}) }, idle),
    api: async (path: string, options: any) => { calls.push({ path, options }); return { lines: [] }; },
  });
  document.body.replaceChildren(card);
  return { card, calls, text: card.textContent as string, button: (label: string) => [...card.querySelectorAll('button')].find((b: any) => b.textContent === label) as any };
}

test('with no edit it says what is served and where to edit', () => {
  const { text, button } = render({});
  assert.match(text, /serves the tokens from its mounted pack/);
  assert.match(text, /Edit for this instance/);
  assert.equal(button('Roll back to the mounted tokens'), undefined);
});

test('a live edit shows who and when, the digest, the previews line and a rollback', async () => {
  const { text, button, calls } = render({ edit: live });
  assert.match(text, /Runs edited tokens/);
  assert.match(text, /Revision 2, sent by Manager, just now/);
  assert.match(text, /SHA-256 b{64}/);
  assert.match(text, /Previews and social cards keep their old colours until the next image\./);
  button('Roll back to the mounted tokens').click();
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(calls[0]!.path, '/api/v1/brand/edits/rollback');
});

test('the connect download reads as it stands', () => {
  assert.match(render({ edit: live, connect: 'derived' }).text, /connect download carries this edit, signed by this instance/);
  const withdrawn = render({ edit: live, connect: 'withdrawn' }).text;
  assert.match(withdrawn, /New apps cannot download a connect pack until this edit is rolled back or a new pack is uploaded/);
  assert.equal(/connect/.test(render({ edit: live, connect: 'none' }).text.replace('Edits on this instance', '')), false);
});

test('after a new image it is a quiet note, unless someone asked to be asked', async () => {
  const quiet = render({ edit: { ...live, state: 'on-new-image', overlaps: ['base: color.brand.indigo'] } });
  assert.match(quiet.text, /Made on an earlier image, and it stays on top of this one/);
  assert.match(quiet.text, /both changed base: color\.brand\.indigo/);
  assert.equal(quiet.button('Keep this edit'), undefined, 'nobody is asked');
  const asked = render({ edit: { ...live, state: 'on-new-image', ask: true }, settings: { approvalChain: null, lookAfterImage: true } });
  assert.match(asked.text, /A new image arrived\. This edit stays live\. Look at it, then keep it or roll it back\./);
  asked.button('Keep this edit').click();
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(asked.calls[0]!.path, '/api/v1/brand/edits/keep');
});

test('an edit that cannot apply, or cannot be read, says plainly what is served instead', () => {
  const cannot = render({ edit: { ...live, state: 'cannot-apply', gone: ['base: color.brand.indigo'] } }).text;
  assert.match(cannot, /no longer applies, because this image has no base: color\.brand\.indigo/);
  assert.match(cannot, /serving the image's own colours/);
  assert.match(cannot, /Serving the mounted tokens/);
  assert.equal(/Previews and social cards/.test(cannot), false);
  assert.match(render({ edit: { ...live, state: 'unavailable' } }).text, /could not be read, so this instance is serving the mounted tokens/);
});

test('each switch says what it does and sends one decision', async () => {
  const off = render({});
  assert.match(off.text, /Edits need approval before they go live/);
  assert.match(off.text, /With this off, an edit goes live when it is sent\./);
  assert.match(off.text, /After a new image, ask someone to look at this instance's edits/);
  assert.match(off.text, /The edit stays live meanwhile\./);
  const approval = off.card.querySelector('#bedit-approval'), look = off.card.querySelector('#bedit-look');
  assert.equal(approval.checked, false, 'off by default');
  assert.equal(look.checked, false, 'off by default');
  look.click();
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(off.calls[0], { path: '/api/v1/brand/edits/settings', options: { method: 'PUT', body: { approvalChain: null, lookAfterImage: true } } });
  approval.click();
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(off.calls[1]!.options.body, { approvalChain: 'brand', lookAfterImage: false });
  const noChains = render({ chains: [] });
  assert.equal(noChains.card.querySelector('#bedit-approval').disabled, true);
  assert.match(noChains.text, /Add an approval chain to turn this on\./);
  const on = render({ settings: { approvalChain: 'brand', lookAfterImage: false } });
  assert.equal(on.card.querySelector('.bedit-chain select').value, 'brand');
});

test('someone who cannot change the switches reads them as a sentence', () => {
  const { card, text } = render({ canChangeSettings: false, chains: undefined });
  assert.equal(card.querySelector('#bedit-approval'), null);
  assert.match(text, /Edits here go live when they are sent\./);
});

test('the history shows what changed, as swatches where a value is a colour', async () => {
  const revisions = [{ n: 2, state: 'live', sentBy: 'u1', sentByName: 'Manager', createdAt: '2026-11-06T00:00:00.000Z', liveAt: '2026-11-06T00:00:00.000Z', changes: 1, digest: 'b'.repeat(64), restoredFrom: null, endedByName: null },
    { n: 1, state: 'superseded', sentBy: 'u1', sentByName: 'Manager', createdAt: '2026-11-05T00:00:00.000Z', liveAt: '2026-11-05T00:00:00.000Z', changes: 2, digest: 'c'.repeat(64), restoredFrom: null, endedByName: null }];
  const calls: string[] = [];
  const card = brandEditsCard({ ...base, edit: live, revisions }, { el, toast: () => {}, changed: async () => {}, relTime: () => 'then', lollyHref: (path: string) => path,
    armConfirmButton: (attrs: Record<string, unknown>, idle: string) => el('button', attrs, idle),
    api: async (path: string) => { calls.push(path); return { lines: [{ kind: 'colour', name: 'base: color.brand.indigo', action: 'changed', before: '#1b2a6b', after: 'url(x);' }] }; } });
  document.body.replaceChildren(card);
  const details = card.querySelector('.bedit-revision details');
  details.open = true;
  details.dispatchEvent(new dom.window.Event('toggle'));
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(calls[0], '/api/v1/brand/edits/revisions/2');
  assert.equal(card.querySelectorAll('.bedit-swatch').length, 1, 'only a value that reads as a colour paints a swatch');
  assert.ok([...card.querySelectorAll('button')].some((b: any) => b.textContent === 'Go back to this'));
  // The live revision does not offer to go back to itself.
  assert.equal(card.querySelectorAll('.bedit-revision')[0].querySelector('button'), null);
});

test('a deployment that cannot keep an edit says so and offers nothing', () => {
  const { text, card } = render({ available: false, limitation: 'This deployment cannot keep an edit.' });
  assert.match(text, /cannot keep an edit/);
  assert.equal(card.querySelector('input'), null);
});
