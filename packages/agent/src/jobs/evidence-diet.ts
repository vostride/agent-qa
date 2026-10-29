// The D-02 evidence diet and the D-01 compaction ladder.
//
// WHAT A PACK IS. One per unknown-verdict failed test: the failing step plus a bounded
// neighbor window, QUOTING StepEvidence fields verbatim — `stepText`,
// `verifierVerdict.reasoning`, each sub-action's `plan` and `result.error`, and the
// reportedValue/aiJudgment/assertOutcome/termination/limitStop/conditionVerdicts blocks when
// present — so the authored sentence can cite captured bytes rather than paraphrase them.
// Assembly (here) is kept separate from rendering (plan 04's author feeds packs into the
// prompt's volatile tier), which is what makes the ladder testable on bytes.
//
// THE TWO FORCED CHANNELS. Every pack carries (1) the test's prior-build outcome,
// derived from a caller-injected history record, and (2) the failing step's `servedBrief`
// plus its serve-time `retrievalTrace` — rendered so the author can honestly set
// memoryMisdirectionRuledOut. Compaction squeezes the WINDOW, never these channels
// (house law: efficacy over token economy); they are byte-identical through every rung.
//
// THE SCREENSHOT CHANNEL (D-02, L9). The failing step's `subActions[].decisionScreenshotRef`
// entries travel as REFS deduped by sha, never bytes: this package has no fs. Plan 04's
// author resolves bytes through the readEvidenceBlob capability (bound in plan 06) and
// attaches image parts only when the v46 vision negotiation allows. Rung 1 of the ladder
// strips the refs — text-only BYOM degradation is a deterministic rung, not an ad-hoc drop.
//
// NO IMPORTED ESTIMATOR. Token estimation arrives as injected data — a
// `(text) => number` plus a numeric budget — satisfying the TokenAccounting substrate
// without this package importing model. Plan 06's binding passes
// `TokenAccounting.estimate` through the capability.

import { canonicalJson } from '@vostride/agent-qa-schema'
import type {
  AiJudgmentEvidence,
  ArtifactRef,
  AssertValueEvidence,
  CompletedRunHandoff,
  ConditionVerdictsEvidence,
  LimitStopEvidence,
  MemberTestOutcome,
  PerTestOutcome,
  ServedBrief,
  ServedRetrievalTraceV1,
  StepEvidence,
  TerminationEvidence,
} from '@vostride/agent-qa-schema'

/**
 * Neighbor steps quoted either side of the failing step.
 *
 * Pinned, not config; retune from operational evidence: raise if discriminators
 * in real transcripts routinely cite out-of-window steps; never add a knob for it.
 */
export const EVIDENCE_WINDOW_STEPS = 2

/**
 * The rung-4 per-field quote cap, in characters.
 *
 * Pinned, not config; retune from operational evidence: raise if discriminating
 * error text is routinely cut mid-signal at this cap in real over-budget transcripts.
 */
export const QUOTE_FIELD_CAP = 500

/** The stable test identity the history lookup is keyed by — filePath + testName, NEVER testId. */
export interface EvidenceTestIdentity {
  readonly filePath: string
  readonly testName: string
}

export interface EvidenceOutcomeEntry {
  readonly buildOrdinal: number
  readonly passed: boolean
}

/**
 * Minimal structural mirror of knowledge-local's `TestOutcomeHistory` (plan 02). Declared
 * locally on purpose: this package never imports knowledge-local; the capability that feeds
 * it is declared in plan 04's kinds.ts change and bound in plan 06, and structural typing
 * makes the real record assignable here unchanged.
 */
export interface EvidenceTestHistory {
  readonly passes: number
  readonly failures: number
  readonly heals: number
  readonly flakeCount: number
  readonly lastOutcomes: readonly EvidenceOutcomeEntry[]
  readonly lastBuildOrdinal: number | undefined
}

export type EvidenceHistoryLookup = (
  identity: EvidenceTestIdentity,
) => EvidenceTestHistory | undefined

/**
 * Forced channel 1: the prior-build outcome, always typed, never faked. `no-history` = the
 * lookup answered nothing for this identity; `no-prior-build` = history exists but holds no
 * entry STRICTLY below the current build — mirroring plan 02's `priorBuildOutcome` law
 * (greatest ordinal strictly below current, typed absence otherwise).
 */
export type PriorBuildChannel =
  | { readonly kind: 'no-history' }
  | { readonly kind: 'no-prior-build' }
  | { readonly kind: 'prior-build'; readonly buildOrdinal: number; readonly passed: boolean }

