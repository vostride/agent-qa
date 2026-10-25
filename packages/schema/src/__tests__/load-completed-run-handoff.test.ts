// Wave-0 RED scaffold (361-01, Task 1). Pins the schema-side handoff version guard
// BEFORE any implementation exists — RED strictly on the unresolved import of the
// not-yet-existing `../handoff/load-completed-run-handoff` module (right-reason RED).
//
// Contract source: 361-CONTEXT.md D-19 (361 ships the READ side of the version
// discipline: parse → version check → reject newer-than-known with a typed error →
// migrate older; empty migration table at v1, but the seam exists so every future
// consumer imports the one guard instead of re-implementing the rule) +
// eval-and-core-types.md §A8 schema-version discipline (reject newer / migrate older).
//
// Schema module-discipline law: extension-less relative import specifiers, no node builtins.
import { describe, expect, it } from 'vitest'

import {
  guardCompletedRunHandoff,
  HandoffVersionError,
  HANDOFF_MIGRATIONS,
} from '../handoff/load-completed-run-handoff'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  type CompletedRunHandoff,
} from '../handoff/completed-run-handoff'
import { asRunId } from '../run/run-id'
import { PlannerLimitsRecordSchema, RunKnowledgePlanSourceSchema } from '../functions/runs'
import type { ScopeKey } from '../identity/scope-key'

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }

function makeValidHandoff(): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-abc'),
    scope,
    buildOrdinal: 1,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [],
  }
}

