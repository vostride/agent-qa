// The agent job queue engine (Phase 385, D-05 / D-08 / D-17 / D-18 / D-20).
//
// Pure semantics. This package is storageNeutral, so nothing here touches a host API: every
// byte the engine causes to exist crosses `JobStorePort`. The driver is a PUMPABLE function
// — `runNextJob` does one job and returns — never a loop with timers. Phase 385 ships no
// production dispatcher at all; the first real host arrives with the daemon, and a driver
// that owned its own scheduling would have to be taken apart again to let that host own it.
//
// All engine-visible time comes from the injected clock. A single ambient timestamp here
// would make the deterministic dump the crash matrix compares differ for reasons that have
// nothing to do with correctness (D-03), and the usual repair for a flaky equality
// assertion is to loosen it — which would quietly retire the proof.

import type {
  ChainedJobRequest,
  Job,
  JobHandlerOutcome,
  JobId,
  JobKind,
} from '@vostride/agent-qa-schema'
import { canonicalJson } from '@vostride/agent-qa-schema'

import type { ClockPort } from '../ports/clock.js'
import type {
  ChainTerminalRecord,
  ClaimNextOptions,
  JobCancelOutcome,
  JobCheckpointRecord,
  JobEnqueueOutcome,
  JobInsert,
  JobStoreFence,
  JobStorePort,
} from '../ports/job-store.js'
import {
  buildChainTerminalNotification,
  chainJobIdsForRun,
  POST_RUN_CHAIN_TERMINAL_KINDS,
} from './chain-identity.js'
import type {
  JobBackoffPolicy,
  JobKindDeclaration,
  JobKindRegistry,
} from './kind-registry.js'
import { recordLlmAuthorship } from './record-llm-authorship.js'
import type {
  JobAuthorCallback,
  JobCheckpointContext,
  JobModelCapability,
} from './record-llm-authorship.js'

/**
 * Where job ids come from.
 *
 * Injected rather than generated, and derived from `(kind, idempotencyKey)` rather than
 * random, so the same logical job carries the same id in every process and across a replay.
 * A random id would make two dumps of the same history unequal by construction.
 */
export interface JobIdSource {
  jobIdFor(kind: JobKind, idempotencyKey: string): JobId
}

/**
 * Thrown when an enqueue arrives without a usable idempotency key (D-08).
 *
 * The type already requires the argument; this covers the empty string, which types cannot
 * exclude and which would silently collapse every keyless caller onto one queue slot.
 */
export class MissingIdempotencyKeyError extends Error {
  override readonly name = 'MissingIdempotencyKeyError'

  constructor(readonly jobKind: JobKind) {
    super(
      `An agent job of kind ${jobKind} was enqueued without an idempotency key. Every ` +
        'enqueue needs one: dedupe is a store guarantee resting on the (kind, key) unique ' +
        'index, and an empty key would collapse unrelated jobs onto a single slot.',
    )
  }
}

/** Thrown when a handler asks to chain to a successor its kind never declared (D-17). */
export class UndeclaredJobSuccessorError extends Error {
  override readonly name = 'UndeclaredJobSuccessorError'

  constructor(
    readonly jobKind: JobKind,
    readonly successorKind: JobKind,
  ) {
    super(
      `Agent job kind ${jobKind} may not chain to ${successorKind}: the successor is not ` +
        'in its declared topology. The declared set is the auditable one, so a chain that ' +
        'only exists inside a handler body must not be reachable.',
    )
  }
}

/** Thrown when a handler publishes a checkpoint its kind never declared. */
export class UndeclaredJobCheckpointError extends Error {
  override readonly name = 'UndeclaredJobCheckpointError'

  constructor(
    readonly jobKind: JobKind,
    readonly checkpointId: string,
  ) {
    super(
      `Agent job kind ${jobKind} may not publish checkpoint ${checkpointId}: it is not on ` +
        "the kind's declared checkpoint schedule. Recovery is planned from the declared " +
        'schedule, so a checkpoint outside it is state nothing would ever resume from.',
    )
  }
}

