import { describe, expect, it } from 'vitest'

import { CURRENT_BUS_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  QuarantineAppliedEntry,
  RunEventEnvelope,
  RunEventType,
  StepStartedPayload,
} from '@vostride/agent-qa-schema'

import {
  QUARANTINE_TEST_ANNOTATION,
  createConsoleReporter,
  renderQuarantineSummarySegment,
} from '../../reporters/console-reporter.js'
import {
  QUARANTINED_CHECKOUT,
  QUARANTINED_ELSEWHERE,
  buildReporterFixture,
  createCapture,
} from './fixtures.js'

function renderFixture(
  verbose = true,
  quarantined?: readonly QuarantineAppliedEntry[],
): { output: string; secrets: ReturnType<typeof buildReporterFixture> } {
  const fixture = buildReporterFixture()
  const capture = createCapture()
  const reporter = createConsoleReporter({
    plain: true,
    colorize: false,
    verbose,
    write: capture.write,
    isTTY: false,
    ...(quarantined === undefined ? {} : { quarantined }),
  })
  for (const envelope of fixture.envelopes) reporter.handler(envelope)
  return { output: capture.output(), secrets: fixture }
}

describe('createConsoleReporter', () => {
  it('renders the v1 console surface — step, hook, per-test, and summary lines', () => {
    const { output } = renderFixture(true)
    expect(output).toContain('Open login page')
    expect(output).toContain('Submit credentials')
    expect(output).toContain('seed-db')
    expect(output).toContain('Login test')
    expect(output).toContain('Checkout test')
    // aggregate summary block
    expect(output).toContain('Tests:')
    expect(output).toMatch(/1 of 2 passed/)
  })

  it('testRetryScheduled resets per-test step accumulation (no double count)', () => {
    const { output } = renderFixture(true)
    // test 0 retries: only the final attempt's 1 step counts; test 1 adds 1 → 2 total.
    // Without the reset the aggregate would read 4 total.
    expect(output).toMatch(/2 total/)
    expect(output).not.toMatch(/4 total/)
    expect(output).toMatch(/1 passed/)
    expect(output).toMatch(/1 failed/)
  })

  it('is replay-equivalent — identical envelope stream yields byte-identical output (D-04)', () => {
    const fixture = buildReporterFixture()
    const a = createCapture()
    const b = createCapture()
    const repA = createConsoleReporter({
      plain: true,
      colorize: false,
      verbose: true,
      write: a.write,
      isTTY: false,
    })
    const repB = createConsoleReporter({
      plain: true,
      colorize: false,
      verbose: true,
      write: b.write,
      isTTY: false,
    })
    for (const envelope of fixture.envelopes) repA.handler(envelope)
    for (const envelope of fixture.envelopes) repB.handler(envelope)
    expect(a.output()).toBe(b.output())
  })

  it('exposes an awaitable flush()', async () => {
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const reporter = createConsoleReporter({ plain: true, write: capture.write, isTTY: false })
    for (const envelope of fixture.envelopes) reporter.handler(envelope)
    await expect(reporter.flush()).resolves.toBeUndefined()
  })
})

// ---- 390 D-15: the disposition a human reads --------------------------------------------------
//
// "QUARANTINED — failed, not counted" is the line that keeps the un-quarantine evidence flowing: it
// tells the reader the test ran, that it failed, and why the build is nonetheless green. The
// summary segment is what makes the green build's arithmetic add up.
//
// The byte-unchanged claim is pinned as a DIFFERENTIAL over one envelope stream, because an
// assertion that the zero case changed nothing is only load-bearing if the same code path WOULD
// have changed under a snapshot.

