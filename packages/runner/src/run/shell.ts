// The run shell — `startRun` and the RunSession it returns (D-01, SESSION-01/02/04/05). This is
// the run lifecycle every later surface attaches to: it owns the bus, seq, the bounded member
// pool (402-02 D-09 — N members concurrent in the run's process, `workers` default 1, exclusive
// lanes for members that share a mutable execution resource), group-scoped fail-fast skip
// production (absorbed from suite/runner.ts:530-554),
// run-level cancel + wall-clock budget (D-03), the aggregate-verdict emission, and the one-per-run
// handoff assembly + persistence (D-17). It carries ZERO verdict logic (deriveMemberOutcome/
// deriveAggregateVerdict/classifyRootCause own it) and ZERO fs/provider access (validate:arch
// storageNeutral) —
// per-test execution stays behind the injected `executor` port, every I/O leg behind a run port.
//
// Terminal sequence is owned by ONE code path (RESEARCH Pitfall 7): compute the aggregate verdict,
// publish `verdict` EXACTLY once (before any post-processing event, SESSION-02), set the terminal
// status, assemble + persist the handoff (a store failure degrades with a runWarning and NEVER
// gates `done`, D-07), finalize the run artifact, AWAIT the post-verdict step, resolve `done`
// (which NEVER rejects, D-13/D-17), then publish `runFinished` LAST with the DECIDED disposition
// and `finalSeq` equal to its own seq, and close the bus.
//
// 2026-08-26 (Phase 404 D-09/D-10) supersedes the sentence above that had `runFinished` publish
// the hardcoded detached literal: the value is no longer a literal. Between `runArtifactStore.finalize`
// and `runFinished` the shell awaits ONE host-supplied `ports.postVerdict` step — the durable
// enqueue plus a single writer-lease consult — and publishes whatever posture it decided. That
// step is BOUNDED by `POST_VERDICT_STEP_BUDGET_MS` and degrades in every direction: absent, thrown,
// warned or overrun all read `detached`, three of the four with a named `runWarning`. It NEVER
// gates `done`, it publishes nothing itself, and `cancelBudget` / `liveStreams.close()` /
// `bus.close()` are untouched behind it — so `done` still resolves after `runFinished` and a closed
// bus (403-03 D-3).
//
// The six post-processing chip events have no producer HERE — the chain pump emits them, one per
// job outcome it observes (404-05). What this file owns of post-processing is the awaited step
// above and the disposition it publishes; the chips are somebody else's line on the bus.

import type {
  MaskFn,
  MemberTestOutcome,
  PerTestOutcome,
  PostProcessingDisposition,
  RunCompletion,
  RunSession,
  RunStatus,
} from '@vostride/agent-qa-schema'
import {
  CURRENT_BUS_SCHEMA_VERSION,
  projectTestFinished,
  quarantineAppliesToTest,
} from '@vostride/agent-qa-schema'
import { createRunEventBus } from './bus.js'
import { createLiveStreamHub } from './live-stream-hub.js'
import { deriveAggregateVerdict, deriveMemberOutcome } from './verdict.js'
import { classifyRootCause } from './root-cause.js'
import { createMemberEventSink } from './event-sink.js'
import { assembleHandoff, assemblePerTestOutcome, skippedPerTestOutcome } from './handoff-assembly.js'
import type { MemberEvidenceContext, PostVerdictOutcome, RunConfig, RunTimerPort } from './ports.js'
import { POST_VERDICT_STEP_BUDGET_MS } from './ports.js'
import type { RunMemberDescriptor } from './ports.js'
import type { TestResult } from '../result.js'
import { redactSecretValue } from '../loop/secrets.js'

// Re-export the port contracts the Wave-0 `run-shell.test.ts` imports through `../shell.js`.
export type {
  RunConfig,
  RunMemberDescriptor,
  MemberTestExecutor,
  MemberTestRunContext,
} from './ports.js'

