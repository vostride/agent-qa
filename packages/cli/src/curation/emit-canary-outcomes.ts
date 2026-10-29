import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import {
  admitAnalysisArtifactForRun,
  ANALYSIS_FILE,
  canonicalJson,
  guardRunAnalysisArtifact,
  normalizeAnchor,
  resolveRunVerdicts,
  type Anchor,
  type CanaryOutcome,
  type CompletedRunHandoff,
  type PerTestOutcome,
  type RecordId,
  type RunAnalysisArtifact,
  type StepEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'

import { exercisedAnchors } from './handoff-anchors.js'
import { creditCanaryAttributions, type CanaryCreditCounters } from './canary-credit.js'

// The runtime and never-bar checks pin this closed vocabulary.
export type NonSignalClass = 'environment' | 'timeout' | 'flake'
// prettier-ignore
export const NON_SIGNAL_CLASSES = ['environment', 'timeout', 'flake'] as const satisfies readonly NonSignalClass[]
const NON_ATTRIBUTABLE_FAILURES = new Set<string>(NON_SIGNAL_CLASSES)
export function isNonSignalClass(value: string): value is NonSignalClass {
  return NON_ATTRIBUTABLE_FAILURES.has(value)
}

// Clean passes keep their persisted class; `resolveRunVerdicts` then overwrites what it governs.
type ResolvedClasses = ReadonlyMap<number, Verdict['class']>

function resolveAttributionClasses(
  artifact: RunAnalysisArtifact | undefined,
  handoff: CompletedRunHandoff,
): ResolvedClasses {
  const classes = new Map<number, Verdict['class']>()
  for (const member of handoff.tests) {
    if (member.rootCause !== undefined) classes.set(member.testIndex, member.rootCause.class)
  }
  for (const verdict of resolveRunVerdicts(artifact, handoff)) {
    classes.set(verdict.perTest, verdict.class)
  }
  return classes
}

// An artifact recording another run's id folds to the floor; a newer schema fails hard.
function loadRunAnalysisArtifact(
  runDir: string,
  runId: string,
): RunAnalysisArtifact | undefined {
  let bytes: string
  try {
    bytes = readFileSync(join(runDir, ANALYSIS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const admission = admitAnalysisArtifactForRun(
    guardRunAnalysisArtifact(JSON.parse(bytes)),
    runId,
  )
  return admission.kind === 'admitted' ? admission.artifact : undefined
}

// Only guard misses that show staleness attribute negatives; policy walls never damn the procedure.
const STALENESS_MISS_REASONS = new Set([
  'descriptor-ambiguous',
  'descriptor-missing',
  'page-anchor-mismatch',
])

export interface ProjectCanaryOutcomesInput {
  handoff: CompletedRunHandoff
  // Taken as an argument, so identical handoff and artifact bytes yield identical outcomes.
  artifact?: RunAnalysisArtifact
  resolveCandidateAnchors: (id: RecordId) => CandidateAnchorResolution
}

export type CandidateAnchorResolution =
  | { kind: 'resolved'; anchors: Anchor[] }
  | { kind: 'unresolved'; reason: 'not-found' | 'invalid' | 'lookup-error'; detail?: string }

export type EmitCanaryOutcomeResult =
  | { kind: 'non-signal'; class: NonSignalClass }
  | { kind: 'emitted' }
  | { kind: 'refused'; reason: 'emit-error' }
  | {
      kind: 'unresolved'
      reason: Extract<CandidateAnchorResolution, { kind: 'unresolved' }>['reason']
      detail?: string
    }

export type EmitCanaryOutcomeDetail = {
  benefit?: never
  candidateId?: never
  stepIndex?: never
  testId: string
  testIndex: number
  outcome: { kind: 'rerun-excluded' }
} | {
  benefit: CanaryOutcome['benefit']
  candidateId: RecordId
  testId: string
  testIndex: number
  stepIndex: number
  outcome: EmitCanaryOutcomeResult
}

export interface EmitCanaryOutcomeReport {
  canary: CanaryCreditCounters
  emitted: number
  refused: number
  unresolved: number
  // Per-source split of the `planSource` attribution stream; totals cover both sources.
  procedure: {
    emitted: number
    refused: number
    unresolved: number
  }
  details: EmitCanaryOutcomeDetail[]
}

export interface EmitCanaryOutcomesOptions {
  handoff: CompletedRunHandoff
  /** Absolute agent-qa-knowledge root used for store lookup and durable queue emission. */
  knowledgeRoot: string
  /** Absolute completed-run directory retained to keep the two post-verdict emit seams aligned. */
  runDir: string
  emit: (outcome: CanaryOutcome) => void
}

function normalizedKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

// The class switch consumes the resolved class, never the handoff field.
function nonAttributableFailure(test: PerTestOutcome, resolved: ResolvedClasses): boolean {
  const resolvedClass = resolved.get(test.testIndex)
  return resolvedClass !== undefined && NON_ATTRIBUTABLE_FAILURES.has(resolvedClass)
}

function attributedOutcome(
  test: PerTestOutcome,
  step: StepEvidence,
  resolved: ResolvedClasses,
): CanaryOutcome['runOutcome'] | undefined {
  if (step.verifierVerdict.pass) return 'positive'
  if (nonAttributableFailure(test, resolved)) return undefined
  return 'negative'
}

// A positive needs complete replay in a passing test; negatives stay root-cause gated.
function procedureReplayOutcome(
  test: PerTestOutcome,
  step: StepEvidence,
  resolved: ResolvedClasses,
): CanaryOutcome['runOutcome'] | undefined {
  const source = step.planSource
  if (source === undefined || source.kind !== 'procedure-replay') return undefined
  if (source.guard.executionFailure !== undefined) {
    return nonAttributableFailure(test, resolved) ? undefined : 'negative'
  }
  if (source.guard.verifierRejection !== undefined) {
    return nonAttributableFailure(test, resolved) ? undefined : 'negative'
  }
  const miss = source.guard.miss
  if (miss === undefined) {
    const outcome = attributedOutcome(test, step, resolved)
    if (outcome === 'positive' && source.guard.checksPassed !== source.guard.total) {
      return undefined
    }
    if (outcome === 'positive' && test.outcome !== 'passed') {
      return undefined
    }
    return outcome
  }
  if (!STALENESS_MISS_REASONS.has(miss.reason)) return undefined
  return nonAttributableFailure(test, resolved) ? undefined : 'negative'
}

function servedCanaryIds(step: StepEvidence): RecordId[] {
  const seen = new Set<RecordId>()
  const ids: RecordId[] = []
  // Pin 1 is deliberately Channel-1-only: ReadTrace has no servedAsCanary authority.
  for (const line of step.servedBrief.channel1) {
    if (!line.servedAsCanary || seen.has(line.id)) continue
    seen.add(line.id)
    ids.push(line.id)
  }
  return ids
}

function firstMatchingAnchor(
  candidateAnchors: readonly Anchor[],
  stepAnchors: readonly Anchor[],
): Anchor | undefined {
  const exercisedByKey = new Map(
    stepAnchors.map((anchor) => [normalizedKey(anchor), normalizeAnchor(anchor)]),
  )
  for (const candidateAnchor of candidateAnchors) {
    const match = exercisedByKey.get(normalizedKey(candidateAnchor))
    if (match !== undefined) return match
  }
  return undefined
}

type AttributionSource = 'served-brief' | 'procedure-replay'

export type ProjectedCanaryAttribution =
  | { kind: 'rerun-excluded'; testId: string; testIndex: number }
  | {
      kind: 'non-signal'
      source: AttributionSource
      class: NonSignalClass
      candidateId: RecordId
      testId: string
      testIndex: number
      stepIndex: number
    }
  | {
      kind: 'outcome'
      source: AttributionSource
      outcome: CanaryOutcome
    }
  | {
      kind: 'unresolved'
      source: AttributionSource
      candidateId: RecordId
      testId: string
      testIndex: number
      stepIndex: number
      reason: Extract<CandidateAnchorResolution, { kind: 'unresolved' }>['reason']
      detail?: string
    }

function projectCanaryAttributions(
  input: ProjectCanaryOutcomesInput,
): ProjectedCanaryAttribution[] {
  const resolutionByCandidate = new Map<RecordId, CandidateAnchorResolution>()
  const resolveAnchors = (id: RecordId): CandidateAnchorResolution => {
    if (!resolutionByCandidate.has(id)) {
      try {
        resolutionByCandidate.set(id, input.resolveCandidateAnchors(id))
      } catch (error) {
        resolutionByCandidate.set(id, {
          kind: 'unresolved',
          reason: 'lookup-error',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return resolutionByCandidate.get(id)!
  }

  // Resolved once per fold, consumed by every class-switched site below.
  const resolved = resolveAttributionClasses(input.artifact, input.handoff)

  const projected: ProjectedCanaryAttribution[] = []
  for (const test of input.handoff.tests) {
    // One diagnostic per member, before either attribution source or lookup.
    if (test.isRerun === true) {
      projected.push({ kind: 'rerun-excluded', testId: test.testId, testIndex: test.testIndex })
      continue
    }
    for (const step of test.steps) {
      projectBriefAttributions(input, test, step, resolveAnchors, resolved, projected)
      projectProcedureAttribution(input, test, step, resolveAnchors, resolved, projected)
    }
  }
  return projected
}

function projectBriefAttributions(
  input: ProjectCanaryOutcomesInput,
  test: PerTestOutcome,
  step: StepEvidence,
  resolveAnchors: (id: RecordId) => CandidateAnchorResolution,
  resolved: ResolvedClasses,
  projected: ProjectedCanaryAttribution[],
): void {
  const runOutcome = attributedOutcome(test, step, resolved)
  const resolvedClass = resolved.get(test.testIndex)
  if (runOutcome === undefined) {
    if (resolvedClass === undefined || !isNonSignalClass(resolvedClass)) return
    for (const candidateId of servedCanaryIds(step)) {
      projected.push({ kind: 'non-signal', source: 'served-brief', class: resolvedClass,
        candidateId, testId: test.testId, testIndex: test.testIndex, stepIndex: step.stepIndex })
    }
    return
  }
  const stepAnchors = exercisedAnchors(step)
  if (stepAnchors.length === 0) return

  for (const candidateId of servedCanaryIds(step)) {
    const resolution = resolveAnchors(candidateId)
    if (resolution.kind === 'unresolved') {
      projected.push({
        kind: 'unresolved',
        source: 'served-brief',
        candidateId,
        testId: test.testId,
        testIndex: test.testIndex,
        stepIndex: step.stepIndex,
        reason: resolution.reason,
        ...(resolution.detail === undefined ? {} : { detail: resolution.detail }),
      })
      continue
    }
    const exercisedAnchor = firstMatchingAnchor(resolution.anchors, stepAnchors)
    if (exercisedAnchor === undefined) continue
    projected.push({
      kind: 'outcome',
      source: 'served-brief',
      outcome: {
        candidateId,
        runOutcome,
        // The credit pass sets the benefit from the run outcome.
        benefit: 'rode-along',
        runId: String(input.handoff.runId),
        testId: test.testId,
        testIndex: test.testIndex,
        buildOrdinal: input.handoff.buildOrdinal,
        stepIndex: step.stepIndex,
        briefDigest: step.servedBrief.briefDigest,
        attribution: [
          `Candidate ${candidateId}`,
          `matched ${canonicalJson(exercisedAnchor)}`,
          `on test ${test.testIndex} (${test.testId}) step ${step.stepIndex}`,
          `with ${runOutcome} verdict`,
        ].join(' '),
        exercisedAnchor,
      } satisfies CanaryOutcome,
    })
  }
}

// Replay is direct exercise, so no anchor-contact match is required for this source.
function projectProcedureAttribution(
  input: ProjectCanaryOutcomesInput,
  test: PerTestOutcome,
  step: StepEvidence,
  resolveAnchors: (id: RecordId) => CandidateAnchorResolution,
  resolved: ResolvedClasses,
  projected: ProjectedCanaryAttribution[],
): void {
  const source = step.planSource
  if (source === undefined || source.kind !== 'procedure-replay') return
  const runOutcome = procedureReplayOutcome(test, step, resolved)
  if (runOutcome === undefined) {
    const resolvedClass = resolved.get(test.testIndex)
    const failed = source.guard.executionFailure !== undefined
      || source.guard.verifierRejection !== undefined
      || (source.guard.miss !== undefined && STALENESS_MISS_REASONS.has(source.guard.miss.reason))
      || (source.guard.miss === undefined && !step.verifierVerdict.pass)
    if (failed && resolvedClass !== undefined && isNonSignalClass(resolvedClass)) {
      projected.push({ kind: 'non-signal', source: 'procedure-replay', class: resolvedClass,
        candidateId: source.procedureId, testId: test.testId, testIndex: test.testIndex,
        stepIndex: step.stepIndex })
    }
    return
  }

  const resolution = resolveAnchors(source.procedureId)
  if (resolution.kind === 'unresolved') {
    projected.push({
      kind: 'unresolved',
      source: 'procedure-replay',
      candidateId: source.procedureId,
      testId: test.testId,
      testIndex: test.testIndex,
      stepIndex: step.stepIndex,
      reason: resolution.reason,
      ...(resolution.detail === undefined ? {} : { detail: resolution.detail }),
    })
    return
  }
  const anchor = resolution.anchors[0]
  if (anchor === undefined) return
  const miss = source.guard.miss
  const executionFailure = source.guard.executionFailure
  const verifierRejection = source.guard.verifierRejection
  const attributionDetail = executionFailure !== undefined
    ? `with execution failure at procedure step ${executionFailure.procedureStepIndex}`
    : verifierRejection !== undefined
      ? `with verifier rejection at procedure step ${verifierRejection.procedureStepIndex}`
      : miss !== undefined
        ? `with guard miss ${miss.reason} at procedure step ${miss.procedureStepIndex}`
        : `with ${runOutcome} verdict`
  projected.push({
    kind: 'outcome',
    source: 'procedure-replay',
    outcome: {
      candidateId: source.procedureId,
      runOutcome,
      // The credit pass sets the benefit from the run outcome.
      benefit: 'rode-along',
      runId: String(input.handoff.runId),
      testId: test.testId,
      testIndex: test.testIndex,
      buildOrdinal: input.handoff.buildOrdinal,
      stepIndex: step.stepIndex,
      briefDigest: step.servedBrief.briefDigest,
      attribution: [
        `Procedure ${source.procedureId} replayed`,
        `on test ${test.testIndex} (${test.testId}) step ${step.stepIndex}`,
        attributionDetail,
      ].join(' '),
      exercisedAnchor: normalizeAnchor(anchor),
    } satisfies CanaryOutcome,
  })
}

/** Pure Pin-1 projection: identical handoff + canonical snapshot yields identical outcome bytes. */
export function projectCanaryOutcomes(
  input: ProjectCanaryOutcomesInput,
): CanaryOutcome[] {
  return projectCanaryAttributions(input).flatMap((projected) =>
    projected.kind === 'outcome' ? [projected.outcome] : [],
  )
}

/** Resolves anchors read-only, sets each benefit, then emits every attribution in isolation. */
export async function emitCanaryOutcomes(opts: EmitCanaryOutcomesOptions): Promise<EmitCanaryOutcomeReport> {
  if (!isAbsolute(opts.knowledgeRoot)) throw new TypeError('knowledgeRoot must be absolute')
  if (!isAbsolute(opts.runDir)) throw new TypeError('runDir must be absolute')

  // Loaded once per fold, so an upgraded run re-folds with flipped attribution.
  const artifact = loadRunAnalysisArtifact(opts.runDir, String(opts.handoff.runId))
  const projected = projectCanaryAttributions({
    handoff: opts.handoff,
    ...(artifact === undefined ? {} : { artifact }),
    resolveCandidateAnchors: (id) => LOCAL_CURATION_CAPABILITIES.readCanonicalBundleAnchors({
      knowledgeRoot: opts.knowledgeRoot,
      bundleId: id,
    }),
  })
  const credit = creditCanaryAttributions({ attributions: projected })
  const report: EmitCanaryOutcomeReport = {
    canary: credit.counters,
    emitted: 0,
    refused: 0,
    unresolved: 0,
    procedure: { emitted: 0, refused: 0, unresolved: 0 },
    details: [],
  }

  for (const attribution of credit.attributions) {
    if (attribution.kind === 'rerun-excluded') {
      report.canary.rerunExcluded += 1
      report.details.push({ testId: attribution.testId, testIndex: attribution.testIndex,
        outcome: { kind: 'rerun-excluded' } })
      continue
    }
    if (attribution.kind === 'non-signal') {
      report.canary.nonSignal[attribution.class] += 1
      report.details.push({ benefit: 'rode-along', candidateId: attribution.candidateId,
        testId: attribution.testId, testIndex: attribution.testIndex, stepIndex: attribution.stepIndex,
        outcome: { kind: 'non-signal', class: attribution.class } })
      continue
    }
    const fromProcedure = attribution.source === 'procedure-replay'
    if (attribution.kind === 'unresolved') {
      report.unresolved += 1
      if (fromProcedure) report.procedure.unresolved += 1
      report.details.push({
        benefit: 'rode-along',
        candidateId: attribution.candidateId,
        testId: attribution.testId,
        testIndex: attribution.testIndex,
        stepIndex: attribution.stepIndex,
        outcome: {
          kind: 'unresolved',
          reason: attribution.reason,
          ...(attribution.detail === undefined ? {} : { detail: attribution.detail }),
        },
      })
      continue
    }

    let outcome: EmitCanaryOutcomeResult
    try {
      opts.emit(attribution.outcome)
      outcome = { kind: 'emitted' }
      report.emitted += 1
      if (fromProcedure) report.procedure.emitted += 1
    } catch (error) {
      if (error instanceof TypeError) throw error
      outcome = { kind: 'refused', reason: 'emit-error' }
      report.refused += 1
      if (fromProcedure) report.procedure.refused += 1
    }
    report.details.push({
      benefit: attribution.outcome.benefit,
      candidateId: attribution.outcome.candidateId,
      testId: attribution.outcome.testId,
      testIndex: attribution.outcome.testIndex,
      stepIndex: attribution.outcome.stepIndex,
      outcome,
    })
  }
  return report
}
