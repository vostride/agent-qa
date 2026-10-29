// Scans for a fresh empty trace at the recorder call, which type-checks but drops the served one.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeBriefDigest,
  type BriefBlock,
  type TraceLine,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { KnowledgeHintReader, ServedCautions } from '../../knowledge-hint-reader.js'
import type { ActionResult } from '../../platform.js'
import { executeStep } from '../index.js'
import type { LoopPorts } from '../ports.js'
import type { ActionPlan } from '../types.js'
import { makeActionPlan, makeAdapter, makePlanner, makeStepContext } from './loop-harness.js'
import { noCautions, servedBrief, servedCautions } from './fixtures/served-trace.js'

const loopDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function statementsOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

describe('the loop threads the serve-time trace to the evidence seam', () => {
  const source = statementsOf(readFileSync(join(loopDir, 'index.ts'), 'utf8'))

  it('hands the recorder the trace it was served, never a fabricated one', () => {
    // The composite is destructured once and its own `trace` is what reaches the recorder.
    expect(occurrences(source, 'trace: served.trace')).toBe(1)
    expect(occurrences(source, 'recorder.recordServedCautions(injected, cautionsForTurn.trace)'))
      .toBe(1)

    // No empty/synthetic trace is constructed anywhere in the loop.
    for (const forbidden of [
      'servedLines: []',
      'truncated: []',
      'schemaVersion:',
    ]) {
      expect(occurrences(source, forbidden)).toBe(0)
    }

    // POSITIVE CONTROL: the fabricated-trace shape this scan exists to reject is rejected.
    const planted = `${source}\n  recorder.recordServedBrief({ block, trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [] } })\n`
    expect(occurrences(planted, 'servedLines: []')).toBe(1)
    expect(occurrences(planted, 'schemaVersion:')).toBe(1)

    // INVERSE CONTROL: the same shape in PROSE must not be flagged, which is the failure mode a
    // naive substring scan hits in this file — it explains the contract it implements.
    expect(occurrences(
      statementsOf('// never write servedLines: [] here\n/* nor schemaVersion: 1 */\nconst x = 1\n'),
      'servedLines: []',
    )).toBe(0)
  })

  it('reads both composite entries exactly once each', () => {
    // Two serving entries cross this seam; a third call would be a serve nobody attributed.
    expect(occurrences(source, '.getRunBrief(')).toBe(1)
    expect(occurrences(source, '.getCautions(')).toBe(1)
    expect(occurrences(`${source}\nports.knowledgeReader?.getRunBrief(s, b)\n`, '.getRunBrief(')).toBe(2)
  })
})

// A turn that injects nothing must still hand the reader's trace to the recorder.
const EMPTY_BRIEF: BriefBlock = {
  tiers: { L0: '', L1: '', L2: '' },
  lines: [],
  truncation: '',
  admissions: [],
}

const BUDGETS = { brief: 64, searchResults: 64, caution: 24, readBody: 64, recordCap: 8 }

function cut(recordId: string, rank: number, score: number): TraceLine {
  return { recordId, leg: 'anchor', rank, score }
}

// Serves are scripted per lookup; a single entry answers every lookup because the index clamps.
function readerServing(...serves: ServedCautions[]): KnowledgeHintReader {
  let call = 0
  return {
    // The Channel-1 trace is deliberately empty, so any cut candidate reaching evidence can only
    // have come through Channel 3. A brief-borne cut would make the assertion below pass for a
    // reason that has nothing to do with the caution turn.
    getRunBrief: () => servedBrief(EMPTY_BRIEF),
    search: () => [],
    read: () => { throw new Error('not used') },
    getCautions: () => serves[Math.min(call++, serves.length - 1)]!,
    getProcedure: () => undefined,
    emitCanaryOutcome: () => {},
  }
}

const ACTION_FAILED: ActionResult = { success: false, error: 'Browser process disconnected' }

interface LoopShape {
  /** Scripted adapter results; the last entry repeats, so `[ACTION_FAILED]` never succeeds. */
  executeResults?: ActionResult[]
  plans?: ActionPlan[]
  /** The per-step action limit. Absent ⇒ the schema default (30 actions), i.e. no early exit. */
  maxActions?: number
}

