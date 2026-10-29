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

/**
 * The masking seam. Every payload projection takes a `MaskFn` and routes every
 * string it produces through it. Pre-362 the CLI passes an identity function; 362's
 * masking-context seeding replaces it with the real redactor with ZERO further wiring —
 * the same discipline `StepEvidence.workingMemory` already follows.
 */
export type MaskFn = (text: string) => string

/**
 * Structural walk that applies `mask` to every string value reachable from `value`.
 * Arrays and plain objects are walked; numbers/booleans/null pass through unchanged.
 * Pure — the input is never mutated (a fresh structure is returned). This is the
 * terminal pass every projection runs so no value-bearing string field can escape the
 * D-09 seam.
 */
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

/**
 * `StepEvidence` → `stepFinalized` payload. Carries `cacheStatus`, the
 * `verifierVerdict`, a boolean `selfHealOccurred` FLAG (never the `selfHeal` body), and
 * the `briefDigest` — the `ServedBrief`'s own digest field travels, never its body.
 */
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
    // Phase 363 D-01 additive-optional appends (RESEARCH Q1). These are plain extra inputs
    // sourced from the runner `StepResult` — NOT fields on the §A8 StepEvidence DTO
    // (Pitfall 2). Omitted when absent so no undefined-hole survives JSON round-trip.
    ...(extra?.status !== undefined ? { status: extra.status } : {}),
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra?.error !== undefined ? { error: extra.error } : {}),
    // same spread-when-defined rule, for the same
    // reason — an unmeasured step carries NO key rather than a zero triple. The three
    // members are numbers, so `maskPayloadStrings` walks past them untouched.
    ...usage,
    ...(extra?.evidence !== undefined ? { evidence: extra.evidence } : {}),
    // Snapshot names are data-bearing keys. The terminal walk below masks their values.
    ...(extra?.variableSnapshot !== undefined
      ? { variableSnapshot: Object.fromEntries(
          Object.entries(extra.variableSnapshot).map(([name, value]) => [mask(name), value]),
        ) }
      : {}),
    // same spread-when-defined rule, read from the
    // EVIDENCE rather than from `extra` — unlike the 363 appends above, the rung IS a
    // `StepEvidence` field. A step whose evidence recorded no rung carries no key, so
    // absence on the wire keeps meaning "no ladder was named" and never "the top rung".
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

/**
 * `SubActionEvidence` → `subActionRecorded` payload. The raw `stateBefore`/
 * `stateAfter` are collapsed to `screenStateHash` identity strings and destructured away
 * (the `toRecordedActionResult` idiom — never `delete`); `result` is already a
 * `RecordedActionResult` by evidence construction so no live screenshot bytes ride the bus.
 *
 * 2026-08-27 (Phase 405 plan 01, D-14 · RESEARCH D1): `decisionScreenshotRef` STOPS BEING
 * DISCARDED. Until this date it was destructured out and voided beside `stateBefore`, and the
 * consequence was measured rather than suspected: `artifactRefs` is declared on the payload,
 * no runner code sets `evidence.artifactRefs`, and the ONE ref the runner does mint per live
 * decision — the sha-keyed decision screenshot the v50 `FsEvidenceArtifactStore` already
 * writes — reached the handoff and the analysis jobs and never the wire. So the dashboard's
 * projection had nothing to persist and the run-detail page had no screenshot to render.
 *
 * THIS IS CONTENT ON A FROZEN SHAPE, not a shape change (the 363 D-01 class, and RESEARCH
 * Open Q1 recorded here as the dated decision it is). The payload TYPE, the envelope and the
 * event NAME are untouched; an existing optional field acquires its first producer. The ref
 * is APPENDED to whatever `artifactRefs` the evidence already carried rather than replacing
 * it, because the two are different claims — "everything this sub-action produced" and "the
 * frame the planner decided from" — and a decision screenshot that silently displaced a
 * store-written ref would lose evidence to gain evidence.
 *
 * The array is spread in only when NON-EMPTY (the absent-is-spread-away idiom every optional
 * on this payload follows): an empty array would be a second spelling of "no artifacts", and
 * a reader that had to tell `[]` from missing would be learning a distinction nothing means.
 */
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

/**
 * `PerTestOutcome` → `testFinished` payload. Identity + `outcome` only; the
 * embedded `steps` array is destructured away and never rides the bus.
 */
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
    // Phase 363 D-01 additive-optional appends (RESEARCH Q1). Plain extra inputs sourced
    // from the runner `TestResult` — NOT fields on the §A8 PerTestOutcome DTO (Pitfall 2).
    // `failureSummary` is a string so it routes through the mask like every payload string.
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

// --- Hook lifecycle + retry projections (Phase 363 D-01 parity appends, spec §2.2) ----

/**
 * Hook identity → `hookStarted` payload. Pure structural pass: absent optional
 * identity fields are omitted (no undefined holes), every string routes through the mask.
 */
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

/**
 * Hook result → `hookFinished` payload. `stdout`/`stderr`/`error` and each
 * `variables` VALUE are routed through the mask by the terminal string walk — keys pass
 * through because {@link maskPayloadStrings} masks values only. Absent optionals are omitted.
 */
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

/**
 * Retry accounting → `testRetryScheduled` payload (resolves RESEARCH Open Q-3). No mask
 * param: the payload carries only identifiers and scheduling accounting (testId, indices,
 * attempt counts, a coarse reason) — no captured secret-bearing streams. Absent `reason`
 * is omitted so no undefined-hole survives JSON round-trip.
 */
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
