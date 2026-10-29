import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { LiveFrame, LiveFrameEndReason } from '@vostride/agent-qa-schema'
import type { LiveSessionConfig } from '../live-editor/types.js'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const TEARDOWN_HOOK_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const INLINE_HOOK_TOKEN = `{{runHook:"${HOOK_ID}"}}`

const mockSetup = vi.fn().mockResolvedValue(undefined)
const mockCleanup = vi.fn().mockResolvedValue(undefined)
const mockExecute = vi.fn().mockResolvedValue({ success: true })
const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from('fake-screenshot'))
const mockObserve = vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} })
// The web adapter's Chromium screencast, as the editor's hub sees it (428 D-07).
let screencastEmit: ((frame: LiveFrame) => void) | undefined
const mockScreencastStart = vi.fn(async (onFrame: (frame: LiveFrame) => void) => {
  screencastEmit = onFrame
})
const mockScreencastStop = vi.fn(async () => {
  screencastEmit = undefined
})
const mockScreencast = {
  kind: 'cdp-screencast' as const,
  start: mockScreencastStart,
  ack: vi.fn(async () => {}),
  stop: mockScreencastStop,
}

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn().mockImplementation(function () {
    return {
      platform: 'web',
      setup: mockSetup,
      cleanup: mockCleanup,
      execute: mockExecute,
      screenshot: mockScreenshot,
      observe: mockObserve,
      liveStream: mockScreencast,
    }
  }),
}))

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn().mockImplementation(function () {
    throw new Error('mock Android adapter unavailable')
  }),
}))

const mockExecuteStep = vi.fn().mockResolvedValue({
  name: 'test-step',
  status: 'passed',
  duration: 100,
})
const variableStoreEntries = new Map<string, string>()
const mockRunHooks = vi.fn().mockResolvedValue({
  results: new Map(),
  variables: {},
  allPassed: true,
  duration: 5,
})
const mockRunHookInSandbox = vi.fn().mockResolvedValue({
  success: true,
  variables: {},
  output: 'ok',
  stdout: 'ok',
  stderr: '',
  duration: 5,
})
const mockParseHookInline = vi.fn((text: string) => Array.from(text.matchAll(/\{\{runHook:"([^"]+)"\}\}/g)).map((match) => ({
  hookId: match[1],
  fullMatch: match[0],
})))
const mockStripHookInline = vi.fn((text: string) => text.replace(/\{\{runHook:"[^"]+"\}\}/g, '').replace(/\s{2,}/g, ' ').trim())
const mockInterpolateVariables = vi.fn((instruction: string, variableStore: { getAll: () => Map<string, string> }) => {
  const values = variableStore.getAll()
  return instruction.replace(/\{\{env:([^}]+)\}\}/g, (match, rawName: string) => {
    const name = rawName.trim()
    return values.get(name) ?? match
  })
})
const mockFindUnresolvedTemplates = vi.fn((instruction: string) => {
  const unresolved: Array<{ pattern: string; message: string }> = []
  const hookMatch = instruction.match(/\{\{runHook:"[^"]+"\}\}/)
  if (hookMatch) {
    unresolved.push({ pattern: hookMatch[0], message: 'unknown template syntax' })
  }

  for (const match of instruction.matchAll(/\{\{env:([^}]+)\}\}/g)) {
    unresolved.push({ pattern: match[0], message: `variable '${match[1].trim()}' not set. Set it in .env, via --var, or setVariable action.` })
  }

  return unresolved
})

const mockCreateModel = vi.fn().mockReturnValue({ modelId: 'test-model' })
const mockGetProviderOptions = vi.fn().mockReturnValue(undefined)
const mockVariableStoreInstance = {
  set: vi.fn((name: string, value: string) => {
    variableStoreEntries.set(name, value)
  }),
  setAll: vi.fn((values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      variableStoreEntries.set(name, value)
    }
  }),
  get: vi.fn((name: string) => variableStoreEntries.get(name)),
  getAll: vi.fn(() => new Map(variableStoreEntries)),
  snapshot: vi.fn(() => Object.fromEntries(variableStoreEntries)),
}

// executeStep/LLMPlanner/LLMVerifier moved to the runner package (Phase 353-07);
// live-session now imports them from @vostride/agent-qa-runner, so intercept them there.
vi.mock('@vostride/agent-qa-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-runner')>()
  return {
    ...actual,
    executeStep: (...args: unknown[]) => mockExecuteStep(...args),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
    // runHooks moved to runner in Phase 363 D-06.
    runHooks: (...args: unknown[]) => mockRunHooks(...args),
    // Variables subsystem moved to runner in Phase 363 D-07.
    VariableStore: vi.fn().mockImplementation(function () { return mockVariableStoreInstance }),
    interpolateVariables: (...args: unknown[]) => mockInterpolateVariables(...args as Parameters<typeof mockInterpolateVariables>),
    findUnresolvedTemplates: (...args: unknown[]) => mockFindUnresolvedTemplates(...args as Parameters<typeof mockFindUnresolvedTemplates>),
    // Inline hook parsing moved to runner in Phase 363-11; live-session imports it from runner.
    parseHookInline: (text: string) => mockParseHookInline(text),
    stripHookInline: (text: string) => mockStripHookInline(text),
  }
})

// DockerHookExecutor moved to runner-local in Phase 363 D-06; its execute() is the old
// runHookInSandbox body behind the port.
vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()),
  DockerHookExecutor: class { execute(...args: unknown[]) { return mockRunHookInSandbox(...args) } },
}))

