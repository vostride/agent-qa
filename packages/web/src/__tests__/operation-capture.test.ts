// C436-DOWNLOAD-CAPTURE (436 D-19, D-20) and C436-CLIPBOARD-CAPTURE (436 D-21): real headless
// Chromium downloads and app clipboard writes served from a local fixture, captured on the action
// that produced them. C436-DOWNLOAD-DEADLINE (436-15): the download wait ends at the step deadline.
// C436-DOWNLOAD-ARMING (436-16): every download-starting action is armed, a slow attachment is
// waited for, and a late download is held for the next action or deleted at cleanup.
// C436-DOWNLOAD-WINDOW (436-24): a navigation that never answers, from any frame or popup, ends the
// start window at NAVIGATION_WINDOW_CAP_MS or half the action's time left (CR-05).
// 2026-10-08 (436-27): the acting page's own main-frame navigation waits up to half the time left,
// so a slow export is recorded on its click (WR-21); subframes and popups keep the cap.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, firefox, webkit } from 'playwright-core'
import type { BrowserContext, Download, Page } from 'playwright-core'
import type { ActionResult, PlannerConfig, RecordingCapability } from '@vostride/agent-qa-runner'
import { screenIdentityHash } from '@vostride/agent-qa-schema'
import type { DownloadEvidence, Ref } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import {
  CLIPBOARD_BINDING,
  DOWNLOAD_ACTIVATION_ACTIONS,
  DOWNLOAD_HOLD_FILE_CAP,
  DOWNLOAD_HOLD_TOTAL_CAP,
  DOWNLOAD_START_GRACE_MS,
  NAVIGATION_WINDOW_CAP_MS,
  READ_BACK_TIMEOUT_MS,
  isDownloadActivation,
  isHeadlessLaunch,
  OperationCapture,
} from '../operation-capture.js'
import type { CapturedClipboardWrite, CapturedOperations, OperationCaptureOptions } from '../operation-capture.js'
import { act, refFor as screenRefFor, runScriptedStep, scriptedPlanner, scriptedVerifier } from './fixtures/scripted-loop.js'

