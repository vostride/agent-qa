// The Effect section's view: measured effects only, problems first.

import { describe, expect, it } from 'vitest'
import { RunKnowledgeProjectionSchema, type RunKnowledgeProjection } from '@vostride/agent-qa-schema'

import {
  EFFECT_NOTHING_MEASURED_TEXT,
  EFFECT_NOTHING_USED_TEXT,
  EFFECT_OUTCOMES,
  EFFECT_SENTENCES,
  EFFECT_TONES,
  EFFECT_TONE_OF,
  REPLAY_STOP_CAUSES,
  UNCOUNTED_TRIALS_TOOLTIP,
  effectSectionView,
  effectSentenceText,
  isReplayComplete,
  planSourceSentence,
  projectKnowledgeView,
  replayCompleteParts,
  replayStop,
  replayStoppedParts,
  uncountedTrialsLine,
  unmeasuredRecordsLine,
  type EffectSectionView,
} from '@/lib/knowledge-view'

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type Outcome = 'confirmed' | 'contradicted' | 'helpful' | 'harmful'
type CurationStatus = 'pending' | 'running' | 'complete' | 'failed'

function line(id: string, summary: string, canary = false) {
  return { id, kind: 'fact', summary, trust: 0.9, status: 'candidate', servedAsCanary: canary, tier: 'confirmed' }
}

function trial(id: string, summary: string) {
  return line(id, summary, true)
}

interface Served {
  readonly channel1?: ReturnType<typeof line>[]
  readonly channel3?: Array<{ id: string; summary: string }>
  readonly planSource?: Record<string, unknown>
}

function step(stepIndex: number, served: Served, testIndex = 0) {
  return {
    testId: 't_effect',
    testIndex,
    stepIndex,
    stepText: `step text ${String(stepIndex)}`,
    served: { channel1: served.channel1 ?? [], channel2: [], channel3: served.channel3 ?? [] },
    trace: { kind: 'no-trace', reason: 'pre-trace-run' },
    ...(served.planSource === undefined ? {} : { planSource: served.planSource }),
  }
}

function attributed(recordId: string, stepIndex: number, outcome: Outcome, testIndex = 0) {
  return { testIndex, stepIndex, recordId, observationId: `obs-${recordId}-${String(stepIndex)}`, outcome }
}

interface Learned {
  readonly attributions?: ReturnType<typeof attributed>[]
  readonly status?: CurationStatus
  readonly scanIncomplete?: true
}

function projection(steps: ReturnType<typeof step>[], learned: Learned = {}): ReadyProjection {
  const parsed = RunKnowledgeProjectionSchema.parse({
    kind: 'ready',
    runId: 'run-427-07-effect',
    buildOrdinal: 1,
    knowledgeStore: 'bound',
    steps,
    curation: { status: learned.status ?? 'complete' },
    learned: {
      changes: [],
      canaryAttributions: learned.attributions ?? [],
      ...(learned.scanIncomplete === undefined ? {} : { scanIncomplete: true }),
    },
  })
  if (parsed.kind !== 'ready') throw new Error('expected a ready projection')
  return parsed
}

function summary(view: EffectSectionView): Array<[string, string]> {
  return view.entries.map(entry => [entry.record, entry.outcome])
}

function steps(view: EffectSectionView, index: number): string[] {
  return (view.entries[index]?.addresses ?? []).map(address => `${String(address.testIndex)}:${String(address.stepIndex)}`)
}

