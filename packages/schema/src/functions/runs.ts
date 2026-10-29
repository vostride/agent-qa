import { z } from 'zod'

import type { Action } from '../action/index'
import { RecordedRetrievalRungSchema } from '../brief/retrieval-rung'
import { ServedRetrievalTraceV1Schema } from '../brief/retrieval-trace'
import { BRIEF_WHY_NO_TRACE_REASONS } from '../knowledge/review-verbs'
import { RecordChangeSchema } from '../knowledge/maintenance-views'
import type { VerifierVerdict } from '../handoff/step-evidence'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { PlannerLimitsRecord } from '../config/planner-limits'
import type { ScopeKey, ScopeTier } from '../identity/scope-key'
import {
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  RUN_NOTIFICATION_VIEW_STATUSES,
} from '../notification/run-notification'
import type { RunNotificationView } from '../notification/run-notification'
import { CurationSnapshotSchema } from '../notification/curation-snapshot'
import {
  CurationSnapshotWithheldSchema,
  POST_PROCESSING_CHIP_STATUSES,
  POST_PROCESSING_DETAIL_STAGES,
  PostProcessingSkippedSchema,
  PostProcessingStageDetailSchema,
} from '../notification/post-processing-status'
import type { PostProcessingChips, PostProcessingStatus } from '../notification/post-processing-status'
import { LiveStreamDeclarationSchema } from '../run/live-stream'
import { RUN_EVENT_TYPES } from '../run/bus-events'
import { ModelUsageSchema, ModelUsageIdentitySchema } from '../run/model-usage'
import type { ModelUsage, ModelTokenUsage } from '../run/model-usage'
import type { RunEventEnvelope, RunEventPayload } from '../run/bus-events'
import type { MemberTestOutcome } from '../run/member-outcome'
import {
  EvidenceEntrySchema, EvidenceKindSchema, EvidenceAbsenceReasonSchema, evidenceEntryOfKind,
  ConsoleEvidenceDocumentSchema, NetworkEvidenceDocumentSchema, A11yEvidenceDocumentSchema,
  AriaEvidenceDocumentSchema, VariablesEvidenceDocumentSchema, VariableSnapshotSchema,
} from '../run/evidence'
import type { AriaEvidenceEntry, StepEvidenceEntries, VariableSnapshot } from '../run/evidence'
import { RecordingEntrySchema, type RecordingEntry } from '../run/recording'
import type { RecordedActionResult } from '../result/index'
import { runIdSchema } from '../run/run-id'
import type { GroundingEvidence } from '../screen/target-descriptor'
import type { RunId } from '../run/run-id'
import { EXECUTION_CONTEXT_VALUES } from '../run/run-status'
import type { ExecutionContext, RunStatus } from '../run/run-status'
import type { Verdict } from '../verdict/verdict'
import { RunDetailMemberMarkSchema, type RunDetailMemberMark } from './feedback'
import { wireOutputContract } from './output-contract'
import { oneJoinArm, recordJoinShape } from './record-join'

export const RUN_SUMMARY_SCHEMA_VERSION = 2

export interface RunSummary {
  runId: RunId
  scope: ScopeKey
  buildOrdinal: number
  executionContext: ExecutionContext
  aggregateVerdict: RunStatus
  startedAt: number
  endedAt: number
  /** Number of member tests the run recorded. */
  testCount: number
  /** Every member test the run recorded, in recorded order, whatever filter selected the run. */
  tests: RunSummaryTest[]
  recordedTargets: RecordedTargets
}

export interface RunSummaryTest {
  testIndex: number
  testId: string
  testName: string
}

// `unknown` is its own arm: a run with no readable snapshot is not a run with no targets.
export type RecordedTargets =
  | { status: 'recorded'; names: string[] }
  | { status: 'unknown' }

const scopeTierValues = [
  'global',
  'product',
  'suite',
  'test',
] as const satisfies readonly ScopeTier[]

const runStatusValues = [
  'passed',
  'failed',
  'healed',
  'timeout',
  'cancelled',
] as const satisfies readonly RunStatus[]

// 393: hoisted to `run/run-status.ts` beside the type, so the analyze-run payload mirror
// enumerates the same closed set rather than keeping a second copy of it.
const executionContextValues = EXECUTION_CONTEXT_VALUES

const scopeKeySchema = z.object({
  tier: z.enum(scopeTierValues),
  key: z.string(),
}).strict()

const RunSummaryTestSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  testId: z.string(),
  testName: z.string(),
}).strict() satisfies z.ZodType<RunSummaryTest>

const RecordedTargetsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('recorded'), names: z.array(z.string().min(1)) }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]) satisfies z.ZodType<RecordedTargets>

export const RunSummarySchema = z.object({
  runId: runIdSchema,
  scope: scopeKeySchema,
  buildOrdinal: z.number().int().nonnegative(),
  executionContext: z.enum(executionContextValues),
  aggregateVerdict: z.enum(runStatusValues),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  testCount: z.number().int().nonnegative(),
  tests: z.array(RunSummaryTestSchema),
  recordedTargets: RecordedTargetsSchema,
}).strict() satisfies z.ZodType<RunSummary>

export const RUNS_LIST_DEFAULT_LIMIT = 20
export const RUNS_LIST_MAX_LIMIT = 200

const listTextFilterSchema = z.string().refine((value) => value.trim().length > 0, {
  message: 'must name something: an empty or whitespace-only filter matches nothing',
})

// `.int()` is safe-integer bounded in zod 4, so an unrepresentable epoch or limit is refused
// rather than rounded.
const epochMillisecondsSchema = z.number().int().nonnegative()

// Filters select completed runs before the limit; `since` is inclusive epoch ms on `endedAt`.
export const RunsListInputSchema = z.object({
  verdict: z.enum(runStatusValues).optional(),
  test: listTextFilterSchema.optional(),
  target: listTextFilterSchema.optional(),
  since: epochMillisecondsSchema.optional(),
  limit: z.number().int().min(1).max(RUNS_LIST_MAX_LIMIT).optional(),
}).strict()

export type RunsListInput = z.infer<typeof RunsListInputSchema>

export const RunsListOutputSchema = z.array(RunSummarySchema)

export type RunsListOutput = z.infer<typeof RunsListOutputSchema>

export const RunsListOutputContract = wireOutputContract(RunsListOutputSchema)

export const RUN_DETAIL_SCHEMA_VERSION = 2

export interface RunTestDetail {
  testId: string
  testName: string
  filePath: string
  testIndex: number
  outcome: MemberTestOutcome
  /** Number of recorded steps; the step evidence stays in the handoff document. */
  stepCount: number
  /**
   * Present iff the run classified a root cause for this member. Flattened to the three
   * fields a listing renders — the full `Verdict` (cited steps, anchors, artifacts) stays
   * in the handoff document rather than crossing every surface boundary by default.
   */
  rootCause?: {
    class: Verdict['class']
    producer: 'deterministic-classifier' | 'analyze-run'
    confidence: number
    rationale: string
  }
}

export interface RunDetail {
  runId: RunId
  scope: ScopeKey
  buildOrdinal: number
  executionContext: ExecutionContext
  aggregateVerdict: RunStatus
  configDigests: {
    suiteConfigDigest: string
    testConfigDigest: string
  }
  startedAt: number
  endedAt: number
  gateRun?: true
  // Independent of `gateRun`: neither implies the other.
  excludedFromOutcomes?: true
  tests: RunTestDetail[]
}

const verdictClassValues = [
  'test_bug',
  'app_bug',
  'environment',
  'flake',
  'config_error',
  'llm_error',
  'unknown',
  'timeout',
] as const satisfies readonly Verdict['class'][]

const memberTestOutcomeValues = [
  ...runStatusValues,
  'skipped',
] as const satisfies readonly MemberTestOutcome[]

const configDigestsSchema = z.object({
  suiteConfigDigest: z.string(),
  testConfigDigest: z.string(),
}).strict()

export const RunTestDetailSchema = z.object({
  testId: z.string(),
  testName: z.string(),
  filePath: z.string(),
  testIndex: z.number().int().nonnegative(),
  outcome: z.enum(memberTestOutcomeValues),
  stepCount: z.number().int().nonnegative(),
  rootCause: z.object({
    class: z.enum(verdictClassValues),
    producer: z.enum(['deterministic-classifier', 'analyze-run']),
    confidence: z.number(),
    rationale: z.string(),
  }).strict().optional(),
}).strict() satisfies z.ZodType<RunTestDetail>