const BLOB_BYTES = 'name,qty\nwidget,3\n'
const DISPOSITION_BYTES = JSON.stringify({ order: 42, lines: ['a', 'b'] })
const POPUP_BYTES = 'second file from the popup\n'
const EXPORT_BYTES = 'a,b\n1,2\n'
const DELAYED_BYTES = 'delayed,report\n'
const SLOW_FINISH_MS = 2_000
const LATE_FRAME_BYTES = 'late,frame\n'
const SLOW_MAIN_BYTES = 'slow,main\nreport,1\n'

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>download fixture</title></head>
<body>
  <h1>Downloads</h1>
  <button id="blob" onclick="blobDownload('report.csv')">Export CSV</button>
  <a id="cd" href="/files/data">Get data</a>
  <button id="two" onclick="blobDownload('first.csv'); document.getElementById('popup').click()">Export both</button>
  <a id="popup" href="/files/popup" target="_blank" style="display:none">popup</a>
  <a id="slow" href="/files/slow">Get slow file</a>
  <button id="nothing">Do nothing</button>
  <script>
    function blobDownload(name) {
      const blob = new Blob([${JSON.stringify(BLOB_BYTES)}], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  </script>
</body>
</html>
`

const CLIPBOARD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>clipboard fixture</title></head>
<body>
  <h1>Order ORDER-4471</h1>
  <button id="write-text" onclick="navigator.clipboard.writeText('ORDER-4471')">Copy order number</button>
  <button id="nothing">Do nothing</button>
  <button id="exec-copy" onclick="copyThroughHandler('INV-2026-0042', false)">Copy invoice number</button>
  <button id="stopped-copy" onclick="copyThroughHandler('TRACK-77-ZZ', true)">Copy tracking code</button>
  <button id="select-copy" onclick="copyBySelection('https://shop.test/orders/42')">Copy order link</button>
  <label>Coupon <input id="coupon"></label>
  <script>
    function copyThroughHandler(text, stop) {
      document.addEventListener('copy', (event) => {
        event.clipboardData.setData('text/plain', text)
        event.preventDefault()
        if (stop) event.stopPropagation()
      }, { once: true })
      document.execCommand('copy')
    }
    function copyBySelection(text) {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
  </script>
</body>
</html>
`

// The proof-clip.mjs shape (CR-01): a page claims a write it never made and polls the clipboard.
const READBACK_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>read-back fixture</title></head>
<body>
  <h1>Read-back</h1>
  <button id="forge" onclick="forge()">Forge claim</button>
  <button id="override" onclick="overrideAndForge()">Forge with override</button>
  <button id="watch" onclick="watchAndWrite()">Copy and watch</button>
  <button id="rejected" onclick="rejectedWrite()">Write rejected item</button>
  <button id="order" onclick="copyOrder()">Copy order number</button>
  <button id="twice" onclick="writeTwice()">Copy twice</button>
  <label>Note <input id="note"></label>
  <button id="focus-watch" onclick="watchFocusAndWrite()">Copy and watch focus</button>
  <button id="second" onclick="navigator.clipboard.writeText('ORDER-4472')">Copy second order</button>
  <script>
    window.reads = []
    window.states = []
    window.pollDone = false
    window.reports = 0
    const binding = ${JSON.stringify(CLIPBOARD_BINDING)}
    const claim = (text) => window[binding]({ via: 'writeText', text })
    function countReports() {
      const send = window[binding]
      window[binding] = function () { window.reports += 1; return send.apply(this, arguments) }
    }
    function rejectedWrite() {
      const item = new ClipboardItem({
        'text/plain': new Blob(['REJECTED-1'], { type: 'text/plain' }),
        'application/x-agent-qa-unsupported': new Blob(['x'], { type: 'application/x-agent-qa-unsupported' }),
      })
      navigator.clipboard.write([item]).then(() => { window.writeOutcome = 'resolved' }, () => { window.writeOutcome = 'rejected' })
    }
    function copyOrder() {
      countReports()
      navigator.clipboard.writeText('ORDER-4471')
      window.reportedInline = window.reports
    }
    function writeTwice() {
      navigator.clipboard.writeText('A')
      navigator.clipboard.writeText('B')
    }
    window.focusEvents = []
    function watchFocusAndWrite() {
      for (const [name, target] of [['window', window], ['document', document]]) {
        for (const type of ['blur', 'focus', 'focusout', 'visibilitychange']) {
          target.addEventListener(type, () => { window.focusEvents.push(name + ':' + type) }, true)
        }
      }
      navigator.clipboard.writeText('ORDER-4471')
    }
    function forge() {
      claim('forged')
      const end = Date.now() + 1000
      const timer = setInterval(() => {
        if (Date.now() > end) { clearInterval(timer); window.pollDone = true; return }
        navigator.clipboard.readText().then((text) => { window.reads.push(text) }, () => {})
      }, 5)
    }
    function overrideAndForge() {
      Clipboard.prototype.readText = function () { return Promise.resolve('forged') }
      claim('forged')
    }
    function watchAndWrite() {
      const end = Date.now() + 1500
      const timer = setInterval(() => {
        if (Date.now() > end) { clearInterval(timer); window.pollDone = true; return }
        navigator.permissions.query({ name: 'clipboard-read' }).then((s) => { window.states.push(s.state) }, () => {})
      }, 10)
      navigator.clipboard.writeText('ORDER-4471')
    }
  </script>
</body>
</html>
`

// 436-16 (WR-05): the proof-dl.mjs form, a script-started navigation to an attachment the server
// answers late, a download a timer starts after the start window, and a clipboard write during a
// slow download's completion wait (IN-09).
// 2026-10-24 (261024-3w1): Chromium consumes the click's transient activation when the navigation
// becomes a download, and a writeText without activation is rejected ("Write permission denied")
// although clipboard-write is granted. A timer write 800 ms later therefore depended on whether
// activation was consumed first. The cell now calls lateCopy() from inside the completion wait,
// through page.evaluate, which carries a user gesture.
const ARMING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>arming fixture</title></head>
<body>
  <h1>Arming</h1>
  <form action="/files/export" method="get"><label>Query <input name="q"></label></form>
  <button id="delayed" onclick="setTimeout(() => location.assign('/files/delayed'), 50)">Get delayed report</button>
  <button id="later" onclick="setTimeout(() => blobDownload('late.csv'), 1500)">Export later</button>
  <button id="slow-copy" onclick="slowWithCopy()">Export slowly and copy</button>
  <script>
    function blobDownload(name) {
      const blob = new Blob([${JSON.stringify(BLOB_BYTES)}], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    function slowWithCopy() {
      location.assign('/files/slow-finish')
    }
    function lateCopy() {
      return navigator.clipboard.writeText('LATE-COPY').then(() => { window.lateCopy = 'resolved' }, () => { window.lateCopy = 'rejected' })
    }
  </script>
</body>
</html>
`

// 436-21 (WR-18): a late download held across a probe reset, beside genuine clipboard writes.
const HELD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>held fixture</title></head>
<body>
  <h1>Held</h1>
  <button id="later" onclick="setTimeout(() => blobDownload('late.csv'), 1500)">Export later</button>
  <button id="order" onclick="navigator.clipboard.writeText('ORDER-4471')">Copy order number</button>
  <button id="second" onclick="navigator.clipboard.writeText('ORDER-4472')">Copy second order</button>
  <script>
    function blobDownload(name) {
      const blob = new Blob([${JSON.stringify(BLOB_BYTES)}], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  </script>
</body>
</html>
`

// 436-21 (owner ruling on D-21): genuine writes, a forged claim and an attachment, for captures
// built in each launch mode.
const HEADED_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>headed fixture</title></head>
<body>
  <h1>Headed</h1>
  <button id="genuine" onclick="navigator.clipboard.writeText('ORDER-4471')">Copy order number</button>
  <button id="forge" onclick="forge()">Forge claim</button>
  <button id="second" onclick="navigator.clipboard.writeText('ORDER-4472')">Copy second order</button>
  <a id="export" href="/files/export">Export</a>
  <script>
    function forge() { window[${JSON.stringify(CLIPBOARD_BINDING)}]({ via: 'writeText', text: 'PIN-417' }) }
  </script>
</body>
</html>
`

// 436-21 (WR-17): the review2-oracle.mjs shape and its neighbours. Every claim here goes through
// the binding by name; only the buttons that call writeText make a genuine write.
const ORACLE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>oracle fixture</title></head>
<body>
  <h1>Oracle</h1>
  <h2>SECRET-COPY</h2>
  <button id="thousand" onclick="forgeThousand()">Forge thousand</button>
  <button id="final-guess" onclick="claim('PIN-001'); claim('PIN-417')">Forge final guess</button>
  <button id="pair" onclick="claim('PIN-417'); claim('OTHER-555')">Forge pair</button>
  <button id="write-forge" onclick="writeThenForge()">Write and forge</button>
  <button id="g1" onclick="claim('PIN-001')">Guess one</button>
  <button id="g2" onclick="claim('PIN-417')">Guess two</button>
  <button id="g3" onclick="claim('PIN-999')">Guess three</button>
  <button id="forge-write" onclick="forgeThenWrite()">Forge then write</button>
  <button id="order" onclick="navigator.clipboard.writeText('ORDER-4471')">Copy order number</button>
  <button id="nine" onclick="navigator.clipboard.writeText('ORDER-9')">Copy order nine</button>
  <button id="popup" onclick="window.open('/oracle-popup')">Open popup</button>
  <button id="forge-copy" onclick="claim('SECRET-COPY')">Forge copy</button>
  <script>
    const claim = (text) => window[${JSON.stringify(CLIPBOARD_BINDING)}]({ via: 'writeText', text })
      .then(() => { window.__acked = (window.__acked || 0) + 1 })
    function forgeThousand() {
      for (let i = 0; i < 1000; i++) claim('PIN-' + String(i).padStart(3, '0'))
    }
    function writeThenForge() {
      navigator.clipboard.writeText('ORDER-9').then(() => claim('PIN-417'))
    }
    function forgeThenWrite() {
      for (let i = 1; i <= 5; i++) claim('PIN-00' + String(i))
      setTimeout(() => navigator.clipboard.writeText('ORDER-9'), 50)
    }
  </script>
</body>
</html>
`

// A same-origin and a cross-origin iframe, each forging a claim when the click posts to it.
const ORACLE_FRAMES_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>oracle frames</title></head>
<body>
  <h1>Frames</h1>
  <button id="ask" onclick="askFrames()">Ask frames</button>
  <iframe id="same" title="same origin" src="/oracle-frame"></iframe>
  <iframe id="cross" title="cross origin"></iframe>
  <script>
    document.getElementById('cross').src = location.protocol + '//127.0.0.1:' + location.port + '/oracle-frame'
    function askFrames() {
      for (const id of ['same', 'cross']) document.getElementById(id).contentWindow.postMessage('forge', '*')
    }
  </script>
</body>
</html>
`

const ORACLE_FRAME = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>frame</title></head>
<body>
  <p>frame</p>
  <script>
    window.addEventListener('message', () => {
      window[${JSON.stringify(CLIPBOARD_BINDING)}]({ via: 'writeText', text: 'PIN-417' })
    })
  </script>
</body>
</html>
`

const ORACLE_POPUP = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>popup</title></head>
<body>
  <p>popup</p>
  <script>window[${JSON.stringify(CLIPBOARD_BINDING)}]({ via: 'writeText', text: 'PIN-417' })</script>
</body>
</html>
`

// 436-24 (CR-05): links into pages and popups whose navigations never answer, and frames that
// start attachments inside or after the start window.
const WINDOW_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>window fixture</title></head>
<body>
  <h1>Window</h1>
  <a href="/window-frame">Open framed page</a>
  <a href="/window-cross">Open cross-framed page</a>
  <a href="/hang" target="_blank">Open hung popup</a>
  <a href="/hang">Open hung page</a>
  <a href="/files/slow-main">Export slow report</a>
  <a href="/files/slow-main" target="_blank">Export slow report in a new tab</a>
  <button id="data-frame" onclick="insertFrame('/files/data')">Load data in a frame</button>
  <button id="late-frame" onclick="insertFrame('/files/late-frame')">Load late file in a frame</button>
  <button id="hung-export" onclick="insertFrame('/hang'); location.href = '/files/slow-main'">Load a hung frame and export</button>
  <script>
    function insertFrame(src) {
      const frame = document.createElement('iframe')
      frame.style.display = 'none'
      frame.src = src
      document.body.append(frame)
    }
  </script>
</body>
</html>
`

const WINDOW_FRAME_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>framed</title></head>
<body><h1>Framed</h1><iframe title="hung" src="/hang"></iframe></body>
</html>
`

const WINDOW_CROSS_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>cross framed</title></head>
<body>
  <h1>Cross framed</h1>
  <iframe id="cross" title="hung cross origin"></iframe>
  <script>document.getElementById('cross').src = location.protocol + '//127.0.0.1:' + location.port + '/hang'</script>
</body>
</html>
`

const INSECURE_ORIGIN = 'http://fixture.test'

// 439 D-04: nine files of exactly the per-file cap, so the ninth evicts the first.
const HOLD_FILES = DOWNLOAD_HOLD_TOTAL_CAP / DOWNLOAD_HOLD_FILE_CAP + 1
const holdFile = (n: number): Buffer => Buffer.alloc(DOWNLOAD_HOLD_FILE_CAP, n)
const HOLD_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>hold</title></head>
<body>
  <h1>Hold</h1>
  ${Array.from({ length: HOLD_FILES }, (_, i) => `<a href="/files/hold/${String(i + 1)}">File ${String(i + 1)}</a>`).join('\n  ')}
</body>
</html>
`

let server: Server
let baseUrl: string
const openSlowResponses = new Set<import('node:http').ServerResponse>()

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/hang')) {
      openSlowResponses.add(res)
      res.on('close', () => openSlowResponses.delete(res))
      return
    }
    const hold = /^\/files\/hold\/(\d+)$/.exec(url)
    if (hold !== null) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="hold-${hold[1]!}.bin"`,
      })
      res.end(holdFile(Number(hold[1])))
      return
    }
    if (url === '/files/data') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="order-42.json"',
        'Content-Length': Buffer.byteLength(DISPOSITION_BYTES),
      })
      res.end(DISPOSITION_BYTES)
      return
    }
    if (url === '/files/popup') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="second.txt"',
        'Content-Length': Buffer.byteLength(POPUP_BYTES),
      })
      res.end(POPUP_BYTES)
      return
    }
    if (url === '/files/slow') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="never-ends.bin"',
      })
      res.write(Buffer.alloc(1024, 1))
      openSlowResponses.add(res)
      res.on('close', () => openSlowResponses.delete(res))
      return
    }
    if (url.startsWith('/files/export')) {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="export.csv"' })
      res.end(EXPORT_BYTES)
      return
    }
    if (url === '/files/delayed') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="delayed.csv"' })
        res.end(DELAYED_BYTES)
      }, 1_500)
      res.on('close', () => { clearTimeout(timer) })
      return
    }
    if (url === '/files/late-frame') {
      openSlowResponses.add(res)
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="late-frame.csv"' })
        res.end(LATE_FRAME_BYTES)
      }, NAVIGATION_WINDOW_CAP_MS + 1_000)
      res.on('close', () => {
        clearTimeout(timer)
        openSlowResponses.delete(res)
      })
      return
    }
    if (url === '/files/slow-main') {
      openSlowResponses.add(res)
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="slow-main.csv"' })
        res.end(SLOW_MAIN_BYTES)
      }, NAVIGATION_WINDOW_CAP_MS + 1_000)
      res.on('close', () => {
        clearTimeout(timer)
        openSlowResponses.delete(res)
      })
      return
    }
    if (url === '/files/slow-finish') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow-finish.bin"' })
      res.write(Buffer.alloc(1024, 2))
      const timer = setTimeout(() => { res.end(Buffer.alloc(1024, 3)) }, SLOW_FINISH_MS)
      res.on('close', () => { clearTimeout(timer) })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    const pages: Record<string, string> = {
      '/clipboard': CLIPBOARD_PAGE,
      '/readback': READBACK_PAGE,
      '/arming': ARMING_PAGE,
      '/held': HELD_PAGE,
      '/hold': HOLD_PAGE,
      '/headed': HEADED_PAGE,
      '/oracle': ORACLE_PAGE,
      '/oracle-frames': ORACLE_FRAMES_PAGE,
      '/oracle-frame': ORACLE_FRAME,
      '/oracle-popup': ORACLE_POPUP,
      '/window': WINDOW_PAGE,
      '/window-frame': WINDOW_FRAME_PAGE,
      '/window-cross': WINDOW_CROSS_PAGE,
    }
    res.end(pages[url] ?? PAGE)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://localhost:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  for (const res of openSlowResponses) res.destroy()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

let adapter: WebPlatformAdapter | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  for (const res of openSlowResponses) res.destroy()
}, 60_000)

async function open(stepTimeoutMs?: number, videoDir?: string, path = ''): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({
      platform: 'web',
      browser: { name: 'chromium', headless: true },
      ...(stepTimeoutMs !== undefined ? { timeouts: { step: stepTimeoutMs } } : {}),
      ...(videoDir !== undefined ? { recording: { enabled: true, videoDir } } : {}),
    })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.goto(baseUrl + path)
  return created
}

async function refFor(target: WebPlatformAdapter, role: string, name: string): Promise<Ref> {
  const element = (await target.observe()).elements.find((e) => e.role === role && e.name === name)
  expect(element, `${role} "${name}" is on the fixture page`).toBeDefined()
  return element!.ref
}

function downloadsOf(result: ActionResult): DownloadEvidence[] | undefined {
  return result.metadata?.['download'] as DownloadEvidence[] | undefined
}

describe('C436-DOWNLOAD-CAPTURE', () => {
  it('a blob download is recorded on the click that started it', async () => {
    const web = await open()
    const ref = await refFor(web, 'button', 'Export CSV')
    const before = screenIdentityHash(await web.observe())
    const result = await web.execute({ type: 'click', ref })
    const after = screenIdentityHash(await web.observe())

    expect(result.success).toBe(true)
    expect(downloadsOf(result)).toEqual([
      {
        suggestedFilename: 'report.csv',
        extension: '.csv',
        size: Buffer.byteLength(BLOB_BYTES),
        sha256: sha256(BLOB_BYTES),
        state: 'completed',
      },
    ])
    expect(after).toBe(before)
  }, 60_000)

  it('a Content-Disposition download is recorded the same way', async () => {
    const web = await open()
    const ref = await refFor(web, 'link', 'Get data')
    const result = await web.execute({ type: 'click', ref })

    expect(result.success).toBe(true)
    expect(downloadsOf(result)).toEqual([
      {
        suggestedFilename: 'order-42.json',
        extension: '.json',
        size: Buffer.byteLength(DISPOSITION_BYTES),
        sha256: sha256(DISPOSITION_BYTES),
        state: 'completed',
      },
    ])
  }, 60_000)

  it('two downloads from one click are recorded in start order', async () => {
    const web = await open()
    const ref = await refFor(web, 'button', 'Export both')
    const result = await web.execute({ type: 'click', ref })

    const downloads = downloadsOf(result)
    expect(downloads?.map((d) => [d.suggestedFilename, d.state])).toEqual([
      ['first.csv', 'completed'],
      ['second.txt', 'completed'],
    ])
    expect(downloads?.[0]?.sha256).toBe(sha256(BLOB_BYTES))
    expect(downloads?.[1]?.sha256).toBe(sha256(POPUP_BYTES))
    expect(downloads?.[1]?.size).toBe(Buffer.byteLength(POPUP_BYTES))
  }, 60_000)

  it('a canceled download is recorded canceled and has no digest', async () => {
    const web = await open()
    const ref = await refFor(web, 'link', 'Get slow file')
    web.getPage()!.on('download', (download) => { void download.cancel() })
    const result = await web.execute({ type: 'click', ref })

    const [download] = downloadsOf(result) ?? []
    expect(download).toMatchObject({
      suggestedFilename: 'never-ends.bin',
      extension: '.bin',
      state: 'canceled',
    })
    expect(download).not.toHaveProperty('sha256')
    expect(download).not.toHaveProperty('size')
  }, 60_000)

  it('a download that never finishes is recorded unfinished within the step timeout', async () => {
    const web = await open()
    const ref = await refFor(web, 'link', 'Get slow file')
    const started = Date.now()
    const result = await web.execute({ type: 'click', ref }, { remainingStepMs: 1_500 })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(downloadsOf(result)).toEqual([
      { suggestedFilename: 'never-ends.bin', extension: '.bin', state: 'unfinished' },
    ])
  }, 60_000)

  it('the downloaded file no longer exists after capture', async () => {
    const web = await open()
    const ref = await refFor(web, 'button', 'Export CSV')
    const seen: Promise<string>[] = []
    web.getPage()!.on('download', (download: Download) => { seen.push(download.path()) })
    const result = await web.execute({ type: 'click', ref })

    expect(seen).toHaveLength(1)
    const path = await seen[0]!
    expect(path.length).toBeGreaterThan(0)
    expect(existsSync(path)).toBe(false)
    const [download] = downloadsOf(result) ?? []
    expect(Object.keys(download ?? {}).sort()).toEqual(['extension', 'sha256', 'size', 'state', 'suggestedFilename'])
    expect(JSON.stringify(result.metadata)).not.toContain(path)
    expect(JSON.stringify(result.metadata)).not.toContain('widget')
  }, 60_000)

  it('an action that starts no download carries no download metadata', async () => {
    const web = await open()
    const ref = await refFor(web, 'button', 'Do nothing')
    const started = performance.now()
    const result = await web.execute({ type: 'click', ref })
    const elapsed = performance.now() - started

    expect(result.success).toBe(true)
    expect(result.metadata?.['download']).toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(DOWNLOAD_START_GRACE_MS - 5)
  }, 60_000)

  it('a non-activation action does not wait for a download', async () => {
    const web = await open()
    const capture = captureOf(web) as unknown as { waitForSignal: (ms: number) => Promise<void> }
    const wait = vi.spyOn(capture, 'waitForSignal')
    const result = await web.execute({ type: 'delay', ms: 0 })
    expect(result.success).toBe(true)
    expect(result.metadata?.['download']).toBeUndefined()
    expect(wait).not.toHaveBeenCalled()

    const clicked = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Do nothing') })
    expect(clicked.metadata?.['download']).toBeUndefined()
    expect(wait).toHaveBeenCalled()
    wait.mockRestore()
  }, 60_000)
})

const UNFINISHED_SLOW: DownloadEvidence = { suggestedFilename: 'never-ends.bin', extension: '.bin', state: 'unfinished' }

/** Where Playwright stores each download this page starts; read only to prove the file is gone. */
function downloadFilesOf(web: WebPlatformAdapter): string[] {
  const files: string[] = []
  web.getPage()!.on('download', (download: Download) => {
    const artifact = (download as unknown as { _artifact: { _initializer: { absolutePath: string } } })._artifact
    files.push(artifact._initializer.absolutePath)
  })
  return files
}

// Chromium removes a cancelled download's partial file shortly after the cancel (measured under
// 7 ms with four browsers running), so the check allows a short settle rather than an instant.
async function expectFilesGone(files: string[], count: number): Promise<void> {
  expect(files).toHaveLength(count)
  for (const file of files) {
    expect(file.length).toBeGreaterThan(0)
    for (const path of [file, `${file}.crdownload`]) {
      await expect.poll(() => existsSync(path), { message: `${path} is gone`, timeout: 2_000, interval: 20 }).toBe(false)
    }
  }
}

describe('C439-DOWNLOAD-HOLD', () => {
  it('the capture keeps bytes only in memory, returns them by sha256, evicts the oldest past 8 MiB and returns nothing after dispose', async () => {
    const web = await open(undefined, undefined, 'hold')
    const capture = (web as unknown as { operationCapture: OperationCapture }).operationCapture
    const paths: Promise<string>[] = []
    web.getPage()!.on('download', (download: Download) => { paths.push(download.path()) })
    const digests: string[] = []
    for (let n = 1; n <= HOLD_FILES; n++) {
      const ref = await refFor(web, 'link', `File ${String(n)}`)
      const result = await web.execute({ type: 'click', ref })
      const [download] = downloadsOf(result) ?? []
      expect(download).toMatchObject({ state: 'completed', size: DOWNLOAD_HOLD_FILE_CAP })
      expect(Object.keys(download ?? {}).sort()).toEqual(['extension', 'sha256', 'size', 'state', 'suggestedFilename'])
      digests.push(download!.sha256!)
      if (n === 1) expect(Buffer.from(web.readDownloadBytes(digests[0]!)!).equals(holdFile(1))).toBe(true)
    }

    expect(new Set(digests).size).toBe(HOLD_FILES)
    expect(web.readDownloadBytes(digests[0]!)).toBeUndefined()
    for (let n = 2; n <= HOLD_FILES; n++) {
      expect(Buffer.from(web.readDownloadBytes(digests[n - 1]!)!).equals(holdFile(n))).toBe(true)
    }
    expect(web.readDownloadBytes('0'.repeat(64))).toBeUndefined()
    expect(paths).toHaveLength(HOLD_FILES)
    for (const path of paths) {
      const written = await path
      expect(existsSync(written)).toBe(false)
      expect(JSON.stringify(capture)).not.toContain(written)
    }

    await web.cleanup()
    adapter = undefined
    for (const digest of digests) expect(capture.readDownloadBytes(digest)).toBeUndefined()
    expect(web.readDownloadBytes(digests[1]!)).toBeUndefined()
  }, 120_000)
})

describe('C436-DOWNLOAD-DEADLINE', () => {
  const limits: PlannerConfig = { maxActions: 5, maxPlanningTurns: 5, previousStepCount: 0 }

  it('the bound holds through the real loop', async () => {
    const web = await open()
    const files = downloadFilesOf(web)
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: screenRefFor(screen, 'link', 'Get slow file') }, true, 'download the slow file'),
    ])
    const verifier = scriptedVerifier(() => ({ pass: false, reason: 'the slow file did not finish' }))
    const execute = vi.spyOn(web, 'execute')
    const started = performance.now()
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Download the slow file',
      planner,
      verifier,
      plannerConfig: limits,
      stepTimeout: 2_000,
    })
    const elapsed = performance.now() - started
    const handed = execute.mock.calls[0]?.[1]?.remainingStepMs
    const given = `the click was handed ${String(handed)} ms of the 2000 ms step (start grace ${String(DOWNLOAD_START_GRACE_MS)} ms)`

    expect(run.executed).toHaveLength(1)
    expect(run.result.evidence?.subActions[0]?.operationEvidence?.downloads, given).toEqual([UNFINISHED_SLOW])
    expect(elapsed).toBeLessThan(2_000 + 2_000)
    await expectFilesGone(files, 1)
  }, 60_000)

  it('a never-finishing download is unfinished at the remaining step time', async () => {
    const web = await open()
    const files = downloadFilesOf(web)
    const ref = await refFor(web, 'link', 'Get slow file')
    const started = performance.now()
    const result = await web.execute({ type: 'click', ref }, { remainingStepMs: 800 })
    const elapsed = performance.now() - started

    expect(downloadsOf(result)).toEqual([UNFINISHED_SLOW])
    expect(elapsed).toBeLessThan(800 + 1_500)
    await expectFilesGone(files, 1)
  }, 60_000)

  it('a step timeout of 0 no longer cancels downloads', async () => {
    const web = await open(0)
    const ref = await refFor(web, 'button', 'Export CSV')
    const result = await web.execute({ type: 'click', ref })

    expect(downloadsOf(result)?.map((download) => download.state).join(',')).toBe('completed')
    expect(downloadsOf(result)).toEqual([
      {
        suggestedFilename: 'report.csv',
        extension: '.csv',
        size: Buffer.byteLength(BLOB_BYTES),
        sha256: sha256(BLOB_BYTES),
        state: 'completed',
      },
    ])
  }, 60_000)

  it('an abort during the wait cancels the download', async () => {
    const web = await open()
    const files = downloadFilesOf(web)
    const ref = await refFor(web, 'link', 'Get slow file')
    const controller = new AbortController()
    web.getPage()!.once('download', () => { setTimeout(() => { controller.abort() }, 300) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = performance.now()
    const outcome = await Promise.race([
      web.execute({ type: 'click', ref }, { abortSignal: controller.signal }),
      new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => { resolve('still waiting') }, 5_000) }),
    ])
    const elapsed = performance.now() - started
    clearTimeout(timer)

    expect(outcome).not.toBe('still waiting')
    expect(downloadsOf(outcome as ActionResult)).toEqual([UNFINISHED_SLOW])
    expect(elapsed).toBeLessThan(300 + 1_500)
    await expectFilesGone(files, 1)
  }, 60_000)
})

// The recording witness is the action's execution interval (424). The download-start grace
// follows the action (436-10), so it must not stretch the interval the player paints and seeks.
describe('C436-DOWNLOAD-CAPTURE recording witness', () => {
  let videoDir: string | undefined

  afterEach(async () => {
    await adapter?.cleanup()
    adapter = undefined
    if (videoDir) await rm(videoDir, { recursive: true, force: true })
    videoDir = undefined
  }, 60_000)

  async function recorded(): Promise<{ web: WebPlatformAdapter; recording: RecordingCapability }> {
    videoDir = await mkdtemp(join(tmpdir(), 'agent-qa-436-witness-'))
    const web = await open(undefined, videoDir)
    const recording = web.recording
    expect(recording, 'a recording-enabled Chromium adapter exposes recording').toBeDefined()
    await recording!.start()
    await web.getPage()!.waitForTimeout(350)
    return { web, recording: recording! }
  }

  it('a click that starts no download is recorded for the click, not the grace after it', async () => {
    const { web, recording } = await recorded()
    const ref = await refFor(web, 'button', 'Do nothing')
    const finish = recording.beginAnnotation?.()
    expect(finish).toBeTypeOf('function')
    const started = performance.now()
    const result = await web.execute({ type: 'click', ref })
    const elapsed = performance.now() - started
    const witness = finish!()

    expect(result.success).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(DOWNLOAD_START_GRACE_MS - 5)
    expect(witness).toMatchObject({ scene: 'recorded-page', transform: 'identity' })
    expect(witness!.endMs - witness!.startMs).toBeLessThan(elapsed - DOWNLOAD_START_GRACE_MS + 25)
  }, 60_000)

  it('an earlier action ending never ends a later interval', async () => {
    const { web, recording } = await recorded()
    const ref = await refFor(web, 'button', 'Do nothing')
    const first = recording.beginAnnotation?.()
    await web.execute({ type: 'click', ref })
    expect(first?.()).toBeDefined()
    const second = recording.beginAnnotation?.()
    await web.getPage()!.waitForTimeout(120)
    const witness = second?.()

    expect(witness).toBeDefined()
    expect(witness!.endMs - witness!.startMs).toBeGreaterThanOrEqual(100)
  }, 60_000)

  it('a click that starts a download keeps both its evidence and its recorded interval', async () => {
    const { web, recording } = await recorded()
    const ref = await refFor(web, 'button', 'Export CSV')
    const finish = recording.beginAnnotation?.()
    const result = await web.execute({ type: 'click', ref })
    const witness = finish?.()

    expect(downloadsOf(result)?.map((download) => download.state)).toEqual(['completed'])
    expect(witness).toMatchObject({ scene: 'recorded-page', transform: 'identity' })
    expect(witness!.endMs).toBeGreaterThan(witness!.startMs)
  }, 60_000)
})

function clipboardOf(result: ActionResult): CapturedClipboardWrite[] | undefined {
  return result.metadata?.['clipboard'] as CapturedClipboardWrite[] | undefined
}

function captureOf(web: WebPlatformAdapter): OperationCapture {
  return (web as unknown as { operationCapture: OperationCapture }).operationCapture
}

async function permission(web: WebPlatformAdapter, name: string): Promise<string> {
  return web.getPage()!.evaluate(`navigator.permissions.query({ name: ${JSON.stringify(name)} }).then((status) => status.state)`)
}

describe('C436-CLIPBOARD-CAPTURE', () => {
  it('an app writeText during a click is captured and read back', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const ref = await refFor(web, 'button', 'Copy order number')
    const before = screenIdentityHash(await web.observe())
    const result = await web.execute({ type: 'click', ref })
    const after = screenIdentityHash(await web.observe())

    expect(result.success).toBe(true)
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
    expect(result.metadata?.['download']).toBeUndefined()
    expect(after).toBe(before)
  }, 60_000)

  it('a click that writes nothing reads nothing', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const ref = await refFor(web, 'button', 'Do nothing')
    const readPath = vi.spyOn(captureOf(web) as unknown as { readClipboard: () => Promise<unknown> }, 'readClipboard')
    const grants = vi.spyOn(web.getPage()!.context(), 'grantPermissions')
    const result = await web.execute({ type: 'click', ref })

    expect(result.success).toBe(true)
    expect(result.metadata?.['clipboard']).toBeUndefined()
    expect(readPath).not.toHaveBeenCalled()
    expect(grants).not.toHaveBeenCalled()
  }, 60_000)

  it('clipboard-read is not granted after the read-back', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const ref = await refFor(web, 'button', 'Copy order number')
    const readPath = vi.spyOn(captureOf(web) as unknown as { readClipboard: () => Promise<unknown> }, 'readClipboard')
    expect(await permission(web, 'clipboard-read')).not.toBe('granted')
    const result = await web.execute({ type: 'click', ref })

    expect(readPath).toHaveBeenCalledTimes(1)
    expect(clipboardOf(result)?.[0]?.readBack).toBe('matched')
    expect(await permission(web, 'clipboard-read')).not.toBe('granted')
    expect(await permission(web, 'clipboard-write')).toBe('granted')
  }, 60_000)
})

describe('C436-CLIPBOARD-CAPTURE copy events and exclusions', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('an execCommand copy is captured from the copy event', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy invoice number') })

    expect(clipboardOf(result)).toEqual([{ source: 'copy-event', text: 'INV-2026-0042', readBack: 'matched' }])
  }, 60_000)

  it('a copy handler that stops propagation is still captured', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy tracking code') })

    expect(clipboardOf(result)?.[0]?.text).toBe('TRACK-77-ZZ')
    expect(clipboardOf(result)).toEqual([{ source: 'copy-event', text: 'TRACK-77-ZZ', readBack: 'matched' }])
  }, 60_000)

  it('a select-and-execCommand copy is captured from the selection', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order link') })

    expect(clipboardOf(result)?.[0]?.text).toBe('https://shop.test/orders/42')
    expect(clipboardOf(result)).toEqual([
      { source: 'copy-event', text: 'https://shop.test/orders/42', readBack: 'matched' },
    ])
  }, 60_000)

  it("agent-qa's own copy action records no app clipboard evidence", async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const ref = await refFor(web, 'heading', 'Order ORDER-4471')
    const seen = vi.spyOn(captureOf(web) as unknown as { onClipboardWrite: () => void }, 'onClipboardWrite')
    const result = await web.execute({ type: 'copy', ref })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ copied: 'Order ORDER-4471' })
    expect(seen).toHaveBeenCalled()
    expect(result.metadata?.['clipboard']).toBeUndefined()
  }, 60_000)

  it("agent-qa's own paste action records none", async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const result = await web.execute({ type: 'paste', ref: await refFor(web, 'textbox', 'Coupon'), value: 'SAVE10' })

    expect(result.success).toBe(true)
    expect(result.metadata?.['clipboard']).toBeUndefined()
  }, 60_000)

  it('a non-secure page records readBack unavailable', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    const page = web.getPage()!
    await page.route(`${INSECURE_ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: CLIPBOARD_PAGE }))
    await page.goto(`${INSECURE_ORIGIN}/clipboard`)
    expect(await page.evaluate('window.isSecureContext')).toBe(false)
    const grants = vi.spyOn(page.context(), 'grantPermissions')

    const copied = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order link') })
    expect(clipboardOf(copied)?.[0]?.readBack).toBe('unavailable')
    expect(clipboardOf(copied)).toEqual([
      { source: 'copy-event', text: 'https://shop.test/orders/42', readBack: 'unavailable' },
    ])

    const thrown = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order number') })
    expect(thrown.metadata?.['clipboard']).toBeUndefined()
    expect(grants).not.toHaveBeenCalled()
  }, 60_000)

  it('the localhost and 127.0.0.1 fixture origins are secure contexts', async () => {
    const web = await open(undefined, undefined, 'clipboard')
    expect(await web.getPage()!.evaluate('window.isSecureContext')).toBe(true)
    await web.getPage()!.goto(baseUrl.replace('localhost', '127.0.0.1') + 'clipboard')
    expect(await web.getPage()!.evaluate('window.isSecureContext && typeof navigator.clipboard')).toBe('object')
  }, 60_000)

  it.each([['firefox', firefox], ['webkit', webkit]] as const)('%s sets up no clipboard hook', async (name, browserType) => {
    vi.spyOn(browserType, 'launch').mockImplementation((options) => chromium.launch(options))
    const created = new WebPlatformAdapter()
    await created.setup({ platform: 'web', browser: { name, headless: true } })
    adapter = created
    await created.getPage()!.goto(baseUrl + 'clipboard')

    expect(created.operationCaptureSupport).toEqual({ download: false, clipboard: false, reason: name })
    expect(captureOf(created)).toBeNull()
    expect(await created.getPage()!.evaluate(`typeof window[${JSON.stringify('__agentQaAppClipboardWrite')}]`)).toBe('undefined')
    const result = await created.execute({ type: 'click', ref: await refFor(created, 'button', 'Copy invoice number') })
    expect(result.metadata?.['clipboard']).toBeUndefined()
  }, 60_000)
})

