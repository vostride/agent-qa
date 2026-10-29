// C436-SCROLL-VISIBILITY (436-17 · D-24/D-25, review CR-04 and WR-06): on the web lane untilVisible
// decides target visibility by what is on screen. C436-SCROLL-REF (436-17 · D-25, review CR-03): a
// container ref scrolls and measures only the container it names. C436-SCROLL-POINTER (436-18 ·
// D-24/D-25, review CR-02): a no-ref wheel is judged by the scrollers under the pointer. Real
// headless Chromium through WebPlatformAdapter, fixtures served from a loopback node:http server.
// C436-SCROLL-REF adds the propagating body, quirks mode, body and html
// scrollers, shadow roots and an iframe-only ref (review CR-06). C436-SCROLL-FRAMES: the probe
// sees every frame and answers visible, hidden or unknown (review CR-07). C436-SCROLL-DECOYS:
// hidden, transparent and covered copies never count, positioned targets are hit-tested.
// C436-SCROLL-FRAMES adds iframes that never answer (review CR-08).

import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Frame, Locator, Page } from 'playwright-core'
import type { Ref } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { buildScrollPrimitives, FRAME_PROBE_TIMEOUT_MS } from '../compound-web.js'
import { runUntilVisibleLoop } from '@vostride/agent-qa-runner'