describe('the effect closed sets are exactly the published members', () => {
  it('the effect outcomes, tones, tone map and stop causes', () => {
    expect(EFFECT_OUTCOMES).toEqual([
      'contradicted',
      'harmful',
      'replay-stopped',
      'confirmed',
      'helpful',
      'replay-complete',
      'pending',
      'unknown',
    ])
    expect(EFFECT_TONES).toEqual(['problem', 'positive', 'pending', 'unknown'])
    expect(EFFECT_TONE_OF).toEqual({
      contradicted: 'problem',
      harmful: 'problem',
      'replay-stopped': 'problem',
      confirmed: 'positive',
      helpful: 'positive',
      'replay-complete': 'positive',
      pending: 'pending',
      unknown: 'unknown',
    })
    expect(Object.keys(REPLAY_STOP_CAUSES).sort()).toEqual([
      'descriptor-ambiguous',
      'descriptor-missing',
      'execution-failure',
      'gate-refused',
      'non-replayable-action',
      'page-anchor-mismatch',
      'parameter-unbound',
      'verifier-rejection',
    ])
  })
})

describe('entries order problems first, then by step, then by Knowledge-used position', () => {
  it('EFFECT-ORDER: harmful and contradicted before helpful and confirmed; an unknown entry sorts last', () => {
    const view = effectSectionView(projection(
      [
        step(0, { channel1: [trial('rec_u', 'U unread trial'), trial('rec_w', 'W helped'), trial('rec_x', 'X held')] }),
        step(1, { channel1: [trial('rec_z', 'Z misled')] }),
        step(2, { channel1: [trial('rec_y', 'Y did not hold')] }),
      ],
      {
        scanIncomplete: true,
        attributions: [
          attributed('rec_w', 0, 'helpful'),
          attributed('rec_x', 0, 'confirmed'),
          attributed('rec_z', 1, 'harmful'),
          attributed('rec_y', 2, 'contradicted'),
        ],
      },
    ))

    expect(summary(view)).toEqual([
      ['Z misled', 'harmful'],
      ['Y did not hold', 'contradicted'],
      ['W helped', 'helpful'],
      ['X held', 'confirmed'],
      ['U unread trial', 'unknown'],
    ])
    expect(view.entries.map(entry => entry.tone)).toEqual(['problem', 'problem', 'positive', 'positive', 'unknown'])
    expect(view.absence).toBeUndefined()
  })

  it('EFFECT-ORDER: the join is on test, step and record — a second member test\'s step 0 is its own trial', () => {
    const view = effectSectionView(projection(
      [
        step(0, { channel1: [trial('rec_a', 'A in test 1')] }, 0),
        step(0, { channel1: [trial('rec_a', 'A in test 1')] }, 1),
      ],
      { attributions: [attributed('rec_a', 0, 'confirmed', 1)] },
    ))

    expect(summary(view)).toEqual([['A in test 1', 'confirmed']])
    expect(steps(view, 0)).toEqual(['1:0'])
    expect(view.uncounted).toBeUndefined()
  })
})

describe('repeated same-outcome trials of one record are one entry', () => {
  it('EFFECT-GROUPED-STEPS: one record confirmed in steps 0, 1 and 2 is one entry with three addresses', () => {
    const view = effectSectionView(projection(
      [0, 1, 2].map(index => step(index, { channel1: [trial('rec_g', 'the cart badge counts items')] })),
      { attributions: [0, 1, 2].map(index => attributed('rec_g', index, 'confirmed')) },
    ))

    expect(summary(view)).toEqual([['the cart badge counts items', 'confirmed']])
    expect(steps(view, 0)).toEqual(['0:0', '0:1', '0:2'])
  })
})

