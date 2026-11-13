import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitFileResult } from '../commands/init-filesystem.js'
import {
  downloadPlaygroundApps,
  fetchReleaseAsset,
  type PlaygroundAppsInput,
} from '../commands/playground-app.js'
import {
  PLAYGROUND_APP_PIN,
  playgroundAppUrl,
  type PlaygroundAppPin,
} from '../commands/playground-app-pin.js'
import {
  buildZip,
  cleanupTempProjects,
  fakePlaygroundApp,
  fakePlaygroundIosEntries,
  tempProject,
  type FakePlaygroundApp,
  type ZipFixtureEntry,
} from './project-fixtures.js'

const APK = 'playground-android-26.11.02-1ba82a3.apk'
const ZIP = 'playground-ios-simulator-26.11.02-1ba82a3.zip'
const RELEASE = 'mobile-26.11.02-1ba82a3'
const REPOSITORY = 'github.com/vostride/playground'

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

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
      `https://github.com/vostride/playground/releases/download/${RELEASE}/${ZIP}`,
    )
  })
})

describe('downloading the Playground app for iOS', () => {
  function pinnedTo(archive: Uint8Array): PlaygroundAppPin {
    return {
      ...PLAYGROUND_APP_PIN,
      ios: {
        file: PLAYGROUND_APP_PIN.ios.file,
        sha256: createHash('sha256').update(archive).digest('hex'),
        bytes: archive.byteLength,
      },
    }
  }

  it('unzips the pinned build into app-bundles/Playground.app with each file and its mode, and keeps no zip', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app, { runtimes: ['ios'] })

    expect(result).toEqual({ arrived: ['ios'], failures: [] })
    expect(recorded).toEqual([
      { path: join(root, 'app-bundles', 'Playground.app'), outcome: 'created' },
    ])
    for (const entry of fakePlaygroundIosEntries()) {
      const path = join(root, 'app-bundles', entry.name)
      if (entry.name.endsWith('/')) {
        expect(statSync(path).isDirectory(), entry.name).toBe(true)
      } else {
        expect(readFileSync(path), entry.name).toEqual(Buffer.from(entry.bytes))
        expect(statSync(path).mode & 0o777, entry.name).toBe((entry.mode ?? 0) & 0o777)
      }
    }
    const executable = 'app-bundles/Playground.app/Frameworks/hermesvm.framework/hermesvm'
    expect(statSync(join(root, executable)).mode & 0o777).toBe(0o755)
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    expect(files.filter((path) => path.endsWith('.zip'))).toEqual([])
  })

  it('refuses bytes whose sha256 is not the pinned one before it reads them as a zip', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp({ ios: text('these bytes are not a zip') })

    const { result, recorded } = await download(root, app, { runtimes: ['ios'] })

    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'ios',
          reason:
            'The Playground app for iOS was not downloaded: its sha256 is not the pinned one. ' +
            `It is ${ZIP} in release ${RELEASE} of ${REPOSITORY}.`,
        },
      ],
    })
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
    expect(recorded).toEqual([])
  })

  const valid: ZipFixtureEntry = {
    name: 'Playground.app/Info.plist',
    bytes: text('a valid entry\n'),
    mode: 0o100644,
  }

  const refusals = [
    {
      label: 'an entry that climbs out of Playground.app',
      archive: () =>
        buildZip([valid, { name: 'Playground.app/../../outside.txt', bytes: text('outside\n') }]),
      says: 'Playground.app/../../outside.txt is outside Playground.app',
    },
    {
      label: 'an entry outside the Playground.app folder',
      archive: () => buildZip([valid, { name: 'elsewhere/file.txt', bytes: text('elsewhere\n') }]),
      says: 'elsewhere/file.txt is outside Playground.app',
    },
    {
      label: 'a symbolic link entry',
      archive: () =>
        buildZip([
          valid,
          { name: 'Playground.app/link', bytes: text('Info.plist'), mode: 0o120777 },
        ]),
      says: 'Playground.app/link is a symbolic link',
    },
    {
      label: 'an encrypted entry',
      archive: () =>
        buildZip([valid, { name: 'Playground.app/sealed', bytes: text('sealed\n'), flags: 0x1 }]),
      says: 'Playground.app/sealed is encrypted',
    },
    {
      label: 'an entry compressed with a method other than stored or deflate',
      archive: () =>
        buildZip([valid, { name: 'Playground.app/packed', bytes: text('packed\n'), method: 12 }]),
      says: 'Playground.app/packed is compressed with method 12',
    },
    {
      label: 'an entry whose inflated size is not its declared size',
      archive: () =>
        buildZip([
          valid,
          { name: 'Playground.app/short', bytes: text('short\n'), deflate: true, size: 99 },
        ]),
      says: 'Playground.app/short inflates to 6 bytes, not 99',
    },
    {
      label: 'an end record that counts 0xffff entries',
      archive: () => buildZip([valid], { count: 0xffff }),
      says: 'it is a zip64 archive',
    },
    {
      label: 'an end record whose directory offset is 0xffffffff',
      archive: () => buildZip([valid], { offset: 0xffffffff }),
      says: 'it is a zip64 archive',
    },
    {
      label: 'bytes with no end record',
      archive: () => buildZip([valid]).subarray(0, -22),
      says: 'it has no end record',
    },
  ]

  for (const { label, archive, says } of refusals) {
    it(`refuses ${label} and writes nothing`, async () => {
      const { root } = tempProject('playground-app')
      const crafted = archive()
      const app = fakePlaygroundApp({ ios: crafted })

      const { result, recorded } = await download(root, app, {
        runtimes: ['ios'],
        pin: pinnedTo(crafted),
      })

      expect(result).toEqual({
        arrived: [],
        failures: [
          {
            runtime: 'ios',
            reason:
              'The Playground app for iOS was not downloaded: its archive cannot be used ' +
              `(${says}). It is ${ZIP} in release ${RELEASE} of ${REPOSITORY}.`,
          },
        ],
      })
      expect(existsSync(join(root, 'app-bundles'))).toBe(false)
      expect(readdirSync(root)).toEqual(['.git'])
      expect(recorded).toEqual([])
    })
  }

  it('keeps a Playground.app that is already there and asks for nothing', async () => {
    const { root } = tempProject('playground-app')
    const folder = join(root, 'app-bundles', 'Playground.app')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Info.plist'), 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app, { runtimes: ['ios'] })

    expect(app.requests).toEqual([])
    expect(recorded).toEqual([{ path: folder, outcome: 'preserved' }])
    expect(result).toEqual({ arrived: ['ios'], failures: [] })
    expect(readFileSync(join(folder, 'Info.plist'), 'utf8')).toBe('an older build')
  })

  it('with force fetches the build again and writes each file over the one that is there', async () => {
    const { root } = tempProject('playground-app')
    const folder = join(root, 'app-bundles', 'Playground.app')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Info.plist'), 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app, { runtimes: ['ios'], force: true })

    expect(app.requests.map((request) => request.url)).toEqual([
      playgroundAppUrl(app.source.pin, 'ios'),
    ])
    for (const entry of fakePlaygroundIosEntries()) {
      if (entry.name.endsWith('/')) continue
      const path = join(root, 'app-bundles', entry.name)
      expect(readFileSync(path), entry.name).toEqual(Buffer.from(entry.bytes))
    }
    expect(recorded).toEqual([{ path: folder, outcome: 'updated' }])
    expect(result).toEqual({ arrived: ['ios'], failures: [] })
  })
})

describe('downloading the Playground app for both runtimes', () => {
  it('publishes the iOS build when the Android bytes are wrong, and fails Android alone', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp({ android: text('another build') })

    const { result } = await download(root, app, { runtimes: ['android', 'ios'] })

    expect(result).toEqual({
      arrived: ['ios'],
      failures: [{ runtime: 'android', reason: expect.stringContaining(APK) }],
    })
    expect(existsSync(join(root, 'app-bundles', APK))).toBe(false)
    expect(existsSync(join(root, 'app-bundles', 'Playground.app', 'Info.plist'))).toBe(true)
  })

  it('publishes the APK when the iOS bytes are wrong, and fails iOS alone', async () => {
    const { root } = tempProject('playground-app')
    const app = fakePlaygroundApp({ ios: text('another build') })

    const { result } = await download(root, app, { runtimes: ['android', 'ios'] })

    expect(result).toEqual({
      arrived: ['android'],
      failures: [{ runtime: 'ios', reason: expect.stringContaining(ZIP) }],
    })
    expect(existsSync(join(root, 'app-bundles', APK))).toBe(true)
    expect(existsSync(join(root, 'app-bundles', 'Playground.app'))).toBe(false)
  })
})
