import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCleanup,
  mockCreateModel,
  mockDrainConsole,
  mockDrainNetwork,
  mockExecute,
  mockExecuteStep,
  mockGetPage,
  mockGetProviderOptions,
  mockObserve,
  mockRunHooks,
  mockRunHookInSandbox,
  mockScreenshot,
  mockSetup,
  mockCaptureAuthState,
  mockVariableStoreInstance,
  real,
} = vi.hoisted(() => ({
  mockCleanup: vi.fn().mockResolvedValue(undefined),
  mockCreateModel: vi.fn().mockReturnValue({ modelId: 'test-model' }),
  mockDrainConsole: vi.fn(() => []),
  mockDrainNetwork: vi.fn(() => []),
  mockExecute: vi.fn().mockResolvedValue({ success: true }),
  mockExecuteStep: vi.fn(),
  mockGetPage: vi.fn(),
  mockGetProviderOptions: vi.fn().mockReturnValue(undefined),
  mockObserve: vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} }),
  mockRunHooks: vi.fn().mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 }),
  mockRunHookInSandbox: vi.fn(),
  mockScreenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
  mockSetup: vi.fn().mockResolvedValue(undefined),
  mockCaptureAuthState: vi.fn(),
  real: { adapter: false },
  mockVariableStoreInstance: {
    set: vi.fn(),
    setAll: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue(new Map()),
    snapshot: vi.fn().mockReturnValue({}),
  },
}))

vi.mock('@vostride/agent-qa-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-web')>()
  return {
    ...actual,
    WebPlatformAdapter: vi.fn().mockImplementation(function (options: unknown) {
      if (real.adapter) {
        return new actual.WebPlatformAdapter(
          options as ConstructorParameters<typeof actual.WebPlatformAdapter>[0],
        )
      }
      return {
        platform: 'web',
        setup: mockSetup,
        cleanup: mockCleanup,
        execute: mockExecute,
        screenshot: mockScreenshot,
        observe: mockObserve,
        drainConsoleLogs: mockDrainConsole,
        drainNetworkLogs: mockDrainNetwork,
        getPage: mockGetPage,
        captureAuthState: mockCaptureAuthState,
      }
    }),
  }
})

vi.mock('@vostride/agent-qa-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner')>()),
  runHooks: (...args: unknown[]) => mockRunHooks(...args),
  VariableStore: vi.fn().mockImplementation(function () { return mockVariableStoreInstance }),
  interpolateVariables: vi.fn((instruction: string) => instruction),
  findUnresolvedTemplates: vi.fn(() => []),
  parseHookInline: vi.fn(() => []),
  stripHookInline: vi.fn((text: string) => text),
}))
vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()),
  DockerHookExecutor: class { execute(...args: unknown[]) { return mockRunHookInSandbox(...args) } },
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    executeStep: (...args: unknown[]) => mockExecuteStep(...args),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
    redactSecretValue: vi.fn((value: unknown) => value),
    parseHookInline: vi.fn(() => []),
    stripHookInline: vi.fn((text: string) => text),
    runHooks: (...args: unknown[]) => mockRunHooks(...args),
    runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
    resolveSecretTemplatesInValue: vi.fn((value: unknown) => value),
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

import {
  AUTH_STATE_SCHEMA_VERSION,
  resolveAuthStatePaths,
  writeAuthStateFiles,
  type AuthStateMetadata,
} from '@vostride/agent-qa-core'
import { parseHookInline, type RuntimeAuthStateConfig } from '@vostride/agent-qa-runner'
import { ConfigManager } from '../../config/index.js'
import { LiveSession } from '../live-session.js'
import type { LiveSessionConfig, ServerMessage } from '../types.js'

const SECRET_COOKIE_VALUE = 'secret-cookie-fixture'
const SECRET_LOCAL_STORAGE_VALUE = 'secret-local-storage-fixture'
const SECRET_INDEXED_DB_VALUE = 'secret-indexed-db-fixture'
const SECRET_SESSION_STORAGE_VALUE = 'secret-session-storage-fixture'