describe('an uncounted trial is not an effect', () => {
  it('UNCOUNTED-NOT-EFFECTS: a settled, clean-read trial with no outcome is no entry and one uncounted record', () => {
    const view = effectSectionView(projection([step(0, { channel1: [trial('rec_q', 'the quiet trial')] })]))

    expect(view.entries).toEqual([])
    expect(view.uncounted).toEqual({ count: 1, line: uncountedTrialsLine(1) })
    expect(view.absence).toBe(EFFECT_NOTHING_MEASURED_TEXT)
    expect(view.unmeasured).toBeUndefined()
  })

  it('UNCOUNTED-NOT-EFFECTS: a record with one confirmed and one uncounted trial is one confirmed entry, not uncounted', () => {
    const view = effectSectionView(projection(
      [
        step(0, { channel1: [trial('rec_m', 'the mixed trial')] }),
        step(1, { channel1: [trial('rec_m', 'the mixed trial')] }),
      ],
      { attributions: [attributed('rec_m', 0, 'confirmed')] },
    ))

    expect(summary(view)).toEqual([['the mixed trial', 'confirmed']])
    expect(steps(view, 0)).toEqual(['0:0'])
    expect(view.uncounted).toBeUndefined()
  })

  it('UNCOUNTED-NOT-EFFECTS: a failed chain with a clean read leaves an unattributed trial uncounted, never a problem', () => {
    const view = effectSectionView(projection([step(0, { channel1: [trial('rec_f', 'after a failed chain')] })], { status: 'failed' }))

    expect(view.entries).toEqual([])
    expect(view.uncounted?.count).toBe(1)
  })
})

describe('a procedure hint is a use, never an effect', () => {
  it('HINT-NOT-EFFECT: a step whose plan a procedure hinted yields no entry', () => {
    const view = effectSectionView(projection([
      step(0, { planSource: { kind: 'procedure-hint', procedureId: 'rec_h' } }),
      step(1, { planSource: { kind: 'procedure-hint', procedureId: 'rec_d', demotion: 'body-empty' } }),
    ]))

    expect(view.entries).toEqual([])
    expect(view.absence).toBe(EFFECT_NOTHING_MEASURED_TEXT)
  })
})

// Runner-shaped: `total` counts this test step's attempted actions (1 per flow-covered step);
// the procedure's own size is the sibling `flow.length`.
function replay(procedureId: string, guard: Record<string, unknown>, flow?: { cursor: number; length: number }) {
  return { kind: 'procedure-replay', procedureId, guard, ...(flow === undefined ? {} : { flow }) }
}

const PASSED = { checksPassed: 1, total: 1 }

