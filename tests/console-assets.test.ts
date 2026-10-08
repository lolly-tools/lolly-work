// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildConsoleAssets, checkConsoleAssets, consoleAssetPlan } from '../scripts/console-assets.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-console-assets-'));
  mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'index.html'), '<link rel="stylesheet" href="/admin/styles.css"><script type="module" src="/admin/app.js"></script>');
  writeFileSync(join(dir, 'app.js'), "import { preview } from './project-transfer.js';\nboot();\n");
  writeFileSync(join(dir, 'project-transfer.js'), 'export const preview = true;');
  writeFileSync(join(dir, 'styles.css'), '@import url("./theme.css");');
  writeFileSync(join(dir, 'theme.css'), '@font-face{src:url("./fonts/example.woff2")}');
  writeFileSync(join(dir, 'fonts/example.woff2'), 'font fixture');
  return dir;
}

test('console revisions are deterministic and generation is idempotent across mtimes and directories', () => {
  const a = fixture(), b = fixture();
  try {
    assert.equal(buildConsoleAssets(a), buildConsoleAssets(b));
    const generated = readFileSync(join(a, 'index.html'), 'utf8');
    const before = consoleAssetPlan(a).revision;
    utimesSync(join(a, 'app.js'), 0, 0);
    assert.equal(buildConsoleAssets(a), before);
    assert.equal(checkConsoleAssets(a), before);
    assert.equal(readFileSync(join(a, 'index.html'), 'utf8'), generated);
    assert.match(generated, /\/admin\/app\.js\?v=[a-f0-9]{64}/);
    assert.match(generated, /\/admin\/styles\.css\?v=[a-f0-9]{64}/);
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('source, imported modules, imported CSS and HTML changes invalidate the selected revision', () => {
  const dir = fixture();
  try {
    buildConsoleAssets(dir);
    for (const file of ['app.js', 'project-transfer.js', 'theme.css', 'index.html']) {
      const before = checkConsoleAssets(dir);
      const source = readFileSync(join(dir, file), 'utf8');
      writeFileSync(join(dir, file), source + '\n/* changed */');
      assert.throws(() => checkConsoleAssets(dir), /revision is stale/, `${file} must invalidate the entry URL`);
      assert.notEqual(buildConsoleAssets(dir), before);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('a copied old entry selected by HTML is refused even when canonical source is current', () => {
  const dir = fixture();
  try {
    buildConsoleAssets(dir);
    writeFileSync(join(dir, 'app-07fcc2c25050.js'), '/* lacks projectTransferCard */');
    writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replace(/app\.js\?v=[a-f0-9]+/, 'app-07fcc2c25050.js'));
    assert.throws(() => checkConsoleAssets(dir), /obsolete copied console asset/, 'reproduce the stale committed-copy packaging bug');
    rmSync(join(dir, 'app-07fcc2c25050.js'));
    assert.throws(() => checkConsoleAssets(dir), /revision is stale/);
    buildConsoleAssets(dir);
    assert.equal(checkConsoleAssets(dir), consoleAssetPlan(dir).revision);
  } finally { rmSync(dir, { recursive: true }); }
});

test('missing HTML, CSS and font assets are refused before packaging', () => {
  const dir = fixture();
  try {
    rmSync(join(dir, 'fonts/example.woff2'));
    assert.throws(() => buildConsoleAssets(dir), /Missing console asset: fonts\/example\.woff2/);
    writeFileSync(join(dir, 'fonts/example.woff2'), 'font fixture');
    rmSync(join(dir, 'theme.css'));
    assert.throws(() => buildConsoleAssets(dir), /Missing console asset: theme\.css/);
    writeFileSync(join(dir, 'theme.css'), '');
    rmSync(join(dir, 'app.js'));
    assert.throws(() => buildConsoleAssets(dir), /Missing console asset: app\.js/);
  } finally { rmSync(dir, { recursive: true }); }
});

// Exercise the same native linker as the container probe. Launch the VM flag in
// this fixture subprocess so normal node:test does not require global VM flags.
function moduleProbe(mode: 'current' | 'stale' | 'missing') {
  const loader = new URL('../scripts/console-module-check.ts', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import { loadConsoleModuleGraph } from ${JSON.stringify(loader)};
    const mode = ${JSON.stringify(mode)};
    const api = 'const consoleNavigation=()=>null, actSessionObj=()=>null, actToolObj=()=>null, actProjectObj=()=>null; let session;';
    const files = {
      '/admin/app.js': "import { preview } from './project-transfer.js';" + api + 'const renderProjectDetail=()=>preview;\\nboot();',
      '/admin/old.js': api + 'const renderProjectDetail=()=>"Old project view";\\nboot();',
      '/admin/project-transfer.js': 'export { preview } from "./preview-label.js";',
      '/admin/preview-label.js': 'export const preview="Prepare to move this project";',
    };
    if (mode === 'missing') delete files['/admin/preview-label.js'];
    const requests=[];
    const entry = await loadConsoleModuleGraph({html:'<script type="module" src="/admin/'+(mode==='stale'?'old.js':'app.js?v=fixture')+'"></script>',base:'https://console.test',context:vm.createContext({}),read:async url=>{
      const path=new URL(url).pathname; requests.push(path); assert.ok(files[path], 'Missing shipped module '+path); return files[path];
    }});
    assert.equal(entry.namespace.renderProjectDetail(), 'Prepare to move this project', 'HTML-selected view must offer transfer preparation');
    assert.ok(requests.includes('/admin/preview-label.js'), 'transitive module must load');
  `;
  return spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 15_000 });
}

test('the release module probe follows the HTML-selected entry and transitive imports', () => {
  const result = moduleProbe('current');
  assert.equal(result.status, 0, result.stderr);
});

test('the release module probe refuses an old HTML-selected view and a missing transitive module', () => {
  const stale = moduleProbe('stale');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /HTML-selected view must offer transfer preparation/);
  const missing = moduleProbe('missing');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing shipped module \/admin\/preview-label\.js/);
});
