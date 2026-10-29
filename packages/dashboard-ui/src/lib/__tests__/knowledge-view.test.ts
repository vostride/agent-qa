// THE KNOWLEDGE PROJECTION, HELD TOTAL AND PURE.
//
// `projectKnowledgeView` is the whole distance between what `runs.knowledge` said and what a
// person reads in the Knowledge tab. It takes a `KnowledgeRead` — the client's own bytes — and
// returns a view; it has no I/O, no clock and no React in its signature, so a state the panel
// paints can never be one the op did not say.
//
// THE CELLS FIX THE PUBLISHED SENTENCES BY THEIR EXPORTED CONSTANTS, never by
// literal prose. Copy moves in one place and the tests move with it; prose inlined in a component
// is prose that drifts from prose inlined in a test, and both of them stay green while the two
// disagree.
//
// THE CELLS THAT MATTER MOST are the absence ones. D-03's summary line omits a zero segment, so
// "every segment zero" and "no steps at all" are two DIFFERENT sentences: the first says
// retrieval ran and served nothing, the second says this run has no briefed step to describe.
// Collapsing them would tell a reader the store is empty when in fact nothing asked it anything.

import { describe, expect, it } from 'vitest'
import {
  CurationSnapshotSchema,
  TRACE_TRUNCATION_TOP_K,
  formatEntityUri,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CurationBreakdown,
  RecordChange,
  RunKnowledgeCanaryAttribution,
  RunKnowledgeProjection,
  RunKnowledgeStep,
  TraceLine,
} from '@vostride/agent-qa-schema'
import { RETRIEVAL_RUNG_REASONS, RETRIEVAL_RUNGS } from '@vostride/agent-qa-schema'

import type { KnowledgeRead } from '@/lib/api'
import {
  BREAKDOWN_NOT_RECORDED_TEXT,
  BREAKDOWN_WITHHELD_TEXT,
  COUNTS_NOT_RECORDED_TEXT,
  NO_MEMORY_CHANGES_TEXT,
  curationBreakdownLine,
  legacyCurationPairText,
} from '@/lib/post-processing-view'
import {
  ATTRIBUTION_PENDING_TEXT,
  ATTRIBUTION_UNKNOWN_TEXT,
  BROKE_CAUSE_LABELS,
  CANARY_BADGE_TEXT,
  NO_MEMORY_CHANGES_SENTENCE,
  CHANGES_NOT_AVAILABLE_TEXT,
  CHANGES_UNREADABLE_TEXT,
  CHANNEL_PAGE_SIZE,
  COUNTS_NOT_RECORDED_SENTENCE,
  CURATION_FAILED_PARTIAL_TEXT,
  CURATION_FAILED_TEXT,
  CHANGES_PENDING_TEXT,
  LEARNED_CHANGE_KINDS,
  MEMORY_CHANGES_HEADING,
  NOT_ATTRIBUTED_TEXT,
  NO_BRIEF_LINES_TEXT,
  NO_BRIEF_SERVED_TEXT,
  NO_STORE_BODY,
  NO_STORE_HEADING,
  PROCEDURE_HINT_DEMOTED_TEXT,
  PROCEDURE_HINT_TEXT,
  PRE_TRACE_TEXT,
  READ_FAILED_HEADING,
  RECONCILIATION_UNATTRIBUTED_TEXT,
  RECORD_CONTENT_NOT_RECORDED_LEAD,
  REPLAY_FACT,
  HINT_FACT,
  STEP_NOT_FOUND_TEXT,
  STEP_NO_BRIEF_TEXT,
  STORE_READ_INCOMPLETE_TEXT,
  USED_HEADING,
  CHANNEL_EYEBROWS,
  DOCTOR_HINT_TEXT,
  DOCTOR_POINTER_TEXT,
  RUNG_CAUSE_LABELS,
  RUNG_LABELS,
  bannerRung,
  briefLineViews,
  briefLinesFact,
  brokeAtText,
  canaryFact,
  canaryOutcomeWord,
  changeLedgerViews,
  channelPage,
  cutCandidates,
  cutCandidatesLabel,
  learnedView,
  planSourceSentence,
  planSourceView,
  projectKnowledgeView,
  readFailedBody,
  reconciliationCountText,
  replayedText,
  retrievalStatement,
  rungBannerText,
  showAllLinesLabel,
  stepRowTitle,
  traceLineText,
  usedSummaryLine,
} from '@/lib/knowledge-view'

const RUN_ID = 'r_knowledge_view'

/** One projected step, with everything absent unless a cell asks for it. */
function step(overrides: Partial<RunKnowledgeStep> = {}): RunKnowledgeStep {
  return {
    testId: 't_one',
    testIndex: 0,
    stepIndex: 0,
    stepText: 'click checkout',
    served: { channel1: [], channel2: [], channel3: [] },
    trace: { kind: 'no-trace', reason: 'pre-trace-run' },
    ...overrides,
  } as RunKnowledgeStep
}

/** One channel-1 brief line; `servedAsCanary` is the only field any cell here varies. */
function briefLine(servedAsCanary = false, id = 'rec_1'): RunKnowledgeStep['served']['channel1'][number] {
  return {
    id,
    kind: 'fact',
    summary: 'the cart page lives at /view_cart',
    trust: 0.9,
    status: 'active',
    servedAsCanary,
    tier: 'confirmed',
  }
}

function ready(overrides: Partial<Extract<RunKnowledgeProjection, { kind: 'ready' }>> = {}): KnowledgeRead {
  return {
    kind: 'read',
    projection: {
      kind: 'ready',
      runId: RUN_ID,
      buildOrdinal: 3,
      knowledgeStore: 'bound',
      steps: [],
      curation: { status: 'complete' },
      learned: { changes: [], canaryAttributions: [] },
      ...overrides,
    } as Extract<RunKnowledgeProjection, { kind: 'ready' }>,
  }
}

