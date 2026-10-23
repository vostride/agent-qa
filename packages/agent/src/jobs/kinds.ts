import type { CurationSnapshot } from '@vostride/agent-qa-schema'
// The five real agent job kinds (Phase 385, D-09 / D-17 / D-18 / D-20).
//
// The kind set is closed and shipped, and this module declares every member of it. The
// declarations are the CONTRACT this phase ships; the handler bodies are deterministic
// stand-ins, and the two are not the same kind of thing. Real semantics for analyze-run and
// curate-memory arrive with the phases that own them — what has to exist now is a complete,
// registry-driven description of how each kind checkpoints, chains, retries and gives up,
// because the crash matrix iterates THAT rather than a list of its own.
//
// The stand-ins are scripted by payload, in the style of the v51 drain fixture's scripted
// author: a handler publishes its own declared schedule with its own bytes and then does
// exactly what the payload asked for. That matters for two separate reasons. Distinguishable
// bytes mean a matrix comparing five recovered histories is comparing five different things
// rather than five copies of one. Scriptable outcomes mean the adversarial legs — a chain, a
// retryable report, a permanent one — can be driven through the REAL kinds instead of through
// a synthetic stand-in that a later refactor could leave behind.
//
// Deliberately absent from every published byte: the attempt number and any timestamp. A
// checkpoint whose bytes changed with the attempt that wrote it would make an interrupted
// history differ from an uninterrupted one for a reason that has nothing to do with recovery,
// and the usual repair for a failing equality assertion is to loosen it.

import type { ReplayGatePort } from '../ports/gates.js'
import type {
  ChainedJobRequest,
  CompletedRunHandoff,
  ExecutionContext,
  GateReceipt,
  GateVerdict,
  JobHandlerOutcome,
  JobKind,
  KnowledgeBundleSummary,
  KnowledgeGatesListResult,
  MisdirectionRecordResult,
  MisdirectionRootPosture,
  PerTestOutcome,
  RunAnalysisArtifact,
  RunNotificationVerdictSummary,
  Verdict,
  VerdictGroundingQuote,
  VerdictSentenceParts,
} from '@vostride/agent-qa-schema'
import {
  asRecordId,
  canonicalJson,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  CurationSnapshotSchema,
  errorTextOf,
  failingStepOf,
  MisdirectionRecordResultSchema,
  RunNotificationSchemaError,
  sha256hex,
  slugBranch,
  stepOutcomeUnproven,
  validateAnalysisAgainstHandoff,
} from '@vostride/agent-qa-schema'
import type { JobCheckpointReadOutcome } from '../ports/job-store.js'
import { deterministicVerdict, UNKNOWN_SIGNAL_RATIONALE } from '@vostride/agent-qa-runner'

import {
  authorRunAnalysis,
  flippedRecordsOf,
  misdirectionValidationOptions,
  stampVerdictMisdirectionEvidence,
} from './analyze-run-author.js'
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

/**
 * analyze-run's ratified disposition: the chain proceeds with unknown verdicts (spec §1.2).
 *
 * Its downstream jobs must never wait on a dead head, so a permanently failed analysis hands
 * them the same successors a successful one would, marked as carrying no verdicts. Nothing
 * here reaches a model, and nothing here can: what it is given is the failed job, the payload
 * that job was handed, and the reason.
 *
 * "The same successors a successful one would" is true by construction: this fallback maps
 * over the one successor constant below, the same list the success path's `next`, the scripted
 * stand-in and the declaration itself all read. Declared equals produced, so a dead analysis
 * hands on exactly what a live one would and no path can enqueue what the topology never declared.
 *
 * 2026-09-01 (Phase 409): the reserved sixth kind left with the Issue-slot cleanup, and 388
 * D-04's declared/produced split collapsed with it.
 *
 * The extra carries the run's identity and posture forward for the same reason the success
 * path does (Pitfall 6): the successor may be claimed by the daemon, which resolves posture
 * from `payload.executionContext` (386 D-09/D-12), and curation cannot fold a run directory
 * it was never told about. The unknown-verdicts marker travels with them so the chain
 * terminal can report the analysis stage honestly from a job that succeeded afterwards.
 */
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

/**
 * The 422 D-13 edge, declared once and read by the declaration, the real handler and the
 * scripted stand-in alike — the same declared-equals-produced discipline the analyze-run edge
 * above rests on. `propose-improvements` is a kind this build has declared since 385; what this
 * constant adds is the successor relation that finally reaches it.
 */
//
// 2026-09-12, 422-22: stated as `as const satisfies readonly JobKind[]` rather than annotated,
// so the literal members survive into the type. An annotation widens the entries to `JobKind`
// and the edge stops being visible to anything reading the constant — which is the same D-22
// bar every other closed set in this milestone is held to.
const CURATE_MEMORY_SUCCESSORS = ['propose-improvements'] as const satisfies readonly JobKind[]

/**
 * The host powers the two real post-run handlers need, injected by the composition (D-01).
 *
 * Both are things `agent` cannot do and must never learn to: reading a file is a host API in
 * a storageNeutral package, and the curation drain lives two packages away behind the writer
 * lease. Passing them as capabilities is what lets the handler bodies be real here while the
 * bindings stay where the ownership is — and it is also the seam a test uses to drive the
 * chain without a knowledge root.
 *
 * The whole interface is OPTIONAL at construction. A registry built without it keeps the
 * scripted stand-ins byte-identically, because several shipped suites — engine semantics,
 * kind registry, the kill matrix — drive the REAL kinds by scripting their payloads, and a
 * build where those kinds could only do real work would have no way to express "chain here,
 * fail permanently there" without a knowledge root and a run directory per case.
 */