/**
 * Raised at a checkpoint boundary when the job being run has been asked to stop (D-19).
 *
 * A thrown sentinel rather than a return value, because the boundary is inside a capability
 * the handler awaits and there is no other way to unwind a handler from underneath. A handler
 * MAY catch it — cooperative cancellation is cooperative — but catching it buys nothing: the
 * next boundary raises it again, and a kind whose handler swallowed every one of them would
 * simply run to the end, which is the same thing that happens to a kind with no boundary at
 * all. The driver catches it, records the cancellation and reports the boundary it stopped at.
 */
export class JobCancelledError extends Error {
  override readonly name = 'JobCancelledError'

  constructor(
    readonly jobId: JobId,
    readonly checkpointId: string,
  ) {
    super(
      `agent job ${String(jobId)} was asked to stop and is being cancelled at checkpoint ` +
        `${checkpointId}; work already checkpointed stays recorded and this step never ran`,
    )
  }
}

export interface CreateAgentJobQueueOptions {
  readonly store: JobStorePort
  readonly registry: JobKindRegistry
  readonly clock: ClockPort
  readonly idSource: JobIdSource
  /**
   * The model a job may author with, bound by the composition root (D-10).
   *
   * REQUIRED, and deliberately not defaultable. An optional capability would mean a queue
   * could be built with none, and the only sensible behaviour for an author callback that
   * cannot reach a model is to fail somewhere far from the composition that forgot it. Making
   * it an argument of construction puts that decision where the binding is made. The engine
   * never calls it: the only thing that happens to this value is that the authorship
   * primitive hands it to an author callback, carrying the job's signal when a host passed one.
   */
  readonly model: JobModelCapability
  /**
   * The kinds this host may never claim, fixed when its queue is composed (388-09).
   *
   * A CONSTRUCTION option, deliberately not a member of `RunNextJobInput`: whether a host
   * may claim a kind is a fact about the HOST — which capabilities its composition can bind
   * — and putting it on the per-call input would make it a decision every pump site
   * re-makes, with every pump site a place the answers could diverge. Absent means what it
   * means today: every declared kind is this host's to take.
   */
  readonly unclaimableKinds?: readonly JobKind[]
}

export interface RunNextJobInput {
  readonly fence: JobStoreFence
  // 2026-10-19 (444.1-13, D-01): reaches every model request of the claimed job; an attempt
  // that fails while it is aborted is released with its attempt refunded.
  readonly signal?: AbortSignal
}

/** Facts every ran outcome carries, whatever the job's disposition turned out to be. */
export interface RanJobOutcomeBase {
  readonly ran: true
  /** The job AS CLAIMED. The store owns what its row says afterwards. */
  readonly job: Job
  readonly checkpointsPublished: readonly string[]
  /**
   * `false` in exactly one case: the attempt bound was already spent when the job was
   * claimed, so the driver failed it without handing it to its handler (D-18).
   */
  readonly handlerInvoked: boolean
  /**
   * The payload of the job AS CLAIMED, so a host can attribute this outcome to whatever the
   * payload names — a run, above all — without going back to the store for a row the job has
   * already moved past (406 D-16). Optional because the outcome is the engine's fact and the
   * payload is the caller's: nothing here reads it, and no fabricated outcome must grow a
   * field to keep compiling.
   */
  readonly payload?: unknown
}

export type RunNextJobOutcome =
  | { readonly ran: false; readonly reason: 'no-job' }
  | (RanJobOutcomeBase & {
      readonly disposition: 'completed'
      readonly chained: readonly JobEnqueueOutcome[]
    })
  | (RanJobOutcomeBase & {
      readonly disposition: 'retry-scheduled'
      readonly reason: string
      /**
       * How long a host should wait before pumping this job again, computed from the kind's
       * declared backoff policy and the attempt just spent.
       *
       * Returned rather than applied: 385 ships no dispatcher, and a driver that slept on its
       * own would be the timer loop this engine deliberately is not. The same value goes to the
       * store as the disposition's `retryAfterMs`, which stores the row's not-before time from
       * its own clock and keeps the row out of every claim until then (444.1 D-23).
       */
      readonly retryDelayMs: number
      readonly attemptsRemaining: number
    })
  | (RanJobOutcomeBase & {
      readonly disposition: 'cancelled'
      /**
       * The checkpoint the driver refused to publish, i.e. WHERE the request was honoured.
       *
       * Named rather than implied, because "cancelled" alone cannot say how much of the job
       * had already happened, and `checkpointsPublished` beside it says exactly that: the
       * steps in that list are done and durable, this one never started.
       */
      readonly honoredAtCheckpoint: string
    })
  | (RanJobOutcomeBase & {
      readonly disposition: 'failed'
      readonly reason: string
      /** What the kind's declared disposition enqueued — empty for a halt-chain kind. */
      readonly continuation: readonly JobEnqueueOutcome[]
    })
  | (RanJobOutcomeBase & {
      readonly disposition: 'interrupted'
      // `handler-threw: …` or the aborted attempt's retryable reason.
      readonly reason: string
    })

