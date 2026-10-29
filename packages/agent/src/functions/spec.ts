// Only the declaration type leaves this directory, so no surface can bypass `invokeFunction`.

import type { EventLogPort } from '@vostride/agent-qa-runner'
import type { z } from 'zod'

import type {
  AgentAskInput,
  AgentAskResult,
  OutputContract,
  ClauseReceiptStatus,
  CompletedRunHandoff,
  CommitReceipt,
  CurationSnapshot,
  EntityDescriptor,
  EntityResolution,
  ForgetReceiptV1,
  FeedbackPort,
  FeedbackReadsPort,
  InspectRecordView,
  JobStatus,
  KnowledgeAcceptInput,
  KnowledgeBundleSummary,
  KnowledgeChangeOutput,
  KnowledgeGatesListResult,
  KnowledgeForgetInput,
  KnowledgeMarkInput,
  KnowledgeRecordShowInput,
  KnowledgeRecordShowResult,
  KnowledgeTargetRef,
  LiveStreamDeclaration,
  LiveUrlSigner,
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsInspectInput,
  KnowledgeRejectInput,
  EvidenceBlobLookup,
  EvidenceBlobPresence,
  MaskFn,
  MaskedResolvedConfig,
  PostProcessingStageDetail,
  QuarantineOperationsPort,
  RecordChange,
  RecordedTargets,
  RiskActionDescriptor,
  RunAnalysisArtifact,
  RunDetailRows,
  RunId,
  RunNotification,
  RunsStartInput,
  StepEvidence,
} from '@vostride/agent-qa-schema'

import type { AuthoringFunnelPortLike } from '../authoring/funnel.js'
import type {
  ConfigFilesPortLike,
  ConfigScaffoldContentPortLike,
  ConfigValidatePortLike,
  ConfigWritePortLike,
} from '../config-mutation/ports.js'
import type { CapabilityCatalogPort } from '../explain/port.js'
import type { EvaluateDraftPorts } from '../authoring/verify-draft.js'
import type {
  AuthoringReadPortLike,
  AuthoringScopePortLike,
  DraftShelfPortLike,
  ParsedDraftLike,
} from '../authoring/ports.js'
import type { RecurrenceProvider } from '../analysis/render-sentence.js'
import type { ChainJobIds } from '../jobs/chain-identity.js'
import type { JobIdSource } from '../jobs/engine.js'

// A `stream` op's `output` contract describes one element, never the iterable.
export type FunctionResultKind = 'unary' | 'stream'

// Every element carries its own resume token, so a stream is independent of its transport.
export type FunctionStream<Element = unknown> = AsyncIterable<Element>

/**
 * One replayed run event, defined AS the element type the runner's `EventLogPort.read`
 * yields. Binding it to the runner contract rather than restating the envelope means the
 * layer cannot drift out of step with the log the runner actually writes.
 */
export type ReplayedRunEvent = ReturnType<EventLogPort['read']>[number]

// Computed per composition, never a static field a spec could get wrong.
export type FunctionBindingStatus = 'bound' | 'unbound'

/**
 * The OPTIONAL members of {@link FunctionDeps} — the deps whose presence varies by host.
 *
 * A spec naming one of these in {@link FunctionSpec.boundThrough} is bound exactly in the
 * compositions that supplied it. This union is the whole vocabulary: a capability cannot
 * become conditionally bound on something the deps record does not declare, so "which
 * compositions can run this op" is answerable by reading two lines.
 */
export type OptionalFunctionDepKey =
  | 'liveView'
  | 'runInvocation'
  | 'knowledgeReview'
  | 'postProcessing'
  | 'runDetail'
  | 'evidenceBlobs'
  | 'analysis'
  | 'recurrence'
  | 'quarantine'
  | 'chatTurn'
  | 'draftEvaluation'
  | 'authoringRead'
  | 'authoringScope'
  | 'draftShelf'
  | 'authoringFunnel'
  | 'configFiles'
  | 'configValidate'
  | 'scaffoldContent'
  | 'capabilityCatalog'
  | 'feedback' // The mark port
  | 'feedbackReads' // Read-only mark history and preview, with no writer authority
  | 'configWrite' // The direct config writer, with no proposal and no git
  | 'secretMask' // The declared-secret mask the run reads project through