/** The `ready` arm's per-step ledger (427 D-19 moved it into Retrieval details), narrowed. */
function usedOf(view: ReturnType<typeof projectKnowledgeView>) {
  if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`)
  return view.ledger
}

describe('a failed read is its own state, never an empty panel', () => {
  it('carries the read-failed heading and the masked reason with the doctor pointer', () => {
    const view = projectKnowledgeView({ kind: 'unavailable', error: 'read_failed' })

    expect(view.state).toBe('error')
    if (view.state !== 'error') throw new Error('unreachable')
    expect(view.heading).toBe(READ_FAILED_HEADING)
    expect(view.body).toBe(readFailedBody('read_failed'))
    expect(view.body).toContain('read_failed')
    expect(view.body).toContain('agent-qa doctor')
  })

  it('forwards the producer error VERBATIM — never sliced, never re-worded', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const view = projectKnowledgeView({ kind: 'unavailable', error: hostile })

    if (view.state !== 'error') throw new Error('unreachable')
    expect(view.body.startsWith(hostile)).toBe(true)
  })
})

describe('a pruned handoff is a legible state, not a refusal', () => {
  it('projects evidence-incomplete with no body of its own — the shipped component owns the words', () => {
    const view = projectKnowledgeView({
      kind: 'read',
      projection: { kind: 'evidence-incomplete', runId: RUN_ID },
    })

    expect(view).toEqual({ state: 'evidence-incomplete' })
  })
})

describe('no knowledge reader bound is not a rung, it is a state', () => {
  it('projects empty-no-store from knowledgeStore: unbound, whatever the steps say', () => {
    const view = projectKnowledgeView(ready({ knowledgeStore: 'unbound', steps: [step()] }))

    expect(view.state).toBe('empty-no-store')
    if (view.state !== 'empty-no-store') throw new Error('unreachable')
    expect(view.heading).toBe(NO_STORE_HEADING)
    expect(view.body).toBe(NO_STORE_BODY)
    expect(NO_STORE_HEADING).toBe('No knowledge store configured for this project')
  })
})

describe('the Used summary is DERIVED from the rows the panel already holds', () => {
  it('reads the sentence of record with every segment present, joined by a middot', () => {
    const summary = usedSummaryLine({ stepsBriefed: 12, canaryLines: 4, replays: 1, hints: 2 })

    expect(summary).toBe('12 steps briefed · 4 canary lines served · 1 procedure replay, 2 hints')
  })

  it('uses the singular form of every segment at one', () => {
    const summary = usedSummaryLine({ stepsBriefed: 1, canaryLines: 1, replays: 1, hints: 1 })

    expect(summary).toBe('1 step briefed · 1 canary line served · 1 procedure replay, 1 hint')
  })

  it('omits a zero segment rather than printing a zero somebody measured', () => {
    expect(usedSummaryLine({ stepsBriefed: 3, canaryLines: 0, replays: 0, hints: 2 }))
      .toBe('3 steps briefed · 2 hints')
    expect(usedSummaryLine({ stepsBriefed: 0, canaryLines: 2, replays: 3, hints: 0 }))
      .toBe('2 canary lines served · 3 procedure replays')
  })

  it('says nothing was served when every segment is zero — never an empty line', () => {
    expect(usedSummaryLine({ stepsBriefed: 0, canaryLines: 0, replays: 0, hints: 0 }))
      .toBe(NO_BRIEF_LINES_TEXT)
  })

  it('counts a step as briefed when ANY of its three channels carried a line', () => {
    const view = projectKnowledgeView(ready({
      steps: [
        step({ stepIndex: 0, served: { channel1: [briefLine()], channel2: [], channel3: [] } }),
        step({ stepIndex: 1, served: { channel1: [], channel2: [], channel3: [{ id: 'c1', summary: 'slow page' }] } }),
        step({ stepIndex: 2 }),
      ],
    }))

    expect(usedOf(view).summary).toBe('2 steps briefed')
  })

  it('counts canary lines served across every step, not steps that served one', () => {
    const view = projectKnowledgeView(ready({
      steps: [
        step({ stepIndex: 0, served: { channel1: [briefLine(true), briefLine(true)], channel2: [], channel3: [] } }),
        step({ stepIndex: 1, served: { channel1: [briefLine(true)], channel2: [], channel3: [] } }),
      ],
    }))

    expect(usedOf(view).summary).toBe('2 steps briefed · 3 canary lines served')
  })

  it('says NO BRIEF WAS SERVED — a different sentence — when the run has no steps at all', () => {
    const view = projectKnowledgeView(ready({ steps: [] }))

    expect(usedOf(view).summary).toBe(NO_BRIEF_SERVED_TEXT)
    expect(NO_BRIEF_SERVED_TEXT).not.toBe(NO_BRIEF_LINES_TEXT)
    expect(usedOf(view).steps).toEqual([])
  })
})

describe('one row per step, whatever the row served', () => {
  it('titles a row by its ONE-BASED ordinal and the step text', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({ stepIndex: 2, stepText: 'click checkout' })],
    }))

    expect(usedOf(view).steps[0].title).toBe('Step 3 — click checkout')
    expect(stepRowTitle(2, 'click checkout')).toBe('Step 3 — click checkout')
  })

  it('carries both indices, because stepIndex is numbered PER MEMBER TEST', () => {
    const view = projectKnowledgeView(ready({
      steps: [
        step({ testIndex: 0, stepIndex: 0 }),
        step({ testId: 't_two', testIndex: 1, stepIndex: 0 }),
      ],
    }))

    const rows = usedOf(view).steps
    expect(rows.map(r => [r.testIndex, r.stepIndex])).toEqual([[0, 0], [1, 0]])
  })

  it('badges a briefed row with its line counts and marks no plan source', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({
        served: { channel1: [briefLine(true), briefLine()], channel2: [], channel3: [] },
      })],
    }))

    const row = usedOf(view).steps[0]
    expect(row.briefLines).toBe(2)
    expect(row.canaryLines).toBe(1)
    expect(row.planSource).toBe('none')
    expect(row.facts).toEqual([briefLinesFact(2), canaryFact(1)])
    expect(row.noBrief).toBeUndefined()
  })

  it('uses the singular brief-line fact at one', () => {
    expect(briefLinesFact(1)).toBe('1 brief line')
    expect(briefLinesFact(4)).toBe('4 brief lines')
    expect(canaryFact(1)).toBe('1 canary')
  })

  it('states a replay row as a replay, and a hint row as a hint', () => {
    const view = projectKnowledgeView(ready({
      steps: [
        step({
          stepIndex: 0,
          served: { channel1: [briefLine()], channel2: [], channel3: [] },
          planSource: { kind: 'procedure-replay', procedureId: 'p_1', guard: { checksPassed: 5, total: 5 } },
        }),
        step({
          stepIndex: 1,
          served: { channel1: [briefLine()], channel2: [], channel3: [] },
          planSource: { kind: 'procedure-hint', procedureId: 'p_2', demotion: 'body-empty' },
        }),
      ],
    }))

    const [replay, hint] = usedOf(view).steps
    expect(replay.planSource).toBe('procedure-replay')
    expect(replay.facts).toContain(REPLAY_FACT)
    expect(hint.planSource).toBe('procedure-hint')
    expect(hint.facts).toContain(HINT_FACT)
    expect(usedOf(view).summary).toBe('2 steps briefed · 1 procedure replay, 1 hint')
  })

  it('marks a step that served nothing rather than dropping the row', () => {
    const view = projectKnowledgeView(ready({ steps: [step()] }))

    const row = usedOf(view).steps[0]
    expect(row.noBrief).toBe(true)
    expect(row.facts).toEqual([])
    expect(row.briefLines).toBe(0)
    expect(usedOf(view).summary).toBe(NO_BRIEF_LINES_TEXT)
  })
})

describe('the recorded rung rides the view when the evidence recorded one', () => {
  it('carries the rung and its cause through untouched', () => {
    const view = projectKnowledgeView(ready({
      steps: [step()],
      retrievalRung: { schemaVersion: 2, rung: 'static-floor', reason: 'native-runtime-unavailable' },
    }))

    if (view.state !== 'ready') throw new Error('unreachable')
    expect(view.rung).toEqual({ rung: 'static-floor', reason: 'native-runtime-unavailable' })
  })

  it('leaves the rung ABSENT — not null — when the run recorded none', () => {
    const view = projectKnowledgeView(ready({ steps: [step()] }))

    if (view.state !== 'ready') throw new Error('unreachable')
    expect(view.rung).toBeUndefined()
    expect('rung' in view).toBe(false)
  })
})

describe('absence is an absent key, everywhere (the layer idiom)', () => {
  it('never puts a null anywhere in any arm of the view', () => {
    const views = [
      projectKnowledgeView({ kind: 'unavailable', error: 'boom' }),
      projectKnowledgeView({ kind: 'read', projection: { kind: 'evidence-incomplete', runId: RUN_ID } }),
      projectKnowledgeView(ready({ knowledgeStore: 'unbound' })),
      projectKnowledgeView(ready({ steps: [] })),
      projectKnowledgeView(ready({
        steps: [step({ served: { channel1: [briefLine(true)], channel2: [], channel3: [] } })],
        retrievalRung: { schemaVersion: 2, rung: 'lexical-only', reason: 'floor-disabled' },
      })),
    ]

    for (const view of views) {
      expect(JSON.stringify(view)).not.toContain('null')
    }
  })
})

describe('the reserved copy the expansion plans consume is published NOW', () => {
  it('names the three channel eyebrows exactly as the contract spells them', () => {
    expect(CHANNEL_EYEBROWS).toEqual({
      1: 'CHANNEL 1 · BRIEF',
      2: 'CHANNEL 2 · READ TRACES',
      3: 'CHANNEL 3 · CAUTIONS',
    })
  })

  it('renders a trace line with its score to three decimal places', () => {
    expect(traceLineText('dense', 2, 0.5)).toBe('leg dense · rank 2 · score 0.500')
  })

  it('labels the cut-candidates ledger from the PRODUCER cap, never a typed 20', () => {
    expect(cutCandidatesLabel(3)).toBe(`Cut candidates (3 of top ${String(TRACE_TRUNCATION_TOP_K)})`)
    expect(TRACE_TRUNCATION_TOP_K).toBe(20)
  })

  it('gives every no-trace arm and every half heading its own sentence', () => {
    expect(PRE_TRACE_TEXT).toBe('no trace was captured for this run')
    expect(STEP_NOT_FOUND_TEXT).toBe('no evidence recorded for this step')
    expect(STEP_NO_BRIEF_TEXT).toBe('no brief served')
    expect(USED_HEADING).toBe('Knowledge used')
    expect(MEMORY_CHANGES_HEADING).toBe('Memory changes')
    expect(new Set([PRE_TRACE_TEXT, STEP_NOT_FOUND_TEXT, STEP_NO_BRIEF_TEXT]).size).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// the Used half in full: the per-line why-trace, the cut ledger, the
// canary outcome word, the replay/hint sentence and the channel page.
// ─────────────────────────────────────────────────────────────────────────────

/** One answered trace, carrying whatever served/cut ledgers a cell hands it. */
function answered(
  servedLines: readonly TraceLine[] = [],
  truncated: readonly TraceLine[] = [],
): RunKnowledgeStep['trace'] {
  return {
    kind: 'answered',
    trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [...servedLines], truncated: [...truncated] },
  }
}

function traceLine(recordId: string, over: Partial<TraceLine> = {}): TraceLine {
  return { recordId, leg: 'anchor', rank: 1, score: 1.48695, ...over }
}

function attribution(
  over: Partial<RunKnowledgeCanaryAttribution> = {},
): RunKnowledgeCanaryAttribution {
  return {
    testIndex: 0,
    stepIndex: 0,
    recordId: 'rec_1',
    observationId: 'canary-outcome:abc',
    outcome: 'confirmed',
    ...over,
  }
}

/** The one detail of the one row of a ready view — most cells below want exactly this. */
function detailOf(view: ReturnType<typeof projectKnowledgeView>, index = 0) {
  return usedOf(view).steps[index].detail
}

describe('a served line carries the trace answer that explains IT, and nothing it computed', () => {
  it('answers a served line from the trace ledger — leg, rank and score, matched by recordId', () => {
    const lines = briefLineViews(
      step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } }),
      answered([traceLine('rec_a', { leg: 'dense', rank: 4, score: 0.25 })]),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0].why).toEqual({ kind: 'answered', leg: 'dense', rank: 4, score: 0.25 })
  })

  it('forwards the LEG WORD the trace recorded, never a re-worded one', () => {
    for (const leg of ['lexical', 'dense', 'anchor'] as const) {
      const lines = briefLineViews(
        step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } }),
        answered([traceLine('rec_a', { leg })]),
      )
      if (lines[0].why.kind !== 'answered') throw new Error('unreachable')
      expect(lines[0].why.leg).toBe(leg)
    }
  })

  it('maps a line the ANSWERED trace recorded nothing for to the step-not-found arm', () => {
    const lines = briefLineViews(
      step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } }),
      answered([traceLine('rec_other')]),
    )

    expect(lines[0].why).toEqual({ kind: 'no-trace', reason: 'step-not-found' })
  })

  it('gives EVERY line the step trace\'s own reason, verbatim, when the step has no trace', () => {
    for (const reason of ['pre-trace-run', 'artifact-missing', 'step-not-found'] as const) {
      const lines = briefLineViews(
        step({
          served: { channel1: [briefLine(false, 'rec_a'), briefLine(false, 'rec_b')], channel2: [], channel3: [] },
        }),
        { kind: 'no-trace', reason },
      )
      expect(lines.map(line => line.why)).toEqual([
        { kind: 'no-trace', reason },
        { kind: 'no-trace', reason },
      ])
    }
  })

  it('has exactly TWO kinds of why — answered, and a named absence', () => {
    const kinds = new Set([
      ...briefLineViews(
        step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } }),
        answered([traceLine('rec_a')]),
      ).map(line => line.why.kind),
      ...briefLineViews(
        step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } }),
        { kind: 'no-trace', reason: 'pre-trace-run' },
      ).map(line => line.why.kind),
    ])

    expect(kinds).toEqual(new Set(['answered', 'no-trace']))
  })

  it('keeps the served line\'s own fields beside the why — the panel paints one object', () => {
    const lines = briefLineViews(
      step({ served: { channel1: [briefLine(true, 'rec_a')], channel2: [], channel3: [] } }),
      answered([traceLine('rec_a')]),
    )

    expect(lines[0].id).toBe('rec_a')
    expect(lines[0].summary).toBe('the cart page lives at /view_cart')
    expect(lines[0].servedAsCanary).toBe(true)
  })
})

describe('the cut ledger is the answer to "why did it NOT say X"', () => {
  it('labels the ledger from the producer cap and carries the cut lines through', () => {
    const cut = cutCandidates(answered([], [traceLine('rec_x'), traceLine('rec_y'), traceLine('rec_z')]))

    expect(cut).toEqual({
      label: cutCandidatesLabel(3),
      lines: [traceLine('rec_x'), traceLine('rec_y'), traceLine('rec_z')],
    })
    expect(cut?.label).toBe(`Cut candidates (3 of top ${String(TRACE_TRUNCATION_TOP_K)})`)
  })

  it('has NO ledger at all when the step has no trace — an empty one would claim nothing was cut', () => {
    expect(cutCandidates({ kind: 'no-trace', reason: 'artifact-missing' })).toBeUndefined()
  })

  it('keeps the ledger on an answered trace that truncated nothing — zero cut IS a recorded fact', () => {
    expect(cutCandidates(answered([traceLine('rec_a')]))).toEqual({
      label: cutCandidatesLabel(0),
      lines: [],
    })
  })
})

describe('a canary line is never blank — it says pending, not-attributed, or the outcome', () => {
  it('says PENDING while curation has not settled, whatever the attributions hold', () => {
    expect(canaryOutcomeWord('pending', attribution())).toBe('pending')
    expect(canaryOutcomeWord('running', undefined)).toBe('pending')
  })

  it('says the attributed OUTCOME WORD once curation is complete', () => {
    for (const outcome of ['confirmed', 'contradicted', 'helpful', 'harmful'] as const) {
      expect(canaryOutcomeWord('complete', attribution({ outcome }))).toBe(outcome)
    }
  })

  it('says NOT-ATTRIBUTED when curation is complete and nothing was attributed to this line', () => {
    expect(canaryOutcomeWord('complete', undefined)).toBe('not-attributed')
  })

  /**
   * THE OWNER'S RULING, 2026-08-30 (UAT item 11 · G-407-11 · REVIEW CR-01).
   *
   * A ROW THE STORE SERVED IS AN ANSWER, AND A CHAIN THAT FELL OVER CANNOT UN-APPEND IT. The
   * curation job's fate is reported by the chip beside this line; printing `not attributed` here
   * as well is a SECOND, DIFFERENT claim — that the store was consulted and said no — made while
   * the same projection holds the row that disproves it. From 407-06 (`a795316e`) to 407-21 the
   * row arm was gated `curationStatus === 'done'`, and the domain being exactly
   * {pending, running, done, failed} that conjunct's ONLY effect was to route this cell past the
   * row it had already been handed.
   */
  it('lets a SERVED ROW beat a FAILED chain — a fold that fell over cannot un-commit an outcome it appended', () => {
    for (const outcome of ['confirmed', 'contradicted', 'helpful', 'harmful'] as const) {
      expect(canaryOutcomeWord('failed', attribution({ outcome }))).toBe(outcome)
    }
  })

  it('says NOT-ATTRIBUTED for a FAILED chain with NO row on a CLEAN read — the walk finished and found nothing', () => {
    expect(canaryOutcomeWord('failed', undefined)).toBe('not-attributed')
    expect(canaryOutcomeWord('failed', undefined, false)).toBe('not-attributed')
  })

  /**
   * REVIEW WR-02 — `not attributed` IS A POSITIVE CLAIM, AND A PARTIAL READ CANNOT MAKE IT.
   *
   * When the store scan is incomplete the op ships `canaryAttributions: []`, so every served
   * canary line read `not attributed` — the store was consulted and said no — while the very same
   * projection was telling the Learned half that nobody could look. `unknown` is the absence of an
   * answer, which is what a partial read actually produced.
   */
  it('says UNKNOWN, not NOT-ATTRIBUTED, when the read that would have answered was partial', () => {
    expect(canaryOutcomeWord('complete', undefined, true)).toBe('unknown')
    // The default keeps every existing caller green, and says the same thing explicitly.
    expect(canaryOutcomeWord('complete', undefined)).toBe('not-attributed')
    expect(canaryOutcomeWord('complete', undefined, false)).toBe('not-attributed')
  })

  it('lets a row that WAS read win over the flag — rows beat degradation here as on the other half', () => {
    for (const outcome of ['confirmed', 'contradicted', 'helpful', 'harmful'] as const) {
      expect(canaryOutcomeWord('complete', attribution({ outcome }), true)).toBe(outcome)
    }
  })

  it('reads the UNSETTLED chain first even on a partial read — pending is still the answer', () => {
    expect(canaryOutcomeWord('pending', undefined, true)).toBe('pending')
    expect(canaryOutcomeWord('running', attribution(), true)).toBe('pending')
  })

  it('honours a served row on a FAILED chain over a PARTIAL read too — the row is the one measured fact of the three', () => {
    for (const outcome of ['confirmed', 'contradicted', 'helpful', 'harmful'] as const) {
      expect(canaryOutcomeWord('failed', attribution({ outcome }), true)).toBe(outcome)
    }
  })

  /**
   * THE SUB-QUESTION THE RULING LEFT OPEN, ANSWERED THE SAME WAY WR-02 ANSWERED IT FOR `done`.
   *
   * The review's own fix sketch kept a `failed` arm ahead of the flag and so answered
   * `not-attributed` here. We answer `unknown` instead: with the walk incomplete NOBODY
   * established that nothing was attributed, so the positive claim is simply unavailable — and
   * the chain's failure is evidence about the CHAIN, not about how much of the store could be
   * read. That is 407-18/WR-02's argument verbatim, applied to the arm this ruling re-opened.
   */
  it('says UNKNOWN for a FAILED chain with no row over a PARTIAL read — nobody could finish looking', () => {
    expect(canaryOutcomeWord('failed', undefined, true)).toBe('unknown')
  })

  it('draws the line between the two words in the published copy, not in a component', () => {
    expect(ATTRIBUTION_UNKNOWN_TEXT).toBe('attribution unknown')
    expect(ATTRIBUTION_UNKNOWN_TEXT).not.toBe(NOT_ATTRIBUTED_TEXT)
  })

  /**
   * `unknown` IS NOW REACHABLE FROM TWO COMBINATIONS, AND THE SWEEP SAYS SO RATHER THAN LOOSENING.
   *
   * 407-22 moved the second one in (`failed` + no row + partial read), so the assertion states the
   * PREDICATE the word answers to — settled chain, no row, partial read — instead of naming one
   * status. A cell per arm proves each arm answers; only the sweep proves no OTHER combination
   * leaks into `unknown`, which is the way a widened vocabulary usually goes wrong.
   */
  it('reaches `unknown` only where the chain SETTLED, no row was served and the read was partial — from either settled word', () => {
    const words = new Set<string>()

    for (const status of ['pending', 'running', 'failed', 'complete'] as const) {
      for (const row of [undefined, attribution()]) {
        for (const partial of [false, true]) {
          const word = canaryOutcomeWord(status, row, partial)
          if (word === 'unknown') {
            expect(status === 'complete' || status === 'failed').toBe(true)
            expect(row).toBeUndefined()
            expect(partial).toBe(true)
          }
          expect(word).not.toBe('')
          words.add(word)
        }
      }
    }

    expect(words.has('unknown')).toBe(true)
    expect([...words].sort()).toEqual(['confirmed', 'not-attributed', 'pending', 'unknown'])
  })
})

describe('a replay states its guard outcome and a hint states its demotion', () => {
  it('reads replayed n/n when every check passed and nothing broke', () => {
    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: { checksPassed: 5, total: 5 },
    })).toBe(replayedText(5, 5))
    expect(replayedText(5, 5)).toBe('replayed 5/5')
  })

  it('names the broken step ONE-BASED, with the cause word the contract spells', () => {
    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: { checksPassed: 2, total: 5, miss: { procedureStepIndex: 2, reason: 'gate-refused' } },
    })).toBe('broke at step 3: miss')

    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: { checksPassed: 1, total: 5, executionFailure: { procedureStepIndex: 1 } },
    })).toBe('broke at step 2: adapter failure')

    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: { checksPassed: 3, total: 5, verifierRejection: { procedureStepIndex: 3 } },
    })).toBe('broke at step 4: verifier rejection')
  })

  it('breaks at the FIRST cause in precedence order — miss, then adapter, then verifier', () => {
    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: {
        checksPassed: 0,
        total: 5,
        miss: { procedureStepIndex: 0, reason: 'descriptor-missing' },
        executionFailure: { procedureStepIndex: 1 },
        verifierRejection: { procedureStepIndex: 2 },
      },
    })).toBe(brokeAtText(1, 'miss'))
  })

  it('does NOT read replayed n/n when a guard member broke, even at full checksPassed', () => {
    expect(planSourceSentence({
      kind: 'procedure-replay',
      procedureId: 'p_1',
      guard: { checksPassed: 5, total: 5, verifierRejection: { procedureStepIndex: 4 } },
    })).toBe('broke at step 5: verifier rejection')
  })

  it('says procedure hint, and says so it was DEMOTED when the evidence recorded a demotion', () => {
    expect(planSourceSentence({ kind: 'procedure-hint', procedureId: 'p_2' })).toBe(PROCEDURE_HINT_TEXT)
    expect(planSourceSentence({ kind: 'procedure-hint', procedureId: 'p_2', demotion: 'body-empty' }))
      .toBe(PROCEDURE_HINT_DEMOTED_TEXT)
    expect(PROCEDURE_HINT_TEXT).toBe('procedure hint')
    expect(PROCEDURE_HINT_DEMOTED_TEXT).toBe('procedure hint (demoted from replay)')
  })

  it('tones the row ok, broke or hint — the three looks the UI-SPEC colours', () => {
    expect(planSourceView({
      kind: 'procedure-replay', procedureId: 'p', guard: { checksPassed: 2, total: 2 },
    })).toEqual({ kind: 'procedure-replay', procedureId: 'p', sentence: 'replayed 2/2', tone: 'ok' })

    expect(planSourceView({
      kind: 'procedure-replay',
      procedureId: 'p',
      guard: { checksPassed: 0, total: 2, miss: { procedureStepIndex: 0, reason: 'gate-refused' } },
    })).toEqual({
      kind: 'procedure-replay',
      procedureId: 'p',
      sentence: 'broke at step 1: miss',
      tone: 'broke',
      missReason: 'gate-refused',
    })

    expect(planSourceView({ kind: 'procedure-hint', procedureId: 'p' }))
      .toEqual({ kind: 'procedure-hint', procedureId: 'p', sentence: PROCEDURE_HINT_TEXT, tone: 'hint' })
  })

  it('names the three broke causes exactly as the Copywriting Contract spells them', () => {
    expect(BROKE_CAUSE_LABELS).toEqual({
      miss: 'miss',
      executionFailure: 'adapter failure',
      verifierRejection: 'verifier rejection',
    })
  })
})

describe('a long channel shows a page, and says how many it is holding back', () => {
  it('shows every line and holds nothing back at or below the page size', () => {
    const lines = Array.from({ length: CHANNEL_PAGE_SIZE }, (_, i) => `line ${String(i)}`)
    const page = channelPage(lines)

    expect(page.lines).toHaveLength(CHANNEL_PAGE_SIZE)
    expect(page.hiddenCount).toBeUndefined()
    expect(page.showAllLabel).toBeUndefined()
    expect(CHANNEL_PAGE_SIZE).toBe(50)
  })

  it('shows the first 50 and offers the WHOLE count in the trigger, not the hidden one', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i)}`)
    const page = channelPage(lines)

    expect(page.lines).toHaveLength(50)
    expect(page.lines[49]).toBe('line 49')
    expect(page.hiddenCount).toBe(10)
    expect(page.showAllLabel).toBe(showAllLinesLabel(60))
    expect(showAllLinesLabel(60)).toBe('Show all 60 lines')
  })
})

