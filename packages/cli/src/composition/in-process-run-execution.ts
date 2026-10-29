// Producers stay in `run.ts`, the one cli file the surface firewall lets reach platform packages.

import { asRunId, resolveEffectiveWorkers } from '@vostride/agent-qa-schema'
import type {
  MaskFn,
  QuarantineAppliedEntry,
  RunSession,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
// Safety names come via `run-drive-vocabulary`; the firewall bars the safety package here.
import {
  DRAIN_BUDGET_MS,
  createRunInvocationCore,
  mapVerdictToExitCode,
  runSafetyScope,
} from '@vostride/agent-qa-agent-local'
import { waitForPostVerdictContinuation } from '../curation/post-verdict-continuation.js'
import { ciResumeClause } from '../curation/resume-limit.js'
import type { RunExecutionContext } from '@vostride/agent-qa-agent-local'

import { assembleCliRun } from './run-assembly.js'
import type { CurationWriterAuthority } from '../curation/curation-tail.js'
import {
  createPostVerdictStep,
  releaseUntakenPostVerdictLease,
  type PostVerdictHandoff,
} from '../curation/post-verdict-step.js'
import { REPLAY_FROM_START, attachRunSubscribers } from '../run-session-composition.js'
import {
  isMintedCliRunId,
  mintCliRunId,
  produceMembersFromPatterns,
  resolveRunInvocationInputs,
} from '../commands/run.js'
import type {
  ProducedCliRunMembers,
  RunArtifactSnapshotListener,
  RunInvocationInputs,
  RunOptions,
  RunRecord,
} from '../commands/run.js'

/**
 * The box a door reads when no post-verdict step was ever composed for this run — a denial, an
 * assembly that threw, or a core with no factory. It acquired nothing, so it hands back nothing.
 */
const UNCOMPOSED_POST_VERDICT: PostVerdictHandoff = Object.freeze({
  outcome: undefined,
  takeAcquiredLease: () => undefined,
  takeUnclaimedLease: () => undefined,
})

/**
 * The typed input failure, re-exported so a composing door has ONE import site for this module's
 * whole contract. It is declared in its own leaf module because this file and `commands/run.ts`
 * import each other — see `cli-run-input-error.ts`'s header for why that matters.
 */
export { CliRunInputError } from './cli-run-input-error.js'

/** What a member producer answers. Declared where its vocabulary is legal; re-exported here. */
export type { ProducedCliRunMembers as ProducedRunMembers } from '../commands/run.js'

/** What a member producer is handed: the request, the resolved inputs and the run's own identity. */
export interface RunMemberProductionContext {
  readonly request: RunsStartInput
  readonly configPath: string
  readonly runId: string
  readonly executionContext: RunExecutionContext
  /** The resolved preflight, when the door already read it. Absent for a bare-request door. */
  readonly inputs?: RunInvocationInputs
}

export type RunMemberProducer = (
  context: RunMemberProductionContext,
) => Promise<ProducedCliRunMembers>

/** What the door's subscriber factory is handed inside the core's `onSession`. */
export interface RunSubscriberAttachInput {
  readonly session: RunSession
  readonly quarantined: readonly QuarantineAppliedEntry[]
  /** The run's mask: the producer's redactor over the secrets read at its start. */
  readonly mask: MaskFn
  // A door's dashboard ingest registers here to stage each member's masked test and config.
  readonly onMemberSnapshot?: (listener: RunArtifactSnapshotListener) => () => void
}

/** What a door's post-verdict tail is handed, INSIDE the run's own safety scope. */
export interface CliRunVerdictContext {
  readonly postVerdictDeadlineMs?: number
  readonly runId: string
  readonly verdict: string
  /** The verdict's own exit code, before any door-level fold (`--all`, a pending cancel). */
  readonly exitCode: number
  readonly mask: MaskFn
  readonly configDir: string
  readonly configFilePath: string
  // Take this lease; a tail that acquires its own is answered `held` by its own process.
  readonly postVerdict: PostVerdictHandoff
}

/** What one in-process run answers with. A non-zero `exitCode` is a real run, not an error. */
export interface CliRunOutcome {
  readonly runId: string
  readonly verdict: string
  readonly exitCode: number
  // Never rejects; leaving it unawaited keeps `run-settled` off the drain's clock.
  readonly settled?: Promise<void>
}

/**
 * What a door hands over to get a run. Everything here is something only a DOOR can answer.
 */
export interface InProcessCliRunExecutionOptions {
  readonly postVerdictSignal?: AbortSignal
  /** The config runs resolve against unless `request.configPath` names another. */
  readonly configPath: string
  /** `<configDir>/.agent-qa`, the root the function layer's evidence check reads. */
  readonly agentQaRoot: string
  // No default and no ambient fallback: a door that supplies nothing gets a type error.
  readonly executionContext: RunExecutionContext
  readonly onSession?: (session: RunSession) => void
  /** Freeze the door's completed result before any asynchronous post-verdict work. */
  readonly freezeVerdict?: (verdict: CliRunVerdictContext['verdict']) => number
  /**
   * The already-resolved input preflight, when the door read it for itself.
   *
   * `agent-qa run` needs these before it can answer `--list-tests`, `--dry-run` or a parse error, so
   * it hands them over rather than paying for a second config resolution and a second secrets read.
   * Absent ⇒ the drive resolves them from `configPath` and `request.patterns`, which is what a door
   * holding nothing but a `RunsStartInput` does.
   */
  readonly inputs?: RunInvocationInputs
  // Absent, the pattern producer runs; it is mode-aware, because `runs.start` carries no mode flag.
  readonly produceMembers?: RunMemberProducer
  /** The door's own reporters, attached inside the core's `onSession`. The record is not one. */
  readonly subscribers?: (input: RunSubscriberAttachInput) => { flush(): Promise<void> } | undefined
  /**
   * The run's runs.db record. The drive opens it once the request and its run id are allowed and
   * attaches it itself; the door that built it closes it. Required: no door runs unrecorded.
   */
  readonly runRecord: RunRecord
  /**
   * The door's post-verdict tail, run INSIDE the run's safety scope and after the subscriber flush,
   * returning the final exit code.
   *
   * IT IS A HOOK RATHER THAN THE DRIVE'S OWN WORK because the tail is a door concern that must not
   * leave the scope: `agent-qa run` folds its `--all` suite result into the code here and drains the
   * post-verdict knowledge curation, whose egress masks with the context's `mask`. A drive that ran
   * the tail itself would own a lifecycle it has no business owning.
   */
  readonly afterVerdict?: (context: CliRunVerdictContext) => Promise<number> | number
  // `detach` skips the lease, still enqueueing; `writerAuthority` passes the daemon's held lease.
  readonly postProcessing?: {
    readonly detach?: true
    readonly writerAuthority?: CurationWriterAuthority
  }
  // Detached, so `run-settled` does not wait on curation holding the db and the device lease.
  readonly postRunTail?: (context: CliRunVerdictContext) => Promise<void>
  /**
   * Handed the run's detached post-run work, the same promise as the outcome's `settled`, the
   * moment the drive starts it. It is called on every path that starts such work, including a run
   * that then re-raises a member's framework error and so returns no outcome.
   */
  readonly onPostRun?: (settled: Promise<void>) => void
  /** Where a quarantine-fold warning goes. The door owns its rendering. */
  readonly warn?: (message: string) => void
  // Takes the run id because one door port serves many runs and a lease belongs to one.
  readonly resolveAppiumUrl?: (runId: string) => string | undefined
  // UI flags `RunsStartInput` lacks, added one named field at a time, never as `RunOptions`.
  readonly resolveRunFlags?: (runId: string) => { readonly disableCache?: boolean } | undefined
}

// In `ci` and `cloud` the line states the resume limit, not a promise.
export function preparationPendingWarning(
  runId: string,
  pendingPath: string | undefined,
  executionContext: RunExecutionContext,
): string {
  const resumeClause = ciResumeClause(executionContext, 'any-host')
  return resumeClause !== undefined
    ? `Run ${runId}: post-verdict hand-off pending; analysis is not yet queued. It ${resumeClause}. Durable intent: ${pendingPath}.`
    : `Run ${runId}: post-verdict hand-off pending; analysis is not yet queued. Durable intent: ${pendingPath}. The next local run or daemon drain resumes eligible pending hand-offs.`
}

// Order matters: inputs, identity, members, hooks, core, then execute in the run's safety scope.
export async function runInProcessCliRun(
  options: InProcessCliRunExecutionOptions,
  request: RunsStartInput,
): Promise<CliRunOutcome> {
  const configPath = request.configPath ?? options.configPath
  const runId = request.runId ?? mintCliRunId()

  // A DOOR THAT BROUGHT ITS OWN PRODUCER BROUGHT ITS OWN INPUTS TOO. Resolving them here anyway
  // would re-read the config and the secrets file for a door that already has both, and would make
  // `agent-qa run`'s `--list-tests`/`--dry-run`/parse-error preflight a thing this seam repeats.
  const produced = options.produceMembers === undefined
    ? await produceMembersFromPatterns({
        inputs: options.inputs ?? await resolveRunInvocationInputs({
          configPath,
          ...(request.patterns === undefined ? {} : { patterns: request.patterns }),
        }),
        runId,
        runRecord: options.runRecord,
        // The door's per-run resolver, BOUND to this run's id here — the one place the id is
        // decided. See `resolveAppiumUrl` on the options.
        ...(options.resolveAppiumUrl === undefined
          ? {}
          : { resolveAppiumUrl: (): string | undefined => options.resolveAppiumUrl!(runId) }),
        ...(options.resolveRunFlags === undefined
          ? {}
          : { opts: { ...options.resolveRunFlags(runId) } as RunOptions }),
      })
    : await options.produceMembers({
        request,
        configPath,
        runId,
        executionContext: options.executionContext,
        ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
      })

  const warnByName = options.warn ?? ((): void => { /* a door with no renderer drops the line */ })
  const mask: MaskFn = (text) => produced.secretRedactor.redactString(text)

  // No per-run hook registrar or guardrail audit sink is built; the loop gets no hook port.

  let quarantined: readonly QuarantineAppliedEntry[] = []
  let startedSession: RunSession | undefined
  let startedSubscribers: { flush(): Promise<void> } | undefined
  let startedRecord: { flush(): Promise<void> } | undefined
  // One variable, not a map: this drive serves exactly one run, so a keyed cache would never evict.
  let postVerdictHandoff: PostVerdictHandoff | undefined

  const core = createRunInvocationCore({
    configPath,
    agentQaRoot: options.agentQaRoot,
    executionContext: options.executionContext,
    mintRunId: mintCliRunId,
    // The mint's shape predicate; the core requires it with no default.
    isMintedRunId: isMintedCliRunId,
    afterRefusal: async () => {
      // The record opens once the request and its run id are allowed, then plugins load, before
      // any effect.
      await options.runRecord.open({
        runId,
        configDir: produced.configDir,
        ...(produced.configuredRunsDbPath === undefined
          ? {}
          : { configuredDbPath: produced.configuredRunsDbPath }),
      })
      await produced.loadPlugins()
    },
    assembleRun: async (assemblyContext) => {
      const assembly = await assembleCliRun({
        runId: assemblyContext.runId,
        // The one place the worker count is applied; only the config the producer read feeds it.
        workers: resolveEffectiveWorkers({
          ...(produced.concurrency ?? {}),
          memberCount: produced.members.length,
        }),
        executionContext: assemblyContext.executionContext,
        configDir: assemblyContext.configDir,
        knowledgeRoot: produced.knowledgeRoot,
        ports: assemblyContext.ports,
        secretRedactor: produced.secretRedactor,
        members: produced.members,
        executor: produced.executor,
        configDigests: produced.configDigests,
        product: produced.product,
        ...(produced.buildTag === undefined ? {} : { buildTag: produced.buildTag }),
        ...(produced.plannerLimits === undefined ? {} : { plannerLimits: produced.plannerLimits }),
        ...(produced.runArtifact === undefined ? {} : { runArtifact: produced.runArtifact }),
        memberProbeUrls: produced.memberProbeUrls,
        warn: options.warn ?? (() => { /* a door with no renderer drops the fold warning */ }),
      })
      produced.applyAssembly({
        buildOrdinal: assembly.buildOrdinal,
        quarantined: assembly.quarantined,
      })
      quarantined = assembly.quarantined
      // Live knowledge bind, after the verdict, with the ordinal it reads.
      produced.bindKnowledge?.(assembly.buildOrdinal)
      return assembly.config
    },
    onSession: (session) => {
      startedSession = session
      produced.bindSession(session)
      options.onSession?.(session)
      startedSubscribers = options.subscribers?.({
        session,
        quarantined,
        mask,
        ...(produced.onMemberSnapshot === undefined ? {} : { onMemberSnapshot: produced.onMemberSnapshot }),
      })
      // Subscribed directly, never through `attachRunSubscribers`: its wire reporter can print to
      // stdout, which is the protocol on the MCP stdio server and `fn --json`.
      const record = options.runRecord.subscriber({
        mask,
        members: produced.members.map(({ name, testId, filePath, suiteId, suiteName }) => ({
          name,
          testId,
          filePath,
          ...(suiteId === undefined ? {} : { suiteId }),
          ...(suiteName === undefined ? {} : { suiteName }),
        })),
        gateRun: request.gateRun === true,
        ...(produced.onMemberSnapshot === undefined ? {} : { onMemberSnapshot: produced.onMemberSnapshot }),
        snapshots: {
          config: produced.subscriberSeed?.configSnapshot,
          source: produced.subscriberSeed?.sourceSnapshot,
        },
        ...(produced.subscriberSeed?.attributes === undefined
          ? {}
          : { attributes: produced.subscriberSeed.attributes }),
      })
      session.subscribe(REPLAY_FROM_START, record.handler)
      startedRecord = record
    },
    // Composed with the producer's knowledge root, so consult, enqueue and drain address one root.
    postVerdict: () => {
      const step = createPostVerdictStep({
        runId,
        agentQaRoot: options.agentQaRoot,
        knowledgeRoot: produced.knowledgeRoot,
        // The producer's resolved config file, so the enqueue's host is the project the run used.
        configPath: produced.configFilePath,
        // Conditionally spread on this file's house rule — an absent posture is an ABSENT field,
        // so the step's own defaults live in exactly one place.
        ...(options.postProcessing?.detach === true ? { detach: true as const } : {}),
        ...(options.postProcessing?.writerAuthority === undefined
          ? {}
          : { writerAuthority: options.postProcessing.writerAuthority }),
        log: { warn: options.warn ?? (() => { /* a door with no renderer drops the line */ }) },
        executionContext: options.executionContext,
      })
      postVerdictHandoff = step.handoff
      return step.port
    },
  })


  /**
   * The detached post-processing leg, once started. `undefined` for every door without one.
   *
   * Its presence is what MOVES the close-out below out of the drive's `finally` and onto this
   * promise's own — the two must never both run, and which one does is decided exactly once.
   */
  let detachedTail: Promise<void> | undefined
  let closedOut = false

  // Releases an untaken lease once, outermost: a re-thrown framework error skips `afterVerdict`.
  const closeOutRun = (): void => {
    if (closedOut) return
    closedOut = true
    releaseUntakenPostVerdictLease({
      handoff: postVerdictHandoff ?? UNCOMPOSED_POST_VERDICT,
      knowledgeRoot: produced.knowledgeRoot,
      runId,
      log: { warn: warnByName },
    })
  }
  let preparationDisclosureOwnedByDoor = false
  let preparationSettled = false
  const retainUntilSettled = (completion: Promise<unknown>): Promise<void> =>
    completion.then(() => undefined, () => undefined).finally(closeOutRun)
  const detach = (completion: Promise<unknown>): Promise<void> => {
    detachedTail = retainUntilSettled(completion)
    options.onPostRun?.(detachedTail)
    return detachedTail
  }

  return await runSafetyScope(
    { executionContext: options.executionContext },
    async (): Promise<CliRunOutcome> => {
      try {
        // The core refuses, assembles, starts and awaits the run. A refused request field or run id
        // throws from inside here, before a single run event exists.
        await core.execute({ ...request, runId: asRunId(runId) })
        const session = startedSession
        if (session === undefined) {
          // Unreachable: the core notifies `onSession` before it awaits the run. Asserted rather
          // than assumed, because a silently absent session would degrade into a run whose verdict
          // nothing mapped.
          throw new Error('The invocation core completed without reporting a run session.')
        }

        const { verdict } = await session.done
        const exitCode = options.freezeVerdict === undefined
          ? mapVerdictToExitCode(verdict as never)
          : options.freezeVerdict(verdict)
        await produced.finalize?.()
        // Await every subscriber flush after `done` and before publishing or re-throwing.
        await Promise.all([startedSubscribers?.flush(), startedRecord?.flush()])
        const postVerdictDeadlineMs = Date.now() + DRAIN_BUDGET_MS
        preparationSettled = await waitForPostVerdictContinuation(postVerdictHandoff?.completion,
          postVerdictDeadlineMs, options.postVerdictSignal)

        // A member-closure throw is a framework error, re-surfaced here for the exit-2 contract.
        const frameworkError = produced.takeFrameworkError()
        if (frameworkError !== undefined) throw frameworkError

        const verdictContext: CliRunVerdictContext = {
          runId,
          verdict,
          exitCode,
          mask,
          configDir: produced.configDir,
          configFilePath: produced.configFilePath,
          postVerdict: postVerdictHandoff ?? UNCOMPOSED_POST_VERDICT,
          postVerdictDeadlineMs,
        }
        const finalExitCode = options.afterVerdict === undefined
          ? exitCode
          : await options.afterVerdict(verdictContext)
        preparationDisclosureOwnedByDoor = options.afterVerdict !== undefined || options.postRunTail !== undefined
        if (options.postRunTail === undefined) {
          if (!preparationSettled && postVerdictHandoff?.completion !== undefined) {
            detach(postVerdictHandoff.completion)
          }
          return { runId, verdict, exitCode: finalExitCode,
            ...(detachedTail === undefined ? {} : { settled: detachedTail }) }
        }
        // Start the leg and return; the close-out travels with it.
        const settled = detach(Promise.allSettled([
          postVerdictHandoff?.completion,
          options.postRunTail(verdictContext)
          .catch((error: unknown) => {
            // In `ci` and `cloud` the line states the resume limit, not a promise.
            const resumeClause = ciResumeClause(options.executionContext, 'any-host')
            warnByName(
              `Run ${runId}: the post-run tail did not complete (`
              + `${error instanceof Error ? error.message : String(error)}`
              + (resumeClause !== undefined
                ? `); queued work ${resumeClause}.`
                : '); queued work will resume on the next run or when the daemon drains it.'),
            )
          }),
        ]))
        return { runId, verdict, exitCode: finalExitCode, settled }
      } finally {
        // The record flushes on every path; its own failure never replaces the run's.
        try {
          await startedRecord?.flush()
        } catch {}
        if (!preparationDisclosureOwnedByDoor && postVerdictHandoff?.completion !== undefined) {
          const handoff = postVerdictHandoff
          if (handoff.enqueueState === undefined) {
            warnByName(preparationPendingWarning(runId, handoff.pendingPath, options.executionContext))
          }
          void handoff.completion!.then(() => {
            if (handoff.failureDetail !== undefined) warnByName(handoff.failureDetail)
          }, () => warnByName(`Run ${runId}: analysis enqueue failed (enqueue-error). Durable intent: ${handoff.pendingPath}.`))
        }
        // The close-out runs HERE unless the detached tail took ownership of it.
        if (detachedTail === undefined && !preparationSettled && postVerdictHandoff?.completion !== undefined) {
          detach(postVerdictHandoff.completion)
        }
        if (detachedTail === undefined) closeOutRun()
      }
    },
  )
}

/**
 * Attach a door's standard bus subscribers. Exported so `agent-qa run` and a later dashboard door
 * reach ONE attach helper rather than each writing the argument fold themselves.
 */
export function cliRunSubscribers(input: {
  readonly console?: { verbose: boolean; logLevel: string } | false
  readonly junitOutputPath?: string | undefined
  readonly extraSubscribers?: Parameters<typeof attachRunSubscribers>[0]['extraSubscribers']
}): (attach: RunSubscriberAttachInput) => { flush(): Promise<void> } {
  return (attach) => attachRunSubscribers({
    session: attach.session,
    console: input.console ?? false,
    junitOutputPath: input.junitOutputPath,
    extraSubscribers: input.extraSubscribers,
    quarantined: attach.quarantined,
  })
}

/**
 * Assert at the type level that this module never terminates its host: the only way out of the
 * in-process path is a return or one of the three declared throws.
 *
 * A RUNTIME MARKER, NOT DOCUMENTATION. `in-process-exit-census.test.ts` scans this module and its
 * relative first-party import closure for any acquisition of the host-terminating call, and the
 * per-task tripwire greps this file for a comment-filtered `process.exit(` count of zero.
 */
export const IN_PROCESS_RUN_TERMINATES_NOTHING = true
