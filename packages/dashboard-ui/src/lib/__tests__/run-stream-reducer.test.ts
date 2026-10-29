// Cells feed payloads carrying every planner field, because a spread puts them back in rows.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  RunEventEnvelope,
  RunEventPayload,
  RunEventType,
} from '@vostride/agent-qa-schema'

import * as reducer from '@/lib/run-stream-reducer'
import {
  STEP_STATUSES,
  createInitialRunStreamState,
  markGap,
  reduceRunStream,
  stepStatusOf,
  type RunStreamState,
} from '@/lib/run-stream-reducer'

/**
 * The one string every "no reasoning content reaches the state" cell hunts for. It is fed on FIVE
 * distinct payload fields across four event types and asserted absent from the serialised state —
 * so a `{ ...payload }` regression anywhere in the reducer reds this, not just one in the arm the
 * cell happens to name.
 */
const SENTINEL = 'SENTINEL-REASONING-7f3a'

const RUN_ID = 'run_live'

let nextSeq = 1

function envelope(type: RunEventType, payload: unknown, seq?: number, ts?: number): RunEventEnvelope {
  const resolved = seq ?? nextSeq++
  if (seq !== undefined && seq >= nextSeq) nextSeq = seq + 1
  return { seq: resolved, ts: ts ?? resolved * 1000, runId: RUN_ID, type, payload: payload as RunEventPayload }
}

/** Fold a list of envelopes at one frozen `now`. */
function fold(envelopes: readonly RunEventEnvelope[], now = 10_000): RunStreamState {
  nextSeq = 1
  let state = createInitialRunStreamState()
  for (const one of envelopes) state = reduceRunStream(state, one, now)
  return state
}

const stepStarted = (testIndex: number, stepIndex: number, stepText = 'a step', seq?: number, ts?: number) =>
  envelope('stepStarted', { testIndex, stepIndex, stepText }, seq, ts)

const stepFinalized = (
  testIndex: number,
  stepIndex: number,
  extra: Record<string, unknown> = {},
  seq?: number,
) =>
  envelope('stepFinalized', {
    testIndex,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: SENTINEL },
    selfHealOccurred: false,
    briefDigest: 'd',
    ...extra,
  }, seq)

/**
 * A `subActionRecorded` payload carrying ALL FIVE forbidden fields with sentinel values — the
 * shape a real producer emits, not a trimmed one. A reducer that spreads the payload keeps every
 * one of them.
 */
const subAction = (testIndex: number, stepIndex: number, subActionIndex = 0, seq?: number) =>
  envelope('subActionRecorded', {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: SENTINEL,
    plannedAction: { kind: 'click', target: { descriptor: SENTINEL } },
    grounding: { candidates: [{ reasoning: SENTINEL }] },
    result: { status: 'success', detail: SENTINEL },
    screenStateHash: 'h1',
  }, seq)

const rowsOf = (state: RunStreamState, testIndex: number) =>
  state.steps.filter((row) => row.testIndex === testIndex)

const rowAt = (state: RunStreamState, testIndex: number, stepIndex: number) =>
  state.steps.find((row) => row.testIndex === testIndex && row.stepIndex === stepIndex)

const runningRows = (state: RunStreamState) => state.steps.filter((row) => row.status === 'running')

// The status vocabulary

