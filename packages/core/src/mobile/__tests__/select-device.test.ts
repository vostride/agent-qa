import { describe, expect, it } from 'vitest'

import { runnerForPlaces } from '../../remote/select-place.js'
import { RemoteEntrySchema } from '../../schema/remote-schema.js'
import {
  selectDevicePlace,
  selectTestDevice,
  type SelectDevicePlaceInput,
  type SelectDevicePlaceResult,
  type SelectTestDeviceInput,
} from '../select-device.js'

const farm = RemoteEntrySchema.parse({
  name: 'farm',
  protocol: 'appium',
  url: 'https://farm.example.com/wd/hub',
  headers: { 'x-team': 'mobile' },
  basicAuth: { user: 'qa', password: '{{secret:FARM_KEY}}' },
})
const lab = RemoteEntrySchema.parse({
  name: 'lab',
  protocol: 'appium',
  url: 'https://lab.example.com/wd/hub',
  connectTimeout: '45s',
})
const grid = RemoteEntrySchema.parse({
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://grid.example.com/playwright',
})
const remotes = [farm, lab, grid]
const devices = {
  pixel: {},
  'galaxy-farm': { remote: 'farm' },
  'galaxy-lab': { remote: 'lab' },
}

function select(input: Partial<SelectDevicePlaceInput> & { device: string }) {
  return selectDevicePlace({ devices, remotes, ...input })
}

function refusal(result: SelectDevicePlaceResult): string {
  if (!('refusal' in result)) throw new Error(`placed: ${result.place.kind}`)
  return result.refusal
}

describe('where a device runs', () => {
  it('runs a device whose profile names an appium remote there, with a 5-minute connect timeout', () => {
    expect(select({ device: 'galaxy-farm' })).toEqual({
      place: {
        kind: 'remote',
        device: 'galaxy-farm',
        remote: {
          name: 'farm',
          protocol: 'appium',
          url: 'https://farm.example.com/wd/hub',
          headers: { 'x-team': 'mobile' },
          basicAuth: { user: 'qa', password: '{{secret:FARM_KEY}}' },
          connectTimeoutMs: 300000,
        },
      },
    })
  })

  it("gives the remote device the remote's own connect timeout", () => {
    const result = select({ device: 'galaxy-lab' })
    if ('refusal' in result || result.place.kind !== 'remote') throw new Error('not remote')
    expect(result.place.remote.connectTimeoutMs).toBe(45000)
  })

  it('runs a device whose profile names no remote here', () => {
    expect(select({ device: 'pixel' })).toEqual({ place: { kind: 'local', device: 'pixel' } })
  })

  it('refuses an unknown device, naming the file and the listed devices', () => {
    expect(refusal(select({ device: 'pixle', file: 'tests/login.test.yaml' }))).toBe(
      'Unknown device "pixle" in tests/login.test.yaml. registry.devices lists: pixel, galaxy-farm, galaxy-lab.',
    )
    expect(refusal(select({ devices: {}, device: 'pixel', file: 'agent-qa.config.yaml' }))).toBe(
      'Unknown device "pixel" in agent-qa.config.yaml. registry.devices lists no devices.',
    )
    expect(refusal(select({ device: 'toString' }))).toBe(
      'Unknown device "toString". registry.devices lists: pixel, galaxy-farm, galaxy-lab.',
    )
  })

  it('refuses a device whose remote is not listed or is not an appium remote', () => {
    expect(refusal(select({ devices: { phone: { remote: 'fram' } }, device: 'phone' }))).toBe(
      'Device phone names remote "fram", which registry.remotes does not list. registry.remotes lists: farm, lab, grid.',
    )
    expect(
      refusal(select({ devices: { phone: { remote: 'farm' } }, remotes: [], device: 'phone' })),
    ).toBe(
      'Device phone names remote "farm", which registry.remotes does not list. registry.remotes lists no remotes.',
    )
    expect(refusal(select({ devices: { phone: { remote: 'grid' } }, device: 'phone' }))).toBe(
      "Device phone names remote grid, a playwright remote; a device's remote needs protocol: appium.",
    )
  })
})