describe('guardCompletedRunHandoff (D-19, §A8 version discipline)', () => {
  it('returns a typed handoff for a document at the current schemaVersion', () => {
    const doc = makeValidHandoff()
    const guarded = guardCompletedRunHandoff(doc)
    expect(guarded.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(guarded.runId).toBe('run-abc')
    expect(guarded.aggregateVerdict).toBe('passed')
  })

  it('loads a stored schemaVersion 2 document as the current shape', () => {
    const doc = { ...makeValidHandoff(), schemaVersion: 2 }
    const guarded = guardCompletedRunHandoff(doc)
    expect(guarded.runId).toBe('run-abc')
    expect(guarded.aggregateVerdict).toBe('passed')
    expect(guarded.tests).toEqual([])
  })

  it('rejects a pre-INST schemaVersion 1 with no migration registered', () => {
    const doc = { ...makeValidHandoff(), schemaVersion: 1 }
    let thrown: unknown
    try {
      guardCompletedRunHandoff(doc)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HandoffVersionError)
    const err = thrown as HandoffVersionError
    expect(err.message).toContain('schemaVersion 1')
    expect(err.message).toContain(`supports ${CURRENT_HANDOFF_SCHEMA_VERSION}`)
    expect(err.foundVersion).toBe(1)
    expect(err.supportedVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
  })

  it('rejects a newer-than-known schemaVersion with a typed HandoffVersionError', () => {
    const newer = 8
    const doc = { ...makeValidHandoff(), schemaVersion: newer }
    let thrown: unknown
    try {
      guardCompletedRunHandoff(doc)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HandoffVersionError)
    const err = thrown as HandoffVersionError
    expect(err.foundVersion).toBe(8)
    expect(err.supportedVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
  })

  it('a handoff stamped 2 is returned as the same object', () => {
    const doc = { ...makeValidHandoff(), schemaVersion: 2 }
    expect(guardCompletedRunHandoff(doc)).toBe(doc)
  })

  it.each([1, 3, 4, 5, 6, 7, 8])('a handoff stamped %i is refused', (stamp) => {
    let thrown: unknown
    try {
      guardCompletedRunHandoff({ ...makeValidHandoff(), schemaVersion: stamp })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HandoffVersionError)
    expect((thrown as HandoffVersionError).foundVersion).toBe(stamp)
  })

  it('throws for a non-numeric schemaVersion', () => {
    const doc = { ...makeValidHandoff(), schemaVersion: 'one' as unknown as number }
    expect(() => guardCompletedRunHandoff(doc)).toThrow()
  })

  it('throws for a missing schemaVersion', () => {
    const { schemaVersion: _omit, ...withoutVersion } = makeValidHandoff()
    void _omit
    expect(() => guardCompletedRunHandoff(withoutVersion as CompletedRunHandoff)).toThrow()
  })

  it('registers no migration, so schemaVersion 1 stays unreadable', () => {
    expect(HANDOFF_MIGRATIONS).toBeDefined()
    expect(Object.keys(HANDOFF_MIGRATIONS)).toEqual([])
  })
})

// --- 407-03 (TRST-01, D-13): the additive `StepEvidence.retrievalRung` -----------------------
//
// The rung is recorded BESIDE the served brief, never inside it, so a v6 handoff stays
// loadable and a v7 handoff that carries one is admitted only in the shape the schema
// declares. Present-implies-valid, exactly as `retrievalTrace` next door.

function makeStepWithRung(rung?: unknown): unknown {
  return {
    stepIndex: 0,
    stepText: 'Save the record',
    cacheStatus: 'miss',
    servedBrief: {
      scope,
      asOfBuild: 1,
      budget: 4096,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest-deadbeef',
    },
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'saved' },
    ...(rung !== undefined ? { retrievalRung: rung } : {}),
  }
}

function makeHandoffWithStep(rung?: unknown): Record<string, unknown> {
  return {
    ...makeValidHandoff(),
    tests: [
      {
        testId: 't-1',
        testName: 'checkout happy path',
        filePath: 'tests/checkout.test.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [makeStepWithRung(rung)],
      },
    ],
  }
}

describe('member-grain rerun markers at the load boundary (418 D-09, approved OQ-1)', () => {
  function handoffWithRerunFields(fields: Record<string, unknown>) {
    const doc = makeHandoffWithStep()
    const tests = doc.tests as Record<string, unknown>[]
    return { ...doc, tests: tests.map((test) => ({ ...test, ...fields })) }
  }

  it.each([1, 3])('preserves a literal rerun marker and attempt %s', (rerunAttempt) => {
    const doc = handoffWithRerunFields({ isRerun: true, rerunAttempt })
    const guarded = guardCompletedRunHandoff(doc)
    expect(guarded.tests[0]?.isRerun).toBe(true)
    expect(guarded.tests[0]?.rerunAttempt).toBe(rerunAttempt)
    expect(guarded).toEqual(doc)
    expect(guarded).not.toHaveProperty('isRerun')
  })

  it.each([false, 'yes', 1, null, undefined])('refuses a present isRerun value of %s', (isRerun) => {
    expect(() => guardCompletedRunHandoff(handoffWithRerunFields({ isRerun }))).toThrow(
      /failed structural validation/,
    )
  })

  it.each([0, -1, 1.5, '1', Number.NaN, Infinity, null, undefined])(
    'refuses a present rerunAttempt value of %s',
    (rerunAttempt) => {
      expect(() =>
        guardCompletedRunHandoff(handoffWithRerunFields({ isRerun: true, rerunAttempt })),
      ).toThrow(/failed structural validation/)
    },
  )

  it('loads an ordinary member unchanged with both keys absent', () => {
    const doc = makeHandoffWithStep()
    const guarded = guardCompletedRunHandoff(doc)
    expect(guarded).toEqual(doc)
    expect(guarded.tests[0]).not.toHaveProperty('isRerun')
    expect(guarded.tests[0]).not.toHaveProperty('rerunAttempt')
  })
})

describe('StepEvidence.retrievalRung at the load boundary (407 D-13, TRST-01)', () => {
  it('the current handoff schemaVersion is 2', () => {
    expect(CURRENT_HANDOFF_SCHEMA_VERSION).toBe(2)
  })

  it('loads a document whose step carries a recorded rung, field intact', () => {
    const recorded = {
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'native-runtime-unavailable',
    }
    const guarded = guardCompletedRunHandoff(makeHandoffWithStep(recorded))
    expect(guarded.tests[0]?.steps[0]?.retrievalRung).toEqual(recorded)
  })

  it('admits a memidex rung carrying no reason key (the top rung names no cause)', () => {
    const recorded = { schemaVersion: 2, rung: 'memidex' }
    const guarded = guardCompletedRunHandoff(makeHandoffWithStep(recorded))
    expect(guarded.tests[0]?.steps[0]?.retrievalRung).toEqual(recorded)
  })

  it('refuses a step whose retrievalRung is present but not a RecordedRetrievalRung', () => {
    // Present-implies-valid: the same refusal an invalid `retrievalTrace` earns.
    expect(() => guardCompletedRunHandoff(makeHandoffWithStep({ rung: 'fast' }))).toThrow(
      /failed structural validation/,
    )
  })

  it('refuses a rung whose word is outside the closed vocabulary', () => {
    expect(() =>
      guardCompletedRunHandoff(makeHandoffWithStep({ schemaVersion: 2, rung: 'dense-only' })),
    ).toThrow(/failed structural validation/)
  })
})

// --- 407-20 (REVIEW WR-04): a replay plan source is admitted only in the wire's own domain ---
//
// `hasCompletePlanSourceShape` used to admit `flow.cursor`/`flow.length` as merely FINITE numbers
// and `guard.checksPassed`/`guard.total`/`*.procedureStepIndex` as a bare `typeof === 'number'`,
// while `RunKnowledgePlanSourceSchema` (`../functions/runs`) declares every one of them
// `z.number().int().nonnegative()`. `planSourceOf` picks an admitted value straight onto that
// strict wire, so a `-1` cursor loaded here and then threw at `spec.output.parse` — the Knowledge
// tab rendering `read_failed` for that run. A handoff carrying a negative cursor is malformed, so
// it is refused where it is LOADED, through the same arm an unknown `miss.reason` takes today.

function makeReplayStep(planSource: unknown): unknown {
  return {
    stepIndex: 0,
    stepText: 'Save the record',
    cacheStatus: 'miss',
    servedBrief: {
      scope,
      asOfBuild: 1,
      budget: 4096,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'brief-digest-deadbeef',
    },
    subActions: [],
    verifierVerdict: { pass: true, reasoning: 'saved' },
    planSource,
  }
}

function replayHandoff(planSource: unknown): Record<string, unknown> {
  return {
    ...makeValidHandoff(),
    tests: [
      {
        testId: 't-1',
        testName: 'checkout happy path',
        filePath: 'tests/checkout.test.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [makeReplayStep(planSource)],
      },
    ],
  }
}

/** The shape `recordProcedureReplaySource` (runner loop/index.ts:406) really writes. */
function replaySource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'procedure-replay',
    procedureId: 'p',
    guard: { checksPassed: 3, total: 3 },
    flow: { cursor: 1, length: 3 },
    ...overrides,
  }
}