const page = (title: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const PARAGRAPHS = page('paragraphs', Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${String(i)}</p>`).join(''))
const BUTTONS = page('buttons', Array.from({ length: 200 }, (_, i) => `<p><button>Buy ${String(i)}</button></p>`).join(''))
const NESTED = page('nested', `
  <div id="list" style="height: 200px; overflow: auto; border: 1px solid #888">
    ${Array.from({ length: 30 }, (_, i) => `<div style="height: 40px">Entry ${String(i)}</div>`).join('')}
  </div>
  <p>Below the list</p>`)
const LABELLED = page('labelled', '<h1>Dialog</h1><button aria-label="Close dialog">×</button>')
const SHORT = page('short', '<h1>Short page</h1><p>Nothing to scroll here.</p><button>Do nothing</button>')
// The listbox scrolls, and so does the page around it, so a swipe on the wrong scroller shows.
const LISTBOX = page('listbox', `
  <select id="rows" multiple aria-label="Rows" style="height: 300px">
    ${Array.from({ length: 100 }, (_, i) => `<option>Row ${String(i)}</option>`).join('')}
  </select>
  <div style="height: 3000px">Page tail</div>`)
const STALE = page('stale', `
  <div id="feed" role="region" aria-label="Feed" style="height: 200px; overflow: auto">
    ${Array.from({ length: 30 }, (_, i) => `<div style="height: 40px">Post ${String(i)}</div>`).join('')}
  </div>
  <div style="height: 3000px">Page tail</div>`)

// proof-wheel.mjs: a 700 px list above a footer, so the document can scroll only 120 px.
const POINTER = page('pointer', `
  <style>body{margin:0} #list{height:700px;overflow:auto;margin:0} footer{height:120px}</style>
  <ul id="list">${Array.from({ length: 200 }, (_, i) => `<li><button>Item ${String(i)}</button></li>`).join('')}</ul>
  <footer>Footer</footer>`)

// review2-body-prop*.mjs and review2-quirks.mjs: a ref near the top of a 3000 px page whose body
// overflow propagates to the viewport, or a quirks-mode page.
const PROP_TAIL = '<div style="height:3000px"><button style="position:relative;top:10px">Item one</button></div><p>Footer text</p>'
const PROP_BODY = `<!DOCTYPE html><html><head><style>html,body{height:100%} body{margin:0;overflow-x:hidden}</style></head><body>${PROP_TAIL}</body></html>`
const PROP_BODY_Y = `<!DOCTYPE html><html><head><style>html{height:100%} body{height:100%;margin:0;overflow-y:auto}</style></head><body>${PROP_TAIL}</body></html>`
const QUIRKS = `<html><head></head><body>${PROP_TAIL}</body></html>`
const BODY_SCROLLER = `<!DOCTYPE html><html><head><style>html{height:100%;overflow:hidden} body{height:100%;margin:0;overflow:auto}</style></head><body>${PROP_TAIL}</body></html>`
const HTML_SCROLLER = `<!DOCTYPE html><html><head><style>html{height:100%;overflow:auto}</style></head><body>${PROP_TAIL}</body></html>`
// Quirks mode with a body that could scroll: document.scrollingElement is null.
const NO_SCROLLING_ELEMENT = '<html><head><style>html{height:100%;overflow:hidden} body{height:100%;margin:0;overflow:auto}</style></head><body><button>Lone button</button></body></html>'
const SLOTTED = page('slotted', `
  <div id="host"><template shadowrootmode="open"><div id="inner" style="height:200px;overflow:auto"><slot></slot></div></template>
    ${Array.from({ length: 30 }, (_, i) => `<button style="display:block;height:40px">Slot item ${String(i)}</button>`).join('')}
  </div>
  <div style="height:3000px">Page tail</div>`)
const SHADOW_TREE = page('shadow tree', `
  <div id="box" style="height:200px;overflow:auto">
    <div id="host"><template shadowrootmode="open"><div style="height:1200px"><button>Shadow item</button></div></template></div>
  </div>
  <div style="height:3000px">Page tail</div>`)
const FRAMED_ONLY = page('framed only', `
  <iframe id="frame" src="/framed-only-inner" style="width:400px;height:150px"></iframe>
  <div style="height:3000px">Page tail</div>`)
const FRAMED_ONLY_INNER = page('framed only inner', '<div style="height:2000px"><button>Framed item</button></div>')

// review2-iframe-target3.mjs: an on-screen iframe away from the pointer, then 2000 px of page.
const PAY_FRAME = '<!DOCTYPE html><html><body><button>Pay now</button></body></html>'
const FRAME_STYLE = 'margin-left:500px;width:400px;height:150px;border:0;display:block'
const framePage = (src: string, style = FRAME_STYLE, before = '', after = '<div style="height:2000px">Body</div>'): string =>
  `<!DOCTYPE html><html><body style="margin:0">${before}<iframe id="frame" src="${src}" style="${style}"></iframe>${after}</body></html>`
const FRAME_SAME = framePage('/frame-pay')
const FRAME_SLOW = framePage('/frame-pay')
const FRAME_CROSS = (port: number): string => framePage(`http://127.0.0.1:${String(port)}/frame-pay`)
const FRAME_NESTED = framePage('/frame-mid', 'margin-left:500px;width:400px;height:300px;border:0;display:block')
const FRAME_MID = '<!DOCTYPE html><html><body style="margin:0"><iframe src="/frame-pay" style="width:300px;height:150px;border:0"></iframe></body></html>'
const FRAME_BELOW = framePage('/frame-pay', FRAME_STYLE, '<div style="height:2000px">Above</div>', '<div style="height:1000px">Below</div>')
// The page itself can scroll 280 px, so both searches meet real boundaries.
const FRAME_SCROLLED_OUT = framePage('/frame-pay-deep', FRAME_STYLE, '', '<div style="height:850px">Body</div>')
const PAY_FRAME_DEEP = '<!DOCTYPE html><html><body><div style="height:1500px">Top</div><button>Pay now</button></body></html>'
const FRAME_SCALED = framePage('/frame-pay', `${FRAME_STYLE};transform:scale(0.5)`, '', '<div style="height:850px">Body</div>')
const FRAME_COVERED = framePage('/frame-pay', FRAME_STYLE, '',
  '<div style="height:850px">Body</div><div style="position:fixed;inset:0;background:rgba(0,0,0,0.3)"></div>')
// review3-hung-frame-probe.mjs: an iframe whose server never answers (/hang).
const HUNG_PROBE = `<!DOCTYPE html><html><body><h1>Account</h1><button>Top target</button><iframe src="/hang" style="width:300px;height:120px"></iframe>
<div style="height:3000px"></div><button>Far target</button></body></html>`
const HUNG_BESIDE_HEALTHY = '<!DOCTYPE html><html><body style="margin:0"><iframe src="/hang"></iframe>' +
  `<iframe id="pay" src="/frame-pay" style="${FRAME_STYLE}"></iframe><div style="height:850px">Body</div></body></html>`
const HUNG_ABSENT = page('hung absent', '<h1>Account</h1><iframe src="/hang"></iframe><div style="height:1500px">Spacer</div>')

// a copy of the target at the top, the real button 4000 px down.
const decoyPage = (title: string, decoy: string): string => page(title, `
  ${decoy}
  <div style="height:4000px">Spacer</div>
  <button id="real">Delete account</button>
  <div style="height:1000px">Tail</div>`)
const SR_ONLY = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0'
const DECOY_SR_ONLY = decoyPage('sr-only', `<a href="#real" style="${SR_ONLY}">Delete account</a>`)
const DECOY_OPACITY = decoyPage('opacity', '<div style="opacity:0">Delete account</div>')
const DECOY_OVERLAY = decoyPage('overlay',
  '<p>Delete account</p><div style="position:fixed;inset:0;background:rgba(0,0,0,0.3)"></div>')
const frameDecoy = (wrapper: string): string =>
  `<div style="${wrapper}"><iframe srcdoc="<button>Delete account</button>" style="width:400px;height:150px"></iframe></div>`
const DECOY_FRAME_OPACITY = decoyPage('frame opacity', frameDecoy('opacity:0'))
const DECOY_FRAME_HIDDEN = decoyPage('frame hidden', frameDecoy('visibility:hidden'))
// review3-probe-misjudge.mjs: on-screen text in a display:contents holder or host, and a card
// title under a transparent stretched-link overlay.
const CONTENTS = page('contents',
  '<h1>Checkout</h1><div style="display:contents">Pay now</div><p>Short page</p><div style="height:1200px"></div><p>End</p>')
const CONTENTS_HOST = page('host', `<h1>Checkout</h1><pay-button>Pay now</pay-button><div style="height:1200px"></div><p>End</p>
<script>customElements.define('pay-button', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host{display:contents}</style><button><slot></slot></button>' } })</script>`)
const CARD = page('card', `<style>.card{position:relative;width:300px;border:1px solid #ccc;padding:12px}.stretched::after{content:"";position:absolute;inset:0;z-index:1}</style>
<div class="card"><h5>Premium plan</h5><p>All features</p><a class="stretched" href="#plan">Choose</a></div>`)
const CONTENTS_EMPTY = page('contents empty',
  '<h1>Toolbar</h1><div style="display:contents" title="Open menu"></div><div style="height:1200px"></div>')
const POSITIONED_FIXED = page('fixed', `
  <div style="overflow:hidden;height:10px"><button style="position:fixed;bottom:20px;right:20px">Chat with us</button></div>
  <div style="height:2000px">Tail</div>`)
const POSITIONED_ABSOLUTE = page('absolute', `
  <div style="overflow:hidden;height:10px"><span style="position:absolute;top:100px">Escaped label</span></div>
  <div style="height:2000px">Tail</div>`)
const POINTER_NONE = page('pointer-events', `
  <button><span style="pointer-events:none">Save draft</span></button>
  <div style="height:2000px">Tail</div>`)
const SHADOW_TARGET = page('shadow target', `
  <div id="host"><template shadowrootmode="open"><button>Shadow pay</button></template></div>
  <div style="height:2000px">Tail</div>`)
// Slot item 25 sits 500 px down a 200 px internal scroller: inside the viewport's rectangle,
// outside the scroller's box.
const SLOTTED_CLIPPED = page('slotted clipped', `
  <div id="host"><template shadowrootmode="open"><div id="inner" style="height:200px;overflow:auto"><slot></slot></div></template>
    ${Array.from({ length: 40 }, (_, i) => `<div style="height:20px">Slot item ${String(i)}</div>`).join('')}
  </div>
  <div style="height:3000px">Page tail</div>`)

const PAGES: Record<string, string | ((port: number) => string)> = {
  '/decoy-sr-only': DECOY_SR_ONLY,
  '/decoy-opacity': DECOY_OPACITY,
  '/decoy-overlay': DECOY_OVERLAY,
  '/decoy-frame-opacity': DECOY_FRAME_OPACITY,
  '/decoy-frame-hidden': DECOY_FRAME_HIDDEN,
  '/contents': CONTENTS,
  '/host': CONTENTS_HOST,
  '/card': CARD,
  '/contents-empty': CONTENTS_EMPTY,
  '/positioned-fixed': POSITIONED_FIXED,
  '/positioned-absolute': POSITIONED_ABSOLUTE,
  '/pointer-none': POINTER_NONE,
  '/shadow-target': SHADOW_TARGET,
  '/slotted-clipped': SLOTTED_CLIPPED,
  '/frame-same': FRAME_SAME,
  '/frame-slow': FRAME_SLOW,
  '/frame-cross': FRAME_CROSS,
  '/frame-nested': FRAME_NESTED,
  '/frame-mid': FRAME_MID,
  '/frame-pay': PAY_FRAME,
  '/frame-below': FRAME_BELOW,
  '/frame-scrolled-out': FRAME_SCROLLED_OUT,
  '/frame-pay-deep': PAY_FRAME_DEEP,
  '/frame-scaled': FRAME_SCALED,
  '/frame-covered': FRAME_COVERED,
  '/hung-probe': HUNG_PROBE,
  '/hung-beside-healthy': HUNG_BESIDE_HEALTHY,
  '/hung-absent': HUNG_ABSENT,
  '/prop-body': PROP_BODY,
  '/prop-body-y': PROP_BODY_Y,
  '/quirks': QUIRKS,
  '/body-scroller': BODY_SCROLLER,
  '/html-scroller': HTML_SCROLLER,
  '/no-scrolling-element': NO_SCROLLING_ELEMENT,
  '/slotted': SLOTTED,
  '/shadow-tree': SHADOW_TREE,
  '/framed-only': FRAMED_ONLY,
  '/framed-only-inner': FRAMED_ONLY_INNER,
  '/pointer': POINTER,
  '/paragraphs': PARAGRAPHS,
  '/buttons': BUTTONS,
  '/nested': NESTED,
  '/labelled': LABELLED,
  '/short': SHORT,
  '/listbox': LISTBOX,
  '/stale': STALE,
}

// The web native search waits the page's default action timeout for a target that is not in the
// DOM; a short default keeps the absent-target cells quick and changes no result.
const NATIVE_SEARCH_TIMEOUT_MS = 2_000

let server: Server
let baseUrl = ''
let adapter: WebPlatformAdapter | undefined
// /hang never answers; each parked response is destroyed after its cell.
const parkedResponses = new Set<ServerResponse>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/hang') {
      parkedResponses.add(res)
      res.on('close', () => parkedResponses.delete(res))
      return
    }
    const entry = PAGES[path]
    const html = typeof entry === 'function' ? entry((server.address() as AddressInfo).port) : entry
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

async function open(path: string): Promise<{ web: WebPlatformAdapter; tab: Page }> {
  const opened = await openLoaded(path, 'load')
  await opened.web.observe()
  return opened
}

// A page holding a hung iframe never fires `load`, so it is opened at domcontentloaded and not observed.
async function openHung(path: string): Promise<{ web: WebPlatformAdapter; tab: Page }> {
  return openLoaded(path, 'domcontentloaded')
}

async function openLoaded(path: string, waitUntil: 'load' | 'domcontentloaded'): Promise<{ web: WebPlatformAdapter; tab: Page }> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  const tab = created.getPage()!
  tab.setDefaultTimeout(NATIVE_SEARCH_TIMEOUT_MS)
  await tab.goto(baseUrl + path, { waitUntil })
  return { web: created, tab }
}

