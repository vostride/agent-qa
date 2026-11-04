import { describe, expect, it } from 'vitest'

import { runnerForPlaces } from '../../remote/select-place.js'
import { RemoteEntrySchema } from '../../schema/remote-schema.js'
import {
  selectDevicePlace,
  type SelectDevicePlaceInput,
  type SelectDevicePlaceResult,
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
