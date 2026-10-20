// SPDX-License-Identifier: MPL-2.0
import { createS3DeliveryProvider, type S3DeliveryOptions } from './s3.ts';
import { createWebdavDeliveryProvider, type WebdavDeliveryOptions } from './webdav.ts';
import { createHttpsDeliveryProvider, type HttpsDeliveryOptions } from './https.ts';
import { createBrandfolderDeliveryProvider, type BrandfolderDeliveryOptions } from './brandfolder.ts';
import { createCloudinaryDeliveryProvider, type CloudinaryDeliveryOptions } from './cloudinary.ts';
import type { ConfigDeliveryDestination, DeliveryProvider } from './types.ts';

export function createDeliveryProvider(
  destination: ConfigDeliveryDestination,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): DeliveryProvider {
  switch (destination.kind) {
    case 'brandfolder':
      return createBrandfolderDeliveryProvider(destination.options as unknown as BrandfolderDeliveryOptions, secret, fetchImpl);
    case 'cloudinary':
      return createCloudinaryDeliveryProvider(destination.options as unknown as CloudinaryDeliveryOptions, secret, fetchImpl);
    case 's3':
      return createS3DeliveryProvider(destination.options as unknown as S3DeliveryOptions, secret, fetchImpl);
    case 'webdav':
      return createWebdavDeliveryProvider(destination.options as unknown as WebdavDeliveryOptions, secret, fetchImpl);
    case 'https':
      return createHttpsDeliveryProvider(destination.options as unknown as HttpsDeliveryOptions, secret, fetchImpl);
    default:
      throw new Error(`delivery destination kind not implemented: ${destination.kind}`);
  }
}