export const RunDetailSchema = z.object({
  runId: runIdSchema,
  scope: scopeKeySchema,
  buildOrdinal: z.number().int().nonnegative(),
  executionContext: z.enum(executionContextValues),
  aggregateVerdict: z.enum(runStatusValues),
  configDigests: configDigestsSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  gateRun: z.literal(true).optional(),
  excludedFromOutcomes: z.literal(true).optional(),
  tests: z.array(RunTestDetailSchema),
}).strict() satisfies z.ZodType<RunDetail>

/** `runs.get` addresses exactly one completed run by id. */
export const RunsGetInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsGetInput = z.infer<typeof RunsGetInputSchema>

export const RunsPostProcessingInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsPostProcessingInput = z.infer<typeof RunsPostProcessingInputSchema>

// The wire shape a surface receives; `guardRunNotification` checks the stored bytes separately.
export const RunNotificationViewSchema = z.object({
  schemaVersion: z.literal(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION),
  runId: z.string(),
  outcome: z.enum(RUN_NOTIFICATION_VIEW_STATUSES),
  verdictSummary: z.object({
    total: z.number().int().nonnegative(),
    // A class that did not occur is an absent key, never a zero, so unknown classes stay distinct.
    byClass: z.partialRecord(z.enum(verdictClassValues), z.number().int().nonnegative()),
  }).strict(),
  stages: z.object({
    analysis: z.object({ status: z.enum(RUN_NOTIFICATION_VIEW_STATUSES) }).strict(),
    curation: z.object({
      status: z.enum(RUN_NOTIFICATION_VIEW_STATUSES),
      curated: z.number().int().nonnegative().optional(),
      deprecated: z.number().int().nonnegative().optional(),
      curationSnapshot: CurationSnapshotSchema.optional(),
    }).strict(),
  }).strict(),
}).strict() satisfies z.ZodType<RunNotificationView>

const PostProcessingChipsSchema = z.object({
  analysis: z.enum(POST_PROCESSING_CHIP_STATUSES),
  curation: z.enum(POST_PROCESSING_CHIP_STATUSES),
}).strict() satisfies z.ZodType<PostProcessingChips>

// `notification` is optional, not nullable: absence is the ordinary state of a chain in flight.
export const PostProcessingStatusSchema = z.object({
  runId: z.string(),
  chips: PostProcessingChipsSchema,
  stageDetails: z.partialRecord(z.enum(POST_PROCESSING_DETAIL_STAGES), PostProcessingStageDetailSchema).optional(),
  curationSnapshot: CurationSnapshotSchema.optional(),
  /** A recorded snapshot that could not be projected safely; never beside curationSnapshot. */
  curationSnapshotWithheld: CurationSnapshotWithheldSchema.optional(),
  /** The run's chain was never enqueued; folded from the durable handoff markers. */
  skipped: PostProcessingSkippedSchema.optional(),
  notification: RunNotificationViewSchema.optional(),
}).strict() satisfies z.ZodType<PostProcessingStatus>

// An empty input runs the configured default set; an unknown key is refused, not ignored.
export const RunsStartInputSchema = z.object({
  /** Test file paths or glob patterns to run; absent means the configured default set. */
  patterns: z.array(z.string()).optional(),
  // Absent: the composition mints one; an unrun id still fails `RunNotRecordedError`.
  runId: runIdSchema.optional(),
  /** Config file the composition root resolves the run against. */
  configPath: z.string().optional(),
  // Only the literal marker is accepted, matching the handoff carrier.
  gateRun: z.literal(true).optional(),
  // Independent of `gateRun`: neither implies the other.
  excludedFromOutcomes: z.literal(true).optional(),
}).strict()

export type RunsStartInput = z.infer<typeof RunsStartInputSchema>

export const RUN_START_ACKNOWLEDGEMENT_SCHEMA_VERSION = 2

const plannerLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

// The handoff loader checks this shape by hand in `hasPlannerLimitsRecordShape`; keep them equal.
export const PlannerLimitsRecordSchema = z.object({
  maxActions: plannerLimitSchema,
  maxPlanningTurns: plannerLimitSchema,
  perTest: z.array(z.object({
    testName: z.string(),
    filePath: z.string(),
    maxActions: plannerLimitSchema,
    maxPlanningTurns: plannerLimitSchema,
  }).strict()).optional(),
}).strict() satisfies z.ZodType<PlannerLimitsRecord>

