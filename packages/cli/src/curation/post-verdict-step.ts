// The disposition comes from a non-acquiring read; a lease is acquired only when a pump takes it.

import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import type {
  LocalAgentHost,
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
} from '@vostride/agent-qa-agent-local'
import { AnalyzeRunPayloadSchema } from '@vostride/agent-qa-schema'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { nudgeDaemon } from '../daemon/client.js'
import {
  completedRunHandoffPath,
  curationTailHandoffDigest,
  defaultCurationTailOperations,
  type CurationTailOperations,
  type CurationWriterAuthority,
} from './curation-tail.js'
import { resolvePostRunJobModel } from './post-run-tail.js'
import { dirname, join, resolve } from 'node:path'
import { ownPostVerdictContinuation, postVerdictPendingPath, PostVerdictContinuationRefused } from './post-verdict-continuation.js'
import { writeRunConfigRecord } from './run-curation-context.js'
import { ciResumeClause } from './resume-limit.js'
import type { ExecutionContext } from '@vostride/agent-qa-schema'

/**
 * The capability table, stubbable per cell.
 *
 * Named through `LOCAL_DAEMON_CAPABILITIES`'s own members rather than re-declared, so a signature
 * change on the lease API is a compile error here rather than a drifted second spelling.
 *
 * `readWriterLease` + `deriveWriterLeaseFreshness` are the DECISION half and `acquireWriterLease`
 * is the MUTATION half, and they are separate members because the step calls them at different
 * moments: the first pair at the verdict, the second only if a pump asks.
 */
export interface PostVerdictStepOperations {
  ownContinuation: typeof ownPostVerdictContinuation
  acquireWriterLease: typeof LOCAL_DAEMON_CAPABILITIES.acquireWriterLease
  releaseLease: typeof LOCAL_DAEMON_CAPABILITIES.releaseLease
  readWriterLease: typeof LOCAL_DAEMON_CAPABILITIES.readWriterLease
  // The freshness verdict names `unknown`, so an unreadable epoch never reads as no holder.
  deriveWriterLeaseFreshness: typeof LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness
  nudgeDaemon: typeof nudgeDaemon
  // The shell saves this handoff before awaiting the step, so it exists on every path here.
  loadCompletedRunHandoff: CurationTailOperations['loadCompletedRunHandoff']
  /**
   * A host composed over this run's project, opened for the ENQUEUE and closed again.
   *
   * A separate composition from the tail's, deliberately: the tail composes its own host for the
   * drain, with the run's declared mask threaded so `composeHost` can DERIVE `masker-active`
   * from what it HAS. This one folds nothing and prints nothing — it opens the queue, writes one
   * row and closes — so it needs neither, and sharing one handle across the shell's step and a
   * tail that may never run would leave an sqlite handle open on every framework-error exit.
   */
  composeHost(input: { readonly agentQaRoot: string; readonly configPath: string }): LocalAgentHost
  /** The one instant the freshness verdict is taken against. */
  now: () => number
}

/** What an ACQUISITION answered — the mutating half of the lease API. */
export type WriterLeaseOutcome = ReturnType<PostVerdictStepOperations['acquireWriterLease']>

/** What the non-mutating READ answered, before any freshness verdict is derived from it. */
export type WriterLeaseReadOutcome = ReturnType<PostVerdictStepOperations['readWriterLease']>

/**
 * The three answers a NON-ACQUIRING lease probe can give, and the domain `dispositionOf` is total
 * over.
 *
 * Deliberately not `AcquireWriterLeaseOutcome`: that union's `acquired` arm is a statement that a
 * lease file was rewritten, and this probe rewrites nothing. `free` is the honest name for what it
 * can observe — "no current-epoch holder is present" — which is a fact about the lease, not about
 * this process.
 */
export type WriterLeaseProbe =
  | { readonly kind: 'held' }
  | { readonly kind: 'free' }
  | { readonly kind: 'refused'; readonly reason: string }