describe('a procedure replay is measured', () => {
  it('REPLAY-COMPLETE: a six-step procedure replayed step by step is one positive entry sized by its flow', () => {
    const view = effectSectionView(projection([0, 1, 2, 3, 4, 5].map(index => step(index, {
      ...(index === 0 ? { channel1: [line('rec_p', 'check out as a guest')] } : {}),
      planSource: replay('rec_p', PASSED, { cursor: index, length: 6 }),
    }))))

    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]).toMatchObject({ outcome: 'replay-complete', tone: 'positive', record: 'check out as a guest' })
    expect(steps(view, 0)).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4', '0:5'])
    expect(view.entries[0]?.parts).toEqual(replayCompleteParts(6, 6))
    expect(effectSentenceText(view.entries[0]!.parts, 'steps 1–6')).toBe('Replayed all 6 of its steps in steps 1–6')
  })

  it('REPLAY-GROUPED-STEPS: a three-step procedure replayed across steps 0, 1 and 2 is one entry with three addresses', () => {
    const view = effectSectionView(projection([0, 1, 2].map(index => step(index, {
      planSource: replay('rec_t', PASSED, { cursor: index, length: 3 }),
    }))))

    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]?.outcome).toBe('replay-complete')
    expect(steps(view, 0)).toEqual(['0:0', '0:1', '0:2'])
    expect(view.entries[0]?.parts).toEqual(replayCompleteParts(3, 3))
  })

  it('REPLAY-GROUPED-STEPS: the same stop of one procedure in two member tests is one entry; a later stop is its own', () => {
    const stopAt = (index: number) =>
      replay('rec_g', { checksPassed: 0, total: 1, miss: { procedureStepIndex: index, reason: 'page-anchor-mismatch' } }, { cursor: index, length: 3 })
    const view = effectSectionView(projection([
      step(1, { planSource: stopAt(1) }, 0),
      step(1, { planSource: stopAt(1) }, 1),
      step(2, { planSource: stopAt(2) }, 2),
    ]))

    expect(view.entries.map(entry => entry.outcome)).toEqual(['replay-stopped', 'replay-stopped'])
    expect(steps(view, 0)).toEqual(['0:1', '1:1'])
    expect(view.entries[0]?.parts).toEqual(replayStoppedParts(2, 3, 'page-anchor-mismatch'))
    expect(steps(view, 1)).toEqual(['2:2'])
    expect(view.entries[1]?.parts).toEqual(replayStoppedParts(3, 3, 'page-anchor-mismatch'))
  })

  it('REPLAY-STOPPED-IS-PROBLEM: a miss at procedure step index 2 stops the replay at its step 3 and names the cause', () => {
    const view = effectSectionView(projection([
      step(0, { planSource: replay('rec_s', PASSED, { cursor: 0, length: 6 }) }),
      step(1, { planSource: replay('rec_s', PASSED, { cursor: 1, length: 6 }) }),
      step(2, {
        planSource: replay(
          'rec_s',
          { checksPassed: 0, total: 1, miss: { procedureStepIndex: 2, reason: 'descriptor-missing' } },
          { cursor: 2, length: 6 },
        ),
      }),
    ]))

    expect(view.entries.map(entry => entry.outcome)).toEqual(['replay-stopped', 'replay-complete'])
    expect(view.entries[0]).toMatchObject({ outcome: 'replay-stopped', tone: 'problem' })
    expect(view.entries[0]?.parts).toEqual(replayStoppedParts(3, 6, 'descriptor-missing'))
    expect(effectSentenceText(view.entries[0]!.parts, 'step 3')).toBe("Replay stopped at its step 3 of 6 in step 3: the element wasn't found")
    expect(view.entries[1]?.parts).toEqual(replayCompleteParts(2, 6))
    expect(effectSentenceText(view.entries[1]!.parts, 'steps 1 and 2')).toBe('Replayed 2 of its 6 steps in steps 1 and 2')
  })

  it('REPLAY-STOPPED-IS-PROBLEM: a miss outranks an execution failure, which outranks a verifier rejection', () => {
    expect(replayStop({
      checksPassed: 0,
      total: 1,
      miss: { procedureStepIndex: 3, reason: 'gate-refused' },
      executionFailure: { procedureStepIndex: 1 },
      verifierRejection: { procedureStepIndex: 0 },
    })).toEqual({ step: 4, cause: 'gate-refused' })
    expect(replayStop({
      checksPassed: 0,
      total: 1,
      executionFailure: { procedureStepIndex: 1 },
      verifierRejection: { procedureStepIndex: 0 },
    })).toEqual({ step: 2, cause: 'execution-failure' })
    expect(replayStop({ checksPassed: 1, total: 1, verifierRejection: { procedureStepIndex: 3 } }))
      .toEqual({ step: 4, cause: 'verifier-rejection' })
    expect(replayStop({ checksPassed: 1, total: 1 })).toBeUndefined()
  })

  it('REPLAY-STOPPED-IS-PROBLEM: a stopped replay sorts before a trial that held up in an earlier step', () => {
    const view = effectSectionView(projection(
      [
        step(0, { channel1: [trial('rec_c', 'an early confirmation')] }),
        step(4, {
          planSource: replay('rec_r', { checksPassed: 0, total: 1, executionFailure: { procedureStepIndex: 0 } }, { cursor: 0, length: 3 }),
        }),
      ],
      { attributions: [attributed('rec_c', 0, 'confirmed')] },
    ))

    expect(view.entries.map(entry => entry.outcome)).toEqual(['replay-stopped', 'confirmed'])
  })
})

