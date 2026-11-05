// Live against this Mac's simctl; skipped without the live flag.

import { describe, expect, it } from 'vitest'
import { findDeviceHere } from '@vostride/agent-qa-core'
import { listIOSSimulatorsHere } from '../simulators-here.js'

const LIVE = process.env.AGENT_QA_IOS_LIVE === '1'

describe.skipIf(!LIVE)("this Mac's simulators as the lister finds them", () => {
  it('lists simulators with no problem, and the finder resolves the first by name and os to its udid', async () => {
    const listing = await listIOSSimulatorsHere()
    expect(listing.problem).toBeUndefined()
    const simulator = listing.simulators.find((candidate) => candidate.available)
    expect(simulator, 'this Mac has an available simulator').toBeDefined()

    const result = findDeviceHere({
      device: 'live',
      platform: 'ios',
      model: simulator!.name,
      os: simulator!.os,
      ios: listing,
    })

    expect(result).toMatchObject({
      found: { udid: simulator!.udid, name: simulator!.name, os: simulator!.os },
    })
  }, 60_000)
})