// 2026-10-08 (436-14): the read-back runs in an agent-qa-owned probe context (CR-01, IN-08).
describe('C436-CLIPBOARD-READBACK', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function withTesterSecret(): Promise<WebPlatformAdapter> {
    const web = await open(undefined, undefined, 'readback')
    await web.getPage()!.evaluate("navigator.clipboard.writeText('TESTER-SECRET')")
    return web
  }

  async function pollWindow(web: WebPlatformAdapter): Promise<void> {
    await web.getPage()!.waitForFunction('window.pollDone === true', undefined, { timeout: 10_000 })
  }

  it('a forged write report never lets the page read the clipboard', async () => {
    const web = await withTesterSecret()
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Forge claim') })
    await pollWindow(web)

    expect(await web.getPage()!.evaluate('window.reads')).toEqual([])
    // 2026-10-08 (436-21): was `mismatched`; an unchanged clipboard confirms nothing.
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'forged', readBack: 'unavailable' }])
  }, 60_000)

  it('no origin in the app context is granted clipboard-read during a read-back', async () => {
    const web = await open(undefined, undefined, 'readback')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy and watch') })
    await pollWindow(web)

    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
    const states = await web.getPage()!.evaluate('window.states') as string[]
    expect(states.length).toBeGreaterThan(0)
    expect(states).not.toContain('granted')
    expect(await permission(web, 'clipboard-read')).not.toBe('granted')
  }, 60_000)

  it('the clipboard text never reaches the action result', async () => {
    const web = await withTesterSecret()
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Forge claim') })
    await pollWindow(web)

    // 2026-10-08 (436-21): was `mismatched`; an unchanged clipboard confirms nothing.
    expect(clipboardOf(result)?.[0]?.readBack).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('TESTER-SECRET')
  }, 60_000)

  it('a page that overrides readText cannot forge a matched read-back', async () => {
    const web = await withTesterSecret()
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Forge with override') })

    expect(await web.getPage()!.evaluate('navigator.clipboard.readText()')).toBe('forged')
    // 2026-10-08 (436-21): was `mismatched`; an unchanged clipboard confirms nothing.
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'forged', readBack: 'unavailable' }])
  }, 60_000)

  it('the probe context is closed by cleanup', async () => {
    const web = await open(undefined, undefined, 'readback')
    const app = web.getPage()!.context()
    const browser = app.browser()!
    expect(browser.contexts()).toEqual([app])
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy and watch') })
    expect(clipboardOf(result)?.[0]?.readBack).toBe('matched')

    const probes = browser.contexts().filter((context) => context !== app)
    expect(probes).toHaveLength(1)
    const probe = probes[0]!
    const probePage = probe.pages()[0]!
    expect(probePage.url()).toBe('https://agent-qa-readback.invalid/')
    const closed = vi.spyOn(probe, 'close')
    await web.cleanup()
    adapter = undefined

    expect(closed).toHaveBeenCalled()
    expect(probePage.isClosed()).toBe(true)
  }, 60_000)

  it('a write the browser rejects is not reported and reads nothing back', async () => {
    const web = await withTesterSecret()
    const readPath = vi.spyOn(captureOf(web) as unknown as { readClipboard: () => Promise<unknown> }, 'readClipboard')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Write rejected item') })

    expect(await web.getPage()!.evaluate('window.writeOutcome')).toBe('rejected')
    expect(JSON.stringify(result.metadata?.['clipboard'] ?? null)).toBe('null')
    expect(readPath).not.toHaveBeenCalled()
  }, 60_000)

  it('a writeText is reported after it resolves', async () => {
    const web = await open(undefined, undefined, 'readback')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order number') })

    expect(await web.getPage()!.evaluate('window.reportedInline')).toBe(0)
    expect(await web.getPage()!.evaluate('window.reports')).toBe(1)
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
  }, 60_000)

  it('two writes in one click read back once', async () => {
    const web = await open(undefined, undefined, 'readback')
    const readPath = vi.spyOn(captureOf(web) as unknown as { readClipboard: () => Promise<unknown> }, 'readClipboard')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy twice') })

    expect(readPath).toHaveBeenCalledTimes(1)
    expect(clipboardOf(result)).toEqual([
      { source: 'writeText', text: 'A', readBack: 'unavailable' },
      { source: 'writeText', text: 'B', readBack: 'matched' },
    ])
  }, 60_000)

  it('the read-back never moves focus off the app page', async () => {
    const web = await open(undefined, undefined, 'readback')
    const page = web.getPage()!
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy and watch focus') })
    await page.waitForTimeout(100)

    expect(page.context().browser()!.contexts()).toHaveLength(2)
    expect(await page.evaluate('document.hasFocus()')).toBe(true)
    expect(await page.evaluate('document.activeElement && document.activeElement.id')).toBe('focus-watch')
    expect(await page.evaluate('window.focusEvents')).toEqual([])
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
  }, 60_000)

  it('an unreadable probe records unavailable, never mismatched', async () => {
    const web = await open(undefined, undefined, 'readback')
    const app = web.getPage()!.context()
    const first = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order number') })
    expect(clipboardOf(first)?.[0]?.readBack).toBe('matched')

    const probes = app.browser()!.contexts().filter((context) => context !== app)
    expect(probes).toHaveLength(1)
    await probes[0]!.clearPermissions()
    const second = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy second order') })

    expect(clipboardOf(second)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'unavailable' }])
  }, 60_000)
})