vi.mock('@vostride/agent-qa-core', async () => {
  // 436-19: the live door checks limit leaves with the real core schemas the CLI applies.
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  class LocalSecretStore {
    private secrets: Record<string, string>
    constructor(secrets: Record<string, string> = {}) {
      this.secrets = secrets
    }
    get(name: string) { return this.secrets[name] }
    require(name: string) {
      const value = this.get(name)
      if (value === undefined) throw new Error(`Secret not found: ${name}`)
      return value
    }
    forEachSecret(callback: (name: string, value: string) => void) {
      for (const [name, value] of Object.entries(this.secrets)) callback(name, value)
    }
  }
  class LocalSecretRedactor {
    constructor(private store: LocalSecretStore) {}
    redactString(value: string) {
      let redacted = value.replace(/\{\{secret:(\w+)\}\}/g, (_match, name) => `[secret:${name}]`)
      this.store.forEachSecret((_name, secret) => {
        redacted = redacted.replaceAll(secret, '[secret]')
      })
      return redacted
    }
  }
  const redactSecretValue = (value: any, redactor?: LocalSecretRedactor): any => {
    if (!redactor) return value
    if (typeof value === 'string') return redactor.redactString(value)
    if (Buffer.isBuffer(value)) return value
    if (Array.isArray(value)) return value.map((item) => redactSecretValue(item, redactor))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretValue(item, redactor)]))
    }
    return value
  }
  const resolveSecretTemplatesInValue = (value: any, store?: LocalSecretStore): any => {
    if (!store) return value
    if (typeof value === 'string') return value.replace(/\{\{secret:(\w+)\}\}/g, (_match, name) => store.require(name))
    if (Array.isArray(value)) return value.map((item) => resolveSecretTemplatesInValue(item, store))
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSecretTemplatesInValue(item, store)]))
    }
    return value
  }
  return {
    MobileSetupError: class MobileSetupError extends Error {
      category: string
      constructor(options: { category: string; message: string }) {
        super(options.message)
        this.name = 'MobileSetupError'
        this.category = options.category
      }
    },
    resolveMobileRunConfig: vi.fn(),
    getAgentQaVersion: () => '0.0.0',
    executeStep: (...args: unknown[]) => mockExecuteStep(...args),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
    runHooks: (...args: unknown[]) => mockRunHooks(...args),
    runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
    parseHookInline: (text: string) => mockParseHookInline(text),
    stripHookInline: (text: string) => mockStripHookInline(text),
    SecretStore: LocalSecretStore,
    SecretRedactor: LocalSecretRedactor,
    redactSecretValue,
    resolveSecretTemplatesInValue,
    PlannerConfigSchema: actual.PlannerConfigSchema,
    printRunText: actual.printRunText,
    TestDefinitionSchema: actual.TestDefinitionSchema,
    SuiteDefinitionSchema: actual.SuiteDefinitionSchema,
  }
})

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: (...args: unknown[]) => mockCreateModel(...args),
    getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
  }
})

import { LivePlannerLimitsRefusedError, LiveSession, resolveLivePlannerLimits } from '../live-editor/live-session.js'
import type { ConfigManager } from '../config/index.js'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { resolvePlannerLimits } from '@vostride/agent-qa-schema'

const webConfig: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
  headless: true,
}