const STORAGE_STATE = {
  cookies: [
    {
      name: 'sid',
      value: SECRET_COOKIE_VALUE,
      domain: 'staging.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [
    {
      origin: 'https://staging.example.com',
      localStorage: [{ name: 'token', value: SECRET_LOCAL_STORAGE_VALUE }],
      indexedDB: [{ name: 'auth-db', value: SECRET_INDEXED_DB_VALUE }],
      sessionStorage: [{ name: 'made-up:user', value: SECRET_SESSION_STORAGE_VALUE }],
    },
  ],
}

const webConfig: LiveSessionConfig = {
  platform: 'web',
  llmConfig: {
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-4-20250514',
    baseURL: 'https://anthropic-proxy.example/messages',
  },
  headless: true,
  url: 'https://staging.example.com',
}

type CaptureWebAuthState = (
  name: string,
  options?: { replace?: boolean },
) => Promise<AuthStateMetadata>

function getCaptureWebAuthState(session: LiveSession): CaptureWebAuthState {
  const candidate = (session as unknown as { captureWebAuthState?: CaptureWebAuthState }).captureWebAuthState
  if (typeof candidate !== 'function') {
    throw new Error('captureWebAuthState is not implemented')
  }
  return candidate.bind(session)
}

async function expectPathFreeRejection(promise: Promise<unknown>): Promise<string> {
  let rejection: unknown
  try {
    await promise
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeInstanceOf(Error)
  const message = rejection instanceof Error ? rejection.message : String(rejection)
  expect(message).not.toContain('.agent-qa/auth-states')
  expect(message).not.toContain('.json')
  expect(message).not.toContain('payloadPath')
  expect(message).not.toContain('metadataPath')
  expect(message).not.toContain(SECRET_COOKIE_VALUE)
  expect(message).not.toContain(SECRET_LOCAL_STORAGE_VALUE)
  expect(message).not.toContain(SECRET_INDEXED_DB_VALUE)
  expect(message).not.toContain(SECRET_SESSION_STORAGE_VALUE)
  return message
}

describe('LiveSession.captureWebAuthState', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager

  beforeEach(async () => {
    vi.clearAllMocks()
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 })
    mockCaptureAuthState.mockResolvedValue(STORAGE_STATE)
    mockGetPage.mockReturnValue({
      evaluate: vi.fn(),
      url: () => 'https://staging.example.com/dashboard',
    })
    mockVariableStoreInstance.getAll.mockReturnValue(new Map())
    mockVariableStoreInstance.snapshot.mockReturnValue({})

    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-live-auth-state-'))
    configPath = join(tempDir, 'agent-qa.config.yaml')
    configManager = new ConfigManager(configPath, (text) => text)
    await writeFile(configPath, [
      'services:',
      '  authState:',
      '    dir: .agent-qa/auth-states',
      'registry:',
      '  targets:',
      '    staging-web:',
      '      platform: web',
      '      url: https://staging.example.com',
      '    android-app:',
      '      platform: android',
      '      appPackage: com.example.app',
      '      appActivity: .MainActivity',
      '',
    ].join('\n'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function initializeWebSession(targetName: string | undefined = 'staging-web'): Promise<LiveSession> {
    const session = new LiveSession('auth-state-session', { configManager, configPath })
    await session.initialize({
      ...webConfig,
      targetName,
    })
    mockExecute.mockClear()
    mockCleanup.mockClear()
    mockCaptureAuthState.mockClear()
    return session
  }

  it("writes what the web adapter's capture returns and returns metadata only", async () => {
    const session = await initializeWebSession()
    const capture = getCaptureWebAuthState(session)

    const metadata = await capture('admin')

    expect(mockCaptureAuthState).toHaveBeenCalledTimes(1)
    expect(mockExecute).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(metadata).toMatchObject({
      version: AUTH_STATE_SCHEMA_VERSION,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
    })
    expect(new Date(metadata.capturedAt).toISOString()).toBe(metadata.capturedAt)

    const serializedMetadata = JSON.stringify(metadata)
    expect(serializedMetadata).not.toContain('.agent-qa/auth-states')
    expect(serializedMetadata).not.toContain('.json')
    expect(serializedMetadata).not.toContain('payloadPath')
    expect(serializedMetadata).not.toContain('metadataPath')
    expect(serializedMetadata).not.toContain(SECRET_COOKIE_VALUE)
    expect(serializedMetadata).not.toContain(SECRET_LOCAL_STORAGE_VALUE)
    expect(serializedMetadata).not.toContain(SECRET_INDEXED_DB_VALUE)
    expect(serializedMetadata).not.toContain(SECRET_SESSION_STORAGE_VALUE)
    expect(JSON.stringify(session.getState())).not.toContain(SECRET_SESSION_STORAGE_VALUE)

    const paths = resolveAuthStatePaths({
      configDir: tempDir,
      authStateDir: '.agent-qa/auth-states',
      targetName: 'staging-web',
      stateName: 'admin',
      platform: 'web',
    })
    await expect(readFile(paths.payloadPath, 'utf-8').then(JSON.parse)).resolves.toEqual(STORAGE_STATE)
    await expect(readFile(paths.metadataPath, 'utf-8').then(JSON.parse)).resolves.toEqual(metadata)
  })

  it('requires replace=true before overwriting an existing auth state', async () => {
    const session = await initializeWebSession()
    const capture = getCaptureWebAuthState(session)

    await capture('admin')
    mockCaptureAuthState.mockClear()

    const message = await expectPathFreeRejection(capture('admin'))
    expect(message).toMatch(/replace=true|already exists/i)
    expect(mockCaptureAuthState).not.toHaveBeenCalled()

    await expect(capture('admin', { replace: true })).resolves.toMatchObject({
      version: AUTH_STATE_SCHEMA_VERSION,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
    })
    expect(mockCaptureAuthState).toHaveBeenCalledTimes(1)
  })

  it('fails safely before reading storage state while a session command is executing', async () => {
    const session = await initializeWebSession()
    ;(session as unknown as { executing: boolean }).executing = true
    const capture = getCaptureWebAuthState(session)

    const message = await expectPathFreeRejection(capture('admin'))

    expect(message).toMatch(/executing|busy/i)
    expect(mockCaptureAuthState).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('hard-fails mobile sessions before reading storage state', async () => {
    const session = new LiveSession('mobile-auth-state-session', { configManager, configPath })
    Object.assign(session as unknown as Record<string, unknown>, {
      platform: 'android',
      readyForInteraction: true,
      targetName: 'android-app',
      adapter: {
        platform: 'android',
        getPage: mockGetPage,
        cleanup: mockCleanup,
      },
    })
    const capture = getCaptureWebAuthState(session)

    const message = await expectPathFreeRejection(capture('admin'))

    expect(message).toMatch(/web/i)
    expect(mockCaptureAuthState).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fails safely when the Live Mode session has no target name', async () => {
    const session = await initializeWebSession('')
    const capture = getCaptureWebAuthState(session)

    const message = await expectPathFreeRejection(capture('admin'))

    expect(message).toMatch(/target/i)
    expect(mockCaptureAuthState).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })
})

const MOUNT_CAPTURED_AT = '2026-11-14T08:00:00.000Z'

function resolvedFixture(storageStatePath: string): RuntimeAuthStateConfig {
  return {
    version: AUTH_STATE_SCHEMA_VERSION,
    kind: 'web',
    targetName: 'staging-web',
    stateName: 'buyer',
    capturedAt: MOUNT_CAPTURED_AT,
    storageStatePath,
  }
}

describe('a live session mounts the auth state its config names', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager
  let payloadPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    real.adapter = false
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 })
    mockVariableStoreInstance.getAll.mockReturnValue(new Map())
    mockVariableStoreInstance.snapshot.mockReturnValue({})
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-live-auth-mount-'))
    configPath = join(tempDir, 'agent-qa.config.yaml')
    configManager = new ConfigManager(configPath, (text) => text)
    await writeFile(configPath, [
      'registry:',
      '  targets:',
      '    staging-web:',
      '      platform: web',
      '      url: https://staging.example.com',
      '',
    ].join('\n'))
    payloadPath = join(tempDir, 'buyer.json')
    await writeFile(payloadPath, JSON.stringify(STORAGE_STATE))
  })

  afterEach(async () => {
    real.adapter = false
    await rm(tempDir, { recursive: true, force: true })
  })

  async function start(
    config: Partial<LiveSessionConfig>,
    messages: ServerMessage[] = [],
  ): Promise<LiveSession> {
    const session = new LiveSession('auth-mount-session', { configManager, configPath })
    session.attachMessageSink((message) => messages.push(message))
    await session.initialize({ ...webConfig, targetName: 'staging-web', ...config })
    return session
  }

  it('hands the resolved state to the adapter before the first navigation', async () => {
    const order: string[] = []
    mockSetup.mockImplementationOnce(async () => { order.push('setup') })
    mockExecute.mockImplementationOnce(async () => {
      order.push('navigate')
      return { success: true }
    })
    const resolved = resolvedFixture(payloadPath)

    await start({ authState: { name: 'buyer', load: true, resolved } })

    expect(mockSetup).toHaveBeenCalledTimes(1)
    expect(mockSetup.mock.calls[0]?.[0]).toMatchObject({ authState: resolved })
    expect(order).toEqual(['setup', 'navigate'])
  })

  it.each([
    ['no auth state', undefined],
    ['a state that was never captured', { name: 'buyer', load: true }],
    ['load false', { name: 'buyer', load: false }],
  ])('calls the adapter with no auth state for %s', async (_label, authState) => {
    await start(authState === undefined ? {} : { authState })

    expect(mockSetup).toHaveBeenCalledTimes(1)
    expect('authState' in (mockSetup.mock.calls[0]?.[0] as Record<string, unknown>)).toBe(false)
  })

  it('reports the name and capture time of a mounted state, and nothing of its payload', async () => {
    const messages: ServerMessage[] = []
    const session = await start(
      { authState: { name: 'buyer', load: true, resolved: resolvedFixture(payloadPath) } },
      messages,
    )

    const state = session.getState()
    expect(state.authState).toEqual({ name: 'buyer', capturedAt: MOUNT_CAPTURED_AT })
    const serialised = JSON.stringify({ state, messages })
    for (const leaked of [SECRET_COOKIE_VALUE, SECRET_LOCAL_STORAGE_VALUE, SECRET_INDEXED_DB_VALUE, payloadPath]) {
      expect(serialised).not.toContain(leaked)
    }
  })

  it('reports a named state with no capture time when it started signed out', async () => {
    const session = await start({ authState: { name: 'buyer', load: true } })

    expect(session.getState().authState).toEqual({ name: 'buyer', capturedAt: null })
  })

  it.each([
    ['load false', { authState: { name: 'buyer', load: false } }],
    ['no auth state', {}],
  ])('reports no auth state for %s', async (_label, config) => {
    const session = await start(config)

    expect(session.getState().authState).toBeNull()
  })

  it('reports no auth state for an android session', () => {
    const session = new LiveSession('android-auth-session', { configManager, configPath })
    Object.assign(session as unknown as Record<string, unknown>, { platform: 'android' })

    expect(session.getState().authState).toBeNull()
  })
})

