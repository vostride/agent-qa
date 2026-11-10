// A run's bus events become coarse spans and the run state an error carries, read back from what
// the real SDK sends through a recording transport.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope, RunEventPayload, RunEventType } from '@vostride/agent-qa-schema'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from '../../__tests__/error-report-recorder.js'
import type { RecordedEnvelope } from '../../__tests__/error-report-recorder.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { produceMembersFromPatterns, resolveRunInvocationInputs } from '../../commands/run.js'
import { closeErrorReporting, settleReporting, startErrorReporting } from '../error-reporting.js'
import type { ErrorReporter } from '../error-reporting.js'
import { runInProcessCliRun } from '../in-process-run-execution.js'
import type { InProcessCliRunExecutionOptions } from '../in-process-run-execution.js'
import * as traceModule from '../run-trace-subscriber.js'
import { adapterFor, createRunTraceSubscriber } from '../run-trace-subscriber.js'
import type { RunTraceSubscriber } from '../run-trace-subscriber.js'
import {
  CountingTarget,
  PLANTED_SECRET_NAME,
  REMOTE_DEVICE_NAME,
  closeTestRunRecords,
  createInProcessFixture,
  removeInProcessFixtures,
  testRunRecord,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const TEST_NAME = 'Checkout with the saved Visa card'
const STEP_TEXT = 'Type 4242-7781 into the card number field'
const FILE_PATH = 'tests/checkout/saved-card.test.yaml'
const TYPED_VALUE = '4242-7781-0000'

const tempDirs: string[] = []
let pinnedTmpdir: PinnedTmpdir | undefined

beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})

// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-run-trace-auth-'))
  tempDirs.push(dataHome)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeErrorReporting()
  closeTestRunRecords()
  removeReportProjects()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

async function startRecording() {
  const recorder = recordingReportTransport()
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  return { recorder, reporter }
}

let seq = 0

function envelope(runId: string, type: RunEventType, payload: unknown): RunEventEnvelope {
  seq += 1
  return { seq, ts: 1_700_000_000_000 + seq, runId, type, payload: payload as RunEventPayload }
}

// Each builder carries the text a real run puts on its events, so a cell can look for it.
const events = {
  runStarted: (runId: string) =>
    envelope(runId, 'runStarted', { busSchemaVersion: 2, memberTestCount: 1 }),
  testStarted: (runId: string, testIndex: number) =>
    envelope(runId, 'testStarted', {
      testId: generateTestId(),
      testIndex,
      name: TEST_NAME,
      filePath: FILE_PATH,
      stepTexts: [STEP_TEXT],
    }),
  stepStarted: (runId: string, testIndex: number, stepIndex: number) =>
    envelope(runId, 'stepStarted', { testIndex, stepIndex, stepText: STEP_TEXT }),
  subActionRecorded: (runId: string, testIndex: number, stepIndex: number, type: string) =>
    envelope(runId, 'subActionRecorded', {
      testIndex,
      stepIndex,
      subActionIndex: 0,
      plan: STEP_TEXT,
      plannedAction: { type, ref: 'e7', value: TYPED_VALUE },
      result: { success: true },
      screenStateHash: 'screen-hash',
    }),
  stepFinalized: (runId: string, testIndex: number, stepIndex: number, status = 'passed') =>
    envelope(runId, 'stepFinalized', {
      testIndex,
      stepIndex,
      cacheStatus: 'miss',
      verifierVerdict: { pass: status === 'passed', reasoning: STEP_TEXT },
      selfHealOccurred: false,
      briefDigest: 'brief-digest',
      status,
      ...(status === 'failed' ? { error: `Step failed: ${STEP_TEXT}` } : {}),
    }),
  testRetryScheduled: (runId: string, testIndex: number, attempt: number) =>
    envelope(runId, 'testRetryScheduled', {
      testId: generateTestId(),
      testIndex,
      attempt,
      maxAttempts: 2,
      reason: STEP_TEXT,
    }),
  testFinished: (runId: string, testIndex: number, outcome = 'passed') =>
    envelope(runId, 'testFinished', { testId: generateTestId(), testIndex, outcome }),
  runFinished: (runId: string, aggregateVerdict = 'passed') =>
    envelope(runId, 'runFinished', { aggregateVerdict, disposition: 'drained', finalSeq: seq }),
}

