// SPDX-License-Identifier: MPL-2.0
import { themeFromTokens } from './brand-theme.js';

const root = document.documentElement;
const theme = document.getElementById('landing-theme');
const modes = ['light', 'dark', 'brand'];
function setTheme(value) {
  if (modes.includes(value)) root.dataset.theme = value;
  else root.removeAttribute('data-theme');
  if (theme) theme.value = value || 'system';
}
try { setTheme(localStorage.getItem('lw-theme')); } catch { setTheme(null); }
theme?.addEventListener('change', () => {
  setTheme(theme.value);
  try { if (modes.includes(theme.value)) localStorage.setItem('lw-theme', theme.value); else localStorage.removeItem('lw-theme'); } catch { /* Theme still works without storage. */ }
});
window.addEventListener('storage', event => { if (event.key === 'lw-theme') setTheme(event.newValue); });

async function loadBrand() {
  try {
    const response = await fetch('/api/brand', { credentials: 'same-origin' });
    if (!response.ok) return;
    const brand = await response.json();
    // Use only the instance-owned public logo routes. Tokens never create markup.
    for (const mode of ['light', 'dark']) {
      const img = document.querySelector(`[data-brand-logo="${mode}"]`);
      const path = brand?.logos?.[mode] ?? brand?.logos?.[mode === 'light' ? 'dark' : 'light'];
      if (img && /^\/api\/brand\/logo\/(light|dark)$/.test(path ?? '')) {
        img.src = path;
        img.addEventListener('error', () => { img.hidden = true; }, { once: true });
        img.hidden = false;
      }
    }
    await themeFromTokens(brand?.tokens, file => `/api/brand/font/${encodeURIComponent(file)}`);
  } catch { /* The page remains usable with its default theme. */ }
}
void loadBrand();

const data = JSON.parse(document.getElementById('arch-data').textContent);
let scenario = data.scenarios[0];
let active = data.nodes.find(node => node.id === 'engine');
let lens = 'security';
let step = -1;
const offline = document.getElementById('arch-offline');
const text = (id, value) => { document.getElementById(id).textContent = value; };
function renderDetail() {
  document.querySelectorAll('[data-node]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.node === active.id)));
  document.querySelectorAll('[data-lens]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lens === lens)));
  text('arch-detail-title', active.label); text('arch-detail-body', active.body);
  text('arch-detail-view', active[lens]); text('arch-detail-limit', active.limit);
  document.getElementById('arch-detail-link').href = `/admin#/docs?doc=${encodeURIComponent(active.doc)}`;
}
function renderScenario() {
  document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario.id)));
  text('arch-flow-down', offline.checked ? 'No connection' : scenario.down);
  text('arch-flow-up', scenario.up);
  document.getElementById('arch-flow-up').hidden = !scenario.up || offline.checked;
  text('arch-work-note', offline.checked ? 'Shared services are unavailable' : scenario.id === 'local' ? 'Not needed for this workflow' : 'Connected for this workflow');
  document.getElementById('arch-work-zone').dataset.connected = String(!offline.checked && scenario.id !== 'local');
  text('arch-result', offline.checked ? scenario.offline : scenario.result);
  renderStep(); renderDetail();
}
function renderStep() {
  text('arch-step-label', step < 0 ? 'Follow the work, step by step' : `Step ${step + 1} of ${scenario.steps.length}`);
  document.querySelector('.arch-trace').hidden = offline.checked;
  document.getElementById('arch-step-text').hidden = step < 0;
  text('arch-step-text', step < 0 ? '' : scenario.steps[step].text);
  const next = document.getElementById('arch-next');
  next.disabled = offline.checked;
  next.textContent = step < 0 ? 'Start →' : step === scenario.steps.length - 1 ? 'Start again ↻' : 'Next step →';
}
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  scenario = data.scenarios.find(item => item.id === button.dataset.scenario); step = -1;
  active = data.nodes.find(node => node.id === (scenario.id === 'local' ? 'engine' : 'work'));
  renderScenario();
}));
document.querySelectorAll('[data-node]').forEach(button => button.addEventListener('click', () => { active = data.nodes.find(node => node.id === button.dataset.node); renderDetail(); }));
document.querySelectorAll('[data-lens]').forEach(button => button.addEventListener('click', () => { lens = button.dataset.lens; renderDetail(); }));
offline.addEventListener('change', () => { step = -1; renderScenario(); });
document.getElementById('arch-next').addEventListener('click', () => {
  step = step >= scenario.steps.length - 1 ? 0 : step + 1;
  active = data.nodes.find(node => node.id === scenario.steps[step].node); renderStep(); renderDetail();
});
renderScenario();