/**
 * The budget's own answer, as a VALUE rather than a rejection (404 D-10).
 *
 * A sentinel keeps the two outcomes in one type, so the shell's `catch` stays reserved for what a
 * throw actually means — the STEP failed — rather than absorbing the timeout as if the host's code
 * had raised. `unique symbol` makes the narrowing exhaustive at the one comparison site.
 */
const POST_VERDICT_TIMED_OUT: unique symbol = Symbol('post-verdict-budget-expired')

/**
 * Race a promise against a bounded one-shot, on the run's OWN clock when it has one.
 *
 * `ports.timer` is the post-verdict bound's clock, kept apart from the bus heartbeat, so a unit pin
 * that fires the fake timer drives this bound deterministically; without one, a real unref'd
 * `setTimeout` bounds it exactly as the bus's default clock does. The timer is ALWAYS cancelled —
 * a bound that outlived the race it bounded would keep the process alive past a run that had
 * already finished.
 *
 * The loser is not cancelled, and cannot be: a promise the host handed over has no abort seam. A
 * step that answers after the budget answers into a void, which is what "detached" already means.
 */
async function raceWithBudget(
  work: Promise<PostVerdictOutcome>,
  budgetMs: number,
  timer: RunTimerPort | undefined,
): Promise<PostVerdictOutcome | typeof POST_VERDICT_TIMED_OUT> {
  let cancel: (() => void) | undefined
  const expiry = new Promise<typeof POST_VERDICT_TIMED_OUT>(resolve => {
    if (timer !== undefined) {
      cancel = timer.schedule(budgetMs, () => resolve(POST_VERDICT_TIMED_OUT))
      return
    }
    const handle = setTimeout(() => resolve(POST_VERDICT_TIMED_OUT), budgetMs) as unknown as {
      unref?: () => void
    }
    handle.unref?.()
    cancel = () => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  })
  try {
    return await Promise.race([work, expiry])
  } finally {
    cancel?.()
  }
}

/**
 * Does the run-start quarantine snapshot license this member's failure (390 D-14/D-16)?
 *
 * The match is on STABLE TEST IDENTITY — the member's `filePath` plus its parsed `name`, which is
 * the `testName` leg the ledger keys on — never `testId`, a per-run explicit id that would not
 * survive to the next build. `product` is not compared: the composition layer already filtered the
 * snapshot to this run's product before handing it over (D-16).
 *
 * The comparison itself is schema's `quarantineAppliesToTest` and not a local copy (390-07): the
 * CLI reporters have to reach the SAME answer about the same member, and two spellings of one rule
 * can disagree without failing to compile.
 */
function isMemberQuarantined(
  member: RunMemberDescriptor,
  quarantined: RunConfig['quarantined'],
): boolean {
  return quarantineAppliesToTest(quarantined, {
    filePath: member.filePath,
    testName: member.name,
  })
}

/**
 * A member's HANDLE index (402-04, D-10) — the identity every member-scoped payload is stamped
 * with and the identity the `runStarted` roster announces.
 *
 * ONE expression, used at both sites. The roster and the stamps are two readings of the same
 * question, and a run whose announced handles did not match the handles its events carry would
 * make every per-handle attach a guess: a client would ask for a handle the roster offered and be
 * served an empty stream, with nothing anywhere saying which of the two was wrong.
 */
function memberHandleIndex(member: RunMemberDescriptor, index: number): number {
  return member.testIndex ?? index
}

/**
 * Start a run (D-01). Constructs the session SYNCHRONOUSLY — the bus, `runStarted` at seq 1, the
 * run-budget arm, the run-level AbortController — then kicks the async member pool whose settled
 * result feeds `done`. Returns the addressable {@link RunSession} immediately.
 *
 * 402-02 (D-09): members execute through a BOUNDED CONCURRENT POOL rather than a `for` loop, but
 * everything after it is unchanged — the terminal sequence is still ONE code path, run once, after
 * the pool settles. Concurrency changes which member is in flight when; it does not change who
 * publishes the verdict, or when `runFinished` is last.
 */