function ports(serves: ServedCautions[], shape: LoopShape = {}): LoopPorts {
  const loopPorts: LoopPorts = {
    adapter: makeAdapter({
      executeResults: shape.executeResults ?? [ACTION_FAILED, { success: true }],
    }),
    planner: makePlanner(shape.plans ?? [
      makeActionPlan({ action: { type: 'click', ref: 'e2' } }),
      makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
    ]),
    knowledgeReader: readerServing(...serves),
    knowledgeBudgets: BUDGETS,
  }
  if (shape.maxActions !== undefined) {
    loopPorts.plannerConfig = { maxActions: shape.maxActions, maxPlanningTurns: shape.maxActions, previousStepCount: 0 }
  }
  return loopPorts
}

/** One action failure followed by a success — the shape that triggers exactly one caution turn. */
async function replanAfterFailure(cautions: ServedCautions): ReturnType<typeof executeStep> {
  return executeStep('Click Log in', ports([cautions]), makeStepContext({ testName: 'Checkout Flow' }))
}

describe('a turn that injected ZERO cautions still lands the reader cut ledger', () => {
  it('Shape A: the reader ranked candidates and cut them all', async () => {
    const served = await replanAfterFailure(servedCautions(
      { cautions: [], budgetUsed: 0, admissions: [] },
      {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [],
        truncated: [cut('caution-cut-a', 4, 0.31), cut('caution-cut-b', 5, 0.22)],
      },
    ))

    const persisted = served.evidence?.retrievalTrace
    expect(persisted?.truncated.map(({ recordId }) => recordId))
      .toEqual(['caution-cut-a', 'caution-cut-b'])
    // Nothing is rendered into the turn, so nothing counts as served.
    expect(persisted?.servedLines).toEqual([])
  })

  it('Shape A leaves the ServedBrief bytes exactly where the no-caution baseline left them', async () => {
    // Compared with a real replan that served no caution trace, so only the trace differs.
    const laden = await replanAfterFailure(servedCautions(
      { cautions: [], budgetUsed: 0, admissions: [] },
      { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [cut('caution-cut-a', 4, 0.31)] },
    ))
    const baseline = await replanAfterFailure(noCautions())

    expect(laden.evidence?.servedBrief.channel3).toHaveLength(0)
    expect(JSON.stringify(laden.evidence?.servedBrief))
      .toBe(JSON.stringify(baseline.evidence?.servedBrief))
    expect(laden.evidence?.servedBrief.briefDigest)
      .toBe(computeBriefDigest({ ...laden.evidence!.servedBrief, briefDigest: '' }))
    // The guard is not vacuously true over two empty things: the laden run really did carry a cut.
    expect(laden.evidence?.retrievalTrace?.truncated).toHaveLength(1)
  })
})

// Steps ending at the deadline or action limit still drain staged cautions in `finish()`.
/**
 * A staged composite whose block renders NOTHING. `served` are lines the reader handed over for a
 * turn that never came; `cutCandidates` are the ones it had already dropped. Both must reach
 * evidence as candidates — a line the reader served to a turn that never ran was still not shown
 * to anybody, and `cut` builds either side because the two differ only in which array they sit in.
 */
function stagedServe(served: TraceLine[], cutCandidates: TraceLine[]): ServedCautions {
  return servedCautions(
    { cautions: [], budgetUsed: 0, admissions: [] },
    { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: served, truncated: cutCandidates },
  )
}

/** A step whose every action fails and whose action limit ends it after `maxActions` actions. */
async function endsAtBudget(
  serves: ServedCautions[],
  maxActions: number,
): ReturnType<typeof executeStep> {
  return executeStep(
    'Click Log in',
    ports(serves, {
      executeResults: [ACTION_FAILED],
      plans: [
        makeActionPlan({ action: { type: 'click', ref: 'e2' } }),
        makeActionPlan({ action: { type: 'click', ref: 'e1' } }),
      ],
      maxActions,
    }),
    makeStepContext({ testName: 'Checkout Flow' }),
  )
}

