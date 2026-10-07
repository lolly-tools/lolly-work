// SPDX-License-Identifier: MPL-2.0
import { evaluate, type PrincipalCtx, type Grant } from '../rbac/evaluate.ts';

/** Mirror route requirements, including endpoints that still require an admin role. */
export function consoleAccess(principal: PrincipalCtx, grants: Grant[]) {
  const requirements: Record<string, string[]> = {
    overview: ['telemetry.view'], activity: ['audit.export'], agents: ['audit.export'], fleet: ['fleet.view'], rooms: ['telemetry.view'],
    links: ['link.revoke'], tools: ['policy.edit'], catalog: ['catalog.expire'], providers: ['catalog.provider.read'],
    injectables: ['catalog.injectable.manage'], flags: ['policy.edit'], design: ['catalog.read'],
    contractors: ['link.create-guest'], grants: ['grant.edit'], preview: ['policy.edit'], audit: ['audit.export'],
    setup: ['instance.config'], tokens: ['token.manage', 'scim.manage'], chains: ['policy.edit'],
  };
  const actions = [...new Set(Object.values(requirements).flat().concat([
    'brand.switch', 'catalog.provider.credential', 'catalog.provider.manage', 'catalog.edit',
    'project.create', 'project.manage', 'session.create', 'approval.act', 'catalog.submit', 'user.invite',
    // The review panel offers a collection to join on approval (plan 299).
    'catalog.collection.manage',
  ]))].filter(action => evaluate(principal, action, ['*'], grants));
  const views = Object.fromEntries(Object.entries(requirements).map(([id, requirements]) =>
    [id, requirements.some(action => actions.includes(action))]));
  views.instance = ['tools', 'catalog', 'providers', 'design', 'flags', 'injectables'].some(id => views[id]);
  views.users = principal.role === 'admin' || principal.role === 'owner';
  for (const id of ['messages', 'projects', 'approvals', 'docs', 'verify']) views[id] = true;
  return { actions, views };
}