const hookDef = (id: string) => ({
  id,
  name: id,
  runtime: 'node' as const,
  file: `/tmp/${id}.js`,
  deps: [],
  timeout: 30_000,
  network: false,
})

function passingHooks(hooks: Array<{ name: string }>) {
  return {
    results: new Map(hooks.map((hook) => [hook.name, {
      success: true,
      variables: {},
      output: '',
      stdout: '',
      stderr: '',
      duration: 1,
    }])),
    variables: {},
    allPassed: true,
    duration: 1,
  }
}

describe('a live session gives its hooks the auth state a run gives them', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager
  let payloadPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    real.adapter = false
    mockRunHooks.mockImplementation(async (hooks: Array<{ name: string }>) => passingHooks(hooks))
    mockRunHookInSandbox.mockResolvedValue({
      success: false,
      variables: {},
      output: '',
      stdout: '',
      stderr: 'stopped here',
      duration: 1,
    })
    mockVariableStoreInstance.getAll.mockReturnValue(new Map())
    mockVariableStoreInstance.snapshot.mockReturnValue({})
    mockCaptureAuthState.mockResolvedValue(STORAGE_STATE)
    mockGetPage.mockReturnValue({
      evaluate: vi.fn(),
      url: () => 'https://staging.example.com/dashboard',
    })
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-live-auth-hooks-'))
    configPath = join(tempDir, 'agent-qa.config.yaml')
    configManager = new ConfigManager(configPath, (text) => text)
    await writeFile(configPath, [
      'registry:',
      '  targets:',
      '    staging-web:',
      '      platform: web',
      '      url: https://staging.example.com',
      '',
    ].join('\n'))
    payloadPath = join(tempDir, 'buyer.json')
    await writeFile(payloadPath, JSON.stringify(STORAGE_STATE))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function start(
    authState: LiveSessionConfig['authState'],
    messages: ServerMessage[] = [],
  ): Promise<LiveSession> {
    const session = new LiveSession('auth-hooks-session', { configManager, configPath })
    session.attachMessageSink((message) => messages.push(message))
    await session.initialize({
      ...webConfig,
      targetName: 'staging-web',
      setupHooks: ['h-setup'],
      teardownHooks: ['h-teardown'],
      resolvedHooks: new Map([
        ['h-setup', hookDef('h-setup')],
        ['h-teardown', hookDef('h-teardown')],
        ['h-inline', hookDef('h-inline')],
      ]),
      ...(authState === undefined ? {} : { authState }),
    })
    return session
  }

  function hookOptions(callIndex: number): Record<string, unknown> {
    return mockRunHooks.mock.calls[callIndex]?.[1] as Record<string, unknown>
  }

  async function runInlineHook(session: LiveSession): Promise<Record<string, unknown>> {
    vi.mocked(parseHookInline).mockReturnValueOnce([{ hookId: 'h-inline' }] as never)
    await session.executeStepCommand('{{hook:h-inline}} open the cart')
    return mockRunHookInSandbox.mock.calls[0]?.[1] as Record<string, unknown>
  }

  it('gives setup, teardown and inline hooks the resolved state, setup before the adapter', async () => {
    const order: string[] = []
    mockRunHooks.mockImplementationOnce(async (hooks: Array<{ name: string }>) => {
      order.push('setup-hook')
      return passingHooks(hooks)
    })
    mockSetup.mockImplementationOnce(async () => { order.push('adapter') })
    const resolved = resolvedFixture(payloadPath)
    const session = await start({ name: 'buyer', load: true, resolved })

    expect(order).toEqual(['setup-hook', 'adapter'])
    expect(hookOptions(0).authState).toEqual(resolved)

    await session.executeHookCommand('teardown', 'h-teardown')
    expect(hookOptions(1).authState).toEqual(resolved)

    expect((await runInlineHook(session)).authState).toEqual(resolved)
  })

  it('gives the hooks no state when none was resolved', async () => {
    const session = await start({ name: 'buyer', load: true })

    expect(hookOptions(0).authState).toBeUndefined()
    await session.executeHookCommand('teardown', 'h-teardown')
    expect(hookOptions(1).authState).toBeUndefined()
    expect((await runInlineHook(session)).authState).toBeUndefined()
  })

  it('makes a capture of the named state the session state, says so once, and gives it to later hooks', async () => {
    const messages: ServerMessage[] = []
    const session = await start({ name: 'buyer', load: true }, messages)
    messages.length = 0

    const metadata = await session.captureWebAuthState('buyer')

    expect(session.getState().authState).toEqual({ name: 'buyer', capturedAt: metadata.capturedAt })
    const stateMessages = messages.filter((message) => message.type === 'session-state')
    expect(stateMessages).toHaveLength(1)
    expect(stateMessages[0]).toMatchObject({ state: { authState: { name: 'buyer', capturedAt: metadata.capturedAt } } })
    for (const leaked of [SECRET_COOKIE_VALUE, SECRET_LOCAL_STORAGE_VALUE, SECRET_SESSION_STORAGE_VALUE, '.json']) {
      expect(JSON.stringify(messages)).not.toContain(leaked)
    }

    await session.executeHookCommand('teardown', 'h-teardown')
    const written = resolveAuthStatePaths({
      configDir: tempDir,
      targetName: 'staging-web',
      stateName: 'buyer',
      target: { platform: 'web' },
    })
    expect(hookOptions(1).authState).toMatchObject({
      stateName: 'buyer',
      targetName: 'staging-web',
      capturedAt: metadata.capturedAt,
      storageStatePath: written.payloadPath,
    })
  })

  it('leaves the session state alone when another name is captured', async () => {
    const messages: ServerMessage[] = []
    const session = await start({ name: 'buyer', load: true }, messages)
    messages.length = 0

    await session.captureWebAuthState('someone-else')

    expect(session.getState().authState).toEqual({ name: 'buyer', capturedAt: null })
    expect(messages.filter((message) => message.type === 'session-state')).toHaveLength(0)
  })

  it('a session that names no state is unchanged by a capture', async () => {
    const messages: ServerMessage[] = []
    const session = await start(undefined, messages)
    messages.length = 0

    await session.captureWebAuthState('buyer')

    expect(session.getState().authState).toBeNull()
    expect(messages.filter((message) => message.type === 'session-state')).toHaveLength(0)
  })

  it('a load false session that captures its named state reports it from then on', async () => {
    const session = await start({ name: 'buyer', load: false })
    expect(session.getState().authState).toBeNull()

    const metadata = await session.captureWebAuthState('buyer')

    expect(session.getState().authState).toEqual({ name: 'buyer', capturedAt: metadata.capturedAt })
  })
})

