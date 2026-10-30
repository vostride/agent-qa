// `packages/agent` may not touch `node:*`, so every host port is built here, once, for both hosts.

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canaryOutcomeObservationId, planMarkEvidence, projectMarkEvidenceOutcome } from '@vostride/agent-qa-knowledge-local/reader'
import {
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
  CHAT_HELP_TEXT,
  CHAT_RESOLVER_TABLE,
  createAgentJobQueue,
  createChatCompactionHook,
  createChatState,
  createFunctionRegistry,
  createPlannerStage,
  createRealJobKindRegistry,
  createTurnEngine,
  deterministicOverrideStrategy,
  foldFunctionResult,
  invokeFunction,
  projectPlannerTools,
  RUNS_START_FUNCTION_ID,
  replayToModelMessages,
  splitClauses,
} from '@vostride/agent-qa-agent'
import type {
  AgentJobQueue,
  AuthoringFunnelPortLike,
  CapabilityCatalogPort,
  ChatConfigState,
  ChatDirectiveHandlers,
  ChatLanguageModel,
  ChatStateContainer,
  ChatStateSnapshot,
  ChatTokenAccounting,
  CompactionHook,
  LiveViewPort,
  PlannerStagePort,
  RunDetailReaderPort,
  ReconcileStrategy,
  AnalysisArtifactReaderPort,
  ClockPort,
  ConfigFilesPortLike,
  ConfigReaderPort,
  ConfigScaffoldContentPortLike,
  ConfigValidatePortLike,
  EntityDirectoryPort,
  FunctionDeps,
  FunctionRegistry,
  JobIdSource,
  JobKindRegistry,
  JobModelCapability,
  KnowledgeReaderPort,
  PostRunJobCapabilities,
  RecurrenceLadder,
  RecurrenceProvider,
  RunInvocationPort,
  RunsReaderPort,
  StartedRun,
  StepEvidenceAddress,
  StepEvidenceLookup,
} from '@vostride/agent-qa-agent'
import {
  ADDRESSING_LEDGER_DB_FILE,
  acquireEmbedder,
  acquireWriterLease,
  classifyIndexFace,
  countPendingCurationJobs,
  createMemorySightingSource,
  createLocalKnowledgeStore,
  createQuarantineOperations,
  QUARANTINE_FLAG_FLOOR,
  describeAllEntities,
  embedPendingEntities,
  countRemainingCurationWork,
  deriveWriterLeaseFreshness,
  drainQueue,
  DRAIN_BUDGET_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  enqueueCurationCandidateProjection,
  failureRecurrence,
  fingerprintRecurrence,
  listTestsInFile,
  foldQuarantineLedgerState,
  foldRetrievalRung,
  foldRunOutcomes,
  createDraftReceiptsStore,
  createSuiteFingerprintIndex,
  indexDbPath,
  readQuarantineLedger,
  readTestOutcomeHistory,
  getEntityDescriptor,
  heartbeatLease,
  inspectDrainableCurationWork,
  isLeaseStale,
  listQueuedCandidates,
  openAddressingLedger,
  openEntityIndex,
  openKnowledgeReader,
  purgeAffectedSetFingerprint,
  probeEmbedderWorkerSocket,
  purgeRecord,
  readCanonicalBundleAnchors,
  readEmbedderWorkerRegistration,
  readWriterLease,
  rebuildIndex,
  reconcileRunOutcomesProjection,
  entityIndexDbPath,
  resolveEntityRef,
  sightEntity,
  refreshWriterLeaseAuthority,
  releaseLease,
  removeEmbedderWorkerRegistration,
  resetEmbedderCapability,
  resolveEmbedderCapability,
  resolveProcessIncarnation,
  verifyEmbedderWorkerIncarnation,
  resolvePurgeAffectedSet,
  resolveRollbackAffectedSet,
  rollbackAffectedSetFingerprint,
  rollbackCampaign,
  rollbackCurationJob,
  runMaintenanceTail,
  sweepEntityIndex,
  RUN_OUTCOMES_PROJECTION_VERSION,
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
  type EmbedderWorkerRegistration,
  type EntityIndexSweepReport,
  type ResolveEntityRefDeps,
  applyExplicitReview,
  appendMarkEvidence,
  triageMark,
  servedIdsOn,
  procedureReadOn,
  applyFeedback,
  enumerateBundleDirs,
  loadBundle,
  verifyBundleIntegrity,
  createAuthoringReader,
  openAddressingLedger as openAddressingLedgerForReview,
  resolveRetrievalRung,
} from '@vostride/agent-qa-knowledge-local'
import type {
  ExplicitReviewDelegate,
  ExplicitReviewRequest,
  ExplicitReviewResult,
  CreateLocalKnowledgeStoreConfig,
} from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeReviewPort } from '@vostride/agent-qa-agent'
import type { FeedbackPort, FeedbackReadsPort } from '@vostride/agent-qa-schema'
import type { ArtifactRef } from '@vostride/agent-qa-schema'
import type { ServedRecordFacts } from '@vostride/agent-qa-knowledge-local'
export type { ServedRecordFacts, MarkTriage, ApplyFeedbackInput } from '@vostride/agent-qa-knowledge-local'
import { ReplayIncompleteError } from '@vostride/agent-qa-runner'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import {
  ARTIFACT_FILE,
  FsEventLog,
  FsEvidenceArtifactStore,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  admitAnalysisArtifactForRun,
  ANALYSIS_FILE,
  asJobId,
  DEFAULT_EMBEDDING_PROFILE,
  guardRunAnalysisArtifact,
  maskPayloadTree,
  sha256hex16,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringBrief,
  AuthoringVerifyDraftInput,
  ChatSessionEvent,
  ChatSessionHandle,
  CompletedRunHandoff,
  DraftReceipt,
  ExecutionContext,
  GateReceipt,
  GateReceiptRecordOutcome,
  KnowledgeChangeOutput,
  KnowledgeChangeVerb,
  MaskFn,
  PromotionOutcome,
  RecordId,
  FunctionCaller,
  JobKind,
  QuarantineEntryStateName,
  QuarantineLadderState,
  RecordedTargets,
  RunEventEnvelope,
  RunId,
  RunStartAcknowledgement,
  TestEditPatchSet,
  TestFileWrite,
  RunsStartInput,
  ScopeKey,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import { createKnowledgeReaderPort } from './knowledge-review-reader.js'
import type { SightMemoryEntities } from './knowledge-review-reader.js'
import { createEvidenceBlobReader, readEvidenceBlobBytes } from './evidence-blob-reader.js'
import { buildRunPorts } from './run-composition.js'
import type { RetrievalRungResolver } from './run-composition.js'
import { writeAnalysisArtifact } from '../analysis/persist-analysis.js'
import { createJsonlSessionLog } from '../session/jsonl-session-log.js'
import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { createPostProcessingReader } from '../store/post-processing-reader.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'

// The one file naming the writer-gated entry; reader-carveout fails on a second or on none.

// `run-composition.ts` takes this as an input, so the resolver keeps one importer of its package.
export const resolveHostRetrievalRung: RetrievalRungResolver = resolveRetrievalRung

// Read-only probes, so a diagnostic gets both axes without a second fold or any mutation.
export interface LocalKnowledgeProbeCapabilities {
  readonly classifyIndexFace: typeof classifyIndexFace
  readonly foldRetrievalRung: typeof foldRetrievalRung
  readonly indexDbPath: typeof indexDbPath
  readonly readEmbedderWorkerRegistration: typeof readEmbedderWorkerRegistration
  readonly readWriterLease: typeof readWriterLease
  readonly resolveEmbedderCapability: typeof resolveEmbedderCapability
}

export const LOCAL_KNOWLEDGE_PROBES: LocalKnowledgeProbeCapabilities = Object.freeze({
  classifyIndexFace,
  foldRetrievalRung,
  indexDbPath,
  readEmbedderWorkerRegistration,
  readWriterLease,
  resolveEmbedderCapability,
})

// The probe vocabulary the three doctor rows are typed against, re-exported through the same one
// edge. Types are erased, so this hands a caller no power the frozen table above does not.
export type {
  AcquireEmbedderOutcome,
  IndexFace,
  ReadEmbedderWorkerRegistrationOutcome,
  ResolveEmbedderCapabilityOptions,
} from '@vostride/agent-qa-knowledge-local'

// The delegate transport's vocabulary, re-exported through the edge that names the writer entry.
export type {
  ExplicitReviewDelegate,
  ExplicitReviewDelegation,
  ExplicitReviewRequest,
  ExplicitReviewResult,
} from '@vostride/agent-qa-knowledge-local'

export type {
  AcquireWriterLeaseOutcome,
  AuthorOutcome,
  AuthoringTestRef,
  CurationCandidateProjection,
  CurationJobView,
  CurationProjectionArtifactSource,
  CuratorAuthor,
  EnqueueCurationCandidateProjectionOutcome,
  HeartbeatLeaseOutcome,
  LeaseOperationOptions,
  NeighborRecord,
  OpenServingKnowledgeReaderConfig,
  PurgeAffectedSet,
  PurgeReceipt,
  RebuildReport,
  ReadWriterLeaseOutcome,
  ReleaseLeaseOutcome,
  RollbackAffectedSet,
  RollbackCampaignInput,
  RollbackCurationJobInput,
  RollbackReport,
  WriterLease,
  WriterLeaseAuthority,
  WriterLeaseFreshness,
} from '@vostride/agent-qa-knowledge-local'

// Surface hosts reach worker lifecycle vocabulary through this one legal composition edge.
export {
  // Re-exported so the post-run tail and the curation drain share one bound.
  DRAIN_BUDGET_MS,
  EMBEDDER_WORKER_REGISTRATION_FILE,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  EmbedderWorkerTimeoutError,
  // The projection's maintenance cadence reaches the daemon host through the same one edge.
  ENTITY_INDEX_SWEEP_INTERVAL_MS,
}

/**
 * The standing daemon's writer-authority substrate, published through the same one composition
 * edge as every other local writer capability. Surface packages may import agent-local, but the
 * architecture firewall deliberately forbids them from naming knowledge-local or safety
 * directly; keeping this frozen table here preserves that boundary without duplicating lease
 * behavior in the CLI host.
 */
export interface LocalDaemonCapabilities {
  readonly acquireWriterLease: typeof acquireWriterLease
  readonly heartbeatLease: typeof heartbeatLease
  readonly releaseLease: typeof releaseLease
  readonly readWriterLease: typeof readWriterLease
  readonly isLeaseStale: typeof isLeaseStale
  // Recoverability reads this verdict, not the lease file, and must handle `unknown` explicitly.
  readonly deriveWriterLeaseFreshness: typeof deriveWriterLeaseFreshness
  readonly countPendingCurationJobs: typeof countPendingCurationJobs
  readonly countRemainingCurationWork: typeof countRemainingCurationWork
  readonly inspectDrainableCurationWork: typeof inspectDrainableCurationWork
  readonly listQueuedCandidates: typeof listQueuedCandidates
  readonly acquireEmbedder: typeof acquireEmbedder
  readonly drainQueue: typeof drainQueue
  readonly runMaintenanceTail: typeof runMaintenanceTail
  readonly resolveEmbedderWorkerEntryPath: () => string
  readonly readEmbedderWorkerRegistration: typeof readEmbedderWorkerRegistration
  readonly embedderWorkerProcessIsAlive: typeof embedderWorkerProcessIsAlive
  readonly embedderWorkerSocketPath: typeof embedderWorkerSocketPath
  readonly probeEmbedderWorkerSocket: typeof probeEmbedderWorkerSocket
  // No surface may signal a registered worker pid unless this verdict is `match`.
  readonly verifyEmbedderWorkerIncarnation: typeof verifyEmbedderWorkerIncarnation
  // A run owner's start time, read for the CLI's `runs.db` ownership.
  readonly resolveProcessIncarnation: typeof resolveProcessIncarnation
  readonly removeEmbedderWorkerRegistration: (
    agentQaRoot: string,
    expected: EmbedderWorkerRegistration,
  ) => ReturnType<typeof removeEmbedderWorkerRegistration>
  readonly resetEmbedderCapability: () => void
  readonly pinLocalHeadlessExecutionContext: () => void
}

function resolveEmbedderWorkerEntryPath(): string {
  const requireBase = typeof __filename === 'string'
    ? __filename
    : import.meta.url
  const knowledgeEntry = createRequire(requireBase).resolve('@vostride/agent-qa-knowledge-local')
  return join(dirname(knowledgeEntry), 'embedder-worker', 'worker-entry.js')
}

export const LOCAL_DAEMON_CAPABILITIES: LocalDaemonCapabilities = Object.freeze({
  acquireWriterLease,
  heartbeatLease,
  releaseLease,
  readWriterLease,
  deriveWriterLeaseFreshness,
  isLeaseStale,
  countPendingCurationJobs,
  countRemainingCurationWork,
  inspectDrainableCurationWork,
  listQueuedCandidates,
  acquireEmbedder,
  drainQueue,
  runMaintenanceTail,
  resolveEmbedderWorkerEntryPath,
  readEmbedderWorkerRegistration,
  embedderWorkerProcessIsAlive,
  embedderWorkerSocketPath,
  probeEmbedderWorkerSocket,
  verifyEmbedderWorkerIncarnation,
  resolveProcessIncarnation,
  removeEmbedderWorkerRegistration,
  resetEmbedderCapability: () => resetEmbedderCapability(DEFAULT_EMBEDDING_PROFILE),
  pinLocalHeadlessExecutionContext: () => {
    setActiveExecutionContextResolver(() => 'local-headless')
  },
})

/**
 * Index maintenance and the campaign/job rollback verbs, plus the lease every one of them is only
 * legal to hold under. Grouped rather than flattened because they share that precondition: a host
 * reaching for `purgeRecord` without a lease is the mistake the grouping makes visible.
 */
export interface LocalKnowledgeMaintenanceCapabilities {
  readonly acquireWriterLease: typeof acquireWriterLease
  readonly refreshWriterLeaseAuthority: typeof refreshWriterLeaseAuthority
  readonly releaseLease: typeof releaseLease
  readonly rebuildIndex: typeof rebuildIndex
  readonly purgeRecord: typeof purgeRecord
  readonly resolvePurgeAffectedSet: typeof resolvePurgeAffectedSet
  readonly purgeAffectedSetFingerprint: typeof purgeAffectedSetFingerprint
  readonly rollbackCampaign: typeof rollbackCampaign
  readonly rollbackCurationJob: typeof rollbackCurationJob
  readonly resolveRollbackAffectedSet: typeof resolveRollbackAffectedSet
  readonly rollbackAffectedSetFingerprint: typeof rollbackAffectedSetFingerprint
}

interface ReceiptWriterInput extends Pick<CreateLocalKnowledgeStoreConfig,
  'knowledgeRoot' | 'executionContext' | 'sourceBuildOrdinal' | 'sourceRunId'> {
  /** The caller already holds this authority; these capabilities never acquire a lease. */
  lease: { leaseId: string; epoch: number }
}

export interface RecordGateReceiptInput extends ReceiptWriterInput {
  receipt: GateReceipt
}

export interface PromoteWithReceiptsInput extends ReceiptWriterInput {
  candidateId: RecordId
  receipts?: readonly GateReceipt[]
}

function receiptWriter(input: ReceiptWriterInput) {
  return createLocalKnowledgeStore({
    knowledgeRoot: input.knowledgeRoot,
    executionContext: input.executionContext,
    writerLeaseId: input.lease.leaseId,
    epoch: input.lease.epoch,
    ...(input.sourceBuildOrdinal === undefined ? {} : { sourceBuildOrdinal: input.sourceBuildOrdinal }),
    ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
  })
}

function recordGateReceipt(input: RecordGateReceiptInput): Promise<GateReceiptRecordOutcome> {
  return receiptWriter(input).recordGateReceipt(input.receipt)
}

function promoteWithReceipts(input: PromoteWithReceiptsInput): Promise<PromotionOutcome> {
  return receiptWriter(input).promote(input.candidateId, input.receipts)
}

/** Internal facts only: public showRecord deliberately omits bundle construction fields. */
function readFeedbackRecord(input: { knowledgeRoot: string; recordId: string; evidenceRef?: ArtifactRef }): ServedRecordFacts | undefined {
  const matches = enumerateBundleDirs(input.knowledgeRoot).flatMap(entry => {
    const result = loadBundle(entry.dir)
    return result.kind === 'loaded' && result.bundle.manifest.id === input.recordId
      && verifyBundleIntegrity(entry.dir).ok ? [result.bundle] : []
  })
  if (matches.length !== 1) return undefined
  const bundle = matches[0]!
  const artifact = input.evidenceRef ?? bundle.artifactsIndex.artifacts[0]
  if (artifact === undefined) return undefined
  return { recordId: input.recordId, kind: bundle.frontmatter.kind,
    ...(bundle.frontmatter.subtype === undefined ? {} : { subtype: bundle.frontmatter.subtype }),
    anchors: bundle.frontmatter.anchors.map(anchor => anchor.raw), scope: bundle.frontmatter.scope,
    summary: bundle.summary, distilledEvidenceRef: { id: artifact.id, sha: artifact.sha },
    // This is the only admitted draft construction stage; user origin belongs on the delta.
    originStage: 'run-curation' }
}

export interface LocalCurationCapabilities {
  readonly readFeedbackRecord: typeof readFeedbackRecord
  readonly appendMarkEvidence: typeof appendMarkEvidence
  // The lease-free planning half of `appendMarkEvidence`, so a preview runs without the writer.
  readonly planMarkEvidence: typeof planMarkEvidence
  readonly projectMarkEvidenceOutcome: typeof projectMarkEvidenceOutcome
  readonly triageMark: typeof triageMark
  readonly servedIdsOn: typeof servedIdsOn
  readonly procedureReadOn: typeof procedureReadOn
  readonly applyFeedback: typeof applyFeedback
  readonly recordGateReceipt: typeof recordGateReceipt
  readonly promoteWithReceipts: typeof promoteWithReceipts
  /** Serving-side reader the tail folds against; read-only despite arriving on the writer edge. */
  readonly openKnowledgeReader: typeof openKnowledgeReader
  readonly drainQueue: typeof drainQueue
  readonly foldRunOutcomes: typeof foldRunOutcomes
  // A version bump refolds through this rebuild, invoked per CLI tail sweep and per daemon lease.
  readonly reconcileRunOutcomesProjection: typeof reconcileRunOutcomesProjection
  readonly enqueueCurationCandidateProjection: typeof enqueueCurationCandidateProjection
  readonly readCanonicalBundleAnchors: typeof readCanonicalBundleAnchors
  // Reuses the writer's observation identity through the CLI bridge.
  readonly canaryOutcomeObservationId: typeof canaryOutcomeObservationId
  /**
   * Component of the tail's receipt: a bump refolds runs already receipted at the old version.
   * The receipt is the per-run half of that promise; `reconcileRunOutcomesProjection` above is
   * the half that actually re-derives the rows.
   */
  readonly runOutcomesProjectionVersion: typeof RUN_OUTCOMES_PROJECTION_VERSION
  readonly maintenance: LocalKnowledgeMaintenanceCapabilities
}

export const LOCAL_CURATION_CAPABILITIES: LocalCurationCapabilities = Object.freeze({
  readFeedbackRecord,
  appendMarkEvidence,
  planMarkEvidence,
  projectMarkEvidenceOutcome,
  triageMark,
  servedIdsOn,
  procedureReadOn,
  applyFeedback,
  recordGateReceipt,
  promoteWithReceipts,
  openKnowledgeReader,
  drainQueue,
  foldRunOutcomes,
  reconcileRunOutcomesProjection,
  enqueueCurationCandidateProjection,
  readCanonicalBundleAnchors,
  runOutcomesProjectionVersion: RUN_OUTCOMES_PROJECTION_VERSION,
  canaryOutcomeObservationId,
  maintenance: Object.freeze({
    acquireWriterLease,
    refreshWriterLeaseAuthority,
    releaseLease,
    rebuildIndex,
    purgeRecord,
    resolvePurgeAffectedSet,
    purgeAffectedSetFingerprint,
    rollbackCampaign,
    rollbackCurationJob,
    resolveRollbackAffectedSet,
    rollbackAffectedSetFingerprint,
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTargetName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// The target names a run recorded in its untrusted `artifact.json`. Anything but a non-empty list
// of non-empty names answers `unknown`, so a run recorded without them never reads as recorded.
function recordedTargetsOf(artifact: unknown): RecordedTargets {
  const targets = isRecord(artifact) ? artifact.targets : undefined
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(isTargetName)) {
    return { status: 'unknown' }
  }
  return { status: 'recorded', names: [...new Set(targets)].sort() }
}

/**
 * Enumerate `<agentQaRoot>/runs/<slug>/handoff.json`. A project with no runs directory is an
 * ordinary empty result, not an error; an individual unreadable or version-rejected document is
 * skipped so one bad run never hides every other run.
 */
export function createRunsReader(agentQaRoot: string): RunsReaderPort {
  function enumerate(): CompletedRunHandoff[] {
    const runsDir = join(agentQaRoot, RUNS_SUBDIR)
    if (!existsSync(runsDir)) return []

    const documents: CompletedRunHandoff[] = []
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const handoffPath = join(runsDir, entry.name, HANDOFF_FILE)
      if (!existsSync(handoffPath)) continue
      try {
        documents.push(loadCompletedRunHandoff(handoffPath))
      } catch {
        continue
      }
    }
    return documents
  }

  return {
    list(): Promise<readonly CompletedRunHandoff[]> {
      return Promise.resolve(enumerate())
    },
    // Matches the recorded `runId` over enumerated documents, so `../../etc` addresses nothing.
    get(runId: RunId): Promise<CompletedRunHandoff | undefined> {
      return Promise.resolve(enumerate().find((document) => document.runId === runId))
    },
    // A resume point below the earliest surviving seq throws `ReplayIncompleteError`.
    readEvents(runId: RunId, fromSeq: number): Promise<readonly RunEventEnvelope[]> {
      const recorded = [...new FsEventLog({ root: agentQaRoot, runId }).read(0)]
        .sort((left, right) => left.seq - right.seq)
      if (recorded.length === 0) return Promise.resolve([])

      const earliestAvailableSeq = recorded[0]!.seq
      if (fromSeq < earliestAvailableSeq) {
        return Promise.reject(new ReplayIncompleteError(fromSeq, earliestAvailableSeq))
      }
      return Promise.resolve(recorded.filter((event) => event.seq >= fromSeq))
    },
    // Read through the version guard; an ambiguous step reports its candidates instead of guessing.
    readStepEvidence(runId: RunId, address: StepEvidenceAddress): Promise<StepEvidenceLookup> {
      const document = enumerate().find((candidate) => candidate.runId === runId)
      if (document === undefined) return Promise.resolve({ kind: 'run-not-recorded' })

      const candidates = document.tests.filter((test) => (
        (address.testId === undefined || test.testId === address.testId)
        && test.steps.some((step) => step.stepIndex === address.stepIndex)
      ))
      if (candidates.length === 0) return Promise.resolve({ kind: 'step-not-found' })
      if (candidates.length > 1) {
        return Promise.resolve({
          kind: 'ambiguous-step-address',
          // Sorted, so the refusal a surface prints is the same list twice running.
          testIds: candidates.map((test) => test.testId).sort(),
        })
      }

      const evidence = candidates[0]!.steps.find((step) => step.stepIndex === address.stepIndex)
      return Promise.resolve(
        evidence === undefined
          ? { kind: 'step-not-found' }
          : { kind: 'found', evidence },
      )
    },
    // The caller's id is compared, never joined onto a path; an absent snapshot is `unknown`.
    getRecordedTargets(runId: RunId): Promise<RecordedTargets> {
      const runsDir = join(agentQaRoot, RUNS_SUBDIR)
      if (!existsSync(runsDir)) return Promise.resolve({ status: 'unknown' })

      const entry = readdirSync(runsDir, { withFileTypes: true })
        .find((candidate) => candidate.isDirectory() && candidate.name === runId)
      if (entry === undefined) return Promise.resolve({ status: 'unknown' })

      try {
        const runDir = join(runsDir, entry.name)
        if (loadCompletedRunHandoff(join(runDir, HANDOFF_FILE)).runId !== runId) {
          return Promise.resolve({ status: 'unknown' })
        }
        return Promise.resolve(
          recordedTargetsOf(JSON.parse(readFileSync(join(runDir, ARTIFACT_FILE), 'utf8'))),
        )
      } catch {
        return Promise.resolve({ status: 'unknown' })
      }
    },
  }
}

// The read verbs live in the reader carve-out; only the sighting site, which mints, stays here.
export function createKnowledgeReader(
  resolveKnowledgeRoot: () => Promise<string> | string,
  sightMemoryEntities?: SightMemoryEntities,
): KnowledgeReaderPort {
  return createKnowledgeReaderPort({
    resolveKnowledgeRoot,
    ...(sightMemoryEntities === undefined ? {} : { sightMemoryEntities }),
  })
}

// ---- knowledge review: the WRITE half of the verb family --------

export interface CreateKnowledgeReviewInput {
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => Promise<string> | string
  // The lease this host holds: a holder cannot acquire it twice, and supplies no delegate.
  readonly resolveWriterAuthority?: () => { readonly leaseId: string; readonly epoch: number } | undefined
  // How a direct change reaches a live lease holder; absent, a held lease refuses it by name.
  readonly knowledgeChangeDelegate?: ExplicitReviewDelegate
  // The context a change is recorded under; absent means the process resolver.
  readonly resolveExecutionContext?: () => ExecutionContext
}

/** The public answer to one direct change, from the explicit writer's own result. */
function knowledgeChangeOutput(
  verb: KnowledgeChangeVerb,
  operationId: string,
  result: ExplicitReviewResult,
): KnowledgeChangeOutput {
  switch (result.outcome) {
    case 'applied':
      return {
        outcome: 'applied',
        verb,
        operationId,
        recordIds: [...result.recordIds],
        ...(result.forgetReceipt === undefined ? {} : { forgetReceipt: result.forgetReceipt }),
        ...(result.commitReceipt === undefined ? {} : { commitReceipt: result.commitReceipt }),
      }
    case 'target-not-found':
      return { outcome: 'target-not-found', verb, operationId, target: result.target }
    case 'policy-materialize-refused':
      return { outcome: 'refused', verb, operationId, reason: 'policy-materialize-refused' }
    default:
      return result satisfies never
  }
}

/**
 * Bind the mutating review verbs over the review modules and the Curator's one commit path.
 *
 * A SEPARATE factory from `createKnowledgeReader`, mirroring the port split it implements: this
 * is the object whose presence makes accept/reject/forget report `bound`, and a host that wants
 * only the read verbs simply does not build one. The `MEM-` short-ID leg resolves through the
 * addressing ledger, opened per call and closed again on exactly the reasoning the entity
 * directory uses — a durable file the composition root owns, never a handle a review module holds.
 */
export function createKnowledgeReview(input: CreateKnowledgeReviewInput): KnowledgeReviewPort {
  async function roots(): Promise<{ knowledgeRoot: string }> {
    return { knowledgeRoot: await input.resolveKnowledgeRoot() }
  }

  // One change at a time, or two in-process changes find the lease held by each other and refuse.
  let changeChain: Promise<unknown> = Promise.resolve()
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = changeChain.then(work, work)
    changeChain = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    // A missing identity is minted once per call and returned, so a retry is the same change.
    change: (request) => serialized(async () => {
      const { knowledgeRoot } = await roots()
      const operationId = request.operationId ?? randomUUID()
      const authority = input.resolveWriterAuthority?.()
      const result = await applyKnowledgeChange({
        agentQaRoot: input.agentQaRoot,
        knowledgeRoot,
        request: { verb: request.verb, input: request.input } as ExplicitReviewRequest,
        operationId,
        // The op that made the change, stamped on Gate-3 receipts: `knowledge.accept`,
        // `knowledge.reject` or `knowledge.forget`, which is the verb's own op id.
        opId: `knowledge.${request.verb}`,
        executionContext: (input.resolveExecutionContext ?? getActiveExecutionContext)(),
        ...(input.knowledgeChangeDelegate === undefined ? {} : { delegate: input.knowledgeChangeDelegate }),
        ...(authority === undefined ? {} : { writerAuthority: authority }),
      })
      return knowledgeChangeOutput(request.verb, operationId, result)
    }),
  }
}



// ---- an explicit knowledge change, applied in the call ------------------------

export interface ApplyKnowledgeChangeInput {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly request: ExplicitReviewRequest
  /** The caller's stable identity for this change: a retry with the same identity lands nothing twice. */
  readonly operationId: string
  /** The op making the change, stamped on its Gate-3 receipts. */
  readonly opId: string
  /** The caller's actual context, recorded as-is. An explicit change applies in every context. */
  readonly executionContext: ExecutionContext
  /**
   * How this host reaches a live writer-lease holder. The holder receives exactly the validated
   * request and identity, bounded; the lease is never taken. Absent, a held lease refuses by name.
   */
  readonly delegate?: ExplicitReviewDelegate
  /** The lease this host already holds, when it is the holder. Exclusive with {@link delegate}. */
  readonly writerAuthority?: { readonly leaseId: string; readonly epoch: number }
}

// Nothing is filed: the change is committed through the direct writer, or refused by type.
export async function applyKnowledgeChange(input: ApplyKnowledgeChangeInput): Promise<ExplicitReviewResult> {
  const ledger = openAddressingLedgerForReview({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  try {
    return await applyExplicitReview({
      agentQaRoot: input.agentQaRoot,
      knowledgeRoot: input.knowledgeRoot,
      request: input.request,
      operationId: input.operationId,
      opId: input.opId,
      executionContext: input.executionContext,
      resolveBundleShortId: (shortId) => ledger.lookupByShortId(shortId)?.machineId,
      ...(input.delegate === undefined ? {} : { delegate: input.delegate }),
      ...(input.writerAuthority === undefined ? {} : { writerAuthority: input.writerAuthority }),
    })
  } finally {
    ledger.close()
  }
}

// ---- entities: the addressing ledger and the tier-(a) resolver ----------

export interface CreateEntityDirectoryInput {
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => Promise<string> | string
}

// Opened per call so no ledger file appears early, and closed again because minting is lease-free.
export function createEntityDirectory(input: CreateEntityDirectoryInput): EntityDirectoryPort {
  return {
    resolve(ref) {
      return withEntityResolutionDeps(input, (deps) => resolveEntityRef(ref, deps))
    },
    get(ref) {
      return withEntityResolutionDeps(input, (deps) => getEntityDescriptor(ref, deps))
    },
  }
}

// Sights through the resolver's own `sightEntity` leg, so the list verbs share one minting path.
export function createMemorySightingHook(
  input: CreateEntityDirectoryInput,
): SightMemoryEntities {
  return (bundleIds) => withEntityResolutionDeps(input, (deps) => {
    for (const bundleId of bundleIds) sightEntity(bundleId, deps)
  })
}

/**
 * Open the addressing ledger and the entity-index projection for ONE span, run `body`, close.
 *
 * Shared by the directory port and the list-verb sighting hook so both obey the same open/close
 * law rather than two copies of it.
 */
async function withEntityResolutionDeps<T>(
  input: CreateEntityDirectoryInput,
  body: (deps: ResolveEntityRefDeps) => T | Promise<T>,
): Promise<T> {
  const knowledgeRoot = await input.resolveKnowledgeRoot()
  const ledger = openAddressingLedger({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  // The projection lives under the knowledge root and is disposable; the ledger is never rebuilt.
  const entityIndex = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot), knowledgeRoot })
  try {
    // AWAITED inside the try, not returned from it: tier (b)'s dense leg is asynchronous, so
    // returning the promise would close both databases while the resolution was still using
    // them. The bug is invisible while every caller is synchronous, which is exactly why it
    // is worth the word.
    return await body({
      ledger,
      entityIndex,
      sources: [createMemorySightingSource(() => knowledgeRoot)],
    })
  } finally {
    entityIndex.close()
    ledger.close()
  }
}

export interface SweepEntityIndexInput extends CreateEntityDirectoryInput {
  /**
   * Test seam ONLY. Production omission runs the real acquisition ladder, which is what makes
   * the dense rung appear on hosts that have a model and stay absent on hosts that do not.
   */
  readonly acquireEmbedderCapability?: typeof acquireEmbedder
}

export interface SweepEntityIndexOutcome extends EntityIndexSweepReport {
  /** How many renderings gained a vector this sweep. Zero on a floor host, by design. */
  readonly embedded: number
}

// Takes no writer lease and never writes the ledger, so a one-shot CLI process can run it.
export async function sweepEntityIndexProjection(
  input: SweepEntityIndexInput,
): Promise<SweepEntityIndexOutcome> {
  const knowledgeRoot = await input.resolveKnowledgeRoot()
  const ledger = openAddressingLedger({
    path: join(input.agentQaRoot, ADDRESSING_LEDGER_DB_FILE),
  })
  const entityIndex = openEntityIndex({ path: entityIndexDbPath(knowledgeRoot), knowledgeRoot })
  try {
    const report = sweepEntityIndex(entityIndex, describeAllEntities({
      ledger,
      sources: [createMemorySightingSource(() => knowledgeRoot)],
    }))

    let embedded = 0
    const acquire = input.acquireEmbedderCapability ?? acquireEmbedder
    const capability = await acquire({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      agentQaRoot: input.agentQaRoot,
    })
    if (capability.kind === 'ready') {
      embedded = await embedPendingEntities(
        entityIndex,
        capability.embedder,
        capability.profile,
      )
    }
    return { ...report, embedded }
  } finally {
    entityIndex.close()
    ledger.close()
  }
}

// ---- runs.start: the composition's binding ---------------------------------------------

// A port, because the process model, signals, reporters and exit discipline differ per host.
export interface RunExecutionPort {
  execute(request: RunsStartInput): Promise<StartedRun>
}

// An empty event log means no run took place, because the bus writes `runStarted` first.
export class RunProducedNoEventsError extends Error {
  constructor(readonly runId: string) {
    super(
      `The host reported run ${runId}, but no run events were recorded for it. ` +
        'A run that started at all writes runStarted before anything else, so an empty ' +
        'event log means no run took place under that id.',
    )
    this.name = 'RunProducedNoEventsError'
  }
}

/**
 * Bind `runs.start` over a host's run execution.
 *
 * The composition contributes the half a host must not be trusted with: after the host says a
 * run happened, the run's own durable event log is read back and an empty one is refused. The
 * op then builds its acknowledgment from the completed-run record through the SAME reader
 * `runs.get` answers from, so "the run is real" and "the run is addressable" are one fact.
 */
export function createLocalRunInvocation(input: {
  readonly agentQaRoot: string
  readonly execution: RunExecutionPort
}): RunInvocationPort {
  return {
    async start(request: RunsStartInput): Promise<StartedRun> {
      const started = await input.execution.execute(request)
      const { eventLog } = buildRunPorts({
        configDir: dirname(input.agentQaRoot),
        runId: String(started.runId),
      })
      if (eventLog.read(0).length === 0) {
        throw new RunProducedNoEventsError(String(started.runId))
      }
      return started
    },
  }
}

// ---- authoring.draft.verify: the keep-gate evaluator's binding --------------

/** The stable test identity, spelled once for this binding. */
interface DraftIdentity {
  readonly filePath: string
  readonly testName: string
}

/**
 * A parsed draft, as the HOST hands it over.
 *
 * Structurally identical to `packages/agent`'s `ParsedDraftLike`, and mirrored here rather than
 * imported for the reason every mirror in this graph exists: that type lives inside `agent`'s
 * `authoring/` and is not on its barrel, and publishing it to give a composition a name would put
 * a gate-orchestration type on the surface that publishes exactly one dispatch.
 *
 * `filePath` MUST be the workspace-relative identity the runner records on
 * `PerTestOutcome.filePath` — `workspaceRelativeIdentityPath`, the one spelling of that recipe.
 * Gates 1-2 find the draft's own member inside each run document by comparing against those bytes,
 * so a path spelled any other way makes every gate-run report `absent` for its own draft and gate
 * 1 fail for a join reason wearing a draft reason's clothes.
 */
export interface ParsedDraftDescriptor {
  readonly testId: string
  readonly filePath: string
  readonly testName: string
  // Required: without it, child gate runs hit a name `resolveTarget` throws on.
  readonly target: string
  readonly steps: readonly string[]
  /**
   * The parsed test's `context` block — an EDITABLE root, and therefore one the credential gate
   * scans. Structurally identical to `ParsedDraftLike.context`; a mirror that dropped it would
   * hand `packages/agent` a draft whose context can no longer be screened.
   */
  readonly context?: string
  readonly contentDigest: string
}

// `packages/agent` cannot stat a path, so the host answers each refusal arm and the op names it.
export type DraftParseOutcome =
  | { readonly kind: 'parsed'; readonly draft: ParsedDraftDescriptor }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'outside-workspace' }
  | { readonly kind: 'unparsable'; readonly reason: string }

// One authored suite test as text, for gate 3's degraded lane.
export interface SuiteTextEntry {
  readonly filePath: string
  readonly testName: string
  readonly stepsText: readonly string[]
}

// Both verbs or neither: parse alone leaves gate 3's text lane empty, so a duplicate looks novel.
export interface DraftAuthoringPort {
  parseDraft(filePath: string): Promise<DraftParseOutcome>
  suiteTextCorpus(): Promise<readonly SuiteTextEntry[]>
  // Enumerates and never refuses; a project declaring no targets answers an empty list.
  configuredTargetNames(): Promise<readonly string[]>
  // Throws rather than answering `undefined`, because only the host knows which candidates it saw.
  deriveDefaultScope(): Promise<ScopeKey>
  // Parse before write, in one verb, so an unparsable draft writes nothing.
  stageDraft(contents: string): Promise<DraftStageOutcome>
  // Answers `DraftStageOutcome`, so an unrunnable patched document leaves the shelf untouched.
  applyPatchesToDraft(
    draft: ParsedDraftDescriptor,
    patchSet: TestEditPatchSet,
  ): Promise<DraftStageOutcome>
  // Checks the boundary and the read bytes, writes via a sibling temp and a rename, runs no git.
  publishDraft(request: DraftPublishRequest): Promise<TestFileWrite>
}

/** One draft to write: its shelf path, its target, and what the target held when it was read. */
export interface DraftPublishRequest {
  readonly draftPath: string
  readonly targetPath: string
  readonly sourceDigest?: string
}

/**
 * What staging produced: a parsed draft that IS on the shelf, or a refusal that wrote nothing.
 *
 * Structurally the mirror of `agent`'s `DraftStageOutcome`, on this file's own mirror discipline
 * — that type lives inside `agent`'s `authoring/` and the value crossing this seam is assignable
 * to it unchanged.
 */
export type DraftStageOutcome =
  | { readonly kind: 'staged'; readonly draft: ParsedDraftDescriptor }
  | { readonly kind: 'unparsable'; readonly reason: string }

/** The suite comparison, materialized once per evaluation. */
interface FingerprintSnapshot {
  readonly union: ReadonlySet<string>
  readonly covered: readonly DraftIdentity[]
  readonly elements: ReadonlyMap<string, readonly string[]>
}

const EMPTY_FINGERPRINT_SNAPSHOT: FingerprintSnapshot = {
  union: new Set<string>(),
  covered: [],
  elements: new Map<string, readonly string[]>(),
}

// Spelled as the escape `\u0000`: a raw control byte makes `grep` treat the file as data.
function draftIdentityKey(identity: DraftIdentity): string {
  return `${identity.filePath}\u0000${identity.testName}`
}

// Excludes the draft's own identity before the union, or gate 3 compares the draft to itself.
function readSuiteFingerprints(
  knowledgeRoot: string,
  product: string,
  draft: DraftIdentity,
): FingerprintSnapshot {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return EMPTY_FINGERPRINT_SNAPSHOT
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const index = createSuiteFingerprintIndex(db, { product })
    const draftKey = draftIdentityKey(draft)
    const covered = index
      .coveredTests()
      .filter((identity) => draftIdentityKey(identity) !== draftKey)
    const elements = new Map<string, readonly string[]>()
    const union = new Set<string>()
    for (const identity of covered) {
      const own = index.elementsForTest(identity.filePath, identity.testName)
      elements.set(draftIdentityKey(identity), own)
      for (const element of own) union.add(element)
    }
    return { union, covered, elements }
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return EMPTY_FINGERPRINT_SNAPSHOT
    }
    throw error
  } finally {
    db.close()
  }
}