describe("a replay's size is the procedure's recorded flow, never the per-step fold", () => {
  it('REPLAY-SIZE-FROM-FLOW: three completed body steps then a miss at body index 3 of a six-step flow', () => {
    const view = effectSectionView(projection([
      ...[0, 1, 2].map(index => step(index, { planSource: replay('rec_f', PASSED, { cursor: index, length: 6 }) })),
      step(3, {
        planSource: replay(
          'rec_f',
          { checksPassed: 0, total: 1, miss: { procedureStepIndex: 3, reason: 'descriptor-missing' } },
          { cursor: 3, length: 6 },
        ),
      }),
    ]))

    expect(view.entries.map(entry => entry.outcome)).toEqual(['replay-stopped', 'replay-complete'])
    expect(view.entries[0]?.parts).toEqual(replayStoppedParts(4, 6, 'descriptor-missing'))
    expect(effectSentenceText(view.entries[0]!.parts, 'step 4')).toBe("Replay stopped at its step 4 of 6 in step 4: the element wasn't found")
    expect(view.entries[1]?.parts).toEqual(replayCompleteParts(3, 6))
    expect(effectSentenceText(view.entries[1]!.parts, 'steps 1–3')).toBe('Replayed 3 of its 6 steps in steps 1–3')
  })

  it('REPLAY-SIZE-FROM-FLOW: with no recorded flow neither replay sentence prints an "of N" clause', () => {
    const view = effectSectionView(projection([
      step(0, { planSource: replay('rec_a', PASSED) }),
      step(1, { planSource: replay('rec_b', { checksPassed: 0, total: 1, miss: { procedureStepIndex: 1, reason: 'descriptor-missing' } }) }),
    ]))

    const texts = view.entries.map((entry, index) => effectSentenceText(entry.parts, `step ${String(index === 0 ? 2 : 1)}`))
    expect(texts).toEqual([
      "Replay stopped at its step 2 in step 2: the element wasn't found",
      'Replayed in step 1 — every replayed action was accepted',
    ])
    for (const text of texts) expect(text).not.toContain(' of ')
  })

  it('REPLAY-SIZE-FROM-FLOW: a one-step procedure reads its only step, and no stop prints a step above its denominator', () => {
    const only = effectSectionView(projection([step(0, { planSource: replay('rec_o', PASSED, { cursor: 0, length: 1 }) })]))
    expect(effectSentenceText(only.entries[0]!.parts, 'step 1')).toBe('Replayed its only step in step 1')

    const beyond = effectSectionView(projection([
      step(0, {
        planSource: replay(
          'rec_m',
          { checksPassed: 0, total: 1, miss: { procedureStepIndex: 3, reason: 'descriptor-missing' } },
          { cursor: 0, length: 1 },
        ),
      }),
    ]))
    const text = effectSentenceText(beyond.entries[0]!.parts, 'step 1')
    expect(text).toBe("Replay stopped at its step 4 in step 1: the element wasn't found")
    for (const [, k, n] of text.matchAll(/step (\d+) of (\d+)/g)) expect(Number(k)).toBeLessThanOrEqual(Number(n))
  })
})

