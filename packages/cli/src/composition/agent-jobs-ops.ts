// The agent job queue's operator ops: a kind-filtered drain, a listing, and a cancel.
//
// Phase 413 D-04 ("analyze-run drained before seeding") and D-06 ("curator jobs enqueued but NOT
// drained; analyze-run still drains") both assume a mechanism RESEARCH F15 measured absent: every
// shipped host pumps the GLOBAL FIFO, so draining `analyze-run` for a run also claims the
// `curate-memory` successor its completion enqueues, and the inline tail then folds candidates
// into the git-tracked knowledge root. Nothing in the CLI could drain one kind and stop.
//
// RESEARCH OQ-4 named two ways to close that gap and called (b) the one faithful to both
// decisions. This file IS option (b), implemented outright rather than assumed away: the queue is
// re-composed here with `unclaimableKinds` (the 388-09 CONSTRUCTION option) set to every declared
// kind except `--only`, UNIONED with the kinds the composed host itself may not claim, so an
// excluded row is never claimed — its status, its claim and its attempt count are untouched,
// because the exclusion lives in the store's SELECTION rather than in a filter this loop applies
// after the fact. No new agent-local surface, no new job kind.
//
// The union is a CORRECTION, not decoration. This file asserted the exclusion twice over from the
// day it was written and only ever composed it once: the host's posture-derived set sat on
// `host.jobs().queue`, which this pump does not drain, and `ComposedAgentJobs` published a `Pick`
// that dropped the very field a re-composer needs to honour it. A safety claim that overstates its
// guarantee is the same defect class as the hole it describes, so both are fixed here.
//
// Why outright rather than assumed: seeding is a write-once, costly-reversibility door, and healed
// runs are exactly the class only `analyze-run` classifies (F13). A campaign that seeded before its
// verdicts existed would commit a corpus nobody can un-commit.
//
// The lease bracket is `knowledge-maintain.ts`'s `withWriterLease` and the pump loop is
// `post-run-tail.ts`'s, both deliberately: two drainers under one fence is the tampering threat
// (T-413-46), and "never sleep on a backoff" is the tail's own rule (T-413-48).

import { dirname, join, resolve } from 'node:path'

import { QuarantinedJobRequeueError, createAgentJobQueue } from '@vostride/agent-qa-agent'
import type {
  AgentJobQueue,
  ClockPort,
  JobStoreFence,
  RunNextJobOutcome,
} from '@vostride/agent-qa-agent'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import type { LocalAgentJobs } from '@vostride/agent-qa-agent-local'
import { asJobId } from '@vostride/agent-qa-schema'
import type { JobKind, JobStatus } from '@vostride/agent-qa-schema'

import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { resolvePostRunJobModel } from '../curation/post-run-tail.js'
import { composeCliLocalAgent } from './local-agent-host.js'

/**
 * How many jobs one pump will run before it stops.
 *
 * Equal to `JOB_RECOVERY_MAX_RESUMED_JOBS` and chosen for the same reason: it is more iterations
 * than any campaign leg can legitimately queue for one kind, so reaching it is a bug — a chain
 * feeding itself, or a queue this process is not the only writer of — and not a long drain. A loop
 * that trusted the queue to empty would be an unbounded claim under a lease (T-413-48).
 */
export const AGENT_JOBS_PUMP_BOUND = 64

/**
 * The heartbeat cadence the pump refreshes its lease on.
 *
 * Declared locally, exactly as `knowledge-maintain.ts` declares it: the constant lives in
 * `knowledge-local`, which a firewalled surface may not name (FUNC-02), and the value a CLI
 * command heartbeats at is the CLI's own decision anyway.
 */
const WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 5_000