interface DraftEvaluationBindingInput {
  readonly authoring: DraftAuthoringPort
  readonly agentQaRoot: string
  readonly knowledgeRoot: () => Promise<string> | string
  /** The SAME reader `runs.get` answers from — see below. */
  readonly readRun: (runId: string) => Promise<CompletedRunHandoff | undefined>
  // Dispatches one gate-run through the real `runs.start` op.
  readonly startGateRun: (request: RunsStartInput) => Promise<RunStartAcknowledgement>
  // The same object `authoring.funnel.get` binds, so gate 2 reads no second projection.
  readonly authoringFunnel: AuthoringFunnelPortLike
}

// Gate runs go through the `runs.start` op, whose acknowledgment reads the run's own record.
function createDraftEvaluation(input: DraftEvaluationBindingInput) {
  return {
    resolveDraft(draftPath: string): Promise<DraftParseOutcome> {
      return input.authoring.parseDraft(draftPath)
    },
    async openEvaluation(draft: ParsedDraftDescriptor) {
      const knowledgeRoot = await input.knowledgeRoot()
      const draftIdentity: DraftIdentity = {
        filePath: draft.filePath,
        testName: draft.testName,
      }
      const draftKey = draftIdentityKey(draftIdentity)
      // The authored universe MINUS the draft itself. Handed its own bytes to compare against,
      // the text lane scores 1.0 and reads the draft as already covered — by itself.
      const textCorpus = (await input.authoring.suiteTextCorpus()).filter(
        (entry) => draftIdentityKey(entry) !== draftKey,
      )

      let observedProduct: string | undefined
      let snapshot: FingerprintSnapshot | undefined
      const fingerprints = (): FingerprintSnapshot => {
        if (snapshot !== undefined) return snapshot
        snapshot = observedProduct === undefined
          ? EMPTY_FINGERPRINT_SNAPSHOT
          : readSuiteFingerprints(knowledgeRoot, observedProduct, draftIdentity)
        return snapshot
      }

      return {
        runs: {
          async start(request: RunsStartInput): Promise<RunStartAcknowledgement> {
            const acknowledgement = await input.startGateRun(request)
            observedProduct ??= slugBranch(acknowledgement.scope.key)
            return acknowledgement
          },
          get: (runId: string) => input.readRun(runId),
        },
        fingerprints: {
          elementUnion: () => fingerprints().union,
          coveredTests: () => fingerprints().covered,
          elementsForTest: (filePath: string, testName: string) =>
            fingerprints().elements.get(draftIdentityKey({ filePath, testName })) ?? [],
        },
        textCorpus,
        // Receipts are machine-local working state under the runtime root, not committed artifacts.
        receipts: createDraftReceiptsStore({ resolveAgentQaRoot: () => input.agentQaRoot }),
        // `product` is gate 3's observed product: stability and the index ask about one app.
        suiteStability: {
          port: input.authoringFunnel,
          product: () => observedProduct,
        },
      }
    },
  }
}