const STILL_WAITING = 'still waiting at the sentinel'

// An unbounded wait fails on its assertion, not on the cell timeout.
async function withSentinel<T>(work: Promise<T>, ms = 20_000): Promise<{ value: T | typeof STILL_WAITING; ms: number }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const value = await Promise.race([
    work,
    new Promise<typeof STILL_WAITING>((resolve) => { timer = setTimeout(() => { resolve(STILL_WAITING) }, ms) }),
  ])
  clearTimeout(timer)
  return { value, ms: Date.now() - started }
}

type Rect = { top: number; bottom: number; innerHeight: number }

async function rectOf(tab: Page, selector: string, index: number): Promise<Rect> {
  return tab.evaluate(([sel, i]) => {
    const g = globalThis as unknown as {
      innerHeight: number
      document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { top: number; bottom: number } }> }
    }
    const r = g.document.querySelectorAll(sel)[i].getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, innerHeight: g.innerHeight }
  }, [selector, index] as const)
}

async function scrollY(tab: Page): Promise<number> {
  return tab.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY)
}

async function refFor(web: WebPlatformAdapter, role: string, name: string): Promise<Ref> {
  const element = (await web.observe()).elements.find((e) => e.role === role && e.name === name)
  expect(element, `${role} "${name}" is observed`).toBeDefined()
  return element!.ref
}

function untilVisible(text: string, maxSwipes: number, ref?: Ref) {
  return {
    type: 'scroll' as const,
    mode: 'untilVisible' as const,
    text,
    direction: 'down' as const,
    maxSwipes,
    retryOpposite: false,
    ...(ref ? { ref } : {}),
  }
}

