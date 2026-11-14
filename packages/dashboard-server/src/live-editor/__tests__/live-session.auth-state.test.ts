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
  mockStorageState,
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
  mockStorageState: vi.fn(),
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
import type { RuntimeAuthStateConfig } from '@vostride/agent-qa-runner'
import { ConfigManager } from '../../config/index.js'
import { LiveSession } from '../live-session.js'
import type { LiveSessionConfig, ServerMessage } from '../types.js'

const SECRET_COOKIE_VALUE = 'secret-cookie-fixture'
const SECRET_LOCAL_STORAGE_VALUE = 'secret-local-storage-fixture'
const SECRET_INDEXED_DB_VALUE = 'secret-indexed-db-fixture'

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
  return message
}

describe('LiveSession.captureWebAuthState', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager

  beforeEach(async () => {
    vi.clearAllMocks()
    mockRunHooks.mockResolvedValue({ results: new Map(), variables: {}, allPassed: true, duration: 0 })
    mockStorageState.mockResolvedValue(STORAGE_STATE)
    mockGetPage.mockReturnValue({
      context: () => ({ storageState: mockStorageState }),
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
    mockStorageState.mockClear()
    return session
  }

  it('captures the active web context with IndexedDB and returns metadata only', async () => {
    const session = await initializeWebSession()
    const capture = getCaptureWebAuthState(session)

    const metadata = await capture('admin')

    expect(mockStorageState).toHaveBeenCalledTimes(1)
    expect(mockStorageState).toHaveBeenCalledWith({ indexedDB: true })
    const storageStateCall = mockStorageState.mock.calls[0]
    expect(storageStateCall).toEqual([{ indexedDB: true }])
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
    mockStorageState.mockClear()

    const message = await expectPathFreeRejection(capture('admin'))
    expect(message).toMatch(/replace=true|already exists/i)
    expect(mockStorageState).not.toHaveBeenCalled()

    await expect(capture('admin', { replace: true })).resolves.toMatchObject({
      version: AUTH_STATE_SCHEMA_VERSION,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
    })
    expect(mockStorageState).toHaveBeenCalledWith({ indexedDB: true })
  })

  it('fails safely before reading storage state while a session command is executing', async () => {
    const session = await initializeWebSession()
    ;(session as unknown as { executing: boolean }).executing = true
    const capture = getCaptureWebAuthState(session)

    const message = await expectPathFreeRejection(capture('admin'))

    expect(message).toMatch(/executing|busy/i)
    expect(mockStorageState).not.toHaveBeenCalled()
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
    expect(mockStorageState).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('fails safely when the Live Mode session has no target name', async () => {
    const session = await initializeWebSession('')
    const capture = getCaptureWebAuthState(session)

    const message = await expectPathFreeRejection(capture('admin'))

    expect(message).toMatch(/target/i)
    expect(mockStorageState).not.toHaveBeenCalled()
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

interface PlaywrightBinary {
  chromium: { executablePath(): string }
}

// Playwright comes from the web adapter's own install, the same build the session drives.
const playwright = createRequire(createRequire(import.meta.url).resolve('@vostride/agent-qa-web'))(
  'playwright-core',
) as PlaywrightBinary

const BROWSER_COOKIE_VALUE = 'made-up-session-cookie-for-the-browser'

describe('a live session in a real browser opens its start url with the mounted state', () => {
  let tempDir: string
  let configPath: string
  let configManager: ConfigManager
  let server: Server
  let startUrl: string
  let cookieHeaders: Array<string | undefined>
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
    server = createServer((req, res) => {
      if (req.url === '/start') cookieHeaders.push(req.headers.cookie)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>shop</title><p>shop</p>')
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
    const session = new LiveSession('auth-browser-session', { configManager, configPath })
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

  it('sends no cookie when the session names no state', async () => {
    await start({})

    expect(cookieHeaders).toEqual([undefined])
  })
})
