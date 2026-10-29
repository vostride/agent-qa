// Runner-owned port interfaces for the step-execution loop.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp,
// no core/model/adapter package imports. Follows the knowledge-hint-reader idiom:
// type-only imports, exported interfaces, no implementation, no class. Every
// possibly-absent port is optional and optional-chained by the loop — never
// throw-on-absent (D-05 degrade-when-absent).

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

/** Compression output — v1's CompressResult shape (Pitfall 9). */
export interface CompressedScreenshot {
  buffer: Buffer
  imageWidth: number
  imageHeight: number
}

/**
 * Screenshot compression + dimension port. The core-side implementation owns
 * `sharp` (storageNeutral forbids it in runner, Pitfall 9). `compress` covers the
 * LLM-planner compression call site; `dimensions` covers the action-space-width
 * metadata fallback done inline via `sharp(screenshot).metadata()` at v1
 * loop.ts:199-201. The loop applies `stampCaptureMode` itself (runner-owned since 352).
 */
export interface ScreenshotCompressor {
  compress(
    screenshot: Buffer,
    options: { effectiveResolution: number; maxBytes?: number; actionSpaceWidth: number },
  ): Promise<CompressedScreenshot>
  dimensions(screenshot: Buffer): Promise<{ width: number; height: number }>
}

/**
 * Structural secret-lookup port. The concrete `SecretStore` (moved into runner in
 * this plan, task 2) satisfies it by construction; `resolveSecretTemplatesInValue`
 * consumes it. Named distinctly from the concrete class to avoid a barrel collision.
 */
export interface SecretResolver {
  get(name: string): string | undefined
  require(name: string): string
  has(name: string): boolean
  /**
   * OPTIONAL name enumeration. The loop assembles the procedure
   * consult's binding-NAME set from the ports already in scope; secret template names are
   * part of that set so secret-parameterized procedures stay replay-eligible. Names only —
   * the callback receives the value because the concrete `SecretStore.forEachSecret`
   * already carries it, but the loop only ever collects the name; no value crosses the
   * reader port in any form. Absent implementations simply contribute no names.
   */
  forEachSecret?(callback: (name: string, value: string) => void): void
}

/** Structural secret-redactor port — the concrete `SecretRedactor` satisfies it. */
export interface SecretRedactorPort {
  redactString(value: string): string
}

/**
 * Structural run-scoped working-memory port. The concrete
 * `WorkingMemoryStore` (working-memory/store.ts) satisfies it by construction; declared
 * structurally here (the SecretResolver naming precedent) so the ports module never imports the
 * concrete class. `capture` writes verbatim entries (registered secrets redacted at capture);
 * `entries` returns the whole set in capture order; `dispose` empties it at run end.
 */
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

/**
 * Runner-local structural copy of model's DegradeOptions. Runner cannot
 * import the model package, so the shape is duplicated here; Plan 05's cli conformance
 * proof asserts model's `DegradeOptions` structurally matches this. Policy-free: the
 * caller supplies the concrete budget + pin predicate.
 */
export interface RunnerDegradeOptions {
  budget: number
  pin?: (message: ModelMessage, index: number) => boolean
}

/**
 * Runner-local structural copy of model's DegradeOutcome. `ok:true` carries the
 * fitted messages; `ok:false` is the structured cannot-fit outcome (system + final +
 * pinned content alone exceed the budget) — degrade never throws and never violates a pin.
 */
export type RunnerDegradeOutcome =
  | { ok: true; messages: ModelMessage[] }
  | { ok: false; reason: 'pinned-content-exceeds-budget'; messages: ModelMessage[] }

/**
 * Provider-neutral token-accounting port — the 354↔355 seam. A types-only
 * structural duplicate of model's `TokenAccounting` (accounting/types.ts): runner cannot
 * import model, so the shape is mirrored here and message types are imported from `'ai'`
 * only (never `@ai-sdk/*`, PROVIDER_ORCHESTRATION_ALLOWED). Policy-free — prompt tokens
 * only. This plan declares the seam; Phase 355 wires estimate/degrade consumption.
 */
export interface TokenAccounting {
  estimate(messages: ModelMessage[]): number
  recordUsage(usage: LanguageModelUsage, messages: ModelMessage[]): void
  getCeilings(): { contextWindow: number; maxOutput: number }
  degrade(messages: ModelMessage[], options: RunnerDegradeOptions): RunnerDegradeOutcome
}

/**
 * D-02 run-scoped event-emit seam. The loop emits `stepFinalized`/`subActionRecorded` at the
 * moment they occur (live semantics from day one) — the bus assigns `seq` centrally. Both legs
 * are fire-and-forget SYNCHRONOUS void: the loop must NEVER await telemetry. Follows
 * the optional-port idiom (masking/workingMemory): structural, optional on {@link LoopPorts},
 * optional-chained at the emit site, never throw-on-absent (D-05 degrade-when-absent). The
 * concrete curry lands at the run shell (`MemberEventSink.loopEmitFor`); the port survives 363's
 * migration unchanged.
 */
