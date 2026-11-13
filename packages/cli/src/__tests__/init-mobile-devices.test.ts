// A fresh init with a mobile runtime lists this machine's emulators and simulators through a fake
// lister, writes the device it picked for each runtime and names it in one line, or says in one
// line that the runtime has none.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findDeviceHere,
  type AndroidHere,
  type AttachedAndroid,
  type AvdHere,
  type IOSHere,
} from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { InitCommandHooks } from '../commands/init.js'
import { PLAYGROUND_APP_PATHS } from '../commands/playground-app-pin.js'
import type { DevicesHereLister } from '../commands/run.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import { cleanupTempProjects, mobileInitFakes, tempProject } from './project-fixtures.js'
import { rerun } from './rerun-fixtures.js'

const IPHONE_UDID = '0A6B5E2C-4D1F-4A9E-9C3B-2F8E7D6A5B4C'
const PIXEL_AVD: AvdHere = {
  name: 'Pixel_10_Pro',
  profile: 'pixel_10_pro',
  displayName: 'Pixel 10 Pro',
  os: '17',
}
const PIXEL: AndroidHere = { attached: [], avds: [PIXEL_AVD] }
const IPHONE: IOSHere = {
  simulators: [
    { name: 'iPhone 18 Pro', udid: IPHONE_UDID, os: '27.0', state: 'Booted', available: true },
  ],
}
const USB_PHONE: AttachedAndroid = {
  serial: 'R5CT32QWERT',
  state: 'device',
  model: 'SM_S918B',
  os: '16',
}
const ANDROID_DEVICE = 'android-emulator-pixel-10-pro-17'
const IOS_DEVICE = 'ios-simulator-iphone-18-pro-27.0'
const ANDROID_LINE = `Android device: Pixel 10 Pro (Android 17) as ${ANDROID_DEVICE}`
const IOS_LINE = `iOS device: iPhone 18 Pro (iOS 27.0) as ${IOS_DEVICE}`
const ANDROID_NONE =
  "Android device: none found. Create an emulator in Android Studio's Device Manager, then " +
  'describe it under registry.devices and set device on registry.targets.playground-android.'
const IOS_NONE =
  'iOS device: none found. Create a simulator in Xcode, then describe it under ' +
  'registry.devices and set device on registry.targets.playground-ios.'
const PLAYGROUND_EXAMPLES = [
  'tests/examples/playground-android-open-komazon.yaml',
  'tests/examples/playground-android-cart-total.yaml',
  'tests/examples/playground-android-cart-total-bug.yaml',
  'tests/examples/playground-ios-open-komazon.yaml',
  'tests/examples/playground-ios-cart-total.yaml',
  'tests/examples/playground-ios-cart-total-bug.yaml',
]

interface WrittenConfig {
  registry: {
    devices?: Record<
      string,
      { platform: 'android' | 'ios'; model?: string; os?: string; id?: string }
    >
    targets: Record<string, { device?: string; app?: { path?: string } }>
  }
}

afterEach(() => {
  cleanupTempProjects()
})

async function freshInit(
  platform: string,
  devices: { android?: AndroidHere; ios?: IOSHere } = {},
  hooks: InitCommandHooks = {},
) {
  const project = tempProject('mobile-devices')
  const fakes = mobileInitFakes(devices)
  const result = await rerun(
    project,
    [
      '--yes',
      '--pm',
      'none',
      '--no-browsers',
      '--agents',
      'none',
      '--llm',
      'gemini',
      '--platform',
      platform,
    ],
    { hooks: { ...fakes.hooks, ...hooks } },
  )
  const text = readFileSync(join(project.root, 'agent-qa.config.yaml'), 'utf8')
  return { project, fakes, result, text, config: parse(text) as WrittenConfig }
}

function deviceLinesOf(entries: readonly FakeInitUiEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'line' && /^(Android|iOS) device:/u.test(entry.text))
    .map((entry) => entry.text)
}

describe('a fresh mobile init and the devices on this machine', () => {
  it('writes the AVD and the simulator it picked, binds each Playground target and names both', async () => {
    const { result, config } = await freshInit('android,ios', { android: PIXEL, ios: IPHONE })

    expect(result.exit).toBe(0)
    expect(config.registry.devices).toEqual({
      [ANDROID_DEVICE]: { platform: 'android', model: 'Pixel 10 Pro', os: '17' },
      [IOS_DEVICE]: { platform: 'ios', model: 'iPhone 18 Pro', os: '27.0' },
    })
    expect(config.registry.targets['playground-android']?.device).toBe(ANDROID_DEVICE)
    expect(config.registry.targets['playground-ios']?.device).toBe(IOS_DEVICE)
    const scaffold = result.entries.findIndex(
      (entry) => entry.kind === 'done' && entry.text.startsWith('Scaffold:'),
    )
    expect(scaffold, 'the scaffold step is done').toBeGreaterThan(-1)
    expect(result.entries.slice(scaffold + 1, scaffold + 4)).toEqual([
      { kind: 'line', text: ANDROID_LINE },
      { kind: 'line', text: IOS_LINE },
      { kind: 'step', text: 'Installing dependencies' },
    ])
  })

  it("writes entries the run's finder resolves to the devices it picked", async () => {
    const { config } = await freshInit('android,ios', { android: PIXEL, ios: IPHONE })

    const entryOf = (target: string) => {
      const device = config.registry.targets[target]?.device ?? `no device on ${target}`
      const profile = config.registry.devices?.[device]
      if (profile === undefined) throw new Error(`registry.devices has no ${device}`)
      return { device, ...profile }
    }
    expect(findDeviceHere({ ...entryOf('playground-android'), android: PIXEL })).toMatchObject({
      found: { avd: 'Pixel_10_Pro' },
    })
    expect(findDeviceHere({ ...entryOf('playground-ios'), ios: IPHONE })).toMatchObject({
      found: { udid: IPHONE_UDID },
    })
  })

  it('lists no device for a web project and draws no device line', async () => {
    const { result, fakes } = await freshInit('web', { android: PIXEL, ios: IPHONE })

    expect(result.exit).toBe(0)
    expect(fakes.listed).toEqual([])
    const deviceLines = result.entries.filter((entry) => /^(Android|iOS) device:/u.test(entry.text))
    expect(deviceLines).toEqual([])
  })

  it('lists only the Android devices for an Android project', async () => {
    const { result, fakes, config } = await freshInit('android', { android: PIXEL, ios: IPHONE })

    expect(result.exit).toBe(0)
    expect(fakes.listed).toEqual(['android'])
    expect(Object.keys(config.registry.devices ?? {})).toEqual([ANDROID_DEVICE])
  })
})

