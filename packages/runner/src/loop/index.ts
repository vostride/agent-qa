// Screen equality decides nothing; retries come only from actual errors or operation evidence.

import {
  coerceProcedureBindingValue,
  computeCacheKey,
  DEFAULT_PLANNER_LIMITS,
  elementOrdinal,
  formatLimitStopReason,
  isReplayableActionShape,
  normalizeAnchor,
  parseProcedureBody,
  procedureSourceBinding,
  readBindingOutcomeMeta,
  servingRecordMetadata,
  toRecordedActionResult,
  validRecordingAnnotation,
  validRecordedAnnotation,
} from '@vostride/agent-qa-schema'
import type {
  Action as SchemaAction,
  ActionAnnotation,
  CacheMissReason,
  ClipboardEvidence,
  CompoundInputCount,
  DownloadEvidence,
  InputEvidence,
  LimitStopEvidence,
  OperationCaptureAvailability,
  OperationEvidence,
  RecordingAnnotationWitness,
  ActionResult as SchemaActionResult,
  Anchor,
  AssertValueOp,
  CacheKey,
  CautionBlock,
  CautionLine,
  ConditionVerdictsEvidence,
  Decision,
  ElementInfo,
  GroundingAttempt,
  GroundingEvidence,
  ProcedureBodyPayload,
  ProcedureBindingAvailability,
  ProcedureGuardTarget,
  ProcedureMatch,
  ProcedureParamType,
  ProcedureStepSpec,
  RecordId,
  Ref,
  ScreenState,
  ServedRetrievalTraceV1,
  StepPlanSource,
  TargetDescriptor,
  TargetMismatchReason,
  TargetRefusalMeta,
  VerifierVerdict,
  Viewport,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'
import { wrapAppObservedData } from '@vostride/agent-qa-safety'
import type { Action, ActionResult, ExecuteOptions, OperationCaptureSupport } from '../platform.js'
import type { StepResult, StepTrace, SubActionTrace, TokenUsage } from '../result.js'
import { stampCaptureMode, type CaptureStamp } from '../screen-builder.js'
import { normalizePointerActionForStep } from '../tools/pointer-action-normalization.js'
import { defaultRegistry } from '../tools/registry.js'
import { classifyStep } from '../cache/classify.js'
import { buildCacheableStepInput } from '../cache/key.js'
import { buildCachedPlanValue } from '../cache/value.js'
import { deterministicDescriptorMatcher } from '../cache/reground.js'
import { groundActionPlan, requiresElementRef } from '../grounding/gate.js'
import { judgeStatedTarget, renderTargetMismatch } from '../grounding/stated-target.js'
import { rowTextOf } from '../grounding/row-text.js'
import { strictMatch } from '../grounding/strict-match.js'
import type {
  StatedTarget,
  StatedTargetLane,
  StatedTargets,
  TargetIdentity,
} from '../grounding/stated-target.js'
import type { CachedPlanValue } from '../cache/port.js'
import type { CarriedArtifacts, LoopPorts } from './ports.js'
import { guardActionData } from './blob-guard.js'
import type {
  ActionPlan,
  AiJudgment,
  AssertAiMode,
  ExtractField,
  PlanResult,
  StepContext,
  VerificationResult,
  VerifierAuthorContext,
} from './types.js'
import { VISUAL_CLAIM_WITHOUT_SCREENSHOT } from './types.js'
import { PlanningLimitReachedError, PlanningTurnError } from './planner.js'
import { withAbort, getTimeoutAbortReason } from './abort.js'
import {
  literalSecretMarkerRefusal,
  redactSecretValue,
  resolveSecretTemplatesInValue,
} from './secrets.js'
import {
  buildVerifierCitationSources,
  captureServedPromptTurn,
  estimateTokens,
  hasValidStepPosition,
  renderInputEvidence,
  renderOperationEvidence,
} from './prompts.js'
import { judgeConditions, type CitationSources, type ConditionGuardFacts } from './requested-conditions.js'
import { lineHolds, type SavedFile } from './condition-guards.js'
import {
  StepRecordAccumulator,
  readLine,
  type RecordedAction,
  type RecordedActionOutcome,
} from './step-record.js'
import { EvidenceRecorder, collapseAnnotation, persistAriaEvidence, projectLegacyTrace } from './evidence.js'
import type { RecordSubActionInput } from './evidence.js'
import { maskToolExchanges } from './mask-exchanges.js'
import { settle } from './settle.js'
import { desiredStateSatisfied } from '../compound/idempotency.js'
import {
  readUniqueValueMeta,
  readFillRereadMeta,
  readFillVerdictMeta,
  readScrollUntilVisibleMeta,
  readDownloadMeta,
  readClipboardMeta,
  readIdempotentNoopMeta,
  readFillSubmitMeta,
  readFillRefusalMeta,
  readShellActionMeta,
  CLIPBOARD_TEXT_LIMIT,
  CLIPBOARD_TRUNCATION_MARKER,
} from '../compound/metadata.js'
import type { ClipboardWriteMeta } from '../compound/metadata.js'
import { mintReportedValue, mintUniqueValue, defaultUniqueValueGenerator } from '../compound/dispatch-mint.js'
import { compareAssertValue, type AssertValueResult } from '../compound/assert-value.js'
import { createRecordLedger } from './record-ledger.js'
import { StepLimitMeter } from './step-limits.js'

// A planning error matching these gets the contextWindow/previousStepCount hint, not the raw error.
const CONTEXT_ERROR_PATTERNS = [
  'context length', 'maximum context', 'token limit',
  'too many tokens', 'exceeds.*max', 'input.*too long',
]

// Only stale-ref failures the re-ground heal can rescue; bare timeouts stay on the replan path.
const REF_RESOLUTION_FAILURE_PATTERNS: RegExp[] = [
  /^\s*Unknown ref\s+["']/i,
  /resolved to \d+ element/i,
]

function isRefResolutionFailure(errorMsg: string): boolean {
  return REF_RESOLUTION_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMsg))
}

// A new document (stale-observation) or a removed frame (frame-detached) never starts a heal.
function startsBindingHeal(result: ActionResult): boolean {
  const outcome = readBindingOutcomeMeta(result)?.outcome
  return outcome === 'binding-lost' || outcome === 'binding-changed'
}

function unprovenHealNote(reason: 'absent' | 'not-unique'): string {
  const found = reason === 'absent' ? 'none matches it' : 'more than one matches it'
  return 'The element was replaced or changed, and no single current element is provably the '
    + `same (role, exact name and row: ${found}), so nothing was sent.`
}

// A cancel can come from any door, so the record names no cause.
export const CANCELLED_MESSAGE = 'The run was cancelled before this step finished.'

// Fallbacks until the composition root supplies model-derived numbers; not config keys.
const PROVISIONAL_BRIEF_TOKEN_BUDGET = 512
const PROVISIONAL_CAUTION_TOKEN_BUDGET = 64
const PROVISIONAL_DISTINCT_RECORD_CAP = 8
const CAUTION_TRUNCATION_ID = 'caution:truncated'

// The first observation doubles as stateBefore, so only extra polls before two equal hashes cost.
const DEFAULT_SETTLE_MAX_POLLS = 3
const DEFAULT_SETTLE_INTERVAL_MS = 0
const VERIFY_SETTLE_INTERVAL_MS = 500

type LiveDecisionEvidence = Pick<RecordSubActionInput, 'exchanges' | 'callRecord' | 'decisionScreenshotRef'>
type RecordedPair = Pick<RecordSubActionInput, 'plannedAction' | 'stateBefore' | 'healedDispatch'>
type DecisionEvidence = LiveDecisionEvidence & Pick<RecordSubActionInput, 'operationEvidence'>

function recordingOffsetFrom(zeroMs: number | undefined): number | undefined {
  if (zeroMs === undefined) return undefined
  return Math.max(0, Math.round(performance.now() - zeroMs))
}