// `origin: agent`, because the runs answering a verify request are the system's own doing.
const AUTHORING_GATE_RUN_CALLER: FunctionCaller = Object.freeze({
  surface: 'authoring',
  origin: 'agent',
})

// No second caller for `runs.start`: every gate-run starts inside `authoring.draft.verify`.
const AUTHORING_LOOP_VERIFY_CALLER: FunctionCaller = Object.freeze({
  surface: 'authoring',
  origin: 'agent',
})

/** Wall-clock in the one format every store column and dump row is written in. */
export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  now: (): string => new Date().toISOString(),
})

/**
 * Job ids are derived from `(kind, idempotencyKey)` rather than minted at random, so two hosts
 * enqueuing the same logical work address the same row and the store's unique index has something
 * stable to deduplicate on.
 */
const digestJobIdSource: JobIdSource = {
  jobIdFor: (kind, idempotencyKey) =>
    asJobId(`job_${sha256hex16(`${kind} ${idempotencyKey}`)}`),
}
export const DIGEST_JOB_ID_SOURCE: JobIdSource = Object.freeze(digestJobIdSource)

// The concrete sqlite store, because the host that opened the database closes and dumps it.
export interface LocalAgentJobs {
  readonly queue: AgentJobQueue
  readonly store: SqliteJobStore
  readonly kinds: JobKindRegistry
  /** The capability the queue was constructed with, exposed so a host can assert what it bound. */
  readonly model: JobModelCapability
  /**
   * The id source the queue was constructed with.
   *
   * Exposed because a caller that watches this queue's outcomes must be able to derive the same
   * ids the enqueue addressed — the push half of a run's chip trail and the pull half of its
   * status have to agree about which rows belong to which run. Publishing the SOURCE makes that
   * agreement structural; re-deriving a default at the call site would make it a convention, and
   * a convention is exactly what breaks the first time a host is composed with a different one.
   */
  readonly idSource: JobIdSource
  /**
   * The kind exclusion the queue was constructed with, resolved from
   * `UNCLAIMABLE_BY_PROSE_POSTURE` and published for the same stated reason `idSource` is:
   * a caller that must assert what its queue was constructed with should read the value
   * rather than re-derive a default. Empty when the host declared `'masker-active'` or was
   * composed with no `postRun` at all.
   */
  readonly unclaimableKinds: readonly JobKind[]
}

