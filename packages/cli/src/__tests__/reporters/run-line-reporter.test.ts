import { afterEach, describe, expect, it, vi } from 'vitest'

import { colorsFor } from '@vostride/agent-qa-core/run-text-output'
import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  MemberTestOutcome,
  RunEventEnvelope,
  RunEventType,
  RunFinishedPayload,
  RunStartedPayload,
  RunStatus,
  StepFinalizedPayload,
  TestFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
} from '@vostride/agent-qa-schema'

import { createRunLineReporter, humanDuration } from '../../reporters/index.js'
import type { RunLineReporterHandle, RunLineReporterOptions } from '../../reporters/index.js'
import { buildReporterFixture } from './fixtures.js'

const RUN_ID = 'run-fixture-1'
const ESCAPE = '\u001b'
const COLORS_ON = colorsFor({ isTTY: false }, { FORCE_COLOR: '1' })
const COLORS_OFF = colorsFor({ isTTY: false }, { NO_COLOR: '1' })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function envelope(type: RunEventType, payload: unknown, ts = 1_000): RunEventEnvelope {
  return { seq: 0, ts, runId: RUN_ID, type, payload } as RunEventEnvelope
}

function runStarted(memberTestCount: number, ts = 1_000): RunEventEnvelope {
  const payload: RunStartedPayload = {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
    memberTestCount,
  }
  return envelope('runStarted', payload, ts)
}

function testStarted(testIndex: number, name: string, suiteName?: string): RunEventEnvelope {
  const payload: TestStartedPayload = {
    testId: `t${testIndex}`,
    testIndex,
    name,
    filePath: `tests/${testIndex}.yaml`,
    ...(suiteName === undefined
      ? {}
      : { suiteId: 'suite-1', suiteName, suiteIndex: 0, suiteTotal: 1 }),
  }
  return envelope('testStarted', payload)
}

function stepFinalized(
  testIndex: number,
  stepIndex: number,
  status: 'passed' | 'failed',
  error?: string,
): RunEventEnvelope {
  const payload: StepFinalizedPayload = {
    testIndex,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: status === 'passed', reasoning: 'checked' },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status,
    durationMs: 500,
    ...(error === undefined ? {} : { error }),
  }
  return envelope('stepFinalized', payload)
}

function retryScheduled(testIndex: number): RunEventEnvelope {
  const payload: TestRetryScheduledPayload = {
    testId: `t${testIndex}`,
    testIndex,
    attempt: 1,
    maxAttempts: 2,
  }
  return envelope('testRetryScheduled', payload)
}

function testFinished(
  testIndex: number,
  outcome: MemberTestOutcome,
  failureSummary?: string,
): RunEventEnvelope {
  const payload: TestFinishedPayload = {
    testId: `t${testIndex}`,
    testIndex,
    outcome,
    durationMs: 1_000,
    ...(failureSummary === undefined ? {} : { failureSummary }),
  }
  return envelope('testFinished', payload)
}

function runFinished(aggregateVerdict: RunStatus, ts: number): RunEventEnvelope {
  const payload: RunFinishedPayload = { aggregateVerdict, disposition: 'detached', finalSeq: 0 }
  return envelope('runFinished', payload, ts)
}

function record(options: RunLineReporterOptions = {}): {
  reporter: RunLineReporterHandle
  messages: string[]
  feed: (envelopes: readonly RunEventEnvelope[]) => void
} {
  const messages: string[] = []
  const reporter = createRunLineReporter({
    platforms: ['ios'],
    colors: COLORS_OFF,
    ...options,
    print: (message) => {
      messages.push(message)
    },
  })
  return {
    reporter,
    messages,
    feed: (envelopes) => {
      for (const each of envelopes) reporter.handler(each)
    },
  }
}

function oneTest(outcome: MemberTestOutcome, verdict: RunStatus, steps: RunEventEnvelope[] = []) {
  return [
    runStarted(1, 1_000),
    testStarted(0, 'Cart total'),
    ...steps,
    testFinished(0, outcome),
    runFinished(verdict, 147_000),
  ]
}

const SUITE_NAMES = ['Login', 'Cart total', 'Search', 'Checkout', 'Profile']

