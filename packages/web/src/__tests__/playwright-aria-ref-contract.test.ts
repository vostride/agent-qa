// `aria-ref=` is undocumented; re-run this file first after a playwright-core bump.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'

const ROWS_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul id="addresses">
    <li id="elm">
      <p>7 Elm Street, Springfield</p>
      <button type="button" onclick="window.__clicks.push('7 Elm Street, Springfield')">Edit label</button>
    </li>
    <li id="home">
      <p>1 Home Street, Springfield</p>
      <button type="button" onclick="window.__clicks.push('1 Home Street, Springfield')">Edit label</button>
    </li>
    <li id="oak">
      <p>9 Oak Road, Springfield</p>
      <button type="button" onclick="window.__clicks.push('9 Oak Road, Springfield')">Edit label</button>
    </li>
  </ul>
</body></html>`

const frameButton = (name: string): string => `<button type='button'>${name}</button>`

const FRAMED_PAGE = `<!doctype html><html><body>
  <button type="button">Main action</button>
  <iframe id="payments" srcdoc="${frameButton('Approve')}${frameButton('Decline')}"></iframe>
</body></html>`

const html = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${body}</body></html>`

const itemButtons = Array.from(
  { length: 30 },
  (_, i) => `<li><button type="button">Item ${String(i + 1)}</button></li>`,
)

// The start page outnumbers the next page, so no next-page ref reuses a start-page ref's number.
const START = html(`
  <ul>${itemButtons.join('')}</ul>
  <a href="/next">Continue to next page</a>
  <form action="/next" method="get">
    <input name="from" value="form" aria-label="Source">
    <button type="submit">Submit order</button>
  </form>`)

// Served from localhost; the second frame comes from 127.0.0.1, another site.
const NEXT = (port: number): string => html(`
  <button type="button">Fresh action</button>
  <iframe id="child" src="/child"></iframe>
  <iframe id="cross" src="http://127.0.0.1:${String(port)}/cross"></iframe>
  <div id="host"></div>
  <script>
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
      '<button type="button">Shadow action</button>'
  </script>`)

const PAGES: Record<string, string | ((port: number) => string)> = {
  '/start': START,
  '/next': NEXT,
  '/child': html('<button type="button">Child action</button>'),
  '/cross': html('<button type="button">Cross action</button>'),
}

let server: Server
let port = 0
let browser: Browser | undefined
let context: BrowserContext | undefined

