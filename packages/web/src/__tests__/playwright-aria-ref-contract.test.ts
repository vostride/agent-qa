// C438-ARIA-REF-CONFORMANCE (438 D-06; spec/v3 browser control §3.1): the playwright-core
// behaviour web/src/binding.ts relies on. `aria-ref=` is undocumented, so a playwright-core bump
// must re-run this file before anything else.
// Raw Playwright on headless Chromium, no adapter; pages are inline snippets.

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

let browser: Browser | undefined
let context: BrowserContext | undefined

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
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