// One test with one step that records one action.
function oneStepRun(runId: string, testIndex = 0, stepIndex = 0, action = 'fill') {
  return [
    events.runStarted(runId),
    events.testStarted(runId, testIndex),
    events.stepStarted(runId, testIndex, stepIndex),
    events.subActionRecorded(runId, testIndex, stepIndex, action),
    events.stepFinalized(runId, testIndex, stepIndex),
    events.testFinished(runId, testIndex),
    events.runFinished(runId),
  ]
}

function drive(subscriber: RunTraceSubscriber, envelopes: readonly RunEventEnvelope[]): void {
  for (const item of envelopes) subscriber.handler(item)
}

interface RecordedSpan {
  readonly name?: string
  readonly trace_id?: string
  readonly span_id?: string
  readonly parent_span_id?: string
  readonly status?: string
  readonly start_timestamp?: number
  readonly end_timestamp?: number
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

interface RecordedEvent {
  readonly contexts?: Readonly<Record<string, unknown>>
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
}

function envelopeItems(envelopes: readonly RecordedEnvelope[]) {
  const parsed = JSON.parse(serializedEnvelopes(envelopes)) as Array<
    [unknown, Array<[{ readonly type?: string }, unknown]>]
  >
  return parsed.flatMap(([, items]) => items)
}

function recordedSpans(envelopes: readonly RecordedEnvelope[]): RecordedSpan[] {
  return envelopeItems(envelopes)
    .filter(([header]) => header.type === 'span')
    .flatMap(([, payload]) => (payload as { readonly items?: RecordedSpan[] }).items ?? [])
}

function recordedEvents(envelopes: readonly RecordedEnvelope[]): RecordedEvent[] {
  return envelopeItems(envelopes)
    .filter(([header]) => header.type === 'event')
    .map(([, payload]) => payload as RecordedEvent)
}

function eventWithMessage(envelopes: readonly RecordedEnvelope[], message: string) {
  const event = recordedEvents(envelopes).find(
    (candidate) => candidate.exception?.values?.[0]?.value === message,
  )
  expect(event, `no event was sent for "${message}"`).toBeDefined()
  return event!
}

function attributeOf(span: RecordedSpan | undefined, key: string): unknown {
  return span?.attributes?.[key]?.value
}

function spansOf(envelopes: readonly RecordedEnvelope[], op: string): RecordedSpan[] {
  return recordedSpans(envelopes).filter((span) => attributeOf(span, 'sentry.op') === op)
}

function only(spans: readonly RecordedSpan[]): RecordedSpan {
  expect(spans).toHaveLength(1)
  return spans[0]!
}

describe('the spans of a run', () => {
  it('nests the step under the test and the test under the run, and puts the run of an agent-qa run command under its command span in one trace', async () => {
    const { recorder, reporter } = await startRecording()
    reporter.beginCommandSpan('run', [])

    drive(
      createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['web'] }),
      oneStepRun(generateRunId()),
    )
    await settleReporting()

    const command = only(spansOf(recorder.envelopes, 'agent_qa.command'))
    const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
    const test = only(spansOf(recorder.envelopes, 'agent_qa.test'))
    const step = only(spansOf(recorder.envelopes, 'agent_qa.step'))
    expect([run.name, test.name, step.name]).toEqual(['run', 'test', 'step'])
    expect(command.span_id).toMatch(/^[0-9a-f]{16}$/)
    expect(run.parent_span_id).toBe(command.span_id)
    expect(test.parent_span_id).toBe(run.span_id)
    expect(step.parent_span_id).toBe(test.span_id)
    expect([run.trace_id, test.trace_id, step.trace_id]).toEqual([
      command.trace_id,
      command.trace_id,
      command.trace_id,
    ])
  })