describe('the projection joins the trace, the ledger, the outcome and the plan source per step', () => {
  it('builds one detail per step, with the three channels the op recorded', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({
        served: {
          channel1: [briefLine(false, 'rec_a')],
          channel2: [{ id: 'rec_b', detailLevel: 'full', bodyDigest: 'sha256:b' }],
          channel3: [{ id: 'rec_c', summary: 'this page is slow' }],
        },
        trace: answered([traceLine('rec_a', { leg: 'lexical', rank: 2, score: 0.5 })]),
      })],
    }))

    const detail = detailOf(view)
    expect(detail.channel1.map(l => l.id)).toEqual(['rec_a'])
    expect(detail.channel1[0].why).toEqual({ kind: 'answered', leg: 'lexical', rank: 2, score: 0.5 })
    expect(detail.channel2).toEqual([{ id: 'rec_b', detailLevel: 'full', bodyDigest: 'sha256:b' }])
    expect(detail.channel3).toEqual([{ id: 'rec_c', summary: 'this page is slow' }])
  })

  it('joins the canary outcome on testIndex, stepIndex AND recordId — all three, or none', () => {
    const view = projectKnowledgeView(ready({
      steps: [
        step({
          testIndex: 0,
          stepIndex: 0,
          served: { channel1: [briefLine(true, 'rec_a')], channel2: [], channel3: [] },
        }),
        step({
          testIndex: 1,
          stepIndex: 0,
          served: { channel1: [briefLine(true, 'rec_a')], channel2: [], channel3: [] },
        }),
      ],
      curation: { status: 'complete' },
      learned: {
        changes: [],
        canaryAttributions: [attribution({ testIndex: 0, stepIndex: 0, recordId: 'rec_a', outcome: 'helpful' })],
      },
    }))

    expect(detailOf(view, 0).channel1[0].canaryOutcome).toBe('helpful')
    // The SAME record id on a NEIGHBOURING member test is a different served line.
    expect(detailOf(view, 1).channel1[0].canaryOutcome).toBe('not-attributed')
  })

  /**
   * REVIEW WR-02 THROUGH THE WHOLE FOLD. `stepRow`/`stepDetail` are never handed the wire flag,
   * so the Used half denied outcomes the store was never asked for. One member reaches both
   * halves, so both halves say the same thing about the same read.
   */
  it('says UNKNOWN on a served canary line whose store read was partial, not NOT-ATTRIBUTED', () => {
    const partial = {
      steps: [step({ served: { channel1: [briefLine(true, 'rec_a')], channel2: [], channel3: [] } })],
      curation: { status: 'complete' as const },
      learned: { changes: [], canaryAttributions: [], scanIncomplete: true as const },
    }

    expect(detailOf(projectKnowledgeView(ready(partial))).channel1[0].canaryOutcome).toBe('unknown')

    // The SAME projection with a clean read keeps the positive claim it earned.
    expect(detailOf(projectKnowledgeView(ready({
      ...partial,
      learned: { changes: [], canaryAttributions: [] },
    }))).channel1[0].canaryOutcome).toBe('not-attributed')
  })

  it('leaves a non-canary line with NO outcome key at all — never a word it did not earn', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({ served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] } })],
      curation: { status: 'complete' },
    }))

    const line = detailOf(view).channel1[0]
    expect(line.canaryOutcome).toBeUndefined()
    expect('canaryOutcome' in line).toBe(false)
  })

  it('reads the curation word from the projection, so an unsettled chain says pending', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({ served: { channel1: [briefLine(true, 'rec_a')], channel2: [], channel3: [] } })],
      curation: { status: 'running' },
      learned: { changes: [], canaryAttributions: [attribution({ recordId: 'rec_a' })] },
    }))

    expect(detailOf(view).channel1[0].canaryOutcome).toBe('pending')
  })

  it('carries the plan-source row and the cut ledger onto the detail', () => {
    const view = projectKnowledgeView(ready({
      steps: [step({
        served: { channel1: [briefLine(false, 'rec_a')], channel2: [], channel3: [] },
        trace: answered([traceLine('rec_a')], [traceLine('rec_cut')]),
        planSource: { kind: 'procedure-replay', procedureId: 'p_1', guard: { checksPassed: 5, total: 5 } },
      })],
    }))

    const detail = detailOf(view)
    expect(detail.cut?.label).toBe(cutCandidatesLabel(1))
    expect(detail.planSource).toEqual({ kind: 'procedure-replay', procedureId: 'p_1', sentence: 'replayed 5/5', tone: 'ok' })
  })

  it('leaves the cut ledger and the plan source ABSENT — not null — when the step recorded neither', () => {
    const view = projectKnowledgeView(ready({ steps: [step()] }))

    const detail = detailOf(view)
    expect('cut' in detail).toBe(false)
    expect('planSource' in detail).toBe(false)
    expect(JSON.stringify(detail)).not.toContain('null')
  })

  it('gives a step that served nothing an EMPTY detail rather than no detail', () => {
    const view = projectKnowledgeView(ready({ steps: [step()] }))

    expect(detailOf(view)).toEqual({ channel1: [], channel2: [], channel3: [] })
  })
})