describe("a replay plan source is admitted only in the wire's own domain (407-20, REVIEW WR-04)", () => {
  it('loads a step whose replay plan source carries the ordinals the runner writes', () => {
    const guarded = guardCompletedRunHandoff(replayHandoff(replaySource()))
    expect(guarded.tests[0]?.steps[0]?.planSource).toEqual({
      kind: 'procedure-replay',
      procedureId: 'p',
      guard: { checksPassed: 3, total: 3 },
      flow: { cursor: 1, length: 3 },
    })
  })

  it.each([
    ['flow.cursor: -1', replaySource({ flow: { cursor: -1, length: 3 } })],
    ['flow.length: 1.5', replaySource({ flow: { cursor: 1, length: 1.5 } })],
    ['flow.cursor: Number.NaN', replaySource({ flow: { cursor: Number.NaN, length: 3 } })],
    ['guard.checksPassed: -1', replaySource({ guard: { checksPassed: -1, total: 3 } })],
    ['guard.total: 2.5', replaySource({ guard: { checksPassed: 2, total: 2.5 } })],
    [
      'guard.miss.procedureStepIndex: 1.5',
      replaySource({
        guard: {
          checksPassed: 1,
          total: 3,
          miss: { procedureStepIndex: 1.5, reason: 'descriptor-missing' },
        },
      }),
    ],
    [
      'guard.executionFailure.procedureStepIndex: -1',
      replaySource({
        guard: { checksPassed: 1, total: 3, executionFailure: { procedureStepIndex: -1 } },
      }),
    ],
    [
      'guard.verifierRejection.procedureStepIndex: 0.5',
      replaySource({
        guard: { checksPassed: 1, total: 3, verifierRejection: { procedureStepIndex: 0.5 } },
      }),
    ],
  ])('refuses a replay plan source carrying %s', (_label, planSource) => {
    // The same refusal arm an unknown `miss.reason` earns today — never admitted here and
    // then thrown at by `spec.output.parse` as a `read_failed` page.
    expect(() => guardCompletedRunHandoff(replayHandoff(planSource))).toThrow(
      /failed structural validation/,
    )
  })

  it('leaves an ordinary procedure-hint plan source untouched', () => {
    const hint = { kind: 'procedure-hint', procedureId: 'p' }
    expect(guardCompletedRunHandoff(replayHandoff(hint)).tests[0]?.steps[0]?.planSource).toEqual(
      hint,
    )
  })

  it('leaves a procedure-hint carrying a declared demotion untouched', () => {
    const hint = { kind: 'procedure-hint', procedureId: 'p', demotion: 'body-empty' }
    expect(guardCompletedRunHandoff(replayHandoff(hint)).tests[0]?.steps[0]?.planSource).toEqual(
      hint,
    )
  })

  it('still refuses a procedure-hint whose demotion is outside the closed union', () => {
    const hint = { kind: 'procedure-hint', procedureId: 'p', demotion: 'body-elsewhere' }
    expect(() => guardCompletedRunHandoff(replayHandoff(hint))).toThrow(
      /failed structural validation/,
    )
  })
})