/**
 * Forced channel 2: the failing step's served brief and serve-time retrieval trace,
 * verbatim. `no-failing-step` is the zero-step posture — a suite-bootstrap failure recorded
 * no step, so there is no brief to quote and none is fabricated.
 */
export type MemoryChannel =
  | { readonly kind: 'no-failing-step' }
  | {
      readonly kind: 'served'
      readonly servedBrief: ServedBrief
      readonly retrievalTrace: ServedRetrievalTraceV1 | undefined
    }

export interface EvidenceSubActionQuote {
  readonly plan: string
  readonly error?: string
}

export interface EvidenceStepQuote {
  readonly stepIndex: number
  readonly role: 'failing' | 'neighbor'
  readonly stepText: string
  readonly verifierReasoning: string
  readonly subActions: readonly EvidenceSubActionQuote[]
  readonly reportedValue?: string
  readonly aiJudgment?: AiJudgmentEvidence
  readonly assertOutcome?: AssertValueEvidence
  readonly termination?: TerminationEvidence
  readonly limitStop?: LimitStopEvidence
  readonly conditionVerdicts?: ConditionVerdictsEvidence
}

export interface EvidencePack {
  readonly testIndex: number
  readonly filePath: string
  readonly testName: string
  readonly outcome: MemberTestOutcome
  /** The failing step's recorded index. Absent exactly when the test captured zero steps. */
  readonly failingStepIndex?: number
  readonly steps: readonly EvidenceStepQuote[]
  /** The zero-step posture: the test-level outcome quoted verbatim, no fabricated step. */
  readonly testLevelQuote?: string
  /** The failing step's decision-screenshot refs, deduped by sha. Refs only, never bytes. */
  readonly screenshotRefs: readonly ArtifactRef[]
  readonly priorBuild: PriorBuildChannel
  readonly memory: MemoryChannel
}

/**
 * The failing step: the FIRST step whose verifier verdict failed, else the LAST step (a
 * failed test whose steps all verified — e.g. a timeout after the last verified step —
 * still has its most recent step as the evidence anchor). Returns the ARRAY position, so
 * the window below can never index outside `steps[]` whatever the recorded `stepIndex`
 * values are.
 */
function failingStepPosition(steps: readonly StepEvidence[]): number {
  const failed = steps.findIndex((step) => !step.verifierVerdict.pass)
  return failed === -1 ? steps.length - 1 : failed
}

function quoteStep(step: StepEvidence, role: 'failing' | 'neighbor'): EvidenceStepQuote {
  return {
    stepIndex: step.stepIndex,
    role,
    stepText: step.stepText,
    verifierReasoning: step.verifierVerdict.reasoning,
    subActions: step.subActions.map((subAction) => ({
      plan: subAction.plan,
      ...(subAction.result.error === undefined ? {} : { error: subAction.result.error }),
    })),
    ...(step.reportedValue === undefined ? {} : { reportedValue: step.reportedValue.value }),
    ...(step.aiJudgment === undefined ? {} : { aiJudgment: step.aiJudgment }),
    ...(step.assertOutcome === undefined ? {} : { assertOutcome: step.assertOutcome }),
    ...(step.termination === undefined ? {} : { termination: step.termination }),
    ...(step.limitStop === undefined ? {} : { limitStop: step.limitStop }),
    ...(step.conditionVerdicts === undefined
      ? {}
      : { conditionVerdicts: withoutFileText(step.conditionVerdicts) }),
  }
}

/** A saved file's text never enters a prompt: keep only its verdicts. */
function withoutFileText(block: ConditionVerdictsEvidence): ConditionVerdictsEvidence {
  return {
    ...block,
    conditions: block.conditions.map(({ file, ...condition }) => ({
      ...condition,
      ...(file === undefined ? {} : { file: { name: file.name, content: file.content } }),
    })),
  }
}

/** Dedupe by sha, first occurrence wins — the refs are content-addressed, so equal sha = equal bytes. */
function collectScreenshotRefs(step: StepEvidence): ArtifactRef[] {
  const seen = new Set<string>()
  const refs: ArtifactRef[] = []
  for (const subAction of step.subActions) {
    const ref = subAction.decisionScreenshotRef
    if (ref === undefined || seen.has(ref.sha)) continue
    seen.add(ref.sha)
    refs.push(ref)
  }
  return refs
}