describe('the canary and attribution copy is published as constants, like every sentence before it', () => {
  it('spells the canary marker and both unsettled words exactly once', () => {
    expect(CANARY_BADGE_TEXT).toBe('canary')
    expect(ATTRIBUTION_PENDING_TEXT).toBe('attribution pending')
    expect(NOT_ATTRIBUTED_TEXT).toBe('not attributed')
    expect(new Set([CANARY_BADGE_TEXT, ATTRIBUTION_PENDING_TEXT, NOT_ATTRIBUTED_TEXT]).size).toBe(3)
  })

  it('rounds a trace score to three places, so two adjacent candidates stop looking identical', () => {
    expect(traceLineText('anchor', 1, 1.48695)).toBe('leg anchor · rank 1 · score 1.487')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The Learned half
// ─────────────────────────────────────────────────────────────────────────────

/** One record change, with only the fields the Learned half reads varied. */
function change(
  kind: RecordChange['change'],
  recordId = 'fact-cart-page-4ccac',
  overrides: Partial<RecordChange> = {},
): RecordChange {
  return { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change: kind, atOrdinal: 7, ...overrides }
}

/**
 * A recorded snapshot carrying only the member the heading reads.
 *
 * `rows: []` beside a non-zero breakdown is a shape the op never serves. The count-line cells use it
 * because the heading reads `breakdown` alone; since 427 D-15 the ROWS come from `rows`, so a cell
 * about rows builds a schema-valid snapshot with {@link addedSnapshot} instead.
 */
function snapshotOf(breakdown: Partial<CurationBreakdown> = {}) {
  return {
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION as typeof CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [],
    breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0, ...breakdown },
  }
}

/** A schema-valid snapshot of `ids.length` added records, one row each (427 D-15: rows equal counts). */
function addedSnapshot(ids: readonly string[]) {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: ids.map((id, index) => ({
      recordId: id, bucket: 'added', changes: [{ bucket: 'added', change: change('added', id, { atOrdinal: 10 + index }) }],
    })),
    breakdown: { added: ids.length, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
  })
}

/** The Retrieval details entries for the same projection body (427 D-19 part 2). */
function ledgerFrom(
  overrides: Partial<Extract<RunKnowledgeProjection, { kind: 'ready' }>> = {},
) {
  const read = ready(overrides)
  if (read.kind !== 'read' || read.projection.kind !== 'ready') throw new Error('fixture is not ready')
  return changeLedgerViews(read.projection)
}

/** The projection body the Learned half projects from; every cell varies one member of it. */
function learnedFrom(
  overrides: Partial<Extract<RunKnowledgeProjection, { kind: 'ready' }>> = {},
) {
  const read = ready(overrides)
  if (read.kind !== 'read' || read.projection.kind !== 'ready') throw new Error('fixture is not ready')
  return learnedView(read.projection)
}

describe('the promotion projection copies receipt attribution', () => {
  it('preserves the path and complete digest, and keeps historical keys absent', () => {
    // RE-SPELLED 427-08 (D-19 part 2): the receipt now reaches Retrieval details, never the row.
    const promotionReceiptDigest = '0123456789abcdef'.repeat(4)
    const input = {
      curation: { status: 'complete' as const },
      learned: { canaryAttributions: [], changes: [
        change('promoted', 'fact-current', { promotionPath: 'user-sovereign', promotionReceiptDigest }),
        change('promoted', 'fact-historical'),
      ] },
    }
    const entries = ledgerFrom(input)
    expect(entries[0]).toMatchObject({ promotionPath: 'user-sovereign', promotionReceiptDigest })
    expect(entries[1]).not.toHaveProperty('promotionPath')
    expect(entries[1]).not.toHaveProperty('promotionReceiptDigest')
    expect(learnedFrom(input).rows[0]).not.toHaveProperty('promotionPath')
  })
})

/** The ready view, or a named failure: 432-09 cells read that no proposals member survives. */
function readyView(overrides: Partial<Extract<RunKnowledgeProjection, { kind: 'ready' }>> = {}) {
  const view = projectKnowledgeView(ready(overrides))
  if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`)
  return view
}

describe('the Learned half mirrors the curation word and NEVER renders blank', () => {
  it('says deltas are still coming while curation is pending — a sentence, not a spinner', () => {
    const view = learnedFrom({ curation: { status: 'pending' } })
    expect(view.state).toBe('pending')
    expect(view.sentence).toBe(CHANGES_PENDING_TEXT)
    expect(view.rows).toEqual([])
    expect(view.countLine).toBeUndefined()
  })

  it('says the SAME sentence while curation is running — the reader waits on one fact, not two', () => {
    const view = learnedFrom({ curation: { status: 'running' } })
    expect(view.state).toBe('running')
    expect(view.sentence).toBe(CHANGES_PENDING_TEXT)
  })

  it('states the failure outright rather than showing an empty list that reads as "nothing changed"', () => {
    const view = learnedFrom({ curation: { status: 'failed' } })
    expect(view.state).toBe('failed')
    expect(view.sentence).toBe(CURATION_FAILED_TEXT)
    expect(view.rows).toEqual([])
  })

  it('renders no count line while curation is unsettled — counts come only from the frozen row', () => {
    for (const status of ['pending', 'running', 'failed'] as const) {
      expect(learnedFrom({ curation: { status } }).countLine).toBeUndefined()
    }
  })

  it('says the counts were not recorded — never a zero — when a settled row committed none', () => {
    const view = learnedFrom({ curation: { status: 'complete' } })
    expect(view.state).toBe('counts-absent')
    expect(view.sentence).toBe(COUNTS_NOT_RECORDED_SENTENCE)
    expect(view.countLine).toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(view.countNote).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('0')
  })

  it('keeps the two absences apart: `counts-absent` is a settled run, `pending` is an unsettled one', () => {
    expect(learnedFrom({ curation: { status: 'complete' } }).state)
      .not.toBe(learnedFrom({ curation: { status: 'pending' } }).state)
  })
})

describe('a settled curation says what it changed, in the chip\'s own words', () => {
  it('collapses a both-zero legacy pair to the pair itself, with the changed-nothing sentence', () => {
    // RE-SPELLED 425-06. The pair is now rendered AS a pair rather than folded into a
    // phrase, because folding it was the step that let two coarse counts read as a breakdown.
    const view = learnedFrom({ curation: { status: 'complete', counts: { curated: 0, deprecated: 0 } } })
    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(0, 0))
    expect(view.countNote).toBe(BREAKDOWN_NOT_RECORDED_TEXT)
    expect(view.sentence).toBe(NO_MEMORY_CHANGES_SENTENCE)
    expect(view.rows).toEqual([])
  })

  it('says the change records are not available YET when counts moved but no row reached this run', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: { changes: [], canaryAttributions: [] },
    })
    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(3, 1))
    expect(view.sentence).toBe(CHANGES_NOT_AVAILABLE_TEXT)
    expect(view.rows).toEqual([])
  })

  it('reads the count line from the SAME function the chip does — one number, one wording', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: {
        changes: [],
        canaryAttributions: [],
        curationSnapshot: snapshotOf({ added: 1 }),
      },
    })
    expect(view.countLine).toBe(curationBreakdownLine(snapshotOf({ added: 1 }).breakdown))
  })

  /**
   * LEARNED-BREAKDOWN-LINE (425-06 · D-16/D-17, roadmap SC4).
   *
   * ONE FUNCTION, TWO SURFACES — the 407 LERN-02 rule, now spanning the header and the tab. The
   * curation card and this heading both call `curationBreakdownLine` on the SAME persisted
   * snapshot, so the two cannot disagree about a run a person is reading twice.
   */
  it('LEARNED-BREAKDOWN-LINE: spells the five buckets in the curation card\'s own words', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 4, deprecated: 1 } },
      learned: {
        changes: [],
        canaryAttributions: [],
        curationSnapshot: snapshotOf({ added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 }),
      },
    })

    expect(view.countLine).toBe('1 added · 1 confirmed · 1 superseded · 1 deprecated · 1 proposed')
    expect(view.countNote).toBeUndefined()
  })

  it('LEARNED-BREAKDOWN-LINE: omits a zero bucket rather than printing a count nobody took', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 1 } },
      learned: {
        changes: [],
        canaryAttributions: [],
        curationSnapshot: snapshotOf({ added: 2, deprecated: 1, proposed: 1 }),
      },
    })

    expect(view.countLine).toBe('2 added · 1 deprecated · 1 proposed')
    expect(view.countLine).not.toContain('confirmed')
    expect(view.countLine).not.toContain('superseded')
  })

  it('LEARNED-BREAKDOWN-LINE: reads five zeros as no memory changes, and still states the outcome', () => {
    const view = learnedFrom({
      curation: { status: 'complete' },
      learned: { changes: [], canaryAttributions: [], curationSnapshot: snapshotOf() },
    })

    expect(view.countLine).toBe(NO_MEMORY_CHANGES_TEXT)
    expect(view.countNote).toBeUndefined()
    expect(view.sentence).toBe(NO_MEMORY_CHANGES_SENTENCE)
  })

  /**
   * LEARNED-LEGACY-NOTE.
   *
   * FIVE BUCKETS ARE NEVER SYNTHESIZED FROM TWO. A pre-423 pair is a coarser measurement, not a
   * breakdown with three buckets missing, so the heading prints the pair and says on its own line
   * that no breakdown exists — the reader who sees two numbers where five usually live is told why.
   */
  it("LEARNED-LEGACY-NOTE: prints an older run's pair as a pair, with the not-recorded note beneath", () => {
    const view = learnedFrom({ curation: { status: 'complete', counts: { curated: 2, deprecated: 0 } } })

    expect(view.countLine).toBe(legacyCurationPairText(2, 0))
    expect(view.countLine).toBe('2 curated · 0 deprecated')
    expect(view.countNote).toBe(BREAKDOWN_NOT_RECORDED_TEXT)
  })

  it('LEARNED-LEGACY-NOTE: a settled row with no counts at all keeps its own fragment and no note', () => {
    const view = learnedFrom({ curation: { status: 'complete' } })

    expect(view.countLine).toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(view.countNote).toBeUndefined()
  })

  it('LEARNED-LEGACY-NOTE: names the withheld category when the READ ITSELF withheld the snapshot', () => {
    const view = learnedFrom({
      curation: { status: 'complete' },
      learned: {
        changes: [],
        canaryAttributions: [],
        curationSnapshotWithheld: { reason: 'masking-unavailable' },
      },
    })

    expect(view.countLine).toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(view.countNote).toBe(BREAKDOWN_WITHHELD_TEXT['masking-unavailable'])
  })

  it('LEARNED-LEGACY-NOTE: the snapshot outranks the pair — a recorded breakdown carries no note', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [],
        canaryAttributions: [],
        curationSnapshot: snapshotOf({ added: 2 }),
      },
    })

    expect(view.countLine).toBe('2 added')
    expect(view.countNote).toBeUndefined()
  })

  it('LEARNED-LEGACY-NOTE: leaves the unsettled ladder alone — no line and no note before it settles', () => {
    for (const status of ['pending', 'running', 'failed'] as const) {
      const view = learnedFrom({
        curation: { status, counts: { curated: 2, deprecated: 0 } },
        learned: { changes: [], canaryAttributions: [], curationSnapshot: snapshotOf({ added: 2 }) },
      })
      expect(view.countLine).toBeUndefined()
      expect(view.countNote).toBeUndefined()
    }
  })
  it('drops the state sentence once there are rows — the rows ARE the answer', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: { changes: [change('confirmed')], canaryAttributions: [] },
    })
    expect(view.rows.length).toBe(1)
    expect(view.sentence).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reconciliation line (425-06 · D-19, roadmap SC4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A MISMATCH IS EXPLAINED BY ONE EXPLICIT LINE, AND ONLY WHEN THERE IS ONE.
 *
 * `counted` is the sum of the snapshot's five buckets; `shown` is the rows this half placed in the
 * CURATION section, because 423 D-15 gives since-then rows their own counted line and folding them
 * in here would hide a real gap behind a later promotion.
 *
 * RE-SPELLED 427-08. The curation rows ARE the snapshot's rows now, one per affected record,
 * so on a schema-valid snapshot `shown` equals `counted` by construction and the reconciliation
 * cannot appear. The gate itself is kept as the structural guard; what a partial read or a failed
 * chain costs is said by the notes beside the rows.
 */
describe('a count that disagrees with the rows says so, and says why', () => {
  it('RECONCILIATION-ONLY-ON-MISMATCH: a schema-valid snapshot shows one curation row per counted record', () => {
    const snapshot = addedSnapshot(['rec-a', 'rec-b', 'rec-c'])
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 0 } },
      learned: {
        changes: [change('added', 'rec-a'), change('added', 'rec-b')],
        canaryAttributions: [],
        curationSnapshot: snapshot,
      },
    })

    expect(view.rows.map(row => row.bucket)).toEqual(['added', 'added', 'added'])
    expect(view.rows.filter(row => row.section === 'curation').length).toBe(snapshot.breakdown.added)
    expect(view.rows.map(row => row.leadSource)).toEqual(['not-recorded', 'not-recorded', 'not-recorded'])
  })

  it('RECONCILIATION-ONLY-ON-MISMATCH: carries NO reconciliation key when the two numbers agree', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [change('added', 'rec-a'), change('added', 'rec-b')],
        canaryAttributions: [],
        curationSnapshot: addedSnapshot(['rec-a', 'rec-b']),
      },
    })

    expect(view.rows.length).toBe(2)
    expect(view.curationSnapshot).toEqual({ breakdown: snapshotOf({ added: 2 }).breakdown })
    expect(view.curationSnapshot?.reconciliation).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('counted')
  })

  it('RECONCILIATION-ONLY-ON-MISMATCH: the reconciliation text agrees its noun with the count', () => {
    expect(reconciliationCountText(1, 0)).toBe('1 change counted · 0 shown')
    expect(reconciliationCountText(3, 2)).toBe('3 changes counted · 2 shown')
    expect(reconciliationCountText(0, 1)).toBe('0 changes counted · 1 shown')
  })

  it('RECONCILIATION-ONLY-ON-MISMATCH: a since-then row is not one of the rows shown', () => {
    const later = change('promoted', 'rec-later')
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [change('added', 'rec-a'), change('added', 'rec-b'), later],
        canaryAttributions: [],
        curationSnapshot: addedSnapshot(['rec-a', 'rec-b']),
        sinceThen: { changes: [later], count: 1 },
      },
    })

    expect(view.rows.map(row => row.section)).toEqual(['curation', 'curation', 'since-then'])
    expect(view.curationSnapshot?.sinceThenCount).toBe(1)
    expect(view.curationSnapshot?.reconciliation).toBeUndefined()
  })

  it('RECONCILIATION-CAUSE-FROM-READ: a failed chain keeps its snapshot rows and names the chain beside them', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: {
        changes: [change('added', 'rec-a')],
        canaryAttributions: [],
        curationSnapshot: addedSnapshot(['rec-a', 'rec-b', 'rec-c']),
      },
    })

    expect(view.state).toBe('failed')
    expect(view.rows.length).toBe(3)
    expect(view.chainNote).toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(view.sentence).toBeUndefined()
  })

  it('RECONCILIATION-CAUSE-FROM-READ: an incomplete store scan keeps the rows and names the store beside them', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 0 } },
      learned: {
        changes: [change('added', 'rec-a')],
        canaryAttributions: [],
        curationSnapshot: addedSnapshot(['rec-a', 'rec-b', 'rec-c']),
        scanIncomplete: true,
      },
    })

    expect(view.rows.length).toBe(3)
    expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
    expect(view.scanIncomplete).toBe(true)
  })

  it('RECONCILIATION-CAUSE-FROM-READ: pending and running carry none, whatever the counts say', () => {
    for (const status of ['pending', 'running'] as const) {
      const view = learnedFrom({
        curation: { status },
        learned: {
          changes: [change('added', 'rec-a')],
          canaryAttributions: [],
          curationSnapshot: snapshotOf({ added: 3 }),
        },
      })

      expect(view.rows).toEqual([])
      expect(view.curationSnapshot?.reconciliation).toBeUndefined()
    }
  })

  it('RECONCILIATION-CAUSE-FROM-READ: a run with no snapshot at all reconciles nothing', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 0 } },
      learned: { changes: [change('added', 'rec-a')], canaryAttributions: [] },
    })

    expect(view.curationSnapshot).toBeUndefined()
  })
})

// RE-PINNED 2026-08-30 (407-15 · R-407-15-01). The three cells below used to pin FOUR kinds:
// 'keeps the four Learned kinds in the projection's own order', 'drops `added` and `purged` — a
// birth and a deletion are not what this run LEARNED' and 'publishes the four kinds as one closed
// table the component and the cells both name'. `added` moved INTO the set: 407-04 stamps
// `sourceRunId` on the synthetic `added` change precisely so a run's new facts show here, and
// under the four-kind literal the commonest curation outcome was served, attributed, then dropped
// (REVIEW CR-04). `purged` is still out. The widening is a reconciliation of D-10 pending the
// user's ruling — see R-407-15-01.
describe('the record list is the five LEARNED kinds and nothing else', () => {
  const everyKind: readonly RecordChange['change'][] = [
    'added', 'confirmed', 'superseded', 'deprecated', 'promoted', 'purged',
  ]

  function rowsOfEveryKind() {
    return learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: {
        changes: everyKind.map((kind, index) => change(kind, `rec_${String(index)}`)),
        canaryAttributions: [],
      },
    }).rows
  }

  // RE-SPELLED 427-08: the rows carry 425's bucket words, so a promotion reads Confirmed.
  it("maps the five Learned kinds onto the curation bucket words in the projection's own order", () => {
    expect(rowsOfEveryKind().map(row => row.bucket))
      .toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'confirmed'])
  })

  it('drops ONLY `purged` — a deletion is maintenance, never what this run taught the store', () => {
    const ids = ledgerFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: {
        changes: everyKind.map((kind, index) => change(kind, `rec_${String(index)}`)),
        canaryAttributions: [],
      },
    }).flatMap(entry => entry.recordIds)
    expect(rowsOfEveryKind().length).toBe(5)
    expect(ids).toContain('rec_0')
    expect(ids).not.toContain('rec_5')
  })

  it('publishes the five kinds as one closed table the component and the cells both name', () => {
    expect([...LEARNED_CHANGE_KINDS])
      .toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'promoted'])
  })

  // RE-TARGETED 427-08 (D-19 part 2): ids and references live in the Retrieval details ledger.
  it('carries the record id verbatim, however unlovely — in the ledger, never on the row', () => {
    const input = {
      curation: { status: 'complete' as const, counts: { curated: 1, deprecated: 0 } },
      learned: { changes: [change('promoted', 'fact-page-https-example-com-0f9a')], canaryAttributions: [] },
    }
    expect(ledgerFrom(input)[0]?.recordIds).toEqual(['fact-page-https-example-com-0f9a'])
    expect(JSON.stringify(learnedFrom(input).rows)).not.toContain('fact-page-https-example-com-0f9a')
  })

  it('mints NO href for a record id that is not an addressable entity — a guessed link is worse than none', () => {
    const entries = ledgerFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: { changes: [change('confirmed', 'fact-page-https-example-com-0f9a')], canaryAttributions: [] },
    })
    expect(entries[0]?.href).toBeUndefined()
    expect(entries[0]?.ref).toBeUndefined()
  })

  it('builds the canonical agentqa:// reference when the record IS addressed by a MEM short-ID', () => {
    const entries = ledgerFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: { changes: [change('superseded', 'MEM-001')], canaryAttributions: [] },
    })
    expect(entries[0]?.ref).toBe(formatEntityUri('MEM', 'MEM-001'))
    // `ENTITY_KIND_ROUTES.MEM` is `null` under the DASH-03 contract: this build can say WHAT the
    // entry points at without being able to say where to click, and it says exactly that.
    expect(entries[0]?.href).toBeUndefined()
  })
})

describe('a curated NEW fact is what the run learned', () => {
  /**
   * THE VERIFIER'S REPRODUCTION, INVERTED.
   *
   * Gap 2 drove a real curation that added one fact and deprecated nothing — the commonest
   * curation outcome there is — and the half printed the legacy pair beside
   * `Change records for this run are not available yet.` The record WAS on the wire, stamped with
   * this run's id by `diffSince`, and the view discarded it. This cell is that projection with the
   * answer it should have had.
   */
  it('lists the added record instead of denying it — one row, no sentence', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: {
        changes: [change('added', 'fact-el-textbox-password-9a05ce', { sourceRunId: RUN_ID })],
        canaryAttributions: [],
      },
    })

    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(1, 0))
    expect(view.rows.length).toBe(1)
    expect(view.rows[0]?.bucket).toBe('added')
    expect(view.rows[0]?.primary).toBe(RECORD_CONTENT_NOT_RECORDED_LEAD)
    expect(view.sentence).toBeUndefined()
  })

  /**
   * ROWS BEAT SENTENCES, and the disagreement is SHOWN rather than hidden.
   *
   * A settled row saying both counts are zero, beside a change record the store really attributed
   * to this run, is two producers disagreeing. The old arm order consulted the counts first and so
   * suppressed the record; the person then read a both-zero pair with no way to learn otherwise.
   */
  it('paints rows even when the frozen counts say nothing moved — a served record is never denied', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 0, deprecated: 0 } },
      learned: { changes: [change('confirmed')], canaryAttributions: [] },
    })

    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(0, 0))
    expect(view.rows.length).toBe(1)
    expect(view.sentence).toBeUndefined()
  })

  it('paints rows under a settled row that recorded NO counts — the state word still says so', () => {
    const view = learnedFrom({
      curation: { status: 'complete' },
      learned: { changes: [change('promoted')], canaryAttributions: [] },
    })

    expect(view.state).toBe('counts-absent')
    expect(view.countLine).toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(view.rows.length).toBe(1)
    expect(view.sentence).toBeUndefined()
  })

  it('lists NOTHING while the chain is UNSETTLED, however many rows the projection carries', () => {
    // RE-SCOPED 407-26. This cell used to iterate `failed` too, under a title that
    // contradicted its own subject: `failed` is a SETTLED chain, and the D-12 justification the
    // title cites — "a chain that has not settled has not finished deciding what it changed" —
    // does not describe it. The settled-and-failed case moved to the cell below.
    for (const status of ['pending', 'running'] as const) {
      const view = learnedFrom({
        curation: { status },
        learned: { changes: [change('added'), change('confirmed')], canaryAttributions: [] },
      })
      expect(view.rows).toEqual([])
      expect(view.sentence).toBe(CHANGES_PENDING_TEXT)
      expect(view.chainNote).toBeUndefined()
    }
  })

  /**
   * G-407-12 / REVIEW CR-01 — OWNER RULING 2026-08-31: A SERVED ROW WINS ON THE LEARNED HALF TOO.
   *
   * 407-22 ruled that "a chain that fell over cannot un-commit an outcome event it already
   * appended" and applied it to the Used half's `canaryOutcomeWord`. The owner extended the same
   * ruling to this half. `learned.changes` comes from the `diffSince` walk over the COMMITTED
   * store, filtered by 407-04's run-link stamping; `curation.status` comes from a different
   * sibling op. `{ status: 'failed', changes: [row] }` is therefore a producible shape, and the
   * records in it were served and stamped with this run's own id before the chain fell over.
   */
  it('PAINTS records a failed chain already committed — a chain that fell over cannot un-commit them', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: { changes: [change('added', 'rec-a'), change('confirmed', 'rec-b')], canaryAttributions: [] },
    })

    expect(view.state).toBe('failed')
    expect(view.rows.length).toBe(2)
    // The failure is a NOTE beside the rows, never a sentence over them: `sentence`'s own
    // published contract is "absent exactly when rows is non-empty".
    expect(view.sentence).toBeUndefined()
    expect(view.chainNote).toBe(CURATION_FAILED_PARTIAL_TEXT)
    // D-09 is untouched — counts still come only from the settled notification row.
    expect(view.countLine).toBeUndefined()
  })

  it('keeps the no-rows failed arm byte-identical — the approved sentence, and no note', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: { changes: [], canaryAttributions: [] },
    })

    expect(view.state).toBe('failed')
    expect(view.sentence).toBe(CURATION_FAILED_TEXT)
    expect(view.rows).toEqual([])
    expect(view.chainNote).toBeUndefined()
    expect(view.countLine).toBeUndefined()
  })

  it('narrows the KINDS on the failed arm exactly as on the complete arm — it is the same fold', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: {
        changes: [change('added'), change('purged', 'rec-purged')],
        canaryAttributions: [],
      },
    })

    expect(view.rows.map(row => row.bucket)).toEqual(['added'])
    expect(view.chainNote).toBe(CURATION_FAILED_PARTIAL_TEXT)
  })

  /**
   * WR-02 → 427-08 D-15 — ONE RECORD, ONE ROW, ONE INDEX KEY.
   *
   * `diffSince` emits one `RecordChange` per surviving outcome event, so a bundle confirmed at
   * ordinal 12 and superseded at 13 crosses the run filter twice. Since 427 D-15 those changes are
   * one row in the record's strongest bucket, and every raw event behind it is listed in Retrieval
   * details. The key is the row's index and never names the record: no id reaches a row.
   */
  it('keys a row by its ROW INDEX and never by the record it belongs to', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: { changes: [change('added', 'rec_a', { atOrdinal: 4 })], canaryAttributions: [] },
    })

    expect(view.rows[0]?.key).toBe('0')
    expect(view.rows[0]?.key).not.toContain('rec_a')
  })

  it('never spells the word undefined, and returns the same key for the same input twice', () => {
    const input = {
      curation: { status: 'complete' as const, counts: { curated: 1, deprecated: 0 } },
      learned: {
        changes: [change('confirmed', 'rec', { atOrdinal: 12, evidenceToken: 'tok-a', byRecordId: 'by-1' })],
        canaryAttributions: [],
      },
    }

    const first = learnedFrom(input)
    const second = learnedFrom(input)

    expect(first.rows[0]?.key).toBe('0')
    expect(first.rows[0]?.key).not.toContain('undefined')
    expect(second.rows[0]?.key).toBe(first.rows[0]?.key)
  })

  it('folds two changes on ONE record into one row in its strongest bucket, both events in the ledger', () => {
    const input = {
      curation: { status: 'complete' as const, counts: { curated: 1, deprecated: 0 } },
      learned: {
        changes: [
          change('confirmed', 'rec_same', { atOrdinal: 12 }),
          change('superseded', 'rec_same', { atOrdinal: 13 }),
        ],
        canaryAttributions: [],
      },
    }
    const view = learnedFrom(input)

    expect(view.rows.map(row => [row.key, row.bucket])).toEqual([['0', 'superseded']])
    expect(ledgerFrom(input)[0]?.events).toEqual([
      { change: 'confirmed', atOrdinal: 12 },
      { change: 'superseded', atOrdinal: 13 },
    ])
  })

  /**
   * REVIEW WR-01 — TWO `confirmed` EVENTS AT ONE ORDINAL, ONE RECORD.
   *
   * `survivingOutcomeEvents` dedupes on `evidenceToken:curationJobId`, NOT on type or ordinal, so
   * one bundle can carry two confirmations at one `buildOrdinal` and `diffSince` emits both. They
   * are one record, so one row; the ledger keeps both events and both tokens.
   */
  it('gives two confirmations at ONE ordinal one row, and keeps both tokens in the ledger', () => {
    const input = {
      curation: { status: 'complete' as const, counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [
          change('confirmed', 'rec_same', { atOrdinal: 12, evidenceToken: 'tok-a' }),
          change('confirmed', 'rec_same', { atOrdinal: 12, evidenceToken: 'tok-b' }),
        ],
        canaryAttributions: [],
      },
    }

    expect(learnedFrom(input).rows.map(row => row.key)).toEqual(['0'])
    expect(ledgerFrom(input)[0]?.evidenceTokens).toEqual(['tok-a', 'tok-b'])
    expect(ledgerFrom(input)[0]?.events.length).toBe(2)
  })

  /**
   * REVIEW WR-04 (round-2 WR-05) — THE CASE NO MEMBER-BUILT KEY COULD SEE.
   *
   * Two `RecordChange`s identical in all five members the 407 key spelled are reachable by
   * construction. They are one record's history, so they are one row, and both events stay listed.
   */
  it('separates two changes identical in all five previously-keyed members', () => {
    const input = {
      curation: { status: 'complete' as const, counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [
          change('confirmed', 'rec_same', { atOrdinal: 12, evidenceToken: 'tok-a', byRecordId: 'by-1' }),
          change('confirmed', 'rec_same', { atOrdinal: 12, evidenceToken: 'tok-a', byRecordId: 'by-1' }),
        ],
        canaryAttributions: [],
      },
    }

    const view = learnedFrom(input)
    expect(view.rows.length).toBe(1)
    expect(new Set(view.rows.map(row => row.key)).size).toBe(view.rows.length)
    expect(ledgerFrom(input)[0]?.events).toEqual([
      { change: 'confirmed', atOrdinal: 12 },
      { change: 'confirmed', atOrdinal: 12 },
    ])
  })

  it('assigns indices over the rows actually PAINTED, not over the changes served', () => {
    // The kept-kind filter runs BEFORE the index is assigned, so a dropped `purged` change does
    // not leave a hole in the numbering of the rows that survive it.
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 0 } },
      learned: {
        changes: [
          change('purged', 'rec_gone'),
          change('added', 'rec_a', { atOrdinal: 1 }),
          change('promoted', 'rec_b', { atOrdinal: 2 }),
        ],
        canaryAttributions: [],
      },
    })

    expect(view.rows.map(row => [row.key, row.bucket])).toEqual([['0', 'added'], ['1', 'confirmed']])
  })
})

describe('an unreadable store is named, never called "not available yet"', () => {
  /**
   * TWO ABSENCES THAT MUST NOT WEAR ONE SENTENCE.
   *
   * `CHANGES_NOT_AVAILABLE_TEXT` means the store answered and no change carried this run's
   * attribution. 407-14's `learned.scanIncomplete` means the store could not be READ — the op
   * folded a `KnowledgeMaintenanceScanError` and published the fold rather than hiding it inside
   * an emptiness. Saying "not available yet" about a store nobody could open tells a reader to
   * wait for something that will never arrive on its own.
   */
  it('says the change records could not be READ, keeps the counts, and lists nothing', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: { changes: [], canaryAttributions: [], scanIncomplete: true },
    })

    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(3, 1))
    expect(view.sentence).toBe(CHANGES_UNREADABLE_TEXT)
    expect(view.scanIncomplete).toBe(true)
    expect(view.rows).toEqual([])
  })

  it('sends the reader to the one door that grades the same fold — `doctor`, not a reload', () => {
    expect(CHANGES_UNREADABLE_TEXT)
      .toBe(`Change records could not be read from the knowledge store. ${DOCTOR_HINT_TEXT}`)
    expect(CHANGES_UNREADABLE_TEXT).not.toBe(CHANGES_NOT_AVAILABLE_TEXT)
  })

  it('carries NO scanIncomplete member on a clean read — the flag is true or absent, never false', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: { changes: [], canaryAttributions: [] },
    })

    expect(view.scanIncomplete).toBeUndefined()
    expect(view.sentence).toBe(CHANGES_NOT_AVAILABLE_TEXT)
  })
})

describe('a partial read decorates the answer, it never replaces it', () => {
  /**
   * THE REVIEW'S REPRODUCTION, INVERTED (REVIEW CR-01).
   *
   * `runs.knowledge` folds its two Learned enrichments INDEPENDENTLY, so a failed attribution
   * scan beside a readable diff publishes `{ scanIncomplete: true, changes: [<this run's row>] }`
   * — a sanctioned, op-tested shape. The shipped arm put the flag ABOVE the row fold and returned
   * `rows: []`, so the half asserted the store could not be read while holding the record that
   * proves it could. The flag DECORATES the answer; it never replaces it.
   */
  it('paints the row it was handed and keeps the flag beside it — no unreadable-store sentence', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 1, deprecated: 0 } },
      learned: {
        changes: [change('confirmed', 'rec-mine', { sourceRunId: RUN_ID })],
        canaryAttributions: [],
        scanIncomplete: true,
      },
    })

    expect(view.state).toBe('complete')
    expect(view.countLine).toBe(legacyCurationPairText(1, 0))
    expect(view.rows.length).toBe(1)
    expect(view.rows[0]?.bucket).toBe('confirmed')
    expect(view.sentence).toBeUndefined()
    expect(view.scanIncomplete).toBe(true)
    expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
  })

  /**
   * THE FLAG-ONLY WORLD IS UNTOUCHED (407-17's (c2) shape).
   *
   * Nothing to list AND nothing readable is the one arm whose sentence already names the store,
   * so the note would be a second, quieter copy of the sentence beside it — a nag, not news.
   */
  it('still names the unreadable store when the kind filter left nothing to paint, and adds NO note', () => {
    const view = learnedFrom({
      curation: { status: 'complete', counts: { curated: 3, deprecated: 1 } },
      learned: { changes: [], canaryAttributions: [], scanIncomplete: true },
    })

    expect(view.sentence).toBe(CHANGES_UNREADABLE_TEXT)
    expect(view.rows).toEqual([])
    expect(view.scanIncomplete).toBe(true)
    expect(view.readNote).toBeUndefined()
    expect('readNote' in view).toBe(false)
  })

  /**
   * THE FLAG IS A FACT ABOUT THE READ, NOT ABOUT THE CHAIN.
   *
   * The unsettled arms returned before the flag was ever consulted, so a run waiting on a chain
   * that will settle, over a store nobody can open, rendered `Deltas land when curation settles.`
   * with no stamp at all — no cell and no operator grep could see the degradation.
   */
  it('carries the flag and the note through the unsettled arms — pending and running', () => {
    for (const status of ['pending', 'running'] as const) {
      const view = learnedFrom({
        curation: { status },
        learned: { changes: [], canaryAttributions: [], scanIncomplete: true },
      })

      expect(view.state).toBe(status)
      expect(view.sentence).toBe(CHANGES_PENDING_TEXT)
      expect(view.rows).toEqual([])
      expect(view.scanIncomplete).toBe(true)
      expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
    }
  })

  it('carries the flag and the note through a FAILED chain — the failure sentence still stands', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: { changes: [], canaryAttributions: [], scanIncomplete: true },
    })

    expect(view.state).toBe('failed')
    expect(view.sentence).toBe(CURATION_FAILED_TEXT)
    expect(view.rows).toEqual([])
    expect(view.scanIncomplete).toBe(true)
    expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
  })

  /**
   * TWO PRODUCERS, TWO NOTES, NEITHER SPEAKING FOR THE OTHER.
   *
   * The chain's fate and the store's readability are folded INDEPENDENTLY by 407-14's op, so a
   * projection can carry both at once — the shipped conformance file's fifth world
   * (`attributed-failed`) literally does. One slot could only report one of them, which is the
   * coupling round-2 WR-03 named; `chainNote` and `readNote` are therefore siblings, not a
   * single flag with two meanings.
   */
  it('carries the chain note AND the read note at once — a failed chain over a partial read', () => {
    const view = learnedFrom({
      curation: { status: 'failed' },
      learned: {
        changes: [change('confirmed', 'rec-mine', { sourceRunId: RUN_ID })],
        canaryAttributions: [],
        scanIncomplete: true,
      },
    })

    expect(view.state).toBe('failed')
    expect(view.rows.length).toBe(1)
    expect(view.sentence).toBeUndefined()
    expect(view.chainNote).toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(view.scanIncomplete).toBe(true)
    expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
    expect(view.chainNote).not.toBe(view.readNote)
  })

  it('paints rows under a counts-absent settled row on a partial read, note and all', () => {
    const view = learnedFrom({
      curation: { status: 'complete' },
      learned: {
        changes: [change('promoted', 'rec-mine', { sourceRunId: RUN_ID })],
        canaryAttributions: [],
        scanIncomplete: true,
      },
    })

    expect(view.state).toBe('counts-absent')
    expect(view.countLine).toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(view.rows.length).toBe(1)
    expect(view.sentence).toBeUndefined()
    expect(view.scanIncomplete).toBe(true)
    expect(view.readNote).toBe(STORE_READ_INCOMPLETE_TEXT)
  })

  it('carries NEITHER member on a clean read, in every state — absence is an absent key', () => {
    for (const status of ['pending', 'running', 'failed', 'complete'] as const) {
      const view = learnedFrom({
        curation: status === 'complete' ? { status, counts: { curated: 1, deprecated: 0 } } : { status },
        learned: { changes: [change('added')], canaryAttributions: [] },
      })

      expect('scanIncomplete' in view).toBe(false)
      expect('readNote' in view).toBe(false)
    }
  })

  it('sends the reader to the same door as every other degradation, in its own words', () => {
    expect(STORE_READ_INCOMPLETE_TEXT)
      .toBe(`The knowledge store could not be fully read. ${DOCTOR_HINT_TEXT}`)
    expect(STORE_READ_INCOMPLETE_TEXT).not.toBe(CHANGES_UNREADABLE_TEXT)
    expect(STORE_READ_INCOMPLETE_TEXT).not.toBe(CHANGES_NOT_AVAILABLE_TEXT)
  })
})

