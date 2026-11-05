import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AndroidHere, IOSHere } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareMobileLiveSession } from '../mobile-bootstrap.js'
import type { PrepareMobileLiveSessionInput } from '../mobile-bootstrap.js'

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
    remotes: [{ name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }],
    targets: {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
        device: 'release-android-emu',
      },
      'farm-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        app: { ref: 'storage:wikipedia-nightly' },
        device: 'galaxy-farm',
      },
      'release-ios-wdio': {
        platform: 'ios',
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      },
    },
    devices: {
      'release-android-emu': {
        platform: 'android',
        model: 'Pixel 8',
        os: '15',
      },
      'galaxy-farm': {
        platform: 'android',
        model: 'Samsung Galaxy S24',
        remote: 'farm',
      },
      'ios-sim': {
        platform: 'ios',
        model: 'iPhone 17',
        os: '26.2',
      },
    },
  },
}

const androidHere: AndroidHere = {
  attached: [],
  avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
}

const iosHere: IOSHere = {
  simulators: [
    { name: 'iPhone 17', udid: 'SIM-17', os: '26.2', state: 'Shutdown', available: true },
  ],
}

function listing(platform: 'android' | 'ios'): Promise<AndroidHere | IOSHere> {
  return Promise.resolve(platform === 'android' ? androidHere : iosHere)
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

// Each cell names AGENT_QA_APPIUM_URL itself, so the developer's environment never decides it.
function prepare(input: Partial<PrepareMobileLiveSessionInput> & { config?: Record<string, unknown> }) {
  const { config: cfg, ...rest } = input
  return prepareMobileLiveSession({
    sessionId: 'live-android',
    platform: 'android',
    targetName: 'release-android-wikipedia',
    appState: 'preserve',
    configManager: makeConfigManager(cfg ?? config),
    configPath: '/tmp/agent-qa.config.yaml',
    appiumManager: makeAppiumManager(),
    listDevicesHere: vi.fn(listing),
    envUrl: '',
    ...rest,
  })
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
  it("finds the draft's Android device here, leases Appium once and hands over the AVD", async () => {
    const appiumManager = makeAppiumManager()
    const listDevicesHere = vi.fn(listing)

    const result = await prepare({
      useDeviceName: 'release-android-emu',
      appiumManager,
      listDevicesHere,
    })

    expect(listDevicesHere).toHaveBeenCalledWith('android')
    expect(appiumManager.acquireLease).toHaveBeenCalledTimes(1)
    expect(appiumManager.acquireLease).toHaveBeenCalledWith({ runId: 'live-android', platform: 'android' })
    expect(result.appiumLease?.url).toBe('http://localhost:4723')
    expect(result.platformConfig).toMatchObject({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      appPackage: 'org.wikipedia.alpha',
      appActivity: 'org.wikipedia.main.MainActivity',
      appiumUrl: 'http://localhost:4723',
      device: {
        name: 'release-android-emu',
        model: 'Pixel 8',
        os: '15',
        here: { avd: 'Pixel_8_API_35', os: '15' },
      },
      appState: 'preserve',
    })
  })

  it("uses the target's device when the draft names none", async () => {
    const result = await prepare({})

    expect(result.platformConfig.device).toMatchObject({
      name: 'release-android-emu',
      here: { avd: 'Pixel_8_API_35' },
    })
  })

  it('finds an iOS simulator by model and keeps the bundle id apart from it', async () => {
    const appiumManager = makeAppiumManager()

    const result = await prepare({
      sessionId: 'live-ios',
      platform: 'ios',
      targetName: 'release-ios-wdio',
      useDeviceName: 'ios-sim',
      appState: 'reset',
      appiumManager,
    })

    expect(appiumManager.acquireLease).toHaveBeenCalledWith({ runId: 'live-ios', platform: 'ios' })
    expect(result.platformConfig).toMatchObject({
      platform: 'ios',
      bundleId: 'org.reactjs.native.example.wdiodemoapp',
      appiumUrl: 'http://localhost:4723',
      device: { name: 'ios-sim', os: '26.2', here: { udid: 'SIM-17', name: 'iPhone 17' } },
      appState: 'reset',
    })
  })

  it('connects a remote device to its remote and lists, leases and starts nothing', async () => {
    const appiumManager = makeAppiumManager()
    const listDevicesHere = vi.fn(listing)

    const result = await prepare({
      targetName: 'farm-android-wikipedia',
      appiumManager,
      listDevicesHere,
      envUrl: 'http://127.0.0.1:4723',
    })

    expect(appiumManager.acquireLease).not.toHaveBeenCalled()
    expect(listDevicesHere).not.toHaveBeenCalled()
    expect(result.appiumLease).toBeUndefined()
    expect(result.platformConfig).toMatchObject({
      platform: 'android',
      targetName: 'farm-android-wikipedia',
      appRef: 'storage:wikipedia-nightly',
      device: {
        name: 'galaxy-farm',
        model: 'Samsung Galaxy S24',
        remote: { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' },
      },
    })
    expect(result.platformConfig).not.toHaveProperty('appiumUrl')
    expect(result.platformConfig.device).not.toHaveProperty('here')
  })

  it('refuses a device this machine does not have with the finder sentence and leases nothing', async () => {
    const appiumManager = makeAppiumManager()

    await expect(
      prepare({
        useDeviceName: 'release-android-emu',
        appiumManager,
        listDevicesHere: vi.fn(async () => ({ attached: [], avds: [] })),
      }),
    ).rejects.toMatchObject({
      category: 'device-resolution',
      message:
        'Device release-android-emu wants a Pixel 8 on Android 15; this machine has no Android ' +
        'devices or AVDs. Set model or os in registry.devices.release-android-emu.',
    })
    expect(appiumManager.acquireLease).not.toHaveBeenCalled()
  })

  it("talks to the Appium AGENT_QA_APPIUM_URL names on this machine and leases nothing", async () => {
    const appiumManager = makeAppiumManager()

    const result = await prepare({
      useDeviceName: 'release-android-emu',
      appiumManager,
      envUrl: 'http://127.0.0.1:4725/wd/hub',
    })

    expect(appiumManager.acquireLease).not.toHaveBeenCalled()
    expect(result.appiumLease).toBeUndefined()
    expect(result.platformConfig).toMatchObject({
      appiumUrl: 'http://127.0.0.1:4725/wd/hub',
      device: { here: { avd: 'Pixel_8_API_35' } },
    })
  })

  it('refuses an AGENT_QA_APPIUM_URL that is not this machine and leases nothing', async () => {
    const appiumManager = makeAppiumManager()

    await expect(
      prepare({
        useDeviceName: 'release-android-emu',
        appiumManager,
        envUrl: 'https://farm.example.com/wd/hub',
      }),
    ).rejects.toMatchObject({
      category: 'device-resolution',
      message:
        'AGENT_QA_APPIUM_URL names farm.example.com, which is not this machine. List that server ' +
        "under registry.remotes with protocol: appium and set the device's remote to its name.",
    })
    expect(appiumManager.acquireLease).not.toHaveBeenCalled()
  })

  it("passes the resolver's refusal on as its own sentence", async () => {
    const targets = config.registry.targets
    await expect(
      prepare({
        targetName: 'farm-android-wikipedia',
        config: {
          registry: {
            ...config.registry,
            targets: {
              ...targets,
              'farm-android-wikipedia': {
                ...targets['farm-android-wikipedia'],
                app: { path: 'apps/wikipedia.apk' },
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      category: 'device-resolution',
      message:
        'Device galaxy-farm runs on remote farm, and target farm-android-wikipedia has only ' +
        'app.path. Set app.ref to the app the server installs.',
    })
  })

  it('uses the global mobile app state when the live request omits an override', async () => {
    const result = await prepare({
      useDeviceName: 'release-android-emu',
      appState: undefined,
      config: { ...config, use: { mobile: { appState: 'reset' } } },
    })

    expect(result.platformConfig.appState).toBe('reset')
    expect(result.resolved.sourceTrace).toContain('appState=use.mobile.appState:reset')
  })

  it('wraps Appium acquisition failures as appium-startup', async () => {
    const appiumManager = makeAppiumManager({
      acquireLease: vi.fn().mockRejectedValue(new Error('connection refused')),
    })

    await expect(
      prepare({ sessionId: 'live-fail', useDeviceName: 'release-android-emu', appiumManager }),
    ).rejects.toMatchObject({
      category: 'appium-startup',
      message: expect.stringContaining('connection refused'),
    })
  })

  it('returns an Appium lease release function that only releases once', async () => {
    const releaseLease = vi.fn().mockReturnValue(true)
    const result = await prepare({
      sessionId: 'live-release',
      useDeviceName: 'release-android-emu',
      appiumManager: makeAppiumManager({ releaseLease }),
    })

    expect(result.appiumLease?.release('setup-failed')).toBe(true)
    expect(result.appiumLease?.release('setup-failed')).toBe(false)
    expect(releaseLease).toHaveBeenCalledTimes(1)
    expect(releaseLease).toHaveBeenCalledWith('live-release', 'setup-failed')
  })

  it("resolves the live session app path from the target's app.path beside the config", async () => {
    const { dir, configPath } = await createTempWorkspace()
    await mkdir(join(dir, 'apps'), { recursive: true })
    await writeFile(join(dir, 'apps', 'wikipedia.apk'), 'apk', 'utf-8')

    const result = await prepare({
      sessionId: 'live-app-path',
      useDeviceName: 'release-android-emu',
      config: withAppPath('apps/wikipedia.apk'),
      configPath,
    })

    expect(result.platformConfig).toMatchObject({
      appPath: join(dir, 'apps', 'wikipedia.apk'),
    })
  })

  it('surfaces missing live app path as app-install', async () => {
    const { dir, configPath } = await createTempWorkspace()

    await expect(
      prepare({
        sessionId: 'live-missing-app',
        useDeviceName: 'release-android-emu',
        config: withAppPath('apps/missing.apk'),
        configPath,
      }),
    ).rejects.toMatchObject({
      category: 'app-install',
      message: expect.stringContaining(join(dir, 'apps', 'missing.apk')),
    })
  })
})
