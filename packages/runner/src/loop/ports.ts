// Type-only and provider-neutral; every possibly-absent port is optional and optional-chained.

import type { LanguageModelUsage, ModelMessage } from 'ai'
import type {
  ArtifactRef,
  ClipboardEvidence,
  DownloadEvidence,
  EvidenceDocument,
  DeclaredModelProfile,
  ModelUsageObservations,
  ProcedureBodyPayload,
  ProcedureMatch,
  RecordedRetrievalRung,
  RecordingRef,
  RecordId,
  ReadTrace,
  ScreenState,
  ScopeKey,
  WorkingMemoryEntry,
  StepEvidence,
  StepFinalizedPayload,
  SubActionEvidence,
  SubActionRecordedPayload,
} from '@vostride/agent-qa-schema'
import type { ConfigDigests } from '../run/ports.js'
import type { PlatformAdapter } from '../platform.js'
import type { KnowledgeHintReader } from '../knowledge-hint-reader.js'
import type { ActionPlanCache } from '../cache/port.js'
import type { StorageStatePort } from '../storage-state/port.js'
import type { UniqueValueGenerator } from '../compound/dispatch-mint.js'
import type { Planner, Verifier, PlannerConfig } from './types.js'
import type { RecordLedger } from './record-ledger.js'

/** Compression output, shaped like runner-local's `CompressResult`. */
export interface CompressedScreenshot {
  buffer: Buffer
  imageWidth: number
  imageHeight: number
}

// The core-side implementation owns `sharp`, which runner's storage-neutral class forbids.
export interface ScreenshotCompressor {
  compress(
    screenshot: Buffer,
    options: { effectiveResolution: number; maxBytes?: number; actionSpaceWidth: number },
  ): Promise<CompressedScreenshot>
  dimensions(screenshot: Buffer): Promise<{ width: number; height: number }>
}

// The concrete `SecretStore` satisfies this structurally; named apart to avoid a barrel collision.
export interface SecretResolver {
  get(name: string): string | undefined
  require(name: string): string
  has(name: string): boolean
  // The loop collects only names here; no secret value crosses the reader port.
  forEachSecret?(callback: (name: string, value: string) => void): void
}

/** Structural secret-redactor port — the concrete `SecretRedactor` satisfies it. */
export interface SecretRedactorPort {
  redactString(value: string): string
}

// Declared structurally, so the ports module never imports the concrete `WorkingMemoryStore`.
export interface WorkingMemoryPort {
  capture(entries: readonly WorkingMemoryEntry[], ctx?: { test?: number; step?: number }): void
  entries(): WorkingMemoryEntry[]
  dispose(): void
}

/** Minimal scoped-logger surface the loop uses; core's LogManager satisfies it. */
export interface LoopScopedLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error?(message: string, meta?: Record<string, unknown>): void
}

export interface LoopLogger {
  createScopedLogger(scope: string): LoopScopedLogger | undefined
}

// A structural copy of model's DegradeOptions, because runner cannot import the model package.
export interface RunnerDegradeOptions {
  budget: number
  pin?: (message: ModelMessage, index: number) => boolean
}

// A structural copy of model's DegradeOutcome; degrade never throws and never violates a pin.
export type RunnerDegradeOutcome =
  | { ok: true; messages: ModelMessage[] }
  | { ok: false; reason: 'pinned-content-exceeds-budget'; messages: ModelMessage[] }

// A types-only mirror of model's `TokenAccounting`, because runner cannot import model.
export interface TokenAccounting {
  estimate(messages: ModelMessage[]): number
  recordUsage(usage: LanguageModelUsage, messages: ModelMessage[]): void
  getCeilings(): { contextWindow: number; maxOutput: number }
  degrade(messages: ModelMessage[], options: RunnerDegradeOptions): RunnerDegradeOutcome
}

// Both legs are fire-and-forget and synchronous: the loop never awaits telemetry.
export interface LoopEventEmitPort {
  // `extra` comes from the StepResult in `finish()`, not StepEvidence; the sink masks `error`.
  stepFinalized(
    evidence: StepEvidence,
    extra?: {
      status?: StepFinalizedPayload['status']
      durationMs?: number
      error?: string
      // Absent when nothing was measured; never fabricated here.
      tokenUsage?: StepFinalizedPayload['tokenUsage']
      /** Finished member scope, including late extraction; overrides the legacy loop tally. */
      modelObservations?: ModelUsageObservations
      evidence?: StepFinalizedPayload['evidence']
      variableSnapshot?: StepFinalizedPayload['variableSnapshot']
    },
  ): void
  subActionRecorded(
    evidence: SubActionEvidence,
    subActionIndex: number,
    /** Capture-time ARIA state; the projector appends its ref beside the decision screenshot. */
    extra?: { ariaEvidence?: SubActionRecordedPayload['ariaEvidence']; recordingOffsetMs?: number },
  ): void
}

// `getBlob` lets a host satisfy eval's `ArtifactSource` without a runner-to-eval dependency.
export interface PersistedRecording {
  ref: RecordingRef
  byteLength: number
}

