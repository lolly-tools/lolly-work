// SPDX-License-Identifier: MPL-2.0
/**
 * The production PDF readback's pixel budget. The readback is loaded only when a PDF is
 * read back, so the Limits and quotas panel reads the budget from here instead.
 */
export const PRODUCTION_MAX_PIXELS = 16_000_000;
