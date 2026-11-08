// SPDX-License-Identifier: MPL-2.0
/**
 * Audit limits. Audit retirement reads them from here, and so does the Limits and quotas
 * panel, which must not load retirement to show them.
 */

/** The longest reason kept on the boundary row. It is operator text in the
 *  audit log, so it should say why ("secret rotation 2026-10-04"), not who. */
export const RETIRE_REASON_MAX = 200;
