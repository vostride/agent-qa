// Keyed on `FIREWALLED_SURFACE_DIRS`, so a surface admitted without declaring its projection fails.

import { describe, expect, it } from 'vitest'

import { createFunctionRegistry } from '../../../agent/src/functions/registry.js'
import type { FunctionDeps } from '../../../agent/src/functions/spec.js'
import { FIREWALLED_SURFACE_DIRS } from '../lint/surface-firewall.js'

// `static-ids` must list a registry subset; `not-yet-projected` predates the function layer.
export type SurfaceProjectionSource =
  | { kind: 'generic-invoker'; note: string }
  | { kind: 'static-ids'; ids: readonly string[] }
  | { kind: 'not-yet-projected'; projectedBy: string; note: string }

export const SURFACE_PROJECTION_SOURCES: Readonly<
  Record<string, SurfaceProjectionSource>
> = {
  'packages/cli': {
    kind: 'generic-invoker',
    note: 'The `fn` verb projects the registry directly — it lists what the registry lists and renders what the invocation returns. That is not the whole CLI, and this entry does not model the remainder: the knowledge command family holds one piece of capability-specific static knowledge, `KNOWLEDGE_BUNDLES_LIST_ID = \'knowledge.bundles.list\'` (declared at commands/knowledge-read.ts:73, invoked at :411), which can drift from the registry. Until this entry becomes a real projection source, the subset comparison below has nothing to compare.',
  },
  'packages/mcp': {
    kind: 'not-yet-projected',
    projectedBy: 'a registry projection of the MCP tool set',
    note: 'The v1 37-tool server predates the layer and publishes a hand-written tool set from its own modules. A registry projection that replaces it turns this entry into a real id set, at which point the subset comparison below stops being vacuous.',
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

  it('keeps the pre-layer escape hatch pinned, naming what will project each surface', () => {
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
