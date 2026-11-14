import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'
import { captureAuthState, readAuthStateFile, restoreSessionStorage } from '../auth-state.js'
import { startCdpBrowser } from './fixtures/remote-browsers.js'
import type { CdpBrowser } from './fixtures/remote-browsers.js'
import type { AuthStateContext } from '../auth-state.js'

const SHOP = 'https://shop.example.test'
const ADMIN = 'https://admin.example.test'

function fakePage(read: unknown): Page {
  return {
    evaluate: vi.fn(async () => {
      if (read instanceof Error) throw read
      return read
    }),
  } as unknown as Page
}

function fakeContext(state: unknown, pages: Page[]) {
  const storageState = vi.fn().mockResolvedValue(state)
  return {
    context: { storageState, pages: () => pages } as unknown as AuthStateContext,
    storageState,
  }
}

function playwrightState() {
  return {
    cookies: [
      {
        name: 'made-up-cookie',
        value: 'made-up-cookie-value',
        domain: 'shop.example.test',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [
      { origin: SHOP, localStorage: [{ name: 'made-up-local', value: 'made-up-local-value' }] },
    ],
  }
}

describe('captureAuthState', () => {
  it('adds each origin sessionStorage to the state Playwright returns, the later page winning', async () => {
    const { context, storageState } = fakeContext(playwrightState(), [
      fakePage({
        origin: SHOP,
        items: [
          { name: 'made-up:user', value: 'first' },
          { name: 'made-up:cart', value: 'one' },
        ],
      }),
      fakePage({ origin: SHOP, items: [{ name: 'made-up:user', value: 'second' }] }),
      fakePage({ origin: ADMIN, items: [{ name: 'made-up:admin', value: 'made-up-admin-value' }] }),
    ])

    const captured = await captureAuthState(context)

    expect(storageState).toHaveBeenCalledWith({ indexedDB: true })
    expect(captured.cookies).toEqual(playwrightState().cookies)
    expect(captured.origins).toEqual([
      {
        origin: SHOP,
        localStorage: [{ name: 'made-up-local', value: 'made-up-local-value' }],
        sessionStorage: [
          { name: 'made-up:user', value: 'second' },
          { name: 'made-up:cart', value: 'one' },
        ],
      },
      {
        origin: ADMIN,
        localStorage: [],
        sessionStorage: [{ name: 'made-up:admin', value: 'made-up-admin-value' }],
      },
    ])
  })

  it('returns exactly what Playwright returns when no page holds sessionStorage', async () => {
    const { context } = fakeContext(playwrightState(), [
      fakePage({ origin: SHOP, items: [] }),
      fakePage({ origin: ADMIN, items: [] }),
    ])

    expect(await captureAuthState(context)).toEqual(playwrightState())
  })

  it('leaves out a page whose read fails, a page that is not http or https and items that are not strings', async () => {
    const { context } = fakeContext({ cookies: [], origins: [] }, [
      fakePage(new Error('made-up read failure')),
      fakePage({ origin: 'null', items: [{ name: 'made-up:user', value: 'opaque' }] }),
      fakePage({
        origin: 'chrome-extension://made-up',
        items: [{ name: 'made-up:user', value: 'extension' }],
      }),
      fakePage({ origin: 'file://', items: [{ name: 'made-up:user', value: 'file' }] }),
      fakePage({
        origin: SHOP,
        items: [
          { name: 'made-up:user', value: null },
          { name: 'made-up:ok', value: 'kept' },
        ],
      }),
    ])

    expect(await captureAuthState(context)).toEqual({
      cookies: [],
      origins: [
        { origin: SHOP, localStorage: [], sessionStorage: [{ name: 'made-up:ok', value: 'kept' }] },
      ],
    })
  })

  it('keeps a key such as __proto__ as data', async () => {
    const { context } = fakeContext({ cookies: [], origins: [] }, [
      fakePage({ origin: SHOP, items: [{ name: '__proto__', value: 'made-up-proto' }] }),
    ])

    const captured = await captureAuthState(context)

    expect(captured.origins[0]?.sessionStorage).toEqual([
      { name: '__proto__', value: 'made-up-proto' },
    ])
  })
})

describe('readAuthStateFile', () => {
  let folder: string

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'agent-qa-auth-state-'))
  })

  afterAll(async () => {
    await rm(folder, { recursive: true, force: true })
  })

  async function payloadFile(name: string, content: string): Promise<string> {
    const path = join(folder, name)
    await writeFile(path, content)
    return path
  }

  it('hands Playwright cookies and origins without sessionStorage and keeps the entries apart', async () => {
    const payload = {
      cookies: playwrightState().cookies,
      origins: [
        {
          origin: SHOP,
          localStorage: [{ name: 'made-up-local', value: 'made-up-local-value' }],
          sessionStorage: [{ name: 'made-up:user', value: 'made-up-user-value' }],
        },
        {
          origin: ADMIN,
          localStorage: [],
          sessionStorage: [{ name: 'made-up:admin', value: 'made-up-admin-value' }],
        },
      ],
    }

    const loaded = await readAuthStateFile(
      await payloadFile('with-session.json', JSON.stringify(payload)),
    )

    expect(loaded.playwright).toEqual({
      cookies: playwrightState().cookies,
      origins: [
        { origin: SHOP, localStorage: [{ name: 'made-up-local', value: 'made-up-local-value' }] },
      ],
    })
    expect([...loaded.sessionStorage]).toEqual([
      [SHOP, [{ name: 'made-up:user', value: 'made-up-user-value' }]],
      [ADMIN, [{ name: 'made-up:admin', value: 'made-up-admin-value' }]],
    ])
  })

  it('hands a payload without sessionStorage to Playwright as the file holds it', async () => {
    const payload = {
      ...playwrightState(),
      origins: [
        ...playwrightState().origins,
        {
          origin: ADMIN,
          localStorage: [],
          indexedDB: [{ name: 'made-up-db', version: 1, stores: [] }],
        },
      ],
    }

    const loaded = await readAuthStateFile(await payloadFile('plain.json', JSON.stringify(payload)))

    expect(loaded.playwright).toEqual(payload)
    expect(loaded.sessionStorage.size).toBe(0)
  })

  it('restores no origin that is not an http or https origin and no item that is not two strings', async () => {
    const payload = {
      cookies: [],
      origins: [
        {
          origin: 'file://',
          localStorage: [],
          sessionStorage: [{ name: 'made-up:user', value: 'file' }],
        },
        {
          origin: 'javascript:alert(1)',
          localStorage: [],
          sessionStorage: [{ name: 'made-up:user', value: 'script' }],
        },
        {
          origin: 'chrome://settings',
          localStorage: [],
          sessionStorage: [{ name: 'made-up:user', value: 'chrome' }],
        },
        {
          origin: `${SHOP}/path`,
          localStorage: [],
          sessionStorage: [{ name: 'made-up:user', value: 'path' }],
        },
        {
          origin: ADMIN,
          localStorage: [],
          sessionStorage: [{ name: 'made-up:user', value: 7 }, 'made-up'],
        },
      ],
    }

    const loaded = await readAuthStateFile(
      await payloadFile('hostile.json', JSON.stringify(payload)),
    )

    expect(loaded.sessionStorage.size).toBe(0)
    expect(loaded.playwright).toEqual({ cookies: [], origins: [] })
  })

  it('refuses a missing file or one that is not JSON with a sentence that holds nothing of the file', async () => {
    const broken = await payloadFile('broken.json', '{"cookies": [{"value": "made-up-secret-value"')

    await expect(readAuthStateFile(join(folder, 'missing.json'))).rejects.toThrow(
      /^Auth state could not be read\.$/,
    )
    const error = await readAuthStateFile(broken).catch((caught: Error) => caught)
    expect((error as Error).message).toBe('Auth state could not be read.')
    expect((error as Error).message).not.toContain('made-up-secret-value')
  })
})

