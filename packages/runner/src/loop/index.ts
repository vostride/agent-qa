// The runner-owned step-execution loop (D-01/D-02): observe → cached-or-planned plan →
// safety-gated execute → record §A8 evidence → conditional verify. Provider- and storage-neutral.
// Bounded by the per-step action limit, the user timeouts and abort. Screen equality or change
// decides nothing (HARN-01); retries come only from actual errors or operation-specific evidence.

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
import type { SavedFile } from './condition-guards.js'
import { StepRecordAccumulator, type RecordedAction, type RecordedActionOutcome } from './step-record.js'
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

// v1's context-window overflow classification (loop.ts:277-286) — kept byte-equivalent
// (D-04, Pitfall 10): a planning error matching one of these is surfaced with the
// contextWindow/previousStepCount remediation hint rather than the raw error.
const CONTEXT_ERROR_PATTERNS = [
  'context length', 'maximum context', 'token limit',
  'too many tokens', 'exceeds.*max', 'input.*too long',
]

// D-10/LOOP-04 · Pitfall 7 — the DELIBERATELY CONSERVATIVE ref-resolution classifier.
// A matched adapter error string is a stale-ref/wrong-element failure the re-ground heal
// can rescue by re-observing + re-grounding (NOT a replan). Exactly two classes:
//   (a) the shared resolver prefix — 'Unknown ref "…"' (both the web and mobile
//       element-resolvers throw this verbatim), and
//   (b) the Playwright strict-mode violation — '…resolved to N elements'.
// Bare timeouts and every other failure are INTENTIONALLY excluded — they stay on the
// replan path (the D-10 boundary). Do not broaden it.
const REF_RESOLUTION_FAILURE_PATTERNS: RegExp[] = [
  /^\s*Unknown ref\s+["']/i,
  /resolved to \d+ element/i,
]

function isRefResolutionFailure(errorMsg: string): boolean {
  return REF_RESOLUTION_FAILURE_PATTERNS.some((pattern) => pattern.test(errorMsg))
}

// 438 D-07/D-08/D-09: the adapter's typed binding outcomes that send the loop to re-find the
// element. A new document (stale-observation) or a removed frame (frame-detached) never does.
function startsBindingHeal(result: ActionResult): boolean {
  const outcome = readBindingOutcomeMeta(result)?.outcome
  return outcome === 'binding-lost' || outcome === 'binding-changed'
}

function unprovenHealNote(reason: 'absent' | 'not-unique'): string {
  const found = reason === 'absent' ? 'none matches it' : 'more than one matches it'
  return 'The element was replaced or changed, and no single current element is provably the '
    + `same (role, exact name and row: ${found}), so nothing was sent.`
}

// 444 D-51: a cancel can come from any door, so the record names no cause.
export const CANCELLED_MESSAGE = 'The run was cancelled before this step finished.'

// Provisional fallbacks used only until the composition root supplies model-derived numbers
// (380 D-02/D-15/D-17). They are deliberately not config keys; the loop consumes plain budgets.
const PROVISIONAL_BRIEF_TOKEN_BUDGET = 512
const PROVISIONAL_CAUTION_TOKEN_BUDGET = 64
const PROVISIONAL_DISTINCT_RECORD_CAP = 8
const CAUTION_TRUNCATION_ID = 'caution:truncated'

// D-09/D-16 settle-gate bounds. The poll is deliberately small (Pitfall 4/5): the first
// observation doubles as stateBefore (no extra capture), so only the extra poll iterations
// before two consecutive matching screenIdentityHash values cost anything. The inter-poll
// wait defaults to 0 (deterministic, back-to-back) — the composition root injects a real
// animation-settling interval; the step deadline is the hard proceed-on-latest backstop.
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

// The return paths:
//   1. planner stepFailed          → failed  (no execution; one verifier call, ending 'give-up'
//                                    or 'infeasible', unproven conditions after the reason)
//   2. setVariable + stepComplete  → passed  (short-circuit, no verify)
//   3. verify pass                 → passed  (the runner's judgment of cited per-condition verdicts)
//   4. verify app-error            → failed  (no further replan)
//   5. no-verifier + stepComplete  → passed  (test seam only; C439-CENSUS proves every production
//                                    door binds a verifier)
//   6. action or planning limit    → failed  (typed limitStop; one verifier call, ending 'limit-stop')
//   7. policy denial or a planning failure → failed  (no verifier call)
//   8. abort / timeout             → cancelled | failed  (no verifier call; the requested outcome
//                                    is recorded unverified with their reason)
//   9. assertAI or extractAI the model could not judge or extract → failed  (no verifier call;
//                                    the requested outcome is recorded unverified, ending
//                                    'unresolved')
// Other execution failures and a rejected completion are NOT return paths — they inject failure
// context and continue the loop (self-heal = replan-with-failure-context, D-12).
export async function executeStep(
  stepInstruction: string,
  ports: LoopPorts,
  context: StepContext,
): Promise<StepResult> {
  const startTime = performance.now()
  // D-11: modality resolved once at composition; absent gate = full-capture (the
  // pre-gate default for non-CLI callers and tests). The loop owns the branching.
  const gate = ports.visionGate ?? { attachImage: true, captureMode: 'full' as const, promptNote: '' }
  // 436 D-07/D-10: one monotonic meter per step execution, never refilled and never derived
  // from actionIndex (cache-key material).
  const meter = new StepLimitMeter({
    maxActions: ports.plannerConfig?.maxActions ?? DEFAULT_PLANNER_LIMITS.maxActions,
    maxPlanningTurns: ports.plannerConfig?.maxPlanningTurns ?? DEFAULT_PLANNER_LIMITS.maxPlanningTurns,
  })
  // 436 D-11: inner inputs of each executed compound action, keyed by its sub-action index.
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

  // §A8 evidence accumulator (D-14) — the recording array IS SubActionEvidence[].
  // D-02 (Plan 361-08): bind the one sub-action emission chokepoint to ports.events when
  // present, so every recordSubAction append emits `subActionRecorded` live. D-02 (423):
  // the same boundary persists the already captured before tree; no capture or handoff rewrite.
  // 407 D-13/D-16: the rung was resolved ONCE at the composition root; the loop awaits that one
  // promise and stamps what it gets. Two guards, each a way the banner could otherwise lie:
  //   - no bound reader ⇒ no rung, because "no knowledge reader bound is not a rung" (D-16) and a
  //     step served no brief must not be labelled as if a ladder chose its content;
  //   - a rejected probe folds to `undefined` rather than propagating — asking the host what it
  //     can do must never be able to fail a test step (T-407-16).
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
  // 436 D-23: what this platform can capture, recorded once per step; unsupported never invents.
  recorder.recordOperationCapture(operationCaptureAvailability(ports.adapter.operationCaptureSupport))
  // 436 D-22: the step's operation evidence across its sub-actions, for the verifier.
  const stepOperationEvidence: OperationEvidence = {}
  // 439 D-03: everything the step did and read, for the verifier; never the planner's reasoning.
  const stepRecord = new StepRecordAccumulator()
  const recordMask = (value: string) => redactSecretValue(value, ports.secretRedactor)
  const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()
  // 439 D-04: what earlier steps of this test downloaded or copied, labelled by its producer.
  for (const item of carriedItems(ports.carriedArtifacts)) {
    stepRecord.addCarried({ stepNumber: item.stepNumber, actionIndex: item.actionIndex, text: recordMask(item.text) })
  }
  // 439 D-17: bytes are read only for this step's completed downloads and this test's carried ones.
  const savedFiles = (actions: readonly RecordedAction[]): SavedFile[] =>
    savedFileCandidates(actions, ports.carriedArtifacts).map((download) => ({
      name: download.suggestedFilename,
      bytes: download.sha256 !== undefined ? ports.adapter.readDownloadBytes?.(download.sha256) : undefined,
    }))
  // D-17: one ledger object lives where turns live. A bound object is shared with Channel-2 tool
  // closures; otherwise this step-local instance still accounts for the frozen Channel-1 brief.
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

  // activePredicate persists the declared D-09 bulk predicate for the run.
  let activePredicate: string | undefined

  // 436 D-13: attached to a limit stop when they exist; masked when recorded.
  let lastVerifierRejection: string | undefined
  let lastPlannerReasoning: string | undefined

  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let lastPlannedAction: Action | undefined
  let lastExecutedAction: Action | undefined
  // D-13: a failure retrieves once at the failure moment, then the returned block is consumed
  // by the immediately-following live planning turn. Clearing happens before that turn renders,
  // so a successful follow-up cannot make the caution sticky; a recurring failure stages anew.
  // D-16: the staged value is the caution block WITH its serve-time trace, so the Channel-3 half
  // of the trace survives to the evidence seam instead of being reconstructed there.
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
    // WR-10 (387-13): stage the composite the reader returned, whole. The old predicate here kept
    // it only when a caution would actually RENDER, which threw away the all-cut turn's whole
    // attribution ledger — the exact step "why didn't it mention X" is asked about. There is
    // deliberately no replacement predicate: one gating on "a caution or a non-empty trace" was
    // written and then measured INERT (a wholly empty composite records nothing and renders
    // nothing, so staging it is observably identical to skipping it), and an unpinnable gate that
    // a later reader would take for an invariant is worse than no gate. What must not be dropped
    // is dropped nowhere: the consuming turn re-checks nothing either.
    pendingCautions = served
  }

  // A completing plan that dispatched assertAI or extractAI never writes the cache; this latch
  // makes finalize report 'bypass'.
  let cacheBypass = false

  // PROC-02 (381 D-09..D-12, F-381-51-1) per-step procedure state. `procedureConsulted`
  // makes the getProcedure consult a strict at-most-once-per-step event (D-09) — a carried
  // flow resume (2a′ below) substitutes the consult entirely. `procedureReplay` holds the
  // decoded body plus the guard-fold bookkeeping while replay drives THIS step's one body
  // step (`nextIndex` is the cursor into the committed body; `stepCursor` records the body
  // index this test step attempted; `attempted`/`checksPassed` are the PER-STEP fold —
  // total/passed stored actions within this step). `aborted` is the D-11 one-shot
  // guard/execution-failure latch (no replay re-entry within the step, and an aborted flow
  // is never re-armed into the cross-step carry).
  // `procedureHintStaged`
  // carries the rendered hint block (matched-hint mode, unparseable-body demotion, or the
  // post-miss structural recovery projection) for ledger-metered exposure on every
  // subsequent live planning turn; `procedureHintExposed` keeps the planSource
  // procedure-hint write once-per-step.
  let procedureConsulted = false
  let procedureReplay: {
    match: ProcedureMatch
    payload: ProcedureBodyPayload
    nextIndex: number
    checksPassed: number
    /** Stored actions attempted within THIS test step — the per-step fold's `total` (D-12). */
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
    /** Set only on the fail-closed body-read demotion path (G-381-4 / D-12). */
    demotion?: ProcedureHintDemotion
  } | undefined
  let procedureHintExposed = false

  // Loop-side procedure parameter binding (D-08/T-381-21): values bind by NAME from the
  // same source-tagged availability contract the matcher admitted (WR-03). Secret parameters
  // hard-wall to the secret store; strings preserve variables -> memory -> secret-template
  // precedence. Typed coercion delegates to the ONE schema-owned law
  // (coerceProcedureBindingValue in schema procedure-binding-coercion.ts) — the same
  // function that computes the capability bits crossing the reader port — with try-in-order
  // source semantics: the first source (variables, then memory) whose value passes the
  // shared coercion binds, so binder success is exactly the matcher's per-source capability
  // OR (the completed 381-22 WR-01 law, now value-typed). A miss here is genuine
  // availability/type drift and is reported as parameter-unbound below.
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

  // D-08 capability assembly (RESEARCH Open Q2): preserve the three source identities so
  // procedureParameterFillability and this binder apply one contract. Variables and memory
  // carry capability entries computed HERE, loop-side, by procedureSourceBinding over the
  // raw values — the same shared coercion the binder uses, so matcher admission and loop
  // binding cannot drift. Only names and per-type capability booleans cross the reader
  // port; no test-variable, working-memory, or secret value ever does.
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
        // PER-STEP fold (F-381-51-1 · D-12): checksPassed/total range over the stored
        // actions attempted within THIS test step (one body step per test step, D-09), so
        // checksPassed === total keeps meaning "this step's replayed actions all passed
        // guards, executed, and were accepted" for every consumer. Cross-flow position
        // lives in `flow` below, never in the fold.
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

  // F-381-51-1 · D-09 re-arm half of take-then-rearm. Called ONLY at a successful step
  // completion whose completing decision was a replayed body step, with body remaining and
  // the flow non-aborted. Every other exit path — guard miss, execution failure, verifier
  // rejection, policy denial, step failure, abort, exhaustion, any terminal builder —
  // leaves the cell empty: the 2a′ take already cleared it and this is the ONLY write
  // site, so carry loss is the default (the D-11 one-shot law extended across the step
  // boundary: a miss at a carried step demotes to hint within that step and the flow is
  // over for the run).
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

  // D-15c self-heal boundary carry: the previous failed sub-action's index +
  // Decision. On the next iteration's observation (which reveals the failure), that
  // observation is attached as the failed sub-action's stateAfter AND is naturally the
  // recovering sub-action's stateBefore (identical-state sharing, one capture).
  let pendingSelfHeal: { index: number; failed: Decision } | undefined

  // CACHE-02 (D-07/D-08): classify the step by resolution provenance ONCE. A step that
  // reads a live secret ({{secret:X}} / [secret:*] marker) or sets an env/secret variable
  // is NonCacheableStepInput — the loop bypasses the cache entirely (no get, no set) and
  // finalize emits cacheStatus='bypass' (Pitfall 7). The read path reuses the shipped
  // findSecretTemplates/marker provenance; the set path reuses the setVariable verb
  // vocabulary until the live resolver-reported provenance is wired (Phase 362).
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
    // WR-10′ (387-15): the staged failure-caution composite belongs to that same backstop set. It
    // is consumed by the NEXT planning turn and by nothing else, and this step may never reach one
    // — the deadline check and the action-limit check both return above that pickup. The
    // step those exits end is exactly the terminal failure "why didn't it mention X" is asked
    // about, and without this drain its whole attribution ledger is lost (KREV-02, D-14).
    //
    // It lives HERE, at the single terminal funnel documented below, rather than at each exit:
    // draining at the individual return sites would be an enumeration of a hand-picked member set
    // that the next exit silently escapes. Every terminal RETURN in this file routes through
    // finish(), so a return-shaped exit nobody has written yet inherits the drain by construction.
    //
    // Scope, stated as narrowly as the tests measure it (WR-06, 387-19). RETURNS are the funnel's
    // reach; the THROW-shaped exits are not covered and are outside this backstop by design, not by
    // oversight — a throw leaves executeStep with no StepResult at all, so it abandons the step's
    // entire evidence record and not merely this ledger. Folding them in is a behaviour change, and
    // deliberately not one this comment pretends has happened.
    //
    // That exception is bounded by SHAPE, and the shape is a fact a test reds rather than a claim
    // this comment asserts: `trace-threading.test.ts` → 'every throw-shaped exit is a re-raise
    // after a missed abort re-check (387-19)' classifies every throw statement in this file and
    // accepts exactly two shapes — a caught error re-raised immediately below the checkAbort()
    // re-check (so the raise happens only because the error was NOT an abort), and a constructed
    // `throw new …` for a violated invariant. A third shape, or a re-raise without its re-check,
    // reds that scan. It pins no count of sites: a further conforming site is controlled for there
    // and must stay silent, so this paragraph does not rot when one is added.
    //
    // Zero injected is the truthful argument, not a shortcut: a staged-but-never-consumed turn
    // rendered nothing, so every line the reader served is a cut candidate under the recorder's
    // own uniform injected/non-injected split (387-13 Shape B). No caution enters the ServedBrief,
    // whose bytes therefore cannot move (D-13). No new recorder logic and no special case.
    if (pendingCautions !== undefined) {
      recorder.recordServedCautions([], pendingCautions.trace)
      pendingCautions = undefined
    }
    // WM-01 masked snapshot (Pitfall 7 boundary 3): the whole served set snapshots into
    // StepEvidence.workingMemory with declared values masked (441 D-06),
    // BESIDE the brief. Unbound port ⇒ no snapshot (optional-port idiom).
    if (ports.workingMemory) {
      recorder.recordWorkingMemory(
        ports.workingMemory.entries().map((entry) => ({ ...entry, value: recordMask(entry.value) })),
      )
    }
    recorder.recordLimitUsage(meter.snapshot(
      compoundInputs.filter((input) => input.subActionIndex < recorder.subActionCount),
    ))
    // 381-41 (G-381-3): the step's {{env:NAME}} provenance pairs ride to the recorder
    // VERBATIM — deliberately NOT through recordMask, unlike the
    // workingMemory snapshot above. Masking would transform email-valued and
    // credential-named bindings here while `plannedAction` and `stepInstruction` stayed
    // raw, so the emit fold's exact-string match would miss and replay would stay
    // permanently `hint`. Do not "harden" this by adding a mask; that IS the bug.
    const evidence = recorder.finalize(verdict, 0, stepInstruction, {
      nonCacheable: nonCacheable || cacheBypass,
      ...(context.interpolatedVariables ? { interpolatedVariables: context.interpolatedVariables } : {}),
    })
    // D-02 live emission (Plan 361-08): finish() is the single terminal funnel (success/
    // failure/cancelled + the direct finish() call sites all route here), so emitting once
    // here covers EVERY terminal path exactly once. Fire-and-forget SYNC, optional-chained —
    // the loop never awaits telemetry; unbound port ⇒ no emit, byte-identical (D-02/D-07/D-05).
    //
    // 363 D-01: this is the ONE place the StepResult-derived status/durationMs/error exist AND the
    // stepFinalized event is emitted, so the parity enrichment rides here (not a second core-side
    // emission, which would double-publish). `error` is masked at the sink chokepoint (T-363-05).
    const durationMs = performance.now() - startTime
    // 405 D-05: `tokenUsage()` is the ONE producer of this step's usage — it already feeds
    // buildStepTrace four lines below, and already answers `undefined` when neither counter
    // moved. Passing it here gives the bus the same number the legacy trace carries, with no
    // second accumulator and no zero-fill.
    ports.events?.stepFinalized(evidence, { status, durationMs, error, tokenUsage: tokenUsage() })
    // The legacy trace is projected FROM evidence (Open Q5) — this array is exactly
    // projectLegacyTrace(result.evidence); the loop never mutates it after projection.
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

  // 439 D-08 (supersedes 436 D-13's no model call at exhaustion): a give-up, an infeasible
  // declaration and a limit stop are each judged once per condition over a settled final screen.
  // The call is recorded, never debited (436 D-09). It returns the unproven conditions' reason
  // ('' when none, or when no verifier is bound), or the abort result when the step was aborted.
  // The verdicts explain the ending; they never turn it into a pass.
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

  // 436 D-12: the limit stop ends the step through the ordinary failure funnel with its own typed
  // block — never a planning failure, a termination or a verdict. 439 D-08: it is judged once.
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

  // Best-effort step-level "before" screenshot (artifacts; SCREEN-03).
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
    // 2026-10-14 (441-01, D-10): a literal [secret:NAME] would type the placeholder text itself.
    const refusal = literalSecretMarkerRefusal(toExecute)
    if (refusal !== undefined) return { result: { success: false, error: refusal }, error: refusal }
    let result: ActionResult
    let rawData: unknown
    try {
      // Template resolution stays INSIDE the try (T-353-08): a MissingSecretError is caught
      // and surfaced as a redacted execError — the action never reaches the adapter.
      const actionForExecution = resolveSecretTemplatesInValue(toExecute, ports.secretStore)

      if (actionForExecution.type === 'setVariable') {
        // Pitfall 8 — setVariable runs via the callback, NOT the adapter.
        const sv = actionForExecution as Extract<Action, { type: 'setVariable' }>
        ports.onSetVariable?.(sv.name, sv.value)
        result = { success: true }
      } else {
        let actionToExecute = actionForExecution
        if (actionForExecution.type === 'fileUpload' && ports.resolveUploadPath) {
          // Pitfall 1 — path resolution is injected core-side; the loop never touches paths.
          const resolveUpload = ports.resolveUploadPath
          actionToExecute = { ...actionForExecution, files: actionForExecution.files.map(f => resolveUpload(f)) }
        }
        let finishAnnotation: (() => RecordingAnnotationWitness | undefined) | undefined
        try { finishAnnotation = ports.adapter.recording?.beginAnnotation?.() } catch { /* Optional evidence must not prevent execution. */ }
        // 2026-10-08 (436-15, D-19): the adapter's post-action wait ends at the step deadline or abort.
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

    // 436 D-10: the next action would be refused, so stop before any planner call. 439 D-08: the
    // stop settles and observes once (not counted) so the verifier judges a final screen.
    if (meter.actionsExhausted()) return await limitStop('actions')

    // 1. SETTLE + OBSERVE — the bounded settle gate polls screenIdentityHash and proceeds
    // only on two consecutive matching hashes (or the maxPolls/deadline bound, D-16). The
    // settled observation is the next sub-action's stateBefore (D-15, no extra capture —
    // Pitfall 5); a heal that re-dispatches records its own observation in healedDispatch
    // (444.1 D-14). The settled hash doubles as settle-stability and the 8th cache-key component.
    let screenState: ScreenState
    let settledHash: string
    try {
      const settled = await settle(
        () => withAbort(ports.adapter.observe({ extractDom: true }), ports.abortSignal),
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

    // D-15c: the observation that reveals a prior failure is the failed sub-action's
    // stateAfter (and this iteration's planning stateBefore — the same object).
    if (pendingSelfHeal) {
      recorder.attachStateAfter(pendingSelfHeal.index, screenState)
    }

    let screenshot: Buffer | undefined
    if (ports.adapter.screenshot) {
      try { screenshot = await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
    }

    const abortAfterObserve = checkAbort()
    if (abortAfterObserve) return abortAfterObserve

    // Derive the ONE finalized planner attachment and its capture stamp from a single source
    // (T-367-17). The configured compression branch owns compressed bytes + returned dims; when
    // an image is attached but no vision sizing is configured, the RAW bytes are the attachment
    // and dims come from the dimension port (host-neutral viewport fallback when unbound). The
    // captureMode is then stamped ONCE from the actual attachment, so `full`/`textOnly` describes
    // the real planner call on both the compressed and raw/no-sizing paths (Pitfall 9).
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

    // Inject the gated image + prompt note for the planner (D-11): text-only omits the
    // image block and leans on the tree/DOM via the prompt note.
    context.screenshot = gate.attachImage && screenshot ? screenshot : undefined
    context.promptNote = gate.promptNote

    // One authoritative modality stamp over the finalized attachment: `full` (with the selected
    // dims) when an image is attached, otherwise `textOnly`. This is the single source of the
    // recorded stateBefore.metadata.captureMode for every planner call.
    const captureStamp: CaptureStamp = context.screenshot && captureDims
      ? { mode: 'full', imageWidth: captureDims.imageWidth, imageHeight: captureDims.imageHeight }
      : { mode: 'textOnly' }
    screenState = stampCaptureMode(screenState, captureStamp)

    // 2. PLAN — procedure-first at step start (PROC-02/D-09), then the replay → re-ground →
    // replan hit ladder (D-13), then the planning turn.
    //
    // 2a′. CARRIED FLOW RESUME (F-381-51-1 · D-09): a completed replayed step with body
    // remaining re-armed the member-scoped carry cell; this step TAKES it — read and
    // immediately empty (take-then-rearm: the cell is emptied at step start and re-armed
    // only after this step's verifier accepts a successful replayed step with body
    // remaining, so every early exit leaves no carry, D-11). The carry substitutes the
    // step-start consult for flow-covered steps — ZERO matcher call, keeping D-09's
    // once-per-step consult as an upper bound. It transports only match + parsed payload +
    // cursor, never a resolved ref: the carried body step still re-earns dispatch through
    // the FULL fresh-screen guard ladder in §2b below (D-10 — never a blind action).
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

    // 2a. STEP-START PROCEDURE CONSULT (D-09): at most once per step, before the first
    // planning turn AND before the per-decision cache consult (the researcher-recommended
    // procedure-first precedence). Optional-chained getRunBrief idiom: an unbound reader
    // costs nothing (binding names are not even assembled) and never throws. Intent is the
    // NL step text; source-tagged binding NAMES are assembled loop-side — values never cross.
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
            // Fetch + decode the committed body. parseProcedureBody is fail-closed
            // (T-381-01): an unreadable or unparseable body demotes the match to hint —
            // never a throw, never a blind replay.
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
              // G-381-4: the wall is unchanged — no partial body, no default body, no replay
              // without a parsed payload. Only the EVIDENCE changes: the earned replay that
              // the wall just refused records WHY, so a starved replay can never again be
              // indistinguishable from an ordinary hint recommendation (D-12).
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
    // A passed guard authorizes exactly one dispatch attempt; its cursor/fold commit is
    // deferred until that action has actually executed successfully (381 CR-02).
    let pendingProcedureReplay: {
      procedureStepIndex: number
      instruction: string
    } | undefined
    let advancedProcedureStepIndex: number | undefined
    // The per-decision-point cache key: masked stepText + value-free env digest + the
    // settled screenIdentityHash as the 8th component (D-05/D-09). Branch never enters key
    // material. Undefined for non-cacheable (bypassed) steps or when no cache is bound.
    let cacheKey: CacheKey | undefined
    const cacheActive = !nonCacheable && !!ports.cache

    // 2b. GUARDED PROCEDURE REPLAY (D-09/D-10/D-11, F-381-51-1): each test step consumes
    // exactly ONE committed body step — the one at the carried cursor — under the FULL
    // guard (unique fresh-screen re-ground + page-anchor equality + grounding gate, the
    // one guard idiom shared with cache replay, T-356-04a). Body steps map 1:1 onto test
    // steps: the replayed decision completes its own test step and the remaining body
    // rides the member-scoped carry to the NEXT step (`attempted === 0` makes the per-step
    // consumption law structural, never just a consequence of the abort latches). A guard
    // miss aborts replay for the WHOLE flow: the miss is folded into planSource, a closed
    // value-free recovery projection reaches ordinary planning, and ordinary planning takes
    // over — no replay re-entry within this step and no carry (one-shot, D-11).
    // Replayed actions keep `cached: false`, skip the cache consult below, and are never
    // written back into the action cache.
    if (procedureReplay && !procedureReplay.aborted
      && procedureReplay.attempted === 0
      && procedureReplay.nextIndex < procedureReplay.payload.steps.length) {
      const replayState = procedureReplay
      const procedureStep = replayState.payload.steps[replayState.nextIndex]
      replayState.stepCursor = replayState.nextIndex
      replayState.attempted++
      // Landmarks are a SOFT diagnostic only (D-10): a missing landmark logs, never misses.
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
        // F-381-51-1 · D-09: every replayed decision completes its own test step — the
        // step's verifier runs per replayed body step (verifier boundaries stay intact)
        // and the remaining body reaches the NEXT test step via the carry, never this one.
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
        // D-11 demotion: project only the typed structural facts the recovery turn may see.
        // The projector is the raw-input firewall; the renderer accepts only its closed DTO
        // plus the whole-string masker, so authored procedure prose and bound values cannot
        // cross this post-miss seam.
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
        // D-20 (Plan 361-08): key the cache on the real digests the CLI mints when present, so
        // cache identity and the future handoff identity share ONE mint (Pitfall 1 — they cannot
        // fork). Absent port ⇒ empty strings, preserving today's key material exactly (D-05). The
        // one-time invalidation when real digests first arrive is accepted (no-back-compat law).
        suiteConfigDigest: ports.configDigests?.suiteConfigDigest ?? '',
        testConfigDigest: ports.configDigests?.testConfigDigest ?? '',
        stepText: stepInstruction,
        stepIndex: actionIndex,
        testIndex: 0,
        envVars: cacheEnvVars,
        screenIdentityHash: settledHash,
      }))
      const hit = await ports.cache!.get(cacheKey)
      if (hit) {
        // Exact-key hit: re-find each stored target strictly in the FRESH observation (a stored
        // target never drives a blind click, T-356-04a, and never a pick, D-10). All resolve ⇒
        // replay with NO LLM call. A key hit that does not replay is a recorded miss with its
        // reason (D-11), then invalidated and replanned (A7).
        const replay = replayFromCache(hit, screenState.elements)
        if (replay.ok) {
          planResult = { plan: replay.plan }
          cached = true
        } else {
          recorder.recordCacheMiss({ reason: replay.reason })
          await ports.cache!.invalidate(cacheKey)
          ports.logger?.createScopedLogger('cache')?.debug(
            'Cached target does not replay — re-planning', { actionIndex, reason: replay.reason },
          )
        }
      }
    }

    if (!procedureReplayed && !cached) {
      // 436 D-08: a live decision needs a planner call; cache and procedure replay do not.
      if (meter.planningExhausted()) return await limitStop('planning-turns')
      const turnOrdinal = nextLiveTurnOrdinal
      // Knowledge-brief sourcing seam (D-12): source the full three-tier brief through the
      // optional KnowledgeHintReader port. In M1 `ports.knowledgeReader` is unbound, so this
      // yields undefined and the slots stay empty and NEVER throw. D-05 routes only
      // sovereign/authored L0 into the cached-prefix context tier; learned L1/L2 remain volatile
      // and are always framed as hypotheses, never instructions. Channel 1 is deterministic,
      // Channel 2 has planner agency, and Channel 3 has no agency; all three share the
      // distinct-id ledger below.
      const briefScope = { tier: 'test', key: context.testName } as const
      const briefBudget = ports.knowledgeBudgets?.brief ?? PROVISIONAL_BRIEF_TOKEN_BUDGET
      // D-16: one value carries the brief AND the serve-time trace, so the trace cannot be lost
      // between the port and evidence — it is destructured here and handed straight to the
      // recorder alongside the block it explains (KREV-02).
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
      // The brief rides every planning turn, so its distinct ids are already spent before any
      // agentic search/read or automatic failure caution can admit a record (Pitfall 9).
      recordLedger.resetTurn(brief?.admissions ?? [], {
        surface: 'brief-line',
        turnOrdinal,
      })
      // D-11: reset the independent cumulative read-body counter only after the shared distinct-id
      // ledger has been reseeded for this turn. An unregistered Channel-2 surface leaves this absent.
      beginMemoryTurn?.(
        briefScope,
        brief?.lines.map((line) => line.id) ?? [],
        turnOrdinal,
      )
      // D-13/D-16/D-17 Channel 3 has no agency: surface the staged records as failure-adjacent
      // observations inside the existing hypotheses frame, then clear them. Re-emphasizing an
      // id already present in Channel 1 is intentionally free — the planner should not have to
      // remember the caution after demonstrating the exact failure it warns about. New ids still
      // consume the shared distinct-record cap, and every refusal is visible rather than clipped.
      // WR-10 (387-13): entered for anything staged, with no second opinion about whether it was
      // worth entering — `stageFailureCautions` already applied that predicate, and a re-check
      // here would be a redundant gate free to disagree with it. A staged block with no cautions
      // is the all-cut turn: nothing renders, but its attribution ledger is still recorded.
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
            // 380-10's reserved terminal line is a reader-owned overflow signal, not a durable
            // record. Render it, but never spend or mint a ledger admission for it.
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

        // The serve-time trace rides with the injected lines: the recorder keeps only the
        // attributions for cautions that were ACTUALLY rendered into the turn, so the trace
        // never claims a record the planner never saw (D-13's honest-testimony rule). The
        // recording sits OUTSIDE the observations gate below: what the planner was shown and
        // what the run can later account for are different questions, and a turn that rendered
        // no frame still owes an answer for the candidates it declined to render (WR-10).
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
      // PROC-02 hint exposure (D-11 / T-381-20): a matched-hint or post-miss-demoted
      // procedure renders as one compact DATA-wrapped block appended into the L2 slot —
      // the volatile hypotheses-not-instructions frame's procedures tier (the Channel-3
      // caution append idiom above; BRIF-01 lineage: hypotheses, never instructions or
      // commands, on every prompt surface). Admission rides the shared record ledger with
      // real ServingRecordMetadata (id + flow-anchor cluster + renderedCost); a refusal
      // drops the block fail-closed for this turn — never the turn itself, never an
      // unmetered fallback. Empty-slot omission is preserved: no staged hint ⇒ no section.
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
          // RESEARCH Open Q3 (D-12): a hint actually rendered into a planning turn records
          // planSource procedure-hint — unless a replay attempt already owns the planSource
          // slot (post-miss demotion keeps the procedure-replay fold with its miss).
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
      // WM-01 serve (D-11): the whole run-scoped set is served verbatim to every planning turn
      // via the optional workingMemory port (the knowledgeReader idiom). Unbound ⇒ left as-is,
      // the loop runs memory-less. The served set is what finalize snapshots masked.
      if (ports.workingMemory) context.workingMemory = ports.workingMemory.entries()
      // D-09 active bulk-completion predicate — re-stated as volatile turn content each turn
      // (persisted once declared); the planner re-evaluates + cites, the verifier backstops.
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
      // 436 D-08: the planner debits each model call through the gate; a planner that reports
      // none is debited once per plan().
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
        // 436 D-12: the planning limit refused a planner call — its own typed stop, never a
        // planning failure.
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

    // §A8 decision-screenshot persistence (CASS-02, T-367-17). For a LIVE model decision that
    // attached an image, persist the EXACT bytes the planner received (context.screenshot — never
    // the step-level artifact shot, raw pre-compression bytes, or a later shot) exactly once and
    // record the returned ref ON liveDecisionEvidence, so every terminal evidence branch this
    // iteration carries it through the one existing spread (recordSubAction / recordSuccess).
    // Cache replays (liveDecisionEvidence absent) and text-only turns (no context.screenshot) mint
    // no ref. A host-store failure is caught and warned bytes-free (T-367-17-I/D): the ref stays
    // absent so downstream completeness can classify the missing evidence — the run never fails.
    if (liveDecisionEvidence && context.screenshot && ports.evidenceArtifacts) {
      try {
        liveDecisionEvidence.decisionScreenshotRef = ports.evidenceArtifacts.persistDecisionScreenshot(context.screenshot)
      } catch {
        ports.logger?.createScopedLogger('evidence')?.warn('Failed to persist decision screenshot')
      }
    }

    const rawPlan = planResult!.plan

    // WM-01 CAPTURE-BEFORE-NAVIGATE (Pattern 6): the planner authored remember[] against the
    // pre-action observation this turn — write it to the run-scoped store BEFORE the action
    // dispatches, so the entries record atomically with the navigating action. The store
    // redacts registered secrets at capture (Pitfall 7 boundary 1); values stay verbatim.
    if (rawPlan.remember && rawPlan.remember.length > 0) {
      ports.workingMemory?.capture(rawPlan.remember, { step: actionIndex })
    }
    // D-09 persist the declared bulk-completion predicate for the rest of the run.
    if (rawPlan.bulkCompletionPredicate) activePredicate = rawPlan.bulkCompletionPredicate

    let normalizedAction = normalizePointerActionForStep(rawPlan.action as Action, stepInstruction)
    // Redact BEFORE recording (Information-disclosure control, T-353-08): every value
    // that reaches evidence/display is pre-redacted; secret templates are resolved only
    // at the execute boundary below.
    let action = redactSecretValue(normalizedAction, ports.secretRedactor)
    const reasoning = redactSecretValue(rawPlan.reasoning, ports.secretRedactor)
    lastPlannedAction = action
    if (!cached && !procedureReplayed && reasoning.trim() !== '') lastPlannerReasoning = reasoning

    // The grounding gate is the ONE chokepoint between plan and adapter.execute (D-08).
    // Live turn-produced plans arrive gate-resolved from the Plan-06 turn — their §A8 trail
    // rides on rawPlan.groundingAttempts, and re-running the gate here would double-ground
    // against the same observation. Only the cache-replay path (and any residual out-of-turn
    // plan) is (re-)validated here: replayFromCache already resolved every stored descriptor
    // to a fresh ref, so the gate confirms the ref is in the fresh snapshot and yields the
    // §A8 attempt trail for the replay's evidence. A gate failure maps: ref_not_in_snapshot ⇒
    // the D-10 heal; any other failure ⇒ the failure-context flow.
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
      // D-04: a residual out-of-turn plan carrying a target is grounded here, so its stated
      // target reaches the pre-dispatch check like a live turn's; the grounded action executes.
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

    // The §A8 grounding block for this sub-action's evidence (GROUND-02), redacted before
    // record (T-357-02a). Recomputed to the heal trail below if the D-10 heal fires.
    let grounding = buildGroundingEvidence(
      action,
      screenState.elements,
      gateAttempts,
      statedTargets,
      recordMask,
    )

    // Persist the completing decision's plan into the per-key cache as a descriptor-only
    // value (D-12 overfit guard: buildCachedPlanValue strips ref/coords/data and derives
    // role + exact name locators, with the decision's stated row words when the observed row
    // holds them, D-11). setVariable actions are never cached (env provenance). No-op for
    // bypassed steps, cache hits, or when no cache is bound.
    const cacheCompletingPlan = async (): Promise<void> => {
      // Pitfall 4 cache-vs-procedure precedence: a procedure-replayed completing plan is
      // NEVER persisted into the action cache. The procedure store owns replaying whole
      // flows ACROSS test steps — one body step per test step, resumed through the
      // member-scoped carry (F-381-51-1 · D-09) — and replayed completing plans stay out
      // of the cache; double-storing a replayed action under a decision cache key would
      // let the cached flag claim what planSource already attributes — evidence separation
      // (D-12) requires exactly one provenance per decision. (Structurally `cacheKey` is
      // already undefined here because replayed decisions skip the cache consult; this
      // guard makes the precedence decision explicit.)
      if (procedureReplayed) return
      if (!cacheActive || cached || !cacheKey || !ports.cache) return
      if (normalizedAction.type === 'setVariable') return
      // D-08 write guard (Phase 360): an AI-assertion plan is never persisted. Narrowing the
      // action away from the assertAI/extractAI members IS the CacheablePlannedAction typecheck
      // proof (Plan 09's Exclude type) — buildCachedPlanValue below receives only cacheable
      // members without a cast, and the bypass stamp threads through finalize.
      if (normalizedAction.type === 'assertAI' || normalizedAction.type === 'extractAI') return
      await ports.cache.set(cacheKey, buildCachedPlanValue({
        plannedActions: [normalizedAction],
        elements: screenState.elements,
        verificationOutcome: 'passed',
        ...(statedTargets !== undefined ? { statedTargets } : {}),
      }))
    }

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
      // D-04 fork (Phase 360): a `failureKind:'infeasible'` turn is a machine-distinguishable
      // terminal outcome — record the typed StepEvidence.termination block ({kind,reason}) and
      // return a distinct failure verdict. A plain stepFailed (no failureKind) stays byte-unchanged.
      if (rawPlan.failureKind === 'infeasible') {
        const reason = redactSecretValue(rawPlan.failureReason ?? '', ports.secretRedactor)
        recorder.recordTermination({ kind: 'infeasible', reason })
        // 439 D-08: the declaration's own reason (an ambiguity refusal's candidates) stays first.
        const unproven = await verifyEnding('infeasible', lastExecutedAction)
        if (typeof unproven !== 'string') return unproven
        return failure(withUnproven(`Step declared infeasible: ${reason}`, unproven))
      }
      const unproven = await verifyEnding('give-up', lastExecutedAction)
      if (typeof unproven !== 'string') return unproven
      return failure(withUnproven(`Step failed: ${reasoning}`, unproven))
    }

    // 3. EXECUTE — resolve templates only here; gate through the tool_call hook. The
    // replay gate may have already rejected the action (D-08), in which case it never
    // reaches the adapter and the failure routes into the heal / failure-context flow.
    let execResult: ActionResult
    let execError: string | undefined
    let unresolvedEnding: string | undefined
    // 436 D-07: the one pre-dispatch debit for every executed action on every decision path; a
    // gate-forced cache error never executes and is not debited. The loop top already refused an
    // exhausted meter, so this debit cannot be refused here.
    // D-04/D-05: the stated target is judged against each lane's element before the debit; a
    // clear contradiction sends nothing, substitutes nothing and is not debited.
    const targetRefusal = gateForcedError === undefined && statedTargets !== undefined
      ? judgeStatedTargets(statedTargets, normalizedAction, screenState.elements, recordMask)
      : undefined
    if (gateForcedError === undefined && targetRefusal === undefined) meter.tryDebitAction()
    // D-14: judged pre-dispatch on the settled `screenState` only (never a live probe, Pitfall 10).
    const idempotentNoop = gateForcedError === undefined && targetRefusal === undefined
      ? desiredStateSatisfied(normalizedAction, screenState)
      : undefined
    // Phase 360 dispatch verbs siblinged at the ONE chokepoint (357 D-08 law): the runner-mint
    // termination verbs (reportValue/uniqueValue), the AI judge lane (assertAI/extractAI), the
    // structured assertValue read→compare lane, and the storage-state strip/inject seam all
    // decide here — no second pre-adapter decision site. Helper logic lives in the Plan 08/09
    // compound + verifier modules; only the branch decisions live here.
    const dispatchVerb = normalizedAction.type
    // Value-bearing evidence is masked before record through recordMask (441 D-06, D-11).
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
      // D-01/D-02/D-03: a platform-less answer verb mints a success ActionResult here — never
      // adapter.execute. The answer surfaces on metadata.reportedValue and lands masked-before-
      // record in StepEvidence.reportedValue. reportValue is NON-terminal (D-02): the plan-field
      // envelope (stepComplete/stepFailed) stays the sole termination mechanism.
      const reportedValue = recordMask(String((action as { value?: unknown }).value ?? ''))
      execResult = mintReportedValue({ value: reportedValue })
      execError = undefined
      recorder.recordReportedValue({ value: reportedValue })
      stepRecord.addRead({ kind: 'reportValue', text: `"${reportedValue}"` })
    } else if (dispatchVerb === 'uniqueValue') {
      // D-16: mint prefix + injectable-generator suffix here (zero adapter.execute), then auto-write
      // the minted value into run-scoped working memory keyed by the prefix (kind extracted-value /
      // provenance toolResult). Cache replay re-enters this branch and re-mints fresh (uniqueness
      // is the semantic) — no special-casing.
      const prefix = String((action as { prefix?: unknown }).prefix ?? '')
      const minted = mintUniqueValue({ prefix }, ports.uniqueValueGenerator ?? defaultUniqueValueGenerator)
      execResult = minted
      execError = undefined
      const uv = readUniqueValueMeta(minted)
      if (uv) {
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
      // One extraction per attempt through the verifier's model lane. The typed fields are masked,
      // then written to run-scoped working memory and the read line as JSON text; an extraction the
      // model could not make ends the step unresolved and writes nothing.
      cacheBypass = true
      const av = action as { query?: unknown; scope?: unknown }
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
        const fields = redactSecretValue(extraction.fields, ports.secretRedactor)
        const entries: WorkingMemoryEntry[] = Object.entries(fields).map(([key, value]) => ({
          key,
          value: extractedText(value),
          kind: 'extracted-value',
          provenance: 'toolResult',
          stepIndex: actionIndex,
        }))
        if (entries.length > 0) ports.workingMemory?.capture(entries, { step: actionIndex })
        const values = entries.map((entry) => `${recordMask(entry.key)} = ${entry.value}`)
        stepRecord.addRead({
          kind: 'extractAI',
          text: `"${recordMask(query)}": ${values.length > 0 ? values.join(', ') : 'no fields'}`,
        })
        const degradedScope = av.scope === 'global'
        recorder.recordAiJudgment({ verb: 'extractAI', ...(degradedScope ? { degradedScope: true } : {}) })
        execResult = { success: true, metadata: { aiJudgment: { verb: 'extractAI' }, extracted: fields } }
        execError = undefined
      }
    } else if (dispatchVerb === 'assertValue' && (action as { source?: unknown }).source === 'expr-result') {
      // 439 D-14: no platform reads a value for expr-result, so it is refused before dispatch.
      const unreadable = 'assertValue {source:"expr-result"} reads no value on any platform; assert on url, storage or network, or evaluate an expr.'
      execResult = { success: false, error: unreadable }
      execError = unreadable
    } else if (dispatchVerb === 'assertValue') {
      // D-10 "adapter reads, runner judges": dispatch the source read to the adapter ONCE (it
      // returns the raw source value in data, or a §7.1 source-unavailable error), then apply the
      // pure comparator and mint the outcome. A failing comparison is an honest §7.1 failure the
      // planner mediates; a passing one is a read the verifier may cite (439 D-12).
      // 2026-10-13 (441-09, D-06): judged on the raw read, recorded through the declared mask.
      const read = await executeResolvedAction(normalizedAction, { keepRawData: true })
      if (!read.result.success) {
        execResult = read.result
        execError = read.error
      } else {
        const av = action as { source?: unknown; expr?: unknown; op?: unknown; expected?: unknown }
        const source = typeof av.source === 'string' ? av.source : (av.expr !== undefined ? 'expr-result' : 'unknown')
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
      // D-14 secret-template idiom (Pitfall 2): the RECORDED and EXECUTED objects DIFFER. save →
      // the adapter returns the raw blob; strip it from the recorded result and hand it to the
      // storageState port, recording only { name, fingerprint }. restore → load the blob from the
      // port and inject it into the EXECUTED action only; the recorded action carries just the name.
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
      // D-14 pre-dispatch idempotency short-circuit at the ONE chokepoint before adapter.execute,
      // judged on the settled `screenState` only (Pitfall 10; no live probe). The skipped tap
      // delivers no input, so it is recorded with success false and no error, and it is still the
      // action the meter already counted (437 D-05); the step stays on the success path and its
      // outcome rests on the verifier. Positive-evidence only: a missing state never suppresses.
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

    // 3b. D-10 RE-GROUND-FIRST HEAL (LOOP-04, Pitfall 7). On a CONSERVATIVELY-classified
    // ref-resolution failure, the replay gate's ref_not_in_snapshot, or the adapter's typed
    // binding-lost / binding-changed (D-07, D-08), re-observe and re-find EVERY ref lane of the
    // action by its observed role, exact name and row words (strictMatch), then re-execute with
    // every lane patched — NO planning turn, and no pre-observe ref is ever re-sent (CR-01).
    // stale-observation and frame-detached never heal (D-09). Exactly ONE heal per planned action
    // (a per-iteration one-shot, never a counter — LOOP-02), bounded by the action limit and
    // stepTimeout. Every re-found lane is judged against its stated target first (D-04): a
    // contradiction on any lane is refused on path 'heal', not sent and not debited. When any lane
    // has no single provably-same element, nothing is sent and the failure branch hands the
    // planner the outcome. The heal trail is recorded in the sub-action's grounding block only;
    // StepEvidence.selfHeal stays reserved for replan-based heals (D-11). A heal that re-dispatches
    // sends refs taken from its fresh observation, so the dispatched action is recorded in
    // healedDispatch against that observation, re-stamped with the planner call's capture stamp
    // (CR-03), while plannedAction/stateBefore keep the planner's own pair (444.1 D-14). The
    // verifier and cautions read the dispatched pair. The cache write keeps the unpatched action
    // and the pre-heal elements.
    // 436 D-07: the heal re-execution is a counted action; at the limit it is skipped and the
    // next loop top stops the step.
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
        freshState = await withAbort(ports.adapter.observe({ extractDom: true }), ports.abortSignal)
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

    // 436 D-21/D-22: download and clipboard evidence ride the action that produced them. The adapter's metadata key is
    // removed from the recorded and emitted result, so only the typed, masked evidence persists
    // (D-16), and the planner's history carries it as app-observed data. 437 D-05: the input
    // evidence is derived from the result's metadata, which keeps its own keys.
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

    // CR-02: the replay cursor and successful-check fold advance only after dispatch (and any
    // conservative re-ground heal) has succeeded. A verifier rejection does not undo a real
    // adapter success; it merely hands the exhausted/in-progress sequence to the next loop turn.
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

    // setVariable + stepComplete short-circuits verification (Pitfall 8, loop.ts:399).
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
      pendingSelfHeal = undefined
      // setVariable is inherently non-cacheable — no cache write here (Pitfall 6).
      return success()
    }

    // D-19 (Phase 360): the legacy non-visual-`assert` short-circuit was deleted here. Its
    // assertValue successor went too (439 D-12); a passing read is now verifier evidence.

    const annotation = buildAnnotation(action, execResult, viewport, !!execError)

    // Best-effort "after" screenshot for artifacts.
    if (ports.adapter.screenshot) {
      try { await withAbort(ports.adapter.screenshot(), ports.abortSignal) } catch { /* best-effort */ }
    }
    const abortAfterPostShot = checkAbort()
    if (abortAfterPostShot) return abortAfterPostShot

    // 4. EXECUTION FAILURE → self-heal = replan-with-failure-context (D-12). No counter
    // (D-10). The failed sub-action's stateAfter lands on the next observation (D-15c).
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

      // A failed replay of a cached plan invalidates that key and re-plans (D-13).
      if (cached && cacheKey && ports.cache) {
        await ports.cache.invalidate(cacheKey)
      }

      // Failure context injected for the next planning turn (the surviving mitigation).
      context.failureContext = `Sub-action ${actionIndex + 1} failed: ${execError}\n` +
        (healUnproven !== undefined ? `${unprovenHealNote(healUnproven)}\n` : '') +
        `Failed action: ${JSON.stringify(action)}\n` +
        `Adapt your approach — try a different element or strategy.`

      pendingSelfHeal = {
        index: failedIdx,
        failed: { plan: reasoning, plannedAction: recordedPair.plannedAction, result: toRecordedActionResult(toSchemaResult(execResult, annotation)) },
      }
      // D-13: a grounding miss is a failed action in substance. It reaches this same branch after
      // the conservative re-ground-first heal has exhausted, so all execution-failure shapes stage
      // exactly one caution lookup for the next replan turn.
      stageFailureCautions(action, actedState)
      continue
    }

    // Execution succeeded — clear failure context.
    context.failureContext = undefined

    // 5. VERIFY — only when the planner signals stepComplete (three-outcome strategy).
    let verifierReasoning: string | undefined
    if (rawPlan.stepComplete && ports.verifier) {
      // 2026-10-11 (439-04): the assertValue short-circuit is gone (D-12). Every completion claim,
      // including one after a passing assertValue, is judged by the verifier; the read sits in
      // the step record as citable evidence for its own condition. The AI judge lanes were
      // already judged here (quick 261004-lsa). 'verifier-model' is recorded only with the final
      // verdict. A FAILING assertValue or a false assertAI never reaches here — each set
      // execError above.
      // D-15b: the verifier's own re-observation IS stateAfter. (The retired-`assert`
      // afterState reuse special-case was deleted with the verb — D-19, Phase 360.)
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

      // 439 D-03: the verifier judges the whole step, from its settled start to its final screen.
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
      // 439 D-07/D-10: the runner computes the pass from the cited per-condition verdicts.
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
        pendingSelfHeal = undefined
        await cacheCompletingPlan()
        // F-381-51-1 · D-09: the verifier ACCEPTED a successful replayed step — re-arm the
        // cross-step carry when body steps remain (the only write site; take-then-rearm).
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

      // Verifier says not done — planner was wrong about stepComplete. Treat as a
      // self-heal boundary: replan with the verifier's reasoning as failure context
      // (D-12), and let the next observation land as this sub-action's stateAfter (D-15c).
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
      pendingSelfHeal = {
        index: failedIdx,
        failed: { plan: reasoning, plannedAction: recordedPair.plannedAction, result: toRecordedActionResult(toSchemaResult(execResult, annotation)) },
      }
      stageFailureCautions(action, afterState)
      // Non-completing decision — not cached (only the step-completing plan is persisted).
      continue
    }

    // No verifier but the planner claims completion — trust the planner. A test seam only: every
    // production door binds a verifier, which C439-CENSUS proves (439 D-12).
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
      pendingSelfHeal = undefined
      void idx
      await cacheCompletingPlan()
      // F-381-51-1 · D-09: verifier-less harness state — the trusted completion accepts
      // the replayed step, so the cross-step carry re-arms when body steps remain.
      if (procedureReplayed) rearmProcedureFlowCarry()
      return success()
    }

    // Sub-action succeeded but the goal is not yet met — record and continue (no
    // stateAfter: this is not a D-15 boundary).
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
    pendingSelfHeal = undefined
    context.subActionHistory!.push({
      action: JSON.stringify(action),
      reasoning,
      result: historyResult,
      verifierRejection: rawPlan.stepComplete ? verifierReasoning : undefined,
      data: guardActionData(execResult.data, ports.guardBlob),
      ...historyEvidence,
    })
    // Non-completing decision — not cached (only the step-completing plan is persisted).
  }
}

