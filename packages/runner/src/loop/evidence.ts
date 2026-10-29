// Evidence is built as schema DTOs while the loop runs; the legacy trace is projected from it.
import {
  computeBriefDigest,
  EvidenceArtifactRefSchema,
  NO_KNOWLEDGE_READER_TRUNCATION,
  readIdempotentNoopMeta,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  SERVED_BRIEF_PROOF_SCHEMA_VERSION,
  toRecordedActionResult,
  TRACE_TRUNCATION_TOP_K,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  Action,
  ActionAnnotation,
  AriaEvidenceEntry,
  CacheMissReason,
  ActionResult as SchemaActionResult,
  AiJudgmentEvidence,
  AssertValueEvidence,
  BoundingBox,
  BriefBlock,
  CautionLine,
  ConditionVerdictsEvidence,
  Decision,
  DeclaredModelProfile,
  InterpolatedVariable,
  LimitStopEvidence,
  LosslessServedBriefProofV1,
  ModelIdentity,
  ModelCallRecord,
  OperationCaptureAvailability,
  PlanningFailureEvidence,
  Point,
  RecordedActionResult,
  RecordedRetrievalRung,
  ReportedValueEvidence,
  ReadTrace,
  ScopeKey,
  ScreenState,
  ServedAdmissionEvent,
  ServedBrief,
  ServedPromptTurn,
  ServedRetrievalTraceV1,
  StepEvidence,
  StepLimitUsage,
  StepPlanSource,
  SubActionEvidence,
  TerminationEvidence,
  ToolExchangeEvidence,
  TraceLine,
  VerdictSource,
  VerifierVerdict,
  Viewport,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'
import type { Action as PlatformAction, ActionResult as PlatformActionResult } from '../platform.js'
import type { StepAnnotation, SubActionTrace } from '../result.js'
import type { EvidenceArtifactStorePort, SecretRedactorPort } from './ports.js'
import { redactSecretValue } from './secrets.js'

// Persist the captured before tree with the member's declared mask; handoff states stay raw.
export function persistAriaEvidence(
  evidence: SubActionEvidence,
  secretRedactor: SecretRedactorPort | undefined,
  store: EvidenceArtifactStorePort | undefined,
): AriaEvidenceEntry {
  if (evidence.stateBefore.tree.length === 0) {
    return { kind: 'aria', state: 'absent', reason: 'empty' }
  }
  try {
    if (!secretRedactor || !store?.persistEvidenceDocument) {
      return { kind: 'aria', state: 'absent', reason: 'failed' }
    }
    const ref = EvidenceArtifactRefSchema.parse(store.persistEvidenceDocument({
      schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      kind: 'aria',
      tree: redactSecretValue(evidence.stateBefore.tree, secretRedactor),
    }))
    if (!ref.id.startsWith('aria-state:')) {
      return { kind: 'aria', state: 'absent', reason: 'failed' }
    }
    return { kind: 'aria', state: 'present', ref }
  } catch {
    // An evidence failure cannot suppress the recorded action or its decision screenshot.
    return { kind: 'aria', state: 'absent', reason: 'failed' }
  }
}

// The typed empty brief served when no KnowledgeHintReader is bound; never an unsafe cast.

export function makeEmptyServedBrief(scope: ScopeKey, asOfBuild: number): ServedBrief {
  const brief: ServedBrief = {
    scope,
    asOfBuild,
    budget: 0,
    truncation: NO_KNOWLEDGE_READER_TRUNCATION,
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  // computeBriefDigest canonicalizes every field EXCEPT briefDigest, so digesting the
  // brief with an empty digest field yields the stable content digest.
  return { ...brief, briefDigest: computeBriefDigest(brief) }
}

function makeChannel1ServedBrief(input: {
  scope: ScopeKey
  asOfBuild: number
  budget: number
  block: BriefBlock
}): ServedBrief {
  const served: ServedBrief = {
    scope: input.scope,
    asOfBuild: input.asOfBuild,
    budget: input.budget,
    truncation: input.block.truncation,
    channel1: [...input.block.lines],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...served, briefDigest: computeBriefDigest(served) }
}

// ---------------------------------------------------------------------------
// foldCacheStatus — per-step fold of the per-sub-action `cached` flags: all hit ⇒ 'hit',
// otherwise 'miss'. `finalize` decides 'disabled' and 'bypass' before this fold.
// ---------------------------------------------------------------------------

export function foldCacheStatus(subActionCacheFlags: boolean[]): StepEvidence['cacheStatus'] {
  // A step with no sub-actions replayed nothing from the cache, so it is a miss.
  return subActionCacheFlags.length > 0 && subActionCacheFlags.every(flag => flag) ? 'hit' : 'miss'
}

// Maps the adapter's legacy coordinate fields onto the schema ActionAnnotation union.

function clampPointToViewport(point: Point, viewport: Viewport): Point {
  return {
    x: Math.max(0, Math.min(point.x, viewport.width)),
    y: Math.max(0, Math.min(point.y, viewport.height)),
  }
}

function scrollDirection(action: PlatformAction): 'up' | 'down' | 'left' | 'right' | undefined {
  if (action.type !== 'scroll') return undefined
  // Scroll carries an explicit direction in both modes, so there is no pixel sign to decode.
  const a = action as Extract<PlatformAction, { type: 'scroll' }>
  return a.direction
}

export function collapseAnnotation(
  action: PlatformAction,
  execResult: PlatformActionResult,
  viewport: Viewport,
): ActionAnnotation {
  const direction = action.type === 'swipe'
    ? (action.mode === 'direction' ? action.direction : undefined)
    : scrollDirection(action)

  const base = { viewport, ...(direction ? { direction } : {}) }

  // path — swipe/drag map to a start→end segment (execResult coords first, then the
  // action's own path points as the fallback — schema SwipeByPath `from`/`to`).
  if (action.type === 'swipe' || action.type === 'drag') {
    const start = execResult.startCoordinates
      ?? (action.type === 'swipe' && action.mode === 'path' ? action.from : undefined)
    const end = execResult.endCoordinates
      ?? (action.type === 'swipe' && action.mode === 'path' ? action.to : undefined)
    return {
      ...base,
      kind: 'path',
      path: { start: start ?? { x: 0, y: 0 }, end: end ?? { x: 0, y: 0 } },
    }
  }

  // pinch — center + scale (schema: coordinate form carries x/y; ref form has no center).
  if (action.type === 'pinch') {
    const a = action as Extract<PlatformAction, { type: 'pinch' }>
    const center = execResult.coordinates
      ?? ('x' in a && 'y' in a ? { x: a.x, y: a.y } : { x: 0, y: 0 })
    return { ...base, kind: 'pinch', pinch: { center, scale: a.scale } }
  }

  // scroll with a container bounding box → region (clamped into the viewport, v1 rule).
  if (action.type === 'scroll' && execResult.boundingBox) {
    return { ...base, kind: 'region', region: { boundingBox: clampToViewport(execResult.boundingBox, viewport) } }
  }

  // point — the default (click/fill/tap/hover/navigate/…): a single click point plus an
  // optional bounding box carried alongside.
  const rawPoint = execResult.coordinates ?? { x: 0, y: 0 }
  const point = action.type === 'scroll' ? clampPointToViewport(rawPoint, viewport) : rawPoint
  const boundingBox = execResult.boundingBox
  return {
    ...base,
    kind: 'point',
    point: boundingBox ? { ...point, boundingBox } : point,
  }
}

function clampToViewport(box: BoundingBox, viewport: Viewport): BoundingBox {
  let { x, y, width, height } = box
  if (y < 0) { height += y; y = 0 }
  if (x < 0) { width += x; x = 0 }
  if (x + width > viewport.width) width = viewport.width - x
  if (y + height > viewport.height) height = viewport.height - y
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

// ---------------------------------------------------------------------------
// EvidenceRecorder — the accumulator the loop drives. Its recording types ARE the
// schema §A8 DTOs; there is no intermediate v1 shape.
// ---------------------------------------------------------------------------

export interface RecordSubActionInput {
  /** The planner's reasoning/plan string for this sub-action. */
  plan: string
  plannedAction: Action
  // The full observed ScreenState, with elements and refMap, not only the tree string.
  stateBefore: ScreenState
  stateAfter?: ScreenState
  // Screenshot bytes may be present here; `toRecordedActionResult` strips them before storage.
  result: SchemaActionResult
  /** v1 per-sub-action cache flag; folded per step by foldCacheStatus at finalize. */
  cached?: boolean
  // The loop redacts the descriptor before passing it here, so no raw descriptor reaches evidence.
  grounding?: SubActionEvidence['grounding']
  // Identity of the final image bytes the planner saw; absent when not captured, never fabricated.
  decisionScreenshotRef?: SubActionEvidence['decisionScreenshotRef']
  /**
   * Auxiliary §A8 ArtifactRefs already reserved by the schema DTO. Copied verbatim (order and
   * identity preserved) so the recorder never drops artifact references present on the input.
   */
  artifactRefs?: SubActionEvidence['artifactRefs']
  // The loop masks every string leaf first; present for live turns, absent for cache replay.
  exchanges?: ToolExchangeEvidence[]
  // Absent when no live call record is available.
  callRecord?: ModelCallRecord
  // What the action produced outside the page, already masked by the loop.
  operationEvidence?: SubActionEvidence['operationEvidence']
  healedDispatch?: SubActionEvidence['healedDispatch']
}

export class EvidenceRecorder {
  private readonly subActions: SubActionEvidence[] = []
  private readonly cacheFlags: boolean[] = []
  private servedBrief: ServedBrief
  // Kept out of `servedBrief`, whose bytes feed its digest; Channel 1 replaces, Channel 3 appends.
  private channel1Trace?: ServedRetrievalTraceV1
  private readonly channel3TraceLines: TraceLine[] = []
  private readonly channel3Truncated: TraceLine[] = []
  private selfHeal?: StepEvidence['selfHeal']
  private workingMemory?: WorkingMemoryEntry[]
  private planningFailure?: PlanningFailureEvidence
  private reportedValue?: ReportedValueEvidence
  private termination?: TerminationEvidence
  private limitStop?: LimitStopEvidence
  private conditionVerdicts?: ConditionVerdictsEvidence
  private limitUsage?: StepLimitUsage
  private operationCapture?: OperationCaptureAvailability
  private aiJudgment?: AiJudgmentEvidence
  private assertOutcome?: AssertValueEvidence
  private verdictSource?: VerdictSource
  private planSource?: StepPlanSource
  private cacheMiss?: { reason: CacheMissReason }
  // Run-declared planner context, copied onto every finalized step when bound.
  private readonly modelProfile?: DeclaredModelProfile
  // Verifier identity, copied beside every finalized verdict when bound.
  private readonly verifierIdentity?: ModelIdentity
  // Once-per-member bound-surface digest, copied onto every finalized step.
  private readonly toolSchemaDigest?: string
  // Kept out of `servedBrief`, whose bytes key cassettes; the recorder never resolves it.
  private readonly retrievalRung?: RecordedRetrievalRung
  // Every `recordSubAction` append emits through this one seam; unbound, the recorder never throws.
  private readonly onSubActionRecorded?: (evidence: SubActionEvidence, index: number) => void

  constructor(options?: {
    servedBrief?: ServedBrief
    scope?: ScopeKey
    asOfBuild?: number
    onSubActionRecorded?: (evidence: SubActionEvidence, index: number) => void
    modelProfile?: DeclaredModelProfile
    verifierIdentity?: ModelIdentity
    toolSchemaDigest?: string
    retrievalRung?: RecordedRetrievalRung
  }) {
    this.servedBrief = options?.servedBrief
      ?? makeEmptyServedBrief(options?.scope ?? { tier: 'test', key: '' }, options?.asOfBuild ?? 0)
    this.onSubActionRecorded = options?.onSubActionRecorded
    this.modelProfile = options?.modelProfile
    this.verifierIdentity = options?.verifierIdentity
    this.toolSchemaDigest = options?.toolSchemaDigest
    this.retrievalRung = options?.retrievalRung
  }

  private replaceServedBrief(next: ServedBrief): void {
    const unsigned: ServedBrief = { ...next, briefDigest: '' }
    this.servedBrief = {
      ...unsigned,
      briefDigest: computeBriefDigest(unsigned),
    }
  }

  private losslessProof(): LosslessServedBriefProofV1 {
    const proof = this.servedBrief.proof
    if (proof === undefined) {
      throw new Error('lossless served brief proof has not been initialized')
    }
    return proof
  }

  /**
   * Upgrade this production recorder from the proof-less historical shape to a live lossless
   * proof. The model-visible channel bytes stay unchanged; only the actual serving caps and
   * empty chronological journals are introduced.
   */
  beginLosslessServedBrief(input: {
    recordCap: number
    combinedBudget: number
  }): void {
    this.replaceServedBrief({
      ...this.servedBrief,
      proof: {
        schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
        completeness: 'lossless',
        recordCap: input.recordCap,
        combinedBudget: input.combinedBudget,
        admissionEvents: [],
        promptTurns: [],
      },
      briefDigest: '',
    })
  }

  /**
   * Append observations drained from the production admission authority. Ordinals must remain
   * contiguous across batches; validation occurs before mutation so a bad batch appends nothing.
   */
  recordServedAdmissionEvents(events: readonly ServedAdmissionEvent[]): void {
    if (events.length === 0) return
    const proof = this.losslessProof()
    const firstOrdinal = proof.admissionEvents.length
    let previousTurn = proof.admissionEvents.at(-1)?.turnOrdinal
    for (const [index, event] of events.entries()) {
      if (event.ordinal !== firstOrdinal + index) {
        throw new Error('served admission event ordinal must be contiguous')
      }
      if (previousTurn !== undefined && event.turnOrdinal < previousTurn) {
        throw new Error('served admission event turn ordinal must be nondecreasing')
      }
      previousTurn = event.turnOrdinal
    }
    this.replaceServedBrief({
      ...this.servedBrief,
      proof: {
        ...proof,
        admissionEvents: [
          ...proof.admissionEvents,
          ...events.map(event => ({ ...event })),
        ],
      },
      briefDigest: '',
    })
  }

  /** Append one exact production prompt snapshot and re-address the complete served proof. */
  recordServedPromptTurn(turn: ServedPromptTurn): void {
    const proof = this.losslessProof()
    if (turn.ordinal !== proof.promptTurns.length) {
      throw new Error('served prompt turn ordinal must be contiguous')
    }
    const previousTurn = proof.promptTurns.at(-1)?.turnOrdinal
    if (previousTurn !== undefined && turn.turnOrdinal < previousTurn) {
      throw new Error('served prompt turn ordinal must be nondecreasing')
    }
    this.replaceServedBrief({
      ...this.servedBrief,
      proof: {
        ...proof,
        promptTurns: [...proof.promptTurns, { ...turn }],
      },
      briefDigest: '',
    })
  }

  /** The number of sub-actions recorded so far; the next recordSubAction returns this index. */
  get subActionCount(): number {
    return this.subActions.length
  }

  /** Append a §A8 SubActionEvidence. Returns its index (for attachStateAfter). */
  recordSubAction(input: RecordSubActionInput): number {
    const result: RecordedActionResult = toRecordedActionResult(input.result)
    const evidence: SubActionEvidence = {
      plan: input.plan,
      plannedAction: input.plannedAction,
      stateBefore: input.stateBefore,
      result,
    }
    if (input.stateAfter) evidence.stateAfter = input.stateAfter
    if (input.exchanges !== undefined) evidence.exchanges = input.exchanges
    if (input.callRecord !== undefined) evidence.callRecord = input.callRecord
    if (input.grounding) evidence.grounding = input.grounding
    if (input.decisionScreenshotRef) evidence.decisionScreenshotRef = input.decisionScreenshotRef
    if (input.artifactRefs) evidence.artifactRefs = [...input.artifactRefs]
    if (input.operationEvidence) evidence.operationEvidence = input.operationEvidence
    if (input.healedDispatch) evidence.healedDispatch = input.healedDispatch
    this.subActions.push(evidence)
    this.cacheFlags.push(input.cached ?? false)
    const index = this.subActions.length - 1
    // Fires after the append, so the evidence and its index leave the loop as they occur.
    this.onSubActionRecorded?.(evidence, index)
    return index
  }

  // Values arrive masked by the loop, and sit beside the brief, never inside `servedBrief`.
  recordWorkingMemory(entries: WorkingMemoryEntry[]): void {
    this.workingMemory = entries
  }

  /**
   * Record the real deterministic Channel-1 brief served to this step. The recording type is the
   * schema-owned ServedBrief; the digest is always recomputed over the populated channels.
   * makeEmptyServedBrief remains exclusively the no-reader constructor fallback.
   */
  recordServedBrief(input: {
    scope: ScopeKey
    asOfBuild: number
    budget: number
    block: BriefBlock
    // A required parameter, so dropping the trace is a compile error, not a trace-less run.
    trace: ServedRetrievalTraceV1
  }): void {
    this.channel1Trace = input.trace
    const channel1 = makeChannel1ServedBrief(input)
    const served: ServedBrief = {
      ...channel1,
      // A step may replan more than once. Re-reading the frozen Channel-1 block must not erase
      // direct-read or failure-caution evidence already served by an earlier turn in this step.
      channel2: [...this.servedBrief.channel2],
      channel3: [...this.servedBrief.channel3],
      ...(this.servedBrief.proof === undefined
        ? {}
        : { proof: this.servedBrief.proof }),
      briefDigest: '',
    }
    this.replaceServedBrief(served)
  }

  // The ledger accumulates even on zero-injection turns; the empty return only skips a rehash.
  recordServedCautions(
    cautions: readonly CautionLine[],
    trace: ServedRetrievalTraceV1,
  ): void {
    // Keep only the attributions for cautions that were actually injected. The reader ranked and
    // budgeted a wider set; the loop's own record ledger then refused some of them, and a trace
    // claiming a refused caution was served would be false testimony about this turn. The
    // reader's own cut candidates ride along unchanged — they answer "why didn't it mention X".
    // With `cautions` empty the injected set is empty, so EVERY served line the reader handed
    // over is a cut candidate — the same rule, not a special case for the all-refused turn.
    const injectedIds = new Set(cautions.map(({ id }) => String(id)))
    this.channel3TraceLines.push(
      ...trace.servedLines.filter(({ recordId }) => injectedIds.has(recordId)),
    )
    this.channel3Truncated.push(
      ...trace.servedLines.filter(({ recordId }) => !injectedIds.has(recordId)),
      ...trace.truncated,
    )
    if (cautions.length === 0) return
    const served: ServedBrief = {
      ...this.servedBrief,
      channel3: [...this.servedBrief.channel3, ...cautions],
      briefDigest: '',
    }
    this.replaceServedBrief(served)
  }

  /** Append successful Channel-2 direct reads and re-address the complete served brief. */
  recordServedReadTraces(traces: readonly ReadTrace[]): void {
    if (traces.length === 0) return
    const served: ServedBrief = {
      ...this.servedBrief,
      channel2: [...this.servedBrief.channel2, ...traces],
      briefDigest: '',
    }
    this.replaceServedBrief(served)
  }

  // Exchanges and message arrive masked by the loop; the recorder stays mask-agnostic.
  recordPlanningFailure(evidence: PlanningFailureEvidence): void {
    this.planningFailure = evidence
  }

  // Callers mask every value-bearing field with `recordMask` before handing the DTO here.

  // `value` arrives masked; reportValue is non-terminal, so this only records.
  recordReportedValue(evidence: ReportedValueEvidence): void {
    this.reportedValue = evidence
  }

  // Present only when a turn declared the step infeasible, unlike a plain `stepFailed`.
  recordTermination(evidence: TerminationEvidence): void {
    this.termination = evidence
  }

  // Text fields arrive masked; never a planning failure, a termination or a verdict source.
  recordLimitStop(evidence: LimitStopEvidence): void {
    this.limitStop = evidence
  }

  // Fields arrive masked and bounded; a later judgment of the step replaces an earlier one.
  recordConditionVerdicts(evidence: ConditionVerdictsEvidence): void {
    this.conditionVerdicts = evidence
  }

  /** Record whether the step's platform could capture each operation. */
  recordOperationCapture(availability: OperationCaptureAvailability): void {
    this.operationCapture = availability
  }

  /** Record the step's configured limits and usage; finish() calls it on every path. */
  recordLimitUsage(usage: StepLimitUsage): void {
    this.limitUsage = usage
  }

  /**
   * Record the assertAI or extractAI judge block: the verdict and masked rationale, or why the
   * model could not judge or extract. One per attempt.
   */
  recordAiJudgment(evidence: AiJudgmentEvidence): void {
    this.aiJudgment = evidence
  }

  // `expected` and `actual` arrive masked; the verifier still judges a passing outcome.
  recordAssertOutcome(evidence: AssertValueEvidence): void {
    this.assertOutcome = evidence
  }

  // Set with the final verdict, so a verifier rejection records nothing.
  recordVerdictSource(source: VerdictSource): void {
    this.verdictSource = source
  }

  // Beside `cacheStatus`, so cached-flag consumers are never polluted; the last write wins.
  recordPlanSource(source: StepPlanSource): void {
    this.planSource = source
  }

  // The first reason in the step is kept, recorded before the loop invalidates the entry.
  recordCacheMiss(miss: { reason: CacheMissReason }): void {
    this.cacheMiss ??= { reason: miss.reason }
  }

  // Reuses an observation the loop already takes; no extra capture.
  attachStateAfter(index: number, state: ScreenState): void {
    const evidence = this.subActions[index]
    if (evidence) evidence.stateAfter = state
  }

  // The failed and the recovering decision at the replan-with-failure-context boundary.
  recordSelfHeal(failedDecision: Decision, recoveringDecision: Decision): void {
    this.selfHeal = { failedDecision, recoveringDecision }
  }

  // Copies the reader's serve-time values unchanged; absent means no reader served this step.
  private foldRetrievalTrace(): ServedRetrievalTraceV1 | undefined {
    if (this.channel1Trace === undefined && this.channel3TraceLines.length === 0) {
      return this.channel3Truncated.length === 0 ? undefined : {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [],
        truncated: this.channel3Truncated.slice(0, TRACE_TRUNCATION_TOP_K),
      }
    }
    return {
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      servedLines: [
        ...(this.channel1Trace?.servedLines ?? []),
        ...this.channel3TraceLines,
      ],
      // The pinned bound is a bound on the LEDGER, not per channel. Channel-1 cut candidates come
      // first because Channel 1 is what every planning turn actually reads, so "why didn't the
      // brief mention X" is asked about it far more often than about a failure-moment caution.
      truncated: [
        ...(this.channel1Trace?.truncated ?? []),
        ...this.channel3Truncated,
      ].slice(0, TRACE_TRUNCATION_TOP_K),
    }
  }

  /** Finalize the accumulated evidence into a §A8 StepEvidence; servedBrief is always present
   * (empty when no reader bound).
   *
   * cacheStatus is `'disabled'` when no cache was bound for the step (`options.cacheDisabled`),
   * else `'bypass'` when the loop left the cache untouched for a non-cacheable step
   * (`options.nonCacheable`), else the per-step hit/miss fold. */
  finalize(
    verdict: VerifierVerdict,
    stepIndex: number,
    stepText: string,
    options?: {
      cacheDisabled?: boolean
      nonCacheable?: boolean
      // Stamped only when non-empty, and never masked: see `StepEvidence.interpolatedVariables`.
      interpolatedVariables?: readonly InterpolatedVariable[]
    },
  ): StepEvidence {
    const evidence: StepEvidence = {
      stepIndex,
      stepText,
      cacheStatus: options?.cacheDisabled
        ? 'disabled'
        : options?.nonCacheable
          ? 'bypass'
          : foldCacheStatus(this.cacheFlags),
      servedBrief: this.servedBrief,
      subActions: this.subActions,
      verifierVerdict: verdict,
    }
    const retrievalTrace = this.foldRetrievalTrace()
    if (retrievalTrace !== undefined) evidence.retrievalTrace = retrievalTrace
    if (this.retrievalRung !== undefined) evidence.retrievalRung = this.retrievalRung
    if (this.selfHeal) evidence.selfHeal = this.selfHeal
    if (this.workingMemory) evidence.workingMemory = this.workingMemory
    if (this.planningFailure) evidence.planningFailure = this.planningFailure
    if (this.reportedValue) evidence.reportedValue = this.reportedValue
    if (this.termination) evidence.termination = this.termination
    if (this.limitStop) evidence.limitStop = this.limitStop
    if (this.conditionVerdicts) evidence.conditionVerdicts = this.conditionVerdicts
    if (this.limitUsage) evidence.limitUsage = this.limitUsage
    if (this.operationCapture) evidence.operationCapture = this.operationCapture
    if (this.aiJudgment) evidence.aiJudgment = this.aiJudgment
    if (this.assertOutcome) evidence.assertOutcome = this.assertOutcome
    if (this.verdictSource) evidence.verdictSource = this.verdictSource
    if (this.planSource) evidence.planSource = this.planSource
    if (this.cacheMiss && evidence.cacheStatus === 'miss') evidence.cacheMiss = this.cacheMiss
    if (this.modelProfile !== undefined) evidence.modelProfile = this.modelProfile
    if (this.verifierIdentity !== undefined) evidence.verifierIdentity = this.verifierIdentity
    if (this.toolSchemaDigest !== undefined) evidence.toolSchemaDigest = this.toolSchemaDigest
    if (options?.interpolatedVariables && options.interpolatedVariables.length > 0) {
      evidence.interpolatedVariables = [...options.interpolatedVariables]
    }
    return evidence
  }
}

// Projects the legacy string-state trace from the evidence; richer to poorer only.

const LEGACY_ANNOTATION_TYPES: ReadonlySet<StepAnnotation['type']> = new Set([
  'click', 'fill', 'tap', 'hover', 'scroll', 'swipe', 'pinch', 'navigate',
])

function legacyAnnotationType(actionType: string): StepAnnotation['type'] {
  return LEGACY_ANNOTATION_TYPES.has(actionType as StepAnnotation['type'])
    ? (actionType as StepAnnotation['type'])
    : 'other'
}

function toLegacyStepAnnotation(annotation: ActionAnnotation, actionType: string): StepAnnotation {
  const legacy: StepAnnotation = {
    type: legacyAnnotationType(actionType),
    viewport: annotation.viewport,
  }
  if (annotation.direction) legacy.direction = annotation.direction
  if (annotation.failureHighlight) legacy.failureHighlight = annotation.failureHighlight
  switch (annotation.kind) {
    case 'point':
      legacy.clickPoint = { x: annotation.point.x, y: annotation.point.y }
      if (annotation.point.boundingBox) legacy.boundingBox = annotation.point.boundingBox
      break
    case 'path':
      legacy.startPoint = annotation.path.start
      legacy.endPoint = annotation.path.end
      break
    case 'pinch':
      legacy.startPoint = annotation.pinch.center
      legacy.pinchScale = annotation.pinch.scale > 1 ? 'out' : 'in'
      break
    case 'region':
      legacy.boundingBox = annotation.region.boundingBox
      break
  }
  return legacy
}

export function projectLegacyTrace(evidence: StepEvidence): SubActionTrace[] {
  return evidence.subActions.map((sub, index) => {
    const noInput = readIdempotentNoopMeta(sub.result)
    const trace: SubActionTrace = {
      index,
      observation: sub.stateBefore.tree,
      reasoning: sub.plan,
      plannedAction: sub.plannedAction as PlatformAction,
      result: noInput ? 'no-input' : sub.result.success ? 'success' : 'failure',
      screenStateBefore: sub.stateBefore.tree,
      cached: false,
    }
    if (noInput) trace.noInputSent = { currentState: noInput.currentState }
    else if (sub.result.error !== undefined) trace.error = sub.result.error
    if (sub.stateAfter) trace.screenStateAfter = sub.stateAfter.tree
    if (sub.result.annotation) {
      trace.annotation = toLegacyStepAnnotation(sub.result.annotation, sub.plannedAction.type)
    }
    if (sub.result.data !== undefined) trace.data = sub.result.data
    return trace
  })
}