// A runtime projection of the union, so a removed key is measurable in vitest.
export const OPTIONAL_FUNCTION_DEP_KEYS = [
  'liveView',
  'runInvocation',
  'knowledgeReview',
  'postProcessing',
  'runDetail',
  'evidenceBlobs',
  'analysis',
  'recurrence',
  'quarantine',
  'chatTurn',
  'draftEvaluation',
  'authoringRead',
  'authoringScope',
  'draftShelf',
  'authoringFunnel',
  'configFiles',
  'configValidate',
  'scaffoldContent',
  'capabilityCatalog',
  'feedback',
  'feedbackReads',
  'configWrite',
  'secretMask',
] as const satisfies readonly OptionalFunctionDepKey[]

type ExactlyEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type _Cover = ExactlyEqual<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], OptionalFunctionDepKey>
const _optionalFunctionDepKeysCover: _Cover = true
void _optionalFunctionDepKeysCover

// Declared here, not in invoke.ts, so an unbound op can throw it without an import cycle.
export class FunctionNotBoundError extends Error {
  constructor(readonly functionId: string) {
    super(`${functionId} is declared but not bound in this composition`)
    this.name = 'FunctionNotBoundError'
  }
}

// Ids are `domain.verb`; the domain list is pinned in the conformance suite's `domain-list.ts`.
export interface FunctionMetadata {
  id: string
  /** One-line human description; rendered by catalogs and `agent-qa fn --list`. */
  summary: string
  resultKind: FunctionResultKind
  // Listings and MCP tool annotations read the risk descriptor.
  risk: RiskActionDescriptor
}

// A projection has no `parse`, so a listing gives no handle to replace a shared validator.
export type FunctionSchemaProjection = Readonly<Record<string, unknown>>

// Ops may not return `not-run`, which only the engine knows; an unreadable result is `failed`.
export interface ClauseVerdict {
  readonly status: Exclude<ClauseReceiptStatus, 'not-run'>
  /**
   * WHICH road, in the op's own vocabulary — `schema-fail`, `refs-only`, a proposal id.
   *
   * The empty string means "this op has nothing to add", and the engine falls back to the line it
   * has always printed. It is not a second spelling of absence: a fold that had nothing to say and a
   * fold that was never declared reach the same rendered line, which is the honest outcome for both.
   */
  readonly outcome: string
}

/**
 * The public, capability-free description of one registered capability.
 *
 * Carries no live validator and nothing runnable: every value reachable through a
 * declaration is data. `invokeFunction` reads the enforcing schema off the {@link
 * FunctionSpec} instead, which never leaves this directory.
 */
export interface FunctionDeclaration extends FunctionMetadata {
  // Computed from the registry's deps, never copied off a spec.
  bindingStatus: FunctionBindingStatus
  // Presence as data, never the callable, so a listing carries nothing runnable.
  classifies?: true
  // The fold adds lines beside the full payload render, never instead of it.
  rendersResult?: true
  input: FunctionSchemaProjection
  // For a `stream` op this describes one element, the frame its transport carries.
  output: FunctionSchemaProjection
}

/**
 * INTERNAL: metadata plus the LIVE contracts plus the implementation. Deliberately absent
 * from the package barrel — exporting this type (or any helper taking one and running it)
 * would hand a surface a private power, which is precisely what the function layer
 * abolishes.
 *
 * A spec is NOT a declaration: it extends the shared scalar metadata and re-declares the
 * two contract fields as live `z.ZodType`s. `invokeFunction` is the only reader of those,
 * and it reaches them through the module-private internals seam.
 */
export interface FunctionSpec<Input = unknown, Output = unknown> extends FunctionMetadata {
  // Absent: bound wherever registered. Present: bound only where the composition supplied that dep.
  boundThrough?: OptionalFunctionDepKey
  input: z.ZodType<Input>
  // For a `stream` op this contracts one element; parsing the iterable against it would be wrong.
  output: z.ZodType<Output>
  // For outputs zod cannot convert in output mode; it changes only the declared projection.
  outputRepresentation?: OutputContract<z.ZodType<Output>>
  // Pure, and required; an `as`-cast can still skip it, which the conformance census catches.
  classify(output: Output): ClauseVerdict
  // Additive: printed beside the complete payload render, never instead of it or as a filter.
  renderResult?(output: Output): readonly string[]
  invoke(input: Input, deps: FunctionDeps): Promise<Output>
}

// Acquired inside `invoke`, so a refusal throws instead of a stream dying half-delivered.
export interface FunctionStreamSpec<Input = unknown, Element = unknown>
  extends FunctionMetadata {
  boundThrough?: OptionalFunctionDepKey
  resultKind: 'stream'
  input: z.ZodType<Input>
  output: z.ZodType<Element>
  // Must not consume the stream: reading an element would eat the caller's first event.
  classify(output: FunctionStream<Element>): ClauseVerdict
  invoke(input: Input, deps: FunctionDeps): Promise<FunctionStream<Element>>
}