export function startRun(config: RunConfig): RunSession {
  const mask: MaskFn = (text) => redactSecretValue(text, config.secretRedactor)
  const ports = config.ports ?? {}
  const timer = ports.timer

  // The bus heartbeat runs on its own default clock — the injected `ports.timer` is reserved for
  // the run-budget so that firing it in a test is unambiguous (heartbeat re-arm on every publish
  // would otherwise clobber the budget on a single shared fake timer).
  const bus = createRunEventBus({ runId: config.runId, eventLog: ports.eventLog })

  // 403 D-05: ONE frame hub per run. Frames are DATA on a side channel — the hub publishes no bus
  // event of its own, and its only bus contact is the existing `runWarning` degrade channel, so
  // the frozen `RUN_EVENT_TYPES` list gains nothing (LIVE-03).
  const liveStreams = createLiveStreamHub({
    ...(ports.timer === undefined ? {} : { timer: ports.timer }),
    onWarning: (code, message) => {
      bus.publish('runWarning', { code, message })
    },
    // WR-06 (403): a SUBSCRIBER's fault is a fact about the subscriber, not about the run, so it is
    // never published on the bus — `runWarning` is durable, replayed to every later reader and
    // rendered on the live page, and a viewer closing a tab at the wrong instant must not write a
    // row into the run's permanent transcript (LIVE-03). The hub still DETACHES the faulty
    // subscriber. WHERE the fault goes is the host's decision (403-13): forwarded by reference under
    // the conditional-spread rule, so an absent port stays an absent field rather than an invented
    // non-destination.
    ...(ports.onSubscriberFault === undefined ? {} : { onSubscriberFault: ports.onSubscriberFault }),
  })

  const startedAt = timer?.now() ?? Date.now()

  // runStarted — seq 1, carrying the bus schema version + the D-04 header fields, plus (402-04,
  // D-10) the HANDLE ROSTER: the identities the per-member sinks are about to stamp. It rides as
  // an ADDITIVE payload field beside `memberTestCount` — never a new event type, because the
  // `RUN_EVENT_TYPES` list is frozen/append-only and a second event vocabulary on the wire is
  // exactly what D-13 exists to prevent. Derived through `memberHandleIndex` so the roster and the
  // stamps below cannot drift: there is one expression for "which member is this", used twice.
  bus.publish('runStarted', {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: config.scope,
    executionContext: config.executionContext,
    buildOrdinal: config.buildOrdinal,
    configDigests: config.configDigests,
    memberTestCount: config.members.length,
    handles: config.members.map(memberHandleIndex),
  })

  // D-08: stage the config + source artifact snapshot into the run dir once, right after
  // runStarted. Fire-and-forget (sync) — a store throw degrades with a runWarning and NEVER gates
  // the run (D-07). Absent store ⇒ no-op; absent snapshot ⇒ an empty (schema-version-only) stage.
  try {
    ports.runArtifactStore?.stage(config.runArtifact ?? {})
  } catch (error) {
    bus.publish('runWarning', {
      code: 'artifact-stage-failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let status: 'running' | RunStatus = 'running'
  let runCancelled = false
  const runController = new AbortController()

  const done: Promise<RunCompletion> = (async (): Promise<RunCompletion> => {
    const memberCount = config.members.length
    // 402-02 (D-09): INDEX-ADDRESSED outcome slots, pre-sized, assigned by member index — the
    // replacement for the pre-402 lockstep `push` trio. The aggregate rule reads these three
    // arrays POSITIONALLY, so under a concurrent pool "append in completion order" silently
    // re-attributes every member's outcome to whoever finished in its position. Appending is
    // therefore not a style choice here; it is the tampering surface (T-402-07). A slot is written
    // exactly once, by exactly one `runMember(i)`, and the compaction below refuses to guess about
    // a hole.
    const outcomeSlots: (PerTestOutcome | undefined)[] = new Array<PerTestOutcome | undefined>(
      memberCount,
    )
    const memberOutcomeSlots: (MemberTestOutcome | undefined)[] = new Array<
      MemberTestOutcome | undefined
    >(memberCount)
    const memberQuarantinedSlots: (boolean | undefined)[] = new Array<boolean | undefined>(
      memberCount,
    )
    const poisonedGroups = new Set<string>()

    /**
     * ONE member's execution — the pre-402 loop body, extracted intact. Every seam is preserved in
     * place: abort-skip, group fail-fast skip, the `testStarted` publish, the member
     * AbortController chained to the run controller, the executor-vs-abort race, outcome
     * derivation, group poisoning, root-cause classification, handoff assembly, `testFinished`.
     * The ONLY changes are `continue` → `return` and `push` → indexed assignment.
     *
     * The fail-fast decision (RESEARCH open Q1, legislated by 402-02): poisoning prevents a NEW
     * member from STARTING; members already in flight run to completion. That falls out of where
     * the check sits — it is evaluated when this function is entered, i.e. exactly at the moment a
     * member starts — and it is the reading that matches the shipped abort-skip idiom, which also
     * only ever refuses to start work rather than killing work already begun.
     */
    const runMember = async (i: number): Promise<void> => {
      const member = config.members[i]
      const testIndex = memberHandleIndex(member, i)
      const name = member.name
      const quarantined = isMemberQuarantined(member, config.quarantined)
      const quarantineMarker = quarantined ? (true as const) : undefined

      // Run aborted (cancel or budget) — skip the rest without invoking the executor (D-03).
      // 2026-10-17 (444-08, D-34): published like the fail-fast skip, so every surface lists it.
      if (runController.signal.aborted) {
        const skip = skippedPerTestOutcome(member, testIndex, quarantineMarker)
        outcomeSlots[i] = skip
        memberOutcomeSlots[i] = 'skipped'
        memberQuarantinedSlots[i] = quarantined
        bus.publish('testFinished', projectTestFinished(skip, mask, {
          recording: { state: 'absent', reason: 'not-captured' },
          name: member.name,
          filePath: member.filePath,
        }))
        return
      }

      // Group fail-fast (D-15): a poisoned same-group predecessor skips this member — shell-owned
      // skip production absorbed from suite/runner.ts:530-554; the executor is never invoked.
      if (member.failFastGroup !== undefined && poisonedGroups.has(member.failFastGroup)) {
        const skip = skippedPerTestOutcome(member, testIndex, quarantineMarker)
        outcomeSlots[i] = skip
        memberOutcomeSlots[i] = 'skipped'
        memberQuarantinedSlots[i] = quarantined
        bus.publish('testFinished', projectTestFinished(skip, mask, {
          recording: { state: 'absent', reason: 'not-captured' },
          name: member.name,
          filePath: member.filePath,
        }))
        return
      }

      // 363 D-01: enrich testStarted with the member descriptor's parity fields (filePath, suite
      // grouping, totalSteps). Suite grouping rides testStarted — the shell stays suite-agnostic
      // (no suite lifecycle events); reporters derive boundaries by watching the grouping change.
      // Absent optionals are omitted via conditional spread so no undefined-hole survives round-trip.
      // Every field but stepTexts is structural identity (not a captured stream) — not masked, matching
      // testId/name. stepTexts (G-428-2) is authored step content, so it is masked here by `mask`, the
      // same run redactor the member's event sink below masks stepStarted.stepText with.
      bus.publish('testStarted', {
        testId: member.testId,
        testIndex,
        name,
        ...(member.filePath !== undefined ? { filePath: member.filePath } : {}),
        ...(member.suiteId !== undefined ? { suiteId: member.suiteId } : {}),
        ...(member.suiteName !== undefined ? { suiteName: member.suiteName } : {}),
        ...(member.suiteIndex !== undefined ? { suiteIndex: member.suiteIndex } : {}),
        ...(member.suiteTotal !== undefined ? { suiteTotal: member.suiteTotal } : {}),
        ...(member.totalSteps !== undefined ? { totalSteps: member.totalSteps } : {}),
        ...(member.stepTexts !== undefined ? { stepTexts: member.stepTexts.map(mask) } : {}),
      })

      // Member abort chained to the run controller so run-level cancel/budget aborts the active test.
      const memberController = new AbortController()
      const onRunAbort = (): void => memberController.abort()
      if (runController.signal.aborted) memberController.abort()
      else runController.signal.addEventListener('abort', onRunAbort, { once: true })

      const events = createMemberEventSink({ bus, mask, testIndex })
      let evidenceContext: MemberEvidenceContext | undefined

      // Race the executor against member-abort (SESSION-04). A member wedged on a genuinely-
      // pending async op that never observes `ctx.abortSignal` (the planner's retry-without-image
      // window) would otherwise block `await config.executor(...)` forever, so `done` never settles,
      // the terminal sequence never runs, and `bus.close()` never clears the heartbeat — the live
      // Ctrl+C hang. Racing lets the loop finalize the wedged member as `cancelled` and reach the
      // ONE terminal sequence even when the executor never settles. The unit suite missed this
      // because its `abortableExecutor` resolves the instant abort fires (executor-settles branch).
      type RaceOutcome =
        | { kind: 'result'; result: TestResult }
        | { kind: 'error'; error: unknown }
        | { kind: 'aborted' }

      // The `.then(onResolve, onReject)` mapping attaches a rejection handler to the executor promise
      // synchronously, so a member that settles (or rejects) AFTER the run raced past it can never
      // surface as an unhandled rejection — the swallow is structural, no extra `.catch` needed.
      // 444-17 (D-52): the member's own clock, so a result the shell builds below keeps the time
      // the member ran. Only members dispatched here have one; an abort-skipped member keeps 0.
      const memberStartedAt = performance.now()
      const executorRaced: Promise<RaceOutcome> = config
        .executor(member, {
          runId: config.runId,
          abortSignal: memberController.signal,
          testIndex,
          events,
          setEvidenceContext(context) {
            evidenceContext = context
          },
          evidenceArtifacts: ports.evidenceArtifacts,
          registerLiveStream(capability, fallback) {
            liveStreams.register(testIndex, capability, fallback)
          },
        })
        .then(
          (r): RaceOutcome => ({ kind: 'result', result: r }),
          (error): RaceOutcome => ({ kind: 'error', error }),
        )

      let onMemberAbort: (() => void) | undefined
      const abortRaced: Promise<RaceOutcome> = memberController.signal.aborted
        ? Promise.resolve<RaceOutcome>({ kind: 'aborted' })
        : new Promise<RaceOutcome>((resolve) => {
            onMemberAbort = (): void => resolve({ kind: 'aborted' })
            memberController.signal.addEventListener('abort', onMemberAbort, { once: true })
          })

      let raced: RaceOutcome
      try {
        raced = await Promise.race([executorRaced, abortRaced])
      } finally {
        runController.signal.removeEventListener('abort', onRunAbort)
        if (onMemberAbort) memberController.signal.removeEventListener('abort', onMemberAbort)
      }

      let result: TestResult
      if (raced.kind === 'result') {
        result = raced.result
      } else if (raced.kind === 'error') {
        // An executor throw is never silent and never crashes the run (T-361-10): a runWarning
        // plus a synthesized failed result keep termination on the verdict + runFinished path.
        bus.publish('runWarning', {
          code: 'member-executor-error',
          message: raced.error instanceof Error ? raced.error.message : String(raced.error),
        })
        result = {
          name: member.testId,
          filePath: `${member.testId}.test.ts`,
          status: 'failed',
          steps: [],
          duration: performance.now() - memberStartedAt,
        }
      } else {
        // Abort won the race — the member did not settle after run-level cancel/budget. Finalize it
        // as `cancelled` through the SAME deriveMemberOutcome/assemblePerTestOutcome helpers below so
        // the "exactly one handoff / verdict once / runFinished last" invariants stay intact. The
        // aggregate verdict is still run-level-first (deriveAggregateVerdict: cancel⇒cancelled,
        // budget⇒timeout), so this member's own 'cancelled' outcome never changes the aggregate.
        result = {
          name,
          filePath: `${member.testId}.test.ts`,
          status: 'cancelled',
          steps: [],
          duration: performance.now() - memberStartedAt,
        }
      }

      // 403 D-05: the member's race has settled (result, executor error or abort) — its browser is
      // on its way down, so the handle withdraws its declaration here and reads `{ kind: 'none' }`
      // from now on. Placed at the ONE site every arm converges on, so no arm can forget it.
      liveStreams.register(testIndex, undefined)

      const outcome = deriveMemberOutcome(result)
      // 390 D-14 (CR-01, measured 2026-08-05): the disposition licenses this member's failure at the
      // AGGREGATE rule, and it must license it HERE too — this is the one site that decides whether
      // OTHER tests run. `run.ts:1961` puts every member of a suite in one `failFastGroup`
      // unconditionally, so an unguarded poisoning by a quarantined failure skips every remaining
      // member of that suite; those skips are neutral in `deriveAggregateVerdict`, and a run holding
      // a genuinely failing, NON-quarantined test answers 'passed' at exit 0 where pre-390 it exited
      // 1. Both outcome arms are guarded because the aggregate rule skips both (a licensed flake that
      // times out is the same phenomenon). A NON-quarantined failure still poisons its group exactly
      // as before — the disposition changes nothing where none applies.
      if (
        (outcome === 'failed' || outcome === 'timeout') &&
        member.failFastGroup !== undefined &&
        !quarantined
      ) {
        poisonedGroups.add(member.failFastGroup)
      }

      // 373-07 §A9 root-cause classification (D-05, RCC-02) — this is the ONE seam where `result`
      // (the TestResult, carrying retryCount), `outcome`, and `testIndex` coexist (RESEARCH
      // Pitfall 3): classify HERE, never against the assembled PerTestOutcome. The shell carries
      // zero verdict logic — this call is the only addition; root-cause.ts owns every branch.
      // 401-19 (WR-04): THE MEMBER'S OWN BASELINE. `member` is already in scope here, which is
      // what makes per-member attribution possible without a second lookup; a run-level value read
      // off `config` was applied to every member, so one target's health reading became another
      // target's diagnosis.
      const rootCause = classifyRootCause({
        result,
        outcome,
        testIndex,
        ...(member.baselineProbe === undefined ? {} : { baselineProbe: member.baselineProbe }),
        mask,
      })

      // 420 D-06: classify actual original evidence with this same member's baseline.
      // The final retry keeps its own classification, outcome and canary markers.
      const firstFailure = result.firstFailedAttempt
      const originalOutcome = firstFailure === undefined
        ? undefined
        : deriveMemberOutcome(firstFailure.result)
      const origin = firstFailure !== undefined &&
        (originalOutcome === 'failed' || originalOutcome === 'timeout')
        ? {
            runId: config.runId,
            outcome: originalOutcome,
            rootCause: classifyRootCause({
              result: firstFailure.result,
              outcome: originalOutcome,
              testIndex,
              ...(member.baselineProbe === undefined ? {} : { baselineProbe: member.baselineProbe }),
              mask,
            }),
          }
        : undefined

      const perTest = assemblePerTestOutcome(
        member,
        result,
        outcome,
        {
          testIndex,
          scope: config.scope,
          buildOrdinal: config.buildOrdinal,
          mask,
          ...evidenceContext,
          ...(quarantineMarker !== undefined ? { quarantined: quarantineMarker } : {}),
        },
        rootCause,
        origin,
      )
      outcomeSlots[i] = perTest
      memberOutcomeSlots[i] = outcome
      memberQuarantinedSlots[i] = quarantined
      // 363 D-01: enrich testFinished with the TestResult the shell already holds at assembly —
      // durationMs, retryCount, and the masked failureSummary (masked by projectTestFinished's
      // terminal walk, T-363-05). Absent optionals are omitted (Pitfall 2 — sourced from the runner
      // result, never new fields on the §A8 PerTestOutcome DTO).
      bus.publish(
        'testFinished',
        projectTestFinished(perTest, mask, {
          durationMs: result.duration,
          failureSummary: result.failureSummary,
          retryCount: result.retryCount,
          ...(result.recording !== undefined ? { recording: result.recording } : {}),
        }),
      )
    }

    // ---- The bounded member pool (402-02, D-09) ----------------------------------------------
    //
    // `workers` defaults to 1, and at 1 this is a plain sequential loop over `runMember(0..n-1)` —
    // the generalization is meant to be a superset of the shipped behavior, not a rewrite of it,
    // and the workers=1 parity control in `run-shell.concurrency.test.ts` compares the whole event
    // stream against a fixture captured BEFORE this code existed.
    //
    // Effective concurrency is min(members, workers) and the request cannot raise it (D-12): the
    // value arrives on the resolved RunConfig from config, never from a caller's payload, so an
    // unbounded-concurrency denial-of-service (T-402-08) has no reachable input.
    //
    // EXCLUSIVE LANES are the part that is NOT a scheduling nicety. Members that declare the same
    // `exclusiveLane` share a mutable execution resource and are run strictly one at a time, in
    // index order. Today's suite path is exactly such a set: every member of every suite drives the
    // ONE `suiteConfig.adapter` its suite set up (verified 2026-08-24, the RESEARCH A2 read), and
    // `createSuiteLifecycle` additionally admits one active suite at a time. Pooling over that
    // would interleave two tests on one browser page. The direct path is the opposite — each direct
    // test constructs its OWN adapter inside its own closure — and declares no lane, so it pools.
    // D-09's "each member its own browser/CDP handle" is therefore a PRECONDITION the descriptor
    // states, not an assumption the pool makes.
    const requestedWorkers = Math.floor(config.workers ?? 1)
    const workerCount = Math.max(
      1,
      Math.min(memberCount, Number.isFinite(requestedWorkers) ? requestedWorkers : 1),
    )

    // One FIFO tail per lane. A lane member chains onto its lane's tail, so lane members execute in
    // the order they were claimed — which is index order, because indices are claimed in order.
    const laneTails = new Map<string, Promise<void>>()
    const runInLane = async (lane: string, i: number): Promise<void> => {
      const previous = laneTails.get(lane) ?? Promise.resolve()
      const settled: Promise<void> = previous.then(
        () => runMember(i),
        () => runMember(i),
      )
      // The stored tail swallows rejection so one member's throw cannot wedge its lane; the
      // returned promise does NOT, so a throw still propagates exactly as it did from the loop.
      laneTails.set(
        lane,
        settled.then(
          () => undefined,
          () => undefined,
        ),
      )
      await settled
    }

    let nextIndex = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex
        nextIndex += 1
        if (i >= memberCount) return
        const lane = config.members[i].exclusiveLane
        if (lane === undefined) await runMember(i)
        else await runInLane(lane, i)
      }
    }

    if (memberCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
    }

    // ---- Compact the index-addressed slots for the aggregate rule ----------------------------
    //
    // Every path through `runMember` writes all three slots, so a hole is a programming error
    // rather than a run condition. It is still handled rather than asserted, because `done` never
    // rejects (D-13/D-17): a hole degrades with a runWarning and the index is dropped from all
    // THREE arrays together, which keeps the positional alignment the aggregate rule depends on.
    const outcomes: PerTestOutcome[] = []
    const memberOutcomes: MemberTestOutcome[] = []
    const memberQuarantined: boolean[] = []
    for (let i = 0; i < memberCount; i += 1) {
      const perTest = outcomeSlots[i]
      const outcome = memberOutcomeSlots[i]
      const quarantined = memberQuarantinedSlots[i]
      if (perTest === undefined || outcome === undefined || quarantined === undefined) {
        bus.publish('runWarning', {
          code: 'member-outcome-missing',
          message: `Member ${i} produced no outcome slot; it is omitted from the aggregate.`,
        })
        continue
      }
      outcomes.push(perTest)
      memberOutcomes.push(outcome)
      memberQuarantined.push(quarantined)
    }
    // ---- Terminal sequence — ONE owner (Pitfall 7) -------------------------------------------
    const verdict = deriveAggregateVerdict({
      runCancelled,
      outcomes: memberOutcomes,
      quarantined: memberQuarantined,
    })

    // verdict EXACTLY once, BEFORE any post-processing event (SESSION-02).
    bus.publish('verdict', { verdict })
    status = verdict

    const endedAt = timer?.now() ?? Date.now()
    const handoff = assembleHandoff(config, outcomes, verdict, { startedAt, endedAt })

    // Persist the one handoff; a store failure degrades with a runWarning and NEVER gates done (D-07).
    try {
      await ports.handoffStore?.save(handoff)
    } catch (error) {
      bus.publish('runWarning', {
        code: 'handoff-write-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // D-08: finalize the run artifact with the end timestamp before runFinished. Fire-and-forget
    // (sync) — a store throw degrades with a runWarning and NEVER gates done (D-07). The keep/drop
    // table drops the top-level runtime section, so only errors + finalizedAt are merged here.
    try {
      ports.runArtifactStore?.finalize({ finalizedAt: new Date(endedAt).toISOString() })
    } catch (error) {
      bus.publish('runWarning', {
        code: 'artifact-finalize-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // 404 D-10: the ONE awaited post-verdict step — enqueue + a single writer-lease consult,
    // performed by a HOST-supplied port so the runner still names no queue and no lease
    // (validate:arch storageNeutral). It decides `runFinished.disposition` and nothing else: the
    // step returns a value and never touches the bus, so the terminal sequence keeps ONE owner
    // (Pitfall 7).
    //
    // DEGRADE, NEVER GATE (D-11, 403-03 D-3). Four ways this can fail to decide, and all four end
    // the same way — `detached` plus a named `runWarning`, with `runFinished` still published last
    // and `bus.close()` still behind it: an absent port (no warning: nothing was promised), a
    // throw, a resolution carrying its own warning, and a step that outlives
    // POST_VERDICT_STEP_BUDGET_MS. The budget is raced on `ports.timer` when one is injected — the
    // post-verdict bound's own clock, kept apart from the bus heartbeat, so a fake timer drives the
    // timeout deterministically — and on a real one-shot otherwise.
    let disposition: PostProcessingDisposition = 'detached'
    if (ports.postVerdict !== undefined) {
      const step = ports.postVerdict
      try {
        const outcome = await raceWithBudget(
          step.run({
            runId: config.runId,
            verdict,
            ...(config.gateRun === true ? { gateRun: true as const } : {}),
            ...(config.excludedFromOutcomes === true
              ? { excludedFromOutcomes: true as const }
              : {}),
          }),
          POST_VERDICT_STEP_BUDGET_MS,
          timer,
        )
        if (outcome === POST_VERDICT_TIMED_OUT) {
          bus.publish('runWarning', {
            code: 'post-verdict-step-timeout',
            message:
              `The post-verdict step did not answer within ${String(POST_VERDICT_STEP_BUDGET_MS)}ms; `
              + 'the run is reported detached and nothing will be drained from this process.',
          })
        } else {
          disposition = outcome.disposition
          if (outcome.warning !== undefined) {
            bus.publish('runWarning', {
              code: outcome.warning.code,
              message: outcome.warning.message,
            })
          }
        }
      } catch (error) {
        bus.publish('runWarning', {
          code: 'post-verdict-step-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // runFinished LAST, once, carrying the decided disposition, finalSeq = its own seq (the next
    // seq the bus will stamp).
    bus.publish('runFinished', {
      aggregateVerdict: verdict,
      disposition,
      finalSeq: bus.currentSeq + 1,
    })

    // Every started screencast stops before the bus closes — the hub's warnings still have a bus.
    await liveStreams.close()
    bus.close()

    return { verdict, handoff }
  })()

  return {
    id: config.runId,
    get status() {
      return status
    },
    executionContext: config.executionContext,
    subscribe: (fromSeq, handler) => bus.subscribe(fromSeq, handler),
    subscribeFrames: (handle, onFrame, onEnd) => liveStreams.subscribe(handle, onFrame, onEnd),
    streamCapabilityOf: (handle) => liveStreams.capabilityOf(handle),
    cancel(): void {
      // Run-level cancel (D-03): abort the active member, skip the rest, aggregate `cancelled`.
      runCancelled = true
      runController.abort()
    },
    done,
  }
}