describe('restoreSessionStorage', () => {
  function routedPage(failOn?: 'goto' | 'goBack') {
    const calls: string[] = []
    const page = {
      route: vi.fn(async (_url: string, _handler: unknown) => {
        calls.push('route')
      }),
      unroute: vi.fn(async (_url: string, _handler: unknown) => {
        calls.push('unroute')
      }),
      goto: vi.fn(async (url: string) => {
        calls.push(`goto ${url}`)
        if (failOn === 'goto') throw new Error('made-up navigation failure made-up-user-value')
      }),
      evaluate: vi.fn(async (_script: unknown, _argument: unknown) => {
        calls.push('evaluate')
      }),
      goBack: vi.fn(async () => {
        calls.push('goBack')
        if (failOn === 'goBack') throw new Error('made-up back failure')
      }),
    }
    return { page, calls }
  }

  const entries = new Map([[SHOP, [{ name: 'made-up:user', value: 'made-up-user-value' }]]])

  it('does nothing when there is nothing to restore', async () => {
    const { page, calls } = routedPage()
    await restoreSessionStorage(page as unknown as Page, new Map())
    expect(calls).toEqual([])
  })

  it('writes each origin behind a route, steps back and removes the route', async () => {
    const { page, calls } = routedPage()
    await restoreSessionStorage(page as unknown as Page, entries)
    expect(calls).toEqual(['route', `goto ${SHOP}`, 'evaluate', 'goBack', 'unroute'])
    expect(page.unroute.mock.calls[0]?.[1]).toBe(page.route.mock.calls[0]?.[1])
    expect(page.evaluate.mock.calls[0]?.[1]).toEqual(entries.get(SHOP))
  })

  it.each(['goto', 'goBack'] as const)(
    'removes the route and names only the origin when %s fails',
    async (failOn) => {
      const { page, calls } = routedPage(failOn)
      const error = await restoreSessionStorage(page as unknown as Page, entries).catch(
        (caught: Error) => caught,
      )
      expect((error as Error).message).toBe(`Could not restore sessionStorage for ${SHOP}.`)
      expect(calls.at(-1)).toBe('unroute')
      expect(page.unroute.mock.calls[0]?.[1]).toBe(page.route.mock.calls[0]?.[1])
    },
  )
})

