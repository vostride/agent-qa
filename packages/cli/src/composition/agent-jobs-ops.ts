// The store's selection excludes every kind but `--only`, plus the host's unclaimable kinds.

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

// Reaching this bound means a chain feeding itself or another writer, not a long drain.
export const AGENT_JOBS_PUMP_BOUND = 64

// Declared locally: the constant lives in `knowledge-local`, which this surface may not name.
const WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 5_000

/** The store-owned facts about one row that an operator may read. Never a payload body. */
export interface AgentJobRow {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly attempts: number
  readonly claimed: boolean
  readonly cancelRequested: boolean
  // Shown beside an unreadable `kind`, so a quarantine is not mistaken for a crashed handler.
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

// `unexpected-kind` cannot happen while the queue excludes the kind; the loop records it anyway.
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

// A refusal, not `not-terminal`: waiting never makes a quarantined row requeueable, so it exits 1.
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

// The only thing read out of a payload here: an id-shaped string under `runId`, else `undefined`.
function runIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = (payload as { runId?: unknown }).runId
  return typeof candidate === 'string' ? candidate : undefined
}

// Throws rather than answering a no-op, so a fold that never ran cannot publish `bundle-committed`.
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
      // Without `postRun`, `postRunCapabilities()` drops the bundle, `persistAnalysis` included.
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

// `unclaimableKinds` becomes `claimNext`'s `excludeKinds`, so an excluded row is never offered.
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

    // The one place the kind filter is applied: the host's kinds and `--only`'s, on one queue.
    const onlyQueue: AgentJobQueue = createAgentJobQueue({
      store: jobs.store,
      registry: jobs.kinds,
      clock: deps.clock,
      idSource: jobs.idSource,
      model: jobs.model,
      unclaimableKinds: excludedKinds,
    })

    // Adopt the lease's epoch before returning rows a dead holder left claimed.
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

// Under the lease, because a cancel writes rows a drainer may be claiming.
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

// A resumed job reads its latest checkpoint, so the reset and the forget are one fenced write.
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
      // Caught by class, not message; any other store failure must not be reported as a quarantine.
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
