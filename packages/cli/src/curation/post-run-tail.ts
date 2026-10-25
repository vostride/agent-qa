import type { CurationSnapshot } from '@vostride/agent-qa-schema'
// The one post-run tail (Phase 388 plan 02, D-01 / D-03 / D-05 / D-07).
//
// Every door's tail ends here. What the run process owes the post-run chain is two separable
// things, and separating them is the whole design:
//
//   1. ENQUEUE — a durable record that this run has analysis waiting. Idempotent by `runId`,
//      fence-free (385 D-02), and performed even under `--detach`, because detaching asks this
//      process not to SPEND itself on the work, never to forget the work exists (Pitfall 3).
//   2. DRAIN OR HAND OFF — spending this process on the chain when nothing else can. If the
//      writer lease is free, pump the chain here under the ONE budget; if a daemon holds it,
//      nudge and return immediately. The run process never waits on the daemon (D-03).
//
// ═══ 2026-08-26 — Phase 404 D-05: LEG 1 NO LONGER LIVES IN THIS FILE ═══
//
// The enqueue moved into `curation/post-verdict-step.ts`, which the runner SHELL awaits between
// the verdict and `runFinished`. The reason is not tidiness: this tail was reachable only from
// `commands/run.ts`, so a run started through the dashboard, MCP, chat or the daemon reached its
// verdict and queued nothing at all — LIFE-03's posture clause was vacuous for every non-CLI run,
// and a dashboard-only user read `pending` forever. The step is composed by the one invocation
// core, so no door can forget it. `PostRunTailHandle` therefore has no `enqueue()` member, and
// `drain()` resolves the knowledge root and composes its host for ITSELF rather than inheriting
// them from a leg that ran first.
//
// The paragraph above still describes what the RUN owes; it is simply owed from two files now,
// and the split is exactly the "verdict ≠ done" line this phase draws. What stays here is leg 2
// and the user-facing close-out: the pump, its budget, its chip emitter, the exit-summary line
// and the digest block.
//
// Everything below is warn-only. The exit code was frozen by `mapVerdictToExitCode` before this
// file is reached, and `runVerdictFirstCurationTail` returns it whatever happens here (JOBQ-06).
// A failure to enqueue costs this run its analysis and nothing else — no retry file, no second
// durable medium for a fact the queue owns (D-07).

// Import discipline (FUNC-02): this file is CLI surface code written after the firewall was
// armed, so it may name only `agent`, `agent-local` and `schema` across package boundaries —
// never `core`, `knowledge-local`, `runner-local` or `safety`. Everything it needs from those
// arrives through the one composition edge (`LOCAL_DAEMON_CAPABILITIES`, `DRAIN_BUDGET_MS`) or
// through `curation-tail.ts`, which is ledgered for exactly those specifiers. That is not
// ceremony: it is what keeps the run tail's reach identical to the reach the tail already had.

