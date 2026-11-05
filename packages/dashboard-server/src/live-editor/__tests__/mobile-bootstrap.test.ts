import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareMobileLiveSession } from '../mobile-bootstrap.js'

function makeConfigManager(config: Record<string, unknown>) {
  return {
    readWithRevision: vi.fn().mockResolvedValue({ kind: 'ok', config, raw: '', revision: 'fixture' }),
  } as any
}

function makeAppiumManager(overrides: Partial<{
  acquireLease: ReturnType<typeof vi.fn>
  releaseLease: ReturnType<typeof vi.fn>
  getUrl: ReturnType<typeof vi.fn>
}> = {}) {
  return {
    acquireLease: overrides.acquireLease ?? vi.fn().mockResolvedValue(undefined),
    releaseLease: overrides.releaseLease ?? vi.fn().mockReturnValue(true),
    getUrl: overrides.getUrl ?? vi.fn(() => 'http://localhost:4723'),
  } as any
}

const config = {
  registry: {
    targets: {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
      },
      'release-ios-wdio': {
        platform: 'ios',
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      },
    },
    devices: {
      'release-android-emu': {
        platform: 'android',
        os: '15',
      },
      'ios-sim': {
        platform: 'ios',
        os: '26.2',
      },
    },
  },
}

function withAppPath(path: string) {
  const targets = config.registry.targets
  return {
    registry: {
      ...config.registry,
      targets: {
        ...targets,
        'release-android-wikipedia': { ...targets['release-android-wikipedia'], app: { path } },
      },
    },
  }
}

let tempDirs: string[] = []

async function createTempWorkspace(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-live-mobile-'))
  tempDirs.push(dir)
  return { dir, configPath: join(dir, 'agent-qa.config.yaml') }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('prepareMobileLiveSession', () => {
  it('resolves Android app identity and acquires an Appium lease', async () => {
    const appiumManager = makeAppiumManager()

    const result = await prepareMobileLiveSession({
      sessionId: 'live-android',
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'preserve',
      configManager: makeConfigManager(config),
      configPath: '/tmp/agent-qa.config.yaml',
      appiumManager,
    })

    expect(appiumManager.acquireLease).toHaveBeenCalledWith({ runId: 'live-android', platform: 'android' })
    expect(result.platformConfig).toMatchObject({
      platform: 'android',
      appPackage: 'org.wikipedia.alpha',
      appActivity: 'org.wikipedia.main.MainActivity',
      appiumUrl: 'http://localhost:4723',
      device: { name: 'release-android-emu', os: '15' },
      appState: 'preserve',
    })
  })

  it('resolves iOS bundle identity separately from simulator identity', async () => {
    const appiumManager = makeAppiumManager()

    const result = await prepareMobileLiveSession({
      sessionId: 'live-ios',
      platform: 'ios',
      targetName: 'release-ios-wdio',
      useDeviceName: 'ios-sim',
      appState: 'reset',
      configManager: makeConfigManager(config),
      configPath: '/tmp/agent-qa.config.yaml',
      appiumManager,
    })

    expect(appiumManager.acquireLease).toHaveBeenCalledWith({ runId: 'live-ios', platform: 'ios' })
    expect(result.platformConfig).toMatchObject({
      platform: 'ios',
      bundleId: 'org.reactjs.native.example.wdiodemoapp',
      appiumUrl: 'http://localhost:4723',
      device: { name: 'ios-sim', os: '26.2' },
      appState: 'reset',
    })
  })

  it('uses the global mobile app state when the live request omits an override', async () => {
    const appiumManager = makeAppiumManager()

    const result = await prepareMobileLiveSession({
      sessionId: 'live-config-app-state',
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      configManager: makeConfigManager({
        ...config,
        use: { mobile: { appState: 'reset' } },
      }),
      configPath: '/tmp/agent-qa.config.yaml',
      appiumManager,
    })

    expect(result.platformConfig.appState).toBe('reset')
    expect(result.resolved.sourceTrace).toContain('appState=use.mobile.appState:reset')
  })

  it('wraps Appium acquisition failures as appium-startup', async () => {
    const appiumManager = makeAppiumManager({
      acquireLease: vi.fn().mockRejectedValue(new Error('connection refused')),
    })

    await expect(
      prepareMobileLiveSession({
        sessionId: 'live-fail',
        platform: 'android',
        targetName: 'release-android-wikipedia',
        useDeviceName: 'release-android-emu',
        appState: 'preserve',
        configManager: makeConfigManager(config),
        configPath: '/tmp/agent-qa.config.yaml',
        appiumManager,
      }),
    ).rejects.toMatchObject({
      category: 'appium-startup',
      message: expect.stringContaining('connection refused'),
    })
  })

  it('returns an Appium lease release function that only releases once', async () => {
    const releaseLease = vi.fn().mockReturnValue(true)
    const appiumManager = makeAppiumManager({ releaseLease })
    const result = await prepareMobileLiveSession({
      sessionId: 'live-release',
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'preserve',
      configManager: makeConfigManager(config),
      configPath: '/tmp/agent-qa.config.yaml',
      appiumManager,
    })

    expect(result.appiumLease.release('setup-failed')).toBe(true)
    expect(result.appiumLease.release('setup-failed')).toBe(false)
    expect(releaseLease).toHaveBeenCalledTimes(1)
    expect(releaseLease).toHaveBeenCalledWith('live-release', 'setup-failed')
  })

  it("resolves the live session app path from the target's app.path beside the config", async () => {
    const { dir, configPath } = await createTempWorkspace()
    await mkdir(join(dir, 'apps'), { recursive: true })
    await writeFile(join(dir, 'apps', 'wikipedia.apk'), 'apk', 'utf-8')

    const result = await prepareMobileLiveSession({
      sessionId: 'live-app-path',
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'preserve',
      configManager: makeConfigManager(withAppPath('apps/wikipedia.apk')),
      configPath,
      appiumManager: makeAppiumManager(),
    })

    expect(result.platformConfig).toMatchObject({
      appPath: join(dir, 'apps', 'wikipedia.apk'),
    })
  })

  it('surfaces missing live app path as app-install', async () => {
    const { dir, configPath } = await createTempWorkspace()

    await expect(
      prepareMobileLiveSession({
        sessionId: 'live-missing-app',
        platform: 'android',
        targetName: 'release-android-wikipedia',
        useDeviceName: 'release-android-emu',
        appState: 'preserve',
        configManager: makeConfigManager(withAppPath('apps/missing.apk')),
        configPath,
        appiumManager: makeAppiumManager(),
      }),
    ).rejects.toMatchObject({
      category: 'app-install',
      message: expect.stringContaining(join(dir, 'apps', 'missing.apk')),
    })
  })
})
