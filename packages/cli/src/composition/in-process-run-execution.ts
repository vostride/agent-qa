// THE ONE IN-PROCESS `agent-qa run` EXECUTION (Phase 401 plan 11, D-01/D-02/D-07).
//
// WHAT THIS FILE IS. `createRunInvocationCore` (401-03) made run assembly a PORT a door implements,
// which was right — members, the executor closure, reporters and the masking context are CLI
// vocabulary `agent-local` may not name. The consequence nobody planned for is that **no
// non-`run.ts` door could implement that port**: `assembleCliRun` requires `members` and `executor`,
// `RunsStartInput` carries neither, and the producer chain that turns one into the other lived
// unexported inside `run.ts`'s command body. 401-06 halted on exactly that wall.
//
// So this module is the assembly side of D-02: the composition that turns a bare `RunsStartInput`
// into a started in-process run. A door supplies its own posture and gets a run — without spawning
// `agent-qa run`, and without naming a single CLI option.
//
// IT COMPOSES THE CORE AND ASKS NOBODY. This module hands the core the door's `executionContext`
// and lets the core own the ORDER; the core starts every allowed request, whatever environment its
// targets declare. No confirm port, session trust or approval reader exists on this seam.
//
// IT READS NO AMBIENT EXECUTION CONTEXT (D-07). There is no `resolveRunExecutionContext()` call
// here, no `getActiveExecutionContext`, no TTY sniff: `executionContext` is a REQUIRED option with
// no default, so a door that supplies nothing gets a type error rather than a guess. Naming those
// two resolvers in this comment while never calling them is deliberate — it is the non-vacuity
// witness the source census in `in-process-exit-census.test.ts` leans on (the 401-03 idiom).
//
// WHY THE VOCABULARY STAYED IN `run.ts`, AND WHY THAT IS NOT LAZINESS. `packages/arch`'s FUNC-02
// surface firewall lets a file under `packages/cli` name only `@vostride/agent-qa-agent`,
// `-agent-local`, `-analytics` and `-schema`. Anything else needs an exact `(file, specifier)`
// ledger entry — the ledger **only ever shrinks**, and a file written after 2026-07-28 can never
// join it. `commands/run.ts` is the ONLY cli file ledgered for `android`, `core`, `dashboard`,
// `ios`, `model`, `runner`, `runner-local`, `safety`, `safety-local` and `web`. The platform, model
// and runner vocabulary therefore has exactly one legal home in this package, and it is the file it
// already lives in. So what moved here is the COMPOSITION; the producers stay in `run.ts` and are
// imported RELATIVELY (a relative path is not a package specifier and the firewall does not range
// it). A later reader who "tidies" the producers into a new file will be refused by the build.
//
// THE DOOR KEEPS PROCESS LIFECYCLE. Signal handlers, the grace timer, `releaseAppium()`, closing the
// dashboard db and the terminal exits stay in `run.ts`. This module computes, and returns or throws
// — including for every input failure, which becomes a `CliRunInputError` rather than a dead host
// (T-401-31). A library that can terminate its caller is a boundary of its own.
//
// A NON-ZERO EXIT CODE IS NOT AN ERROR. A failing suite exits non-zero and is a perfectly real run.
// This module throws only the core's run-id refusals and `CliRunInputError`.