export interface EvidenceArtifactStorePort {
  persistDecisionScreenshot(bytes: Uint8Array): ArtifactRef
  /** Already live-masked JSON only. Optional for existing screenshot-only hosts. */
  persistEvidenceDocument?(document: Exclude<EvidenceDocument, { kind: 'variables' }>): ArtifactRef
  hasBlob?(sha: string): boolean
  getBlob(sha: string): Uint8Array | undefined
  persistRecording?(stagingPath: string): PersistedRecording
  blobSize?(sha: string): number | undefined
  readBlobRange?(sha: string, start: number, end: number): Uint8Array | undefined
  discardRecording?(stagingPath: string): void
}

// Carries only the match, parsed payload and cursor; every carried step re-earns dispatch.
export interface ProcedureFlowCarry {
  match: ProcedureMatch
  payload: ProcedureBodyPayload
  nextIndex: number
}

// A completed download from an earlier step of this test, labelled by its producer.
export interface CarriedDownload {
  stepNumber: number
  /** 1-based position of the producing action in its step. */
  actionIndex: number
  evidence: DownloadEvidence
}

// The latest app clipboard write from an earlier step of this test.
export interface CarriedClipboard {
  stepNumber: number
  actionIndex: number
  evidence: ClipboardEvidence
}

export interface CarriedArtifacts {
  downloads: CarriedDownload[]
  clipboard?: CarriedClipboard
}

export interface LoopPorts {
  recordingZeroMs?: number
  adapter: PlatformAdapter
  planner: Planner
  verifier?: Verifier
  // Descriptor-only values over a branded CacheKey; absent, every step misses.
  cache?: ActionPlanCache
  // The loop never derives model facts from a model handle; roots pass the same profile objects.
  modelProfiles?: {
    planner: DeclaredModelProfile
    verifier?: DeclaredModelProfile
  }
  // Separate from model identity, because tool attribution is a distinct fact.
  toolSchemaDigest?: string
  compressor?: ScreenshotCompressor
  // Optional; the loop degrades gracefully when absent.
  knowledgeReader?: KnowledgeHintReader
  // Resolved once at the root; a promise, so the embedder probe stays off the critical path.
  knowledgeRetrievalRung?: Promise<RecordedRetrievalRung>
  // One cell per member: taken at step start, re-armed only after an accepted replayed step.
  procedureFlow?: { carry?: ProcedureFlowCarry }
  // One cell per member, never serialized; absent in the live editor, so nothing carries.
  carriedArtifacts?: CarriedArtifacts
  // Computed at the composition root; the provider-neutral loop never derives model ceilings.
  knowledgeBudgets?: {
    brief: number
    searchResults: number
    caution: number
    readBody: number
    recordCap: number
  }
  // Run-fixed build ordinal copied into ServedBrief attribution when a reader is bound.
  knowledgeAsOfBuild?: number
  // Channel-2 tools share this object; absent, a step-local ledger covers Channel 1 only.
  recordLedger?: RecordLedger
  // Invoked only after the shared ledger is reseeded from the frozen brief.
  beginMemoryTurn?: (scope?: ScopeKey, exposedIds?: readonly RecordId[]) => void
  /** Consume the successful direct reads served during the current live planning turn. */
  drainMemoryReadTraces?: () => ReadTrace[]
  plannerConfig?: PlannerConfig
  /** Wall-clock timeout for a single step (ms). 0 or undefined = no timeout. */
  stepTimeout?: number
  logger?: LoopLogger
  logCapture?: { console?: boolean; network?: boolean }
  vision?: { screenshotSize?: number; effectiveResolution?: number }
  visionGate?: { attachImage: boolean; captureMode: 'full' | 'textOnly'; promptNote: string }
  /** setVariable executes through this callback, not the adapter. */
  onSetVariable?: (name: string, value: string) => void
  /** Path resolution stays core-side; paths arrive pre-resolved. */
  resolveUploadPath?: (rawPath: string) => string
  abortSignal?: AbortSignal
  secretStore?: SecretResolver
  secretRedactor?: SecretRedactorPort
  // Unbound, the loop runs without memory: no capture and an empty served set.
  workingMemory?: WorkingMemoryPort
  // Only `{ name, fingerprint }` is recorded; unbound, a `storageState` action gets an error.
  storageState?: StorageStatePort
  // Tests inject a fixed generator; production uses `defaultUniqueValueGenerator`.
  uniqueValueGenerator?: UniqueValueGenerator
  // Roots that depend on model may inject its `guardBlob`; otherwise a runner-local fallback runs.
  guardBlob?: (value: unknown) => string | undefined
  // Bound by the run shell; absent, the loop emits nothing and never throws.
  events?: LoopEventEmitPort
  // The cache keys on the run's real digests; absent, the existing key material is used.
  configDigests?: ConfigDigests
  // One store for every member; absent, nothing persists and nothing throws.
  evidenceArtifacts?: EvidenceArtifactStorePort
}
