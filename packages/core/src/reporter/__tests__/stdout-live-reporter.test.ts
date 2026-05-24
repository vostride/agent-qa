import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StdoutLiveReporter } from '../stdout-live-reporter.js'
import type { TestDefinition } from '../../types/test.js'
import type { TestResult } from '../../types/result.js'
import { SecretRedactor, SecretStore } from '../../agent/secrets.js'

const RUN_ID = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'

function makeTest(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return {
    'test-id': 't_login-test',
    name: 'Login test',
    target: 'default',
    steps: ['Click Login'],
    ...overrides,
  }
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'Login test',
    filePath: '/tests/login.yaml',
    status: 'passed',
    steps: [],
    duration: 123,
    ...overrides,
  }
}

function parseEvents(writeSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return (writeSpy.mock.calls as unknown[][])
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith('AGENT_QA_EVENT:'))
    .map((line: string) => JSON.parse(line.slice('AGENT_QA_EVENT:'.length)))
}

describe('StdoutLiveReporter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    writeSpy.mockRestore()
    vi.useRealTimers()
    delete process.env.AGENT_QA_LIVE_EVENTS
    delete process.env.AGENT_QA_PARENT_RUN_ID
    delete process.env.AGENT_QA_ATTEMPT_NUMBER
    delete process.env.AGENT_QA_MAX_RETRIES
  })

  it('emits run ID on live start, heartbeat, retry, and completion events', () => {
    vi.useFakeTimers()
    process.env.AGENT_QA_LIVE_EVENTS = 'true'
    process.env.AGENT_QA_PARENT_RUN_ID = 'r_parent'
    process.env.AGENT_QA_ATTEMPT_NUMBER = '2'
    process.env.AGENT_QA_MAX_RETRIES = '3'
    const reporter = new StdoutLiveReporter()

    reporter.onTestStart(makeTest(), '/tests/login.yaml', { runId: RUN_ID })
    vi.advanceTimersByTime(10_000)
    reporter.onTestEnd(makeResult({ runId: RUN_ID }))

    const events = parseEvents(writeSpy)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'retry-attempt', runId: RUN_ID, attempt: 2, maxRetries: 3 }),
      expect.objectContaining({ type: 'test-start', runId: RUN_ID }),
      expect.objectContaining({ type: 'heartbeat', runId: RUN_ID }),
      expect.objectContaining({ type: 'test-complete', runId: RUN_ID }),
    ]))
  })

  it('emits transient step, subaction, hook, and suite identity on live events', () => {
    process.env.AGENT_QA_LIVE_EVENTS = 'true'
    const reporter = new StdoutLiveReporter()
    const context = {
      runId: RUN_ID,
      parentRunId: 'r_suite',
      suiteIndex: 1,
      testIndex: 1,
      stepIndex: 2,
      stepId: 'step-2',
    }

    reporter.onTestStart(makeTest(), '/tests/login.yaml', {
      runId: RUN_ID,
      parentRunId: 'r_suite',
      artifact: { suiteIndex: 1, runtime: { suiteTotal: 3 } },
    })
    reporter.onStepStart('Repeat action', 'Login test', context)
    reporter.onStepPhase({
      phase: 'plan',
      subActionIndex: 3,
      phaseOrdinal: 1,
      text: 'Reason about the action',
      duration: 7,
    }, 'Repeat action', 'Login test', context)
    reporter.onStepEnd({
      id: 'step-2',
      name: 'Repeat action',
      status: 'passed',
      duration: 42,
    }, 'Login test', context)
    reporter.onHookStart({
      hookId: 'hook-seed',
      hookName: 'seed data',
      phase: 'setup',
      hookExecutionId: 'hook-exec-1',
      runId: RUN_ID,
      stepId: 'step-2',
    })
    reporter.onHookEnd({
      hookId: 'hook-seed',
      hookName: 'seed data',
      phase: 'setup',
      hookExecutionId: 'hook-exec-1',
      runId: RUN_ID,
      stepId: 'step-2',
      status: 'passed',
      duration: 8,
      stdout: 'seeded',
      stderr: '',
      variables: { TOKEN: 'safe' },
      type: 'hook',
    })
    reporter.onTestEnd(makeResult({ runId: RUN_ID }))

    const events = parseEvents(writeSpy)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'test-start',
        runId: RUN_ID,
        parentRunId: 'r_suite',
        suiteIndex: 1,
        suiteTotal: 3,
      }),
      expect.objectContaining({
        type: 'step-start',
        runId: RUN_ID,
        parentRunId: 'r_suite',
        suiteIndex: 1,
        suiteTotal: 3,
        testIndex: 1,
        stepIndex: 2,
        stepId: 'step-2',
      }),
      expect.objectContaining({
        type: 'step-phase',
        runId: RUN_ID,
        stepIndex: 2,
        stepId: 'step-2',
        subActionIndex: 3,
        phaseOrdinal: 1,
      }),
      expect.objectContaining({
        type: 'step-complete',
        runId: RUN_ID,
        stepIndex: 2,
        stepId: 'step-2',
      }),
      expect.objectContaining({
        type: 'hook-start',
        runId: RUN_ID,
        parentRunId: 'r_suite',
        suiteIndex: 1,
        suiteTotal: 3,
        hookId: 'hook-seed',
        stepId: 'step-2',
      }),
      expect.objectContaining({
        type: 'hook-end',
        runId: RUN_ID,
        hookId: 'hook-seed',
        stdout: 'seeded',
        variables: { TOKEN: 'safe' },
        logType: 'hook',
      }),
      expect.objectContaining({
        type: 'test-complete',
        runId: RUN_ID,
        parentRunId: 'r_suite',
        suiteIndex: 1,
        suiteTotal: 3,
      }),
    ]))
  })

  it('omits run ID when no context or result run ID exists', () => {
    process.env.AGENT_QA_LIVE_EVENTS = 'true'
    const reporter = new StdoutLiveReporter()

    reporter.onTestStart(makeTest(), '/tests/login.yaml')
    reporter.onTestEnd(makeResult())

    const events = parseEvents(writeSpy)
    expect(events).toHaveLength(2)
    expect(events.every(event => !('runId' in event))).toBe(true)
  })

  it('redacts secrets from emitted step, hook, and completion events', () => {
    process.env.AGENT_QA_LIVE_EVENTS = 'true'
    const rawSecret = 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7'
    const redactor = new SecretRedactor(new SecretStore({ loginPassword: rawSecret }))
    const reporter = new StdoutLiveReporter({ redactor })

    reporter.onTestStart(makeTest({ steps: ['Fill {{secret:loginPassword}}'] }), '/tests/login.yaml', { runId: RUN_ID })
    reporter.onStepEnd({
      name: 'Fill {{secret:loginPassword}}',
      status: 'failed',
      duration: 42,
      action: { type: 'fill', value: rawSecret },
      error: `failed with ${rawSecret}`,
      trace: {
        observation: `saw ${rawSecret}`,
        reasoning: `use {{secret:loginPassword}}`,
        plannedAction: { type: 'fill', value: rawSecret },
        result: `typed ${rawSecret}`,
        error: `trace ${rawSecret}`,
      },
    } as never, 'Login test')
    reporter.onStepPhase({
      phase: 'execute',
      subActionIndex: 0,
      text: `phase ${rawSecret}`,
      action: { type: 'fill', value: rawSecret },
      success: false,
      duration: 2,
    } as never, 'Fill {{secret:loginPassword}}', 'Login test')
    reporter.onHookEnd({
      hookName: 'seed-secret',
      phase: 'setup',
      hookExecutionId: 'hook-1',
      status: 'failed',
      duration: 5,
      stdout: `stdout ${rawSecret}`,
      stderr: `stderr ${rawSecret}`,
      variables: { LEAK: rawSecret },
      error: `hook ${rawSecret}`,
    })
    reporter.onTestEnd(makeResult({
      runId: RUN_ID,
      status: 'failed',
      duration: 100,
      failureSummary: `failed ${rawSecret}`,
    }))

    const serialized = JSON.stringify(parseEvents(writeSpy))
    expect(serialized).not.toContain(rawSecret)
    expect(serialized).toContain('[secret]')
    expect(serialized).toContain('[secret:loginPassword]')
  })
})