export interface CancelJobInput {
  readonly jobId: JobId
  readonly fence: JobStoreFence
}

export interface RecoverAbandonedClaimsInput {
  readonly fence: JobStoreFence
}

export interface RecoverAbandonedClaimsOutcome {
  readonly released: readonly JobId[]
}

export interface AgentJobQueue {
  /**
   * Enqueue one job. The key is MANDATORY and there is no keyless overload — dedupe has to
   * be impossible to opt out of, or "running the tail twice produces one job" degrades from
   * a guarantee into a habit.
   */
  enqueue(kind: JobKind, payload: unknown, idempotencyKey: string): Promise<JobEnqueueOutcome>

  /** Claim, run, checkpoint and dispose of exactly one job. Returns when that job is done. */
  runNextJob(input: RunNextJobInput): Promise<RunNextJobOutcome>

  /**
   * Ask for one job to stop (D-19).
   *
   * Built with the driver rather than after it. The place a cooperative cancel is honoured is
   * the seam between declared checkpoints, and that seam only exists inside `runNextJob` —
   * adding the check later would mean reopening engine core with handlers already written
   * against it. 385 exposes this on no surface at all; the phases that own job UX do that.
   */
  cancel(input: CancelJobInput): Promise<JobCancelOutcome>

  /**
   * Return every outstanding claim to the queue, keeping the attempt each one spent.
   *
   * A host that dies while holding a job leaves its row claimed and nothing reaps it, so
   * without this the bound above is unreachable for exactly the job it exists to stop: a
   * poison job would sit claimed forever instead of exhausting its attempts and failing. The
   * attempt is deliberately NOT refunded — that is what makes the bound survive a crash.
   *
   * Call it after adopting authority and BEFORE pumping. Only one process may drain under a
   * given fence, so at that moment every outstanding claim belongs to a host that is gone;
   * calling it beside a live pump would take a job away from the handler still running it.
   */
  recoverAbandonedClaims(
    input: RecoverAbandonedClaimsInput,
  ): Promise<RecoverAbandonedClaimsOutcome>
}

/**
 * The delay a host should wait after spending `attempt`, per the kind's declared policy.
 *
 * A pure function of the policy and the attempt number — no clock is read here and none can
 * be, which is what keeps a kind's retry behaviour describable without running it.
 */
function retryDelayMs(policy: JobBackoffPolicy, attempt: number): number {
  if (policy.kind === 'none') return 0
  if (policy.kind === 'fixed') return policy.delayMs
  const grown = policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1)
  return Math.min(grown, policy.maxDelayMs)
}

/** The summary a job carries when its caller supplied none. Deterministic on purpose. */
function defaultSummary(kind: JobKind, idempotencyKey: string): string {
  return `agent job ${kind} (${idempotencyKey})`
}