// ---- helpers -----------------------------------------------------------------

// Env-set provenance (D-07, set path). Pre-plan, the live resolver isn't available (its
// onSetVariable callback fires only at execute time), so an explicit set/store/save verb
// paired with an env-shaped token (UPPER_SNAKE identifier) is the provenance signal. The
// read path (secret templates / [secret:*] marker) is classified inside classifyStep.
// Phase 362 replaces this with the live resolver-reported provenance.
const ENV_SET_VERB = /\b(set|store|save|remember)\b/i
const ENV_NAME_TOKEN = /\b[A-Z][A-Z0-9_]+\b/g

function deriveEnvSetNames(stepText: string): string[] {
  if (!ENV_SET_VERB.test(stepText)) return []
  return stepText.match(ENV_NAME_TOKEN) ?? []
}

// Replayability is judged by the ONE schema-shared list (`isReplayableActionShape` —
// NON_REPLAYABLE_ACTION_TYPES + COORDINATE_ACTION_KEYS). The former loop-local
// COORDINATE_KEYS/COORDINATE_ACTION_TYPES copies were retired for the shared import
// (381 Pitfall 6: cache write guard, extraction disposition, and procedure replay must
// never fork the list). Behavior-compatible on the cache path: the extra non-replayable
// types (setVariable/assertAI/extractAI) are never persisted by cacheCompletingPlan.