interface PlaywrightBinary {
  chromium: { executablePath(): string }
}

// Playwright comes from the web adapter's own install, the same build the session drives.
const playwright = createRequire(createRequire(import.meta.url).resolve('@vostride/agent-qa-web'))(
  'playwright-core',
) as PlaywrightBinary

const BROWSER_COOKIE_VALUE = 'made-up-session-cookie-for-the-browser'
const BROWSER_SESSION_STORAGE_VALUE = 'made-up-session-storage-for-the-browser'

// The page tells the server only whether the item was there when its first script ran.
const START_PAGE = `<!doctype html><title>shop</title><script>
fetch('/seen?item=' + (sessionStorage.getItem('made-up:user') === null ? 'no' : 'yes'))
</script><p>shop</p>`

describe('a live session in a real browser opens its start url with the mounted state', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager
  let server: Server
  let startUrl: string
  let cookieHeaders: Array<string | undefined>
  let seen: string[]
  const sessions: LiveSession[] = []

  beforeEach(async () => {
    if (!existsSync(playwright.chromium.executablePath())) {
      throw new Error('Playwright Chromium missing; never skip')
    }
    vi.clearAllMocks()
    real.adapter = true
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 })
    mockVariableStoreInstance.getAll.mockReturnValue(new Map())
    mockVariableStoreInstance.snapshot.mockReturnValue({})
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-live-auth-browser-'))
    configPath = join(tempDir, 'agent-qa.config.yaml')
    configManager = new ConfigManager(configPath, (text) => text)
    await writeFile(configPath, [
      'registry:',
      '  targets:',
      '    staging-web:',
      '      platform: web',
      '      url: http://127.0.0.1/',
      '',
    ].join('\n'))
    cookieHeaders = []
    seen = []
    server = createServer((req, res) => {
      if (req.url === '/start') cookieHeaders.push(req.headers.cookie)
      if (req.url?.startsWith('/seen?item=')) seen.push(req.url.slice('/seen?item='.length))
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(START_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    startUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/start`
  })

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.cleanup()
    real.adapter = false
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(tempDir, { recursive: true, force: true })
  })

  async function saveBrowserState(): Promise<RuntimeAuthStateConfig> {
    const paths = resolveAuthStatePaths({
      configDir: tempDir,
      targetName: 'staging-web',
      stateName: 'buyer',
      target: { platform: 'web' },
    })
    await writeAuthStateFiles(paths, {
      payload: {
        cookies: [{
          name: 'sid',
          value: BROWSER_COOKIE_VALUE,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        }],
        origins: [],
      },
      metadata: {
        version: AUTH_STATE_SCHEMA_VERSION,
        kind: 'web',
        target: 'staging-web',
        name: 'buyer',
        capturedAt: MOUNT_CAPTURED_AT,
      },
    })
    return { ...resolvedFixture(paths.payloadPath) }
  }

  async function start(config: Partial<LiveSessionConfig>): Promise<LiveSession> {
    const session = new LiveSession(`auth-browser-session-${sessions.length}`, { configManager, configPath })
    sessions.push(session)
    await session.initialize({ ...webConfig, targetName: 'staging-web', url: startUrl, ...config })
    return session
  }

  it('sends the saved cookie with the first request, and a capture holds the same cookies', async () => {
    const resolved = await saveBrowserState()
    const session = await start({ authState: { name: 'buyer', load: true, resolved } })

    expect(cookieHeaders).toEqual([`sid=${BROWSER_COOKIE_VALUE}`])

    await session.captureWebAuthState('buyer-again')
    const again = resolveAuthStatePaths({
      configDir: tempDir,
      targetName: 'staging-web',
      stateName: 'buyer-again',
      target: { platform: 'web' },
    })
    const captured = JSON.parse(await readFile(again.payloadPath, 'utf-8')) as {
      cookies: Array<{ name: string; domain: string }>
    }
    expect(captured.cookies.map(({ name, domain }) => ({ name, domain }))).toEqual([
      { name: 'sid', domain: '127.0.0.1' },
    ])
  })

  it("captures the open tab's sessionStorage, and a session that mounts it has the item at document start", async () => {
    const first = await start({})
    await vi.waitFor(() => expect(seen).toEqual(['no']))
    const page = (first as unknown as { adapter: { getPage(): { evaluate<A>(fn: (arg: A) => void, arg: A): Promise<void> } } })
      .adapter.getPage()
    await page.evaluate((value) => sessionStorage.setItem('made-up:user', value), BROWSER_SESSION_STORAGE_VALUE)

    const metadata = await first.captureWebAuthState('buyer-tab')
    expect(JSON.stringify(metadata)).not.toContain(BROWSER_SESSION_STORAGE_VALUE)
    const paths = resolveAuthStatePaths({
      configDir: tempDir,
      targetName: 'staging-web',
      stateName: 'buyer-tab',
      target: { platform: 'web' },
    })
    const captured = JSON.parse(await readFile(paths.payloadPath, 'utf-8')) as {
      origins: Array<{ origin: string; sessionStorage?: Array<{ name: string }> }>
    }
    const origin = new URL(startUrl).origin
    expect(captured.origins.find((entry) => entry.origin === origin)?.sessionStorage?.map(({ name }) => name)).toEqual([
      'made-up:user',
    ])

    seen = []
    const resolved = { ...resolvedFixture(paths.payloadPath), stateName: 'buyer-tab' }
    await start({ authState: { name: 'buyer-tab', load: true, resolved } })
    await vi.waitFor(() => expect(seen).toEqual(['yes']))
  })

  it('sends no cookie when the session names no state', async () => {
    await start({})

    expect(cookieHeaders).toEqual([undefined])
  })
})
