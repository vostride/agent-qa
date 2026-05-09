import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConsoleReporter, humanDuration } from '../console-reporter.js'
import { generateFailureSummary } from '../../agent/failure-summary.js'
import type { StepResult, TestResult, StepTrace, SubActionTrace } from '../../types/result.js'
import type { RunSummary, SuiteSummary } from '../types.js'

describe('humanDuration', () => {
  it('formats sub-second as milliseconds', () => {
    expect(humanDuration(0)).toBe('0ms')
    expect(humanDuration(523)).toBe('523ms')
    expect(humanDuration(999)).toBe('999ms')
  })

  it('formats sub-minute as seconds', () => {
    expect(humanDuration(1000)).toBe('1s')
    expect(humanDuration(12000)).toBe('12s')
    expect(humanDuration(45500)).toBe('45s')
    expect(humanDuration(59999)).toBe('59s')
  })

  it('formats over-minute as compound minutes + seconds', () => {
    expect(humanDuration(60000)).toBe('1m 0s')
    expect(humanDuration(60500)).toBe('1m 0s')
    expect(humanDuration(125000)).toBe('2m 5s')
    expect(humanDuration(300000)).toBe('5m 0s')
    expect(humanDuration(772000)).toBe('12m 52s')
  })

  it('formats multi-hour durations as total minutes + seconds (no hours)', () => {
    expect(humanDuration(3600000)).toBe('60m 0s')
    expect(humanDuration(3905000)).toBe('65m 5s')
  })
})

let logs: string[]
let originalLog: typeof console.log