describe('createConsoleReporter — the 390 D-15 quarantine disposition', () => {
  const ANNOTATION = ` ${QUARANTINE_TEST_ANNOTATION}`
  const SEGMENT = ' · 1 quarantined failure'

  it('annotates the failing member and counts it separately in the summary', () => {
    const { output } = renderFixture(true, [QUARANTINED_CHECKOUT])
    expect(output).toContain(`FAIL Checkout test 1s${ANNOTATION}`)
    expect(output).toContain(`Tests:  1 of 2 passed${SEGMENT}`)
    // the failed-tests block names it too — the reader scanning red rows learns why the build is green
    expect(output).toContain(`  x Checkout test${ANNOTATION}`)
  })

  it('never rewrites the outcome — the member still reads FAIL and still counts as failed', () => {
    const { output } = renderFixture(true, [QUARANTINED_CHECKOUT])
    expect(output).toContain('FAIL Checkout test')
    expect(output).not.toContain('PASS Checkout test')
    // 1 of 2 passed: the quarantined failure is NOT promoted into the passed tally
    expect(output).toMatch(/Tests:  1 of 2 passed/)
    // the failed-tests block is still rendered at all
    expect(output).toContain('Failed tests:')
  })

  it('the annotation and the segment are the ONLY byte differences', () => {
    const baseline = renderFixture(true).output
    const marked = renderFixture(true, [QUARANTINED_CHECKOUT]).output

    // (a) the same stream DID change
    expect(marked).not.toBe(baseline)
    // (b) the annotation appears exactly twice: the per-test line and the failed-tests entry
    expect(marked.split(ANNOTATION)).toHaveLength(3)
    // (c) stripping both additions reproduces the un-quarantined output BYTE for BYTE
    expect(marked.split(ANNOTATION).join('').split(SEGMENT).join('')).toBe(baseline)
  })

  it('renders byte-identically when the snapshot is empty or addresses another test', () => {
    const baseline = renderFixture(true).output
    expect(renderFixture(true, []).output).toBe(baseline)
    expect(renderFixture(true, [QUARANTINED_ELSEWHERE]).output).toBe(baseline)
    expect(baseline).not.toContain('QUARANTINED')
  })

  it('says nothing about a PASSING member carrying an entry', () => {
    const { output } = renderFixture(true, [
      { ...QUARANTINED_CHECKOUT, filePath: 'tests/login.yaml', testName: 'Login test' },
    ])
    expect(output).toBe(renderFixture(true).output)
  })
})

describe('C441-DISPLAY', () => {
  it('the console reporter prints the masked payload as it is', () => {
    const fixture = buildReporterFixture()
    const capture = createCapture()
    const reporter = createConsoleReporter({
      plain: true,
      colorize: false,
      write: capture.write,
      isTTY: false,
    })
    for (const envelope of fixture.envelopes) {
      const payload = envelope.payload as StepStartedPayload
      const masked = envelope.type === 'stepStarted' && payload.stepIndex === 0
        ? { ...envelope, payload: { ...payload, stepText: 'Log in with [secret:PW_441]' } }
        : envelope
      reporter.handler(masked)
    }
    expect(capture.output()).toContain('Log in with [secret:PW_441]')
  })

  it('the console reporter prints a numbered placeholder unchanged and restores nothing', () => {
    const { output, secrets } = renderFixture(true)
    const placeholder = secrets.mask(secrets.stepSecret)
    expect(placeholder).not.toBe(secrets.stepSecret)
    expect(output).toContain(`Timeout waiting for token ${placeholder}`)
    for (const secret of [secrets.stepSecret, secrets.hookSecret, secrets.summarySecret]) {
      expect(output).not.toContain(secret)
    }
  })
})