/** Refusal returned when durable capabilities are requested after their composition was closed. */
export class LocalAgentClosedError extends Error {
  override readonly name = 'LocalAgentClosedError'

  constructor(readonly agentQaRoot: string) {
    super(
      `The local agent composition for ${agentQaRoot} is closed. A closed composition cannot `
      + 'reopen its job store; create a new composition with fresh lifecycle ownership instead.',
    )
  }
}

export interface LocalAgentHost {
  /** The function registry with every seed capability bound over local storage. */
  readonly registry: FunctionRegistry
  // Present on every host, or `agent.ask` would be bound with its state absent.
  readonly chat: LocalAgentChatSession
  /** The knowledge-writer powers this host grants — the same frozen object for every host. */
  readonly curation: LocalCurationCapabilities
  /** The clock every store column, dump row and audit stamp in this host is written against. */
  readonly clock: ClockPort
  /**
   * Open (once) the durable job queue and its sqlite store over this host's runtime root.
   *
   * A method rather than an eager member, and the reason is a behaviour rather than a taste:
   * constructing the store CREATES `<agentQaRoot>/agent-jobs.db` and the checkpoint directory. A
   * host that only lists the registry — `agent-qa fn --list` is exactly that — would otherwise
   * bring a queue database into existence in a project that has never enqueued anything. Repeated
   * calls return the same instance, so "opened once" is a property of the handle and not of the
   * caller's discipline.
   */
  jobs(): Promise<LocalAgentJobs>
  /** Close whatever was opened and join an open already in flight. Idempotent. */
  close(): Promise<void>
}

