import type { CurationSnapshot } from '@vostride/agent-qa-schema'
// Leg 2 and the close-out: the pump, its budget, the chip emitter and the exit line; all warn-only.

// Surface code: other packages arrive via the composition edge or the ledgered `curation-tail.ts`.

import {
  chainJobIdsForRun,
  invokeFunction,
  renderAnalysisClusterBlock,
  RUNS_DIGEST_FUNCTION_ID,
  RUNS_POST_PROCESSING_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
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

// Re-exported so the CLI suite names it here; the layout lives in the package with both callers.
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
import { createPostRunChipEmitter } from './post-run-chip-emitter.js'
import { resolveRunCurationContext } from './run-curation-context.js'
import { ciResumeClause, isCiContext, resumeLimitClause } from './resume-limit.js'
import {
  CURATION_BREAKDOWN_BUCKETS,
  POST_PROCESSING_SKIP_REASON_WORDS,
} from '@vostride/agent-qa-schema'

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
  // The global FIFO spends the budget on other runs before this run's chain is reachable.
  | 'backlog-exhausted'
  | 'retry-scheduled'
  | 'refused'
  // Distinct from `drained`, so a throw on the first job never reads like an emptied queue.
  | 'threw'

// Control flow only; the user-facing line is rendered from durable job state.
export interface PostRunTailReport {
  readonly enqueue?: PostRunEnqueueOutcome
  readonly preparationPending?: true
  readonly drain: PostRunDrainOutcome
  /** Chain jobs this process actually ran to a disposition. */
  readonly jobsRun: number
}

// Every side effect this tail performs, in one table, so a test can induce each failure.
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
  // Through the one read op, so the CLI and the dashboard cannot disagree about a row.
  readPostProcessingStatus(host: LocalAgentHost, runId: string): Promise<PostProcessingStatus>
  // Through the one producer, so the printed bytes match `agent-qa digest`, the run page and chat.
  readRunDigest(host: LocalAgentHost, runId: string): Promise<RunDigest>
  /** The one wall clock, read only at tail boundaries. */
  now(): number
}

export interface PostRunTailHostInput {
  readonly agentQaRoot: string
  readonly configPath: string
  // Carried so `composeHost` derives the posture from what the tail has.
  readonly mask?: RunCurationTailOptions['mask']
  readonly curateRun: (input: {
    readonly runId: string
    readonly executionContext: unknown
    readonly deadlineMs?: number
  }) => Promise<{
    readonly curated: number
    readonly deprecated: number
    /** The fold's own completeness, carried rather than dropped. */
    readonly complete: boolean
    readonly snapshot?: CurationSnapshot
    readonly reason?: string
  }>
}

// A failed resolution reports only when an author reaches the model, so no LLM still gets a chain.
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
      agentQaRoot: input.agentQaRoot,
      configPath: input.configPath,
      model: () => resolvePostRunJobModel(input.configPath),
      postRun: {
        curateRun: input.curateRun,
        // From presence: a tail without a mask defers the claim rather than emitting unmasked.
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
    now: Date.now,
  }
}

// `Pick` rather than a restatement, so `mask` cannot drift from what the fold consumes.
export interface RunPostRunTailOptions extends Pick<
  RunCurationTailOptions,
  | 'runId'
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
  // Absent reads as `skipped`; `failed` makes `finish()` return early, because nothing is queued.
  enqueueOutcome?: PostRunEnqueueOutcome
  /** Live ownership survives the runner's bounded wait; undefined state means still preparing. */
  postVerdict?: import('./post-verdict-step.js').PostVerdictHandoff
  /** The host wait and this drain spend one deadline. */
  deadlineMs?: number
  // The dashboard's second chip sink, threaded to `createChipEmitter` at its one construction site.
  relay?: (envelope: RunEventEnvelope) => void
  /** Focused test seam. Production callers omit it. */
  operations?: Partial<PostRunTailOperations>
  // In `ci` and `cloud` a pending line states the resume limit.
  executionContext?: ExecutionContext
}