export interface PostRunJobCapabilities {
  /**
   * The run's persisted handoff, addressed by `runId` alone.
   *
   * Hard-fails typed on a missing or malformed document rather than answering `undefined`:
   * D-06 makes the PATH derived and the BYTES pinned, so "there is no handoff for this run"
   * is a permanent condition of that run, never a transient one worth retrying.
   */
  loadCompletedRunHandoff(runId: string): CompletedRunHandoff
  /**
   * The per-run fold, and the fold's own report of whether it FINISHED (WR-03).
   *
   * `complete` is not a nicety on the side of the counts: the v51 fold answers `false` for
   * candidate refusals, a cap exceeded, unresolved canaries, a failed outcome projection and
   * requeues, and in every one of those cases it writes NO receipt so the run refolds later.
   * Both production bindings used to return the counts alone, which is how a fold that refused
   * became a stage the durable notification row called `done` — the one place in this phase
   * where the record overstated what happened. It is part of the contract precisely so a
   * binding cannot drop it silently: omit it and the binding stops typechecking.
   */
  curateRun(input: {
    readonly runId: string
    readonly executionContext: unknown
    readonly deadlineMs?: number
  }): Promise<{
    readonly curated: number
    readonly deprecated: number
    readonly complete: boolean
    readonly snapshot?: CurationSnapshot
    /**
     * The candidates the fold's own receipt names, forwarded to the proposal stage (422 D-13).
     *
     * ADDITIVE-OPTIONAL rather than required, on this module's existing tolerance idiom, and the
     * distinction is carried through rather than flattened: ABSENT means the binding reported no
     * candidate ids at all, while `[]` means it reported that there were none. A required field
     * would have forced every host and every harness that scripts a fold to invent a value for a
     * question they are not the authority on — and the first thing a host invents here is `[]`,
     * which is the one answer that is indistinguishable from a real empty fold.
     */
    readonly candidateIds?: readonly string[]
    /** 2026-10-16 (442-10, D-17): why a fold that did not complete handed its run back. */
    readonly reason?: string
  }>
  /**
   * Put one run's analysis artifact durably on disk (389 D-09).
   *
   * Called INSIDE the author callback, before the verdicts-authored value is recorded — the
   * authorship primitive records only after the callback returns, so by the time any chip can
   * read `done` the sentence is already fetchable. Authored never overstates. The binding is
   * the host's (`agent-local` derives the path from `runId` the same way it derives the
   * handoff's — a job payload never carries a path); a synchronous throw here propagates out
   * of the author, no checkpoint is recorded, and the declared bound adjudicates the retry.
   */
  persistAnalysis(artifact: RunAnalysisArtifact): void
  /**
   * One test's recorded outcome history, keyed the projection's way — `product` =
   * `slugBranch(scope.key)` plus the stable test identity `filePath` + `testName`, NEVER
   * `testId` (389 plan 02's key law). Feeds D-02's forced prior-build channel and the
   * author's failure-history reasoning input. OPTIONAL: production hosts bind
   * knowledge-local's `readTestOutcomeHistory` in plan 06; unbound, the author runs with a
   * typed no-history diet — degraded, never a crash.
   */
  readTestHistory?(query: {
    readonly product: string
    readonly filePath: string
    readonly testName: string
  }): TestOutcomeHistoryLike | undefined
  /**
   * D-01's TokenAccounting substrate entering as DATA — the estimator and input budget the
   * author's compaction ladder walks against. OPTIONAL: plan 06 binds it from the same
   * profile resolution as the job model; unbound, the packs travel whole (no ladder) and
   * the model call carries whatever they weigh.
   */
  analysisTokenBudget?: {
    readonly estimate: (text: string) => number
    readonly inputBudget: number
  }
  /**
   * D-02's capability-gated screenshot bytes: the CASS-02 evidence-blob store read,
   * sha-addressed within one run's directory. OPTIONAL: plan 06 binds it at the production
   * hosts; unbound — or with a model that does not advertise vision — the author's request
   * is text-only, the L9 graceful degradation, never an error.
   */
  readEvidenceBlob?(runId: string, sha: string): Uint8Array | undefined
  /**
   * 2026-09-12, 422 D-19: which evaluation-root posture this run's circularity evidence was
   * produced under.
   *
   * The rows themselves cannot answer it. An ABSENT root and a BROKEN one both publish the same
   * empty ledger — that is precisely why 422-14 records the posture in its own durable file —
   * and only the first earns `backing: 'declared-only'`. Reading that file is a host API, so the
   * posture arrives here as a capability rather than as something this package learns to look up.
   *
   * OPTIONAL, and unbound is FAIL-CLOSED rather than permissive: a run whose posture nobody can
   * state is treated as an ordinary `'eval-root'`, which is 422-11's own default and which makes
   * an empty ledger an unresolved cross-check rather than a BYOM exemption. A throw is read the
   * same way — a posture this process could not obtain is not a posture it may assume.
   */
  readMisdirectionRootPosture?(runId: string): MisdirectionRootPosture | undefined
  /**
   * 2026-09-07, 417 D-18: typed now, bound nowhere in 417. Phase 422's
   * propose-improvements binds this seam; the five-kind chain is untouched.
   *
   * 2026-09-11, 422 D-14: the proposal stage CALLS it. Its resolved receipt means the writer
   * acknowledged persisting one (`ReplayGatePort`'s own contract) — anything else throws, and
   * the handler reads the throw as a charged slot with an unknown outcome rather than as a
   * screening result it may record.
   */
  runReplayGate?: ReplayGatePort['runReplayGate']
  /**
   * Every committed bundle, as the reader entry's listing row (422 D-14).
   *
   * Structurally `KnowledgeReaderPort['listBundles']`, declared here rather than imported so this
   * module keeps naming only schema DTOs. OPTIONAL: unbound, the Gate-1 leg is a typed no-op.
   */
  listBundles?(): Promise<readonly KnowledgeBundleSummary[]>
  /**
   * One record's gate history, standing evidence and live verdict (422 D-14).
   *
   * The SELECTION reads this, not a store: a candidate is ungated when it carries no standing
   * Gate-1 line under the current corpus digest, and that question is answerable from the
   * committed receipts alone. OPTIONAL on the same terms as the listing.
   */
  gateReceiptsFor?(input: { readonly candidateId: string }): Promise<KnowledgeGatesListResult>
  /**
   * Which corpus this product's Gate-1 evidence is currently measured against (422 D-14).
   *
   * The digest is what makes a standing receipt a DECISION rather than a historical note: a
   * receipt produced against a corpus that has since moved decided a different question. A
   * posture that cannot resolve — a broken root, an unreadable floor — completes the stage
   * `posture-unavailable` and spends nothing, which is a report rather than a retry loop.
   */
  readProposeCorpusPosture?(input: {
    readonly product: string
  }): Promise<ProposeCorpusPosture>
  /**
   * This job's durable Gate-1 charge, read back from the authoritative checkpoint (422 D-14).
   *
   * NARROW on purpose: one checkpoint, addressed by this job's own id, read-only. The handler is
   * not handed a store, a checkpoint reader or a path — the composition that owns the store binds
   * this one question, and `parseProposeGate1Allowance` below is the shape check it binds through.
   */
  readProposeGate1Allowance?(jobId: string): Promise<ProposeGate1AllowanceRead>
  /**
   * The operator's `eval.gate1.maxPerJob` override, already resolved by the host (422 D-14).
   *
   * DATA rather than a reader, because the handler must not learn to read configuration. Absent
   * means the recorded default, and the difference is disclosed on the charge as `cap.source` so
   * a reader can tell a deliberate bound from an inherited one.
   */
  proposeGate1MaxPerJob?: number
  /**
   * The third stage's work, as a NEUTRAL optional port (422 D-13).
   *
   * Optional on exactly the terms `readTestHistory` and `readEvidenceBlob` are: a host that does
   * not bind it is not a broken host, it is a host that stages nothing. The stage still RUNS —
   * it publishes its checkpoint, lands `done` and terminates the chain — and the record then
   * reports a proposal stage that reached the port and proposed nothing, with no counts at all.
   * That is a different sentence from `proposed: 0`, and the counts are omitted precisely so the
   * two cannot be confused.
   *
   * Neutral in the same sense the two real handlers' other capabilities are: it names no store,
   * no knowledge root and no model. The adversarial staging itself lives two packages away
   * behind an operator admission seam this package may not reach, and binding it here would be
   * the import edge the architecture refuses.
   */
  stageAdversarialProposal?(input: {
    readonly runId: string
    readonly executionContext: ExecutionContext | undefined
    readonly candidateIds: readonly string[]
    readonly upstream: ProposeImprovementsUpstream
  }): Promise<{ readonly proposed: number; readonly skipped: number }>
}

/**
 * The minimal structural mirror of knowledge-local's `TestOutcomeHistory` row (389 plan 02).
 *
 * Declared HERE rather than imported because the dependency points the other way — this
 * package never names knowledge-local — and structural typing makes the real
 * `readTestOutcomeHistory` record assignable unchanged at the plan 06 binding. It also
 * matches `evidence-diet.ts`'s `EvidenceTestHistory` member-for-member, so one capability
 * answer feeds both the diet's prior-build channel and the author's reasoning input.
 */
export interface TestOutcomeHistoryLike {
  readonly passes: number
  readonly failures: number
  readonly heals: number
  readonly flakeCount: number
  readonly lastOutcomes: readonly { readonly buildOrdinal: number; readonly passed: boolean }[]
  readonly lastBuildOrdinal: number | undefined
}

/**
 * The claim shape analyze-run is enqueued with (D-06). Anything else is unreadable input.
 *
 * The two markers below are ADDITIVE-OPTIONAL (393 D-20, WTST-06): the enqueue site copies them
 * from the loaded handoff, and every job already sitting in a durable queue predates them. They
 * are queue-level VISIBILITY, never integrity — the digest field above already covers the
 * handoff bytes these values also live inside, so a consumer that needs the authoritative
 * answer reads the handoff, not this copy.
 */
export interface AnalyzeRunPayload {
  readonly runId: string
  readonly handoffDigest: string
  readonly handoffSchemaVersion: number
  readonly executionContext: ExecutionContext | undefined
  /**
   * D-10's verify-before-present gate-run marker, mirroring the handoff carrier's `?: true`
   * idiom. A DISTINCT axis from `excludedFromOutcomes` — C8 ratified that gate runs DO feed
   * curation, so neither marker may be read as implying the other.
   */
  readonly gateRun?: true
  /** D-14 §6's outcome-exclusion marker, same carrier idiom, same literal-only rule. */
  readonly excludedFromOutcomes?: true
  /**
   * 422 D-17/D-18: the pre-enqueue arbiter's per-record cross-check rows, copied off the same
   * handoff `handoffDigest` names (422-14's enqueue site).
   *
   * ABSENT is not EMPTY here either: absent means the arbiter never ran (every job queued before
   * 422-14), `[]` means it ran and recorded nothing. The copy is VISIBILITY, exactly as the two
   * markers above are — the handoff is what the digest covers, so the handler reads its authority
   * off the loaded document and uses this copy only to notice a queue row that disagrees with the
   * bytes it points at.
   */
  readonly misdirectionEvidence?: readonly MisdirectionRecordResult[]
  /**
   * Set when the key was PRESENT and this build could not read it.
   *
   * Deliberately not folded into absence, on 422-08's `unreadable`-is-not-`absent` rule. Absence
   * says the arbiter never ran and turns the gate off; an unreadable claim says a producer wrote
   * something this build cannot check, and degrading that to "never ran" would silently disarm
   * the guard for exactly the payload that most deserves it. The handler refuses instead.
   */
  readonly misdirectionEvidenceUnreadable?: true
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
    ...readCarriedMisdirectionEvidence(record.misdirectionEvidence),
  }
}