/** The store-owned facts about one row that an operator may read. Never a payload body. */
export interface AgentJobRow {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly attempts: number
  readonly claimed: boolean
  readonly cancelRequested: boolean
  /**
   * What the store can say this row concluded, when it can say anything (422 D-16).
   *
   * Carried verbatim from the store's diagnostic projection rather than re-derived here. Today it
   * is `unreadable_kind` and nothing else: the row's `kind` above is then a kind this build does
   * not read, and printing that kind WITHOUT this field beside it is the failure mode — an
   * operator sees an unfamiliar kind sitting at `failed` with a spent attempt and no way to tell
   * a quarantine from a handler that crashed.
   */
  readonly conclusionKind?: string
  /** Present only when the payload names a run as a string — see `runIdOf`. */
  readonly runId?: string
}

/** One thing the pump durably did, reported as data rather than as a log line. */
export interface AgentJobOutcomeRow {
  readonly jobId: string
  readonly kind: JobKind
  readonly runId?: string
  readonly disposition: 'completed' | 'retry-scheduled' | 'failed' | 'cancelled' | 'interrupted'
  readonly attempt: number
}

/**
 * How the pump loop ended.
 *
 * `unexpected-kind` is unreachable by construction — the queue's own exclusion is the guard — and
 * is here so the loop RECORDS that rather than trusting it. A pump that silently ran a kind it was
 * not asked for is the elevation threat (T-413-45), and a value nobody can observe is not a guard.
 */
export type AgentJobsPumpStop = 'empty' | 'bound' | 'retry-scheduled' | 'unexpected-kind'

export type PumpAgentJobsOutcome =
  | {
      readonly kind: 'pumped'
      readonly only: JobKind
      readonly ran: number
      readonly outcomes: readonly AgentJobOutcomeRow[]
      readonly stoppedOn: AgentJobsPumpStop
      readonly excludedKinds: readonly JobKind[]
    }
  | AgentJobsRefusal

export interface AgentJobsRefusal {
  readonly kind: 'refused'
  readonly reason: string
  readonly holder?: { readonly pid: number; readonly leaseId: string; readonly epoch: number }
  readonly message?: string
}

export type CancelAgentJobOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'cancel-requested' }
  | { readonly kind: 'already-terminal'; readonly status: JobStatus }
  | AgentJobsRefusal

export type RequeueAgentJobOutcome =
  | { readonly kind: 'requeued' }
  | { readonly kind: 'not-terminal'; readonly status: JobStatus }
  | AgentJobsRefusal

/**
 * The refusal reason a quarantined row's requeue reports (422 D-16).
 *
 * A REFUSAL and not a `not-terminal` outcome, which is the difference between "somebody else owns
 * this row, try later" and "this row can never be requeued by anyone". `not-terminal` exits 0
 * because a campaign driver must not abort over a row a drainer legitimately holds; this one exits
 * 1 through the channel every other refusal already uses, because the operator asked for something
 * that will not become possible by waiting.
 */
export const UNREADABLE_KIND_REFUSAL_REASON = 'unreadable-kind'

export interface ListAgentJobsOutcome {
  readonly epoch: number
  readonly jobs: readonly AgentJobRow[]
}

/**
 * The durable half these ops operate on, plus the close that gives the database back.
 *
 * `unclaimableKinds` is on this list because a `Pick` that drops it makes the host's own exclusion
 * STRUCTURALLY unreachable to the one caller that has to re-state it. `pumpAgentJobs` builds a
 * fresh queue rather than draining `jobs.queue`, so the posture-derived set has to travel as DATA
 * or it does not travel at all — and `LocalAgentJobs` publishes the field for exactly this.
 */
export interface ComposedAgentJobs {
  readonly jobs: Pick<
    LocalAgentJobs,
    'store' | 'kinds' | 'queue' | 'model' | 'idSource' | 'unclaimableKinds'
  >
  close(): Promise<void>
}

type MaintenanceCapabilities = typeof LOCAL_CURATION_CAPABILITIES.maintenance

export interface AgentJobsOpsDeps {
  composeJobs(): Promise<ComposedAgentJobs>
  knowledgeRoot(): Promise<string>
  readonly clock: ClockPort
  readonly acquireWriterLease: MaintenanceCapabilities['acquireWriterLease']
  readonly releaseLease: MaintenanceCapabilities['releaseLease']
  readonly refreshWriterLeaseAuthority: MaintenanceCapabilities['refreshWriterLeaseAuthority']
}