// The ordered ref-field lanes replay must re-resolve for an action (Pitfall 5a): a drag
// maps its two per-field locators onto fromRef/toRef; every other element action maps its
// single locator onto ref. A locator-less action (navigate/waitFor/…) has no lane, but an
// action type that must name an element always has its ref lane (438-09).
function replayLanes(action: Record<string, unknown>, locatorCount: number): string[] {
  if (action.type === 'drag') return ['fromRef', 'toRef']
  return locatorCount >= 1 || requiresElementRef(String(action.type ?? '')) ? ['ref'] : []
}

type CacheReplay = { ok: true; plan: ActionPlan } | { ok: false; reason: CacheMissReason }

// Replay rung of the hit ladder (D-13): reconstruct an ActionPlan from a descriptor-only
// cached value by re-finding EVERY stored per-field locator in the FRESH observation
// (Pitfall 5 — multi-ref drags re-resolve both fromRef and toRef). A locator resolves only
// through strictMatch: role, exact name and stated row words, one survivor (D-10). The action
// shape or a missing lane locator is 'non-replayable'; the first lane with no survivor or with
// several names the strict reason. Either way nothing replays (T-356-04a / T-438-15).
function replayFromCache(value: CachedPlanValue, elements: readonly ElementInfo[]): CacheReplay {
  const action = value.plannedActions[0]
  if (!action) return { ok: false, reason: 'non-replayable' }
  const replayAction: Record<string, unknown> = { ...action }

  // Non-replayable action shapes (coordinate-bearing / excluded types, the schema-shared
  // list) ⇒ invalidate ⇒ replan (Pitfall 5b).
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
      stepComplete: value.verificationOutcome === 'passed',
    },
  }
}