describe('only a fold that passed every attempted check is a completed replay', () => {
  it('REPLAY-INCOMPLETE-NOT-COMPLETE: a policy-denied replayed action and an empty fold are no entry', () => {
    const denied = replay('rec_i', { checksPassed: 0, total: 1 }, { cursor: 0, length: 3 })
    const view = effectSectionView(projection([step(0, { planSource: denied })]))

    expect(view.entries).toEqual([])
    expect(view.absence).toBe(EFFECT_NOTHING_MEASURED_TEXT)
    const parsed = projection([step(0, { planSource: denied })]).steps[0]?.planSource
    if (parsed === undefined) throw new Error('expected a plan source')
    expect(planSourceSentence(parsed)).toBe('replayed 0/1')

    const empty = effectSectionView(projection([step(0, { planSource: replay('rec_e', { checksPassed: 0, total: 0 }) })]))
    expect(empty.entries).toEqual([])

    expect(isReplayComplete({ checksPassed: 0, total: 1 })).toBe(false)
    expect(isReplayComplete({ checksPassed: 0, total: 0 })).toBe(false)
    expect(isReplayComplete({ checksPassed: 1, total: 1 })).toBe(true)
  })

  it('REPLAY-INCOMPLETE-NOT-COMPLETE: an unfinished third step leaves the first two as the completed replay', () => {
    const view = effectSectionView(projection([
      step(0, { planSource: replay('rec_n', PASSED, { cursor: 0, length: 3 }) }),
      step(1, { planSource: replay('rec_n', PASSED, { cursor: 1, length: 3 }) }),
      step(2, { planSource: replay('rec_n', { checksPassed: 0, total: 1 }, { cursor: 2, length: 3 }) }),
    ]))

    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]?.outcome).toBe('replay-complete')
    expect(steps(view, 0)).toEqual(['0:0', '0:1'])
    expect(view.entries[0]?.parts).toEqual(replayCompleteParts(2, 3))
    expect(effectSentenceText(view.entries[0]!.parts, 'steps 1 and 2')).toBe('Replayed 2 of its 3 steps in steps 1 and 2')
  })
})

const DENIED = { checksPassed: 0, total: 1 }
const MISS = { checksPassed: 0, total: 1, miss: { procedureStepIndex: 1, reason: 'descriptor-missing' } }

function login(guard: Record<string, unknown>, cursor: number) {
  return replay('rec_login', guard, { cursor, length: 3 })
}

function entryAt(view: EffectSectionView, addresses: string[]) {
  const index = view.entries.findIndex((_, at) => steps(view, at).join(' ') === addresses.join(' '))
  return index === -1 ? undefined : view.entries[index]
}

function allThreeListsNone(view: EffectSectionView, shortFlow: string[]) {
  const all = replayCompleteParts(3, 3)
  view.entries.forEach((entry, at) => {
    if (entry.parts.lead !== all.lead || entry.parts.tail !== all.tail) return
    for (const address of shortFlow) expect(steps(view, at)).not.toContain(address)
  })
}

describe('a completed replay is sized by its own flow, never by other flows of its procedure', () => {
  it('REPLAY-PER-FLOW: a second test\'s flow that stops after one body step reads 1 of 3, never all 3', () => {
    const complete = [0, 1, 2].map(index => step(index, { planSource: login(PASSED, index) }, 0))
    const world = (second: Record<string, unknown>) => effectSectionView(projection([
      ...complete,
      step(0, { planSource: login(PASSED, 0) }, 1),
      step(1, { planSource: login(second, 1) }, 1),
    ]))

    const denied = world(DENIED)
    expect(denied.entries).toHaveLength(2)
    expect(denied.entries.map(entry => entry.outcome)).toEqual(['replay-complete', 'replay-complete'])
    expect(entryAt(denied, ['0:0', '0:1', '0:2'])?.parts).toEqual(replayCompleteParts(3, 3))
    const short = entryAt(denied, ['1:0'])
    expect(short?.parts).toEqual(replayCompleteParts(1, 3))
    expect(effectSentenceText(short!.parts, 'step 1')).toBe('Replayed 1 of its 3 steps in step 1')
    allThreeListsNone(denied, ['1:0'])

    const missed = world(MISS)
    expect(missed.entries).toHaveLength(3)
    expect(entryAt(missed, ['0:0', '0:1', '0:2'])?.parts).toEqual(replayCompleteParts(3, 3))
    expect(entryAt(missed, ['1:0'])).toMatchObject({ outcome: 'replay-complete', parts: replayCompleteParts(1, 3) })
    expect(entryAt(missed, ['1:1'])).toMatchObject({
      outcome: 'replay-stopped',
      parts: replayStoppedParts(2, 3, 'descriptor-missing'),
    })
    allThreeListsNone(missed, ['1:0'])
  })

  it('REPLAY-PER-FLOW: a test that ends after one body step is its own entry; two complete flows are one', () => {
    const view = effectSectionView(projection([
      ...[0, 1, 2].map(index => step(index, { planSource: login(PASSED, index) }, 0)),
      step(0, { planSource: login(PASSED, 0) }, 1),
      ...[0, 1, 2].map(index => step(index, { planSource: login(PASSED, index) }, 2)),
    ]))

    expect(view.entries).toHaveLength(2)
    expect(entryAt(view, ['0:0', '0:1', '0:2', '2:0', '2:1', '2:2'])).toMatchObject({
      outcome: 'replay-complete',
      parts: replayCompleteParts(3, 3),
    })
    expect(entryAt(view, ['1:0'])).toMatchObject({ outcome: 'replay-complete', parts: replayCompleteParts(1, 3) })
    allThreeListsNone(view, ['1:0'])
  })

  it('REPLAY-PER-FLOW: inside one test a fresh match after a completed flow is its own flow', () => {
    const view = effectSectionView(projection([
      ...[0, 1, 2].map(index => step(index, { planSource: login(PASSED, index) })),
      step(3, { planSource: login(PASSED, 0) }),
      step(4, { planSource: login(DENIED, 1) }),
    ]))

    expect(view.entries).toHaveLength(2)
    expect(entryAt(view, ['0:0', '0:1', '0:2'])).toMatchObject({ outcome: 'replay-complete', parts: replayCompleteParts(3, 3) })
    expect(entryAt(view, ['0:3'])).toMatchObject({ outcome: 'replay-complete', parts: replayCompleteParts(1, 3) })
    allThreeListsNone(view, ['0:3'])
  })
})