export interface PostVerdictStepOptions {
  readonly runId: string
  /** `<configDir>/.agent-qa` — what `nudgeDaemon` addresses the daemon registration through. */
  readonly agentQaRoot: string
  /**
   * The run's ALREADY-RESOLVED knowledge root, from the producer that resolved it for the run
   * itself. Passed rather than re-derived: the enqueue, the drain and this consult must address
   * one root, and two derivations are free to disagree.
   */
  readonly knowledgeRoot: string
  // Required: a door that omitted it would compose a host against a project it did not resolve.
  readonly configPath: string
  // Only the literal `true`: an absent field stays absent, never an `undefined` to re-check.
  readonly detach?: true
  // The daemon door hands over its held lease, because acquiring again answers `held` to itself.
  readonly writerAuthority?: CurationWriterAuthority
  readonly log: { warn(message: string): void }
  // The run's context, so a line about unfinished work never promises a CI resume.
  readonly executionContext?: ExecutionContext
  /** Focused test seam. Production callers omit it. */
  readonly operations?: Partial<PostVerdictStepOperations>
}

/**
 * The box the acquired lease travels in, from the step to whoever pumps.
 *
 * `outcome` is diagnostic only — the shell already published the posture; this is for a host that
 * wants to know what its own step decided without re-reading the wire.
 */
export interface PostVerdictHandoff {
  readonly outcome: PostVerdictOutcome | undefined
  readonly completion?: Promise<PostVerdictOutcome>
  readonly enqueueState?: PostVerdictEnqueueState
  readonly failureDetail?: string
  readonly pendingPath?: string
  // A mutating call shaped like a getter: invoke it inside the scope whose `finally` releases.
  takeAcquiredLease(): CurationWriterAuthority | undefined
  // Never hands back a supplied authority: releasing a live daemon's lease would revoke it mid-run.
  takeUnclaimedLease(): CurationWriterAuthority | undefined
}

/** The named degrade codes this step can carry to the shell's `runWarning` channel. */
const WRITER_LEASE_REFUSED = 'writer-lease-refused'
const POST_PROCESSING_UNBOUND = 'post-processing-unbound'
const POST_RUN_ENQUEUE_FAILED = 'post-run-enqueue-failed'

function defaultOperations(): PostVerdictStepOperations {
  const curationDefaults = defaultCurationTailOperations()
  return {
    ownContinuation: ownPostVerdictContinuation,
    acquireWriterLease: LOCAL_DAEMON_CAPABILITIES.acquireWriterLease,
    releaseLease: LOCAL_DAEMON_CAPABILITIES.releaseLease,
    readWriterLease: LOCAL_DAEMON_CAPABILITIES.readWriterLease,
    deriveWriterLeaseFreshness: LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness,
    nudgeDaemon,
    loadCompletedRunHandoff: curationDefaults.loadCompletedRunHandoff,
    composeHost: (input) => composeCliLocalAgent({
      agentQaRoot: input.agentQaRoot,
      configPath: input.configPath,
      model: () => resolvePostRunJobModel(input.configPath),
    }),
    now: () => Date.now(),
  }
}

/** What the durable hand-off answered. `deduped` is a SUCCESS — see `enqueueAnalyzeRun`. */
export type PostVerdictEnqueueOutcome = 'enqueued' | 'deduped'

/**
 * The composed host has no durable job queue at all.
 *
 * A NAMED class rather than a bare `Error`, because it is the one enqueue failure that is not a
 * failure of the enqueue: nothing is wrong with the run, this host simply cannot queue anything —
 * which is `post-processing-unbound`'s exact meaning on the lease side too. Every other throw is
 * `post-run-enqueue-failed`, and collapsing the two would tell a person to go look for a broken
 * queue on a host that never had one.
 */
export class PostProcessingUnboundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostProcessingUnboundError'
  }
}

