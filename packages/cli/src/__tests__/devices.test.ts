// The spawned cells run the built `dist/cli.js`; run `pnpm build` at the repository root first.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { AgentQaConfig, AndroidHere, IOSHere, SimulatorHere } from '@vostride/agent-qa-core'

import { describeDevices, describeDevicesHere, type DevicesHereLister } from '../commands/run.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  fixtureProject,
  spawnCollecting,
} from './conformance/spawned-chat.js'

const LAB_SETTING = 'lab-setting-value'

function devicesProject(label: string): string {
  const { root, configPath } = fixtureProject(`devices-${label}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.registry = {
    remotes: [
      { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' },
      { name: 'lab', plugin: 'lab-devices', settings: { project: LAB_SETTING } },
    ],
    devices: {
      pixel: { platform: 'android', model: 'Pixel 8' },
      'galaxy-farm': { platform: 'android', model: 'Galaxy S24', remote: 'farm' },
      'galaxy-lab': { platform: 'android', model: 'Galaxy S24', remote: 'lab' },
    },
  }
  config.plugins = [
    { name: 'lab-devices', path: './tools/lab-devices', options: { region: LAB_SETTING } },
  ]
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  return root
}

// A PATH holding no adb or xcrun, so the spawned CLI lists nothing from this machine.
function withoutDeviceTools(root: string): Record<string, string> {
  return { PATH: join(root, 'no-device-tools') }
}

function simulator(name: string, os: string, state = 'Shutdown'): SimulatorHere {
  return { name, os, udid: `${name.replace(/\s+/g, '-')}-${os}`, state, available: true }
}

function lister(
  android: AndroidHere,
  ios: IOSHere,
): { list: DevicesHereLister; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    list: async (platform) => {
      calls.push(platform)
      return platform === 'android' ? android : ios
    },
  }
}

function config(registry: Record<string, unknown>): AgentQaConfig {
  return { registry: { remotes: [], ...registry } } as unknown as AgentQaConfig
}

const FARM = { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }
const LAB = { name: 'lab', plugin: 'lab-devices', settings: { project: LAB_SETTING } }

describe('describeDevicesHere', () => {
  it('says what each local profile finds here and where a remote one runs', async () => {
    const { list, calls } = lister(
      {
        attached: [{ serial: 'R58M41ABCDE', state: 'device', model: 'Pixel 8', os: '15' }],
        avds: [],
      },
      { simulators: [simulator('iPhone 16', '18.4'), simulator('iPhone 15', '17.5')] },
    )
    const lines = await describeDevicesHere(
      config({
        remotes: [FARM],
        devices: {
          pixel: { platform: 'android', model: 'Pixel 8' },
          iphone: { platform: 'ios', model: 'iPhone 16', os: '18.4' },
          'galaxy-farm': {
            platform: 'android',
            remote: 'farm',
            model: 'Samsung Galaxy S24',
            os: '14',
          },
        },
      }),
      { listDevicesHere: list },
    )

    expect(lines.slice(0, 3)).toEqual([
      'pixel        here: Pixel 8 phone R58M41ABCDE',
      'iphone       here: iPhone 16 (18.4), shut down',
      'galaxy-farm  remote farm (appium https://farm.example.com:443)',
    ])
    expect(calls.filter((platform) => platform === 'android')).toEqual(['android'])
    expect(calls.filter((platform) => platform === 'ios')).toEqual(['ios'])
  })

  it("then lists this machine's phones, AVDs and simulators to copy a model from", async () => {
    const { list } = lister(
      {
        attached: [
          { serial: 'R58M41ABCDE', state: 'device', model: 'SM-S921B', os: '14' },
          { serial: '37121FDJH000', state: 'device', model: 'Pixel 8', os: '15' },
        ],
        avds: [{ name: 'Pixel_8_API_35', profile: 'pixel_8', displayName: 'Pixel 8', os: '15' }],
      },
      { simulators: [simulator('iPhone 16', '18.4'), simulator('iPhone 15', '17.5')] },
    )
    const lines = await describeDevicesHere(
      config({
        remotes: [FARM],
        devices: {
          pixel: { platform: 'android', model: 'Pixel 8' },
          iphone: { platform: 'ios', model: 'iPhone 16', os: '18.4' },
          'galaxy-farm': {
            platform: 'android',
            remote: 'farm',
            model: 'Samsung Galaxy S24',
            os: '14',
          },
        },
      }),
      { listDevicesHere: list },
    )

    expect(lines).toEqual([
      'pixel        here: Pixel 8 phone 37121FDJH000',
      'iphone       here: iPhone 16 (18.4), shut down',
      'galaxy-farm  remote farm (appium https://farm.example.com:443)',
      'Attached:   SM-S921B  Android 14  R58M41ABCDE',
      '            Pixel 8   Android 15  37121FDJH000',
      'Emulators:  Pixel_8_API_35 (Pixel 8, Android 15)',
      'Simulators: iPhone 16 (18.4), iPhone 15 (17.5)',
    ])
  })

  it("prints a missing tool's listing problem on its line", async () => {
    const { list } = lister(
      { attached: [], avds: [], problem: 'adb not found (set ANDROID_HOME)' },
      { simulators: [], problem: 'simulators need macOS' },
    )
    const lines = await describeDevicesHere(
      config({ devices: { pixel: { platform: 'android', model: 'Pixel 8' } } }),
      { listDevicesHere: list },
    )

    expect(lines).toEqual([
      'pixel  not here: wants a Pixel 8',
      'Attached:   adb not found (set ANDROID_HOME)',
      'Emulators:  none',
      'Simulators: simulators need macOS',
    ])
  })

  it('lists this machine when no profile is configured', async () => {
    const { list, calls } = lister(
      {
        attached: [{ serial: 'R58M41ABCDE', state: 'unauthorized' }],
        avds: [{ name: 'Pixel_8_API_35', displayName: 'Pixel 8', os: '15' }],
      },
      { simulators: [] },
    )
    const lines = await describeDevicesHere(config({}), { listDevicesHere: list })

    expect(lines).toEqual([
      'Attached:   R58M41ABCDE unauthorized',
      'Emulators:  Pixel_8_API_35 (Pixel 8, Android 15)',
      'Simulators: none',
    ])
    expect([...calls].sort()).toEqual(['android', 'ios'])
  })

  it('says a local profile that matches nothing is not here, with what it wants', async () => {
    const { list } = lister(
      { attached: [], avds: [] },
      { simulators: [simulator('iPhone 16 Pro', '18.4'), simulator('iPhone 15', '17.5')] },
    )
    const lines = await describeDevicesHere(
      config({ devices: { iphone: { platform: 'ios', model: 'iPhone 16', os: '18.4' } } }),
      { listDevicesHere: list },
    )

    expect(lines[0]).toBe('iphone  not here: wants an iPhone 16 simulator on iOS 18.4')
  })

  it('says a profile with no model and nothing running names no model', async () => {
    const { list } = lister({ attached: [], avds: [] }, { simulators: [] })
    const lines = await describeDevicesHere(
      config({ devices: { pixel: { platform: 'android' } } }),
      { listDevicesHere: list },
    )

    expect(lines[0]).toBe(
      'pixel  names no model, and this machine runs no Android device. Start one, or set model in registry.devices.pixel.',
    )
  })

  it("prints a remote's name, protocol and origin, never its path, query or headers", async () => {
    const { list } = lister({ attached: [], avds: [] }, { simulators: [] })
    const lines = await describeDevicesHere(
      config({
        remotes: [
          {
            name: 'farm',
            protocol: 'appium',
            url: 'https://farm.example.com:8443/wd/hub/team-path?token=query-value',
            headers: { 'X-Team': 'header-value' },
          },
        ],
        devices: { 'galaxy-farm': { platform: 'android', remote: 'farm', model: 'Galaxy S24' } },
      }),
      { listDevicesHere: list },
    )

    expect(lines[0]).toBe('galaxy-farm  remote farm (appium https://farm.example.com:8443)')
    const text = lines.join('\n')
    for (const hidden of ['/wd/hub', 'team-path', 'query-value', 'token', 'header-value']) {
      expect(text).not.toContain(hidden)
    }
  })

  it('prints a device on a plugin remote by its remote and plugins entry, never its settings', async () => {
    const { list, calls } = lister({ attached: [], avds: [] }, { simulators: [] })
    const lines = await describeDevicesHere(
      config({
        remotes: [LAB],
        devices: { 'galaxy-lab': { platform: 'android', remote: 'lab', model: 'Galaxy S24' } },
      }),
      { listDevicesHere: list },
    )

    expect(lines[0]).toBe('galaxy-lab  remote lab (plugin lab-devices)')
    expect(lines.join('\n')).not.toContain(LAB_SETTING)
    expect(calls.filter((platform) => platform === 'android')).toEqual(['android'])
  })
})

describe('describeDevices', () => {
  it('gives each profile what it finds here, or its remote by name and origin or by plugins entry', async () => {
    const { list } = lister(
      {
        attached: [{ serial: 'R58M41ABCDE', state: 'device', model: 'Pixel 8', os: '15' }],
        avds: [],
      },
      { simulators: [simulator('iPhone 15', '17.5')] },
    )
    const view = await describeDevices(
      config({
        remotes: [FARM, LAB],
        devices: {
          pixel: { platform: 'android', model: 'Pixel 8' },
          iphone: { platform: 'ios', model: 'iPhone 16', os: '18.4' },
          'galaxy-farm': { platform: 'android', remote: 'farm', model: 'Galaxy S24' },
          'galaxy-lab': { platform: 'android', remote: 'lab', model: 'Galaxy S24' },
        },
      }),
      { listDevicesHere: list },
    )

    expect(view.devices).toEqual([
      { name: 'pixel', platform: 'android', here: 'Pixel 8 phone R58M41ABCDE' },
      { name: 'iphone', platform: 'ios', notHere: 'wants an iPhone 16 simulator on iOS 18.4' },
      {
        name: 'galaxy-farm',
        platform: 'android',
        remote: { name: 'farm', protocol: 'appium', url: 'https://farm.example.com:443' },
      },
      {
        name: 'galaxy-lab',
        platform: 'android',
        remote: { name: 'lab', plugin: 'lab-devices' },
      },
    ])
    expect(view.here.android.attached).toHaveLength(1)
    expect(view.here.ios.simulators).toHaveLength(1)
    const json = JSON.stringify(view)
    for (const hidden of [LAB_SETTING, '/wd/hub']) expect(json).not.toContain(hidden)
  })

  it("keeps a missing model's sentence whole", async () => {
    const { list } = lister({ attached: [], avds: [] }, { simulators: [] })
    const view = await describeDevices(config({ devices: { pixel: { platform: 'android' } } }), {
      listDevicesHere: list,
    })

    expect(view.devices).toEqual([
      {
        name: 'pixel',
        platform: 'android',
        notHere:
          'names no model, and this machine runs no Android device. Start one, or set model in registry.devices.pixel.',
      },
    ])
  })
})

describe('agent-qa devices', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  afterEach(() => {
    cleanupTempRoots()
  })

  it('devices init is refused with what replaced it and writes no file', async () => {
    const root = devicesProject('init')
    const before = readdirSync(root).sort()

    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices', 'init'])

    expect(outcome.code).toBe(1)
    expect(outcome.stderr.trim()).toBe(
      'agent-qa devices init was removed: devices are found by model and os, so nothing needs binding. Run agent-qa devices to see what this machine has.',
    )
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it('bare devices says what each profile finds here or the remote it runs on', async () => {
    const root = devicesProject('list')

    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices'], withoutDeviceTools(root))

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/^ {2}pixel {8}not here: wants a Pixel 8$/mu)
    expect(outcome.stdout).toMatch(
      /^ {2}galaxy-farm {2}remote farm \(appium https:\/\/farm\.example\.com:443\)$/mu,
    )
    expect(outcome.stdout).toMatch(/^ {2}Attached: {3}adb not found \(set ANDROID_HOME\)$/mu)
    expect(outcome.stdout).toMatch(/^ {2}Emulators: {2}none$/mu)
    expect(outcome.stdout).toMatch(/^ {2}Simulators: /mu)
    expect(outcome.stdout).toMatch(/^ {2}galaxy-lab {3}remote lab \(plugin lab-devices\)$/mu)
    expect(outcome.stdout).not.toContain(LAB_SETTING)
  })

  it('devices --json gives each profile its place, a plugin remote by name and entry only', async () => {
    const root = devicesProject('json')

    const outcome = await spawnCollecting(
      root,
      [CLI_ENTRY, 'devices', '--json'],
      withoutDeviceTools(root),
    )

    expect(outcome.code).toBe(0)
    const view = JSON.parse(outcome.stdout) as {
      devices: Array<Record<string, unknown>>
      here: { android: { problem?: string } }
    }
    expect(view.devices).toEqual([
      { name: 'pixel', platform: 'android', notHere: 'wants a Pixel 8' },
      {
        name: 'galaxy-farm',
        platform: 'android',
        remote: { name: 'farm', protocol: 'appium', url: 'https://farm.example.com:443' },
      },
      {
        name: 'galaxy-lab',
        platform: 'android',
        remote: { name: 'lab', plugin: 'lab-devices' },
      },
    ])
    expect(view.here.android.problem).toBe('adb not found (set ANDROID_HOME)')
    expect(outcome.stdout).not.toContain(LAB_SETTING)
  })

  it("devices --json reads the config --config names, not the working folder's", async () => {
    const project = devicesProject('config-flag')
    const { root: elsewhere } = fixtureProject('devices-elsewhere')

    const outcome = await spawnCollecting(
      elsewhere,
      [CLI_ENTRY, '--config', join(project, 'agent-qa.config.yaml'), 'devices', '--json'],
      withoutDeviceTools(elsewhere),
    )

    expect(outcome.code, outcome.stderr).toBe(0)
    const view = JSON.parse(outcome.stdout) as { devices: Array<{ name: string }> }
    expect(view.devices.map(({ name }) => name)).toEqual(['pixel', 'galaxy-farm', 'galaxy-lab'])
  })

  it('devices --json lists the devices without loading a model-auth plugin that is not installed', async () => {
    const root = devicesProject('auth-plugin')
    const configPath = join(root, 'agent-qa.config.yaml')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { plugins: unknown[] }
    config.plugins.push({ name: 'subscription', package: '@vostride/agent-qa-subscription-auth' })
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const outcome = await spawnCollecting(
      root,
      [CLI_ENTRY, 'devices', '--json'],
      withoutDeviceTools(root),
    )

    expect(outcome.code, outcome.stderr).toBe(0)
    const view = JSON.parse(outcome.stdout) as { devices: Array<{ name: string }> }
    expect(view.devices.map(({ name }) => name)).toEqual(['pixel', 'galaxy-farm', 'galaxy-lab'])
  })

  it('bare devices with no profile says so and still lists this machine', async () => {
    const { root } = fixtureProject('devices-none')
    writeFileSync(join(root, '.env'), '', 'utf8')
    writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')

    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices'], withoutDeviceTools(root))

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('No devices configured in registry.devices')
    expect(outcome.stdout).toMatch(/^ {2}Attached: {3}adb not found \(set ANDROID_HOME\)$/mu)
  })
})