describe('a step that ENDS before its staged ledger is consumed still lands it', () => {
  it('terminal budget exit: the staged cut ledger survives the step that never replanned', async () => {
    const served = await endsAtBudget([stagedServe(
      // A line the reader SERVED for the turn that never came. Its presence is what makes the
      // honesty assertion below non-vacuous: with a served-lines-empty trace, no implementation
      // could populate `servedLines` at all, so the assertion would hold for a reason having
      // nothing to do with the drain (found by probing this case's own controls — m4).
      [cut('caution-served-x', 1, 0.88)],
      [cut('caution-cut-a', 4, 0.31), cut('caution-cut-b', 5, 0.22)],
    )], 1)

    // The step really did end at the budget, not at a replan that happened to work.
    expect(served.status).toBe('failed')
    expect(served.error).toContain('Stopped: action limit reached')

    const persisted = served.evidence?.retrievalTrace
    // Non-injected served lines first, then the reader's own cuts — the recorder's uniform split,
    // applied to the terminal turn with no special case.
    expect(persisted?.truncated.map(({ recordId }) => recordId))
      .toEqual(['caution-served-x', 'caution-cut-a', 'caution-cut-b'])
    // Nothing is rendered into any turn, so nothing counts as served.
    expect(persisted?.servedLines).toEqual([])
  })

  it('two stagings: the terminal drain APPENDS to the consumed one, it does not replace it', async () => {
    const served = await endsAtBudget(
      [stagedServe([], [cut('staged-a-cut', 4, 0.31)]), stagedServe([], [cut('staged-b-cut', 6, 0.19)])],
      2,
    )

    expect(served.error).toContain('Stopped: action limit reached')
    expect(served.evidence?.retrievalTrace?.truncated.map(({ recordId }) => recordId))
      .toEqual(['staged-a-cut', 'staged-b-cut'])
    expect(served.evidence?.retrievalTrace?.servedLines).toEqual([])
  })

  it('the terminal drain leaves the ServedBrief bytes where a cut-free budget exit left them', async () => {
    // The drain injects nothing, so the brief cannot move; the control carried no cut candidates.
    const laden = await endsAtBudget([stagedServe([], [cut('caution-cut-a', 4, 0.31)])], 1)
    const baseline = await endsAtBudget([noCautions()], 1)

    expect(laden.evidence?.servedBrief.channel3).toHaveLength(0)
    expect(JSON.stringify(laden.evidence?.servedBrief))
      .toBe(JSON.stringify(baseline.evidence?.servedBrief))
    expect(laden.evidence?.servedBrief.briefDigest)
      .toBe(computeBriefDigest({ ...laden.evidence!.servedBrief, briefDigest: '' }))
    // Not vacuous over two empty things: the laden run really did carry a cut through the drain.
    expect(laden.evidence?.retrievalTrace?.truncated).toHaveLength(1)
  })
})

/**
 * The funnel property the drain's totality rests on. A drain placed at one exit site closes one
 * exit; a drain placed where EVERY terminal path already converges closes the class, including
 * exits nobody has written yet. This scan pins the convergence itself rather than counting the
 * exits — a count of `return failure(` sites is exactly the hand-picked member set the drain is
 * designed to make irrelevant, and pinning it would red on an innocuous tenth exit that the
 * funnel already covers.
 */
const DRAIN_CALL = 'recorder.recordServedCautions([], pendingCautions.trace)'
const FOLD_CALL = 'recorder.finalize('

// One predicate, so the real-source check and the rejecting controls test the same thing.
function drainPrecedesFold(text: string): boolean {
  const drain = text.indexOf(DRAIN_CALL)
  const fold = text.indexOf(FOLD_CALL)
  return drain > -1 && fold > -1 && drain < fold
}

/** The plausible wrong placement, built by surgery on the REAL source: the drain lifted out of
 *  position and re-inserted immediately after the fold. Never a hand-written synthetic source —
 *  the control has to reject the file that could actually exist. */
