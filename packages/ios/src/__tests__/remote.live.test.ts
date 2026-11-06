// Live against a simulator behind an Appium started separately, which the cell treats as a remote.
// Skipped without the live flag and that Appium's URL. The first session may build WebDriverAgent.

import { afterEach, describe, expect, it } from 'vitest'
import { formatRemoteOrigin, remoteOrigin } from '@vostride/agent-qa-schema'
import { IOSPlatformAdapter } from '../adapter.js'
import { listIOSSimulatorsHere } from '../simulators-here.js'
import type { IOSAdapterConfig } from '../types.js'

const LIVE = process.env.AGENT_QA_IOS_LIVE === '1'
const APPIUM_URL = process.env.AGENT_QA_LIVE_APPIUM_URL
const SETTINGS = 'com.apple.Preferences'
const CONNECT_TIMEOUT_MS = 900_000

async function sessionAnswer(url: string, sessionId: string): Promise<unknown> {
  const base = url.endsWith('/') ? url : `${url}/`
  const reply = await fetch(new URL(`session/${sessionId}/timeouts`, base))
  return ((await reply.json()) as { value?: unknown }).value
}

describe.skipIf(!LIVE || APPIUM_URL === undefined)(
  'a simulator behind a separately started Appium as a remote device',
  () => {
    let adapter: IOSPlatformAdapter | undefined

    afterEach(async () => {
      try {
        await adapter?.cleanup()
      } finally {
        adapter = undefined
      }
    }, 120_000)

    it('is selected by model and os, probes as a simulator, records the remote and deletes the session', async () => {
      const url = APPIUM_URL as string
      const listing = await listIOSSimulatorsHere()
      expect(listing.problem).toBeUndefined()
      const available = listing.simulators.filter((simulator) => simulator.available)
      // A booted simulator first, so the cell does not wait for a boot it does not need.
      const simulator =
        available.find((candidate) => candidate.state === 'Booted') ?? available[0]
      expect(simulator, 'this Mac has an available simulator').toBeDefined()

      const config: IOSAdapterConfig = {
        platform: 'ios',
        bundleId: SETTINGS,
        device: {
          name: 'live-simulator',
          platform: 'ios',
          model: simulator!.name,
          os: simulator!.os,
          // Otherwise XCUITest restarts a windowless simulator to show it, needing Simulator.app.
          capabilities: { 'appium:isHeadless': true },
          remote: {
            name: 'live',
            protocol: 'appium',
            url,
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
          },
        },
      }
      adapter = new IOSPlatformAdapter()
      await adapter.setup(config)

      const screen = await adapter.observe()
      expect(screen.tree.length).toBeGreaterThan(0)
      expect(screen.elements.length).toBeGreaterThan(0)

      const evidence = adapter.placeEvidence
      expect(evidence).toMatchObject({
        place: 'remote',
        name: 'live',
        protocol: 'appium',
        origin: formatRemoteOrigin(remoteOrigin(url)!),
        device: 'live-simulator',
        deviceType: 'simulator',
      })
      expect(evidence).not.toHaveProperty('appiumVersion')
      const recorded = evidence as { sessionId?: string }
      expect(recorded.sessionId).toBeDefined()

      await adapter.cleanup()
      adapter = undefined
      expect(await sessionAnswer(url, recorded.sessionId as string)).toMatchObject({
        error: 'invalid session id',
      })
    }, CONNECT_TIMEOUT_MS + 300_000)
  },
)