// ---- PROC-02 guarded procedure replay helpers (381 D-09..D-12) -----------------

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
    }

// 2026-10-09 (438-10): no stored or derived position reaches the recovery context (D-12).
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
 * Re-find one committed procedure target strictly (438 D-11): the one element with its role,
 * exact name and stored row words. A target without a stored name (a body committed before
 * 438) cannot be judged and is 'descriptor-missing'; no ordinal is read and nothing is picked.
 */
function strictProcedureTarget(
  target: ProcedureGuardTarget,
  elements: readonly ElementInfo[],
):
  | { ok: true; ref: Ref }
  | { ok: false; reason: 'descriptor-missing' | 'descriptor-ambiguous' } {
  if (target.name === undefined) return { ok: false, reason: 'descriptor-missing' }
  const match = strictMatch({ role: target.role, name: target.name, row: target.row }, elements)
  if (match.kind === 'resolved') return { ok: true, ref: match.ref }
  return {
    ok: false,
    reason: match.kind === 'not-unique' ? 'descriptor-ambiguous' : 'descriptor-missing',
  }
}

/**
 * The D-10 full guard for ONE committed procedure action, in order: (0) defense-in-depth
 * replayability shape check against the schema-shared list (Pitfall 6); (1) unique
 * fresh-screen re-find of EVERY stored action target and the declared guard target through
 * strictMatch (role, exact name, stored row words; 438 D-11) — not-unique and absent are
 * distinct miss reasons, never a pick (T-357-03a); (2) live-vs-stored page anchor equality through
 * `normalizeAnchor` (D-10);
 * (3) loop-side value binding by NAME (values never crossed the reader port, T-381-21);
 * (4) the grounding gate exactly as the cached branch runs it, yielding the §A8 attempt
 * trail on the returned plan (`groundingAttempts`). Persisted bodies are untrusted runtime
 * inputs: commit accepts structurally valid guard-only target variants, so authoring
 * co-derivation is never a runtime invariant (D-10; PROC-02/SC2). A stored descriptor never
 * drives a blind action: every leg must pass before the action may execute.
 */
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
      return { ok: false, reason: match.reason, location: { kind: 'action-target', lane } }
    }
    action[lane] = match.ref
  }

  const guardMatch = strictProcedureTarget(input.step.guard.target, input.screenState.elements)
  if (!guardMatch.ok) {
    return { ok: false, reason: guardMatch.reason, location: { kind: 'guard-target' } }
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

/**
 * Render the compact procedure hint block (T-381-20/T-381-21): flow name, confidence tier,
 * the parsed body's instruction outline, and parameter NAMES/types — never values, never
 * raw step actions as commands. This is the ordinary hint/body-read/execution/verifier
 * renderer; guard misses use the closed structural recovery renderer above. Masked through
 * the declared-secret mask, then DATA-wrapped via the safety package's delimiters so the
 * whole span reads as untrusted app-observed data under the hypotheses frame.
 */
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

/**
 * D-14 precise-first failure anchors. Element identity comes from the failed action's resolved
 * ref and the matching live ElementInfo, then page and flow broaden the recall seed. Every lane
 * goes through schema's shared normalizeAnchor authority; this module owns no normalization copy.
 */
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

// D-05: the first lane whose stated target clearly contradicts the element its ref names. Both
// identities are scrubbed (declared-secret redaction) before they reach the block or message.
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

// D-04/D-05: one lane's stated target judged against `element` in `elements`; a refusal on a
// contradiction, else undefined. `path` says whether the element is the live ref's or the heal's.
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

// Build the §A8 grounding block for a grounded sub-action (GROUND-02). Present ONLY when the
// action carries an element field. Pitfall 9, D-02: the descriptor names the grounded element by
// its exact name, never by position, and the first lane's stated target is recorded beside it.
// Every identity is scrubbed BEFORE it lands in evidence (T-357-02a, D-05). Attempts come from
// the turn gate / heal when supplied, else a synthesized ref-resolved trail for the committed ref.
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

// D-08 re-find (LOOP-04, CR-01). EVERY ref lane of the failed action is re-found in the FRESH
// observation, each only when exactly one element there has its observed role, exact name and row
// words (strictMatch): no ordinal, no hierarchy tiebreak, no looser rung. One unproven lane, or two
// lanes with different prior refs collapsing onto one fresh element, makes the whole heal unproven,
// so no pre-observe ref is ever dispatched against the fresh observation. Resolved carries every
// lane's fresh ref and element and the §A8 trail (per lane: ref no-match → tree-search resolved),
// its descriptor naming the first lane, scrubbed like the live block and its row capped like the
// refusal block's (WR-01, D-05); null means a lane names no element of the prior observation.
// Never replans.
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

// Object reads (storage map, network log array) stringify as JSON so `contains` has something honest
// to match. 439 D-14: a network read is judged per entry, and an empty log is unread.
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

// 439 D-17: this step's completed downloads, then the carried ones, most recent first.
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

// 439 D-04: only a completed download is evidence it happened; the clipboard keeps the latest write.
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

// 437 D-06/D-17/D-18: verdicts and outcomes only, never typed or read-back text. inputSent is false
// only on positive evidence that nothing was delivered: a refusal or an unavailable mechanism.
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

// 436 D-21: masked first, so a secret is never cut into an unmaskable fragment, then bounded.
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
  pending: { index: number; failed: Decision } | undefined,
  reasoning: string,
  plannedAction: SchemaAction,
  execResult: ActionResult,
  annotation: ActionAnnotation | undefined,
): void {
  if (!pending) return
  const recovering: Decision = {
    plan: reasoning,
    plannedAction,
    result: toRecordedActionResult(toSchemaResult(execResult, annotation)),
  }
  recorder.recordSelfHeal(pending.failed, recovering)
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