function withDrainBelowTheFold(text: string): string {
  const lifted = text.replace(DRAIN_CALL, 'recorder.recordCautionsLater()')
  const foldEnd = lifted.indexOf(FOLD_CALL) + FOLD_CALL.length
  return `${lifted.slice(0, foldEnd)}\n      ${DRAIN_CALL}\n${lifted.slice(foldEnd)}`
}

// Pins the shape of each throw (a re-raise after the abort re-check, or `throw new`), not a count.
const RE_RAISE = /^throw\s+([A-Za-z_$][\w$]*)\s*;?\s*\}*\s*$/
const CONSTRUCTED_THROW = /^throw\s+new\s+[A-Za-z_$][\w$]*\s*\(/
/** The abort re-check must sit IMMEDIATELY above the re-raise: anchored at the window's end, with
 *  the bound identifier backreferenced through the test and the return. Whitespace is collapsed and
 *  the separators are optional, so the SHAPE is what is pinned and not the file's current line
 *  breaks — a conforming re-raise written on one line is accepted (controlled for below). */
const ABORT_RECHECK = /const (\w+) = checkAbort\(\);? if \( ?\1 ?\) \{? ?return \1;? ?\}? ?$/
/** Wide enough for the idiom (~90 chars once whitespace is collapsed) with room to spare; the
 *  regex anchors from `const … = checkAbort()`, so a window that slices mid-token is harmless. */
const IDIOM_WINDOW = 240

function throwIdiomViolations(text: string): string[] {
  const violations: string[] = []
  const throwStatements = /\bthrow\b[^\n]*/g
  let match: RegExpExecArray | null
  while ((match = throwStatements.exec(text)) !== null) {
    const statement = match[0].trim()
    if (CONSTRUCTED_THROW.test(statement)) continue
    if (!RE_RAISE.test(statement)) {
      violations.push(`throw shape outside the disclosed set: ${statement}`)
      continue
    }
    const preceding = text.slice(Math.max(0, match.index - IDIOM_WINDOW), match.index)
      .replace(/\s+/g, ' ')
    if (!ABORT_RECHECK.test(preceding)) {
      violations.push(`re-raise outside the abort re-check idiom: ${statement}`)
    }
  }
  return violations
}

function throwStatementsOf(text: string, shape: RegExp): string[] {
  return (text.match(/\bthrow\b[^\n]*/g) ?? []).map((s) => s.trim()).filter((s) => shape.test(s))
}

describe('the terminal drain sits at the ONE funnel every exit routes through', () => {
  const source = statementsOf(readFileSync(join(loopDir, 'index.ts'), 'utf8'))

  it('evidence is folded in exactly one place, and every terminal builder routes there', () => {
    // The convergence: one fold, so any terminal path's evidence passes whatever precedes it.
    expect(occurrences(source, 'recorder.finalize(')).toBe(1)

    // The three terminal builders are single-expression `finish` calls, so all their call sites —
    // however many there are today — inherit the drain by construction.
    for (const builder of [
      "const success = (): StepResult => finish('passed'",
      "const failure = (error: string): StepResult => finish('failed'",
      "const cancelled = (): StepResult => finish('cancelled'",
    ]) {
      expect(occurrences(source, builder)).toBe(1)
    }
  })

  it('the staged caution ledger drains BEFORE the fold, beside the other backstop drains', () => {
    const drain = source.indexOf('recorder.recordServedCautions([], pendingCautions.trace)')
    const readTraceDrain = source.indexOf('recorder.recordServedReadTraces(ports.drainMemoryReadTraces')
    const fold = source.indexOf('recorder.finalize(')

    expect(drain).toBeGreaterThan(-1)
    expect(readTraceDrain).toBeGreaterThan(-1)
    // Between the existing no-loss backstop drains and the fold: a drain after the fold would
    // record into evidence nobody reads again.
    expect(drain).toBeGreaterThan(readTraceDrain)
    expect(fold).toBeGreaterThan(drain)

    // The same ordering, stated once as a predicate so the controls below can run THIS expression
    // rather than a re-derivation of it.
    expect(drainPrecedesFold(source)).toBe(true)

    // The misplaced source keeps both needles once, so a rejection here is about order alone.
    const misplaced = withDrainBelowTheFold(source)
    expect(occurrences(misplaced, DRAIN_CALL)).toBe(1)
    expect(occurrences(misplaced, FOLD_CALL)).toBe(1)
    expect(drainPrecedesFold(misplaced)).toBe(false)

    // The input the old control passed on. A predicate that answers "the drain is in the right
    // place" about a text with no drain in it is not measuring placement.
    expect(drainPrecedesFold('')).toBe(false)
  })

  it('the drain is a SECOND sanctioned call shape, not a licence for a third', () => {
    // Neither sanctioned call shape constructs a trace, so a fabricated-trace call still fails.
    expect(occurrences(source, 'recorder.recordServedCautions(injected, cautionsForTurn.trace)')).toBe(1)
    expect(occurrences(source, 'recorder.recordServedCautions([], pendingCautions.trace)')).toBe(1)
    // Exactly two call sites in the whole file — a third would be a serve nobody attributed.
    expect(occurrences(source, 'recorder.recordServedCautions(')).toBe(2)
  })

  it('every throw-shaped exit is a re-raise after a missed abort re-check', () => {
    // The disclosure in the backstop comment, measured. No count is pinned anywhere below.
    expect(throwIdiomViolations(source)).toEqual([])

    // NON-VACUITY: an empty file would satisfy the line above. Both disclosed arms are populated,
    // asserted as "there is at least one", never as "there are N" — the number is free to move.
    expect(throwStatementsOf(source, RE_RAISE).length).toBeGreaterThan(0)
    expect(throwStatementsOf(source, CONSTRUCTED_THROW).length).toBeGreaterThan(0)
    // The re-raises do not all share one identifier, so the scan cannot be passing by matching a
    // single hard-coded name: `throw err` is the common spelling, `throw verifyError` is not.
    expect(new Set(throwStatementsOf(source, RE_RAISE)).size).toBeGreaterThan(1)

    // POSITIVE CONTROL 1 — the realistic wrong edit: an existing site's abort re-check deleted, so
    // an abort would be re-raised as a failure instead of returning the cancellation.
    const unguarded = source.replace(
      'const abortDuringVerify = checkAbort()\n        if (abortDuringVerify) return abortDuringVerify\n        throw verifyError',
      'throw verifyError',
    )
    expect(unguarded).not.toBe(source) // the mutation landed; a no-op replace would prove nothing
    expect(throwIdiomViolations(unguarded)).toEqual([
      're-raise outside the abort re-check idiom: throw verifyError',
    ])

    // POSITIVE CONTROL 2 — the new exit a later reader adds without the idiom.
    expect(throwIdiomViolations(`${source}\n  } catch (err) {\n    throw err\n  }\n`))
      .toEqual(['re-raise outside the abort re-check idiom: throw err'])

    // POSITIVE CONTROL 3 — a throw shape outside the disclosed set. It reds not because it is
    // wrong but because the comment no longer describes the file, which is the whole point.
    expect(throwIdiomViolations(`${source}\n    throw makeStepError()\n`))
      .toEqual(['throw shape outside the disclosed set: throw makeStepError()'])

    // A further conforming site must stay silent, so the scan pins a shape, not a membership list.
    const oneMoreConformingSite = `${source}\n  } catch (err) {\n    const abortLater = checkAbort()\n    if (abortLater) return abortLater\n    throw err\n  }\n`
    expect(throwIdiomViolations(oneMoreConformingSite)).toEqual([])
    expect(throwStatementsOf(oneMoreConformingSite, RE_RAISE).length)
      .toBe(throwStatementsOf(source, RE_RAISE).length + 1)

    // The same site on one line must stay silent, or the scan pins line breaks, not the idiom.
    expect(throwIdiomViolations(
      `${source}\n  try { risky() } catch (err) { const abortInline = checkAbort(); if (abortInline) return abortInline; throw err }\n`,
    )).toEqual([])
  })
})