export function createAgentJobQueue(options: CreateAgentJobQueueOptions): AgentJobQueue {
  const { store, registry, clock, idSource, model, unclaimableKinds } = options
  // Resolved once at construction, so every pump passes the same exclusion or none at all;
  // a queue built without the option calls `claimNext(fence)` exactly as it did before.
  // Copied and frozen at construction, never captured by reference (WR-11): the caller keeps a
  // handle on the array it passed, and a queue that claimed against that live array would let
  // a post-construction write to it re-arm the exclusion this guard exists to hold.
  const claimOptions: ClaimNextOptions | undefined =
    unclaimableKinds === undefined
      ? undefined
      : Object.freeze({ excludeKinds: Object.freeze([...unclaimableKinds]) })

  function requestFor(kind: JobKind, payload: unknown, idempotencyKey: string): JobInsert {
    // An undeclared kind is refused before anything is written: the store would happily
    // hold a row no handler can ever pick up, and that row is indistinguishable from a
    // stuck job forever after.
    registry.require(kind)
    if (idempotencyKey.trim() === '') {
      throw new MissingIdempotencyKeyError(kind)
    }
    return {
      id: idSource.jobIdFor(kind, idempotencyKey),
      kind,
      idempotencyKey,
      summary: defaultSummary(kind, idempotencyKey),
      payload,
    }
  }

  function successorRequests(
    declaration: JobKindDeclaration,
    next: readonly ChainedJobRequest[],
  ): JobInsert[] {
    return next.map((successor) => {
      if (!declaration.allowedSuccessors.includes(successor.kind)) {
        throw new UndeclaredJobSuccessorError(declaration.kind, successor.kind)
      }
      return requestFor(successor.kind, successor.payload, successor.idempotencyKey)
    })
  }

  /**
   * The notification a finishing job should carry INTO its terminal transaction, if it is one
   * (388 D-09 / D-10 / D-12).
   *
   * Three conditions, and each excludes a different wrong record. The kind must be one whose
   * finish can end a post-run chain — an unrelated kind has no run and no stages to report.
   * The payload must name a run — a chain-member job enqueued by a harness with a scripted
   * payload is not a run's chain, and inventing a dedupe key for it would collide with a real
   * one. And the job must be chaining NOTHING: enqueuing a successor in this very transaction
   * is the definition of a chain that has not finished, which is also why this is decided from
   * the inserts rather than from the kind's declared topology.
   *
   * What is NOT decided here is whether the chain's other members are terminal. That is a
   * question about rows at the instant of the write, and only the store can ask it inside the
   * transaction that answers it (385 D-05).
   */
  function chainTerminalFor(input: {
    readonly job: Job
    readonly payload: unknown
    readonly next: readonly JobInsert[]
    readonly finished: 'done' | 'failed'
    readonly publishedValues: ReadonlyMap<string, unknown>
  }): ChainTerminalRecord | undefined {
    if (!POST_RUN_CHAIN_TERMINAL_KINDS.includes(input.job.kind)) return undefined
    if (input.next.length > 0) return undefined
    const record =
      input.payload !== null && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : {}
    const runId = record.runId
    if (typeof runId !== 'string' || runId === '') return undefined

    const ids = chainJobIdsForRun(runId, idSource)
    return {
      dedupeKey: runId,
      candidateJobIds: [ids.analyzeRun, ids.curateMemory],
      payloadJson: canonicalJson(
        buildChainTerminalNotification({
          runId,
          finishingKind: input.job.kind,
          finished: input.finished,
          payload: input.payload,
          publishedValues: input.publishedValues,
        }),
      ),
    }
  }

  /**
   * Land one job permanently, running whatever continuation its kind declared (D-20).
   *
   * Validation and deterministic request construction happen before durability. The store then
   * receives the terminal parent and the complete continuation set in one fenced call, so there
   * is no ordering choice here and no crash window for the engine to repair on replay.
   */
  async function failPermanently(input: {
    readonly job: Job
    readonly payload: unknown
    readonly declaration: JobKindDeclaration
    readonly reason: string
    readonly handlerInvoked: boolean
    readonly published: readonly string[]
    readonly publishedValues: ReadonlyMap<string, unknown>
    readonly fence: JobStoreFence
  }): Promise<RunNextJobOutcome> {
    const { job, declaration, reason, fence } = input
    const requests =
      declaration.onPermanentFailure === 'halt-chain'
        ? []
        : declaration.onPermanentFailure({ job, payload: input.payload, reason })

    // Validated before a single store call: an undeclared continuation is a wrong
    // declaration, and half of one already enqueued is worse than none.
    const inserts = successorRequests(declaration, requests)

    // D-12: a permanent failure is a chain terminal too. Wiring notify into the completion
    // path alone would leave the runs a user most needs to hear about silent — a curation that
    // exhausted its attempts lands HERE and nowhere else.
    const failed = await store.failAndChain(
      job.id,
      { kind: 'permanent', reason },
      inserts,
      fence,
      chainTerminalFor({
        job,
        payload: input.payload,
        next: inserts,
        finished: 'failed',
        publishedValues: input.publishedValues,
      }),
    )

    return {
      ran: true,
      disposition: 'failed',
      job: failed.job,
      payload: input.payload,
      checkpointsPublished: input.published,
      handlerInvoked: input.handlerInvoked,
      reason,
      continuation: failed.chained,
    }
  }

  return {
    async enqueue(kind, payload, idempotencyKey) {
      return store.enqueue(requestFor(kind, payload, idempotencyKey))
    },

    async cancel({ jobId, fence }) {
      // Pure delegation on purpose: which of the three things a cancel means depends on the
      // row's state at the instant of the write, and only the store can read and write that
      // in one transaction. An engine that decided here would be deciding from a read it had
      // already let go of.
      return store.requestCancel(jobId, fence)
    },

    async recoverAbandonedClaims({ fence }) {
      const dump = await store.dumpState()
      const released: JobId[] = []
      for (const row of dump.jobs) {
        if (!row.claimed) continue
        const jobId = row.id as JobId
        await store.recordFailure(
          jobId,
          { kind: 'retry', reason: 'the claim was abandoned by a host that did not finish it' },
          fence,
        )
        released.push(jobId)
      }
      return { released }
    },

    async runNextJob({ fence, signal }) {
      const claim =
        claimOptions === undefined
          ? await store.claimNext(fence)
          : await store.claimNext(fence, claimOptions)
      if (!claim.claimed) {
        return { ran: false, reason: 'no-job' }
      }

      const job = claim.job
      const declaration = registry.require(job.kind)
      const published: string[] = []
      /**
       * What each checkpoint this attempt published actually said.
       *
       * Kept beside the id list rather than read back from the store, because the one consumer
       * — the chain-terminal notification's curation counts — is assembled microseconds before
       * the transaction that ends the job, and a read there would be querying rows that
       * transaction is about to change. It is per-ATTEMPT state on purpose: a resumed job that
       * did not re-publish a step carries no value for it, and reporting the previous attempt's
       * numbers as this one's is exactly the kind of quiet wrongness a checkpoint exists to
       * prevent.
       */
      const publishedValues = new Map<string, unknown>()

      // D-18's bound, enforced HERE — on the claim, which is the one point a job that kills
      // its host cannot skip. Checked only when recording a failure it would never fire for a
      // handler that never returns, and that handler is exactly the one the bound is for. The
      // attempt was already spent by the claim, so a job arriving with more attempts than its
      // kind permits has had every attempt it was owed.
      if (job.attempts > declaration.maxAttempts) {
        return failPermanently({
          job,
          payload: claim.payload,
          declaration,
          reason:
            `the attempt bound of ${declaration.maxAttempts} is spent (this claim is attempt ` +
            `${job.attempts}), so this agent job is given up on without being run again`,
          handlerInvoked: false,
          published,
          publishedValues,
          fence,
        })
      }

      // One gate for both directions. Recovery is planned from the declared schedule, so an
      // id outside it is state nothing would ever resume from — whether a handler is writing
      // it or an authorship primitive is looking for it.
      const requireDeclaredCheckpoint = (checkpointId: string): void => {
        if (!declaration.checkpointed || !declaration.checkpointSchedule.includes(checkpointId)) {
          throw new UndeclaredJobCheckpointError(job.kind, checkpointId)
        }
      }

      /**
       * THE checkpoint boundary (D-19). Both ways into a checkpoint pass through here.
       *
       * The cancellation state is re-read every time rather than read once at the claim: a
       * cancel that arrived while the job was running is precisely the case this exists for,
       * and a value cached before the handler started could never see it. Reading it at the
       * boundary is also what makes the boundary the boundary — the step in flight completes
       * and is published, and the NEXT one never begins.
       *
       * A declaration error is decided first: a handler naming a checkpoint its kind never
       * declared is wrong whether or not anyone asked the job to stop.
       */
      let honoredAtCheckpoint: string | undefined
      const enterCheckpointBoundary = async (checkpointId: string): Promise<void> => {
        requireDeclaredCheckpoint(checkpointId)
        const dump = await store.dumpState()
        const row = dump.jobs.find((candidate) => candidate.id === String(job.id))
        if (row?.cancelRequested === true) {
          // Remembered as well as thrown, and the FIRST boundary wins. A refusal at a boundary
          // IS the cancellation being honoured, so a handler that catches the sentinel and
          // carries on cannot take that back — its later boundaries refuse too, and the job
          // lands cancelled whatever it eventually reports.
          honoredAtCheckpoint ??= checkpointId
          throw new JobCancelledError(job.id, checkpointId)
        }
      }

      const landCancelled = async (boundary: string): Promise<RunNextJobOutcome> => {
        await store.recordCancellation(job.id, fence)
        return {
          ran: true,
          disposition: 'cancelled',
          job,
          payload: claim.payload,
          checkpointsPublished: published,
          handlerInvoked: true,
          honoredAtCheckpoint: boundary,
        }
      }

      const publish = async (checkpointId: string, value: unknown): Promise<void> => {
        await enterCheckpointBoundary(checkpointId)
        const record: JobCheckpointRecord = {
          checkpointId,
          jobId: job.id,
          attempt: job.attempts,
          recordedAt: clock.now(),
          value,
        }
        await store.publishCheckpoint(job.id, checkpointId, record, fence)
        published.push(checkpointId)
        publishedValues.set(checkpointId, value)
      }

      const jobModel: JobModelCapability =
        signal === undefined
          ? model
          : {
              modelId: model.modelId,
              ...(model.vision === undefined ? {} : { vision: model.vision }),
              generate: (request) => model.generate({ ...request, signal }),
            }

      const landInterrupted = async (reason: string): Promise<RunNextJobOutcome> => {
        await store.releaseInterrupted(job.id, fence)
        return {
          ran: true,
          disposition: 'interrupted',
          job,
          payload: claim.payload,
          checkpointsPublished: published,
          handlerInvoked: true,
          reason,
        }
      }

      // The context that carries the model. It is built here and handed to the authorship
      // primitive; it is NOT part of what the handler receives, which is the structural half
      // of "a job has no ambient model accessor" (D-11 layer 2).
      const checkpointContext: JobCheckpointContext = {
        jobId: job.id,
        model: jobModel,
        async readRecordedValue(checkpointId) {
          // The same boundary. An authorship that is about to consult a model is exactly where
          // a pending cancel is worth the most, so the request is honoured BEFORE the call
          // rather than after it, and the answer nobody will use is never paid for.
          await enterCheckpointBoundary(checkpointId)
          const recorded = await store.readCheckpoint(job.id, checkpointId)
          // The envelope is peeled UNCONDITIONALLY, and that is a fact about the writer rather
          // than a guess about the bytes: `publish` just above is the only thing that ever
          // writes a checkpoint payload, and it always wraps the authored value in a
          // `JobCheckpointRecord`. Testing the payload's shape first would be re-deriving from
          // the bytes something the engine already knows — and it cannot even do that
          // faithfully, because canonical JSON has no member for a `value` of `undefined`, so
          // the envelope of an authored `undefined` reads back one key short of the one that
          // was written and is indistinguishable from a payload nothing wrapped. The primitive
          // would then answer a bare value on the first pass and an envelope on the resume:
          // two functions wearing one name, which is the failure its own contract forswears.
          //
          // Exactly one level is peeled, so an authored object carrying a `value` key of its
          // own comes back whole. `recorded` remains the discriminant — `{recorded: true,
          // value: undefined}` is a checkpoint that holds `undefined`, never an absent one.
          return recorded.found
            ? { recorded: true, value: (recorded.payload as JobCheckpointRecord).value }
            : { recorded: false }
        },
        publishCheckpoint: publish,
      }

      let outcome: JobHandlerOutcome
      try {
        outcome = await declaration.handler({
          job,
          payload: claim.payload,
          publishCheckpoint: publish,
          recordLlmAuthorship: async <T>(
            checkpointId: string,
            author: JobAuthorCallback<T>,
          ): Promise<T> => recordLlmAuthorship(checkpointContext, checkpointId, author),
        })
      } catch (error) {
        // Only THIS job's sentinel is a cancellation. A handler that ran a nested job and let
        // its refusal escape would otherwise land the wrong row cancelled.
        if (error instanceof JobCancelledError && String(error.jobId) === String(job.id)) {
          return landCancelled(honoredAtCheckpoint ?? error.checkpointId)
        }
        // Declaration refusals are engine invariants, not handler failures. Turning one into
        // a retry would hide a programming error behind backoff and make an impossible
        // checkpoint look transient.
        if (error instanceof UndeclaredJobCheckpointError) throw error

        const reason = `handler-threw: ${error instanceof Error ? error.message : String(error)}`
        // Before the bound: an aborted attempt did not fail, so even the last one is not spent.
        if (signal?.aborted === true) return landInterrupted(reason)
        if (job.attempts < declaration.maxAttempts) {
          const delayMs = retryDelayMs(declaration.backoff, job.attempts)
          await store.recordFailure(job.id, { kind: 'retry', reason, retryAfterMs: delayMs }, fence)
          return {
            ran: true,
            disposition: 'retry-scheduled',
            job,
            payload: claim.payload,
            checkpointsPublished: published,
            handlerInvoked: true,
            reason,
            retryDelayMs: delayMs,
            attemptsRemaining: declaration.maxAttempts - job.attempts,
          }
        }

        return failPermanently({
          job,
          payload: claim.payload,
          declaration,
          reason,
          handlerInvoked: true,
          published,
          publishedValues,
          fence,
        })
      }

      // The handler returned normally — but if a boundary refused along the way it swallowed
      // the refusal, and a swallowed cancel is still a cancel. Reached only in that case: a
      // job whose boundaries all passed leaves this undefined, which is what keeps a cancel
      // arriving after the last checkpoint from retroactively discarding finished work.
      if (honoredAtCheckpoint !== undefined) {
        return landCancelled(honoredAtCheckpoint)
      }

      // The discriminant is READ, not merely accepted. A driver that ignored it and reached
      // for `next` would complete a job whose handler had just said it failed, and the row
      // would read `done` forever after with nothing recording that anything went wrong.
      if (outcome.status === 'complete') {
        const inserts = successorRequests(declaration, outcome.next)
        const completed = await store.completeAndChain(
          job.id,
          inserts,
          fence,
          chainTerminalFor({
            job,
            payload: claim.payload,
            next: inserts,
            finished: 'done',
            publishedValues,
          }),
        )
        return {
          ran: true,
          disposition: 'completed',
          job: completed.job,
          payload: claim.payload,
          checkpointsPublished: published,
          handlerInvoked: true,
          chained: completed.chained,
        }
      }

      if (outcome.status === 'retryable' && signal?.aborted === true) {
        return landInterrupted(outcome.reason)
      }

      // A retryable REPORT on the last permitted attempt becomes a permanent DECISION: the
      // handler says the thing that went wrong could go right next time, and only the engine
      // knows there is no next time. That asymmetry is why the report and the decision are
      // two types rather than one.
      if (outcome.status === 'retryable' && job.attempts < declaration.maxAttempts) {
        const delayMs = retryDelayMs(declaration.backoff, job.attempts)
        await store.recordFailure(
          job.id,
          { kind: 'retry', reason: outcome.reason, retryAfterMs: delayMs },
          fence,
        )
        return {
          ran: true,
          disposition: 'retry-scheduled',
          job,
          payload: claim.payload,
          checkpointsPublished: published,
          handlerInvoked: true,
          reason: outcome.reason,
          retryDelayMs: delayMs,
          attemptsRemaining: declaration.maxAttempts - job.attempts,
        }
      }

      // Either the handler said the failure is permanent — which skips every remaining
      // attempt, because retrying something that cannot succeed only spends the bound — or it
      // said retryable on the attempt that used the bound up.
      return failPermanently({
        job,
        payload: claim.payload,
        declaration,
        reason: outcome.reason,
        handlerInvoked: true,
        published,
        publishedValues,
        fence,
      })
    },
  }
}