/**
 * Injected read port over the completed runs recorded for a project.
 *
 * `packages/agent` is `storageNeutral`: no host builtin is importable here. Every byte of run
 * state arrives through this port, built at the composition root over the concrete
 * `runner-local` handoff store.
 */
export interface RunsReaderPort {
  /** Every completed run this project can load. Missing run storage yields `[]`. */
  list(): Promise<readonly CompletedRunHandoff[]>
  // Implementations resolve ids against the runs they enumerate, never by a path join.
  get(runId: RunId): Promise<CompletedRunHandoff | undefined>
  // Missing early events reject with `ReplayIncompleteError`, never a silently truncated prefix.
  readEvents(runId: RunId, fromSeq: number): Promise<readonly ReplayedRunEvent[]>
  // On the runs port, so the why-verb answers from what happened, never from today's index.
  readStepEvidence(
    runId: RunId,
    address: StepEvidenceAddress,
  ): Promise<StepEvidenceLookup>
  // Targets as recorded when the run ran; an unbound reader leaves every run `unknown`.
  getRecordedTargets?(runId: RunId): Promise<RecordedTargets>
}

/**
 * Which step's evidence is wanted.
 *
 * `testId` is optional and its optionality is the never-guess contract, not a convenience:
 * `StepEvidence.stepIndex` is numbered per MEMBER TEST, so a run with two tests has two step
 * 0s and `(runId, stepIndex)` addresses neither of them. A single-test run needs no
 * disambiguator; a multi-test run that omits it has asked an ambiguous question, and the
 * lookup says so by name rather than answering about whichever test happened to be first.
 */
export interface StepEvidenceAddress {
  readonly stepIndex: number
  readonly testId?: string
}

/**
 * What a step-evidence read found — four situations a caller phrases four different ways.
 *
 * A bare `StepEvidence | undefined` was the obvious shape and it is the wrong one: it
 * collapses "no such run was ever recorded", "that run has no such step" and "your address
 * matches more than one step" into one silence. The why-verb has to distinguish the first two
 * (its no-trace vocabulary already does, and a surface tells the reader to go looking in one
 * case and not the other), and it must never treat the third as an absence — an ambiguous
 * address answered with a `not found` would be a wrong answer wearing an honest one's clothes.
 */
export type StepEvidenceLookup =
  | { readonly kind: 'found'; readonly evidence: StepEvidence }
  | { readonly kind: 'run-not-recorded' }
  | { readonly kind: 'step-not-found' }
  | { readonly kind: 'ambiguous-step-address'; readonly testIds: readonly string[] }

/**
 * Injected read port over the committed knowledge store.
 *
 * Backed by the knowledge-local `/reader` package entry at the composition root. The
 * writer-gated main entry is unreachable from this layer by construction.
 */
export interface KnowledgeReaderPort {
  // Optional, so existing fakes stay valid; an unbound read refuses by name.
  gateReceipts?(input: { candidateId: string }): Promise<KnowledgeGatesListResult>
  /** Every committed bundle, already projected to the schema-owned listing row. */
  listBundles(): Promise<readonly KnowledgeBundleSummary[]>
  // Returns the reader entry's own view schema, never a paraphrase that could drift.
  inspectRecords(input: KnowledgeRecordsInspectInput): Promise<readonly InspectRecordView[]>
  /** Every record change since a build ordinal — the reader entry's `diffSince`, wired. */
  diffSince(input: KnowledgeRecordsDiffInput): Promise<readonly RecordChange[]>
  /**
   * One record with the provenance that justifies it, or a named absence.
   *
   * Absence is a RESULT here rather than a refusal the port throws, because a record id that
   * names nothing is an ordinary reviewer question and not a broken store. The op renders the
   * answer; it never decides what "found" means.
   */
  showRecord(input: KnowledgeRecordShowInput): Promise<KnowledgeRecordShowResult>
  /**
   * Current maintenance content for caller-supplied identities, in first-request order
   * with duplicates removed. Missing records remain per-ID results; an incomplete scan
   * retains the maintenance reader's typed failure for the caller to report honestly.
   * Optional for existing hosts: consumers refuse an unbound capability by name.
   * This read does not sight identities or change storage.
   */
  showRecords?(input: { recordIds: readonly string[] }): Promise<readonly KnowledgeRecordShowResult[]>
  // With `skippedBundles > 0` the walk is partial, so an absent `outcome` is not "not attributed".
  canaryAttributions?(input: {
    runId: string
    tuples: readonly {
      candidateId: string
      testId: string
      testIndex: number
      stepIndex: number
    }[]
  }): Promise<{
    readonly rows: readonly {
      candidateId: string
      testIndex: number
      stepIndex: number
      observationId: string
      outcome?: 'confirmed' | 'contradicted' | 'helpful' | 'harmful'
    }[]
    readonly skippedBundles: number
  }>
}

