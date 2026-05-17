import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LiveSessionConfig } from '../types.js'

const mockSetup = vi.fn().mockResolvedValue(undefined)
const mockCleanup = vi.fn().mockResolvedValue(undefined)
const mockExecute = vi.fn().mockResolvedValue({ success: true })
const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from('fake'))
const mockObserve = vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} })
const mockDrainConsole = vi.fn(() => [])
const mockDrainNetwork = vi.fn(() => [])
const mockAndroidSetup = vi.fn().mockResolvedValue(undefined)
const mockAndroidCleanup = vi.fn().mockResolvedValue(undefined)
const mockResolveMobileRunConfig = vi.fn()

// One adapter instance is shared across all WebPlatformAdapter() calls,
// which lets us assert "same adapter reused across steps" (D-01).
const sharedAdapterRef: { current: unknown } = { current: null }

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn().mockImplementation(function () {
    const adapter = {
      platform: 'web',
      setup: mockSetup,
      cleanup: mockCleanup,
      execute: mockExecute,
      screenshot: mockScreenshot,
      observe: mockObserve,
      drainConsoleLogs: mockDrainConsole,
      drainNetworkLogs: mockDrainNetwork,
    }
    sharedAdapterRef.current = adapter
    return adapter
  }),
}))

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn().mockImplementation(function () {
    return {
      platform: 'android',
      setup: mockAndroidSetup,
      cleanup: mockAndroidCleanup,
      execute: vi.fn(),
      screenshot: vi.fn(),
      observe: vi.fn(),
      drainConsoleLogs: vi.fn(() => []),
      drainNetworkLogs: vi.fn(() => []),
    }
  }),
}))

const mockExecuteStep = vi.fn()
const mockRunHooks = vi.fn()
const mockParseHookInline = vi.fn(() => [])
const mockStripHookInline = vi.fn((instruction: string) => instruction)
const mockRunHookInSandbox = vi.fn()
const mockCreateModel = vi.fn().mockResolvedValue({ modelId: 'test-model' })
const mockGetProviderOptions = vi.fn().mockReturnValue(undefined)
const mockVariableStoreInstance = {
  set: vi.fn(),
  setAll: vi.fn(),
  get: vi.fn(),
  getAll: vi.fn().mockReturnValue(new Map()),
  snapshot: vi.fn().mockReturnValue({}),
}

vi.mock('@vostride/agent-qa-core', () => ({
  MobileSetupError: class MobileSetupError extends Error {
    category: string
    constructor(options: { category: string; message: string }) {
      super(options.message)
      this.name = 'MobileSetupError'
      this.category = options.category
    }
  },
  resolveMobileRunConfig: (...args: unknown[]) => mockResolveMobileRunConfig(...args),
  executeStep: (...args: unknown[]) => mockExecuteStep(...args),
  createModel: (...args: unknown[]) => mockCreateModel(...args),
  getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
  LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
  LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
  VariableStore: vi.fn().mockImplementation(function () { return mockVariableStoreInstance }),
  interpolateVariables: vi.fn((instruction: string) => instruction),
  findUnresolvedTemplates: vi.fn(() => []),
  redactSecretValue: vi.fn((value: unknown) => value),
  redactAuthStateValue: vi.fn((value: unknown) => value),
  parseHookInline: () => mockParseHookInline(),
  stripHookInline: (text: string) => mockStripHookInline(text),
  runHooks: (...args: unknown[]) => mockRunHooks(...args),
  runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
}))

import { LiveSession } from '../live-session.js'

const webConfig: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
  headless: true,
}

const makeHookDef = (name: string) => ({
  id: name,
  name,
  runtime: 'node' as const,
  file: `/tmp/${name}.js`,
  deps: [],
  timeout: 30_000,
  network: false,
})

// Forward-contract type — plan 02 introduces this alongside `executeTestCommand`.
interface LiveTestResultPayload {
  status: 'passed' | 'failed' | 'cancelled'
  duration: number
  error?: string
  setupHookExecutions: Array<{ hookName: string; status: string }>
  stepResults: Array<{ status: string }>
  teardownHookExecutions: Array<{ hookName: string; status: string }>
}

