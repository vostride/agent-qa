// The §A8 evidence module (D-14): the loop's internal recording types ARE the schema
// §A8 DTOs. Evidence is populated by construction as the loop runs — never projected
// after the fact from v1 SubActionTrace shapes. This module mints ZERO new schema
// types; it consumes SubActionEvidence/StepEvidence/RecordedActionResult/ServedBrief/
// toRecordedActionResult/computeBriefDigest from @vostride/agent-qa-schema.
//
// The legacy StepResult.trace is PROJECTED from the evidence at step end
// (projectLegacyTrace, Open Q5 — richer→poorer is legal; the reverse is D-14's
// forbidden direction). Reporters/dashboard/JUnit keep consuming StepResult.trace
// unchanged until 361/363.
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

/** D-02: persist the captured before tree with the member's declared mask; handoff states stay raw. */
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

// ---------------------------------------------------------------------------
// makeEmptyServedBrief — the canonical empty brief (Pitfall 4 / D-05 graceful
// degradation). StepEvidence.servedBrief is REQUIRED; when no KnowledgeHintReader is
// bound (no M2 implementation exists) the loop serves this fully-typed empty brief —
// never an unsafe cast (Pitfall 4's warning sign).
// ---------------------------------------------------------------------------

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
    // D-03: Channel 2 read traces and Channel 3 cautions are populated by 380-07/380-09.
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
  // 439 D-15: a step with no sub-actions replayed nothing from the cache, so it is a miss.
  return subActionCacheFlags.length > 0 && subActionCacheFlags.every(flag => flag) ? 'hit' : 'miss'
}

// ---------------------------------------------------------------------------
// collapseAnnotation — pure re-derivation of the v1 loop.ts StepAnnotation block,
// mapping the adapter's runner-legacy result shape (coordinates / boundingBox /
// startCoordinates / endCoordinates) onto the single schema ActionAnnotation union.
// Feeds result.annotation on evidence; projectLegacyTrace derives the legacy dashboard
// StepAnnotation from it (reporters consume that until 361/363).
// ---------------------------------------------------------------------------

function clampPointToViewport(point: Point, viewport: Viewport): Point {
  return {
    x: Math.max(0, Math.min(point.x, viewport.width)),
    y: Math.max(0, Math.min(point.y, viewport.height)),
  }
}

function scrollDirection(action: PlatformAction): 'up' | 'down' | 'left' | 'right' | undefined {
  if (action.type !== 'scroll') return undefined
  // Schema v2 Scroll carries an explicit direction on both modes (direction / untilVisible) —
  // no pixel sign to decode (D-01).
  const a = action as Extract<PlatformAction, { type: 'scroll' }>
  return a.direction
}