// Required wherever `postRun` is supplied, so the typechecker makes each host state its masking.
export type CandidateProsePosture = 'masker-active' | 'no-masker'

// A total `Record`, so a third posture cannot compile unmapped; `unclaimableKinds` derives from it.
export const UNCLAIMABLE_BY_PROSE_POSTURE: Record<CandidateProsePosture, readonly JobKind[]>
  = Object.freeze({
    // Frozen deep, because the inner arrays are what the queue claims against.
    'masker-active': Object.freeze([]),
    'no-masker': Object.freeze(['curate-memory'] as const),
  })

export interface ComposeLocalAgentInput {
  // The declared-secret mask for chat projections and run reads.
  readonly mask: MaskFn
  readonly feedback?: FeedbackPort
  // Absent leaves `runs.marks.history` and `runs.mark.preview` unbound by name.
  readonly feedbackReads?: FeedbackReadsPort
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  // Injected because flattening and masking need the host's loader, and masking is its boundary.
  readonly config: ConfigReaderPort
  /** Resolves the knowledge root this invocation serves from. See `createKnowledgeReader`. */
  readonly knowledgeRoot: () => Promise<string> | string
  // A required factory: the queue needs a model, and resolving one costs a config and auth read.
  readonly model: () => JobModelCapability | Promise<JobModelCapability>
  // Optional: a host without it lists `runs.start` as `unbound` and refuses it by name.
  readonly runExecution?: RunExecutionPort
  // Optional: `authoring.draft.verify` binds only where this and `runExecution` are both present.
  readonly draftAuthoring?: DraftAuthoringPort
  // Host-supplied because the edit uses `yaml`'s Document API, which this package may not name.
  readonly configFiles?: ConfigFilesPortLike
  // Host-supplied: `AgentQaConfigSchema` lives in core, which this package may not name.
  readonly configValidate?: ConfigValidatePortLike
  // Optional: its absence leaves only `config.project.scaffold` unbound.
  readonly scaffoldContent?: ConfigScaffoldContentPortLike
  // Host-supplied because its transaction is shared per path with the dashboard's own writes.
  readonly configWrite?: FunctionDeps['configWrite']
  // Optional: absent lists `agent.explain` as `unbound` rather than answering from model memory.
  readonly capabilityCatalog?: CapabilityCatalogPort
  // Optional: a host with no HTTP origin lists `runs.liveurl` as `unbound`, never a dead link.
  readonly liveView?: LiveViewPort
  // Optional: a host with no projection to read lists `runs.detail` as `unbound` by name.
  readonly runDetail?: RunDetailReaderPort
  // `agent-local` cannot name a socket, so the CLI injects a closure over `invokeViaDaemon`.
  readonly knowledgeChangeDelegate?: ExplicitReviewDelegate
  /** The writer lease a leaseholding host already owns. See `createKnowledgeReview`. */
  readonly resolveWriterAuthority?: () => { readonly leaseId: string; readonly epoch: number } | undefined
  // Required: only a host knows the checkout root, and a guessed root mints unreadable identities.
  readonly mintQuarantineIdentityPath: (filePath: string) => string
  readonly clock?: ClockPort
  readonly idSource?: JobIdSource
  /** The kind registry the queue dispatches through. Defaults to the real declarations. */
  readonly jobKinds?: JobKindRegistry
  // Optional: with it the real analyze-run and curate-memory bodies run; without it, scripted ones.
  readonly postRun?: {
    readonly curateRun: PostRunJobCapabilities['curateRun']
    // Required, so a `postRun` that omits its masking posture does not typecheck.
    readonly candidateProse: CandidateProsePosture
  }
  // Optional factory, resolved at queue open; answering `undefined` sends packs whole.
  readonly analysisTokenBudget?: () =>
    | Promise<PostRunJobCapabilities['analysisTokenBudget']>
    | PostRunJobCapabilities['analysisTokenBudget']
  // Injected per composition, so a host's posture does not leak through the process global.
  readonly resolveExecutionContext?: () => ExecutionContext
  // Called after the event is on file; its return is discarded and a throw swallowed.
  readonly observeSessionEvent?: (sessionId: string, event: ChatSessionEvent) => void
  // Never config-reachable: disabling the deterministic override removes a safety property.
  readonly chatReconcile?: ReconcileStrategy
  // A built model, never an id the SDK resolves past the masking middleware; absent is headless.
  readonly chatModel?: ChatLanguageModel
  // Host-resolved with the chat model, or a session compacts against a window the model lacks.
  readonly chatAccounting?: ChatTokenAccounting
  // Absent, `/model` records the declared model and emits `model_change` but resolves no client.
  readonly chatModelFor?: (name: string) => ChatLanguageModel | Promise<ChatLanguageModel>
  // Passed through to the engine's `present`; absent, nothing renders mid-turn.
  readonly chatPresent?: (text: string) => void | Promise<void>
}

// Exposed for REPL state and closing an interrupted turn; everything else goes through `agent.ask`.
export interface LocalAgentChatSession {
  // A lookup, because these facts belong to one session; reading never creates a scope.
  stateFor(sessionId: string): ChatStateSnapshot | undefined
  // A no-op between turns: `aborted` after `turn_complete` would trim a finished turn on repair.
  abortActiveTurn(): Promise<void>
}

// Absent data answers `undefined`, not an empty row; any other read failure propagates.
function readProjectedTestHistory(
  knowledgeRoot: string,
  query: { readonly product: string; readonly filePath: string; readonly testName: string },
): ReturnType<typeof readTestOutcomeHistory> {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return readTestOutcomeHistory(db, {
      product: query.product,
      filePath: query.filePath,
      testName: query.testName,
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return undefined
    throw error
  } finally {
    db.close()
  }
}

// `kth` and `windowBuilds` are the renderer's vocabulary, whichever window answers them.
interface ProjectedRecurrence {
  readonly kth: number
  readonly windowBuilds: number
}

// A fingerprint query reads the fingerprint window, else the per-test one; one ordinal serves both.
function readProjectedRecurrence(
  knowledgeRoot: string,
  query: { readonly product: string; readonly filePath: string; readonly testName: string
    readonly fingerprint?: string },
): ProjectedRecurrence | undefined {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) return undefined
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const history = readTestOutcomeHistory(db, {
      product: query.product,
      filePath: query.filePath,
      testName: query.testName,
    })
    if (history === undefined) return undefined
    const currentBuildOrdinal =
      history.lastBuildOrdinal
      ?? history.lastOutcomes.reduce((max, entry) => Math.max(max, entry.buildOrdinal), 0)
    if (query.fingerprint === undefined) return failureRecurrence(history, currentBuildOrdinal)
    const windowed = fingerprintRecurrence(
      db,
      { product: query.product, fingerprint: query.fingerprint },
      currentBuildOrdinal,
    )
    return { kth: windowed.occurrenceOrdinals, windowBuilds: windowed.windowOrdinals }
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return undefined
    throw error
  } finally {
    db.close()
  }
}