/**
 * The run a claimed job's payload names, if it names one as a string.
 *
 * The `job-dispatcher.ts` idiom verbatim, and the ONLY thing read out of a payload anywhere in
 * this module (T-413-47). The payload is `unknown` by construction and every kind spells its own,
 * so an id-shaped string under `runId` is the whole contract; anything else yields `undefined` and
 * the key is omitted rather than emitted empty.
 */
function runIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { runId?: unknown }).runId
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * The `curateRun` this host declares it will never run.
 *
 * REQUIRED by `postRun`'s type (388-10) — the posture is a review of the binding it describes, so
 * there is no `postRun` without one — and UNREACHABLE by construction: `'no-masker'` makes
 * `curate-memory` unclaimable on the composed host, `pumpAgentJobs` UNIONS that set into the
 * `unclaimableKinds` of the queue it actually drains, and `--only` excludes it there a second time.
 * The union is what makes the second sentence true; before it, the posture governed a queue this
 * verb never touched. Supplied so the OTHER half of the capability bundle, `persistAnalysis`,
 * exists at all.
 *
 * It THROWS rather than answering `{curated: 0, deprecated: 0, complete: true}`, and the
 * difference is the same one WR-03 is about: a fold that never ran must never let
 * `bundle-committed` be published, because that receipt names an event that did not happen. A
 * silent no-op would be a second masked fallback in the file written to remove the first. If this
 * ever executes, both exclusions failed and the operator must be told rather than reassured.
 */
const PUMP_NEVER_CURATES = (): Promise<never> => {
  throw new Error(
    'agent-jobs pump composed a host that may not claim curate-memory (unclaimableKinds, twice '
    + "on ONE queue: the host's own 'no-masker' posture, unioned into the queue this pump "
    + 'constructs, and that queue\'s --only exclusion), yet the curation fold was reached. Both '
    + 'exclusions failed; no candidate was folded and no receipt was written.',
  )
}

export function defaultAgentJobsOpsDeps(configPath: string): AgentJobsOpsDeps {
  const configDir = dirname(resolve(configPath))
  const { acquireWriterLease, releaseLease, refreshWriterLeaseAuthority }
    = LOCAL_CURATION_CAPABILITIES.maintenance

  return {
    composeJobs: async () => {
      // Composed WITH a `postRun`, and the shape of it is the whole point.
      //
      // `postRunCapabilities()` is all-or-nothing: `if (postRun === undefined) return undefined`
      // drops the ENTIRE bundle, so a host that withholds `curateRun` also withholds
      // `persistAnalysis` — the analyze-run artifact writer riding the same object — and
      // `createRealJobKindRegistry(undefined)` then hands analyze-run its scripted STAND-IN, which
      // publishes `verdicts-authored` and reports `complete` having written nothing. Composing
      // with no `postRun` here did not merely stop this host claiming the curator; it silently
      // disarmed the kind the pump exists to drain. The 413-08 campaign measured the consequence:
      // 19/19 legs `completed`, 0/19 `analysis.json`, D-04's exclusion filter reading a
      // deterministic floor it was never meant to see, and every leg row asserting an analysis
      // that did not exist — the masked fallback 413-07 named as this phase's defect class.
      //
      // What holds `curate-memory` back is NOT the absence of a binding, and never was. It is
      // `unclaimableKinds`, twice — but twice on ONE queue, which is the part this file used to
      // get wrong. `'no-masker'` folds through `UNCLAIMABLE_BY_PROSE_POSTURE` to exactly
      // `['curate-memory']` on the composed host (the belt), and `pumpAgentJobs` UNIONS that
      // published set into the queue it constructs, where every declared kind but `--only` is
      // excluded as well (the braces). A belt that stayed on `host.jobs().queue` would be a belt
      // on a queue this command never drains, which is what it was. Both live in the store's
      // SELECTION rather than in a binding, so the row is never OFFERED — a guarantee no
      // capability object can weaken. The posture is also the honest one rather than a lever: this
      // host binds no declared mask to a fold, and a host that cannot say its fold masks may not
      // claim the kind that folds.
      const host = composeCliLocalAgent({
        agentQaRoot: join(configDir, '.agent-qa'),
        configPath,
        model: () => resolvePostRunJobModel(configPath),
        postRun: { curateRun: PUMP_NEVER_CURATES, candidateProse: 'no-masker' },
      })
      const jobs = await host.jobs()
      return { jobs, close: () => host.close() }
    },
    knowledgeRoot: async () => {
      const config = await resolveConfig({ configPath, loadAuthPlugins: false })
      return resolveConfiguredKnowledgeRoot(config, configDir)
    },
    clock: { now: () => new Date().toISOString() },
    acquireWriterLease,
    releaseLease,
    refreshWriterLeaseAuthority,
  }
}

