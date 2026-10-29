// The handle scope classification, the handle filter predicate and the handle id spelling
//
// THE TOTALITY CLAIM IS STRUCTURAL, NOT A GREP. Twice in this phase a source grep for a symbol
// name was satisfied by the IMPORT LINE and passed a mutation that gutted the expression it was
// supposed to pin (402-01's `timingSafeEqual`, 402-03's `resolveEffectiveWorkers`). So the claim
// "every event type is classified" is carried by two independent mechanisms, neither of which is
// a text scan:
//
//   1. COMPILE TIME — `RUN_EVENT_SCOPE` is declared `satisfies Record<RunEventType, RunEventScope>`,
//      so appending a member to `RUN_EVENT_TYPES` without classifying it is a type error, and a
//      key that is NOT a member is an excess-property error. `pnpm typecheck` is that half's proof;
//      a green `vitest run` is NOT (402-03 measured vitest's typecheck pass ranging only
//      `*.test-d.ts` and reporting "no errors" under a mutation `tsc --noEmit` catches).
//   2. RUNTIME — the cell below walks `RUN_EVENT_TYPES` (the frozen list) and asks the table for
//      each member. It iterates the TYPE LIST, never the table's own keys: a table that lost an
//      entry still has keys to iterate, so iterating the table would pass under exactly the
//      mutation this cell exists to catch.

import { describe, expect, it } from 'vitest'

import {
  RUN_EVENT_SCOPE,
  RUN_EVENT_TYPES,
  handleId,
  handleRosterOf,
  memberIndexOf,
  parseHandleId,
  parseHandleParam,
  passesHandleFilter,
  type RunEventEnvelope,
  type RunEventScope,
  type RunEventType,
} from '../index.js'

/** Build an envelope of a chosen type with a chosen payload. Seq/ts are irrelevant here. */
function envelopeOf(type: RunEventType, payload: Record<string, unknown>): RunEventEnvelope {
  return { seq: 1, ts: 0, runId: 'r_scope', type, payload } as unknown as RunEventEnvelope
}

describe('RUN_EVENT_SCOPE — a TOTAL, positive classification of the frozen event vocabulary', () => {
  it('classifies every RUN_EVENT_TYPES member explicitly, walking the TYPE LIST not the table', () => {
    const unclassified: string[] = []
    for (const type of RUN_EVENT_TYPES) {
      if (!Object.hasOwn(RUN_EVENT_SCOPE, type)) unclassified.push(type)
    }
    expect(unclassified).toEqual([])
    // Non-vacuity: the list this walked is the real one, not an empty array a refactor emptied.
    // 20 since 404 D-02 removed the three never-emitted `issues*` names.
    expect(RUN_EVENT_TYPES.length).toBeGreaterThanOrEqual(20)
  })

  it('classifies with a CLOSED vocabulary — no fall-through, no undefined, no stray value', () => {
    const allowed: readonly RunEventScope[] = ['run', 'member', 'member-when-addressed']
    for (const type of RUN_EVENT_TYPES) {
      expect(allowed).toContain(RUN_EVENT_SCOPE[type])
    }
  })

  it('declares NO key that is not a member of the frozen list (the table cannot outgrow it)', () => {
    const frozen = new Set<string>(RUN_EVENT_TYPES)
    expect(Object.keys(RUN_EVENT_SCOPE).filter((key) => !frozen.has(key))).toEqual([])
  })

  it('pins the classification itself, so a silent re-classification is a failing diff', () => {
    // The six post-run chip events are run-scoped BY NATURE: `ChipEventPayload` is
    // `{ runId, error?, willRetry? }` — there is no member producer and no field that could name
    // one. The lifecycle/diagnostic run-scoped set is D-14's own list plus `runStarted`.
    expect(
      RUN_EVENT_TYPES.filter((type) => RUN_EVENT_SCOPE[type] === 'run'),
    ).toEqual([
      'runStarted',
      'runFinished',
      'verdict',
      'runWarning',
      'runError',
      'heartbeat',
      'analysisStarted',
      'analysisCompleted',
      'analysisFailed',
      'curationStarted',
      'curationCompleted',
      'curationFailed',
    ])
    // Every member-scoped payload declares `testIndex: number` REQUIRED — that is the ground
    // truth this classification is derived from, not a preference.
    expect(
      RUN_EVENT_TYPES.filter((type) => RUN_EVENT_SCOPE[type] === 'member'),
    ).toEqual([
      'testStarted',
      'testFinished',
      'stepStarted',
      'stepFinalized',
      'subActionRecorded',
      'testRetryScheduled',
    ])
    // `HookStartedPayload.testIndex` is OPTIONAL (`scope?: 'suite' | 'test' | 'step'`), and the
    // producer only fills it when the hook's identity carries one — so hook scope is a property
    // of the INSTANCE, not of the type. Read at implementation time from the payload type and
    // `hooks/orchestrator.ts:buildStartedPayload`, which spreads `testIndex` conditionally.
    expect(
      RUN_EVENT_TYPES.filter((type) => RUN_EVENT_SCOPE[type] === 'member-when-addressed'),
    ).toEqual(['hookStarted', 'hookFinished'])
  })
})

