import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildInternalRunAttributes } from '../../run-attributes.js'
import type { TestDefinition } from '../../types/test.js'
import type { StepResult, TestResult } from '../../types/result.js'
import { MockAnalyticsTransport } from '../transport.js'
import { createAnalyticsRunReporter } from '../run-reporter.js'

const testId = 't_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const suiteId = 's_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const runId = 'r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const parentRunId = 'r_parent-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const authStateName = 'analytics-demo-acc'
const authStatePath = '/internal/auth/staging-web/analytics-demo-acc/storage-state.json'
const authCookieSecret = 'analytics-cookie-secret'
const authLocalStorageSecret = 'analytics-local-storage-secret'

function makeTest(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return {
    'test-id': testId,
    name: 'Sensitive Test Name',
    target: 'web',
    steps: ['Sensitive step text'],
    ...overrides,
  } as TestDefinition
}

function makeArtifactContext() {
  return {
    runId,
    artifact: {
      kind: 'test' as const,
      config: {
        use: { authState: authStateName },
        model: {
          planner: { provider: 'openai', model: 'gpt-planner' },
          verifier: { provider: 'openai', model: 'gpt-verifier' },
        },
        runtime: {
          platform: 'web',
          browserName: 'chromium',
          authState: {
            version: 1,
            kind: 'web',
            targetName: 'staging-web',
            stateName: authStateName,
            capturedAt: '2026-05-17T00:00:00.000Z',
            storageStatePath: authStatePath,
          },
        },
        memory: {
          enabled: true,
          injectedObservationCount: 2,
        },
      },
      source: {
        kind: 'test',
        testId,
        name: 'Sensitive Test Name',
        filePath: '/private/tests/sensitive.yaml',
      },
      metadata: {
        attributes: buildInternalRunAttributes({ trigger: 'dashboard', runner: 'local' }),
      },
    },
  }
}

function makeStep(): StepResult {
  return {
    id: 'step-1',
    name: 'Sensitive step text',
    status: 'passed',
    duration: 123,
    healingAttempts: [{ success: true } as any],
    trace: {
      observation: 'raw observation',
      reasoning: 'raw reasoning',
      plannedAction: { type: 'click' } as any,
      result: 'success',
      screenStateBefore: 'raw state',
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      verifierReasoning: 'verified',
      subActions: [
        {
          index: 0,
          observation: 'raw sub observation',
          reasoning: 'raw sub reasoning',
          plannedAction: { type: 'click' } as any,
          result: 'success',
          screenStateBefore: 'raw sub state',
          cached: true,
          tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          verifierReasoning: 'sub verified',
        },
        {
          index: 1,
          observation: 'raw failed sub observation',
          reasoning: 'raw failed sub reasoning',
          plannedAction: { type: 'fill' } as any,
          result: 'failure',
          error: 'raw subaction error',
          screenStateBefore: 'raw failed state',
          cached: false,
        },
      ],
    },
    consoleLogs: [{ level: 'error', text: 'secret console', timestamp: 1 }],
    networkLogs: [{
      url: 'https://secret.example',
      method: 'GET',
      status: 500,
      requestHeaders: {},
      responseHeaders: {},
      startTime: 1,
      endTime: 2,
    }],
  }
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  const result: TestResult = {
    runId,
    name: 'Sensitive Test Name',
    filePath: '/private/tests/sensitive.yaml',
    status: 'passed',
    duration: 1234,
    steps: [makeStep()],
    retryCount: 1,
    failureSummary: 'raw failure text',
    ...overrides,
  }
  ;(result as any).memoryLog = {
    added: 1,
    confirmed: 2,
    deprecated: 3,
    deleted: 4,
    deltas: [{ observationId: 'obs_secret', reasoning: 'raw memory reasoning' }],
    errors: ['raw memory error'],
    curatorDuration: 25,
    tokenUsage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
  }
  ;(result as any).authStatePayload = {
    cookies: [{ name: 'sid', value: authCookieSecret }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: authLocalStorageSecret }] }],
  }
  return result
}

