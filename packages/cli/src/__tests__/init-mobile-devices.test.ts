// A fresh init with a mobile runtime lists this machine's emulators and simulators through a fake
// lister, writes the device it picked for each runtime and names it in one line.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findDeviceHere, type AndroidHere, type IOSHere } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { InitCommandHooks } from '../commands/init.js'
import { cleanupTempProjects, mobileInitFakes, tempProject } from './project-fixtures.js'
import { rerun } from './rerun-fixtures.js'

const IPHONE_UDID = '0A6B5E2C-4D1F-4A9E-9C3B-2F8E7D6A5B4C'
const PIXEL: AndroidHere = {
  attached: [],
  avds: [{ name: 'Pixel_10_Pro', profile: 'pixel_10_pro', displayName: 'Pixel 10 Pro', os: '17' }],
}
const IPHONE: IOSHere = {
  simulators: [
    { name: 'iPhone 18 Pro', udid: IPHONE_UDID, os: '27.0', state: 'Booted', available: true },
  ],
}
const ANDROID_DEVICE = 'android-emulator-pixel-10-pro-17'
const IOS_DEVICE = 'ios-simulator-iphone-18-pro-27.0'

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
  return { project, fakes, result, config: parse(text) as WrittenConfig }
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
      { kind: 'line', text: `Android device: Pixel 10 Pro (Android 17) as ${ANDROID_DEVICE}` },
      { kind: 'line', text: `iOS device: iPhone 18 Pro (iOS 27.0) as ${IOS_DEVICE}` },
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