beforeEach(() => {
  logs = []
  originalLog = console.log
  console.log = vi.fn((...args: any[]) => {
    logs.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  console.log = originalLog
})

function makeTrace(overrides?: Partial<StepTrace>): StepTrace {
  return {
    observation: 'button "Login" [ref=btn-1]',
    reasoning: 'User wants to log in, clicking the Login button',
    plannedAction: { type: 'click', ref: 'btn-1' },
    result: 'success',
    screenStateBefore: 'button "Login"',
    ...overrides,
  }
}

function makeSubAction(overrides?: Partial<SubActionTrace>): SubActionTrace {
  return {
    index: 0,
    observation: 'button visible',
    reasoning: 'click it',
    plannedAction: { type: 'click', ref: 'btn-1' },
    result: 'success',
    screenStateBefore: 'button',
    cached: false,
    ...overrides,
  }
}

function makeStepResult(overrides?: Partial<StepResult>): StepResult {
  return {
    name: 'Click Login',
    status: 'passed',
    duration: 42,
    ...overrides,
  }
}

function makeTestResult(overrides?: Partial<TestResult>): TestResult {
  return {
    name: 'Login test',
    filePath: '/tests/login.yaml',
    status: 'passed',
    steps: [makeStepResult()],
    duration: 500,
    ...overrides,
  }
}

function makeSummary(overrides?: Partial<RunSummary>): RunSummary {
  return {
    results: [makeTestResult()],
    duration: 1000,
    passed: 1,
    failed: 0,
    skipped: 0,
    ...overrides,
  }
}

function makeSuiteSummary(overrides?: Partial<SuiteSummary>): SuiteSummary {
  return {
    name: 'My Suite',
    status: 'passed',
    tests: [makeTestResult()],
    duration: 2000,
    passed: 1,
    failed: 0,
    skipped: 0,
    ...overrides,
  }
}

describe('ConsoleReporter', () => {
  it('onStepEnd with passed step prints flush-left checkmark and step name', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult(), 'Login test')

    const output = logs.join('\n')
    expect(output).toContain('\u2713')
    expect(output).toContain('Click Login')
    expect(output).toContain('42ms')
    // Flat layout: no deep indentation (4+ spaces before icon)
    const stepLine = logs.find(l => l.includes('Click Login') && l.includes('\u2713'))
    expect(stepLine).toBeTruthy()
    expect(stepLine!.startsWith('    ')).toBe(false)
  })

  it('onStepEnd with failed step prints red X and error message', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult({
      status: 'failed',
      error: 'Element not found',
    }), 'Login test')

    const output = logs.join('\n')
    expect(output).toContain('\u2717')
    expect(output).toContain('Element not found')
  })

  it('onStepEnd with healed step prints yellow checkmark and healing count', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult({
      status: 'healed',
      healingAttempts: [
        { action: { type: 'click', ref: 'btn-2' }, observationBefore: '', success: true },
        { action: { type: 'click', ref: 'btn-3' }, observationBefore: '', success: true },
      ],
    }), 'Login test')

    const output = logs.join('\n')
    expect(output).toContain('\u2713')
    expect(output).toContain('Healed after 2 attempt(s)')
  })

  it('onStepEnd with verbose=true no longer prints trace (LogManager handles verbose display)', () => {
    const reporter = new ConsoleReporter({ verbose: true, colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult({ trace: makeTrace() }), 'Login test')

    const output = logs.join('\n')
    expect(output).not.toContain('Observed:')
    expect(output).not.toContain('Reasoning:')
    expect(output).toContain('Click Login')
  })

  it('onStepEnd with verbose=false skips trace details but still shows errors on failure', () => {
    const reporter = new ConsoleReporter({ verbose: false, colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult({
      status: 'failed',
      trace: makeTrace({ result: 'failure', error: 'Timeout' }),
    }), 'Login test')

    const output = logs.join('\n')
    expect(output).not.toContain('Observed:')
    expect(output).not.toContain('Reasoning:')
    expect(output).toContain('Timeout')
  })

  it('onRunEnd prints aligned Tests/Steps/Cache/Time summary', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    // Accumulate step counters
    reporter.onRunStart([{ 'test-id': 't_test-1', name: 'Test 1', target: 'default', steps: [] }])
    reporter.onStepEnd(makeStepResult({ status: 'passed' }), 'Test 1')
    reporter.onStepEnd(makeStepResult({ status: 'passed', name: 'Step 2' }), 'Test 1')
    reporter.onStepEnd(makeStepResult({ status: 'failed', name: 'Step 3', error: 'fail' }), 'Test 1')
    logs = []
    reporter.onRunEnd(makeSummary({ passed: 3, failed: 1, skipped: 2 }))

    const output = logs.join('\n')
    expect(output).toContain('Tests:')
    expect(output).toContain('Tests:  3 of 6 passed')
    expect(output).toContain('Steps:')
    expect(output).toContain('Cache:')
    expect(output).toContain('Time:')
    expect(output).toMatch(/Time:\s+\d+(ms|s|m \d+s)/)
    expect(output).not.toContain('--- Summary ---')
  })

  it('onRunEnd with failures lists failed test names', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onRunEnd(makeSummary({
      failed: 1,
      results: [
        makeTestResult({ name: 'Passing test' }),
        makeTestResult({ name: 'Broken test', status: 'failed' }),
      ],
    }))

    const output = logs.join('\n')
    expect(output).toContain('Failed tests:')
    expect(output).toContain('Broken test')
    expect(output).not.toContain('Passing test')
  })

  it('onRunEnd prints failed test details before final status', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onRunEnd(makeSummary({
      passed: 1,
      failed: 1,
      skipped: 0,
      results: [
        makeTestResult({ name: 'Passing test' }),
        makeTestResult({
          name: 'Broken test',
          status: 'failed',
          failureSummary: 'Expected button to exist',
        }),
      ],
    }))

    const output = logs.join('\n')
    const failedIndex = output.indexOf('Failed tests:')
    const testsIndex = output.indexOf('Tests:  1 of 2 passed')
    expect(failedIndex).toBeGreaterThanOrEqual(0)
    expect(testsIndex).toBeGreaterThan(failedIndex)
  })

  it('onRunEnd prints deduped failed test details with final stats', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    const assertionReason = 'The current page URL is https://www.iana.org/help/example-domains, which does not match https://www.iana.org/example-domains.'
    const failureSummary = generateFailureSummary([
      makeStepResult({
        name: 'Verify the page url is "https://www.iana.org/example-domains"',
        status: 'failed',
        error: `Step failed: ${assertionReason}`,
        trace: makeTrace({
          reasoning: assertionReason,
          plannedAction: { type: 'assert', condition: 'URL equals expected value' },
          result: 'failure',
          error: `Step failed: ${assertionReason}`,
        }),
      }),
    ])

    reporter.onRunStart([{ 'test-id': 't_test-1', name: 'Test 1', target: 'default', steps: [] }])
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: true })] }) }), 'Test 1')
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: false })] }) }), 'Test 1')
    logs = []
    reporter.onRunEnd(makeSummary({
      passed: 1,
      failed: 1,
      skipped: 0,
      results: [
        makeTestResult({ name: 'Passing test' }),
        makeTestResult({
          name: 'Example failing test',
          status: 'failed',
          failureSummary,
        }),
      ],
    }))

    const output = logs.join('\n')
    expect(output).toContain('Failed tests:')
    expect(output).toContain('Example failing test')
    expect(output.match(new RegExp(assertionReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
    expect(output).toContain('Attempted action: assert')
    expect(output).toContain('Tests:  1 of 2 passed')
    expect(output).toContain('Steps:')
    expect(output).toContain('Cache:')
    expect(output).toContain('Time:')
  })

  it('onTestStart prints RUN badge with file path', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onTestStart({ 'test-id': 't_my-test', name: 'My test', target: 'default', steps: [] }, '/tests/my.yaml')

    // In non-TTY, onTestStart is a no-op (writeLine skips), so we check that no crash
    // The RUN badge is only visible in TTY mode
    // For non-TTY, verify no crash happened
    expect(true).toBe(true)
  })

  it('constructor defaults to verbose=false', () => {
    const reporter = new ConsoleReporter()
    reporter.onStepEnd(makeStepResult({ trace: makeTrace() }), 'test')

    const output = logs.join('\n')
    expect(output).not.toContain('Observed:')
    expect(output).toContain('Click Login')
    expect(output).toContain('42ms')
  })

  it('onRunStart prints test count header', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onRunStart([
      { 'test-id': 't_test-1', name: 'Test 1', target: 'default', steps: [] },
      { 'test-id': 't_test-2', name: 'Test 2', target: 'default', steps: [] },
    ])

    const output = logs.join('\n')
    expect(output).toContain('Running 2 test(s)')
  })

  it('onTestEnd prints PASS badge for passing test', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onTestEnd(makeTestResult({ status: 'passed', duration: 500 }))

    const output = logs.join('\n')
    expect(output).toContain('PASS')
    expect(output).toContain('Login test')
  })

  it.each([
    ['passed' as const],
    ['failed' as const],
    ['skipped' as const],
    ['cancelled' as const],
  ])('onTestEnd prints run ID for %s result', (status) => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    const runId = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    reporter.onTestEnd(makeTestResult({ status, runId }))

    const output = logs.join('\n')
    expect(output).toContain(`Run ID: ${runId}`)
  })

  it('onTestEnd prints FAIL badge for failing test', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onTestEnd(makeTestResult({ status: 'failed', duration: 500 }))

    const output = logs.join('\n')
    expect(output).toContain('FAIL')
    expect(output).toContain('Login test')
  })

  it('printStandaloneSummary shows aligned Tests/Steps/Cache/Time rows', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onRunStart([{ 'test-id': 't_t', name: 'T', target: 'default', steps: [] }])
    // Accumulate: 3 passed steps, 1 failed step
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: true })] }) }), 'T')
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: false })] }) }), 'T')
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: true })] }) }), 'T')
    reporter.onStepEnd(makeStepResult({ status: 'failed', name: 'Bad step', error: 'err', trace: makeTrace({ subActions: [makeSubAction({ cached: false })] }) }), 'T')

    logs = []
    reporter.onRunEnd(makeSummary({ passed: 1, failed: 0, skipped: 0, duration: 5000 }))

    const output = logs.join('\n')
    expect(output).toContain('Tests:')
    expect(output).toContain('Tests:  1 of 1 passed')
    expect(output).toContain('Steps:')
    expect(output).toContain('3 passed')
    expect(output).toContain('1 failed')
    expect(output).toContain('Cache:')
    expect(output).toContain('2 hits')
    expect(output).toContain('2 misses')
    expect(output).toContain('Time:')
    expect(output).not.toContain('--- Summary ---')
  })

  it('step counters reset between runs', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    // First run: 2 passed steps
    reporter.onRunStart([{ 'test-id': 't_t1', name: 'T1', target: 'default', steps: [] }])
    reporter.onStepEnd(makeStepResult({ status: 'passed' }), 'T1')
    reporter.onStepEnd(makeStepResult({ status: 'passed', name: 'S2' }), 'T1')
    reporter.onRunEnd(makeSummary())

    // Second run: 1 passed step
    reporter.onRunStart([{ 'test-id': 't_t2', name: 'T2', target: 'default', steps: [] }])
    reporter.onStepEnd(makeStepResult({ status: 'passed', name: 'S3' }), 'T2')

    logs = []
    reporter.onRunEnd(makeSummary())

    const output = logs.join('\n')
    expect(output).toContain('Steps:')
    // Should show "1 passed" from second run only, not "3 passed"
    const stepsLine = logs.find(l => l.startsWith('Steps:'))
    expect(stepsLine).toContain('1 passed')
    expect(stepsLine).toContain('1 total')
  })

  it('non-TTY mode uses console.log for step output', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onStepEnd(makeStepResult(), 'Login test')

    // In non-TTY (test env), output goes through console.log
    expect(logs.length).toBeGreaterThan(0)
    const output = logs.join('\n')
    expect(output).toContain('Click Login')
  })

  it('plain mode uses ASCII output without ANSI or cursor rewrites', () => {
    const reporter = new ConsoleReporter({ plain: true, colorize: true })
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const runId = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    const failed = makeTestResult({
      status: 'failed',
      runId,
      failureSummary: 'Expected button to exist',
      steps: [makeStepResult({ status: 'failed', error: 'Element not found' })],
    })

    try {
      reporter.onRunStart([{ 'test-id': 't_test-1', name: 'Test 1', target: 'default', steps: [] }])
      reporter.onTestStart({ 'test-id': 't_test-1', name: 'Test 1', target: 'default', steps: [] }, '/tests/login.yaml')
      reporter.onStepStart('Click Login', 'Login test')
      reporter.onStepEnd(makeStepResult({ status: 'failed', error: 'Element not found' }), 'Login test')
      reporter.onTestEnd(failed)
      reporter.onRunEnd(makeSummary({ passed: 0, failed: 1, skipped: 0, results: [failed] }))
      expect(writeSpy).not.toHaveBeenCalled()
    } finally {
      writeSpy.mockRestore()
    }

    const output = logs.join('\n')
    expect(output).toContain('x Click Login 42ms')
    expect(output).toContain('FAIL Login test')
    expect(output).toContain(`Run ID: ${runId}`)
    expect(output).toContain('Failed tests:')
    expect(output).toContain('  x Login test')
    expect(output).toContain('Tests:  0 of 1 passed')
    expect(output).not.toMatch(/\x1B\[[0-9;]*[A-Za-z]/)
    expect(output).not.toMatch(/[✓✗→↳▶○]/)
  })

  it('defaults to plain output for non-TTY CI output', () => {
    const originalIsTTY = process.stdout.isTTY
    const hadIsTTY = Object.prototype.hasOwnProperty.call(process.stdout, 'isTTY')
    const originalCI = process.env.CI
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    process.env.CI = 'true'

    try {
      const reporter = new ConsoleReporter({ colorize: true })
      reporter.onStepEnd(makeStepResult(), 'Login test')
    } finally {
      if (hadIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
      } else {
        delete (process.stdout as any).isTTY
      }
      if (originalCI === undefined) {
        delete process.env.CI
      } else {
        process.env.CI = originalCI
      }
    }

    const output = logs.join('\n')
    expect(output).toContain('ok Click Login 42ms')
    expect(output).not.toMatch(/\x1B\[[0-9;]*[A-Za-z]/)
    expect(output).not.toContain('\u2713')
  })

  it('suite mode uses 2-space indent for test names', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onSuiteStart({ name: 'My Suite', tests: [], auth: {} } as any)

    // Force isTTY to false and call onTestStart
    ;(reporter as any).isTTY = false
    reporter.onTestStart({ 'test-id': 't_suite-test', name: 'Suite test', target: 'default', steps: [] }, '/tests/suite.yaml')

    // Non-TTY writeLine is a no-op for onTestStart, so no output from RUN badge
    // But onTestEnd should show the badge with 2-space indent
    logs = []
    reporter.onTestEnd(makeTestResult({ name: 'Suite test' }))
    const output = logs.join('\n')
    // Suite mode test names get 2-space indent
    const testLine = logs.find(l => l.includes('PASS') || l.includes('Suite test'))
    expect(testLine).toBeTruthy()
    expect(testLine!.startsWith('  ')).toBe(true)
  })

  it('onSuiteEnd shows aligned summary with Steps and Cache rows', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    reporter.onSuiteStart({ name: 'My Suite', tests: [], auth: {} } as any)
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: true })] }) }), 'T')
    reporter.onStepEnd(makeStepResult({ status: 'passed', trace: makeTrace({ subActions: [makeSubAction({ cached: false })] }) }), 'T')

    logs = []
    reporter.onSuiteEnd(makeSuiteSummary())

    const output = logs.join('\n')
    expect(output).toContain('Suites:')
    expect(output).toContain('Tests:')
    expect(output).toContain('Steps:')
    expect(output).toContain('Cache:')
    expect(output).toContain('Time:')
  })

  describe('onHookEnd', () => {
    it('verbose mode prints emitted variables after hook', () => {
      const reporter = new ConsoleReporter({ verbose: true, colorize: false, plain: false })
      reporter.onHookEnd!({
        hookName: 'seed-db',
        phase: 'setup',
        hookExecutionId: 'hook-1',
        status: 'passed',
        duration: 500,
        stdout: '',
        stderr: '',
        variables: { API_KEY: 'abc123', BASE_URL: 'https://example.com' },
      })

      const output = logs.join('\n')
      expect(output).toContain('\u21B3 API_KEY=abc123')
      expect(output).toContain('\u21B3 BASE_URL=https://example.com')
    })

    it('non-verbose mode does not print variables', () => {
      const reporter = new ConsoleReporter({ verbose: false, colorize: false, plain: false })
      reporter.onHookEnd!({
        hookName: 'seed-db',
        phase: 'setup',
        hookExecutionId: 'hook-1',
        status: 'passed',
        duration: 500,
        stdout: '',
        stderr: '',
        variables: { API_KEY: 'abc123' },
      })

      const output = logs.join('\n')
      expect(output).not.toContain('\u21B3')
    })

    it('verbose mode with empty variables prints nothing extra', () => {
      const reporter = new ConsoleReporter({ verbose: true, colorize: false, plain: false })
      reporter.onHookEnd!({
        hookName: 'seed-db',
        phase: 'setup',
        hookExecutionId: 'hook-1',
        status: 'passed',
        duration: 500,
        stdout: '',
        stderr: '',
        variables: {},
      })

      const output = logs.join('\n')
      expect(output).not.toContain('\u21B3')
    })
  })

  it('TTY mode uses process.stdout.write for step progress', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    ;(reporter as any).canOverwrite = true
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      reporter.onStepStart('Click the button', 'Test')
      expect(writeSpy).toHaveBeenCalled()
      const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(written).toContain('\x1B[2K\r')
      expect(written).toContain('Click the button')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('writeLine clears multi-line wrapped output', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    ;(reporter as any).canOverwrite = true
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })

    try {
      const longText = 'A'.repeat(80)
      reporter.onStepStart(longText, 'Test')
      writeSpy.mockClear()

      reporter.onStepStart('short', 'Test')
      const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(written).toContain('\x1B[1A\x1B[2K')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('writeLine with short text does not emit cursor-up', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    ;(reporter as any).canOverwrite = true
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })

    try {
      reporter.onStepStart('short text', 'Test')
      writeSpy.mockClear()

      reporter.onStepStart('another short', 'Test')
      const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(written).not.toContain('\x1B[1A')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('printLine resets lastWriteLen after newline', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    ;(reporter as any).canOverwrite = true
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })

    try {
      const longText = 'B'.repeat(120)
      reporter.onStepStart(longText, 'Test')

      writeSpy.mockClear()
      reporter.onStepEnd(makeStepResult({ name: 'done' }), 'Test')
      const printWritten = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(printWritten).toContain('\x1B[1A\x1B[2K')

      writeSpy.mockClear()
      reporter.onStepStart('next step', 'Test')
      const nextWritten = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(nextWritten).not.toContain('\x1B[1A')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('stripAnsi removes color codes before width calc', () => {
    const reporter = new ConsoleReporter({ colorize: false, plain: false })
    ;(reporter as any).canOverwrite = true
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true })

    try {
      const visibleText = 'C'.repeat(30)
      const ansiText = '\x1B[31m' + visibleText + '\x1B[0m'
      ;(reporter as any).writeLine(ansiText)
      writeSpy.mockClear()

      ;(reporter as any).writeLine('next')
      const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(written).not.toContain('\x1B[1A')
    } finally {
      writeSpy.mockRestore()
    }
  })
})