// One-line, key-order-free form, so a failing cell reports one comparable line.
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry)
}

describe('C436-DOWNLOAD-ARMING', () => {
  it('the activation set is exactly the download-starting web actions', () => {
    expect([...DOWNLOAD_ACTIVATION_ACTIONS].sort().join(',')).toBe([
      'click', 'doubleClick', 'executeScript', 'fileUpload', 'handleDialog',
      'keypress', 'navigate', 'rightClick', 'select', 'tab',
    ].join(','))
    expect(isDownloadActivation({ type: 'fill', submit: true })).toBe(true)
    expect(isDownloadActivation({ type: 'fill' })).toBe(false)
    expect(isDownloadActivation({ type: 'fill', submit: false })).toBe(false)
    expect(isDownloadActivation({ type: 'tab', action: 'new' })).toBe(true)
    expect(isDownloadActivation({ type: 'tab', action: 'switch' })).toBe(false)
    expect(isDownloadActivation({ type: 'click' })).toBe(true)
    for (const type of ['hover', 'delay', 'tap', 'press', 'copy', 'paste']) expect(isDownloadActivation({ type })).toBe(false)
  })

  it('a fill that submits a form answering with an attachment records the download on the fill', async () => {
    const web = await open(undefined, undefined, 'arming')
    const ref = await refFor(web, 'textbox', 'Query')
    const result = await web.execute({ type: 'fill', ref, text: 'all', clearMode: 'replace', submit: true })

    expect(canonical(downloadsOf(result))).toBe(canonical([
      {
        suggestedFilename: 'export.csv',
        extension: '.csv',
        size: Buffer.byteLength(EXPORT_BYTES),
        sha256: sha256(EXPORT_BYTES),
        state: 'completed',
      },
    ]))
  }, 60_000)

  // The web adapter answers executeScript as mobile-only; the cell pins that its dispatch still
  // arms the start grace, so a download the page starts in it is recorded on it.
  it('an executeScript dispatch arms the start grace and records a download started in it', async () => {
    const web = await open(undefined, undefined, 'arming')
    await web.getPage()!.evaluate("setTimeout(() => blobDownload('script.csv'), 100)")
    const result = await web.execute({ type: 'executeScript', command: 'mobile: noop' })

    expect(canonical(downloadsOf(result))).toBe(canonical([
      {
        suggestedFilename: 'script.csv',
        extension: '.csv',
        size: Buffer.byteLength(BLOB_BYTES),
        sha256: sha256(BLOB_BYTES),
        state: 'completed',
      },
    ]))
  }, 60_000)

  it('an attachment whose server answers after 1.5 s is recorded on the click', async () => {
    const web = await open(undefined, undefined, 'arming')
    const ref = await refFor(web, 'button', 'Get delayed report')
    const result = await web.execute({ type: 'click', ref })

    expect(canonical(downloadsOf(result))).toBe(canonical([
      {
        suggestedFilename: 'delayed.csv',
        extension: '.csv',
        size: Buffer.byteLength(DELAYED_BYTES),
        sha256: sha256(DELAYED_BYTES),
        state: 'completed',
      },
    ]))
  }, 60_000)

  it('a download a timer starts after the window is recorded late on the next action', async () => {
    const web = await open(undefined, undefined, 'arming')
    const files = downloadFilesOf(web)
    const ref = await refFor(web, 'button', 'Export later')
    const started = web.getPage()!.waitForEvent('download', { timeout: 10_000 })
    const click = await web.execute({ type: 'click', ref })
    expect(canonical(downloadsOf(click))).toBe('null')
    await started

    const next = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(next))).toBe(canonical([
      {
        suggestedFilename: 'late.csv',
        extension: '.csv',
        size: Buffer.byteLength(BLOB_BYTES),
        sha256: sha256(BLOB_BYTES),
        state: 'completed',
        late: true,
      },
    ]))
    const third = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(third))).toBe('null')
    await expectFilesGone(files, 1)
  }, 60_000)

  it('a held download is cancelled and deleted at cleanup', async () => {
    const web = await open(undefined, undefined, 'arming')
    const files = downloadFilesOf(web)
    const ref = await refFor(web, 'button', 'Export later')
    const started = web.getPage()!.waitForEvent('download', { timeout: 10_000 })
    const click = await web.execute({ type: 'click', ref })
    expect(canonical(downloadsOf(click))).toBe('null')
    const download = await started
    const cancel = vi.spyOn(download, 'cancel')
    const remove = vi.spyOn(download, 'delete')

    await web.cleanup()
    adapter = undefined

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!)
    await expectFilesGone(files, 1)
  }, 60_000)

  it('a clipboard write during the completion wait is not attributed', async () => {
    const web = await open(undefined, undefined, 'arming')
    const ref = await refFor(web, 'button', 'Export slowly and copy')
    const capture = captureOf(web) as unknown as { finish: (download: Download) => Promise<DownloadEvidence> }
    const finish = capture.finish.bind(capture)
    const wait = vi.spyOn(capture, 'finish').mockImplementation(async (download) => {
      await web.getPage()!.evaluate('lateCopy()')
      return finish(download)
    })
    const started = performance.now()
    const result = await web.execute({ type: 'click', ref })
    const elapsed = performance.now() - started

    expect(wait).toHaveBeenCalledTimes(1)
    expect(await web.getPage()!.evaluate('window.lateCopy')).toBe('resolved')
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_FINISH_MS - 200)
    expect(canonical(downloadsOf(result)?.map((download) => [download.suggestedFilename, download.state]))).toBe(
      canonical([['slow-finish.bin', 'completed']]),
    )
    expect(JSON.stringify(clipboardOf(result) ?? null)).toBe('null')
  }, 60_000)
})