export function collapseAnnotation(
  action: PlatformAction,
  execResult: PlatformActionResult,
  viewport: Viewport,
): ActionAnnotation {
  // Schema swipe (D-15 flip): SwipeByDirection carries `direction`; SwipeByPath carries from/to.
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
  /**
   * The FULL observed ScreenState the sub-action was planned against (D-15). Pitfall 3:
   * v1 stored only the tree string — the forbidden shape. elements + refMap ride along.
   */
  stateBefore: ScreenState
  stateAfter?: ScreenState
  /**
   * The execution result as the schema ActionResult (screenshot may be present here as
   * bytes; it is structurally excluded by toRecordedActionResult before storage — the
   * type-level screenshot-never guarantee, T-353-06). annotation is produced via
   * collapseAnnotation.
   */
  result: SchemaActionResult
  /** v1 per-sub-action cache flag; folded per step by foldCacheStatus at finalize. */
  cached?: boolean
  /**
   * The §A8 grounding evidence for this sub-action (GROUND-02): the resolved descriptor
   * plus the per-rung attempt trail (turn gate on the live path, replay resolution on the
   * cache path, re-ground heal entries on the D-10 path). Present only when the action
   * carried an element field; the loop redacts the descriptor BEFORE passing it here so a
   * pre-redaction descriptor never reaches evidence (T-357-02a, the redact-before-record
   * ordering). Typed via the schema DTO — no runner-local mirror (353 evidence-by-construction).
   */
  grounding?: SubActionEvidence['grounding']
  /**
   * The §A8 decision-screenshot ArtifactRef (CASS-02): the identity of the exact final image
   * bytes the planner saw for this live decision, minted by the run-scoped artifact store.
   * Absent on cache-served, text-only, unbound-store, or failed-store paths — never fabricated.
   */
  decisionScreenshotRef?: SubActionEvidence['decisionScreenshotRef']
  /**
   * Auxiliary §A8 ArtifactRefs already reserved by the schema DTO. Copied verbatim (order and
   * identity preserved) so the recorder never drops artifact references present on the input.
   */
  artifactRefs?: SubActionEvidence['artifactRefs']
  /**
   * Ordered exchanges from this live planning decision (D-01). The loop masks every
   * string leaf BEFORE passing them here (T-360-01); the recorder never sees raw values.
   * Present, possibly empty, for live turns and absent for cache replay.
   */
  exchanges?: ToolExchangeEvidence[]
  /**
   * Final-response enrichment for this live decision (D-05/D-08). The loop passes it
   * conditionally; structural absence means no live call record was available.
   */
  callRecord?: ModelCallRecord
  /** 436 D-22: what the action produced outside the page, already masked by the loop. */
  operationEvidence?: SubActionEvidence['operationEvidence']
  healedDispatch?: SubActionEvidence['healedDispatch']
}