function fiveTestSuite(failing: ReadonlyMap<number, RunEventEnvelope[]>): RunEventEnvelope[] {
  const envelopes = [runStarted(5, 1_000)]
  SUITE_NAMES.forEach((name, index) => {
    envelopes.push(testStarted(index, name, 'Checkout suite'))
    const failedSteps = failing.get(index)
    if (failedSteps === undefined) {
      envelopes.push(stepFinalized(index, 0, 'passed'), testFinished(index, 'passed'))
    } else {
      envelopes.push(...failedSteps, testFinished(index, 'failed'))
    }
  })
  envelopes.push(runFinished(failing.size > 0 ? 'failed' : 'passed', 363_000))
  return envelopes
}

describe('createRunLineReporter', () => {
  it('prints a passing test as a start line with its platform and short id, then its result', () => {
    const { messages, feed } = record()
    feed(oneTest('passed', 'passed', [stepFinalized(0, 0, 'passed')]))
    expect(messages).toEqual(['▶ Cart total · ios · run-fixture', '✓ Cart total · passed · 2m 26s'])
  })

  it('puts the failed step and its masked error under a failed result', () => {
    const fixture = buildReporterFixture()
    const error = fixture.mask(
      `Expected $24.00 but the page shows $36.00 for ${fixture.stepSecret}`,
    )
    const { messages, feed } = record()
    feed(
      oneTest('failed', 'failed', [
        stepFinalized(0, 0, 'passed'),
        stepFinalized(0, 1, 'passed'),
        stepFinalized(0, 2, 'failed', error),
      ]),
    )
    expect(messages).toEqual([
      '▶ Cart total · ios · run-fixture',
      `✗ Cart total · failed · 2m 26s\nstep 3: ${error}`,
    ])
    expect(messages.join('\n')).toMatch(/\[secret:\w+\]/)
    expect(messages.join('\n')).not.toContain(fixture.stepSecret)
  })

  it('shows the first line of the failure summary when no step failed, and nothing without one', () => {
    const summarised = record()
    summarised.feed([
      runStarted(1, 1_000),
      testStarted(0, 'Cart total'),
      testFinished(0, 'failed', 'Setup hook exited 1\nmore detail'),
      runFinished('failed', 13_000),
    ])
    expect(summarised.messages[1]).toBe('✗ Cart total · failed · 12s\nSetup hook exited 1')

    const bare = record()
    bare.feed(oneTest('failed', 'failed'))
    expect(bare.messages[1]).toBe('✗ Cart total · failed · 2m 26s')
  })

  it('prints a failed suite as one start line and one result line with its first failure', () => {
    const { messages, feed } = record()
    feed(
      fiveTestSuite(
        new Map([
          [1, [stepFinalized(1, 0, 'passed'), stepFinalized(1, 2, 'failed', 'Expected $24.00')]],
          [3, [stepFinalized(3, 0, 'failed', 'Pay button missing')]],
        ]),
      ),
    )
    expect(messages).toEqual([
      '▶ Checkout suite · 5 tests · ios · run-fixture',
      '✗ Checkout suite · 2 of 5 failed · 6m 2s\nCart total · step 3: Expected $24.00',
    ])
  })

  it('prints a passing suite as how many passed', () => {
    const { messages, feed } = record()
    feed(fiveTestSuite(new Map()))
    expect(messages).toEqual([
      '▶ Checkout suite · 5 tests · ios · run-fixture',
      '✓ Checkout suite · 5 passed · 6m 2s',
    ])
  })

  it('names a cancelled or timed-out run by its verdict', () => {
    const cancelled = record()
    cancelled.feed([
      runStarted(1, 1_000),
      testStarted(0, 'Cart total'),
      runFinished('cancelled', 13_000),
    ])
    expect(cancelled.messages[1]).toBe('⊘ Cart total · cancelled · 12s')

    const timedOut = record()
    timedOut.feed([
      runStarted(1, 1_000),
      testStarted(0, 'Cart total'),
      testFinished(0, 'timeout'),
      runFinished('timeout', 13_000),
    ])
    expect(timedOut.messages[1]).toBe('✗ Cart total · timeout · 12s')
  })

  it('leaves the platform out when there is none and joins several', () => {
    const none = record({ platforms: [] })
    none.feed(oneTest('passed', 'passed'))
    expect(none.messages[0]).toBe('▶ Cart total · run-fixture')

    const two = record({ platforms: ['android', 'ios'] })
    two.feed(oneTest('passed', 'passed'))
    expect(two.messages[0]).toBe('▶ Cart total · android, ios · run-fixture')
  })

  it('drops the failed step of an attempt that was retried', () => {
    const passedOnRetry = record()
    passedOnRetry.feed(
      oneTest('passed', 'passed', [
        stepFinalized(0, 1, 'failed', 'first attempt'),
        retryScheduled(0),
        stepFinalized(0, 1, 'passed'),
      ]),
    )
    expect(passedOnRetry.messages[1]).toBe('✓ Cart total · passed · 2m 26s')

    const failedAgain = record()
    failedAgain.feed(
      oneTest('failed', 'failed', [
        stepFinalized(0, 1, 'failed', 'first attempt'),
        retryScheduled(0),
        stepFinalized(0, 1, 'passed'),
        stepFinalized(0, 3, 'failed', 'second attempt'),
      ]),
    )
    expect(failedAgain.messages[1]).toBe('✗ Cart total · failed · 2m 26s\nstep 4: second attempt')
  })

  it('prints exactly two messages for the reporters fixture, its secrets still masked', () => {
    const fixture = buildReporterFixture()
    const { messages, feed } = record()
    feed(fixture.envelopes)
    const first = fixture.envelopes[0]
    const last = fixture.envelopes[fixture.envelopes.length - 1]
    expect(messages).toEqual([
      '▶ Auth · 2 tests · ios · run-fixture',
      `✗ Auth · 1 of 2 failed · ${humanDuration((last?.ts ?? 0) - (first?.ts ?? 0))}\nCheckout test · step 1: Element not found`,
    ])
    const output = messages.join('\n')
    expect(output).not.toContain(fixture.stepSecret)
    expect(output).not.toContain(fixture.hookSecret)
    expect(output).not.toContain(fixture.summarySecret)
  })

  it('colours only the result icon: green, red or yellow', () => {
    const green = COLORS_ON.green('✓')
    const red = COLORS_ON.red('✗')
    const yellow = COLORS_ON.yellow('⊘')
    expect(green).toContain(ESCAPE)

    const passed = record({ colors: COLORS_ON })
    passed.feed(oneTest('passed', 'passed'))
    expect(passed.messages).toEqual([
      '▶ Cart total · ios · run-fixture',
      `${green} Cart total · passed · 2m 26s`,
    ])

    const failed = record({ colors: COLORS_ON })
    failed.feed(oneTest('failed', 'failed', [stepFinalized(0, 0, 'failed', 'boom')]))
    expect(failed.messages[1]).toBe(`${red} Cart total · failed · 2m 26s\nstep 1: boom`)

    const cancelled = record({ colors: COLORS_ON })
    cancelled.feed(oneTest('cancelled', 'cancelled'))
    expect(cancelled.messages[1]).toBe(`${yellow} Cart total · cancelled · 2m 26s`)
  })

  it('holds no escape character with colours off', () => {
    const { messages, feed } = record({ colors: COLORS_OFF })
    feed(fiveTestSuite(new Map([[1, [stepFinalized(1, 0, 'failed', 'boom')]]])))
    expect(messages).toHaveLength(2)
    expect(messages.join('\n')).not.toContain(ESCAPE)
  })

  it('survives a malformed envelope and keeps printing', () => {
    const { reporter, messages, feed } = record()
    expect(() => reporter.handler(envelope('testStarted', null))).not.toThrow()
    expect(() => reporter.handler(envelope('stepFinalized', undefined))).not.toThrow()
    feed(oneTest('passed', 'passed'))
    expect(messages).toEqual(['▶ Cart total · ios · run-fixture', '✓ Cart total · passed · 2m 26s'])
  })

  it('prints a tagged run line on stdout by default, an error continuing under the message', () => {
    vi.stubEnv('NO_COLOR', '1')
    vi.stubEnv('GITHUB_ACTIONS', '')
    const printed: string[] = []
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
      printed.push(String(text))
    })
    const reporter = createRunLineReporter({ platforms: ['ios'] })
    for (const each of oneTest('failed', 'failed', [
      stepFinalized(0, 2, 'failed', 'Expected $24.00 but the\npage shows $36.00'),
    ])) {
      reporter.handler(each)
    }
    const continuation = ' '.repeat('HH:MM:SS'.length + 2 + 9 + 2)
    expect(printed).toHaveLength(2)
    expect(printed[0]).toMatch(/^\d{2}:\d{2}:\d{2} {2}run {8}▶ Cart total · ios · run-fixture$/)
    expect(printed[1]?.split('\n')).toEqual([
      expect.stringMatching(/^\d{2}:\d{2}:\d{2} {2}run {8}✗ Cart total · failed · 2m 26s$/),
      `${continuation}step 3: Expected $24.00 but the`,
      `${continuation}page shows $36.00`,
    ])
  })
})