describe('memberIndexOf — the one place a payload is asked which member it belongs to', () => {
  it('reads a non-negative integer testIndex off the payload', () => {
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: 0 }))).toBe(0)
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: 11 }))).toBe(11)
  })

  it('refuses a testIndex that is not a non-negative integer, and an absent one', () => {
    expect(memberIndexOf(envelopeOf('stepStarted', {}))).toBeUndefined()
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: -1 }))).toBeUndefined()
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: 1.5 }))).toBeUndefined()
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: '2' }))).toBeUndefined()
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: null }))).toBeUndefined()
    expect(memberIndexOf(envelopeOf('stepStarted', { testIndex: Number.NaN }))).toBeUndefined()
  })
})

describe('passesHandleFilter — run-scoped ALWAYS passes, member-scoped only its own', () => {
  it('passes every run-scoped envelope to every handle, whatever the handle is', () => {
    for (const type of RUN_EVENT_TYPES.filter((t) => RUN_EVENT_SCOPE[t] === 'run')) {
      for (const handle of [0, 1, 7, 4242]) {
        expect(passesHandleFilter(envelopeOf(type, {}), handle)).toBe(true)
      }
    }
  })

  it('passes a run-scoped envelope even when it happens to carry a foreign testIndex', () => {
    // The classification decides, not the payload's incidental fields — otherwise a run-scoped
    // event that grew a `testIndex` tomorrow would silently vanish from every other handle's
    // stream, and a handle subscriber would stop learning that the run ended.
    expect(passesHandleFilter(envelopeOf('verdict', { verdict: 'passed', testIndex: 9 }), 3))
      .toBe(true)
  })

  it('passes a member-scoped envelope to its OWN handle and to no other', () => {
    const envelope = envelopeOf('stepStarted', { testIndex: 3, stepIndex: 0, stepText: 'x' })
    expect(passesHandleFilter(envelope, 3)).toBe(true)
    for (const other of [0, 1, 2, 4, 30]) {
      expect(passesHandleFilter(envelope, other)).toBe(false)
    }
  })

  it('does not match on POSITION — handle 0 sees nothing of a member whose testIndex is 7', () => {
    // A filter keyed on array position rather than the stamped testIndex is indistinguishable
    // from a correct one when the indices are 0,1,2. These are not.
    for (const testIndex of [3, 7, 11]) {
      expect(passesHandleFilter(envelopeOf('testStarted', { testIndex }), 0)).toBe(false)
      expect(passesHandleFilter(envelopeOf('testStarted', { testIndex }), testIndex)).toBe(true)
    }
  })

  it('is not off by one', () => {
    const envelope = envelopeOf('testFinished', { testIndex: 7 })
    expect(passesHandleFilter(envelope, 6)).toBe(false)
    expect(passesHandleFilter(envelope, 8)).toBe(false)
    expect(passesHandleFilter(envelope, 7)).toBe(true)
  })

  it('treats a hook that names no member as run-scoped, and one that does as that member\'s', () => {
    const suiteHook = envelopeOf('hookStarted', {
      hookName: 'suite-setup', phase: 'setup', hookExecutionId: 'h1', scope: 'suite',
    })
    expect(passesHandleFilter(suiteHook, 0)).toBe(true)
    expect(passesHandleFilter(suiteHook, 7)).toBe(true)

    const memberHook = envelopeOf('hookFinished', {
      hookName: 'before-each', phase: 'setup', hookExecutionId: 'h2', scope: 'test', testIndex: 7,
      status: 'passed', durationMs: 1, stdout: '', stderr: '', variables: {},
    })
    expect(passesHandleFilter(memberHook, 7)).toBe(true)
    expect(passesHandleFilter(memberHook, 0)).toBe(false)
  })

  it('FAILS CLOSED: a member-scoped envelope with no usable testIndex reaches no handle', () => {
    // A member-scoped event that lost its identity is a defect. Serving it to every handle would
    // turn that defect into cross-handle disclosure, so it reaches none of them and
    // the firehose (no handle) is where it stays visible.
    expect(passesHandleFilter(envelopeOf('stepStarted', {}), 0)).toBe(false)
    expect(passesHandleFilter(envelopeOf('stepStarted', {}), 7)).toBe(false)
  })
})