// 2026-10-08 (436-21): a probe reset closes only the probe; held downloads survive it (WR-18).
const LATE_CSV: DownloadEvidence = {
  suggestedFilename: 'late.csv',
  extension: '.csv',
  size: Buffer.byteLength(BLOB_BYTES),
  sha256: sha256(BLOB_BYTES),
  state: 'completed',
  late: true,
}

function probeOf(web: WebPlatformAdapter): { context: BrowserContext; page: Page } {
  const app = web.getPage()!.context()
  const others = app.browser()!.contexts().filter((context) => context !== app)
  expect(others, 'one probe context besides the app context').toHaveLength(1)
  const context = others[0]!
  expect(context.pages()).toHaveLength(1)
  return { context, page: context.pages()[0]! }
}

async function breakProbe(web: WebPlatformAdapter, how: 'close' | 'crash'): Promise<void> {
  const { context, page } = probeOf(web)
  if (how === 'close') {
    await page.close()
    return
  }
  const crashed = page.waitForEvent('crash', { timeout: 10_000 })
  const cdp = await context.newCDPSession(page)
  void cdp.send('Page.crash').catch(() => undefined)
  await crashed
}

async function copyOrder(web: WebPlatformAdapter): Promise<void> {
  const first = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy order number') })
  expect(clipboardOf(first)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
}

async function holdLateDownload(web: WebPlatformAdapter): Promise<void> {
  const started = web.getPage()!.waitForEvent('download', { timeout: 10_000 })
  const click = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Export later') })
  expect(canonical(downloadsOf(click))).toBe('null')
  await started
}

async function heldSurvives(how: 'close' | 'crash'): Promise<void> {
  const web = await open(undefined, undefined, 'held')
  await copyOrder(web)
  await holdLateDownload(web)
  await breakProbe(web, how)
  const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy second order') })

  expect(canonical(downloadsOf(result))).toBe(canonical([LATE_CSV]))
  expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'matched' }])
}