describe('the step status vocabulary is exactly seven words, and stepStatusOf resolves it', () => {
  it('declares the seven statuses the page can render, and no eighth', () => {
    expect([...STEP_STATUSES]).toEqual([
      'pending',
      'running',
      'passed',
      'failed',
      'healed',
      'skipped',
      'cancelled',
    ])
  })

  it.each([
    ['passed'],
    ['failed'],
    ['healed'],
    ['skipped'],
    ['cancelled'],
  ] as const)('takes the producer\'s own `status` verbatim when present: %s', (status) => {
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: false, reasoning: '' },
      selfHealOccurred: true,
      briefDigest: 'd',
      status,
    })).toBe(status)
  })

  it('falls back to `healed` when `status` is absent and the step self-healed — BEFORE reading the verdict', () => {
    // A healed step's verdict passes, so reading it first would render every heal as a pass.
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: true, reasoning: '' },
      selfHealOccurred: true,
      briefDigest: 'd',
    })).toBe('healed')
  })

  it('falls back to the verifier verdict when `status` is absent and nothing healed', () => {
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: true, reasoning: '' },
      selfHealOccurred: false,
      briefDigest: 'd',
    })).toBe('passed')
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: false, reasoning: '' },
      selfHealOccurred: false,
      briefDigest: 'd',
    })).toBe('failed')
  })

  it('answers `failed` for a payload with neither `status` nor a verdict object — an absent verdict is not a pass', () => {
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      selfHealOccurred: false,
      briefDigest: 'd',
    } as unknown as Parameters<typeof stepStatusOf>[0])).toBe('failed')
  })

  it('REFUSES a `status` word outside the vocabulary and falls through — the envelope crosses a trust boundary', () => {
    // The payload arrives as JSON from another process. Its `status` is typed, which says nothing
    // about what a build one version ahead (or a tampered proxy) actually sends.
    expect(stepStatusOf({
      testIndex: 0,
      stepIndex: 0,
      cacheStatus: 'miss',
      verifierVerdict: { pass: false, reasoning: '' },
      selfHealOccurred: false,
      briefDigest: 'd',
      status: 'quarantined',
    } as unknown as Parameters<typeof stepStatusOf>[0])).toBe('failed')
  })

  it('maps stepStarted to `running` and stepFinalized to the resolved status, through the reducer', () => {
    const state = fold([
      stepStarted(0, 0, 'click login'),
      stepFinalized(0, 0, { status: 'healed' }),
      stepStarted(0, 1, 'assert dashboard'),
    ])
    expect(rowAt(state, 0, 0)?.status).toBe('healed')
    expect(rowAt(state, 0, 0)?.text).toBe('click login')
    expect(rowAt(state, 0, 1)?.status).toBe('running')
  })

  it('creates a row directly in its final status when stepFinalized arrives with no prior stepStarted', () => {
    // A resumed stream can land between a step's start and its finalize.
    const state = fold([stepFinalized(3, 2, { status: 'failed' })])
    expect(rowAt(state, 3, 2)).toMatchObject({ status: 'failed', ticks: 0 })
    expect(rowAt(state, 3, 2)?.startedAt).toBeUndefined()
  })
})

// Motion and a plain count, and nothing else

