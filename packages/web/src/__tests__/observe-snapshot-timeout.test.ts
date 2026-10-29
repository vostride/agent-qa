// C436-OBSERVE-BOUND (436-27 · D-29, review CR-09): observe's ai-mode snapshot keeps the short
// bound for a child frame that never answers, and a main frame that outlasts it is taken once more
// with the pre-436-24 bound instead of failing the observation. Real headless Chromium through
// WebPlatformAdapter, fixtures served from a loopback node:http server.

import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Locator, Page } from 'playwright-core'
import type { ScreenState } from '@vostride/agent-qa-schema'
import {
  OBSERVE_SNAPSHOT_RETRY_TIMEOUT_MS,
  OBSERVE_SNAPSHOT_TIMEOUT_MS,
  WebPlatformAdapter,
} from '../adapter.js'

const BUSY_MS = 6_500
// The readiness wait's cap (smart-wait.ts).
const READINESS_CAP_MS = 10_000

const page = (title: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

// The first time the adapter hides the overlay, right before the snapshot, the main thread is held
// for BUSY_MS, so the first snapshot attempt outlasts the short bound on any machine.
const BUSY_HOOK = `
  <div data-agent-qa-internal id="hook">overlay</div>
  <h1>Slow snapshot</h1>
  <button>Ready</button>
  <script>
    const hook = document.getElementById('hook')
    let fired = false
    new MutationObserver(() => {
      if (fired || hook.style.display !== 'none') return
      fired = true
      setTimeout(() => { const end = Date.now() + ${String(BUSY_MS)}; while (Date.now() < end) {} }, 0)
    }).observe(hook, { attributes: true, attributeFilter: ['style'] })
  </script>`

const PAGES: Record<string, string> = {
  '/busy': page('busy', BUSY_HOOK),
  '/hung-frame': page('hung frame', '<iframe title="hung" src="/hang"></iframe><button>Ready</button>'),
  '/busy-hung-frame': page('busy hung frame', `${BUSY_HOOK}<iframe title="hung" src="/hang"></iframe>`),
  '/hook': page('hook', '<div data-agent-qa-internal id="hook">overlay</div><h1>Hook</h1><button>Ready</button>'),
}

let server: Server
let baseUrl = ''
let adapter: WebPlatformAdapter | undefined
// /hang never answers; each parked response is destroyed after its cell.
const parkedResponses = new Set<ServerResponse>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path === '/hang') {
      parkedResponses.add(res)
      res.on('close', () => parkedResponses.delete(res))
      return
    }
    const html = PAGES[path]
    res.writeHead(html === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html ?? 'not found')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://localhost:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  for (const res of parkedResponses) res.destroy()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter?.cleanup()
  adapter = undefined
  for (const res of parkedResponses) res.destroy()
}, 60_000)

type SnapshotSpy = MockInstance<Locator['ariaSnapshot']>

async function open(path: string): Promise<{ web: WebPlatformAdapter; tab: Page; snapshot: SnapshotSpy }> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  const tab = created.getPage()!
  // A page holding a hung iframe never fires `load`.
  await tab.goto(baseUrl + path, { waitUntil: 'domcontentloaded' })
  const proto = Object.getPrototypeOf(tab.locator(':root')) as Locator
  return { web: created, tab, snapshot: vi.spyOn(proto, 'ariaSnapshot') }
}

function timeoutsOf(snapshot: SnapshotSpy): (number | undefined)[] {
  return snapshot.mock.calls.map(([options]) => options?.timeout)
}

function hasReady(state: ScreenState): boolean {
  return state.elements.some((element) => element.role === 'button' && element.name === 'Ready')
}

async function hookDisplay(tab: Page): Promise<string> {
  return tab.evaluate(() => (globalThis as any).document.getElementById('hook').style.display as string)
}

function timeoutError(): Error {
  return Object.assign(new Error('locator.ariaSnapshot: Timeout exceeded'), { name: 'TimeoutError' })
}

describe('the ai-mode snapshot timeout', () => {
  it('a main frame whose snapshot outlasts the short bound is still observed', async () => {
    const { web, tab, snapshot } = await open('/busy')
    const state = await web.observe()

    expect(timeoutsOf(snapshot)).toEqual([OBSERVE_SNAPSHOT_TIMEOUT_MS, OBSERVE_SNAPSHOT_RETRY_TIMEOUT_MS])
    const [first, second] = snapshot.mock.settledResults
    expect(first?.type, 'the first attempt outlasted the short bound').toBe('rejected')
    expect((first?.value as Error).name).toBe('TimeoutError')
    expect(second?.type).toBe('fulfilled')
    expect(hasReady(state)).toBe(true)
    expect(await hookDisplay(tab)).toBe('')
  }, 120_000)

  it('a page whose iframe never answers is observed at the short bound with one snapshot', async () => {
    const { web, snapshot } = await open('/hung-frame')
    const started = performance.now()
    const state = await web.observe()
    const elapsed = performance.now() - started

    expect(hasReady(state)).toBe(true)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(READINESS_CAP_MS + OBSERVE_SNAPSHOT_TIMEOUT_MS + 2_000)
  }, 120_000)

  it('a slow main frame beside a hung iframe is observed and never throws', async () => {
    const { web } = await open('/busy-hung-frame')
    const started = performance.now()
    const state = await web.observe()
    const elapsed = performance.now() - started

    expect(hasReady(state)).toBe(true)
    expect(elapsed).toBeLessThan(60_000)
  }, 120_000)

  it('a snapshot error that is not a timeout is thrown without a second attempt', async () => {
    const { web, tab, snapshot } = await open('/hook')
    snapshot.mockRejectedValueOnce(new Error('snapshot failed'))

    await expect(web.observe()).rejects.toThrow('snapshot failed')
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(await hookDisplay(tab)).toBe('')
  }, 120_000)

  it('a snapshot that times out twice is thrown', async () => {
    const { web, tab, snapshot } = await open('/hook')
    snapshot.mockRejectedValueOnce(timeoutError()).mockRejectedValueOnce(timeoutError())

    await expect(web.observe()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(timeoutsOf(snapshot)).toEqual([OBSERVE_SNAPSHOT_TIMEOUT_MS, OBSERVE_SNAPSHOT_RETRY_TIMEOUT_MS])
    expect(await hookDisplay(tab)).toBe('')
  }, 120_000)
})
