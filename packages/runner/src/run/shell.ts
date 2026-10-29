// Owns the lifecycle but no verdict logic or I/O; one code path runs the terminal sequence.

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

// Re-export the port contracts that `run-shell.test.ts` imports through `../shell.js`.
export type {
  RunConfig,
  RunMemberDescriptor,
  MemberTestExecutor,
  MemberTestRunContext,
} from './ports.js'

// A sentinel, so the `catch` stays reserved for a step that actually threw.
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

// Uses schema's `quarantineAppliesToTest`, so the CLI reporters reach the same answer.
function isMemberQuarantined(
  member: RunMemberDescriptor,
  quarantined: RunConfig['quarantined'],
): boolean {
  return quarantineAppliesToTest(quarantined, {
    filePath: member.filePath,
    testName: member.name,
  })
}

// One expression for the roster and the stamps, so announced handles match event handles.
function memberHandleIndex(member: RunMemberDescriptor, index: number): number {
  return member.testIndex ?? index
}

/**
 * Start a run. Constructs the session SYNCHRONOUSLY — the bus, `runStarted` at seq 1, the
 * run-level AbortController — then kicks the async member pool whose settled result feeds `done`.
 * Returns the addressable {@link RunSession} immediately.
 *
 * Members execute through a BOUNDED CONCURRENT POOL, and the terminal sequence is ONE code path,
 * run once, after the pool settles. Concurrency changes which member is in flight when; it does not
 * change who publishes the verdict, or when `runFinished` is last.
 */
export function startRun(config: RunConfig): RunSession {
  const mask: MaskFn = (text) => redactSecretValue(text, config.secretRedactor)
  const ports = config.ports ?? {}
  const timer = ports.timer

  // The bus heartbeat runs on its own default clock — the injected `ports.timer` is reserved for
  // the post-verdict bound and the frame hub, so that firing it in a test is unambiguous (heartbeat
  // re-arm on every publish would otherwise clobber those bounds on a single shared fake timer).
  const bus = createRunEventBus({ runId: config.runId, eventLog: ports.eventLog })

  // Frames are side-channel data; the hub publishes no bus event of its own.
  const liveStreams = createLiveStreamHub({
    ...(ports.timer === undefined ? {} : { timer: ports.timer }),
    onWarning: (code, message) => {
      bus.publish('runWarning', { code, message })
    },
    // A subscriber's fault never reaches the bus; the host decides where it goes.
    ...(ports.onSubscriberFault === undefined ? {} : { onSubscriberFault: ports.onSubscriberFault }),
  })

  const startedAt = timer?.now() ?? Date.now()

  // The handle roster is a payload field derived through `memberHandleIndex`, not a new event.
  bus.publish('runStarted', {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: config.scope,
    executionContext: config.executionContext,
    buildOrdinal: config.buildOrdinal,
    configDigests: config.configDigests,
    memberTestCount: config.members.length,
    handles: config.members.map(memberHandleIndex),
  })

  // Stage the artifact once after runStarted; a store throw warns and never gates the run.
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
    // The aggregate rule reads slots by position, so completion-order appends would misattribute.
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

    // Fail-fast poisoning stops new members from starting; members already in flight finish.
    const runMember = async (i: number): Promise<void> => {
      const member = config.members[i]
      const testIndex = memberHandleIndex(member, i)
      const name = member.name
      const quarantined = isMemberQuarantined(member, config.quarantined)
      const quarantineMarker = quarantined ? (true as const) : undefined

      // Run cancelled: skip the rest without the executor, published like the fail-fast skip.
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

      // A poisoned same-group predecessor skips this member; the executor is never invoked.
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

      // Descriptor fields are structural identity and unmasked; `stepTexts` is authored, so masked.
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

      // Member abort chained to the run controller so a run-level cancel aborts the active test.
      const memberController = new AbortController()
      const onRunAbort = (): void => memberController.abort()
      if (runController.signal.aborted) memberController.abort()
      else runController.signal.addEventListener('abort', onRunAbort, { once: true })

      const events = createMemberEventSink({ bus, mask, testIndex })
      let evidenceContext: MemberEvidenceContext | undefined

      // Race the executor against member abort, or an executor ignoring its signal hangs `done`.
      type RaceOutcome =
        | { kind: 'result'; result: TestResult }
        | { kind: 'error'; error: unknown }
        | { kind: 'aborted' }

      // The member's own clock keeps its run time in a result; an abort-skipped member keeps 0.
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
        // An executor throw becomes a runWarning plus a synthesized failed result, never a crash.
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
        // Abort won the race — the member did not settle after a run-level cancel. Finalize it
        // as `cancelled` through the SAME deriveMemberOutcome/assemblePerTestOutcome helpers below so
        // the "exactly one handoff / verdict once / runFinished last" invariants stay intact. A
        // run-level cancel wins the aggregate outright (deriveAggregateVerdict returns `cancelled`),
        // so this member's own 'cancelled' outcome never changes the aggregate.
        result = {
          name,
          filePath: `${member.testId}.test.ts`,
          status: 'cancelled',
          steps: [],
          duration: performance.now() - memberStartedAt,
        }
      }

      // Every arm converges here, so the handle withdraws its declaration once the race settles.
      liveStreams.register(testIndex, undefined)

      const outcome = deriveMemberOutcome(result)
      // A quarantined failure must not poison its group, or skipped siblings hide real failures.
      if (
        (outcome === 'failed' || outcome === 'timeout') &&
        member.failFastGroup !== undefined &&
        !quarantined
      ) {
        poisonedGroups.add(member.failFastGroup)
      }

      // Classify here, where `result`, `outcome` and `testIndex` meet, with the member's baseline.
      const rootCause = classifyRootCause({
        result,
        outcome,
        testIndex,
        ...(member.baselineProbe === undefined ? {} : { baselineProbe: member.baselineProbe }),
        mask,
      })

      // Classify the original evidence with this member's baseline; the final retry keeps its own.
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
      // Enrich testFinished from the TestResult; the projection masks failureSummary.
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

    // Members sharing an `exclusiveLane` share one resource, so they never interleave.
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

    // A hole warns and is dropped from every slot array together, keeping positions aligned.
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
    // ---- Terminal sequence: one owner ----
    const verdict = deriveAggregateVerdict({
      runCancelled,
      outcomes: memberOutcomes,
      quarantined: memberQuarantined,
    })

    // `verdict` exactly once, before any post-processing event.
    bus.publish('verdict', { verdict })
    status = verdict

    const endedAt = timer?.now() ?? Date.now()
    const handoff = assembleHandoff(config, outcomes, verdict, { startedAt, endedAt })

    // Persist the one handoff; a store failure warns and never gates `done`.
    try {
      await ports.handoffStore?.save(handoff)
    } catch (error) {
      bus.publish('runWarning', {
        code: 'handoff-write-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // Finalize the run artifact before runFinished; a store throw warns and never gates `done`.
    try {
      ports.runArtifactStore?.finalize({ finalizedAt: new Date(endedAt).toISOString() })
    } catch (error) {
      bus.publish('runWarning', {
        code: 'artifact-finalize-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    // Degrade, never gate: every undecided outcome reads `detached`, and runFinished stays last.
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
      // Run-level cancel: abort the active member, skip the rest, aggregate `cancelled`.
      runCancelled = true
      runController.abort()
    },
    done,
  }
}
