// Live against an emulator behind an Appium started separately, which the cell treats as a remote.
// Skipped without the live flag and that Appium's URL.

import { afterEach, describe, expect, it } from 'vitest'
import { formatRemoteOrigin, remoteOrigin } from '@vostride/agent-qa-schema'
import { AndroidPlatformAdapter } from '../adapter.js'
import { listAndroidDevicesHere } from '../devices-here.js'
import type { AndroidAdapterConfig } from '../types.js'

const LIVE = process.env.AGENT_QA_ANDROID_LIVE === '1'
const APPIUM_URL = process.env.AGENT_QA_LIVE_APPIUM_URL
const SETTINGS = 'com.android.settings'

async function sessionAnswer(url: string, sessionId: string): Promise<unknown> {
  const base = url.endsWith('/') ? url : `${url}/`
  const reply = await fetch(new URL(`session/${sessionId}/timeouts`, base))
  return ((await reply.json()) as { value?: unknown }).value
}

describe.skipIf(!LIVE || APPIUM_URL === undefined)(
  'an emulator behind a separately started Appium as a remote device',
  () => {
    let adapter: AndroidPlatformAdapter | undefined

    afterEach(async () => {
      try {
        await adapter?.cleanup()
      } finally {
        adapter = undefined
      }
    }, 120_000)

    it('opens on the remote, reads a page source, records the remote and deletes the session', async () => {
      const url = APPIUM_URL as string
      const listing = await listAndroidDevicesHere()
      expect(listing.problem).toBeUndefined()
      const emulator = listing.attached.find(
        (device) =>
          device.state === 'device' &&
          (device.avd !== undefined || device.serial.startsWith('emulator-')),
      )
      expect(emulator, 'an emulator is running on this machine').toBeDefined()
      const model = emulator?.model ?? emulator?.avd
      expect(model, 'the emulator reports a model').toBeDefined()

      const config: AndroidAdapterConfig = {
        platform: 'android',
        appPackage: SETTINGS,
        appActivity: '.Settings',
        device: {
          name: 'live-emulator',
          platform: 'android',
          model: model as string,
          remote: { name: 'live', protocol: 'appium', url, connectTimeoutMs: 300_000 },
        },
      }
      adapter = new AndroidPlatformAdapter()
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
        device: 'live-emulator',
      })
      const recorded = evidence as { appiumVersion?: string; sessionId?: string }
      expect(recorded.appiumVersion).toMatch(/^\d+\.\d+/)
      expect(recorded.sessionId).toBeDefined()

      await adapter.cleanup()
      adapter = undefined
      expect(await sessionAnswer(url, recorded.sessionId as string)).toMatchObject({
        error: 'invalid session id',
      })
    }, 600_000)
  },
)