describe('an unsettled or unreadable fold is re-worded, never re-derived (loading / error)', () => {
  it('EFFECT-PENDING: while curation is pending or running every trial entry is pending, attributed or not', () => {
    for (const status of ['pending', 'running'] as const) {
      const view = effectSectionView(projection(
        [step(0, { channel1: [trial('rec_a', 'first trial'), trial('rec_b', 'second trial')] })],
        { status, attributions: [attributed('rec_a', 0, 'harmful')] },
      ))

      expect(summary(view)).toEqual([['first trial', 'pending'], ['second trial', 'pending']])
      expect(view.entries.every(entry => entry.tone === 'pending')).toBe(true)
      expect(view.uncounted).toBeUndefined()
    }
  })

  it('EFFECT-UNKNOWN: settled with an incomplete store read, an unattributed trial is unknown', () => {
    const view = effectSectionView(projection([step(0, { channel1: [trial('rec_k', 'could not be checked')] })], { scanIncomplete: true }))

    expect(summary(view)).toEqual([['could not be checked', 'unknown']])
    expect(view.entries[0]?.tone).toBe('unknown')
    expect(view.uncounted).toBeUndefined()
  })
})

describe('the closing line counts the rest', () => {
  it('UNMEASURED-LINE: 4 used records, 1 entry, 1 uncounted leaves 2 unmeasured', () => {
    const view = effectSectionView(projection(
      [
        step(0, {
          channel1: [trial('rec_e', 'the measured one'), trial('rec_n', 'the uncounted one'), line('rec_o', 'a plain line')],
          channel3: [{ id: 'rec_c', summary: 'a caution' }],
        }),
      ],
      { attributions: [attributed('rec_e', 0, 'helpful')] },
    ))

    expect(view.entries).toHaveLength(1)
    expect(view.uncounted).toEqual({ count: 1, line: uncountedTrialsLine(1) })
    expect(view.unmeasured).toEqual({ count: 2, line: unmeasuredRecordsLine(2) })
  })

  it('UNMEASURED-LINE: with no entries there is no closing line, and nothing used reads the nothing-used sentence', () => {
    const measuredNothing = effectSectionView(projection([step(0, { channel1: [line('rec_o', 'a plain line')] })]))
    expect(measuredNothing.entries).toEqual([])
    expect(measuredNothing.unmeasured).toBeUndefined()
    expect(measuredNothing.absence).toBe(EFFECT_NOTHING_MEASURED_TEXT)

    const usedNothing = effectSectionView(projection([step(0, {})]))
    expect(usedNothing.absence).toBe(EFFECT_NOTHING_USED_TEXT)
    expect(usedNothing.unmeasured).toBeUndefined()
    expect(usedNothing.uncounted).toBeUndefined()
  })

  it('UNMEASURED-LINE: the singular and plural forms', () => {
    expect(unmeasuredRecordsLine(1)).toBe('1 other record has no measured effect.')
    expect(unmeasuredRecordsLine(3)).toBe('3 other records have no measured effect.')
  })

  it('UNMEASURED-LINE: the ready arm carries this same view', () => {
    const read = projection(
      [step(0, { channel1: [trial('rec_e', 'the measured one'), line('rec_o', 'a plain line')] })],
      { attributions: [attributed('rec_e', 0, 'confirmed')] },
    )
    const view = projectKnowledgeView({ kind: 'read', projection: read })
    if (view.state !== 'ready') throw new Error('expected a ready view')
    expect(view.effect).toEqual(effectSectionView(read))
  })
})