describe('untilVisible counts a target only when it is on screen', () => {
  it('on-screen plain text ends found', async () => {
    const { web, tab } = await open('/paragraphs')
    const result = await web.execute(untilVisible('Paragraph 190', 3))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    const rect = await rectOf(tab, 'p', 190)
    expect(rect.innerHeight).toBe(720)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(rect.innerHeight)
    expect(await buildScrollPrimitives(tab, {}, 720).probeTargetVisible!('Paragraph 190')).toBe('visible')
  }, 60_000)

  it('a named button below the fold is not found until it is on screen', async () => {
    const { web, tab } = await open('/buttons')
    const probe = buildScrollPrimitives(tab, {}, 720)
    expect(await probe.probeTargetVisible!('Buy 190')).toBe('hidden')
    expect(await probe.probeTargetVisible!('Buy 1')).toBe('visible')
    expect(await scrollY(tab)).toBe(0)

    const result = await web.execute(untilVisible('Buy 190', 3))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    expect(await scrollY(tab), 'the page actually moved').toBeGreaterThan(0)
    const rect = await rectOf(tab, 'button', 190)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(rect.innerHeight)
    expect(await probe.probeTargetVisible!('Buy 190')).toBe('visible')
  }, 60_000)

  it('an element clipped by a nested scroller is not visible', async () => {
    const { tab } = await open('/nested')
    const probe = buildScrollPrimitives(tab, {}, 720)
    // Entry 10 sits 400 px down the 200 px list: inside the viewport's rectangle, outside the list's box.
    const clipped = await rectOf(tab, '#list > div', 10)
    expect(clipped.top).toBeGreaterThan(0)
    expect(clipped.bottom).toBeLessThan(clipped.innerHeight)
    // The search may not have moved the list, so the clip cannot prove the entry hidden.
    expect(await probe.probeTargetVisible!('Entry 10')).toBe('unknown')
    expect(await probe.probeTargetVisible!('Entry 0')).toBe('visible')
  }, 60_000)

  it('an aria-label-only target counts when on screen', async () => {
    const { tab } = await open('/labelled')
    const probe = buildScrollPrimitives(tab, {}, 720)
    expect(await probe.probeTargetVisible!('close dialog')).toBe('visible')
  }, 60_000)

  it('a target absent from the page never ends found', async () => {
    const { web } = await open('/short')
    const result = await web.execute(untilVisible('No such text', 2))
    const meta = result.metadata?.scrollUntilVisible as { outcome: string } | undefined
    expect(meta).toBeDefined()
    expect(meta!.outcome).not.toBe('found')
  }, 60_000)
})

describe('a scroll by ref moves the scroller that holds the ref', () => {
  it('a listbox ref scrolls the listbox itself', async () => {
    const { web, tab } = await open('/listbox')
    const ref = await refFor(web, 'listbox', 'Rows')
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false, ref,
    })
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
    const list = await tab.evaluate(() => {
      const el = (globalThis as unknown as {
        document: { getElementById(id: string): { scrollTop: number; scrollHeight: number; clientHeight: number } }
      }).document.getElementById('rows')
      return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
    })
    expect(list.max).toBeGreaterThan(0)
    expect(Math.abs(list.top - list.max)).toBeLessThanOrEqual(1)
    expect(await scrollY(tab), 'the window did not move').toBe(0)
  }, 60_000)

  it('a ref that no longer resolves reports unknown and moves nothing', async () => {
    const { web, tab } = await open('/stale')
    const ref = await refFor(web, 'region', 'Feed')
    await tab.evaluate(() => {
      (globalThis as unknown as { document: { getElementById(id: string): { remove(): void } } })
        .document.getElementById('feed').remove()
    })
    const result = await web.execute(untilVisible('No such post', 2, ref))
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 2, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes',
    })
    expect(await scrollY(tab), 'the window did not move').toBe(0)
  }, 60_000)

  it('a resolved element with no scrollable ancestor on a page that cannot scroll is unknown, never a boundary', async () => {
    const { web, tab } = await open('/short')
    const ref = await refFor(web, 'button', 'Do nothing')
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false, ref,
    })
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 20, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes',
    })
    expect(await scrollY(tab)).toBe(0)
  }, 60_000)

  it('a ref under a body whose overflow propagates scrolls the page', async () => {
    await refScrollsThePage('/prop-body')
  }, 60_000)

  it('the overflow-y:auto propagating body variant scrolls the page', async () => {
    await refScrollsThePage('/prop-body-y')
  }, 60_000)

  it('a quirks-mode page scrolls through document.scrollingElement', async () => {
    await refScrollsThePage('/quirks')
  }, 60_000)

  it('a body that is its own scroller is scrolled and measured itself', async () => {
    const { web, tab } = await open('/body-scroller')
    const ref = await refFor(web, 'button', 'Item one')
    await web.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref })
    expect(await valueOf(tab, 'document.body.scrollTop')).toBe(720)
    expect(await scrollY(tab), 'the window did not move').toBe(0)
    await tab.evaluate('document.body.scrollTop = 1500')
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'up', amount: 'toEnd', retryOpposite: false, ref,
    })
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
    expect(await valueOf(tab, 'document.body.scrollTop')).toBe(0)
  }, 60_000)

  it('an html scroller is measured as the document scroller', async () => {
    const { web, tab } = await open('/html-scroller')
    const ref = await refFor(web, 'button', 'Item one')
    await web.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref })
    expect(await valueOf(tab, 'document.documentElement.scrollTop')).toBe(720)
  }, 60_000)

  it("a slotted ref scrolls its open shadow root's internal scroller", async () => {
    const { web, tab } = await open('/slotted')
    const ref = await refFor(web, 'button', 'Slot item 0')
    await web.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref })
    expect(await valueOf(tab, "document.getElementById('host').shadowRoot.getElementById('inner').scrollTop")).toBeGreaterThan(0)
    expect(await scrollY(tab), 'the window did not move').toBe(0)
  }, 60_000)

  it("a ref inside an open shadow tree scrolls its host's scrolling ancestor", async () => {
    const { web, tab } = await open('/shadow-tree')
    const ref = await refFor(web, 'button', 'Shadow item')
    await web.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref })
    expect(await valueOf(tab, "document.getElementById('box').scrollTop")).toBeGreaterThan(0)
    expect(await scrollY(tab), 'the window did not move').toBe(0)
  }, 60_000)

  it('a page with no scrolling element reports unknown', async () => {
    const { web, tab } = await open('/no-scrolling-element')
    expect(await tab.evaluate('document.scrollingElement === null')).toBe(true)
    const ref = await refFor(web, 'button', 'Lone button')
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref,
    })
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 1, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes',
    })
  }, 60_000)

  it('an iframe-only ref moves nothing and reads unknown', async () => {
    const { web, tab } = await open('/framed-only')
    const ref = await refFor(web, 'button', 'Framed item')
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref,
    })
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ endedBy: 'max-swipes' })
    expect(await scrollY(tab), 'the window did not move').toBe(0)
    expect(await valueOf(tab, "document.getElementById('frame').contentWindow.scrollY"), 'the iframe did not move').toBe(0)
  }, 60_000)
})

