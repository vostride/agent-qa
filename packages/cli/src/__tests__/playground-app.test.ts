import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  moveFolderInsideRoot,
  removeFolderInsideRoot,
  type InitFileResult,
} from '../commands/init-filesystem.js'
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
// A folder init unpacks into or moves the older build to, beside Playground.app.
const TEMPORARY = /^\.Playground\.app\.agent-qa-init-\d+-[0-9a-f-]{36}\.tmp$/u

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

afterEach(() => {
  cleanupTempProjects()
  vi.restoreAllMocks()
})

async function download(
  root: string,
  app: FakePlaygroundApp,
  overrides: Partial<PlaygroundAppsInput> = {},
) {
  const recorded: InitFileResult[] = []
  // Each folder removed, with the URLs the fetcher had been asked for by then.
  const removals: { path: string; requested: string[] }[] = []
  const input: PlaygroundAppsInput = {
    dir: root,
    runtimes: ['android'],
    pin: app.source.pin,
    fetch: app.source.fetch,
    exists: existsSync,
    removeFolder: (path) => {
      removals.push({ path, requested: app.requests.map((request) => request.url) })
      removeFolderInsideRoot({ path, root })
    },
    moveFolder: (from, to) => {
      moveFolderInsideRoot({ from, to, root })
    },
    force: false,
    signal: new AbortController().signal,
    record: (result) => {
      recorded.push(result)
    },
    ...overrides,
  }
  return { result: await downloadPlaygroundApps(input), recorded, removals, signal: input.signal }
}

// Every file and folder under a folder, by its path inside it.
function entriesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .map((path) => path.split(sep).join('/'))
    .sort()
}

