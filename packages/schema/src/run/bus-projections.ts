import { screenStateHash } from '../determinism/screen-hash'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { StepEvidence } from '../handoff/step-evidence'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import { projectObservedModelUsage } from './model-usage'
import type { ModelUsageObservations } from './model-usage'
import type {
  HookFinishedPayload,
  HookStartedPayload,
  StepFinalizedPayload,
  SubActionRecordedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
} from './bus-events'

// Every payload projection routes each string it produces through a `MaskFn`.
export type MaskFn = (text: string) => string

// The terminal pass of every projection, so no string escapes the mask; the input is not mutated.
export function maskPayloadStrings<T>(value: T, mask: MaskFn): T {
  return walk(value, mask) as T
}

function walk(value: unknown, mask: MaskFn): unknown {
  if (typeof value === 'string') {
    return mask(value)
  }
  if (Array.isArray(value)) {
    return value.map(entry => walk(entry, mask))
  }
  if (value !== null && typeof value === 'object') {
    // Define own properties even for a captured name such as __proto__.
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry, mask)]))
  }
  return value
}

/**
 * Like {@link maskPayloadStrings}, but also masks every object key, for documents whose keys are
 * data (op results, chat payloads, CLI output). Two keys of one object that mask to one name throw
 * instead of silently dropping a member; the message carries no value.
 */
export function maskPayloadTree<T>(value: T, mask: MaskFn): T {
  return walkTree(value, mask) as T
}