// Total over ledger states, so a new state cannot compile unmapped; `released` maps to no rung.
const LADDER_STATE_FOR_ENTRY = {
  quarantined: 'quarantined',
  expired: 'expired',
  released: undefined,
} as const satisfies Record<QuarantineEntryStateName, QuarantineLadderState | undefined>

// An unreadable ledger propagates its error; healing would render a suppressed test as ordinary.
function readQuarantineLadder(
  knowledgeRoot: string,
  identity: { readonly product: string; readonly filePath: string; readonly testName: string },
  now: string,
  recurrence: ProjectedRecurrence,
): RecurrenceLadder | undefined {
  const entries = foldQuarantineLedgerState(readQuarantineLedger(knowledgeRoot).events, now)
  const entry = entries.find((candidate) =>
    candidate.product === identity.product
    && candidate.filePath === identity.filePath
    && candidate.testName === identity.testName)
  const state = entry === undefined ? undefined : LADDER_STATE_FOR_ENTRY[entry.state]
  if (entry !== undefined && state !== undefined) return { state, expiresAt: entry.expiresAt }
  if (recurrence.kth >= QUARANTINE_FLAG_FLOOR) return { state: 'flagged' }
  return undefined
}

interface ProjectionRecurrence {
  readonly provider: RecurrenceProvider
  /**
   * Resolve (and cache) the knowledge root the SYNC provider reads under. See the
   * `runs.get` wrapper in `composeLocalAgent` for why this exists and where it is awaited.
   */
  prime(): Promise<void>
}

// Both reads run per call and nothing about the answer is cached; only the knowledge root is kept.
function createProjectionRecurrenceProvider(
  resolveKnowledgeRoot: () => Promise<string> | string,
  /** The host clock, read ONCE per query — the ladder's expiry comparison needs an instant. */
  now: () => string,
): ProjectionRecurrence {
  let root: string | undefined
  let resolving: Promise<void> | undefined

  function beginResolve(): Promise<void> | undefined {
    if (resolving !== undefined) return resolving // reuse the in-flight resolution; never mint a second promise
    let answer: Promise<string> | string
    try {
      answer = resolveKnowledgeRoot()
    } catch {
      return undefined // sync throw: swallowed here, retried on the next query
    }
    if (typeof answer === 'string') {
      root = answer
      return undefined
    }
    // A failed resolution clears the marker so the next query retries rather than
    // pinning the provider to permanent no-history over a transient host error.
    resolving = answer.then(
      (value) => {
        root = value
      },
      () => {
        resolving = undefined
      },
    )
    return resolving
  }

  function rootNow(): string | undefined {
    if (root !== undefined) return root
    beginResolve()
    return root
  }

  return {
    prime(): Promise<void> {
      if (root !== undefined) return Promise.resolve()
      // Both stored handlers swallow, so prime never rejects — the awaited runs.get hop
      // cannot fail on a knowledge-root problem.
      return beginResolve() ?? Promise.resolve()
    },
    provider: {
      failureRecurrence(query) {
        const knowledgeRoot = rootNow()
        if (knowledgeRoot === undefined) return undefined
        const recurrence = readProjectedRecurrence(knowledgeRoot, query)
        // No recorded history is the no-history clause, ladder or not.
        if (recurrence === undefined) return undefined
        const ladder = readQuarantineLadder(knowledgeRoot, query, now(), recurrence)
        return ladder === undefined ? recurrence : { ...recurrence, ladder }
      },
    },
  }
}

// Absent is `undefined`; a newer schema, bad bytes or another run's id are refused, not absent.
function createAnalysisArtifactReader(agentQaRoot: string): AnalysisArtifactReaderPort {
  return {
    getArtifact(runId) {
      const path = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId), ANALYSIS_FILE)
      let bytes: string
      try {
        bytes = readFileSync(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      const admission = admitAnalysisArtifactForRun(
        guardRunAnalysisArtifact(JSON.parse(bytes)),
        runId,
      )
      return admission.kind === 'admitted' ? admission.artifact : undefined
    },
  }
}

// The handoff path derives from `runId` through `slugBranch`, so `../../etc` addresses nothing.
export function postRunCapabilities(
  input: ComposeLocalAgentInput,
  /**
   * The RESOLVED knowledge root. `openJobs` awaits the host's resolver once at queue open
   * — the same once-at-open idiom the model factory follows — so the SYNC capability
   * members below never race an async resolution mid-job.
   */
  knowledgeRoot: string,
  /** The RESOLVED budget, awaited from the input factory at the same open (see above). */
  analysisTokenBudget?: PostRunJobCapabilities['analysisTokenBudget'],
): PostRunJobCapabilities | undefined {
  const postRun = input.postRun
  if (postRun === undefined) return undefined
  return {
    loadCompletedRunHandoff: (runId: string) =>
      loadCompletedRunHandoff(
        join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(runId), HANDOFF_FILE),
      ),
    curateRun: postRun.curateRun,
    // Derived from the artifact's own `runId` through `slugBranch`; a payload carries no path.
    persistAnalysis: (artifact) =>
      writeAnalysisArtifact(
        join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(artifact.runId), ANALYSIS_FILE),
        artifact,
      ),
    // Keyed by the stable identity (product, filePath, testName), never a per-run id; read-only.
    readTestHistory: (query) => readProjectedTestHistory(knowledgeRoot, query),
    // Through the shared `lookupEvidenceBlob`, so `runs.artifact` and this job agree on blobs.
    readEvidenceBlob: (runId, sha) =>
      readEvidenceBlobBytes({ agentQaRoot: input.agentQaRoot }, runId, sha),
    // Host-resolved from the job model's profile; this composition adds no knob.
    ...(analysisTokenBudget === undefined ? {} : { analysisTokenBudget }),
  }
}

// Identical but for `origin`: a typed alias is a person's call and a planned one is not.
export const CHAT_RESOLVER_CALLER: FunctionCaller = Object.freeze({
  surface: 'chat',
  origin: 'human',
})

export const CHAT_PLANNER_CALLER: FunctionCaller = Object.freeze({
  surface: 'chat',
  origin: 'agent',
})

// Derived from the registry, so a build that gains an op gains it here; unbuilt answers `unbound`.
function chatToolsetIds(registry: FunctionRegistry | undefined): readonly string[] {
  if (registry === undefined) return []
  return registry
    .list(CHAT_RESOLVER_CALLER)
    .map((declaration) => declaration.id)
    .sort()
}

function chatToolsetHash(registry: FunctionRegistry | undefined): string {
  if (registry === undefined) return 'unbound'
  // Sorted before hashing, so the hash identifies the set, not the walk order.
  return sha256hex16(chatToolsetIds(registry).join('\n'))
}

// Masks written text, keeps the guard's closed vocabulary; an unnamed member masks as a tree.
type ChatMemberRule = 'as-written' | 'text' | 'tree' | ((value: unknown, mask: MaskFn) => unknown)
type ChatMemberRules = Readonly<Record<string, ChatMemberRule>>

function projectChatMembers<T extends object>(value: T, rules: ChatMemberRules, mask: MaskFn): T {
  return Object.fromEntries(Object.entries(value).map(([key, member]) => {
    const rule = Object.hasOwn(rules, key) ? rules[key]! : 'tree'
    if (rule === 'as-written') return [key, member]
    if (typeof rule === 'function') return [key, rule(member, mask)]
    if (rule === 'text' && typeof member === 'string') return [key, mask(member)]
    return [key, maskPayloadTree(member, mask)]
  })) as T
}

const eachChatRecord = (rules: ChatMemberRules): ChatMemberRule => (value, mask) => {
  const project = (entry: unknown) =>
    isRecord(entry) ? projectChatMembers(entry, rules, mask) : maskPayloadTree(entry, mask)
  return Array.isArray(value) ? value.map(project) : project(value)
}

const CHAT_EVENT_BASE: ChatMemberRules = {
  kind: 'as-written', turnId: 'as-written', at: 'as-written',
}
const CHAT_CLAUSE_RECEIPT_RULES: ChatMemberRules = {
  clause: 'text', functionId: 'as-written', origin: 'as-written', status: 'as-written', outcome: 'text',
}
const CHAT_EVENT_RULES: Readonly<Record<ChatSessionEvent['kind'], ChatMemberRules>> = {
  user_message: { ...CHAT_EVENT_BASE, text: 'text' },
  stage_outcome: { ...CHAT_EVENT_BASE, stage: 'as-written', outcome: 'as-written' },
  clause_receipt: { ...CHAT_EVENT_BASE, ...CHAT_CLAUSE_RECEIPT_RULES },
  clause_result: { ...CHAT_EVENT_BASE, functionId: 'as-written', payload: 'tree' },
  approval_decision: {
    ...CHAT_EVENT_BASE, actionClass: 'as-written', decision: 'as-written', source: 'as-written',
  },
  mark_unhandled: { ...CHAT_EVENT_BASE, clause: 'text', reason: 'text' },
  model_change: { ...CHAT_EVENT_BASE, from: 'text', to: 'text', source: 'as-written' },
  active_tools_change: {
    ...CHAT_EVENT_BASE, addedIds: 'as-written', removedIds: 'as-written', toolsetHash: 'as-written',
  },
  compaction: {
    ...CHAT_EVENT_BASE, beforeTokens: 'as-written', afterTokens: 'as-written', outcome: 'as-written',
  },
  aborted: { ...CHAT_EVENT_BASE, source: 'as-written' },
  turn_complete: { ...CHAT_EVENT_BASE, status: 'as-written' },
}

const CHAT_INVOKE_ANSWER_RULES: ChatMemberRules = {
  payload: 'tree',
  verdict: eachChatRecord({ status: 'as-written', outcome: 'text' }),
  foldLines: 'tree',
}

const CHAT_TURN_RESULT_RULES: ChatMemberRules = {
  sessionId: 'as-written',
  turnId: 'as-written',
  status: 'as-written',
  answer: 'text',
  receipts: eachChatRecord(CHAT_CLAUSE_RECEIPT_RULES),
  results: eachChatRecord({ functionId: 'as-written', payload: 'tree' }),
  unhandled: eachChatRecord({ clause: 'text', reason: 'text' }),
  refusedLineCount: 'as-written',
}

function projectChatSessionEvent(event: ChatSessionEvent, mask: MaskFn): ChatSessionEvent {
  const rules = Object.hasOwn(CHAT_EVENT_RULES, event.kind)
    ? CHAT_EVENT_RULES[event.kind]
    : CHAT_EVENT_BASE
  return projectChatMembers(event, rules, mask)
}