// Starting is asynchronous, so the acknowledgement names the run, never its outcome.
export interface RunStartAcknowledgement {
  runId: RunId
  scope: ScopeKey
  executionContext: ExecutionContext
  buildOrdinal: number
  startedAt: number
  /** Member tests the resolved pattern set admitted. */
  testCount: number
  gateRun?: true
  excludedFromOutcomes?: true
  limits?: PlannerLimitsRecord
}

export const RunStartAcknowledgementSchema = z.object({
  runId: runIdSchema,
  scope: scopeKeySchema,
  executionContext: z.enum(executionContextValues),
  buildOrdinal: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  testCount: z.number().int().nonnegative(),
  gateRun: z.literal(true).optional(),
  excludedFromOutcomes: z.literal(true).optional(),
  limits: PlannerLimitsRecordSchema.optional(),
}).strict() satisfies z.ZodType<RunStartAcknowledgement>

// `lastEventId` is the last `seq` the caller saw, so the stream resumes at `lastEventId + 1`.
export const RunsEventsInputSchema = z.object({
  runId: runIdSchema,
  lastEventId: z.number().int().nonnegative().optional(),
}).strict()

export type RunsEventsInput = z.infer<typeof RunsEventsInputSchema>

// Absent `handle` means 0, the single member every non-suite run has.
export const RunsLiveUrlInputSchema = z.object({
  runId: runIdSchema,
  handle: z.number().int().nonnegative().optional(),
}).strict()

export type RunsLiveUrlInput = z.infer<typeof RunsLiveUrlInputSchema>

// The token is in the `liveUrl` fragment: `classify` never interpolates it and no door logs it.
export const RunsLiveUrlResultSchema = z.object({
  liveUrl: z.string(),
  expiresAt: z.number().int(),
  handle: z.number().int().nonnegative(),
  stream: LiveStreamDeclarationSchema,
}).strict()

export type RunsLiveUrlResult = z.infer<typeof RunsLiveUrlResultSchema>

/** The editor subject's mint input, reachable only through the dashboard door. */
export const EditorLiveUrlInputSchema = z.object({
  sessionId: z.string().min(1),
}).strict()

export type EditorLiveUrlInput = z.infer<typeof EditorLiveUrlInputSchema>

// Strict because the composition parses this result, so a grown field throws instead of leaking.
export const EditorLiveUrlResultSchema = z.object({
  liveUrl: z.string(),
  expiresAt: z.number().int(),
  stream: LiveStreamDeclarationSchema,
}).strict()

export type EditorLiveUrlResult = z.infer<typeof EditorLiveUrlResultSchema>

export const RUN_EVENT_ENVELOPE_SCHEMA_VERSION = 2

// One element of the stream; `payload` stays an open record that a consumer narrows by `type`.
export const RunEventEnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.number().int().nonnegative(),
  runId: z.string(),
  type: z.enum(RUN_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()).transform((value) => value as RunEventPayload),
}).strict() satisfies z.ZodType<RunEventEnvelope>

// Field names mirror the bus payloads one for one, so the projection cannot drift from the events.

// `testIndex` is the handle; every descriptive field is optional so a thin member still renders.
export interface RunDetailMember {
  testIndex: number
  testId?: string
  name?: string
  filePath?: string
  suiteId?: string
  suiteName?: string
  suiteIndex?: number
  totalSteps?: number
  outcome?: MemberTestOutcome
  durationMs?: number
  failureSummary?: string
  retryCount?: number
  attempts: number
  recording?: RecordingEntry
  // The latest mark per address: the run-level entry first, then steps ascending.
  marks?: readonly RunDetailMemberMark[]
}

// Absent when nothing was measured; a cache hit or a bypass carries no usage, never a zero.
export interface RunStepTokenUsage extends ModelTokenUsage {}

export interface RunDetailStep {
  testIndex: number
  stepIndex: number
  /** The instruction text, cached from this step's own `stepStarted`. */
  stepText?: string
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'disabled'
  verifierVerdict: VerifierVerdict
  selfHealOccurred: boolean
  briefDigest: string
  status?: 'passed' | 'failed' | 'healed' | 'skipped' | 'cancelled'
  durationMs?: number
  error?: string
  tokenUsage?: RunStepTokenUsage
  modelUsage?: ModelUsage
  /** Capture-time entries; absence on historical rows is normalized by the read op. */
  evidence?: StepEvidenceEntries
  /** Finalized snapshot, with names and values masked by the bus producer. */
  variableSnapshot?: VariableSnapshot
}