// RE-SPELLED 432-09 from 'the proposals line is a COUNT and a door, never any proposal content
// ': the tab shows what changed, so no ready view carries a proposals member, a count or a
// review command, whatever the curation word — and a legacy count on the wire is not projected.
describe('no ready view carries a pending-proposals line or a review command', () => {
  it.each([
    ['complete', { curation: { status: 'complete' as const, counts: { curated: 1, deprecated: 0 } } }],
    ['pending', { curation: { status: 'pending' as const } }],
    ['a legacy count on the wire', { curation: { status: 'complete' as const }, pendingProposalCount: 3 } as never],
  ])('renders no proposals member on %s', (_name, overrides) => {
    const view = readyView(overrides)
    expect('proposals' in view).toBe(false)
    expect(JSON.stringify(view)).not.toMatch(/agent-qa proposals|waiting for review/)
  })
})

describe('the ready arm carries the Learned half so the tab does not have to build one', () => {
  it('fills `learned` on every ready view, and never a `proposals` member', () => {
    const view = projectKnowledgeView(ready({
      curation: { status: 'complete', counts: { curated: 2, deprecated: 1 } },
      learned: { changes: [change('confirmed', 'MEM-001')], canaryAttributions: [] },
    }))
    if (view.state !== 'ready') throw new Error('expected ready')
    expect(view.learned?.state).toBe('complete')
    expect(view.learned?.rows.length).toBe(1)
    expect('proposals' in view).toBe(false)
  })

  it('omits `proposals` from the ready arm on every read', () => {
    const view = projectKnowledgeView(ready({ curation: { status: 'running' } }))
    if (view.state !== 'ready') throw new Error('expected ready')
    expect('proposals' in view).toBe(false)
    expect(view.learned?.state).toBe('running')
  })
})

