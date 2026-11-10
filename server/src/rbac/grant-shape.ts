// SPDX-License-Identifier: MPL-2.0
/**
 * Which grants can ever match (plans/82 fault B).
 *
 * The evaluator compares a grant's resource with the selectors a route passes
 * in, and nothing else. A grant naming a selector no route produces is stored,
 * listed in the console and exported in the governance document, and decides
 * nothing: a deny an admin wrote to keep logos from a partner programme
 * (`catalog.read` on `catalog:tag/logo`) left every logo served. This module
 * says, before a grant is stored, whether it can match, so the write paths
 * refuse one that cannot and the console marks one already stored.
 *
 * The table below lists, per action, the selector kinds the server evaluates
 * that action against. Every action is also evaluated against `*`. An action
 * absent from the table is decided for the whole deployment, so `*` is the only
 * resource that can match it. `approval.act` is the exception: its selectors
 * include the approval's own subject reference, which a requester supplies,
 * so any resource can match it.
 */
import { knownActions, type Grant } from './evaluate.ts';

/** Selector kinds each action is evaluated against, beside `*`. Keep in step with
 *  the call sites; `tests/grant-shape.test.ts` names them. */
const RESOURCE_KINDS: Readonly<Record<string, readonly string[]>> = {
  'tool.use': ['tool'],
  'export.server': ['tool'],
  'export.request': ['tool'],
  'export.download': ['tool'],
  'link.create': ['tool'],
  'link.create-guest': ['tool'],
  'delivery.create': ['destination'],
  'project.manage': ['project'],
  // A programme's tokens, usage, View as and template review check `programme:<id>`;
  // the rest of the programme routes check `*` only.
  'programme.manage': ['programme'],
  'session.view': ['session', 'project'],
  'session.edit': ['session', 'project'],
  'comment.view': ['session', 'project'],
  'comment.create': ['session', 'project'],
  'comment.edit': ['session', 'project'],
  'comment.resolve': ['session', 'project'],
  'comment.moderate': ['session', 'project'],
};

/** Actions whose selectors include a free-form subject reference. */
const ANY_RESOURCE = new Set(['approval.act']);

const ID = /^[A-Za-z0-9._~-]{1,200}$/;

/** The resource forms an action accepts, for messages: `*` first. */
export function acceptedResources(action: string): string[] {
  if (ANY_RESOURCE.has(action)) return ['*', 'chain:<id>', 'approval:<id>', 'or a subject reference'];
  return ['*', ...(RESOURCE_KINDS[action] ?? []).map(kind => `${kind}:<id>`)];
}

/**
 * Why this grant can never match, or null when it can. Callers refuse a new
 * grant with this text and show it beside a stored one.
 */
export function grantNeverMatches(grant: Pick<Grant, 'action' | 'resource'>): string | null {
  const { action, resource } = grant;
  if (!knownActions().has(action)) {
    return `"${action}" is not a permission this deployment checks, so the rule would never apply.`;
  }
  if (resource === '*' || ANY_RESOURCE.has(action)) return null;
  const kinds = RESOURCE_KINDS[action] ?? [];
  const colon = resource.indexOf(':');
  const kind = colon > 0 ? resource.slice(0, colon) : '';
  const id = colon > 0 ? resource.slice(colon + 1) : '';
  if (!kinds.length) {
    return `"${action}" is checked for the whole deployment, not per ${kind || 'resource'}, so its resource must be "*".`;
  }
  if (id.startsWith('tag/')) {
    return `Tag selectors are not checked. Name each ${kinds[0]} instead, for example ${kinds[0]}:<id>.`;
  }
  if (!kinds.includes(kind) || !ID.test(id)) {
    return `"${action}" is checked against ${acceptedResources(action).map(form => `"${form}"`).join(' or ')}, so "${resource}" would never match.`;
  }
  return null;
}
