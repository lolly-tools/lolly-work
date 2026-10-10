// SPDX-License-Identifier: MPL-2.0
/** Real native, signature and immutable ABI checks inside an isolated Work image. */
import fs from 'node:fs'; import crypto from 'node:crypto'; import { createRequire } from 'node:module';
const require = createRequire('/app/package.json'), { Resvg } = require('@resvg/resvg-js'), sharp = require('sharp');
const need = (value, message) => { if (!value) throw Error(message); }, sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const chunks = []; let size = 0; for await (const bytes of process.stdin) { size += bytes.length; need(size <= 16 * 1024 ** 2, 'Native input bound'); chunks.push(bytes); }
const input = JSON.parse(Buffer.concat(chunks));
need(process.getuid() > 0 && process.getgid() > 0 && Number(process.versions.node.split('.')[0]) >= 24, 'Non-root Node 24 runtime required');
need(['DATABASE_URL','DATABASE_URL_UNPOOLED','LW_DATABASE_URL','LW_SESSION_SECRET','LW_LINK_SECRET','LW_RENDER_WORKER_SECRET','LW_CATALOG_SIGNING_KEY','LW_CONFIG','LW_SEED_CONFIG','LW_ALLOW_STALE_SHELL','NODE_OPTIONS'].every(key => !process.env[key]), 'Inherited production environment refused');
const pinBytes = fs.readFileSync('/app/engine-pin.json'), pin = JSON.parse(pinBytes);
need(sha(pinBytes) === input.enginePinSha256 && fs.readFileSync('/stage/engine-pin.json').equals(pinBytes) && pin.generatedFrom === input.sources.engine, 'Accepted baked/mounted engine pin differs');
need(sha(fs.readFileSync('/app/content-resolver-pin.json')) === input.resolverPinSha256, 'Accepted resolver pin differs');
const { contentHash } = await import('/app/scripts/lib/content-hash.ts');
for (const [root, family] of [['/app/vendor/@lolly/engine','engine'],['/app/vendor/@lolly-tools/core','core']]) need(contentHash(root) === pin[family].contentHash, 'Vendor content differs');
for (const [name, hash] of Object.entries(pin.schemas)) need(sha(fs.readFileSync('/app/vendor/@lolly/schemas/' + name)) === hash, 'Schema ABI differs');
need(input.sourceFiles && Object.keys(input.sourceFiles).length > 0 && Object.keys(input.sourceFiles).length <= 8192, 'Accepted image source map required');
for (const [relative, file] of Object.entries(input.sourceFiles)) {
  need(relative && !relative.startsWith('/') && !relative.includes('\\') && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe accepted source path');
  const full = '/app/' + relative, stat = fs.lstatSync(full);
  if (file.mode === 'symlink') need(stat.isSymbolicLink() && fs.readlinkSync(full) === file.linkTarget, 'Source link differs');
  else need(stat.isFile() && (stat.mode & 0o7777) === parseInt(file.mode, 8) && stat.size === file.bytes && sha(fs.readFileSync(full)) === file.sha256, 'Accepted image source differs');
}
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="13" height="7"><rect width="13" height="7" fill="green"/></svg>').render().asPng();
const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
need(decoded.info.width === 13 && decoded.info.height === 7 && decoded.info.channels === 4, 'Native PNG dimensions differ');
for (let at = 0; at < decoded.data.length; at += 4) need(decoded.data[at] === 0 && decoded.data[at+1] === 128 && decoded.data[at+2] === 0 && decoded.data[at+3] === 255, 'Native PNG pixels differ');
const { importSpkiOrJwkPublicKey, verifyCatalogEnvelope, verifyToolFile } = await import('/app/vendor/@lolly/engine/src/catalog-integrity.ts');
need(input.publicKey.kty === 'EC' && input.publicKey.crv === 'P-256' && !('d' in input.publicKey), 'Public-only P-256 pin required');
const index = fs.readFileSync('/stage/shell/catalog/tools/index.json'), envelopeBytes = fs.readFileSync('/stage/shell/catalog/tools/index.sig.json'), envelope = JSON.parse(envelopeBytes);
need(sha(index) === input.catalog.indexSha256 && sha(envelopeBytes) === input.catalog.envelopeSha256 && envelope.keyId === input.catalog.keyId
  && Object.keys(envelope.files).length === input.catalog.signedFiles, 'Qualified catalog differs');
need((await verifyCatalogEnvelope(envelope, index, await importSpkiOrJwkPublicKey(JSON.stringify(input.publicKey)))).ok, 'Catalog signature refused');
for (const [relative, hash] of Object.entries(envelope.files)) {
  need(relative && !relative.startsWith('/') && !relative.includes('\\') && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe signed path');
  const a = fs.readFileSync('/stage/shell/tools/' + relative), b = fs.readFileSync('/stage/pack/tools/' + relative), [tool, ...parts] = relative.split('/');
  need(sha(a) === hash && a.equals(b) && (await verifyToolFile(envelope, tool, parts.join('/'), a)).ok, 'Signed shell/raw bytes differ');
}
const { checkShellDist } = await import('/app/server/src/lib/shell-dist.ts'); const shell = checkShellDist('/stage/shell'); need(shell.present && shell.hasOrgConfig, 'Governed shell marker missing');
console.log(JSON.stringify({ version: 1, status: 'ISOLATED_NATIVE_CATALOG_VERIFIED', qualified: true, uid: process.getuid(), gid: process.getgid(), node: process.versions.node,
  engineVersion: pin.engine.version, coreVersion: pin.core.version, sourceFiles: Object.keys(input.sourceFiles).length, signedFiles: Object.keys(envelope.files).length,
  vendorContentMatches: true, retainedImmutablePinVerified: true, filteredCatalogSignatureVerified: true, publicPinMatches: true, nativeDecodedGreenPixels: 91,
  network: false, database: false, productionSecrets: false, physicalGpuClaimed: false }));