// Throws rather than reporting, treats `deduped` as success, and closes its own host.
export async function enqueueAnalyzeRun(input: {
  readonly runId: string
  readonly agentQaRoot: string
  readonly configPath: string
  readonly operations: Pick<PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'>
}): Promise<PostVerdictEnqueueOutcome> {
  const handoff = input.operations.loadCompletedRunHandoff(
    completedRunHandoffPath(input.agentQaRoot, input.runId),
  )
  const host = input.operations.composeHost({
    agentQaRoot: input.agentQaRoot,
    configPath: input.configPath,
  })
  try {
    if (typeof host.jobs !== 'function') {
      throw new PostProcessingUnboundError(
        'The host composed for this run binds no durable job queue, so nothing could be enqueued.',
      )
    }
    const jobs = await host.jobs()
    // Markers are copied from the handoff by conditional spread; the schema refuses `false`.
    const payload = AnalyzeRunPayloadSchema.parse({
      runId: input.runId,
      // The digest is minted once per run and shared with the receipt.
      handoffDigest: curationTailHandoffDigest(handoff),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
      ...(handoff.gateRun === undefined ? {} : { gateRun: handoff.gateRun }),
      ...(handoff.excludedFromOutcomes === undefined
        ? {}
        : { excludedFromOutcomes: handoff.excludedFromOutcomes }),
    })
    const outcome = await jobs.queue.enqueue('analyze-run', payload, input.runId)
    return outcome.deduped ? 'deduped' : 'enqueued'
  } finally {
    try {
      await host.close?.()
    } catch {
      // A store handle that will not close must never cost the verdict.
    }
  }
}

/** Read the actual deterministic row before recovery can spend, and validate its final bytes. */
async function matchingAnalysisAlreadyQueued(options: PostVerdictStepOptions, operations: PostVerdictStepOperations): Promise<boolean> {
  const host = operations.composeHost(options)
  try {
    const jobs = await host.jobs()
    const id = jobs.idSource.jobIdFor('analyze-run', options.runId)
    const row = (await jobs.store.dumpState()).jobs.find((job) => job.id === id
      || (job.kind === 'analyze-run' && job.idempotencyKey === options.runId))
    if (row === undefined) return false
    const handoff = operations.loadCompletedRunHandoff(completedRunHandoffPath(options.agentQaRoot, options.runId))
    const parsed = AnalyzeRunPayloadSchema.safeParse(row.payload)
    if (row.id !== id || row.kind !== 'analyze-run' || row.idempotencyKey !== options.runId
      || !parsed.success || parsed.data.runId !== options.runId
      || parsed.data.handoffDigest !== curationTailHandoffDigest(handoff)
      || parsed.data.handoffSchemaVersion !== handoff.schemaVersion
      || parsed.data.executionContext !== handoff.executionContext
      || parsed.data.gateRun !== handoff.gateRun
      || parsed.data.excludedFromOutcomes !== handoff.excludedFromOutcomes) {
      throw new PostVerdictContinuationRefused('queue-conflict')
    }
    return true
  } finally { await host.close() }
}

// Names the run, says the verdict is unaffected, and gives the handoff path for a manual re-queue.
function enqueueFailureWarning(
  runId: string,
  handoffPath: string,
  detail: string,
  executionContext: ExecutionContext | undefined,
): string {
  // In `ci` and `cloud` the drive's hand-off sentence states the resume limit.
  const resumeClause = ciResumeClause(executionContext, 'any-host')
  return `Run ${runId}: analysis enqueue failed or was refused (${detail}); post-run analysis was not queued. The verdict and exit code are unaffected. `
    + `Handoff: ${handoffPath}. Durable intent, if publication succeeded: ${join(dirname(handoffPath), 'post-verdict-pending.json')}. `
    + (resumeClause !== undefined
      ? `It ${resumeClause}; conflicting or unsafe state remains refused.`
      : 'The next local run or daemon drain resumes eligible pending hand-offs; conflicting or unsafe state remains refused.')
}

/**
 * Is a CURRENT-EPOCH holder present? Answered without touching the lease file.
 *
 * TOTAL OVER THE FOUR READ KINDS, deliberately as a `switch` with no `default` and no trailing
 * return — `classifyDaemonRegistration`'s own shape, for the same reason: the line this idiom
 * replaces everywhere it appears is `if (read.kind !== 'parsed') …`, which folds "I could not read
 * the authority state" into "nobody holds it".
 *
 *   - `absent` / `malformed` — genuine recovery input. Nobody holds a lease anyone can honour, so
 *     an acquisition would succeed by reclaiming: `free`.
 *   - `unreadable` — a lease that EXISTS and could not be opened (EACCES, EIO, EMFILE). Never
 *     evidence that nobody holds it, and the acquisition refuses on this input with exactly this
 *     reason, so the probe reports the same refusal rather than promising a drain that cannot
 *     happen.
 *   - `parsed` — the freshness verdict decides, and its `unknown` arm answers `refused` for the
 *     same argument the acquisition's `corrupt-epoch-state` refusal is built on.
 */