/**
 * The additive-optional circularity copy, read the way this module reads every durable payload
 * member — tolerantly about GENERATION, strictly about SHAPE.
 *
 * An absent key is an older producer and stays absent. A present key whose rows all parse is
 * carried verbatim. A present key that does not parse is neither dropped nor guessed at: it is
 * marked unreadable, and the handler turns that into a permanent refusal. Dropping it would be
 * the one failure this whole block exists to prevent — a gated run quietly re-read as a
 * historical one, whose no-trust-change verdict is then accepted on its own word.
 */
function readCarriedMisdirectionEvidence(
  value: unknown,
): Pick<AnalyzeRunPayload, 'misdirectionEvidence' | 'misdirectionEvidenceUnreadable'> {
  if (value === undefined) return {}
  if (!Array.isArray(value)) return { misdirectionEvidenceUnreadable: true as const }
  const rows: MisdirectionRecordResult[] = []
  for (const candidate of value) {
    const parsed = MisdirectionRecordResultSchema.safeParse(candidate)
    if (!parsed.success) return { misdirectionEvidenceUnreadable: true as const }
    rows.push(parsed.data as MisdirectionRecordResult)
  }
  return { misdirectionEvidence: rows }
}

/**
 * What the two earlier stages already did, carried forward to the third (422 D-13).
 *
 * Every member is OPTIONAL and every absence is a real, different situation rather than a
 * default: no `analysisStatus` means this payload does not say what became of the analysis, and
 * no `curation` means it does not say what the fold committed. The terminal builder reads the
 * absences as absences — it never fills them with zeros — because this block exists precisely so
 * the record can report stages the finishing job did not run, and a block that guessed would be
 * a more confident lie than saying nothing.
 */
export interface ProposeImprovementsUpstream {
  readonly verdictSummary?: RunNotificationVerdictSummary
  readonly analysisStatus?: 'done' | 'failed'
  readonly curation?: {
    readonly curated?: number
    readonly deprecated?: number
    readonly complete?: true
    readonly curationSnapshot?: CurationSnapshot
  }
}

/**
 * The claim shape propose-improvements is enqueued with (422 D-13).
 *
 * `runId` is the only member the stage cannot work without, and it is also what makes the job a
 * RUN's chain member at all — the engine decides a chain terminal on it. Everything else
 * degrades: `candidateIds` to the empty list, `upstream` to a block that claims nothing.
 */
export interface ProposeImprovementsPayload {
  readonly runId: string
  readonly executionContext: ExecutionContext | undefined
  readonly candidateIds: readonly string[]
  readonly upstream: ProposeImprovementsUpstream
}

/**
 * Additive-tolerant, on exactly `readAnalyzeRunPayload`'s terms and for the same reason.
 *
 * These bytes come off a DURABLE queue: a job may have been written by an older build that had
 * no `upstream` block, or a newer one carrying a key this build has never heard of. Refusing
 * either would strand committed curation behind an unrunnable stage, so unknown keys are ignored
 * and unreadable members degrade to absence. The strict half of the contract lives on the
 * PRODUCER side — `realCurateMemoryHandler` below, where a bad shape means a bug in code that
 * just ran and the refusal is actionable.
 *
 * A non-string candidate id is DROPPED rather than stringified: an id this build cannot read is
 * not an id it may invent, and a `String(undefined)` reaching the staging port would address a
 * candidate that does not exist.
 */
export function readProposeImprovementsPayload(
  value: unknown,
): ProposeImprovementsPayload | undefined {
  const record = asRecord(value)
  if (typeof record.runId !== 'string' || record.runId === '') return undefined

  const upstreamSource = asRecord(record.upstream)
  const curationSource = asRecord(upstreamSource.curation)
  const summary = asRecord(upstreamSource.verdictSummary)
  const snapshot = curationSource.curationSnapshot === undefined
    ? undefined
    : CurationSnapshotSchema.safeParse(curationSource.curationSnapshot)
  if (snapshot !== undefined && !snapshot.success) {
    throw new RunNotificationSchemaError('its curation snapshot is invalid')
  }
  const curation = {
    ...(isCount(curationSource.curated) ? { curated: curationSource.curated } : {}),
    ...(isCount(curationSource.deprecated) ? { deprecated: curationSource.deprecated } : {}),
    ...(curationSource.complete === true ? { complete: true as const } : {}),
    ...(snapshot?.success ? { curationSnapshot: snapshot.data } : {}),
  }

  return {
    runId: record.runId,
    executionContext:
      typeof record.executionContext === 'string'
        ? (record.executionContext as ExecutionContext)
        : undefined,
    candidateIds: Array.isArray(record.candidateIds)
      ? record.candidateIds.filter((id): id is string => typeof id === 'string')
      : [],
    upstream: {
      ...(isCount(summary.total)
        ? { verdictSummary: summary as unknown as RunNotificationVerdictSummary }
        : {}),
      ...(upstreamSource.analysisStatus === 'done' || upstreamSource.analysisStatus === 'failed'
        ? { analysisStatus: upstreamSource.analysisStatus }
        : {}),
      ...(Object.keys(curation).length === 0 ? {} : { curation }),
    },
  }
}

/** Non-negative whole numbers only — the counts idiom this module shares with the record. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * A permanent report, phrased once.
 *
 * Every unreadable-input path below is PERMANENT rather than retryable, and that is A1 rather
 * than pessimism: a payload whose shape is wrong, a handoff that is not there, bytes that
 * drifted — none of them becomes right on a second attempt, and retrying them would spend a
 * bound the poison-job case needs.
 */
function permanently(reason: string): JobHandlerOutcome {
  return { status: 'permanent', reason }
}

/**
 * Members whose outcome is worth a root-cause verdict.
 *
 * The complement of the runner's own presence rule (373-07): clean passes, skipped and
 * cancelled members are not failures to explain. Everything else gets a verdict, which is
 * what keeps the checkpoint's array in step with what the analysis chip claims to cover.
 */
function needsVerdict(test: PerTestOutcome): boolean {
  return test.outcome !== 'passed' && test.outcome !== 'skipped' && test.outcome !== 'cancelled'
}

/**
 * The D-02 bridge: PROJECT the verdicts the runner already persisted; never re-classify.
 *
 * Re-running the classifier here is not merely redundant, it is impossible to do faithfully —
 * it reads `TestResult.retryCount`, which `PerTestOutcome` deliberately does not carry, so a
 * handler that "re-classified" would be classifying from strictly less evidence and quietly
 * disagreeing with the verdict already on disk. An absent verdict is filled with the same
 * 'unknown' the classifier itself mints, so the array covers every failed member and 389 can
 * supersede exactly the ones that carry no signal.
 */
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

/**
 * The one concrete next action a template sentence names, total over the verdict union
 * (389 D-06). A `Record` rather than an if-chain so an added class is a compile error here,
 * not an uncovered row — the 388-11 `postureOf` discipline.
 */
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

/**
 * A verbatim quote of captured evidence for one member test (389 D-06).
 *
 * Step selection and error-text precedence come from schema's ONE exported input rule
 * (`failingStepOf`/`errorTextOf`, hoisted by 390 plan 02): the first failed step else the last,
 * then the first sub-action error text else the verifier's own reasoning. This quote and the
 * fingerprint window are now the SAME rule by construction rather than by parallel maintenance.
 * A test that captured ZERO steps quotes its test-level outcome through the typed no-step arm —
 * never a fabricated stepIndex. Every branch quotes bytes the run actually recorded; templates
 * assemble around the quote, the quote itself is never authored.
 */
function templateGroundingQuote(test: PerTestOutcome | undefined): VerdictGroundingQuote {
  if (test === undefined) return { source: 'test-outcome', quote: 'failed' }
  const step = failingStepOf(test)
  // `failingStepOf` answers undefined for exactly the zero-step test — the no-step arm.
  if (step === undefined) return { source: 'test-outcome', quote: test.outcome }
  return { stepIndex: step.stepIndex, quote: errorTextOf(step, test) }
}

/**
 * Producer-keyed template parts for one floor verdict (389 D-06).
 *
 * Deterministic classes get code-authored parts derived from the hard signal that minted the
 * class — the classifier's rationale IS that signal, so the discriminator carries it.
 * `unknown` gets the honest "root cause undetermined" discriminator and the manual-inspection
 * next action; plan 04's LLM upgrade replaces exactly those members through the same author
 * callback, and nothing else changes shape.
 *
 * Exported (module-level, NOT on the package barrel) for the `analysis.get` op's floor leg:
 * a run with no artifact renders honest parts through THIS same rule — a second spelling of
 * the template inside the op would be exactly the D-06 drift the one-rule law forbids.
 */
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

