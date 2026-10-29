// The entity card, held to ONE denominator across two doors.
//
// WHAT THIS LEG IS AND IS NOT. It is the MCP half of a claim whose other half lives in
// `packages/dashboard-ui/src/__tests__/entity-card.test.ts`, and BOTH halves read the SAME rows:
// `ENTITY_CARD_RENDER_CASES` on `scenario-table.ts`, reached from the `entityCardExpect` column the
// entity ops carry. That arrangement is DASH-03's parity clause taken literally and 399.1 D-09's
// one-denominator rule applied to a new kind of expectation — a dashboard-only card census beside
// the table would be a table measured against itself, and the two would drift in the direction of
// whichever was edited more.
//
// WHY THE TWO SURFACES CONSUME THE ROW DIFFERENTLY, AND WHY THAT IS NOT A LOOPHOLE. A card reaches
// a browser as an element tree and reaches an MCP client as a JSON document with a dereferenceable
// address. Those are different MEDIA for one claim, not different claims: the row states the fields
// a reader must be able to read and the route/reference each kind resolves to, and each surface's
// consumer asserts that in its own medium. What neither may do is state its own expectation, which
// is why the cases live on the table and nothing below writes one down.
//
// WHY THE TWO CONSUMERS DO NOT IMPORT EACH OTHER. Every package's `tsconfig.json` pins `rootDir` to
// its own `src`, so a cross-package relative import is a `tsc --noEmit` error (TS6059) — a real
// boundary, not a nuisance. The shared declaration therefore lives in the ONE package both depend
// on: `ENTITY_DASHBOARD_ROUTES` is a shipped contract in `schema/src/entity/dashboard-route.ts`,
// beside `ENTITY_URL_ROUTE` and on that constant's own stated reasoning. This table's cases are
// SPREAD from it rather than restating it, and the cell below asserts that spread held.
//
// WHAT THIS LEG DOES NOT RE-ASSERT. `render-parity.test.ts` already drives BOTH entity ops on the
// MCP door and holds every declared field of a card result to the caller, with its own mutation
// bar — the same rows, the same table. Repeating that here would be a second cell over one claim.
// What is left, and what a per-KIND expectation is actually for, is the REFERENCE form: MCP's card
// link is the `agentqa://<segment>/{id}` resource template (`mcp/src/resources.ts`), one per kind,
// and a reference that is not a canonical address for its own kind is a link nothing can
// dereference.
//
// 430: the dashboard renders no card, so the dashboard half of DASH-03 is now the
// route contract in dashboard-ui's `entity-card.test.ts`: an href minted over an entity's own address
// by the shared route map, and none for a kind the dashboard does not route.

