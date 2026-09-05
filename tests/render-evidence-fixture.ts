import { evidenceHash, finishRenderEvidence } from '../server/src/render/evidence.ts';

/** Minimal valid receipt for store/lease tests; pipeline tests use real engine observations. */
export function evidenceFixture(bytes: Uint8Array) {
  return finishRenderEvidence({
    engine: { version: '1.176.0', documentApiVersion: '1.0.0', scope: 'control-plane' },
    tool: { id: 'card', version: '1.0.0', sourceHash: evidenceHash([]), scope: 'local-runtime', files: [] },
    context: {
      paramsHash: evidenceHash({}), profileHash: evidenceHash({}), groupsHash: evidenceHash([]),
      policyVersion: 'test-policy', catalogVersion: 'test-catalog', format: 'svg', widthPx: null, heightPx: null,
      watermark: false, renderer: 'work-jsdom', rasterizer: 'none', signerCertificateHash: null,
    },
    assets: [], limitations: ['dependencies-not-locked', 'engine-dependency-graph-unavailable'],
  }, bytes);
}
