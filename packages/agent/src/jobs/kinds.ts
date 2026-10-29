import type { CurationSnapshot } from '@vostride/agent-qa-schema'
// The real job kinds; stand-ins scripted by payload let tests drive them without a host.
//
// Deliberately absent from every published byte: the attempt number and any timestamp. A
// checkpoint whose bytes changed with the attempt that wrote it would make an interrupted
// history differ from an uninterrupted one for a reason that has nothing to do with recovery,
// and the usual repair for a failing equality assertion is to loosen it.

import type {
  ChainedJobRequest,
  CompletedRunHandoff,
  ExecutionContext,
  JobHandlerOutcome,
  JobKind,
  PerTestOutcome,
  RunAnalysisArtifact,
  Verdict,
  VerdictGroundingQuote,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'
import {
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CurationSnapshotSchema,
  errorTextOf,
  failingStepOf,
  sha256hex,
  slugBranch,
  stepOutcomeUnproven,
} from '@vostride/agent-qa-schema'
import { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from '@vostride/agent-qa-runner'

import { authorRunAnalysis, stampVerdictMemoryOnPath } from './analyze-run-author.js'
import { UNKNOWN_VERDICTS_MARKER } from './chain-identity.js'
import { buildEvidencePacks } from './evidence-diet.js'
import type { EvidenceHistoryLookup } from './evidence-diet.js'
import { createJobKindRegistry } from './kind-registry.js'
import type {
  FallbackContinuationInput,
  JobHandler,
  JobHandlerContext,
  JobKindDeclaration,
  JobKindRegistry,
} from './kind-registry.js'

/**
 * What a stand-in handler will do, as read off the payload it was handed.
 *
 * Every field is optional and an absent field means the ordinary path, so a caller that knows
 * nothing about this module gets a job that publishes its schedule and completes.
 */
export interface StandInJobScript {
  /** Chain to every successor the kind declares. */
  readonly chain?: boolean
  /** Report a failure instead of completing. */
  readonly fail?: 'retryable' | 'permanent'
  readonly reason?: string
}

function readScript(payload: unknown): StandInJobScript {
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const fail = record.fail === 'retryable' || record.fail === 'permanent' ? record.fail : undefined
  return {
    chain: record.chain === true,
    fail,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  }
}

/**
 * The successor instances a kind produces, derived from the predecessor's id.
 *
 * The key is derived rather than minted so the same logical continuation carries the same key
 * in every process and on every replay — which is what makes re-running a chain after a crash
 * a dedupe instead of a second job.
 */
function successorsOf(
  declaration: Pick<JobKindDeclaration, 'kind' | 'allowedSuccessors'>,
  jobId: string,
  extra: Record<string, unknown> = {},
): readonly ChainedJobRequest[] {
  return declaration.allowedSuccessors.map((successor) => ({
    kind: successor,
    payload: { from: declaration.kind, predecessor: jobId, ...extra },
    idempotencyKey: `${jobId}->${successor}`,
  }))
}

function standInHandler(
  kind: JobKind,
  checkpointSchedule: readonly string[],
  allowedSuccessors: readonly JobKind[],
): JobHandler {
  return async (context) => {
    const script = readScript(context.payload)
    let step = 0
    for (const checkpointId of checkpointSchedule) {
      await context.publishCheckpoint(checkpointId, {
        kind,
        checkpointId,
        step,
        jobId: String(context.job.id),
      })
      step += 1
    }
    if (script.fail !== undefined) {
      return { status: script.fail, reason: script.reason ?? `${kind} stand-in scripted failure` }
    }
    return {
      status: 'complete',
      next: script.chain === true ? [...successorsOf({ kind, allowedSuccessors }, String(context.job.id))] : [],
    }
  }
}

// Maps over the success path's successor constant, so a dead analysis hands on the same jobs.
function analyzeRunFallback(input: FallbackContinuationInput): readonly ChainedJobRequest[] {
  const payload = asRecord(input.payload)
  return successorsOf(
    { kind: 'analyze-run', allowedSuccessors: ANALYZE_RUN_SUCCESSORS },
    String(input.job.id),
    {
      ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
      ...(payload.executionContext === undefined
        ? {}
        : { executionContext: payload.executionContext }),
      verdicts: UNKNOWN_VERDICTS_MARKER,
      failureReason: input.reason,
    },
  )
}

const ANALYZE_RUN_SUCCESSORS = ['curate-memory'] as const satisfies readonly JobKind[]

// File reads and the curation drain arrive as capabilities; without them the stand-ins run.
export interface PostRunJobCapabilities {
  // A missing or malformed handoff is permanent for that run, so it fails typed and is not retried.
  loadCompletedRunHandoff(runId: string): CompletedRunHandoff
  // `complete` is required, so a binding cannot drop a fold's refusal and report it done.
  curateRun(input: {
    readonly runId: string
    readonly executionContext: unknown
    readonly deadlineMs?: number
  }): Promise<{
    readonly curated: number
    readonly deprecated: number
    readonly complete: boolean
    readonly snapshot?: CurationSnapshot
    // Why a fold that did not complete handed its run back.
    readonly reason?: string
  }>
  // Called inside the author callback, so the artifact is durable before the value is recorded.
  persistAnalysis(artifact: RunAnalysisArtifact): void
  // Keyed by product and the stable `filePath` + `testName`, never `testId`; unbound is no history.
  readTestHistory?(query: {
    readonly product: string
    readonly filePath: string
    readonly testName: string
  }): TestOutcomeHistoryLike | undefined
  // The estimator and input budget for the compaction ladder; unbound, packs travel whole.
  analysisTokenBudget?: {
    readonly estimate: (text: string) => number
    readonly inputBudget: number
  }
  // Screenshot bytes by sha within one run; unbound or without vision, the request is text only.
  readEvidenceBlob?(runId: string, sha: string): Uint8Array | undefined
}

// A structural mirror of knowledge-local's row, matching `EvidenceTestHistory` member for member.
export interface TestOutcomeHistoryLike {
  readonly passes: number
  readonly failures: number
  readonly heals: number
  readonly flakeCount: number
  readonly lastOutcomes: readonly { readonly buildOrdinal: number; readonly passed: boolean }[]
  readonly lastBuildOrdinal: number | undefined
}

// Both markers are optional, because queued jobs predate them; they are visibility, not integrity.
export interface AnalyzeRunPayload {
  readonly runId: string
  readonly handoffDigest: string
  readonly handoffSchemaVersion: number
  readonly executionContext: ExecutionContext | undefined
  // A distinct axis from `excludedFromOutcomes`: gate runs still feed curation.
  readonly gateRun?: true
  // The outcome-exclusion marker, same carrier idiom, same literal-only rule.
  readonly excludedFromOutcomes?: true
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Deliberately NOT `AnalyzeRunPayloadSchema`, and deliberately additive-tolerant.
 *
 * This reader consumes payloads off a DURABLE queue, where a job may have been written by an
 * older build (no flags at all) or a newer one (a key this build has never heard of). Refusing
 * either would strand work rather than protect anything, so unknown keys stay ignored and only
 * the literal marker is read — a `false` on the wire degrades to absence rather than becoming a
 * third state a downstream `!== undefined` could misread. The strict half of the contract lives
 * on the PRODUCER side, at the enqueue mint, where a bad shape means a bug in code that just ran
 * and the refusal is actionable.
 *
 * Exported for the reader-arm suite: `analyze-run-payload-flags.test.ts` pins both generations
 * of the payload here and then re-enters through the real handler, so the direct cases cannot
 * quietly stop describing what the handler actually parses.
 */
export function readAnalyzeRunPayload(value: unknown): AnalyzeRunPayload | undefined {
  const record = asRecord(value)
  if (typeof record.runId !== 'string' || record.runId === '') return undefined
  if (typeof record.handoffDigest !== 'string' || record.handoffDigest === '') return undefined
  if (typeof record.handoffSchemaVersion !== 'number') return undefined
  return {
    runId: record.runId,
    handoffDigest: record.handoffDigest,
    handoffSchemaVersion: record.handoffSchemaVersion,
    executionContext:
      typeof record.executionContext === 'string'
        ? (record.executionContext as ExecutionContext)
        : undefined,
    ...(record.gateRun === true ? { gateRun: true as const } : {}),
    ...(record.excludedFromOutcomes === true
      ? { excludedFromOutcomes: true as const }
      : {}),
  }
}

// Unreadable input is permanent: it never becomes right on a retry, which would waste the bound.
function permanently(reason: string): JobHandlerOutcome {
  return { status: 'permanent', reason }
}

// Clean passes, skips and cancellations need no verdict; everything else gets one.
function needsVerdict(test: PerTestOutcome): boolean {
  return test.outcome !== 'passed' && test.outcome !== 'skipped' && test.outcome !== 'cancelled'
}

// Projects persisted verdicts; re-classifying would lack `retryCount` and disagree with disk.
function projectHandoffVerdicts(handoff: CompletedRunHandoff): Verdict[] {
  return handoff.tests
    .filter(needsVerdict)
    .map((test) => test.rootCause ?? deterministicVerdict(
      'unknown',
      UNKNOWN_SIGNAL_RATIONALE,
      [],
      test.testIndex,
    ))
}

/** Per-class counts, carried forward so the chain terminal can report them without a re-read. */
function summarizeVerdicts(verdicts: readonly Verdict[]): {
  total: number
  byClass: Partial<Record<Verdict['class'], number>>
} {
  const byClass: Partial<Record<Verdict['class'], number>> = {}
  for (const verdict of verdicts) {
    byClass[verdict.class] = (byClass[verdict.class] ?? 0) + 1
  }
  return { total: verdicts.length, byClass }
}

// A `Record`, so an added class is a compile error here, not an uncovered row.
const TEMPLATE_NEXT_ACTION: Record<Verdict['class'], string> = {
  test_bug: 'update the test to match the behaviour the app now has',
  app_bug: 'file the failure against the application with the quoted evidence',
  environment: 'check the environment or infrastructure dependency the run relied on',
  flake: 'watch for recurrence before changing the test or the app',
  config_error: 'fix the run configuration the signal names',
  llm_error: 'retry the run; the failure originated in the model pipeline, not the app',
  unknown: 'inspect the run manually — no deterministic signal matched',
  timeout: 'investigate the slow dependency or raise the step timeout deliberately',
}

// Step selection comes from `failingStepOf`/`errorTextOf`; a step-less test quotes its outcome.
function templateGroundingQuote(test: PerTestOutcome | undefined): VerdictGroundingQuote {
  if (test === undefined) return { source: 'test-outcome', quote: 'failed' }
  const step = failingStepOf(test)
  // `failingStepOf` answers undefined for exactly the zero-step test — the no-step arm.
  if (step === undefined) return { source: 'test-outcome', quote: test.outcome }
  return { stepIndex: step.stepIndex, quote: errorTextOf(step, test) }
}

// Exported for `analysis.get`'s floor leg, so the op renders parts through this same rule.
export function templateSentenceParts(
  verdict: Verdict,
  handoff: CompletedRunHandoff,
): VerdictSentenceParts {
  const test = handoff.tests.find((candidate) => candidate.testIndex === verdict.perTest)
  return {
    perTest: verdict.perTest,
    groundingQuote: templateGroundingQuote(test),
    discriminator:
      verdict.class === 'unknown'
        ? 'root cause undetermined'
        : `${verdict.class}: ${verdict.evidence.rationale}`,
    nextAction: TEMPLATE_NEXT_ACTION[verdict.class],
    links: [],
  }
}

// The recorded shape is `{runId, verdicts}`; sentence parts live in the artifact.
function realAnalyzeRunHandler(capabilities: PostRunJobCapabilities): JobHandler {
  return async (context) => {
    const payload = readAnalyzeRunPayload(context.payload)
    if (payload === undefined) {
      return permanently(
        'the analyze-run payload does not name a run, a handoff digest and a handoff schema ' +
          'version, so there is nothing for this job to analyse',
      )
    }

    let handoff: CompletedRunHandoff
    try {
      handoff = capabilities.loadCompletedRunHandoff(payload.runId)
    } catch (error) {
      return permanently(
        `the handoff for ${payload.runId} could not be read: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }

    if (handoff.schemaVersion !== payload.handoffSchemaVersion) {
      return permanently(
        `the handoff for ${payload.runId} declares schema version ` +
          `${String(handoff.schemaVersion)} and the job was enqueued against ` +
          String(payload.handoffSchemaVersion),
      )
    }
    // The digest pins that the analysed bytes are the ones the tail measured.
    if (sha256hex(canonicalJson(handoff)) !== payload.handoffDigest) {
      return permanently(
        `the handoff for ${payload.runId} no longer digests to the bytes this job was ` +
          'enqueued against, so analysing it would answer about a different run',
      )
    }

    // A fresh pass runs the callback once and persists the artifact before recording.
    const authored = await context.recordLlmAuthorship(
      'verdicts-authored',
      // The model arrives only as this argument; a floor with no unknown members reaches no model.
      async (model) => {
        const floor = projectHandoffVerdicts(handoff)
        // A limit stop or an unproven step is no app failure, so its floor verdict passes through.
        const limitStopped = new Set(
          handoff.tests
            .filter((test) =>
              test.steps.some((step) => step.limitStop !== undefined || stepOutcomeUnproven(step)),
            )
            .map((test) => test.testIndex),
        )
        const unknownTests = floor
          .filter((verdict) => verdict.class === 'unknown' && !limitStopped.has(verdict.perTest))
          .map((verdict) => verdict.perTest)

        let verdicts = floor
        const authoredParts = new Map<number, VerdictSentenceParts>()
        if (unknownTests.length > 0) {
          // The projection's product key, spelled the projection's way.
          const product = slugBranch(handoff.scope.key)
          const history: EvidenceHistoryLookup = (identity) =>
            capabilities.readTestHistory?.({
              product,
              filePath: identity.filePath,
              testName: identity.testName,
            })
          const result = await authorRunAnalysis(model, {
            handoff,
            floor,
            packs: buildEvidencePacks(handoff, unknownTests, history),
            history,
            ...(capabilities.analysisTokenBudget === undefined
              ? {}
              : { tokenBudget: capabilities.analysisTokenBudget }),
            // runId-curried so the author sees the plain `(sha) => bytes` shape.
            ...(capabilities.readEvidenceBlob === undefined
              ? {}
              : {
                  readEvidenceBlob: (sha: string) =>
                    capabilities.readEvidenceBlob?.(payload.runId, sha),
                }),
          })
          verdicts = result.verdicts
          for (const parts of result.authoredParts) authoredParts.set(parts.perTest, parts)
        }

        // LLM parts for upgraded members, template parts for the rest.
        const sentenceParts = verdicts.map((verdict) =>
          verdict.producer === 'analyze-run'
            ? authoredParts.get(verdict.perTest) ?? templateSentenceParts(verdict, handoff)
            : templateSentenceParts(verdict, handoff),
        )
        // Every member, authored or not, carries the low-trust records its own path served.
        const testsByIndex = new Map(handoff.tests.map((test) => [test.testIndex, test]))
        const stamped = verdicts.map((verdict, index) =>
          stampVerdictMemoryOnPath({
            verdict,
            parts: sentenceParts[index],
            test: testsByIndex.get(verdict.perTest),
          }),
        )
        capabilities.persistAnalysis({
          schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
          runId: payload.runId,
          verdicts: stamped,
          parts: sentenceParts,
        })
        return { runId: payload.runId, verdicts: stamped }
      },
    )
    const verdicts = authored.verdicts

    return {
      status: 'complete',
      next: [
        ...successorsOf(
          { kind: 'analyze-run', allowedSuccessors: ANALYZE_RUN_SUCCESSORS },
          String(context.job.id),
          {
            // Without these the daemon misreads the posture and curation misses the run.
            runId: payload.runId,
            executionContext: payload.executionContext ?? handoff.executionContext,
            verdictSummary: summarizeVerdicts(verdicts),
          },
        ),
      ],
    }
  }
}

// The curation fold runs inside this job; a capability that throws spends an attempt.
function realCurateMemoryHandler(capabilities: PostRunJobCapabilities): JobHandler {
  return async (context) => {
    const record = asRecord(context.payload)
    if (typeof record.runId !== 'string' || record.runId === '') {
      return permanently(
        'the curate-memory payload names no run, so there is no run directory to fold and no ' +
          'receipt to write',
      )
    }
    await context.publishCheckpoint('candidates-authored', { runId: record.runId })
    const counts = await capabilities.curateRun({
      runId: record.runId,
      executionContext: record.executionContext,
    })
    // Checked before publish: a fold that refused wrote no bundle, and refolding is its recovery.
    if (!counts.complete) {
      return {
        status: 'retryable',
        reason: counts.reason
          ?? 'the curation fold did not complete and wrote no receipt; the stage will retry '
            + 'under its declared bound',
      }
    }
    // Bundles are committed: an invalid snapshot is omitted, never retrying a finished fold.
    const parsedSnapshot = counts.snapshot === undefined
      ? undefined
      : CurationSnapshotSchema.safeParse(counts.snapshot)
    const curationSnapshot = parsedSnapshot?.success === true ? parsedSnapshot.data : undefined
    await context.publishCheckpoint('bundle-committed', {
      runId: record.runId,
      curated: counts.curated,
      deprecated: counts.deprecated,
      ...(curationSnapshot === undefined
        ? {}
        : { curationSnapshot }),
    })
    return { status: 'complete', next: [] }
  }
}

/**
 * Every kind, keyed by itself.
 *
 * `satisfies Record<JobKind, JobKindDeclaration>` is the compile-time half of completeness: a
 * kind added to the shipped vocabulary fails to typecheck here until it is declared. The registry-driven conformance test is the runtime half, and the two catch
 * different drifts — a missing entry versus an entry whose own `kind` field disagrees with
 * the slot it sits in.
 */
function declarationsFor(capabilities?: PostRunJobCapabilities) {
  return {
  // Chat is never checkpointed: its record is the session log, so one attempt.
  chat: {
    kind: 'chat',
    checkpointed: false,
    checkpointSchedule: [],
    allowedSuccessors: [],
    maxAttempts: 1,
    backoff: { kind: 'none' },
    onPermanentFailure: 'halt-chain',
    handler: standInHandler('chat', [], []),
  },

  // The chain's head. Its verdicts feed curate-memory — the one kind it declares and the one
  // it produces — and its permanent failure proceeds with unknown verdicts into that same kind.
  'analyze-run': {
    kind: 'analyze-run',
    checkpointed: true,
    checkpointSchedule: ['verdicts-authored'],
    allowedSuccessors: ANALYZE_RUN_SUCCESSORS,
    maxAttempts: 3,
    backoff: { kind: 'exponential', initialDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 },
    onPermanentFailure: analyzeRunFallback,
    handler: capabilities === undefined
      ? standInHandler('analyze-run', ['verdicts-authored'], ANALYZE_RUN_SUCCESSORS)
      : realAnalyzeRunHandler(capabilities),
  },

  // Two checkpoints: candidates are authored, then the bundle is committed.
  //
  // It declares no successor: its finish is the chain's terminal.
  'curate-memory': {
    kind: 'curate-memory',
    checkpointed: true,
    checkpointSchedule: ['candidates-authored', 'bundle-committed'],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'exponential', initialDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 },
    onPermanentFailure: 'halt-chain',
    handler: capabilities === undefined
      ? standInHandler(
          'curate-memory',
          ['candidates-authored', 'bundle-committed'],
          [],
        )
      : realCurateMemoryHandler(capabilities),
  },

  consolidate: {
    kind: 'consolidate',
    checkpointed: true,
    checkpointSchedule: ['consolidation-authored'],
    allowedSuccessors: [],
    maxAttempts: 2,
    backoff: { kind: 'fixed', delayMs: 5_000 },
    onPermanentFailure: 'halt-chain',
    handler: standInHandler('consolidate', ['consolidation-authored'], []),
  },

  } satisfies Record<JobKind, JobKindDeclaration>
}

// The no-capability set: harnesses read it and script analyze-run and curate-memory by payload.
export const REAL_JOB_KIND_DECLARATIONS: readonly JobKindDeclaration[] = Object.freeze(
  Object.values(declarationsFor()) as readonly JobKindDeclaration[],
)

// A fresh registry per call, so a test that registers extra kinds cannot leak into another.
export function createRealJobKindRegistry(
  capabilities?: PostRunJobCapabilities,
): JobKindRegistry {
  return createJobKindRegistry(
    capabilities === undefined
      ? REAL_JOB_KIND_DECLARATIONS
      : (Object.values(declarationsFor(capabilities)) as readonly JobKindDeclaration[]),
  )
}