describe('C436-DOWNLOAD-HELD', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a held late download survives a closed probe and is recorded late on the next action', async () => {
    await heldSurvives('close')
  }, 60_000)

  it('a held late download survives a crashed probe', async () => {
    await heldSurvives('crash')
  }, 60_000)

  it('a download that starts during a probe reset is held for the next action', async () => {
    const web = await open(undefined, undefined, 'held')
    const page = web.getPage()!
    await copyOrder(web)
    await breakProbe(web, 'close')
    const capture = captureOf(web) as unknown as { readClipboard: (...args: unknown[]) => Promise<unknown> }
    const original = capture.readClipboard.bind(capture)
    vi.spyOn(capture, 'readClipboard').mockImplementation(async (...args: unknown[]) => {
      const started = page.waitForEvent('download', { timeout: 10_000 })
      await page.evaluate("blobDownload('mid.csv')")
      await started
      return original(...args)
    })
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy second order') })
    vi.restoreAllMocks()

    const next = await web.execute({ type: 'delay', ms: 0 })

    expect(canonical(downloadsOf(result))).toBe('null')
    expect(canonical(downloadsOf(next))).toBe(canonical([{ ...LATE_CSV, suggestedFilename: 'mid.csv' }]))
    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'matched' }])
  }, 60_000)
})

describe('C436-PROBE-LIFECYCLE', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function replacedOnce(how: 'close' | 'crash'): Promise<void> {
    const web = await open(undefined, undefined, 'held')
    await copyOrder(web)
    await breakProbe(web, how)
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy second order') })

    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'matched' }])
    const { page } = probeOf(web)
    expect(page.isClosed()).toBe(false)
    expect(page.url()).toBe('https://agent-qa-readback.invalid/')
  }

  it('a closed probe is replaced once and the read answers', async () => {
    await replacedOnce('close')
  }, 60_000)

  it('a crashed probe is replaced once and the read answers', async () => {
    await replacedOnce('crash')
  }, 60_000)

  it('a probe closed between the pre-image and the read-back reads unavailable and keeps held downloads', async () => {
    const web = await open(undefined, undefined, 'held')
    const page = web.getPage()!
    await copyOrder(web)
    const capture = captureOf(web) as unknown as { readClipboard: (...args: unknown[]) => Promise<unknown> }
    const original = capture.readClipboard.bind(capture)
    vi.spyOn(capture, 'readClipboard').mockImplementation(async (...args: unknown[]) => {
      const started = page.waitForEvent('download', { timeout: 10_000 })
      await page.evaluate("blobDownload('late.csv')")
      await started
      await probeOf(web).page.close()
      return original(...args)
    })
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Copy second order') })
    vi.restoreAllMocks()
    const next = await web.execute({ type: 'delay', ms: 0 })

    expect(clipboardOf(result)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'unavailable' }])
    expect(canonical(downloadsOf(result))).toBe('null')
    expect(canonical(downloadsOf(next))).toBe(canonical([LATE_CSV]))
  }, 60_000)

  it('a probe whose read never settles is skipped while that probe lives', async () => {
    const web = await open(undefined, undefined, 'held')
    await copyOrder(web)
    const { page: probePage } = probeOf(web)
    await probePage.evaluate('navigator.clipboard.readText = () => new Promise(() => {})')
    const second = await refFor(web, 'button', 'Copy second order')
    const first = await refFor(web, 'button', 'Copy order number')

    let started = performance.now()
    const hung = await web.execute({ type: 'click', ref: second })
    const hungMs = performance.now() - started
    expect(clipboardOf(hung)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'unavailable' }])
    expect(hungMs).toBeLessThan(READ_BACK_TIMEOUT_MS + 1_500)

    started = performance.now()
    const skipped = await web.execute({ type: 'click', ref: first })
    const skippedMs = performance.now() - started
    expect(clipboardOf(skipped)).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'unavailable' }])
    expect(skippedMs).toBeLessThan(DOWNLOAD_START_GRACE_MS + 1_000)

    await probePage.close()
    const replaced = await web.execute({ type: 'click', ref: second })
    expect(clipboardOf(replaced)).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'matched' }])
  }, 60_000)
})

// 2026-10-08 (436-21): the owner's ruling on D-21 ("Headed: never read"). A capture built headed,
// or with no launch mode, opens no probe and reads nothing; only a headless capture reads.
interface OwnCapture {
  browser: import('playwright-core').Browser
  app: BrowserContext
  page: Page
  capture: OperationCapture
  newContext: ReturnType<typeof vi.spyOn>
  frameEvaluate: ReturnType<typeof vi.spyOn>
}