  it.each(['mcp', 'dashboard', 'serve', 'daemon', 'chat'])(
    'starts each run in a trace of its own when the command is %s',
    async (command) => {
      const { recorder, reporter } = await startRecording()
      reporter.beginCommandSpan(command, [])

      for (const runId of [generateRunId(), generateRunId()]) {
        drive(createRunTraceSubscriber({ reporter, runner: 'local' }), oneStepRun(runId))
      }
      await settleReporting()

      const commandSpan = only(spansOf(recorder.envelopes, 'agent_qa.command'))
      const runs = spansOf(recorder.envelopes, 'agent_qa.run')
      const tests = spansOf(recorder.envelopes, 'agent_qa.test')
      expect(runs).toHaveLength(2)
      expect(tests).toHaveLength(2)
      for (const run of runs) {
        expect(run.trace_id).toMatch(/^[0-9a-f]{32}$/)
        expect(run.parent_span_id).toBeUndefined()
        expect(run.trace_id).not.toBe(commandSpan.trace_id)
        const test = tests.find((candidate) => candidate.parent_span_id === run.span_id)
        expect(test?.trace_id).toBe(run.trace_id)
      }
      expect(runs[0]?.trace_id).not.toBe(runs[1]?.trace_id)
    },
  )

  it('names the run id, the runner, the platforms and the plugins on the run, the indexes on the test and the step, and the action kind on the step', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()

    drive(
      createRunTraceSubscriber({
        reporter,
        runner: 'remote',
        remotePlugins: ['kernel', '@acme/agent-qa-plugin-grid', 'kernel'],
        platforms: ['android'],
      }),
      oneStepRun(runId, 1, 2, 'tap'),
    )
    await settleReporting()

    const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
    const test = only(spansOf(recorder.envelopes, 'agent_qa.test'))
    const step = only(spansOf(recorder.envelopes, 'agent_qa.step'))
    expect(attributeOf(run, 'agent_qa.run_id')).toBe(runId)
    expect(attributeOf(run, 'agent_qa.runner')).toBe('remote')
    expect(attributeOf(run, 'agent_qa.platforms')).toEqual(['android'])
    expect(attributeOf(run, 'agent_qa.plugins')).toEqual(['kernel', 'third_party'])
    expect(attributeOf(test, 'agent_qa.test_index')).toBe(1)
    expect(attributeOf(step, 'agent_qa.step_index')).toBe(2)
    expect(attributeOf(step, 'agent_qa.action')).toBe('tap')
  })

  it('holds no test name, step text, file path or typed value in any span', async () => {
    const { recorder, reporter } = await startRecording()
    reporter.beginCommandSpan('run', [])
    const runId = generateRunId()
    const sequence = oneStepRun(runId)
    // An action kind outside the closed list is not named, whatever its text.
    sequence.splice(4, 0, events.subActionRecorded(runId, 0, 0, STEP_TEXT))

    drive(createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['web'] }), sequence)
    await settleReporting()

    const spans = recordedSpans(recorder.envelopes)
    expect(spans.map((span) => span.name).sort()).toEqual(['agent-qa run', 'run', 'step', 'test'])
    const sent = JSON.stringify(spans)
    for (const text of [TEST_NAME, STEP_TEXT, FILE_PATH, TYPED_VALUE]) {
      expect(sent).not.toContain(text)
    }
  })

  it('ends a failed step, a failed test and a failed run ok, since a failed assertion is a verdict', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()

    drive(createRunTraceSubscriber({ reporter, runner: 'local' }), [
      events.runStarted(runId),
      events.testStarted(runId, 0),
      events.stepStarted(runId, 0, 0),
      events.stepFinalized(runId, 0, 0, 'failed'),
      events.testFinished(runId, 0, 'failed'),
      events.runFinished(runId, 'failed'),
    ])
    await settleReporting()

    expect(
      ['agent_qa.run', 'agent_qa.test', 'agent_qa.step'].map(
        (op) => only(spansOf(recorder.envelopes, op)).status,
      ),
    ).toEqual(['ok', 'ok', 'ok'])
  })

  it('ends a step error when its test ends before the step does, and ok when the test was cancelled', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()

    drive(createRunTraceSubscriber({ reporter, runner: 'local' }), [
      events.runStarted(runId),
      events.testStarted(runId, 0),
      events.stepStarted(runId, 0, 0),
      events.testFinished(runId, 0, 'failed'),
      events.testStarted(runId, 1),
      events.stepStarted(runId, 1, 0),
      events.testFinished(runId, 1, 'cancelled'),
      events.runFinished(runId, 'cancelled'),
    ])
    await settleReporting()

    const tests = spansOf(recorder.envelopes, 'agent_qa.test')
    const steps = spansOf(recorder.envelopes, 'agent_qa.step')
    expect(steps).toHaveLength(2)
    const statusUnder = (testIndex: number) => {
      const test = tests.find((span) => attributeOf(span, 'agent_qa.test_index') === testIndex)
      return steps.find((span) => span.parent_span_id === test?.span_id)?.status
    }
    expect([statusUnder(0), statusUnder(1)]).toEqual(['error', 'ok'])
    expect(tests.map((span) => span.status)).toEqual(['ok', 'ok'])
  })

  it('ends every span still open when the run finishes, error when it broke off and ok when it was cancelled', async () => {
    const { recorder, reporter } = await startRecording()
    const brokenOff = generateRunId()
    const cancelled = generateRunId()

    for (const [runId, verdict] of [
      [brokenOff, 'failed'],
      [cancelled, 'cancelled'],
    ] as const) {
      drive(createRunTraceSubscriber({ reporter, runner: 'local' }), [
        events.runStarted(runId),
        events.testStarted(runId, 0),
        events.stepStarted(runId, 0, 0),
        events.runFinished(runId, verdict),
      ])
    }
    await settleReporting()

    const runs = spansOf(recorder.envelopes, 'agent_qa.run')
    const statusesOf = (runId: string) => {
      const run = runs.find((span) => attributeOf(span, 'agent_qa.run_id') === runId)
      const test = spansOf(recorder.envelopes, 'agent_qa.test').find(
        (span) => span.parent_span_id === run?.span_id,
      )
      const step = spansOf(recorder.envelopes, 'agent_qa.step').find(
        (span) => span.parent_span_id === test?.span_id,
      )
      return [run?.status, test?.status, step?.status]
    }
    expect(statusesOf(brokenOff)).toEqual(['ok', 'error', 'error'])
    expect(statusesOf(cancelled)).toEqual(['ok', 'ok', 'ok'])
  })

  it('ends the open step and test spans of a retried test before the next attempt opens its own', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()

    // The next attempt repeats the steps from the first, as a retry does.
    drive(createRunTraceSubscriber({ reporter, runner: 'local' }), [
      events.runStarted(runId),
      events.testStarted(runId, 0),
      events.stepStarted(runId, 0, 0),
      events.stepFinalized(runId, 0, 0, 'failed'),
      events.stepStarted(runId, 0, 1),
      events.testRetryScheduled(runId, 0, 1),
      events.stepStarted(runId, 0, 0),
      events.stepFinalized(runId, 0, 0),
      events.stepStarted(runId, 0, 1),
      events.stepFinalized(runId, 0, 1),
      events.testFinished(runId, 0),
      events.runFinished(runId),
    ])
    await settleReporting()

    const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
    const tests = spansOf(recorder.envelopes, 'agent_qa.test')
    const steps = spansOf(recorder.envelopes, 'agent_qa.step')
    expect(tests).toHaveLength(2)
    expect(steps).toHaveLength(4)
    const [first, second] = [...tests].sort(
      (a, b) => (a.start_timestamp ?? 0) - (b.start_timestamp ?? 0),
    )
    expect(tests.map((span) => span.parent_span_id)).toEqual([run.span_id, run.span_id])
    expect(first!.end_timestamp).toBeLessThanOrEqual(second!.start_timestamp!)
    const under = (test: RecordedSpan) =>
      steps
        .filter((span) => span.parent_span_id === test.span_id)
        .map((span) => [attributeOf(span, 'agent_qa.step_index'), span.status])
        .sort()
    expect(under(first!)).toEqual([
      [0, 'ok'],
      [1, 'error'],
    ])
    expect(under(second!)).toEqual([
      [0, 'ok'],
      [1, 'ok'],
    ])
  })

  it('ends what a run left open when it breaks off before it finishes, and ignores what comes after', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()
    const subscriber = createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['web'] })

    drive(subscriber, oneStepRun(runId).slice(0, 3))
    await subscriber.flush()
    drive(subscriber, [events.stepStarted(runId, 0, 1), events.runFinished(runId)])
    reporter.capture(new Error('an error after the run broke off'))
    await settleReporting()

    const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
    const test = only(spansOf(recorder.envelopes, 'agent_qa.test'))
    const step = only(spansOf(recorder.envelopes, 'agent_qa.step'))
    expect([run.status, test.status, step.status]).toEqual(['error', 'error', 'error'])
    const after = eventWithMessage(recorder.envelopes, 'an error after the run broke off')
    expect(after.contexts).not.toHaveProperty('run')
  })

  it('throws nothing on a malformed envelope and leaves the other spans as they were', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()
    const subscriber = createRunTraceSubscriber({ reporter, runner: 'local' })
    const malformed = [
      envelope(runId, 'testStarted', undefined),
      envelope(runId, 'stepStarted', { testIndex: '0', stepIndex: 1, stepText: STEP_TEXT }),
      envelope(runId, 'stepStarted', { testIndex: 0, stepIndex: -1, stepText: STEP_TEXT }),
      envelope(runId, 'stepStarted', { testIndex: 0, stepIndex: 0.5, stepText: STEP_TEXT }),
      envelope(runId, 'subActionRecorded', { testIndex: 0, stepIndex: 0 }),
      envelope(runId, 'testFinished', null),
      events.stepStarted(generateRunId(), 0, 1),
      { seq: 99 } as unknown as RunEventEnvelope,
    ]

    drive(subscriber, oneStepRun(runId).slice(0, 3))
    for (const item of malformed) expect(() => subscriber.handler(item)).not.toThrow()
    drive(subscriber, oneStepRun(runId).slice(3))
    await settleReporting()

    const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
    const test = only(spansOf(recorder.envelopes, 'agent_qa.test'))
    const step = only(spansOf(recorder.envelopes, 'agent_qa.step'))
    expect([test.parent_span_id, step.parent_span_id]).toEqual([run.span_id, test.span_id])
    expect([run.status, test.status, step.status]).toEqual(['ok', 'ok', 'ok'])
    expect(attributeOf(step, 'agent_qa.action')).toBe('fill')
  })
})

