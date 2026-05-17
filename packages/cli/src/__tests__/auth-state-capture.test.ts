import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  resolveTarget: vi.fn(),
  resolveAuthStatePaths: vi.fn(),
  listAuthStateMetadata: vi.fn(),
  readAuthStateMetadata: vi.fn(),
  removeAuthStateFiles: vi.fn(),
  removeAuthStateTarget: vi.fn(),
  writeAuthStateFiles: vi.fn(),
  chromiumLaunch: vi.fn(),
  firefoxLaunch: vi.fn(),
  webkitLaunch: vi.fn(),
}))

vi.mock('../config.js', () => ({
  resolveConfig: mocks.resolveConfig,
}))

vi.mock('../targets.js', () => ({
  resolveTarget: mocks.resolveTarget,
}))

vi.mock('@vostride/agent-qa-core', () => ({
  AUTH_STATE_SCHEMA_VERSION: 1,
  resolveAuthStatePaths: mocks.resolveAuthStatePaths,
  listAuthStateMetadata: mocks.listAuthStateMetadata,
  readAuthStateMetadata: mocks.readAuthStateMetadata,
  removeAuthStateFiles: mocks.removeAuthStateFiles,
  removeAuthStateTarget: mocks.removeAuthStateTarget,
  writeAuthStateFiles: mocks.writeAuthStateFiles,
}))

vi.mock('playwright-core', () => ({
  chromium: { launch: mocks.chromiumLaunch },
  firefox: { launch: mocks.firefoxLaunch },
  webkit: { launch: mocks.webkitLaunch },
}))

import { createAuthStateCommand } from '../commands/auth-state.js'

const output: string[] = []

const paths = {
  targetName: 'test-app',
  stateName: 'admin',
  rootDir: '/tmp/auth',
  targetDir: '/tmp/auth/test-app',
  payloadPath: '/tmp/auth/test-app/admin.json',
  metadataPath: '/tmp/auth/test-app/admin.meta.json',
}

const metadata = {
  version: 1,
  kind: 'web',
  target: 'test-app',
  name: 'admin',
  capturedAt: '2026-05-17T00:00:00.000Z',
}

const secretCookie = ['secret', 'cookie'].join('-')
const secretLocalStorage = ['secret', 'local', 'storage'].join('-')
const authStateDir = ['.agent-qa', 'auth-states'].join('/')
const storageStatePayload = {
  cookies: [{
    name: 'session',
    value: secretCookie,
    domain: 'example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }],
  origins: [{
    origin: 'https://example.com',
    localStorage: [{ name: 'token', value: secretLocalStorage }],
    indexedDB: [{ name: 'firebaseLocalStorageDb', version: 1, stores: [] }],
  }],
}

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  storageState: vi.fn().mockResolvedValue(storageStatePayload),
}

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
}

function getOutput(): string {
  return output.join('\n')
}

async function runAuthStateCommand(
  args: string[],
  waitForConfirmation: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue('confirmed'),
): Promise<void> {
  const parent = new Command()
  parent.exitOverride()
  parent.enablePositionalOptions()
  parent.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  parent.addCommand(createAuthStateCommand({
    waitForConfirmation: waitForConfirmation as any,
    now: () => new Date('2026-05-17T00:00:00.000Z'),
  }))

  await parent.parseAsync(['node', 'test', 'auth-state', ...args])
}

async function runCapture(
  waitForConfirmation: ReturnType<typeof vi.fn>,
  args = ['capture', '--target', 'test-app', '--name', 'admin'],
): Promise<void> {
  await runAuthStateCommand(args, waitForConfirmation)
}