describe('a fresh mobile init with no device for a runtime', () => {
  it('writes both targets, their apps and the six examples, no device, and a line per runtime', async () => {
    const { project, result, config } = await freshInit('android,ios')

    expect(result.exit).toBe(0)
    expect(config.registry).not.toHaveProperty('devices')
    const targets = { android: 'playground-android', ios: 'playground-ios' } as const
    for (const runtime of ['android', 'ios'] as const) {
      const target = config.registry.targets[targets[runtime]]
      expect(target, targets[runtime]).not.toHaveProperty('device')
      expect(target?.app?.path, targets[runtime]).toBe(PLAYGROUND_APP_PATHS[runtime])
    }
    for (const path of PLAYGROUND_EXAMPLES) {
      expect(existsSync(join(project.root, path)), path).toBe(true)
    }
    expect(deviceLinesOf(result.entries)).toEqual([ANDROID_NONE, IOS_NONE])
  })

  it('says iOS has no simulator because they need macOS, and still writes the Android device', async () => {
    const { result, config } = await freshInit('android,ios', {
      android: PIXEL,
      ios: { simulators: [], problem: 'simulators need macOS' },
    })

    expect(result.exit).toBe(0)
    expect(config.registry.devices).toEqual({
      [ANDROID_DEVICE]: { platform: 'android', model: 'Pixel 10 Pro', os: '17' },
    })
    expect(config.registry.targets['playground-android']?.device).toBe(ANDROID_DEVICE)
    expect(config.registry.targets['playground-ios']).not.toHaveProperty('device')
    expect(deviceLinesOf(result.entries)).toEqual([
      ANDROID_LINE,
      'iOS device: none found (simulators need macOS). Describe one under registry.devices ' +
        'and set device on registry.targets.playground-ios once this machine has one.',
    ])
  })

  it('carries on past a lister that throws, and its line gives the error', async () => {
    const listDevicesHere: DevicesHereLister = async (platform) => {
      if (platform === 'android') throw new Error('adb is not on PATH')
      return IPHONE
    }

    const { project, result, config } = await freshInit('android,ios', {}, { listDevicesHere })

    expect(result.exit).toBe(0)
    expect(Object.keys(config.registry.devices ?? {})).toEqual([IOS_DEVICE])
    expect(config.registry.targets['playground-android']).not.toHaveProperty('device')
    expect(deviceLinesOf(result.entries)).toEqual([
      "Android device: none found (could not list this machine's devices: adb is not on PATH). " +
        'Describe one under registry.devices and set device on ' +
        'registry.targets.playground-android once this machine has one.',
      IOS_LINE,
    ])
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: expect.stringMatching(/^Scaffold: /u),
    })
    for (const path of PLAYGROUND_EXAMPLES) {
      expect(existsSync(join(project.root, path)), path).toBe(true)
    }
    expect(result.entries).toContainEqual(
      expect.objectContaining({ kind: 'note', text: 'Next steps' }),
    )
  })

  it('never writes a phone attached over USB, alone or beside an AVD', async () => {
    const alone = await freshInit('android', { android: { attached: [USB_PHONE], avds: [] } })

    expect(alone.result.exit).toBe(0)
    expect(alone.config.registry).not.toHaveProperty('devices')
    expect(alone.config.registry.targets['playground-android']).not.toHaveProperty('device')
    expect(deviceLinesOf(alone.result.entries)).toEqual([ANDROID_NONE])

    const beside = await freshInit('android', { android: { ...PIXEL, attached: [USB_PHONE] } })

    expect(beside.result.exit).toBe(0)
    expect(beside.config.registry.devices).toEqual({
      [ANDROID_DEVICE]: { platform: 'android', model: 'Pixel 10 Pro', os: '17' },
    })
    expect(beside.text).not.toContain(USB_PHONE.serial)
  })

  it("writes no device and does not say none was found when the only AVD's emulator is offline", async () => {
    const { result, config } = await freshInit('android', {
      android: {
        attached: [{ serial: 'emulator-5554', state: 'offline', avd: PIXEL_AVD.name }],
        avds: [PIXEL_AVD],
      },
    })

    expect(result.exit).toBe(0)
    expect(config.registry).not.toHaveProperty('devices')
    expect(config.registry.targets['playground-android']).not.toHaveProperty('device')
    expect(deviceLinesOf(result.entries)).toEqual([
      "Android device: none of this machine's emulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-android.',
    ])
  })
})