describe('LiveSession', () => {
  let session: LiveSession

  beforeEach(() => {
    session = new LiveSession('test-session-1')
    vi.clearAllMocks()
    variableStoreEntries.clear()
    mockExecuteStep.mockResolvedValue({ name: 'test-step', status: 'passed', duration: 100 })
    mockRunHooks.mockResolvedValue({
      results: new Map(),
      variables: {},
      allPassed: true,
      duration: 5,
    })
    mockRunHookInSandbox.mockResolvedValue({
      success: true,
      variables: {},
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      duration: 5,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initialize creates adapter and model for web platform', async () => {
    await session.initialize(webConfig)
    expect(mockSetup).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'web', browser: expect.objectContaining({ name: 'chromium' }) }),
    )
    expect(mockCreateModel).toHaveBeenCalled()
    expect(session.status).toBe('idle')
  })

  it('initialize passes the configured navigation timeout to the web adapter setup', async () => {
    await session.initialize({ ...webConfig, navigationTimeoutMs: 30_000 })
    expect(mockSetup).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'web', timeouts: { navigation: 30_000 } }),
    )
  })

  it('initialize leaves the navigation timeout to the adapter default when none is configured', async () => {
    await session.initialize(webConfig)
    expect(mockSetup).toHaveBeenCalledWith(expect.not.objectContaining({ timeouts: expect.anything() }))
  })

  it('initialize navigates to URL when provided', async () => {
    await session.initialize({ ...webConfig, url: 'https://example.com' })
    expect(mockExecute).toHaveBeenCalledWith({ type: 'navigate', to: 'url', url: 'https://example.com' })
  })

  it('initialize resolves secret placeholders only for adapter navigation', async () => {
    const secretStore = new SecretStore({ START_URL_TOKEN: 'runtime-url-token' })
    await session.initialize({
      ...webConfig,
      url: 'https://example.com/{{secret:START_URL_TOKEN}}',
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(mockExecute).toHaveBeenCalledWith({ type: 'navigate', to: 'url', url: 'https://example.com/runtime-url-token' })
  })

  it('initialize remains interactive when hookRegistryError is present but no missing setup hooks are requested', async () => {
    await session.initialize({
      ...webConfig,
      hookRegistryError: 'Invalid YAML in hooks file: unexpected end of document',
    })

    expect(mockSetup).toHaveBeenCalled()
    expect(mockCreateModel).toHaveBeenCalled()
    expect(session.getState().interactive).toBe(true)
    expect(session.getState().terminalError).toBeNull()
  })

  it('initialize surfaces hookRegistryError when a configured setup hook is unavailable', async () => {
    const hookMessages: any[] = []
    session.attachMessageSink((message) => {
      hookMessages.push(message)
    })

    await session.initialize({
      ...webConfig,
      setupHooks: [HOOK_ID],
      hookRegistryError: 'Invalid YAML in hooks file: unexpected end of document',
    })

    expect(session.getState().interactive).toBe(false)
    expect(session.getState().terminalError).toContain('Setup hooks failed')
    expect(hookMessages).toHaveLength(2)
    expect(hookMessages[1]).toMatchObject({
      type: 'hook-complete',
      hook: {
        hookId: HOOK_ID,
        status: 'failed',
        stderr: 'Invalid YAML in hooks file: unexpected end of document',
        error: `Hook ID "${HOOK_ID}" is not defined in hooks.yaml (Invalid YAML in hooks file: unexpected end of document)`,
      },
    })
  })

  it('initialize throws when android adapter is not available', async () => {
    const mobileConfig: LiveSessionConfig = { ...webConfig, platform: 'android' }
    await expect(session.initialize(mobileConfig)).rejects.toThrow('Failed to load Android adapter')
  })

  it('executeStepCommand calls executeStep with correct config', async () => {
    await session.initialize(webConfig)
    const result = await session.executeStepCommand(
      'Click the login button',
      0,
      undefined,
      { testName: 'Draft Login', testContext: 'Use staging login' },
    )
    expect(mockExecuteStep).toHaveBeenCalledWith(
      'Click the login button',
      expect.objectContaining({
        plannerConfig: expect.objectContaining({ maxActions: 30, maxPlanningTurns: 30 }),
      }),
      expect.objectContaining({
        stepInstruction: 'Click the login button',
        testName: 'Draft Login',
        testContext: 'Use staging login',
      }),
    )
    expect(result.status).toBe('passed')
    expect(session.stepsExecuted).toBe(1)
  })

  it('executeStepCommand passes secret context and redacts returned live payloads', async () => {
    const messages: any[] = []
    session.attachMessageSink((message) => messages.push(message))
    const secretStore = new SecretStore({ loginPassword: 'raw-secret-sentinel' })
    mockExecuteStep.mockResolvedValue({
      name: 'Fill {{secret:loginPassword}}',
      status: 'failed',
      duration: 7,
      error: 'adapter echoed raw-secret-sentinel',
      trace: {
        observation: 'raw-secret-sentinel',
        reasoning: 'use raw-secret-sentinel',
        plannedAction: { type: 'fill', ref: 'password', value: 'raw-secret-sentinel' },
        result: 'failure',
        error: 'raw-secret-sentinel',
        screenStateBefore: 'raw-secret-sentinel',
      },
      variableSnapshot: { leaked: { value: 'raw-secret-sentinel', source: 'env' } },
    })

    await session.initialize({
      ...webConfig,
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })
    const result = await session.executeStepCommand(
      'Fill password with {{secret:loginPassword}}',
      0,
      undefined,
      { testName: 'Secret Draft' },
    )

    expect(mockExecuteStep).toHaveBeenCalledWith(
      'Fill password with {{secret:loginPassword}}',
      expect.objectContaining({ secretStore, secretRedactor: expect.anything() }),
      expect.objectContaining({
        stepInstruction: 'Fill password with {{secret:loginPassword}}',
      }),
    )
    expect(JSON.stringify(result)).not.toContain('raw-secret-sentinel')
    expect(JSON.stringify(messages)).not.toContain('raw-secret-sentinel')
    expect(result.error).toContain('[secret:loginPassword]')
  })

  it('executeStepCommand throws when already executing', async () => {
    await session.initialize(webConfig)
    mockExecuteStep.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ name: 's', status: 'passed', duration: 50 }), 100)))
    const first = session.executeStepCommand('Step 1')
    await expect(session.executeStepCommand('Step 2')).rejects.toThrow('Step already executing')
    await first
  })

  it('executeStepCommand tracks previousSteps across calls', async () => {
    await session.initialize(webConfig)
    await session.executeStepCommand('Step 1', 0, undefined, { testName: 'Draft Step 1' })

    let capturedPreviousSteps: unknown[] = []
    mockExecuteStep.mockImplementation((_step: string, _config: unknown, ctx: { previousSteps: unknown[] }) => {
      capturedPreviousSteps = [...ctx.previousSteps]
      return Promise.resolve({ name: 'test-step', status: 'passed', duration: 100 })
    })
    await session.executeStepCommand('Step 2', 1, undefined, { testName: 'Draft Step 2' })

    expect(capturedPreviousSteps).toEqual([{ instruction: 'Step 1', outcome: 'passed' }])
  })

  it('executeStepCommand runs inline hooks before unresolved-template validation and uses hook variables in the same step', async () => {
    mockRunHookInSandbox.mockResolvedValue({
      success: true,
      variables: { test_runtime_env: '42' },
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      duration: 11,
    })

    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([[
        HOOK_ID,
        {
          id: HOOK_ID,
          name: 'Seed Auth',
          runtime: 'node',
          file: '/tmp/seed-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        },
      ]]),
    })

    const result = await session.executeStepCommand(
      `${INLINE_HOOK_TOKEN} Verify that {{env:test_runtime_env}} equals 42`,
      0,
      undefined,
      { testName: 'Inline Hook Draft' },
    )

    expect(mockRunHookInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: HOOK_ID, name: 'Seed Auth' }),
      expect.objectContaining({ env: {} }),
    )
    expect(mockFindUnresolvedTemplates).toHaveBeenCalledWith('Verify that 42 equals 42')
    expect(mockExecuteStep).toHaveBeenCalledWith(
      'Verify that 42 equals 42',
      expect.anything(),
      expect.objectContaining({
        stepInstruction: 'Verify that 42 equals 42',
        variables: expect.objectContaining({ test_runtime_env: '42' }),
      }),
    )
    expect(result.status).toBe('passed')
    expect(result.executionLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'hook',
        name: 'Seed Auth',
        hookId: HOOK_ID,
        status: 'passed',
        variables: { test_runtime_env: '42' },
      }),
    ]))
  })

  it('executeStepCommand fails fast when an inline hook id is missing from the live registry', async () => {
    await session.initialize(webConfig)

    const result = await session.executeStepCommand(
      `${INLINE_HOOK_TOKEN} Verify that {{env:test_runtime_env}} equals 42`,
      0,
      undefined,
      { testName: 'Missing Inline Hook Draft' },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toBe(`Inline hook "${HOOK_ID}" is not defined in hooks.yaml`)
    expect(mockRunHookInSandbox).not.toHaveBeenCalled()
    expect(mockExecuteStep).not.toHaveBeenCalled()
  })

  it('initialize seeds env vars into the live variable store', async () => {
    await session.initialize({
      ...webConfig,
      envVars: { BASE_URL: 'https://example.com', AUTH_TOKEN: 'secret' },
    })

    expect(mockVariableStoreInstance.setAll).toHaveBeenCalledWith(
      { BASE_URL: 'https://example.com', AUTH_TOKEN: 'secret' },
      'env',
    )
  })

  it('initialize runs setup hooks before the session becomes interactive', async () => {
    mockRunHooks.mockResolvedValue({
      results: new Map([[
        'Seed Auth',
        {
          success: true,
          variables: { AUTH_TOKEN: 'hook-token' },
          output: 'ok',
          stdout: 'ok',
          stderr: '',
          duration: 12,
        },
      ]]),
      variables: { AUTH_TOKEN: 'hook-token' },
      allPassed: true,
      duration: 12,
    })

    await session.initialize({
      ...webConfig,
      setupHooks: [HOOK_ID],
      resolvedHooks: new Map([[
        HOOK_ID,
        {
          id: HOOK_ID,
          name: 'Seed Auth',
          runtime: 'node',
          file: '/tmp/seed-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        },
      ]]),
    })

    expect(mockRunHooks).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'Seed Auth' })],
      expect.objectContaining({ env: {} }),
    )
    expect(mockVariableStoreInstance.setAll).toHaveBeenCalledWith(
      { AUTH_TOKEN: 'hook-token' },
      'hook',
    )
    expect(session.getState().interactive).toBe(true)
    expect(mockSetup).toHaveBeenCalled()
  })

  it('initialize leaves the session inspectable when setup hooks fail', async () => {
    mockRunHooks.mockResolvedValue({
      results: new Map([[
        'Seed Auth',
        {
          success: false,
          variables: {},
          output: '',
          stdout: '',
          stderr: 'boom',
          duration: 8,
          error: 'Hook failed',
        },
      ]]),
      variables: {},
      allPassed: false,
      duration: 8,
    })

    await session.initialize({
      ...webConfig,
      setupHooks: [HOOK_ID],
      resolvedHooks: new Map([[
        HOOK_ID,
        {
          id: HOOK_ID,
          name: 'Seed Auth',
          runtime: 'node',
          file: '/tmp/seed-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        },
      ]]),
    })

    expect(mockSetup).not.toHaveBeenCalled()
    expect(mockCreateModel).not.toHaveBeenCalled()
    expect(session.getState().interactive).toBe(false)
    expect(session.getState().terminalError).toContain('Setup hooks failed')
    await expect(session.executeStepCommand('Click login')).rejects.toThrow('Setup hooks failed')
  })

  it('cancelStep does not throw when no step executing', () => {
    expect(() => session.cancelStep()).not.toThrow()
  })

  it('executeHookCommand runs a single hook on demand and stores emitted variables', async () => {
    mockRunHooks.mockResolvedValue({
      results: new Map([[
        'Seed Auth',
        {
          success: true,
          variables: { AUTH_TOKEN: 'hook-token' },
          output: 'ok',
          stdout: 'ok',
          stderr: '',
          duration: 9,
        },
      ]]),
      variables: { AUTH_TOKEN: 'hook-token' },
      allPassed: true,
      duration: 9,
    })

    await session.initialize({
      ...webConfig,
      resolvedHooks: new Map([[
        HOOK_ID,
        {
          id: HOOK_ID,
          name: 'Seed Auth',
          runtime: 'node',
          file: '/tmp/seed-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        },
      ]]),
    })

    const hookMessages: any[] = []
    session.attachMessageSink((message) => {
      hookMessages.push(message)
    })

    const result = await session.executeHookCommand('setup', HOOK_ID)

    expect(mockRunHooks).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: HOOK_ID, name: 'Seed Auth' })],
      expect.objectContaining({ env: {} }),
    )
    expect(mockVariableStoreInstance.setAll).toHaveBeenCalledWith(
      { AUTH_TOKEN: 'hook-token' },
      'hook',
    )
    expect(result.name).toBe('Seed Auth')
    expect(result.status).toBe('passed')
    expect(hookMessages).toHaveLength(2)
    expect(hookMessages[0]).toMatchObject({
      type: 'hook-start',
      hook: {
        hookId: HOOK_ID,
        hookName: 'Seed Auth',
        status: 'running',
      },
    })
    expect(hookMessages[0].hook.executionId).toEqual(expect.any(String))
    expect(hookMessages[0].hook.executionId).not.toBe(HOOK_ID)
    expect(hookMessages[1]).toMatchObject({
      type: 'hook-complete',
      hook: {
        executionId: hookMessages[0].hook.executionId,
        hookId: HOOK_ID,
        hookName: 'Seed Auth',
        status: 'passed',
      },
    })
    expect((result as any).hookId).toBe(HOOK_ID)
    expect(result.id).toBe(hookMessages[0].hook.executionId)
    expect(session.getState().status).toBe('idle')
  })

  it('getState returns correct state', async () => {
    await session.initialize(webConfig)
    const state = session.getState()
    expect(state.sessionId).toBe('test-session-1')
    expect(state.platform).toBe('web')
    expect(state.status).toBe('idle')
    expect(state.currentStep).toBeNull()
    expect(state.stepsExecuted).toBe(0)
    expect(state.createdAt).toBeGreaterThan(0)
  })

  it('startIdleTimer calls callback after timeout', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    session.startIdleTimer(callback)
    vi.advanceTimersByTime(300_001)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('clearIdleTimer prevents callback', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    session.startIdleTimer(callback)
    session.clearIdleTimer()
    vi.advanceTimersByTime(300_001)
    expect(callback).not.toHaveBeenCalled()
  })

  it('cleanup calls adapter.cleanup', async () => {
    await session.initialize(webConfig)
    await session.cleanup()
    expect(mockCleanup).toHaveBeenCalled()
    expect(session.status).toBe('terminated')
  })

  it('cleanup runs teardown hooks when the live session ends', async () => {
    mockRunHooks
      .mockResolvedValueOnce({
        results: new Map([[
          'Seed Auth',
          {
            success: true,
            variables: { AUTH_TOKEN: 'hook-token' },
            output: 'ok',
            stdout: 'ok',
            stderr: '',
            duration: 5,
          },
        ]]),
        variables: { AUTH_TOKEN: 'hook-token' },
        allPassed: true,
        duration: 5,
      })
      .mockResolvedValueOnce({
        results: new Map([[
          'Cleanup Auth',
          {
            success: true,
            variables: {},
            output: 'done',
            stdout: 'done',
            stderr: '',
            duration: 7,
          },
        ]]),
        variables: {},
        allPassed: true,
        duration: 7,
      })

    await session.initialize({
      ...webConfig,
      setupHooks: [HOOK_ID],
      teardownHooks: [TEARDOWN_HOOK_ID],
      resolvedHooks: new Map([
        [HOOK_ID, {
          id: HOOK_ID,
          name: 'Seed Auth',
          runtime: 'node',
          file: '/tmp/seed-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        }],
        [TEARDOWN_HOOK_ID, {
          id: TEARDOWN_HOOK_ID,
          name: 'Cleanup Auth',
          runtime: 'node',
          file: '/tmp/cleanup-auth.js',
          deps: [],
          timeout: 30_000,
          network: false,
        }],
      ]),
    })

    mockVariableStoreInstance.getAll.mockReturnValue(new Map([['AUTH_TOKEN', 'hook-token']]))
    await session.cleanup()

    expect(mockCleanup).toHaveBeenCalled()
    expect(mockRunHooks).toHaveBeenLastCalledWith(
      [expect.objectContaining({ name: 'Cleanup Auth' })],
      expect.objectContaining({ env: { AUTH_TOKEN: 'hook-token' } }),
    )
  })

  it('HUB-REGISTERED-UNDER-SESSION: a web session registers its screencast as handle 0 of its own hub', async () => {
    await session.initialize(webConfig)
    const attachment = session.liveAttachment()

    expect(attachment.streamCapabilityOf(0)).toEqual({ kind: 'cdp-screencast' })

    const frames: LiveFrame[] = []
    const subscription = attachment.subscribeFrames(0, (frame) => frames.push(frame))
    expect(subscription, 'handle 0 is subscribable').toBeDefined()
    await vi.waitFor(() => expect(mockScreencastStart).toHaveBeenCalledTimes(1))

    screencastEmit?.({
      id: 7,
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { width: 10, height: 20, timestamp: 1_700_000_000_000 },
    })
    expect(frames.map((frame) => frame.id)).toEqual([7])
    expect(frames[0]?.kind).toBe('cdp-screencast')
    subscription?.unsubscribe()
  })

  it('HUB-REGISTERED-UNDER-SESSION: a session whose setup hooks failed has no adapter and no hub', async () => {
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: false, duration: 1 })
    await session.initialize({
      ...webConfig,
      setupHooks: [HOOK_ID],
      resolvedHooks: new Map([[HOOK_ID, {
        id: HOOK_ID,
        name: 'Seed Auth',
        runtime: 'node',
        file: '/tmp/seed-auth.js',
        deps: [],
        timeout: 30_000,
        network: false,
      }]]),
    })
    const attachment = session.liveAttachment()

    expect(attachment.streamCapabilityOf(0)).toEqual({ kind: 'none' })
    expect(attachment.subscribeFrames(0, () => {})).toBeUndefined()
  })

  it('MOBILE-REGISTERS-SNAPSHOT: a mobile session registers the adapter\'s context-neutral snapshot stream', async () => {
    const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
    const snapshotStream = {
      kind: 'snapshot' as const,
      start: vi.fn(async () => {}),
      ack: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }
    const mobileScreenshot = vi.fn()
    ;(AndroidPlatformAdapter as unknown as Mock).mockImplementationOnce(function () {
      return {
        platform: 'android',
        setup: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn(),
        observe: vi.fn(),
        screenshot: mobileScreenshot,
        liveStream: snapshotStream,
      }
    })

    await session.initialize({ ...webConfig, platform: 'android', appPackage: 'com.example.app' })
    const attachment = session.liveAttachment()

    expect(attachment.streamCapabilityOf(0)).toEqual({ kind: 'snapshot' })
    const subscription = attachment.subscribeFrames(0, () => {})
    expect(subscription).toBeDefined()
    await vi.waitFor(() => expect(snapshotStream.start).toHaveBeenCalledTimes(1))
    expect(mobileScreenshot, 'never the context-switching screenshot()').not.toHaveBeenCalled()
    subscription?.unsubscribe()
  })

  it('CLEANUP-CLOSES-HUB-AND-ENDS: cleanup closes the hub before the browser goes, settles ended, and runs once', async () => {
    await session.initialize({
      ...webConfig,
      teardownHooks: [TEARDOWN_HOOK_ID],
      resolvedHooks: new Map([[TEARDOWN_HOOK_ID, {
        id: TEARDOWN_HOOK_ID,
        name: 'Cleanup Auth',
        runtime: 'node',
        file: '/tmp/cleanup-auth.js',
        deps: [],
        timeout: 30_000,
        network: false,
      }]]),
    })
    const attachment = session.liveAttachment()
    let ended = false
    void attachment.ended.then(() => {
      ended = true
    })
    const ends: LiveFrameEndReason[] = []
    attachment.subscribeFrames(0, () => {}, (reason) => ends.push(reason))
    await vi.waitFor(() => expect(mockScreencastStart).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(ended, 'ended is pending while the session lives').toBe(false)

    await session.cleanup()
    await Promise.resolve()

    expect(ends).toEqual(['closed'])
    expect(ended).toBe(true)
    expect(mockScreencastStop).toHaveBeenCalledTimes(1)
    expect(mockScreencastStop.mock.invocationCallOrder[0]).toBeLessThan(mockCleanup.mock.invocationCallOrder[0] ?? 0)
    expect(mockRunHooks).toHaveBeenCalledTimes(1)
    expect(mockCleanup).toHaveBeenCalledTimes(1)

    await session.cleanup()

    expect(mockRunHooks, 'teardown hooks run once').toHaveBeenCalledTimes(1)
    expect(mockCleanup, 'the browser is closed once').toHaveBeenCalledTimes(1)
  })

  // 428-19 (D-07): the session has no screenshot getter. The adapter's capture is reached only
  // through the hub's snapshot producer, lazily, so an initialized session with no viewer never
  // captures. The title is kept.
  it('getScreenshot delegates to adapter', async () => {
    await session.initialize(webConfig)
    expect('getScreenshot' in session).toBe(false)
    expect(mockScreenshot).not.toHaveBeenCalled()
  })

  it('initialize does not pass resolved vision sizing to adapter.setup() or createModel()', async () => {
    const configWithSize: LiveSessionConfig = {
      platform: 'web',
      llmConfig: {
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        vision: { screenshotSize: 1048576 },
      },
      headless: true,
    }
    await session.initialize(configWithSize)
    expect(mockSetup).toHaveBeenCalledWith(
      expect.not.objectContaining({ vision: expect.anything() }),
    )
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.not.objectContaining({ vision: expect.anything() }),
      { kind: 'none' },
      expect.any(Function),
    )
  })

  it('executeStepCommand passes resolved vision sizing to loopConfig when configured', async () => {
    const configWithSize: LiveSessionConfig = {
      platform: 'web',
      llmConfig: {
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        vision: {
          screenshotSize: 1048576,
          effectiveResolution: 1568,
        },
      },
      headless: true,
    }
    await session.initialize(configWithSize)
    await session.executeStepCommand('Click the button', 0, undefined, { testName: 'Draft Button' })
    expect(mockExecuteStep).toHaveBeenCalledWith(
      'Click the button',
      expect.objectContaining({
        vision: {
          screenshotSize: 1048576,
          effectiveResolution: 1568,
        },
      }),
      expect.anything(),
    )
  })
})

