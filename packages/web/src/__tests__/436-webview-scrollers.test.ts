// C436-WEBVIEW-SCRIPT (436-23 · D-25, review WR-20 and IN-32): the Android WebView scroller script
// run in real headless Chromium, the engine an Android WebView uses. A 400×800 touch viewport, a
// CDP touch scroll gesture, fixtures from a loopback node:http server (page base on localhost,
// cross-origin frames on 127.0.0.1). The live Android WebView path is not exercised here (D-30).

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import {
  WEBVIEW_SCROLLERS_SCRIPT,
  parseWebViewScrollers,
  webViewSwipeSignal,
} from '@vostride/agent-qa-core'
import type { IdentifiedScrollOffsets } from '@vostride/agent-qa-core'

const html = (head: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0}${head}</style></head><body>${body}</body></html>`

const INNER = html('', '<div style="height:3000px">Inner frame content</div>')
const IFRAME_UNDER = html('iframe{display:block;border:0}', '<div style="height:1200px">Top</div><iframe id="f" src="/inner" style="width:380px;height:600px"></iframe>')
const CROSS_ORIGIN = (port: number): string =>
  html('iframe{display:block;border:0}', `<iframe src="http://127.0.0.1:${String(port)}/inner" style="width:380px;height:300px"></iframe><div style="height:3000px">Tail</div>`)
const HIDDEN_FRAMES = html('', '<iframe src="/inner" style="width:0;height:0;border:0"></iframe>'
  + '<iframe src="/inner" style="position:absolute;top:-5000px;width:380px;height:300px"></iframe><div style="height:3000px">Tail</div>')
const SHADOW = html('', '<div style="height:1500px">Top</div><div id="host"></div><script>'
  + 'document.getElementById("host").attachShadow({ mode: "open" }).innerHTML ='
  + ' \'<div id="inner" style="height:400px;overflow:auto"><div style="height:3000px">Shadow list</div></div>\''
  + '</script>')
const OFF_CANVAS = html('nav{position:fixed;top:0;left:0;width:300px;height:100%;overflow-y:auto;transform:translateX(-100%)}',
  '<nav><div style="height:3000px">Drawer</div></nav><div style="height:3000px">Tail</div>')
const TAIL = '<div style="height:3000px">Tail</div>'
const PROP_BODY = `<!DOCTYPE html><html><head><style>html,body{height:100%} body{margin:0;overflow-x:hidden}</style></head><body>${TAIL}</body></html>`
const QUIRKS = `<html><head></head><body>${TAIL}</body></html>`
const BODY_SCROLLER = `<!DOCTYPE html><html><head><style>html{overflow:hidden;height:100%} body{height:100%;overflow:auto;margin:0}</style></head><body>${TAIL}</body></html>`
const PLAIN = html('', TAIL)
const MIXED = html('.s{height:150px;overflow:auto}', '<div class="s a"><div style="height:900px">A</div></div>'
  + '<div class="s" id="b"><div style="height:900px">B</div></div><div id="host"></div>' + TAIL + '<script>'
  + 'document.getElementById("host").attachShadow({ mode: "open" }).innerHTML ='
  + ' \'<div style="height:150px;overflow:auto"><div style="height:900px">S</div></div>\''
  + '</script>')

const PAGES: Record<string, string | ((port: number) => string)> = {
  '/inner': INNER,
  '/iframe-under': IFRAME_UNDER,
  '/cross-origin': CROSS_ORIGIN,
  '/hidden-frames': HIDDEN_FRAMES,
  '/shadow': SHADOW,
  '/off-canvas': OFF_CANVAS,
  '/prop-body': PROP_BODY,
  '/quirks': QUIRKS,
  '/body-scroller': BODY_SCROLLER,
  '/plain': PLAIN,
  '/mixed': MIXED,
}

let server: Server
let baseUrl = ''
let port = 0
let browser: Browser
let context: BrowserContext | undefined

beforeAll(async () => {
  server = createServer((req, res) => {
    const entry = PAGES[(req.url ?? '/').split('?')[0]]
    const body = typeof entry === 'function' ? entry(port) : entry
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body ?? 'not found')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  baseUrl = `http://localhost:${String(port)}`
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}, 120_000)

