// The run-completion bus subscriber (Phase 398 plan 06 task 3, D-16 / D-17 · RUNX-03).
//
// RE-HOMED FROM `core/src/analytics/run-reporter.ts`, keeping the subscription shape byte-for-byte
// where it faces the bus: `{ handler(envelope), flush() }`. That is deliberate and it is the whole
// interface plan 10 has to rewire — the CLI root's attach site changes which module it imports and
// nothing else. The accumulation logic is the part that was worth moving intact: the per-member
// step tallies, the retry reset that keeps a re-run from double-counting, the outcome→status
// mapping, and the suite aggregate derived from the members rather than from a second stream.
//
// THREE THINGS DID NOT COME ACROSS, and each absence is a defect the re-derivation closes:
//
//   1. The `disabled` flag. The v1 subscriber re-read the privacy posture and no-op'd inside its
//      own handler, which made it the SECOND place in the process deciding whether telemetry
//      happens. It is not a decision here at all: an opted-out host composes a port with no
//      transport, so this module emits into a wall and never learns the difference. One decision
//      site, in `compose.ts`, is what D-19 buys and what the ownership contract forbids re-opening.
//   2. Run attributes. The trigger and runner are passed in by the caller that resolved the run's
//      attributes; this module reads no environment for them.
//   3. Raw id pass-through. v1 forwarded whatever string the bus carried into `run_id`/`test_id`.
//      Those fields are known-id codecs in the closed union now, so a foreign string reaching one
//      is exactly the free-text channel the union exists to close. Ids are filtered through the
//      ids package's canonical predicates and DROPPED when they do not match, rather than sent and
//      refused downstream where nobody would see it.
//
// Best-effort is unchanged and load-bearing: every handler body and the flush body swallow their
// own errors, because a malformed envelope must never be able to fail the run it is describing.

import type {
  RunEventEnvelope,
  RunFinishedPayload,
  StepFinalizedPayload,
  TestFinishedPayload,
  TestStartedPayload,
  VerdictPayload,
} from '@vostride/agent-qa-schema'
import {
  analyticsRunId,
  analyticsSuiteId,
  analyticsTestId,
  ANALYTICS_AGENT_PRODUCTS,
  ANALYTICS_EMITTING_HOSTS,
  ANALYTICS_RUNNERS,
  ANALYTICS_RUNTIME_CONTEXTS,
  ANALYTICS_RUN_STATUSES,
  ANALYTICS_TRIGGER_SOURCES,
  type AgentQaAnalyticsEvent,
} from './events.js'
import type { AnalyticsPort, AnalyticsPropertyValue } from './port.js'

type AnalyticsRunStatus = (typeof ANALYTICS_RUN_STATUSES)[number]
export type AnalyticsTriggerSource = (typeof ANALYTICS_TRIGGER_SOURCES)[number]
export type AnalyticsRunner = (typeof ANALYTICS_RUNNERS)[number]

type CompletionEvent<TName extends AgentQaAnalyticsEvent['name']> = Extract<
  AgentQaAnalyticsEvent,
  { name: TName }
>

/**
 * The identity-shaped properties every event in a session carries.
 *
 * Handed in rather than resolved here: `resolveAnalyticsIdentity` answers who, `compose.ts` answers
 * whether, and a subscriber that reached for either would be a third opinion on both.
 */
export interface AnalyticsRunStandardProperties {
  agent_qa_version?: string
  surface?: (typeof ANALYTICS_EMITTING_HOSTS)[number]
  runtime_context?: (typeof ANALYTICS_RUNTIME_CONTEXTS)[number]
  agent_product?: (typeof ANALYTICS_AGENT_PRODUCTS)[number]
  $process_person_profile?: false
}

export interface AnalyticsRunSubscriberOptions {
  /** The composed port. An opted-out host passes one with no transport; see the header. */
  port: AnalyticsPort<AgentQaAnalyticsEvent>
  /** How the run was triggered, as known at the composition root. */
  triggerSource?: string
  /** Which runner executed it, as known at the composition root. */
  runner?: string
  standardProperties?: AnalyticsRunStandardProperties
}

export interface AnalyticsRunSubscriber {
  handler(envelope: RunEventEnvelope): void
  flush(): Promise<void>
}

interface MemberStepTally {
  step_count: number
  passed_step_count: number
  failed_step_count: number
  skipped_step_count: number
  /**
   * the member's measured model-call usage, accumulated ONLY
   * from steps whose `stepFinalized` carried a `tokenUsage`. Absent while no step has been
   * measured — which is why it is optional rather than a zeroed triple: `captureTestRun` spreads
   * the three analytics fields in only when this member exists, so a run nobody measured reports
   * no cost at all instead of reporting a cost of zero.
   */
  tokens?: { input: number; output: number; total: number }
}