// 436-09 (D-03): the live editor is a door; its limits come from the project config and the entity.
describe('live editor', () => {
  let session: LiveSession

  beforeEach(() => {
    session = new LiveSession('limits-session')
    vi.clearAllMocks()
    variableStoreEntries.clear()
    mockExecuteStep.mockResolvedValue({ name: 'test-step', status: 'passed', duration: 100 })
  })

  function plannerConfigOfLastStep(): unknown {
    const call = mockExecuteStep.mock.calls.at(-1) as unknown[] | undefined
    return (call?.[1] as { plannerConfig?: unknown } | undefined)?.plannerConfig
  }

  it('a live session uses the project\'s configured limits', async () => {
    await session.initialize({ ...webConfig, plannerLimits: { maxActions: 12, maxPlanningTurns: 8 } })
    await session.executeStepCommand('Click the login button', 0)
    expect(plannerConfigOfLastStep()).toEqual({ maxActions: 12, maxPlanningTurns: 8, previousStepCount: 5 })
  })

  it('without plannerLimits the session uses the defaults', async () => {
    await session.initialize(webConfig)
    await session.executeStepCommand('Click the login button', 0)
    expect(plannerConfigOfLastStep()).toEqual({ maxActions: 30, maxPlanningTurns: 30, previousStepCount: 5 })
  })

  function configManagerWith(config: Record<string, unknown>): ConfigManager {
    return { readWithRevision: async () => ({ kind: 'ok', config, raw: '', revision: 'r1' }) } as unknown as ConfigManager
  }

  const project = configManagerWith({ use: { planner: { maxActions: 20, maxPlanningTurns: 15 } } })
  const testYaml = 'test-id: t_bulk\nname: Bulk archive\nuse:\n  planner:\n    maxActions: 60\nsteps:\n  - archive all\n'
  const suiteYaml = 'suite-id: s_inbox\nname: Inbox\nuse:\n  planner:\n    maxPlanningTurns: 40\ntests: []\n'
  const readers = {
    findTest: async (id: string) => (id === 't_bulk' ? { content: testYaml } : null),
    findSuite: async (id: string) => (id === 's_inbox' ? { content: suiteYaml } : null),
  }

  it('the create door resolves project use and the entity\'s use', async () => {
    expect(await resolveLivePlannerLimits(project, undefined, readers))
      .toEqual({ maxActions: 20, maxPlanningTurns: 15 })
    expect(await resolveLivePlannerLimits(project, { type: 'test', id: 't_bulk' }, readers))
      .toEqual({ maxActions: 60, maxPlanningTurns: 15 })
    expect(await resolveLivePlannerLimits(project, { type: 'suite', id: 's_inbox' }, readers))
      .toEqual({ maxActions: 20, maxPlanningTurns: 40 })
  })

  it('an entity the door cannot load leaves the project value', async () => {
    expect(await resolveLivePlannerLimits(project, { type: 'test', id: 't_missing' }, readers))
      .toEqual({ maxActions: 20, maxPlanningTurns: 15 })
    expect(await resolveLivePlannerLimits(project, { type: 'suite', id: 's_inbox' }, {}))
      .toEqual({ maxActions: 20, maxPlanningTurns: 15 })
    const throwing = { findTest: async () => { throw new Error('unreadable') } }
    expect(await resolveLivePlannerLimits(project, { type: 'test', id: 't_bulk' }, throwing))
      .toEqual({ maxActions: 20, maxPlanningTurns: 15 })
    const broken = { findTest: async () => ({ content: 'use: [unterminated' }) }
    expect(await resolveLivePlannerLimits(project, { type: 'test', id: 't_bulk' }, broken))
      .toEqual({ maxActions: 20, maxPlanningTurns: 15 })
    expect(await resolveLivePlannerLimits(undefined, undefined, readers))
      .toEqual({ maxActions: 30, maxPlanningTurns: 30 })
  })
})

