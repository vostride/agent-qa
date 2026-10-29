// The card ↔ dashboard-route contract.
//
// WHY THIS IS IN `schema` AND NOT IN THE DASHBOARD. Verbatim `url.ts`'s reasoning for
// `ENTITY_URL_ROUTE`: "the M5 route table imports this constant, so 'the dashboard's routes and the
// cards' links agree' is ONE declaration rather than two that were written from the same sentence."
// The same sentence has three readers now — the dashboard's renderer, which mints hrefs from it;
// the conformance scenario table, whose entity-card cases are built OVER it; and the parity cells
// on both doors, which join against it. Three copies of a route table is three places a kind can
// quietly acquire or lose a page, with nothing comparing them.
//
// AND IT IS A CONTRACT, NOT A FIXTURE. What a kind's card links to is a published fact about this
// product's surfaces — the same class of fact as `ENTITY_URL_ROUTE` and `ENTITY_URI_SEGMENTS`, both
// of which already live here. A test-only table would have made the parity suite's idea of the
// routes the subject and left the shipped ones unmeasured.
//
// THE `null` ARM IS THE HONEST ONE. A kind with no page here says so, and every reader is
// obliged to render nothing rather than a link — not a disabled anchor, not a `#`, not the card's
// own `url`, which addresses `ENTITY_URL_ROUTE`'s M5 shape that no build serves yet. "A card that
// carried a link to a route nothing serves would be a dead link shown with confidence."

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

/**
 * THE per-kind table, total over `EntityKind`.
 *
 * `as const satisfies Record<EntityKind, …>` is the completeness guarantee every other per-kind
 * table in this directory carries: a sixth kind is a compile error here rather than a kind whose
 * card silently renders whichever arm a lookup happened to miss. There is deliberately no fallback.
 *
 * The three routed paths are the ones `dashboard-ui/src/app.tsx` registers today. The two `null`
 * arms are not placeholders: `MEM`/`POL` have no page in this build. They are also the arms that
 * matter most to measure —
 * a `MEM` card in dashboard chat DOES carry a `url` (400-01's D-16 overlays a base for any
 * conversation the dashboard serves) and must still offer nothing to click.
 */
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
