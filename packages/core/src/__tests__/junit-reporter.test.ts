import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JUnitReporter } from '../reporter/junit-reporter.js'
import type { TestResult, StepResult } from '../types/result.js'
import type { RunSummary, SuiteSummary } from '../reporter/types.js'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'Click login button',
    status: 'passed',
    duration: 1234,
    ...overrides,
  }
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'Login Test',
    filePath: 'tests/login.yaml',
    status: 'passed',
    steps: [makeStep()],
    duration: 5678,
    ...overrides,
  }
}

function makeSummary(results: TestResult[]): RunSummary {
  return {
    results,
    duration: results.reduce((s, r) => s + r.duration, 0),
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
  }
}

function makeSuiteSummary(overrides: Partial<SuiteSummary> = {}): SuiteSummary {
  const tests = overrides.tests ?? [
    makeResult({ name: 'Login', filePath: 'tests/login.yaml', duration: 1000 }),
    makeResult({ name: 'Download', filePath: 'tests/download.yaml', duration: 2000 }),
  ]

  return {
    runId: 'r_suite-run-id',
    name: 'Sample smoke suite',
    status: 'passed',
    tests,
    duration: tests.reduce((s, r) => s + r.duration, 0),
    passed: tests.filter(r => r.status === 'passed').length,
    failed: tests.filter(r => r.status === 'failed').length,
    skipped: tests.filter(r => r.status === 'skipped').length,
    ...overrides,
  }
}

let writtenXml: string
let writtenPath: string
let mkdirPath: string

beforeEach(async () => {
  vi.clearAllMocks()
  const fs = await import('node:fs/promises')
  ;(fs.writeFile as any).mockImplementation(async (path: string, content: string) => {
    writtenPath = path
    writtenXml = content
  })
  ;(fs.mkdir as any).mockImplementation(async (path: string) => {
    mkdirPath = path
  })
})