async function valueOf(tab: Page, expression: string): Promise<number> {
  return tab.evaluate<number>(expression)
}

// A ref near the top: `down` moves the page one viewport, and `toEnd up` from 1500 ends on the
// page's own top, never on a container the gesture did not move (review CR-06).
async function refScrollsThePage(path: string): Promise<void> {
  const { web, tab } = await open(path)
  const ref = await refFor(web, 'button', 'Item one')
  await web.execute({ type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: false, ref })
  expect(await scrollY(tab), 'down moved the page one viewport').toBe(720)
  await tab.evaluate('window.scrollTo(0, 1500)')
  const result = await web.execute({
    type: 'scroll', mode: 'direction', direction: 'up', amount: 'toEnd', retryOpposite: false, ref,
  })
  expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
  expect(await scrollY(tab), 'the boundary is the page top').toBe(0)
}

type Extent = { top: number; max: number }

async function listExtent(tab: Page): Promise<Extent> {
  return tab.evaluate(() => {
    const el = (globalThis as unknown as {
      document: { getElementById(id: string): { scrollTop: number; scrollHeight: number; clientHeight: number } }
    }).document.getElementById('list')
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
  })
}

async function documentExtent(tab: Page): Promise<Extent> {
  return tab.evaluate(() => {
    const el = (globalThis as unknown as {
      document: { scrollingElement: { scrollTop: number; scrollHeight: number; clientHeight: number } }
    }).document.scrollingElement
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
  })
}

// The proof-wheel.mjs setup: the document already at its bottom, the pointer inside the list.
async function openPointerList(): Promise<{ web: WebPlatformAdapter; tab: Page }> {
  const opened = await open('/pointer')
  await opened.tab.evaluate(() => {
    const g = globalThis as unknown as {
      scrollTo(x: number, y: number): void
      document: { scrollingElement: { scrollHeight: number } }
    }
    g.scrollTo(0, g.document.scrollingElement.scrollHeight)
  })
  await opened.tab.mouse.click(200, 200)
  const doc = await documentExtent(opened.tab)
  expect(doc.max).toBeGreaterThan(0)
  expect(Math.abs(doc.top - doc.max), 'the document starts at its bottom').toBeLessThanOrEqual(1)
  expect((await listExtent(opened.tab)).top).toBe(0)
  return opened
}

describe('a scroll follows the scroller under the pointer', () => {
  it('toEnd with the pointer in a nested list follows the list to its end', async () => {
    const { web, tab } = await openPointerList()
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false,
    })
    const meta = result.metadata?.scrollUntilVisible as { swipes: number } | undefined
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
    expect(meta!.swipes).toBeGreaterThan(1)
    const list = await listExtent(tab)
    expect(list.max).toBeGreaterThan(0)
    expect(Math.abs(list.top - list.max), 'the list reached its end').toBeLessThanOrEqual(1)
  }, 60_000)

  it('untilVisible in the nested list never ends not-found on the document boundary', async () => {
    const { web, tab } = await openPointerList()
    // The wheel under the pointer moves the list while the document sits at its bottom.
    expect(await buildScrollPrimitives(tab, {}, 720).swipeOnce('down')).toBe('moved')
    const result = await web.execute({
      type: 'scroll', mode: 'untilVisible', text: 'Item 150', direction: 'down', maxSwipes: 3, retryOpposite: false,
    })
    const meta = result.metadata?.scrollUntilVisible as { outcome: string } | undefined
    expect(meta).toBeDefined()
    expect(['found', 'unresolved']).toContain(meta!.outcome)
  }, 60_000)

  it('a wheel over the document alone keeps the document rule', async () => {
    const { web, tab } = await open('/paragraphs')
    await tab.mouse.click(200, 200)
    const result = await web.execute({
      type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false,
    })
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'boundary' })
    const doc = await documentExtent(tab)
    expect(doc.max).toBeGreaterThan(0)
    expect(Math.abs(doc.top - doc.max)).toBeLessThanOrEqual(1)
  }, 60_000)

  it('the probe leaves nothing on the page', async () => {
    const { tab } = await openPointerList()
    const fingerprint = () => tab.evaluate(() => {
      const g = globalThis as unknown as {
        document: { querySelectorAll(s: string): ArrayLike<{ tagName: string; getAttributeNames(): string[]; getAttribute(n: string): string | null }> }
      }
      const attributes = Array.from(g.document.querySelectorAll('*'), (el) =>
        `${el.tagName}[${el.getAttributeNames().map((n) => `${n}=${String(el.getAttribute(n))}`).join(',')}]`)
      return { keys: Object.keys(globalThis).sort(), attributes }
    })
    const before = await fingerprint()
    expect(await buildScrollPrimitives(tab, {}, 720).swipeOnce('down')).toBe('moved')
    const after = await fingerprint()
    expect(after.keys).toEqual(before.keys)
    expect(after.attributes).toEqual(before.attributes)
  }, 60_000)
})