interface TestDraft {
  testIndex: number
  testId: string
  testName: string
  testContext?: string
  steps: string[]
  setup: string[]
  teardown: string[]
}

type ExecuteTestCommand = (
  testExecutionId: string,
  testDraft: TestDraft,
  onPhase?: (event: unknown) => void,
) => Promise<LiveTestResultPayload>

function getExecuteTestCommand(session: LiveSession): ExecuteTestCommand | undefined {
  const candidate = (session as unknown as { executeTestCommand?: ExecuteTestCommand }).executeTestCommand
  return typeof candidate === 'function' ? candidate.bind(session) : undefined
}

// Helper: return a hook-results map keyed by hook name. Each entry is the `runHooks`
// shape that `LiveSession.runLifecycleHooks` expects.
function mockHookResults(entries: Array<{ name: string; success: boolean; variables?: Record<string, string>; error?: string }>) {
  const results = new Map<string, {
    success: boolean
    variables: Record<string, string>
    output: string
    stdout: string
    stderr: string
    duration: number
    error?: string
  }>()
  for (const entry of entries) {
    results.set(entry.name, {
      success: entry.success,
      variables: entry.variables ?? {},
      output: '',
      stdout: '',
      stderr: entry.success ? '' : (entry.error ?? 'hook failed'),
      duration: 5,
      error: entry.success ? undefined : (entry.error ?? 'hook failed'),
    })
  }
  return {
    results,
    variables: Object.assign({}, ...entries.filter(e => e.success).map(e => e.variables ?? {})),
    allPassed: entries.every(e => e.success),
    duration: entries.length * 5,
  }
}