describe('the runner a run on devices records', () => {
  it('is remote when a device runs on a remote, and local otherwise', () => {
    const remote = select({ device: 'galaxy-farm' })
    const here = select({ device: 'pixel' })
    if ('refusal' in remote || 'refusal' in here) throw new Error('refused')
    expect(runnerForPlaces([remote.place])).toBe('remote')
    expect(runnerForPlaces([here.place, remote.place])).toBe('remote')
    expect(runnerForPlaces([here.place])).toBe('local')
  })
})

const profiles = {
  pixel: { platform: 'android' },
  'pixel-tablet': { platform: 'android' },
  'galaxy-farm': { platform: 'android', remote: 'farm' },
  iphone: { platform: 'ios' },
}
const android = { name: 'shop-android', platform: 'android', device: 'pixel' }

function selectTest(input: Partial<SelectTestDeviceInput>) {
  return selectTestDevice({ devices: profiles, remotes, target: android, ...input })
}

describe('the device a test runs on', () => {
  it("is its target's device when neither the test nor --device picks one", () => {
    expect(selectTest({})).toEqual({ place: { kind: 'local', device: 'pixel' } })
  })

  it("is the test's pick over its target's device", () => {
    expect(selectTest({ test: 'pixel-tablet', file: 'tests/login.test.yaml' })).toEqual({
      place: { kind: 'local', device: 'pixel-tablet' },
    })
    const remote = selectTest({ test: 'galaxy-farm' })
    if ('refusal' in remote) throw new Error(remote.refusal)
    expect(remote.place.kind).toBe('remote')
  })

  it("is the --device pick over the test's and the target's", () => {
    expect(selectTest({ flag: 'pixel-tablet', test: 'pixel' })).toEqual({
      place: { kind: 'local', device: 'pixel-tablet' },
    })
  })

  it('runs here when --device names a device here, though the test picks a remote device', () => {
    expect(
      selectTest({ flag: 'pixel', test: 'galaxy-farm', file: 'tests/login.test.yaml' }),
    ).toEqual({ place: { kind: 'local', device: 'pixel' } })
  })

  it('refuses --device naming a device on a remote', () => {
    expect(refusal(selectTest({ flag: 'galaxy-farm' }))).toBe(
      'Device galaxy-farm runs on remote farm; --device picks a device on this machine. Set use.device: galaxy-farm in a suite or test to run there.',
    )
  })

  it('refuses a test with no device anywhere', () => {
    expect(refusal(selectTest({ target: { name: 'shop-android', platform: 'android' } }))).toBe(
      'No device specified for mobile target "shop-android". Set device on registry.targets.shop-android, or use.device in the test or its suite.',
    )
  })

  it("refuses a device of another platform than the test's target", () => {
    expect(refusal(selectTest({ test: 'iphone', file: 'tests/login.test.yaml' }))).toBe(
      'Device "iphone" is ios, but target "shop-android" is android.',
    )
    expect(refusal(selectTest({ flag: 'iphone' }))).toBe(
      'Device "iphone" is ios, but target "shop-android" is android.',
    )
  })

  it('refuses an unknown device, naming where the name came from', () => {
    expect(refusal(selectTest({ flag: 'pixle' }))).toBe(
      'Unknown device "pixle" in --device. registry.devices lists: pixel, pixel-tablet, galaxy-farm, iphone.',
    )
    expect(refusal(selectTest({ test: 'pixle', file: 'tests/login.test.yaml' }))).toBe(
      'Unknown device "pixle" in tests/login.test.yaml. registry.devices lists: pixel, pixel-tablet, galaxy-farm, iphone.',
    )
    expect(refusal(selectTest({ target: { ...android, device: 'pixle' } }))).toBe(
      'Unknown device "pixle" in registry.targets.shop-android. registry.devices lists: pixel, pixel-tablet, galaxy-farm, iphone.',
    )
  })
})