describe('AnalyticsRunReporter', () => {
  let tempDir: string
  let identityPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-reporter-'))
    identityPath = join(tempDir, 'analytics.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('does not emit from onTestEnd alone', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })

    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', makeArtifactContext())
    await reporter.onTestEnd?.()

    expect(transport.events).toHaveLength(0)
  })

  it('emits one final test completion event from onRunEnd with aggregate metrics only', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })

    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', makeArtifactContext())
    await reporter.onHookEnd?.({
      hookId: 'h_setup',
      hookName: 'Sensitive setup',
      phase: 'setup',
      hookExecutionId: 'hook-1',
      runId,
      status: 'failed',
      duration: 10,
      stdout: 'secret stdout',
      stderr: 'secret stderr',
      variables: { SECRET: 'value', ACCESS_TOKEN: 'analytics-hook-token' },
      error: 'raw hook error',
    })
    await reporter.onTestEnd?.()
    await reporter.onRunEnd?.({ results: [makeResult()], duration: 1234, passed: 1, failed: 0, skipped: 0 })

    expect(transport.events).toHaveLength(1)
    const event = transport.events[0].event
    expect(event.name).toBe('agent-qa.test_run.completed')
    expect(event.properties).toMatchObject({
      surface: 'cli',
      runtime_context: 'user',
      run_id: runId,
      test_id: testId,
      trigger_source: 'dashboard',
      runner: 'local',
      platform: 'web',
      browser_name: 'chromium',
      status: 'passed',
      duration_ms: 1234,
      retry_count: 1,
      is_flaky: true,
      input_tokens: 13,
      output_tokens: 7,
      total_tokens: 20,
      planner_call_count: 2,
      verifier_call_count: 2,
      step_count: 1,
      passed_step_count: 1,
      subaction_count: 2,
      cached_subaction_count: 1,
      failed_subaction_count: 1,
      healing_attempt_count: 1,
      hook_count: 1,
      failed_hook_count: 1,
      memory_enabled: true,
      memory_injected_observation_count: 2,
      memory_curator_input_tokens: 7,
      memory_curator_output_tokens: 8,
      memory_curator_total_tokens: 15,
      memory_added_count: 1,
      memory_confirmed_count: 2,
      memory_deprecated_count: 3,
      memory_deleted_count: 4,
      memory_error_count: 1,
      $process_person_profile: false,
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('Sensitive Test Name')
    expect(serialized).not.toContain('/private/tests/sensitive.yaml')
    expect(serialized).not.toContain('raw failure text')
    expect(serialized).not.toContain('secret console')
    expect(serialized).not.toContain('https://secret.example')
    expect(serialized).not.toContain('secret stdout')
    expect(serialized).not.toContain('raw memory reasoning')
    expect(serialized).not.toContain('obs_secret')
    expect(serialized).not.toContain(authStateName)
    expect(serialized).not.toContain(authStatePath)
    expect(serialized).not.toContain(authCookieSecret)
    expect(serialized).not.toContain(authLocalStorageSecret)
    expect(serialized).not.toContain('analytics-hook-token')
  })

  it('emits one final retry-aware event after failed attempts', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })

    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', makeArtifactContext())
    await reporter.onTestEnd?.()
    await reporter.onTestEnd?.()
    await reporter.onRunEnd?.({ results: [makeResult({ status: 'passed', retryCount: 2 })], duration: 3000, passed: 1, failed: 0, skipped: 0 })

    expect(transport.events).toHaveLength(1)
    expect(transport.events[0].event.properties).toMatchObject({
      status: 'passed',
      retry_count: 2,
      is_flaky: true,
    })
  })

  it('uses sanitized result metadata when a setup failure never emitted onTestStart', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })

    await reporter.onRunEnd?.({
      results: [
        makeResult({
          status: 'failed',
          steps: [],
          duration: 42,
          metadata: {
            phase: 'setup',
            error: 'Could not auto-start Appium',
            testId,
            attributes: buildInternalRunAttributes({ trigger: 'dashboard', runner: 'local' }),
            runtime: {
              platform: 'android',
              mobileTransport: 'local',
              appState: 'preserve',
            },
          },
        }),
      ],
      duration: 42,
      passed: 0,
      failed: 1,
      skipped: 0,
    })

    expect(transport.events).toHaveLength(1)
    expect(transport.events[0].event.properties).toMatchObject({
      run_id: runId,
      test_id: testId,
      trigger_source: 'dashboard',
      runner: 'local',
      platform: 'android',
      mobile_transport: 'local',
      app_state: 'preserve',
      status: 'failed',
      failure_category: 'setup',
      duration_ms: 42,
    })
    expect(JSON.stringify(transport.events[0].event)).not.toContain('Could not auto-start Appium')
  })

  it('omits metric families that were not measured', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })
    const result = makeResult({
      steps: [],
      retryCount: undefined,
      failureSummary: undefined,
    })
    delete (result as any).memoryLog

    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', {
      runId,
      artifact: {
        kind: 'test',
        metadata: { attributes: buildInternalRunAttributes({ trigger: 'cli', runner: 'local' }) },
        source: { kind: 'test', testId },
      },
    })
    await reporter.onRunEnd?.({ results: [result], duration: 100, passed: 1, failed: 0, skipped: 0 })

    expect(transport.events[0].event.properties.step_count).toBe(0)
    expect(transport.events[0].event.properties.input_tokens).toBeUndefined()
    expect(transport.events[0].event.properties.memory_added_count).toBeUndefined()
    expect(transport.events[0].event.properties.retry_count).toBeUndefined()
  })

  it('emits suite parent aggregates and child test events without child details on parent', async () => {
    const transport = new MockAnalyticsTransport()
    const reporter = createAnalyticsRunReporter({ surface: 'cli', transport, identityPath, env: {} })
    const suite = {
      'suite-id': suiteId,
      name: 'Sensitive Suite Name',
      target: 'web',
      tests: [{ test: '/private/tests/sensitive.yaml', id: testId }],
    } as any

    await reporter.onSuiteStart?.(suite, {
      runId: parentRunId,
      artifact: {
        kind: 'suite-parent',
        source: { kind: 'suite', suiteId, name: 'Sensitive Suite Name', filePath: '/private/suite.yaml' },
        runtime: { executionMode: 'parallel' },
        metadata: { attributes: { 'agent-qa.trigger': 'mcp', 'agent-qa.runner': 'browserstack' } },
      },
    })
    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', {
      runId,
      parentRunId,
      artifact: {
        kind: 'suite-child',
        source: { kind: 'test', testId, name: 'Sensitive Test Name', filePath: '/private/tests/sensitive.yaml' },
      },
    })
    await reporter.onRunEnd?.({ results: [makeResult({ runId })], duration: 100, passed: 1, failed: 0, skipped: 0 })
    await reporter.onSuiteEnd?.({
      runId: parentRunId,
      name: 'Sensitive Suite Name',
      status: 'passed',
      tests: [makeResult({ runId })],
      duration: 200,
      passed: 1,
      failed: 0,
      skipped: 0,
    })

    expect(transport.events.map(payload => payload.event.name)).toEqual([
      'agent-qa.test_run.completed',
      'agent-qa.suite_run.completed',
    ])
    expect(transport.events[0].event.properties.parent_run_id).toBe(parentRunId)
    expect(transport.events[1].event.properties).toMatchObject({
      run_id: parentRunId,
      suite_id: suiteId,
      trigger_source: 'mcp',
      runner: 'browserstack',
      suite_child_count: 1,
      suite_execution_mode: 'parallel',
    })
    const parentSerialized = JSON.stringify(transport.events[1].event)
    expect(parentSerialized).not.toContain('Sensitive Suite Name')
    expect(parentSerialized).not.toContain('/private/suite.yaml')
    expect(parentSerialized).not.toContain(testId)
    expect(parentSerialized).not.toContain('raw failure text')
  })

  it('does not reject when analytics capture fails', async () => {
    const reporter = createAnalyticsRunReporter({
      surface: 'cli',
      identityPath,
      env: {},
      service: {
        capture: vi.fn(() => { throw new Error('capture failed') }),
        flush: vi.fn(),
      },
    })

    await reporter.onTestStart?.(makeTest(), '/private/tests/sensitive.yaml', makeArtifactContext())
    await expect(reporter.onRunEnd?.({ results: [makeResult()], duration: 100, passed: 1, failed: 0, skipped: 0 }))
      .resolves.toBeUndefined()
  })
})
