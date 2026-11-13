// The setup guard refuses the default Playground download and fails the test that reached it, and
// outside a test the default hands its request to fetchReleaseAsset with the global fetch and the
// download's deadline.
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlaygroundAppRequest } from '../commands/playground-app.js'
import { fetchPlaygroundAppByDefault } from '../commands/playground-app-fetch.js'
import type * as PlaygroundAppFetchModule from '../commands/playground-app-fetch.js'
import { PLAYGROUND_APP_PIN, playgroundAppUrl } from '../commands/playground-app-pin.js'
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

function androidRequest(): PlaygroundAppRequest {
  return {
    url: playgroundAppUrl(PLAYGROUND_APP_PIN, 'android'),
    maxBytes: PLAYGROUND_APP_PIN.android.bytes,
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
