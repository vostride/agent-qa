import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Action, ActionResult, PlatformAdapter, PlatformConfig, ScreenState } from '../../types/platform.js'

const {
  mockRunTest,
  mockRunHooks,
  mockRunCurator,
  mockDeprecateOnFailure,
  mockShouldAblate,
  mockCollectAllInjectedIds,
} = vi.hoisted(() => ({
  mockRunTest: vi.fn(),
  mockRunHooks: vi.fn(),
  mockRunCurator: vi.fn(),
  mockDeprecateOnFailure: vi.fn(),
  mockShouldAblate: vi.fn(() => false),
  mockCollectAllInjectedIds: vi.fn(() => new Map()),
}))

vi.mock('../../agent/runner.js', () => ({
  runTest: mockRunTest,
}))

vi.mock('../../hooks/orchestrator.js', () => ({
  runHooks: mockRunHooks,
}))

vi.mock('../../memory/curator.js', () => ({
  runCurator: mockRunCurator,
  deprecateOnFailure: mockDeprecateOnFailure,
}))

vi.mock('../../memory/ablation.js', () => ({
  shouldAblate: mockShouldAblate,
  collectAllInjectedIds: mockCollectAllInjectedIds,
}))

import { runSuite } from '../runner.js'
import type { RunSuiteConfig } from '../runner.js'
import type { SuiteDefinition } from '../types.js'
import type { TestDefinition } from '../../types/test.js'
import { SecretRedactor, SecretStore } from '../../agent/secrets.js'

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

function createMockAdapter(executeResults: ActionResult[] = [{ success: true }]): {
  adapter: PlatformAdapter
  execute: ReturnType<typeof vi.fn>
  setup: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
} {
  let executeIndex = 0
  const setup = vi.fn(async (_config: PlatformConfig) => {})
  const cleanup = vi.fn(async () => {})
  const execute = vi.fn(async (_action: Action) => {
    const result = executeResults[Math.min(executeIndex, executeResults.length - 1)]
    executeIndex += 1
    return result
  })

  const adapter: PlatformAdapter = {
    platform: 'web',
    setup,
    cleanup,
    execute,
    async observe(): Promise<ScreenState> {
      return {
        tree: '',
        elements: [],
        url: 'https://example.com',
        timestamp: Date.now(),
        metadata: { coordSpace: 'viewport', viewportWidth: 1280, viewportHeight: 720 },
      }
    },
  }

  return { adapter, execute, setup, cleanup }
}

function makeSuite(overrides: Partial<SuiteDefinition> = {}): SuiteDefinition {
  return {
    name: 'Smoke Suite',
    target: 'webapp',
    tests: [{ test: 'tests/login.yaml', id: VALID_TEST_ID }],
    ...overrides,
  }
}

function makeTest(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return {
    'test-id': VALID_TEST_ID,
    name: 'Login Test',
    target: 'webapp',
    steps: ['Open login page'],
    ...overrides,
  }
}

function makeAuthState() {
  return {
    version: 1,
    kind: 'web',
    targetName: 'webapp',
    stateName: 'admin',
    capturedAt: '2026-05-17T00:00:00.000Z',
    storageStatePath: '/internal/auth/webapp/admin.json',
  } as const
}

function makeConfig(adapter: PlatformAdapter, overrides: Partial<RunSuiteConfig> = {}): RunSuiteConfig {
  return {
    adapter,
    platformConfig: {
      platform: 'web',
      browser: { name: 'chromium', headless: true },
    },
    planner: {} as any,
    healingConfig: { maxAttempts: 0 },
    plannerModel: {} as any,
    verifierModel: {} as any,
    ...overrides,
  }
}