describe('the run state an error carries', () => {
  it('names the adapter by what it drives', () => {
    expect((['web', 'android', 'ios'] as const).map(adapterFor)).toEqual([
      'playwright',
      'uiautomator2',
      'xcuitest',
    ])
  })

  it('carries the run id, the runner, the platform, the adapter, the step and the action on an error during a step, and none after the run finishes', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()
    const subscriber = createRunTraceSubscriber({
      reporter,
      runner: 'remote',
      platforms: ['android', 'web'],
    })

    drive(subscriber, [
      events.runStarted(runId),
      events.testStarted(runId, 0),
      events.stepStarted(runId, 0, 3),
      events.subActionRecorded(runId, 0, 3, 'tap'),
    ])
    reporter.capture(new Error('an error during the step'))
    drive(subscriber, [
      events.stepFinalized(runId, 0, 3),
      events.testFinished(runId, 0),
      events.runFinished(runId),
    ])
    reporter.capture(new Error('an error after the run'))
    await settleReporting()

    expect(eventWithMessage(recorder.envelopes, 'an error during the step').contexts?.run).toEqual({
      run_id: runId,
      runner: 'remote',
      platform: 'android',
      adapter: 'uiautomator2',
      step: 3,
      action: 'tap',
    })
    const after = eventWithMessage(recorder.envelopes, 'an error after the run')
    expect(after.contexts).not.toHaveProperty('run')
    expect(after.contexts).not.toHaveProperty('runs')
  })

  it('keeps each open run’s state apart, names each under its run id while both are open, and none as the run', async () => {
    const { recorder, reporter } = await startRecording()
    const first = generateRunId()
    const second = generateRunId()
    const one = createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['web'] })
    const two = createRunTraceSubscriber({ reporter, runner: 'remote', platforms: ['ios'] })
    const firstState = {
      run_id: first,
      runner: 'local',
      platform: 'web',
      adapter: 'playwright',
      step: 1,
      action: 'click',
    }

    drive(one, [
      events.runStarted(first),
      events.testStarted(first, 0),
      events.stepStarted(first, 0, 1),
      events.subActionRecorded(first, 0, 1, 'click'),
    ])
    drive(two, [
      events.runStarted(second),
      events.testStarted(second, 0),
      events.stepStarted(second, 0, 4),
    ])
    reporter.capture(new Error('both runs are open'))
    drive(two, [
      events.subActionRecorded(second, 0, 4, 'tap'),
      events.stepFinalized(second, 0, 4),
      events.testFinished(second, 0),
      events.runFinished(second),
    ])
    reporter.capture(new Error('the first run is still open'))
    drive(one, [
      events.stepFinalized(first, 0, 1),
      events.testFinished(first, 0),
      events.runFinished(first),
    ])
    reporter.capture(new Error('no run is open'))
    await settleReporting()

    const both = eventWithMessage(recorder.envelopes, 'both runs are open')
    expect(both.contexts).not.toHaveProperty('run')
    expect(both.contexts?.runs).toEqual({
      [first]: firstState,
      [second]: {
        run_id: second,
        runner: 'remote',
        platform: 'ios',
        adapter: 'xcuitest',
        step: 4,
      },
    })
    const firstOnly = eventWithMessage(recorder.envelopes, 'the first run is still open')
    expect(firstOnly.contexts?.run).toEqual(firstState)
    expect(firstOnly.contexts).not.toHaveProperty('runs')
    const none = eventWithMessage(recorder.envelopes, 'no run is open')
    expect(none.contexts).not.toHaveProperty('run')
    expect(none.contexts).not.toHaveProperty('runs')
  })

  it('carries the run state from the moment the run starts, and a new step names no action until it records one', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()
    const subscriber = createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['ios'] })

    drive(subscriber, [events.runStarted(runId)])
    reporter.capture(new Error('an error before the first step'))
    drive(subscriber, [
      events.testStarted(runId, 0),
      events.stepStarted(runId, 0, 0),
      events.subActionRecorded(runId, 0, 0, 'tap'),
      events.stepFinalized(runId, 0, 0),
      events.stepStarted(runId, 0, 1),
    ])
    reporter.capture(new Error('an error on the next step'))
    await settleReporting()

    const place = { run_id: runId, runner: 'local', platform: 'ios', adapter: 'xcuitest' }
    const before = eventWithMessage(recorder.envelopes, 'an error before the first step')
    const next = eventWithMessage(recorder.envelopes, 'an error on the next step')
    expect(before.contexts?.run).toEqual(place)
    expect(next.contexts?.run).toEqual({ ...place, step: 1 })
  })

  it('names the action of the step it names, not one another member recorded', async () => {
    const { recorder, reporter } = await startRecording()
    const runId = generateRunId()
    const subscriber = createRunTraceSubscriber({ reporter, runner: 'local', platforms: ['web'] })

    drive(subscriber, [
      events.runStarted(runId),
      events.testStarted(runId, 0),
      events.testStarted(runId, 1),
      events.stepStarted(runId, 0, 2),
      events.stepStarted(runId, 1, 0),
      events.subActionRecorded(runId, 0, 2, 'click'),
    ])
    reporter.capture(new Error('an error while two members run'))
    await settleReporting()

    const during = eventWithMessage(recorder.envelopes, 'an error while two members run')
    expect(during.contexts?.run).toEqual({
      run_id: runId,
      runner: 'local',
      platform: 'web',
      adapter: 'playwright',
      step: 0,
    })
  })

  it('leaves no run state of a closed reporter on the reports of the next one', async () => {
    const first = await startRecording()
    drive(createRunTraceSubscriber({ reporter: first.reporter, runner: 'local' }), [
      events.runStarted(generateRunId()),
    ])
    first.reporter.capture(new Error('an error under the first reporter'))
    await settleReporting()
    await closeErrorReporting()

    const second = await startRecording()
    second.reporter.capture(new Error('an error under the next reporter'))
    await settleReporting()

    const before = eventWithMessage(first.recorder.envelopes, 'an error under the first reporter')
    const after = eventWithMessage(second.recorder.envelopes, 'an error under the next reporter')
    expect(before.contexts?.run).toBeDefined()
    expect(after.contexts).not.toHaveProperty('run')
  })
})

