// The MCP half of the entity card claim; both halves read `ENTITY_CARD_RENDER_CASES`.

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

// Minted by `formatEntityUri`: `TGT` is slug-addressed and every other kind is ordinal-addressed.
function canonicalReferenceFor(kind: EntityKind): string {
  return formatEntityUri(kind, shortIdFor(kind))
}

// The bare `<op> completed` line: the mutation bar.
function droppedRender(opId: string): string {
  return `${opId} completed`
}

function shortIdFor(kind: EntityKind): string {
  return kind === 'TGT' ? 'TGT-checkout' : `${kind}-001`
}

// `EntityCardSchema` is `.strict()`, so this lists the field names it admits, not content.
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
    // Unrouted kinds have a `url` in hand and must still refuse to make it a destination.
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
      // A marker the dropping render already contains would read green on a broken build.
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
