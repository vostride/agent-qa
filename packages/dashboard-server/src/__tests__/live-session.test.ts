import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LiveSessionConfig } from '../live-editor/types.js'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const TEARDOWN_HOOK_ID = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const INLINE_HOOK_TOKEN = `{{runHook:"${HOOK_ID}"}}`

const mockSetup = vi.fn().mockResolvedValue(undefined)
const mockCleanup = vi.fn().mockResolvedValue(undefined)
const mockExecute = vi.fn().mockResolvedValue({ success: true })
const mockScreenshot = vi.fn().mockResolvedValue(Buffer.from('fake-screenshot'))
const mockObserve = vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} })

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn().mockImplementation(function () {
    return {
      platform: 'web',
      setup: mockSetup,
      cleanup: mockCleanup,
      execute: mockExecute,
      screenshot: mockScreenshot,
      observe: mockObserve,
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

const mockCreateModel = vi.fn().mockResolvedValue({ modelId: 'test-model' })
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

vi.mock('@vostride/agent-qa-core', () => {
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
  const redactAuthStateValue = (value: any, context: { secretRedactor?: LocalSecretRedactor } = {}): any => {
    const secretRedacted = redactSecretValue(value, context.secretRedactor)
    if (typeof secretRedacted === 'string') {
      if (
        secretRedacted.includes('AGENT_QA_AUTH_STATE_JSON')
        || secretRedacted.includes('/workspace/.agent-qa-auth-state/storage-state.json')
        || (secretRedacted.includes('"cookies"') && secretRedacted.includes('"origins"'))
      ) {
        return '[auth state redacted]'
      }
      return secretRedacted.replace(/authState:\s*[^\s]+/g, 'authState: [auth state redacted]')
    }
    if (Buffer.isBuffer(secretRedacted)) return secretRedacted
    if (Array.isArray(secretRedacted)) return secretRedacted.map((item) => redactAuthStateValue(item, {}))
    if (secretRedacted && typeof secretRedacted === 'object') {
      if (Array.isArray((secretRedacted as any).cookies) && Array.isArray((secretRedacted as any).origins)) {
        return '[auth state redacted]'
      }
      return Object.fromEntries(Object.entries(secretRedacted).map(([key, item]) => {
        if (/^(authState|storageStatePath|AGENT_QA_AUTH_STATE_JSON|AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH)$/i.test(key)) {
          return [key, '[auth state redacted]']
        }
        if (/^(ACCESS_TOKEN|SESSION_TOKEN|AUTH_TOKEN|csrf)$/i.test(key)) {
          return [key, '[auth state redacted]']
        }
        return [key, redactAuthStateValue(item, {})]
      }))
    }
    return secretRedacted
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
    executeStep: (...args: unknown[]) => mockExecuteStep(...args),
    createModel: (...args: unknown[]) => mockCreateModel(...args),
    getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
    VariableStore: vi.fn().mockImplementation(function () { return mockVariableStoreInstance }),
    interpolateVariables: (...args: unknown[]) => mockInterpolateVariables(...args as Parameters<typeof mockInterpolateVariables>),
    findUnresolvedTemplates: (...args: unknown[]) => mockFindUnresolvedTemplates(...args as Parameters<typeof mockFindUnresolvedTemplates>),
    runHooks: (...args: unknown[]) => mockRunHooks(...args),
    runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
    parseHookInline: (text: string) => mockParseHookInline(text),
    stripHookInline: (text: string) => mockStripHookInline(text),
    SecretStore: LocalSecretStore,
    SecretRedactor: LocalSecretRedactor,
    redactSecretValue,
    redactAuthStateValue,
    resolveSecretTemplatesInValue,
  }
})

import { LiveSession } from '../live-editor/live-session.js'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-core'

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

  it('initialize navigates to URL when provided', async () => {
    await session.initialize({ ...webConfig, url: 'https://example.com' })
    expect(mockExecute).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com' })
  })

  it('initialize resolves secret placeholders only for adapter navigation', async () => {
    const secretStore = new SecretStore({ START_URL_TOKEN: 'runtime-url-token' })
    await session.initialize({
      ...webConfig,
      url: 'https://example.com/{{secret:START_URL_TOKEN}}',
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(mockExecute).toHaveBeenCalledWith({ type: 'navigate', url: 'https://example.com/runtime-url-token' })
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
        healingConfig: expect.objectContaining({ maxAttempts: 3 }),
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
    expect(result.error).toContain('[secret]')
  })

  it('executeStepCommand redacts auth-state shaped live payloads', async () => {
    const storageState = JSON.stringify({
      cookies: [{ name: 'sid', value: 'live-cookie-secret' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'live-local-secret' }] }],
    })
    mockExecuteStep.mockResolvedValue({
      name: 'Auth step',
      status: 'failed',
      duration: 7,
      error: storageState,
      trace: {
        observation: storageState,
        reasoning: 'use authState: demo-acc',
        plannedAction: { type: 'waitFor', condition: storageState },
        result: 'failure',
        error: '/workspace/.agent-qa-auth-state/storage-state.json',
        screenStateBefore: storageState,
      },
      variableSnapshot: { SESSION_TOKEN: { value: 'live-session-token', source: 'hook' } },
    })

    await session.initialize(webConfig)
    const result = await session.executeStepCommand('Verify authenticated dashboard', 0)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain('[auth state redacted]')
    expect(serialized).not.toContain('live-cookie-secret')
    expect(serialized).not.toContain('live-local-secret')
    expect(serialized).not.toContain('demo-acc')
    expect(serialized).not.toContain('/workspace/.agent-qa-auth-state/storage-state.json')
    expect(serialized).not.toContain('live-session-token')
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
      expect.objectContaining({ envVars: {} }),
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
      { envVars: {} },
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
      { envVars: {} },
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
      { envVars: { AUTH_TOKEN: 'hook-token' } },
    )
  })

  it('getScreenshot delegates to adapter', async () => {
    await session.initialize(webConfig)
    const screenshot = await session.getScreenshot()
    expect(mockScreenshot).toHaveBeenCalled()
    expect(screenshot).toBeInstanceOf(Buffer)
  })

  it('initialize does not pass screenshotSize to adapter.setup()', async () => {
    const configWithSize: LiveSessionConfig = {
      platform: 'web',
      llmConfig: {
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        screenshotSize: 1048576,
      },
      headless: true,
    }
    await session.initialize(configWithSize)
    expect(mockSetup).toHaveBeenCalledWith(
      expect.not.objectContaining({ screenshotSize: expect.anything() }),
    )
  })

  it('executeStepCommand passes screenshotSize to loopConfig when configured', async () => {
    const configWithSize: LiveSessionConfig = {
      platform: 'web',
      llmConfig: {
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        screenshotSize: 1048576,
        effectiveResolution: 1568,
      },
      headless: true,
    }
    await session.initialize(configWithSize)
    await session.executeStepCommand('Click the button', 0, undefined, { testName: 'Draft Button' })
    expect(mockExecuteStep).toHaveBeenCalledWith(
      'Click the button',
      expect.objectContaining({
        screenshotSize: 1048576,
        effectiveResolution: 1568,
      }),
      expect.anything(),
    )
  })
})