// No `enqueue()` member: the shell enqueues on every door, so detach skips only the drain.
export interface PostRunTailHandle {
  // `takeLease` runs inside the try whose `finally` releases, so no path strands a lease.
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

// Normal ends only: a throw leaves the loop, skips classification, and reports as `threw`.
type ChainPumpExit = 'bound' | 'budget' | 'empty' | 'aborted'

// A `Record`, so a new pump exit fails to compile until it is classified.
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
  // Every line this tail logs, or hands a leg to log, is masked.
  const mask = opts.mask ?? ((text: string) => text)
  const log: RunPostRunTailOptions['log'] = {
    warn: (message) => opts.log.warn(mask(message)),
    ...(opts.log.info === undefined
      ? {}
      : { info: (message: string) => opts.log.info?.(mask(message)) }),
  }
  // Resolved inside a leg's try, so a module read that throws cannot turn a pass into exit 2.
  let resolvedOperations: PostRunTailOperations | undefined
  const ops = (): PostRunTailOperations => (resolvedOperations ??= {
    ...defaultPostRunTailOperations(),
    ...opts.operations,
  })

  // `skipped` when no step ran in front of this tail: not told, not a claim that nothing is queued.
  const enqueueOutcome = (): PostRunEnqueueOutcome | undefined => {
    if (opts.postVerdict === undefined) return opts.enqueueOutcome ?? 'skipped'
    const state = opts.postVerdict.enqueueState
    return state === 'unbound' ? 'failed' : state
  }
  let observingLateFailure = false
  const discloseFailure = () => log.warn(opts.postVerdict?.failureDetail
    ?? `Run ${opts.runId}: analysis enqueue failed or was refused. Analysis is not queued.`)
  let drainOutcome: PostRunDrainOutcome = 'not-attempted'
  let jobsRun = 0
  let preparationRecoveryPending = false
  // Only the pump's own observation shows analyze-run completed; drain outcome and chips cannot.
  let analyzeRunCompleted = false
  let host: LocalAgentHost | undefined
  let knowledgeRoot: string | undefined
  // Read at claim time, because the host is composed before the lease is acquired.
  let heldAuthority: CurationWriterAuthority | undefined
  /** The one budget's absolute stop point, fixed when the drain leg begins. */
  let drainDeadlineMs: number | undefined
  // Aborts at `drainDeadlineMs`, or with the caller's own signal.
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
    const folded = await ops().curateCompletedRun({
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
    // Keep the fold's `complete`, or the warning and the durable notification row disagree.
    return {
      curated: folded.curated,
      deprecated: folded.deprecated,
      complete: folded.complete,
      ...(folded.snapshot === undefined ? {} : { snapshot: folded.snapshot }),
    }
  }

  const openHost = (): LocalAgentHost => {
    host ??= ops().composeHost({
      agentQaRoot: opts.agentQaRoot,
      configPath: opts.configPath,
      // The same conditional spread the fold is threaded with: composeHost derives the
      // posture from this value's PRESENCE, so the tail never asserts a mask it lacks.
      ...(opts.mask === undefined ? {} : { mask: opts.mask }),
      curateRun,
    })
    return host
  }

  return {
    async drain(input: {
      readonly takeLease?: () => CurationWriterAuthority | undefined
      readonly withoutLease?: 'consult' | 'skip'
    } = {}): Promise<void> {
      if (opts.postVerdict !== undefined && enqueueOutcome() !== 'enqueued' && enqueueOutcome() !== 'deduped') return
      let root: string
      const budget = new AbortController()
      let budgetTimer: ReturnType<typeof setTimeout> | undefined
      try {
        // The one step before the take, so an unresolvable root costs a warning and no lease.
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
      } catch (error) {
        // The operations table can throw while resolving and must not reach the framework catch.
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
        // Calling the thunk acquires, and the very next statement records what to release.
        const handed = input.takeLease?.()
        acquiredLeaseId = handed?.leaseId
        heldAuthority = handed
        if (handed === undefined && input.withoutLease === 'skip') {
          // Nothing acquired or composed: `drainOutcome` stays `not-attempted` for `finish()`.
          return
        }
        // Composed AFTER the take, so a composition that throws lands in the catch below with a
        // release already armed above it — the exact path that used to drop the lease.
        openedHost = openHost()
        // A handed authority skips this consult; the `held` and `refused` arms cannot apply to it.
        if (handed === undefined) {
          const acquired = ops().acquireWriterLease(root)
          if (acquired.kind === 'held') {
            // The shipped nudge wakes the job pump; a lost nudge falls back to the daemon's poll.
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
        ]
        // The only construction site, in the acquired-lease branch, so the daemon emits nothing.
        const chips = ops().createChipEmitter({
          agentQaRoot: opts.agentQaRoot,
          runId: opts.runId,
          chainJobIds: ownChainJobIds,
          // The chip's error text crosses the fold's disclosure boundary, so it takes the mask.
          ...(opts.mask === undefined ? {} : { mask: opts.mask }),
          // An absent relay is an absent field, never a present `undefined`.
          ...(opts.relay === undefined ? {} : { relay: opts.relay }),
          now: () => ops().now(),
        })
        // Adopt the minted epoch, then reclaim rows a dead holder left claimed, as the daemon does.
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
            // Set only where this process sees analyze-run complete; failed or retrying is not.
            analyzeRunCompleted = true
          }
          jobsRun += 1
          if (outcome.disposition === 'retry-scheduled') {
            // Never sleep on a backoff: the store keeps the row unclaimable until its not-before.
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
        // A retry of another run's job never changes this run's outcome.
        if (drainOutcome === 'drained' && retryingOwnJobs.size > 0) drainOutcome = 'retry-scheduled'
        // Starvation exits are reachable only inside the pump, so no outcome check is needed.
        if (!ownChainObserved && PUMP_EXIT_STARVES_OWN_CHAIN[pumpExit]) {
          drainOutcome = 'backlog-exhausted'
        }
        // The prior-run janitor uses what is left of the budget and lease, and skips this run.
        if (!preparationRecoveryPending) await ops().runCurationTail({
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
        // A host that never came up reads `not-attempted`, not `threw`; `openedHost` records that.
        drainOutcome = openedHost === undefined ? 'not-attempted' : 'threw'
        log.warn(drainFailureWarning(opts.runId, error, opts.executionContext))
      } finally {
        clearTimeout(budgetTimer)
        drainSignal = undefined
        heldAuthority = undefined
        // The one release, on every path out; `root` is known before any take.
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
          ? `Run ${opts.runId}: post-verdict hand-off pending; analysis is not yet queued. It ${resumeClause}. Durable intent: ${opts.postVerdict.pendingPath}.`
          : `Run ${opts.runId}: post-verdict hand-off pending; analysis is not yet queued. Durable intent: ${opts.postVerdict.pendingPath}. The next local run or daemon drain resumes eligible pending hand-offs.`)
        if (!observingLateFailure && opts.postVerdict.completion !== undefined) {
          observingLateFailure = true
          void opts.postVerdict.completion.then(() => {
            if (enqueueOutcome() === 'failed') discloseFailure()
          }, discloseFailure)
        }
        return
      }
      if (opts.postVerdict !== undefined && actualEnqueue === 'failed') { discloseFailure(); return }
      // A skipped enqueue falls through to the exit line, which prints the status read's fact.
      const skippedEnqueue = opts.postVerdict !== undefined && actualEnqueue === 'skipped'
      if (input.detached === true && drainOutcome === 'not-attempted' && !skippedEnqueue) {
        // The one place `detached` is ever produced. `drain()` was never called, so nothing
        // else in this file could have said so — and a report that called the detach posture
        // `not-attempted` would be indistinguishable from an enqueue that failed first.
        drainOutcome = 'detached'
      }
      // Read lazily and once, because a second read would be a second projection of one run.
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
      // Printed after the exit line, only when this process's pump completed analyze-run.
      const printDigestBlock = async (openedHost: LocalAgentHost): Promise<void> => {
        if (!analyzeRunCompleted) return
        const digest = await readDigest(openedHost)
        if (digest === undefined || digest.lines.length === 0) return
        log.info?.(digest.lines.join('\n'))
      }
      // A failed enqueue already warned, so no close-out line is built from an empty chain.
      if (actualEnqueue === 'failed') return
      let openedHost: LocalAgentHost
      try {
        // Composed here because the detach leg never calls `drain()` and needs the line most.
        openedHost = openHost()
      } catch (error) {
        log.warn(summaryFailureWarning(opts.runId, error))
        return
      }
      try {
        const status = await ops().readPostProcessingStatus(openedHost, opts.runId)
        if (status.notification !== undefined && drainOutcome === 'drained') {
          // The chain reached its terminal in this process, so this line reports what happened.
          const receipt = readCurationTailReceipt(completedRunDir(opts.agentQaRoot, opts.runId))
          log.info?.(renderChainTerminalLine(status.notification,
            receipt?.runId === opts.runId ? receipt : undefined))
          await printDigestBlock(openedHost)
          return
        }
        // Statuses are durable; the parenthetical and the fetch suffix are this process's posture.
        log.info?.(
          renderPostProcessingSummaryLine(
            status,
            postureOf(drainOutcome),
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

const SUMMARY_SEPARATOR = ' · '

/**
 * What THIS process knows about a pending stage's future — the only thing durable state cannot
 * say for itself.
 *
 * `none` is the honest answer for `--detach`, a refusal and a drain that simply ended: nobody in
 * this process promised anything, so nothing is promised on their behalf.
 */
export type PostRunPendingPosture = 'handed-off' | 'backlog-exhausted' | 'none'

// A host folding with no mask cannot claim `curate-memory`, so no daemon drains curation.
type StageDrainer = 'any-host' | 'masked-leg-only'

// A `Record` over the chip set, so a new stage must classify its drainer here.
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

// A CI workspace is usually discarded, so a pending stage says how its drainer can still reach it.
const CI_PENDING_SUFFIX: Record<StageDrainer, string> = {
  'any-host': ` (${resumeLimitClause('any-host')})`,
  'masked-leg-only': ` (${resumeLimitClause('masked-leg-only')})`,
}

// Total over the outcome union, so a new outcome must choose its posture here.
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

// Status words come verbatim from `runs.postprocessing`; the parenthetical comes from posture only.
export function renderPostProcessingSummaryLine(
  status: PostProcessingStatus,
  posture: PostRunPendingPosture,
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
  ].join(SUMMARY_SEPARATOR)}`
}

// A snapshot prints every bucket; a row without one prints the legacy pair, never synthesized.
export function renderChainTerminalLine(
  notification: RunNotificationView,
  report?: {
    canary?: CanaryCreditCounters
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
  // The receipt's typed class counts stay visible on the chain line.
  const nonSignalClasses = canary === undefined || nonSignalTotal === 0 ? ''
    : ` (${NON_SIGNAL_CLASSES.map(name => `${name} ${canary.nonSignal[name]}`).join(', ')})`
  const canaryText = canary === undefined ? '' :
    `canary: ride-along ${canary.rideAlongUncredited}`
    + `, non-signal ${nonSignalTotal}${nonSignalClasses}`
    + `, rerun-excluded ${canary.rerunExcluded}`
  const curationCounts = counts.join(', ') + (canaryText === '' ? '' :
    `${counts.length === 0 ? '' : '; '}${canaryText}`)
  return `post-processing ${notification.outcome} for ${notification.runId} — ${[
    verdicts,
    `analysis: ${stages.analysis.status}`,
    `curation: ${stages.curation.status}`
      + (curationCounts === '' ? '' : ` (${curationCounts})`),
  ].join(SUMMARY_SEPARATOR)}`
}

// The id rides `JSON.stringify`, so one needing quotes still pastes as a working command.
export function digestFetchCommand(runId: string): string {
  return `agent-qa digest ${JSON.stringify(runId)}`
}

// The count is dropped when the ledger is not read; the command prints regardless.
export function renderDigestPointer(runId: string, digest: RunDigest | undefined): string {
  const changes = digest?.markChanges?.length ?? 0
  const applied = changes === 0
    ? ''
    : `marks: ${changes} change${changes === 1 ? '' : 's'} applied${SUMMARY_SEPARATOR}`
  return `${SUMMARY_SEPARATOR}${applied}digest: ${digestFetchCommand(runId)}`
}

// Warned, never thrown, and carries the same fetch command the exit line would have.
function digestReadFailureWarning(runId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The digest for ${runId} could not be read for printing (${detail}); it remains `
    + `readable via ${digestFetchCommand(runId)}.`
}

// Warned rather than swallowed or thrown: the exit code is already frozen.
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
