// SPDX-License-Identifier: MPL-2.0
/**
 * The most a request body may hold, by kind of route (plans/82 M7). Each route reads
 * its cap from here, and so does the console's Limits and quotas panel, so the page
 * and the check cannot drift apart. The values are the ones each route held inline.
 */

/** A JSON body where a route sets no size of its own: `readJson`'s default. */
export const JSON_BODY_DEFAULT_BYTES = 512 * 1024;
/** A short control body: a confirmation, a choice, a label or a secret to check. */
export const JSON_BODY_CONTROL_BYTES = 4096;
/** A comment and its anchor. */
export const COMMENT_BODY_BYTES = 16_000;
/** An access request's role and note, and an edge purge secret. */
export const JSON_BODY_SMALL_BYTES = 16 * 1024;
/** Where to deliver a retained render output. */
export const DELIVERY_BODY_BYTES = 32 * 1024;
/** Share settings and groups, an edge purge list and a setup proposal. */
export const JSON_BODY_MEDIUM_BYTES = 64 * 1024;
/** A list: people to add, an exit's selection, an upload's or project file's parts. */
export const JSON_BODY_LIST_BYTES = 512 * 1024;
/** A form post: an OIDC logout and the sign-in forms. */
export const FORM_BODY_BYTES = 4096;
/** An OIDC back-channel logout token. */
export const FORM_BODY_LARGE_BYTES = 32 * 1024;
/** An export a provider is asked to publish. */
export const PROVIDER_PUBLISH_BYTES = 64 * 1024 * 1024;