interface MemberRecord {
  testId?: string
  outcome: string
  durationMs?: number
  retryCount?: number
  steps: MemberStepTally
}

function emptyStepTally(): MemberStepTally {
  return { step_count: 0, passed_step_count: 0, failed_step_count: 0, skipped_step_count: 0 }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The member index, or nothing — and every handler below bails on nothing.
 *
 * 2026-08-17 (Phase 398 plan 06 task 3). This guard was NOT in the module that moved here, and its
 * absence was measured rather than reasoned about: the "never throws into the run" cell fed a
 * `testFinished` envelope whose payload was the number `7`, expected no emission, and got a fully
 * formed `test_run.completed` event with `status: 'unknown'` and a zeroed step tally. Reading a
 * property off a number is legal in JavaScript, so the surrounding try/catch — the thing that looks
 * like the boundary — never fired, and the malformed envelope was recorded as a member keyed on
 * `undefined`. A best-effort subscriber is allowed to drop what it cannot read; it is not allowed
 * to invent a test run that never happened, because that number is indistinguishable downstream
 * from a real one.
 */
function readIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalisers written against the union's OWN vocabulary arrays.
 *
 * A hand-written `value === 'cli' || value === 'dashboard'` list is how the v1 subscriber came to
 * emit trigger sources the schema had stopped accepting: two lists, one of them stale, no signal.
 * Membership is asked of the array the union is built from, so the two cannot disagree.
 */
function normalizeTriggerSource(value: unknown): AnalyticsTriggerSource {
  return ANALYTICS_TRIGGER_SOURCES.find((candidate) => candidate === value) ?? 'unknown'
}

function normalizeRunner(value: unknown): AnalyticsRunner {
  return ANALYTICS_RUNNERS.find((candidate) => candidate === value) ?? 'unknown'
}

/**
 * Map a member/aggregate outcome to the analytics status vocabulary.
 *
 * Carried from the v1 mapping unchanged so a dashboard reading these numbers across the cutover
 * sees one series rather than two: `healed` counts as `passed` (the heal marker lives on the step),
 * and `timeout` collapses to `failed`. The union does carry a `timeout` arm — splitting it out is a
 * retune with a migration attached, not a side effect of moving a file.
 */
function outcomeToAnalyticsStatus(outcome: unknown): AnalyticsRunStatus {
  switch (outcome) {
    case 'passed':
    case 'healed':
      return 'passed'
    case 'failed':
    case 'timeout':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function definedProperties(
  properties: Record<string, AnalyticsPropertyValue>,
): Record<string, AnalyticsPropertyValue> {
  const output: Record<string, AnalyticsPropertyValue> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

export function createAnalyticsRunSubscriber(
  options: AnalyticsRunSubscriberOptions,
): AnalyticsRunSubscriber {
  const port = options.port
  const standard = options.standardProperties ?? {}
  const triggerSource = normalizeTriggerSource(options.triggerSource)
  const runner = normalizeRunner(options.runner)

  // Accumulated run state, filled from the envelope stream and read once at flush.
  let runId: string | undefined
  let suiteId: string | undefined
  let finished = false
  let aggregateVerdict: string | undefined
  let sawSuite = false
  const members = new Map<number, MemberRecord>()
  // Live step tallies keyed by testIndex; `testRetryScheduled` resets a member's tally so a
  // re-run's repeated `stepFinalized` sequence never double-counts (schema §2.2 retry note).
  const liveSteps = new Map<number, MemberStepTally>()

  function stepTallyFor(testIndex: number): MemberStepTally {
    let tally = liveSteps.get(testIndex)
    if (!tally) {
      tally = emptyStepTally()
      liveSteps.set(testIndex, tally)
    }
    return tally
  }

  function handleTestStarted(payload: TestStartedPayload): void {
    const testIndex = readIndex(payload.testIndex)
    if (testIndex === undefined) return
    const payloadSuiteId = readString(payload.suiteId)
    if (payloadSuiteId) {
      sawSuite = true
      suiteId = analyticsSuiteId(payloadSuiteId) ?? suiteId
    }
    liveSteps.set(testIndex, emptyStepTally())
  }

  function handleStepFinalized(payload: StepFinalizedPayload): void {
    const testIndex = readIndex(payload.testIndex)
    if (testIndex === undefined) return
    const tally = stepTallyFor(testIndex)
    tally.step_count += 1
    switch (payload.status) {
      case 'passed':
      case 'healed':
        tally.passed_step_count += 1
        break
      case 'failed':
      case 'cancelled':
        tally.failed_step_count += 1
        break
      case 'skipped':
        tally.skipped_step_count += 1
        break
      default:
        break
    }
    // the fields `analytics/src/events.ts` has declared since v33 with no producer get
    // one here. A step with no `tokenUsage` is a step nobody measured (a cache hit, a bypass, a
    // provider that reports none) and contributes NOTHING — not a zero.
    const usage = payload.tokenUsage
    if (usage !== undefined) {
      const tokens = tally.tokens ?? { input: 0, output: 0, total: 0 }
      tokens.input += usage.promptTokens
      tokens.output += usage.completionTokens
      tokens.total += usage.totalTokens
      tally.tokens = tokens
    }
  }

  function handleTestFinished(payload: TestFinishedPayload): void {
    const testIndex = readIndex(payload.testIndex)
    if (testIndex === undefined) return
    const steps = liveSteps.get(testIndex) ?? emptyStepTally()
    // Only the final attempt emits `testFinished` — overwrite any prior record for this index.
    members.set(testIndex, {
      testId: readString(payload.testId),
      outcome: readString(payload.outcome) ?? 'unknown',
      durationMs: readNumber(payload.durationMs),
      retryCount: readNumber(payload.retryCount),
      steps,
    })
    liveSteps.delete(testIndex)
  }

  function captureTestRun(record: MemberRecord): void {
    const status = outcomeToAnalyticsStatus(record.outcome)
    const testId = analyticsTestId(record.testId)
    // The four flat counts are analytics property names verbatim and spread as-is; `tokens` is an
    // accumulator, NOT a property, so it is destructured away rather than allowed to ride into the
    // bag as a nested object the strict schema would refuse.
    const { tokens: _tokens, ...steps } = record.steps
    const properties = definedProperties({
      ...standard,
      run_id: runId,
      test_id: testId,
      trigger_source: triggerSource,
      runner,
      status,
      duration_ms: record.durationMs,
      retry_count: record.retryCount,
      is_flaky: record.retryCount !== undefined
        ? status === 'passed' && record.retryCount > 0
        : undefined,
      ...steps,
      // 405 D-07. Spread in only when the member measured at least one step. `definedProperties`
      // would drop three `undefined`s anyway, but building them unconditionally would mean writing
      // `input_tokens: tokens?.input ?? 0` somewhere — and that `?? 0` is exactly the fabricated
      // measurement this whole path refuses to make.
      ...(record.steps.tokens === undefined
        ? {}
        : {
          input_tokens: record.steps.tokens.input,
          output_tokens: record.steps.tokens.output,
          total_tokens: record.steps.tokens.total,
        }),
    }) as CompletionEvent<'agent-qa.test_run.completed'>['properties']

    port.capture({ name: 'agent-qa.test_run.completed', properties })
  }

  function captureSuiteRun(records: readonly MemberRecord[]): void {
    const statuses = records.map((record) => outcomeToAnalyticsStatus(record.outcome))
    const properties = definedProperties({
      ...standard,
      run_id: runId,
      suite_id: suiteId,
      trigger_source: triggerSource,
      runner,
      status: outcomeToAnalyticsStatus(aggregateVerdict),
      duration_ms: records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0),
      suite_child_count: records.length,
      suite_passed_count: statuses.filter((status) => status === 'passed').length,
      suite_failed_count: statuses.filter((status) => status === 'failed').length,
      suite_skipped_count: statuses.filter((status) => status === 'skipped').length,
    }) as CompletionEvent<'agent-qa.suite_run.completed'>['properties']

    port.capture({ name: 'agent-qa.suite_run.completed', properties })
  }

  return {
    handler(envelope: RunEventEnvelope): void {
      try {
        runId = analyticsRunId(envelope.runId)
        switch (envelope.type) {
          case 'testStarted':
            handleTestStarted(envelope.payload as TestStartedPayload)
            break
          case 'stepFinalized':
            handleStepFinalized(envelope.payload as StepFinalizedPayload)
            break
          case 'testRetryScheduled': {
            const retryIndex = readIndex((envelope.payload as { testIndex?: unknown }).testIndex)
            if (retryIndex !== undefined) liveSteps.delete(retryIndex)
            break
          }
          case 'testFinished':
            handleTestFinished(envelope.payload as TestFinishedPayload)
            break
          case 'verdict':
            aggregateVerdict = readString((envelope.payload as VerdictPayload).verdict) ?? aggregateVerdict
            break
          case 'runFinished':
            aggregateVerdict =
              readString((envelope.payload as RunFinishedPayload).aggregateVerdict) ?? aggregateVerdict
            finished = true
            break
          default:
            break
        }
      } catch {
        // A malformed envelope must never break a run — analytics is best-effort.
      }
    },

    async flush(): Promise<void> {
      if (!finished) {
        // Still settle the port so a composed transport drains cleanly on an abandoned run.
        await port.flush()
        return
      }

      try {
        const records = [...members.values()]
        for (const record of records) captureTestRun(record)
        if (sawSuite) captureSuiteRun(records)
      } catch {
        // Analytics is intentionally best-effort — never surface a fault to the run.
      }

      await port.flush()
    },
  }
}