afterEach(async () => {
  await context?.close()
  context = undefined
})

async function open(path: string): Promise<Page> {
  context = await browser.newContext({ viewport: { width: 400, height: 800 }, hasTouch: true })
  const tab = await context.newPage()
  await tab.goto(baseUrl + path, { waitUntil: 'load' })
  return tab
}

const raw = (tab: Page): Promise<unknown> => tab.evaluate(`(function(){${WEBVIEW_SCROLLERS_SCRIPT}})()`)
const read = async (tab: Page): Promise<IdentifiedScrollOffsets[] | undefined> => parseWebViewScrollers(await raw(tab))
const frames = (tab: Page): Promise<unknown> =>
  tab.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
const toEnd = async (tab: Page): Promise<void> => {
  await tab.evaluate('window.scrollTo(0, 1e6)')
  await frames(tab)
}

// A raw touch swipe from (x, y), held before release so it never flings; `down` moves the content
// up, as a finger swiping up does. Linux headless Chromium ignores a synthesized touch gesture.
async function swipe(tab: Page, x: number, y: number, direction: 'down' | 'up'): Promise<void> {
  const cdp = await tab.context().newCDPSession(tab)
  const step = direction === 'down' ? -20 : 20
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    touchPoints: { x: number, y: number }[],
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
  await touch('touchStart', [{ x, y }])
  for (let k = 1; k <= 15; k++) {
    await touch('touchMove', [{ x, y: y + k * step }])
    await new Promise((settle) => setTimeout(settle, 16))
  }
  await new Promise((settle) => setTimeout(settle, 200))
  await touch('touchEnd', [])
  await cdp.detach()
  await frames(tab)
}

async function judged(tab: Page, x: number, y: number, between?: () => Promise<unknown>) {
  const before = await read(tab)
  await swipe(tab, x, y, 'down')
  await between?.()
  const after = await read(tab)
  return { before, after, signal: webViewSwipeSignal('down', before, after) }
}

const ids = (members: IdentifiedScrollOffsets[] | undefined): string[] | undefined => members?.map((m) => m.id)