function abortSkippedStream(): RunEventEnvelope[] {
  let seq = 0
  const env = (type: RunEventType, payload: object): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-444.1-15', type, payload }) as RunEventEnvelope
  return [
    env('runStarted', {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: { tier: 'suite', key: 'shop' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
      memberTestCount: 2,
    }),
    env('testStarted', { testId: 't0', testIndex: 0, name: 'Login flow', filePath: 'tests/login.yaml' }),
    env('testFinished', { testId: 't0', testIndex: 0, outcome: 'cancelled', durationMs: 500 }),
    env('testFinished', {
      testId: 't1',
      testIndex: 1,
      outcome: 'skipped',
      name: 'Checkout flow',
      filePath: 'tests/checkout.yaml',
    }),
    env('runFinished', { aggregateVerdict: 'cancelled' }),
  ]
}

describe('C444.1-REPORTER-WORDS', () => {
  it('the console names an abort-skipped member by its test', () => {
    const capture = createCapture()
    const reporter = createConsoleReporter({
      plain: true,
      colorize: false,
      write: capture.write,
      isTTY: false,
    })
    for (const envelope of abortSkippedStream()) reporter.handler(envelope)
    const output = capture.output()
    expect(output).toContain('skipped Checkout flow (skipped)')
    expect(output).not.toContain('Test 2')
  })

  it('the console prints a cancelled member and step as cancelled with their own glyph and counts', () => {
    const render = (plain: boolean): string => {
      const capture = createCapture()
      const reporter = createConsoleReporter({
        plain,
        colorize: !plain,
        write: capture.write,
        isTTY: false,
      })
      for (const envelope of cancelledStream()) reporter.handler(envelope)
      return capture.output()
    }

    const plain = render(true)
    expect(plain).toContain('cancelled Pay now 0ms\n')
    expect(plain).toContain('cancelled Checkout flow (cancelled)\n')
    expect(plain).toContain('Tests:  1 of 2 passed, 1 cancelled\n')
    expect(plain).toContain('Steps:  1 passed, 1 cancelled, 2 total\n')
    expect(plain).not.toContain('skipped')

    const colour = render(false)
    expect(colour.split('⊘')).toHaveLength(3)
    expect(colour).not.toContain('○')
  })
})

describe('the Cache line', () => {
  const render = (statusesByTest: readonly (readonly string[])[]): string => {
    const capture = createCapture()
    const reporter = createConsoleReporter({
      plain: true,
      colorize: false,
      write: capture.write,
      isTTY: false,
    })
    for (const envelope of cacheStream(statusesByTest)) reporter.handler(envelope)
    return capture.output()
  }
  const cacheLine = (output: string): string =>
    output.split('\n').find((line) => line.startsWith('Cache:')) ?? ''

  it('a run where no test used the cache prints Cache: disabled', () => {
    const line = cacheLine(render([['disabled', 'disabled']]))
    expect(line).toBe('Cache:  disabled')
    expect(line).not.toContain('hits,')
  })

  it('a run where one test had the cache off names it', () => {
    expect(cacheLine(render([['hit'], ['disabled']]))).toBe(
      'Cache:  1 hits, 0 misses (disabled for 1 test)',
    )
  })

  it('two tests with the cache off are counted as tests', () => {
    expect(cacheLine(render([['miss'], ['disabled', 'disabled'], ['disabled']]))).toContain(
      '(disabled for 2 tests)',
    )
  })

  it('a run with the cache on prints hits and misses as before', () => {
    expect(cacheLine(render([['hit'], ['miss']]))).toBe('Cache:  1 hits, 1 misses')
  })
})

function cacheStream(statusesByTest: readonly (readonly string[])[]): RunEventEnvelope[] {
  let seq = 0
  const env = (type: RunEventType, payload: object): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-cache-line', type, payload }) as RunEventEnvelope
  return [
    env('runStarted', {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: { tier: 'suite', key: 'shop' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
      memberTestCount: statusesByTest.length,
    }),
    ...statusesByTest.flatMap((statuses, testIndex) => [
      env('testStarted', {
        testId: `t${testIndex}`,
        testIndex,
        name: `Test ${testIndex}`,
        filePath: `tests/t${testIndex}.yaml`,
      }),
      ...statuses.flatMap((cacheStatus, stepIndex) => [
        env('stepStarted', { testIndex, stepIndex, stepText: `Step ${stepIndex}` }),
        env('stepFinalized', {
          testIndex,
          stepIndex,
          cacheStatus,
          verifierVerdict: { pass: true, reasoning: 'passed' },
          selfHealOccurred: false,
          briefDigest: 'digest',
          status: 'passed',
          durationMs: 100,
        }),
      ]),
      env('testFinished', { testId: `t${testIndex}`, testIndex, outcome: 'passed', durationMs: 100 }),
    ]),
    env('runFinished', { aggregateVerdict: 'passed' }),
  ]
}

function cancelledStream(): RunEventEnvelope[] {
  let seq = 0
  const env = (type: RunEventType, payload: object): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-444.1-15', type, payload }) as RunEventEnvelope
  const step = (testIndex: number, status: string, durationMs: number): object => ({
    testIndex,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: status === 'passed', reasoning: status },
    selfHealOccurred: false,
    briefDigest: 'digest',
    status,
    durationMs,
  })
  return [
    env('runStarted', {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: { tier: 'suite', key: 'shop' },
      executionContext: 'local-headless',
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
      memberTestCount: 2,
    }),
    env('testStarted', { testId: 't0', testIndex: 0, name: 'Login flow', filePath: 'tests/login.yaml' }),
    env('stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Open login' }),
    env('stepFinalized', step(0, 'passed', 400)),
    env('testFinished', { testId: 't0', testIndex: 0, outcome: 'passed', durationMs: 400 }),
    env('testStarted', {
      testId: 't1',
      testIndex: 1,
      name: 'Checkout flow',
      filePath: 'tests/checkout.yaml',
    }),
    env('stepStarted', { testIndex: 1, stepIndex: 0, stepText: 'Pay now' }),
    env('stepFinalized', step(1, 'cancelled', 0)),
    env('testFinished', { testId: 't1', testIndex: 1, outcome: 'cancelled', durationMs: 700 }),
    env('runFinished', { aggregateVerdict: 'cancelled' }),
  ]
}

describe('renderQuarantineSummarySegment (the pure composer)', () => {
  it('is SILENT at zero — every pre-390 summary line stays byte-frozen', () => {
    expect(renderQuarantineSummarySegment(0)).toBe('')
    expect(renderQuarantineSummarySegment(-1)).toBe('')
  })

  it('pins the rendered bytes and the plural', () => {
    expect(renderQuarantineSummarySegment(1)).toBe(' · 1 quarantined failure')
    expect(renderQuarantineSummarySegment(2)).toBe(' · 2 quarantined failures')
  })
})
