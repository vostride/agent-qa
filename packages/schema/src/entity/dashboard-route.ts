// A kind with a `null` route renders no link: its card's `url` addresses a route no build serves.

import type { EntityKind } from './kinds'

/**
 * WHICH address fills a route's parameter — the grain a link is keyed by.
 *
 * Declared rather than left implicit because it is the whole of the dead-link question. A test's
 * page is keyed by its MACHINE ID (`/test/t-irish-vise-s`) while a card's `id` is its published
 * short-ID (`TST-001`) — a different address in a different namespace — so a table that said only
 * "routed" would be satisfied by a link that 404s. `no-parameter` is a real third answer and not a
 * degenerate one: a target's page is the config surface, which is why `TGT` can route from an
 * address alone where `TST` and `RUN` cannot.
 */
export const ENTITY_DASHBOARD_ROUTE_GRAINS = [
  'machine-id',
  'no-parameter',
  'unrouted',
] as const

export type EntityDashboardRouteGrain = (typeof ENTITY_DASHBOARD_ROUTE_GRAINS)[number]

export interface EntityDashboardRoute {
  /**
   * The route TEMPLATE, or `null` for a kind this dashboard has no page for.
   *
   * A template rather than a rendered path, on `ENTITY_URL_ROUTE`'s reasoning: a router consumes
   * the template and a card consumes the rendering, and both have to be able to name the same
   * thing.
   */
  readonly route: string | null
  readonly keyedBy: EntityDashboardRouteGrain
}

// `MEM` and `POL` have no page, so even a `MEM` card that carries a `url` offers nothing to click.
export const ENTITY_DASHBOARD_ROUTES = {
  TST: { route: '/test/:t_id', keyedBy: 'machine-id' },
  RUN: { route: '/runs/:id', keyedBy: 'machine-id' },
  MEM: { route: null, keyedBy: 'unrouted' },
  POL: { route: null, keyedBy: 'unrouted' },
  TGT: { route: '/config', keyedBy: 'no-parameter' },
} as const satisfies Record<EntityKind, EntityDashboardRoute>

/** Does this build serve a page for that kind? The one predicate, so nobody re-derives it. */
export function isRoutedEntityKind(kind: EntityKind): boolean {
  return ENTITY_DASHBOARD_ROUTES[kind].route !== null
}