// Separate from the reader port, so a read-only host never holds a write path.
export interface KnowledgeReviewPort {
  // A repeated `operationId` is the same change and lands once; an absent one is minted.
  change(request: KnowledgeChangeRequest): Promise<KnowledgeChangeOutput>
}

// Discriminated so `reject`'s required reason cannot be omitted; marks go through `runs.mark`.
export type KnowledgeChangeRequest = (
  | { readonly verb: 'accept'; readonly input: KnowledgeAcceptInput }
  | { readonly verb: 'reject'; readonly input: KnowledgeRejectInput }
  | { readonly verb: 'forget'; readonly input: KnowledgeForgetInput }
) & { readonly operationId?: string }

// `resolve` answers a closed union so callers never get a maybe; `get` never mints an address.
export interface EntityDirectoryPort {
  resolve(ref: string): Promise<EntityResolution>
  get(ref: string): Promise<EntityDescriptor | undefined>
}

// The claim stays separate from status; facts missing on older readers stay absent.
export interface PostProcessingJobRow extends Readonly<PostProcessingStageDetail> {
  readonly status: JobStatus
  /** Whether a drainer holds this job right now. `false` covers queued and terminal alike. */
  readonly claimed: boolean
}

// Each absent member is a distinct state, so a synthetic row would erase what the projection reads.
export interface PostProcessingChainState {
  readonly analyzeRun?: PostProcessingJobRow
  readonly curateMemory?: PostProcessingJobRow
  /** Completed curation facts, available before the chain terminal is written. */
  readonly curationSnapshot?: CurationSnapshot
  readonly notification?: RunNotification
}

// Chain ids are derived through the host's `idSource`, the same source its queue enqueued with.
export interface PostProcessingReaderPort {
  /** The id source THIS host's queue derives job ids with. */
  readonly idSource: JobIdSource
  /**
   * Durable state for the ids given, or `undefined` when this project holds no queue database
   * at all. Chain identity is still the job-kind layer's to derive, and this port only reads
   * what it is handed, and it may not derive an id of its own.
   *
   * `undefined` is a distinct answer from an empty state and both are honest: the first says
   * nothing has ever been enqueued here, the second says this chain's rows are not among the
   * ones that have. An implementation MUST NOT bring a database into existence to answer —
   * a status read that materialized a queue would make asking a question change the answer.
   */
  readChain(ids: ChainJobIds, runId: string): Promise<PostProcessingChainState | undefined>
}

// Answers rows only; an unknown run id is `undefined`, never resolved by a path join.
export interface RunDetailReaderPort {
  /** One run's projected rows, or `undefined` when the runs database holds no such run or does not exist yet. */
  read(runId: RunId): Promise<RunDetailRows | undefined>
  // A host without it derives no `no-verdict` fact, because absence is not a status.
  readRecord?(runId: RunId): Promise<{ status: string } | undefined>
}

// Containment is the store's own rule; an implementation never joins caller input onto a path.
export interface EvidenceBlobReaderPort {
  /** One blob's bytes, or which KIND of absence this host is reporting. */
  read(runId: RunId, sha: string): Promise<EvidenceBlobLookup>
  stat?(runId: RunId, sha: string): Promise<
    { status: 'found'; byteLength: number } | { status: 'unknown_run' | 'blob_absent' }
  >
  readRange?(runId: RunId, sha: string, start: number, end: number): Promise<EvidenceBlobLookup>
  // When missing, presence is omitted, never reported absent; answers match `read`'s three words.
  has?(runId: RunId, sha: string): Promise<EvidenceBlobPresence>
}

// Bytes pass the version guard at the composition root; `undefined` is an answer, not an error.
export interface AnalysisArtifactReaderPort {
  /** The guarded artifact for one run, or `undefined` when none is on disk. */
  getArtifact(runId: string): RunAnalysisArtifact | undefined
}

