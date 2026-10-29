// The dashboard half of the entity-card contract (Phase 400 plan 08, DASH-03).
//
// 430 (2026-09-28, D-04): this dashboard renders no entity card. The card render, its actions and
// its payload detector left with the conversation surface, so what the dashboard still owns of the
// contract is the route map alone: an href is minted from ENTITY_KIND_ROUTES over an entity's own
// address, a kind this dashboard does not route gets none, and the absence cells below red if a
// card module or a card export returns. The MCP half is conformance/entity-card-parity.test.ts.

import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import { describe, expect, it } from 'vitest'
import {
  ENTITY_DASHBOARD_ROUTES,
  ENTITY_KINDS,
  isRoutedEntityKind,
  parseEntityUri,
} from '@vostride/agent-qa-schema'

import { ENTITY_KIND_ROUTES, entityRefRoute, entityRouteFor } from '@/lib/entity-routes'

// Comments are stripped so a scan for a network call measures code, not the prose explaining it.
function executableSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, '')
}

const ENTITY_ROUTES_SOURCE_TEXT = readFileSync(
  resolvePath(import.meta.dirname, '../lib/entity-routes.ts'),
  'utf8',
)
const ENTITY_ROUTES_SOURCE = executableSource(ENTITY_ROUTES_SOURCE_TEXT)

describe('the kind -> route map is total', () => {
  it('answers for every member of ENTITY_KINDS and for nothing else', () => {
    expect(Object.keys(ENTITY_KIND_ROUTES).sort()).toEqual([...ENTITY_KINDS].sort())
  })

  it('names the routed kinds as resolvers and the unrouted ones as an explicit null', () => {
    // `null` rather than an absent key, so "this kind has no dashboard route" is a decision
    // somebody wrote down rather than a lookup that happened to miss.
    const shape = Object.fromEntries(
      ENTITY_KINDS.map((kind) => [kind, ENTITY_KIND_ROUTES[kind] === null ? 'unrouted' : 'routed']),
    )
    expect(shape).toEqual({
      TST: 'routed', RUN: 'routed', TGT: 'routed',
      MEM: 'unrouted', POL: 'unrouted',
    })
  })

  it('refuses to mint a route for a routed kind whose address names no machine id', () => {
    // `/test/:t_id` is keyed by machine id; guessing the short-ID into that slot would be a dead
    // link minted with confidence, which D-10 forbids.
    expect(entityRouteFor({ kind: 'TST', shortId: 'TST-001' })).toBeUndefined()
    expect(entityRouteFor({ kind: 'TST', shortId: 'TST-001', machineId: 't-x' })).toBe('/test/t-x')
    expect(entityRouteFor({ kind: 'TGT', shortId: 'TGT-checkout' })).toBe('/config')
  })
})

describe('agentqa:// references resolve through the same map', () => {
  it('renders a reference this dashboard cannot route as plain text', () => {
    expect(entityRouteFor({ kind: 'MEM', shortId: 'MEM-001', machineId: 'b-1' })).toBeUndefined()
  })
})

describe('the entity route module stands on its own', () => {
  it('ENTITY-REF-ROUTE-RESOLVES: a bare reference routes only where its address suffices', () => {
    expect(entityRefRoute('agentqa://target/TGT-checkout-v2')).toBe('/config')
    // Both parse, so an undefined below is the route map's answer and not a parse refusal.
    expect(parseEntityUri('agentqa://memory/MEM-001')).toBeDefined()
    expect(parseEntityUri('agentqa://test/TST-001')).toBeDefined()
    expect(entityRefRoute('agentqa://memory/MEM-001')).toBeUndefined()
    expect(entityRefRoute('agentqa://test/TST-001')).toBeUndefined()
    expect(parseEntityUri('agentqa://target/MEM-001')).toBeUndefined()
    expect(entityRefRoute('agentqa://target/MEM-001')).toBeUndefined()
    expect(entityRefRoute('https://example.test/config')).toBeUndefined()
  })

  it('ENTITY-ROUTES-MODULE-SHAPE: imports only the schema and the route builders, and holds no network path', () => {
    const specifiers = [
      ...ENTITY_ROUTES_SOURCE.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/gu),
    ].map((match) => match[1] ?? match[2])
    expect([...new Set(specifiers)].sort()).toEqual(['@/lib/routes', '@vostride/agent-qa-schema'])
    expect(ENTITY_ROUTES_SOURCE).not.toMatch(/\bfetch\s*\(/u)
    expect(ENTITY_ROUTES_SOURCE).not.toMatch(/\bEventSource\b/u)
    expect(ENTITY_ROUTES_SOURCE).not.toMatch(/\bXMLHttpRequest\b/u)
  })

  it('would SEE a network call if one were added (planted-violation control)', () => {
    const planted = executableSource(`${ENTITY_ROUTES_SOURCE_TEXT}\nawait fetch("/api/entities")\n`)
    expect(planted).toMatch(/\bfetch\s*\(/u)
    expect(executableSource('// we never call fetch(\nconst x = 1')).not.toMatch(/\bfetch\s*\(/u)
    expect(executableSource('/* no fetch( here */\nfetch("/x")')).toMatch(/\bfetch\s*\(/u)
  })
})

// The expectations are read from the schema's shipped ENTITY_DASHBOARD_ROUTES, the same declaration
// the conformance scenario table spreads, so both doors are measured against one contract.
describe('the dashboard route map answers the shipped card-route contract', () => {
  it('routes exactly the kinds the contract says are routed, and none of the ones it does not', () => {
    const fromMap = Object.fromEntries(
      ENTITY_KINDS.map((kind) => [kind, ENTITY_KIND_ROUTES[kind] === null ? null : 'routed']),
    )
    const fromContract = Object.fromEntries(
      ENTITY_KINDS.map((kind) => [kind, isRoutedEntityKind(kind) ? 'routed' : null]),
    )
    expect(fromMap).toEqual(fromContract)
  })

  it('mints an href that fills the contract\'s own template, for every routed kind', () => {
    for (const kind of ENTITY_KINDS) {
      const { route: template, keyedBy } = ENTITY_DASHBOARD_ROUTES[kind]
      if (template === null) continue
      const href = entityRouteFor({ kind, shortId: `${kind}-001`, machineId: 'm-1' })
      const expected =
        keyedBy === 'no-parameter' ? template : `${template.slice(0, template.indexOf(':'))}m-1`
      expect(href, `${kind}: ${String(href)} vs ${template}`).toBe(expected)
    }
  })
})

describe('the dashboard renders no entity card', () => {
  it('NO-CARD-MODULE: the conversation module directory does not exist', () => {
    expect(existsSync(resolvePath(import.meta.dirname, '..', 'chat'))).toBe(false)
  })

  it('NO-CARD-EXPORT: the route module exports the route map and its two resolvers, nothing else', async () => {
    const routeModule = await import('@/lib/entity-routes')
    expect(Object.keys(routeModule).sort()).toEqual([
      'ENTITY_KIND_ROUTES',
      'entityRefRoute',
      'entityRouteFor',
    ])
  })
})