import {
  chainJobIdsForRun,
  invokeFunction,
  renderAnalysisClusterBlock,
  RUNS_DIGEST_FUNCTION_ID,
  RUNS_POST_PROCESSING_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type {
  JobModelCapability,
  ProposeGate1Report,
  ProposeImprovementsCheckpoint,
} from '@vostride/agent-qa-agent'
import { DRAIN_BUDGET_MS, LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { recoverPendingPostVerdictContinuations } from './post-verdict-continuation.js'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import type {
  ExecutionContext,
  PostProcessingChips,
  PostProcessingStatus,
  RunDigest,
  RunEventEnvelope,
  RunNotificationView,
} from '@vostride/agent-qa-schema'

// 391-06: the clustered block layout moved to the ONE package that has two callers for it — the
// tail's print and `runs.digest`'s first section. Re-exported from where it used to live so the
// CLI's own suite still names it here, and so nothing in this package composes a second layout.
export { renderAnalysisClusterBlock }

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../composition/local-agent-host.js'
import { nudgeDaemon } from '../daemon/client.js'
import { resolveCliJobModel } from '../llm-utils.js'
import {
  completedRunDir,
  completedRunHandoffPath,
  curateCompletedRun,
  defaultCurationTailOperations,
  readCurationTailReceipt,
  runCurationTail,
  type CurationTailOperations,
  type CurationWriterAuthority,
  type RunCurationTailOptions,
} from './curation-tail.js'
import type { CanaryCreditCounters } from './canary-credit.js'
import { NON_SIGNAL_CLASSES } from './emit-canary-outcomes.js'
import {
  MISDIRECTION_POSTURE_BOUND_AT_HOST,
  readMisdirectionRunPosture,
  type MisdirectionRunPostureRecord,
} from './misdirection-run-state.js'
import { createPostRunChipEmitter } from './post-run-chip-emitter.js'
import { buildPromotionPostureResolver, promotionPostureResolverForHost } from './promotion-posture.js'
import { resolveRunCurationContext } from './run-curation-context.js'
import { ciResumeClause, isCiContext, resumeLimitClause } from './resume-limit.js'
import { LOCAL_CURATION_CAPABILITIES, latestBuildOrdinal } from '@vostride/agent-qa-agent-local'
import { createReplayGatePortForHost, type ReplayGateClaimAuthority } from '../gates/replay-gate-host.js'
import {
  CURATION_BREAKDOWN_BUCKETS,
  POST_PROCESSING_SKIP_REASON_WORDS,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import {
  buildTrustPriorsResolver,
  TrustPriorsRefusedError,
  type trustPriorsForHost,
  formatTrustPriorDisclosure,
  type TrustPriorDisclosure,
} from './trust-priors.js'

/**
 * What became of the durable hand-off.
 *
 * `deduped` is a SUCCESS, not a lesser one: the second tail run for a run id is exactly what
 * the `(kind, idempotency_key)` unique index exists to absorb, and reporting it as a failure
 * would make the store's guarantee look like an error to every reader of this report.
 */
export type PostRunEnqueueOutcome = 'enqueued' | 'deduped' | 'failed' | 'skipped'

/** What became of the in-process chain pump. */
export type PostRunDrainOutcome =
  | 'not-attempted'
  | 'detached'
  | 'handed-off'
  | 'drained'
  | 'budget-exhausted'
  /**
   * The pump spent its bound or its budget entirely on OTHER runs' work and never claimed any
   * member of this run's chain.
   *
   * Distinct from `budget-exhausted`, which says this run's own chain was mid-flight when the
   * clock ran out. The queue is a global FIFO, so a backlog of detached runs can consume the
   * whole budget before this run's `analyze-run` is reachable — and a report that called that
   * `drained` would tell a user their analysis is `pending` with no indication that anything
   * will ever pick it up (WR-01).
   */
  | 'backlog-exhausted'
  | 'retry-scheduled'
  | 'refused'
  /**
   * The drain raised and was caught by the tail's own catch (WR-10).
   *
   * A member rather than leaving the optimistic `'drained'` in place: the pre-loop assignment
   * is what a throw escapes past, so the report used to say `{drain: 'drained', jobsRun: 0}` —
   * byte-identical to the honest emptied-queue case, and there is no way for a reader to tell
   * a queue that had nothing to do from one that blew up on its first job.
   *
   * NOT a `ChainPumpExit`: that type enumerates how the loop ENDS, and a throw does not end
   * the loop, it leaves it. The two are deliberately separate domains.
   */
  | 'threw'

/**
 * Control flow only.
 *
 * Deliberately NOT the user-facing vocabulary: the D-08 summary line is rendered by plan 04
 * from DURABLE job state, because a report built in this process cannot know what the daemon
 * did after this process returned, and a line built from it would be a confident lie the
 * moment the two disagreed.
 */
export interface PostRunTailReport {
  readonly enqueue?: PostRunEnqueueOutcome
  readonly preparationPending?: true
  readonly drain: PostRunDrainOutcome
  /** Chain jobs this process actually ran to a disposition. */
  readonly jobsRun: number
}

/**
 * Every side effect this tail performs, in one table (the `CurationTailOperations` idiom).
 *
 * It is also the JOBQ-06 induced-failure seam plan 05 uses, and the answer to Pitfall 12: the
 * dynamic `mapVerdictToExitCode` imports stay at the call sites and nothing here closes over
 * one site's module graph.
 */
export interface PostRunTailOperations {
  recoverPendingPostVerdictContinuations: typeof recoverPendingPostVerdictContinuations
  loadCompletedRunHandoff: CurationTailOperations['loadCompletedRunHandoff']
  resolveKnowledgeRoot: CurationTailOperations['resolveKnowledgeRoot']
  composeHost(input: PostRunTailHostInput): LocalAgentHost
  acquireWriterLease: typeof LOCAL_DAEMON_CAPABILITIES.acquireWriterLease
  releaseLease: typeof LOCAL_DAEMON_CAPABILITIES.releaseLease
  nudgeDaemon: typeof nudgeDaemon
  curateCompletedRun: typeof curateCompletedRun
  runCurationTail: typeof runCurationTail
  resolveRunCurationContext: typeof resolveRunCurationContext
  createChipEmitter: typeof createPostRunChipEmitter
  /**
   * Durable chip truth, through the ONE read op (D-14).
   *
   * Named on the table so a test can answer it without a store, and shaped as "ask this host's
   * registry" so production has no second way to answer it. The CLI never opens the queue
   * database for status: three surfaces render these five words and a second producer is how
   * the dashboard and the CLI end up saying different true-looking things about one row.
   */
  readPostProcessingStatus(host: LocalAgentHost, runId: string): Promise<PostProcessingStatus>
  /**
   * One run's DIGEST, through the ONE producer (`runs.digest`, 391 D-16/D-17).
   *
   * Same discipline as the status read above, and it replaced the 389 analysis read for a
   * reason that is D-17 rather than taste: the digest's first section IS the clustered verdict
   * block this tail used to print, and its other sections are the chain, the decisions waiting
   * on a human and the counts. Printing both would have been the same run's story told twice.
   *
   * Shaped as "ask this host's registry" so the tail can never compose a line of its own — the
   * bytes it prints are the op result's bytes, which are the barrel renderer's bytes, which are
   * what the `agent-qa digest` verb, M5's run page and 392's chat all serve.
   */
  readRunDigest(host: LocalAgentHost, runId: string): Promise<RunDigest>
  /**
   * This run's OWN `proposals-authored` Gate-1 leg, read back off the durable checkpoint
   * (422 D-14; closes WINDOWS #424 without widening a persisted DTO).
   *
   * OPTIONAL, unlike every member above it, and the asymmetry is deliberate on two counts. It is
   * a DISCLOSURE read: a tail that cannot perform it loses one clause of one line and must never
   * lose the line, so an absent binding answers `not-recorded` exactly as an absent checkpoint
   * does. And every existing harness that hands this table a partial override keeps compiling,
   * which is what stops a disclosure from becoming a reason to touch twelve fixtures.
   *
   * The read goes through the host's OWN job store and the ONE shared `chainJobIdsForRun`
   * derivation — the same store the pump drained and the same ids its chip trail addressed — so
   * the record disclosed here is this run's third stage and not a neighbour's. It is read-only and
   * it never opens a queue the tail did not already open.
   */
  readProposalGate1Report?(host: LocalAgentHost, runId: string): Promise<ProposalGate1Disclosure>
  /** The one wall clock, read only at tail boundaries. */
  now(): number
}

export interface PostRunTailHostInput {
  readonly trustPriors?: ReturnType<typeof trustPriorsForHost>
  readonly resolvePromotionPosture?: () => Promise<RunCurationTailOptions['resolvePromotionPosture']>
  readonly agentQaRoot: string
  readonly configPath: string
  /**
   * The declared mask this tail was handed, if any — carried so `composeHost` can DERIVE the
   * posture from what the tail HAS rather than assert one it intends (388-10, UF-388-01).
   */
  readonly mask?: RunCurationTailOptions['mask']
  /**
   * The writer lease the PUMP holds, resolved at the Gate-1 claim (422 D-14).
   *
   * Threaded through the host input rather than rebuilt inside `composeHost` for the same reason
   * `curateRun` is: the lease belongs to the drain leg below, which takes it AFTER this host has
   * been composed. A closure is what lets the composition happen first and the lease be read
   * later; a value would be `undefined` forever.
   */
  readonly resolveClaimAuthority?: () => ReplayGateClaimAuthority | undefined
  readonly curateRun: (input: {
    readonly runId: string
    readonly executionContext: unknown
    readonly deadlineMs?: number
  }) => Promise<{
    readonly curated: number
    readonly deprecated: number
    /** The fold's own completeness, carried rather than dropped (WR-03). */
    readonly complete: boolean
    readonly snapshot?: CurationSnapshot
    readonly reason?: string
  }>
}

/**
 * The queue's model, resolved for real since 389-06 — the author swap (389-04) made
 * `analyze-run` author its unknown-verdict members through the QUEUE's model, so the 388-era
 * "never authors" stub would abort the very chain this tail drains.
 *
 * What survives from 388 is the DEGRADATION, moved from resolution time to generate time: a
 * project with no usable provider credentials must still get its chain (enqueue, the
 * deterministic floor, curation through the run's own author), so a failed model resolution
 * composes a capability that reports the failure only if the author actually reaches it —
 * "no LLM configured" still never means "no post-run chain", it means the honest
 * transport-throw path for the one job that genuinely needed a model.
 */
export function resolvePostRunJobModel(configPath: string): Promise<JobModelCapability> {
  return resolveCliJobModel(configPath).catch((error: unknown) => ({
    modelId: 'unavailable:post-run-tail',
    generate: (): Promise<never> => {
      throw new Error(
        'The post-run tail could not resolve the configured job model: '
        + (error instanceof Error ? error.message : String(error)),
      )
    },
  }))
}

export function defaultPostRunTailOperations(): PostRunTailOperations {
  const curationDefaults = defaultCurationTailOperations()
  return {
    loadCompletedRunHandoff: curationDefaults.loadCompletedRunHandoff,
    resolveKnowledgeRoot: curationDefaults.resolveKnowledgeRoot,
    composeHost: (input) => composeCliLocalAgent({
      ...(input.trustPriors === undefined ? {} : { trustPriors: input.trustPriors }),
      ...(input.resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture: input.resolvePromotionPosture }),
      agentQaRoot: input.agentQaRoot,
      configPath: input.configPath,
      model: () => resolvePostRunJobModel(input.configPath),
      postRun: {
        // 422-09 (D-14): the lease this tail's drain holds, handed to the composition as a
        // CLOSURE so the Gate-1 bridge resolves it at the claim. The host is composed before the
        // take (385 D-02 — the enqueue must not wait on a lease it does not need), so a value
        // read at this line is `undefined` for the whole life of the process.
        ...(input.resolveClaimAuthority === undefined
          ? {}
          : { resolveClaimAuthority: input.resolveClaimAuthority }),
        curateRun: input.curateRun,
        // Derived from presence, never hard-coded (388-10): the tail declares what it HAS. Both
        // production sites in `run.ts` pass a mask, and a harness that composes the tail
        // without one gets the claim deferral rather than an unmasked emission.
        candidateProse: input.mask === undefined ? 'no-masker' : 'masker-active',
      },
    }),
    acquireWriterLease: LOCAL_DAEMON_CAPABILITIES.acquireWriterLease,
    recoverPendingPostVerdictContinuations,
    releaseLease: LOCAL_DAEMON_CAPABILITIES.releaseLease,
    nudgeDaemon,
    curateCompletedRun,
    runCurationTail,
    resolveRunCurationContext,
    createChipEmitter: createPostRunChipEmitter,
    readPostProcessingStatus: async (host, runId) => await invokeFunction(
      host.registry,
      RUNS_POST_PROCESSING_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as PostProcessingStatus,
    readRunDigest: async (host, runId) => await invokeFunction(
      host.registry,
      RUNS_DIGEST_FUNCTION_ID,
      { runId },
      CLI_FUNCTION_CALLER,
    ) as RunDigest,
    readProposalGate1Report: async (host, runId) => {
      const jobs = await host.jobs()
      // The SAME derivation the enqueue minted with and the chip trail addressed — never a
      // run-keyed guess. The third id is built from the second, which is built from the first.
      const chainIds = chainJobIdsForRun(runId, jobs.idSource)
      const outcome = await jobs.store.readCheckpoint(
        chainIds.proposeImprovements,
        PROPOSALS_AUTHORED_CHECKPOINT,
      )
      return projectProposalGate1(outcome.found ? outcome.payload : undefined)
    },
    now: Date.now,
  }
}

/** The checkpoint `realProposeImprovementsHandler` publishes at the chain terminal (422 D-13). */
const PROPOSALS_AUTHORED_CHECKPOINT = 'proposals-authored'

/**
 * Peel the checkpoint envelope and shape-check the Gate-1 block (422 D-14; WINDOWS #424).
 *
 * `publishCheckpoint` wraps its value in a `JobCheckpointRecord` exactly once, so the record sits
 * at `payload.value` — the envelope 422-09 recorded as costing it a debugging cycle.
 *
 * The check is NARROW AND STRICT for the three members this line renders, and the strictness is
 * what keeps `unreadable` a real arm: a block this build cannot read must not degrade into
 * `unbound`, because `unbound` is a positive claim that the host bound no gate capability. It is
 * not the handler's own `parseProposeGate1Allowance` — that reads the ALLOWANCE ledger, a
 * different checkpoint with a different shape and a much heavier safety obligation.
 */
function projectProposalGate1(payload: unknown): ProposalGate1Disclosure {
  if (payload === undefined) return { kind: 'not-recorded' }
  const record = payload as { readonly value?: unknown } | null
  const value = (record === null || typeof record !== 'object' ? undefined : record.value) as
    | Partial<ProposeImprovementsCheckpoint>
    | undefined
  if (value === null || typeof value !== 'object') return { kind: 'unreadable' }
  const gate1 = value.gate1
  if (gate1 === undefined) return { kind: 'unbound' }
  if (
    gate1 === null || typeof gate1 !== 'object' ||
    typeof (gate1 as ProposeGate1Report).disposition !== 'string' ||
    !Array.isArray((gate1 as ProposeGate1Report).ungatedRemaining) ||
    !Array.isArray((gate1 as ProposeGate1Report).screenedGate1) ||
    !Array.isArray((gate1 as ProposeGate1Report).recoveredGate1Receipts) ||
    !Array.isArray((gate1 as ProposeGate1Report).interruptedGate1)
  ) {
    return { kind: 'unreadable' }
  }
  return { kind: 'recorded', report: gate1 }
}

/**
 * The tail's inputs, taken FROM the v51 tail's own option type.
 *
 * `Pick` rather than a restatement: every one of these fields is handed straight through to
 * the per-run fold, and a second declaration of them would be a second place for `mask` to
 * drift from what the fold actually consumes.
 */
export interface RunPostRunTailOptions extends Pick<
  RunCurationTailOptions,
  | 'runId'
  | 'maxAblations'
  | 'agentQaRoot'
  | 'knowledgeConfig'
  | 'configDir'
  | 'mask'
  | 'modelDeps'
  | 'signal'
  | 'log'
> {
  /** The resolved project config file; the composition resolves everything else from it. */
  configPath: string
  trustPriors?: ReturnType<typeof trustPriorsForHost>
  canaryAblation?: import('./canary-credit.js').CanaryAblation
  /**
   * What the post-verdict step's enqueue answered (404 D-05).
   *
   * Threaded rather than performed, because this tail no longer enqueues: `report().enqueue` is
   * read by cells and by the daemon fixtures, and a report that always said `skipped` would be a
   * quieter second answer to a question the step already answered. Absent ⇒ `skipped`, which is
   * the honest reading for a harness that drove the tail with no step in front of it.
   *
   * `failed` is also the one value that CHANGES this file's behaviour: `finish()` returns early,
   * because nothing is queued and the step's own warning has already said everything true about
   * this run.
   */
  enqueueOutcome?: PostRunEnqueueOutcome
  /** Live ownership survives the runner's bounded wait; undefined state means still preparing. */
  postVerdict?: import('./post-verdict-step.js').PostVerdictHandoff
  /** The host wait and this drain spend one deadline. */
  deadlineMs?: number
  /**
   * The dashboard's second chip sink (404 D-16), accepted here and threaded to the emitter.
   *
   * A PASS-THROUGH, threaded to `createChipEmitter` at the ONE construction site below. It was
   * declared ahead of its consumer in 404-04 — the composition seam (`composeCliPostRunTail`) and
   * the emitter side landed in different plans, and a field added on the emitter alone would have
   * left the composition unable to name it; 404-05 filled the emitter side, so the value now
   * reaches a sink rather than stopping here.
   */
  relay?: (envelope: RunEventEnvelope) => void
  /** Focused test seam. Production callers omit it. */
  operations?: Partial<PostRunTailOperations>
  /** 2026-10-18 (444-14, D-22): in `ci` and `cloud` a pending line states the resume limit. */
  executionContext?: ExecutionContext
}

/**
 * The two legs of the tail, handed to the verdict-first wrapper separately.
 *
 * 2026-08-26 (404 D-05): THERE IS NO `enqueue()` MEMBER. There were three legs, and the first one
 * — the durable hand-off — is now `enqueueAnalyzeRun` inside `post-verdict-step.ts`, called by the
 * shell before `runFinished` on every door rather than by this file on one. The wrapper's
 * `--detach` gate therefore no longer straddles the enqueue at all: detach skips the DRAIN, and the
 * enqueue happened in the shell whatever the flag said (RESEARCH Pitfall 8).
 */
export interface PostRunTailHandle {
  readonly trustPriorDisclosure?: TrustPriorDisclosure
  /**
   * Pump this run's chain.
   *
   * `input.takeLease` is how the 404 D-10 post-verdict step's authority arrives: a THUNK, called
   * by this method rather than evaluated by the caller. ONE LEASE PER RUN: acquire → pump →
   * release. A process that holds the writer lease and calls `acquireWriterLease` again is
   * answered `held` — by itself — and this pump would then "hand off" to nobody, leaving the chain
   * unclaimed and the chips frozen (RESEARCH Pitfall 3, the 387-08 D-18 shape
   * `CurationWriterAuthority` was minted for).
   *
   * WHY A THUNK RATHER THAN THE AUTHORITY ITSELF (2026-08-27, CR-01). Taking the lease is what
   * ACQUIRES it, so a caller that evaluated `takeAcquiredLease()` as the ARGUMENT had already
   * minted the lease before this method was entered — and the setup below can throw. Resolving
   * the knowledge root or composing the host reads the shipped modules, and that early return
   * dropped an acquired lease no `finally` here had reached yet, which the step's own no-leak
   * backstop could no longer see either: taking it had already spent the take-once flag. The fence
   * was then held, unheartbeated, for its whole TTL while the wire had already published
   * `drained`. Called HERE, the take happens after the root is known and INSIDE the try whose
   * `finally` releases, so every path out of this method ends the authority it took.
   *
   * Absent, or answering `undefined` ⇒ this pump's own consult, unchanged. That arm is not legacy
   * debt: a harness driving this tail directly never ran a shell and so has no lease to hand over,
   * and a step whose probe found a holder deliberately hands back nothing — see the fallback
   * clause on the post-verdict step's handoff box.
   *
   * `input.withoutLease` is the ONE knob on that fallback, and it exists because the doors
   * genuinely differ. `'consult'` (the default) is `commands/run.ts`: the probe's answer was taken
   * at the verdict and the holder may have released since, so asking again can still become a real
   * drain. `'skip'` is the `runs.start` door (404 D-06), which pumps only on the step's own
   * authority — it used to say so with a caller-side `if` wrapped around this call, and saying it
   * here instead is what let the take move inside.
   *
   * 2026-08-26 (404 D-05): IT RESOLVES ITS OWN KNOWLEDGE ROOT AND COMPOSES ITS OWN HOST. Those two
   * used to be side effects of the `enqueue()` leg, so a tail whose enqueue had not run reported
   * `not-attempted` and drained nothing. With the enqueue in the shell that would be every tail.
   * The root is resolved BEFORE the take and the host is composed AFTER it, so a root this tail
   * cannot resolve costs no lease at all — there would be nothing to release one against.
   */
  drain(input?: {
    readonly takeLease?: () => CurationWriterAuthority | undefined
    readonly withoutLease?: 'consult' | 'skip'
  }): Promise<void>
  /**
   * The user-facing close-out, run on EVERY leg — including the one `--detach` short-circuits.
   *
   * A third callable rather than a tail of `drain()` for the same reason there are two legs at
   * all: the one posture that most needs a line about queued work is the posture where `drain`
   * is never called. The wrapper is the only thing that knows which gate it applied, so it says
   * so here rather than the tail guessing from a report that would read `not-attempted` for
   * both "detached" and "the enqueue never got that far".
   */
  finish(input?: { readonly detached?: boolean }): Promise<void>
  /** Read after every leg has settled. */
  report(): PostRunTailReport
}

/** How many pump iterations are a bug rather than a chain. Three chain members plus slack. */
const CHAIN_PUMP_BOUND = 16

/**
 * Every way the chain pump's loop can end NORMALLY. One spelling, one place to be read: the
 * loop variable ranges over it, and `PUMP_EXIT_STARVES_OWN_CHAIN` must classify every member.
 *
 * The qualifier is load-bearing and was missing (WR-10): a throw does not END this loop, it
 * LEAVES it, skipping the starvation classification below and landing in the drain's catch.
 * That path is outside this domain by construction, and it is reported by the separate
 * `PostRunDrainOutcome` member `'threw'` — not by a fifth exit here, which would imply the
 * classification runs on a path where it never does.
 */
type ChainPumpExit = 'bound' | 'budget' | 'empty' | 'aborted'

/**
 * Per exit: does reaching it WITHOUT having observed this run's own chain mean the chain was
 * starved (WR-01 / T-388-18b)?
 *
 * A `Record` over the named exit type rather than another condition, deliberately: a fifth
 * exit added to the pump fails to compile here until it is classified — the property the
 * shipped two-member disjunction lacked, which is how the former `retry` exit fell through to a
 * bare `pending` for starved work.
 */
const PUMP_EXIT_STARVES_OWN_CHAIN: Record<ChainPumpExit, boolean> = {
  // The bound was spent entirely on other runs' rows before this run's chain was reachable.
  bound: true,
  // The budget was spent the same way: the clock ran out on foreign work.
  budget: true,
  // An emptied queue is not starvation: the rows are gone because somebody ran them.
  empty: false,
  // An abort is not starvation: the user stopped this process.
  aborted: false,
}

export function runPostRunTail(opts: RunPostRunTailOptions): PostRunTailHandle {
  // 2026-10-15 (441-63, WR-A06): every line this tail logs, or hands a leg to log, is masked.
  const mask = opts.mask ?? ((text: string) => text)
  const log: RunPostRunTailOptions['log'] = {
    warn: (message) => opts.log.warn(mask(message)),
    ...(opts.log.info === undefined
      ? {}
      : { info: (message: string) => opts.log.info?.(mask(message)) }),
  }
  // Read at composition; surface refusal inside each leg's verdict-preserving catch.
  const trustPriors = opts.trustPriors ?? buildTrustPriorsResolver({ configPath: opts.configPath })
  const snapshot = () => {
    if (trustPriors.kind === 'refused') throw new TrustPriorsRefusedError()
    return trustPriors
  }
  const resolveTrustPriors = trustPriors.kind === 'ready' ? trustPriors.resolve : undefined
  /**
   * Resolved on first use, INSIDE a leg's own try (JOBQ-06).
   *
   * Constructing the table reads the shipped modules, and a build where one of those reads
   * throws — a partially-stubbed module graph is the real case that found this — would send
   * the exception straight past `runVerdictFirstCurationTail` into the command's framework
   * catch, turning a passing run into exit 2. Post-processing may cost the analysis; it may
   * never cost the verdict, so the tail does no work at all until a leg is awaited.
   */
  let resolvedOperations: PostRunTailOperations | undefined
  const ops = (): PostRunTailOperations => (resolvedOperations ??= {
    ...defaultPostRunTailOperations(),
    ...opts.operations,
  })

  /**
   * What the post-verdict step's enqueue answered, threaded rather than performed (404 D-05).
   *
   * `skipped` when no step ran in front of this tail — a harness, or a door composing the tail
   * directly. It is not a claim that nothing is queued; it is the honest "this process did not do
   * the queuing and was not told what happened".
   */
  const enqueueOutcome = (): PostRunEnqueueOutcome | undefined => {
    if (opts.postVerdict === undefined) return opts.enqueueOutcome ?? 'skipped'
    const state = opts.postVerdict.enqueueState
    return state === 'unbound' ? 'failed' : state
  }
  let observingLateFailure = false
  const discloseFailure = () => log.warn(opts.postVerdict?.failureDetail
    ?? `Run ${opts.runId}: preparation/enqueue failed or was refused. Analysis is not queued.`)
  let drainOutcome: PostRunDrainOutcome = 'not-attempted'
  let jobsRun = 0
  let preparationRecoveryPending = false
  /**
   * Did THIS process's pump run this run's `analyze-run` to `completed`? (389 D-12.)
   *
   * The sentence-block trigger, and deliberately NOT derived from `drainOutcome` or from a
   * chip status (the house rule above `renderPostProcessingSummaryLine`): a drain whose
   * budget ran out on `curate-memory` still completed analyze-run under the one budget, and
   * a drain that emptied an already-drained queue did not — only the pump's own observation
   * can tell those apart honestly.
   */
  let analyzeRunCompleted = false
  let host: LocalAgentHost | undefined
  let knowledgeRoot: string | undefined
  let posturePromise: ReturnType<typeof buildPromotionPostureResolver> | undefined
  let resolvePromotionPosture: RunCurationTailOptions['resolvePromotionPosture']
  const preparePromotionPosture = (currentBuildOrdinal?: number, scope?: ScopeKey) => {
    snapshot()
    posturePromise ??= buildPromotionPostureResolver({ configPath: opts.configPath,
      replayGate: createReplayGatePortForHost({ configPath: opts.configPath, agentQaRoot: opts.agentQaRoot, resolveTrustPriors }),
      knowledgeRoot, agentQaRoot: opts.agentQaRoot,
      canaryFacts: LOCAL_CURATION_CAPABILITIES.readCanaryPostureFacts,
      lowerTrustShares: LOCAL_CURATION_CAPABILITIES.readLowerTrustShares,
      // A root-wide drain may claim another product's candidate. Its "now" must
      // come from that product's store, not the run whose tail happens to drain it.
      currentBuildOrdinal: product => latestBuildOrdinal({ root: opts.agentQaRoot, product }),
    })
    return posturePromise.then(posture => promotionPostureResolverForHost(
      posture, message => log.warn(message), currentBuildOrdinal,
      scope?.tier === 'product' ? scope.key : null,
    ))
  }
  /**
   * The lease the pump holds, read by `curateRun` at CLAIM time rather than at composition
   * time. The host is composed before the lease is acquired — the enqueue must not wait on a
   * lease it does not need (385 D-02) — so a value captured at composition would always be
   * `undefined` and every fold would try to acquire a lease this process already holds.
   */
  let heldAuthority: CurationWriterAuthority | undefined
  /** The one budget's absolute stop point, fixed when the drain leg begins (D-03). */
  let drainDeadlineMs: number | undefined
  // 2026-10-19 (444.1-14, D-01): aborts at `drainDeadlineMs`, or with the caller's own signal.
  let drainSignal: AbortSignal | undefined

  const curateRun: PostRunTailHostInput['curateRun'] = async (input) => {
    if (knowledgeRoot === undefined) {
      throw new Error('the post-run tail resolved no knowledge root to curate against')
    }
    let runMask = opts.mask
    let runKnowledgeRoot = knowledgeRoot
    if (input.runId !== opts.runId) {
      const context = await ops().resolveRunCurationContext({
        agentQaRoot: opts.agentQaRoot, runId: input.runId, drainerKnowledgeRoot: knowledgeRoot,
      })
      if ('handBack' in context) {
        return { curated: 0, deprecated: 0, complete: false, reason: context.handBack }
      }
      runMask = context.mask
      runKnowledgeRoot = context.knowledgeRoot
    }
    const curatedRunDir = completedRunDir(opts.agentQaRoot, input.runId)
    const handoff = ops().loadCompletedRunHandoff(
      completedRunHandoffPath(opts.agentQaRoot, input.runId),
    )
    const deadlineMs = input.deadlineMs ?? drainDeadlineMs
    const foldSignal = drainSignal ?? opts.signal
    const runPromotionPosture = await preparePromotionPosture(handoff.buildOrdinal, handoff.scope)
    const folded = await ops().curateCompletedRun({
      resolveTrustPriors,
      ...(input.runId !== opts.runId || opts.maxAblations === undefined ? {} : { maxAblations: opts.maxAblations }),
      ...(opts.canaryAblation === undefined ? {} : { operations: { canaryAblation: opts.canaryAblation } }),
      ...(runPromotionPosture === undefined ? {} : { resolvePromotionPosture: runPromotionPosture }),
      runDir: curatedRunDir,
      handoff,
      knowledgeRoot: runKnowledgeRoot,
      agentQaRoot: opts.agentQaRoot,
      ...(runMask === undefined ? {} : { mask: runMask }),
      ...(opts.modelDeps === undefined ? {} : { modelDeps: opts.modelDeps }),
      ...(heldAuthority === undefined ? {} : { authority: heldAuthority }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(foldSignal === undefined ? {} : { signal: foldSignal }),
      log,
    })
    // WR-03: the fold already told us whether it wrote a receipt. Dropping `complete` here is
    // what let `incompleteWarning` print "curation incomplete; it will resume" while the
    // durable notification row recorded the same stage as `done`.
    return {
      curated: folded.curated,
      deprecated: folded.deprecated,
      complete: folded.complete,
      ...(folded.snapshot === undefined ? {} : { snapshot: folded.snapshot }),
    }
  }

  const openHost = (): LocalAgentHost => {
    host ??= ops().composeHost({
      trustPriors: snapshot(),
      resolvePromotionPosture: preparePromotionPosture,
      agentQaRoot: opts.agentQaRoot,
      configPath: opts.configPath,
      // The same conditional spread the fold is threaded with: composeHost derives the
      // posture from this value's PRESENCE, so the tail never asserts a mask it lacks.
      ...(opts.mask === undefined ? {} : { mask: opts.mask }),
      // The SAME `heldAuthority` closure `curateRun` reads above, and for the same reason: the
      // fold and the Gate-1 write happen under one lease, and a second way to learn which lease
      // is a second answer to who is writing (422 D-14).
      resolveClaimAuthority: () => heldAuthority,
      curateRun,
    })
    return host
  }

  return {
    trustPriorDisclosure: trustPriors.kind === 'ready' ? trustPriors.disclosure : undefined,
    async drain(input: {
      readonly takeLease?: () => CurationWriterAuthority | undefined
      readonly withoutLease?: 'consult' | 'skip'
    } = {}): Promise<void> {
      if (opts.postVerdict !== undefined && enqueueOutcome() !== 'enqueued' && enqueueOutcome() !== 'deduped') return
      let root: string
      const budget = new AbortController()
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      try {
        // 404 D-05: resolved HERE. The enqueue leg used to do it as a side effect, and the step
        // that replaced it runs in the shell — a tail that waited for a leg that no longer exists
        // would report `not-attempted` for every run there is.
        //
        // ONE ROOT, still: `resolveKnowledgeRoot` is the same pure function over the same
        // `knowledgeConfig`/`configDir` the producer resolved the run's root from, so this is a
        // re-derivation of a value rather than a second answer to where knowledge lives.
        //
        // AND IT IS THE ONE THING THAT HAPPENS BEFORE THE TAKE (CR-01). A release is addressed to
        // a knowledge root; a lease acquired while this call was still able to throw would be a
        // lease with no address to release it against, held to its TTL under a wire that already
        // said `drained`. Nothing above this line acquires anything, so a root that cannot be
        // resolved costs a warning and no fence.
        knowledgeRoot ??= ops().resolveKnowledgeRoot(opts.knowledgeConfig, opts.configDir)
        root = knowledgeRoot
        const drainStartedMs = ops().now()
        drainDeadlineMs = opts.deadlineMs ?? drainStartedMs + DRAIN_BUDGET_MS
        if (
          (opts.deadlineMs !== undefined && drainStartedMs >= drainDeadlineMs)
          || opts.signal?.aborted
        ) {
          drainOutcome = 'budget-exhausted'
          return
        }
        budgetTimer = setTimeout(() => { budget.abort() }, drainDeadlineMs - drainStartedMs)
        budgetTimer.unref()
        const recovery = await ops().recoverPendingPostVerdictContinuations({
          agentQaRoot: opts.agentQaRoot, configPath: opts.configPath, knowledgeRoot: root,
          deadlineMs: drainDeadlineMs, log,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
        })
        preparationRecoveryPending = recovery.some((result) => result.pending)
        resolvePromotionPosture = await preparePromotionPosture()
      } catch (error) {
        // Constructing the operations table reads the shipped modules, and a build where one of
        // those reads throws must not send the exception past `runVerdictFirstCurationTail` into
        // the command's framework catch (JOBQ-06).
        clearTimeout(budgetTimer)
        drainOutcome = 'not-attempted'
        log.warn(drainFailureWarning(opts.runId, error, opts.executionContext))
        return
      }
      let acquiredLeaseId: string | undefined
      let openedHost: LocalAgentHost | undefined
      const signal = opts.signal === undefined
        ? budget.signal
        : AbortSignal.any([opts.signal, budget.signal])
      drainSignal = signal
      try {
        // THE TAKE, AND THE `finally` THAT ENDS IT, IN ONE TRY (CR-01). Calling the thunk is what
        // acquires; the very next statement records what to release. Nothing can run between them.
        const handed = input.takeLease?.()
        acquiredLeaseId = handed?.leaseId
        heldAuthority = handed
        if (handed === undefined && input.withoutLease === 'skip') {
          // 404 D-06's door rule, moved off the caller. Nothing was acquired and nothing is
          // composed: `drainOutcome` stays `not-attempted`, which is what `finish({ detached })`
          // reads to name the posture for a door that pumped nothing.
          return
        }
        // Composed AFTER the take, so a composition that throws lands in the catch below with a
        // release already armed above it — the exact path that used to drop the lease.
        openedHost = openHost()
        // 404 D-10: a handed authority goes straight to the acquired branch's own sequence — adopt
        // the epoch the step minted, reclaim what a dead holder left, pump — and this consult is
        // SKIPPED entirely. That is the whole point (Pitfall 3): the `held` and `refused` arms
        // below are unreachable for a lease this process is already holding, and reaching them
        // would be the bug. The release in this method's `finally` ends whichever lease the pump
        // held, so a handed-over authority still leaves through exactly one release.
        if (handed === undefined) {
          const acquired = ops().acquireWriterLease(root)
          if (acquired.kind === 'held') {
            // Pitfall 8: the SHIPPED envelope, verbatim. Its handler already calls both
            // `requestDrain` and `jobDispatcher.wake()`, so reusing it wakes the agent-job
            // pump with zero protocol change — and a nudge that never lands is invisible by
            // design, because the daemon's 5s poll is the backstop (386 D-13).
            void ops().nudgeDaemon(opts.agentQaRoot, { knowledgeRoot: root })
              .catch(() => undefined)
            drainOutcome = 'handed-off'
            return
          }
          if (acquired.kind !== 'acquired') {
            drainOutcome = 'refused'
            return
          }
          acquiredLeaseId = acquired.leaseId
          heldAuthority = { leaseId: acquired.leaseId, epoch: acquired.epoch }
        }
        const authority = heldAuthority
        if (authority === undefined) {
          // Unreachable: both arms above either returned or assigned. Asserted rather than assumed
          // — a silently absent authority would pump under no fence at all.
          drainOutcome = 'refused'
          return
        }
        const jobs = await openedHost.jobs()
        /**
         * This run's chain ids, derived ONCE per drain, from the queue's OWN id source.
         *
         * The same `chainJobIdsForRun` the read op derives from (`runs-post-processing.ts`), and
         * the same `idSource` the enqueue above minted with — so the push half of this run's chip
         * trail and the pull half of its status cannot address different rows. The array is a
         * local because two readers need exactly this value: the emitter's drop-guard and the
         * pump's own-chain tracker. Re-deriving for the second reader would be a second answer to
         * a question with one.
         */
        const chainIds = chainJobIdsForRun(opts.runId, jobs.idSource)
        const ownChainJobIds = [
          String(chainIds.analyzeRun),
          String(chainIds.curateMemory),
          // 422 D-13. Listed for the own-chain tracker rather than for the chips: the proposal
          // stage has no chip (`STAGE_CHIPS` maps only the two), so the emitter's drop-guard
          // admits its outcome and then finds nothing to draw. Omitting the id would instead
          // have made this tail's own third stage read as another run's work.
          String(chainIds.proposeImprovements),
        ]
        /**
         * The ONLY construction site (D-13).
         *
         * Inside the acquired-lease branch, after the hand-off and refusal legs have already
         * returned, because this is the one branch that observes `runNextJob` outcomes at all.
         * A detached run never reaches `drain`; a handed-off run returned above; a refused
         * lease returned above. So "the daemon emits nothing" is not a rule this file checks —
         * it is a consequence of where this line sits.
         */
        const chips = ops().createChipEmitter({
          agentQaRoot: opts.agentQaRoot,
          runId: opts.runId,
          chainJobIds: ownChainJobIds,
          // The tail's mask, spread on the same conditional idiom the fold is threaded with: the
          // chip's error text crosses the same disclosure boundary the fold's does (WR-08).
          ...(opts.mask === undefined ? {} : { mask: opts.mask }),
          // 404-05 (D-16): the dashboard's second sink, threaded on the same conditional idiom —
          // an absent relay is an ABSENT field, never a present `undefined`, so the emitter's own
          // optional call is what decides, in one place.
          ...(opts.relay === undefined ? {} : { relay: opts.relay }),
          now: () => ops().now(),
        })
        // Pitfall 7, the daemon's sequence verbatim (host.ts:1759): adopt the epoch the lease
        // just minted, then reclaim rows a dead holder left claimed. Both are safe here for
        // the same reason they are safe there — exactly one fence-holder exists at a time.
        const fence = await jobs.store.adoptEpoch(authority.epoch)
        await jobs.queue.recoverAbandonedClaims({ fence })
        drainOutcome = 'drained'
        /**
         * Did the pump ever reach a member of THIS run's chain?
         *
         * Read from the same `ownChainJobIds` the emitter's drop-guard reads — one derivation per
         * drain, two readers. A second spelling here would be a second answer to "is this our
         * work", and the posture the user is told would be free to disagree with the trail.
         */
        let ownChainObserved = false
        const retryingOwnJobs = new Set<string>()
        /**
         * How the pump left the loop. Whether an exit means this run's chain was starved is
         * declared once, per member, in `PUMP_EXIT_STARVES_OWN_CHAIN` — this doc's job is to
         * point there, not to re-enumerate a subset of the domain.
         */
        let pumpExit: ChainPumpExit = 'bound'
        for (let pumped = 0; pumped < CHAIN_PUMP_BOUND; pumped += 1) {
          if (ops().now() >= drainDeadlineMs) {
            drainOutcome = 'budget-exhausted'
            pumpExit = 'budget'
            break
          }
          if (opts.signal?.aborted === true) {
            pumpExit = 'aborted'
            break
          }
          const outcome = await jobs.queue.runNextJob({ fence, signal })
          if (!outcome.ran) {
            pumpExit = 'empty'
            break
          }
          // Emitted from the outcome the pump just RECEIVED, before anything is decided about
          // it: the chip says what the queue durably did, not what this loop does next.
          chips.observe(outcome)
          const outcomeJobId = String(outcome.job.id)
          if (ownChainJobIds.includes(outcomeJobId)) {
            ownChainObserved = true
            if (outcome.disposition === 'retry-scheduled') retryingOwnJobs.add(outcomeJobId)
            else retryingOwnJobs.delete(outcomeJobId)
          }
          if (
            String(outcome.job.id) === String(chainIds.analyzeRun)
            && outcome.disposition === 'completed'
          ) {
            // The D-12 trigger, recorded at the one place it is observable: a failed or
            // retry-scheduled analyze-run is NOT a completed one, and no later leg may
            // infer completion from a status word this process did not witness.
            analyzeRunCompleted = true
          }
          jobsRun += 1
          if (outcome.disposition === 'retry-scheduled') {
            // Never sleep the run process on a backoff. The store keeps the row out of every
            // claim until its not-before time (444.1 D-23), so the pump goes on to the next one.
            continue
          }
          if (outcome.disposition === 'interrupted') {
            // The signal cut off an in-flight model request; the job is queued again, unspent.
            if (signal.aborted && !budget.signal.aborted) {
              pumpExit = 'aborted'
            } else {
              drainOutcome = 'budget-exhausted'
              pumpExit = 'budget'
            }
            break
          }
        }
        // 2026-10-19 (444.1-21, D-31): a retry of another run's job never changes this run's outcome.
        if (drainOutcome === 'drained' && retryingOwnJobs.size > 0) drainOutcome = 'retry-scheduled'
        // WR-01 / T-388-18b: the pump ended without ever reaching this run's chain, on an exit
        // the table classifies as starvation. The user is owed the reason their work is still
        // pending, not just the fact. No condition on `drainOutcome` here, deliberately: every
        // exit the table marks as starvation is reachable only inside the pump, where the drain
        // outcome is necessarily one of the three values the pump itself sets — the handed-off,
        // refused, detached and not-attempted postures all return before the loop is entered —
        // and widening a hand-written subset would reintroduce the same defect one line down.
        if (!ownChainObserved && PUMP_EXIT_STARVES_OWN_CHAIN[pumpExit]) {
          drainOutcome = 'backlog-exhausted'
        }
        // The prior-run janitor, under the REMAINder of the same budget and the same lease
        // (Pitfall 11). This run's own directory is already receipted by the fold the chain
        // just ran, so the sweep skips it rather than folding it twice.
        if (!preparationRecoveryPending) await ops().runCurationTail({
          resolveTrustPriors,
          resolvePromotionPostureForRun: preparePromotionPosture,
          ...(opts.canaryAblation === undefined ? {} : { operations: { canaryAblation: opts.canaryAblation } }),
          ...(resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture }),
          runId: opts.runId,
          agentQaRoot: opts.agentQaRoot,
          knowledgeConfig: opts.knowledgeConfig,
          configDir: opts.configDir,
          ...(opts.mask === undefined ? {} : { mask: opts.mask }),
          ...(opts.modelDeps === undefined ? {} : { modelDeps: opts.modelDeps }),
          signal,
          log,
          authority: heldAuthority,
          deadlineMs: drainDeadlineMs,
        })
      } catch (error) {
        // The report may not keep the optimistic `'drained'` set before the pump (WR-10).
        // Assigned here rather than cleared in `finally`, because `finally` also runs on the
        // paths that legitimately drained.
        //
        // A host that never came up reads `not-attempted`, not `threw`, and the composition is
        // the one thing this distinguishes: JOBQ-06's posture is that a build whose shipped
        // modules will not compose ATTEMPTED nothing. Read off `openedHost` rather than off a
        // second flag, because that variable already records exactly the fact being asked about.
        drainOutcome = openedHost === undefined ? 'not-attempted' : 'threw'
        log.warn(drainFailureWarning(opts.runId, error, opts.executionContext))
      } finally {
        clearTimeout(budgetTimer)
        drainSignal = undefined
        heldAuthority = undefined
        // THE ONE RELEASE, ON EVERY PATH OUT (CR-01). `acquiredLeaseId` is set in the same breath
        // as the take above and by the acquired arm below it, so there is no exit from this try —
        // return, throw or fall-through — that leaves a fence held by a process that stopped
        // pumping. `root` is known before either could have run, so the release always has an
        // address.
        if (acquiredLeaseId !== undefined) {
          try {
            ops().releaseLease({ knowledgeRoot: root, leaseId: acquiredLeaseId })
          } catch {
            // A lease this process cannot release expires on its own TTL; failing the tail
            // over it would spend the verdict-first guarantee on cleanup.
          }
        }
        if (openedHost !== undefined) {
          try {
            await openedHost.close()
          } catch {
            // Same posture: a store handle that will not close is the process's problem, and
            // the process is about to exit.
          }
        }
      }
    },

    async finish(input: { readonly detached?: boolean } = {}): Promise<void> {
      const actualEnqueue = enqueueOutcome()
      if (opts.postVerdict !== undefined && actualEnqueue === undefined) {
        const resumeClause = ciResumeClause(opts.executionContext, 'any-host')
        log.info?.(resumeClause !== undefined
          ? `Run ${opts.runId}: preparation pending; analysis is not yet queued. It ${resumeClause}. Durable intent: ${opts.postVerdict.pendingPath}.`
          : `Run ${opts.runId}: preparation pending; analysis is not yet queued. Durable intent: ${opts.postVerdict.pendingPath}. The next local run or daemon drain resumes eligible pending preparation.`)
        if (!observingLateFailure && opts.postVerdict.completion !== undefined) {
          observingLateFailure = true
          void opts.postVerdict.completion.then(() => {
            if (enqueueOutcome() === 'failed') discloseFailure()
          }, discloseFailure)
        }
        return
      }
      if (opts.postVerdict !== undefined && actualEnqueue === 'failed') { discloseFailure(); return }
      // 444 D-55: a skipped enqueue (a gate run, an outcome-excluded run) falls through to the one
      // exit line, which prints the status read's `skipped` fact. `drain()` returned before doing
      // anything, and nothing here pumps, so nothing was queued and nothing is drained.
      const skippedEnqueue = opts.postVerdict !== undefined && actualEnqueue === 'skipped'
      if (input.detached === true && drainOutcome === 'not-attempted' && !skippedEnqueue) {
        // The one place `detached` is ever produced. `drain()` was never called, so nothing
        // else in this file could have said so — and a report that called the detach posture
        // `not-attempted` would be indistinguishable from an enqueue that failed first.
        drainOutcome = 'detached'
      }
      /**
       * ONE digest read per tail, whichever arm consumes it (391 D-17).
       *
       * Read lazily and memoised, because exactly one of the two arms below needs it and both
       * need it at most once: the block prints its lines, the exit line points at it and
       * carries its pending count. Two reads would be two projections of one run — cheap,
       * durable and still two answers to a question with one.
       *
       * A failed read costs the digest and nothing else. The warning names the SAME fetch
       * command the exit line would have carried, so the reader's next step is identical
       * whichever way the digest failed to arrive (JOBQ-06: the exit code froze long ago).
       */
      /**
       * This run's persisted Gate-1 leg, read at most once and never at the cost of the line.
       *
       * A DISCLOSURE read has exactly one budget: its own clause. An unbound operation, a store
       * that will not answer, a host whose `jobs()` handle is a harness stub — all of them are
       * "this tail could not read a proposal record", which is what `not-recorded` says. The
       * close-out line is the thing a user sees at the end of a run, and a store read taken for
       * one parenthetical may never be the reason it disappears (the `summaryFailureWarning`
       * posture, minus the warning: nothing was promised here).
       */
      const readProposalGate1 = async (
        host: LocalAgentHost,
      ): Promise<ProposalGate1Disclosure> => {
        const read = ops().readProposalGate1Report
        if (read === undefined) return { kind: 'not-recorded' }
        try {
          return await read(host, opts.runId)
        } catch {
          return { kind: 'not-recorded' }
        }
      }
      /**
       * What actually backs this run's circularity claim (D-19).
       *
       * The RECORDED posture is this run's own `misdirection-posture.json`, written by the
       * arbiter before the analysis enqueue; whether it was APPLIED is a property of the shipped
       * composition (`MISDIRECTION_POSTURE_BOUND_AT_HOST`). Production now binds the reader.
       * Both travel because a harness host may still compose without the binding, and the
       * renderer must retain its fail-closed arm when appliedAtHost is false.
       *
       * A posture file that is present and will not parse is `unreadable` and NOT `not-recorded`:
       * the first says this build could not read what the arbiter wrote, the second says the
       * arbiter wrote nothing, and an operator acts differently on each.
       */
      const readCircularityBacking = (): CircularityGuardDisclosure => {
        let record: MisdirectionRunPostureRecord | undefined
        try {
          record = readMisdirectionRunPosture(
            completedRunDir(opts.agentQaRoot, opts.runId),
            opts.runId,
          )
        } catch {
          return { kind: 'unreadable' }
        }
        return record === undefined
          ? { kind: 'not-recorded' }
          : {
              kind: 'recorded',
              posture: record.kind,
              appliedAtHost: MISDIRECTION_POSTURE_BOUND_AT_HOST,
            }
      }
      let digestRead: { value: RunDigest | undefined } | undefined
      const readDigest = async (openedHost: LocalAgentHost): Promise<RunDigest | undefined> => {
        if (digestRead === undefined) {
          try {
            digestRead = { value: await ops().readRunDigest(openedHost, opts.runId) }
          } catch (error) {
            log.warn(digestReadFailureWarning(opts.runId, error))
            digestRead = { value: undefined }
          }
        }
        return digestRead.value
      }
      /**
       * The D-17 digest block, printed AFTER whichever exit line rendered — and only when this
       * process's own pump completed analyze-run (never a wait, never a poll: the chain either
       * finished under the one budget or the exit line carries the fetch command instead).
       *
       * It REPLACED the 389 sentence block rather than joining it. The digest's first section
       * is that same clustered block, rendered by the same relocated function from the same op
       * result, so printing both would have told one run's story twice — which is exactly the
       * "nothing printed twice" half of D-17.
       */
      const printDigestBlock = async (openedHost: LocalAgentHost): Promise<void> => {
        if (!analyzeRunCompleted) return
        const digest = await readDigest(openedHost)
        if (digest === undefined || digest.lines.length === 0) return
        log.info?.(digest.lines.join('\n'))
      }
      // 404 D-05: the step's answer, not this file's. Nothing is queued and the step's own
      // `post-run-enqueue-failed` warning has already said everything true about this run, so a
      // close-out line built from an empty chain would be the second, quieter version of it.
      if (actualEnqueue === 'failed') return
      let openedHost: LocalAgentHost
      try {
        // Composed HERE rather than inherited: the detach leg never calls `drain()`, and it is
        // exactly the posture that most needs a line about work left queued (388-04 D-08).
        openedHost = openHost()
      } catch (error) {
        log.warn(summaryFailureWarning(opts.runId, error))
        return
      }
      try {
        const status = await ops().readPostProcessingStatus(openedHost, opts.runId)
        if (status.notification !== undefined && drainOutcome === 'drained') {
          // D-09: this process ran the chain to its terminal, so the human line is the honest
          // close-out — it reports what HAPPENED, where the summary reports what is pending.
          // Diagnostics come from this run's validated durable receipt; without one the line
          // omits them. The line prints the served view's words.
          const receipt = readCurationTailReceipt(completedRunDir(opts.agentQaRoot, opts.runId))
          log.info?.(renderChainTerminalLine(status.notification,
            { ...(receipt?.runId === opts.runId ? receipt : {}),
              trustPriorDisclosure: snapshot().disclosure,
              // 422 D-14/D-19: two disclosure reads, both read-only, both on the leg that has the
              // host already open. Each one costs at most its own clause — see `disclosureOf`.
              proposalGate1: await readProposalGate1(openedHost),
              circularity: readCircularityBacking() }))
          await printDigestBlock(openedHost)
          return
        }
        // D-08: work stays queued. The statuses are durable; the parenthetical is posture —
        // and so is the D-17 suffix: when THIS process did not complete analyze-run, the line
        // gains the pending-proposal count and the exact fetch command (the whole digest is
        // one copy-paste away); when it did, the digest prints one line down and a pointer
        // would be noise. EITHER/OR, one story.
        log.info?.(
          renderPostProcessingSummaryLine(
            status,
            postureOf(drainOutcome),
            snapshot().disclosure,
            opts.executionContext,
          )
          + (analyzeRunCompleted
            ? ''
            : renderDigestPointer(opts.runId, await readDigest(openedHost))),
        )
        await printDigestBlock(openedHost)
      } catch (error) {
        log.warn(summaryFailureWarning(opts.runId, error))
      } finally {
        try {
          // Idempotent, and the detach leg's only close: this leg opened the store and the
          // drain that would have closed it never ran.
          await openedHost.close()
        } catch {
          // The process is about to exit; a handle that will not close is not worth the
          // verdict-first guarantee.
        }
      }
    },

    report(): PostRunTailReport {
      const enqueue = enqueueOutcome()
      return { ...(enqueue === undefined ? { preparationPending: true as const } : { enqueue }), drain: drainOutcome, jobsRun }
    },
  }
}

/** The chip words joined by the separator D-08 pinned, in chain order. */
const SUMMARY_SEPARATOR = ' · '

/**
 * What THIS process knows about a pending stage's future — the only thing durable state cannot
 * say for itself.
 *
 * `none` is the honest answer for `--detach`, a refusal and a drain that simply ended: nobody in
 * this process promised anything, so nothing is promised on their behalf.
 */
export type PostRunPendingPosture = 'handed-off' | 'backlog-exhausted' | 'none'

/**
 * Which hosts may drain a stage's kind — read off 388-10's posture contract rather than
 * restated as a condition.
 *
 * `curate-memory` is unclaimable by a host that folds with no declared mask bound
 * (`UNCLAIMABLE_BY_PROSE_POSTURE`), and the production daemon declares exactly that posture,
 * so no daemon will ever drain curation. The parenthetical used to be chosen by POSTURE
 * alone and pasted onto every pending stage, which is how a handed-off leg came to promise a
 * daemon drain for the one kind a daemon may not claim (WR-09).
 */
type StageDrainer = 'any-host' | 'masked-leg-only'

/**
 * A `Record` over the chip set rather than a condition on the curation stage: the chips are
 * closed and ratified, so a third stage must classify its drainer HERE instead of inheriting
 * a promise from a fall-through — the same defect class 388 already named twice.
 */
const STAGE_DRAINER: Record<keyof PostProcessingChips, StageDrainer> = {
  analysis: 'any-host',
  curation: 'masked-leg-only',
}

/**
 * What the parenthetical says, per drainer and posture. `none` says nothing, deliberately.
 *
 * The `masked-leg-only` column names a later LOCAL run rather than a daemon because that is
 * the only host that can claim the kind — and it says "local run" rather than promising a
 * time, because a daemon holding the writer lease for its whole lifetime is exactly what a
 * masked leg has to wait out.
 */
const PENDING_POSTURE_SUFFIX: Record<StageDrainer, Record<PostRunPendingPosture, string>> = {
  'any-host': {
    'handed-off': ' (daemon will drain)',
    'backlog-exhausted': ' (queued behind other runs; the daemon or a later run will drain)',
    none: '',
  },
  'masked-leg-only': {
    'handed-off': ' (deferred to a later local run)',
    'backlog-exhausted': ' (queued behind other runs; a later local run will drain)',
    none: '',
  },
}

// 2026-10-18 (444-14, D-22): a CI workspace is usually thrown away, so in `ci` and `cloud` a pending
// stage names the one condition under which its drainer can still reach it, whatever the posture.
const CI_PENDING_SUFFIX: Record<StageDrainer, string> = {
  'any-host': ` (${resumeLimitClause('any-host')})`,
  'masked-leg-only': ` (${resumeLimitClause('masked-leg-only')})`,
}

/**
 * Total over the drain-outcome union, deliberately: a new outcome must choose its posture HERE
 * rather than inherit one from a fall-through — which is precisely how G-388-3 shipped.
 */
const DRAIN_OUTCOME_POSTURE: Record<PostRunDrainOutcome, PostRunPendingPosture> = {
  'not-attempted': 'none',
  detached: 'none',
  'handed-off': 'handed-off',
  drained: 'none',
  'budget-exhausted': 'none',
  'backlog-exhausted': 'backlog-exhausted',
  'retry-scheduled': 'none',
  refused: 'none',
  // Nobody promised anything: the drain blew up. Whatever is still `pending` is pending for a
  // reason the warning already named, one line above the status.
  threw: 'none',
}

function postureOf(outcome: PostRunDrainOutcome): PostRunPendingPosture {
  return DRAIN_OUTCOME_POSTURE[outcome]
}

/**
 * The D-08 exit summary — ONE line, in the ONE chip vocabulary (D-14).
 *
 * Two rules, and the second is the whole reason this takes two arguments:
 *
 *   - Every status word comes from `runs.postprocessing`, verbatim. Not a synonym, not a
 *     control-flow word from `PostRunTailReport`, not "queued" where the vocabulary says
 *     `pending`. A surface that re-spells one of five words is a surface that will eventually
 *     disagree with the dashboard about a row neither of them got wrong.
 *   - The parenthetical is NOT in the DTO and cannot be. `pending` honestly means "no work has
 *     happened", and durable state has no way to know whether a daemon is about to change that,
 *     whether a backlog is in the way, or whether nobody ever will. That fact lives in THIS
 *     process's POSTURE — it handed the chain off and nudged, or it spent its whole budget on
 *     other runs' jobs — so it is rendered from `posture` and never derived from a status, in
 *     either direction.
 *
 * The parenthetical attaches per STAGE rather than per line: whichever stages are still
 * `pending` are the ones somebody will drain, and a stage that already finished must not be
 * annotated with a future.
 *
 * 425 D-08 / 444 D-39: a THIRD rule, and it outranks both. A run whose chain was never enqueued
 * carries the op's `skipped` fact; both stages print `skipped (<reason word>)` from the one schema
 * map, as the digest and the dashboard do. Absent job rows never spell it.
 *
 * 444 D-22: in `ci` and `cloud` the execution context, never a status, picks a pending stage's
 * suffix: its drainer's resume limit (`CI_PENDING_SUFFIX`).
 */
export function renderPostProcessingSummaryLine(
  status: PostProcessingStatus,
  posture: PostRunPendingPosture,
  trustPriorDisclosure?: TrustPriorDisclosure,
  executionContext?: ExecutionContext,
): string {
  const skipped = status.skipped
  const pendingSuffix = (label: keyof PostProcessingChips): string => isCiContext(executionContext)
    ? CI_PENDING_SUFFIX[STAGE_DRAINER[label]]
    : PENDING_POSTURE_SUFFIX[STAGE_DRAINER[label]][posture]
  const stage = (label: keyof PostProcessingChips, chip: string): string => {
    if (skipped !== undefined) {
      return `${label}: skipped (${POST_PROCESSING_SKIP_REASON_WORDS[skipped.reason]})`
    }
    const suffix = chip === 'pending' ? pendingSuffix(label) : ''
    return `${label}: ${chip}${suffix}`
  }
  return `post-processing — ${[
    stage('analysis', status.chips.analysis),
    stage('curation', status.chips.curation),
    formatTrustPriorDisclosure(trustPriorDisclosure),
  ].join(SUMMARY_SEPARATOR)}`
}

/**
 * Re-exported from the module that OWNS the posture record (422 D-19; WINDOWS #427).
 *
 * The constant lives beside `readMisdirectionRunPosture` rather than here, and the move is not
 * tidiness: `doctor-knowledge-checks.ts` needs the same fact, and importing it from THIS file
 * would pull the terminal host's composition, the daemon client and its registration module into
 * doctor's graph — which is exactly the host-to-host import trap 422-09 recorded when the daemon
 * could not load `local-agent-host.ts`. `misdirection-run-state.ts` names only `zod`, the schema
 * package and node built-ins, so it is importable from anywhere in this package.
 */
export { MISDIRECTION_POSTURE_BOUND_AT_HOST }


/**
 * What this run's persisted `proposals-authored` checkpoint says about its Gate-1 leg (422 D-14).
 *
 * FOUR ARMS, and none of them is a zero. `not-recorded` is a chain that never published the
 * checkpoint — every run written before 422 D-13, and every chain that halted at the fold.
 * `unreadable` is a checkpoint this build found and could not read, which is a different fact and
 * must never degrade into the first. `unbound` is the handler's own `disposition: 'unbound'`,
 * omitted from the checkpoint by `realProposeImprovementsHandler`: a host that bound no gate
 * capability did not screen zero candidates, it did not screen.
 */
export type ProposalGate1Disclosure =
  | { readonly kind: 'not-recorded' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unbound' }
  | { readonly kind: 'recorded'; readonly report: ProposeGate1Report }

/**
 * What backs this run's circularity claim (422 D-19).
 *
 * `posture` is what `misdirection-posture.json` RECORDED; `appliedAtHost` is whether the analysis
 * stage could read it at all. Production now binds the reader, but the members stay separate
 * because a harness host may still compose without it. See MISDIRECTION_POSTURE_BOUND_AT_HOST:
 * the renderer's tested appliedAtHost: false arm must remain fail-closed.
 */
export type CircularityGuardDisclosure =
  | { readonly kind: 'not-recorded' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'recorded'
      readonly posture: MisdirectionRunPostureRecord['kind']
      readonly appliedAtHost: boolean
    }

/**
 * The D-09 human line, rendered from the chain-terminal row and nothing else.
 *
 * Fires on ANY terminal — complete or failed (D-12) — because a failure is exactly when the user
 * most needs to be told. Counts come from the row rather than from the drain that produced it:
 * the row is what 392's chat and M5's dashboard will render, and a CLI line built from a
 * live-process value would be a second, quieter answer to the same question.
 *
 * Absent curation counts print as no counts at all (D-11): a stage that never committed a
 * bundle reports its status, and a `0 curated` would say it curated nothing, which is a
 * different claim from never having got that far.
 *
 * 423 D-15: the curation clause has TWO SENTENCES and never prints both. A row that recorded a
 * `curationSnapshot` renders its breakdown as the five fixed buckets (`added N, confirmed N,
 * superseded N, deprecated N, proposed N`), every one printed because a recorded snapshot measured
 * all five. A row without one — every notification written before 423, and any run whose snapshot
 * could not be folded — renders the legacy `N curated, M deprecated` pair exactly as before, since
 * the pair is all those rows carry; five buckets are never synthesized from it.
 *
 * 422 D-13/D-14/D-19: the third stage joins it, and the SAME rule governs every number it adds —
 * absent is not zero. `stages.proposals` absent renders `not recorded` (a v2 row, or a chain that
 * halted at the fold), a recorded stage with no counts renders `staged not recorded` (no staging
 * port was bound), and only a recorded `proposed: 0` renders a zero. `proposalGate1` and
 * `circularity` follow the same law, one arm per fact.
 *
 * WHAT NEVER REACHES THIS LINE (D-11, T-422-17-01): no `reason` text from any of those records.
 * `ProposeGate1Report.reason` carries a corpus-posture refusal or a store error verbatim, and
 * `MisdirectionRunPostureRecord.reason` carries a root read failure — both are arbitrary strings
 * from layers with no masking boundary of their own. Only the closed disposition and posture
 * WORDS and the array LENGTHS are rendered; no candidate id, no digest, no authored text.
 */
export function renderChainTerminalLine(
  notification: RunNotificationView,
  report?: {
    canary?: CanaryCreditCounters
    trustPriorDisclosure?: TrustPriorDisclosure
    /** This run's persisted Gate-1 leg; omitted entirely by a caller that read none. */
    proposalGate1?: ProposalGate1Disclosure
    /** What actually backs this run's circularity claim; omitted by a caller that read none. */
    circularity?: CircularityGuardDisclosure
  },
): string {
  const { verdictSummary, stages } = notification
  const classes = Object.entries(verdictSummary.byClass)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, count]) => `${className} ${count}`)
  const verdicts = `verdicts ${verdictSummary.total}`
    + (classes.length === 0 ? '' : ` (${classes.join(', ')})`)
  const breakdown = stages.curation.curationSnapshot?.breakdown
  const counts = breakdown !== undefined
    ? CURATION_BREAKDOWN_BUCKETS.map(bucket => `${bucket} ${breakdown[bucket]}`)
    : [
        ...(stages.curation.curated === undefined ? [] : [`${stages.curation.curated} curated`]),
        ...(stages.curation.deprecated === undefined
          ? []
          : [`${stages.curation.deprecated} deprecated`]),
      ]
  const canary = report?.canary
  const nonSignalTotal = canary === undefined ? 0
    : NON_SIGNAL_CLASSES.reduce((sum, name) => sum + canary.nonSignal[name], 0)
  // 418 D-10: the receipt's typed class counts remain visible on the chain line.
  const nonSignalClasses = canary === undefined || nonSignalTotal === 0 ? ''
    : ` (${NON_SIGNAL_CLASSES.map(name => `${name} ${canary.nonSignal[name]}`).join(', ')})`
  const canaryText = canary === undefined ? '' :
    `canary: credited ${canary.credited}, ride-along ${canary.rideAlongUncredited}`
    + `, cap-exceeded ${canary.ablationCapExceeded}`
    + `, non-signal ${nonSignalTotal}${nonSignalClasses}`
    + `, rerun-excluded ${canary.rerunExcluded}, staged ${canary.staged}`
  const curationCounts = counts.join(', ') + (canaryText === '' ? '' :
    `${counts.length === 0 ? '' : '; '}${canaryText}`)
  return `post-processing ${notification.outcome} for ${notification.runId} — ${[
    verdicts,
    `analysis: ${stages.analysis.status}`,
    `curation: ${stages.curation.status}`
      + (curationCounts === '' ? '' : ` (${curationCounts})`),
    renderProposalStageSegment(stages.proposals, report?.proposalGate1),
    ...(report?.circularity === undefined
      ? []
      : [renderCircularityGuardSegment(report.circularity)]),
    formatTrustPriorDisclosure(report?.trustPriorDisclosure),
  ].join(SUMMARY_SEPARATOR)}`
}

/**
 * The third stage's clause on the D-09 line (422 D-13/D-14).
 *
 * FOUR SENTENCES AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   `proposals: not recorded`            the row carries no proposal stage, as for every chain
 *                                        that halted at a permanently failed fold. NOT a stage
 *                                        that staged nothing.
 *   `proposals: complete (staged not recorded…)`  the stage RAN and no staging port was bound, so the
 *                                        counts were omitted by the handler on purpose.
 *   `proposals: complete (staged 0, skipped 0…)`  a MEASURED zero — the port answered and staged
 *                                        nothing. This is the only arm that may print a zero.
 *   `proposals: failed`                  the stage ran and did not finish, which is why the chain
 *                                        outcome one clause up says `failed`.
 */
function renderProposalStageSegment(
  proposals: RunNotificationView['stages']['proposals'],
  gate1: ProposalGate1Disclosure | undefined,
): string {
  if (proposals === undefined) return 'proposals: not recorded'
  const counts =
    proposals.proposed === undefined && proposals.skipped === undefined
      ? ['staged not recorded']
      : [
          ...(proposals.proposed === undefined ? [] : [`staged ${proposals.proposed}`]),
          ...(proposals.skipped === undefined ? [] : [`skipped ${proposals.skipped}`]),
        ]
  const parts = [...counts, ...(gate1 === undefined ? [] : [renderGate1Clause(gate1)])]
  return `proposals: ${proposals.status} (${parts.join(', ')})`
}

/**
 * What the persisted `proposals-authored` Gate-1 leg says — WORDS AND LENGTHS ONLY.
 *
 * The four candidate-state members of `ProposeGate1Report` are deliberately not summable (422
 * D-14), so they are reported separately and the two that are routinely zero are omitted rather
 * than printed as noise. `ungatedRemaining` is printed unconditionally BECAUSE zero is meaningful
 * there: it is the difference between "the cap left work behind" and "the cap admitted everything
 * eligible", and an operator deciding whether to run the replay-gate verb needs to see the zero.
 *
 * `reason` is never rendered: it carries a corpus-posture refusal or a store error verbatim from
 * layers with no masking boundary of their own (D-11, T-422-17-01). The DISPOSITION word already
 * says which of the six situations produced the counts, and it is a closed vocabulary.
 */
function renderGate1Clause(gate1: ProposalGate1Disclosure): string {
  if (gate1.kind === 'not-recorded') return 'Gate-1 not recorded'
  if (gate1.kind === 'unreadable') return 'Gate-1 unreadable'
  if (gate1.kind === 'unbound') return 'Gate-1 not bound'
  const { report } = gate1
  const screened = report.screenedGate1.length + report.recoveredGate1Receipts.length
  return `Gate-1 ${report.disposition}: ungated remaining ${report.ungatedRemaining.length}`
    + (screened === 0 ? '' : `, screened ${screened}`)
    + (report.interruptedGate1.length === 0
      ? ''
      : `, interrupted ${report.interruptedGate1.length}`)
}

/**
 * What ACTUALLY backs this run's circularity claim (422 D-19; WINDOWS #427).
 *
 * Both production hosts now bind the reader that applies prepareMisdirectionEvidence's
 * recorded posture to analysis. A harness host can still compose without that binding,
 * so appliedAtHost remains explicit and its false arm retains the fail-closed disclosure.
 *
 * This function renders the applied backing and names the recorded posture when the two
 * disagree. Declared-only belongs only to an absent-root posture the analysis actually received.
 */
function renderCircularityGuardSegment(circularity: CircularityGuardDisclosure): string {
  if (circularity.kind === 'not-recorded') return 'circularity guard: not recorded'
  if (circularity.kind === 'unreadable') return 'circularity guard: posture-unavailable'
  const { posture, appliedAtHost } = circularity
  if (!appliedAtHost && posture !== 'eval-root') {
    return `circularity guard: eval-root (fail-closed; recorded ${posture} unread — `
      + 'no host binds the posture)'
  }
  return `circularity guard: ${
    posture === 'no-eval-root'
      ? 'declared-only'
      : posture === 'broken-eval-root'
        ? 'posture-unavailable'
        : 'eval-root'
  }`
}

/**
 * The exact fetch command the extended exit line carries (391 D-17).
 *
 * The REAL `agent-qa digest` invocation, byte-for-byte — a positional runId is the shape
 * `commands/digest.ts` parses, and the id rides `JSON.stringify` so one needing quoting cannot
 * silently produce a command that fails on paste. It points at the VERB rather than at
 * `agent-qa fn runs.digest`, because the verb is what a person was given to type; the two reach
 * the same op, and offering the lower-level one here would be an invitation to learn the
 * function layer in order to read a run.
 *
 * It replaced the 389 `analysis.get` pointer rather than joining it. The digest CONTAINS the
 * clustered sentences that pointer fetched, so keeping both would have offered a strictly
 * narrower second command for the same content — two stories about one run, which is the
 * thing D-17's either/or exists to prevent.
 */
export function digestFetchCommand(runId: string): string {
  return `agent-qa digest ${JSON.stringify(runId)}`
}

/**
 * The exit line's D-17 suffix: what this run's marks changed, and the one command that shows it.
 *
 * 2026-09-30, 432-09 (D-04/D-25): nothing waits on a human, so the suffix no longer counts pending
 * proposals. It names the fixes this run's marks applied when the digest read its ledger and there
 * were any. The count is dropped when the digest could not be read or the ledger was not read, and
 * the pointer is not: printing the command regardless is honest, because it is exactly what a person
 * should run to find out. The failure itself was already warned about one line up.
 */
export function renderDigestPointer(runId: string, digest: RunDigest | undefined): string {
  const changes = digest?.markChanges?.length ?? 0
  const applied = changes === 0
    ? ''
    : `marks: ${changes} change${changes === 1 ? '' : 's'} applied${SUMMARY_SEPARATOR}`
  return `${SUMMARY_SEPARATOR}${applied}digest: ${digestFetchCommand(runId)}`
}

/**
 * A failed digest read costs the DIGEST and nothing else.
 *
 * Same posture as `summaryFailureWarning`: warned so the block's absence is attributable,
 * never thrown (the exit code froze long ago — JOBQ-06), and the warning carries the same
 * fetch command the extended exit line would have, so the reader's next step is identical
 * whichever way the digest failed to print.
 */
function digestReadFailureWarning(runId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The digest for ${runId} could not be read for printing (${detail}); it remains `
    + `readable via ${digestFetchCommand(runId)}.`
}

/**
 * A status read that fails costs the CLOSE-OUT LINE and nothing else.
 *
 * Warned rather than swallowed, because a line that silently disappears is how a user learns
 * to distrust the ones that do print; and warned rather than thrown, because the exit code was
 * frozen long before this file ran (JOBQ-06).
 */
function summaryFailureWarning(runId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Post-run status for ${runId} could not be read (${detail}); the queued work is `
    + 'unaffected and is readable later through the runs post-processing status.'
}

function drainFailureWarning(
  runId: string,
  error: unknown,
  executionContext: ExecutionContext | undefined,
): string {
  const detail = error instanceof Error ? error.message : String(error)
  const resumeClause = ciResumeClause(executionContext, 'any-host')
  if (resumeClause !== undefined) {
    return `Post-run processing stopped early for ${runId} (${detail}); queued work ${resumeClause}.`
  }
  return `Post-run processing stopped early for ${runId} (${detail}); queued work will resume `
    + 'on the next run or when the daemon drains it.'
}
