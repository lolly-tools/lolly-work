// SPDX-License-Identifier: MPL-2.0
/**
 * The example partner programme the docs screenshots show (plans/82): one
 * programme, two companies, two partner people, a published Share with rules
 * template that takes the company's logo and contact line, a tool template
 * with the templates-only switch, a logos collection and one held file. Every
 * name is neutral (Resellers, EMEA; Northwind IT; Contoso Systems) so the
 * public docs can carry the pictures.
 *
 * Seeded over HTTP as the capture owner, the way an admin would set it up, so
 * each shot shows what the routes really answer. Used by capture-console.ts
 * for its `partner` recipes only, on a demo instance of their own.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileDesignTool } from '@lolly/engine';
import { ZipBuilder } from '../../server/src/links/zip.ts';

export const PARTNER_PEOPLE = [
  { email: 'rita@northwind.example', groups: [] as string[], firstname: 'Rita', lastname: 'Ortiz', title: 'Partner Sales, Northwind IT' },
  { email: 'nils@northwind.example', groups: [] as string[], firstname: 'Nils', lastname: 'Berg', title: 'Partner Marketing, Northwind IT' },
];
export const PROGRAMME = 'resellers-emea';
export const COMPANY = 'northwind-it';

const LOGO_LIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" width="360" height="96"><title>Northwind IT</title><path d="M8 84 L44 12 L80 84 Z" fill="#0b3d91"/><path d="M30 84 L44 56 L58 84 Z" fill="#1e88e5"/><text x="96" y="62" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#0b2545">Northwind IT</text></svg>';
const LOGO_DARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 96" width="360" height="96"><title>Northwind IT</title><path d="M8 84 L44 12 L80 84 Z" fill="#8fc1ff"/><path d="M30 84 L44 56 L58 84 Z" fill="#ffffff"/><text x="96" y="62" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#ffffff">Northwind IT</text></svg>';
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><rect width="96" height="96" rx="20" fill="#0b3d91"/><path d="M14 80 L48 16 L82 80 Z" fill="#ffffff"/></svg>';
// Two files for the logos collection: one the brand team marks as its own,
// one with no licence record, which the licence gate holds back.
const OWN_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80"><title>Lolly Demo lockup</title><circle cx="40" cy="40" r="28" fill="#2f8f6a"/><text x="84" y="52" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#16302a">Lolly Demo</text></svg>';
const EVENT_BADGE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80" width="240" height="80"><title>Partner summit badge</title><rect x="4" y="4" width="232" height="72" rx="16" fill="#f4b740"/><text x="24" y="50" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#3a2a00">Partner summit</text></svg>';

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const RENDERER = 'var LollyDesignRules = {};';

/** The Share with rules file a designer would publish: a product data sheet
 *  whose price is open and whose logo and details line take the company's. */
function dataSheetFile(ossDir: string): Buffer {
  const font = new Uint8Array(readFileSync(join(ossDir, 'brands/lolly-demo/catalog/fonts/Outfit-Variable.ttf')));
  const digest = sha256(font);
  const fontPath = `assets/${digest}.ttf`;
  const family = `LollyFont${sha256('partner-data-sheet/1.1.0/Outfit').slice(0, 16)}`;
  const face = (weight: number) => `@font-face{font-family:'${family}';src:url('data:font/ttf;base64,${Buffer.from(font).toString('base64')}');font-weight:${weight};font-style:normal;}\n`;
  const def = {
    schemaVersion: 1, id: 'partner-data-sheet', name: 'Partner data sheet', description: 'Add your price.', version: '1.1.0',
    presentation: 'sidebar', formats: ['png', 'svg', 'pdf'],
    inputs: [
      { input: { id: 'price', label: 'Your price', type: 'text', default: '€ 1,240', maxLength: 40 }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] },
      { input: { id: 'logo', label: 'Partner logo', type: 'asset', assetType: 'image' }, targets: [{ variantId: 'a4', layerId: 'logo', property: 'image' }] },
      { input: { id: 'details', label: 'Details line', type: 'text', default: 'Ask your reseller for a quote', maxLength: 200 }, targets: [{ variantId: 'a4', layerId: 'details', property: 'text' }] },
    ],
    variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [
      { id: 'logo', kind: 'image', x: 48, y: 40, w: 220, h: 70, fit: 'contain', name: 'Partner logo' },
      { id: 'title', kind: 'text', x: 48, y: 170, w: 500, h: 60, text: 'Lolly Demo Cloud, Team plan', fontSize: 30, fg: '#16302a', name: 'Title', font: family, weight: '600' },
      { id: 'price', kind: 'text', x: 48, y: 260, w: 500, h: 50, text: '€ 1,240', fontSize: 36, fg: '#16302a', name: 'Price', font: family, weight: '600' },
      { id: 'details', kind: 'text', x: 48, y: 760, w: 500, h: 40, text: 'Ask your reseller for a quote', fontSize: 14, fg: '#333333', name: 'Details line', font: family, weight: '400' },
    ] }],
    defaultVariant: 'a4', choices: [], recipes: [],
    compilerVersion: 1, rendererDigest: sha256(RENDERER), css: face(400) + face(600),
    dependencies: [{ path: fontPath, digest, credit: 'Outfit, SIL Open Font License 1.1: embedded font for editable artwork.' }],
  };
  const compiled = compileDesignTool(def, { source: RENDERER, styles: '' }, { [fontPath]: font }) as { files: Record<string, string | Uint8Array> };
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
  const manifest = { format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: def.id, version: def.version },
    bundledTool: { id: def.id, version: def.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) }, integrity };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  if (!cookie) throw new Error(`no session for ${email}`);
  return cookie.split(';')[0]!;
}