export function probeWriterLease(input: {
  readonly knowledgeRoot: string
  readonly operations: Pick<
    PostVerdictStepOperations,
    'readWriterLease' | 'deriveWriterLeaseFreshness' | 'now'
  >
}): WriterLeaseProbe {
  const read: WriterLeaseReadOutcome = input.operations.readWriterLease(input.knowledgeRoot)
  switch (read.kind) {
    case 'absent':
    case 'malformed':
      return { kind: 'free' }
    case 'unreadable':
      return { kind: 'refused', reason: `unreadable-lease-state (${read.code})` }
    case 'parsed': {
      const verdict = input.operations.deriveWriterLeaseFreshness(
        input.knowledgeRoot,
        read.lease,
        input.operations.now(),
      )
      switch (verdict.kind) {
        case 'fresh':
          return { kind: 'held' }
        case 'reclaimable':
          // A stale holder, or one naming a superseded epoch: the acquisition below would reclaim
          // it, so nothing is holding this run's chain up.
          return { kind: 'free' }
        case 'unknown':
          return { kind: 'refused', reason: 'corrupt-epoch-state' }
      }
    }
  }
}

// `skipped` means the enqueue never ran, which is a decision, not a failure.
export type PostVerdictEnqueueState = PostVerdictEnqueueOutcome | 'failed' | 'unbound' | 'skipped'

function safeEnqueueFailure(error: unknown): string {
  if (error instanceof PostVerdictContinuationRefused) return error.category
  if (error instanceof Error && /\bSQLITE_BUSY\b/.test(error.message)) return 'SQLITE_BUSY'
  return 'enqueue-error'
}

// A `switch` without `default`, so a new probe arm cannot take an adjacent value; order matters.
export function dispositionOf(input: {
  readonly enqueue?: PostVerdictEnqueueState
  /** The enqueue failure's own message, carried to the reader rather than flattened. */
  readonly enqueueError?: string
  readonly writerAuthority?: CurationWriterAuthority
  readonly probe?: WriterLeaseProbe
  readonly leaseSkipped: boolean
  readonly executionContext?: ExecutionContext
}): PostVerdictOutcome {
  if (input.enqueue === 'failed') {
    return {
      disposition: 'detached',
      warning: {
        code: POST_RUN_ENQUEUE_FAILED,
        message: input.enqueueError
          ?? 'The post-run analysis could not be queued for this run, so nothing will be drained '
          + 'from this process.',
      },
    }
  }
  if (input.enqueue === 'unbound') {
    return {
      disposition: 'detached',
      warning: {
        code: POST_PROCESSING_UNBOUND,
        message:
          'No durable job queue is composed on this host, so this run\'s post-processing chain '
          + 'was never queued and will not be drained from this process.',
      },
    }
  }
  // The host already holds the lease; asking would answer `held` to itself, so there is no probe.
  if (input.writerAuthority !== undefined) return { disposition: 'drained' }
  if (input.leaseSkipped) return { disposition: 'detached' }
  const probe = input.probe
  if (probe === undefined) {
    const resumeClause = ciResumeClause(input.executionContext, 'any-host')
    return {
      disposition: 'detached',
      warning: {
        code: POST_PROCESSING_UNBOUND,
        message:
          'No writer-lease capability is composed on this host, so this run\'s post-processing '
          + 'chain will not be drained from this process. '
          + (resumeClause !== undefined
            ? `It ${resumeClause}.`
            : 'The next local run or `agent-qa daemon` drains it.'),
      },
    }
  }
  switch (probe.kind) {
    case 'held':
      // Another holder has a current-epoch lease and will pump; `handedOff` claims no success.
      return { disposition: 'handedOff' }
    case 'free':
      // Nobody holds it, so this process is the one that will take it — when its pump asks.
      return { disposition: 'drained' }
    case 'refused':
      return {
        disposition: 'detached',
        warning: {
          code: WRITER_LEASE_REFUSED,
          message:
            `The writer lease could not be evaluated (${probe.reason}), so this run's `
            + 'post-processing chain will not be drained from this process.',
        },
      }
  }
}