describe('C436-WEBVIEW-SCRIPT the WebView scroller script in real Chromium (436-23 · D-25)', () => {
  it('an iframe under the gesture reads unknown, never at-boundary', async () => {
    const tab = await open('/iframe-under')
    await toEnd(tab)
    const inner = tab.frames().find((f) => f.url().endsWith('/inner'))!
    const innerBefore = await inner.evaluate('window.scrollY') as number
    const before = await raw(tab)
    await swipe(tab, 200, 500, 'down')
    const after = await raw(tab)
    expect(before).toBeNull()
    expect(after).toBeNull()
    expect(webViewSwipeSignal('down', parseWebViewScrollers(before), parseWebViewScrollers(after))).toBe('unknown')
    expect(await inner.evaluate('window.scrollY') as number).toBeGreaterThan(innerBefore)
    expect(await tab.evaluate('window.scrollY + innerHeight >= document.documentElement.scrollHeight - 1')).toBe(true)
  })

  it('a cross-origin iframe in view reads unknown', async () => {
    const tab = await open('/cross-origin')
    expect(tab.frames().some((f) => f.url().startsWith('http://127.0.0.1:'))).toBe(true)
    expect(await raw(tab)).toBeNull()
    const { signal } = await judged(tab, 200, 600)
    expect(signal).toBe('unknown')
  })

  it('a zero-size or off-screen iframe is ignored', async () => {
    const tab = await open('/hidden-frames')
    await toEnd(tab)
    const { before, after, signal } = await judged(tab, 200, 400)
    expect(ids(before)).toEqual(['document'])
    expect(ids(after)).toEqual(['document'])
    expect(signal).toBe('at-boundary')
  })

  it('an open-shadow internal scroller moving under the gesture reads moved', async () => {
    const tab = await open('/shadow')
    await toEnd(tab)
    const { before, after, signal } = await judged(tab, 200, 600)
    const shadow = before?.find((m) => m.id.includes('/s'))
    expect(shadow).toBeDefined()
    expect(shadow!.maxY).toBeGreaterThan(0)
    const moved = after?.find((m) => m.id === shadow!.id)
    expect(moved!.y).toBeGreaterThan(shadow!.y)
    expect(after?.find((m) => m.id === 'document')!.y).toBe(before?.find((m) => m.id === 'document')!.y)
    expect(signal).toBe('moved')
  })

  it('an off-canvas scroller is not a member', async () => {
    const tab = await open('/off-canvas')
    // The drawer has range and sits at offset 0, so it would keep a down boundary out of reach.
    expect(await tab.evaluate('(function(){var n=document.querySelector("nav");return n.scrollHeight-n.clientHeight})()')).toBeGreaterThan(0)
    await toEnd(tab)
    const { before, signal } = await judged(tab, 200, 400)
    expect(ids(before)).toEqual(['document'])
    expect(signal).toBe('at-boundary')
  })

  it('a propagating body is not a member and a quirks page reads its document scroller', async () => {
    const prop = await open('/prop-body')
    const propRead = await judged(prop, 200, 400)
    expect(ids(propRead.before)).toEqual(['document'])
    expect(propRead.signal).toBe('moved')
    await context?.close()

    const quirks = await open('/quirks')
    expect(await quirks.evaluate('document.compatMode')).toBe('BackCompat')
    const { before, after, signal } = await judged(quirks, 200, 400)
    expect(ids(before)).toEqual(['document'])
    expect(before![0].maxY).toBeGreaterThan(0)
    expect(after![0].y).toBeGreaterThan(before![0].y)
    expect(signal).toBe('moved')
  })

  it('a body that scrolls itself is a member', async () => {
    const tab = await open('/body-scroller')
    const { before, after, signal } = await judged(tab, 200, 400)
    const body = before?.find((m) => m.id.includes('|body#'))
    expect(body).toBeDefined()
    expect(body!.maxY).toBeGreaterThan(0)
    expect(after?.find((m) => m.id === body!.id)!.y).toBeGreaterThan(body!.y)
    expect(signal).toBe('moved')
  })

  it('a scroller inserted between reads is unknown unless a common member moved', async () => {
    const tab = await open('/plain')
    await toEnd(tab)
    const { before, after, signal } = await judged(tab, 200, 400, () => tab.evaluate(
      '(function(){var d=document.createElement("div");d.style.cssText="position:fixed;top:0;left:0;width:300px;height:200px;overflow:auto";'
      + 'd.innerHTML="<div style=\\"height:900px\\">New</div>";document.body.appendChild(d);return true})()'))
    expect(ids(before)).toEqual(['document'])
    expect(after).toHaveLength(2)
    expect(signal).toBe('unknown')
  })

  it('member ids are stable across reads with no DOM change', async () => {
    const tab = await open('/mixed')
    const first = ids(await read(tab))
    const second = ids(await read(tab))
    expect(first).toEqual(second)
    expect(first).toHaveLength(4)
    expect(first![0]).toBe('document')
    expect(new Set(first).size).toBe(first!.length)
  })

  it('the script writes nothing to the page', async () => {
    const tab = await open('/mixed')
    const state = (): Promise<unknown> => tab.evaluate(
      '({ names: Object.getOwnPropertyNames(window), symbols: Object.getOwnPropertySymbols(window).map(String),'
      + ' markup: document.documentElement.outerHTML })')
    const before = await state()
    await raw(tab)
    await raw(tab)
    expect(await state()).toEqual(before)
  })
})