export interface RunDetailSubAction {
  testIndex: number
  stepIndex: number
  subActionIndex: number
  plan: string
  plannedAction: Action
  grounding?: GroundingEvidence
  result: RecordedActionResult
  screenStateHash: string
  screenStateHashAfter?: string
  artifactRefs?: readonly RunDetailArtifactRef[]
  /** Before-tree evidence belongs to this sub-action, never its parent step. */
  ariaEvidence?: AriaEvidenceEntry
  recordingOffsetMs?: number
}

// Absent `present` means unknown, so a page tests `present === false` and never claims an absence.
export interface RunDetailArtifactRef extends ArtifactRef {
  present?: boolean
}

// The sums are absent when `measuredSteps` is 0: no usage reported differs from zero usage.
export interface RunTokenTotals {
  measuredSteps: number
  unmeasuredSteps: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cachedMeasuredSteps?: number
  /** Inclusive input over precisely the steps contributing cachedInputTokens. */
  cachedInputMeasuredTokens?: number
}

export const RunModelSummarySchema = z.object({
  declared: z.array(ModelUsageIdentitySchema.extend({ stepCount: z.number().int().positive() }))
    .nonempty().optional(),
  responding: z.array(z.object({ provider: z.string().optional(), modelId: z.string(),
    stepCount: z.number().int().positive() }).strict()).nonempty().optional(),
}).strict()
export type RunModelSummary = z.infer<typeof RunModelSummarySchema>

// The token sum is not here: the op computes it with `projectRunTokenTotals`, its one producer.
export interface RunDetailRows {
  runId: string
  members: readonly RunDetailMember[]
  steps: readonly RunDetailStep[]
  subActions: readonly RunDetailSubAction[]
}

export interface RunDetailProjection extends RunDetailRows {
  tokens: RunTokenTotals
  models?: RunModelSummary
}

/**
 * `runs.detail` addresses exactly one run by id — the same one-field shape `runs.get` takes.
 *
 * Deliberately so: run detail is a fact about a RUN, derived from its id alone. A filter, a handle
 * or a page cursor on this contract would be a second way to address one page, and the projection
 * rests on there being exactly one.
 */
export const RunsDetailInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsDetailInput = z.infer<typeof RunsDetailInputSchema>

/**
 * The bus's own nested objects, carried VERBATIM across the wire.
 *
 * An open record with a cast rather than a re-declaration of `Action` / `RecordedActionResult` /
 * `GroundingEvidence` in zod: those three unions are the runner's contracts, they are large, and a
 * second declaration here would be a second answer to what an action IS — free to fall behind the
 * type the runner actually emits. This is the `RunEventEnvelopeSchema.payload` idiom in this same
 * file, for the same reason: the envelope contract describes the frame, and a consumer narrows the
 * payload against the exported union.
 */
const opaqueBusObject = <T>(): z.ZodType<T> =>
  z.record(z.string(), z.unknown()).transform((value) => value as T) as unknown as z.ZodType<T>

const ArtifactRefSchema = z.object({
  id: z.string(),
  sha: z.string(),
  evidenceIncomplete: z.boolean().optional(),
  present: z.boolean().optional(),
}).strict() satisfies z.ZodType<RunDetailArtifactRef>

const VerifierVerdictSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
}).strict() satisfies z.ZodType<VerifierVerdict>

// Not an integer: the producer is a `performance.now()` delta, so `.int()` would refuse real runs.
const durationMsSchema = z.number().finite().nonnegative()

export const RunDetailMemberSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  testId: z.string().optional(),
  name: z.string().optional(),
  filePath: z.string().optional(),
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteIndex: z.number().int().nonnegative().optional(),
  totalSteps: z.number().int().nonnegative().optional(),
  outcome: z.enum(memberTestOutcomeValues).optional(),
  durationMs: durationMsSchema.optional(),
  failureSummary: z.string().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  attempts: z.number().int().positive(),
  marks: z.array(RunDetailMemberMarkSchema).optional(),
  recording: RecordingEntrySchema.optional(),
}).strict() satisfies z.ZodType<RunDetailMember>

export const RunStepTokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
}).strict() satisfies z.ZodType<RunStepTokenUsage>