import { AGENT_QA_OP_CONTRACTS } from '@vostride/agent-qa-mcp'
import {
  ENTITY_DASHBOARD_ROUTES,
  ENTITY_KINDS,
  ENTITY_URI_SEGMENTS,
  EntityCardResolutionSchema,
  EntityCardSchema,
  formatEntityUri,
  isRoutedEntityKind,
  parseEntityUri,
  type EntityKind,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { ENTITY_CARD_RENDER_CASES, SCENARIO_TABLE } from './scenario-table.js'
import type { ScenarioRow } from './scenario-table.js'

/** The rows that claim to answer with an entity card. */
const CARD_ROWS: readonly ScenarioRow[] = SCENARIO_TABLE.filter(
  (row) => row.entityCardExpect !== undefined,
)

/**
 * A canonical address for one kind, minted by the codec that defines one.
 *
 * `formatEntityUri` rather than a template string, so this is the address a card actually carries
 * rather than a spelling this file believes in. `TGT` is slug-addressed and every other kind
 * is ordinal-addressed, which the codec knows and this file does not have to.
 */
function canonicalReferenceFor(kind: EntityKind): string {
  return formatEntityUri(kind, shortIdFor(kind))
}

/** The line that WAS the whole of what a person saw, before 399.1 — the mutation bar. */
function droppedRender(opId: string): string {
  return `${opId} completed`
}

function shortIdFor(kind: EntityKind): string {
  return kind === 'TGT' ? 'TGT-checkout' : `${kind}-001`
}

/**
 * The field names the CARD CONTRACT admits, enumerated from a minimal card the contract accepts.
 *
 * NOT A STAND-IN FOR PRODUCER OUTPUT, and it must never become one — what a card CONTAINS is the
 * producer's claim and 390-03 says a cell asserting about content drives the producer. What this
 * answers is narrower and is a question only the contract can answer: which NAMES are fields at
 * all. `EntityCardSchema.parse` is the authority, and it is `.strict()`, so a name this object
 * carried that the contract does not declare would throw here rather than widen the set.
 */
const CARD_CONTRACT_FIELDS: readonly string[] = Object.keys(
  EntityCardSchema.parse({
    kind: 'MEM',
    id: 'MEM-001',
    uri: formatEntityUri('MEM', 'MEM-001'),
    title: 'a minimal card the contract admits',
    status: 'active',
    url: 'https://example.invalid/x',
    keyFacts: [],
    actions: [],
  }),
)

// ---- The census: one denominator, both directions ---------------------------------------------

describe('the card expectation is a column on the ONE table', () => {
  it('is carried by exactly the ops whose OUTPUT CONTRACT is the card contract', () => {
    // Derived from the shipped mapping by OBJECT IDENTITY against the two card schemas, never from
    // a list of op ids typed here. An op that acquires a card result and forgets the column is a
    // named RED; a row that carries the column for an op that returns something else is the other
    // direction of the same red.
    const opsReturningCards = Object.entries(AGENT_QA_OP_CONTRACTS)
      .filter(([, contracts]) =>
        contracts.output === EntityCardSchema || contracts.output === EntityCardResolutionSchema)
      .map(([opId]) => opId)
      .sort()

    expect(CARD_ROWS.map((row) => row.opId).sort()).toEqual(opsReturningCards)
    expect(opsReturningCards.length).toBeGreaterThan(0)
  })

  it('states a case for EVERY card kind and for nothing else', () => {
    expect(Object.keys(ENTITY_CARD_RENDER_CASES).sort()).toEqual([...ENTITY_KINDS].sort())
    for (const row of CARD_ROWS) {
      expect([...(row.entityCardExpect?.kinds ?? [])].sort()).toEqual([...ENTITY_KINDS].sort())
    }
  })

  it('carries the URL-ABSENT arm, not just the routed happy paths', () => {
    // The verifier's own requirement for this plan. An expectation set containing only TST/RUN/TGT
    // would state the claim it was already going to pass; the unrouted kinds are where a render has
    // a `url` in hand — 400-01's D-16 overlays a base for any conversation the dashboard serves —
    // and must still refuse to make it a destination.
    const unrouted = ENTITY_KINDS
      .filter((kind) => ENTITY_CARD_RENDER_CASES[kind].dashboardRoute === null)
      .sort()
    expect(unrouted).toEqual(['MEM', 'POL'])
    // `MEM` is the only kind any shipped composition mints today, which is what makes the unrouted
    // arm the one a real reader reaches rather than a hypothetical.
    expect(unrouted).toContain('MEM')
  })

  it('SPREADS the shipped route contract rather than restating it', () => {
    // The one-denominator claim, made structural. If these cases carried their own copy of the
    // routes, the dashboard could stop serving `/runs/:id` and this table would keep asserting a
    // page that is gone — which is the drift the shared declaration exists to make impossible.
    for (const kind of ENTITY_KINDS) {
      expect(ENTITY_CARD_RENDER_CASES[kind].dashboardRoute).toBe(ENTITY_DASHBOARD_ROUTES[kind].route)
      expect(ENTITY_CARD_RENDER_CASES[kind].routeKeyedBy).toBe(ENTITY_DASHBOARD_ROUTES[kind].keyedBy)
    }
  })
})

// ---- The MCP half of the row: the reference a resource read can dereference -------------------

for (const row of CARD_ROWS) {
  for (const kind of ENTITY_KINDS) {
    it(`${row.opId} / ${kind} on mcp: the reference form is the address a resource read resolves`, () => {
      // MCP's per-kind card link is the `agentqa://<segment>/{id}` resource template
      // (`mcp/src/resources.ts`), derived from the SAME `ENTITY_URI_SEGMENTS` table the URI codec
      // is. So the reference half of this row on this door is: a card's `uri` is a canonical
      // address for its OWN kind and id, and it round-trips through the codec an MCP
      // `resources/read` parses the caller's URI with. A reference that did not is a link nothing
      // can dereference — `resources.ts`'s own opening sentence.
      const reference = canonicalReferenceFor(kind)
      expect(reference.startsWith(`agentqa://${ENTITY_URI_SEGMENTS[kind]}/`)).toBe(true)

      const parsed = parseEntityUri(reference)
      expect(parsed?.kind).toBe(kind)
      expect(formatEntityUri(kind, parsed?.shortId ?? '')).toBe(reference)

      // The segment vocabulary is per-kind and the codec REFUSES a mismatched pair, which is what
      // makes the template a per-kind claim rather than five spellings of one.
      const otherKind = ENTITY_KINDS.find((candidate) => candidate !== kind) ?? kind
      const crossed = `agentqa://${ENTITY_URI_SEGMENTS[otherKind]}/${parsed?.shortId ?? ''}`
      expect(parseEntityUri(crossed)).toBeUndefined()
    })

    it(`${row.opId} / ${kind} on mcp: the row's markers name fields a card contract carries`, () => {
      const expected = ENTITY_CARD_RENDER_CASES[kind]
      expect(expected.markers.length).toBeGreaterThan(0)
      // NON-VACUITY: a marker naming nothing on the card contract would make every consumer of
      // this row assert about a shape nothing returns. The shape is read off the contract itself.
      expect(expected.markers.filter((marker) => !CARD_CONTRACT_FIELDS.includes(marker)))
        .toEqual([])
      // MUTATION BAR: a marker the pre-399.1 drop site already contained would read green on the
      // build this phase exists to red.
      expect(expected.markers.filter((marker) => droppedRender(row.opId).includes(marker)))
        .toEqual([])
    })
  }
}

// ---- The route grain the dashboard half joins against ------------------------------------------

describe('the route each case names is one this build can actually serve', () => {
  it('keys every routed case on a grain the card can supply, and says which', () => {
    // The dead-link question, stated on the row rather than left to each surface. A `TST` page is
    // keyed by machine id and a card's `id` is its published short-ID; a case that said only
    // "routed" would be satisfied by a link that 404s. `TGT` is the one routed kind whose page
    // takes no parameter, which is why it can route from an address alone.
    const byGrain = Object.fromEntries(
      ENTITY_KINDS.map((kind) => [kind, ENTITY_CARD_RENDER_CASES[kind].routeKeyedBy]),
    )
    expect(byGrain).toEqual({
      TST: 'machine-id',
      RUN: 'machine-id',
      TGT: 'no-parameter',
      MEM: 'unrouted',
      POL: 'unrouted',
    })

    // The grain and the route agree in both directions: `unrouted` iff no route — asserted rather
    // than assumed, because the two fields are what the dashboard's render branches on and a pair
    // that disagreed would send it down an arm the table did not mean.
    for (const kind of ENTITY_KINDS) {
      const entry = ENTITY_CARD_RENDER_CASES[kind]
      expect(entry.routeKeyedBy === 'unrouted').toBe(entry.dashboardRoute === null)
      expect(isRoutedEntityKind(kind)).toBe(entry.dashboardRoute !== null)
    }
  })

  it('gives every parameterised route exactly one parameter to fill', () => {
    // Without this a case could name `/test/:t_id/:other` and the dashboard's fill rule — one
    // grain, one slot — would silently produce a path missing a segment.
    for (const kind of ENTITY_KINDS) {
      const entry = ENTITY_CARD_RENDER_CASES[kind]
      if (entry.dashboardRoute === null) continue
      const params = entry.dashboardRoute.match(/:[A-Za-z_][A-Za-z0-9_]*/gu) ?? []
      expect(params.length, `${kind}: ${entry.dashboardRoute}`)
        .toBe(entry.routeKeyedBy === 'no-parameter' ? 0 : 1)
    }
  })
})
