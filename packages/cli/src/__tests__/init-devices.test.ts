import { describe, expect, it } from 'vitest'

import {
  findDeviceHere,
  type AndroidHere,
  type AttachedAndroid,
  type AvdHere,
  type IOSHere,
  type SimulatorHere,
} from '@vostride/agent-qa-core'

import { pickDeviceHere, type PickedDevice } from '../commands/init-devices.js'

function avd(name: string, os?: string, extra: Partial<AvdHere> = {}): AvdHere {
  return {
    name,
    profile: name.toLowerCase(),
    displayName: name.replaceAll('_', ' '),
    ...(os === undefined ? {} : { os }),
    ...extra,
  }
}

function emulatorOf(
  running: AvdHere,
  serial: string,
  extra: Partial<AttachedAndroid> = {},
): AttachedAndroid {
  return {
    serial,
    state: 'device',
    model: 'sdk_gphone64_arm64',
    avd: running.name,
    ...(running.os === undefined ? {} : { os: running.os }),
    ...extra,
  }
}

function simulator(name: string, os: string, extra: Partial<SimulatorHere> = {}): SimulatorHere {
  return {
    name,
    os,
    udid: `${name.replace(/\s+/g, '-')}-${os}`,
    state: 'Shutdown',
    available: true,
    ...extra,
  }
}

// While an AVD runs, the run finds its emulator by serial.
type DeviceHere = { avd: string; serial?: string } | { udid: string }

function expectRunFinds(
  pick: PickedDevice | undefined,
  listing: AndroidHere | IOSHere,
  device: DeviceHere,
): void {
  if (pick === undefined) throw new Error('there is no pick for the run to find')
  const find = (shown: AndroidHere | IOSHere) =>
    findDeviceHere({
      device: pick.name,
      ...pick.profile,
      ...(pick.profile.platform === 'ios'
        ? { ios: shown as IOSHere }
        : { android: shown as AndroidHere }),
    })
  if ('udid' in device) {
    const ios = listing as IOSHere
    const shutDown = ios.simulators.map((each) => ({ ...each, state: 'Shutdown' }))
    expect(find(ios)).toMatchObject({ found: { udid: device.udid } })
    expect(find({ ...ios, simulators: shutDown })).toMatchObject({ found: { udid: device.udid } })
    return
  }
  const android = listing as AndroidHere
  const asListed = device.serial === undefined ? { avd: device.avd } : { udid: device.serial }
  expect(find(android)).toMatchObject({ found: asListed })
  expect(find({ ...android, attached: [] })).toMatchObject({ found: { avd: device.avd } })
}

describe('pickDeviceHere on Android', () => {
  const pixel = avd('Pixel_10_Pro', '17')
  const pixelPicked: PickedDevice = {
    name: 'android-emulator-pixel-10-pro-17',
    profile: { platform: 'android', model: 'Pixel 10 Pro', os: '17' },
  }

  it('names an idle AVD after its display name and its OS', () => {
    const listing: AndroidHere = { attached: [], avds: [pixel] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual(pixelPicked)
    expectRunFinds(pick, listing, { avd: 'Pixel_10_Pro' })
  })

  it('picks the same entry while the AVD runs, not the model its emulator reports', () => {
    const listing: AndroidHere = { attached: [emulatorOf(pixel, 'emulator-5554')], avds: [pixel] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual(pixelPicked)
    expectRunFinds(pick, listing, { avd: 'Pixel_10_Pro', serial: 'emulator-5554' })
  })

  it('picks nothing when the machine has no AVD', () => {
    expect(pickDeviceHere('android', { attached: [], avds: [] })).toBeUndefined()
  })
})

describe('pickDeviceHere on iOS', () => {
  const iphonePicked: PickedDevice = {
    name: 'ios-simulator-iphone-18-pro-27.0',
    profile: { platform: 'ios', model: 'iPhone 18 Pro', os: '27.0' },
  }

  it('names a booted simulator after its name and its OS', () => {
    const iphone = simulator('iPhone 18 Pro', '27.0', { state: 'Booted' })
    const listing: IOSHere = { simulators: [iphone] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual(iphonePicked)
    expectRunFinds(pick, listing, { udid: iphone.udid })
  })

  it('picks the same entry for the simulator shut down', () => {
    const iphone = simulator('iPhone 18 Pro', '27.0')
    const listing: IOSHere = { simulators: [iphone] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual(iphonePicked)
    expectRunFinds(pick, listing, { udid: iphone.udid })
  })

  it('picks nothing when the Mac has no simulator', () => {
    expect(pickDeviceHere('ios', { simulators: [] })).toBeUndefined()
  })

  it('picks nothing when simulators cannot be listed', () => {
    const listing: IOSHere = { simulators: [], problem: 'simulators need macOS' }
    expect(pickDeviceHere('ios', listing)).toBeUndefined()
  })
})