describe('each outcome reads as a plain sentence with its steps', () => {
  it('EFFECT-SENTENCES: the pinned wording for every outcome', () => {
    const at = 'step 2'
    expect(effectSentenceText(EFFECT_SENTENCES.contradicted, at)).toBe("Didn't hold up in step 2 — the run saw something different")
    expect(effectSentenceText(EFFECT_SENTENCES.harmful, at)).toBe('Misled the agent in step 2')
    expect(effectSentenceText(EFFECT_SENTENCES.confirmed, at)).toBe('Held up in step 2 — the run saw the same thing')
    expect(effectSentenceText(EFFECT_SENTENCES.helpful, at)).toBe('Helped in step 2')
    expect(effectSentenceText(EFFECT_SENTENCES.pending, at)).toBe('On trial in step 2 — waiting for post-run processing')
    expect(effectSentenceText(EFFECT_SENTENCES.unknown, at)).toBe("Couldn't be checked in step 2 — part of the knowledge store couldn't be read")
    expect(effectSentenceText(replayCompleteParts(6, 6), at)).toBe('Replayed all 6 of its steps in step 2')
    expect(effectSentenceText(replayCompleteParts(2, 6), at)).toBe('Replayed 2 of its 6 steps in step 2')
    expect(effectSentenceText(replayCompleteParts(1, 1), at)).toBe('Replayed its only step in step 2')
    expect(effectSentenceText(replayCompleteParts(undefined, undefined), at))
      .toBe('Replayed in step 2 — every replayed action was accepted')
    expect(effectSentenceText(replayStoppedParts(3, 6, 'descriptor-missing'), at))
      .toBe("Replay stopped at its step 3 of 6 in step 2: the element wasn't found")
    expect(effectSentenceText(replayStoppedParts(1, 1, 'gate-refused'), at))
      .toBe('Replay stopped at its only step in step 2: a safety check refused the action')
    expect(effectSentenceText(replayStoppedParts(4, undefined, 'verifier-rejection'), at))
      .toBe("Replay stopped at its step 4 in step 2: the result didn't pass verification")
    expect(effectSentenceText(replayStoppedParts(4, 1, 'descriptor-missing'), at))
      .toBe("Replay stopped at its step 4 in step 2: the element wasn't found")
  })

  it('EFFECT-SENTENCES: the uncounted line and its tooltip say no reason beyond the fixed sentence', () => {
    expect(uncountedTrialsLine(1)).toBe("1 record on trial wasn't counted for or against by this run")
    expect(uncountedTrialsLine(2)).toBe("2 records on trial weren't counted for or against by this run")
    expect(UNCOUNTED_TRIALS_TOOLTIP).toBe("Post-run processing finished without counting this run's result toward it.")
  })
})