export const RunDetailStepSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  stepText: z.string().optional(),
  cacheStatus: z.enum(['hit', 'miss', 'bypass', 'disabled']),
  verifierVerdict: VerifierVerdictSchema,
  selfHealOccurred: z.boolean(),
  briefDigest: z.string(),
  status: z.enum(['passed', 'failed', 'healed', 'skipped', 'cancelled']).optional(),
  durationMs: durationMsSchema.optional(),
  error: z.string().optional(),
  tokenUsage: RunStepTokenUsageSchema.optional(),
  modelUsage: ModelUsageSchema.optional(),
  evidence: z.strictObject({
    console: evidenceEntryOfKind('console'),
    network: evidenceEntryOfKind('network'),
    a11y: evidenceEntryOfKind('a11y'),
    variables: evidenceEntryOfKind('variables'),
  }).optional(),
  variableSnapshot: VariableSnapshotSchema.optional(),
}).strict() satisfies z.ZodType<RunDetailStep>

export const RunDetailSubActionSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  subActionIndex: z.number().int().nonnegative(),
  plan: z.string(),
  plannedAction: opaqueBusObject<Action>(),
  grounding: opaqueBusObject<GroundingEvidence>().optional(),
  result: opaqueBusObject<RecordedActionResult>(),
  screenStateHash: z.string(),
  screenStateHashAfter: z.string().optional(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
  ariaEvidence: evidenceEntryOfKind('aria').optional(),
  recordingOffsetMs: z.number().finite().nonnegative().optional(),
}).strict() satisfies z.ZodType<RunDetailSubAction>

export const RunTokenTotalsSchema = z.object({
  measuredSteps: z.number().int().nonnegative(),
  unmeasuredSteps: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedMeasuredSteps: z.number().int().positive().optional(),
  cachedInputMeasuredTokens: z.number().int().nonnegative().optional(),
}).strict() satisfies z.ZodType<RunTokenTotals>

export const RunDetailProjectionSchema = z.object({
  runId: z.string(),
  members: z.array(RunDetailMemberSchema),
  steps: z.array(RunDetailStepSchema),
  subActions: z.array(RunDetailSubActionSchema),
  tokens: RunTokenTotalsSchema,
  models: RunModelSummarySchema.optional(),
}).strict() satisfies z.ZodType<RunDetailProjection>

// Lowercase only: the store names blobs in lowercase hex, so uppercase would look like a miss.
export const RunsArtifactInputSchema = z.object({
  runId: runIdSchema,
  sha: z.string().regex(/^[0-9a-f]{64}$/),
  range: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative().optional(),
  }).refine(range => range.end === undefined || range.end >= range.start, {
    message: 'Range end must not be below start',
  }).optional(),
}).strict()

export type RunsArtifactInput = z.infer<typeof RunsArtifactInputSchema>

// `contentType` is sniffed from the bytes and never names a type a browser renders as markup.
export const RunsArtifactResultSchema = z.object({
  runId: z.string(),
  sha: z.string(),
  contentType: z.string(),
  byteLength: z.number().int().nonnegative(),
  bytesBase64: z.string(),
  totalLength: z.number().int().nonnegative().optional(),
  range: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }).optional(),
}).strict()

export type RunsArtifactResult = z.infer<typeof RunsArtifactResultSchema>

export const RunsArtifactOutputContract = wireOutputContract(RunsArtifactResultSchema)

/** A recorded row address, never a caller-selected blob SHA or path. */
export const RunsEvidenceInputSchema = z.strictObject({
  runId: runIdSchema,
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  subActionIndex: z.number().int().nonnegative().optional(),
  kind: EvidenceKindSchema,
}).refine(value => value.kind === 'aria' || value.subActionIndex === undefined, {
  message: 'Only ARIA evidence addresses a sub-action',
})
export type RunsEvidenceInput = z.infer<typeof RunsEvidenceInputSchema>

const evidenceReady = <S extends z.ZodType>(document: S) => z.strictObject({
  address: RunsEvidenceInputSchema,
  outcome: z.literal('ready'),
  evidence: EvidenceEntrySchema,
  document,
})

