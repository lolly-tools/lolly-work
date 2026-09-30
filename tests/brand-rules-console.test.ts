import test from 'node:test';
import assert from 'node:assert/strict';
const jsdom: string = 'jsdom', modulePath: string = '../console/brand-rules.js';
const { JSDOM } = await import(jsdom);
const { brandRulesCard } = await import(modulePath);

test('managed mapping editor uses labelled styled controls and invalidates an edited review', async () => {
  const dom = new JSDOM('<body/>');
  const document = dom.window.document;
  const el = (tag: string, attrs: Record<string, any> = {}, ...children: any[]) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)));
    return node;
  };
  const writes: any[] = [];
  const data = { editable: true, coverage: 'Runtime inputs', system: { label: '<Studio>', rules: [] }, mappings: [], tools: [{ id: 'campaign', name: 'Campaign', inputs: [{ id: 'ink', type: 'color', label: 'Ink' }] }] };
  const card = brandRulesCard(data, { el, toast: () => {}, changed: () => {}, api: async (path: string, options: any) => {
    writes.push({ path, ...options.body }); return { revision: 1, reviewToken: 'review', coverage: [{ toolId: 'campaign', outputs: [{ format: 'svg', rules: [] }] }] };
  } });
  document.body.append(card);
  const button = (label: string) => [...card.querySelectorAll('button')].find((b: any) => b.textContent === label) as any;
  const picker = card.querySelector('select'); picker.value = 'campaign'; button('Add tool').click();
  const inputs = card.querySelectorAll('.brand-rule-grid select, .brand-rule-grid input');
  assert.equal(inputs.length, 7);
  for (const input of inputs) assert.ok(input.closest('label.field'));
  const colour = [...inputs].find((i: any) => i.closest('label').textContent.startsWith('Accent colour')) as any;
  colour.value = 'ink'; colour.dispatchEvent(new dom.window.Event('change'));
  button('Review mappings').click(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(button('Apply reviewed mappings'));
  assert.deepEqual(writes[0].mappings[0].fields, { accent: 'ink' });
  const mode = card.querySelector('input'); mode.value = 'Night'; mode.dispatchEvent(new dom.window.Event('input'));
  assert.equal(button('Apply reviewed mappings'), undefined);
  assert.equal(card.querySelector('studio'), null);
  const readonly = brandRulesCard({ ...data, editable: false }, { el });
  assert.equal(readonly.querySelector('select, input, button'), null);
  dom.window.close();
});