import { asRunId, resolveEffectiveWorkers } from '@vostride/agent-qa-schema'
import type {
  MaskFn,
  QuarantineAppliedEntry,
  RunSession,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
// `@vostride/agent-qa-safety` vocabulary is not nameable from a cli file written after 2026-07-28
// (FUNC-02, and the ledger only shrinks).
//
// `runSafetyScope` and `mapVerdictToExitCode` reach this file through the
// composition root's `run-drive-vocabulary` module (401-11) — the drive RUNS the run, so it has to
// install the run's safety scope and map its verdict, and both of those live in packages this file
// may not name directly.
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
  /** The run's mask: the producer's redactor over the secrets read at its start (441-58, D-06). */
  readonly mask: MaskFn
  /**
   * The producer's snapshot channel (433-29, G-433-5): a door's dashboard ingest registers here to
   * stage each member's masked test and config onto the run's artifact. Absent when the producer
   * has none.
   */
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
  /**
   * This run's post-verdict handoff box (404 D-10) — the writer lease for the chain the shell's
   * step decided this process would pump.
   *
   * A DOOR'S TAIL MUST TAKE IT RATHER THAN CONSULT THE LEASE AGAIN. The step decided the posture
   * inside the shell, before `runFinished`; a tail that called `acquireWriterLease` for itself
   * after taking the authority would be answered `held` by its OWN process and would hand its work
   * off to nobody (RESEARCH Pitfall 3). Route it to the pump —
   * `postRunTail.drain({ takeLease: () => postVerdict.takeAcquiredLease() })` — so acquire → pump
   * → release stays one lease.
   *
   * 2026-08-26: TAKING IT IS WHAT ACQUIRES IT. The step's decision comes from a non-acquiring read,
   * so a door with no tail — or a run that dies above one — mutates no lease file and has nothing
   * to release. See `post-verdict-step.ts`'s header for the measurement that moved it.
   *
   * 2026-08-27 (CR-01): AND A THUNK IS WHY IT IS SAFE. Because taking acquires, the take may not
   * happen where an exception can still skip the release — which is what evaluating it as the
   * argument did. `drain()` calls the thunk itself, after the knowledge root is resolved and
   * inside the try whose `finally` releases.
   */
  readonly postVerdict: PostVerdictHandoff
}

/** What one in-process run answers with. A non-zero `exitCode` is a real run, not an error. */
export interface CliRunOutcome {
  readonly runId: string
  readonly verdict: string
  readonly exitCode: number
  /**
   * The DETACHED post-processing leg, still in flight (404 D-06).
   *
   * Present only when the door supplied a `postRunTail`. It never rejects — the drive catches and
   * warns — so awaiting it is safe and not awaiting it is the point: `execute()` resolving before
   * this settles is exactly what keeps `run-settled` off the drain's clock (RESEARCH Pitfall 2).
   * When it resolves, the untaken-lease backstop has run.
   */
  readonly settled?: Promise<void>
}

/**
 * What a door hands over to get a run. Everything here is something only a DOOR can answer.
 */