/**
 * Compose this run's post-verdict step: the port the shell awaits, and the box its lease leaves in.
 *
 * `run()` NEVER throws for a lease refusal — that is a decided posture with a named warning, not a
 * failure. An UNEXPECTED throw (a capability that raised rather than returning a refusal) is
 * deliberately allowed to propagate, so the shell's own degrade path — `post-verdict-step-failed` —
 * is a live path rather than dead code nothing can reach.
 */
export function createPostVerdictStep(options: PostVerdictStepOptions): {
  readonly port: PostVerdictPort
  readonly handoff: PostVerdictHandoff
} {
  const ops = (): PostVerdictStepOperations => ({ ...defaultOperations(), ...options.operations })
  let acquired: CurationWriterAuthority | undefined
  let supplied: CurationWriterAuthority | undefined
  let claimed = false
  let decided: PostVerdictOutcome | undefined
  let completion: Promise<PostVerdictOutcome> | undefined
  let enqueue: PostVerdictEnqueueState | undefined
  let enqueueError: string | undefined
  /**
   * What `takeAcquiredLease()` should do when a pump finally asks.
   *
   * `run()` sets it and nothing else does. Three states, and the third is why this is a variable
   * rather than a condition on `acquired`:
   *   - `acquire` — nobody held the lease at the verdict, so the pump's request is what mints it.
   *   - `supplied` — the HOST already holds it (the daemon door). Handed straight through; nothing
   *     is acquired, and the backstop must never release it (see `takeUnclaimedLease`).
   *   - `none` — a holder exists, a refusal happened, or the lease was deliberately skipped.
   */
  let plan: 'acquire' | 'supplied' | 'none' = 'none'

  const execute = async (input: PostVerdictStepInput): Promise<PostVerdictOutcome> => {
      const root = options.knowledgeRoot
      // Every run records its config, or another run's tail cannot curate it.
      try {
        writeRunConfigRecord(options.agentQaRoot, options.runId, resolve(options.configPath))
      } catch (error) {
        options.log.warn(`Run ${options.runId}: its config record was not written, so only its own tail `
          + `will curate it (${error instanceof Error ? error.message : String(error)}).`)
      }
      const settle = (outcome: PostVerdictOutcome): PostVerdictOutcome => {
        decided = outcome
        return outcome
      }

      // The markers come from the step input: this arm exists so the handoff is never loaded.
      if (input.gateRun === true || input.excludedFromOutcomes === true) {
        enqueue = 'skipped'
        return settle(dispositionOf({ enqueue: 'skipped', leaseSkipped: true }))
      }

      // (b) THE ENQUEUE — the durable record, before any posture about draining it.
      try {
        enqueue = await ops().ownContinuation({ ...options,
          queued: () => matchingAnalysisAlreadyQueued(options, ops()),
          enqueue: async () => {
            return await enqueueAnalyzeRun({ ...options, operations: ops() })
          },
        })
      } catch (error) {
        enqueue = error instanceof PostProcessingUnboundError ? 'unbound' : 'failed'
        enqueueError = enqueueFailureWarning(
          options.runId,
          completedRunHandoffPath(options.agentQaRoot, options.runId),
          safeEnqueueFailure(error),
          options.executionContext,
        )
      }

      // (c) A run with nothing queued has nothing to promise about, and taking a lease for an
      // empty chain would leave it held for its TTL. No consult at all on this path.
      if (enqueue === 'failed' || enqueue === 'unbound') {
        return settle(dispositionOf({
          enqueue,
          ...(enqueueError === undefined ? {} : { enqueueError }),
          leaseSkipped: false,
        }))
      }

      // (d) The daemon door supplied its own authority: stash it for a pump and acquire nothing.
      const authority = options.writerAuthority
      if (authority !== undefined) {
        supplied = authority
        plan = 'supplied'
        return settle(dispositionOf({ enqueue, writerAuthority: authority, leaseSkipped: false }))
      }

      // (e) `--detach`: the enqueue above ran, and detaching skips only the lease.
      if (options.detach === true) {
        return settle(dispositionOf({ enqueue, leaseSkipped: true }))
      }

      // The decision read is non-mutating; the acquisition waits for a pump.
      const probe = probeWriterLease({ knowledgeRoot: root, operations: ops() })
      if (probe.kind === 'held') {
        // The SHIPPED nudge envelope, verbatim from the tail's own hand-off leg: its handler
        // already calls `requestDrain` and wakes the job dispatcher, and a nudge that never lands
        // is invisible by design because the daemon's own poll is the backstop. Fire-and-forget:
        // this step may not spend the verdict's milliseconds waiting for a daemon to answer.
        void ops().nudgeDaemon(options.agentQaRoot, { knowledgeRoot: root }).catch(() => undefined)
      }
      if (probe.kind === 'free') {
        plan = 'acquire'
      }
      return settle(dispositionOf({ enqueue, probe, leaseSkipped: false }))
  }
  const port: PostVerdictPort = {
    run(input) {
      completion ??= execute(input)
      return completion
    },
  }

  return {
    port,
    handoff: {
      get completion() { return completion },
      get enqueueState() { return enqueue },
      get failureDetail() { return enqueueError },
      get pendingPath() { return postVerdictPendingPath(options) },
      get outcome(): PostVerdictOutcome | undefined {
        return decided
      },
      takeAcquiredLease(): CurationWriterAuthority | undefined {
        if (claimed) return undefined
        claimed = true
        if (plan === 'supplied') {
          const handed = supplied
          supplied = undefined
          return handed
        }
        if (acquired === undefined && plan === 'acquire') {
          // THE one acquisition (see this file's header), made on behalf of the pump that just
          // asked for it. Synchronous by contract — the lease API does its own bounded contention
          // internally. A `held` or `refused` answer hands back `undefined`: the caller's own
          // consult is then the fallback, and this box never acquires again.
          const outcome = ops().acquireWriterLease(options.knowledgeRoot)
          if (outcome.kind === 'acquired') {
            acquired = { leaseId: outcome.leaseId, epoch: outcome.epoch }
          }
        }
        const held = acquired
        acquired = undefined
        return held
      },
      takeUnclaimedLease(): CurationWriterAuthority | undefined {
        if (claimed) return undefined
        claimed = true
        // ONLY what this step itself acquired. A SUPPLIED authority is deliberately not returned:
        // it is the daemon's live, heartbeating lease, and releasing it because no tail claimed it
        // would revoke a running daemon's authority mid-run. See this member's doc on
        // `PostVerdictHandoff`.
        const held = acquired
        acquired = undefined
        return held
      },
    },
  }
}

// Releases only a lease this step acquired; a supplied daemon lease is never released here.
export function releaseUntakenPostVerdictLease(input: {
  readonly handoff: PostVerdictHandoff
  readonly knowledgeRoot: string
  readonly runId: string
  readonly log: { warn(message: string): void }
  readonly operations?: Partial<Pick<PostVerdictStepOperations, 'releaseLease'>>
}): void {
  const authority = input.handoff.takeUnclaimedLease()
  if (authority === undefined) return
  const release = input.operations?.releaseLease ?? LOCAL_DAEMON_CAPABILITIES.releaseLease
  try {
    release({ knowledgeRoot: input.knowledgeRoot, leaseId: authority.leaseId })
  } catch {
    // Same posture as the tail's own release: a lease this process cannot release expires on its
    // TTL, and failing a finished run over cleanup would spend the verdict-first guarantee.
  }
  input.log.warn(
    `Run ${input.runId}: post-run lease released untaken — the post-verdict step acquired the `
    + 'writer lease but no post-run tail claimed it, so nothing was drained from this process.',
  )
}