/** Plan 02's strictly-below law, mirrored: the greatest ordinal STRICTLY below current. */
function priorBuildChannel(
  history: EvidenceTestHistory | undefined,
  currentBuildOrdinal: number,
): PriorBuildChannel {
  if (history === undefined) return { kind: 'no-history' }
  let prior: EvidenceOutcomeEntry | undefined
  for (const entry of history.lastOutcomes) {
    if (entry.buildOrdinal >= currentBuildOrdinal) continue
    if (prior === undefined || entry.buildOrdinal >= prior.buildOrdinal) prior = entry
  }
  if (prior === undefined) return { kind: 'no-prior-build' }
  return { kind: 'prior-build', buildOrdinal: prior.buildOrdinal, passed: prior.passed }
}

function packFor(
  test: PerTestOutcome,
  currentBuildOrdinal: number,
  history: EvidenceHistoryLookup,
): EvidencePack {
  const priorBuild = priorBuildChannel(
    history({ filePath: test.filePath, testName: test.testName }),
    currentBuildOrdinal,
  )

  if (test.steps.length === 0) {
    return {
      testIndex: test.testIndex,
      filePath: test.filePath,
      testName: test.testName,
      outcome: test.outcome,
      steps: [],
      testLevelQuote: test.outcome,
      screenshotRefs: [],
      priorBuild,
      memory: { kind: 'no-failing-step' },
    }
  }

  const failingAt = failingStepPosition(test.steps)
  const failingStep = test.steps[failingAt] as StepEvidence
  const windowStart = Math.max(0, failingAt - EVIDENCE_WINDOW_STEPS)
  const windowEnd = Math.min(test.steps.length, failingAt + EVIDENCE_WINDOW_STEPS + 1)
  const steps = test.steps
    .slice(windowStart, windowEnd)
    .map((step, offset) =>
      quoteStep(step, windowStart + offset === failingAt ? 'failing' : 'neighbor'),
    )

  return {
    testIndex: test.testIndex,
    filePath: test.filePath,
    testName: test.testName,
    outcome: test.outcome,
    failingStepIndex: failingStep.stepIndex,
    steps,
    screenshotRefs: collectScreenshotRefs(failingStep),
    priorBuild,
    memory: {
      kind: 'served',
      servedBrief: failingStep.servedBrief,
      retrievalTrace: failingStep.retrievalTrace,
    },
  }
}

/**
 * Build one evidence pack per requested test, in trajectory order.
 *
 * `unknownTests` is the caller's selection — testIndex values of the unknown-verdict failed
 * tests (plan 04 selects them through `resolveRunVerdicts`); an index with no matching test
 * contributes nothing. `history` is keyed by the stable test identity — filePath + testName,
 * never testId (per-test-outcome.ts identity law) — and is consulted exactly once per pack.
 */
export function buildEvidencePacks(
  handoff: CompletedRunHandoff,
  unknownTests: readonly number[],
  history: EvidenceHistoryLookup,
): EvidencePack[] {
  const requested = new Set(unknownTests)
  return handoff.tests
    .filter((test) => requested.has(test.testIndex))
    .map((test) => packFor(test, handoff.buildOrdinal, history))
}

export type EvidenceTokenEstimator = (text: string) => number

export interface CompactedEvidence {
  readonly packs: readonly EvidencePack[]
  /** The first rung at which the estimate fit — or 4 with `overBudget` when none did. */
  readonly rung: 0 | 1 | 2 | 3 | 4
  /**
   * True = even rung 4 exceeds the budget. The rung-4 result is still returned whole — the
   * model call may yet succeed, and silently dropping tests or forced channels is exactly
   * what this module refuses to do; the author surfaces the flag.
   */
  readonly overBudget: boolean
  /** The estimator's answer for the returned packs' canonical bytes. */
  readonly estimatedTokens: number
}

function truncateQuote(text: string): string {
  return text.length <= QUOTE_FIELD_CAP ? text : text.slice(0, QUOTE_FIELD_CAP)
}