describe('runSuite startup navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunTest.mockResolvedValue({
      name: 'Login Test',
      filePath: '/tests/login.yaml',
      status: 'passed',
      steps: [],
      duration: 1,
    })
    mockRunHooks.mockResolvedValue({
      allPassed: true,
      variables: {},
      results: new Map(),
    })
    mockRunCurator.mockResolvedValue({
      added: 0,
      confirmed: 0,
      deprecated: 0,
      errors: [],
      curatorDuration: 0,
    })
  })

  afterEach(() => {
    delete process.env.AGENT_QA_SUITE_QUEUE_ID
  })

  it('interpolates suite target urls before initial navigation', async () => {
    const { adapter, execute, setup, cleanup } = createMockAdapter()

    const result = await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolveUrl: () => 'https://{{env:HOST}}/login',
        envFileVars: { HOST: 'staging.example.com' },
      }),
    )

    expect(setup).toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith({ type: 'navigate', url: 'https://staging.example.com/login' })
    expect(mockRunTest).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalled()
    expect(result.status).toBe('passed')
  })

  it('resolves suite target url secrets only for startup navigation', async () => {
    const { adapter, execute } = createMockAdapter()
    const secretStore = new SecretStore({ START_URL_TOKEN: 'runtime-url-token' })

    await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolveUrl: () => 'https://example.com/{{secret:START_URL_TOKEN}}',
        secretStore,
        secretRedactor: new SecretRedactor(secretStore),
      }),
    )

    expect(execute).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com/runtime-url-token' })
  })

  it('fails the suite when startup navigation fails', async () => {
    const { adapter, execute } = createMockAdapter([{ success: false, error: 'Navigation blocked' }])

    const result = await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolveUrl: () => 'https://example.com/login',
      }),
    )

    expect(execute).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com/login' })
    expect(mockRunTest).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.tests).toHaveLength(1)
    expect(result.tests[0].failureSummary).toContain('Navigation blocked')
  })

  it('passes accessibility config to each suite member run', async () => {
    const { adapter } = createMockAdapter()
    const accessibilityCheck = vi.fn()
    const accessibility = {
      enabled: true,
      standard: 'wcag2aa' as const,
      runAfter: 'every-step' as const,
      failOnViolation: false,
    }

    await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, { accessibility, accessibilityCheck }),
    )

    expect(mockRunTest).toHaveBeenCalledOnce()
    expect(mockRunTest.mock.calls[0][1]).toEqual(expect.objectContaining({
      accessibility,
      accessibilityCheck,
    }))
  })

  it('fails promptly when startup navigation exceeds the navigation timeout', async () => {
    const { adapter, execute, cleanup } = createMockAdapter()
    execute.mockImplementationOnce(async () => await new Promise<ActionResult>(() => {}))

    const startedAt = Date.now()
    const result = await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolveUrl: () => 'https://example.com/slow-login',
        timeouts: { navigation: 25 },
      }),
    )

    expect(Date.now() - startedAt).toBeLessThan(180)
    expect(mockRunTest).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.tests[0].failureSummary).toContain('Suite navigation timed out after 25ms')
  })

  it('emits a terminal test end when per-test setup fails after test start', async () => {
    const { adapter } = createMockAdapter()
    const events: string[] = []
    mockRunHooks.mockResolvedValue({
      allPassed: false,
      variables: {},
      results: new Map([['seed data', {
        success: false,
        duration: 10,
        stdout: '',
        stderr: 'setup failed',
        variables: {},
        error: 'setup failed',
      }]]),
    })

    const result = await runSuite(
      makeSuite(),
      [[makeTest({ setup: ['hook-seed'] } as any), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolvedHooks: new Map([['hook-seed', { id: 'hook-seed', name: 'seed data', command: 'false' } as any]]),
        sandboxOptions: { cwd: '/tmp', envVars: {} } as any,
        reporters: [{
          onTestStart: async (test) => { events.push(`start:${test.name}`) },
          onTestEnd: async (testResult) => { events.push(`end:${testResult.name}:${testResult.status}`) },
        }],
      }),
    )

    expect(result.status).toBe('failed')
    expect(mockRunTest).not.toHaveBeenCalled()
    expect(events).toEqual(['start:Login Test', 'end:Login Test:failed'])
  })

  it('passes secret runtime context to setup hooks and child tests', async () => {
    const { adapter } = createMockAdapter()
    const secretStore = new SecretStore({ API_KEY: 'runtime-secret' })
    const secretRedactor = new SecretRedactor(secretStore)

    await runSuite(
      makeSuite({ setup: ['hook-seed'] } as any),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolvedHooks: new Map([['hook-seed', { id: 'hook-seed', name: 'seed data', command: 'true' } as any]]),
        sandboxOptions: { envVars: { API_KEY: 'normal-env' } } as any,
        secretStore,
        secretRedactor,
      }),
    )

    expect(mockRunHooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        secretStore,
        secretRedactor,
        envVars: expect.objectContaining({ API_KEY: 'normal-env' }),
      }),
    )
    expect(mockRunTest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ secretStore, secretRedactor }),
      '/tests/login.yaml',
    )
  })

  it('passes active suite auth state to suite hooks, child hooks, and inline hooks', async () => {
    const { adapter, setup } = createMockAdapter()
    const authState = makeAuthState()
    mockRunHooks.mockImplementation(async (hooks: Array<{ name: string }>) => ({
      allPassed: true,
      variables: {},
      results: new Map(hooks.map((hook) => [hook.name, {
        success: true,
        duration: 3,
        stdout: '',
        stderr: '',
        variables: {},
      }])),
    }))
    mockRunTest.mockImplementation(async (_test, config, filePath) => ({
      name: 'Login Test',
      filePath,
      status: 'passed',
      steps: [],
      duration: 1,
      runId: config.runId,
    }))

    await runSuite(
      makeSuite({ setup: ['suite-setup'], teardown: ['suite-teardown'], use: { authState: 'admin' } } as any),
      [[makeTest({ setup: ['test-setup'], teardown: ['test-teardown'] } as any), '/tests/login.yaml']],
      makeConfig(adapter, {
        platformConfig: {
          platform: 'web',
          browser: { name: 'chromium', headless: true },
          authState,
        },
        resolvedHooks: new Map([
          ['suite-setup', { id: 'suite-setup', name: 'suite setup', command: 'true' } as any],
          ['suite-teardown', { id: 'suite-teardown', name: 'suite teardown', command: 'true' } as any],
          ['test-setup', { id: 'test-setup', name: 'test setup', command: 'true' } as any],
          ['test-teardown', { id: 'test-teardown', name: 'test teardown', command: 'true' } as any],
        ]),
        sandboxOptions: { cwd: '/tmp', envVars: { BASE_ENV: 'base' } } as any,
      }),
    )

    expect(mockRunHooks).toHaveBeenCalledTimes(4)
    for (const [, options] of mockRunHooks.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        authState,
        envVars: expect.objectContaining({ BASE_ENV: 'base' }),
      }))
    }
    expect(mockRunHooks.mock.invocationCallOrder[0]).toBeLessThan(setup.mock.invocationCallOrder[0])
    expect(mockRunTest).toHaveBeenCalledWith(
      expect.objectContaining({ use: expect.objectContaining({ authState: 'admin' }) }),
      expect.objectContaining({
        inlineHookSandboxOptions: expect.objectContaining({ authState }),
      }),
      '/tests/login.yaml',
    )
  })

  it('captures suite auth state after all child tests pass and before suite teardown hooks', async () => {
    const { adapter } = createMockAdapter()
    const capturedAuthState = {
      version: 1,
      kind: 'web' as const,
      targetName: 'webapp',
      stateName: 'admin',
      capturedAt: '2026-05-17T01:00:00.000Z',
      storageStatePath: '/internal/auth/webapp/admin.json',
    }
    const capture = vi.fn(async () => capturedAuthState)
    mockRunHooks.mockImplementation(async (hooks: Array<{ name: string }>) => ({
      allPassed: true,
      variables: {},
      results: new Map(hooks.map((hook) => [hook.name, {
        success: true,
        duration: 3,
        stdout: '',
        stderr: '',
        variables: {},
      }])),
    }))
    mockRunTest.mockImplementation(async (_test, config, filePath) => ({
      name: 'Login Test',
      filePath,
      status: 'passed',
      steps: [],
      duration: 1,
      runId: config.runId,
    }))

    const result = await runSuite(
      makeSuite({ teardown: ['suite-teardown'], use: { authState: { name: 'admin', load: false, capture: true } } } as any),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolvedHooks: new Map([
          ['suite-teardown', { id: 'suite-teardown', name: 'suite teardown', command: 'true' } as any],
        ]),
        sandboxOptions: { cwd: '/tmp', envVars: {} } as any,
        authStateCapture: {
          capture,
          failureSummary: 'Could not save auth state "admin" for target "webapp".',
        },
      }),
    )

    expect(result.status).toBe('passed')
    expect(capture).toHaveBeenCalledOnce()
    expect(mockRunHooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authState: capturedAuthState }),
    )
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(mockRunHooks.mock.invocationCallOrder[0])
  })

  it('marks the suite failed when auth-state capture fails while preserving passed child results', async () => {
    const { adapter } = createMockAdapter()
    const onTestEnd = vi.fn()
    mockRunTest.mockResolvedValue({
      name: 'Login Test',
      filePath: '/tests/login.yaml',
      status: 'passed',
      steps: [],
      duration: 1,
    })

    const result = await runSuite(
      makeSuite({ use: { authState: { name: 'admin', load: false, capture: true } } } as any),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter, {
        authStateCapture: {
          capture: vi.fn(async () => { throw new Error('disk path /tmp/auth.json') }),
          failureSummary: 'Could not save auth state "admin" for target "webapp".',
        },
        reporters: [{ onTestEnd }],
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.tests).toEqual([
      expect.objectContaining({ name: 'Login Test', status: 'passed' }),
      expect.objectContaining({
        name: 'Auth state capture',
        status: 'failed',
        failureSummary: 'Could not save auth state "admin" for target "webapp".',
      }),
    ])
    expect(onTestEnd).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Auth state capture',
      failureSummary: 'Could not save auth state "admin" for target "webapp".',
    }))
  })

  it('returns suite and child run IDs through reporter context, runner config, and summaries', async () => {
    const { adapter } = createMockAdapter()
    const contexts: Array<Record<string, unknown> | undefined> = []
    const suiteSummaries: Array<Record<string, unknown>> = []
    mockRunTest.mockImplementation(async (_test, config, filePath) => ({
      name: filePath.includes('settings') ? 'Settings Test' : 'Login Test',
      filePath,
      status: 'passed',
      steps: [],
      duration: 1,
      runId: config.runId,
    }))

    const suite = makeSuite({
      tests: [
        { test: 'tests/login.yaml', id: VALID_TEST_ID },
        { test: 'tests/settings.yaml', id: 't_settings' },
      ],
    })
    const result = await runSuite(
      suite,
      [
        [makeTest(), '/tests/login.yaml'],
        [makeTest({ name: 'Settings Test', 'test-id': 't_settings' }), '/tests/settings.yaml'],
      ],
      makeConfig(adapter, {
        reporters: [{
          onSuiteStart: async (_suite, context) => { contexts.push(context as any) },
          onTestStart: async (_test, _filePath, context) => { contexts.push(context as any) },
          onSuiteEnd: async (summary) => { suiteSummaries.push(summary as any) },
        }],
      }),
    )

    const suiteRunId = result.runId
    const childRunIds = result.tests.map((test) => test.runId)
    expect(suiteRunId).toBeTruthy()
    expect(childRunIds).toHaveLength(2)
    expect(childRunIds.every(Boolean)).toBe(true)
    expect(new Set([suiteRunId, ...childRunIds]).size).toBe(3)
    expect(contexts[0]).toEqual(expect.objectContaining({ runId: suiteRunId }))
    expect(contexts.slice(1)).toEqual([
      expect.objectContaining({
        runId: childRunIds[0],
        parentRunId: suiteRunId,
        artifact: expect.objectContaining({
          runtime: expect.objectContaining({ suiteTotal: 2 }),
        }),
      }),
      expect.objectContaining({
        runId: childRunIds[1],
        parentRunId: suiteRunId,
        artifact: expect.objectContaining({
          runtime: expect.objectContaining({ suiteTotal: 2 }),
        }),
      }),
    ])
    expect(mockRunTest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ runId: childRunIds[0], skipReporterOnTestStart: true }),
      '/tests/login.yaml',
    )
    expect(mockRunTest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ runId: childRunIds[1], skipReporterOnTestStart: true }),
      '/tests/settings.yaml',
    )
    expect(suiteSummaries[0]).toEqual(expect.objectContaining({ runId: suiteRunId }))
  })

  it('emits suite and child run IDs on hook events', async () => {
    const { adapter } = createMockAdapter()
    const hookEvents: Array<Record<string, unknown>> = []
    mockRunHooks.mockImplementation(async (hooks: Array<{ name: string }>) => ({
      allPassed: true,
      variables: {},
      results: new Map(hooks.map((hook) => [hook.name, {
        success: true,
        duration: 3,
        stdout: '',
        stderr: '',
        variables: {},
      }])),
    }))
    mockRunTest.mockImplementation(async (_test, config, filePath) => ({
      name: 'Login Test',
      filePath,
      status: 'passed',
      steps: [],
      duration: 1,
      runId: config.runId,
    }))

    const result = await runSuite(
      makeSuite({ setup: ['suite-setup'], teardown: ['suite-teardown'] } as any),
      [[makeTest({ setup: ['test-setup'], teardown: ['test-teardown'] } as any), '/tests/login.yaml']],
      makeConfig(adapter, {
        resolvedHooks: new Map([
          ['suite-setup', { id: 'suite-setup', name: 'suite setup', command: 'true' } as any],
          ['suite-teardown', { id: 'suite-teardown', name: 'suite teardown', command: 'true' } as any],
          ['test-setup', { id: 'test-setup', name: 'test setup', command: 'true' } as any],
          ['test-teardown', { id: 'test-teardown', name: 'test teardown', command: 'true' } as any],
        ]),
        sandboxOptions: { cwd: '/tmp', envVars: {} } as any,
        reporters: [{
          onHookStart: async (event) => { hookEvents.push({ type: 'start', ...event }) },
          onHookEnd: async (event) => { hookEvents.push({ type: 'end', ...event }) },
        }],
      }),
    )

    const suiteRunId = result.runId
    const childRunId = result.tests[0].runId
    expect(hookEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'start', hookId: 'suite-setup', runId: suiteRunId }),
      expect.objectContaining({ type: 'end', hookId: 'suite-setup', runId: suiteRunId }),
      expect.objectContaining({ type: 'start', hookId: 'test-setup', runId: childRunId }),
      expect.objectContaining({ type: 'end', hookId: 'test-setup', runId: childRunId }),
      expect.objectContaining({ type: 'start', hookId: 'test-teardown', runId: childRunId }),
      expect.objectContaining({ type: 'end', hookId: 'test-teardown', runId: childRunId }),
      expect.objectContaining({ type: 'start', hookId: 'suite-teardown', runId: suiteRunId }),
      expect.objectContaining({ type: 'end', hookId: 'suite-teardown', runId: suiteRunId }),
    ]))
  })

  it('preserves queued suite parent run ID from AGENT_QA_SUITE_QUEUE_ID', async () => {
    const { adapter } = createMockAdapter()
    const queuedRunId = 'r_queue-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    process.env.AGENT_QA_SUITE_QUEUE_ID = queuedRunId

    const result = await runSuite(
      makeSuite(),
      [[makeTest(), '/tests/login.yaml']],
      makeConfig(adapter),
    )

    expect(result.runId).toBe(queuedRunId)
  })
})
