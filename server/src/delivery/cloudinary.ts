// SPDX-License-Identifier: MPL-2.0
/** Create-only authenticated raw assets; no presets or transformations. */
import { createHash } from 'node:crypto';
import { createDamHttp, DamHttpError, damRecord } from '../catalog/providers/dam-http.ts';
import { checkedDamInput, verifyDamBytes } from './dam-write.ts';
import { deliveryFilename } from './s3.ts';
import type { DeliveryProvider } from './types.ts';

export interface CloudinaryDeliveryOptions {
  cloudName: string;
  region?: 'us' | 'eu' | 'ap';
  /** This first adapter requires a dynamic-folder product environment. */
  folderMode: 'dynamic';
  assetFolder: string;
  /** Separate operation-owned namespace; never an existing asset's public ID. */
  publicIdPrefix: string;
}

export function validateCloudinaryDelivery(options: CloudinaryDeliveryOptions): void {
  if (!/^[a-z0-9_-]{1,128}$/i.test(options?.cloudName ?? '')) throw new Error('cloudinary delivery needs cloudName');
  if (options.region !== undefined && !['us', 'eu', 'ap'].includes(options.region)) throw new Error('cloudinary delivery region must be us, eu or ap');
  if (options.folderMode !== 'dynamic') throw new Error('cloudinary delivery requires explicit dynamic folderMode');
  for (const key of ['assetFolder', 'publicIdPrefix'] as const) {
    const value = options[key];
    if (typeof value !== 'string' || !value || value.length > 200 || !value.split('/').every(part => /^[a-z0-9_-]+$/i.test(part))) {
      throw new Error(`cloudinary delivery needs a bounded ${key} path of letters, numbers, underscores or hyphens`);
    }
  }
}

export function createCloudinaryDeliveryProvider(options: CloudinaryDeliveryOptions, secret: string | undefined,
  fetchImpl: typeof fetch = fetch): DeliveryProvider {
  validateCloudinaryDelivery(options);
  let apiKey: string, apiSecret: string;
  try {
    const value = JSON.parse(secret ?? '');
    if (typeof value.apiKey !== 'string' || !/^[a-z0-9_-]+$/i.test(value.apiKey)
      || typeof value.apiSecret !== 'string' || !value.apiSecret || /[\r\n:]/.test(value.apiSecret)) throw new Error();
    apiKey = value.apiKey; apiSecret = value.apiSecret;
  } catch { throw new Error('cloudinary delivery credential must be JSON containing apiKey and apiSecret'); }
  const host = { us: 'api.cloudinary.com', eu: 'api-eu.cloudinary.com', ap: 'api-ap.cloudinary.com' }[options.region ?? 'us'];
  const base = `https://${host}/v1_1/${options.cloudName}`;
  const http = createDamHttp('cloudinary delivery', fetchImpl, 0);
  const headers = { authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}` };
  return {
    kind: 'cloudinary',
    async deliver(input) {
      checkedDamInput(input);
      if (input.bytes.byteLength > 64 * 1024 * 1024) throw new Error('cloudinary delivery exceeds the 64 MiB single-upload ceiling');
      const publicId = `${options.publicIdPrefix}/${input.deliveryId}/${input.sha256}.${input.format}`;
      const detailUrl = `${base}/resources/raw/authenticated/${encodeURIComponent(publicId)}?context=true`;
      const detail = async (): Promise<Record<string, unknown> | null> => {
        try { return damRecord(await http.json(detailUrl, { headers })); }
        catch (error) { if (error instanceof DamHttpError && error.status === 404) return null; throw error; }
      };
      let resource = await detail();
      if (!resource) {
        await input.authorize?.();
        const form = new FormData();
        form.set('file', new Blob([Buffer.from(input.bytes)], { type: input.contentType }), deliveryFilename(input.name, input.format));
        form.set('public_id', publicId);
        form.set('asset_folder', options.assetFolder);
        form.set('type', 'authenticated');
        form.set('overwrite', 'false');
        form.set('unique_filename', 'false');
        form.set('context', `lolly_delivery=${input.deliveryId}|lolly_sha256=${input.sha256}`);
        // Server-side Basic auth is supported by the Upload API. All fields are
        // fixed here; no upload preset, remote URL, eager transform or add-on.
        await http.json(`${base}/raw/upload`, { method: 'POST', headers, body: form });
        resource = await detail();
      }
      if (!resource) throw new Error('Cloudinary original is not ready; retry this delivery later');
      const context = damRecord(resource.context), custom = damRecord(context.custom);
      if (resource.public_id !== publicId || resource.type !== 'authenticated' || resource.resource_type !== 'raw'
        || resource.asset_folder !== options.assetFolder || custom.lolly_delivery !== input.deliveryId || custom.lolly_sha256 !== input.sha256
        || typeof resource.asset_id !== 'string' || !/^[a-z0-9_-]{1,200}$/i.test(resource.asset_id)) {
        throw new Error('Cloudinary existing asset does not belong to this delivery; it was not overwritten');
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      const params = { asset_id: resource.asset_id, expires_at: String(Number(timestamp) + 60), timestamp };
      const canonical = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
      const signature = createHash('sha256').update(canonical + apiSecret).digest('hex');
      const original = await http.request(`${base}/asset/download`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, api_key: apiKey, signature }).toString() });
      const deliveredSha256 = await verifyDamBytes(original, input);
      return { remoteId: resource.asset_id, deliveredSha256, transformation: 'none' };
    },
  };
}