function truncateStepQuote(quote: EvidenceStepQuote): EvidenceStepQuote {
  return {
    ...quote,
    stepText: truncateQuote(quote.stepText),
    verifierReasoning: truncateQuote(quote.verifierReasoning),
    subActions: quote.subActions.map((subAction) => ({
      plan: truncateQuote(subAction.plan),
      ...(subAction.error === undefined ? {} : { error: truncateQuote(subAction.error) }),
    })),
    ...(quote.reportedValue === undefined
      ? {}
      : { reportedValue: truncateQuote(quote.reportedValue) }),
    ...(quote.aiJudgment === undefined
      ? {}
      : {
          aiJudgment: {
            ...quote.aiJudgment,
            ...(quote.aiJudgment.rationale === undefined
              ? {}
              : { rationale: truncateQuote(quote.aiJudgment.rationale) }),
          },
        }),
    ...(quote.assertOutcome === undefined
      ? {}
      : {
          assertOutcome: {
            ...quote.assertOutcome,
            ...(quote.assertOutcome.expected === undefined
              ? {}
              : { expected: truncateQuote(quote.assertOutcome.expected) }),
            ...(quote.assertOutcome.actual === undefined || quote.assertOutcome.actual === null
              ? {}
              : { actual: truncateQuote(quote.assertOutcome.actual) }),
          },
        }),
    ...(quote.termination === undefined
      ? {}
      : {
          termination: {
            ...quote.termination,
            reason: truncateQuote(quote.termination.reason),
          },
        }),
    ...(quote.limitStop === undefined
      ? {}
      : {
          limitStop: {
            ...quote.limitStop,
            reason: truncateQuote(quote.limitStop.reason),
            ...(quote.limitStop.lastVerifierRejection === undefined
              ? {}
              : { lastVerifierRejection: truncateQuote(quote.limitStop.lastVerifierRejection) }),
            ...(quote.limitStop.lastPlannerReasoning === undefined
              ? {}
              : { lastPlannerReasoning: truncateQuote(quote.limitStop.lastPlannerReasoning) }),
          },
        }),
  }
}

/** Keep quotes within `radius` ARRAY positions of the failing quote; zero-step packs pass through. */
function shrinkWindow(pack: EvidencePack, radius: number): EvidencePack {
  const failingAt = pack.steps.findIndex((quote) => quote.role === 'failing')
  if (failingAt === -1) return pack
  return {
    ...pack,
    steps: pack.steps.filter((_, position) => Math.abs(position - failingAt) <= radius),
  }
}

/**
 * The pinned rung table, applied CUMULATIVELY in order — a later rung never re-introduces
 * what an earlier one removed. The failing step and both forced channels survive every
 * rung untouched; rung 4 caps quote-field lengths only.
 *
 *   rung 1  strip screenshotRefs from every pack (D-02/L9 text-only degradation)
 *   rung 2  shrink the neighbor window to ±1
 *   rung 3  drop neighbor steps entirely — the failing step stays whole
 *   rung 4  truncate per-field quote lengths to QUOTE_FIELD_CAP
 */
const COMPACTION_RUNGS: readonly ((packs: readonly EvidencePack[]) => EvidencePack[])[] = [
  (packs) => packs.map((pack) => ({ ...pack, screenshotRefs: [] })),
  (packs) => packs.map((pack) => shrinkWindow(pack, 1)),
  (packs) => packs.map((pack) => shrinkWindow(pack, 0)),
  (packs) =>
    packs.map((pack) => ({
      ...pack,
      steps: pack.steps.map(truncateStepQuote),
      ...(pack.testLevelQuote === undefined
        ? {}
        : { testLevelQuote: truncateQuote(pack.testLevelQuote) }),
    })),
]

/**
 * Walk the pinned rungs until the estimate fits the budget. Deterministic over the injected
 * estimator: same packs, same estimator, same budget — same rung, same bytes. The estimate
 * is taken over the packs' `canonicalJson` bytes, a stable proxy for the volatile-tier text
 * plan 04's author renders from them.
 */
export function compactEvidencePacks(
  packs: readonly EvidencePack[],
  estimate: EvidenceTokenEstimator,
  inputBudget: number,
): CompactedEvidence {
  let current: readonly EvidencePack[] = packs
  let estimated = estimate(canonicalJson(current))
  if (estimated <= inputBudget) {
    return { packs: current, rung: 0, overBudget: false, estimatedTokens: estimated }
  }
  for (const [position, rung] of COMPACTION_RUNGS.entries()) {
    current = rung(current)
    estimated = estimate(canonicalJson(current))
    if (estimated <= inputBudget) {
      return {
        packs: current,
        rung: (position + 1) as 1 | 2 | 3 | 4,
        overBudget: false,
        estimatedTokens: estimated,
      }
    }
  }
  return { packs: current, rung: 4, overBudget: true, estimatedTokens: estimated }
}