// Every search starts at the top with the pointer away from the iframe.
function search(direction: 'up' | 'down', maxSwipes: number) {
  return { type: 'scroll' as const, mode: 'untilVisible' as const, text: 'Pay now', direction, maxSwipes, retryOpposite: true }
}

async function payNow(tab: Page): Promise<string> {
  return buildScrollPrimitives(tab, {}, 720).probeTargetVisible!('Pay now')
}

async function frameIntersectsViewport(tab: Page): Promise<boolean> {
  return tab.evaluate<boolean>(`(() => {
    const r = document.getElementById('frame').getBoundingClientRect()
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  })()`)
}

describe('untilVisible across iframes', () => {
  it('an on-screen target in a same-origin iframe ends found', async () => {
    const { web, tab } = await open('/frame-same')
    expect(await payNow(tab)).toBe('visible')
    const result = await web.execute(search('up', 5))
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 0, reversedOnce: false, outcome: 'found', endedBy: 'target-visible',
    })
  }, 60_000)

  it('an on-screen target in a cross-origin iframe ends found', async () => {
    const { web, tab } = await open('/frame-cross')
    expect(tab.frames().some((f) => f.url().startsWith('http://127.0.0.1:'))).toBe(true)
    expect(await payNow(tab)).toBe('visible')
    const result = await web.execute(search('up', 5))
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 0, reversedOnce: false, outcome: 'found', endedBy: 'target-visible',
    })
  }, 60_000)

  it('an on-screen target in an iframe nested in an iframe ends found', async () => {
    const { web, tab } = await open('/frame-nested')
    expect(tab.frames()).toHaveLength(3)
    expect(await payNow(tab)).toBe('visible')
    const result = await web.execute(search('up', 5))
    expect(result.metadata?.scrollUntilVisible).toEqual({
      swipes: 0, reversedOnce: false, outcome: 'found', endedBy: 'target-visible',
    })
  }, 60_000)

  it('an iframe below the fold is found once the page brings it on screen', async () => {
    const { web, tab } = await open('/frame-below')
    expect(await frameIntersectsViewport(tab)).toBe(false)
    expect(await payNow(tab)).toBe('unknown')
    const result = await web.execute(search('down', 5))
    const meta = result.metadata?.scrollUntilVisible as { swipes: number } | undefined
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    expect(meta!.swipes).toBeGreaterThanOrEqual(1)
    expect(await frameIntersectsViewport(tab)).toBe(true)
  }, 60_000)

  it('a target scrolled out of view inside its iframe never ends not-found', async () => {
    const { web, tab } = await open('/frame-scrolled-out')
    expect(await payNow(tab)).toBe('unknown')
    const result = await web.execute(search('down', 5))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'unresolved' })
  }, 60_000)

  it('a target in a scaled iframe is never judged by a guess', async () => {
    const { web, tab } = await open('/frame-scaled')
    expect(await frameIntersectsViewport(tab)).toBe(true)
    expect(await payNow(tab)).toBe('unknown')
    const result = await web.execute(search('down', 5))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'unresolved' })
  }, 60_000)

  it('an iframe covered by a fixed overlay never ends found or not-found', async () => {
    const { web, tab } = await open('/frame-covered')
    expect(await frameIntersectsViewport(tab)).toBe(true)
    expect(await payNow(tab)).toBe('unknown')
    const result = await web.execute(search('down', 5))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'unresolved' })
  }, 60_000)

  it('a page whose iframe never answers ends untilVisible inside the budget', async () => {
    const { web, tab } = await openHung('/hung-probe')
    const find = (text: string) => withSentinel(web.execute(
      { type: 'scroll', mode: 'untilVisible', direction: 'down', text, maxSwipes: 6, retryOpposite: false },
      { remainingStepMs: 60_000 },
    ))
    const top = await find('Top target')
    expect(top.value, 'Top target').not.toBe(STILL_WAITING)
    expect(top.ms).toBeLessThan(15_000)
    expect((top.value as ActionOutcome).metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
    const far = await find('Far target')
    expect(far.value, 'Far target').not.toBe(STILL_WAITING)
    expect(far.ms).toBeLessThan(15_000)
    expect((far.value as ActionOutcome).metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found' })
    // The native rung brings the far target on screen; found then means the page really moved.
    expect(await scrollY(tab), 'the page moved').toBeGreaterThan(0)
    // Swipes only: every swipe is followed by a probe across the hung frame.
    await tab.evaluate('window.scrollTo(0, 0)')
    const { nativeSearchScroll: _native, ...swipesOnly } = buildScrollPrimitives(tab, {}, 720)
    const swiped = await withSentinel(runUntilVisibleLoop(swipesOnly, {
      target: 'Far target', direction: 'down', maxSwipes: 6, retryOpposite: false,
    }))
    expect(swiped.value, 'Far target by swipes').not.toBe(STILL_WAITING)
    expect(swiped.ms).toBeLessThan(15_000)
    const meta = (swiped.value as Awaited<ReturnType<typeof runUntilVisibleLoop>>).meta
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    expect(meta.swipes).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it("a hung frame beside a healthy frame does not hide the healthy frame's target", async () => {
    const { web, tab } = await openHung('/hung-beside-healthy')
    await tab.frameLocator('#pay').getByText('Pay now').waitFor()
    const run = await withSentinel(web.execute(untilVisible('Pay now', 3), { remainingStepMs: 60_000 }))
    expect(run.value).not.toBe(STILL_WAITING)
    expect(run.ms).toBeLessThan(FRAME_PROBE_TIMEOUT_MS + 1_500)
    expect((run.value as ActionOutcome).metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('an absent target beside a hung frame ends unresolved inside the budget', async () => {
    const { web } = await openHung('/hung-absent')
    const run = await withSentinel(web.execute(
      { ...untilVisible('No such text', 3), retryOpposite: true },
      { remainingStepMs: 60_000 },
    ))
    expect(run.value).not.toBe(STILL_WAITING)
    expect(run.ms).toBeLessThan(15_000)
    expect((run.value as ActionOutcome).metadata?.scrollUntilVisible).toMatchObject({ outcome: 'unresolved' })
  }, 60_000)

  it('a frame with no committed document is unknown at once', async () => {
    const { tab } = await openHung('/hung-absent')
    await expect.poll(() => tab.frames().length).toBe(2)
    const hung = tab.frames().find((frame) => frame !== tab.mainFrame())
    expect(hung!.url()).toBe('')
    const probe = await withSentinel(buildScrollPrimitives(tab, {}, 720).probeTargetVisible!('No such text'), 5_000)
    expect(probe.value).toBe('unknown')
    expect(probe.ms).toBeLessThan(FRAME_PROBE_TIMEOUT_MS)
  }, 60_000)

  it('committed frames that never answer are unknown at the bound, once per search', async () => {
    const { tab } = await open('/short')
    const calls = [0, 0]
    const fakes = calls.map((_, i) => {
      const never = (): Promise<never> => {
        calls[i] += 1
        return new Promise<never>(() => undefined)
      }
      return fakeFrame(tab, never, never)
    })
    vi.spyOn(tab, 'frames').mockReturnValue([...tab.frames(), ...fakes])
    const primitives = buildScrollPrimitives(tab, {}, 720)
    const first = await withSentinel(primitives.probeTargetVisible!('No such text'), 5_000)
    expect(first.value).toBe('unknown')
    expect(first.ms).toBeGreaterThanOrEqual(FRAME_PROBE_TIMEOUT_MS - 50)
    expect(first.ms, 'both frames judged at once').toBeLessThan(FRAME_PROBE_TIMEOUT_MS + 500)
    const second = await withSentinel(primitives.probeTargetVisible!('No such text'), 5_000)
    expect(second.value).toBe('unknown')
    expect(second.ms).toBeLessThan(300)
    expect(calls, 'no second evaluate while a frame is pending').toEqual([1, 1])
  }, 60_000)

  it('a frame that answers after the bound is judged again on the next probe', async () => {
    const { tab } = await open('/short')
    let judged = 0
    let answerLate: (value: unknown[]) => void = () => undefined
    const late = new Promise<unknown[]>((resolve) => { answerLate = resolve })
    const fake = fakeFrame(tab, () => {
      judged += 1
      return judged === 1 ? late : Promise.resolve([])
    }, () => late)
    vi.spyOn(tab, 'frames').mockReturnValue([...tab.frames(), fake])
    const primitives = buildScrollPrimitives(tab, {}, 720)
    const first = await withSentinel(primitives.probeTargetVisible!('No such text'), 5_000)
    expect(first.value).toBe('unknown')
    expect(first.ms).toBeGreaterThanOrEqual(FRAME_PROBE_TIMEOUT_MS - 50)
    answerLate([])
    await late
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const judgedBefore = judged
    const second = await withSentinel(primitives.probeTargetVisible!('No such text'), 5_000)
    expect(judged - judgedBefore, 'the next probe judges the frame').toBe(1)
    expect(second.value).toBe('hidden')
  }, 60_000)

  it('a slow but healthy frame on screen is found at zero swipes', async () => {
    const { web, tab } = await open('/frame-slow')
    const pay = tab.frames().find((frame) => frame !== tab.mainFrame())
    expect(pay, 'the pay frame is attached').toBeDefined()
    const slow = slowCandidates(pay!)
    const result = await web.execute(search('up', 5))
    expect(slow.judged, 'the frame was judged through the slow candidates').toBeGreaterThan(0)
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)
})

// A committed child frame: `evaluate` answers the liveness check, the candidates locator's
// `evaluateAll` the judge.
function fakeFrame(
  tab: Page,
  evaluateAll: () => Promise<unknown[]>,
  evaluate: () => Promise<unknown> = () => new Promise(() => undefined),
): Frame {
  const locator: Record<string, unknown> = { evaluateAll }
  locator.or = () => locator
  const candidates = () => locator
  return {
    url: () => 'http://fake.invalid/frame',
    isDetached: () => false,
    parentFrame: () => tab.mainFrame(),
    evaluate,
    getByText: candidates,
    getByLabel: candidates,
    getByAltText: candidates,
    getByTitle: candidates,
  } as unknown as Frame
}

// A real frame whose candidates answer only after the frame bound, as a very large frame does.
function slowCandidates(frame: Frame): { judged: number } {
  const seen = { judged: 0 }
  const slow = (real: Locator): Locator => new Proxy(real, {
    get(target, prop) {
      if (prop === 'or') return (other: Locator) => slow(target.or(other))
      if (prop === 'evaluateAll') {
        return async (...args: Parameters<Locator['evaluateAll']>) => {
          seen.judged += 1
          await new Promise((resolve) => { setTimeout(resolve, FRAME_PROBE_TIMEOUT_MS + 500) })
          return target.evaluateAll(...args)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  for (const name of ['getByText', 'getByLabel', 'getByAltText', 'getByTitle'] as const) {
    const real = frame[name].bind(frame) as (...args: unknown[]) => Locator
    Object.assign(frame, { [name]: (...args: unknown[]) => slow(real(...args)) })
  }
  return seen
}

type ActionOutcome = Awaited<ReturnType<WebPlatformAdapter['execute']>>

async function realButtonOnScreen(tab: Page): Promise<boolean> {
  return tab.evaluate<boolean>(`(() => {
    const r = document.getElementById('real').getBoundingClientRect()
    return r.top >= 0 && r.bottom <= innerHeight
  })()`)
}

async function innerScrollTop(tab: Page): Promise<number> {
  return tab.evaluate<number>("document.getElementById('host').shadowRoot.getElementById('inner').scrollTop")
}

const ZERO_SWIPES_FOUND = { swipes: 0, reversedOnce: false, outcome: 'found', endedBy: 'target-visible' }

describe('hidden, transparent and covered copies do not count as visible', () => {
  it('a visually hidden copy never ends found at zero swipes', async () => {
    const { web, tab } = await open('/decoy-sr-only')
    const result = await web.execute(untilVisible('Delete account', 10))
    const meta = result.metadata?.scrollUntilVisible as { swipes: number } | undefined
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    expect(meta!.swipes).toBeGreaterThanOrEqual(1)
    expect(await realButtonOnScreen(tab)).toBe(true)
  }, 60_000)

  it('a transparent copy never ends found at zero swipes', async () => {
    const { web, tab } = await open('/decoy-opacity')
    const result = await web.execute(untilVisible('Delete account', 10))
    const meta = result.metadata?.scrollUntilVisible as { swipes: number } | undefined
    expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
    expect(meta!.swipes).toBeGreaterThanOrEqual(1)
    expect(await realButtonOnScreen(tab)).toBe(true)
  }, 60_000)

  it('a copy under a fixed overlay never ends found', async () => {
    const { web } = await open('/decoy-overlay')
    const result = await web.execute(untilVisible('Delete account', 10))
    expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'unresolved' })
  }, 60_000)

  it('a fixed-position target inside an overflow-hidden wrapper ends found', async () => {
    const { web } = await open('/positioned-fixed')
    const result = await web.execute(untilVisible('Chat with us', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('an absolutely positioned target escaping a non-positioned clipping wrapper ends found', async () => {
    const { web } = await open('/positioned-absolute')
    const result = await web.execute(untilVisible('Escaped label', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('a pointer-events:none label on screen ends found', async () => {
    const { web } = await open('/pointer-none')
    const result = await web.execute(untilVisible('Save draft', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('an on-screen target inside an open shadow root ends found', async () => {
    const { web } = await open('/shadow-target')
    const result = await web.execute(untilVisible('Shadow pay', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it("a slotted target clipped by its shadow root's internal scroller is not found at zero swipes", async () => {
    const { web, tab } = await open('/slotted-clipped')
    const primitives = buildScrollPrimitives(tab, {}, 720)
    expect(await primitives.probeTargetVisible!('Slot item 25')).toBe('unknown')
    // Without the native rung nothing moves the internal scroller: never found at 0 swipes, never not-found.
    const { nativeSearchScroll: _native, ...swipesOnly } = primitives
    const { meta } = await runUntilVisibleLoop(swipesOnly, {
      target: 'Slot item 25', direction: 'down', maxSwipes: 3, retryOpposite: true,
    })
    expect(meta.outcome).not.toBe('not-found')
    expect(meta).not.toEqual(ZERO_SWIPES_FOUND)
    expect(await innerScrollTop(tab), 'the internal scroller did not move').toBe(0)
    // The web search's native rung scrolls the internal scroller itself; found then means on screen.
    const result = await web.execute({ ...untilVisible('Slot item 25', 3), retryOpposite: true })
    const searched = result.metadata?.scrollUntilVisible as { outcome: string } | undefined
    expect(searched!.outcome).not.toBe('not-found')
    if (searched!.outcome === 'found') {
      expect(await innerScrollTop(tab)).toBeGreaterThan(0)
      expect(await primitives.probeTargetVisible!('Slot item 25')).toBe('visible')
    }
  }, 60_000)

  it('an iframe copy under an opacity 0 ancestor never ends found at zero swipes', async () => {
    await frameDecoyNeverEndsTheSearch('/decoy-frame-opacity')
  }, 60_000)

  it('an iframe copy under a visibility hidden ancestor never ends found at zero swipes', async () => {
    await frameDecoyNeverEndsTheSearch('/decoy-frame-hidden')
  }, 60_000)

  it('a display contents holder is found at zero swipes', async () => {
    const { web } = await open('/contents')
    const result = await web.execute(untilVisible('Pay now', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('a display contents custom element host is found at zero swipes', async () => {
    const { web } = await open('/host')
    const result = await web.execute(untilVisible('Pay now', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('a title under a transparent stretched link overlay is found at zero swipes', async () => {
    const { web } = await open('/card')
    const result = await web.execute(untilVisible('Premium plan', 3))
    expect(result.metadata?.scrollUntilVisible).toEqual(ZERO_SWIPES_FOUND)
  }, 60_000)

  it('a display contents holder with no text of its own reads unknown, never hidden', async () => {
    const { tab } = await open('/contents-empty')
    expect(await buildScrollPrimitives(tab, {}, 720).probeTargetVisible!('Open menu')).toBe('unknown')
  }, 60_000)
})

// The native rung searches the main frame only, so it may bring the real button on screen at zero
// swipes; the swipe search from the top shows the iframe copy never ends it.
async function frameDecoyNeverEndsTheSearch(path: string): Promise<void> {
  const { web, tab } = await open(path)
  const result = await web.execute(untilVisible('Delete account', 10))
  expect(result.metadata?.scrollUntilVisible).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
  expect(await realButtonOnScreen(tab), 'the real button is on screen').toBe(true)
  await tab.evaluate('window.scrollTo(0, 0)')
  const { nativeSearchScroll: _native, ...swipesOnly } = buildScrollPrimitives(tab, {}, 720)
  const { meta } = await runUntilVisibleLoop(swipesOnly, {
    target: 'Delete account', direction: 'down', maxSwipes: 10, retryOpposite: false,
  })
  expect(meta).toMatchObject({ outcome: 'found', endedBy: 'target-visible' })
  expect(meta.swipes).toBeGreaterThanOrEqual(1)
  expect(await realButtonOnScreen(tab), 'the real button is on screen after the swipes').toBe(true)
}