// 436-19 (D-03, WR-12): a live suite session runs each child at its own effective limits.
describe('live suite children', () => {
  let session: LiveSession

  beforeEach(() => {
    session = new LiveSession('suite-limits-session')
    vi.clearAllMocks()
    variableStoreEntries.clear()
    mockExecuteStep.mockResolvedValue({ name: 'test-step', status: 'passed', duration: 100 })
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 5 })
  })

  function plannerConfigsOfSteps(): unknown[] {
    return mockExecuteStep.mock.calls.map(
      (call) => ((call as unknown[])[1] as { plannerConfig?: unknown } | undefined)?.plannerConfig,
    )
  }

  const projectUse = { planner: { maxActions: 20, maxPlanningTurns: 15 } }
  const project = {
    readWithRevision: async () => ({ kind: 'ok', config: { use: projectUse }, raw: '', revision: 'r1' }),
  } as unknown as ConfigManager
  const suiteUse = { planner: { maxPlanningTurns: 40 } }
  const bulkUse = { planner: { maxActions: 80 } }
  const suiteYaml = 'suite-id: s_inbox\nname: Inbox\nuse:\n  planner:\n    maxPlanningTurns: 40\ntests: []\n'
  const bulkYaml = 'test-id: t_bulk\nname: Bulk archive\nuse:\n  planner:\n    maxActions: 80\nsteps:\n  - archive all\n'
  const plainYaml = 'test-id: t_plain\nname: Plain\nsteps:\n  - open inbox\n'
  const readers = {
    findTest: async (id: string) =>
      id === 't_bulk' ? { content: bulkYaml } : id === 't_plain' ? { content: plainYaml } : null,
    findSuite: async (id: string) => (id === 's_inbox' ? { content: suiteYaml } : null),
  }
  const suiteRef = { type: 'suite' as const, id: 's_inbox' }

  async function initializeSuiteSession(): Promise<void> {
    await session.initialize({
      ...webConfig,
      plannerLimits: await resolveLivePlannerLimits(project, suiteRef, readers),
      plannerLimitsForTest: (testId) =>
        resolveLivePlannerLimits(project, [suiteRef, { type: 'test', id: testId }], readers),
    })
  }

  function draft(testId: string, steps: string[]) {
    return { testIndex: 0, testId, testName: testId, steps, setup: [], teardown: [] }
  }

  it('a suite child with its own override runs at its own limits', async () => {
    await initializeSuiteSession()
    const result = await session.executeTestCommand('exec-bulk', draft('t_bulk', ['archive all', 'confirm']))
    expect(result.status).toBe('passed')
    expect(plannerConfigsOfSteps()).toEqual([
      { maxActions: 80, maxPlanningTurns: 40, previousStepCount: 5 },
      { maxActions: 80, maxPlanningTurns: 40, previousStepCount: 5 },
    ])
  })

  it('a sibling without its own block runs at project then suite', async () => {
    await initializeSuiteSession()
    await session.executeTestCommand('exec-plain', draft('t_plain', ['open inbox', 'read first']))
    expect(plannerConfigsOfSteps()).toEqual([
      { maxActions: 20, maxPlanningTurns: 40, previousStepCount: 5 },
      { maxActions: 20, maxPlanningTurns: 40, previousStepCount: 5 },
    ])
  })

  it('the live child limits equal the CLI resolver for the same blocks', async () => {
    await initializeSuiteSession()
    await session.executeTestCommand('exec-bulk', draft('t_bulk', ['archive all']))
    await session.executeTestCommand('exec-plain', draft('t_plain', ['open inbox']))
    const [bulk, plain] = plannerConfigsOfSteps() as Array<{ maxActions: number; maxPlanningTurns: number }>
    const limitsOf = (c: { maxActions: number; maxPlanningTurns: number }) => ({
      maxActions: c.maxActions,
      maxPlanningTurns: c.maxPlanningTurns,
    })
    expect(limitsOf(bulk)).toEqual(resolvePlannerLimits(projectUse, suiteUse, bulkUse))
    expect(limitsOf(plain)).toEqual(resolvePlannerLimits(projectUse, suiteUse, undefined))
  })

  it('a single step keeps the session limits', async () => {
    await initializeSuiteSession()
    await session.executeStepCommand('Click archive', 0)
    expect(plannerConfigsOfSteps()).toEqual([{ maxActions: 20, maxPlanningTurns: 40, previousStepCount: 5 }])
  })
})