function walkTree(value: unknown, mask: MaskFn): unknown {
  if (typeof value === 'string') {
    return mask(value)
  }
  if (Array.isArray(value)) {
    return value.map(entry => walkTree(entry, mask))
  }
  if (value !== null && typeof value === 'object') {
    const masked: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const maskedKey = mask(key)
      if (Object.hasOwn(masked, maskedKey)) {
        throw new Error('two keys of one object mask to the same name')
      }
      Object.defineProperty(masked, maskedKey, {
        value: walkTree(entry, mask),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return masked
  }
  return value
}

// Only flags and digests travel: never the `selfHeal` body or the `ServedBrief` body.
export function projectStepFinalized(
  evidence: StepEvidence,
  ids: { testIndex: number; stepIndex: number },
  mask: MaskFn,
  extra?: {
    status?: StepFinalizedPayload['status']
    durationMs?: number
    error?: string
    tokenUsage?: StepFinalizedPayload['tokenUsage']
    modelUsage?: StepFinalizedPayload['modelUsage']
    modelObservations?: ModelUsageObservations
    evidence?: StepFinalizedPayload['evidence']
    variableSnapshot?: StepFinalizedPayload['variableSnapshot']
  },
): StepFinalizedPayload {
  const usage = extra?.modelObservations === undefined ? {
    ...(extra?.tokenUsage === undefined ? {} : { tokenUsage: extra.tokenUsage }),
    ...(extra?.modelUsage === undefined ? {} : { modelUsage: extra.modelUsage }),
  } : projectObservedModelUsage(extra.modelObservations)
  const payload: StepFinalizedPayload = {
    testIndex: ids.testIndex,
    stepIndex: ids.stepIndex,
    cacheStatus: evidence.cacheStatus,
    verifierVerdict: evidence.verifierVerdict,
    selfHealOccurred: evidence.selfHeal !== undefined,
    briefDigest: evidence.servedBrief.briefDigest,
    // Spread only when defined, so no undefined hole survives a JSON round-trip.
    ...(extra?.status !== undefined ? { status: extra.status } : {}),
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra?.error !== undefined ? { error: extra.error } : {}),
    // An unmeasured step carries no key rather than a zero triple.
    ...usage,
    ...(extra?.evidence !== undefined ? { evidence: extra.evidence } : {}),
    // Snapshot names are data-bearing keys. The terminal walk below masks their values.
    ...(extra?.variableSnapshot !== undefined
      ? { variableSnapshot: Object.fromEntries(
          Object.entries(extra.variableSnapshot).map(([name, value]) => [mask(name), value]),
        ) }
      : {}),
    // Absence keeps meaning no ladder was named, never the top rung.
    ...(evidence.retrievalRung !== undefined ? { retrievalRung: evidence.retrievalRung } : {}),
  }
  const masked = maskPayloadStrings(payload, mask)
  // Distinctness is defined on published identities; a live masker may collapse raw aliases.
  for (const facts of Object.values(masked.modelUsage?.roles ?? {})) {
    if (facts.respondingModelIds !== undefined) {
      facts.respondingModelIds = [...new Set(facts.respondingModelIds)]
    }
  }
  return masked
}

// The decision screenshot ref is appended to `artifactRefs`, never replacing a store-written ref.
export function projectSubActionRecorded(
  evidence: SubActionEvidence,
  ids: { testIndex: number; stepIndex: number; subActionIndex: number },
  mask: MaskFn,
  extra?: {
    ariaEvidence?: SubActionRecordedPayload['ariaEvidence']
    recordingOffsetMs?: number
  },
): SubActionRecordedPayload {
  const { stateBefore, stateAfter, decisionScreenshotRef, localEffect, ...rest } = evidence
  void stateBefore
  void stateAfter
  void localEffect

  const artifactRefs: readonly ArtifactRef[] = [
    ...(rest.artifactRefs ?? []),
    ...(decisionScreenshotRef === undefined ? [] : [decisionScreenshotRef]),
    ...(extra?.ariaEvidence?.state === 'present' ? [extra.ariaEvidence.ref] : []),
  ]

  const payload: SubActionRecordedPayload = {
    testIndex: ids.testIndex,
    stepIndex: ids.stepIndex,
    subActionIndex: ids.subActionIndex,
    plan: rest.plan,
    plannedAction: rest.plannedAction,
    result: rest.result,
    screenStateHash: screenStateHash(evidence.stateBefore),
    ...(rest.grounding !== undefined ? { grounding: rest.grounding } : {}),
    ...(evidence.stateAfter !== undefined
      ? { screenStateHashAfter: screenStateHash(evidence.stateAfter) }
      : {}),
    ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
    ...(extra?.ariaEvidence !== undefined ? { ariaEvidence: extra.ariaEvidence } : {}),
    ...(extra?.recordingOffsetMs !== undefined ? { recordingOffsetMs: extra.recordingOffsetMs } : {}),
  }
  return maskPayloadStrings(payload, mask)
}

export function projectTestFinished(
  outcome: PerTestOutcome,
  mask: MaskFn,
  extra?: {
    durationMs?: number
    failureSummary?: string
    retryCount?: number
    recording?: TestFinishedPayload['recording']
    name?: string
    filePath?: string
  },
): TestFinishedPayload {
  const { steps, ...rest } = outcome
  void steps

  const payload: TestFinishedPayload = {
    testId: rest.testId,
    testIndex: rest.testIndex,
    outcome: rest.outcome,
    // `failureSummary` is a string, so it passes through the mask like every payload string.
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra?.failureSummary !== undefined
      ? { failureSummary: extra.failureSummary }
      : {}),
    ...(extra?.retryCount !== undefined ? { retryCount: extra.retryCount } : {}),
    ...(extra?.recording !== undefined ? { recording: extra.recording } : {}),
    ...(extra?.name !== undefined ? { name: extra.name } : {}),
    ...(extra?.filePath !== undefined ? { filePath: extra.filePath } : {}),
  }
  return maskPayloadStrings(payload, mask)
}

export function projectHookStarted(
  input: HookStartedPayload,
  mask: MaskFn,
): HookStartedPayload {
  const payload: HookStartedPayload = {
    hookName: input.hookName,
    phase: input.phase,
    hookExecutionId: input.hookExecutionId,
    ...(input.hookId !== undefined ? { hookId: input.hookId } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.testIndex !== undefined ? { testIndex: input.testIndex } : {}),
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
  }
  return maskPayloadStrings(payload, mask)
}

// Masks values only, so `variables` keys pass through unmasked.
export function projectHookFinished(
  input: HookFinishedPayload,
  mask: MaskFn,
): HookFinishedPayload {
  const payload: HookFinishedPayload = {
    hookName: input.hookName,
    phase: input.phase,
    hookExecutionId: input.hookExecutionId,
    status: input.status,
    durationMs: input.durationMs,
    stdout: input.stdout,
    stderr: input.stderr,
    variables: { ...input.variables },
    ...(input.hookId !== undefined ? { hookId: input.hookId } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.testIndex !== undefined ? { testIndex: input.testIndex } : {}),
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
  }
  return maskPayloadStrings(payload, mask)
}

// No mask: the payload carries identifiers and retry counts only, never captured streams.
export function projectTestRetryScheduled(
  input: TestRetryScheduledPayload,
): TestRetryScheduledPayload {
  return {
    testId: input.testId,
    testIndex: input.testIndex,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
}