describe('the Memory changes copy is published as constants, like every sentence before it', () => {
  it('spells each Learned sentence exactly once, and no two the same', () => {
    expect(CHANGES_PENDING_TEXT).toBe('Memory changes appear after post-run processing finishes.')
    expect(CURATION_FAILED_TEXT).toBe('Curation failed — nothing was learned from this run.')
    expect(CURATION_FAILED_PARTIAL_TEXT)
      .toBe('Curation failed — these records were committed before it stopped.')
    expect(COUNTS_NOT_RECORDED_SENTENCE).toBe('Counts not recorded for this run.')
    expect(CHANGES_NOT_AVAILABLE_TEXT).toBe('Change records for this run are not available yet.')
    expect(NO_MEMORY_CHANGES_SENTENCE).toBe('Post-run processing finished and changed nothing in memory.')
    expect(RECONCILIATION_UNATTRIBUTED_TEXT).toBe("The difference could not be attributed to this run's rows.")
    expect(new Set([
      CHANGES_PENDING_TEXT,
      CURATION_FAILED_TEXT,
      CURATION_FAILED_PARTIAL_TEXT,
      COUNTS_NOT_RECORDED_SENTENCE,
      CHANGES_NOT_AVAILABLE_TEXT,
      NO_MEMORY_CHANGES_SENTENCE,
    ]).size).toBe(6)
  })

  it('keeps the Memory changes heading beside them', () => {
    expect(MEMORY_CHANGES_HEADING).toBe('Memory changes')
  })
})