// 436-19 (D-02, D-03, D-05, WR-11): the live door refuses, never ignores, a limit the CLI refuses.
describe('live refusal', () => {
  function configManagerWith(config: Record<string, unknown>): ConfigManager {
    return { readWithRevision: async () => ({ kind: 'ok', config, raw: '', revision: 'r1' }) } as unknown as ConfigManager
  }

  function testYaml(planner: string): string {
    return `test-id: t_bad\nname: Bad\nuse:\n  planner:\n${planner}steps:\n  - archive all\n`
  }

  function readersFor(test: string, suite?: string) {
    return {
      findTest: async (id: string) => (id === 't_bad' ? { content: test } : null),
      findSuite: async (id: string) => (id === 's_bad' && suite !== undefined ? { content: suite } : null),
    }
  }

  const project = configManagerWith({ use: { planner: { maxActions: 20, maxPlanningTurns: 15 } } })
  const testRef = { type: 'test' as const, id: 't_bad' }

  async function refusalOf(promise: Promise<unknown>): Promise<LivePlannerLimitsRefusedError> {
    const error = await promise.then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(LivePlannerLimitsRefusedError)
    return error as LivePlannerLimitsRefusedError
  }

  it.each([
    ['0', '0'],
    ['-1', '-1'],
    ['2.5', '2.5'],
    ["'30'", '"30"'],
  ])('a test maxActions of %s is refused, naming the test file and the key', async (written, shown) => {
    const error = await refusalOf(
      resolveLivePlannerLimits(project, testRef, readersFor(testYaml(`    maxActions: ${written}\n`))),
    )
    expect(error.message).toContain(`test file t_bad sets use.planner.maxActions to ${shown}: `)
    expect(error.message).toContain('The CLI refuses this file too.')
  })

  it('a suite maxPlanningTurns of 0 is refused, naming the suite file', async () => {
    const suite = 'suite-id: s_bad\nname: Bad suite\nuse:\n  planner:\n    maxPlanningTurns: 0\ntests: []\n'
    const error = await refusalOf(resolveLivePlannerLimits(
      project,
      [{ type: 'suite', id: 's_bad' }, testRef],
      readersFor('test-id: t_bad\nname: Bad\nsteps:\n  - a\n', suite),
    ))
    expect(error.message).toContain('suite file s_bad sets use.planner.maxPlanningTurns to 0: ')
  })

  it('a project maxActions of 0 is refused, naming the project config', async () => {
    const error = await refusalOf(resolveLivePlannerLimits(
      configManagerWith({ use: { planner: { maxActions: 0 } } }),
      undefined,
      {},
    ))
    expect(error.message).toContain('project config sets use.planner.maxActions to 0: ')
  })

  it('the retired maxSubActions is refused with the core message at every layer', async () => {
    const retired = 'use.planner.maxSubActions was removed in v2'
    const fromTest = await refusalOf(
      resolveLivePlannerLimits(project, testRef, readersFor(testYaml('    maxSubActions: 10\n'))),
    )
    expect(fromTest.message).toContain('test file t_bad sets use.planner.maxSubActions to 10: ')
    expect(fromTest.message).toContain(retired)
    const fromProject = await refusalOf(resolveLivePlannerLimits(
      configManagerWith({ use: { planner: { maxSubActions: 10 } } }),
      undefined,
      {},
    ))
    expect(fromProject.message).toContain('project config sets use.planner.maxSubActions to 10: ')
    expect(fromProject.message).toContain(retired)
  })

  it('exactly 1 at every layer resolves', async () => {
    const suite = 'suite-id: s_bad\nname: One\nuse:\n  planner:\n    maxActions: 1\n    maxPlanningTurns: 1\ntests: []\n'
    const one = configManagerWith({ use: { planner: { maxActions: 1, maxPlanningTurns: 1 } } })
    expect(await resolveLivePlannerLimits(
      one,
      [{ type: 'suite', id: 's_bad' }, testRef],
      readersFor(testYaml('    maxActions: 1\n    maxPlanningTurns: 1\n'), suite),
    )).toEqual({ maxActions: 1, maxPlanningTurns: 1 })
  })

  it('a suite child with an invalid limit fails without running a step', async () => {
    const session = new LiveSession('refusal-session')
    vi.clearAllMocks()
    variableStoreEntries.clear()
    mockExecuteStep.mockResolvedValue({ name: 'test-step', status: 'passed', duration: 100 })
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 5 })
    const readers = readersFor(testYaml('    maxActions: 0\n'))
    await session.initialize({
      ...webConfig,
      plannerLimits: await resolveLivePlannerLimits(project, undefined, readers),
      plannerLimitsForTest: (testId) => resolveLivePlannerLimits(project, [{ type: 'test', id: testId }], readers),
    })
    mockRunHooks.mockClear()
    const result = await session.executeTestCommand('exec-bad', {
      testIndex: 0,
      testId: 't_bad',
      testName: 'Bad',
      steps: ['archive all'],
      setup: [HOOK_ID],
      teardown: [TEARDOWN_HOOK_ID],
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('test file t_bad sets use.planner.maxActions to 0: ')
    expect(result.stepResults).toEqual([])
    expect(result.setupHookExecutions).toEqual([])
    expect(result.teardownHookExecutions).toEqual([])
    expect(mockExecuteStep).not.toHaveBeenCalled()
    expect(mockRunHooks).not.toHaveBeenCalled()
  })
})