describe('parseHandleParam — a CLOSED three-arm parse, no permissive arm', () => {
  it('reports an absent parameter as absent, never as handle 0', () => {
    expect(parseHandleParam(undefined)).toEqual({ kind: 'absent' })
    expect(parseHandleParam(null)).toEqual({ kind: 'absent' })
  })

  it('accepts a canonical non-negative integer', () => {
    expect(parseHandleParam('0')).toEqual({ kind: 'handle', index: 0 })
    expect(parseHandleParam('7')).toEqual({ kind: 'handle', index: 7 })
    expect(parseHandleParam('42')).toEqual({ kind: 'handle', index: 42 })
  })

  it('refuses everything else, including the shapes Number() would happily coerce', () => {
    for (const raw of [
      '', ' ', '  7 ', 'notanumber', '-1', '-0', '1.5', '+1', '01', '1e2', '0x1',
      'Infinity', 'NaN', '9007199254740993', '7abc', 'null', 'true',
    ]) {
      expect(parseHandleParam(raw), `expected ${JSON.stringify(raw)} refused`)
        .toEqual({ kind: 'invalid' })
    }
  })
})

describe('handleId — the composite string spelling for surfaces that need one id', () => {
  it('spells a handle as runId#testIndex and parses back', () => {
    expect(handleId('r_abc', 7)).toBe('r_abc#7')
    expect(parseHandleId('r_abc#7')).toEqual({ runId: 'r_abc', testIndex: 7 })
  })

  it('splits on the LAST separator, so a run id containing one still round-trips', () => {
    expect(parseHandleId(handleId('r_a#b', 3))).toEqual({ runId: 'r_a#b', testIndex: 3 })
  })

  it('refuses a malformed composite rather than guessing', () => {
    expect(parseHandleId('r_abc')).toBeUndefined()
    expect(parseHandleId('r_abc#')).toBeUndefined()
    expect(parseHandleId('r_abc#-1')).toBeUndefined()
    expect(parseHandleId('#7')).toBeUndefined()
    expect(parseHandleId('r_abc#x')).toBeUndefined()
  })
})

describe('handleRosterOf — the roster rides runStarted as an ADDITIVE payload field', () => {
  it('reads the announced handles off a runStarted envelope', () => {
    expect(handleRosterOf(envelopeOf('runStarted', { memberTestCount: 3, handles: [3, 7, 11] })))
      .toEqual([3, 7, 11])
  })

  it('answers undefined for a runStarted that announces none, and for any other type', () => {
    expect(handleRosterOf(envelopeOf('runStarted', { memberTestCount: 3 }))).toBeUndefined()
    expect(handleRosterOf(envelopeOf('testStarted', { testIndex: 0, handles: [0] })))
      .toBeUndefined()
  })

  it('refuses a roster that is not an array of non-negative integers', () => {
    expect(handleRosterOf(envelopeOf('runStarted', { handles: 'x' }))).toBeUndefined()
    expect(handleRosterOf(envelopeOf('runStarted', { handles: [0, '1'] }))).toBeUndefined()
    expect(handleRosterOf(envelopeOf('runStarted', { handles: [0, -1] }))).toBeUndefined()
  })
})