// ---- 422 D-17..D-20: the circularity guard, at the one seam that authors verdicts -----------
//
// 422-11 shipped the gate with BOTH options defaulting fail-closed and recorded the seam plainly:
// no producer passes `gatedProducerEvidence` or a `rootPosture`, so the arm is off. 422-14 shipped
// the producer. This is where the two meet, and the meeting has exactly one switch:
//
//   the analysed handoff carries a `misdirectionEvidence` member  ->  the arm is ON
//   it does not                                                   ->  the arm is OFF, historically
//
// The switch is the MEMBER's presence and not its contents, because that is what "the arbiter ran"
// means: an empty ledger is a producer that ran and recorded nothing (a skipped run, an absent
// root, a broken one), and an absent member is every run written before the producer existed.
//
// TURNING A FAIL-CLOSED DEFAULT ON IS THE RISKIEST EDIT IN THIS PHASE, so the off arm is not
// merely "the same code with a flag" — it is the same CALL. `misdirectionValidationOptions`
// answers `{}` for an absent ledger, which is the argument every caller passed before 422 and the
// one `validateAnalysisAgainstHandoff` defaults to, and nothing below runs at all.

/** The posture, fail-closed: unbound, unanswered and throwing all read as an ordinary root. */
function readMisdirectionPosture(
  capabilities: PostRunJobCapabilities,
  runId: string,
): MisdirectionRootPosture {
  try {
    return capabilities.readMisdirectionRootPosture?.(runId) ?? 'eval-root'
  } catch {
    return 'eval-root'
  }
}

/**
 * The honest floor for a verdict the evidence does not support (D-20).
 *
 * `unknown` rather than a softer class, because every other class either moves trust (and the
 * evidence cannot justify moving it) or claims no trust change (which is the claim just refused).
 * The floor keeps the refused verdict's CITED STEPS so the stamp that follows recomputes the same
 * path — an exposure dropped here would be an exposure the record stops disclosing — and it stops
 * claiming `memoryMisdirectionRuledOut`, which is the whole content of what was refused.
 */
function honestUnknownFloor(refused: Verdict, test: PerTestOutcome | undefined): Verdict {
  const floor = deterministicVerdict(
    'unknown',
    UNKNOWN_SIGNAL_RATIONALE,
    capturedStepsOnly(refused.evidence.citedSteps, test),
    refused.perTest,
  )
  return { ...floor, memoryMisdirectionRuledOut: false }
}

/**
 * Keep only the steps the member actually captured, in the member's own order.
 *
 * A citation is carried onto a floor verdict to preserve the disclosure it covered, and one way
 * to earn a refusal in the first place is to cite a step that does not exist. Carrying that
 * forward would persist an artifact the validator rejects for a reason this arm did not create.
 */
function capturedStepsOnly(
  cited: readonly number[],
  test: PerTestOutcome | undefined,
): number[] {
  if (test === undefined) return []
  const captured = new Set(test.steps.map((step) => step.stepIndex))
  return test.steps
    .map((step) => step.stepIndex)
    .filter((stepIndex) => captured.has(stepIndex) && cited.includes(stepIndex))
}

/**
 * Give a member the author degraded back the citation of the claim that was refused (422-15).
 *
 * ONLY under a published ledger, and only for a member that actually fell to the floor. The
 * widening exists so the circularity disclosure survives the fall: without it a member refused
 * because a record on a CITED step flipped lands as an `unknown` beside the failing step's own
 * held ledger, with no trace of the record that caused it. For a run whose arbiter never ran
 * there is no disclosure to preserve, and the floor stays byte-identical to what 389 wrote.
 */
function widenRefusedFloorPaths(
  verdicts: readonly Verdict[],
  degradedPaths: readonly { readonly perTest: number; readonly citedSteps: readonly number[] }[],
  handoff: CompletedRunHandoff,
): Verdict[] {
  if (degradedPaths.length === 0) return [...verdicts]
  const testsByIndex = new Map(handoff.tests.map((test) => [test.testIndex, test]))
  return verdicts.map((verdict) => {
    const refused = degradedPaths.find((path) => path.perTest === verdict.perTest)
    if (refused === undefined || verdict.class !== 'unknown') return verdict
    const widened = capturedStepsOnly(
      [...verdict.evidence.citedSteps, ...refused.citedSteps],
      testsByIndex.get(verdict.perTest),
    )
    if (widened.length === verdict.evidence.citedSteps.length) return verdict
    return {
      ...verdict,
      evidence: { ...verdict.evidence, citedSteps: widened },
    } as Verdict
  })
}

/**
 * Stamp every verdict, then enforce the floor over the whole artifact (D-17/D-18/D-20).
 *
 * THE DOUBLE VALIDATION IS THE POINT. The gated posture and the historical one are run over the
 * same stamped artifact, and only a member the GATED posture refuses and the historical one
 * accepts is downgraded. Anything both refuse is a pre-existing condition that has nothing to do
 * with this arm — a verdict citing a step that does not exist was already being persisted that
 * way — and this plan deliberately leaves it exactly where it was. What is measured is the
 * DIFFERENCE the arm makes, which is also the only thing the arm is entitled to change.
 *
 * DETERMINISTIC VERDICTS GO THROUGH THIS TOO. The author upgrades `unknown` floor members and
 * nothing else, so before today a persisted `app_bug` or a classifier-minted `environment` reached
 * the artifact having never met the gate at all. A guard with a hole the size of the classifier is
 * not a guard, and the cross-check does not care which producer wrote the sentence it refutes.
 */
function enforceMisdirectionFloor(input: {
  readonly verdicts: readonly Verdict[]
  readonly handoff: CompletedRunHandoff
  readonly runId: string
  readonly evidence: readonly MisdirectionRecordResult[] | undefined
  readonly rootPosture: MisdirectionRootPosture
  readonly partsOf: (verdicts: readonly Verdict[]) => VerdictSentenceParts[]
}): { readonly verdicts: Verdict[]; readonly parts: VerdictSentenceParts[] } {
  const { handoff, runId, evidence, rootPosture, partsOf } = input
  const testsByIndex = new Map(handoff.tests.map((test) => [test.testIndex, test]))
  const stampAll = (verdicts: readonly Verdict[], parts: readonly VerdictSentenceParts[]) =>
    verdicts.map((verdict, index) =>
      stampVerdictMisdirectionEvidence({
        verdict,
        parts: parts[index],
        test: testsByIndex.get(verdict.perTest),
        evidence,
        rootPosture,
      }),
    )

  const parts = partsOf(input.verdicts)
  // The arbiter never ran: nothing is stamped, nothing is validated, nothing moves.
  if (evidence === undefined) return { verdicts: [...input.verdicts], parts }

  const stamped = stampAll(input.verdicts, parts)
  const artifact: RunAnalysisArtifact = {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: stamped,
    parts,
  }
  const gated = validateAnalysisAgainstHandoff(
    artifact,
    handoff,
    misdirectionValidationOptions(evidence, rootPosture),
  )
  let downgraded = stamped
  if (!gated.ok) {
    const historical = validateAnalysisAgainstHandoff(artifact, handoff)
    const preExisting = new Set(historical.ok ? [] : historical.rejects.map((r) => r.perTest))
    const newlyRefused = new Set(
      gated.rejects.map((reject) => reject.perTest).filter((perTest) => !preExisting.has(perTest)),
    )
    if (newlyRefused.size > 0) {
      downgraded = input.verdicts.map((verdict) =>
        newlyRefused.has(verdict.perTest)
          ? honestUnknownFloor(verdict, testsByIndex.get(verdict.perTest))
          : verdict,
      )
    }
  }

  // Parts are recomputed BEFORE the final stamp: a downgraded member's producer moved back to the
  // classifier, so its sentence is now the template's honest "root cause undetermined" — and the
  // grounding step that sentence quotes is part of the path the stamp recomputes over. Stamping
  // against the pre-downgrade parts would declare a membership the validator no longer recomputes.
  const finalParts = partsOf(downgraded)
  const finalVerdicts = stampAll(downgraded, finalParts).map(withCausalAttribution)
  return { verdicts: finalVerdicts, parts: finalParts }
}

/**
 * Name the harm, and name it narrowly (D-20).
 *
 * Only an `unknown` verdict carries attribution from here — a verdict that kept its class was not
 * harmed by the memory — and only the records an actual FLIP supports are named. A held sibling of
 * a flipped record stays in `memoryOnPath` and out of `attribution`: disclosed, never accused.
 */
function withCausalAttribution(verdict: Verdict): Verdict {
  if (verdict.class !== 'unknown') return verdict
  const flipped = flippedRecordsOf(verdict)
  if (flipped.length === 0) return verdict
  return {
    ...verdict,
    memoryMisdirectionRuledOut: false,
    attribution: { records: flipped.map((record) => asRecordId(record)), anchors: [] },
  } as Verdict
}

