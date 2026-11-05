// Live against this machine's adb, emulator and AVD home; skipped without the live flag.

import { describe, expect, it } from 'vitest'
import { findDeviceHere } from '@vostride/agent-qa-core'
import { listAndroidDevicesHere } from '../devices-here.js'

const LIVE = process.env.AGENT_QA_ANDROID_LIVE === '1'

describe.skipIf(!LIVE)("this machine's Android devices as the lister finds them", () => {
  it('lists every AVD by name, and the finder resolves the first AVD by its display name', async () => {
    const listing = await listAndroidDevicesHere()
    expect(listing.problem).toBeUndefined()
    expect(listing.avds.length, 'this machine has an AVD').toBeGreaterThan(0)
    for (const avd of listing.avds) expect(avd.name.trim()).not.toBe('')

    const avd = listing.avds[0]!
    const result = findDeviceHere({
      device: 'live',
      platform: 'android',
      model: avd.displayName ?? avd.name,
      android: listing,
    })

    const running = listing.attached.find(
      (device) => device.avd === avd.name && device.state === 'device',
    )
    const expected =
      running !== undefined
        ? { udid: running.serial, running: true }
        : { avd: avd.name, running: false }
    expect(result).toMatchObject({ found: expected })
  }, 60_000)
})