function fixtureOptions(fixture: InProcessFixture) {
  // An empty browsers root, so the member fails the same way on every machine.
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return { configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot }
}

async function runOver(
  fixture: InProcessFixture,
  options: Partial<InProcessCliRunExecutionOptions> = {},
): Promise<void> {
  try {
    await runInProcessCliRun(
      {
        runRecord: testRunRecord(),
        ...fixtureOptions(fixture),
        executionContext: 'local-headless',
        ...options,
      },
      { patterns: [fixture.testPattern] },
    )
  } catch {
    // The member's framework error on the empty browsers root.
  }
}

// Each binding the run makes on the reporter, and each end of one, in order.
function trackBindings(reporter: ErrorReporter) {
  const bind = reporter.bindMask
  const log: string[] = []
  const open = new Set<number>()
  let next = 0
  vi.spyOn(reporter, 'bindMask').mockImplementation((mask) => {
    const id = next++
    open.add(id)
    log.push(`bind ${id}`)
    const end = bind(mask)
    return () => {
      if (open.delete(id)) log.push(`end ${id}`)
      end()
    }
  })
  return { log, open }
}

function exceptionValues(envelopes: readonly RecordedEnvelope[]): Array<string | undefined> {
  return recordedEvents(envelopes).map((event) => event.exception?.values?.[0]?.value)
}