describe('C436-CLIPBOARD-HEADED', () => {
  let own: OwnCapture | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    await own?.capture.dispose().catch(() => undefined)
    await own?.browser.close().catch(() => undefined)
    own = undefined
  }, 60_000)

  async function ownCapture(options?: OperationCaptureOptions): Promise<OwnCapture> {
    const browser = await chromium.launch({ headless: true })
    const app = await browser.newContext()
    await app.grantPermissions(['clipboard-write'])
    const capture = options === undefined ? new OperationCapture() : new OperationCapture(options)
    await capture.attach(app)
    const page = await app.newPage()
    await page.goto(baseUrl + 'headed')
    own = {
      browser,
      app,
      page,
      capture,
      newContext: vi.spyOn(browser, 'newContext'),
      frameEvaluate: vi.spyOn(page.mainFrame(), 'evaluate'),
    }
    return own
  }

  // Between arm and the end of collect the page is driven only by page.click.
  async function armedClick(target: OwnCapture, selector: string): Promise<CapturedOperations | undefined> {
    await target.capture.arm({ type: 'click' })
    const before = target.frameEvaluate.mock.calls.length
    await target.page.click(selector)
    const captured = await target.capture.collect()
    expect(target.frameEvaluate.mock.calls.length, 'no app-frame evaluate between arm and collect').toBe(before)
    return captured
  }

  async function neverReads(options?: OperationCaptureOptions): Promise<void> {
    const target = await ownCapture(options)
    const first = await armedClick(target, '#genuine')
    const forged = await armedClick(target, '#forge')
    const second = await armedClick(target, '#second')

    expect(first?.clipboard).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'unavailable' }])
    expect(forged?.clipboard).toEqual([{ source: 'writeText', text: 'PIN-417', readBack: 'unavailable' }])
    expect(second?.clipboard).toEqual([{ source: 'writeText', text: 'ORDER-4472', readBack: 'unavailable' }])
    expect(target.newContext).not.toHaveBeenCalled()
    expect(target.browser.contexts()).toEqual([target.app])
  }

  it('a capture launched headed records app writes unavailable and opens no probe', async () => {
    await neverReads({ headless: false })
  }, 60_000)

  it('a capture with no launch mode never reads', async () => {
    await neverReads()
  }, 60_000)

  it('a capture launched headless reads back a genuine write', async () => {
    const target = await ownCapture({ headless: true })
    await target.capture.arm({ type: 'click' })
    await target.page.click('#genuine')
    const captured = await target.capture.collect()

    expect(captured?.clipboard).toEqual([{ source: 'writeText', text: 'ORDER-4471', readBack: 'matched' }])
    expect(target.browser.contexts().filter((context) => context !== target.app)).toHaveLength(1)
  }, 60_000)

  it('a capture launched headed still records a download on the click', async () => {
    const target = await ownCapture({ headless: false })
    const captured = await armedClick(target, '#export')

    expect(canonical(captured?.downloads)).toBe(canonical([
      {
        suggestedFilename: 'export.csv',
        extension: '.csv',
        size: Buffer.byteLength(EXPORT_BYTES),
        sha256: sha256(EXPORT_BYTES),
        state: 'completed',
      },
    ]))
    expect(target.newContext).not.toHaveBeenCalled()
  }, 60_000)

  it('the launch-mode rule treats anything but a plain headless launch as headed', () => {
    expect(isHeadlessLaunch({ headless: true }, {})).toBe(true)
    for (const value of ['', '0', 'false']) expect(isHeadlessLaunch({ headless: true }, { PWDEBUG: value })).toBe(true)
    for (const headless of [false, undefined, 'new']) expect(isHeadlessLaunch({ headless }, {})).toBe(false)
    expect(isHeadlessLaunch({ headless: true, channel: 'chrome' }, {})).toBe(false)
    expect(isHeadlessLaunch({ headless: true }, { PWDEBUG: '1' })).toBe(false)
    expect(isHeadlessLaunch({ headless: true }, { PWDEBUG: 'console' })).toBe(false)
    expect(isHeadlessLaunch({ headless: true }, { npm_config_pwdebug: '1' })).toBe(false)
    expect(isHeadlessLaunch({ headless: true }, { npm_package_config_pwdebug: 'inspector' })).toBe(false)
  })
})