describe('LiveSession.executeTestCommand (suite-mode orchestration)', () => {
  let session: LiveSession

  beforeEach(() => {
    session = new LiveSession('test-session-suite-mode')
    vi.clearAllMocks()
    sharedAdapterRef.current = null
    mockDrainConsole.mockReturnValue([])
    mockDrainNetwork.mockReturnValue([])
    mockExecuteStep.mockResolvedValue({
      name: 'step',
      status: 'passed',
      duration: 50,
      trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
    })
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 })
    mockParseHookInline.mockReturnValue([])
    mockStripHookInline.mockImplementation((instruction: string) => instruction)
    mockRunHookInSandbox.mockReset()
    mockAndroidSetup.mockResolvedValue(undefined)
    mockAndroidCleanup.mockResolvedValue(undefined)
    mockResolveMobileRunConfig.mockReset()
    mockResolveMobileRunConfig.mockReturnValue({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      deviceName: 'release-android-emu',
      transport: 'local',
      device: {
        name: 'release-android-emu',
        platform: 'android',
        transport: 'local',
        match: {},
      },
      app: {
        appPackage: 'org.wikipedia.alpha',
        deepLinkAppId: 'org.wikipedia.alpha',
        sourceTrace: { appPackage: 'registry.targets.release-android-wikipedia.appPackage' },
      },
      appState: 'preserve',
      appium: {},
      sourceTrace: [],
    })
    mockVariableStoreInstance.getAll.mockReturnValue(new Map())
    mockVariableStoreInstance.snapshot.mockReturnValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs per-test setup hooks before any step', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([['per-test-setup', makeHookDef('per-test-setup')]]),
    })
    const execute = getExecuteTestCommand(session)
    expect(execute).toBeDefined()
    if (!execute) return

    const callOrder: string[] = []
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) => {
      callOrder.push(`hook:${hooks.map(h => h.name).join(',')}`)
      return Promise.resolve(mockHookResults(hooks.map(h => ({ name: h.name, success: true }))))
    })
    mockExecuteStep.mockImplementation((instruction: string) => {
      callOrder.push(`step:${instruction}`)
      return Promise.resolve({
        name: instruction,
        status: 'passed',
        duration: 10,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
      })
    })

    await execute('exec-1', {
      testIndex: 0,
      testId: 't_1',
      testName: 'Checkout',
      steps: ['step one', 'step two'],
      setup: ['per-test-setup'],
      teardown: [],
    })

    expect(callOrder[0]).toBe('hook:per-test-setup')
    expect(callOrder.slice(1)).toEqual(['step:step one', 'step:step two'])
  })

  it('runs per-test teardown hooks after all steps when setup succeeded', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([
        ['pre', makeHookDef('pre')],
        ['post', makeHookDef('post')],
      ]),
    })
    const execute = getExecuteTestCommand(session)!

    const callOrder: string[] = []
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) => {
      callOrder.push(`hook:${hooks.map(h => h.name).join(',')}`)
      return Promise.resolve(mockHookResults(hooks.map(h => ({ name: h.name, success: true }))))
    })
    mockExecuteStep.mockImplementation((instruction: string) => {
      callOrder.push(`step:${instruction}`)
      return Promise.resolve({
        name: instruction,
        status: 'passed',
        duration: 10,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
      })
    })

    const result = await execute('exec-2', {
      testIndex: 1,
      testId: 't_2',
      testName: 'Flow',
      steps: ['a', 'b'],
      setup: ['pre'],
      teardown: ['post'],
    })

    expect(callOrder).toEqual(['hook:pre', 'step:a', 'step:b', 'hook:post'])
    expect(result.status).toBe('passed')
    expect(result.teardownHookExecutions.length).toBeGreaterThan(0)
  })

  it('reuses the same adapter instance across steps (shared browser context, D-01)', async () => {
    await session.initialize(webConfig)
    const execute = getExecuteTestCommand(session)!

    const adapterIds: unknown[] = []
    mockExecuteStep.mockImplementation((_instruction: string, loopConfig: { adapter: unknown }) => {
      adapterIds.push(loopConfig.adapter)
      return Promise.resolve({
        name: 'step',
        status: 'passed',
        duration: 10,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
      })
    })

    await execute('exec-3', {
      testIndex: 2,
      testId: 't_3',
      testName: 'Shared',
      steps: ['one', 'two', 'three'],
      setup: [],
      teardown: [],
    })

    expect(adapterIds.length).toBe(3)
    expect(adapterIds[0]).toBe(adapterIds[1])
    expect(adapterIds[1]).toBe(adapterIds[2])
  })

  it('skips per-test teardown when per-test setup fails (Pitfall 2 / runner.ts break)', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([
        ['broken', makeHookDef('broken')],
        ['post', makeHookDef('post')],
      ]),
    })
    const execute = getExecuteTestCommand(session)!

    const hookCalls: string[] = []
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) => {
      const names = hooks.map(h => h.name)
      hookCalls.push(names.join(','))
      const succeeds = !names.includes('broken')
      return Promise.resolve(mockHookResults(names.map(name => ({ name, success: succeeds, error: succeeds ? undefined : 'bang' }))))
    })

    const result = await execute('exec-4', {
      testIndex: 3,
      testId: 't_4',
      testName: 'FailedSetup',
      steps: ['never runs'],
      setup: ['broken'],
      teardown: ['post'],
    })

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Setup hook "broken" failed/)
    expect(hookCalls).toEqual(['broken'])
    expect(mockExecuteStep).not.toHaveBeenCalled()
    expect(result.teardownHookExecutions).toEqual([])
  })

  it('breaks the step loop on step failure but STILL runs per-test teardown', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([['post', makeHookDef('post')]]),
    })
    const execute = getExecuteTestCommand(session)!

    let call = 0
    mockExecuteStep.mockImplementation((instruction: string) => {
      call++
      return Promise.resolve({
        name: instruction,
        status: call === 1 ? 'failed' : 'passed',
        duration: 10,
        error: call === 1 ? 'boom' : undefined,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'failure', screenStateBefore: '' },
      })
    })
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) =>
      Promise.resolve(mockHookResults(hooks.map(h => ({ name: h.name, success: true }))))
    )

    const result = await execute('exec-5', {
      testIndex: 4,
      testId: 't_5',
      testName: 'StepFails',
      steps: ['bad', 'would-not-run'],
      setup: [],
      teardown: ['post'],
    })

    expect(mockExecuteStep).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('failed')
    expect(result.teardownHookExecutions.length).toBe(1)
  })

  it('returns status:cancelled and STILL runs teardown on cancellation (D-25)', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([['post', makeHookDef('post')]]),
    })
    const execute = getExecuteTestCommand(session)!

    mockExecuteStep.mockResolvedValueOnce({
      name: 'cancelled step',
      status: 'cancelled',
      duration: 5,
      trace: { observation: '', reasoning: '', plannedAction: {}, result: 'failure', screenStateBefore: '' },
    })
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) =>
      Promise.resolve(mockHookResults(hooks.map(h => ({ name: h.name, success: true }))))
    )

    const result = await execute('exec-6', {
      testIndex: 5,
      testId: 't_6',
      testName: 'Cancelled',
      steps: ['never finish'],
      setup: [],
      teardown: ['post'],
    })

    expect(result.status).toBe('cancelled')
    expect(result.teardownHookExecutions.length).toBe(1)
  })

  it('invokes onPhase callback at least once per step', async () => {
    await session.initialize(webConfig)
    const execute = getExecuteTestCommand(session)!

    mockExecuteStep.mockImplementation(async (_i: string, config: { onPhase?: (event: unknown) => void }) => {
      config.onPhase?.({ phase: 'observe', text: 'looking' })
      return {
        name: 'step',
        status: 'passed',
        duration: 10,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
      }
    })

    const phaseEvents: unknown[] = []
    await execute(
      'exec-7',
      { testIndex: 6, testId: 't_7', testName: 'PhaseEvents', steps: ['alpha', 'beta'], setup: [], teardown: [] },
      (event) => phaseEvents.push(event),
    )

    expect(phaseEvents.length).toBeGreaterThanOrEqual(2)
  })

  it('throws "Live session is not ready" when the session is not interactive', async () => {
    // No initialize — session is never interactive.
    const execute = getExecuteTestCommand(session)
    if (!execute) {
      // When the method doesn't exist at all, fail explicitly — this test is RED pre-implementation.
      throw new Error('executeTestCommand is not defined on LiveSession')
    }
    await expect(
      execute('exec-8', { testIndex: 7, testId: 't_8', testName: 'X', steps: ['a'], setup: [], teardown: [] }),
    ).rejects.toThrow(/Live session is not ready/)
  })

  it('releases a managed Appium lease when mobile adapter setup fails', async () => {
    const acquireLease = vi.fn().mockResolvedValue(undefined)
    const releaseLease = vi.fn().mockReturnValue(true)
    const mobileSession = new LiveSession('live-android-session', {
      appiumManager: {
        acquireLease,
        releaseLease,
        getUrl: vi.fn(() => 'http://localhost:4723'),
      } as any,
      configManager: {
        read: vi.fn().mockResolvedValue({
          registry: {
            targets: {
              'release-android-wikipedia': {
                platform: 'android',
                appPackage: 'org.wikipedia.alpha',
              },
            },
            devices: {
              'release-android-emu': {
                platform: 'android',
                transport: 'local',
                match: {},
              },
            },
          },
        }),
      } as any,
      configPath: '/tmp/agent-qa.config.yaml',
    })
    mockAndroidSetup.mockRejectedValueOnce(new Error('app not installed'))

    await expect(
      mobileSession.initialize({
        platform: 'android',
        targetName: 'release-android-wikipedia',
        useDeviceName: 'release-android-emu',
        appState: 'preserve',
        llmConfig: {
          provider: 'anthropic-compatible',
          model: 'claude-sonnet-4-20250514',
          baseURL: 'https://anthropic-proxy.example/messages',
        },
      }),
    ).rejects.toThrow(/device-readiness: Failed to create android adapter session/)

    expect(acquireLease).toHaveBeenCalledWith({ runId: 'live-android-session', platform: 'android' })
    expect(releaseLease).toHaveBeenCalledWith('live-android-session', 'setup-failed')
  })

  it('throws "Test already executing" when executing is already true', async () => {
    await session.initialize(webConfig)
    const execute = getExecuteTestCommand(session)!

    mockExecuteStep.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
      name: 'slow',
      status: 'passed',
      duration: 50,
      trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
    }), 80)))

    const first = execute('exec-9a', { testIndex: 8, testId: 't_9', testName: 'A', steps: ['slow'], setup: [], teardown: [] })
    await expect(
      execute('exec-9b', { testIndex: 9, testId: 't_9', testName: 'B', steps: ['slow'], setup: [], teardown: [] }),
    ).rejects.toThrow(/already executing/i)
    await first
  })

  it('returns a LiveTestResultPayload with the documented shape', async () => {
    await session.initialize(webConfig)
    const execute = getExecuteTestCommand(session)!

    mockExecuteStep.mockResolvedValueOnce({
      name: 'step',
      status: 'passed',
      duration: 25,
      trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
    })

    const result = await execute('exec-10', {
      testIndex: 10,
      testId: 't_10',
      testName: 'ShapeCheck',
      steps: ['only'],
      setup: [],
      teardown: [],
    })

    expect(result).toMatchObject({
      status: expect.stringMatching(/^(passed|failed|cancelled)$/),
      duration: expect.any(Number),
      setupHookExecutions: expect.any(Array),
      stepResults: expect.any(Array),
      teardownHookExecutions: expect.any(Array),
    })
    expect(result.stepResults).toHaveLength(1)
    expect(result.stepResults[0].status).toBe('passed')
  })

  it('dispatches owner-aware per-test hook payloads through the message sink', async () => {
    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([['per-test-setup', makeHookDef('per-test-setup')]]),
    })
    const execute = getExecuteTestCommand(session)!
    const sink = vi.fn()
    session.attachMessageSink(sink)
    mockRunHooks.mockImplementation((hooks: Array<{ name: string }>) =>
      Promise.resolve(mockHookResults(hooks.map((hook) => ({ name: hook.name, success: true }))))
    )

    await execute('exec-hooks', {
      testIndex: 11,
      testId: 't_hooks',
      testName: 'Hook Owner',
      steps: [],
      setup: ['per-test-setup'],
      teardown: [],
    })

    const hookMessages = sink.mock.calls
      .map(([message]) => message)
      .filter((message: any) => message.type === 'hook-start' || message.type === 'hook-complete')

    expect(hookMessages).toHaveLength(2)
    expect(hookMessages[0]).toMatchObject({
      type: 'hook-start',
      hook: {
        hookName: 'per-test-setup',
        owner: {
          scope: 'test',
          testExecutionId: 'exec-hooks',
          testIndex: 11,
          testId: 't_hooks',
          testName: 'Hook Owner',
        },
      },
    })
  })

  it('dispatches explicit suite-mode test-step lifecycle messages while a test is running', async () => {
    await session.initialize(webConfig)
    const execute = getExecuteTestCommand(session)!
    const sink = vi.fn()
    session.attachMessageSink(sink)

    mockExecuteStep.mockImplementation(async (_instruction: string, config: { onPhase?: (event: unknown) => void }) => {
      config.onPhase?.({ phase: 'observe', text: 'looking' })
      return {
        name: 'step',
        status: 'passed',
        duration: 10,
        trace: { observation: '', reasoning: '', plannedAction: {}, result: 'success', screenStateBefore: '' },
      }
    })

    await execute('exec-steps', {
      testIndex: 12,
      testId: 't_steps',
      testName: 'Lifecycle',
      steps: ['alpha'],
      setup: [],
      teardown: [],
    })

    const messages = sink.mock.calls.map(([message]) => message)
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'test-step-start',
        step: expect.objectContaining({
          testExecutionId: 'exec-steps',
          testIndex: 12,
          testId: 't_steps',
          stepIndex: 0,
          stepInstruction: 'alpha',
        }),
      }),
      expect.objectContaining({
        type: 'test-step-phase',
        step: expect.objectContaining({
          testExecutionId: 'exec-steps',
          stepIndex: 0,
        }),
        phase: 'observe',
      }),
      expect.objectContaining({
        type: 'test-step-complete',
        step: expect.objectContaining({
          testExecutionId: 'exec-steps',
          stepIndex: 0,
        }),
        result: expect.objectContaining({ status: 'passed' }),
      }),
    ]))
  })
})