interface HeldLease {
  readonly leaseId: string
  readonly epoch: number
}

/**
 * Acquire, heartbeat, run, release — `knowledge-maintain.ts`'s `withWriterLease` shape.
 *
 * The release is in a `finally` on every path, including the one where the composed host's own
 * close throws: a leaked lease wedges every later leg of the campaign behind a `held` refusal that
 * names a process which is no longer running.
 */
async function withWriterLease<T>(
  deps: AgentJobsOpsDeps,
  operation: (lease: HeldLease, composed: ComposedAgentJobs) => Promise<T>,
): Promise<T | AgentJobsRefusal> {
  const knowledgeRoot = await deps.knowledgeRoot()
  const acquired = deps.acquireWriterLease(knowledgeRoot)
  if (acquired.kind === 'held') {
    return {
      kind: 'refused',
      reason: 'writer-lease-held',
      holder: {
        pid: acquired.holder.pid,
        leaseId: acquired.holder.leaseId,
        epoch: acquired.holder.epoch,
      },
    }
  }
  if (acquired.kind === 'refused') {
    return { kind: 'refused', reason: acquired.reason, message: acquired.error.message }
  }

  const authority = { knowledgeRoot, leaseId: acquired.leaseId, epoch: acquired.epoch }
  let heartbeatError: unknown
  const heartbeatTimer = setInterval(() => {
    if (heartbeatError !== undefined) return
    try {
      deps.refreshWriterLeaseAuthority(authority)
    } catch (error) {
      heartbeatError = error
    }
  }, WRITER_LEASE_HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()

  const composed = await deps.composeJobs()
  try {
    const value = await operation({ leaseId: acquired.leaseId, epoch: acquired.epoch }, composed)
    if (heartbeatError !== undefined) throw heartbeatError
    return value
  } finally {
    clearInterval(heartbeatTimer)
    try {
      await composed.close()
    } finally {
      deps.releaseLease({ knowledgeRoot, leaseId: acquired.leaseId })
    }
  }
}

function outcomeRow(outcome: Extract<RunNextJobOutcome, { ran: true }>): AgentJobOutcomeRow {
  const runId = runIdOf(outcome.payload)
  return {
    jobId: String(outcome.job.id),
    kind: outcome.job.kind,
    ...(runId === undefined ? {} : { runId }),
    disposition: outcome.disposition,
    attempt: outcome.job.attempts,
  }
}

/**
 * Drain `only`, and nothing else, under the writer lease.
 *
 * The exclusion is APPLIED once, in the `createAgentJobQueue` call below, over a set assembled
 * from two sources. That is the whole mechanism: `unclaimableKinds` is frozen into the queue at
 * construction and becomes the store's `claimNext(fence, { excludeKinds })` option, so an excluded
 * row is never OFFERED. There is no "claimed then put back" window for a curator job to slip
 * through, which is what makes D-06's "enqueued but NOT drained" a property of the selection
 * rather than of this loop's discipline.
 *
 * `--only` therefore cannot WIDEN what this host may claim. Naming a kind the host's own posture
 * excludes yields a pump that claims nothing and says so — `ran: 0`, `stoppedOn: 'empty'`, and the
 * named kind present in the `excludedKinds` the outcome reports, so the operator reads a refusal
 * rather than an empty queue.
 */
export async function pumpAgentJobs(
  { only }: { only: JobKind },
  deps: AgentJobsOpsDeps,
): Promise<PumpAgentJobsOutcome> {
  return withWriterLease(deps, async (lease, { jobs }): Promise<PumpAgentJobsOutcome> => {
    // The braces: every declared kind but the one named. The belt: the kinds the composed host
    // itself may not claim, derived from its prose posture and published on `LocalAgentJobs` so a
    // re-composer can carry it. UNION, never replace — a host that may not claim a kind may not
    // claim it because an operator named it in `--only` either, and this pump drains a queue it
    // built rather than the host's, so a belt left behind protects nothing.
    const excludedKinds: readonly JobKind[] = [
      ...new Set([
        ...jobs.kinds.list().map((declaration) => declaration.kind).filter((kind) => kind !== only),
        ...jobs.unclaimableKinds,
      ]),
    ]

    // THE ONE PLACE THE D-06 KIND FILTER IS APPLIED (braces and belt, on one queue).
    const onlyQueue: AgentJobQueue = createAgentJobQueue({
      store: jobs.store,
      registry: jobs.kinds,
      clock: deps.clock,
      idSource: jobs.idSource,
      model: jobs.model,
      unclaimableKinds: excludedKinds,
    })

    // The daemon's sequence verbatim (post-run-tail.ts, Pitfall 7): adopt the epoch the lease just
    // minted, THEN return rows a dead holder left claimed. Safe here for the same reason it is safe
    // there — exactly one fence-holder exists at a time, and this process is it.
    const fence: JobStoreFence = await jobs.store.adoptEpoch(lease.epoch)
    await onlyQueue.recoverAbandonedClaims({ fence })

    const outcomes: AgentJobOutcomeRow[] = []
    let stoppedOn: AgentJobsPumpStop = 'bound'
    for (let pumped = 0; pumped < AGENT_JOBS_PUMP_BOUND; pumped += 1) {
      const outcome = await onlyQueue.runNextJob({ fence })
      if (!outcome.ran) {
        stoppedOn = 'empty'
        break
      }
      outcomes.push(outcomeRow(outcome))
      if (outcome.job.kind !== only) {
        // Unreachable by construction. Recorded rather than trusted: if it ever fires, the
        // exclusion is not doing what this file claims and the operator must be told before the
        // pump goes on claiming.
        stoppedOn = 'unexpected-kind'
        break
      }
      if (outcome.disposition === 'retry-scheduled') {
        // Never sleep on a backoff. The row stays queued and whoever holds the lease next — the
        // daemon, or the next campaign leg — picks it up.
        stoppedOn = 'retry-scheduled'
        break
      }
    }

    return { kind: 'pumped', only, ran: outcomes.length, outcomes, stoppedOn, excludedKinds }
  })
}

/**
 * Every row the agent job store holds, in a deterministic order, with no payload body.
 *
 * Read-only, so no lease is taken: a listing that had to wait behind a running daemon would be
 * useless in exactly the situation an operator reaches for it.
 */
export async function listAgentJobs(deps: AgentJobsOpsDeps): Promise<ListAgentJobsOutcome> {
  const composed = await deps.composeJobs()
  try {
    const dump = await composed.jobs.store.dumpState()
    const jobs: AgentJobRow[] = dump.jobs.map((row) => {
      const runId = runIdOf(row.payload)
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        claimed: row.claimed,
        cancelRequested: row.cancelRequested,
        // Omitted when the store omitted it, so the DTO says "nothing concluded" the same way the
        // projection does rather than inventing an empty string for every ordinary row.
        ...(row.conclusionKind === undefined ? {} : { conclusionKind: row.conclusionKind }),
        ...(runId === undefined ? {} : { runId }),
      }
    })
    jobs.sort((a, b) =>
      a.status !== b.status
        ? a.status.localeCompare(b.status)
        : a.kind !== b.kind
          ? a.kind.localeCompare(b.kind)
          : a.id.localeCompare(b.id),
    )
    return { epoch: dump.epoch, jobs }
  } finally {
    await composed.close()
  }
}