describe('each sub-action is one tick, and no reasoning content survives ingest', () => {
  it('bumps the running row\'s ticks by exactly one per subActionRecorded', () => {
    const state = fold([
      stepStarted(0, 0),
      subAction(0, 0, 0),
      subAction(0, 0, 1),
      subAction(0, 0, 2),
    ])
    expect(rowAt(state, 0, 0)?.ticks).toBe(3)
  })

  it('records the tick\'s own timestamp, so the page can restart its motion', () => {
    // ABSOLUTE, not relative to another field of the same row: a cell phrased as
    // `lastTickAt === (ticks === 1 ? X : undefined)` passes for a reducer that sets neither.
    const state = fold([stepStarted(0, 0, 's', 1, 1_000), subAction(0, 0, 0, 2)])
    expect(rowAt(state, 0, 0)).toMatchObject({ startedAt: 1_000, lastTickAt: 2_000, ticks: 1 })
  })

  it('ticks the ADDRESSED row only — a sub-action for member 1 never bumps member 0', () => {
    const state = fold([
      stepStarted(0, 0),
      stepStarted(1, 0),
      subAction(1, 0, 0),
      subAction(1, 0, 1),
    ])
    expect(rowAt(state, 0, 0)?.ticks).toBe(0)
    expect(rowAt(state, 1, 0)?.ticks).toBe(2)
  })

  it('keeps the tick count across finalize — the count is the step\'s history, not its animation', () => {
    const state = fold([stepStarted(0, 0), subAction(0, 0, 0), subAction(0, 0, 1), stepFinalized(0, 0, { status: 'passed' })])
    expect(rowAt(state, 0, 0)).toMatchObject({ status: 'passed', ticks: 2 })
  })

  it('THE SENTINEL CELL: five forbidden fields fed on four event types, absent from the state at every depth', () => {
    // A type-level omission is not a measurement. This feeds `plan`, `plannedAction`, `grounding`,
    // `result` and `reasoning` (plus `error` and `failureSummary`) with the same sentinel and then
    // asks the RUNTIME object, serialised whole, whether any of it survived.
    const state = fold([
      envelope('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] }),
      envelope('testStarted', { testId: 't0', testIndex: 0, name: 'a member', totalSteps: 2 }),
      stepStarted(0, 0, 'click login'),
      subAction(0, 0, 0),
      subAction(0, 0, 1),
      stepFinalized(0, 0, { status: 'failed', error: SENTINEL, durationMs: 12 }),
      envelope('hookFinished', {
        hookName: 'h',
        phase: 'setup',
        hookExecutionId: 'he',
        status: 'passed',
        durationMs: 1,
        stdout: SENTINEL,
        stderr: SENTINEL,
        variables: { secret: SENTINEL },
      }),
      envelope('testFinished', { testId: 't0', testIndex: 0, outcome: 'failed', failureSummary: SENTINEL }),
    ])

    const serialised = JSON.stringify(state)
    expect(serialised).not.toContain(SENTINEL)
    // And the shapes that CARRY those fields are gone as names too, not merely as values.
    for (const forbidden of ['plannedAction', 'grounding', 'reasoning', 'failureSummary', 'stdout']) {
      expect(serialised).not.toContain(forbidden)
    }
    // Non-vacuity: the fold really did ingest the sentinel-bearing envelopes and build state.
    expect(rowAt(state, 0, 0)).toMatchObject({ status: 'failed', ticks: 2, text: 'click login' })
  })

  it('NON-VACUITY CONTROL: the same sentinel IS visible in the serialised envelopes the fold consumed', () => {
    // Without this, the cell above passes for a reducer that ingested nothing at all — or for a
    // fixture that never carried the sentinel in the first place.
    expect(JSON.stringify(subAction(0, 0, 0))).toContain(SENTINEL)
    expect(JSON.stringify(stepFinalized(0, 0))).toContain(SENTINEL)
    // The literal is pinned because the page and DOM cells assert the same absence on the surface.
    expect(SENTINEL).toBe('SENTINEL-REASONING-7f3a')
  })

  it('carries no invented phase — a row exposes status, text, ticks and times, and nothing that names a phase', () => {
    const state = fold([stepStarted(0, 0), subAction(0, 0, 0)])
    const keys = Object.keys(rowAt(state, 0, 0) as object).sort()
    expect(keys).toEqual([
      'createdSeq',
      'lastTickAt',
      'startedAt',
      'status',
      'stepIndex',
      'testIndex',
      'text',
      'ticks',
    ])
  })
})

// Ordering and adjacency

describe('order is the bus\'s seq, never arrival and never a timestamp tie', () => {
  it('orders two equal-`ts` step events by seq even when the LATER seq arrives first', () => {
    nextSeq = 1
    let state = createInitialRunStreamState()
    state = reduceRunStream(state, stepStarted(0, 0, 'five', 5, 4_242), 10_000)
    state = reduceRunStream(state, stepStarted(1, 0, 'four', 4, 4_242), 10_000)
    expect(state.steps.map((row) => row.createdSeq)).toEqual([4, 5])
    expect(state.steps.map((row) => row.text)).toEqual(['four', 'five'])
  })

  it('keeps lastSeq at the HIGHEST seq observed — a resume point that walks backward re-opens a gap', () => {
    nextSeq = 1
    let state = createInitialRunStreamState()
    state = reduceRunStream(state, stepStarted(0, 0, 'five', 5, 4_242), 10_000)
    state = reduceRunStream(state, stepStarted(1, 0, 'four', 4, 4_242), 10_000)
    expect(state.lastSeq).toBe(5)
  })

  it('ADJACENCY: a finalize for step k and a start for step k+1 leave exactly ONE running row', () => {
    nextSeq = 1
    let state = createInitialRunStreamState()
    state = reduceRunStream(state, stepStarted(0, 0, 'k'), 10_000)
    expect(runningRows(state)).toHaveLength(1)

    state = reduceRunStream(state, stepFinalized(0, 0, { status: 'passed' }), 10_000)
    expect(runningRows(state)).toHaveLength(0)

    state = reduceRunStream(state, stepStarted(0, 1, 'k+1'), 10_000)
    expect(runningRows(state)).toHaveLength(1)
    expect(runningRows(state)[0]?.stepIndex).toBe(1)

    state = reduceRunStream(state, stepFinalized(0, 1, { status: 'passed' }), 10_000)
    state = reduceRunStream(state, stepStarted(0, 2, 'k+2'), 10_000)
    expect(runningRows(state).map((row) => row.stepIndex)).toEqual([2])
  })

  it('never shows two running rows for one member even across an interleaved second member', () => {
    const state = fold([
      stepStarted(0, 0),
      stepStarted(1, 0),
      stepFinalized(0, 0, { status: 'passed' }),
      stepStarted(0, 1),
    ])
    expect(runningRows(state).map((row) => [row.testIndex, row.stepIndex])).toEqual([[1, 0], [0, 1]])
    expect(rowsOf(state, 0).filter((row) => row.status === 'running')).toHaveLength(1)
  })
})

// Members, the thin stream, retries and terminality

describe('members, the thin handle stream and the terminal freeze', () => {
  it('pre-populates pending rows with empty text when testStarted declares totalSteps', () => {
    const state = fold([envelope('testStarted', { testId: 't', testIndex: 0, name: 'm', totalSteps: 3 })])
    expect(rowsOf(state, 0).map((row) => [row.stepIndex, row.status, row.text]))
      .toEqual([[0, 'pending', ''], [1, 'pending', ''], [2, 'pending', '']])
  })

  it('fills a pre-populated row in place rather than appending a duplicate', () => {
    const state = fold([
      envelope('testStarted', { testId: 't', testIndex: 0, name: 'm', totalSteps: 2 }),
      stepStarted(0, 1, 'the second step'),
    ])
    expect(rowsOf(state, 0)).toHaveLength(2)
    expect(rowAt(state, 0, 1)).toMatchObject({ status: 'running', text: 'the second step' })
  })

  it('records the run\'s handle roster from runStarted', () => {
    const state = fold([envelope('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 2, handles: [0, 1] })])
    expect(state.handles).toEqual([0, 1])
  })

  it('leaves handles undefined for a run that announced none — an absent roster is not an empty one', () => {
    const state = fold([envelope('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 2 }, 3)], 4_000)
    expect(state.handles).toBeUndefined()
    // The absence is only a measurement if the envelope was INGESTED. Without this half the cell
    // passes for a reducer that does nothing at all.
    expect(state).toMatchObject({ lastSeq: 3, lastEnvelopeAt: 4_000 })
  })

  it('THE THIN STREAM: a testFinished with no stepStarted ever seen is noted `did not run`', () => {
    // A member stream can begin with a terminal event.
    const state = fold([
      envelope('testStarted', { testId: 't1', testIndex: 1, name: 'member one', totalSteps: 2 }),
      envelope('testFinished', { testId: 't1', testIndex: 1, outcome: 'skipped' }),
    ])
    expect(state.members[1]).toMatchObject({ outcome: 'skipped', note: 'did not run' })
    expect(rowsOf(state, 1).map((row) => row.status)).toEqual(['skipped', 'skipped'])
  })

  it('creates the member from testFinished alone — a handle stream can start at the end', () => {
    const state = fold([envelope('testFinished', { testId: 't1', testIndex: 1, outcome: 'passed' })])
    expect(state.members[1]).toMatchObject({ testIndex: 1, outcome: 'passed', note: 'did not run' })
  })

  it('does NOT note `did not run` for a member that produced a step', () => {
    const state = fold([
      envelope('testStarted', { testId: 't0', testIndex: 0, name: 'm', totalSteps: 1 }),
      stepStarted(0, 0),
      stepFinalized(0, 0, { status: 'passed' }),
      envelope('testFinished', { testId: 't0', testIndex: 0, outcome: 'passed' }),
    ])
    expect(state.members[0]?.note).toBeUndefined()
    expect(rowAt(state, 0, 0)?.status).toBe('passed')
  })

  it('resets a member\'s rows to pending with zero ticks on testRetryScheduled', () => {
    const state = fold([
      envelope('testStarted', { testId: 't0', testIndex: 0, name: 'm', totalSteps: 2 }),
      stepStarted(0, 0),
      subAction(0, 0, 0),
      stepFinalized(0, 0, { status: 'failed' }),
      envelope('testRetryScheduled', { testId: 't0', testIndex: 0, attempt: 2, maxAttempts: 3 }),
    ])
    expect(rowsOf(state, 0).map((row) => [row.status, row.ticks])).toEqual([['pending', 0], ['pending', 0]])
  })

  it('leaves OTHER members untouched by a retry', () => {
    const state = fold([
      stepStarted(0, 0),
      stepFinalized(0, 0, { status: 'passed' }),
      stepStarted(1, 0),
      envelope('testRetryScheduled', { testId: 't1', testIndex: 1, attempt: 2, maxAttempts: 3 }),
    ])
    expect(rowAt(state, 0, 0)?.status).toBe('passed')
    expect(rowAt(state, 1, 0)?.status).toBe('pending')
  })

  it('re-runs a retried member to `running` on the duplicate stepStarted, with ticks back at zero', () => {
    const state = fold([
      stepStarted(0, 0),
      subAction(0, 0, 0),
      subAction(0, 0, 1),
      envelope('testRetryScheduled', { testId: 't0', testIndex: 0, attempt: 2, maxAttempts: 3 }),
      stepStarted(0, 0, 'second attempt'),
    ])
    expect(rowAt(state, 0, 0)).toMatchObject({ status: 'running', ticks: 0, text: 'second attempt' })
    expect(rowsOf(state, 0)).toHaveLength(1)
  })

  it('freezes the verdict: the FIRST verdict wins and a second never overwrites it', () => {
    const state = fold([
      envelope('verdict', { verdict: 'failed' }),
      envelope('verdict', { verdict: 'passed' }),
    ])
    expect(state.verdict).toBe('failed')
    expect(state.terminal).toBe(false)
  })

  it('runFinished marks the state terminal', () => {
    const state = fold([envelope('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 1 })])
    expect(state.terminal).toBe(true)
  })

  it('THE FREEZE: no envelope after runFinished reopens a row', () => {
    const state = fold([
      stepStarted(0, 0),
      stepFinalized(0, 0, { status: 'passed' }),
      envelope('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 3 }),
      stepStarted(0, 0, 'a late start'),
      stepStarted(0, 1, 'a later step'),
      subAction(0, 0, 9),
    ])
    expect(rowAt(state, 0, 0)).toMatchObject({ status: 'passed', ticks: 0, text: 'a step' })
    expect(rowAt(state, 0, 1)).toBeUndefined()
    expect(runningRows(state)).toHaveLength(0)
  })

  it('still advances lastSeq and lastEnvelopeAt after terminal — a frozen page is not a deaf one', () => {
    // Post-processing chip envelopes continue the run's seq after `runFinished`; a state that
    // stopped counting them would report a stale resume point to any client that reattached.
    const before = fold([
      envelope('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 1 }),
    ], 5_000)
    const after = reduceRunStream(before, envelope('analysisStarted', { runId: RUN_ID }, 9), 7_500)
    expect(after.lastSeq).toBe(9)
    expect(after.lastEnvelopeAt).toBe(7_500)
  })

  it('collects runWarning and runError as notices carrying the code and message ONLY', () => {
    const state = fold([
      envelope('runWarning', { code: 'w1', message: 'a warning', context: { secret: SENTINEL } }),
      envelope('runError', { code: 'e1', message: 'an error', context: { secret: SENTINEL } }),
    ])
    expect(state.notices).toEqual([
      { code: 'w1', message: 'a warning' },
      { code: 'e1', message: 'an error' },
    ])
    expect(JSON.stringify(state)).not.toContain(SENTINEL)
  })

  it('is PURE: the input state object is never mutated', () => {
    const initial = createInitialRunStreamState()
    const snapshot = JSON.stringify(initial)
    const next = reduceRunStream(initial, stepStarted(0, 0), 1_000)
    expect(JSON.stringify(initial)).toBe(snapshot)
    expect(next).not.toBe(initial)
  })

  it('advances lastEnvelopeAt and lastSeq for an event type this build does not model', () => {
    const state = fold([envelope('curationCompleted', { runId: RUN_ID }, 4)], 6_000)
    expect(state).toMatchObject({ lastSeq: 4, lastEnvelopeAt: 6_000, terminal: false })
    expect(state.steps).toEqual([])
  })
})

// A pending row carries the text `testStarted` sent

describe('pending rows are seeded from testStarted.stepTexts', () => {
  // The producer masks each entry, so a declared value arrives as its `[secret:<name>]` already.
  const started = (extra: Record<string, unknown>) =>
    envelope('testStarted', { testId: 't', testIndex: 0, name: 'm', ...extra })

  it('PENDING-TEXT-FROM-STEP-TEXTS: the seeded rows read the texts, stepStarted replaces one, a bare finalize keeps one', () => {
    const seeded = fold([started({ totalSteps: 3, stepTexts: ['a', 'b', 'c'] })])
    expect(rowsOf(seeded, 0).map((row) => [row.stepIndex, row.status, row.text]))
      .toEqual([[0, 'pending', 'a'], [1, 'pending', 'b'], [2, 'pending', 'c']])
    // Built field by field: the payload's list is not a key on any row.
    expect(Object.keys(rowAt(seeded, 0, 0) as object).sort())
      .toEqual(['createdSeq', 'status', 'stepIndex', 'testIndex', 'text', 'ticks'])

    const later = fold([
      started({ totalSteps: 3, stepTexts: ['a', 'b', 'c'] }),
      stepStarted(0, 1, 'b2'),
      stepFinalized(0, 2, { status: 'passed' }),
    ])
    expect(rowAt(later, 0, 1)).toMatchObject({ status: 'running', text: 'b2' })
    expect(rowAt(later, 0, 2)).toMatchObject({ status: 'passed', text: 'c' })
  })

  it('OLD-PRODUCER-PENDING-TEXT-EMPTY: a testStarted with no stepTexts seeds pending rows with empty text', () => {
    const state = fold([started({ totalSteps: 2 })])
    expect(rowsOf(state, 0).map((row) => [row.status, row.text])).toEqual([['pending', ''], ['pending', '']])
  })

  it('STEP-TEXTS-ONLY-STRINGS: only string entries are read, the count stays totalSteps\'s, and a non-array is ignored', () => {
    // The payload crossed a trust boundary as JSON. A string is indexable too, so `'xy'[0]` would
    // read as a step text unless the fold checks for an array first.
    const mixed = fold([started({ totalSteps: 2, stepTexts: [1, 'b'] })])
    expect(rowsOf(mixed, 0).map((row) => row.text)).toEqual(['', 'b'])

    const longer = fold([started({ totalSteps: 2, stepTexts: ['x', 'y', 'z'] })])
    expect(rowsOf(longer, 0).map((row) => row.text)).toEqual(['x', 'y'])

    for (const notAnArray of ['xy', { 0: 'x', 1: 'y' }, null, 7]) {
      const state = fold([started({ totalSteps: 2, stepTexts: notAnArray })])
      expect(rowsOf(state, 0).map((row) => row.text), JSON.stringify(notAnArray)).toEqual(['', ''])
    }
  })
})

// The reducer publishes no liveness verdict

describe('the module publishes no bus liveness, and an absent export is the proof', () => {
  // Each cell states one absence, read off the module namespace or its source.
  const exportNames = (): string[] => Object.keys(reducer).sort()
  const source = (): string => readFileSync(resolve(process.cwd(), 'src/lib/run-stream-reducer.ts'), 'utf8')

  it('the module exports no LIVENESS_STALE_MS — the page keeps no stale window over the bus', () => {
    expect(exportNames()).not.toContain('LIVENESS_STALE_MS')
  })

  it('the module exports no livenessOf', () => {
    expect(exportNames()).not.toContain('livenessOf')
  })

  it('THE EXPORT CENSUS: the runtime exports are exactly the fold, its helpers and its vocabulary', () => {
    expect(exportNames()).toEqual([
      'DID_NOT_RUN_NOTE',
      'STEP_STATUSES',
      'createInitialRunStreamState',
      'markGap',
      'reduceRunStream',
      'stepStatusOf',
    ])
    expect(exportNames().filter((name) => /liveness/iu.test(name)), 'no export names liveness, in any casing')
      .toEqual([])
  })

  it('a heartbeat is still folded as activity, and the state it produces names no liveness verdict', () => {
    let state = createInitialRunStreamState()
    for (const tick of [0, 10_000, 20_000]) {
      state = reduceRunStream(state, envelope('heartbeat', {}), tick)
    }
    expect(state).toMatchObject({ lastEnvelopeAt: 20_000, terminal: false })
    expect(Object.keys(state).filter((key) => /liveness/iu.test(key))).toEqual([])
  })

  it('the source declares no Liveness, LivenessKind or LivenessSource type', () => {
    expect(source()).not.toMatch(/\b(?:interface|type)\s+Liveness\w*/u)
  })

  it('the reducer reads no transport: the source never names an EventSource readyState', () => {
    expect(source()).not.toMatch(/readyState/u)
  })

  it('no exported function takes a transport: the function exports and their arities are the fold\'s own', () => {
    const functions = Object.fromEntries(
      Object.entries(reducer as Record<string, unknown>)
        .filter((entry): entry is [string, (...args: never[]) => unknown] => typeof entry[1] === 'function')
        .map(([name, fn]) => [name, fn.length]),
    )
    expect(functions).toEqual({
      createInitialRunStreamState: 0,
      markGap: 3,
      reduceRunStream: 3,
      stepStatusOf: 1,
    })
  })

  it('a long silence changes nothing the state holds — no clock-derived field exists to go stale', () => {
    const state = reduceRunStream(createInitialRunStreamState(), envelope('heartbeat', {}, 2), 0)
    expect(Object.keys(state).sort()).toEqual([
      'gap',
      'handles',
      'lastEnvelopeAt',
      'lastSeq',
      'members',
      'notices',
      'steps',
      'terminal',
      'verdict',
    ])
  })

  it('the source spells no stale window: no 20_000 and no twice-the-heartbeat constant', () => {
    expect(source()).not.toMatch(/20_000|STALE_MS/u)
  })

  it('the reducer source never mentions livenessOf', () => {
    expect(source()).not.toContain('livenessOf')
  })
})

// The gap marker

describe('markGap records what a replay floor cost the viewer', () => {
  it('spans the envelopes between what was seen and the floor the door advertised', () => {
    // The door answers `earliestAvailableSeq: 40`; the client re-attaches with lastEventId 39.
    // Everything from 21 through 39 is gone, and the page says so.
    const state = markGap(createInitialRunStreamState(), 20, 40)
    expect(state.gap).toEqual({ from: 21, to: 39 })
  })

  it('records NO gap when the floor is the very next envelope — nothing was missed', () => {
    // The negative and its neighbouring positive in ONE cell: a `gap === undefined` assertion
    // alone passes for a `markGap` that never records anything.
    expect(markGap(createInitialRunStreamState(), 20, 21).gap).toBeUndefined()
    expect(markGap(createInitialRunStreamState(), 20, 22).gap).toEqual({ from: 21, to: 21 })
  })

  it('is pure and leaves an already-recorded gap in place — the gap happened', () => {
    const first = markGap(createInitialRunStreamState(), 20, 40)
    const second = markGap(first, 100, 101)
    expect(second.gap).toEqual({ from: 21, to: 39 })
    expect(first.gap).toEqual({ from: 21, to: 39 })
  })
})

describe('the retrieval rung is a RUN-CONSTANT, folded from the first frame that carries it', () => {
  const FLOOR = { schemaVersion: 2, rung: 'static-floor', reason: 'native-runtime-unavailable' } as const
  const LEXICAL = { schemaVersion: 2, rung: 'lexical-only', reason: 'floor-disabled' } as const

  it('takes the rung off the first `stepFinalized` payload that carries one', () => {
    const state = fold([stepStarted(0, 0), stepFinalized(0, 0, { status: 'passed', retrievalRung: FLOOR })])
    expect(state.retrievalRung).toEqual(FLOOR)
  })

  it('FIRST FRAME WINS — a later frame never overwrites what the run already said', () => {
    // The rung describes the HOST'S LADDER for this run, not this step's ranking. A header that
    // re-pointed on every frame would flicker between two accounts of one machine mid-run, and the
    // durable half (run-detail) would then disagree with whatever the live half stopped on.
    const state = fold([
      stepFinalized(0, 0, { status: 'passed', retrievalRung: FLOOR }),
      stepFinalized(0, 1, { status: 'passed', retrievalRung: LEXICAL }),
    ])
    expect(state.retrievalRung).toEqual(FLOOR)
  })

  it('leaves a recorded rung alone when a later frame carries none', () => {
    const state = fold([
      stepFinalized(0, 0, { status: 'passed', retrievalRung: FLOOR }),
      stepFinalized(0, 1, { status: 'passed' }),
    ])
    expect(state.retrievalRung).toEqual(FLOOR)
  })

  it('leaves the key ABSENT — not null, not a rung word — before any carrying frame', () => {
    // Not yet known is the absent key, so the page renders no element rather than a guessed rung.
    const state = fold([stepStarted(0, 0), stepFinalized(0, 0, { status: 'passed' })])
    expect(state.retrievalRung).toBeUndefined()
    expect('retrievalRung' in state).toBe(false)
    expect('retrievalRung' in createInitialRunStreamState()).toBe(false)
  })

  it('folds on the ROW-ABSENT arm too — a resumed stream can land a finalize with no prior start', () => {
    // Two return paths in the `stepFinalized` arm, and only one of them is exercised by a stream
    // that started at seq 1. A fold written into the common path only would silently drop the rung
    // for exactly the reattach case the live page reconnects into.
    const state = fold([stepFinalized(3, 2, { status: 'failed', retrievalRung: LEXICAL })])
    expect(rowAt(state, 3, 2)).toMatchObject({ status: 'failed' })
    expect(state.retrievalRung).toEqual(LEXICAL)
  })

  it('THE KEY CENSUS: `retrievalRung` is the ONLY new name a stepFinalized payload puts on the state', () => {
    // The sentinel cell above proves no forbidden VALUE survives; this proves no unintended NAME
    // does either. A payload carrying every field the producer emits is folded, and the state's
    // own top-level key set is pinned — so a `{ ...payload }` regression in this arm reds by name.
    //
    // `gap` and `verdict` are in the census because `createInitialRunStreamState` writes them as
    // present-with-undefined. `retrievalRung` is deliberately NOT written there — the cell above
    // is where that absence is the subject.
    const state = fold([
      envelope('runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] }),
      stepStarted(0, 0, 'click login'),
      stepFinalized(0, 0, {
        status: 'failed',
        error: SENTINEL,
        durationMs: 12,
        retrievalRung: FLOOR,
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      }),
    ])
    expect(Object.keys(state).sort()).toEqual([
      'gap',
      'handles',
      'lastEnvelopeAt',
      'lastSeq',
      'members',
      'notices',
      'retrievalRung',
      'steps',
      'terminal',
      'verdict',
    ])
    expect(JSON.stringify(state)).not.toContain(SENTINEL)
    expect(JSON.stringify(state)).not.toContain('tokenUsage')
  })
})
