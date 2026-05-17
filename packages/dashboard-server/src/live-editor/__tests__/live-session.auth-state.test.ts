import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  mockStorageState,
  mockVariableStoreInstance,
} = vi.hoisted(() => ({
  mockCleanup: vi.fn().mockResolvedValue(undefined),
  mockCreateModel: vi.fn().mockResolvedValue({ modelId: 'test-model' }),
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
  mockStorageState: vi.fn(),
  mockVariableStoreInstance: {
    set: vi.fn(),
    setAll: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue(new Map()),
    snapshot: vi.fn().mockReturnValue({}),
  },
}))

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn().mockImplementation(function () {
    return {
      platform: 'web',
      setup: vi.fn().mockResolvedValue(undefined),
      cleanup: mockCleanup,
      execute: mockExecute,
      screenshot: mockScreenshot,
      observe: mockObserve,
      drainConsoleLogs: mockDrainConsole,
      drainNetworkLogs: mockDrainNetwork,
      getPage: mockGetPage,
    }
  }),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    executeStep: (...args: unknown[]) => mockExecuteStep(...args),
    createModel: (...args: unknown[]) => mockCreateModel(...args),
    getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
    LLMPlanner: vi.fn().mockImplementation(function () { return { plan: vi.fn() } }),
    LLMVerifier: vi.fn().mockImplementation(function () { return { verify: vi.fn() } }),
    VariableStore: vi.fn().mockImplementation(function () { return mockVariableStoreInstance }),
    interpolateVariables: vi.fn((instruction: string) => instruction),
    findUnresolvedTemplates: vi.fn(() => []),
    redactSecretValue: vi.fn((value: unknown) => value),
    parseHookInline: vi.fn(() => []),
    stripHookInline: vi.fn((text: string) => text),
    runHooks: (...args: unknown[]) => mockRunHooks(...args),
    runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
    resolveSecretTemplatesInValue: vi.fn((value: unknown) => value),
  }
})

import {
  AUTH_STATE_SCHEMA_VERSION,
  resolveAuthStatePaths,
  type AuthStateMetadata,
} from '@vostride/agent-qa-core'
import { ConfigManager } from '../../config/index.js'
import { LiveSession } from '../live-session.js'
import type { LiveSessionConfig } from '../types.js'

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
    configManager = new ConfigManager(configPath)
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