async function send(base: string, cookie: string, method: string, path: string, body?: unknown, type = 'application/json'): Promise<any> {
  const raw = body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': type }, ...(raw === undefined ? {} : { body: raw }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Build the example programme on a fresh demo instance, as `ownerEmail`. */
export async function seedPartnerShots(base: string, ownerEmail: string, ossDir: string): Promise<void> {
  const owner = await login(base, ownerEmail);
  for (const p of PARTNER_PEOPLE) await login(base, p.email);
  const P = `/api/v1/programmes/${PROGRAMME}`;
  await send(base, owner, 'PUT', P, { name: 'Resellers, EMEA', description: 'Value-added resellers in Europe, the Middle East and Africa',
    team: 'brand-team', tools: ['pricing-table', 'qr-code', 'certificate', 'logo-wall'], collections: [] });
  await send(base, owner, 'PUT', `${P}/companies/${COMPANY}`, { name: 'Northwind IT' });
  await send(base, owner, 'PUT', `${P}/companies/contoso-systems`, { name: 'Contoso Systems' });
  await send(base, owner, 'POST', `${P}/people`, { rows: PARTNER_PEOPLE.map((p) => ({ email: p.email, company: COMPANY })), apply: true });

  // Northwind IT's details and logos, set up once by the brand team.
  const profile = `${P}/companies/${COMPANY}/profile`;
  await send(base, owner, 'PUT', profile, { website: 'https://northwind.example/', contact: { name: 'Rita Ortiz', email: 'rita@northwind.example', phone: '+49 30 1234 567' },
    address: 'Unter den Linden 1\n10117 Berlin\nGermany', currency: 'EUR', taxNote: 'Prices exclude VAT' });
  for (const [surface, svg] of [['light', LOGO_LIGHT], ['dark', LOGO_DARK], ['mark', MARK]] as const) {
    await send(base, owner, 'POST', `${profile}/logo?surface=${surface}`, svg, 'image/svg+xml');
  }
  await send(base, owner, 'PUT', `${profile}/settings`, { editors: [], approvalChain: null }).catch(() => undefined);

  // A logos collection for the programme: one file marked as the workspace's
  // own, one that records no licence.
  const own = await send(base, owner, 'POST', `/api/v1/catalog/submit?name=${encodeURIComponent('Lolly Demo lockup')}&tags=logo`, OWN_LOGO, 'image/svg+xml');
  const held = await send(base, owner, 'POST', `/api/v1/catalog/submit?name=${encodeURIComponent('Partner summit badge')}&tags=logo`, EVENT_BADGE, 'image/svg+xml');
  await send(base, owner, 'PUT', '/api/v1/catalog/rights/marks', { scope: `asset:${own.assetId}` });
  await send(base, owner, 'PUT', '/api/v1/catalog/collections/partner-logos', { name: 'Partner logos', description: 'Logos partners may use beside their own.',
    members: [own.assetId, held.assetId], groups: [`programme-${PROGRAMME}`, 'brand-team', 'admin'] });
  await send(base, owner, 'PUT', P, { name: 'Resellers, EMEA', collections: ['partner-logos'] });

  // The Share with rules data sheet, published to the programme, taking the
  // company's logo by mode and its contact line.
  const res = await fetch(`${base}${P}/templates/rules-file?groups=programme-${PROGRAMME}`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/octet-stream' }, body: new Uint8Array(dataSheetFile(ossDir)) });
  if (!res.ok) throw new Error(`rules file: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const listed = await send(base, owner, 'GET', `${P}/templates`) as { templates: Array<{ id: string; name: string }>; candidates: Array<{ id: string }> };
  const sheet = listed.templates.find((t) => t.name === 'Partner data sheet');
  if (!sheet) throw new Error('the data sheet did not publish');
  await send(base, owner, 'PUT', `${P}/templates/${sheet.id.slice('inst/'.length)}`, { bindings: { logo: 'logo', details: 'contact' } });

  // A template of one of the programme's own tools, kept to its templates.
  const tpl = await send(base, owner, 'POST', '/api/v1/catalog/submit?type=template&toolId=pricing-table', {
    toolId: 'pricing-table', name: 'Reseller price list', values: { heading: 'Lolly Demo Cloud plans', subheading: 'Prices for resellers in EMEA', cta: 'Ask Northwind IT' } });
  await send(base, owner, 'POST', `${P}/templates`, { from: tpl.assetId, groups: [`programme-${PROGRAMME}`], editable: ['data', 'cta'] });
  await send(base, owner, 'PUT', `${P}/templates-only/pricing-table`, { on: true });
}