// ---------------------------------------------------------------------------
// The rung banner's copy of record
// ---------------------------------------------------------------------------

describe('the strip sentence exists only for warning classes, composed from closed tables', () => {
  it('renders the SENTENCE OF RECORD byte-for-byte for a floor host', () => {
    // Spelled as a literal on purpose: a cell composed from the same constants the implementation
    // uses would go green on a template that lost its em dash.
    expect(rungBannerText({ rung: 'static-floor', reason: 'native-runtime-unavailable' })).toBe(
      "This run's knowledge retrieval used the lightweight static-floor embeddings instead of the full model — native ONNX runtime unavailable. To check the store's health now, run agent-qa doctor. It reports current health and doesn't change what this run recorded.",
    )
  })

  it('renders a locked index as its statement plus the doctor pointer, and paints nothing for the info classes', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(rungBannerText({ rung: 'bundle-scan', reason: 'index-locked' })).toBe(
      `${retrievalStatement('bundle-scan', 'index-locked')} ${DOCTOR_POINTER_TEXT}`,
    )
    expect(rungBannerText({ rung: 'bundle-scan', reason: 'index-not-built' })).toBeUndefined()
    expect(rungBannerText({ rung: 'static-floor', reason: 'profile-static-configured' })).toBeUndefined()
    expect(rungBannerText({ rung: 'lexical-only', reason: 'floor-disabled' })).toBeUndefined()
    expect(rungBannerText({ rung: 'bundle-scan', reason: 'index-unavailable' })).toBeUndefined()
  })

  it('says NOTHING for the top rung and for a run that recorded none', () => {
    // `memidex` is not a degradation, and "not yet known" is the absence of a sentence — both
    // render no banner at all rather than a reassuring one.
    expect(rungBannerText({ rung: 'memidex' })).toBeUndefined()
    expect(rungBannerText(undefined)).toBeUndefined()
  })

  it('paints no strip for a degraded rung that carries no reason — its cause was not recorded, which is information', () => {
    // The fold never mints this, but the schema types `reason` optional on every rung, so the
    // shape is reachable from a historical handoff. It claims neither a fault nor health.
    expect(rungBannerText({ rung: 'static-floor' })).toBeUndefined()
    expect(rungBannerText({ rung: 'bundle-scan' })).toBeUndefined()
  })

  it('ends every warning sentence with the doctor pointer; no rung sentence says Retrieval degraded or carries a backtick', () => {
    expect(DOCTOR_HINT_TEXT).toBe('Run `agent-qa doctor`.')
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      for (const rung of ['bundle-scan', 'static-floor', 'lexical-only'] as const) {
        const text = rungBannerText({ rung, reason })
        if (text === undefined) continue
        expect(text.endsWith(` ${DOCTOR_POINTER_TEXT}`)).toBe(true)
        expect(text).not.toContain('Retrieval degraded')
        expect(text).not.toContain('`')
        expect(text).not.toContain(DOCTOR_HINT_TEXT)
      }
    }
  })
})

