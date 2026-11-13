import { describe, expect, it } from 'vitest'

import {
  findDeviceHere,
  type AndroidHere,
  type AttachedAndroid,
  type AvdHere,
  type IOSHere,
  type SimulatorHere,
} from '@vostride/agent-qa-core'

import { findInitDevices, pickDeviceHere, type PickedDevice } from '../commands/init-devices.js'
import { PLAYGROUND_APP_PIN } from '../commands/playground-app-pin.js'
import type { DevicesHereLister } from '../commands/run.js'

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

describe('pickDeviceHere among several AVDs', () => {
  const pixel6 = avd('Pixel_6')
  const pixel7 = avd('Pixel_7', '14')
  const pixel8 = avd('Pixel_8', '15')
  const pixel9 = avd('Pixel_9', '15')
  const usbPhone: AttachedAndroid = {
    serial: 'R5CT32QWERT',
    state: 'device',
    model: 'SM_S918B',
    os: '16',
  }

  it('picks a running AVD over an idle one on a newer OS', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(pixel7, 'emulator-5554')],
      avds: [pixel9, pixel7],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-7-14',
      profile: { platform: 'android', model: 'Pixel 7', os: '14' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_7', serial: 'emulator-5554' })
  })

  it('picks the idle AVD with the newest OS', () => {
    const listing: AndroidHere = { attached: [], avds: [pixel7, pixel9] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-9-15',
      profile: { platform: 'android', model: 'Pixel 9', os: '15' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_9' })
  })

  it('compares OS versions as numbers, so 10 is newer than 9', () => {
    const listing: AndroidHere = { attached: [], avds: [avd('Pixel_3', '9'), avd('Pixel_4', '10')] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-4-10',
      profile: { platform: 'android', model: 'Pixel 4', os: '10' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_4' })
  })

  it('compares OS versions part by part, so 8.1 is newer than 8.0.5', () => {
    const listing: AndroidHere = {
      attached: [],
      avds: [avd('Nexus_5X', '8.0.5'), avd('Nexus_6P', '8.1')],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-nexus-6p-8.1',
      profile: { platform: 'android', model: 'Nexus 6P', os: '8.1' },
    })
    expectRunFinds(pick, listing, { avd: 'Nexus_6P' })
  })

  it('picks the running AVD with the newer OS', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(pixel7, 'emulator-5554'), emulatorOf(pixel9, 'emulator-5556')],
      avds: [pixel7, pixel9],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-9-15',
      profile: { platform: 'android', model: 'Pixel 9', os: '15' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_9', serial: 'emulator-5556' })
  })

  it('picks the running AVD whose name sorts first when their OS is the same', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(pixel9, 'emulator-5556'), emulatorOf(pixel8, 'emulator-5554')],
      avds: [pixel9, pixel8],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-8-15',
      profile: { platform: 'android', model: 'Pixel 8', os: '15' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_8', serial: 'emulator-5554' })
  })

  it('leaves os out of the entry and the name for an AVD with no OS', () => {
    const listing: AndroidHere = { attached: [], avds: [pixel6] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-6',
      profile: { platform: 'android', model: 'Pixel 6' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_6' })
  })

  it('leaves os out for an AVD that has only an API level', () => {
    const listing: AndroidHere = {
      attached: [],
      avds: [avd('Pixel_6', undefined, { apiLevel: '34' })],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-6',
      profile: { platform: 'android', model: 'Pixel 6' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_6' })
  })

  it('puts an AVD with no OS after an idle AVD whose OS is known', () => {
    const listing: AndroidHere = {
      attached: [],
      avds: [avd('Pixel_6', undefined, { apiLevel: '35' }), pixel7],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-7-14',
      profile: { platform: 'android', model: 'Pixel 7', os: '14' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_7' })
  })

  it('never picks a phone attached over USB', () => {
    expect(pickDeviceHere('android', { attached: [usbPhone], avds: [] })).toBeUndefined()
  })

  it('picks an idle AVD over a phone attached over USB', () => {
    const listing: AndroidHere = { attached: [usbPhone], avds: [pixel7] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-7-14',
      profile: { platform: 'android', model: 'Pixel 7', os: '14' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_7' })
  })

  it('does not count an AVD as running while its emulator is offline', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(pixel7, 'emulator-5554', { state: 'offline' })],
      avds: [pixel7, pixel9],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-9-15',
      profile: { platform: 'android', model: 'Pixel 9', os: '15' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_9' })
  })

  it('names an AVD by its own name when another AVD shares its display name and OS', () => {
    const twin = avd('Pixel_8_2', '15', { profile: 'pixel_8', displayName: 'Pixel 8' })
    const listing: AndroidHere = { attached: [], avds: [pixel8, twin] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-8-2-15',
      profile: { platform: 'android', model: 'Pixel_8_2', os: '15' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_8_2' })
  })

  it('keeps only a-z, 0-9, - and . in the name, and the display name as the model', () => {
    const displayName = '  Pixel [Work]: \u001b[31mphone\u001b[0m  '
    const listing: AndroidHere = { attached: [], avds: [avd('Pixel_Work', '15', { displayName })] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-work-31mphone-0m-15',
      profile: { platform: 'android', model: displayName, os: '15' },
    })
    expect(pick?.name).toMatch(/^[a-z0-9.-]+$/)
    expect(pick?.name).not.toMatch(/--|^-|-$/)
    expectRunFinds(pick, listing, { avd: 'Pixel_Work' })
  })

  it('picks the same AVD whatever order the machine lists its devices in', () => {
    const listing: AndroidHere = {
      attached: [
        emulatorOf(pixel9, 'emulator-5556'),
        usbPhone,
        emulatorOf(pixel8, 'emulator-5554'),
      ],
      avds: [pixel9, pixel8, pixel7, pixel6],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-8-15',
      profile: { platform: 'android', model: 'Pixel 8', os: '15' },
    })
    const avdsReversed: AndroidHere = { ...listing, avds: [...listing.avds].reverse() }
    const attachedReversed: AndroidHere = { ...listing, attached: [...listing.attached].reverse() }
    expect(pickDeviceHere('android', avdsReversed)).toEqual(pick)
    expect(pickDeviceHere('android', attachedReversed)).toEqual(pick)
    expectRunFinds(pick, listing, { avd: 'Pixel_8', serial: 'emulator-5554' })
  })
})

describe('pickDeviceHere among several simulators', () => {
  const firstUdid = '0A6B5E2C-4D1F-4A9E-9C3B-2F8E7D6A5B4C'
  const secondUdid = 'F3E21C8D-7B6A-4F5E-8D9C-1A2B3C4D5E6F'
  const ipad = simulator('iPad Air 13-inch (M3)', '18.4')
  const iphone = simulator('iPhone 16', '18.4')
  const iphonePicked: PickedDevice = {
    name: 'ios-simulator-iphone-16-18.4',
    profile: { platform: 'ios', model: 'iPhone 16', os: '18.4' },
  }

  it('adds the udid as id when two simulators share a name and an OS', () => {
    const listing: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.2', { udid: secondUdid }),
        simulator('iPhone 16', '18.2', { udid: firstUdid }),
      ],
    }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({
      name: 'ios-simulator-iphone-16-18.2',
      profile: { platform: 'ios', model: 'iPhone 16', os: '18.2', id: firstUdid },
    })
    expectRunFinds(pick, listing, { udid: firstUdid })
  })

  it('adds the udid as id for a booted simulator whose twin is shut down', () => {
    const listing: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.2', { udid: firstUdid }),
        simulator('iPhone 16', '18.2', { udid: secondUdid, state: 'Booted' }),
      ],
    }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({
      name: 'ios-simulator-iphone-16-18.2',
      profile: { platform: 'ios', model: 'iPhone 16', os: '18.2', id: secondUdid },
    })
    expectRunFinds(pick, listing, { udid: secondUdid })
  })

  it('picks an iPhone over an iPad when both are idle on one OS', () => {
    const listing: IOSHere = { simulators: [ipad, iphone] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual(iphonePicked)
    expectRunFinds(pick, listing, { udid: iphone.udid })
  })

  it('picks a booted iPad over an idle iPhone', () => {
    const booted = simulator('iPad Air 13-inch (M3)', '18.4', { state: 'Booted' })
    const listing: IOSHere = { simulators: [iphone, booted] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({
      name: 'ios-simulator-ipad-air-13-inch-m3-18.4',
      profile: { platform: 'ios', model: 'iPad Air 13-inch (M3)', os: '18.4' },
    })
    expectRunFinds(pick, listing, { udid: booted.udid })
  })

  it('picks an iPad on a newer OS over an iPhone on an older one', () => {
    const newer = simulator('iPad Air 13-inch (M3)', '18.5')
    const listing: IOSHere = { simulators: [simulator('iPhone 16', '18.2'), newer] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({
      name: 'ios-simulator-ipad-air-13-inch-m3-18.5',
      profile: { platform: 'ios', model: 'iPad Air 13-inch (M3)', os: '18.5' },
    })
    expectRunFinds(pick, listing, { udid: newer.udid })
  })

  it('never picks a simulator that is not available', () => {
    const unavailable = simulator('iPhone 17 Pro', '26.0', { available: false })
    const listing: IOSHere = { simulators: [unavailable, iphone] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual(iphonePicked)
    expectRunFinds(pick, listing, { udid: iphone.udid })
    expect(pickDeviceHere('ios', { simulators: [unavailable] })).toBeUndefined()
  })

  it('picks the same simulator whatever order the Mac lists them in', () => {
    const listing: IOSHere = {
      simulators: [
        simulator('iPhone 16', '18.4', { udid: secondUdid }),
        ipad,
        simulator('iPhone 16', '18.4', { udid: firstUdid }),
        simulator('iPhone 15', '17.5'),
      ],
    }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({ ...iphonePicked, profile: { ...iphonePicked.profile, id: firstUdid } })
    expect(pickDeviceHere('ios', { simulators: [...listing.simulators].reverse() })).toEqual(pick)
    expectRunFinds(pick, listing, { udid: firstUdid })
  })
})

describe('pickDeviceHere and the oldest OS the pinned Playground build installs on', () => {
  const pixel9 = avd('Pixel_9', '15')
  const nexus = avd('Nexus_5', '6.0')
  const iphone16 = simulator('iPhone 16', '18.4')
  const pixel9Picked: PickedDevice = {
    name: 'android-emulator-pixel-9-15',
    profile: { platform: 'android', model: 'Pixel 9', os: '15' },
  }
  const iphone16Picked: PickedDevice = {
    name: 'ios-simulator-iphone-16-18.4',
    profile: { platform: 'ios', model: 'iPhone 16', os: '18.4' },
  }

  it('picks an idle AVD the build installs on over a running one on Android 6', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(nexus, 'emulator-5554')],
      avds: [nexus, pixel9],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual(pixel9Picked)
    expectRunFinds(pick, listing, { avd: 'Pixel_9' })
  })

  it('picks an AVD on Android 7.0, written as 7 or as 7.0', () => {
    for (const os of ['7', '7.0']) {
      const listing: AndroidHere = { attached: [], avds: [nexus, avd('Nexus_6P', os)] }
      expect(pickDeviceHere('android', listing), os).toEqual({
        name: `android-emulator-nexus-6p-${os}`,
        profile: { platform: 'android', model: 'Nexus 6P', os },
      })
    }
  })

  it('picks nothing when every AVD is older than Android 7.0', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(nexus, 'emulator-5554')],
      avds: [nexus, avd('Nexus_4', '5.1')],
    }
    expect(pickDeviceHere('android', listing)).toBeUndefined()
  })

  it('keeps an AVD with no OS, which nothing shows to be too old', () => {
    const listing: AndroidHere = {
      attached: [emulatorOf(nexus, 'emulator-5554')],
      avds: [nexus, avd('Pixel_6')],
    }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-6',
      profile: { platform: 'android', model: 'Pixel 6' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_6' })
  })

  it('keeps an AVD whose OS is a name and not a version', () => {
    const listing: AndroidHere = { attached: [], avds: [nexus, avd('Pixel_Preview', 'Baklava')] }
    const pick = pickDeviceHere('android', listing)
    expect(pick).toEqual({
      name: 'android-emulator-pixel-preview-baklava',
      profile: { platform: 'android', model: 'Pixel Preview', os: 'Baklava' },
    })
    expectRunFinds(pick, listing, { avd: 'Pixel_Preview' })
  })

  it('picks an idle simulator the build installs on over a booted one on iOS 14', () => {
    const old = simulator('iPhone 12', '14.5', { state: 'Booted' })
    const listing: IOSHere = { simulators: [old, iphone16] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual(iphone16Picked)
    expectRunFinds(pick, listing, { udid: iphone16.udid })
  })

  it('picks a simulator on iOS 15.1 and none on iOS 15.0', () => {
    const below = simulator('iPhone 13', '15.0')
    const floor = simulator('iPhone 13', '15.1')
    expect(pickDeviceHere('ios', { simulators: [below] })).toBeUndefined()
    const listing: IOSHere = { simulators: [below, floor] }
    const pick = pickDeviceHere('ios', listing)
    expect(pick).toEqual({
      name: 'ios-simulator-iphone-13-15.1',
      profile: { platform: 'ios', model: 'iPhone 13', os: '15.1' },
    })
    expectRunFinds(pick, listing, { udid: floor.udid })
  })

  it('takes the oldest OS it is handed in place of the pinned one', () => {
    const listing: IOSHere = { simulators: [iphone16, simulator('iPhone 17', '26.0')] }
    expect(pickDeviceHere('ios', listing, '26.1')).toBeUndefined()
    expect(pickDeviceHere('ios', { simulators: [iphone16] }, '18.4')).toEqual(iphone16Picked)
    expect(pickDeviceHere('android', { attached: [], avds: [pixel9] }, '16')).toBeUndefined()
  })
})

describe('findInitDevices', () => {
  const pixel = avd('Pixel_10_Pro', '17')
  const iphone = simulator('iPhone 18 Pro', '27.0', { state: 'Booted' })

  // Answers each runtime with its listing, or throws the error given for it.
  function lister(answers: { android?: AndroidHere | Error; ios?: IOSHere | Error }): {
    list: DevicesHereLister
    listed: string[]
  } {
    const listed: string[] = []
    const list: DevicesHereLister = async (platform) => {
      listed.push(platform)
      const answer = answers[platform]
      if (answer === undefined) throw new Error(`no ${platform} listing was handed in`)
      if (answer instanceof Error) throw answer
      return answer
    }
    return { list, listed }
  }

  it('picks one device per runtime and names its model, OS and entry in one line each', async () => {
    const { list } = lister({
      android: { attached: [], avds: [pixel] },
      ios: { simulators: [iphone] },
    })

    const found = await findInitDevices(['android', 'ios'], list)

    expect(found.lines).toEqual([
      'Android device: Pixel 10 Pro (Android 17) as android-emulator-pixel-10-pro-17',
      'iOS device: iPhone 18 Pro (iOS 27.0) as ios-simulator-iphone-18-pro-27.0',
    ])
    expect(found.devices).toEqual({
      android: {
        name: 'android-emulator-pixel-10-pro-17',
        profile: { platform: 'android', model: 'Pixel 10 Pro', os: '17' },
      },
      ios: {
        name: 'ios-simulator-iphone-18-pro-27.0',
        profile: { platform: 'ios', model: 'iPhone 18 Pro', os: '27.0' },
      },
    })
  })

  it('leaves the brackets out of the line of a pick with no OS', async () => {
    const { list } = lister({ android: { attached: [], avds: [avd('Pixel_6')] } })

    const found = await findInitDevices(['android'], list)

    expect(found.lines).toEqual(['Android device: Pixel 6 as android-emulator-pixel-6'])
  })

  it('prints a model without its escape sequence and newline, and keeps the entry as listed', async () => {
    const displayName = 'Pixel \u001b[31m10\u001b[0m Pro\n'
    const listing: AndroidHere = {
      attached: [],
      avds: [avd('Pixel_10_Pro', '17', { displayName })],
    }

    const found = await findInitDevices(['android'], lister({ android: listing }).list)

    expect(found.lines).toEqual([
      'Android device: Pixel 10 Pro (Android 17) as android-emulator-pixel-31m10-0m-pro-17',
    ])
    expect(found.devices.android?.profile.model).toBe(displayName)
  })

  it('prints a listing problem and a lister error without their control characters', async () => {
    const { list } = lister({
      android: new Error('adb \u001b[31mexited 1\u001b[0m\n'),
      ios: { simulators: [], problem: 'xcrun simctl failed: \u0007busy' },
    })

    const found = await findInitDevices(['android', 'ios'], list)

    expect(found.devices).toEqual({})
    expect(found.lines).toEqual([
      "Android device: none found (could not list this machine's devices: adb exited 1). " +
        'Describe one under registry.devices and set device on ' +
        'registry.targets.playground-android once this machine has one.',
      'iOS device: none found (xcrun simctl failed: busy). Describe one under registry.devices ' +
        'and set device on registry.targets.playground-ios once this machine has one.',
    ])
  })

  it('lists the runtimes in the order given, once each', async () => {
    const { list, listed } = lister({
      android: { attached: [], avds: [pixel] },
      ios: { simulators: [iphone] },
    })

    const found = await findInitDevices(['ios', 'android'], list)

    expect(listed).toEqual(['ios', 'android'])
    expect(found.lines.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
      'iOS device',
      'Android device',
    ])
  })

  it('does not say none was found when the machine lists emulators or simulators it cannot pick', async () => {
    const { list } = lister({
      android: {
        attached: [emulatorOf(pixel, 'emulator-5554', { state: 'offline' })],
        avds: [pixel],
      },
      ios: { simulators: [simulator('iPhone 17 Pro', '26.0', { available: false })] },
    })

    const found = await findInitDevices(['android', 'ios'], list)

    expect(found.devices).toEqual({})
    expect(found.lines).toEqual([
      "Android device: none of this machine's emulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-android.',
      "iOS device: none of this machine's simulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-ios.',
    ])
  })

  it('says none could be picked when every emulator and simulator is older than the pinned build installs on', async () => {
    const old = avd('Nexus_5', '6.0')
    const { list } = lister({
      android: { attached: [emulatorOf(old, 'emulator-5554')], avds: [old] },
      ios: { simulators: [simulator('iPhone 12', '14.5', { state: 'Booted' })] },
    })

    const found = await findInitDevices(['android', 'ios'], list)

    expect(found.devices).toEqual({})
    expect(found.lines).toEqual([
      "Android device: none of this machine's emulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-android.',
      "iOS device: none of this machine's simulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-ios.',
    ])
  })

  it('takes the oldest OS of each runtime from the pin it is handed', async () => {
    const { list } = lister({
      android: { attached: [], avds: [pixel] },
      ios: { simulators: [iphone] },
    })
    const pin = {
      ...PLAYGROUND_APP_PIN,
      android: { ...PLAYGROUND_APP_PIN.android, minOs: '17' },
      ios: { ...PLAYGROUND_APP_PIN.ios, minOs: '27.1' },
    }

    const found = await findInitDevices(['android', 'ios'], list, pin)

    expect(Object.keys(found.devices)).toEqual(['android'])
    expect(found.lines).toEqual([
      'Android device: Pixel 10 Pro (Android 17) as android-emulator-pixel-10-pro-17',
      "iOS device: none of this machine's simulators could be picked. Describe one under " +
        'registry.devices and set device on registry.targets.playground-ios.',
    ])
  })
})