describe('a run started in process', () => {
  it('subscribes the trace only while a reporter is on, and then sends the run with its platform', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const created = vi.spyOn(traceModule, 'createRunTraceSubscriber')
      await runOver(createInProcessFixture({ origin: target.origin, environment: 'local' }))
      expect(created).not.toHaveBeenCalled()

      const { recorder } = await startRecording()
      await runOver(createInProcessFixture({ origin: target.origin, environment: 'local' }))
      await settleReporting()

      expect(created).toHaveBeenCalledTimes(1)
      const run = only(spansOf(recorder.envelopes, 'agent_qa.run'))
      expect(attributeOf(run, 'agent_qa.platforms')).toEqual(['web'])
      expect(attributeOf(run, 'agent_qa.runner')).toBe('local')
      expect(spansOf(recorder.envelopes, 'agent_qa.test')).toHaveLength(1)
    } finally {
      await target.close()
    }
  }, 120_000)

  it('binds the run’s mask while it runs and ends the binding on the way out, and a report made just after still passes it', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const { recorder, reporter } = await startRecording()
      const bindings = trackBindings(reporter)
      const secret = 'zq7-only-the-run-knows'
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        plantedSecret: secret,
      })
      let openWhileRunning: number | undefined

      await runOver(fixture, {
        subscribers: () => ({
          flush: async () => {
            openWhileRunning = bindings.open.size
          },
        }),
      })
      reporter.capture(new Error(`a report quoting ${secret} after the run`))
      await settleReporting()

      expect(openWhileRunning).toBe(1)
      expect(bindings.log).toEqual(['bind 0', 'end 0'])
      expect(exceptionValues(recorder.envelopes)).toEqual([
        `a report quoting [secret:${PLANTED_SECRET_NAME}] after the run`,
      ])
      expect(serializedEnvelopes(recorder.envelopes)).not.toContain(secret)
    } finally {
      await target.close()
    }
  }, 120_000)

  it('keeps two runs’ masks bound while both are open, and each run ends its own binding', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const { recorder, reporter } = await startRecording()
      const bindings = trackBindings(reporter)
      const alpha = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const bravo = createInProcessFixture({ origin: target.origin, environment: 'local' })
      writeFileSync(join(alpha.project, '.env.secrets.local'), 'A_KEY=alpha-x-only-alpha\n')
      writeFileSync(join(bravo.project, '.env.secrets.local'), 'B_KEY=bravo-y-only-bravo\n')
      let arrived = 0
      let release: () => void = () => {}
      const bothOpen = new Promise<void>((resolve) => {
        release = resolve
      })
      // Each run waits in its subscriber flush, before it ends, until both runs are there.
      const hold: Partial<InProcessCliRunExecutionOptions> = {
        subscribers: () => ({
          flush: async () => {
            arrived += 1
            if (arrived === 2) {
              reporter.capture(new Error('alpha-x-only-alpha and bravo-y-only-bravo'))
              await reporter.flush(5_000)
              release()
            }
            await bothOpen
          },
        }),
      }

      await Promise.all([runOver(alpha, hold), runOver(bravo, hold)])
      await settleReporting()

      expect(arrived).toBe(2)
      expect(exceptionValues(recorder.envelopes)).toEqual(['[secret:A_KEY] and [secret:B_KEY]'])
      expect(bindings.log.slice(0, 2)).toEqual(['bind 0', 'bind 1'])
      expect(bindings.log.slice(2).sort()).toEqual(['end 0', 'end 1'])
    } finally {
      await target.close()
    }
  }, 120_000)
})

describe('the platforms a run names', () => {
  it('names web for a test in a browser, and android alone for a test or a suite on a remote Android device', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const produced = async (fixture: InProcessFixture, pattern: string) => {
        const inputs = await resolveRunInvocationInputs({
          configPath: fixture.configPath,
          patterns: [pattern],
        })
        const members = await produceMembersFromPatterns({ inputs, runId: generateRunId() })
        await members.closePluginHosts?.()
        return members.platforms
      }
      const browser = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const device = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        remoteDevice: { url: 'http://127.0.0.1:9', model: 'Samsung Galaxy S24' },
        suiteMemberDevices: [undefined, undefined],
        suiteDevice: REMOTE_DEVICE_NAME,
      })

      expect(await produced(browser, browser.testPattern)).toEqual(['web'])
      expect(await produced(device, device.testPattern)).toEqual(['android'])
      expect(await produced(device, device.suitePattern)).toEqual(['android'])
    } finally {
      await target.close()
    }
  }, 120_000)
})