beforeAll(async () => {
  server = createServer((req, res) => {
    const entry = PAGES[(req.url ?? '/').split('?')[0]]
    const body = typeof entry === 'function' ? entry(port) : entry
    res.writeHead(body === undefined ? 404 : 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body ?? 'not found')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  try {
    // Headless shell keeps cross-site frames in process; desktop Chromium isolates them.
    browser = await chromium.launch({ headless: true, args: ['--site-per-process'] })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}, 60_000)

afterEach(async () => {
  await context?.close()
  context = undefined
}, 60_000)

async function open(html: string): Promise<Page> {
  context = await browser!.newContext()
  const page = await context.newPage()
  await page.setContent(html)
  return page
}

async function aiSnapshot(page: Page): Promise<string> {
  return page.locator(':root').ariaSnapshot({ mode: 'ai' })
}

/** The native refs of every `role "name"` line in an ai snapshot, in snapshot order. */
function refsOf(snapshot: string, role: string, name: string): string[] {
  const line = new RegExp(`^\\s*- ${role} "${name}"[^\\n]*\\[ref=([^\\]]+)\\]`, 'gm')
  return [...snapshot.matchAll(line)].map((match) => match[1])
}

function refNumber(ref: string): number {
  return Number(/e(\d+)$/.exec(ref)![1])
}

async function refCount(page: Page, ref: string): Promise<number> {
  return page.locator('aria-ref=' + ref).count()
}

async function pageClicks(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks)
}

describe('the playwright-core aria-ref behaviour binding relies on', () => {
  it('refs follow a re-sorted node', async () => {
    const page = await open(ROWS_PAGE)
    const [elm] = refsOf(await aiSnapshot(page), 'button', 'Edit label')

    await page.evaluate(() => {
      const doc = (globalThis as any).document
      const row = doc.getElementById('elm')
      row.parentElement.appendChild(row)
    })
    const resorted = refsOf(await aiSnapshot(page), 'button', 'Edit label')

    expect(resorted).toHaveLength(3)
    expect(resorted[2]).toBe(elm)
    await page.locator('aria-ref=' + elm).click()
    expect(await pageClicks(page)).toEqual(['7 Elm Street, Springfield'])
    const atOldIndex = page.getByRole('button', { name: 'Edit label', exact: true }).nth(0)
    expect(await atOldIndex.evaluate((button) => button.closest('li')!.id)).toBe('home')
  }, 60_000)

  it('a default-mode or sub-locator snapshot empties the ref map', async () => {
    const page = await open(ROWS_PAGE)
    const [elm] = refsOf(await aiSnapshot(page), 'button', 'Edit label')
    expect(await refCount(page, elm)).toBe(1)

    await page.locator(':root').ariaSnapshot()
    expect(await refCount(page, elm)).toBe(0)

    await aiSnapshot(page)
    expect(await refCount(page, elm)).toBe(1)
    await page.locator('#oak').ariaSnapshot({ mode: 'ai' })
    expect(await refCount(page, elm)).toBe(0)

    await aiSnapshot(page)
    expect(await refCount(page, elm)).toBe(1)
  }, 60_000)

  it('a new document resets everything', async () => {
    const page = await open(ROWS_PAGE)
    const before = refsOf(await aiSnapshot(page), 'button', 'Edit label')
    const document = await page.evaluateHandle(() => (globalThis as any).document)
    // A rename mints a ref above every first-snapshot ref in this document.
    await page.evaluate(() => {
      ;(globalThis as any).document.querySelector('#home button').textContent = 'Rename label'
    })
    const [renamed] = refsOf(await aiSnapshot(page), 'button', 'Rename label')

    await page.goto('data:text/html,' + encodeURIComponent(ROWS_PAGE))

    await expect(document.evaluate((d) => d === (globalThis as any).document)).rejects.toThrow(
      /execution context was destroyed/i,
    )
    const after = refsOf(await aiSnapshot(page), 'button', 'Edit label')
    expect(after).toEqual(before)
    expect(Math.max(...after.map(refNumber))).toBeLessThan(refNumber(renamed))
  }, 60_000)

  it('pushState keeps the document and the ref', async () => {
    const page = await open(ROWS_PAGE)
    const [elm] = refsOf(await aiSnapshot(page), 'button', 'Edit label')
    const document = await page.evaluateHandle(() => (globalThis as any).document)

    await page.evaluate(() => (globalThis as any).history.pushState({}, '', '#moved'))

    expect(await document.evaluate((d) => d === (globalThis as any).document)).toBe(true)
    expect(await refCount(page, elm)).toBe(1)
  }, 60_000)

  it('frames', async () => {
    const page = await open(FRAMED_PAGE)
    const snapshot = await aiSnapshot(page)
    const [main] = refsOf(snapshot, 'button', 'Main action')
    const [approve] = refsOf(snapshot, 'button', 'Approve')
    const [decline] = refsOf(snapshot, 'button', 'Decline')

    expect(main).toMatch(/^e\d+$/)
    expect(approve).toMatch(/^f\d+e\d+$/)
    expect(decline).toMatch(/^f\d+e\d+$/)
    expect(await refCount(page, approve)).toBe(1)

    await page.evaluate(() => (globalThis as any).document.getElementById('payments').remove())

    await expect(refCount(page, approve)).rejects.toThrow(/invalid frame/i)
  }, 60_000)

  it('a renamed node gets a new ref', async () => {
    const page = await open(ROWS_PAGE)
    const [, home] = refsOf(await aiSnapshot(page), 'button', 'Edit label')

    await page.evaluate(() => {
      ;(globalThis as any).document.querySelector('#home button').textContent = 'Rename label'
    })
    const [renamed] = refsOf(await aiSnapshot(page), 'button', 'Rename label')

    expect(renamed).toBeDefined()
    expect(renamed).not.toBe(home)
  }, 60_000)
})

const NAVIGATIONS = [
  { how: 'a link click', role: 'link', name: 'Continue to next page' },
  { how: 'a form submit', role: 'button', name: 'Submit order' },
] as const

describe.each(NAVIGATIONS)('aria-ref after $how from a real URL', ({ role, name }) => {
  const crossUrl = (): string => `http://127.0.0.1:${String(port)}/cross`

  // Reads /start's snapshot, then follows its link or submits its form and reads /next's.
  async function navigate(): Promise<{ page: Page; oldRef: string; snapshot: string }> {
    context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`http://localhost:${String(port)}/start`, { waitUntil: 'load' })
    const [oldRef] = refsOf(await aiSnapshot(page), role, name)
    expect(await refCount(page, oldRef)).toBe(1)

    await page.locator('aria-ref=' + oldRef).click()
    await page.waitForURL(/\/next/)
    await page.frameLocator('#child').getByRole('button', { name: 'Child action' }).waitFor()
    await page.frameLocator('#cross').getByRole('button', { name: 'Cross action' }).waitFor()
    return { page, oldRef, snapshot: await aiSnapshot(page) }
  }

  it('a fresh main-frame ref resolves exactly once', async () => {
    const { page, snapshot } = await navigate()
    const [fresh] = refsOf(snapshot, 'button', 'Fresh action')

    expect(await refCount(page, fresh)).toBe(1)
    expect(await page.locator('aria-ref=' + fresh).textContent()).toBe('Fresh action')
  }, 60_000)

  it('a ref read before the navigation resolves zero times', async () => {
    const { page, oldRef } = await navigate()

    expect(await refCount(page, oldRef)).toBe(0)
  }, 60_000)

  it('a child-frame ref resolves once', async () => {
    const { page, snapshot } = await navigate()
    const [child] = refsOf(snapshot, 'button', 'Child action')

    expect(await refCount(page, child)).toBe(1)
    expect(await page.locator('aria-ref=' + child).textContent()).toBe('Child action')
  }, 60_000)

  it('a ref in a cross-origin out-of-process frame resolves once', async () => {
    const { page, snapshot } = await navigate()
    const [cross] = refsOf(snapshot, 'button', 'Cross action')

    expect(page.frames().map((frame) => frame.url())).toContain(crossUrl())
    const cdp = await browser!.newBrowserCDPSession()
    const { targetInfos } = await cdp.send('Target.getTargets')
    await cdp.detach()
    expect(targetInfos).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'iframe', url: crossUrl() })]),
    )
    expect(await refCount(page, cross)).toBe(1)
    expect(await page.locator('aria-ref=' + cross).textContent()).toBe('Cross action')
  }, 60_000)

  it('a ref inside an open shadow root resolves once', async () => {
    const { page, snapshot } = await navigate()
    const [shadow] = refsOf(snapshot, 'button', 'Shadow action')

    expect(await refCount(page, shadow)).toBe(1)
    expect(await page.locator('aria-ref=' + shadow).textContent()).toBe('Shadow action')
  }, 60_000)
})