// Every file under a folder, by its path inside it, with its bytes.
function filesUnder(folder: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const path of entriesUnder(folder)) {
    const file = join(folder, path)
    if (statSync(file).isFile()) files[path] = readFileSync(file, 'base64')
  }
  return files
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

  // What the failure says between "was not downloaded: " and ". It is".
  async function failureMessageFor(error: Error): Promise<string | undefined> {
    const { root } = tempProject('playground-app')
    const { result } = await download(root, fakePlaygroundApp({ android: error }))
    expect(result.arrived).toEqual([])
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
    const said = /^The Playground app for Android was not downloaded: (.*)\. It is /su.exec(
      result.failures[0]?.reason ?? '',
    )
    return said?.[1]
  }

  it('resolves with a failure that names the cause when the fetcher rejects with a TypeError, as Node does offline', async () => {
    const offline = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND github.com'),
    })

    expect(await failureMessageFor(offline)).toBe('fetch failed (getaddrinfo ENOTFOUND github.com)')
  })

  it('names each address that refused when the cause is several errors with no message of its own', async () => {
    const refused = new TypeError('fetch failed', {
      cause: new AggregateError([
        new Error('connect ECONNREFUSED ::1:443'),
        new Error('connect ECONNREFUSED 127.0.0.1:443'),
      ]),
    })

    expect(await failureMessageFor(refused)).toBe(
      'fetch failed (connect ECONNREFUSED ::1:443, connect ECONNREFUSED 127.0.0.1:443)',
    )
  })

  it("leaves the control characters out of a cause's message", async () => {
    const certificate = new TypeError('fetch failed', {
      cause: new Error("Hostname does not match the certificate's \u001b[2Jname\r\n\u0007."),
    })

    expect(await failureMessageFor(certificate)).toBe(
      "fetch failed (Hostname does not match the certificate's name)",
    )
  })

  it('carries the message alone when the error has no cause, or a cause that says the same', async () => {
    const same = new Error('the proxy refused', { cause: new Error('the proxy refused') })

    expect(await failureMessageFor(new TypeError('fetch failed'))).toBe('fetch failed')
    expect(await failureMessageFor(same)).toBe('the proxy refused')
    expect(await failureMessageFor(new Error('GitHub answered 404', { cause: 'a string' }))).toBe(
      'GitHub answered 404',
    )
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

  it('with force fetches the APK again and writes it over the one that is there, removing no folder', async () => {
    const { root } = tempProject('playground-app')
    const apk = join(root, 'app-bundles', APK)
    mkdirSync(join(root, 'app-bundles'))
    writeFileSync(apk, 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded, removals } = await download(root, app, { force: true })

    expect(app.requests.map((request) => request.url)).toEqual([
      playgroundAppUrl(app.source.pin, 'android'),
    ])
    expect(readFileSync(apk)).toEqual(Buffer.from(app.bytes.android))
    expect(recorded).toEqual([{ path: apk, outcome: 'updated' }])
    expect(result).toEqual({ arrived: ['android'], failures: [] })
    expect(removals).toEqual([])
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

  // The Playground.app an older build left, with a framework the new build does not have.
  function olderPlaygroundApp(root: string): string {
    const folder = join(root, 'app-bundles', 'Playground.app')
    mkdirSync(join(folder, 'Frameworks', 'old.framework'), { recursive: true })
    writeFileSync(join(folder, 'Info.plist'), 'an older build')
    writeFileSync(join(folder, 'Frameworks', 'old.framework', 'old'), 'an older framework')
    return folder
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
      label: 'an archive that holds folders and no file',
      archive: () => buildZip([{ name: 'Playground.app/', bytes: new Uint8Array() }]),
      says: 'it holds no file',
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

  it('keeps a Playground.app that is already there, asks for nothing and removes nothing', async () => {
    const { root } = tempProject('playground-app')
    const folder = join(root, 'app-bundles', 'Playground.app')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'Info.plist'), 'an older build')
    const app = fakePlaygroundApp()

    const { result, recorded, removals } = await download(root, app, { runtimes: ['ios'] })

    expect(app.requests).toEqual([])
    expect(removals).toEqual([])
    expect(recorded).toEqual([{ path: folder, outcome: 'preserved' }])
    expect(result).toEqual({ arrived: ['ios'], failures: [] })
    expect(readFileSync(join(folder, 'Info.plist'), 'utf8')).toBe('an older build')
  })

  it('with force fetches the build again and replaces the Playground.app that is there as a whole, so no file of the older build stays', async () => {
    const { root } = tempProject('playground-app')
    const folder = join(root, 'app-bundles', 'Playground.app')
    const old = join(folder, 'Frameworks', 'old.framework', 'old')
    mkdirSync(dirname(old), { recursive: true })
    writeFileSync(join(folder, 'Info.plist'), 'an older build')
    writeFileSync(old, 'a framework the new build does not have')
    const app = fakePlaygroundApp()

    const { result, recorded, removals } = await download(root, app, {
      runtimes: ['ios'],
      force: true,
    })

    const url = playgroundAppUrl(app.source.pin, 'ios')
    expect(app.requests.map((request) => request.url)).toEqual([url])
    // The older build is removed from the folder it was moved to, after the request.
    expect(removals).toEqual([{ path: expect.any(String), requested: [url] }])
    expect(dirname(removals[0]?.path ?? '')).toBe(join(root, 'app-bundles'))
    expect(basename(removals[0]?.path ?? '')).toMatch(TEMPORARY)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(dirname(old))).toBe(false)
    expect(entriesUnder(join(root, 'app-bundles'))).toEqual(
      fakePlaygroundIosEntries()
        .map((entry) => entry.name.replace(/\/$/u, ''))
        .sort(),
    )
    for (const entry of fakePlaygroundIosEntries()) {
      if (entry.name.endsWith('/')) continue
      const path = join(root, 'app-bundles', entry.name)
      expect(readFileSync(path), entry.name).toEqual(Buffer.from(entry.bytes))
    }
    expect(recorded).toEqual([{ path: folder, outcome: 'updated' }])
    expect(result).toEqual({ arrived: ['ios'], failures: [] })
  })

  it('with force leaves the Playground.app that is there byte for byte when the sha256 is not the pinned one', async () => {
    const { root } = tempProject('playground-app')
    const folder = olderPlaygroundApp(root)
    const before = filesUnder(folder)
    const app = fakePlaygroundApp({ ios: text('another build') })

    const { result, recorded, removals } = await download(root, app, {
      runtimes: ['ios'],
      force: true,
    })

    expect(result).toEqual({
      arrived: [],
      failures: [
        { runtime: 'ios', reason: expect.stringContaining('its sha256 is not the pinned one') },
      ],
    })
    expect(removals).toEqual([])
    expect(filesUnder(folder)).toEqual(before)
    expect(recorded).toEqual([])
  })

  it('with force leaves the Playground.app that is there byte for byte when the archive is refused', async () => {
    const { root } = tempProject('playground-app')
    const folder = olderPlaygroundApp(root)
    const before = filesUnder(folder)
    const crafted = buildZip([
      valid,
      { name: 'Playground.app/../../outside.txt', bytes: text('outside\n') },
    ])
    const app = fakePlaygroundApp({ ios: crafted })

    const { result, recorded, removals } = await download(root, app, {
      runtimes: ['ios'],
      force: true,
      pin: pinnedTo(crafted),
    })

    expect(result).toEqual({
      arrived: [],
      failures: [{ runtime: 'ios', reason: expect.stringContaining('its archive cannot be used') }],
    })
    expect(removals).toEqual([])
    expect(filesUnder(folder)).toEqual(before)
    expect(recorded).toEqual([])
  })

  // A file at Info.plist and a file under it: the second cannot be written once the first is.
  function archiveWhoseSecondFileCannotBeWritten(): Uint8Array {
    return buildZip([valid, { name: 'Playground.app/Info.plist/inner', bytes: text('inner\n') }])
  }

  it('leaves no Playground.app and no temporary folder when a file of the build cannot be written, and the next download asks for the build again', async () => {
    const { root } = tempProject('playground-app')
    const crafted = archiveWhoseSecondFileCannotBeWritten()

    const failed = await download(root, fakePlaygroundApp({ ios: crafted }), {
      runtimes: ['ios'],
      pin: pinnedTo(crafted),
    })

    expect(failed.result).toEqual({
      arrived: [],
      failures: [{ runtime: 'ios', reason: expect.stringMatching(/ parent .+Info\.plist/u) }],
    })
    expect(failed.recorded).toEqual([])
    expect(readdirSync(join(root, 'app-bundles'))).toEqual([])

    const app = fakePlaygroundApp()
    const next = await download(root, app, { runtimes: ['ios'] })

    expect(app.requests.map((request) => request.url)).toEqual([
      playgroundAppUrl(app.source.pin, 'ios'),
    ])
    expect(next.result).toEqual({ arrived: ['ios'], failures: [] })
    expect(next.recorded).toEqual([
      { path: join(root, 'app-bundles', 'Playground.app'), outcome: 'created' },
    ])
    expect(entriesUnder(join(root, 'app-bundles'))).toEqual(
      fakePlaygroundIosEntries()
        .map((entry) => entry.name.replace(/\/$/u, ''))
        .sort(),
    )
  })

  it('with force leaves the Playground.app that is there byte for byte and no temporary folder when a file of the new build cannot be written, and the next download keeps it', async () => {
    const { root } = tempProject('playground-app')
    const folder = olderPlaygroundApp(root)
    const before = filesUnder(folder)
    const crafted = archiveWhoseSecondFileCannotBeWritten()

    const failed = await download(root, fakePlaygroundApp({ ios: crafted }), {
      runtimes: ['ios'],
      force: true,
      pin: pinnedTo(crafted),
    })

    expect(failed.result).toEqual({
      arrived: [],
      failures: [{ runtime: 'ios', reason: expect.stringMatching(/ parent .+Info\.plist/u) }],
    })
    expect(failed.recorded).toEqual([])
    expect(readdirSync(join(root, 'app-bundles'))).toEqual(['Playground.app'])
    expect(filesUnder(folder)).toEqual(before)

    const app = fakePlaygroundApp()
    const next = await download(root, app, { runtimes: ['ios'] })

    expect(app.requests).toEqual([])
    expect(next.recorded).toEqual([{ path: folder, outcome: 'preserved' }])
    expect(filesUnder(folder)).toEqual(before)
  })

  it('with force puts the Playground.app that was there back byte for byte when the new build cannot be moved into its place', async () => {
    const { root } = tempProject('playground-app')
    const folder = olderPlaygroundApp(root)
    const before = filesUnder(folder)
    let moves = 0

    const { result, recorded } = await download(root, fakePlaygroundApp(), {
      runtimes: ['ios'],
      force: true,
      moveFolder: (from, to) => {
        moves += 1
        if (moves === 2) throw new Error('the folder is held open by another process')
        moveFolderInsideRoot({ from, to, root })
      },
    })

    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'ios',
          reason: expect.stringContaining('the folder is held open by another process'),
        },
      ],
    })
    expect(moves).toBe(3)
    expect(readdirSync(join(root, 'app-bundles'))).toEqual(['Playground.app'])
    expect(filesUnder(folder)).toEqual(before)
    expect(recorded).toEqual([])
  })

  it('with force names the folder that holds the older build when it cannot be put back', async () => {
    const { root } = tempProject('playground-app')
    const before = filesUnder(olderPlaygroundApp(root))
    let moves = 0

    const { result, recorded } = await download(root, fakePlaygroundApp(), {
      runtimes: ['ios'],
      force: true,
      moveFolder: (from, to) => {
        moves += 1
        if (moves === 2) throw new Error('the new build could not be moved')
        if (moves === 3) throw new Error('the older build could not be moved back')
        moveFolderInsideRoot({ from, to, root })
      },
    })

    const left = readdirSync(join(root, 'app-bundles'))
    expect(left).toEqual([expect.stringMatching(TEMPORARY)])
    const kept = join(root, 'app-bundles', left[0] ?? '')
    expect(filesUnder(kept)).toEqual(before)
    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'ios',
          reason: expect.stringContaining(
            'the new build could not be moved, and the build that was there is now ' +
              `${kept} (the older build could not be moved back). It is ${ZIP}`,
          ),
        },
      ],
    })
    expect(recorded).toEqual([])
  })

  it('with force keeps the new build and warns where the older one is when the older one cannot be removed', async () => {
    const { root } = tempProject('playground-app')
    const folder = olderPlaygroundApp(root)
    const before = filesUnder(folder)
    const warned = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)

    const { result, recorded } = await download(root, fakePlaygroundApp(), {
      runtimes: ['ios'],
      force: true,
      removeFolder: () => {
        throw new Error('the folder is held open by another process')
      },
    })

    expect(result).toEqual({ arrived: ['ios'], failures: [] })
    expect(recorded).toEqual([{ path: folder, outcome: 'updated' }])
    for (const entry of fakePlaygroundIosEntries()) {
      if (entry.name.endsWith('/')) continue
      const path = join(root, 'app-bundles', entry.name)
      expect(readFileSync(path), entry.name).toEqual(Buffer.from(entry.bytes))
    }
    const left = readdirSync(join(root, 'app-bundles')).filter((name) => name !== 'Playground.app')
    expect(left).toEqual([expect.stringMatching(TEMPORARY)])
    const kept = join(root, 'app-bundles', left[0] ?? '')
    expect(filesUnder(kept)).toEqual(before)
    expect(warned.mock.calls).toEqual([
      [
        `agent-qa init could not remove its temporary folder ${kept} ` +
          '(the folder is held open by another process). Delete it.',
      ],
    ])
  })

  it('with force removes and writes nothing through an app-bundles that links out of the project', async () => {
    const { root, home } = tempProject('playground-app')
    const outside = join(home, 'elsewhere')
    mkdirSync(join(outside, 'Playground.app'), { recursive: true })
    writeFileSync(join(outside, 'Playground.app', 'Info.plist'), 'a file outside the project')
    symlinkSync(outside, join(root, 'app-bundles'), 'dir')
    const before = filesUnder(outside)
    const app = fakePlaygroundApp()

    const { result, recorded } = await download(root, app, { runtimes: ['ios'], force: true })

    expect(result).toEqual({
      arrived: [],
      failures: [
        {
          runtime: 'ios',
          reason: expect.stringContaining(`symbolic link parent ${join(root, 'app-bundles')}`),
        },
      ],
    })
    expect(filesUnder(outside)).toEqual(before)
    expect(recorded).toEqual([])
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