/** Read failures are separate from the producer's capture-time presence/absence. */
export const RunsEvidenceResultSchema = z.union([
  evidenceReady(ConsoleEvidenceDocumentSchema),
  evidenceReady(NetworkEvidenceDocumentSchema),
  evidenceReady(A11yEvidenceDocumentSchema),
  evidenceReady(AriaEvidenceDocumentSchema),
  evidenceReady(VariablesEvidenceDocumentSchema),
  z.strictObject({
    address: RunsEvidenceInputSchema,
    outcome: z.literal('absent'),
    evidence: z.strictObject({
      kind: EvidenceKindSchema, state: z.literal('absent'), reason: EvidenceAbsenceReasonSchema,
      evidenceIncomplete: z.boolean().optional(),
    }),
  }),
  z.strictObject({
    address: RunsEvidenceInputSchema,
    outcome: z.literal('read-error'),
    code: z.enum(['address-not-found', 'ambiguous-address', 'invalid-entry', 'ref-not-owned',
      'sha-mismatch', 'invalid-document', 'storage-read-failed', 'snapshot-missing', 'masking-unavailable']),
    capture: EvidenceEntrySchema.optional(),
  }),
]).refine(value => {
  if (value.outcome === 'read-error') return value.capture === undefined || value.capture.kind === value.address.kind
  if (value.evidence.kind !== value.address.kind) return false
  return value.outcome !== 'ready' || (value.evidence.state === 'present' && value.document.kind === value.address.kind)
}, { message: 'Evidence, document and address must describe the same captured kind' })
export type RunsEvidenceResult = z.infer<typeof RunsEvidenceResultSchema>

// A captured variable map keeps an own `__proto__` key, which a record parser would skip.
export const RunsEvidenceOutputContract = wireOutputContract(RunsEvidenceResultSchema)

// Every field projects the run's handoff, never today's index, so the panel answers about that run.

/** `runs.knowledge` addresses exactly one recorded run, on `runs.postProcessing`'s one-field footing. */
export const RunsKnowledgeInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsKnowledgeInput = z.infer<typeof RunsKnowledgeInputSchema>

/** A learned change with the read-time record join beside its unchanged historical fields. */
export const RunKnowledgeLearnedChangeSchema = RecordChangeSchema.safeExtend(recordJoinShape)
  .superRefine(oneJoinArm)

// Projected field by field, not spread from `BriefLine`, so a new serving field stays off pages.
export const RunKnowledgeBriefLineSchema = z.object({
  id: z.string(),
  kind: z.string(),
  summary: z.string(),
  trust: z.number(),
  status: z.string(),
  servedAsCanary: z.boolean(),
  tier: z.string(),
  ...recordJoinShape,
}).strict().superRefine(oneJoinArm)

/** One channel-2 read trace as the panel renders it. */
export const RunKnowledgeReadTraceSchema = z.object({
  id: z.string(),
  detailLevel: z.string(),
  bodyDigest: z.string(),
  ...recordJoinShape,
}).strict().superRefine(oneJoinArm)

/**
 * One channel-3 caution as the panel renders it.
 *
 * `anchors` are DELIBERATELY NOT PROJECTED. The panel renders a caution's sentence and nothing
 * else, and an anchor list is structural routing detail that would arrive on the wire with no
 * reader — the projection carries what a surface paints, not everything the producer holds.
 */
export const RunKnowledgeCautionLineSchema = z.object({
  id: z.string(),
  summary: z.string(),
  ...recordJoinShape,
}).strict().superRefine(oneJoinArm)

// Reuses `knowledge.brief.why`'s reason enum, so both reads name a missing trace the same way.
export const RunKnowledgeTraceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answered'),
    trace: ServedRetrievalTraceV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('no-trace'),
    reason: z.enum(BRIEF_WHY_NO_TRACE_REASONS),
  }).strict(),
])

export type RunKnowledgeTrace = z.infer<typeof RunKnowledgeTraceSchema>

// Mirrors `StepPlanSource` member for member; a missing member fails replayed runs' reads.
export const RunKnowledgePlanSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('procedure-replay'),
    procedureId: z.string(),
    guard: z.object({
      checksPassed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      miss: z.object({
        procedureStepIndex: z.number().int().nonnegative(),
        reason: z.enum([
          'descriptor-ambiguous',
          'descriptor-missing',
          'page-anchor-mismatch',
          'gate-refused',
          'parameter-unbound',
          'non-replayable-action',
        ]),
      }).strict().optional(),
      executionFailure: z.object({
        procedureStepIndex: z.number().int().nonnegative(),
      }).strict().optional(),
      verifierRejection: z.object({
        procedureStepIndex: z.number().int().nonnegative(),
      }).strict().optional(),
    }).strict(),
    // Beside the guard fold, never in it: the fold counts this step's actions, the cursor the flow.
    flow: z.object({
      cursor: z.number().int().nonnegative(),
      length: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('procedure-hint'),
    procedureId: z.string(),
    demotion: z.enum(['body-unreadable', 'body-unparseable', 'body-empty']).optional(),
  }).strict(),
])

