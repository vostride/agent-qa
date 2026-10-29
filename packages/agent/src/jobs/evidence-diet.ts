// Packs quote evidence verbatim; compaction squeezes the window, never the forced channels.

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

export const EVIDENCE_WINDOW_STEPS = 2

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

// A structural mirror of knowledge-local's `TestOutcomeHistory`, which this package cannot import.
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

// `no-prior-build` means history exists but holds no entry strictly below the current build.
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

/** The greatest ordinal strictly below current. */
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

// `history` is keyed by `filePath` + `testName`, never `testId`, and read once per pack.
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

// Rungs apply cumulatively in order; the failing step and both forced channels survive every rung.
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

// Deterministic over the injected estimator, measured on the packs' `canonicalJson` bytes.
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
