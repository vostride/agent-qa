// Conformance-suite LEG 5 — reverse completeness (Phase 384, SC4).
//
// Leg 1 asks "is every registered capability covered?". This leg asks the reverse and
// harder question: "does every SURFACE project only capabilities the registry declares?"
// A surface that quietly published something the layer never declared would be a private
// power wearing a catalog entry, which is the failure the firewall exists to make
// impossible and this leg exists to make visible.
//
// It is keyed on `FIREWALLED_SURFACE_DIRS` rather than on a list of its own, so the leg
// ACTIVATES on firewall growth with zero edits to its logic: admitting a surface to the
// firewall without declaring what it projects fails here immediately. M5 admits the two
// dashboards; 396 replaces the pre-layer MCP server with a real registry projection.
//
// Reaching agent's declarations from arch uses the same cross-package relative import the
// manifest already uses for the ownership contracts — the arch package is source-only and
// deliberately depends on nothing, so relative traversal is its house style for reading
// another package's truth rather than a shortcut taken here.

import { describe, expect, it } from 'vitest'

import { createFunctionRegistry } from '../../../agent/src/functions/registry.js'
import type { FunctionDeps } from '../../../agent/src/functions/spec.js'
import { FIREWALLED_SURFACE_DIRS } from '../lint/surface-firewall.js'

/**
 * How a firewalled surface decides which capabilities it publishes.
 *
 * `generic-invoker` — the surface projects the registry itself and holds no per-capability
 * knowledge, so there is nothing static to compare and nothing that can drift. The CLI's
 * `fn` verb is the shipped example: it renders whatever the registry lists and detects a
 * stream result structurally.
 *
 * `static-ids` — the surface enumerates the capabilities it publishes. That list must be a
 * SUBSET of the registry's ids; anything else is a capability the layer never declared.
 *
 * `not-yet-projected` — a firewalled surface that predates the function layer. Its imports
 * are already policed by the firewall ledger, but it projects nothing from the registry,
 * so there is no id set to compare yet. Every such entry names the phase that replaces it,
 * and the golden-set assertion below keeps a NEW surface from quietly taking this door.
 */
export type SurfaceProjectionSource =
  | { kind: 'generic-invoker'; note: string }
  | { kind: 'static-ids'; ids: readonly string[] }
  | { kind: 'not-yet-projected'; projectedBy: string; note: string }

export const SURFACE_PROJECTION_SOURCES: Readonly<
  Record<string, SurfaceProjectionSource>
> = {
  'packages/cli': {
    kind: 'generic-invoker',
    note: 'The `fn` verb projects the registry directly — it lists what the registry lists and renders what the invocation returns. That is not the whole CLI, and this entry does not model the remainder: the knowledge command family holds one piece of capability-specific static knowledge, `KNOWLEDGE_BUNDLES_LIST_ID = \'knowledge.bundles.list\'` (declared at commands/knowledge-read.ts:73, invoked at :411), which can drift from the registry. 397 (FUNC-05) turns this entry into a real projection source so the subset comparison below has something to compare.',
  },
  'packages/mcp': {
    kind: 'not-yet-projected',
    projectedBy: '396',
    note: 'The v1 37-tool server predates the layer and publishes a hand-written tool set from its own modules. 396 replaces it with a registry projection and turns this entry into a real id set, at which point the subset comparison below stops being vacuous.',
  },
}

/**
 * The surfaces allowed to sit in the firewall without projecting the registry yet.
 *
 * Pinned exactly, in both directions: a new firewalled surface cannot reach for the
 * pre-layer escape hatch, and a surface that stops needing it must be moved out of it.
 */
const EXPECTED_NOT_YET_PROJECTED = ['packages/mcp']

const REGISTRY_IDS = createFunctionRegistry({
  // Listing reads declarations only — no port is touched — so the layer needs nothing real
  // in order to enumerate itself.
  deps: {} as FunctionDeps,
})
  // the tokenless caller shape. The listing is the same for every caller, so the
  // retired grant fields and the registry's retired context option are not supplied here.
  .list({
    surface: 'arch-conformance',
    origin: 'agent',
  })
  .map(declaration => declaration.id)

describe('parity leg 5 — surface reverse completeness', () => {
  it('declares a projection source for every firewalled surface, and for no other', () => {
    expect(Object.keys(SURFACE_PROJECTION_SOURCES).sort())
      .toEqual([...FIREWALLED_SURFACE_DIRS].sort())
  })

  it('reads the registry as a nonempty id set', () => {
    expect(REGISTRY_IDS.length).toBeGreaterThan(0)
    expect(new Set(REGISTRY_IDS).size).toEqual(REGISTRY_IDS.length)
  })

  it('projects only capabilities the registry declares', () => {
    const declared = new Set(REGISTRY_IDS)

    for (const dir of FIREWALLED_SURFACE_DIRS) {
      const source = SURFACE_PROJECTION_SOURCES[dir]
      expect(source, dir).toBeDefined()
      if (source === undefined || source.kind !== 'static-ids') continue

      expect(source.ids.length, dir).toBeGreaterThan(0)
      expect(source.ids.filter(id => !declared.has(id)), dir).toEqual([])
    }
  })

  it('keeps the pre-layer escape hatch pinned and dated', () => {
    const notYetProjected = Object.entries(SURFACE_PROJECTION_SOURCES)
      .filter(([, source]) => source.kind === 'not-yet-projected')
      .map(([dir]) => dir)
      .sort()

    expect(notYetProjected).toEqual([...EXPECTED_NOT_YET_PROJECTED].sort())

    for (const [dir, source] of Object.entries(SURFACE_PROJECTION_SOURCES)) {
      if (source.kind !== 'not-yet-projected') continue
      expect(source.projectedBy.trim(), dir).not.toEqual('')
      expect(source.note.trim(), dir).not.toEqual('')
    }
  })
})