export function composeLocalAgent(input: ComposeLocalAgentInput): LocalAgentHost {
  const clock = input.clock ?? SYSTEM_CLOCK

  const entityResolutionInput = {
    agentQaRoot: input.agentQaRoot,
    resolveKnowledgeRoot: input.knowledgeRoot,
  }

  // the recurrence seam and its root priming. `analysis.get` awaits
  // `deps.runs.get` before any recurrence join runs (analysis-get.ts invoke order), so
  // priming the root inside that awaited hop is what makes the SYNC provider correct on a
  // host whose knowledge-root resolver is async (the CLI): by the time the join runs, the
  // root string is cached. A resolution failure is swallowed HERE only — the provider then
  // answers the honest no-history clause, and the knowledge verbs report their own errors
  // through their own awaited resolutions.
  const recurrence = createProjectionRecurrenceProvider(input.knowledgeRoot, () => clock.now())
  const runsReader = createRunsReader(input.agentQaRoot)

  // Reads `composedRegistry` at call time, so a turn crosses the same registry's gate.
  let composedRegistry: FunctionRegistry | undefined
  // `unbound` when no model is bound; binding one later drifts by a `model_change` event.
  const composedChatModelName = input.chatModel === undefined ? 'unbound' : input.chatModel.modelId

  // Keyed by session: one container per host leaked one person's history into another's request.
  interface ChatSessionScope {
    readonly state: ChatStateContainer
  }
  const chatScopes = new Map<string, ChatSessionScope>()
  const chatScopeFor = (sessionId: string): ChatSessionScope => {
    const existing = chatScopes.get(sessionId)
    if (existing !== undefined) return existing
    if (composedRegistry === undefined) {
      throw new TypeError('a chat session opened before its registry finished composing')
    }
    const scope: ChatSessionScope = {
      // An UNBORN session has run no `/model`, so it opens under the model this host composed —
      // which is also what its header will say. A container seeded from another session's override
      // would make one conversation's verb the next conversation's opening posture.
      state: createChatState({ activeModel: composedChatModelName }),
    }
    chatScopes.set(sessionId, scope)
    return scope
  }

  // Read, never captured: a thunk holding the composed model undoes a `/model` on the next turn.
  const chatModelNameFor = (sessionId: string): string =>
    chatScopeFor(sessionId).state.read().activeModel

  // The live model OBJECT for a model name. Keyed by name rather than by session, because
  // `chatModelFor` is a resolution of a name and two sessions naming the same model mean the same
  // model — the same reason the planner stage cache below is keyed that way. Which name a session
  // is under is the per-session fact, and it lives in that session's state.
  const chatModelsByName = new Map<string, ChatLanguageModel>()
  if (input.chatModel !== undefined) chatModelsByName.set(composedChatModelName, input.chatModel)

  const chatSessionLog = createJsonlSessionLog({
    root: input.agentQaRoot,
    now: () => clock.now(),
    // The composed model, masked: a live override would stamp one session's switch on later ones.
    model: () => input.mask(composedChatModelName),
    toolsetHash: () => chatToolsetHash(composedRegistry),
  })

  // Writers outside a turn name it by its logged id; a turn nobody holds gets no row.
  const liveChatSessions = new Map<string, { handle: ChatSessionHandle; turnIds: Set<string> }>()

  const trackedChatSessionLog: SessionLogPort = {
    async open(sessionId?: string): Promise<ChatSessionHandle> {
      const opened = await chatSessionLog.open(sessionId)
      const id = opened.header.sessionId
      const turnIds = new Set<string>()
      const tracked: ChatSessionHandle = {
        header: opened.header,
        events: opened.events,
        refusedLines: opened.refusedLines,
        append: async (event) => {
          // Every event carries the declared mask, per member.
          const projected = projectChatSessionEvent(event, input.mask)
          turnIds.add(projected.turnId)
          await opened.append(projected)
          // The host's copy, taken after the write; a failing push must not fail its turn.
          try {
            input.observeSessionEvent?.(id, projected)
          } catch { /* a push channel's failure is not the turn's */ }
        },
        turnBoundary: () => opened.turnBoundary(),
        close: async () => {
          // Unregistered BEFORE the descriptor goes, so nothing can pick this handle up in the
          // window between the two and write through a closed one.
          liveChatSessions.delete(id)
          await opened.close()
        },
      }
      liveChatSessions.set(id, { handle: tracked, turnIds })
      return tracked
    },
  }

  /** The open session whose file already carries this turn, or none if nobody here holds it. */
  const chatSessionHoldingTurn = (turnId: string): ChatSessionHandle | undefined => {
    for (const entry of liveChatSessions.values()) {
      if (entry.turnIds.has(turnId)) return entry.handle
    }
    return undefined
  }

  // Built lazily, per model in force, because a stage binds its model.
  const plannerStages = new Map<string, PlannerStagePort>()
  const chatPlanner: PlannerStagePort | undefined =
    input.chatModel === undefined
      ? undefined
      : {
          plan: (request) => {
            if (composedRegistry === undefined) {
              throw new TypeError('a chat turn ran before its registry finished composing')
            }
            const activeName = chatModelNameFor(request.sessionId)
            let stage = plannerStages.get(activeName)
            if (stage === undefined) {
              stage = createPlannerStage({
                model: (chatModelsByName.get(activeName) ?? input.chatModel) as ChatLanguageModel,
                tools: projectPlannerTools(composedRegistry, CHAT_PLANNER_CALLER),
                // Read per request: a stage is shared by every session planning under one model.
                context: (contextRequest) => {
                  const scope = chatScopeFor(contextRequest.sessionId).state.read()
                  return { activeModel: scope.activeModel, conversation: scope.conversation }
                },
              })
              plannerStages.set(activeName, stage)
            }
            return stage.plan(request)
          },
        }

  // Bound when the host supplies accounting; its event goes through the per-turn handle.
  const chatCompaction: CompactionHook | undefined =
    input.chatAccounting === undefined
      ? undefined
      : createChatCompactionHook({
          accounting: input.chatAccounting,
          now: () => clock.now(),
          // What compaction leaves is the conversation the prompt renders, kept per session.
          onConversation: (messages, sessionId) => {
            chatScopeFor(sessionId).state.setConversation(messages)
          },
        })

  const chatTurn = createTurnEngine({
    table: CHAT_RESOLVER_TABLE,
    // The real conjunction grammar, quote-aware.
    split: splitClauses,
    reconcile: input.chatReconcile ?? deterministicOverrideStrategy,
    sessionLog: trackedChatSessionLog,
    // Minted per stage: a table hit is a person typing (`human`); a planned call is `agent`.
    mint: {
      forStage: (stage) => (stage === 'resolver' ? CHAT_RESOLVER_CALLER : CHAT_PLANNER_CALLER),
    },
    // Classify the original bytes before projecting: `invokeFunction` does not mask.
    invoke: async (functionId, invokeInput, caller) => {
      if (composedRegistry === undefined) {
        throw new TypeError('a chat turn ran before its registry finished composing')
      }
      const payload = await invokeFunction(composedRegistry, functionId, invokeInput, caller)
      const fold = foldFunctionResult(composedRegistry, functionId, payload)
      return projectChatMembers({ payload, ...fold }, CHAT_INVOKE_ANSWER_RULES, input.mask)
    },
    ...(chatPlanner === undefined ? {} : { planner: chatPlanner }),
    ...(chatCompaction === undefined ? {} : { compaction: chatCompaction }),
    // Resolved per session: `/model` and `/quit` act on the conversation running the turn.
    directives: (sessionId) => ({
      // Applies nothing: `/model` resolves and caches by name, so the apply cannot throw midway.
      validate: async (directive, argument) => {
        if (directive === 'model' && argument !== undefined && input.chatModelFor !== undefined) {
          chatModelsByName.set(argument, await input.chatModelFor(argument))
        }
      },
      model: async (name) => {
        const scope = chatScopeFor(sessionId)
        const from = scope.state.read().activeModel
        // Resolved ALREADY, when this host publishes `validate` — the pre-flight cached it under
        // this name and the apply reuses it rather than resolving a second time. Two resolutions
        // of one name on one turn would be two chances to disagree, and the second of them would
        // be running after the batch had been declared safe.
        if (input.chatModelFor !== undefined && !chatModelsByName.has(name)) {
          // A failed resolution refuses by name rather than silently keeping the old model.
          chatModelsByName.set(name, await input.chatModelFor(name))
        }
        scope.state.setActiveModel(name)
        return { from, to: name, line: `model: ${from} → ${name}` }
      },
      help: () => CHAT_HELP_TEXT,
      quit: () => {
        chatScopeFor(sessionId).state.requestClose()
        return 'closing this session'
      },
    }),
    state: (sessionId) => chatScopeFor(sessionId).state,
    // Re-read per turn and per session, and masked like the log it is compared with.
    config: (sessionId): ChatConfigState => {
      const ids = chatToolsetIds(composedRegistry)
      return {
        model: input.mask(chatModelNameFor(sessionId)),
        toolset: { hash: chatToolsetHash(composedRegistry), ids },
      }
    },
    // Bound only where the loop is; elsewhere an empty vocabulary refuses with the wrong cause.
    ...(input.draftAuthoring !== undefined && input.runExecution !== undefined
      ? { configuredTargets: () => (input.draftAuthoring as DraftAuthoringPort).configuredTargetNames() }
      : {}),
    // Spread conditionally, so a host binding no surface leaves `present` absent.
    ...(input.chatPresent === undefined ? {} : { present: input.chatPresent }),
    now: () => clock.now(),
    mintTurnId: () => `turn-${randomUUID()}`,
  })

  // `runExecution` is in the condition because stage 4 dispatches `authoring.draft.verify`.
  const authoringLoopHost = input.draftAuthoring !== undefined && input.runExecution !== undefined
    ? input.draftAuthoring
    : undefined

  // Assembled once for the funnel op and the gate-2 consultation, so both read one answer.
  const authoringFunnel: AuthoringFunnelPortLike = {
    receipts: createDraftReceiptsStore({ resolveAgentQaRoot: () => input.agentQaRoot }),
    quarantine: {
      list: async () => (await createQuarantineOperations({
        resolveKnowledgeRoot: input.knowledgeRoot,
        now: () => clock.now(),
        mintIdentityPath: input.mintQuarantineIdentityPath,
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
      }).list()),
    },
    // One read-only connection per verb; absent data answers empty, other failures propagate.
    outcomes: {
      testsIn: async (product: string, filePath: string) => {
        const knowledgeRoot = await input.knowledgeRoot()
        const path = indexDbPath(knowledgeRoot)
        if (!existsSync(path)) return []
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          return listTestsInFile(db, { product, filePath })
            .map((testName) => ({ filePath, testName }))
        } catch (error) {
          if (error instanceof Error && error.message.includes('no such table')) return []
          throw error
        } finally {
          db.close()
        }
      },
      outcomesFor: async (product: string, filePath: string, testName: string) => {
        const knowledgeRoot = await input.knowledgeRoot()
        const history = readProjectedTestHistory(knowledgeRoot, { product, filePath, testName })
        if (history === undefined) return []
        return history.lastOutcomes.map((entry) => (entry.passed ? 'passed' : 'failed'))
      },
    },
  }

  const registry = createFunctionRegistry({
    deps: {
      secretMask: input.mask,
      runs: {
        ...runsReader,
        get: async (runId) => {
          await recurrence.prime()
          return runsReader.get(runId)
        },
      },
      // List verbs are live sighting sites: an entity gets its address when first surfaced.
      knowledge: createKnowledgeReader(
        input.knowledgeRoot,
        createMemorySightingHook(entityResolutionInput),
      ),
      config: input.config,
      entities: createEntityDirectory(entityResolutionInput),
      // Optional, so a read-only host reports the mutating verbs as `unbound` by name.
      knowledgeReview: createKnowledgeReview({
        agentQaRoot: input.agentQaRoot,
        resolveKnowledgeRoot: input.knowledgeRoot,
        ...(input.knowledgeChangeDelegate === undefined
          ? {}
          : { knowledgeChangeDelegate: input.knowledgeChangeDelegate }),
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
        // The host's own context, so a direct change records the context it is made in.
        ...(input.resolveExecutionContext === undefined
          ? {}
          : { resolveExecutionContext: input.resolveExecutionContext }),
      }),
      // On every host, unlike `postRun`: a host that never drains still reads what the chain did.
      postProcessing: createPostProcessingReader({
        agentQaRoot: input.agentQaRoot,
        idSource: input.idSource ?? DIGEST_JOB_ID_SOURCE,
      }),
      // An absent port must be an absent field: the registry lists capabilities off this record.
      ...(input.runDetail === undefined ? {} : { runDetail: input.runDetail }),
      // On every host, and the same reader the analysis job uses, so both agree where a blob is.
      evidenceBlobs: createEvidenceBlobReader({ agentQaRoot: input.agentQaRoot }),
      // Present only if this host can run; the registry lists `runs.start` from the same record.
      ...(input.runExecution === undefined ? {} : {
        runInvocation: createLocalRunInvocation({
          agentQaRoot: input.agentQaRoot,
          execution: input.runExecution,
        }),
      }),
      // Bindable from the roots alone, so every host serves the floor or the no-history clause.
      analysis: createAnalysisArtifactReader(input.agentQaRoot),
      recurrence: recurrence.provider,
      // Spread conditionally so `agent.explain` lists `unbound` where no catalog is handed in.
      ...(input.capabilityCatalog === undefined
        ? {}
        : { capabilityCatalog: input.capabilityCatalog }),
      // Spread conditionally, so `runs.liveurl` declares `unbound` where no origin is served.
      ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
      // The funnel reads records this host owns, so it is unconditional; its receipts port lists.
      authoringFunnel,
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.feedbackReads === undefined ? {} : { feedbackReads: input.feedbackReads }),
      quarantine: createQuarantineOperations({
        resolveKnowledgeRoot: input.knowledgeRoot,
        now: () => clock.now(),
        mintIdentityPath: input.mintQuarantineIdentityPath,
        ...(input.resolveWriterAuthority === undefined
          ? {}
          : { resolveWriterAuthority: input.resolveWriterAuthority }),
      }),
      // Bound here, so `agent.ask` is a real capability on every host.
      chatTurn: {
        // The engine also echoes authored clause text on receipts and refusal answers. Mask
        // the complete outward projection after execution, never the message it dispatches.
        runTurn: async turnInput =>
          projectChatMembers(await chatTurn.runTurn(turnInput), CHAT_TURN_RESULT_RULES, input.mask),
      },
      // Both halves spread conditionally: a host that can parse but not run says `unbound`.
      ...(input.draftAuthoring === undefined || input.runExecution === undefined ? {} : {
        draftEvaluation: createDraftEvaluation({
          authoring: input.draftAuthoring,
          agentQaRoot: input.agentQaRoot,
          knowledgeRoot: input.knowledgeRoot,
          authoringFunnel,
          readRun: (runId) => runsReader.get(runId as RunId),
          startGateRun: async (request) => {
            if (composedRegistry === undefined) {
              throw new TypeError('a gate-run started before its registry finished composing')
            }
            return await invokeFunction(
              composedRegistry,
              RUNS_START_FUNCTION_ID,
              request,
              AUTHORING_GATE_RUN_CALLER,
            ) as RunStartAcknowledgement
          },
        }),
      }),
      // The arch import scan reads comments too: never put a quote after the word `from`.
      ...(authoringLoopHost === undefined ? {} : {
        authoringRead: {
          async getAuthoringBrief(intent: string, scope: ScopeKey): Promise<AuthoringBrief> {
            const knowledgeRoot = await input.knowledgeRoot()
            return createAuthoringReader({ knowledgeRoot }).getAuthoringBrief(intent, scope)
          },
          suiteTextCorpus: () => authoringLoopHost.suiteTextCorpus(),
          // Off the same port as the brief and corpus, so a loop host names its own targets.
          configuredTargetNames: () => authoringLoopHost.configuredTargetNames(),
        },
        // Its own key: a scope needs config and workspace, the brief needs an index.
        authoringScope: {
          deriveDefault: () => authoringLoopHost.deriveDefaultScope(),
        },
        draftShelf: {
          model: async () => await input.model(),
          write: (contents: string) => authoringLoopHost.stageDraft(contents),
          // The one RFC 6902 applier, at the host because it needs `core`'s yaml CST.
          applyPatches: (draft, patchSet) => authoringLoopHost.applyPatchesToDraft(draft, patchSet),
          // Same seam as the verbs above: the boundary check needs `core`.
          publish: (request) => authoringLoopHost.publishDraft(request),
          // The evaluator's reader; probes use the gate-run caller, so outcomes exclude them.
          runs: {
            start: async (request): Promise<RunStartAcknowledgement> => {
              if (composedRegistry === undefined) {
                throw new TypeError('a repair probe started before its registry finished composing')
              }
              return await invokeFunction(
                composedRegistry,
                RUNS_START_FUNCTION_ID,
                request,
                AUTHORING_GATE_RUN_CALLER,
              ) as RunStartAcknowledgement
            },
            get: (runId: string) => runsReader.get(runId as RunId),
          },
          verifyDraft: async (verifyInput: AuthoringVerifyDraftInput): Promise<DraftReceipt> => {
            if (composedRegistry === undefined) {
              throw new TypeError('a draft was verified before its registry finished composing')
            }
            return await invokeFunction(
              composedRegistry,
              AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
              verifyInput,
              AUTHORING_LOOP_VERIFY_CALLER,
            ) as DraftReceipt
          },
        },
      }),
      // Each config-editor half spreads on its own condition, so a missing one reads `unbound`.
      ...(input.configFiles === undefined ? {} : { configFiles: input.configFiles }),
      ...(input.configValidate === undefined ? {} : { configValidate: input.configValidate }),
      ...(input.scaffoldContent === undefined
        ? {}
        : { scaffoldContent: input.scaffoldContent }),
      ...(input.configWrite === undefined ? {} : { configWrite: input.configWrite }),
    },
  })
  // Closes the cycle the turn engine's dispatch binding was built against. It happens exactly
  // here, on the line after the registry exists, so there is no window in which a turn could run
  // against an unset reference — and the engine's own guard names that state if one ever appears.
  composedRegistry = registry

  let opened: LocalAgentJobs | undefined
  let opening: Promise<LocalAgentJobs> | undefined
  let closing: Promise<void> | undefined
  let lifecycleGeneration = 0
  let closed = false

  async function openJobs(openGeneration: number): Promise<LocalAgentJobs> {
    const model = await input.model()
    // Resolved ONCE at queue open, the same idiom as the model above: the post-run
    // capability members read synchronously, and the knowledge root is a process fact.
    const knowledgeRoot = await input.knowledgeRoot()
    const analysisTokenBudget = input.analysisTokenBudget === undefined
      ? undefined
      : await input.analysisTokenBudget()
    const store = createSqliteJobStore({
      path: join(input.agentQaRoot, AGENT_JOB_STORE_DB_FILE),
      clock,
      checkpoints: createJobCheckpointStore({ root: input.agentQaRoot }),
    })
    let jobs: LocalAgentJobs
    try {
      const kinds = input.jobKinds
        ?? createRealJobKindRegistry(
          postRunCapabilities(input, knowledgeRoot, analysisTokenBudget),
        )
      // Resolved ONCE and used for both the queue and the published field: the value a watcher
      // derives ids from has to be the value the queue mints them with, and two spellings of the
      // same default is how those two drift.
      const idSource = input.idSource ?? DIGEST_JOB_ID_SOURCE
      // No `postRun` folds to `no-masker`: an undeclared fold posture cannot have been reviewed.
      const unclaimableKinds: readonly JobKind[]
        = UNCLAIMABLE_BY_PROSE_POSTURE[input.postRun?.candidateProse ?? 'no-masker']
      jobs = {
        queue: createAgentJobQueue({
          store,
          registry: kinds,
          clock,
          idSource,
          model,
          ...(unclaimableKinds.length === 0 ? {} : { unclaimableKinds }),
        }),
        store,
        kinds,
        model,
        idSource,
        unclaimableKinds,
      }
    } catch (error) {
      store.close()
      throw error
    }
    if (closed || openGeneration !== lifecycleGeneration) {
      // The model can resolve after close. Constructing then invalidating here keeps the open
      // transactional: the late store proves it can initialize, but it never becomes reachable.
      store.close()
      throw new LocalAgentClosedError(input.agentQaRoot)
    }
    opened = jobs
    return jobs
  }

  return {
    registry,
    chat: {
      stateFor: (sessionId) => chatScopes.get(sessionId)?.state.read(),
      async abortActiveTurn(): Promise<void> {
        // Each live session aborts its own turn in flight; between turns it writes nothing.
        for (const [sessionId, entry] of liveChatSessions) {
          const turnId = chatScopes.get(sessionId)?.state.read().activeTurnId
          if (turnId === undefined) continue
          if (!entry.turnIds.has(turnId)) continue
          await entry.handle.append({
            kind: 'aborted',
            turnId,
            at: clock.now(),
            source: 'explicit',
          })
          // Fsynced immediately rather than at a turn boundary that is not coming: this is the
          // last thing this process writes, and an unflushed `aborted` is exactly the event the
          // repair it exists to make unnecessary would have to reconstruct.
          await entry.handle.turnBoundary()
        }
      },
    },
    curation: LOCAL_CURATION_CAPABILITIES,
    clock,
    jobs(): Promise<LocalAgentJobs> {
      if (closed) return Promise.reject(new LocalAgentClosedError(input.agentQaRoot))
      // Memoized on the PROMISE, not on the resolved value: two concurrent callers awaiting a
      // value-memoized opener would each run the factory and each open the database.
      opening ??= openJobs(lifecycleGeneration)
      return opening
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing
      closed = true
      lifecycleGeneration += 1
      const pending = opening
      const current = opened
      opened = undefined
      // Closing synchronously releases the handle even for callers that do not await `close`.
      current?.store.close()
      closing = (async () => {
        if (pending !== undefined) {
          try {
            const late = await pending
            if (late !== current) late.store.close()
          } catch {
            // A superseded opener closes its own store; a model/open failure owns no live handle.
          }
        }
        opening = undefined
      })()
      return closing
    },
  }
}