// Secret values are dropped at construction, and no unmasked variant exists on this port.
export interface ConfigReaderPort {
  getMasked(): Promise<MaskedResolvedConfig>
}

// The acknowledgment is read back off the run's own record, never taken from this port's word.
export interface RunInvocationPort {
  /**
   * Start a run for this request and resolve when the run has been recorded.
   *
   * Rejects if the run could not be started or did not complete. An implementation that
   * cannot honour the request must throw, never resolve a run id it did not produce.
   */
  start(request: RunsStartInput): Promise<StartedRun>
}

/** What {@link RunInvocationPort.start} reports: the identity of the run it started. */
export interface StartedRun {
  readonly runId: RunId
}

// Absent where no origin is served; editor lookups are separate so a session is never a run.
export interface LiveViewPort {
  signer: LiveUrlSigner
  origin(): string | undefined
  now(): number
  capabilityOf(runId: string, handle: number): LiveStreamDeclaration | undefined
  editorCapabilityOf?(sessionId: string): LiveStreamDeclaration | undefined
  onMinted?(token: string): void
}

export interface FunctionDeps {
  runs: RunsReaderPort
  knowledge: KnowledgeReaderPort
  config: ConfigReaderPort
  entities: EntityDirectoryPort
  runInvocation?: RunInvocationPort
  // Absent where no origin is served, so `runs.liveurl` refuses by name.
  liveView?: LiveViewPort
  knowledgeReview?: KnowledgeReviewPort
  // Absent where there is no queue storage, so the read refuses rather than answer `pending`.
  postProcessing?: PostProcessingReaderPort
  // The CLI binds it over the runs database once config parses; the dashboard passes its handle.
  runDetail?: RunDetailReaderPort
  // Absent where there is no runtime root, so artifacts never read as storage loss.
  evidenceBlobs?: EvidenceBlobReaderPort
  // `analysis.get` refuses without it; `runs.get` treats it as absent and reads the floor.
  analysis?: AnalysisArtifactReaderPort
  // Absent means the renderer's explicit no-history clause, not a refusal.
  recurrence?: RecurrenceProvider
  // One port: each op's risk descriptor already states which verbs write.
  quarantine?: QuarantineOperationsPort
  /** The mark port; absent, `runs.mark` is unbound by name and `runs.detail` lists no marks. */
  feedback?: FeedbackPort
  // Separate from `feedback`, so a host can serve history and preview without mark authority.
  feedbackReads?: FeedbackReadsPort
  // A single verb, so a holder of this dep gets no reach into session state.
  chatTurn?: ChatTurnPort
  // One bundle: a host with only some halves would list the op `bound` and fail far away.
  draftEvaluation?: DraftEvaluationPort
  // Absent without a knowledge index, so no test is compiled from an empty brief.
  authoringRead?: AuthoringReadPortLike
  // Consulted only when the caller named no scope; absent, a scope-less call refuses by name.
  authoringScope?: AuthoringScopePortLike
  // Bound with `authoringRead` or not at all; the invoke refuses on either half's absence.
  draftShelf?: DraftShelfPortLike
  // Absent where there is no runtime root, so no all-zero funnel flatters the loop.
  authoringFunnel?: AuthoringFunnelPortLike
  // Committed config bytes, separate from the masked `ConfigReaderPort`, which must stay masked.
  configFiles?: ConfigFilesPortLike
  // A port, because the config schema lives in core, which this package may not import.
  configValidate?: ConfigValidatePortLike
  // The scaffold content lives beside `init` in cli, which this package may not import.
  scaffoldContent?: ConfigScaffoldContentPortLike
  // Field changes merge in a shared write turn; whole files publish over the digest they read.
  configWrite?: ConfigWritePortLike
  // One port, so a host never lists `agent.explain` bound while unable to cite over the catalog.
  capabilityCatalog?: CapabilityCatalogPort
  // Absent or throwing, run reads fail closed.
  readonly secretMask?: MaskFn
}

// Four arms, because each refusal tells a person something different.
export type DraftResolution =
  | { readonly kind: 'parsed'; readonly draft: ParsedDraftLike }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'outside-workspace' }
  | { readonly kind: 'unparsable'; readonly reason: string }

// Takes the resolved draft so the suite comparison excludes the draft's own identity.
export interface DraftEvaluationPort {
  resolveDraft(draftPath: string): Promise<DraftResolution>
  openEvaluation(draft: ParsedDraftLike): Promise<EvaluateDraftPorts>
}

// Typed against the schema contracts, so this layer does not depend on how a turn is assembled.
export interface ChatTurnPort {
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}
