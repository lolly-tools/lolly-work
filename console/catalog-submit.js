/**
 * Submit an asset from the console (plans/31 section 3, plan 299): the same
 * POST /api/v1/catalog/submit route the CLI and the Lolly app use, with the
 * file as the raw body and the declared metadata as query params. Whether it
 * goes live at once or waits for review is the instance's submit policy; the
 * panel only reports which happened.
 *
 * A template or a user tool is a JSON file of input values for one of the
 * pack's tools. The tool is read from the file when it says, and asked for
 * here when it does not (an exported template file names its tool in the
 * filename only).
 */

const TYPES = [
  ['', 'Work it out from the file'],
  ['image', 'Image'],
  ['icon', 'Icon'],
  ['template', 'Template (JSON)'],
  ['user-tool', 'Tool built on another tool (JSON)'],
];

/** The pack's tools, for the tool picker: [{ id, name }], or [] when unreadable. */
async function packTools() {
  try {
    const res = await fetch('/catalog/tools/index.json');
    const idx = res.ok ? await res.json() : null;
    return (idx?.tools ?? []).filter((t) => typeof t?.id === 'string')
      .map((t) => ({ id: t.id, name: typeof t.name === 'string' ? t.name : t.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

/** The tool an exported template file names: `<toolId>-<slug>.json`, where a tool id
 *  may itself hold dashes, so the longest known tool id that prefixes the name wins. */
export function toolFromFilename(filename, ids) {
  const base = String(filename).toLowerCase();
  return ids.filter((id) => base.startsWith(`${id}-`)).sort((a, b) => b.length - a.length)[0] ?? '';
}

export function createSubmitPanel({ el, field, toast, onClose, onSubmitted }) {
  const file = el('input', { type: 'file', 'aria-label': 'File to submit' });
  const name = el('input', { type: 'text', maxlength: '200' });
  const type = el('select', {}, ...TYPES.map(([v, label]) => el('option', { value: v }, label)));
  const tags = el('input', { type: 'text', placeholder: 'launch, social' });
  const description = el('input', { type: 'text', maxlength: '500' });
  const toolId = el('select', {}, el('option', { value: '' }, 'The one the file names'));
  const toolRow = field('Tool', toolId);
  let tools = [];
  const toolsReady = packTools().then((list) => {
    tools = list;
    toolId.append(...list.map((t) => el('option', { value: t.id }, t.name === t.id ? t.id : `${t.name} (${t.id})`)));
  });
  const status = el('p', { class: 'form-err', role: 'status' });
  const result = el('div', { role: 'status' });
  const send = el('button', { type: 'submit', class: 'primary' }, 'Submit');

  const isData = () => type.value === 'template' || type.value === 'user-tool';
  const syncTool = () => { toolRow.hidden = !isData(); };
  syncTool();
  type.addEventListener('change', syncTool);

  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    // A template names itself in its JSON, so only a file takes its filename.
    if (!name.value.trim() && !/\.json$/i.test(f.name)) name.value = f.name.replace(/\.[^.]+$/, '');
    if (/\.json$/i.test(f.name) && !type.value) {
      type.value = 'template';
      syncTool();
      void toolsReady.then(() => {
        const guess = toolFromFilename(f.name, tools.map((t) => t.id));
        if (guess && !toolId.value) toolId.value = guess;
      });
    }
  });

  const form = el('form', { class: 'stack', novalidate: '' },
    el('div', { class: 'formrow' }, field('File', file), field('Name', name), field('Type', type)),
    el('div', { class: 'formrow' }, field('Tags (comma-separated)', tags), field('Description', description), toolRow),
    el('p', {}, send),
    status, result);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = '';
    result.replaceChildren();
    const f = file.files?.[0];
    if (!f) { status.textContent = 'Choose a file first.'; return; }
    if (!name.value.trim() && !isData()) { status.textContent = 'Give the asset a name.'; return; }
    const q = new URLSearchParams();
    if (name.value.trim()) q.set('name', name.value.trim());
    if (type.value) q.set('type', type.value);
    if (tags.value.trim()) q.set('tags', tags.value.trim());
    if (description.value.trim()) q.set('description', description.value.trim());
    if (isData() && toolId.value.trim()) q.set('toolId', toolId.value.trim());
    send.disabled = true;
    try {
      const res = await fetch(`/api/v1/catalog/submit?${q}`, {
        method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? res.statusText);
      const label = name.value.trim() || (type.value === 'template' ? 'The template' : type.value === 'user-tool' ? 'The tool' : f.name);
      const said = data.duplicate
        ? `${label} is already in the catalog as ${data.assetId}.`
        : data.state === 'submitted'
          ? `${label} is waiting for review.`
          : `${label} is live in the catalog.`;
      toast(said);
      result.replaceChildren(el('p', {}, el('span', { class: `status ${data.state === 'submitted' ? 'review' : 'live'}` }, said)));
      form.reset();
      syncTool();
      onSubmitted?.(data);
    } catch (e) {
      status.textContent = e.message;
    } finally {
      send.disabled = false;
    }
  });

  const heading = el('h2', { class: 'flush', tabindex: '-1' }, 'Submit an asset');
  const element = el('div', { class: 'card stack' },
    el('div', { class: 'list-bar' }, heading, el('button', { type: 'button', onclick: onClose }, 'Close')),
    el('p', { class: 'sub' }, 'Add a file to the catalog, or a template saved in Lolly. It goes live at once, or waits for review when your workspace asks for one.'),
    form);
  return { element, focus: () => heading.focus({ preventScroll: true }) };
}
