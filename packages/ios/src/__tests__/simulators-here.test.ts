import { describe, expect, it } from 'vitest'
import { findDeviceHere } from '@vostride/agent-qa-core'
import { listIOSSimulatorsHere } from '../simulators-here.js'
import type { ListingExec } from '../simulators-here.js'

const RUNTIMES = {
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      version: '27.0',
      platform: 'iOS',
      isAvailable: true,
      name: 'iOS 27.0',
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      version: '26.4.1',
      platform: 'iOS',
      isAvailable: true,
      name: 'iOS 26.4',
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-13-0',
      version: '13.0',
      platform: 'watchOS',
      isAvailable: true,
      name: 'watchOS 13.0',
    },
  ],
}

const DEVICES = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      {
        name: 'iPhone 18 Pro',
        udid: '6F1B2C3D-0000-4000-8000-000000000001',
        state: 'Booted',
        isAvailable: true,
      },
      {
        name: 'iPhone 17',
        udid: '6F1B2C3D-0000-4000-8000-000000000002',
        state: 'Shutdown',
        isAvailable: false,
        availabilityError: 'runtime profile not found',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
      {
        name: 'iPhone 16e',
        udid: '6F1B2C3D-0000-4000-8000-000000000003',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-13-0': [
      {
        name: 'Apple Watch Series 11 (46mm)',
        udid: '6F1B2C3D-0000-4000-8000-000000000004',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
  },
}

type Reply = unknown | { error: Record<string, unknown> }

function fakeExec(runtimes: Reply, devices: Reply) {
  const calls: string[] = []
  const exec: ListingExec = async (file, args, options) => {
    expect(options.timeout).toBe(10_000)
    calls.push([file, ...args].join(' '))
    expect(file).toBe('xcrun')
    const reply = args.includes('runtimes') ? runtimes : devices
    if (reply !== null && typeof reply === 'object' && 'error' in reply) {
      throw Object.assign(new Error('command failed'), (reply as { error: object }).error)
    }
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply) }
  }
  return { exec, calls }
}

describe('listIOSSimulatorsHere', () => {
  it('lists available iOS simulators with the exact version of their runtime', async () => {
    const { exec, calls } = fakeExec(RUNTIMES, DEVICES)

    const listing = await listIOSSimulatorsHere({ exec, platform: 'darwin' })

    expect(listing).toEqual({
      simulators: [
        {
          name: 'iPhone 18 Pro',
          udid: '6F1B2C3D-0000-4000-8000-000000000001',
          os: '27.0',
          state: 'Booted',
          available: true,
        },
        {
          name: 'iPhone 16e',
          udid: '6F1B2C3D-0000-4000-8000-000000000003',
          os: '26.4.1',
          state: 'Shutdown',
          available: true,
        },
      ],
    })
    expect(calls).toEqual([
      'xcrun simctl list runtimes --json',
      'xcrun simctl list devices --json',
    ])
    expect(
      findDeviceHere({
        device: 'iphone',
        platform: 'ios',
        model: 'iPhone 18 Pro',
        os: '27',
        ios: listing,
      }),
    ).toEqual({
      found: expect.objectContaining({ udid: '6F1B2C3D-0000-4000-8000-000000000001', os: '27.0' }),
    })
  })

  it('says simulators need macOS on any other host and runs nothing', async () => {
    const { exec, calls } = fakeExec(RUNTIMES, DEVICES)

    const listing = await listIOSSimulatorsHere({ exec, platform: 'linux' })

    expect(listing).toEqual({ simulators: [], problem: 'simulators need macOS' })
    expect(calls).toEqual([])
  })

  it('reports a missing xcrun as a problem', async () => {
    const { exec } = fakeExec({ error: { code: 'ENOENT' } }, DEVICES)

    const listing = await listIOSSimulatorsHere({ exec, platform: 'darwin' })

    expect(listing).toEqual({ simulators: [], problem: 'xcrun not found (install Xcode)' })
  })

  it('reports simctl that does not answer as a problem instead of throwing', async () => {
    const { exec } = fakeExec(RUNTIMES, { error: { killed: true, signal: 'SIGKILL' } })

    const listing = await listIOSSimulatorsHere({ exec, platform: 'darwin' })

    expect(listing).toEqual({
      simulators: [],
      problem: 'xcrun simctl did not answer within 10 s',
    })
  })

  it('reports a failing simctl with its first error line', async () => {
    const { exec } = fakeExec(
      {
        error: {
          code: 72,
          stderr: 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\n',
        },
      },
      DEVICES,
    )

    const listing = await listIOSSimulatorsHere({ exec, platform: 'darwin' })

    expect(listing).toEqual({
      simulators: [],
      problem:
        'xcrun simctl failed: xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
    })
  })

  it('reports output that is not JSON as a problem', async () => {
    const { exec } = fakeExec(RUNTIMES, 'Simulator service unavailable')

    const listing = await listIOSSimulatorsHere({ exec, platform: 'darwin' })

    expect(listing).toEqual({
      simulators: [],
      problem: 'xcrun simctl list devices printed something other than JSON',
    })
  })
})