// --- 407-20 (REVIEW WR-04, structural half): the loader and the wire, measured as one rule ---
//
// The CR-01 class is TWO PREDICATES OVER ONE SHAPE drifting apart — a member the loader admits
// and `RunKnowledgePlanSourceSchema` refuses is not a caught error, it is a `read_failed` page
// for a run that really replayed a procedure. `planSourceOf` (agent `ops/runs-knowledge.ts`)
// picks exactly the members the loader admitted onto that schema, member for member, so this
// corpus turns any future drift — a slot tightened on the wire, a slot loosened at the loader,
// a new numeric member added to one file and not the other — into a red here.

const ORDINAL_SLOTS = [
  'flow.cursor',
  'flow.length',
  'guard.checksPassed',
  'guard.total',
  'guard.miss.procedureStepIndex',
  'guard.executionFailure.procedureStepIndex',
  'guard.verifierRejection.procedureStepIndex',
] as const

const ORDINAL_CORPUS = [-1, 1.5, Number.NaN, 0, 3] as const

/** Every optional replay member present and valid, so each slot can be varied in isolation. */
function fullReplaySource(): Record<string, unknown> {
  return {
    kind: 'procedure-replay',
    procedureId: 'p',
    guard: {
      checksPassed: 3,
      total: 3,
      miss: { procedureStepIndex: 1, reason: 'descriptor-missing' },
      executionFailure: { procedureStepIndex: 2 },
      verifierRejection: { procedureStepIndex: 0 },
    },
    flow: { cursor: 1, length: 3 },
  }
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split('.')
  const leaf = keys.pop() as string
  let cursor = target
  for (const key of keys) {
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[leaf] = value
  return target
}

/** Whether the load boundary lets the document through at all (the version is always current). */
function loaderAdmits(planSource: Record<string, unknown>): boolean {
  try {
    guardCompletedRunHandoff(replayHandoff(planSource))
    return true
  } catch {
    return false
  }
}

describe('the loader and the wire admit the same replay shapes — member for member (407-20)', () => {
  it.each(
    ORDINAL_SLOTS.flatMap((slot) =>
      ORDINAL_CORPUS.map((value) => [slot, String(value)] as const),
    ),
  )('agrees on %s = %s', (slot, rendered) => {
    const value = ORDINAL_CORPUS.find((candidate) => String(candidate) === rendered)
    const planSource = setPath(fullReplaySource(), slot, value)
    const admitted = loaderAdmits(planSource)
    const onWire = RunKnowledgePlanSourceSchema.safeParse(planSource).success
    expect(
      admitted,
      `${slot} = ${rendered}: the loader ${admitted ? 'ADMITS' : 'REFUSES'} what the wire ` +
        `${onWire ? 'ADMITS' : 'REFUSES'} — the disagreeing side is the ` +
        `${admitted ? 'loader' : 'wire'}`,
    ).toBe(onWire)
  })

  it('is not vacuous — every slot admits an ordinal and refuses a negative, on both sides', () => {
    for (const slot of ORDINAL_SLOTS) {
      for (const admissible of [0, 3]) {
        const planSource = setPath(fullReplaySource(), slot, admissible)
        expect(loaderAdmits(planSource), `${slot} = ${admissible} loads`).toBe(true)
        expect(
          RunKnowledgePlanSourceSchema.safeParse(planSource).success,
          `${slot} = ${admissible} is on the wire`,
        ).toBe(true)
      }
      const refused = setPath(fullReplaySource(), slot, -1)
      expect(loaderAdmits(refused), `${slot} = -1 is refused at load`).toBe(false)
      expect(
        RunKnowledgePlanSourceSchema.safeParse(refused).success,
        `${slot} = -1 is refused on the wire`,
      ).toBe(false)
    }
  })
})

// 436-09 (D-06): the run's planner limits are copied from this record onto the strict
// acknowledgement, so the loader admits exactly the records the wire accepts.
describe('C436-EFFECTIVE-LIMITS the loader and the acknowledgement agree on plannerLimits', () => {
  const entry = { testName: 'Bulk archive', filePath: 'tests/bulk.yaml', maxActions: 60, maxPlanningTurns: 30 }
  const corpus: readonly (readonly [string, unknown])[] = [
    ['run limits only', { maxActions: 30, maxPlanningTurns: 30 }],
    ['with one per-test entry', { maxActions: 30, maxPlanningTurns: 30, perTest: [entry] }],
    ['empty perTest', { maxActions: 30, maxPlanningTurns: 30, perTest: [] }],
    ['retired overrides key', { maxActions: 30, maxPlanningTurns: 30, overrides: [entry] }],
    ['zero actions', { maxActions: 0, maxPlanningTurns: 30 }],
    ['fractional turns', { maxActions: 30, maxPlanningTurns: 2.5 }],
    ['string limit', { maxActions: '30', maxPlanningTurns: 30 }],
    ['missing turns', { maxActions: 30 }],
    ['unknown key', { maxActions: 30, maxPlanningTurns: 30, extra: true }],
    ['per-test entry with unknown key', { maxActions: 30, maxPlanningTurns: 30, perTest: [{ ...entry, extra: 1 }] }],
    ['per-test entry missing name', { maxActions: 30, maxPlanningTurns: 30, perTest: [{ ...entry, testName: undefined }] }],
    ['per-test entry negative limit', { maxActions: 30, maxPlanningTurns: 30, perTest: [{ ...entry, maxActions: -1 }] }],
    ['perTest not an array', { maxActions: 30, maxPlanningTurns: 30, perTest: entry }],
    ['not an object', 30],
  ]

  function loads(plannerLimits: unknown): boolean {
    try {
      guardCompletedRunHandoff(JSON.parse(JSON.stringify({ ...makeValidHandoff(), plannerLimits })))
      return true
    } catch {
      return false
    }
  }

  it.each(corpus)('agrees on %s', (_name, plannerLimits) => {
    expect(loads(plannerLimits)).toBe(PlannerLimitsRecordSchema.safeParse(plannerLimits).success)
  })

  it('is not vacuous and leaves an absent record absent', () => {
    expect(loads({ maxActions: 30, maxPlanningTurns: 30, perTest: [entry] })).toBe(true)
    expect(loads({ maxActions: 30, maxPlanningTurns: 30, overrides: [entry] })).toBe(false)
    expect(loads({ maxActions: 0, maxPlanningTurns: 30 })).toBe(false)
    expect(guardCompletedRunHandoff(makeValidHandoff())).not.toHaveProperty('plannerLimits')
  })
})

// 2026-10-19 (444.1-08, D-14): a healed sub-action's dispatch pair is checked where it is loaded.
describe('C444.1-DISPATCH-PAIR', () => {
  const saveElement = {
    ref: 'e3',
    role: 'button',
    name: 'Save',
    nameNormalized: 'save',
    labels: {},
    attributes: {},
  }
  const dispatchState = {
    platform: 'web',
    url: 'https://shop.example/editor',
    tree: 'button Save',
    elements: [saveElement],
    refMap: {},
    timestamp: 0,
    metadata: {},
  }

  function healedHandoff(healedDispatch?: unknown): Record<string, unknown> {
    const subAction = {
      plan: 'Save the record',
      plannedAction: { type: 'click', ref: 'e2' },
      stateBefore: { ...dispatchState, elements: [{ ...saveElement, ref: 'e2' }] },
      result: { success: true },
      ...(healedDispatch === undefined ? {} : { healedDispatch }),
    }
    const step = { ...(makeStepWithRung() as Record<string, unknown>), subActions: [subAction] }
    const handoff = makeHandoffWithStep()
    const [test] = handoff.tests as Record<string, unknown>[]
    return { ...handoff, tests: [{ ...test, steps: [step] }] }
  }

  it('the loader refuses a healed sub-action whose dispatch pair is malformed', () => {
    const malformed: readonly unknown[] = [
      { action: 'click', stateBefore: {} },
      null,
      { action: [], stateBefore: dispatchState },
      { stateBefore: dispatchState },
      { action: { type: 'click', ref: 'e3' } },
      { action: { type: 'click', ref: 'e3' }, stateBefore: { ...dispatchState, url: 7 } },
      { action: { type: 'click', ref: 'e3' }, stateBefore: { ...dispatchState, elements: [{}] } },
      { action: { type: 'click', ref: 'e3' }, stateBefore: { ...dispatchState, elements: undefined } },
    ]
    for (const healedDispatch of malformed) {
      expect(() => guardCompletedRunHandoff(healedHandoff(healedDispatch))).toThrow(
        /failed structural validation/,
      )
    }

    const pair = { action: { type: 'click', ref: 'e3' }, stateBefore: dispatchState }
    const loaded = guardCompletedRunHandoff(healedHandoff(pair))
    expect(loaded.tests[0]?.steps[0]?.subActions[0]).toHaveProperty('healedDispatch', pair)
    const unhealed = guardCompletedRunHandoff(healedHandoff())
    expect(unhealed.tests[0]?.steps[0]?.subActions[0]).not.toHaveProperty('healedDispatch')
  })
})

describe('a persisted rootCause memoryOnPath at the load boundary', () => {
  function withRootCause(rootCause: Record<string, unknown>): unknown {
    return JSON.parse(
      JSON.stringify({
        ...makeValidHandoff(),
        aggregateVerdict: 'failed',
        tests: [
          {
            testId: 't_checkout',
            testName: 'checkout submits',
            filePath: 'tests/checkout.yaml',
            testIndex: 0,
            outcome: 'failed',
            steps: [],
            rootCause: {
              class: 'app_bug',
              producer: 'analyze-run',
              confidence: 0.8,
              evidence: { citedSteps: [], citedAnchors: [], citedArtifacts: [], rationale: 'r' },
              memoryMisdirectionRuledOut: true,
              perTest: 0,
              ...rootCause,
            },
          },
        ],
      }),
    ) as unknown
  }

  it('round-trips a declared memoryOnPath and leaves an absent one absent', () => {
    const memoryOnPath = [
      { recordId: 'rec_mem_candidate', trust: 'candidate' },
      { recordId: 'rec_mem_canary', trust: 'candidate' },
    ]
    const loaded = guardCompletedRunHandoff(withRootCause({ memoryOnPath }))
    expect(loaded.tests[0]?.rootCause?.memoryOnPath).toEqual(memoryOnPath)
    const bare = guardCompletedRunHandoff(withRootCause({}))
    expect('memoryOnPath' in (bare.tests[0]?.rootCause ?? {})).toBe(false)
  })

  it('refuses a memoryOnPath entry outside the closed trust vocabulary or not an array', () => {
    expect(() =>
      guardCompletedRunHandoff(
        withRootCause({ memoryOnPath: [{ recordId: 'rec_mem_candidate', trust: 'canary' }] }),
      ),
    ).toThrow()
    expect(() =>
      guardCompletedRunHandoff(withRootCause({ memoryOnPath: { recordId: 'rec_mem_candidate' } })),
    ).toThrow()
  })
})