/**
 * The real analyze-run body (D-02 / D-06 / 389 D-09).
 *
 * Reads the run's handoff through the injected capability, refuses anything that is not the
 * document the enqueuer measured, authors the verdicts through `recordLlmAuthorship`, and
 * hands curation the one successor D-04 allows. The recorded SHAPE — `{runId, verdicts}` —
 * is the frozen 388 D-02 byte-shape; sentence parts live in the analysis artifact the author
 * persists BEFORE its value is recorded, never on the checkpoint.
 */
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
    // D-06's bytes-drifted rule. The digest is the whole reason the payload carries no path:
    // it pins that the bytes being analysed are the bytes the tail measured, whoever rewrote
    // the file in between.
    if (sha256hex(canonicalJson(handoff)) !== payload.handoffDigest) {
      return permanently(
        `the handoff for ${payload.runId} no longer digests to the bytes this job was ` +
          'enqueued against, so analysing it would answer about a different run',
      )
    }

    // 422 D-17/D-18: the payload's circularity copy must agree with the bytes the digest above
    // just pinned, BEFORE anything uses either. The handoff is the authority — it is what
    // `handoffDigest` covers — so the copy can neither weaken nor strengthen it; what a copy CAN
    // do is disagree, and a queue row that disagrees with the document it points at is not a row
    // about this run's evidence. Both refusals are permanent for the same reason every other
    // unreadable-input refusal here is: a second attempt reads the same bytes.
    if (payload.misdirectionEvidenceUnreadable === true) {
      return permanently(
        `the analyze-run payload for ${payload.runId} carries a circularity ledger this build ` +
          'cannot read, and a claim that cannot be checked is not a claim that may be ignored',
      )
    }
    const publishedEvidence = handoff.misdirectionEvidence
    if (
      payload.misdirectionEvidence !== undefined &&
      (publishedEvidence === undefined ||
        canonicalJson(payload.misdirectionEvidence) !== canonicalJson(publishedEvidence))
    ) {
      return permanently(
        `the analyze-run payload for ${payload.runId} carries circularity evidence that is not ` +
          'the evidence in the analysed handoff bytes; the digest covers the handoff, so a copy ' +
          'that disagrees with it is not about these bytes',
      )
    }
    const rootPosture = readMisdirectionPosture(capabilities, payload.runId)

    // The author swap (389 D-09/JOBQ-03). On a fresh pass the callback runs exactly once:
    // floor projected, template parts authored, the artifact made durable through
    // `persistAnalysis`, and only THEN is the returned value recorded on the declared
    // checkpoint — the primitive awaits the record before handing the value back, so the
    // artifact-before-checkpoint ordering is structural, not scheduled. On a resume with a
    // recorded value, control never reaches this callback: the author is not re-invoked and
    // the artifact is not rewritten (the recorded-value path).
    const authored = await context.recordLlmAuthorship(
      'verdicts-authored',
      // The full author (389 plan 04): the model capability arrives ONLY as this
      // callback's argument. Unknown floor members are authored through
      // `authorRunAnalysis` — one whole-run call, one repair, per-test degrade — and
      // everything else passes through byte-identical; a floor with no unknown members
      // (or no failures at all) reaches no model. Signature, artifact-write position and
      // returned shape are final from plan 01.
      async (model) => {
        const floor = projectHandoffVerdicts(handoff)
        // 436 D-12: a limit stop is the run running out of limit, and 439 D-07: a step the
        // verifier left unverified or inconclusive is unproven, not an application failure.
        // Neither is something a model may label; their floor verdicts pass through byte-identical.
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
          // The projection's product key, spelled the projection's way (plan 02 key law).
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
            // The ledger reaches the author as DATA and the gate as AUTHORITY (D-20). Absent, it
            // does neither: the request is byte-identical to the pre-422 one and the author's own
            // validation runs under the historical options.
            ...(publishedEvidence === undefined
              ? {}
              : { misdirectionEvidence: publishedEvidence, rootPosture }),
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
          // 422-15: a member the author refused keeps the citation of the claim it refused, so
          // the circularity disclosure computed below still covers every exposure that claim did.
          // Gated on a published ledger: with none there is nothing to disclose and the floor
          // stays exactly the array 389 wrote.
          verdicts =
            publishedEvidence === undefined
              ? result.verdicts
              : widenRefusedFloorPaths(result.verdicts, result.degradedPaths, handoff)
          for (const parts of result.authoredParts) authoredParts.set(parts.perTest, parts)
        }

        // D-06's ONE producer-keyed parts rule: LLM parts for upgraded members, template
        // parts for deterministic members — which is also what hands a degraded/unfilled
        // `unknown` its honest "root cause undetermined" sentence.
        const partsOf = (candidates: readonly Verdict[]): VerdictSentenceParts[] =>
          candidates.map((verdict) =>
            verdict.producer === 'analyze-run'
              ? authoredParts.get(verdict.perTest) ?? templateSentenceParts(verdict, handoff)
              : templateSentenceParts(verdict, handoff),
          )
        // 422 D-17/D-18: the code-owned stamp and the honest floor, over EVERY member — the
        // author's upgrades and the members that never reached it alike.
        const guarded = enforceMisdirectionFloor({
          verdicts,
          handoff,
          runId: payload.runId,
          evidence: publishedEvidence,
          rootPosture,
          partsOf,
        })
        capabilities.persistAnalysis({
          schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
          runId: payload.runId,
          verdicts: guarded.verdicts,
          parts: guarded.parts,
        })
        return { runId: payload.runId, verdicts: guarded.verdicts }
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
            // Pitfall 6: a successor payload without these two is the DAEM-02 bug class — the
            // daemon resolves a claimed job's posture from `payload.executionContext` (386
            // D-09/D-12), and curation cannot find a run directory it was never told about.
            runId: payload.runId,
            executionContext: payload.executionContext ?? handoff.executionContext,
            verdictSummary: summarizeVerdicts(verdicts),
          },
        ),
      ],
    }
  }
}

/**
 * The real curate-memory body (D-01).
 *
 * The v51 curation fold runs INSIDE this job rather than beside it, which is what makes one
 * canonical pipeline out of two — and what makes the curation chip incapable of lying about
 * who did the work. The drain itself arrives as a capability: it needs the writer lease, a
 * knowledge root and a run directory, none of which this package may name.
 *
 * A capability that throws is reported as nothing at all: the engine catches it, spends an
 * attempt, and decides between a retry and a permanent failure from the declared bound. That
 * asymmetry is deliberate — this handler cannot know whether a drain failure is transient.
 */
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
    // WR-03. The gate sits BEFORE the publish, not after it: `bundle-committed` is named for an
    // event, and a fold that refused wrote no bundle. Publishing it and then reporting the
    // failure would leave the chain terminal reading counts off a checkpoint whose event never
    // happened. Retryable rather than permanent because the fold's own recovery IS a refold —
    // it withheld the receipt precisely so the run folds again — and the declared bound
    // (maxAttempts: 3, onPermanentFailure: 'halt-chain') is what decides when refolding stops.
    if (!counts.complete) {
      return {
        status: 'retryable',
        reason: counts.reason
          ?? 'the curation fold did not complete and wrote no receipt; the stage will retry '
            + 'under its declared bound',
      }
    }
    // WR-02. The bundles are committed by now: a snapshot that does not validate is omitted and the
    // legacy counts are published alone, rather than throwing into a retry of a finished fold.
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
    // 422 D-13. The successor is produced for EVERY completed fold, including one that curated
    // nothing: zero work is still work that finished, and a successor gated on the counts would
    // drop exactly the quiet runs — which reads, to every later reader, like a chain that stalled.
    //
    // What travels with it is the upstream truth, and it travels because it has to: the job that
    // lands the chain terminal from here on is the proposal job, which did not do the analysis and
    // did not do this fold. Whatever is not on this payload is not in the durable record.
    return {
      status: 'complete',
      next: [
        ...successorsOf(
          { kind: 'curate-memory', allowedSuccessors: CURATE_MEMORY_SUCCESSORS },
          String(context.job.id),
          {
            // Pitfall 6 / 386 D-09, one edge further along: without these two the
            // daemon-claimed successor resolves a drain-scoped posture and cannot address
            // the run it is proposing about.
            runId: record.runId,
            ...(record.executionContext === undefined
              ? {}
              : { executionContext: record.executionContext }),
            // Absent when the fold reported none — see the capability's own comment for why the
            // empty list and the missing field are deliberately not the same answer.
            ...(counts.candidateIds === undefined
              ? {}
              : { candidateIds: [...counts.candidateIds] }),
            upstream: {
              ...(record.verdictSummary === undefined
                ? {}
                : { verdictSummary: record.verdictSummary }),
              // The dead-analysis marker, restated where the next stage will look for it. The
              // root of THIS payload belongs to the analysis; the root of the next belongs to
              // the fold, so the fact has to be re-carried or it is lost at this edge.
              analysisStatus: record.verdicts === UNKNOWN_VERDICTS_MARKER ? 'failed' : 'done',
              curation: {
                curated: counts.curated,
                deprecated: counts.deprecated,
                complete: true,
                ...(curationSnapshot === undefined ? {} : { curationSnapshot }),
              },
            },
          },
        ),
      ],
    }
  }
}


