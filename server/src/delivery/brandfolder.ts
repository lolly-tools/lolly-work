// SPDX-License-Identifier: MPL-2.0
/** Brandfolder V4 Binary Upload, followed by create and original-byte readback. */
import { createDamHttp, damRecord, damString } from '../catalog/providers/dam-http.ts';
import { checkedDamInput, exactOrigins, storageUrl, readDamOriginal } from './dam-write.ts';
import { deliveryFilename } from './s3.ts';
import type { DeliveryProvider } from './types.ts';

export interface BrandfolderDeliveryOptions {
  brandfolderId: string;
  sectionId: string;
  /** Operator declaration of the existing Brandfolder's access rules. */
  visibility: 'private' | 'public';
  /** Exact vendor temporary-storage and original-download origins, qualified per tenant. */
  uploadOrigins: string[];
  downloadOrigins: string[];
}

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9_-]{1,200}$/i.test(value);
export function validateBrandfolderDelivery(options: BrandfolderDeliveryOptions): void {
  if (!id(options?.brandfolderId) || !id(options.sectionId)) throw new Error('brandfolder delivery needs brandfolderId and sectionId');
  if (!['private', 'public'].includes(options.visibility)) throw new Error('brandfolder delivery needs an explicit visibility');
  exactOrigins(options.uploadOrigins, 'brandfolder uploadOrigins');
  exactOrigins(options.downloadOrigins, 'brandfolder downloadOrigins');
}

export function createBrandfolderDeliveryProvider(options: BrandfolderDeliveryOptions, secret: string | undefined,
  fetchImpl: typeof fetch = fetch): DeliveryProvider {
  validateBrandfolderDelivery(options);
  if (!secret?.trim() || /[\r\n]/.test(secret)) throw new Error('brandfolder delivery needs an API token');
  const http = createDamHttp('brandfolder delivery', fetchImpl, 0), base = 'https://brandfolder.com/api/v4';
  const headers = { authorization: `Bearer ${secret}`, accept: 'application/json' };
  const uploads = exactOrigins(options.uploadOrigins, 'brandfolder uploadOrigins');
  const downloads = exactOrigins(options.downloadOrigins, 'brandfolder downloadOrigins');
  return {
    kind: 'brandfolder',
    async deliver(input) {
      checkedDamInput(input);
      if (!input.checkpoint) throw new Error('brandfolder delivery requires durable progress');
      let remoteId = input.progress?.remoteId;
      if (input.progress && (input.progress.phase !== 'created' || !id(remoteId))) {
        throw new Error('Brandfolder creation outcome is uncertain. Reconcile this delivery with the operator before creating another asset.');
      }
      if (!remoteId) {
        const ticket = damRecord(await http.json(`${base}/upload_requests`, { headers }));
        // Binary Upload documents a top-level object, distinct from V4 JSON:API data.
        const uploadUrl = storageUrl(ticket.upload_url, uploads), objectUrl = storageUrl(ticket.object_url, uploads);
        await input.authorize?.();
        const uploaded = await http.request(uploadUrl, { method: 'PUT', headers: {
          'content-type': input.contentType, 'content-length': String(input.bytes.byteLength),
        }, body: Buffer.from(input.bytes) });
        await uploaded.body?.cancel();
        await input.authorize?.();
        // Brandfolder documents no create idempotency key. A lost create response
        // must never automatically create a second asset on a later attempt.
        await input.checkpoint({ phase: 'creating' });
        let created: Record<string, unknown>;
        try {
          created = damRecord(await http.json(`${base}/brandfolders/${options.brandfolderId}/assets`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ data: { attributes: [{ name: input.name,
            attachments: [{ url: objectUrl, filename: deliveryFilename(input.name, input.format) }],
          }] }, section_key: options.sectionId }),
          }));
        } catch {
          throw new Error('Brandfolder creation outcome is uncertain. Reconcile this delivery with the operator before creating another asset.');
        }
        const rows = Array.isArray(created.data) ? created.data : [created.data];
        if (rows.length !== 1 || !id(damRecord(rows[0]).id)) throw new Error('Brandfolder returned no single created asset; reconcile before resending');
        remoteId = damString(damRecord(rows[0]).id)!;
        await input.checkpoint({ phase: 'created', remoteId });
      }
      const asset = damRecord(damRecord(await http.json(`${base}/assets/${remoteId}?include=brandfolder,section`, { headers })).data);
      const relations = damRecord(asset.relationships);
      const relationId = (key: string) => damRecord(damRecord(relations[key]).data).id;
      if (asset.id !== remoteId || relationId('brandfolder') !== options.brandfolderId || relationId('section') !== options.sectionId) {
        throw new Error('Brandfolder created asset is outside the configured destination');
      }
      const attachments = damRecord(await http.json(`${base}/assets/${remoteId}/attachments`, { headers })).data;
      if (!Array.isArray(attachments) || attachments.length !== 1) throw new Error('Brandfolder original is not ready; retry this delivery later');
      const attachment = damRecord(attachments[0]), attributes = damRecord(attachment.attributes);
      const original = storageUrl(attributes.url, downloads);
      const deliveredSha256 = await readDamOriginal(original, downloads, input, fetchImpl);
      return { remoteId, deliveredSha256, transformation: 'none' };
    },
  };
}
