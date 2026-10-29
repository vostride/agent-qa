// The stamped vocabulary pin: every op carrying a session fact is an op the surface stamps
// (Phase 394, gap round 2, plan 19 — CR-02 · T-394-74 · T-394-75).
//
// WHY THIS FILE EXISTS. `stampSessionRef` guarded ONE function id by equality, and the claim that
// the id was the only op carrying `sessionRef` was a comment. It was false the day
// `authoring.draft.verify` gained the field: that op is `mutating-local`, planner-reachable like
// every registered op (392 D-07), and spreads a caller-supplied `sessionRef` straight onto the
// receipt it persists. So a model could write another author's session id into a verify call and
// have it land on a durable receipt — the exact attribution forgery the write op's stamp exists to
// prevent, one function id over. The guard is now a SET, and this file makes "the set is complete"
// a check rather than a sentence.
//
// THE COMPARISON IS PRODUCED ON ONE SIDE AND PINNED ON THE OTHER, which is the shape
// `caller-scopes.test.ts` uses (and the deleted proposals-accept action-class suite used, until
// 432-17; re-spelled 2026-10-02, 432-42). The derived side is read off
// the LIVE registry — every declaration's inert input projection, asked whether it carries the key
// at the TOP LEVEL — and never off a hand-written list of the ids anyone believes carry it. The
// pinned side is the constant the turn engine actually consults. Equality between them is the rule
// made mechanical: a future sibling op gaining `sessionRef` reds this by the omitted NAME, rather
// than shipping an unguarded forgery path that every existing cell stays green over.
//
// TWO KEYS, TWO SETS, and they are separate because the two laws are. `sessionRef` is an
// OVERWRITE-NEVER-A-DEFAULT on the write side (absence is exclusion on a receipt); `window` is
// D-12's ratified SURFACE default on the read side, constructed by the surface that knows its
// session. A single merged set would have made the two stamps one rule and lost the distinction
// the receipt's own contract turns on.

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

// 2026-10-01 (432-35, D-12): no `grantedScopes` or `safeMode` on the caller. Every caller lists the
// whole catalogue since 432-20, so the name's "granted" no longer narrows anything.
/** Human origin — a listing must be the whole catalogue, not one caller's slice. */
const FULLY_GRANTED: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/**
 * The four REQUIRED ports, answering emptily (the fixture shape the deleted proposals-accept
 * action-class suite used; re-spelled 2026-10-02, 432-42).
 *
 * Nothing here dispatches: the cells read DECLARATIONS. What matters is that every registered op
 * is LISTED, including the ones a real host leaves `unbound`, because an input contract is a fact
 * about the catalogue rather than about one composition's bindings.
 */
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

/**
 * The ids the derivation above cannot see — an input projection with no top-level `properties`.
 *
 * The walk `continue`s over such a declaration, so it contributes to NEITHER side of the
 * equalities below and an op carrying `sessionRef` behind a union, a `$ref` or a record shape
 * would leave every cell here green while going unstamped (394-22, WR-05). Naming those ids makes
 * the skip a decision someone takes rather than one the walk takes silently.
 */
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
    // 2026-10-02 (432-42): re-pointed from `proposals.list`, deleted by 432-17, at a REGISTERED op
    // whose input carries no `sessionRef`, so the negative half discriminates over the live catalogue.
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
    // An op carrying both would need a decision this plan has not made: the ref is an overwrite
    // that never defaults, the window is a default that only overwrites its session arm. Today
    // nothing carries both, and that is stated rather than assumed.
    expect(overlap).toEqual([])
  })
})