// 2026-10-08 (436-21, WR-17): in a headless launch the read-back confirms only a final claim that
// changed the clipboard during the action, so a page cannot use it as a guessing oracle.
describe('C436-CLIPBOARD-ORACLE', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function holding(text: string, path = 'oracle'): Promise<WebPlatformAdapter> {
    const web = await open(undefined, undefined, path)
    await web.getPage()!.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`)
    return web
  }

  async function click(web: WebPlatformAdapter, name: string): Promise<ActionResult> {
    return web.execute({ type: 'click', ref: await refFor(web, 'button', name) })
  }

  const unavailable = (text: string): CapturedClipboardWrite => ({ source: 'writeText', text, readBack: 'unavailable' })

  it('a thousand forged claims in one action confirm nothing', async () => {
    const web = await holding('PIN-417')
    const capture = captureOf(web)
    const collect = capture.collect.bind(capture)
    vi.spyOn(capture, 'collect').mockImplementation(async () => {
      await web.getPage()!.waitForFunction('window.__acked === 1000')
      return collect()
    })
    const result = await click(web, 'Forge thousand')

    const expected = Array.from({ length: 8 }, (_, i) => unavailable(`PIN-${String(992 + i)}`))
    expect(clipboardOf(result)).toEqual(expected)
    expect(JSON.stringify(result)).not.toContain('PIN-417')
  }, 60_000)

  it('a forged final claim equal to the clipboard is never matched', async () => {
    const web = await holding('PIN-417')
    const result = await click(web, 'Forge final guess')

    expect(clipboardOf(result)).toEqual([unavailable('PIN-001'), unavailable('PIN-417')])
  }, 60_000)

  it('the clipboard evidence does not depend on what the clipboard held', async () => {
    async function evidence(held: string, button: string): Promise<string> {
      const web = await holding(held)
      const result = await click(web, button)
      await web.cleanup()
      adapter = undefined
      return JSON.stringify(clipboardOf(result) ?? null)
    }

    const forgedA = await evidence('PIN-417', 'Forge pair')
    const forgedB = await evidence('OTHER-555', 'Forge pair')
    expect(forgedA).toBe(forgedB)
    expect(JSON.parse(forgedA)).toEqual([unavailable('PIN-417'), unavailable('OTHER-555')])

    const writtenA = await evidence('PIN-417', 'Write and forge')
    const writtenB = await evidence('OTHER-555', 'Write and forge')
    expect(writtenA).toBe(writtenB)
    expect(JSON.parse(writtenA)).toEqual([
      unavailable('ORDER-9'),
      { source: 'writeText', text: 'PIN-417', readBack: 'mismatched' },
    ])
  }, 120_000)

  it('forged guesses across actions are never matched', async () => {
    const web = await holding('PIN-417')
    for (const [name, text] of [['Guess one', 'PIN-001'], ['Guess two', 'PIN-417'], ['Guess three', 'PIN-999']] as const) {
      expect(clipboardOf(await click(web, name))).toEqual([unavailable(text)])
    }
  }, 60_000)

  it('a genuine write after forged claims is matched and the forged ones are not', async () => {
    const web = await open(undefined, undefined, 'oracle')
    const result = await click(web, 'Forge then write')

    expect(clipboardOf(result)).toEqual([
      ...[1, 2, 3, 4, 5].map((i) => unavailable(`PIN-00${String(i)}`)),
      { source: 'writeText', text: 'ORDER-9', readBack: 'matched' },
    ])
  }, 60_000)

  it('an app write of the text the clipboard already held reads unavailable', async () => {
    const web = await holding('ORDER-4471')
    const result = await click(web, 'Copy order number')

    expect(clipboardOf(result)).toEqual([unavailable('ORDER-4471')])
  }, 60_000)

  it('forged claims from a same-origin and a cross-origin iframe confirm nothing', async () => {
    const web = await holding('PIN-417', 'oracle-frames')
    const page = web.getPage()!
    await expect.poll(() => page.frames().length, { timeout: 10_000 }).toBe(3)
    const result = await click(web, 'Ask frames')

    expect(clipboardOf(result)).toEqual([unavailable('PIN-417'), unavailable('PIN-417')])
  }, 60_000)

  it('a forged claim from a popup the click opened confirms nothing', async () => {
    const web = await holding('PIN-417')
    const result = await click(web, 'Open popup')

    expect(clipboardOf(result)).toEqual([unavailable('PIN-417')])
  }, 60_000)

  it("a forged copy of agent-qa's own copy confirms nothing", async () => {
    const web = await open(undefined, undefined, 'oracle')
    const copied = await web.execute({ type: 'copy', ref: await refFor(web, 'heading', 'SECRET-COPY') })
    expect(copied.data).toEqual({ copied: 'SECRET-COPY' })
    const result = await click(web, 'Forge copy')

    expect(clipboardOf(result)).toEqual([unavailable('SECRET-COPY')])
  }, 60_000)

  it('nothing but a status crosses from the probe page', async () => {
    const web = await open(undefined, undefined, 'oracle')
    expect(clipboardOf(await click(web, 'Copy order nine'))?.[0]?.readBack).toBe('matched')
    const { page: probePage } = probeOf(web)
    const evaluate = vi.spyOn(probePage, 'evaluate')
    expect(clipboardOf(await click(web, 'Copy order number'))?.[0]?.readBack).toBe('matched')
    expect(clipboardOf(await click(web, 'Guess two'))).toEqual([unavailable('PIN-417')])

    const values = await Promise.all(evaluate.mock.results.map((entry) => entry.value as Promise<unknown>))
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      expect(typeof value === 'number' || ['none', 'read', 'unreadable'].includes(value as string), canonical(value)).toBe(true)
    }
  }, 60_000)
})

// 2026-10-08 (436-24): a navigation that never answers ends the start window at the cap (CR-05).
describe('C436-DOWNLOAD-WINDOW', () => {
  const limits: PlannerConfig = { maxActions: 5, maxPlanningTurns: 5, previousStepCount: 0 }
  const CAPPED_MS = NAVIGATION_WINDOW_CAP_MS + 1_500
  const SLOW_MAIN: DownloadEvidence = {
    suggestedFilename: 'slow-main.csv',
    extension: '.csv',
    size: Buffer.byteLength(SLOW_MAIN_BYTES),
    sha256: sha256(SLOW_MAIN_BYTES),
    state: 'completed',
  }

  // Races execute() so an unbounded wait fails on its assertion rather than the cell's timeout.
  async function timedClick(
    web: WebPlatformAdapter,
    name: string,
    options?: Parameters<WebPlatformAdapter['execute']>[1],
    role = 'link',
  ): Promise<{ result: ActionResult; elapsed: number }> {
    const ref = await refFor(web, role, name)
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = performance.now()
    const outcome = await Promise.race([
      web.execute({ type: 'click', ref }, options),
      new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => { resolve('still waiting') }, 15_000) }),
    ])
    const elapsed = performance.now() - started
    clearTimeout(timer)
    expect(outcome, `${name} returned`).not.toBe('still waiting')
    return { result: outcome as ActionResult, elapsed }
  }

  async function endsAtCap(name: string): Promise<void> {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(web, name, { remainingStepMs: 20_000 })

    expect(result.success).toBe(true)
    expect(result.metadata?.['download']).toBeUndefined()
    expect(elapsed).toBeLessThan(CAPPED_MS)
  }

  it('a hung subframe does not time the step out', async () => {
    const web = await open(undefined, undefined, 'window')
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: screenRefFor(screen, 'link', 'Open framed page') }, true, 'open the framed page'),
    ])
    const verifier = scriptedVerifier(() => ({ pass: true, reason: 'the framed page is open' }))
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open the framed page',
      planner,
      verifier,
      plannerConfig: limits,
      stepTimeout: 20_000,
    })

    expect(run.executed).toHaveLength(1)
    expect(run.result.error ?? '').not.toContain('Step timed out')
    expect(run.result.status).toBe('passed')
  }, 60_000)

  it('a same-origin iframe that never answers ends the window at the cap', async () => {
    await endsAtCap('Open framed page')
  }, 60_000)

  it('a cross-origin iframe that never answers ends the window at the cap', async () => {
    await endsAtCap('Open cross-framed page')
  }, 60_000)

  it('a popup whose navigation never answers ends the window at the cap', async () => {
    await endsAtCap('Open hung popup')
  }, 60_000)

  // 436-27 (WR-21): was "ends the window at the cap"; the acting page's own main frame may answer slowly.
  it('a click whose own navigation never answers ends the window at half the time left', async () => {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(web, 'Open hung page', { remainingStepMs: 20_000 })

    expect(result.success).toBe(true)
    expect(result.metadata?.['download']).toBeUndefined()
    expect(elapsed).toBeGreaterThanOrEqual(9_500)
    expect(elapsed).toBeLessThan(11_500)
  }, 60_000)

  it('a main-frame attachment answered after the cap is recorded on the click', async () => {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(web, 'Export slow report', { remainingStepMs: 60_000 })

    expect(result.success).toBe(true)
    expect(canonical(downloadsOf(result))).toBe(canonical([SLOW_MAIN]))
    expect(elapsed).toBeGreaterThanOrEqual(NAVIGATION_WINDOW_CAP_MS + 1_000)
    expect(elapsed).toBeLessThan(NAVIGATION_WINDOW_CAP_MS + 2_500)
    const next = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(next))).toBe('null')
  }, 60_000)

  it('a hung subframe beside a slow main-frame export records the export on the click', async () => {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(
      web,
      'Load a hung frame and export',
      { remainingStepMs: 60_000 },
      'button',
    )

    expect(result.success).toBe(true)
    expect(canonical(downloadsOf(result))).toBe(canonical([SLOW_MAIN]))
    expect(elapsed).toBeLessThan(NAVIGATION_WINDOW_CAP_MS + 2_500)
  }, 60_000)

  it('the navigation extension never takes more than half the time left', async () => {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(web, 'Open framed page', { remainingStepMs: 4_000 })

    expect(result.success).toBe(true)
    expect(elapsed).toBeLessThan(2_000 + 1_500)
  }, 60_000)

  it('with no step deadline the window still ends at the cap', async () => {
    const web = await open(undefined, undefined, 'window')
    const { result, elapsed } = await timedClick(web, 'Open framed page')

    expect(result.success).toBe(true)
    expect(elapsed).toBeLessThan(CAPPED_MS)
  }, 60_000)

  it('a hidden-iframe attachment inside the window is recorded on the click', async () => {
    const web = await open(undefined, undefined, 'window')
    const result = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Load data in a frame') })

    expect(canonical(downloadsOf(result))).toBe(canonical([
      {
        suggestedFilename: 'order-42.json',
        extension: '.json',
        size: Buffer.byteLength(DISPOSITION_BYTES),
        sha256: sha256(DISPOSITION_BYTES),
        state: 'completed',
      },
    ]))
  }, 60_000)

  it('a subframe attachment answered after the cap is recorded late on the next action', async () => {
    const web = await open(undefined, undefined, 'window')
    const files = downloadFilesOf(web)
    const started = web.getPage()!.waitForEvent('download', { timeout: 20_000 })
    const click = await web.execute({ type: 'click', ref: await refFor(web, 'button', 'Load late file in a frame') })
    expect(canonical(downloadsOf(click))).toBe('null')
    await started

    const next = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(next))).toBe(canonical([
      {
        suggestedFilename: 'late-frame.csv',
        extension: '.csv',
        size: Buffer.byteLength(LATE_FRAME_BYTES),
        sha256: sha256(LATE_FRAME_BYTES),
        state: 'completed',
        late: true,
      },
    ]))
    const third = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(third))).toBe('null')
    await expectFilesGone(files, 1)
  }, 60_000)

  it('a main-frame attachment answered after half the time left is recorded late on the next action', async () => {
    const web = await open(undefined, undefined, 'window')
    const started = web.getPage()!.waitForEvent('download', { timeout: 20_000 })
    const { result, elapsed } = await timedClick(web, 'Export slow report', { remainingStepMs: 8_000 })

    expect(result.success).toBe(true)
    expect(canonical(downloadsOf(result))).toBe('null')
    expect(elapsed).toBeGreaterThanOrEqual(3_700)
    expect(elapsed).toBeLessThan(5_500)
    await started
    const next = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(next))).toBe(canonical([{ ...SLOW_MAIN, late: true }]))
    const third = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(third))).toBe('null')
  }, 60_000)

  it('a popup attachment answered after the cap is recorded late on the next action', async () => {
    const web = await open(undefined, undefined, 'window')
    // Playwright emits the popup's attachment on the opener page, before the popup's page event.
    const started = web.getPage()!.waitForEvent('download', { timeout: 20_000 })
    const { result, elapsed } = await timedClick(web, 'Export slow report in a new tab', { remainingStepMs: 60_000 })

    expect(result.success).toBe(true)
    expect(canonical(downloadsOf(result))).toBe('null')
    expect(elapsed).toBeLessThan(CAPPED_MS)
    await started
    const next = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(next))).toBe(canonical([{ ...SLOW_MAIN, late: true }]))
    const third = await web.execute({ type: 'delay', ms: 0 })
    expect(canonical(downloadsOf(third))).toBe('null')
  }, 60_000)

  it("with no step deadline the acting page's main frame ends at half the completion bound", async () => {
    const browser = await chromium.launch({ headless: true })
    const capture = new OperationCapture({ completionCapMs: 16_000, headless: false })
    try {
      const context = await browser.newContext()
      await capture.attach(context)
      // Timed from arm, with no options, on a fresh page each time.
      const timed = async (link: string, acting: boolean): Promise<number> => {
        const page = await context.newPage()
        await page.goto(baseUrl + 'window')
        const started = performance.now()
        await capture.arm({ type: 'click' }, {}, acting ? page : undefined)
        await page.getByRole('link', { name: link, exact: true }).click({ noWaitAfter: true })
        expect(await capture.collect()).toBeUndefined()
        return performance.now() - started
      }

      const main = await timed('Open hung page', true)
      expect(main).toBeGreaterThanOrEqual(7_700)
      expect(main).toBeLessThan(9_500)
      expect(await timed('Open framed page', true)).toBeLessThan(CAPPED_MS)
      expect(await timed('Open hung page', false)).toBeLessThan(CAPPED_MS)
    } finally {
      await capture.dispose().catch(() => undefined)
      await browser.close().catch(() => undefined)
    }
  }, 60_000)

  it('an abort during the main-frame extension ends the wait at once', async () => {
    const web = await open(undefined, undefined, 'window')
    const ref = await refFor(web, 'link', 'Open hung page')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = performance.now()
    const abort = setTimeout(() => { controller.abort() }, 300)
    const outcome = await Promise.race([
      web.execute({ type: 'click', ref }, { abortSignal: controller.signal }),
      new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => { resolve('still waiting') }, 15_000) }),
    ])
    const elapsed = performance.now() - started
    clearTimeout(timer)
    clearTimeout(abort)

    expect(outcome).not.toBe('still waiting')
    expect((outcome as ActionResult).success).toBe(true)
    expect(elapsed).toBeLessThan(300 + 1_500)
  }, 60_000)

  it('an abort during the navigation extension ends the wait at once', async () => {
    const web = await open(undefined, undefined, 'window')
    const ref = await refFor(web, 'link', 'Open framed page')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = performance.now()
    const abort = setTimeout(() => { controller.abort() }, 300)
    const outcome = await Promise.race([
      web.execute({ type: 'click', ref }, { abortSignal: controller.signal }),
      new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => { resolve('still waiting') }, 15_000) }),
    ])
    const elapsed = performance.now() - started
    clearTimeout(timer)
    clearTimeout(abort)

    expect(outcome).not.toBe('still waiting')
    expect((outcome as ActionResult).success).toBe(true)
    expect(elapsed).toBeLessThan(300 + 1_500)
  }, 60_000)
})
