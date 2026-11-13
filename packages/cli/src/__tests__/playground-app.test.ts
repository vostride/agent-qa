import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitFileResult } from '../commands/init-filesystem.js'
import {
  downloadPlaygroundApps,
  fetchReleaseAsset,
  type PlaygroundAppsInput,
} from '../commands/playground-app.js'
import { PLAYGROUND_APP_PIN, playgroundAppUrl } from '../commands/playground-app-pin.js'
import {
  cleanupTempProjects,
  fakePlaygroundApp,
  tempProject,
  type FakePlaygroundApp,
} from './project-fixtures.js'

const APK = 'playground-android-26.11.02-1ba82a3.apk'
const RELEASE = 'mobile-26.11.02-1ba82a3'
const REPOSITORY = 'github.com/vostride/playground'

afterEach(() => {
  cleanupTempProjects()
})

async function download(
  root: string,
  app: FakePlaygroundApp,
  overrides: Partial<PlaygroundAppsInput> = {},
) {
  const recorded: InitFileResult[] = []
  const input: PlaygroundAppsInput = {
    dir: root,
    runtimes: ['android'],
    pin: app.source.pin,
    fetch: app.source.fetch,
    exists: existsSync,
    force: false,
    signal: new AbortController().signal,
    record: (result) => {
      recorded.push(result)
    },
    ...overrides,
  }
  return { result: await downloadPlaygroundApps(input), recorded, signal: input.signal }
}

describe('downloading the Playground app for Android', () => {
  it('publishes bytes that match the pin as the APK in app-bundles and records it as created', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app)

    const apk = join(root, 'app-bundles', APK)
    expect(result).toEqual({ arrived: ['android'], failures: [] })
    expect(readFileSync(apk)).toEqual(Buffer.from(app.bytes.android))
    expect(recorded).toEqual([{ path: apk, outcome: 'created' }])
  })

  it("asks for the pinned release's APK at its pinned size with the caller's signal", async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp()

    const { signal } = await download(root, app)

    expect(app.requests).toEqual([
      {
        url: `https://github.com/vostride/playground/releases/download/${RELEASE}/${APK}`,
        maxBytes: app.source.pin.android.bytes,
        signal,
      },
    ])
  })

  it('publishes nothing when the sha256 is not the pinned one, and the failure names the file, the release and the repository', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp({ android: new TextEncoder().encode('another build') })

    const { result, recorded } = await download(root, app)

    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'android',
          reason:
            'The Playground app for Android was not downloaded: its sha256 is not the pinned ' +
            `one. It is ${APK} in release ${RELEASE} of ${REPOSITORY}.`,
        },
      ],
    })
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
    expect(recorded).toEqual([])
  })

  it('resolves with a failure that carries the message when the fetcher rejects with a TypeError', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp({ android: new TypeError('fetch failed') })

    const { result } = await download(root, app)

    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'android',
          reason: expect.stringContaining('was not downloaded: fetch failed. It is'),
        },
      ],
    })
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
  })

  it('keeps an APK that is already there and asks for nothing', async () => {
    const { root } = tempProject('playground-app')
    const apk = join(root, 'app-bundles', APK)
    mkdirSync(join(root, 'app-bundles'))
    writeFileSync(apk, 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app)

    expect(app.requests).toEqual([])
    expect(recorded).toEqual([{ path: apk, outcome: 'preserved' }])
    expect(result).toEqual({ arrived: ['android'], failures: [] })
    expect(readFileSync(apk, 'utf8')).toBe('an older build')
  })

  it('with force fetches the APK again and writes it over the one that is there', async () => {
    const { root } = tempProject('playground-app')
    const apk = join(root, 'app-bundles', APK)
    mkdirSync(join(root, 'app-bundles'))
    writeFileSync(apk, 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app, { force: true })

    expect(app.requests.map((request) => request.url)).toEqual([
      playgroundAppUrl(app.source.pin, 'android'),
    ])
    expect(readFileSync(apk)).toEqual(Buffer.from(app.bytes.android))
    expect(recorded).toEqual([{ path: apk, outcome: 'updated' }])
    expect(result).toEqual({ arrived: ['android'], failures: [] })
  })
})

describe('fetching a release file', () => {
  const url = playgroundAppUrl(PLAYGROUND_APP_PIN, 'android')

  function answering(response: Response) {
    return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response)
  }

  // A high-water mark of zero pulls a chunk only when the reader asks for one.
  function streamOf(chunk: () => Uint8Array, reads: { count: number }) {
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads.count += 1
          if (reads.count > 100) controller.error(new Error('the body was read past its limit'))
          else controller.enqueue(chunk())
        },
      },
      { highWaterMark: 0 },
    )
  }

  it("returns a 200 answer's body, and the request follows redirects and sends no header, body or method", async () => {
    const body = new TextEncoder().encode('the release file')
    const fetchImpl = answering(new Response(body, { status: 200 }))
    const caller = new AbortController()

    const bytes = await fetchReleaseAsset({
      url,
      maxBytes: body.byteLength,
      signal: caller.signal,
      fetchImpl,
      timeoutMs: 60_000,
    })

    expect(bytes).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [called, init] = fetchImpl.mock.calls[0] ?? []
    expect(called).toBe(url)
    expect(Object.keys(init ?? {}).sort()).toEqual(['redirect', 'signal'])
    expect(init?.redirect).toBe('follow')
    expect(init?.signal?.aborted).toBe(false)
    caller.abort()
    expect(init?.signal?.aborted).toBe(true)
  })

  it('rejects an answer that is not 200 with the status in its message', async () => {
    const fetchImpl = answering(new Response('Not Found', { status: 404 }))

    await expect(
      fetchReleaseAsset({
        url,
        maxBytes: 100,
        signal: new AbortController().signal,
        fetchImpl,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow('GitHub answered 404')
  })

  it('rejects a content-length above the pinned size before it reads the body', async () => {
    const reads = { count: 0 }
    const response = new Response(
      streamOf(() => new Uint8Array(8), reads),
      { status: 200, headers: { 'content-length': '11' } },
    )

    await expect(
      fetchReleaseAsset({
        url,
        maxBytes: 10,
        signal: new AbortController().signal,
        fetchImpl: answering(response),
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow('the file is larger than its pinned 10 bytes')
    expect(reads.count).toBe(0)
  })

  it('stops reading a body with no content-length once it runs past the pinned size', async () => {
    const reads = { count: 0 }
    const response = new Response(streamOf(() => new Uint8Array(4), reads), { status: 200 })

    await expect(
      fetchReleaseAsset({
        url,
        maxBytes: 10,
        signal: new AbortController().signal,
        fetchImpl: answering(response),
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow('the file is larger than its pinned 10 bytes')
    expect(reads.count).toBe(3)
  })
})

describe('the pinned release', () => {
  it("names the iOS build in the same release by the zip's file name", () => {
    expect(playgroundAppUrl(PLAYGROUND_APP_PIN, 'ios')).toBe(
      `https://github.com/vostride/playground/releases/download/${RELEASE}/` +
        'playground-ios-simulator-26.11.02-1ba82a3.zip',
    )
  })
})
