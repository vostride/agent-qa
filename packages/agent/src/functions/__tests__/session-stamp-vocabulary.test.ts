// The stamped set must equal the derived set, so an op gaining `sessionRef` fails by name.

import {
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  SESSION_STAMPED_FUNCTION_IDS,
  WINDOW_STAMPED_FUNCTION_IDS,
} from '../../chat/turn-engine.js'
import { createFunctionRegistry } from '../registry.js'
import type { FunctionDeclaration, FunctionDeps } from '../spec.js'

/** Human origin — a listing must be the whole catalogue, not one caller's slice. */
const FULLY_GRANTED: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

// Cells read declarations, so every op is listed, including ones a real host leaves `unbound`.
function listingDeps(): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () =>
        Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
    },
  }
}

function declarations(): readonly FunctionDeclaration[] {
  return createFunctionRegistry({ deps: listingDeps() }).list(FULLY_GRANTED)
}

/**
 * The ids whose input contract carries `key` as a TOP-LEVEL property, off the live catalogue.
 *
 * Read from `declaration.input`, the inert JSON-Schema projection every listing already publishes,
 * so nothing here reaches a live validator or re-states a schema. TOP LEVEL and not a deep walk:
 * the stamp writes exactly one top-level key, and a nested `sessionRef` inside some other op's
 * payload is a field this surface neither owns nor could write without inventing a shape.
 */
function idsCarryingTopLevelKey(key: string): ReadonlySet<string> {
  const carrying = new Set<string>()
  for (const declaration of declarations()) {
    const properties = (declaration.input as { properties?: unknown }).properties
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) continue
    if (Object.hasOwn(properties as Record<string, unknown>, key)) carrying.add(declaration.id)
  }
  return carrying
}

// The walk skips these, so an op hiding `sessionRef` behind a union must be named here.
function opaqueDeclarationIds(): string[] {
  return declarations()
    .filter((declaration) => {
      const properties = (declaration.input as { properties?: unknown }).properties
      return typeof properties !== 'object' || properties === null || Array.isArray(properties)
    })
    .map((declaration) => declaration.id)
    .sort()
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort()
}

describe('the session facts the chat surface stamps are pinned to the ops that carry them', () => {
  it('is not vacuous: the catalogue lists ops and both derived sets are non-empty', () => {
    // The guard every equality below leans on. A registry that listed nothing, or a projection
    // that carried no `properties`, would satisfy both equalities perfectly and measure nothing.
    expect(declarations().length).toBeGreaterThan(0)
    expect(idsCarryingTopLevelKey('sessionRef').size).toBeGreaterThan(0)
    expect(idsCarryingTopLevelKey('window').size).toBeGreaterThan(0)
  })

  it('SET-EQUALS the sessionRef-carrying ops — a sibling cannot be silently omitted', () => {
    // THE CELL. Its failure names the ids on both sides, because "the set is wrong" is not
    // something anybody can act on, and the whole defect was that nobody could see which op was
    // missing. Removing `authoring.draft.verify` from the constant reds this by that name.
    expect(sorted(SESSION_STAMPED_FUNCTION_IDS)).toEqual(sorted(idsCarryingTopLevelKey('sessionRef')))
  })

  it('SET-EQUALS the window-carrying ops — the read side has the same completeness rule', () => {
    expect(sorted(WINDOW_STAMPED_FUNCTION_IDS)).toEqual(sorted(idsCarryingTopLevelKey('window')))
  })

  it('the derivation DISCRIMINATES: a key no op carries derives the empty set', () => {
    // The rejected half of the pair. Without it, both equalities above are satisfied by any
    // derivation that answers "every id" or by one whose projection read never finds anything —
    // and a comparison that cannot reject is the state the guard's own doc block was already in.
    expect(idsCarryingTopLevelKey('sessionReff').size).toBe(0)
    // A registered op whose input has no `sessionRef`, so the negative half is not vacuous.
    expect(declarations().map((declaration) => declaration.id), 'the negative example is no longer registered').toContain('runs.list')
    expect(idsCarryingTopLevelKey('sessionRef').has('runs.list')).toBe(false)
  })

  it('the derivation SEES the whole catalogue — an opaque input reds by id', () => {
    // The skip is silent by construction: a declaration the walk cannot read contributes to
    // neither side of the equalities above, so both stay green over an op nobody stamped. This
    // cell turns that into a decision point NAMING the offending id — at which point either the
    // op's input becomes a plain `.strict()` object like every current one, or an argued
    // exception list is introduced THEN, with the argument written down.
    expect(opaqueDeclarationIds()).toEqual([])
  })

  it('the two sets are DISJOINT — one op, one law, and the laws point opposite ways', () => {
    const overlap = [...SESSION_STAMPED_FUNCTION_IDS]
      .filter((id) => WINDOW_STAMPED_FUNCTION_IDS.has(id))
    // The ref overwrites and never defaults, the window is a default; nothing carries both.
    expect(overlap).toEqual([])
  })
})