export type RunKnowledgePlanSource = z.infer<typeof RunKnowledgePlanSourceSchema>

/**
 * ONE STEP of one member test, with everything the panel shows for it.
 *
 * `testIndex` AND `stepIndex` both ride, because `stepIndex` is numbered PER MEMBER TEST — a run
 * with two tests has two step 0s, and a row keyed on `stepIndex` alone would address neither
 * (the `StepEvidenceAddress` never-guess contract, restated as a wire shape).
 */
export const RunKnowledgeStepSchema = z.object({
  testId: z.string(),
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  stepText: z.string(),
  served: z.object({
    channel1: z.array(RunKnowledgeBriefLineSchema),
    channel2: z.array(RunKnowledgeReadTraceSchema),
    channel3: z.array(RunKnowledgeCautionLineSchema),
  }).strict(),
  trace: RunKnowledgeTraceSchema,
  planSource: RunKnowledgePlanSourceSchema.optional(),
  retrievalRung: RecordedRetrievalRungSchema.optional(),
}).strict()

export type RunKnowledgeStep = z.infer<typeof RunKnowledgeStepSchema>

// Rows appear only for an attributed outcome; a canary line with no outcome yet is absent.
export const RunKnowledgeCanaryAttributionSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative(),
  recordId: z.string(),
  observationId: z.string(),
  outcome: z.enum(['confirmed', 'contradicted', 'helpful', 'harmful']),
}).strict()

export type RunKnowledgeCanaryAttribution = z.infer<typeof RunKnowledgeCanaryAttributionSchema>

// `evidence-incomplete` is a result, not a throw: a pruned handoff is an ordinary page state.
export const RunKnowledgeProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('evidence-incomplete'),
    runId: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('ready'),
    runId: z.string(),
    buildOrdinal: z.number().int().nonnegative(),
    knowledgeStore: z.enum(['bound', 'unbound']),
    retrievalRung: RecordedRetrievalRungSchema.optional(),
    steps: z.array(RunKnowledgeStepSchema),
    curation: z.object({
      status: z.enum(POST_PROCESSING_CHIP_STATUSES),
      counts: z.object({
        curated: z.number().int().nonnegative(),
        deprecated: z.number().int().nonnegative(),
      }).strict().optional(),
      skipped: PostProcessingSkippedSchema.optional(),
    }).strict(),
    learned: z.object({
      changes: z.array(RunKnowledgeLearnedChangeSchema),
      canaryAttributions: z.array(RunKnowledgeCanaryAttributionSchema),
      // Absent when curation completed no snapshot, never a row of zeros.
      curationSnapshot: CurationSnapshotSchema.optional(),
      // Set when the snapshot read was withheld; `curationSnapshot` and `sinceThen` stay absent.
      curationSnapshotWithheld: CurationSnapshotWithheldSchema.optional(),
      /**
       * Attributed changes whose recorded identity is not in {@link curationSnapshot}, such as a
       * later promotion of a record the snapshot already names. Present only beside a snapshot.
       */
      sinceThen: z.object({
        changes: z.array(RunKnowledgeLearnedChangeSchema),
        count: z.number().int().nonnegative(),
      }).strict().refine(section => section.count === section.changes.length, {
        message: 'sinceThen.count must equal its change rows', path: ['count'],
      }).optional(),
      // `true` or absent: with it, an empty `changes` means the scan failed, not nothing changed.
      scanIncomplete: z.literal(true).optional(),
    }).strict(),
  }).strict(),
])

export type RunKnowledgeProjection = z.infer<typeof RunKnowledgeProjectionSchema>

// Two absences: a run that never existed is a bad link, a missing blob an unavailable screenshot.
export type EvidenceBlobLookup =
  | { readonly status: 'found'; readonly bytes: Uint8Array }
  | { readonly status: 'blob_absent' }
  | { readonly status: 'unknown_run' }

// Derived from `EvidenceBlobLookup` so a presence stat and a read name the same absences.
export type EvidenceBlobPresence = EvidenceBlobLookup['status']