describe('JUnitReporter', () => {
  it('generates valid XML for a passing test', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult()
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(writtenXml).toContain('<testsuites')
    expect(writtenXml).toContain('<testsuite')
    expect(writtenXml).toContain('<testcase')
    expect(writtenXml).toContain('<system-out>Steps:')
    expect(writtenXml).toContain('</testsuites>')
  })

  it('includes run ID metadata for passing tests', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const runId = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    const result = makeResult({ runId })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain(`runId="${runId}"`)
  })

  it('generates <failure> element for failed tests with failed step details', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const runId = 'r_harbor-iris-jade-kilo-lima-maple-nova-orbit-pearl-quartz'
    const result = makeResult({
      runId,
      status: 'failed',
      steps: [makeStep({ status: 'failed', error: 'Element not found' })],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('<failure')
    expect(writtenXml).toContain('message="Element not found"')
    expect(writtenXml).toContain('type="TestFailure"')
    expect(writtenXml).toContain('Failed step 1: Click login button')
    expect(writtenXml).toContain(`runId="${runId}"`)
    expect(writtenXml).toContain('</failure>')
  })

  it('generates <skipped/> element for skipped tests', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({
      status: 'skipped',
      steps: [makeStep({ status: 'skipped' })],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('<skipped message="skipped"/>')
  })

  it('includes trace details in failure body', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({
      status: 'failed',
      steps: [makeStep({
        status: 'failed',
        error: 'Click failed',
        trace: {
          observation: 'Page shows login form',
          reasoning: 'Need to click submit',
          plannedAction: { type: 'click', ref: 'e1' } as any,
          result: 'failure',
          error: 'Element detached',
          screenStateBefore: 'login form',
        },
      })],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('Observation: Page shows login form')
    expect(writtenXml).toContain('Reasoning: Need to click submit')
    expect(writtenXml).toContain('Planned action:')
    expect(writtenXml).toContain('Error: Element detached')
  })

  it('escapes XML special characters in test names and error messages', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({
      name: 'Test <with> "special" & \'chars\'',
      steps: [makeStep({
        name: 'Step & <special>',
        status: 'failed',
        error: 'Error: <tag> & "quote"',
      })],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('Test &lt;with&gt; &quot;special&quot; &amp; &apos;chars&apos;')
    expect(writtenXml).toContain('Step &amp; &lt;special&gt;')
    expect(writtenXml).toContain('Error: &lt;tag&gt; &amp; &quot;quote&quot;')
  })

  it('creates output directory if it does not exist', async () => {
    const reporter = new JUnitReporter({ outputPath: 'deep/nested/dir/junit.xml' })
    const result = makeResult()
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(mkdirPath).toBe('deep/nested/dir')
    expect(writtenPath).toBe('deep/nested/dir/junit.xml')
  })

  it('calculates correct test/failure counts in testsuites attributes', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result1 = makeResult({
      name: 'Test A',
      status: 'failed',
      steps: [
        makeStep({ name: 'step1', status: 'passed' }),
        makeStep({ name: 'step2', status: 'failed', error: 'err' }),
      ],
    })
    const result2 = makeResult({
      name: 'Test B',
      steps: [
        makeStep({ name: 'step3', status: 'passed' }),
      ],
    })
    reporter.onTestEnd(result1)
    reporter.onTestEnd(result2)
    await reporter.onRunEnd(makeSummary([result1, result2]))

    // 2 total tests, even though the tests contain 3 total steps.
    expect(writtenXml).toContain('tests="2"')
    expect(writtenXml).toContain('failures="1"')
    expect(writtenXml).toContain('1. [PASSED] step1')
    expect(writtenXml).toContain('2. [FAILED] step2')
  })

  it('uses seconds with 3 decimal places for time values', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({
      duration: 5678,
      steps: [makeStep({ duration: 1234 })],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    // 5678ms = 5.678s for the JUnit testcase; 1234ms remains in step detail output.
    expect(writtenXml).toContain('time="5.678"')
    expect(writtenXml).toContain('(1.234s)')
  })

  it('handles test with zero steps gracefully', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({ steps: [] })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    expect(writtenXml).toContain('tests="1"')
    expect(writtenXml).toContain('failures="0"')
    expect(writtenXml).toContain('<testsuite')
    expect(writtenXml).toContain('<testcase')
    expect(writtenXml).toContain('Steps: none recorded')
    expect(writtenXml).toContain('</testsuite>')
  })

  it('uses the Agent QA suite as the JUnit testsuite for suite runs', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const results = [
      makeResult({ name: 'Login', filePath: 'tests/login.yaml', duration: 1000 }),
      makeResult({ name: 'Download', filePath: 'tests/download.yaml', duration: 2000 }),
    ]
    const summary = makeSuiteSummary({ tests: results })
    const fs = await import('node:fs/promises')

    reporter.onSuiteStart({ name: summary.name, tests: [], target: 'default' } as any)
    for (const result of results) {
      reporter.onTestEnd(result)
    }
    await reporter.onRunEnd(makeSummary(results))

    expect(fs.writeFile).not.toHaveBeenCalled()

    await reporter.onSuiteEnd(summary)

    expect(writtenXml).toContain('<testsuites name="agent-qa" tests="2" failures="0" skipped="0" time="3.000">')
    expect(writtenXml).toContain('<testsuite name="Sample smoke suite" tests="2" failures="0" skipped="0" time="3.000" runId="r_suite-run-id">')
    expect(writtenXml).toContain('<testcase name="Login" classname="Sample smoke suite" time="1.000" file="tests/login.yaml"')
    expect(writtenXml).toContain('<testcase name="Download" classname="Sample smoke suite" time="2.000" file="tests/download.yaml"')
    expect((writtenXml.match(/<testsuite /g) || []).length).toBe(1)
    expect((writtenXml.match(/<testcase /g) || []).length).toBe(2)
  })

  it('output is well-formed XML (basic check)', async () => {
    const reporter = new JUnitReporter({ outputPath: 'results/junit.xml' })
    const result = makeResult({
      steps: [
        makeStep({ status: 'passed' }),
        makeStep({ name: 'Failed step', status: 'failed', error: 'err' }),
        makeStep({ name: 'Skipped step', status: 'skipped' }),
      ],
    })
    reporter.onTestEnd(result)
    await reporter.onRunEnd(makeSummary([result]))

    // Check balanced tags
    const openTestsuites = (writtenXml.match(/<testsuites/g) || []).length
    const closeTestsuites = (writtenXml.match(/<\/testsuites>/g) || []).length
    expect(openTestsuites).toBe(closeTestsuites)

    const openTestsuite = (writtenXml.match(/<testsuite /g) || []).length
    const closeTestsuite = (writtenXml.match(/<\/testsuite>/g) || []).length
    expect(openTestsuite).toBe(closeTestsuite)

    const openTestcase = (writtenXml.match(/<testcase /g) || []).length
    const closeTestcase = (writtenXml.match(/<\/testcase>/g) || []).length
    expect(openTestcase).toBe(closeTestcase)
  })
})
