import { afterEach, describe, expect, it, vi } from 'vitest'

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
import type { ConsoleReporterOptions } from '../../reporters/console-reporter.js'
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

  it('is replay-equivalent — identical envelope stream yields byte-identical output', () => {
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

// A differential over one envelope stream, so the zero case is shown to leave the output unchanged.

describe('createConsoleReporter — the quarantine disposition', () => {
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

describe('the console reporter prints masked payloads', () => {
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

describe('console words for abort-skipped and cancelled members', () => {
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

const ACTIONS_ENV = { GITHUB_ACTIONS: 'true' }
const WRAPPED_BLOCK = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u

function failedStepStream(errors: readonly string[]): RunEventEnvelope[] {
  let seq = 0
  const env = (type: RunEventType, payload: object): RunEventEnvelope =>
    ({ seq: seq++, ts: 1_000 + seq, runId: 'run-actions-output', type, payload }) as RunEventEnvelope
  return errors.flatMap((error, stepIndex) => [
    env('stepStarted', { testIndex: 0, stepIndex, stepText: `Submit form ${stepIndex}` }),
    env('stepFinalized', {
      testIndex: 0,
      stepIndex,
      cacheStatus: 'miss',
      verifierVerdict: { pass: false, reasoning: 'failed' },
      selfHealOccurred: false,
      briefDigest: 'digest',
      status: 'failed',
      durationMs: 100,
      error,
    }),
  ])
}

function actionsStream(events: readonly (readonly [RunEventType, object])[]): RunEventEnvelope[] {
  return events.map(
    ([type, payload], seq) =>
      ({ seq, ts: 1_000 + seq, runId: 'run-actions-output', type, payload }) as RunEventEnvelope,
  )
}

function recordChunks(
  envelopes: readonly RunEventEnvelope[],
  options: ConsoleReporterOptions = { plain: true, isTTY: false },
): string[] {
  const chunks: string[] = []
  const reporter = createConsoleReporter({
    ...options,
    colorize: false,
    write: (chunk) => {
      chunks.push(chunk)
    },
    env: ACTIONS_ENV,
  })
  for (const envelope of envelopes) reporter.handler(envelope)
  return chunks
}

describe('the console reporter under GitHub Actions', () => {
  it('wraps a failing step and its error in one stop-commands pair', () => {
    const chunks = recordChunks(failedStepStream(['::set-output name=x::y\n##[error]x']))
    const blocks = chunks.filter((chunk) => chunk.includes('set-output'))
    expect(blocks).toHaveLength(1)
    const [block] = blocks
    expect(block).toMatch(WRAPPED_BLOCK)
    expect(block).toContain('x Submit form 0 100ms\n')
    expect(block).toContain('  Error: ::set-output name=x::y\n##[error]x\n')
  })

  it('gives each failing step its own token', () => {
    const chunks = recordChunks(failedStepStream(['::set-output name=a::b', '##[error]c']))
    const tokens = chunks
      .filter((chunk) => chunk.includes('Error:'))
      .map((chunk) => WRAPPED_BLOCK.exec(chunk)?.[1])
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toBeDefined()
    expect(tokens[1]).toBeDefined()
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('is plain without a plain option, so no line is cleared or overwritten', () => {
    const chunks = recordChunks(failedStepStream(['##[error]x']), { isTTY: true })
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) expect(chunk.startsWith('\x1B[2K\r')).toBe(false)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const runStarted = {
    busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
    scope: { tier: 'suite', key: 'shop' },
    executionContext: 'local-headless',
    buildOrdinal: 1,
    configDigests: { suiteConfigDigest: 'aaaa', testConfigDigest: 'bbbb' },
    memberTestCount: 1,
  }

  it('wraps the run start line that names the model', () => {
    vi.stubEnv('AGENT_QA_LLM_MODEL', '::set-output name=x::y')
    const chunks = recordChunks(actionsStream([['runStarted', runStarted]]))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatch(WRAPPED_BLOCK)
    expect(chunks[0]).toContain('Model: ::set-output name=x::y')
  })

  it('wraps a failing hook, its error and its variables in one stop-commands pair', () => {
    const chunks = recordChunks(
      actionsStream([
        [
          'hookFinished',
          {
            hookName: 'seed-db',
            phase: 'setup',
            hookExecutionId: 'h1',
            scope: 'test',
            status: 'failed',
            durationMs: 300,
            stdout: '',
            stderr: '',
            error: '::add-mask::x',
            variables: { REGION: '##[error]v' },
            kind: 'hook',
          },
        ],
      ]),
      { plain: true, isTTY: false, verbose: true },
    )
    expect(chunks).toHaveLength(1)
    const [block] = chunks
    expect(block).toMatch(WRAPPED_BLOCK)
    expect(block).toContain('  x seed-db 300ms\n')
    expect(block).toContain('    Error: ::add-mask::x\n')
    expect(block).toContain('    -> REGION=##[error]v\n')
  })

  it('wraps the suite line, a named hook label and a test result line in separate pairs', () => {
    const crafted = '::set-output name=x::y'
    const chunks = recordChunks(
      actionsStream([
        [
          'testStarted',
          { testId: 't0', testIndex: 0, name: crafted, suiteId: 's1', suiteName: crafted },
        ],
        [
          'hookStarted',
          { hookName: crafted, phase: 'inline', hookExecutionId: 'h1', scope: 'test' },
        ],
        ['testFinished', { testId: 't0', testIndex: 0, outcome: 'passed', durationMs: 100 }],
      ]),
    )
    const suite = chunks.find((chunk) => chunk.includes('Suite:'))
    const hook = chunks.find((chunk) => chunk.includes('Running hook:'))
    const result = chunks.find((chunk) => chunk.includes('PASS'))
    for (const block of [suite, hook, result]) {
      expect(block).toMatch(WRAPPED_BLOCK)
      expect(block).toContain(crafted)
    }
  })

  it('wraps each failed test with its summary and leaves the labels and totals bare', () => {
    const chunks = recordChunks(
      actionsStream([
        ['runStarted', runStarted],
        ['testStarted', { testId: 't0', testIndex: 0, name: '##[error]x' }],
        [
          'testFinished',
          {
            testId: 't0',
            testIndex: 0,
            outcome: 'failed',
            durationMs: 100,
            failureSummary: 'first ::warning::a\nsecond ##[error]b',
          },
        ],
        ['runFinished', { aggregateVerdict: 'failed' }],
      ]),
    )
    const failure = chunks.find((chunk) => chunk.includes('first ::warning::a'))
    expect(failure).toMatch(WRAPPED_BLOCK)
    expect(failure).toContain('  x ##[error]x\n    first ::warning::a\n    second ##[error]b\n')
    expect(chunks).toContain('Failed tests:\n')
    const totals = chunks.filter((chunk) => /^(Tests|Steps|Cache|Time):/u.test(chunk))
    expect(totals).toHaveLength(4)
  })
})

describe('renderQuarantineSummarySegment (the pure composer)', () => {
  it('is SILENT at zero — a summary line with no quarantined failure stays byte-frozen', () => {
    expect(renderQuarantineSummarySegment(0)).toBe('')
    expect(renderQuarantineSummarySegment(-1)).toBe('')
  })

  it('pins the rendered bytes and the plural', () => {
    expect(renderQuarantineSummarySegment(1)).toBe(' · 1 quarantined failure')
    expect(renderQuarantineSummarySegment(2)).toBe(' · 2 quarantined failures')
  })
})
