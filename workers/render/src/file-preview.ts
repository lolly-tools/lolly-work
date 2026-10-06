// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
export const PREVIEW_INPUT_LIMIT = 16 * 1024 * 1024;
export const PREVIEW_OUTPUT_LIMIT = 32 * 1024 * 1024;
export function previewInputFormat(bytes: Uint8Array): 'eps' | 'emf' | 'wmf' {
  if (bytes.byteLength < 8 || bytes.byteLength > PREVIEW_INPUT_LIMIT) throw new Error('The preview input is empty or too large.');
  const head = Buffer.from(bytes.subarray(0, 32));
  if (head.toString('ascii').startsWith('%!PS') || head.readUInt32LE(0) === 0xc6d3d0c5) return 'eps';
  if (bytes.byteLength >= 88 && head.readUInt32LE(0) === 1 && Buffer.from(bytes).readUInt32LE(40) === 0x464d4520) return 'emf';
  if (head.readUInt32LE(0) === 0x9ac6cdd7 || head.readUInt16LE(0) === 1 && head.readUInt16LE(2) === 9) return 'wmf';
  throw new Error('This file is not a supported EPS, EMF or WMF document.');
}
export async function convertFilePreview(bytes: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  const format = previewInputFormat(bytes); signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'lolly-preview-'));
  try {
    const input = join(dir, `input.${format}`), output = join(dir, 'preview.pdf'); await writeFile(input, bytes, { mode: 0o600 });
    const args = format === 'eps'
      ? ['gs', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-dNumRenderingThreads=1', '-sDEVICE=pdfwrite', `-sOutputFile=${output}`, input]
      : ['inkscape', input, '--export-type=pdf', `--export-filename=${output}`, '--export-area-page'];
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/prlimit', ['--as=1073741824', '--fsize=33554432', '--cpu=25', '--', ...args], { cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, QT_QPA_PLATFORM: 'offscreen', LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'ignore'] });
      const abort = () => child.kill('SIGKILL'); const timer = setTimeout(abort, 30_000);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); if (signal.aborted) reject(signal.reason); else if (code !== 0) reject(new Error('This file could not be converted within the preview limits.')); else resolve(); });
    });
    signal.throwIfAborted(); const info = await stat(output); if (info.size > PREVIEW_OUTPUT_LIMIT || !info.size) throw new Error('The converted preview is empty or too large.');
    const pdf = await readFile(output); if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('The converter did not return a PDF.'); return pdf;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