export interface InProcessCliRunExecutionOptions {
  readonly postVerdictSignal?: AbortSignal
  /** The config runs resolve against unless `request.configPath` names another. */
  readonly configPath: string
  /** `<configDir>/.agent-qa` — the root the function layer's evidence check reads (Pitfall 5). */
  readonly agentQaRoot: string
  /**
   * The context this door's runs start in and record.
   *
   * NO DEFAULT AND NO AMBIENT FALLBACK (D-07). A door that supplies nothing does not get a guess;
   * it gets a type error. That is what keeps this seam RPC-shaped for 402's authed service, and it
   * is why an injected value BEATS a varied process-global — asserted in
   * `in-process-run-execution.test.ts`.
   */
  readonly executionContext: RunExecutionContext
  /** Fired with the started session — the D-09 bridge hook 401-07 consumes. */
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
  /**
   * The seam a door with members of its own overrides.
   *
   * ABSENT ⇒ the pattern-based producer, which is MODE-AWARE and dispatches to the suite half
   * itself. That is a shipped contract rather than a nicety: a `runs.start` carries patterns and no
   * mode flag, so a request whose patterns resolve to a suite file runs a SUITE today, over the fn
   * door and the daemon door alike — as it did over the child port 401-10 deleted, which forwarded
   * the same patterns after a `--` operand separator. A single-test-shaped default would turn a live request into an input error.
   */
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
  /**
   * What this door wants the shell's POST-VERDICT step to do about post-processing (404 D-05/D-09).
   *
   * TWO INDEPENDENT FIELDS, NOT A MODE, because they are answers to two different questions and no
   * door supplies both:
   *
   *   - `detach` — `agent-qa run --detach`. Skip the LEASE; the durable enqueue still happens
   *     (RESEARCH Pitfall 8: detaching asks this process not to SPEND itself on the work, never to
   *     forget the work exists). The run reads `detached`.
   *   - `writerAuthority` — the DAEMON door, which already holds this project's writer lease and
   *     heartbeats it for its own lifetime. Handing it over is what lets the step report `drained`
   *     (D-09: a daemon-launched run drained by the daemon's own pump is drained) without calling
   *     `acquireWriterLease` — which would be answered `held` by this very process and hand the
   *     chain off to nobody (Pitfall 3, Open Q2).
   *
   * ABSENT ⇒ the ordinary consult: a probe of the lease, and `drained`/`handedOff`/`detached` off
   * what it found. That is what every other door gets, and it is byte-identical to 404-01.
   */
  readonly postProcessing?: {
    readonly detach?: true
    readonly writerAuthority?: CurationWriterAuthority
  }
  /**
   * The DETACHED post-processing leg, for doors whose `execute()` promise something else waits on.
   *
   * WHY DETACHED AND NOT AWAITED (D-06, RESEARCH Pitfall 2). `dashboard-server`'s in-process
   * backend emits `'run-settled'` — the db finalize, the Appium lease release, the handle cleanup —
   * when the `invokeRun` promise settles. A drain awaited inside `execute()` would hold all three
   * for up to `DRAIN_BUDGET_MS`, so the runs list would keep showing "running" for a minute after
   * the verdict and a leased device would stay leased. The run's lifecycle ends at `runFinished`;
   * curation is post-processing (D-07), and this option is where that sentence becomes code.
   *
   * The drive hands its close-out to this leg, which runs it once the leg settles (404 D-06).
   *
   * IT RUNS AFTER `afterVerdict` HAS SETTLED, so a door supplying both gets them in that order and
   * never concurrently. A throw is caught and warned by name — post-processing may never cost the
   * verdict (JOBQ-06) — and the untaken-lease backstop still runs behind it.
   *
   * THE IN-FLIGHT PROMISE IS RETURNED on the outcome as `settled`, so a caller that DOES want to
   * wait (a cell; a host that later decides `run-settled` should include curation) can, without the
   * drive deciding that for everyone.
   */
  readonly postRunTail?: (context: CliRunVerdictContext) => Promise<void>
  /**
   * Handed the run's detached post-run work, the same promise as the outcome's `settled`, the
   * moment the drive starts it. It is called on every path that starts such work, including a run
   * that then re-raises a member's framework error and so returns no outcome.
   */
  readonly onPostRun?: (settled: Promise<void>) => void
  /** Where a quarantine-fold warning goes. The door owns its rendering. */
  readonly warn?: (message: string) => void
  /**
   * An Appium the DOOR has already leased for this run (401-07, D-12 — INVK-01 truth 5).
   *
   * IT TAKES THE RUN ID, AND ONLY THIS SEAM CAN BIND IT. A door composes this port ONCE and serves
   * many runs through it, but a lease belongs to one run — so the door answers per run id and the
   * drive, which is the one place the id is decided (`request.runId ?? mintCliRunId()`), binds it
   * before handing the producer a zero-argument resolver. A producer that had to know about run ids
   * to ask about a device would be a producer that knows about the door's bookkeeping.
   *
   * THE OPTION LANDS IN THE SAME CHANGE AS ITS CONSUMER, deliberately (401-03's own reason for not
   * adding it: an option nothing reads is a stub with a type on it). Absent leaves the shipped
   * order — `AGENT_QA_APPIUM_URL`, then the bundled auto-start — byte for byte.
   */
  readonly resolveAppiumUrl?: (runId: string) => string | undefined
  /**
   * Per-run flags a door's own UI offers that `RunsStartInput` has no field for (401-07).
   *
   * EXACTLY ONE MEMBER TODAY, AND DELIBERATELY NOT `RunOptions`. The dashboard has shipped a
   * "no cache" checkbox since v1; it reached a run as the `--disable-cache` OPERAND of a spawned
   * `agent-qa run`, and there is no operand any more. Dropping it silently would give a person who
   * ticked that box a cached answer, which is worse than the box not existing.
   *
   * The wide type was refused on purpose: handing a door `RunOptions` would let it reach flags this
   * seam has no business honouring (the since-deleted session trust flag above all), and every one
   * of them would be a policy input arriving through a producer's back door. This grows one named field at a time, and
   * each addition is a decision somebody makes.
   *
   * The RIGHT long-term home is a field on `RunsStartInput` — the request is the contract, and a
   * per-run fact that travels beside the request is a second channel. That is a schema change with
   * an ack contract behind it, so it is filed rather than smuggled in here.
   */
  readonly resolveRunFlags?: (runId: string) => { readonly disableCache?: boolean } | undefined
}