// Execution failures and rejected completions replan with failure context instead of returning.
export async function executeStep(
  stepInstruction: string,
  ports: LoopPorts,
  context: StepContext,
): Promise<StepResult> {
  const startTime = performance.now()
  // Modality is resolved once at composition; an absent gate means full capture.
  const gate = ports.visionGate ?? { attachImage: true, captureMode: 'full' as const, promptNote: '' }
  // One monotonic meter per step execution, never refilled and never derived from actionIndex.
  const meter = new StepLimitMeter({
    maxActions: ports.plannerConfig?.maxActions ?? DEFAULT_PLANNER_LIMITS.maxActions,
    maxPlanningTurns: ports.plannerConfig?.maxPlanningTurns ?? DEFAULT_PLANNER_LIMITS.maxPlanningTurns,
  })
  // Inner inputs of each executed compound action, keyed by its sub-action index.
  const compoundInputs: CompoundInputCount[] = []
  const promptDate = context.promptDate ?? new Date().toISOString().slice(0, 10)
  context.promptDate = promptDate
  const verifierAuthorContext: VerifierAuthorContext | undefined =
    context.suiteContext || context.testContext
      ? {
          ...(context.suiteContext ? { suiteContext: context.suiteContext } : {}),
          ...(context.testContext ? { testContext: context.testContext } : {}),
          ...(hasValidStepPosition(context)
            ? { stepNumber: context.stepNumber, stepCount: context.stepCount }
            : {}),
        }
      : undefined
  const recordCap = ports.knowledgeBudgets?.recordCap ?? PROVISIONAL_DISTINCT_RECORD_CAP
  const combinedBudget = (ports.knowledgeBudgets?.brief ?? PROVISIONAL_BRIEF_TOKEN_BUDGET)
    + (ports.knowledgeBudgets?.caution ?? PROVISIONAL_CAUTION_TOKEN_BUDGET)
    + (ports.beginMemoryTurn === undefined
      ? 0
      : (ports.knowledgeBudgets?.searchResults ?? PROVISIONAL_BRIEF_TOKEN_BUDGET))
  const deadline = ports.stepTimeout ? startTime + ports.stepTimeout : 0

  // A missing reader means no rung, and a rejected probe folds to `undefined`, never a failed step.
  const retrievalRung = ports.knowledgeReader === undefined || ports.knowledgeRetrievalRung === undefined
    ? undefined
    : await ports.knowledgeRetrievalRung.catch(() => undefined)
  const recorder = new EvidenceRecorder({
    scope: { tier: 'test', key: context.testName },
    asOfBuild: ports.knowledgeAsOfBuild ?? 0,
    onSubActionRecorded: (evidence, index) => {
      const recordingOffsetMs = recordingOffsetFrom(ports.recordingZeroMs)
      const ariaEvidence = persistAriaEvidence(evidence, ports.secretRedactor, ports.evidenceArtifacts)
      ports.events?.subActionRecorded(evidence, index, {
        ariaEvidence,
        ...(recordingOffsetMs !== undefined ? { recordingOffsetMs } : {}),
      })
    },
    modelProfile: ports.modelProfiles?.planner,
    verifierIdentity: ports.modelProfiles?.verifier
      ? {
          provider: ports.modelProfiles.verifier.provider,
          modelId: ports.modelProfiles.verifier.modelId,
        }
      : undefined,
    toolSchemaDigest: ports.toolSchemaDigest,
    retrievalRung,
  })
  context.subActionHistory = []
  // What this platform can capture, recorded once per step; unsupported never invents.
  recorder.recordOperationCapture(operationCaptureAvailability(ports.adapter.operationCaptureSupport))
  // The step's operation evidence across its sub-actions, for the verifier.
  const stepOperationEvidence: OperationEvidence = {}
  // Everything the step did and read, for the verifier; never the planner's reasoning.
  const stepRecord = new StepRecordAccumulator()
  const recordMask = (value: string) => redactSecretValue(value, ports.secretRedactor)
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()
  // What earlier steps of this test downloaded or copied, labelled by its producer.
  for (const item of carriedItems(ports.carriedArtifacts)) {
    stepRecord.addCarried({ stepNumber: item.stepNumber, actionIndex: item.actionIndex, text: recordMask(item.text) })
  }
  // Bytes are read only for this step's completed downloads and this test's carried ones.
  const savedFiles = (actions: readonly RecordedAction[]): SavedFile[] =>
    savedFileCandidates(actions, ports.carriedArtifacts).map((download) => ({
      name: download.suggestedFilename,
      bytes: download.sha256 !== undefined ? ports.adapter.readDownloadBytes?.(download.sha256) : undefined,
    }))
  // A bound ledger is shared with Channel-2 tool closures; otherwise this step-local one is used.
  const recordLedger = ports.recordLedger ?? createRecordLedger({
    cap: recordCap,
    budget: combinedBudget,
    seedRecords: [],
  })
  recorder.beginLosslessServedBrief({ recordCap, combinedBudget })
  recordLedger.beginStepEvidence?.()
  let nextLiveTurnOrdinal = 0
  let nextPromptOrdinal = 0
  // Optional-port compatibility: historical LoopPorts doubles accept two arguments; the
  // production memory wrapper accepts the additive third turn ordinal used by its journal.
  const beginMemoryTurn = ports.beginMemoryTurn as
    | ((
        activeScope?: { tier: 'test'; key: string },
        exposedIds?: readonly RecordId[],
        turnOrdinal?: number,
      ) => void)
    | undefined

  // The declared bulk predicate, kept for the run.
  let activePredicate: string | undefined

  // Attached to a limit stop when they exist; masked when recorded.
  let lastVerifierRejection: string | undefined
  let lastPlannerReasoning: string | undefined

  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let lastPlannedAction: Action | undefined
  let lastExecutedAction: Action | undefined
  // A failure's cautions are consumed by the next live planning turn, so they never stay sticky.
  let pendingCautions: { block: CautionBlock; trace: ServedRetrievalTraceV1 } | undefined

  const stageFailureCautions = (
    failedAction: Action,
    failureState: ScreenState,
  ): void => {
    const anchors = deriveFailureCautionAnchors(failedAction, failureState, context.testName)
    const served = ports.knowledgeReader?.getCautions(
      anchors,
      ports.knowledgeBudgets?.caution ?? PROVISIONAL_CAUTION_TOKEN_BUDGET,
    )
    pendingCautions = served
  }

  // A step that dispatched assertAI or extractAI writes nothing to the cache; this latch makes
  // finalize report 'bypass'.
  let cacheBypass = false

  // The step's saved path: each successful saveable turn is held until the verifier passes the
  // step, then written under a key whose step index is the turn's place among the step's
  // successful turns. A report is never saved and takes no place; each one marks where it fell in
  // the path and the read line it added.
  let pathOrdinal = 0
  let pathEndsAtLastHeld = false
  const savedPath: {
    key: CacheKey
    action: Action
    elements: readonly ElementInfo[]
    statedTargets: StatedTargets | undefined
    turn: number
    storedCompletesStep: boolean | undefined
  }[] = []
  const reportMarks: { held: number; line: string }[] = []
  // Values minted or reported in this step. A turn that types one, or a working-memory value,
  // is not saved, because its replay would type the value of the run that saved it.
  const stepRunValues = new Set<string>()
  const typesRunValue = (action: Action): boolean => carriesRunValue(action, [
    ...stepRunValues,
    ...(ports.workingMemory?.entries().map((entry) => entry.value) ?? []),
  ])
  // Keys replayed from the cache since the step's last rejection, and every key the step
  // invalidated. Replayed turns the verifier rejected are still turns the passing step took, so
  // they are written again with the live turns after them, without a completion claim. On a
  // branch that may write, that copy replaces the deleted entry or the suppression marker.
  let replayedKeys: CacheKey[] = []
  const invalidatedKeys = new Set<CacheKey>()
  // Cache writes are best effort: a store that cannot be written never fails the step.
  const cacheWrite = async (what: string, write: () => Promise<void>): Promise<void> => {
    try {
      await write()
    } catch (err) {
      ports.logger?.createScopedLogger('cache')?.warn(`Cache ${what} failed`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const invalidateKey = async (key: CacheKey): Promise<void> => {
    invalidatedKeys.add(key)
    await cacheWrite('invalidate', () => ports.cache!.invalidate(key))
  }

  // A report the passing verdict cites is read live on replay, so the path ends before it and
  // claims no completion. A closing report it does not cite is dropped and the completion claim
  // moves to the last saved action. A replayed turn is written again only when its flag changes.
  const flushSavedPath = async (
    completing: { turn: number; report: boolean },
    verdict?: ConditionVerdictsEvidence,
  ): Promise<void> => {
    if (!ports.cache || cacheBypass) return
    const citedReads = (verdict?.conditions ?? [])
      .filter((condition) => condition.verdict === 'met')
      .flatMap((condition) => condition.citations)
      .filter((citation) => citation.source === 'read' && citation.found === true)
    const needed = reportMarks.find((mark) =>
      citedReads.some((citation) => lineHolds(mark.line, citation.quote, recordMask)))
    const path = needed !== undefined ? savedPath.slice(0, needed.held) : savedPath
    const last = path.at(-1)
    if (last === undefined) return
    const lastCompletes = needed === undefined
      && (last.turn === completing.turn || (completing.report && pathEndsAtLastHeld))
    for (const held of path) {
      const completesStep = lastCompletes && held === last
      if (held.storedCompletesStep === completesStep && !invalidatedKeys.has(held.key)) continue
      const cache = ports.cache
      await cacheWrite('write', () => cache.set(held.key, buildCachedPlanValue({
        plannedActions: [held.action],
        elements: held.elements,
        completesStep,
        ...(held.statedTargets !== undefined ? { statedTargets: held.statedTargets } : {}),
      })))
    }
  }

  // Per-step procedure state: one consult per step at most, and a carried flow replaces it.
  let procedureConsulted = false
  let procedureReplay: {
    match: ProcedureMatch
    payload: ProcedureBodyPayload
    nextIndex: number
    checksPassed: number
    // Stored actions attempted within this test step: the per-step fold's `total`.
    attempted: number
    /** The body-step index this test step consumed — the planSource `flow.cursor`. */
    stepCursor?: number
    aborted: boolean
    miss?: { procedureStepIndex: number; reason: ProcedureGuardMissReason }
    executionFailure?: { procedureStepIndex: number }
    verifierRejection?: { procedureStepIndex: number }
  } | undefined
  let procedureHintStaged: {
    procedureId: RecordId
    anchors: Anchor[]
    block: string
    /** Set only on the fail-closed body-read demotion path. */
    demotion?: ProcedureHintDemotion
  } | undefined
  let procedureHintExposed = false

  // Values bind by name; the first source whose value passes the shared coercion binds.
  const bindProcedureParam = (
    name: string,
    type: ProcedureParamType,
  ): string | number | boolean | undefined => {
    const asSecretTemplate = ports.secretStore?.has(name) ? `{{secret:${name}}}` : undefined
    if (type === 'secret') return asSecretTemplate

    const memoryEntry = ports.workingMemory?.entries().find((entry) => entry.key === name)
    const sources: unknown[] = [context.variables?.[name], memoryEntry?.value]
    for (const raw of sources) {
      const bound = coerceProcedureBindingValue(type, raw)
      if (bound !== undefined) return bound
    }
    return type === 'string' ? asSecretTemplate : undefined
  }

  // Only names and capability booleans cross the reader port; no variable, memory or secret value.
  const assembleProcedureBindingAvailability = (): ProcedureBindingAvailability => {
    const variables = Object.entries(context.variables ?? {})
      .map(([name, raw]) => procedureSourceBinding(name, raw))
      .filter((entry) => entry !== undefined)
    const memoryByName = new Map<string, ReturnType<typeof procedureSourceBinding>>()
    for (const entry of ports.workingMemory?.entries() ?? []) {
      if (!memoryByName.has(entry.key)) {
        memoryByName.set(entry.key, procedureSourceBinding(entry.key, entry.value))
      }
    }
    const memory = [...memoryByName.values()].filter((entry) => entry !== undefined)
    const secrets = new Set<string>()
    ports.secretStore?.forEachSecret?.((name) => secrets.add(name))
    return { variables, memory, secrets: [...secrets] }
  }

  const recordProcedureReplaySource = (): void => {
    if (!procedureReplay || procedureReplay.stepCursor === undefined) return
    recorder.recordPlanSource({
      kind: 'procedure-replay',
      procedureId: procedureReplay.match.id,
      guard: {
        // The fold ranges over this test step's stored actions; flow position lives in `flow`.
        checksPassed: procedureReplay.checksPassed,
        total: procedureReplay.attempted,
        ...(procedureReplay.aborted && procedureReplay.miss !== undefined
          ? { miss: procedureReplay.miss }
          : {}),
        ...(procedureReplay.executionFailure !== undefined
          ? { executionFailure: procedureReplay.executionFailure }
          : {}),
        ...(procedureReplay.verifierRejection !== undefined
          ? { verifierRejection: procedureReplay.verifierRejection }
          : {}),
      },
      flow: {
        cursor: procedureReplay.stepCursor,
        length: procedureReplay.payload.steps.length,
      },
    })
  }

  // The only write to the carry cell, so every other exit leaves the flow over for the run.
  const rearmProcedureFlowCarry = (): void => {
    if (!ports.procedureFlow) return
    if (!procedureReplay || procedureReplay.aborted) return
    if (procedureReplay.nextIndex >= procedureReplay.payload.steps.length) return
    ports.procedureFlow.carry = {
      match: procedureReplay.match,
      payload: procedureReplay.payload,
      nextIndex: procedureReplay.nextIndex,
    }
  }

  // The failed or rejected sub-action whose stateAfter is the next observation, which is also
  // the recovering sub-action's stateBefore.
  let pendingBoundary: number | undefined
  // A failed saved path's decision, held until a later turn in the step succeeds; that pair
  // becomes the step's selfHeal.
  let pendingSelfHeal: Decision | undefined

  // Classify the step by resolution provenance once. A step that reads a live secret
  // ({{secret:X}} / [secret:*] marker) or sets an env/secret variable is non-cacheable: the loop
  // makes no cache get or set, and finalize records 'bypass' (or 'disabled' when no cache is bound).
  const classification = classifyStep({
    stepText: stepInstruction,
    envSets: deriveEnvSetNames(stepInstruction),
  })
  const nonCacheable = classification.cacheable === false
  const cacheEnvVars = classification.cacheable === true ? classification.envVars : []

  // ---- terminal result builders ------------------------------------------------
  const tokenUsage = (): TokenUsage | undefined =>
    (totalPromptTokens > 0 || totalCompletionTokens > 0)
      ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }
      : undefined

  const finish = (
    status: StepResult['status'],
    verdict: VerifierVerdict,
    error?: string,
  ): StepResult => {
    if (ports.carriedArtifacts !== undefined && context.stepNumber !== undefined) {
      carryForward(ports.carriedArtifacts, context.stepNumber, stepRecord.recordedActions())
    }
    // Capture any model-visible reads admitted immediately before a terminal return. Normal
    // planner turns drain at their own boundary; this final drain is the no-loss backstop.
    recorder.recordServedReadTraces(ports.drainMemoryReadTraces?.() ?? [])
    recorder.recordServedAdmissionEvents(recordLedger.drainEvidenceEvents?.() ?? [])
    // Every terminal return drains staged cautions here; a throw leaves no StepResult at all.
    if (pendingCautions !== undefined) {
      recorder.recordServedCautions([], pendingCautions.trace)
      pendingCautions = undefined
    }
    // The served set snapshots into `StepEvidence.workingMemory` with declared values masked.
    if (ports.workingMemory) {
      recorder.recordWorkingMemory(
        ports.workingMemory.entries().map((entry) => ({ ...entry, value: recordMask(entry.value) })),
      )
    }
    recorder.recordLimitUsage(meter.snapshot(
      compoundInputs.filter((input) => input.subActionIndex < recorder.subActionCount),
    ))
    // Unmasked, or the emit fold's exact match with `plannedAction` misses and replay stays `hint`.
    const evidence = recorder.finalize(verdict, 0, stepInstruction, {
      cacheDisabled: ports.cache === undefined,
      nonCacheable: nonCacheable || cacheBypass,
      ...(context.interpolatedVariables ? { interpolatedVariables: context.interpolatedVariables } : {}),
    })
    // Every terminal path runs `finish()`, so the step's event fires here exactly once.
    const durationMs = performance.now() - startTime
    // `tokenUsage()` is the one producer of this step's usage, shared with the legacy trace.
    ports.events?.stepFinalized(evidence, { status, durationMs, error, tokenUsage: tokenUsage() })
    // Exactly `projectLegacyTrace(result.evidence)`; the loop never mutates it after projection.
    const subActions = projectLegacyTrace(evidence)
    const trace = buildStepTrace(subActions, status === 'passed' ? 'success' : 'failure', error, tokenUsage())
    const result: StepResult = {
      name: stepInstruction,
      status,
      duration: durationMs,
      trace,
      evidence,
    }
    if (lastPlannedAction) result.action = lastPlannedAction
    if (error) result.error = error
    const lastSub = subActions.length > 0 ? subActions[subActions.length - 1] : undefined
    if (lastSub?.annotation) result.annotation = lastSub.annotation
    return result
  }

  const success = (): StepResult => finish('passed', { pass: true, reasoning: 'Step completed' })
  const failure = (error: string): StepResult => finish('failed', { pass: false, reasoning: error }, error)
  const cancelled = (): StepResult => finish('cancelled', { pass: false, reasoning: CANCELLED_MESSAGE }, CANCELLED_MESSAGE)

  const withUnproven = (error: string, unproven: string): string =>
    unproven === '' ? error : `${error} — ${unproven}`

  // Timeout, cancel and a model judgment or extraction that could not be made end the step with
  // no verifier call; the requested outcome is recorded unverified as a whole, with the reason.
  const recordUnverifiedEnding = (
    ending: 'timeout' | 'cancelled' | 'unresolved',
    reason: string,
  ): void => {
    recorder.recordConditionVerdicts({
      ending,
      conditions: [{
        quote: collapse(recordMask(stepInstruction)).slice(0, 300),
        verdict: 'unverified',
        reason: collapse(recordMask(reason)).slice(0, 200),
        citations: [],
      }],
    })
  }

  // Judged once per condition over a settled screen, never debited; the verdicts never make a pass.
  async function verifyEnding(
    ending: 'give-up' | 'infeasible' | 'limit-stop',
    lastAction: Action | undefined,
  ): Promise<string | StepResult> {
    if (!ports.verifier) return ''
    const action: Action = lastAction ?? { type: 'delay', ms: 0 }
    const judge = (
      output: VerificationResult,
      sources: CitationSources,
      imageAttached: boolean,
      guards?: ConditionGuardFacts,
    ) => {
      const judged = judgeConditions({
        stepText: stepInstruction,
        output,
        sources,
        mask: recordMask,
        imageAttached,
        ending,
        ...(guards !== undefined ? { guards } : {}),
      })
      recorder.recordConditionVerdicts(judged.evidence)
      return judged.reason
    }
    let finalState: ScreenState
    try {
      const settled = await settle(
        () => withAbort(ports.adapter.observe(), ports.abortSignal),
        {
          maxPolls: DEFAULT_SETTLE_MAX_POLLS,
          intervalMs: VERIFY_SETTLE_INTERVAL_MS,
          deadline,
          signal: ports.abortSignal,
        },
      )
      finalState = settled.state
    } catch (observeError: unknown) {
      const abortDuringObserve = checkAbort()
      if (abortDuringObserve) return abortDuringObserve
      return judge(endingVerifierError(observeError), NO_CITATION_SOURCES, false)
    }
    stepRecord.start(finalState)
    let screenshot: Buffer | undefined
    if (gate.attachImage && ports.adapter.screenshot) {
      try { screenshot = await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
    }
    const abortBeforeVerify = checkAbort()
    if (abortBeforeVerify) return abortBeforeVerify
    const record = stepRecord.snapshot()
    const accumulatedEvidence = hasOperationEvidence(stepOperationEvidence)
      ? stepOperationEvidence
      : undefined
    meter.recordVerifierCall()
    let verification: VerificationResult
    try {
      const verifyResult = await withAbort(
        ports.verifier.verify(
          stepInstruction, record.startScreen, finalState, action,
          gate.attachImage ? screenshot : undefined,
          ports.abortSignal, gate.promptNote, activePredicate, verifierAuthorContext,
          accumulatedEvidence, record,
        ),
        ports.abortSignal,
      )
      if (verifyResult.tokenUsage) {
        totalPromptTokens += verifyResult.tokenUsage.promptTokens
        totalCompletionTokens += verifyResult.tokenUsage.completionTokens
      }
      verification = verifyResult.verification
    } catch (verifyError: unknown) {
      const abortDuringVerify = checkAbort()
      if (abortDuringVerify) return abortDuringVerify
      verification = endingVerifierError(verifyError)
    }
    const abortAfterVerify = checkAbort()
    if (abortAfterVerify) return abortAfterVerify
    const imageAttached = gate.attachImage && screenshot !== undefined
    return judge(
      verification,
      buildVerifierCitationSources(record.startScreen, finalState, action, accumulatedEvidence, record),
      imageAttached,
      {
        finalElements: finalState.elements,
        platform: finalState.platform,
        record,
        imageAttached,
        ...(needsSavedFile(verification) ? { files: savedFiles(record.actions) } : {}),
      },
    )
  }

  // Ends through the failure funnel with its own typed block, judged once by the verifier.
  const limitStop = async (limit: LimitStopEvidence['limit']): Promise<StepResult> => {
    const judged = await verifyEnding('limit-stop', lastExecutedAction)
    if (typeof judged !== 'string') return judged
    const configured = limit === 'actions' ? meter.maxActions : meter.maxPlanningTurns
    const used = limit === 'actions' ? meter.actionsUsed : meter.planningCallsUsed
    const reason = formatLimitStopReason(limit, configured, used)
    recorder.recordLimitStop({
      limit,
      configured,
      used,
      reason,
      requestedOutcome: 'unverified',
      ...(lastVerifierRejection !== undefined ? { lastVerifierRejection: recordMask(lastVerifierRejection) } : {}),
      ...(lastPlannerReasoning !== undefined ? { lastPlannerReasoning: recordMask(lastPlannerReasoning) } : {}),
    })
    return failure(withUnproven(reason, judged))
  }

  // Abort/timeout check — the three v1 timeout/cancel variants (getTimeoutAbortReason).
  const checkAbort = (): StepResult | undefined => {
    if (!ports.abortSignal?.aborted) return undefined
    const timeout = getTimeoutAbortReason(ports.abortSignal)
    if (timeout) {
      recordUnverifiedEnding('timeout', timeout.message)
      return failure(timeout.message)
    }
    recordUnverifiedEnding('cancelled', CANCELLED_MESSAGE)
    return cancelled()
  }

  const initialAbort = checkAbort()
  if (initialAbort) return initialAbort

  let screenshotBefore: Buffer | undefined
  if (ports.adapter.screenshot) {
    try { screenshotBefore = await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
  }

  // The single execute step: resolve secret templates, then dispatch to the adapter (or the
  // setVariable callback). Every dispatch path, the heal's re-execute included, goes through it,
  // so redact-before-record is single-sourced.
  const executeResolvedAction = async (
    toExecute: Action,
    options: { keepRawData?: boolean } = {},
  ): Promise<{ result: ActionResult; error?: string; rawData?: unknown }> => {
    // A literal `[secret:NAME]` would type the placeholder text itself.
    const refusal = literalSecretMarkerRefusal(toExecute)
    if (refusal !== undefined) return { result: { success: false, error: refusal }, error: refusal }
    let result: ActionResult
    let rawData: unknown
    try {
      // Templates resolve inside the try, so a MissingSecretError never reaches the adapter.
      const actionForExecution = resolveSecretTemplatesInValue(toExecute, ports.secretStore)

      if (actionForExecution.type === 'setVariable') {
        // setVariable runs through the callback, not the adapter.
        const sv = actionForExecution as Extract<Action, { type: 'setVariable' }>
        ports.onSetVariable?.(sv.name, sv.value)
        result = { success: true }
      } else {
        let actionToExecute = actionForExecution
        if (actionForExecution.type === 'fileUpload' && ports.resolveUploadPath) {
          // Path resolution is injected; the loop never touches paths.
          const resolveUpload = ports.resolveUploadPath
          actionToExecute = { ...actionForExecution, files: actionForExecution.files.map(f => resolveUpload(f)) }
        }
        let finishAnnotation: (() => RecordingAnnotationWitness | undefined) | undefined
        try { finishAnnotation = ports.adapter.recording?.beginAnnotation?.() } catch { /* Optional evidence must not prevent execution. */ }
        // The adapter's post-action wait ends at the step deadline or abort.
        const executeOptions: ExecuteOptions = {
          ...(deadline ? { remainingStepMs: Math.max(0, Math.floor(deadline - performance.now())) } : {}),
          ...(ports.abortSignal ? { abortSignal: ports.abortSignal } : {}),
        }
        const executed = await withAbort(ports.adapter.execute(actionToExecute, executeOptions), ports.abortSignal)
        if (options.keepRawData) rawData = executed.data
        let recordingAnnotation: RecordingAnnotationWitness | undefined
        try { recordingAnnotation = finishAnnotation?.() } catch { /* Withhold an unproven interval. */ }
        result = redactSecretValue({ ...executed,
          ...(recordingAnnotation ? { recordingAnnotation } : {}),
        }, ports.secretRedactor)
      }
    } catch (err) {
      const error = redactSecretValue(err instanceof Error ? err.message : String(err), ports.secretRedactor)
      return { result: { success: false, error }, error }
    }
    const error = !result.success ? (result.error ?? 'Action failed') : undefined
    return options.keepRawData ? { result, error, rawData } : { result, error }
  }

  for (let actionIndex = 0; ; actionIndex++) {
    const abortBeforeObserve = checkAbort()
    if (abortBeforeObserve) return abortBeforeObserve

    if (deadline && performance.now() > deadline) {
      const timedOut = `Step timed out after ${ports.stepTimeout}ms`
      recordUnverifiedEnding('timeout', timedOut)
      return failure(timedOut)
    }

    // The next action would be refused, so stop before any planner call; the stop observes once.
    if (meter.actionsExhausted()) return await limitStop('actions')

    // 1. Settle and observe: the settled observation is the next sub-action's stateBefore.
    let screenState: ScreenState
    let settledHash: string
    try {
      const settled = await settle(
        () => withAbort(ports.adapter.observe(), ports.abortSignal),
        {
          maxPolls: DEFAULT_SETTLE_MAX_POLLS,
          intervalMs: DEFAULT_SETTLE_INTERVAL_MS,
          deadline,
          signal: ports.abortSignal,
        },
      )
      screenState = settled.state
      settledHash = settled.hash
      stepRecord.start(screenState)
    } catch (err) {
      const abortResult = checkAbort()
      if (abortResult) return abortResult
      throw err
    }

    if (pendingBoundary !== undefined) {
      recorder.attachStateAfter(pendingBoundary, screenState)
    }

    let screenshot: Buffer | undefined
    if (ports.adapter.screenshot) {
      try { screenshot = await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
    }

    const abortAfterObserve = checkAbort()
    if (abortAfterObserve) return abortAfterObserve

    // `captureMode` is stamped from the actual attachment, so it describes the real planner call.
    let captureDims: { imageWidth: number; imageHeight: number } | undefined
    if (gate.attachImage && screenshot && ports.compressor && (ports.vision?.screenshotSize || ports.vision?.effectiveResolution)) {
      if (!ports.vision?.effectiveResolution) {
        throw new Error('effectiveResolution is required in LLM config when screenshot compression is enabled')
      }
      try {
        const actionSpaceWidth = (screenState.metadata.viewportWidth as number | undefined)
          ?? (await withAbort(ports.compressor.dimensions(screenshot), ports.abortSignal)).width
          ?? 0
        const compressed = await withAbort(
          ports.compressor.compress(screenshot, {
            effectiveResolution: ports.vision.effectiveResolution,
            maxBytes: ports.vision.screenshotSize,
            actionSpaceWidth,
          }),
          ports.abortSignal,
        )
        screenshot = compressed.buffer
        captureDims = { imageWidth: compressed.imageWidth, imageHeight: compressed.imageHeight }
      } catch (err) {
        const abortResult = checkAbort()
        if (abortResult) return abortResult
        throw err
      }
    } else if (gate.attachImage && screenshot) {
      // Raw / no-sizing attachment: the exact raw bytes reach the planner unmodified. Dimensions
      // come from the compressor port when bound, else the recorded viewport is the explicit
      // host-neutral fallback (no host image decode inside the runner).
      try {
        if (ports.compressor) {
          const dims = await withAbort(ports.compressor.dimensions(screenshot), ports.abortSignal)
          captureDims = { imageWidth: dims.width, imageHeight: dims.height }
        } else {
          captureDims = {
            imageWidth: (screenState.metadata.viewportWidth as number | undefined) ?? 0,
            imageHeight: (screenState.metadata.viewportHeight as number | undefined) ?? 0,
          }
        }
      } catch (err) {
        const abortResult = checkAbort()
        if (abortResult) return abortResult
        throw err
      }
    }

    // Inject the gated image + prompt note for the planner: text-only attaches no image block
    // and relies on the accessibility tree through the prompt note.
    context.screenshot = gate.attachImage && screenshot ? screenshot : undefined
    context.promptNote = gate.promptNote

    // One authoritative modality stamp over the finalized attachment: `full` (with the selected
    // dims) when an image is attached, otherwise `textOnly`. This is the single source of the
    // recorded stateBefore.metadata.captureMode for every planner call.
    const captureStamp: CaptureStamp = context.screenshot && captureDims
      ? { mode: 'full', imageWidth: captureDims.imageWidth, imageHeight: captureDims.imageHeight }
      : { mode: 'textOnly' }
    screenState = stampCaptureMode(screenState, captureStamp)

    // 2. Plan. A carried flow is taken at step start, so every early exit leaves no carry.
    if (!procedureConsulted && ports.procedureFlow?.carry !== undefined) {
      const carried = ports.procedureFlow.carry
      ports.procedureFlow.carry = undefined
      procedureConsulted = true
      procedureReplay = {
        match: carried.match,
        payload: carried.payload,
        nextIndex: carried.nextIndex,
        checksPassed: 0,
        attempted: 0,
        aborted: false,
      }
    }

    // 2a. Consult procedures once per step, before the first planning turn and the cache consult.
    if (!procedureConsulted) {
      procedureConsulted = true
      if (ports.knowledgeReader) {
        const match = ports.knowledgeReader.getProcedure(
          stepInstruction,
          screenState,
          assembleProcedureBindingAvailability(),
        )
        if (match !== undefined) {
          if (match.replayRecommendation === 'replay') {
            // An unreadable or unparseable body demotes the match to hint, never a blind replay.
            const body = ports.knowledgeReader.read(match.id)
            const payload = body === undefined ? undefined : parseProcedureBody(body.body)
            if (payload !== undefined && payload.steps.length > 0) {
              procedureReplay = {
                match,
                payload,
                nextIndex: 0,
                checksPassed: 0,
                attempted: 0,
                aborted: false,
              }
            } else {
              // No replay without a parsed payload; the refused replay records why in its demotion.
              procedureHintStaged = {
                procedureId: match.id,
                anchors: [match.flowAnchor],
                block: renderProcedureHintBlock(match, payload, undefined, recordMask),
                demotion: body === undefined
                  ? 'body-unreadable'
                  : payload === undefined
                    ? 'body-unparseable'
                    : 'body-empty',
              }
            }
          } else {
            // Hint recommendation: no replay. The body read is best-effort enrichment for
            // the outline — a missing/unparseable body is NOT a failure (Test 5b).
            const body = ports.knowledgeReader.read(match.id)
            const payload = body === undefined ? undefined : parseProcedureBody(body.body)
            procedureHintStaged = {
              procedureId: match.id,
              anchors: [match.flowAnchor],
              block: renderProcedureHintBlock(match, payload, undefined, recordMask),
            }
          }
        }
      }
    }

    let planResult: PlanResult
    let cached = false
    let procedureReplayed = false
    // A passed guard authorizes one dispatch; the cursor and fold commit only after it succeeds.
    let pendingProcedureReplay: {
      procedureStepIndex: number
      instruction: string
    } | undefined
    let advancedProcedureStepIndex: number | undefined
    // Undefined for non-cacheable steps or when no cache is bound; the branch never enters the key.
    let cacheKey: CacheKey | undefined
    let storedCompletesStep: boolean | undefined
    const cacheActive = !nonCacheable && !!ports.cache

    // 2b. Each test step replays one body step under the full guard; a miss ends the flow.
    if (procedureReplay && !procedureReplay.aborted
      && procedureReplay.attempted === 0
      && procedureReplay.nextIndex < procedureReplay.payload.steps.length) {
      const replayState = procedureReplay
      const procedureStep = replayState.payload.steps[replayState.nextIndex]
      replayState.stepCursor = replayState.nextIndex
      replayState.attempted++
      // Landmarks are a soft diagnostic: a missing landmark logs and never misses.
      for (const landmark of procedureStep.guard.landmarks ?? []) {
        if (!screenState.tree.includes(landmark)) {
          ports.logger?.createScopedLogger('procedure')?.debug(
            'Stored landmark not observed on the fresh screen (soft diagnostic only)',
            { landmark, procedureStepIndex: replayState.nextIndex },
          )
        }
      }
      const paramTypes = new Map(replayState.payload.parameters.map((p) => [p.name, p.type]))
      const attempt = attemptProcedureReplayAction({
        step: procedureStep,
        // Every replayed decision completes its own test step, so the verifier runs per body step.
        isFinal: true,
        screenState,
        bind: (name) => bindProcedureParam(name, paramTypes.get(name) ?? 'string'),
      })
      if (attempt.ok) {
        planResult = { plan: attempt.plan }
        procedureReplayed = true
        pendingProcedureReplay = {
          procedureStepIndex: replayState.nextIndex,
          instruction: procedureStep.instruction,
        }
        // Record that this step is procedure-driven immediately. The accumulator is
        // last-write-wins; success or execution failure below replaces this pending fold.
        recordProcedureReplaySource()
      } else {
        replayState.aborted = true
        replayState.miss = {
          procedureStepIndex: replayState.nextIndex,
          reason: attempt.reason,
        }
        recordProcedureReplaySource()
        const goneTarget = attempt.unjudgeable ? undefined : SAVED_TARGET_GONE[attempt.reason]
        if (goneTarget !== undefined) {
          pendingSelfHeal = {
            plan: 'Replayed from a saved procedure',
            plannedAction: { type: procedureStep.action.type } as unknown as SchemaAction,
            result: toRecordedActionResult({ success: false, error: recordMask(goneTarget) }),
          }
        }
        // The projector is the raw-input firewall, so procedure prose and bound values stay out.
        const recovery = projectProcedureGuardMissRecovery({
          stepNumber: replayState.nextIndex + 1,
          step: procedureStep,
          parameters: replayState.payload.parameters,
          attempt,
          screenState,
          availability: assembleProcedureBindingAvailability(),
          interpolationNames: new Set(
            (context.interpolatedVariables ?? []).map((entry) => entry.name),
          ),
        }) satisfies ProcedureGuardMissRecoveryContext
        procedureHintStaged = {
          procedureId: replayState.match.id,
          anchors: [replayState.match.flowAnchor],
          block: renderProcedureGuardMissRecoveryBlock(recovery, recordMask),
        }
      }
    }

    if (!procedureReplayed && cacheActive) {
      cacheKey = computeCacheKey(buildCacheableStepInput({
        mask: recordMask,
        platform: screenState.platform,
        // Keyed on the CLI's real digests when present; absent, the key uses empty strings.
        suiteConfigDigest: ports.configDigests?.suiteConfigDigest ?? '',
        testConfigDigest: ports.configDigests?.testConfigDigest ?? '',
        stepText: stepInstruction,
        // The step's earlier turns that succeeded: failed turns and reports leave no gap.
        stepIndex: pathOrdinal,
        testIndex: 0,
        envVars: cacheEnvVars,
        screenIdentityHash: settledHash,
      }))
      const hit = await ports.cache!.get(cacheKey)
      if (hit) {
        // A stored target is re-found strictly in the fresh observation, never by a pick.
        const replay = replayFromCache(hit, screenState.elements)
        if (replay.ok) {
          planResult = { plan: replay.plan }
          cached = true
          storedCompletesStep = hit.completesStep
        } else {
          recorder.recordCacheMiss({ reason: replay.reason })
          await invalidateKey(cacheKey)
          const storedAction = hit.plannedActions[0]
          const goneTarget = SAVED_TARGET_GONE[replay.reason]
          if (goneTarget !== undefined && storedAction !== undefined) {
            pendingSelfHeal = {
              plan: 'Replayed from cache',
              plannedAction: storedAction as unknown as SchemaAction,
              result: toRecordedActionResult({ success: false, error: recordMask(goneTarget) }),
            }
          }
          ports.logger?.createScopedLogger('cache')?.debug(
            'Cached target does not replay — re-planning', { actionIndex, reason: replay.reason },
          )
        }
      }
    }

    if (!procedureReplayed && !cached) {
      // A live decision needs a planner call; cache and procedure replay do not.
      if (meter.planningExhausted()) return await limitStop('planning-turns')
      const turnOrdinal = nextLiveTurnOrdinal
      // Only authored knowledge joins the cached tier; learned layers stay volatile hypotheses.
      const briefScope = { tier: 'test', key: context.testName } as const
      const briefBudget = ports.knowledgeBudgets?.brief ?? PROVISIONAL_BRIEF_TOKEN_BUDGET
      // One value carries the brief and its serve-time trace, handed straight to the recorder.
      const served = ports.knowledgeReader?.getRunBrief(
        briefScope,
        briefBudget,
      )
      const brief = served?.brief
      if (served !== undefined && brief !== undefined) {
        context.knowledgePolicyL0 = brief.tiers.L0.trim().length > 0 ? brief.tiers.L0 : undefined
        context.knowledgeBriefL1 = brief.tiers.L1.trim().length > 0 ? brief.tiers.L1 : undefined
        context.knowledgeBriefL2 = brief.tiers.L2.trim().length > 0 ? brief.tiers.L2 : undefined
        context.knowledgeBriefTruncation = brief.truncation.trim().length > 0
          ? brief.truncation
          : undefined
        // Reader-backed runs use the structured fields above; clear the compatibility string so
        // an empty real block cannot accidentally resurrect caller-supplied learned material.
        context.knowledgeBrief = undefined
        recorder.recordServedBrief({
          scope: briefScope,
          asOfBuild: ports.knowledgeAsOfBuild ?? 0,
          budget: briefBudget,
          block: brief,
          trace: served.trace,
        })
      }
      // The brief rides every turn, so its ids are spent before any search, read or caution.
      recordLedger.resetTurn(brief?.admissions ?? [], {
        surface: 'brief-line',
        turnOrdinal,
      })
      // Reset the read-body counter only after the distinct-id ledger is reseeded for this turn.
      beginMemoryTurn?.(
        briefScope,
        brief?.lines.map((line) => line.id) ?? [],
        turnOrdinal,
      )
      // Channel 3 has no agency: staged records render inside the hypotheses frame, then clear.
      const cautionsForTurn = pendingCautions
      pendingCautions = undefined
      if (cautionsForTurn !== undefined) {
        const injected: CautionLine[] = []
        let refused = 0
        let recordCount = 0
        const admissionById = new Map(
          cautionsForTurn.block.admissions.map((metadata) => [String(metadata.id), metadata]),
        )
        for (const caution of cautionsForTurn.block.cautions) {
          if (caution.id === CAUTION_TRUNCATION_ID) {
            // The reader's overflow line renders but never spends or mints a ledger admission.
            injected.push(caution)
            continue
          }
          recordCount++
          const metadata = admissionById.get(String(caution.id))
          if (metadata !== undefined && recordLedger.admit(metadata, {
            surface: 'caution',
            turnOrdinal,
          }).admitted) {
            injected.push(caution)
          } else {
            // Missing cost/source/cluster metadata is a fail-closed omission, never an unmetered
            // fallback. Production reader blocks always carry it by contract.
            refused++
          }
        }

        // Records only the cautions rendered into the turn, outside the observations gate.
        recorder.recordServedCautions(injected, cautionsForTurn.trace)

        const observations = injected.map((caution) => caution.summary)
        if (refused > 0) observations.push(`truncated ${refused} of ${recordCount}`)
        if (observations.length > 0) {
          const frame = `Failure-adjacent caution observations:\n${observations.join('\n')}`
          context.knowledgeBriefL1 = context.knowledgeBriefL1?.trim()
            ? `${context.knowledgeBriefL1}\n\n${frame}`
            : frame
        }
      }
      // A refused ledger admission drops the hint block for this turn, never the turn itself.
      if (procedureHintStaged) {
        const hint = procedureHintStaged
        const admitted = recordLedger.admit(
          servingRecordMetadata({
            id: hint.procedureId,
            anchors: hint.anchors,
            renderedCost: estimateTokens(hint.block),
          }),
          {
            surface: 'procedure-hint',
            turnOrdinal,
          },
        ).admitted
        if (admitted) {
          context.knowledgeBriefL2 = context.knowledgeBriefL2?.trim()
            ? `${context.knowledgeBriefL2}\n\n${hint.block}`
            : hint.block
          // A rendered hint records `procedure-hint` unless a replay already owns planSource.
          if (!procedureHintExposed && procedureReplay === undefined) {
            recorder.recordPlanSource({
              kind: 'procedure-hint',
              procedureId: hint.procedureId,
              ...(hint.demotion === undefined ? {} : { demotion: hint.demotion }),
            })
          }
          procedureHintExposed = true
        }
      }
      // The whole run-scoped set is served verbatim; unbound, the loop runs without memory.
      if (ports.workingMemory) context.workingMemory = ports.workingMemory.entries()
      // The active predicate is restated each turn; the verifier backstops it.
      context.bulkCompletionPredicate = activePredicate
      // The production ledger has already decided every automatic surface for this turn.
      // Persist those exact decisions before snapshotting the exact tier bytes the planner
      // is about to receive; Channel-2 events are appended after the call in tool order.
      recorder.recordServedAdmissionEvents(recordLedger.drainEvidenceEvents?.() ?? [])
      recorder.recordServedPromptTurn(
        captureServedPromptTurn(context, nextPromptOrdinal, turnOrdinal),
      )
      nextPromptOrdinal++
      nextLiveTurnOrdinal++
      // The planner debits each model call through the gate; one that reports none is debited once.
      const planningCallsBefore = meter.planningCallsUsed
      context.planningCallGate = meter
      try {
        planResult = await withAbort(
          ports.planner.plan(stepInstruction, screenState, context, ports.abortSignal),
          ports.abortSignal,
        )
      } catch (planError: unknown) {
        context.planningCallGate = undefined
        if (meter.planningCallsUsed === planningCallsBefore) meter.tryDebitPlanningCall()
        recorder.recordServedReadTraces(ports.drainMemoryReadTraces?.() ?? [])
        recorder.recordServedAdmissionEvents(recordLedger.drainEvidenceEvents?.() ?? [])
        const abortDuringPlan = checkAbort()
        if (abortDuringPlan) return abortDuringPlan
        // The planning limit refused a planner call: its own typed stop, never a planning failure.
        if (planError instanceof PlanningLimitReachedError) return await limitStop('planning-turns')
        if (planError instanceof PlanningTurnError) {
          recorder.recordPlanningFailure({
            reason: planError.reason,
            message: recordMask(planError.message),
            exchanges: maskToolExchanges(planError.exchanges, recordMask),
            ...(planError.callRecord !== undefined ? { callRecord: planError.callRecord } : {}),
          })
        }
        const errorMsg = planError instanceof Error ? planError.message : String(planError)
        const isContextError = CONTEXT_ERROR_PATTERNS.some(p => new RegExp(p, 'i').test(errorMsg))
        const displayMsg = isContextError
          ? `Model context window exceeded. ${errorMsg}. Increase contextWindow on your LLM config or reduce previousStepCount in planner config.`
          : `LLM planning failed: ${errorMsg}`
        return failure(displayMsg)
      }
      context.planningCallGate = undefined
      if (meter.planningCallsUsed === planningCallsBefore) meter.tryDebitPlanningCall()
      recorder.recordServedReadTraces(ports.drainMemoryReadTraces?.() ?? [])
      recorder.recordServedAdmissionEvents(recordLedger.drainEvidenceEvents?.() ?? [])
    }

    if (planResult!.tokenUsage) {
      totalPromptTokens += planResult!.tokenUsage.promptTokens
      totalCompletionTokens += planResult!.tokenUsage.completionTokens
    }

    // A procedure-replayed decision has no live planning turn (the cache-replay parity):
    // no exchanges, no call record, no decision screenshot.
    const liveDecisionEvidence: LiveDecisionEvidence | undefined = (cached || procedureReplayed)
      ? undefined
      : {
          exchanges: maskToolExchanges(planResult!.exchanges ?? [], recordMask),
          ...(planResult!.callRecord !== undefined ? { callRecord: planResult!.callRecord } : {}),
        }

    // Persist the exact bytes the planner received once; a store failure leaves the ref absent.
    if (liveDecisionEvidence && context.screenshot && ports.evidenceArtifacts) {
      try {
        liveDecisionEvidence.decisionScreenshotRef = ports.evidenceArtifacts.persistDecisionScreenshot(context.screenshot)
      } catch {
        ports.logger?.createScopedLogger('evidence')?.warn('Failed to persist decision screenshot')
      }
    }

    const rawPlan = planResult!.plan

    // Write remember[] before the action dispatches, so entries record with the navigating action.
    if (rawPlan.remember && rawPlan.remember.length > 0) {
      ports.workingMemory?.capture(rawPlan.remember, { step: actionIndex })
    }
    // Persist the declared bulk-completion predicate for the rest of the run.
    if (rawPlan.bulkCompletionPredicate) activePredicate = rawPlan.bulkCompletionPredicate

    let normalizedAction = normalizePointerActionForStep(rawPlan.action as Action, stepInstruction)
    // Redact before recording; secret templates resolve only at the execute boundary.
    let action = redactSecretValue(normalizedAction, ports.secretRedactor)
    const reasoning = redactSecretValue(rawPlan.reasoning, ports.secretRedactor)
    lastPlannedAction = action
    if (!cached && !procedureReplayed && reasoning.trim() !== '') lastPlannerReasoning = reasoning

    // Live plans arrive gate-resolved, so only cache replays and out-of-turn plans are gated here.
    let gateAttempts: GroundingAttempt[] | undefined = rawPlan.groundingAttempts
    let gateForcedError: string | undefined
    let gateForcedRefMiss = false
    let residualStatedTargets: StatedTargets | undefined
    if (cached) {
      const gateResult = groundActionPlan({
        toolName: normalizedAction.type,
        action: normalizedAction as unknown as Record<string, unknown>,
        screenState,
      })
      if (gateResult.ok) {
        gateAttempts = gateResult.attempts
      } else {
        gateForcedError = gateResult.error.message
        gateForcedRefMiss = gateResult.error.code === 'ref_not_in_snapshot'
      }
    } else if (
      !procedureReplayed
      && rawPlan.groundingAttempts === undefined
      && carriesStatedTarget(normalizedAction)
    ) {
      // An out-of-turn plan with a target is grounded here, so its target reaches the check.
      const gateResult = groundActionPlan({
        toolName: normalizedAction.type,
        action: normalizedAction as unknown as Record<string, unknown>,
        screenState,
      })
      if (gateResult.ok) {
        normalizedAction = gateResult.action as unknown as Action
        action = redactSecretValue(normalizedAction, ports.secretRedactor)
        lastPlannedAction = action
        gateAttempts = gateResult.attempts
        residualStatedTargets = gateResult.statedTargets
      } else {
        gateForcedError = gateResult.error.message
        gateForcedRefMiss = gateResult.error.code === 'ref_not_in_snapshot'
      }
    }
    const statedTargets = rawPlan.statedTargets ?? residualStatedTargets

    // Redacted before record, and recomputed to the heal trail if the heal fires.
    let grounding = buildGroundingEvidence(
      action,
      screenState.elements,
      gateAttempts,
      statedTargets,
      recordMask,
    )

    const abortAfterPlan = checkAbort()
    if (abortAfterPlan) return abortAfterPlan

    // stepFailed — the planner declares the step impossible; no execution (loop.ts:262).
    if (rawPlan.stepFailed) {
      recorder.recordSubAction({
        plan: reasoning,
        plannedAction: action as unknown as SchemaAction,
        stateBefore: screenState,
        result: toSchemaResult({ success: false, error: `Planner signaled step failure: ${reasoning}` }),
        cached: false,
        grounding,
        ...(liveDecisionEvidence ?? {}),
      })
      // An infeasible declaration records a typed termination block, unlike a plain stepFailed.
      if (rawPlan.failureKind === 'infeasible') {
        const reason = redactSecretValue(rawPlan.failureReason ?? '', ports.secretRedactor)
        recorder.recordTermination({ kind: 'infeasible', reason })
        // The declaration's own reason (an ambiguity refusal's candidates) stays first.
        const unproven = await verifyEnding('infeasible', lastExecutedAction)
        if (typeof unproven !== 'string') return unproven
        return failure(withUnproven(`Step declared infeasible: ${reason}`, unproven))
      }
      const unproven = await verifyEnding('give-up', lastExecutedAction)
      if (typeof unproven !== 'string') return unproven
      return failure(withUnproven(`Step failed: ${reasoning}`, unproven))
    }

    // 3. Execute: templates resolve only here; a replay-gate rejection never reaches the adapter.
    let execResult: ActionResult
    let execError: string | undefined
    let unresolvedEnding: string | undefined
    // One pre-dispatch debit per executed action; a refused stated target is never debited.
    const targetRefusal = gateForcedError === undefined && statedTargets !== undefined
      ? judgeStatedTargets(statedTargets, normalizedAction, screenState.elements, recordMask)
      : undefined
    if (gateForcedError === undefined && targetRefusal === undefined) meter.tryDebitAction()
    // Judged on the settled `screenState` only, never a live probe.
    const idempotentNoop = gateForcedError === undefined && targetRefusal === undefined
      ? desiredStateSatisfied(normalizedAction, screenState)
      : undefined
    // Every pre-adapter dispatch decision happens here; helpers live in compound and verifier.
    const dispatchVerb = normalizedAction.type
    // Value-bearing evidence is masked before record through recordMask.
    if (gateForcedError !== undefined) {
      execResult = { success: false, error: gateForcedError }
      execError = gateForcedError
    } else if (targetRefusal !== undefined) {
      execResult = {
        success: false,
        error: targetRefusal.message,
        metadata: { targetRefusal: targetRefusal.block },
      }
      execError = targetRefusal.message
    } else if (dispatchVerb === 'reportValue') {
      // A platform-less answer verb mints its result here; reportValue never terminates the step.
      const rawReportedValue = String((action as { value?: unknown }).value ?? '')
      stepRunValues.add(rawReportedValue)
      const reportedValue = recordMask(rawReportedValue)
      execResult = mintReportedValue({ value: reportedValue })
      execError = undefined
      recorder.recordReportedValue({ value: reportedValue })
      const read = { kind: 'reportValue' as const, text: `"${reportedValue}"` }
      stepRecord.addRead(read)
      reportMarks.push({
        held: savedPath.length,
        line: readLine({ index: stepRecord.recordedActions().length + 1, ...read }),
      })
    } else if (dispatchVerb === 'uniqueValue') {
      // Cache replay re-enters this branch and mints a fresh value, because it must be unique.
      const prefix = String((action as { prefix?: unknown }).prefix ?? '')
      const minted = mintUniqueValue({ prefix }, ports.uniqueValueGenerator ?? defaultUniqueValueGenerator)
      execResult = minted
      execError = undefined
      const uv = readUniqueValueMeta(minted)
      if (uv) {
        stepRunValues.add(uv.value)
        ports.workingMemory?.capture(
          [{ key: prefix, value: recordMask(uv.value), kind: 'extracted-value', provenance: 'toolResult', stepIndex: actionIndex }],
          { step: actionIndex },
        )
      }
    } else if (dispatchVerb === 'assertAI' && ports.verifier?.judgeClaim) {
      // One judgment per attempt through the verifier's model lane, never the adapter. A true
      // verdict continues; a false verdict goes back to the planner as a self-correcting error; a
      // judgment the model could not make ends the step unresolved.
      cacheBypass = true
      // text never sends the screenshot; visual with no screenshot is unresolved without a call.
      const av = action as { claim?: unknown; mode?: unknown }
      const claim = String(av.claim ?? '')
      const mode: AssertAiMode = av.mode === 'visual' || av.mode === 'text' ? av.mode : 'multimodal'
      const screenshot = mode === 'text' ? undefined : context.screenshot
      let judgment: AiJudgment
      if (mode === 'visual' && screenshot === undefined) {
        judgment = { outcome: 'unresolved', reason: VISUAL_CLAIM_WITHOUT_SCREENSHOT }
      } else {
        meter.recordJudgeCall()
        judgment = await withAbort(
          ports.verifier.judgeClaim(claim, screenState, {
            mode,
            abortSignal: ports.abortSignal,
            ...(screenshot !== undefined ? { screenshot } : {}),
          }),
          ports.abortSignal,
        )
      }
      if (judgment.outcome === 'unresolved') {
        const sentence = `assertAI could not judge "${recordMask(claim)}": ${recordMask(judgment.reason)}`
        recorder.recordAiJudgment({ verb: 'assertAI', unresolved: collapse(sentence).slice(0, 200) })
        execResult = { success: false, error: sentence, metadata: { aiJudgment: { verb: 'assertAI', unresolved: true } } }
        execError = sentence
        unresolvedEnding = sentence
      } else {
        const rationale = redactSecretValue(judgment.rationale, ports.secretRedactor)
        recorder.recordAiJudgment({ verb: 'assertAI', verdict: judgment.verdict, rationale: recordMask(rationale) })
        const judgedClaim = recordMask(claim)
        const declaredMode = typeof av.mode === 'string' ? av.mode : undefined
        stepRecord.addRead({
          kind: 'assertAI',
          text: `"${judgedClaim}"${declaredMode !== undefined ? ` (${declaredMode})` : ''}: judged ${judgment.verdict ? 'true' : 'false'}: ${recordMask(rationale)}`,
          claim: judgedClaim,
          judged: judgment.verdict,
          ...(declaredMode !== undefined ? { mode: declaredMode } : {}),
        })
        if (judgment.verdict) {
          execResult = { success: true, metadata: { aiJudgment: { verb: 'assertAI', verdict: true } } }
          execError = undefined
        } else {
          const selfCorrecting = `Claim "${claim}" judged false: ${rationale} — re-observe the screen or declare the step failed via stepFailed.`
          execResult = { success: false, error: selfCorrecting, metadata: { aiJudgment: { verb: 'assertAI', verdict: false } } }
          execError = selfCorrecting
        }
      }
    } else if (dispatchVerb === 'extractAI' && ports.verifier?.extractData) {
      // One extraction per attempt through the verifier's model lane. Every key and value is masked,
      // then written to run-scoped working memory and the read line as JSON text, which is masked
      // again; an extraction the model could not make ends the step unresolved and writes nothing.
      cacheBypass = true
      const av = action as { query?: unknown }
      const query = String(av.query ?? '')
      const schema = (normalizedAction as { schema?: unknown }).schema
      const fields: readonly ExtractField[] = Array.isArray(schema) ? schema : []
      meter.recordJudgeCall()
      const extraction = await withAbort(
        ports.verifier.extractData(query, screenState, { fields, abortSignal: ports.abortSignal, screenshot: context.screenshot }),
        ports.abortSignal,
      )
      if (extraction.outcome === 'unresolved') {
        const sentence = `extractAI could not extract "${recordMask(query)}": ${recordMask(extraction.reason)}`
        recorder.recordAiJudgment({ verb: 'extractAI', unresolved: collapse(sentence).slice(0, 200) })
        execResult = { success: false, error: sentence, metadata: { aiJudgment: { verb: 'extractAI', unresolved: true } } }
        execError = sentence
        unresolvedEnding = sentence
      } else {
        const fields = maskExtracted(extraction.fields, recordMask) as Record<string, unknown>
        const entries: WorkingMemoryEntry[] = Object.entries(fields).map(([key, value]) => ({
          key,
          value: recordMask(extractedText(value)),
          kind: 'extracted-value',
          provenance: 'toolResult',
          stepIndex: actionIndex,
        }))
        if (entries.length > 0) ports.workingMemory?.capture(entries, { step: actionIndex })
        const values = entries.map((entry) => `${entry.key} = ${entry.value}`)
        stepRecord.addRead({
          kind: 'extractAI',
          text: `"${recordMask(query)}": ${values.length > 0 ? values.join(', ') : 'no fields'}`,
        })
        recorder.recordAiJudgment({ verb: 'extractAI' })
        execResult = { success: true, metadata: { aiJudgment: { verb: 'extractAI' }, extracted: fields } }
        execError = undefined
      }
    } else if (dispatchVerb === 'assertValue') {
      // The adapter reads once and the runner compares; judged on the raw read, recorded masked.
      const read = await executeResolvedAction(normalizedAction, { keepRawData: true })
      if (!read.result.success) {
        execResult = read.result
        execError = read.error
      } else {
        const av = action as { source?: unknown; expr?: unknown; op?: unknown; expected?: unknown }
        const source = typeof av.source === 'string' ? av.source : (av.expr !== undefined ? 'expr' : 'unknown')
        const plannedExpected = (normalizedAction as { expected?: unknown }).expected
        const expected = typeof plannedExpected === 'string'
          ? resolveSecretTemplatesInValue(plannedExpected, ports.secretStore)
          : undefined
        const judged = assertValueReadText(source, read.rawData)
        const outcome = compareAssertValue({
          source, op: av.op as AssertValueOp, expected, actual: judged.actual,
          ...(judged.entries !== undefined ? { entries: judged.entries } : {}),
        })
        const maskedActual = assertValueReadText(source, redactSecretValue(read.rawData, ports.secretRedactor)).actual
        const recordedActual = typeof maskedActual === 'string' ? recordMask(maskedActual) : maskedActual
        const recordedOutcome: AssertValueResult = {
          source: outcome.source,
          op: outcome.op,
          passed: outcome.passed,
          ...(outcome.expected !== undefined ? { expected: recordMask(outcome.expected) } : {}),
          ...(recordedActual !== undefined ? { actual: recordedActual } : {}),
        }
        recorder.recordAssertOutcome(recordedOutcome)
        const assertActual = typeof recordedOutcome.actual === 'string'
          ? ` (read "${recordedOutcome.actual}")`
          : recordedOutcome.actual === null ? ' (read null)' : ''
        stepRecord.addRead({
          kind: 'assertValue',
          text: `${recordedOutcome.source} ${recordedOutcome.op}${recordedOutcome.expected !== undefined ? ` "${recordedOutcome.expected}"` : ''}: ${recordedOutcome.passed ? 'passed' : 'failed'}${assertActual}`,
          assert: {
            source: recordedOutcome.source,
            op: recordedOutcome.op,
            ...(recordedOutcome.expected !== undefined ? { expected: recordedOutcome.expected } : {}),
            passed: recordedOutcome.passed,
          },
        })
        if (recordedOutcome.passed) {
          execResult = { success: true, metadata: { assertValueOutcome: recordedOutcome } }
          execError = undefined
        } else {
          const failMsg = `assertValue on source "${source}" (${recordedOutcome.op}) did not hold — re-observe or declare the step failed via stepFailed.`
          execResult = { success: false, error: failMsg, metadata: { assertValueOutcome: recordedOutcome } }
          execError = failMsg
        }
      }
    } else if (dispatchVerb === 'storageState') {
      // The recorded and executed objects differ: the storage-state blob is never recorded.
      const ss = action as { op?: unknown; name?: unknown }
      const op = ss.op
      const name = String(ss.name ?? '')
      if (op === 'save') {
        const read = await executeResolvedAction(normalizedAction)
        if (!read.result.success) {
          execResult = read.result
          execError = read.error
        } else if (!ports.storageState) {
          const unavailable = `storageState persistence unavailable: no storage-state store is bound to this run.`
          execResult = { success: false, error: unavailable }
          execError = unavailable
        } else {
          // Strip-before-record: the raw blob in read.result.data NEVER reaches evidence.
          const ref = await ports.storageState.save(name, read.result.data)
          execResult = { success: true, metadata: { storageState: { name: ref.name, fingerprint: ref.fingerprint } } }
          execError = undefined
        }
      } else {
        // restore
        if (!ports.storageState) {
          const unavailable = `storageState persistence unavailable: no storage-state store is bound to this run.`
          execResult = { success: false, error: unavailable }
          execError = unavailable
        } else {
          const blob = await ports.storageState.load(name)
          if (blob === undefined) {
            const missing = `storageState "${name}" not found under the run's .agent-qa/storage-states directory.`
            execResult = { success: false, error: missing }
            execError = missing
          } else {
            // Inject the blob into the EXECUTED action only; the recorded action carries just the name.
            const executed = { ...(normalizedAction as unknown as Record<string, unknown>), state: blob } as unknown as Action
            const read = await executeResolvedAction(executed)
            execResult = read.result.success
              ? { success: true, metadata: { storageState: { name } } }
              : { success: false, ...(read.result.error !== undefined ? { error: read.result.error } : {}) }
            execError = read.error
          }
        }
      }
    } else if (idempotentNoop !== undefined) {
      // A satisfied state skips the tap with no input, success false and no error; still metered.
      execResult = {
        success: false,
        metadata: { idempotentNoop: { ...idempotentNoop, inputSent: false } },
      }
    } else {
      const outcome = await executeResolvedAction(normalizedAction)
      execResult = outcome.result
      execError = outcome.error
    }

    const abortAfterExecute = checkAbort()
    if (abortAfterExecute) return abortAfterExecute

    // 3b. Heal once per action by re-finding every ref lane strictly in a fresh observation.
    let healUnproven: 'absent' | 'not-unique' | undefined
    let actedState: ScreenState = screenState
    let recordedPair: RecordedPair = {
      plannedAction: action as unknown as SchemaAction,
      stateBefore: screenState,
    }
    if (
      execError !== undefined
      && (gateForcedRefMiss || isRefResolutionFailure(execError) || startsBindingHeal(execResult))
      && !meter.actionsExhausted()
      && unresolvedEnding === undefined
    ) {
      let freshState: ScreenState
      try {
        freshState = await withAbort(ports.adapter.observe(), ports.abortSignal)
      } catch (err) {
        const abortDuringHeal = checkAbort()
        if (abortDuringHeal) return abortDuringHeal
        throw err
      }
      const freshElements = freshState.elements
      const heal = regroundFailedRef(action, screenState.elements, freshElements, recordMask)
      if (heal?.kind === 'resolved') {
        grounding = grounding?.stated !== undefined
          ? { ...heal.grounding, stated: grounding.stated }
          : heal.grounding
        let healRefusal: TargetRefusal | undefined
        for (const lane of heal.lanes) {
          const stated = statedTargets?.[lane.field]
          if (stated === undefined) continue
          healRefusal = judgeLane(lane.field, 'heal', stated, lane.element, freshElements, recordMask)
          if (healRefusal !== undefined) break
        }
        if (healRefusal !== undefined) {
          execResult = {
            success: false,
            error: healRefusal.message,
            metadata: { ...(execResult.metadata ?? {}), targetRefusal: healRefusal.block },
          }
          execError = healRefusal.message
        } else {
          let patched = normalizedAction
          for (const lane of heal.lanes) patched = patchRef(patched, lane.field, lane.ref)
          meter.tryDebitAction()
          const outcome = await executeResolvedAction(patched)
          execResult = outcome.result
          execError = outcome.error
          action = redactSecretValue(patched, ports.secretRedactor)
          actedState = stampCaptureMode(freshState, captureStamp)
          recordedPair = {
            ...recordedPair,
            healedDispatch: { action: action as unknown as SchemaAction, stateBefore: actedState },
          }
          lastPlannedAction = action
          const abortAfterHeal = checkAbort()
          if (abortAfterHeal) return abortAfterHeal
        }
      } else if (heal?.kind === 'unproven') {
        healUnproven = heal.reason
        const binding = readBindingOutcomeMeta(execResult)
        if (binding !== undefined) {
          execResult = {
            ...execResult,
            metadata: { ...execResult.metadata, binding: { ...binding, heal: heal.reason } },
          }
        }
      }
    }

    const scrollMeta = readScrollUntilVisibleMeta(execResult)
    if (scrollMeta !== undefined) {
      compoundInputs.push({ subActionIndex: recorder.subActionCount, kind: 'scroll', count: scrollMeta.swipes })
    }
    const fillVerdict = readFillVerdictMeta(execResult)
    if (fillVerdict ? fillVerdict.verb === 'fill' : readFillRereadMeta(execResult) !== undefined) {
      compoundInputs.push({ subActionIndex: recorder.subActionCount, kind: 'fill', count: 1 })
    }

    // Only the typed, masked operation evidence persists; the adapter's metadata key is removed.
    const taken = takeOperationEvidence(execResult, recordMask, action.type)
    execResult = taken.result
    const operationEvidence = taken.evidence
    const decisionEvidence: DecisionEvidence | undefined = operationEvidence !== undefined
      ? { ...(liveDecisionEvidence ?? {}), operationEvidence }
      : liveDecisionEvidence
    const renderedEvidence = operationEvidence !== undefined
      ? renderOperationEvidence(operationEvidence)
      : ''
    const historyEvidence = renderedEvidence.length > 0
      ? { evidence: wrapAppObservedData(renderedEvidence) }
      : {}
    if (operationEvidence?.downloads) {
      stepOperationEvidence.downloads = [...(stepOperationEvidence.downloads ?? []), ...operationEvidence.downloads]
    }
    if (operationEvidence?.clipboard) {
      stepOperationEvidence.clipboard = [...(stepOperationEvidence.clipboard ?? []), ...operationEvidence.clipboard]
    }
    const historyResult = readIdempotentNoopMeta(execResult)?.inputSent === false
      ? 'no-input'
      : 'success'
    const recordedOutcome: RecordedActionOutcome =
      gateForcedError !== undefined || execResult.metadata?.['targetRefusal'] !== undefined
        ? 'refused'
        : historyResult === 'no-input'
          ? 'no-input'
          : execError !== undefined ? 'failure' : 'success'
    const actedRef = 'ref' in action && typeof action.ref === 'string' ? action.ref : undefined
    const actedElement = actedRef !== undefined
      ? actedState.elements.find((element) => element.ref === actedRef)
      : undefined
    if (recordedOutcome !== 'refused') lastExecutedAction = action
    stepRecord.addAction({
      action,
      ...(actedElement !== undefined
        ? { element: { role: actedElement.role, name: recordMask(actedElement.name) } }
        : {}),
      outcome: recordedOutcome,
      ...(execError !== undefined ? { error: recordMask(execError) } : {}),
      ...(operationEvidence !== undefined ? { operationEvidence } : {}),
    })
    const notableInput = operationEvidence?.input?.filter(
      (entry) => renderInputEvidence(entry) !== undefined,
    )
    if (notableInput !== undefined && notableInput.length > 0) {
      stepOperationEvidence.input = [...(stepOperationEvidence.input ?? []), ...notableInput]
    }

    // The replay cursor and fold advance only after dispatch succeeds; a rejection never undoes it.
    if (execError === undefined && pendingProcedureReplay !== undefined && procedureReplay) {
      advancedProcedureStepIndex = pendingProcedureReplay.procedureStepIndex
      procedureReplay.checksPassed++
      procedureReplay.nextIndex++
      recordProcedureReplaySource()
      pendingProcedureReplay = undefined
    }

    const viewport: Viewport = {
      width: (screenState.metadata.viewportWidth as number | undefined) ?? 0,
      height: (screenState.metadata.viewportHeight as number | undefined) ?? 0,
    }

    // setVariable with stepComplete skips verification: the runner sets the variable itself.
    if (action.type === 'setVariable' && rawPlan.stepComplete) {
      recorder.recordSubAction({
        plan: reasoning,
        ...recordedPair,
        result: toSchemaResult(execResult),
        cached,
        grounding,
        ...(decisionEvidence ?? {}),
      })
      context.failureContext = undefined
      pendingBoundary = undefined
      pendingSelfHeal = undefined
      // setVariable is non-cacheable, so nothing is written to the cache here.
      return success()
    }

    const annotation = buildAnnotation(action, execResult, viewport, !!execError)

    // Best-effort "after" screenshot for artifacts.
    if (ports.adapter.screenshot) {
      try { await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
    }
    const abortAfterPostShot = checkAbort()
    if (abortAfterPostShot) return abortAfterPostShot

    // 4. EXECUTION FAILURE: replan with the failure as context. The failed sub-action's stateAfter
    // is the next observation, and a failed replay of a saved path arms the heal.
    if (execError) {
      if (pendingProcedureReplay !== undefined && procedureReplay) {
        procedureReplay.aborted = true
        procedureReplay.executionFailure = {
          procedureStepIndex: pendingProcedureReplay.procedureStepIndex,
        }
        recordProcedureReplaySource()
        procedureHintStaged = {
          procedureId: procedureReplay.match.id,
          anchors: [procedureReplay.match.flowAnchor],
          block: renderProcedureHintBlock(
            procedureReplay.match,
            procedureReplay.payload,
            `Guarded replay execution failed at procedure step `
              + `${pendingProcedureReplay.procedureStepIndex + 1} `
              + `("${pendingProcedureReplay.instruction}"): ${execError}`,
            recordMask,
          ),
        }
      }
      const failedIdx = recorder.recordSubAction({
        plan: reasoning,
        ...recordedPair,
        result: toSchemaResult(execResult, annotation),
        cached,
        grounding,
        ...(decisionEvidence ?? {}),
      })
      if (unresolvedEnding !== undefined) {
        recordUnverifiedEnding('unresolved', unresolvedEnding)
        return failure(unresolvedEnding)
      }

      context.subActionHistory!.push({
        action: JSON.stringify(action),
        reasoning,
        result: 'failure',
        error: execError,
        data: guardActionData(execResult.data, ports.guardBlob),
        ...historyEvidence,
      })

      // A failed replay of a cached plan invalidates that key and re-plans.
      if (cached && cacheKey && ports.cache) {
        await invalidateKey(cacheKey)
      }

      // Failure context injected for the next planning turn (the surviving mitigation).
      context.failureContext = `Sub-action ${actionIndex + 1} failed: ${execError}\n` +
        (healUnproven !== undefined ? `${unprovenHealNote(healUnproven)}\n` : '') +
        `Failed action: ${JSON.stringify(action)}\n` +
        `Adapt your approach — try a different element or strategy.`

      pendingBoundary = failedIdx
      if (cached || procedureReplayed) {
        pendingSelfHeal = {
          plan: reasoning,
          plannedAction: recordedPair.plannedAction,
          result: toRecordedActionResult(toSchemaResult(execResult, annotation)),
        }
      }
      // A grounding miss is a failed action, so every execution failure stages one caution lookup.
      stageFailureCautions(action, actedState)
      continue
    }

    // Execution succeeded — clear failure context.
    context.failureContext = undefined
    if (cached && cacheKey !== undefined) replayedKeys.push(cacheKey)

    // A report leaves the end of the saved path where it was; any other turn not held ends it.
    // Every other turn takes its place in the path, held or not, so a turn that cannot replay
    // leaves a gap the rerun plans live instead of replaying a later saved turn in its place.
    const isReport = normalizedAction.type === 'reportValue'
    const saveable = !isReport
      && isReplayableActionShape(normalizedAction.type, Object.keys(normalizedAction))
      && !typesRunValue(normalizedAction)
    if (!isReport) {
      pathEndsAtLastHeld = false
      if (saveable && cacheActive && !procedureReplayed && cacheKey !== undefined) {
        savedPath.push({
          key: cacheKey,
          action: normalizedAction,
          elements: screenState.elements,
          statedTargets,
          turn: actionIndex,
          storedCompletesStep: cached ? storedCompletesStep : undefined,
        })
        pathEndsAtLastHeld = true
      }
      pathOrdinal++
    }

    // 5. VERIFY — only when the planner signals stepComplete (three-outcome strategy).
    let verifierReasoning: string | undefined
    if (rawPlan.stepComplete && ports.verifier) {
      // Every completion claim is judged by the verifier; its own re-observation is stateAfter.
      let afterState: ScreenState
      try {
        // The verifier must not judge a screen that is still changing, such as a composer that
        // has not cleared yet, so the frames settle compares are VERIFY_SETTLE_INTERVAL_MS apart.
        const settledAfter = await settle(
          () => withAbort(ports.adapter.observe(), ports.abortSignal),
          {
            maxPolls: DEFAULT_SETTLE_MAX_POLLS,
            intervalMs: VERIFY_SETTLE_INTERVAL_MS,
            deadline,
            signal: ports.abortSignal,
          },
        )
        afterState = settledAfter.state
      } catch (err) {
        const abortResult = checkAbort()
        if (abortResult) return abortResult
        throw err
      }
      let verifyScreenshot: Buffer | undefined
      if (ports.adapter.screenshot) {
        try { verifyScreenshot = await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
      }

      const abortBeforeVerify = checkAbort()
      if (abortBeforeVerify) return abortBeforeVerify

      // The verifier judges the whole step, from its settled start to its final screen.
      const record = stepRecord.snapshot()
      const accumulatedEvidence = hasOperationEvidence(stepOperationEvidence)
        ? stepOperationEvidence
        : undefined
      let verifyResult
      meter.recordVerifierCall()
      try {
        verifyResult = await withAbort(
          ports.verifier.verify(
            stepInstruction, record.startScreen, afterState, action,
            gate.attachImage ? verifyScreenshot : undefined,
            ports.abortSignal, gate.promptNote, activePredicate, verifierAuthorContext,
            accumulatedEvidence, record,
          ),
          ports.abortSignal,
        )
      } catch (verifyError: unknown) {
        const abortDuringVerify = checkAbort()
        if (abortDuringVerify) return abortDuringVerify
        throw verifyError
      }
      if (verifyResult.tokenUsage) {
        totalPromptTokens += verifyResult.tokenUsage.promptTokens
        totalCompletionTokens += verifyResult.tokenUsage.completionTokens
      }
      // The runner computes the pass from the cited per-condition verdicts.
      const judged = judgeConditions({
        stepText: stepInstruction,
        output: verifyResult.verification,
        sources: buildVerifierCitationSources(
          record.startScreen,
          afterState,
          action,
          accumulatedEvidence,
          record,
        ),
        mask: recordMask,
        imageAttached: gate.attachImage && verifyScreenshot !== undefined,
        ending: 'completion',
        plannerReasoning: reasoning,
        guards: {
          finalElements: afterState.elements,
          platform: afterState.platform,
          record,
          imageAttached: gate.attachImage && verifyScreenshot !== undefined,
          ...(needsSavedFile(verifyResult.verification) ? { files: savedFiles(record.actions) } : {}),
        },
      })
      recorder.recordConditionVerdicts(judged.evidence)
      verifierReasoning = judged.pass ? verifyResult.verification.reasoning : judged.reason
      if (!judged.pass) lastVerifierRejection = verifierReasoning

      const abortAfterVerify = checkAbort()
      if (abortAfterVerify) return abortAfterVerify

      if (judged.pass) {
        recorder.recordVerdictSource('verifier-model')
        const idx = recordSuccess(
          recorder,
          reasoning,
          recordedPair,
          execResult,
          annotation,
          cached,
          grounding,
          decisionEvidence,
        )
        recorder.attachStateAfter(idx, afterState)
        maybeRecordSelfHeal(
          recorder,
          pendingSelfHeal,
          reasoning,
          recordedPair.plannedAction,
          execResult,
          annotation,
        )
        pendingBoundary = undefined
        pendingSelfHeal = undefined
        await flushSavedPath({ turn: actionIndex, report: isReport }, judged.evidence)
        // The verifier accepted a replayed step, so re-arm the carry when body steps remain.
        if (procedureReplayed) rearmProcedureFlowCarry()
        return finish('passed', { pass: true, reasoning: verifierReasoning ?? 'Step completed' })
      }

      if (verifyResult.verification.isAppError) {
        recorder.recordVerdictSource('verifier-model')
        recorder.recordSubAction({
          plan: reasoning,
          ...recordedPair,
          result: toSchemaResult(execResult, annotation),
          cached,
          grounding,
          ...(decisionEvidence ?? {}),
        })
        return failure(`Application error: ${verifyResult.verification.reasoning}`)
      }

      if (procedureReplayed && procedureReplay && !procedureReplay.aborted
        && advancedProcedureStepIndex !== undefined) {
        procedureReplay.aborted = true
        procedureReplay.verifierRejection = {
          procedureStepIndex: advancedProcedureStepIndex,
        }
        recordProcedureReplaySource()
        const rejectedStep = procedureReplay.payload.steps[advancedProcedureStepIndex]
        procedureHintStaged = {
          procedureId: procedureReplay.match.id,
          anchors: [procedureReplay.match.flowAnchor],
          block: renderProcedureHintBlock(
            procedureReplay.match,
            procedureReplay.payload,
            `Guarded replay verifier rejected procedure step `
              + `${advancedProcedureStepIndex + 1} ("${rejectedStep.instruction}"): `
              + verifierReasoning,
            recordMask,
          ),
        }
      }

      // The verifier rejected the completion claim: replan with its reasoning as failure context.
      // The next observation is this sub-action's stateAfter. A rejected replayed claim arms the
      // heal, and a rejected cached claim invalidates every key replayed since the last rejection.
      if (cached && ports.cache) {
        for (const key of replayedKeys) await invalidateKey(key)
      }
      replayedKeys = []
      const failedIdx = recordSuccess(
        recorder,
        reasoning,
        recordedPair,
        execResult,
        annotation,
        cached,
        grounding,
        decisionEvidence,
      )
      recorder.attachStateAfter(failedIdx, afterState)
      context.subActionHistory!.push({
        action: JSON.stringify(action),
        reasoning,
        result: historyResult,
        verifierRejection: verifierReasoning,
        data: guardActionData(execResult.data, ports.guardBlob),
        ...historyEvidence,
      })
      context.failureContext = `Sub-action ${actionIndex + 1} did not accomplish the goal: ${verifierReasoning}\n` +
        `Adapt your approach — try a different element or strategy.`
      pendingBoundary = failedIdx
      if (cached || procedureReplayed) {
        pendingSelfHeal = {
          plan: reasoning,
          plannedAction: recordedPair.plannedAction,
          result: toRecordedActionResult(toSchemaResult(execResult, annotation)),
        }
      }
      stageFailureCautions(action, afterState)
      continue
    }

    // No verifier: trust the planner's completion; only test seams run without one.
    if (rawPlan.stepComplete && !ports.verifier) {
      const idx = recordSuccess(
        recorder,
        reasoning,
        recordedPair,
        execResult,
        annotation,
        cached,
        grounding,
        decisionEvidence,
      )
      maybeRecordSelfHeal(
        recorder,
        pendingSelfHeal,
        reasoning,
        recordedPair.plannedAction,
        execResult,
        annotation,
      )
      pendingBoundary = undefined
      pendingSelfHeal = undefined
      void idx
      await flushSavedPath({ turn: actionIndex, report: isReport })
      // Verifier-less harness: the trusted completion accepts the replayed step; the carry re-arms.
      if (procedureReplayed) rearmProcedureFlowCarry()
      return success()
    }

    // The sub-action succeeded but the goal is not met yet: record and continue.
    recordSuccess(
      recorder,
      reasoning,
      recordedPair,
      execResult,
      annotation,
      cached,
      grounding,
      decisionEvidence,
    )
    maybeRecordSelfHeal(
      recorder,
      pendingSelfHeal,
      reasoning,
      recordedPair.plannedAction,
      execResult,
      annotation,
    )
    pendingBoundary = undefined
    pendingSelfHeal = undefined
    context.subActionHistory!.push({
      action: JSON.stringify(action),
      reasoning,
      result: historyResult,
      verifierRejection: rawPlan.stepComplete ? verifierReasoning : undefined,
      data: guardActionData(execResult.data, ports.guardBlob),
      ...historyEvidence,
    })
  }
}

// ---- helpers -----------------------------------------------------------------

// Pre-plan, a set/store/save verb beside an UPPER_SNAKE token signals env-set provenance.
const ENV_SET_VERB = /\b(set|store|save|remember)\b/i
const ENV_NAME_TOKEN = /\b[A-Z][A-Z0-9_]+\b/g

function deriveEnvSetNames(stepText: string): string[] {
  if (!ENV_SET_VERB.test(stepText)) return []
  return stepText.match(ENV_NAME_TOKEN) ?? []
}

// Replayability is judged by the one schema-shared list (`isReplayableActionShape`), and the
// saved path holds only turns that list accepts.

function carriesRunValue(action: Action, values: readonly string[]): boolean {
  const texts: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const [key, value] of Object.entries(action)) if (key !== 'type') collect(value)
  return values.some((value) => {
    const needle = value.trim()
    return needle !== '' && texts.some((text) => text.includes(needle))
  })
}

function replayLanes(action: Record<string, unknown>, locatorCount: number): string[] {
  if (action.type === 'drag') return ['fromRef', 'toRef']
  return locatorCount >= 1 || requiresElementRef(String(action.type ?? '')) ? ['ref'] : []
}

type CacheReplay = { ok: true; plan: ActionPlan } | { ok: false; reason: CacheMissReason }

// A saved target that is gone or no longer unique means the app changed under the saved path,
// so the step's live repair is a heal. Any other miss is a plain miss.
const SAVED_TARGET_GONE: Partial<Record<CacheMissReason | ProcedureGuardMissReason, string>> = {
  'strict-absent': 'The saved target is not on the page',
  'strict-not-unique': 'The saved target is no longer unique',
  'descriptor-missing': 'The saved target is not on the page',
  'descriptor-ambiguous': 'The saved target is no longer unique',
}

// Each stored locator resolves only through strictMatch with one survivor, or nothing replays.
function replayFromCache(value: CachedPlanValue, elements: readonly ElementInfo[]): CacheReplay {
  const action = value.plannedActions[0]
  if (!action) return { ok: false, reason: 'non-replayable' }
  const replayAction: Record<string, unknown> = { ...action }

  // Non-replayable action shapes invalidate the entry and replan.
  if (!isReplayableActionShape(String(replayAction.type ?? ''), Object.keys(replayAction))) {
    return { ok: false, reason: 'non-replayable' }
  }

  const lanes = replayLanes(replayAction, value.groundedLocator.length)
  // A ref lane with no stored locator is an unreplayable value ⇒ invalidate ⇒ replan.
  if (value.groundedLocator.length < lanes.length) return { ok: false, reason: 'non-replayable' }

  for (let lane = 0; lane < lanes.length; lane++) {
    const match = deterministicDescriptorMatcher.reground(value.groundedLocator[lane], elements)
    if (match.kind === 'absent') return { ok: false, reason: 'strict-absent' }
    if (match.kind === 'not-unique') return { ok: false, reason: 'strict-not-unique' }
    replayAction[lanes[lane]] = match.ref
  }

  return {
    ok: true,
    plan: {
      reasoning: 'Replayed from cache',
      action: replayAction as ActionPlan['action'],
      confidence: 1,
      stepComplete: value.completesStep,
    },
  }
}

// ---- guarded procedure replay helpers ----

/** The closed guard-miss reason vocabulary — the schema StepPlanSource miss union. */
type ProcedureGuardMissReason = NonNullable<
  Extract<StepPlanSource, { kind: 'procedure-replay' }>['guard']['miss']
>['reason']

/** The closed fail-closed body-read demotion vocabulary — the schema procedure-hint arm. */
type ProcedureHintDemotion = NonNullable<
  Extract<StepPlanSource, { kind: 'procedure-hint' }>['demotion']
>

type ProcedureGuardMissLocation =
  | { kind: 'action-shape' }
  | { kind: 'action-target'; lane: string }
  | { kind: 'guard-target' }
  | { kind: 'page-anchor' }
  | { kind: 'parameter'; field: string; name: string }
  | { kind: 'action-schema' }
  | { kind: 'grounding-gate' }

type ProcedureReplayAttempt =
  | { ok: true; plan: ActionPlan }
  | {
      ok: false
      reason: ProcedureGuardMissReason
      location: ProcedureGuardMissLocation
      unjudgeable?: true
    }

// No stored or derived position reaches the recovery context.
interface ProcedureRecoveryDescriptor {
  lane: string
  role: string
  name: string
  row?: string
}

interface ProcedureRecoveryParameter {
  name: string
  type: ProcedureParamType
  required: boolean
  interpolatedInCurrentStep: boolean
}

interface ProcedureRecoverySourceBinding {
  name: string
  canBindNumber: boolean
  canBindBoolean: boolean
}

interface ProcedureRecoverySuppliedSource {
  kind: 'variable' | 'memory' | 'secret'
  name: string
  declaredType: ProcedureParamType
}

type ProcedureRecoveryValueSlot =
  | {
      kind: 'parameter-ref'
      field: string
      name: string
      suppliedSource?: ProcedureRecoverySuppliedSource
    }
  | { kind: 'literal-omitted'; field: string }

/**
 * The only shape permitted across the guard-miss recovery boundary. Deliberately absent:
 * ProcedureStepSpec/instruction prose, raw values, refs, routes, screen trees, labels,
 * attributes, URLs, match metadata, and full action payloads.
 */
interface ProcedureGuardMissRecoveryContext {
  stepNumber: number
  reason: ProcedureGuardMissReason
  location: ProcedureGuardMissLocation
  action: {
    type: string
    targets: readonly ProcedureRecoveryDescriptor[]
    valueSlots: readonly ProcedureRecoveryValueSlot[]
  }
  guard: {
    target: Omit<ProcedureRecoveryDescriptor, 'lane'>
    pageAnchorEqual: boolean
  }
  parameters: readonly ProcedureRecoveryParameter[]
  availability: {
    variables: readonly ProcedureRecoverySourceBinding[]
    memory: readonly ProcedureRecoverySourceBinding[]
    secrets: readonly string[]
  }
  freshCandidates?: readonly { role: string; name: string }[]
}

/**
 * Project the binder's existing source precedence into value-free recovery facts. The
 * availability DTO contains names and capability bits only, so this selector cannot carry or
 * stringify a binding value. Secret parameters hard-wall to the secret store; number/boolean
 * sources require their matching capability; strings preserve variable -> memory -> secret.
 */
function projectProcedureRecoverySuppliedSource(
  name: string,
  declaredType: ProcedureParamType,
  availability: ProcedureBindingAvailability,
): ProcedureRecoverySuppliedSource | undefined {
  const variable = availability.variables.find((entry) => entry.name === name)
  const memory = availability.memory.find((entry) => entry.name === name)
  const secretAvailable = availability.secrets.includes(name)
  const supplied = (
    kind: ProcedureRecoverySuppliedSource['kind'],
  ): ProcedureRecoverySuppliedSource => ({ kind, name, declaredType })

  switch (declaredType) {
    case 'secret':
      return secretAvailable ? supplied('secret') : undefined
    case 'number':
      if (variable?.canBindNumber) return supplied('variable')
      if (memory?.canBindNumber) return supplied('memory')
      return undefined
    case 'boolean':
      if (variable?.canBindBoolean) return supplied('variable')
      if (memory?.canBindBoolean) return supplied('memory')
      return undefined
    case 'string':
      if (variable !== undefined) return supplied('variable')
      if (memory !== undefined) return supplied('memory')
      return secretAvailable ? supplied('secret') : undefined
  }
}

/**
 * Re-find one committed procedure target strictly: the one element with its role, exact name and
 * stored row words. A target without a stored name (a body committed before names were stored)
 * cannot be judged: it is an unjudgeable 'descriptor-missing', not a target gone from the page.
 * No ordinal is read and nothing is picked.
 */
function strictProcedureTarget(
  target: ProcedureGuardTarget,
  elements: readonly ElementInfo[],
):
  | { ok: true; ref: Ref }
  | { ok: false; reason: 'descriptor-missing' | 'descriptor-ambiguous'; unjudgeable?: true } {
  if (target.name === undefined) {
    return { ok: false, reason: 'descriptor-missing', unjudgeable: true }
  }
  const match = strictMatch({ role: target.role, name: target.name, row: target.row }, elements)
  if (match.kind === 'resolved') return { ok: true, ref: match.ref }
  return {
    ok: false,
    reason: match.kind === 'not-unique' ? 'descriptor-ambiguous' : 'descriptor-missing',
  }
}

// Persisted bodies are untrusted, so every guard leg must pass before a stored action executes.
function attemptProcedureReplayAction(input: {
  step: ProcedureStepSpec
  isFinal: boolean
  screenState: ScreenState
  bind: (name: string) => string | number | boolean | undefined
}): ProcedureReplayAttempt {
  const spec = input.step.action
  const shapeKeys = [...Object.keys(spec.targets), ...Object.keys(spec.values)]
  if (!isReplayableActionShape(spec.type, shapeKeys)) {
    return {
      ok: false,
      reason: 'non-replayable-action',
      location: { kind: 'action-shape' },
    }
  }

  const action: Record<string, unknown> = { type: spec.type }
  for (const [lane, target] of Object.entries(spec.targets)) {
    const match = strictProcedureTarget(target, input.screenState.elements)
    if (!match.ok) {
      return {
        ok: false,
        reason: match.reason,
        location: { kind: 'action-target', lane },
        ...(match.unjudgeable ? { unjudgeable: true as const } : {}),
      }
    }
    action[lane] = match.ref
  }

  const guardMatch = strictProcedureTarget(input.step.guard.target, input.screenState.elements)
  if (!guardMatch.ok) {
    return {
      ok: false,
      reason: guardMatch.reason,
      location: { kind: 'guard-target' },
      ...(guardMatch.unjudgeable ? { unjudgeable: true as const } : {}),
    }
  }

  const stored = normalizeAnchor(input.step.guard.pageAnchor) as Extract<Anchor, { t: 'page' }>
  const live = normalizeAnchor({ t: 'page', route: input.screenState.url ?? '' }) as Extract<
    Anchor,
    { t: 'page' }
  >
  if (stored.route !== live.route) {
    return {
      ok: false,
      reason: 'page-anchor-mismatch',
      location: { kind: 'page-anchor' },
    }
  }

  for (const [field, slot] of Object.entries(spec.values)) {
    if (typeof slot === 'string' || typeof slot === 'number' || typeof slot === 'boolean') {
      action[field] = slot
      continue
    }
    if ('json' in slot) {
      // Persisted bodies are untrusted input. Preserve the structured literal exactly without
      // aliasing record-owned arrays/objects into the action that the adapter may mutate.
      action[field] = structuredClone(slot.json)
      continue
    }
    const bound = input.bind(slot.param)
    if (bound === undefined) {
      return {
        ok: false,
        reason: 'parameter-unbound',
        location: { kind: 'parameter', field, name: slot.param },
      }
    }
    action[field] = bound
  }

  // Stored bodies are untrusted persisted input. Reconstruct the canonical tool action exactly
  // as toolCallToActionPlan does: remove the type discriminator, safeParse through the registered
  // strict schema, and use parsed data (including canonical defaults) for the grounding gate.
  // Procedure bodies persist the action verb (`fill`), while the model registry is keyed by
  // surface-qualified tool id (`web_fill`). Accept an exact id for forward compatibility, then
  // resolve the one definition exposed for the live platform by its canonical action type.
  const definition = defaultRegistry.get(spec.type)
    ?? defaultRegistry.getForPlatform(input.screenState.platform)
      .find((candidate) => candidate.type === spec.type)
  if (definition === undefined) {
    return {
      ok: false,
      reason: 'non-replayable-action',
      location: { kind: 'action-shape' },
    }
  }
  const { type: _type, ...actionFields } = action
  const parsed = definition.schema.safeParse(actionFields)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'non-replayable-action',
      location: { kind: 'action-schema' },
    }
  }
  const validatedAction: Record<string, unknown> = {
    type: definition.type,
    ...(parsed.data as Record<string, unknown>),
  }

  const gate = groundActionPlan({
    toolName: spec.type,
    action: validatedAction,
    screenState: input.screenState,
  })
  if (!gate.ok) {
    return { ok: false, reason: 'gate-refused', location: { kind: 'grounding-gate' } }
  }

  return {
    ok: true,
    plan: {
      reasoning: `Replayed from procedure: ${input.step.instruction}`,
      action: gate.action as ActionPlan['action'],
      confidence: 1,
      stepComplete: input.isFinal,
      groundingAttempts: gate.attempts,
    },
  }
}

function projectProcedureRecoveryDescriptor(
  lane: string,
  target: ProcedureStepSpec['guard']['target'],
): ProcedureRecoveryDescriptor {
  return {
    lane,
    role: target.role,
    name: target.name ?? target.nameNormalized,
    ...(target.row === undefined ? {} : { row: target.row }),
  }
}

/**
 * Safe upstream projector for a failed guard attempt. Raw loop/runtime inputs end here; only
 * structural names, capability bits and booleans survive into the renderer DTO.
 */
function projectProcedureGuardMissRecovery(input: {
  stepNumber: number
  step: ProcedureStepSpec
  parameters: ProcedureBodyPayload['parameters']
  attempt: Extract<ProcedureReplayAttempt, { ok: false }>
  screenState: ScreenState
  availability: ProcedureBindingAvailability
  interpolationNames: ReadonlySet<string>
}): ProcedureGuardMissRecoveryContext {
  const referencedNames = new Set<string>()
  const declarations = new Map(
    input.parameters.map((parameter) => [parameter.name, parameter]),
  )
  const valueSlots: ProcedureRecoveryValueSlot[] = []
  for (const [field, slot] of Object.entries(input.step.action.values)) {
    if (typeof slot === 'object' && slot !== null && 'param' in slot) {
      referencedNames.add(slot.param)
      const declaration = declarations.get(slot.param)
      const suppliedSource = declaration === undefined
        ? undefined
        : projectProcedureRecoverySuppliedSource(
            slot.param,
            declaration.type,
            input.availability,
          )
      valueSlots.push({
        kind: 'parameter-ref',
        field,
        name: slot.param,
        ...(suppliedSource === undefined ? {} : { suppliedSource }),
      })
    } else {
      valueSlots.push({ kind: 'literal-omitted', field })
    }
  }

  const parameters = input.parameters
    .filter((parameter) => referencedNames.has(parameter.name))
    .map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      interpolatedInCurrentStep: input.interpolationNames.has(parameter.name),
    }))
  const includeReferenced = (name: string): boolean => referencedNames.has(name)
  const variables = input.availability.variables.filter((entry) => includeReferenced(entry.name))
  const memory = input.availability.memory.filter((entry) => includeReferenced(entry.name))
  const secrets = input.availability.secrets.filter(includeReferenced)

  const storedPage = normalizeAnchor(input.step.guard.pageAnchor) as Extract<
    Anchor,
    { t: 'page' }
  >
  const currentPage = normalizeAnchor({
    t: 'page',
    route: input.screenState.url ?? '',
  }) as Extract<Anchor, { t: 'page' }>

  const actionTargets = Object.entries(input.step.action.targets)
    .map(([lane, target]) => projectProcedureRecoveryDescriptor(lane, target))
  const guardTarget = projectProcedureRecoveryDescriptor('guard', input.step.guard.target)
  const base = {
    stepNumber: input.stepNumber,
    reason: input.attempt.reason,
    location: input.attempt.location,
    action: {
      type: input.step.action.type,
      targets: actionTargets,
      valueSlots,
    },
    guard: {
      target: {
        role: guardTarget.role,
        name: guardTarget.name,
        ...(guardTarget.row === undefined ? {} : { row: guardTarget.row }),
      },
      pageAnchorEqual: storedPage.route === currentPage.route,
    },
    parameters,
    availability: { variables, memory, secrets },
  } satisfies ProcedureGuardMissRecoveryContext

  const failedRole = input.attempt.location.kind === 'action-target'
    ? input.step.action.targets[input.attempt.location.lane]?.role
    : input.attempt.location.kind === 'guard-target'
      ? input.step.guard.target.role
      : undefined
  if (failedRole === undefined) return base

  const freshCandidates = input.screenState.elements
    .filter((element) => element.state.visible && element.role === failedRole)
    .map((element) => ({ role: element.role, name: element.name }))
  return { ...base, freshCandidates } satisfies ProcedureGuardMissRecoveryContext
}

function renderProcedureGuardMissLocation(location: ProcedureGuardMissLocation): string {
  switch (location.kind) {
    case 'action-shape': return 'action-shape'
    case 'action-target': return `action-target lane=${location.lane}`
    case 'guard-target': return 'guard-target'
    case 'page-anchor': return 'page-anchor'
    case 'parameter': {
      return `parameter field=${location.field}; name=${location.name}`
    }
    case 'action-schema': return 'action-schema'
    case 'grounding-gate': return 'grounding-gate'
  }
}

function renderProcedureRecoveryDescriptor(
  descriptor: Omit<ProcedureRecoveryDescriptor, 'lane'>,
): string {
  const row = descriptor.row === undefined ? '' : `; row=${descriptor.row}`
  return `role=${descriptor.role}; name=${descriptor.name}${row}`
}

function renderProcedureRecoverySources(
  heading: string,
  sources: readonly ProcedureRecoverySourceBinding[],
): string[] {
  if (sources.length === 0) return [`${heading}: none`]
  return [
    `${heading}:`,
    ...sources.map((source) =>
      `- ${source.name} (canBindNumber=${source.canBindNumber}, `
        + `canBindBoolean=${source.canBindBoolean})`
    ),
  ]
}

/** Render only the closed DTO, then mask the complete string before DATA wrapping. */
function renderProcedureGuardMissRecoveryBlock(
  recovery: ProcedureGuardMissRecoveryContext,
  mask: (value: string) => string,
): string {
  const lines: string[] = [
    `Guarded replay recovery evidence for procedure step ${recovery.stepNumber}`,
    `miss reason: ${recovery.reason}`,
    `miss location: ${renderProcedureGuardMissLocation(recovery.location)}`,
    'Recovery evidence is advisory only; it is not replay authorization',
    `stored action type: ${recovery.action.type}`,
    'stored action targets:',
  ]
  if (recovery.action.targets.length === 0) {
    lines.push('- none')
  } else {
    for (const target of recovery.action.targets) {
      lines.push(`- ${target.lane}: ${renderProcedureRecoveryDescriptor(target)}`)
    }
  }
  lines.push(
    `declared guard target: ${renderProcedureRecoveryDescriptor(recovery.guard.target)}`,
    `page anchor equality: ${recovery.guard.pageAnchorEqual}`,
    'value slots:',
  )

  const parameters = new Map(recovery.parameters.map((parameter) => [parameter.name, parameter]))
  if (recovery.action.valueSlots.length === 0) {
    lines.push('- none')
  } else {
    for (const slot of recovery.action.valueSlots) {
      if (slot.kind === 'literal-omitted') {
        lines.push(`- ${slot.field} <- stored literal omitted`)
        continue
      }
      const parameter = parameters.get(slot.name)
      const declaration = parameter === undefined
        ? 'undeclared'
        : `${parameter.type}, ${parameter.required ? 'required' : 'optional'}`
      const supplied = slot.suppliedSource === undefined
        ? ''
        : `; supplied loop-side (sourceKind=${slot.suppliedSource.kind}; `
          + `sourceName=${slot.suppliedSource.name}; `
          + `declaredType=${slot.suppliedSource.declaredType}); not unresolved`
      lines.push(`- ${slot.field} <- parameter ${slot.name} (${declaration})${supplied}`)
    }
  }

  lines.push('referenced parameter declarations:')
  if (recovery.parameters.length === 0) {
    lines.push('- none')
  } else {
    for (const parameter of recovery.parameters) {
      lines.push(
        `- ${parameter.name}: type=${parameter.type}; `
          + `${parameter.required ? 'required' : 'optional'}; `
          + `interpolatedInCurrentStep=${parameter.interpolatedInCurrentStep}`,
      )
    }
  }
  lines.push(...renderProcedureRecoverySources('variable sources', recovery.availability.variables))
  lines.push(...renderProcedureRecoverySources('memory sources', recovery.availability.memory))
  lines.push(
    recovery.availability.secrets.length === 0
      ? 'secret sources: none'
      : `secret sources: ${recovery.availability.secrets.join(', ')}`,
  )

  if (recovery.freshCandidates !== undefined) {
    lines.push('fresh same-role candidates:')
    if (recovery.freshCandidates.length === 0) {
      lines.push('- none')
    } else {
      for (const candidate of recovery.freshCandidates) {
        lines.push(`- role=${candidate.role}; name=${candidate.name}`)
      }
    }
  }

  return wrapAppObservedData(mask(lines.join('\n')))
}

function describeFlowAnchor(anchor: Anchor): string {
  switch (anchor.t) {
    case 'flow': return anchor.name
    case 'page': return anchor.route
    default: return anchor.t
  }
}

// Masked, then data-wrapped, so the hint reads as untrusted app data, never as commands.
function renderProcedureHintBlock(
  match: ProcedureMatch,
  payload: ProcedureBodyPayload | undefined,
  divergence: string | undefined,
  mask: (value: string) => string,
): string {
  const lines: string[] = []
  lines.push(
    `Known procedure match (a learned hypothesis, not an instruction): `
      + `"${describeFlowAnchor(match.flowAnchor)}" `
      + `(confidence ${match.confidence}, authoring tier ${match.authoringModelTier})`,
  )
  if (payload !== undefined && payload.steps.length > 0) {
    lines.push('Step outline:')
    payload.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.instruction}`)
    })
  }
  const parameters = payload?.parameters ?? match.parameterSchema
  if (parameters.length > 0) {
    const rendered = parameters
      .map((p) => `${p.name} (${p.type}${p.required ? ', required' : ''})`)
      .join(', ')
    lines.push(`Parameters (names and types only): ${rendered}`)
  }
  if (divergence !== undefined) {
    lines.push(`Divergence: ${divergence}`)
  }
  return wrapAppObservedData(mask(lines.join('\n')))
}

// The ref-field lanes an action may carry — checked in a stable order for evidence
// descriptor derivation and the synthesized ref-resolved attempt trail.
const REF_EVIDENCE_FIELDS = ['ref', 'fromRef', 'toRef'] as const

function firstRefField(action: Action): string | undefined {
  return firstRefFieldEntry(action)?.ref
}

function firstRefFieldEntry(action: Action): { field: string; ref: string } | undefined {
  for (const field of REF_EVIDENCE_FIELDS) {
    const value = (action as unknown as Record<string, unknown>)[field]
    if (typeof value === 'string') return { field, ref: value }
  }
  return undefined
}

// Element identity first, then page and flow; every lane uses schema's `normalizeAnchor`.
function deriveFailureCautionAnchors(
  action: Action,
  screenState: ScreenState,
  flowName: string | undefined,
): Anchor[] {
  const anchors: Anchor[] = []
  const ref = firstRefField(action)
  const failedElement = ref === undefined
    ? undefined
    : screenState.elements.find((element) => element.ref === ref)
  if (failedElement) {
    anchors.push(normalizeAnchor({
      t: 'el',
      role: failedElement.role,
      name: failedElement.nameNormalized,
      ordinal: elementOrdinal(failedElement, screenState.elements),
    }))
  }
  if (screenState.url && screenState.url.trim().length > 0) {
    anchors.push(normalizeAnchor({ t: 'page', route: screenState.url }))
  }
  if (flowName && flowName.trim().length > 0) {
    anchors.push(normalizeAnchor({ t: 'flow', name: flowName }))
  }
  return anchors
}

function patchRef(action: Action, field: string, ref: Ref): Action {
  return { ...(action as unknown as Record<string, unknown>), [field]: ref } as unknown as Action
}

// A ref-resolved §A8 attempt trail synthesized when the planner/turn supplied none — one
// 'ref' entry per committed ref field (drag ⇒ fromRef + toRef). The committed refs were
// validated against the fresh snapshot (gate/replay), so 'resolved' is the honest outcome.
function synthesizeRefAttempts(action: Action): GroundingAttempt[] {
  const trail: GroundingAttempt[] = []
  for (const field of REF_EVIDENCE_FIELDS) {
    const value = (action as unknown as Record<string, unknown>)[field]
    if (typeof value === 'string') trail.push({ stage: 'ref', outcome: 'resolved', resolvedRef: value as Ref })
  }
  return trail
}

const STATED_TARGET_LANES: readonly StatedTargetLane[] = ['ref', 'fromRef', 'toRef']
const OBSERVED_ROW_CAP = 200

function carriesStatedTarget(action: Action): boolean {
  return 'target' in action || 'fromTarget' in action || 'toTarget' in action
}

type TargetRefusal = { message: string; block: TargetRefusalMeta }

// The first lane whose stated target clearly contradicts its ref's element; identities scrubbed.
function judgeStatedTargets(
  statedTargets: StatedTargets,
  action: Action,
  elements: readonly ElementInfo[],
  scrub: (value: string) => string,
): TargetRefusal | undefined {
  for (const lane of STATED_TARGET_LANES) {
    const stated = statedTargets[lane]
    const ref = (action as unknown as Record<string, unknown>)[lane]
    if (stated === undefined || typeof ref !== 'string') continue
    const element = elements.find((candidate) => candidate.ref === ref)
    if (element === undefined) continue
    const refusal = judgeLane(lane, 'live', stated, element, elements, scrub)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

// `path` says whether the element is the live ref's or the heal's.
function judgeLane(
  lane: StatedTargetLane,
  path: TargetRefusalMeta['path'],
  stated: StatedTarget,
  element: ElementInfo,
  elements: readonly ElementInfo[],
  scrub: (value: string) => string,
): TargetRefusal | undefined {
  const judgement = judgeStatedTarget(stated, element, elements)
  if (judgement.verdict === 'agrees') return undefined
  const statedIdentity: TargetIdentity = {
    ...(stated.role !== undefined ? { role: scrub(stated.role) } : {}),
    name: scrub(stated.name),
    ...(stated.row !== undefined ? { row: scrub(stated.row) } : {}),
  }
  const observedIdentity: TargetIdentity = {
    role: scrub(element.role),
    name: scrub(element.name),
    ...(judgement.observedRow !== undefined
      ? { row: scrub(judgement.observedRow).slice(0, OBSERVED_ROW_CAP) }
      : {}),
  }
  const reasons: TargetMismatchReason[] = [...judgement.reasons]
  const block: TargetRefusalMeta = {
    kind: 'target-mismatch',
    lane,
    path,
    stated: statedIdentity,
    observed: observedIdentity,
    reasons,
    rowStated: judgement.rowStated,
    inputSent: false,
  }
  return {
    message: renderTargetMismatch({
      lane, ref: element.ref, stated: statedIdentity, observed: observedIdentity, reasons,
    }),
    block,
  }
}

// Names the element by exact name, never position; every identity is scrubbed before evidence.
function buildGroundingEvidence(
  action: Action,
  elements: readonly ElementInfo[],
  attempts: GroundingAttempt[] | undefined,
  statedTargets: StatedTargets | undefined,
  scrub: (value: string) => string,
): GroundingEvidence | undefined {
  const ref = firstRefField(action)
  if (ref === undefined) return undefined
  const element = elements.find((candidate) => candidate.ref === ref)
  if (element === undefined) return undefined
  const descriptor: TargetDescriptor = {}
  if (element.role) descriptor.role = scrub(element.role)
  descriptor.name = scrub(element.name)
  const trail = attempts !== undefined && attempts.length > 0 ? attempts : synthesizeRefAttempts(action)
  const stated = firstStatedTarget(statedTargets)
  if (stated === undefined) return { descriptor, attempts: trail }
  return {
    descriptor,
    attempts: trail,
    stated: {
      ...(stated.role !== undefined ? { role: scrub(stated.role) } : {}),
      name: scrub(stated.name),
      ...(stated.row !== undefined && stated.row.trim().length > 0
        ? { row: scrub(stated.row) }
        : {}),
    },
  }
}

function firstStatedTarget(statedTargets: StatedTargets | undefined): StatedTarget | undefined {
  if (statedTargets === undefined) return undefined
  for (const lane of STATED_TARGET_LANES) {
    const stated = statedTargets[lane]
    if (stated !== undefined) return stated
  }
  return undefined
}

type HealLane = { field: StatedTargetLane; ref: Ref; element: ElementInfo }

type RegroundOutcome =
  | { kind: 'resolved'; lanes: HealLane[]; grounding: GroundingEvidence }
  | { kind: 'unproven'; reason: 'absent' | 'not-unique' }

// One unproven lane, or two lanes collapsing onto one element, makes the whole heal unproven.
function regroundFailedRef(
  action: Action,
  priorElements: readonly ElementInfo[],
  freshElements: readonly ElementInfo[],
  scrub: (value: string) => string,
): RegroundOutcome | null {
  const lanes: HealLane[] = []
  const priorRefs: string[] = []
  const attempts: GroundingAttempt[] = []
  let descriptor: TargetDescriptor | undefined
  for (const field of REF_EVIDENCE_FIELDS) {
    const priorRef = (action as unknown as Record<string, unknown>)[field]
    if (typeof priorRef !== 'string') continue
    const prior = priorElements.find((element) => element.ref === priorRef)
    if (prior === undefined) return null
    const row = rowTextOf(prior, priorElements)

    const match = strictMatch({ role: prior.role, name: prior.name, row }, freshElements)
    if (match.kind !== 'resolved') return { kind: 'unproven', reason: match.kind }
    const collapsed = lanes.some((lane, i) => lane.ref === match.ref && priorRefs[i] !== priorRef)
    if (collapsed) return { kind: 'unproven', reason: 'not-unique' }
    const element = freshElements.find((candidate) => candidate.ref === match.ref)!

    descriptor ??= {
      role: scrub(prior.role),
      name: scrub(prior.name),
      ...(row !== undefined ? { row: scrub(row).slice(0, OBSERVED_ROW_CAP) } : {}),
    }
    lanes.push({ field, ref: match.ref, element })
    priorRefs.push(priorRef)
    attempts.push(
      { stage: 'ref', outcome: 'no-match' },
      { stage: 'tree-search', outcome: 'resolved', resolvedRef: match.ref },
    )
  }
  if (descriptor === undefined) return null
  return { kind: 'resolved', lanes, grounding: { descriptor, attempts } }
}

function operationCaptureAvailability(
  support: OperationCaptureSupport | undefined,
): OperationCaptureAvailability {
  const download = support?.download ? 'available' : 'unavailable'
  const clipboard = support?.clipboard ? 'available' : 'unavailable'
  if (download === 'available' && clipboard === 'available') return { download, clipboard }
  return { download, clipboard, reason: support?.reason ?? 'platform' }
}

// Object reads stringify as JSON so `contains` can match; a network read is judged per entry.
function assertValueReadText(source: string, value: unknown): { actual?: string | null; entries?: string[] } {
  const entries = source === 'network' && Array.isArray(value)
    ? value.map((entry) => JSON.stringify(entry))
    : undefined
  const actual = value === undefined || entries?.length === 0
    ? undefined
    : value === null ? null
      : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return { ...(actual !== undefined ? { actual } : {}), ...(entries !== undefined ? { entries } : {}) }
}

// An extracted value as working memory and the read line show it: a string as itself, anything
// else as JSON, so null reads as null.
function extractedText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// Masks an extracted value's strings, object keys, numbers and booleans. A number or boolean that
// holds a declared secret becomes its masked text.
function maskExtracted(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value)
    const masked = mask(text)
    return masked === text ? value : masked
  }
  if (Array.isArray(value)) return value.map((item) => maskExtracted(item, mask))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [mask(key), maskExtracted(item, mask)]),
    )
  }
  return value
}

function carriedItems(cell: CarriedArtifacts | undefined): { stepNumber: number; actionIndex: number; text: string }[] {
  if (cell === undefined) return []
  const items = cell.downloads.map((entry) => ({
    stepNumber: entry.stepNumber,
    actionIndex: entry.actionIndex,
    text: renderOperationEvidence({ downloads: [entry.evidence] }),
  }))
  if (cell.clipboard !== undefined) {
    items.push({
      stepNumber: cell.clipboard.stepNumber,
      actionIndex: cell.clipboard.actionIndex,
      text: renderOperationEvidence({ clipboard: [cell.clipboard.evidence] }),
    })
  }
  return items
}

// This step's completed downloads, then the carried ones, most recent first.
function savedFileCandidates(
  actions: readonly RecordedAction[],
  carried: CarriedArtifacts | undefined,
): DownloadEvidence[] {
  const own = actions.flatMap((action) => action.operationEvidence?.downloads ?? [])
  const earlier = (carried?.downloads ?? []).map((entry) => entry.evidence)
  return [...own.reverse(), ...earlier.reverse()].filter((download) => download.state === 'completed')
}

function needsSavedFile(output: VerificationResult): boolean {
  return Array.isArray(output.conditions) && output.conditions.some((condition) => condition.needs === 'file')
}

// Only a completed download is evidence it happened; the clipboard keeps the latest write.
function carryForward(cell: CarriedArtifacts, stepNumber: number, actions: readonly RecordedAction[]): void {
  for (const action of actions) {
    for (const download of action.operationEvidence?.downloads ?? []) {
      if (download.state === 'completed') {
        cell.downloads.push({ stepNumber, actionIndex: action.index, evidence: download })
      }
    }
    const latest = action.operationEvidence?.clipboard?.at(-1)
    if (latest !== undefined) cell.clipboard = { stepNumber, actionIndex: action.index, evidence: latest }
  }
}

function takeOperationEvidence(
  execResult: ActionResult,
  mask: (value: string) => string,
  verb: string,
): { result: ActionResult; evidence?: OperationEvidence } {
  const evidence: OperationEvidence = {}
  const raw = execResult.metadata
  let result = execResult
  if (raw !== undefined && ('download' in raw || 'clipboard' in raw)) {
    const downloads = readDownloadMeta(execResult)
    const clipboard = readClipboardMeta(execResult)
    const { download: _download, clipboard: _clipboard, ...metadata } = raw
    void _download
    void _clipboard
    result = { ...execResult }
    if (Object.keys(metadata).length > 0) result.metadata = metadata
    else delete result.metadata
    if (downloads !== undefined) {
      evidence.downloads = downloads.map((download) => ({
        ...download,
        suggestedFilename: mask(download.suggestedFilename),
      }))
    }
    if (clipboard !== undefined) evidence.clipboard = clipboard.map((write) => boundClipboardWrite(write, mask))
  }
  const noop = readIdempotentNoopMeta(execResult)
  if (noop !== undefined) {
    evidence.input = [{ verb, inputSent: false, currentState: mask(noop.currentState) }]
  } else {
    const input = deriveInputEvidence(execResult, verb)
    if (input !== undefined) evidence.input = [input]
  }
  return hasOperationEvidence(evidence) ? { result, evidence } : { result }
}

// Verdicts only, never typed text; inputSent is false only on positive evidence of no delivery.
function deriveInputEvidence(execResult: ActionResult, verb: string): InputEvidence | undefined {
  const fillVerdict = readFillVerdictMeta(execResult)
  const submit = readFillSubmitMeta(execResult)
  const refusal = readFillRefusalMeta(execResult)
  const shell = readShellActionMeta(execResult)
  if (!fillVerdict && !submit && !refusal && !shell) return undefined
  const unavailable = shell?.outcome === 'unavailable'
  const entry: InputEvidence = {
    verb: fillVerdict?.verb ?? refusal?.verb ?? shell?.verb ?? verb,
    inputSent: refusal === undefined && !unavailable,
  }
  if (fillVerdict) {
    entry.fillVerdict = fillVerdict.verdict
    if (fillVerdict.path) entry.inputPath = fillVerdict.path
    if (fillVerdict.secure) entry.secure = true
  }
  if (submit) {
    entry.submit = submit.outcome ?? (submit.sent ? 'sent' : 'not-sent')
    if (submit.reason) entry.submitReason = submit.reason
  }
  if (refusal) entry.unavailableReason = refusal.cause
  else if (unavailable && shell?.reason) entry.unavailableReason = shell.reason
  return entry
}

const NO_CITATION_SOURCES: CitationSources = {
  'start-screen': '',
  'final-screen': '',
  action: '',
  read: '',
  carried: '',
}

function endingVerifierError(error: unknown): VerificationResult {
  return {
    conditions: [],
    dialogs: [],
    isAppError: false,
    reasoning: '',
    verifierError: error instanceof Error ? error.message : String(error),
  }
}

function hasOperationEvidence(evidence: OperationEvidence): boolean {
  return !!(evidence.downloads || evidence.clipboard || evidence.input)
}

// Masked first, so a secret is never cut into an unmaskable fragment, then bounded.
function boundClipboardWrite(write: ClipboardWriteMeta, mask: (value: string) => string): ClipboardEvidence {
  const text = mask(write.text)
  if (text.length <= CLIPBOARD_TEXT_LIMIT) return { ...write, text, truncated: false }
  const end = isHighSurrogate(text.charCodeAt(CLIPBOARD_TEXT_LIMIT - 1)) ? CLIPBOARD_TEXT_LIMIT - 1 : CLIPBOARD_TEXT_LIMIT
  return { ...write, text: text.slice(0, end) + CLIPBOARD_TRUNCATION_MARKER, truncated: true }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function toSchemaResult(execResult: ActionResult, annotation?: ActionAnnotation): SchemaActionResult {
  const result: SchemaActionResult = { success: execResult.success }
  if (execResult.error !== undefined) result.error = execResult.error
  if (execResult.data !== undefined) result.data = execResult.data
  if (execResult.metadata !== undefined) result.metadata = execResult.metadata
  if (annotation) result.annotation = annotation
  return result
}

const ANNOTATABLE = new Set([
  'click', 'fill', 'tap', 'hover', 'scroll', 'swipe', 'pinch', 'navigate', 'drag',
])

function buildAnnotation(action: Action, execResult: ActionResult, viewport: Viewport, failed: boolean): ActionAnnotation | undefined {
  if (!ANNOTATABLE.has(action.type)) return undefined
  const annotation = collapseAnnotation(action, execResult, viewport)
  if (failed && execResult.boundingBox) annotation.failureHighlight = execResult.boundingBox
  const measuredGeometry = action.type === 'drag' || action.type === 'swipe'
    ? !!execResult.startCoordinates && !!execResult.endCoordinates
    : action.type === 'scroll' ? !!execResult.coordinates || !!execResult.boundingBox : !!execResult.coordinates
  if (measuredGeometry && validRecordingAnnotation(execResult.recordingAnnotation, viewport)) {
    annotation.recording = execResult.recordingAnnotation
    if (!validRecordedAnnotation(annotation)) delete annotation.recording
  }
  return annotation
}

function recordSuccess(
  recorder: EvidenceRecorder,
  reasoning: string,
  pair: RecordedPair,
  execResult: ActionResult,
  annotation: ActionAnnotation | undefined,
  cached: boolean,
  grounding: GroundingEvidence | undefined,
  decisionEvidence: DecisionEvidence | undefined,
): number {
  return recorder.recordSubAction({
    plan: reasoning,
    ...pair,
    result: toSchemaResult(execResult, annotation),
    cached,
    grounding,
    ...(decisionEvidence ?? {}),
  })
}

function maybeRecordSelfHeal(
  recorder: EvidenceRecorder,
  failed: Decision | undefined,
  reasoning: string,
  plannedAction: SchemaAction,
  execResult: ActionResult,
  annotation: ActionAnnotation | undefined,
): void {
  if (!failed) return
  const recovering: Decision = {
    plan: reasoning,
    plannedAction,
    result: toRecordedActionResult(toSchemaResult(execResult, annotation)),
  }
  recorder.recordSelfHeal(failed, recovering)
}

function buildStepTrace(
  subActions: SubActionTrace[],
  result: 'success' | 'failure',
  error: string | undefined,
  usage: TokenUsage | undefined,
): StepTrace {
  const last = subActions.length > 0 ? subActions[subActions.length - 1] : undefined
  const first = subActions.length > 0 ? subActions[0] : undefined
  const trace: StepTrace = {
    observation: last?.observation ?? '',
    reasoning: last?.reasoning ?? error ?? '',
    plannedAction: last?.plannedAction ?? { type: 'waitFor', on: 'text', text: '', timeoutMs: 0 },
    result,
    screenStateBefore: first?.screenStateBefore ?? '',
    subActions,
  }
  if (error) trace.error = error
  if (last?.screenStateAfter !== undefined) trace.screenStateAfter = last.screenStateAfter
  if (last?.confidence !== undefined) trace.confidence = last.confidence
  if (usage) trace.tokenUsage = usage
  return trace
}