describe('auth-state capture command', () => {
  beforeEach(() => {
    output.length = 0
    process.exitCode = undefined
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation((...items: unknown[]) => {
      output.push(items.map(String).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation((...items: unknown[]) => {
      output.push(items.map(String).join(' '))
    })

    mocks.resolveConfig.mockResolvedValue({
      registry: { targets: { 'test-app': { platform: 'web', url: 'https://example.com' } } },
      services: { authState: { dir: authStateDir } },
      use: { browser: { name: 'webkit' } },
    })
    mocks.resolveTarget.mockReturnValue({
      name: 'test-app',
      product: 'test-app',
      platform: 'web',
      url: 'https://example.com',
    })
    mocks.resolveAuthStatePaths.mockReturnValue(paths)
    mocks.listAuthStateMetadata.mockResolvedValue([metadata])
    mocks.readAuthStateMetadata.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    mocks.removeAuthStateFiles.mockResolvedValue(undefined)
    mocks.removeAuthStateTarget.mockResolvedValue(undefined)
    mocks.writeAuthStateFiles.mockResolvedValue(undefined)
    mocks.chromiumLaunch.mockResolvedValue(mockBrowser)
    mocks.firefoxLaunch.mockResolvedValue(mockBrowser)
    mocks.webkitLaunch.mockResolvedValue(mockBrowser)
    mockBrowser.newContext.mockResolvedValue(mockContext)
    mockBrowser.close.mockResolvedValue(undefined)
    mockContext.newPage.mockResolvedValue(mockPage)
    mockContext.storageState.mockResolvedValue(storageStatePayload)
    mockPage.goto.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('saves storage state after terminal confirmation while the headed browser is open', async () => {
    const waitForConfirmation = vi.fn().mockResolvedValue('confirmed')

    await runCapture(waitForConfirmation)

    expect(mocks.resolveConfig).toHaveBeenCalledWith({
      configPath: 'agent-qa.config.yaml',
      loadAuthPlugins: false,
    })
    expect(mocks.resolveAuthStatePaths).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: 'test-app',
      stateName: 'admin',
      target: { platform: 'web' },
    })
    expect(mocks.webkitLaunch).toHaveBeenCalledWith(expect.objectContaining({ headless: false }))
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' })
    expect(waitForConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      browser: mockBrowser,
      message: expect.stringContaining('press Enter to save'),
    }))
    expect(mockContext.storageState).toHaveBeenCalledWith({ indexedDB: true })
    expect(mocks.writeAuthStateFiles).toHaveBeenCalledWith(paths, {
      payload: storageStatePayload,
      metadata,
    })
    expect(mockBrowser.close).toHaveBeenCalled()
    expect(getOutput()).toContain('Saved auth state "admin" for target "test-app".')
    expect(getOutput()).not.toContain(paths.payloadPath)
    expect(getOutput()).not.toContain(paths.metadataPath)
    expect(getOutput()).not.toContain('.agent-qa/auth-states')
    expect(getOutput()).not.toContain('secret-cookie')
    expect(getOutput()).not.toContain('secret-local-storage')
  })

  it('warns in the prompt when an existing auth state will be replaced', async () => {
    mocks.readAuthStateMetadata.mockResolvedValue(metadata)
    const waitForConfirmation = vi.fn().mockResolvedValue('confirmed')

    await runCapture(waitForConfirmation)

    expect(waitForConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Existing auth state will be replaced'),
    }))
    expect(mocks.writeAuthStateFiles).toHaveBeenCalled()
  })

  it('cancels on Ctrl+C without writing auth state', async () => {
    const waitForConfirmation = vi.fn().mockResolvedValue('cancelled')

    await runCapture(waitForConfirmation)

    expect(mocks.writeAuthStateFiles).not.toHaveBeenCalled()
    expect(mockBrowser.close).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(getOutput()).toContain('Auth-state capture cancelled.')
    expect(getOutput()).not.toContain(paths.payloadPath)
  })

  it('fails without writing auth state when the browser closes before confirmation', async () => {
    const waitForConfirmation = vi.fn().mockResolvedValue('browser-closed')

    await runCapture(waitForConfirmation)

    expect(mocks.writeAuthStateFiles).not.toHaveBeenCalled()
    expect(mockBrowser.close).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(getOutput()).toContain('Browser was closed before auth state was saved.')
  })

  it('keeps auth-state paths and payload values out of save failure output', async () => {
    mocks.writeAuthStateFiles.mockRejectedValue(new Error(`EACCES: ${paths.payloadPath}`))
    const waitForConfirmation = vi.fn().mockResolvedValue('confirmed')

    await runCapture(waitForConfirmation)

    expect(process.exitCode).toBe(1)
    expect(mockBrowser.close).toHaveBeenCalled()
    expect(getOutput()).toContain('Could not save auth state "admin" for target "test-app".')
    expect(getOutput()).not.toContain(paths.payloadPath)
    expect(getOutput()).not.toContain(paths.metadataPath)
    expect(getOutput()).not.toContain('secret-cookie')
    expect(getOutput()).not.toContain('secret-local-storage')
  })

  it('rejects mobile targets before launching a browser', async () => {
    mocks.resolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform: 'android',
    })
    mocks.resolveAuthStatePaths.mockImplementation(() => {
      throw new Error('auth state is only supported for web targets. use.mobile.appState: preserve')
    })
    const waitForConfirmation = vi.fn().mockResolvedValue('confirmed')

    await runCapture(waitForConfirmation, ['capture', '--target', 'mobile-app', '--name', 'admin'])

    expect(mocks.webkitLaunch).not.toHaveBeenCalled()
    expect(mocks.writeAuthStateFiles).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(getOutput()).toContain('use.mobile.appState: preserve')
  })

  it('lists auth-state metadata without exposing paths or payload values', async () => {
    mocks.listAuthStateMetadata.mockResolvedValue([
      metadata,
      {
        version: 1,
        kind: 'web',
        target: 'uat',
        name: 'demo-acc',
        capturedAt: '2026-05-17T01:00:00.000Z',
      },
    ])

    await runAuthStateCommand(['list'])

    expect(mocks.listAuthStateMetadata).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: undefined,
    })
    expect(getOutput()).toContain('Target\tName\tCaptured\tKind')
    expect(getOutput()).toContain('test-app\tadmin\t2026-05-17T00:00:00.000Z\tweb')
    expect(getOutput()).toContain('uat\tdemo-acc\t2026-05-17T01:00:00.000Z\tweb')
    expect(getOutput()).not.toContain(authStateDir)
    expect(getOutput()).not.toContain('.json')
    expect(getOutput()).not.toContain('payloadPath')
    expect(getOutput()).not.toContain('metadataPath')
    expect(getOutput()).not.toContain('secret-cookie')
    expect(getOutput()).not.toContain('secret-local-storage')
    expect(getOutput()).not.toContain('firebaseLocalStorageDb')
  })

  it('filters list by resolved web target', async () => {
    await runAuthStateCommand(['list', '--target', 'test-app'])

    expect(mocks.resolveTarget).toHaveBeenCalledWith(expect.anything(), 'test-app')
    expect(mocks.resolveAuthStatePaths).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: 'test-app',
      stateName: 'placeholder',
      target: { platform: 'web' },
    })
    expect(mocks.listAuthStateMetadata).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: 'test-app',
    })
  })

  it('prints a concise message when no auth states are saved', async () => {
    mocks.listAuthStateMetadata.mockResolvedValue([])

    await runAuthStateCommand(['list'])

    expect(process.exitCode).toBeUndefined()
    expect(getOutput()).toBe('No auth states saved.')
  })

  it('rejects mobile target filtering with web auth-state guidance', async () => {
    mocks.resolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform: 'android',
    })
    mocks.resolveAuthStatePaths.mockImplementation(() => {
      throw new Error('auth state is only supported for web targets. For native mobile, use use.mobile.appState: preserve.')
    })

    await runAuthStateCommand(['list', '--target', 'mobile-app'])

    expect(process.exitCode).toBe(1)
    expect(mocks.listAuthStateMetadata).not.toHaveBeenCalled()
    expect(getOutput()).toContain('auth state is only supported for web targets')
    expect(getOutput()).toContain('use.mobile.appState: preserve')
    expect(getOutput()).not.toContain(authStateDir)
  })

  it('removes one named auth state without exposing filesystem paths', async () => {
    await runAuthStateCommand(['remove', '--target', 'test-app', '--name', 'admin'])

    expect(mocks.removeAuthStateFiles).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: 'test-app',
      stateName: 'admin',
      target: { platform: 'web' },
    })
    expect(mocks.removeAuthStateTarget).not.toHaveBeenCalled()
    expect(getOutput()).toContain('Removed auth state "admin" for target "test-app".')
    expect(getOutput()).not.toContain(authStateDir)
    expect(getOutput()).not.toContain('.json')
  })

  it('removes all auth states for a target without requiring --all', async () => {
    await runAuthStateCommand(['remove', '--target', 'test-app'])

    expect(mocks.removeAuthStateTarget).toHaveBeenCalledWith({
      configDir: expect.any(String),
      authStateDir,
      targetName: 'test-app',
      target: { platform: 'web' },
    })
    expect(mocks.removeAuthStateFiles).not.toHaveBeenCalled()
    expect(getOutput()).toContain('Removed auth states for target "test-app".')
  })

  it('treats missing named or target auth state removal as success', async () => {
    mocks.removeAuthStateFiles.mockResolvedValueOnce(undefined)
    mocks.removeAuthStateTarget.mockResolvedValueOnce(undefined)

    await runAuthStateCommand(['remove', '--target', 'test-app', '--name', 'missing'])
    await runAuthStateCommand(['remove', '--target', 'test-app'])

    expect(process.exitCode).toBeUndefined()
    expect(getOutput()).toContain('Removed auth state "missing" for target "test-app".')
    expect(getOutput()).toContain('Removed auth states for target "test-app".')
  })

  it('keeps remove failures path-free', async () => {
    mocks.removeAuthStateFiles.mockRejectedValueOnce(new Error(`EACCES ${paths.payloadPath}`))

    await runAuthStateCommand(['remove', '--target', 'test-app', '--name', 'admin'])

    expect(process.exitCode).toBe(1)
    expect(getOutput()).toContain('Could not remove auth state "admin" for target "test-app".')
    expect(getOutput()).not.toContain(paths.payloadPath)
    expect(getOutput()).not.toContain(paths.metadataPath)
  })

  it('does not accept --all for target removal', async () => {
    await expect(runAuthStateCommand(['remove', '--target', 'test-app', '--all']))
      .rejects.toThrow()
  })
})