export interface LoopEventEmitPort {
  /**
   * the additive-optional `extra` carries the StepResult-derived
   * `{status, durationMs, error}` the reporters need (RESEARCH Q1 parity). Sourced from the
   * runner `StepResult` at the loop's single terminal `finish()` funnel — NOT fields on the §A8
   * `StepEvidence` DTO (Pitfall 2). `error` is masked at the sink chokepoint. Absent
   * ⇒ the base evidence-only payload, source-compatible with pre-363 callers.
   */
  stepFinalized(
    evidence: StepEvidence,
    extra?: {
      status?: StepFinalizedPayload['status']
      durationMs?: number
      error?: string
      /**
       * the step's measured usage, from the loop's own planner + verifier tally.
       * Absent when nothing was measured — the loop's `tokenUsage()` already answers
       * `undefined` in that case, so absence is produced, never fabricated here.
       */
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

/**
 * Run-scoped content-addressed evidence artifact store. Storage-neutral: a
 * runner-local `FsEvidenceArtifactStore` owns the sha-keyed blob persistence; the runner
 * declares only the shape. `persistDecisionScreenshot` returns the identity for the exact
 * byte payload so a decision screenshot becomes addressable by `ArtifactRef.sha`; `getBlob`
 * serves those bytes back, letting a host adapter satisfy eval's structurally identical
 * `ArtifactSource` without a runner-to-eval dependency. Both legs are synchronous.
 */
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

/**
 * The member-scoped procedure-flow carry: the replay position a
 * completed test step hands to the NEXT test step so a committed multi-step flow replays
 * exactly one body step per test step. Transports ONLY the consult match, the parsed body
 * payload, and the cursor — never a pre-resolved ref, never a screen: every carried body
 * step re-earns dispatch through the full fresh-screen descriptor/guard/page-anchor/
 * grounding-gate ladder at its own test step (D-10 — a stored action can never dispatch
 * against a screen its guards did not pass on at that step).
 */
export interface ProcedureFlowCarry {
  match: ProcedureMatch
  payload: ProcedureBodyPayload
  nextIndex: number
}

/** a completed download from an earlier step of this test, labelled by its producer. */
export interface CarriedDownload {
  stepNumber: number
  /** 1-based position of the producing action in its step. */
  actionIndex: number
  evidence: DownloadEvidence
}

/** the latest app clipboard write from an earlier step of this test. */
export interface CarriedClipboard {
  stepNumber: number
  actionIndex: number
  evidence: ClipboardEvidence
}

export interface CarriedArtifacts {
  downloads: CarriedDownload[]
  clipboard?: CarriedClipboard
}

/**
 * The runner-owned port bundle the loop executes against — successor to v1's
 * AgentLoopConfig (core types.ts:66-104), minus the D-10 healing/attempt-limit
 * fields and minus the v1 cache-key inputs (those move behind the cache port).
 */
export interface LoopPorts {
  recordingZeroMs?: number
  adapter: PlatformAdapter
  planner: Planner
  verifier?: Verifier
  /**
   * Redesigned per-key cache port: get/set/invalidate over a branded CacheKey,
   * descriptor-only value. Plan 05's FsActionCache implements it; injected at the Plan 06
   * CLI composition root. Absent ⇒ every step misses (no cache), never throws.
   */
  cache?: ActionPlanCache
  /**
   * D-05 declared decision context for both model roles. Composition roots pass the
   * same profile objects to the planner/verifier constructors and this recording lane;
   * the loop never derives model facts from a model handle. Absent preserves the
   * provider-neutral degrade-when-absent contract.
   */
  modelProfiles?: {
    planner: DeclaredModelProfile
    verifier?: DeclaredModelProfile
  }
  /**
   * D-16 once-per-member digest of the complete bound tool surface. It remains a
   * separate optional port because tool attribution is distinct from model identity;
   * absent callers continue without evidence stamping and never throw.
   */
  toolSchemaDigest?: string
  compressor?: ScreenshotCompressor
  /** D-05 optional read-only knowledge reader — the loop degrades gracefully when absent. */
  knowledgeReader?: KnowledgeHintReader
  /**
   * the HOST's retrieval rung, resolved ONCE at the composition
   * root by knowledge-local's single `resolveRetrievalRung`, never re-probed per step. It
   * crosses as the schema type because the runner never imports knowledge-local (validate:arch
   * enforces that); a promise because the resolver's embedder probe can cost a model load and
   * overlapping it with run start keeps the probe off the critical path.
   *
   * It describes the ladder the machine was on when this run was served — NOT how this brief was
   * ranked. Absent ⇒ no rung is stamped (D-05 degrade-when-absent); a rejection stamps nothing
   * and never fails a step; and a rung is never stamped onto a step no reader served (D-16 —
   * "no knowledge reader bound is not a rung").
   */
  knowledgeRetrievalRung?: Promise<RecordedRetrievalRung>
  /**
   * F-381-51-1 · D-09 member-scoped carry cell (the recordLedger shared-mutable-object
   * precedent): the caller owns ONE cell per test member and threads the SAME object into
   * every per-step ports literal. The loop TAKES the carry at step start (reading and
   * immediately emptying the cell) and re-arms it only after the step's verifier accepts a
   * successful replayed step with body steps remaining — take-then-rearm, the D-11 one-shot
   * law extended across the step boundary: every other exit (guard miss, execution failure,
   * verifier rejection, policy denial, step failure, abort, exhaustion) leaves the cell
   * empty. Loop-side state only: never serialized, never recorded into evidence or the
   * handoff, never crosses a test boundary. Absent ⇒ no cursor crosses steps (D-05
   * degrade-when-absent).
   */
  procedureFlow?: { carry?: ProcedureFlowCarry }
  /**
   * 439 D-04 member-scoped carry cell, the `procedureFlow` precedent: the caller owns ONE cell per
   * test member and threads the SAME object into every per-step ports literal. The loop renders its
   * items into the step record's carried lines at step start, and at the step's end appends the
   * step's completed downloads and replaces the clipboard with its latest write. Loop-side state
   * only: never serialized, never recorded into evidence or the handoff, never crosses a test
   * boundary. Absent ⇒ nothing carries (the live editor).
   */
  carriedArtifacts?: CarriedArtifacts
  /**
   * D-02/D-15/D-17 knowledge budgets are computed beside model token accounting at the
   * composition root and arrive here as plain numbers. The provider-neutral loop never derives
   * model ceilings or imports token-accounting policy; absent bindings use provisional floors.
   */
  knowledgeBudgets?: {
    brief: number
    searchResults: number
    caution: number
    readBody: number
    recordCap: number
  }
  /** D-21 run-fixed build ordinal copied into ServedBrief attribution when a reader is bound. */
  knowledgeAsOfBuild?: number
  /**
   * D-17 loop-controlled turn ledger. A composition root that registers Channel-2 tools binds
   * the same object into their closures; the loop owns reset timing and Channel 3 consults it
   * directly. Absent is legal and creates a step-local ledger for Channel-1 accounting only.
   */
  recordLedger?: RecordLedger
  /**
   * D-11 Channel-2 turn reset owned by the memory-tool wrapper. The loop invokes it only after
   * reseeding the shared distinct-record ledger from the frozen brief, so both ledgers begin the
   * live planning turn from the same boundary.
   */
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
  /** Pitfall 8 — setVariable executes via this callback, NOT the adapter. */
  onSetVariable?: (name: string, value: string) => void
  /** Pitfall 1 — path resolution stays core-side, injected pre-resolved into the loop. */
  resolveUploadPath?: (rawPath: string) => string
  abortSignal?: AbortSignal
  secretStore?: SecretResolver
  secretRedactor?: SecretRedactorPort
  /**
   * WM-01 run-scoped working-memory seam. The concrete `WorkingMemoryStore` is
   * created at the CLI composition root and injected here; Phase 361 rebinds this exact seam onto
   * `RunSession` (the knowledgeReader idiom). Unbound ⇒ the loop runs memory-less: no capture, an
   * empty served set — it never throws (D-05 degrade-when-absent).
   */
  workingMemory?: WorkingMemoryPort
  /**
   * D-14 storage-state persistence seam. The runner-local `FsStorageStateStore` is
   * constructed run-scoped at the CLI/dashboard composition roots and injected here; the seam
   * strips the raw blob from the recorded result and records only `{ name, fingerprint }`. Unbound
   * ⇒ a `storageState` action degrades to a §7.1 persistence-unavailable error (never throws, D-05).
   */
  storageState?: StorageStatePort
  /**
   * D-16 injectable unique-value suffix generator (353 K=2 determinism). Absent ⇒ the seam uses
   * `defaultUniqueValueGenerator` (timestamp + entropy). Tests inject a fixed generator for
   * deterministic minted values; production leaves it unbound.
   */
  uniqueValueGenerator?: UniqueValueGenerator
  /**
   * D-06 optional pre-prompt blob-guard — bounds a single one-shot structured tool-output
   * value before it lands in the sub-action history / next planning turn. A pure signature
   * (no `ai`/model types, zero arch risk). Composition roots that depend on model may inject
   * model's canonical `guardBlob`; the loop degrades to a runner-local fallback when absent.
   */
  guardBlob?: (value: unknown) => string | undefined
  /**
   * D-02 run-scoped event-emit seam. Bound by the run shell (per-step curry via
   * `MemberEventSink.loopEmitFor`) so the loop emits `stepFinalized`/`subActionRecorded` live;
   * absent ⇒ the loop runs telemetry-less (no emit), never throws (D-05 degrade-when-absent).
   */
  events?: LoopEventEmitPort
  /**
   * D-20 real config digests, so the loop can key the cache on what the run actually keyed on
   * (consumed in Plan 08). Type-imported from the run layer; absent ⇒ the existing key material
   * is used unchanged.
   */
  configDigests?: ConfigDigests
  /**
   * CASS-02 run-scoped decision-screenshot byte store. The shell hands one store instance to
   * every member; the loop mints an `ArtifactRef` for captured screenshot bytes through it.
   * Absent ⇒ a legal memory-only / test-harness state (no persistence), never throws.
   */
  evidenceArtifacts?: EvidenceArtifactStorePort
}