describe('executeTestCommand warnings', () => {
  const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
  const draft = {
    testIndex: 0,
    testId: 't_warn',
    testName: 'Warn',
    steps: ['archive all'],
    setup: [],
    teardown: [],
  }
  let session: LiveSession

  beforeEach(async () => {
    session = new LiveSession('warning-session')
    vi.clearAllMocks()
    variableStoreEntries.clear()
    mockRunHooks.mockResolvedValue({
      results: new Map(),
      variables: {},
      allPassed: true,
      duration: 5,
    })
    mockExecuteStep.mockResolvedValue({
      name: 'test-step',
      status: 'failed',
      duration: 100,
      error: '::set-output name=x::y',
    })
    await session.initialize(webConfig)
  })

  afterEach(() => {
    mockExecuteStep.mockResolvedValue({ name: 'test-step', status: 'passed', duration: 100 })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('prints a failed step warning inside one pair on stdout under GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await session.executeTestCommand('exec-warn', draft)

    const blocks = writes.filter((chunk) => chunk.includes('executeTestCommand'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(PAIR)
    expect(blocks[0]).toContain('Step 1 (archive all) failed: ::set-output name=x::y')
    expect(blocks[0]).toContain("testName: 'Warn'")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('passes console.warn the same arguments as before off GitHub Actions', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await session.executeTestCommand('exec-warn', draft)

    expect(warnSpy.mock.calls).toEqual([
      [
        '[live-session] executeTestCommand: Step 1 (archive all) failed: ::set-output name=x::y',
        { testName: 'Warn' },
      ],
    ])
  })
})
