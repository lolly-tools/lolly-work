import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { renderViaWorker, type WorkerEvidence } from '../server/src/render/worker-client.ts';
import { evidenceHash } from '../server/src/render/evidence.ts';
import { inspectWorkProduction, verifyProductionReport, type ProductionRequest } from '../server/src/render/production.ts';

const skip = !process.env.LOLLY_WEB_BASE && 'Set LOLLY_WEB_BASE to run the worker against a real Lolly shell.';
test('real Chart worker evidence reaches the final production evaluator with exact data and scale', { skip, timeout: 120_000 }, async () => {
  process.env.PORT = '0';
  process.env.LW_RENDER_WORKER_SECRET = 'local-production-browser-test';
  process.env.LW_RENDER_EXPORT_TIMEOUT_MS = '75000';
  const playwrightPath: string = '../workers/render/node_modules/playwright-core/index.mjs';
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch({ ...(process.env.LOLLY_BROWSER_PATH ? { executablePath: process.env.LOLLY_BROWSER_PATH } : {}) });
  const { server, __setBrowserGetterForTests } = await import('../workers/render/src/server.ts');
  __setBrowserGetterForTests(async () => browser);
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const cfg = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: process.env.LW_RENDER_WORKER_SECRET, timeoutMs: 90_000 };
    const values = { data: 'Category,Revenue (GBP)\nA,125\nB,250', yTitle: 'Revenue (GBP)', yScaleType: 'linear', yZero: true };
    const request: ProductionRequest = { contract: { profile: 'lolly/production-still-v1', id: 'chart-revenue', revision: '1', format: 'svg', width: 1280, height: 800, pages: 1, alpha: 'any',
      requirements: Object.entries(values).map(([id, value]) => ({ id, kind: 'input', location: id, expected: evidenceHash(value) })),
    } };
    let evidence: WorkerEvidence | undefined;
    const svg = await renderViaWorker(cfg, { toolId: 'chart', format: 'svg', profile: {}, overrides: {}, evidence: true, inputIds: Object.keys(values), query: new URLSearchParams(Object.entries(values).map(([id, value]) => [id, String(value)] as [string, string])).toString() }, { onEvidence: value => { evidence = value; } });
    assert.ok(evidence?.inputs);
    const bytes = new TextEncoder().encode(svg);
    const report = await inspectWorkProduction(bytes, request, { inputs: evidence.inputs });
    await verifyProductionReport(report, bytes, request);
    assert.ok(report.checks.every(check => check.state === 'pass'));
    const changed: ProductionRequest = { contract: { ...request.contract, requirements: [{ id: 'data', kind: 'input', location: 'data', expected: evidenceHash(values.data.replace('125', '12')) }] } };
    const mismatch = await inspectWorkProduction(bytes, changed, { inputs: evidence.inputs });
    await assert.rejects(verifyProductionReport(mismatch, bytes, changed), /requirement.data:fail/);
    const unobserved = await inspectWorkProduction(bytes, request, {});
    await assert.rejects(verifyProductionReport(unobserved, bytes, request), /requirement.data:undetermined/);
  } finally {
    __setBrowserGetterForTests(null);
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