// 2026-10-18 (444-14, D-22): in `ci` and `cloud` the line states the resume limit, not a promise.
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

/**
 * Run ONE `agent-qa` run, in this process.
 *
 * The order is the load-bearing part, and every step of it is somebody's answer rather than this
 * function's opinion:
 *
 *   1. resolve the inputs (reads only) — or take the door's, if it already has them;
 *   2. mint or accept the run's identity;
 *   3. produce members and an executor — mode-aware by default, overridable by a door with its own;
 *   4. build the audit sink and safety-hook runner, and bind the hooks back into the producer;
 *   5. compose the core, which owns the run-id check, assembly and start order;
 *   6. inside the run's safety scope: execute, await `done`, finalise, flush, re-surface a member's
 *      framework error, map the verdict, and let the door's tail have the last word on the code.
 *
 * NO DEFENSIVE CATCH ANYWHERE (D-03). Crash-through is the accepted posture; the runner's
 * budget/abort machinery is the orderly containment. The `finally` below closes the run out and
 * does nothing else.
 */
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

  // 2026-10-15 (441-30, D-12/D-15): no per-run hook registrar is built or bound; the run's loop
  // gets no hook port. 441-31 (D-15): and no guardrail audit sink is built for it.

  let quarantined: readonly QuarantineAppliedEntry[] = []
  let startedSession: RunSession | undefined
  let startedSubscribers: { flush(): Promise<void> } | undefined
  let startedRecord: { flush(): Promise<void> } | undefined
  /**
   * This run's post-verdict handoff box (404 D-10), captured when the core builds the step.
   *
   * ONE VARIABLE RATHER THAN A MAP KEYED BY RUN ID: this drive serves exactly one run — the id is
   * decided a few lines above and the core is constructed around it — so a keyed collection would
   * be a cache whose only entry is this run's, and nothing would ever evict it.
   *
   * `UNCOMPOSED_POST_VERDICT` is what a door reads if the run never reached assembly. It is not a
   * stub standing in for a real box: a run whose step was never built acquired no lease, so the
   * honest answer to "what did your step acquire" is `undefined` — and a required field beats an
   * optional one here, because a tail that forgot to take the lease is the defect this seam exists
   * to prevent, and an optional member is a member a door forgets.
   */
  let postVerdictHandoff: PostVerdictHandoff | undefined

  const core = createRunInvocationCore({
    configPath,
    agentQaRoot: options.agentQaRoot,
    executionContext: options.executionContext,
    mintRunId: mintCliRunId,
    // 401-20 (CR-04): the shape predicate, from the package that owns the mint. REQUIRED on the
    // core with no default, so this line is not a policy this door chose — its absence is a
    // compile error.
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
        // 402-03 (D-12): THE ONE PLACE THE WORKER COUNT IS APPLIED, for every door.
        //
        // The formula is `@vostride/agent-qa-schema`'s and is called exactly here, on the pair the
        // PRODUCER read out of the resolved config and the member count the producer assembled.
        // A caller cannot reach it: `RunsStartInput` names neither field (strict, pinned in
        // `runs-start-input-posture.test.ts`) and nothing on this drive's options carries one, so
        // the only input to concurrency is a config the target's owner wrote.
        //
        // A producer that reported no pair — a door that brought its own members and read no
        // config — resolves to 1, which is the shipped sequential behaviour rather than a guess.
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
      // D-23 live bind, behind the verdict and with the ordinal it reads.
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
    // 404 D-05/D-10: the post-verdict step, composed HERE and threaded by the core so no door can
    // forget it. It speaks writer-lease vocabulary `agent-local`'s runner seam may not name, which
    // is exactly why the core takes a factory rather than building one.
    //
    // The knowledge root is the producer's already-resolved value, not a second resolution: the
    // consult, the enqueue and the drain must address ONE root.
    postVerdict: () => {
      const step = createPostVerdictStep({
        runId,
        agentQaRoot: options.agentQaRoot,
        knowledgeRoot: produced.knowledgeRoot,
        // The PRODUCER's resolved config file, not the raw `configPath` this drive was handed: the
        // enqueue's host is composed against the project the run actually resolved, and the tail
        // composes its own host from the same value one layer up (D-05).
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

  /**
   * Release whatever lease nobody took. Exactly once, whoever runs it.
   *
   * 404 D-10, the structural no-leak rule: any lease still in the box here is a lease "released
   * untaken". If the tail took it this is a no-op; if something filled the box ahead of a pump
   * that never came, the lease is released HERE and the fact is named, rather than left to expire
   * on its TTL while every reader of the wire believes somebody is draining.
   *
   * IT IS THE OUTERMOST THING, NOT SOMETHING AROUND `afterVerdict`, and the difference is a
   * measured one (404-01): a framework error re-thrown above `mapVerdictToExitCode` skips
   * `afterVerdict` entirely, and a release scoped to that call left the lease held for its whole
   * TTL — the very posture this rule exists to prevent, on the ONE path most likely to produce it.
   *
   * 2026-08-26: it ACQUIRES NOTHING to check. The step's acquisition is lazy, so that same
   * framework-error path now arrives here with an empty box and this call is silent — the
   * `released untaken` line stopped being ordinary run output, which is what
   * `run-parity.e2e.test.ts` measures. The backstop stays because the box can still be filled by a
   * host that supplies its own authority (the daemon door).
   *
   * 404 D-06: the drive's `finally` runs this only when no detached leg was started, and the leg's
   * own `finally` runs it otherwise; `detachedTail`'s presence decides which, once.
   */
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
        // Pitfall 6/8: await EVERY subscriber flush (junit write, dashboard finalize, analytics
        // drain) AFTER `done` and BEFORE publishing the result or re-throwing a framework error.
        await Promise.all([startedSubscribers?.flush(), startedRecord?.flush()])
        const postVerdictDeadlineMs = Date.now() + DRAIN_BUDGET_MS
        preparationSettled = await waitForPostVerdictContinuation(postVerdictHandoff?.completion,
          postVerdictDeadlineMs, options.postVerdictSignal)

        // A throw out of a member closure is a framework/setup error rather than a test failure:
        // the shell absorbs executor throws into failed members (D-13), so the producer captured
        // the first one and it is re-surfaced here to preserve the exit-2 contract.
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
        // 404 D-06 / RESEARCH Pitfall 2: START it and RETURN; the close-out travels with it.
        const settled = detach(Promise.allSettled([
          postVerdictHandoff?.completion,
          options.postRunTail(verdictContext)
          .catch((error: unknown) => {
            // 444 D-48: in `ci` and `cloud` the line states the resume limit, not a promise.
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
        // 2026-10-17 (443-14, GAP-D2; 444-09, D-16): the record flushes on every path and closes its own
        // row when it saw no verdict or a failed write; a repeat flush is a no-op, and a failure here
        // never replaces the run's.
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