/**
 * Ask the engine to cancel one job, under the same lease bracket the pump uses.
 *
 * Under the lease because a cancel is a WRITE against rows a drainer may be claiming, and the three
 * outcomes it can have depend on the row's state at the instant of that write. This is the D-06
 * disposal step's discard arm, and it operates on the agent job queue — the run queue's
 * `agent-qa queue cancel` addresses a different store entirely (https://vostride.com/docs/agent-qa/daemon).
 */
export async function cancelAgentJob(
  jobId: string,
  deps: AgentJobsOpsDeps,
): Promise<CancelAgentJobOutcome> {
  return withWriterLease(deps, async (lease, { jobs }): Promise<CancelAgentJobOutcome> => {
    const fence = await jobs.store.adoptEpoch(lease.epoch)
    const outcome = await jobs.queue.cancel({ jobId: asJobId(jobId), fence })
    if (outcome.outcome === 'already-terminal') {
      return { kind: 'already-terminal', status: outcome.status }
    }
    return { kind: outcome.outcome }
  })
}

/**
 * Return one FINISHED agent job to the queue, forgetting what its last attempt recorded.
 *
 * Why this verb exists at all. The 413-08 campaign pumped 19 `analyze-run` rows to `done` against a
 * host composed with no `postRun`, so the kind registry handed every one of them its scripted
 * STAND-IN: each row recorded a `verdicts-authored` checkpoint carrying no verdicts and reported
 * `completed` having written no `analysis.json`. The pump is fixed forward, but the rows are not
 * re-runnable by enqueueing again — the store dedups on `(kind, idempotencyKey)`, so a second
 * enqueue for the same run is refused, and a fresh key would break the chain identity
 * `chainJobIdsForRun` derives from the run id. The row itself has to go back.
 *
 * Why the checkpoint forget is not a detail. A resumed job reads its LATEST recorded checkpoint
 * across attempts (`ORDER BY attempt DESC LIMIT 1`), so a reset that moved only the status would
 * hand the real handler the stand-in's empty authorship as though a handler had produced it: it
 * would author nothing and report `completed` a second time. `requeueTerminal` makes the lifecycle
 * reset and the checkpoint forget one fenced transaction for exactly that reason.
 *
 * Under the writer lease, and in the same bracket the pump uses, because this is a WRITE against
 * rows a drainer may be claiming (T-413-46). And it deliberately does NOT pump: the operator runs
 * `agent-jobs pump --only <kind>` next, so the forget and the re-run stay two visible steps that a
 * driver records separately rather than one verb whose failure mode is ambiguous.
 */
export async function requeueAgentJob(
  jobId: string,
  deps: AgentJobsOpsDeps,
): Promise<RequeueAgentJobOutcome> {
  return withWriterLease(deps, async (lease, { jobs }): Promise<RequeueAgentJobOutcome> => {
    const fence = await jobs.store.adoptEpoch(lease.epoch)
    let outcome
    try {
      outcome = await jobs.store.requeueTerminal(asJobId(jobId), fence)
    } catch (error) {
      // 422 D-16. Caught by CLASS rather than by message, and translated into the refusal shape
      // this command already renders and exits 1 on — a second error channel for one more refusal
      // would give the operator two vocabularies for the same kind of "no". The store refused
      // before it wrote anything, so there is nothing to undo here. Every other error keeps
      // travelling: a store that failed for some unrelated reason must not be reported as a
      // quarantine.
      if (!(error instanceof QuarantinedJobRequeueError)) throw error
      return {
        kind: 'refused',
        reason: UNREADABLE_KIND_REFUSAL_REASON,
        message: error.message,
      }
    }
    if (outcome.outcome === 'not-terminal') {
      return { kind: 'not-terminal', status: outcome.status }
    }
    return { kind: 'requeued' }
  })
}