const SIGN_IN_PAGE = `<!doctype html><title>made-up shop</title><script>
window.atStart = {
  signedIn: sessionStorage.getItem('made-up:session') !== null,
  keys: Object.keys(sessionStorage),
  history: history.length,
}
</script><body>made-up shop</body>`

function refuseWithoutChromium(): void {
  if (!existsSync(chromium.executablePath()))
    throw new Error('Playwright Chromium missing; never skip')
}

describe('auth state sessionStorage in a real browser', () => {
  const server = createServer((_request, response) => {
    requests += 1
    response.setHeader('content-type', 'text/html')
    response.end(SIGN_IN_PAGE)
  })
  let requests = 0
  let first = ''
  let second = ''
  let folder = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    first = `http://127.0.0.1:${port}`
    second = `http://localhost:${port}`
    folder = await mkdtemp(join(tmpdir(), 'agent-qa-auth-state-browser-'))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(folder, { recursive: true, force: true })
  })

  type AtStart = { signedIn: boolean; keys: string[]; history: number }

  async function atStart(page: Page): Promise<AtStart> {
    return page.evaluate(() => (globalThis as unknown as { atStart: AtStart }).atStart)
  }

  it('a captured sign-in opens the next session signed in, once, and a cleared sign-out stays out', async () => {
    refuseWithoutChromium()
    const made = { first: 'made-up-first-session-value', second: 'made-up-second-session-value' }

    const capturing = new WebPlatformAdapter()
    let baselineHistory = 0
    let payload: Awaited<ReturnType<WebPlatformAdapter['captureAuthState']>>
    try {
      await capturing.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
      const page = capturing.getPage()!
      await page.goto(`${first}/`)
      baselineHistory = (await atStart(page)).history
      await page.evaluate((value) => sessionStorage.setItem('made-up:session', value), made.first)
      await capturing.execute({ type: 'tab', action: 'new', url: `${second}/` })
      await capturing
        .getPage()!
        .evaluate((value) => sessionStorage.setItem('made-up:other', value), made.second)
      payload = await capturing.captureAuthState()
    } finally {
      await capturing.cleanup()
    }
    expect(
      payload.origins
        .find((entry) => entry.origin === first)
        ?.sessionStorage?.map((item) => item.name),
    ).toEqual(['made-up:session'])
    expect(
      payload.origins
        .find((entry) => entry.origin === second)
        ?.sessionStorage?.map((item) => item.name),
    ).toEqual(['made-up:other'])

    const storageStatePath = join(folder, 'state.json')
    await writeFile(storageStatePath, JSON.stringify(payload))
    const restored = new WebPlatformAdapter()
    try {
      requests = 0
      await restored.setup({
        platform: 'web',
        browser: { name: 'chromium', headless: true },
        authState: {
          version: 2,
          kind: 'web',
          targetName: 'made-up-target',
          stateName: 'made-up-state',
          capturedAt: '2026-01-01T00:00:00.000Z',
          storageStatePath,
        },
      })
      expect(requests).toBe(0)
      const page = restored.getPage()!
      expect(page.url()).toBe('about:blank')

      await page.goto(`${first}/`)
      expect(await atStart(page)).toEqual({
        signedIn: true,
        keys: ['made-up:session'],
        history: baselineHistory,
      })

      await page.evaluate(() => sessionStorage.clear())
      await page.reload()
      expect((await atStart(page)).signedIn).toBe(false)

      await page.goto(`${second}/`)
      expect((await atStart(page)).keys).toEqual(['made-up:other'])

      await restored.execute({ type: 'tab', action: 'new', url: `${first}/` })
      expect(await atStart(restored.getPage()!)).toEqual({
        signedIn: true,
        keys: ['made-up:session'],
        history: baselineHistory,
      })

      const logs = JSON.stringify([restored.drainConsoleLogs(), restored.drainNetworkLogs()])
      expect(logs).not.toContain(made.first)
      expect(logs).not.toContain(made.second)
    } finally {
      await restored.cleanup()
    }
  }, 60_000)

  it('a reused remote context gets the sessionStorage in the tab it opens', async () => {
    refuseWithoutChromium()
    const storageStatePath = join(folder, 'reused.json')
    await writeFile(
      storageStatePath,
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: first,
            localStorage: [],
            sessionStorage: [{ name: 'made-up:session', value: 'made-up-reused' }],
          },
        ],
      }),
    )
    let cdp: CdpBrowser | undefined
    const adapter = new WebPlatformAdapter()
    try {
      cdp = await startCdpBrowser()
      requests = 0
      await adapter.setup({
        platform: 'web',
        browser: {
          name: 'chromium',
          remote: {
            name: 'grid',
            protocol: 'cdp',
            url: cdp.endpoint,
            connectTimeoutMs: 30_000,
            context: 'reuse',
          },
        },
        authState: {
          version: 2,
          kind: 'web',
          targetName: 'made-up-target',
          stateName: 'made-up-state',
          capturedAt: '2026-01-01T00:00:00.000Z',
          storageStatePath,
        },
      })
      expect(requests).toBe(0)
      const page = adapter.getPage()!
      expect(page.url()).toBe('about:blank')
      await page.goto(`${first}/`)
      expect(await atStart(page)).toMatchObject({ signedIn: true, keys: ['made-up:session'] })
    } finally {
      await adapter.cleanup()
      await cdp?.close()
    }
  }, 60_000)
})
