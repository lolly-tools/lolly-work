// SPDX-License-Identifier: MPL-2.0
/**
 * Who is behind a view as a partner (programmes/view-as.ts), as trusted request
 * metadata: never a group name and never a grant principal, so nothing an identity
 * provider sends and no grant can stand in for it.
 *
 * Every request runs inside its own holder (api/app.ts), and the view-as gate fills
 * it once it admits a view. The served feed (catalog/served-index.ts) reads it to
 * answer the partner's feed AND the admin's own, for the partner's groups only.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from './evaluate.ts';

export interface ViewContext {
  /** The groups the view answers as (the partner's). */
  subjectGroups: readonly string[];
  /** The admin behind the view. */
  viewer: { userId: string; groups: string[]; role: Role };
}

const requests = new AsyncLocalStorage<{ view?: ViewContext }>();

/** Run one request with a fresh, empty holder. */
export function withRequestView<T>(fn: () => T): T {
  return requests.run({}, fn);
}

/** Record the view the current request was admitted as. Outside a request, nothing. */
export function enterView(view: ViewContext): void {
  const holder = requests.getStore();
  if (holder) holder.view = view;
}

/** The view the current request was admitted as, or undefined. */
export function currentView(): ViewContext | undefined {
  return requests.getStore()?.view;
}