describe('the two label tables are TOTAL over the schema vocabularies', () => {
  it('RUNG_CAUSE_LABELS has exactly the recorded reasons, none blank', () => {
    expect(Object.keys(RUNG_CAUSE_LABELS).sort()).toEqual([...RETRIEVAL_RUNG_REASONS].sort())
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      expect(RUNG_CAUSE_LABELS[reason].length).toBeGreaterThan(0)
    }
  })

  it('carries the doctor row wording verbatim for the three labels the CLI reconciled', () => {
    // These three are NOT in UI-SPEC's five. `doctor-knowledge-checks.ts` chose them; 407-11 pins
    // the two tables equal. This cell is the dashboard half of that pin, stated locally so the
    // drift reds here first.
    expect(RUNG_CAUSE_LABELS['model-not-downloaded']).toBe('embedding model not downloaded')
    expect(RUNG_CAUSE_LABELS['embedder-load-failed']).toBe('embedder failed to load')
    expect(RUNG_CAUSE_LABELS['profile-static-configured']).toBe('static profile configured')
  })

  it('RUNG_LABELS names every rung EXCEPT the top one — a table with a `memidex` label invites a banner for it', () => {
    expect(Object.keys(RUNG_LABELS).sort()).toEqual(
      RETRIEVAL_RUNGS.filter(rung => rung !== 'memidex').slice().sort(),
    )
    expect(RUNG_LABELS['bundle-scan']).toBe('bundle scan')
    expect(RUNG_LABELS['static-floor']).toBe('static-floor embeddings')
    expect(RUNG_LABELS['lexical-only']).toBe('lexical-only retrieval')
  })
})

describe('the header reads the rung off the DURABLE projection, and only where there is one', () => {
  const RECORDED = { schemaVersion: 2, rung: 'static-floor', reason: 'native-runtime-unavailable' } as const

  it('hands the recorded value back untouched for a bound store', () => {
    expect(bannerRung(ready({ retrievalRung: RECORDED }))).toEqual(RECORDED)
  })

  it('says nothing for a project with NO knowledge store bound', () => {
    // A run that never asked retrieval anything was not served on a rung. The tab says so in its
    // own words; the header stays silent rather than labelling the run degraded.
    expect(bannerRung(ready({ knowledgeStore: 'unbound', retrievalRung: RECORDED }))).toBeUndefined()
  })

  it('says nothing for an older run whose evidence recorded no rung', () => {
    expect(bannerRung(ready({}))).toBeUndefined()
  })

  it('says nothing for a pruned handoff, a refused door, or a read that has not landed', () => {
    expect(bannerRung({ kind: 'read', projection: { kind: 'evidence-incomplete', runId: RUN_ID } })).toBeUndefined()
    expect(bannerRung({ kind: 'unavailable', error: 'boom' })).toBeUndefined()
    expect(bannerRung(undefined)).toBeUndefined()
  })
})
