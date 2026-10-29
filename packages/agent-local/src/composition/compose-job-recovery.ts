// Release dead claims before pumping: `claimNext` never re-offers a row with `claimed_at` set.

import { join } from 'node:path'

import { createAgentJobQueue, createRealJobKindRegistry } from '@vostride/agent-qa-agent'
import type {
  AgentJobQueue,
  ClockPort,
  JobIdSource,
  JobKindRegistry,
  JobModelCapability,
  JobStoreFence,
  RecoverAbandonedClaimsOutcome,
  RunNextJobOutcome,
} from '@vostride/agent-qa-agent'

import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'

/**
 * How many jobs one `resumePending` call will run before it refuses to continue.
 *
 * A bound rather than a loop that trusts the queue to empty: recovery runs against a store any
 * process may have written, and a chain that keeps enqueuing successors would otherwise turn a
 * recovery call into an unbounded drain. Exceeding it raises rather than truncating — a resume that
 * quietly stopped early would report success over work it left behind.
 */
export const JOB_RECOVERY_MAX_RESUMED_JOBS = 64

export interface ComposeJobRecoveryInput {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. Absolute. */
  readonly agentQaRoot: string
  /** Every column and dump row this host writes is stamped from here. */
  readonly clock: ClockPort
  /** Ids derived from `(kind, idempotencyKey)`, so a resumed chain addresses the same rows. */
  readonly idSource: JobIdSource
  /**
   * The capability a resumed job may author with, supplied by the host.
   *
   * Required and not defaultable, on the same reasoning as the queue's own option: an optional
   * capability means a host can compose recovery with none, and the only place to discover that is
   * inside an author callback far from the composition that forgot it.
   */
  readonly model: JobModelCapability
  /** Defaults to the six real declarations. Injected so a harness can drive its own handlers. */
  readonly jobKinds?: JobKindRegistry
}

export interface JobRecoveryHost {
  readonly store: SqliteJobStore
  readonly kinds: JobKindRegistry
  readonly queue: AgentJobQueue
  /**
   * Return every outstanding claim to the queue, keeping the attempt each one spent.
   *
   * Call this FIRST. Only one process drains under a given fence, so at the moment authority is
   * adopted every outstanding claim belongs to a host that is gone; calling it beside a live pump
   * would reclaim a job from the handler still running it.
   */
  recoverAbandonedClaims(fence: JobStoreFence): Promise<RecoverAbandonedClaimsOutcome>
  /** Pump until no row is claimable. No timers, no sleeping — not a dispatcher. */
  resumePending(fence: JobStoreFence, maxJobs?: number): Promise<readonly RunNextJobOutcome[]>
  close(): void
}

export function composeJobRecovery(input: ComposeJobRecoveryInput): JobRecoveryHost {
  const store = createSqliteJobStore({
    path: join(input.agentQaRoot, AGENT_JOB_STORE_DB_FILE),
    clock: input.clock,
    checkpoints: createJobCheckpointStore({ root: input.agentQaRoot }),
  })
  const kinds = input.jobKinds ?? createRealJobKindRegistry()
  const queue = createAgentJobQueue({
    store,
    registry: kinds,
    clock: input.clock,
    idSource: input.idSource,
    model: input.model,
  })

  return {
    store,
    kinds,
    queue,

    recoverAbandonedClaims(fence: JobStoreFence): Promise<RecoverAbandonedClaimsOutcome> {
      return queue.recoverAbandonedClaims({ fence })
    },

    async resumePending(
      fence: JobStoreFence,
      maxJobs: number = JOB_RECOVERY_MAX_RESUMED_JOBS,
    ): Promise<readonly RunNextJobOutcome[]> {
      const outcomes: RunNextJobOutcome[] = []
      for (;;) {
        if (outcomes.length >= maxJobs) {
          throw new Error(
            `agent job recovery ran ${maxJobs} jobs without emptying the agent job queue; the ` +
              'bound exists so a chain that keeps enqueuing successors cannot turn recovery into an unbounded ' +
              'drain, and stopping early without saying so would report success over work left behind',
          )
        }
        const outcome = await queue.runNextJob({ fence })
        if (!outcome.ran) return outcomes
        outcomes.push(outcome)
      }
    },

    close(): void {
      store.close()
    },
  }
}