// ---- 422 D-14: the per-job Gate-1 allowance ------------------------------------------------
//
// THE PROBLEM THIS SHAPE EXISTS FOR. A Gate-1 call is replay work no later run can recover, so
// the job needs a bound on how many it may spend. The naive bound — "look at what is still
// ungated and stop at N" — is not a bound at all across a retry, because the thing that makes a
// candidate look ungated is the very evidence an interrupted attempt failed to persist. Two
// interruption windows make that concrete, and they fail in opposite directions:
//
//   1. The replay finished and the receipt write was refused or never answered. Nothing is
//      standing, so a retry re-selects the same candidate and spends a second call for it.
//   2. The receipt IS durable and the checkpoint recording the result never landed. The standing
//      receipt correctly suppresses that candidate — and its allowance is now invisible, so the
//      retry admits a DIFFERENT candidate and the job exceeds its own cap without ever
//      re-screening anything.
//
// So the charge is durable and it precedes the spend: the selected slots are published as a
// checkpoint BEFORE the first port call, and a resumed job reads that charge back and treats
// every slot in it as consumed. It is an upper bound on calls that may have been attempted, not
// evidence that any of them ran — which is why a resumed attempt reports three separate things
// (acknowledged, recovered, unknown) rather than one count.
//
// 422-06 solved the structurally identical problem for probe authoring one wave earlier and its
// answer is the same one: the interrupted state is DERIVED from a charge with no completion,
// never written by the code that failed to run.

/** The checkpoint the durable per-job Gate-1 charge is published on, before any invocation. */
export const PROPOSE_GATE1_ALLOWANCE_CHECKPOINT = 'gate1-allowance-reserved'

/**
 * How many Gate-1 calls ONE proposal job may spend (422 D-14).
 *
 * Four, beside the phase's other two Gate-1-adjacent recorded defaults, and the unit is the one
 * this layer always knows exactly: a CALL. A per-job bound rather than a per-run one because
 * the job is what carries a durable charge; and a bound at all because a fold that committed
 * forty candidates would otherwise hand the pump forty replays before the next run's tail could
 * get a lease. The number is a STATED budget with a stated rationale — bounded per-job replay
 * work — and not a measured one; nothing in this repo yet measures what a proposal stage should
 * be allowed to spend.
 */
export const PROPOSE_DEFAULT_MAX_GATE1_PER_JOB = 4

/** Where the bound came from, disclosed beside it so an operator can tell a default from a choice. */
export interface ProposeGate1Cap {
  readonly value: number
  readonly source: 'config' | 'default'
}

/**
 * The durable charge, published before the first Gate-1 invocation (422 D-14).
 *
 * Every member is part of the IDENTITY of the charge rather than decoration. `jobId` and `runId`
 * are what let a resumed attempt refuse a reservation that belongs to somebody else instead of
 * silently adopting it. `product` and `corpusDigest` freeze what the selection was made against,
 * so a corpus that moved between the attempts cannot re-open a slot. `cap` travels with it
 * because a config change during a retry must not enlarge a charge already made. And
 * `selectedCandidateIds` is the charge itself: those slots are spent, whatever became of them.
 */
export interface ProposeGate1Allowance {
  readonly jobId: string
  readonly runId: string
  readonly product: string
  readonly corpusDigest: string
  readonly cap: ProposeGate1Cap
  readonly selectedCandidateIds: readonly string[]
}

/**
 * What reading the persisted charge found.
 *
 * Three arms, and `unreadable` is NOT folded into `absent` — that is the whole safety property.
 * An absent charge permits a first selection; a charge this build cannot read means a previous
 * attempt may have spent slots this one cannot account for, and the only honest response is to
 * spend nothing.
 */
export type ProposeGate1AllowanceRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'claimed'; readonly allowance: ProposeGate1Allowance }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** What corpus the selection is made against, and whether it can be known at all. */
export type ProposeCorpusPosture =
  | { readonly kind: 'resolved'; readonly corpusDigest: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'no-root' }

/** One candidate whose Gate-1 receipt exists and is readable, with the verdict it carries. */
export interface ProposeGate1Screened {
  readonly candidateId: string
  readonly verdict: GateVerdict
}

/**
 * What the proposal stage's Gate-1 leg did, as the durable record reports it (422 D-14).
 *
 * The four candidate-state members are deliberately NOT summable into one count:
 *
 *   `screenedGate1`          this attempt called the port and the writer acknowledged a receipt
 *   `recoveredGate1Receipts` a valid receipt was already on disk under the saved identity —
 *                            found, never generated here, and never claimed as this attempt's work
 *   `interruptedGate1`       a charged slot with no acknowledged and no recovered receipt. UNKNOWN,
 *                            which is its own outcome and not a quiet zero
 *   `ungatedRemaining`       eligible work the cap did not admit; it waits for a later run's
 *                            distinct job or the operator's replay-gate verb, and is never a refund
 */
export interface ProposeGate1Report {
  readonly disposition:
    | 'unbound'
    | 'no-candidates'
    | 'posture-unavailable'
    | 'allowance-unavailable'
    | 'claimed'
    | 'resumed'
  readonly reason?: string
  readonly cap?: ProposeGate1Cap
  readonly reservedGate1: readonly string[]
  readonly screenedGate1: readonly ProposeGate1Screened[]
  readonly recoveredGate1Receipts: readonly ProposeGate1Screened[]
  readonly interruptedGate1: readonly string[]
  readonly ungatedRemaining: readonly string[]
  readonly kindExcluded: readonly string[]
  readonly stale: readonly string[]
}

/** What `proposals-authored` carries. `gate1` is ABSENT when no gate capability was bound. */
export interface ProposeImprovementsCheckpoint {
  readonly runId: string
  readonly candidateIds: readonly string[]
  readonly proposed?: number
  readonly skipped?: number
  readonly gate1?: ProposeGate1Report
}

/**
 * The record kinds Gate 1 does not judge (417 D-19's tier abstention, restated as a filter).
 *
 * Selecting one would buy a `tier-not-implemented` abstention for a full replay's price, which
 * is the one way to spend a charged slot and learn nothing at all.
 */
const GATE1_EXCLUDED_RECORD_KINDS: readonly string[] = ['procedure', 'policy']

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Read the durable charge back out of a checkpoint read (422 D-14).
 *
 * STRICT, unlike this module's two payload readers, and the asymmetry is the point. Those read
 * bytes off a durable queue that an older build may have written, where refusing would strand
 * real work. This reads THIS job's own charge ledger, written by this build moments ago — so a
 * shape this build cannot read is not a generation gap, it is a ledger that cannot be trusted to
 * say what was already spent. Degrading it to `absent` would license a second selection against
 * a charge that already exists, which is exactly the over-spend the ledger exists to prevent.
 *
 * Exported so the composition that owns the store can bind a one-line reader: the envelope peel
 * and the shape check live HERE, where the shape is declared, rather than in each host.
 */
export function parseProposeGate1Allowance(
  outcome: JobCheckpointReadOutcome,
): ProposeGate1AllowanceRead {
  if (!outcome.found) return { kind: 'absent' }
  // Exactly one level, unconditionally — the engine's own rule. `publishCheckpoint` is the only
  // writer of these bytes and it always wraps the value in a `JobCheckpointRecord`.
  const value = asRecord((outcome.payload as { readonly value?: unknown } | undefined)?.value)
  const cap = asRecord(value.cap)
  const ids = value.selectedCandidateIds
  const unreadable = (reason: string): ProposeGate1AllowanceRead => ({ kind: 'unreadable', reason })
  if (
    typeof value.jobId !== 'string' || value.jobId === '' ||
    typeof value.runId !== 'string' || value.runId === '' ||
    typeof value.product !== 'string' || value.product === '' ||
    typeof value.corpusDigest !== 'string' || value.corpusDigest === '' ||
    !isPositiveInteger(cap.value) ||
    (cap.source !== 'config' && cap.source !== 'default') ||
    !Array.isArray(ids) ||
    !ids.every((id): id is string => typeof id === 'string' && id !== '')
  ) {
    return unreadable('the persisted Gate-1 allowance is not a readable charge')
  }
  if (ids.length > cap.value) {
    return unreadable('the persisted Gate-1 allowance charges more slots than its own cap')
  }
  return {
    kind: 'claimed',
    allowance: {
      jobId: value.jobId,
      runId: value.runId,
      product: value.product,
      corpusDigest: value.corpusDigest,
      cap: { value: cap.value, source: cap.source },
      selectedCandidateIds: [...(ids as readonly string[])],
    },
  }
}

