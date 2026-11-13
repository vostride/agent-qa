// The setup guard refuses the default Playground download and fails the test that reached it,
// outside a test the default hands its request to fetchReleaseAsset with the global fetch and the
// download's deadline, and the shared fakes a test hands init answer without reaching a default.
import { createHash } from 'node:crypto'

import type { IOSHere } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlaygroundAppRequest } from '../commands/playground-app.js'
import { fetchPlaygroundAppByDefault } from '../commands/playground-app-fetch.js'
import type * as PlaygroundAppFetchModule from '../commands/playground-app-fetch.js'
import {
  PLAYGROUND_APP_PIN,
  playgroundAppUrl,
  type PlaygroundAppPin,
} from '../commands/playground-app-pin.js'
import { mobileInitFakes } from './project-fixtures.js'
import { assertNoGuardedCalls, takeGuardedCalls } from './test-side-effect-guard.js'

const releaseAssetCalls = vi.hoisted(() => [] as unknown[])

vi.mock('../commands/playground-app.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../commands/playground-app.js')>()
  const fetchReleaseAsset: typeof real.fetchReleaseAsset = async (options) => {
    releaseAssetCalls.push(options)
    return new Uint8Array()
  }
  return { ...real, fetchReleaseAsset }
})

const REFUSAL = 'A test reached the Playground release. Inject hooks.playgroundApp.'

function androidRequest(pin: PlaygroundAppPin = PLAYGROUND_APP_PIN): PlaygroundAppRequest {
  return {
    url: playgroundAppUrl(pin, 'android'),
    maxBytes: pin.android.bytes,
    signal: new AbortController().signal,
  }
}

afterEach(() => {
  releaseAssetCalls.length = 0
})

describe('the default Playground download in a test', () => {
  it('is refused before any request and records it', async () => {
    const refusal = await fetchPlaygroundAppByDefault(androidRequest()).then(
      () => 'the download answered',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    expect(refusal).toBe(REFUSAL)
    expect(takeGuardedCalls()).toEqual(['playground release'])
    expect(releaseAssetCalls).toEqual([])
  })

  it('the check after each test names the hook to inject', async () => {
    await fetchPlaygroundAppByDefault(androidRequest()).catch(() => undefined)

    expect(() => assertNoGuardedCalls()).toThrow(
      /^1 real side effects reached from this test: playground release\. Inject hooks\.playgroundApp\.$/u,
    )
    expect(takeGuardedCalls()).toEqual([])
  })
})

describe('the default Playground download outside a test', () => {
  it('hands fetchReleaseAsset the global fetch and a 600,000 ms deadline', async () => {
    const real = await vi.importActual<typeof PlaygroundAppFetchModule>(
      '../commands/playground-app-fetch.js',
    )
    const request = androidRequest()

    await real.fetchPlaygroundAppByDefault(request)

    expect(real.PLAYGROUND_APP_DEADLINE_MS).toBe(600_000)
    expect(releaseAssetCalls).toEqual([
      { ...request, fetchImpl: globalThis.fetch, timeoutMs: 600_000 },
    ])
  })
})

describe('the shared fakes for a fresh mobile init', () => {
  it('answer without the default', async () => {
    const fakes = mobileInitFakes()

    expect(await fakes.hooks.listDevicesHere('android')).toEqual({ attached: [], avds: [] })
    expect(await fakes.hooks.listDevicesHere('ios')).toEqual({ simulators: [] })
    expect(fakes.listed).toEqual(['android', 'ios'])

    const { pin } = fakes.hooks.playgroundApp
    const request = androidRequest(pin)
    const bytes = await fakes.hooks.playgroundApp.fetch(request)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.android.sha256)
    expect(fakes.requests).toEqual([request])

    const ios: IOSHere = {
      simulators: [
        {
          name: 'iPhone 18 Pro',
          udid: 'iPhone-18-Pro-27.0',
          os: '27.0',
          state: 'Booted',
          available: true,
        },
      ],
    }
    const handed = mobileInitFakes({ ios })
    expect(await handed.hooks.listDevicesHere('ios')).toBe(ios)
    expect(await handed.hooks.listDevicesHere('android')).toEqual({ attached: [], avds: [] })

    expect(takeGuardedCalls()).toEqual([])
  })
})