export class EvidenceRecorder {
  private readonly subActions: SubActionEvidence[] = []
  private readonly cacheFlags: boolean[] = []
  private servedBrief: ServedBrief
  /**
   * KREV-02 · D-13: the serve-time retrieval trace, recorded BESIDE `servedBrief` and never
   * inside it. `ServedBrief` feeds `computeBriefDigest`, so a trace channel within it would have
   * rewritten every cassette and acceptance digest in the tree; a sibling field leaves those
   * bytes untouched, which `evidence-trace.test.ts` proves by digest equality rather than by
   * asserting that nobody edited the brief.
   *
   * Channel 1 is REPLACED on each record (a step replans against the SAME frozen brief, so
   * appending would duplicate its attributions), while Channel 3 APPENDS — exactly mirroring how
   * `servedBrief.channel1` and `servedBrief.channel3` themselves behave.
   */
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
  /** D-06 run-declared planner context, copied onto every finalized step when bound. */
  private readonly modelProfile?: DeclaredModelProfile
  /** D-07 verifier identity copied beside every finalized verdict when bound. */
  private readonly verifierIdentity?: ModelIdentity
  /** D-16 once-per-member bound-surface digest copied onto every finalized step. */
  private readonly toolSchemaDigest?: string
  /**
   * 407 D-13: the HOST's retrieval rung at serve time, handed in by the composition root and
   * copied onto every finalized step. It sits BESIDE `servedBrief` for the same reason
   * `retrievalTrace` does — `computeBriefDigest` keys cassettes and acceptance evidence on the
   * brief's bytes, so a rung channel inside the brief would invalidate every brief ever served.
   * The recorder never resolves it: a run's rung is a fact about serve time, not a live probe.
   */
  private readonly retrievalRung?: RecordedRetrievalRung
  /**
   * D-02 single sub-action chokepoint (Plan 361-08). When bound, invoked at the END of
   * every {@link recordSubAction} append with the recorded evidence and its index — so all
   * five loop call sites emit `subActionRecorded` through ONE seam, never per-call-site.
   * Optional-chained: unbound ⇒ the recorder is byte-identical to today (never throws, D-05).
   */
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
    // D-02 live emission (Plan 361-08): fire the one chokepoint AFTER the append so the
    // recorded evidence + its index leave the loop at the moment they occur. Fire-and-forget,
    // optional-chained — never throws when unbound.
    this.onSubActionRecorded?.(evidence, index)
    return index
  }

  /**
   * Snapshot the run-scoped working-memory set served to this step's planning turns
   * (WM-01, §12.15). The loop passes the values ALREADY masked (the loop's `recordMask`, Pitfall
   * 7 boundary 3) — recorded BESIDE the brief, never inside `servedBrief`.
   */
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
    /**
     * D-16's last hop, made structural. The trace is a REQUIRED parameter, so the only way to
     * persist a served brief without one is to change this signature — which is a compile error
     * at every call site rather than a silently trace-less run. `makeEmptyServedBrief` stays the
     * one no-reader constructor fallback and records nothing here, so an absent trace on evidence
     * means "no reader was bound", never "a reader served and the trace was dropped" (D-15).
     */
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

  /**
   * Append the exact Channel-3 CautionLines injected into a live replan turn. Refused records
   * never enter this method; the reserved reader overflow line does because its summary was
   * actually rendered. Digest recomputation keeps ServedBrief content-addressed after mutation.
   *
   * WR-10 (387-13): the LEDGER accumulates on every call, including the zero-injection one. A
   * turn that injected nothing is not a turn with nothing to explain — it is exactly the turn
   * "why didn't it mention X" is asked about, and {@link foldRetrievalTrace} carries a dedicated
   * arm for "no served lines, non-empty truncation ledger" that this method previously made
   * unreachable by returning before accumulating.
   *
   * The surviving `cautions.length === 0` return is a COST guard, not a correctness one, and the
   * distinction is measured rather than asserted: deleting it outright reddens nothing, because
   * appending an empty array and recomputing a content-addressed digest reproduces the same
   * bytes. It stays only to skip a whole-brief rehash on every all-cut turn. D-13's byte-stability
   * on this path is protected by what is NOT written here — cut candidates are never spoofed into
   * `channel3` as served lines — and the regression cases pin that outcome, not this branch.
   */
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

  /**
   * Record the structurally failed planning turn (D-03). Exchanges and message arrive
   * ALREADY masked by the loop; the recorder remains mask-agnostic.
   */
  recordPlanningFailure(evidence: PlanningFailureEvidence): void {
    this.planningFailure = evidence
  }

  // -------------------------------------------------------------------------
  // Phase 360 termination-verb & AI-assertion evidence blocks (EXEC-05/EXEC-07 ·
  // D-03/D-04/D-05/D-10/D-11). Sibling record* methods on the recorder; recording types ARE
  // the schema §A8 DTOs (353 D-14 law — no runner-local mirror). MASKED-BEFORE-RECORD: as with
  // recordWorkingMemory, the caller (the Plan 10 dispatch seam) masks every value-bearing field
  // via the loop's `recordMask` BEFORE handing the DTO here — the recorder never sees a raw secret
  // and never store-raw-then-masks (T-360-01).
  // -------------------------------------------------------------------------

  /**
   * Record the D-03 `common_reportValue` answer block. `value` arrives already masked. Surfaced
   * on StepEvidence.reportedValue so the verdict layer (and Phase 361's handoff) carries the
   * retrieved answer first-class. reportValue is non-terminal (D-02) — this only records.
   */
  recordReportedValue(evidence: ReportedValueEvidence): void {
    this.reportedValue = evidence
  }

  /**
   * Record the D-04 infeasible termination block — present only when a turn declared the step
   * infeasible via the `failureKind`/`failureReason` envelope (machine-distinguishable from a
   * plain `stepFailed`). Sorted keys `["kind","reason"]` are fixed by the DTO.
   */
  recordTermination(evidence: TerminationEvidence): void {
    this.termination = evidence
  }

  /**
   * Record the typed limit stop (436 D-12/D-13). Its text fields arrive already masked; it is
   * never a planning failure, a termination or a verdict source.
   */
  recordLimitStop(evidence: LimitStopEvidence): void {
    this.limitStop = evidence
  }

  /**
   * Record the per-condition verdicts (439 D-07). Text fields arrive masked and bounded; a later
   * judgment of the same step replaces an earlier one.
   */
  recordConditionVerdicts(evidence: ConditionVerdictsEvidence): void {
    this.conditionVerdicts = evidence
  }

  /** Record whether the step's platform could capture each operation (436 D-23). */
  recordOperationCapture(availability: OperationCaptureAvailability): void {
    this.operationCapture = availability
  }

  /** Record the step's configured limits and usage (436 D-11); finish() calls it on every path. */
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

  /**
   * Record the D-10/D-11 structured `common_assertValue` outcome block: the comparator's
   * deterministic result with `expected`/`actual` already masked. A passing outcome drives the
   * verifier short-circuit (Plan 10 seam), recorded via {@link recordVerdictSource}.
   */
  recordAssertOutcome(evidence: AssertValueEvidence): void {
    this.assertOutcome = evidence
  }

  /**
   * Record which path produced this step's final verification verdict (D-11): the deterministic
   * assertValue comparator (`'assert-value'`) or the verifier's own model call
   * (`'verifier-model'`), which also decides every AI-judged conclusion (assertAI or extractAI;
   * quick 261004-lsa). Set with the final verdict, so a verifier rejection records nothing.
   */
  recordVerdictSource(source: VerdictSource): void {
    this.verdictSource = source
  }

  /**
   * Record the typed step plan source (PROC-02 · 381 D-12). `procedure-replay` carries the
   * guard fold (checksPassed/total + the first miss when the fold broke off); `procedure-hint`
   * marks a served-without-replay exposure. Recorded BESIDE `cacheStatus` — structurally
   * distinct from the cached flag so eval/cassette consumers reading cached semantics are
   * never polluted (Pitfall 4). Last write wins: the loop updates the fold as guard checks
   * accumulate, and the final state is what finalize emits.
   */
  recordPlanSource(source: StepPlanSource): void {
    this.planSource = source
  }

  /**
   * Record why a cache key hit did not replay (438 D-11), before the loop invalidates the entry.
   * The first reason in the step is kept.
   */
  recordCacheMiss(miss: { reason: CacheMissReason }): void {
    this.cacheMiss ??= { reason: miss.reason }
  }

  /**
   * Attach the D-15 stateAfter at the spec-locked boundaries (assert sub-actions, the
   * verifier boundary, the self-heal boundary) by reuse of an observation the loop
   * already takes — no extra capture.
   */
  attachStateAfter(index: number, state: ScreenState): void {
    const evidence = this.subActions[index]
    if (evidence) evidence.stateAfter = state
  }

  /** Record the §A8 contrastive self-heal pair (D-12): the failed decision and the
   * recovering decision at the replan-with-failure-context boundary. */
  recordSelfHeal(failedDecision: Decision, recoveringDecision: Decision): void {
    this.selfHeal = { failedDecision, recoveringDecision }
  }

  /**
   * Fold the per-channel serve-time attributions into the one persisted trace (D-13/D-14).
   *
   * Every value here was computed by the reader at the moment of serving and is copied through
   * unchanged — no score is re-derived and no rank is recomputed at persistence time. The runner
   * writes; the reader computed.
   *
   * Absent when nothing was served through a bound reader, which is D-15's honest no-trace arm:
   * an absent trace says "no reader served this step", not "a trace was lost".
   */
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
      /**
       * The step's `{{env:NAME}}` provenance pairs (PROC-01 · 381 D-03/D-08), stamped only
       * when non-empty so the absent-by-default shape is preserved. The recorder is
       * MASK-AGNOSTIC by contract: it records exactly what its caller passes and masks
       * nothing itself. These pairs in particular must NOT be masked anywhere — see the
       * masking prohibition on `StepEvidence.interpolatedVariables`.
       */
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
    // 2026-10-07 (436-03): no producer writes stagnation or cycle any more (D-15, D-17).
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

// ---------------------------------------------------------------------------
// projectLegacyTrace — projects the legacy SubActionTrace[] (string screen states)
// FROM the evidence at step end. Richer→poorer only (Open Q5); reporters/dashboard/
// JUnit keep consuming StepResult.trace unchanged until 361/363.
// ---------------------------------------------------------------------------

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