/** The one standing Gate-1 line, if the record carries one at all. */
function standingGate1(standing: readonly GateReceipt[]): Extract<GateReceipt, { gate: 1 }> | undefined {
  for (const receipt of standing) if (receipt.gate === 1) return receipt
  return undefined
}

/**
 * Payload candidates first, then the same product's older candidates (422 D-14/D-15).
 *
 * The payload's ids come first because they are the ones this run's fold just committed — the
 * work the chain is actually about. The sweep exists so a corpus that accumulated ungated
 * candidates while nobody was screening does not stay that way forever, and it is ordered
 * OLDEST-first with the record id as a stable tie-break so two hosts walking one corpus at the
 * same ordinal agree on what "next" means.
 *
 * The product comes from the payload rather than from configuration: a proposal job is about one
 * run, a run is about one product, and a sweep scoped by anything else would spend this run's
 * charge on a corpus it has no evidence about.
 */
function orderProposalCandidates(
  bundles: readonly KnowledgeBundleSummary[],
  payloadCandidateIds: readonly string[],
): { readonly product: string | undefined; readonly ordered: readonly KnowledgeBundleSummary[] } {
  const byId = new Map<string, KnowledgeBundleSummary>()
  for (const bundle of bundles) if (!byId.has(bundle.bundleId)) byId.set(bundle.bundleId, bundle)
  const named: KnowledgeBundleSummary[] = []
  const seen = new Set<string>()
  for (const id of payloadCandidateIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = byId.get(id)
    if (row !== undefined) named.push(row)
  }
  const product = named[0]?.product
  if (product === undefined) return { product: undefined, ordered: [] }
  const sweep = bundles
    .filter(
      (bundle) =>
        bundle.product === product && !seen.has(bundle.bundleId) && bundle.status === 'candidate',
    )
    .sort(
      (left, right) =>
        left.openedAtOrdinal - right.openedAtOrdinal ||
        (left.bundleId < right.bundleId ? -1 : left.bundleId > right.bundleId ? 1 : 0),
    )
  return { product, ordered: [...named, ...sweep] }
}

const NO_GATE1_WORK = {
  reservedGate1: [] as readonly string[],
  screenedGate1: [] as readonly ProposeGate1Screened[],
  recoveredGate1Receipts: [] as readonly ProposeGate1Screened[],
  interruptedGate1: [] as readonly string[],
  ungatedRemaining: [] as readonly string[],
  kindExcluded: [] as readonly string[],
  stale: [] as readonly string[],
} as const

/**
 * Reconcile a charge a previous attempt already made — WITHOUT spending anything (422 D-14).
 *
 * Zero port calls on this path, by construction rather than by a counter: `runReplayGate` is not
 * reachable from here. The charge's own identity is what the standing receipts are checked
 * against, so a corpus that moved between the attempts leaves a slot UNKNOWN rather than
 * silently recovering a receipt about a different corpus.
 */
async function reconcileGate1Allowance(
  allowance: ProposeGate1Allowance,
  gateReceiptsFor: NonNullable<PostRunJobCapabilities['gateReceiptsFor']>,
): Promise<ProposeGate1Report> {
  const recovered: ProposeGate1Screened[] = []
  const interrupted: string[] = []
  for (const candidateId of allowance.selectedCandidateIds) {
    let standing: Extract<GateReceipt, { gate: 1 }> | undefined
    try {
      const gates = await gateReceiptsFor({ candidateId })
      standing = gates.kind === 'found' ? standingGate1(gates.standing) : undefined
    } catch {
      // An unreadable store makes the slot's outcome UNKNOWN, which is what `interrupted` says.
      standing = undefined
    }
    if (standing !== undefined && standing.corpusVersion.corpusDigest === allowance.corpusDigest) {
      recovered.push({ candidateId, verdict: standing.verdict })
    } else {
      interrupted.push(candidateId)
    }
  }
  return {
    ...NO_GATE1_WORK,
    disposition: 'resumed',
    cap: allowance.cap,
    reservedGate1: [...allowance.selectedCandidateIds],
    recoveredGate1Receipts: recovered,
    interruptedGate1: interrupted,
  }
}

/**
 * Select, charge, then spend — in that order, and never the other way round (422 D-14/D-15).
 */
async function screenGate1(
  capabilities: PostRunJobCapabilities,
  context: JobHandlerContext,
  payload: ProposeImprovementsPayload,
): Promise<ProposeGate1Report> {
  const runReplayGate = capabilities.runReplayGate
  const readAllowance = capabilities.readProposeGate1Allowance
  const listBundles = capabilities.listBundles
  const gateReceiptsFor = capabilities.gateReceiptsFor
  const readCorpusPosture = capabilities.readProposeCorpusPosture
  // A host that bound no replay gate, no allowance reader, no corpus reader — a typed no-op,
  // not a failure. It is the posture 417 shipped and 422-07 shipped after it, and a stage that
  // refused to complete over it would strand the chain terminal for every such host.
  if (
    runReplayGate === undefined || readAllowance === undefined || listBundles === undefined ||
    gateReceiptsFor === undefined || readCorpusPosture === undefined
  ) {
    return { ...NO_GATE1_WORK, disposition: 'unbound' }
  }

  const jobId = String(context.job.id)
  // THE LEDGER IS READ FIRST, before anything is selected. A charge that already exists decides
  // this attempt entirely; nothing below it may enlarge, refill or replace one.
  let read: ProposeGate1AllowanceRead
  try {
    read = await readAllowance(jobId)
  } catch (error) {
    return {
      ...NO_GATE1_WORK,
      disposition: 'allowance-unavailable',
      reason: `the persisted Gate-1 allowance could not be read: ${errorTextOfUnknown(error)}`,
    }
  }
  if (read.kind === 'unreadable') {
    return { ...NO_GATE1_WORK, disposition: 'allowance-unavailable', reason: read.reason }
  }
  if (read.kind === 'claimed') {
    const allowance = read.allowance
    if (allowance.jobId !== jobId || allowance.runId !== payload.runId) {
      return {
        ...NO_GATE1_WORK,
        disposition: 'allowance-unavailable',
        reason: 'the persisted Gate-1 allowance was charged for another job or run',
      }
    }
    return await reconcileGate1Allowance(allowance, gateReceiptsFor)
  }

  const cap: ProposeGate1Cap = isPositiveInteger(capabilities.proposeGate1MaxPerJob)
    ? { value: capabilities.proposeGate1MaxPerJob, source: 'config' }
    : { value: PROPOSE_DEFAULT_MAX_GATE1_PER_JOB, source: 'default' }

  const { product, ordered } = orderProposalCandidates(await listBundles(), payload.candidateIds)
  if (product === undefined) {
    return { ...NO_GATE1_WORK, disposition: 'no-candidates' }
  }
  const posture = await readCorpusPosture({ product })
  if (posture.kind !== 'resolved') {
    return {
      ...NO_GATE1_WORK,
      disposition: 'posture-unavailable',
      cap,
      reason: posture.kind === 'no-root'
        ? 'no committed corpus root, so nothing can be screened against one'
        : posture.reason,
    }
  }

  const kindExcluded: string[] = []
  const stale: string[] = []
  const ungated: string[] = []
  for (const row of ordered) {
    if (GATE1_EXCLUDED_RECORD_KINDS.includes(row.kind)) {
      kindExcluded.push(row.bundleId)
      continue
    }
    if (row.status !== 'candidate') continue
    const gates = await gateReceiptsFor({ candidateId: row.bundleId })
    if (gates.kind !== 'found') continue
    if (GATE1_EXCLUDED_RECORD_KINDS.includes(gates.recordKind)) {
      kindExcluded.push(row.bundleId)
      continue
    }
    const standing = standingGate1(gates.standing)
    // A standing Gate-1 line under the CURRENT corpus digest is a decision, whatever it decided:
    // a fail and an abstain are screening results, and re-buying them would spend the charge on
    // a question this corpus has already answered.
    if (standing !== undefined && standing.corpusVersion.corpusDigest === posture.corpusDigest) {
      continue
    }
    if (standing !== undefined) stale.push(row.bundleId)
    ungated.push(row.bundleId)
  }

  const selected = ungated.slice(0, cap.value)
  const remaining = ungated.slice(cap.value)
  if (selected.length === 0) {
    return {
      ...NO_GATE1_WORK,
      disposition: 'claimed',
      cap,
      ungatedRemaining: remaining,
      kindExcluded,
      stale,
    }
  }

  // THE CHARGE, durable, BEFORE the first call. `publishCheckpoint` resolves only once the store
  // has it; if it throws, no call is made at all, and if the process dies between the write and
  // the acknowledgement the next attempt reads the charge back and spends nothing.
  const allowance: ProposeGate1Allowance = {
    jobId,
    runId: payload.runId,
    product,
    corpusDigest: posture.corpusDigest,
    cap,
    selectedCandidateIds: selected,
  }
  await context.publishCheckpoint(PROPOSE_GATE1_ALLOWANCE_CHECKPOINT, allowance)

  const screened: ProposeGate1Screened[] = []
  const interrupted: string[] = []
  // SEQUENTIALLY, and once each. Concurrency here would put several replays under one writer
  // lease at once for no gain the cap can express.
  for (const candidateId of selected) {
    try {
      const receipt = await runReplayGate(asRecordId(candidateId))
      // The port resolves only on an ACKNOWLEDGED receipt (422 D-14, the T1 contract), so this
      // is a screening result the store agrees with rather than one this process remembers.
      screened.push({ candidateId, verdict: receipt.verdict })
    } catch {
      // Refused, unknown, or lost. The slot stays charged and reports no screened success — the
      // one thing that must never happen here is a refusal reading as a quiet nothing.
      interrupted.push(candidateId)
    }
  }

  return {
    disposition: 'claimed',
    cap,
    reservedGate1: [...selected],
    screenedGate1: screened,
    recoveredGate1Receipts: [],
    interruptedGate1: interrupted,
    ungatedRemaining: remaining,
    kindExcluded,
    stale,
  }
}

function errorTextOfUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The real propose-improvements body (422 D-13).
 *
 * The third and last stage of the post-run chain. It runs on candidates the fold's receipt named
 * and on the upstream truth the fold forwarded, and it stages its proposals through an OPTIONAL
 * neutral port — so a host that binds nothing still lands the stage, publishes its checkpoint and
 * terminates the chain honestly rather than leaving the run's record unwritten.
 *
 * It cannot undo the curation behind it, and nothing here tries. A permanent failure halts the
 * chain (the declaration below), the committed bundle stays committed, and the terminal record
 * reports a `done` curation beside a `failed` proposal stage — which is what actually happened.
 *
 * A port that throws is reported as nothing at all, exactly as the fold's is: the engine catches
 * it, spends an attempt and decides between a retry and a permanent failure from the declared
 * bound, because this handler cannot know whether a staging failure is transient.
 */
function realProposeImprovementsHandler(capabilities: PostRunJobCapabilities): JobHandler {
  return async (context) => {
    const payload = readProposeImprovementsPayload(context.payload)
    if (payload === undefined) {
      return permanently(
        'the propose-improvements payload names no run, so there is no curated run to propose ' +
          'improvements about',
      )
    }

    // 422 D-14: the Gate-1 leg runs FIRST and charges its own allowance before it spends one.
    // It is deliberately ahead of the staging: a screening refusal must not be erasable by a
    // staging success published over the top of it, and both land on one checkpoint below.
    const gate1 = await screenGate1(capabilities, context, payload)

    const staged = capabilities.stageAdversarialProposal === undefined
      ? undefined
      : await capabilities.stageAdversarialProposal({
          runId: payload.runId,
          executionContext: payload.executionContext,
          candidateIds: payload.candidateIds,
          upstream: payload.upstream,
        })

    // Published AFTER the staging, on the fold's `bundle-committed` discipline: the checkpoint is
    // named for an event, and counts recorded before the port answered would name an event that
    // had not happened yet. The counts are omitted entirely when no port was bound, so the
    // terminal record can tell "staged nothing" from "staged zero".
    //
    // `gate1` is omitted on exactly the same terms: a host that bound no gate capability did not
    // screen zero candidates, it did not screen. Absence is what says so, and it is what keeps
    // every record written before this widening describing the same thing it always did.
    const checkpoint: ProposeImprovementsCheckpoint = {
      runId: payload.runId,
      candidateIds: [...payload.candidateIds],
      ...(staged === undefined ? {} : { proposed: staged.proposed, skipped: staged.skipped }),
      ...(gate1.disposition === 'unbound' ? {} : { gate1 }),
    }
    await context.publishCheckpoint('proposals-authored', checkpoint)
    return { status: 'complete', next: [] }
  }
}

/**
 * Every kind, keyed by itself.
 *
 * `satisfies Record<JobKind, JobKindDeclaration>` is the compile-time half of D-09's
 * completeness: a sixth kind added to the shipped vocabulary fails to typecheck here until
 * it is declared. The registry-driven conformance test is the runtime half, and the two catch
 * different drifts — a missing entry versus an entry whose own `kind` field disagrees with
 * the slot it sits in.
 */
function declarationsFor(capabilities?: PostRunJobCapabilities) {
  return {
  // JOBQ-04 / C9. Chat is NOT a checkpointed job and never becomes one: its state of record
  // is the append-only session log, and the queue's checkpoint discipline covers background
  // work only. One attempt, because there is no durable progress for a second one to resume.
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

  // Two checkpoints, mirroring the v51 curation lifecycle: candidates are authored, then the
  // bundle is committed. The second is the one whose recovery actually matters.
  //
  // 422 D-13: it now chains onward to the proposal stage, and `halt-chain` survives that
  // unchanged — deliberately. A fold that gave up permanently committed no bundle, so there is
  // nothing for a proposal stage to propose about; handing it a successor would mint a job whose
  // whole premise is a fold that did not happen.
  'curate-memory': {
    kind: 'curate-memory',
    checkpointed: true,
    checkpointSchedule: ['candidates-authored', 'bundle-committed'],
    allowedSuccessors: CURATE_MEMORY_SUCCESSORS,
    maxAttempts: 3,
    backoff: { kind: 'exponential', initialDelayMs: 1_000, factor: 2, maxDelayMs: 30_000 },
    onPermanentFailure: 'halt-chain',
    handler: capabilities === undefined
      ? standInHandler(
          'curate-memory',
          ['candidates-authored', 'bundle-committed'],
          CURATE_MEMORY_SUCCESSORS,
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

  // The chain's tail since 422 D-13. It declares NO successor — a fourth stage would be one
  // nothing derives an id for — and halts its chain on permanent failure, which here means only
  // that nothing further is enqueued: the curation behind it is committed and stays committed.
  //
  // 422 D-14 adds `gate1-allowance-reserved` AHEAD of `proposals-authored`, and the order is the
  // contract rather than a listing convention: the charge is what a resumed attempt reads to
  // learn what a previous one may already have spent, so it has to be durable before any call
  // is made and therefore before the checkpoint that reports the result.
  'propose-improvements': {
    kind: 'propose-improvements',
    checkpointed: true,
    checkpointSchedule: [PROPOSE_GATE1_ALLOWANCE_CHECKPOINT, 'proposals-authored'],
    allowedSuccessors: [],
    maxAttempts: 2,
    backoff: { kind: 'fixed', delayMs: 5_000 },
    onPermanentFailure: 'halt-chain',
    handler: capabilities === undefined
      ? standInHandler(
          'propose-improvements',
          [PROPOSE_GATE1_ALLOWANCE_CHECKPOINT, 'proposals-authored'],
          [],
        )
      : realProposeImprovementsHandler(capabilities),
  },
  } satisfies Record<JobKind, JobKindDeclaration>
}

/**
 * The five declarations as a list, in the order the kind vocabulary declares them.
 *
 * The NO-CAPABILITY set: analyze-run and curate-memory carry their scripted stand-ins here,
 * byte-identically to what 385 shipped. Everything registry-driven that does not compose a
 * host — the conformance suite, the crash matrix, the kill matrix's adversarial legs — reads
 * this list, and every one of them scripts those two kinds by payload.
 */
export const REAL_JOB_KIND_DECLARATIONS: readonly JobKindDeclaration[] = Object.freeze(
  Object.values(declarationsFor()) as readonly JobKindDeclaration[],
)

/**
 * A registry over exactly the five real kinds.
 *
 * A fresh registry per call rather than a module-level singleton: a registry is a small,
 * cheap value, and one shared instance is how a test that registers something extra ends up
 * changing what every other test in the process sees.
 *
 * With `capabilities`, analyze-run and curate-memory dispatch their REAL bodies (388 D-01 /
 * D-02); without, they keep the scripted stand-ins. The stand-ins are the HARNESS affordance,
 * not a shipped posture: both production compositions bind capabilities — `composeLocalAgent`
 * when the run tail supplies its curation drain (plan 02), and the daemon's own composition
 * through the same input. A caller that gets a stand-in is a caller that asked for one.
 *
 * The DECLARATIONS are identical in both cases. Only the two handler slots move, so a matrix
 * that derives its crash points from the declared schedule covers the real bodies with no
 * harness change at all — which is the design intent 385 D-09 stated and this is the phase
 * that spends it.
 */
export function createRealJobKindRegistry(
  capabilities?: PostRunJobCapabilities,
): JobKindRegistry {
  return createJobKindRegistry(
    capabilities === undefined
      ? REAL_JOB_KIND_DECLARATIONS
      : (Object.values(declarationsFor(capabilities)) as readonly JobKindDeclaration[]),
  )
}
