// In Chromium a refused iframe still fires `load`, so the wrapper also probes the frame's origin.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  APP_WRAPPER_CONNECTING_HINT,
  APP_WRAPPER_CONNECTING_MESSAGE,
  APP_WRAPPER_EXPIRED_HINT,
  APP_WRAPPER_EXPIRED_MESSAGE,
  APP_WRAPPER_LOAD_TIMEOUT_MS,
  APP_WRAPPER_PERMANENT_LINK_LABEL,
  APP_WRAPPER_UNREACHABLE_MESSAGE,
  renderAppWrapperPage,
} from '@vostride/agent-qa-mcp'
import type { AppWrapperMint } from '@vostride/agent-qa-mcp'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive a REAL Chromium — the only place the wrapper\'s states can be observed as a '
  + 'person meets them: run `pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE '
  + 'SKIPPED WHEN THE BROWSER IS ABSENT: every other cell in this phase asserts bytes, and these '
  + 'are the only ones that assert behaviour.'

const RUN_ID = 'run-dom'

let browser: Browser | undefined
const openServers: Server[] = []

/** Serve one fixed response body on loopback, and answer the origin it bound. */
async function serveStatic(body: string, contentType: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': contentType })
    res.end(body)
  })
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/**
 * A loopback origin that can REFUSE the wrapper's reachability probe, and then stop refusing.
 *
 * The wrapper probes `origin + '/'` and navigates the frame to `origin + '/live/<runId>'`, so the
 * two are separable by path — and they must be. Refusing "the first request the server sees" would
 * refuse whichever of the two happened to arrive first, and when that is the FRAME navigation the
 * document goes straight to `live` (Chromium fires `load` on its own error page, and the probe that
 * follows succeeds) — the cell would then be measuring a race rather than the memo.
 *
 * The refusal is a socket destroy rather than a 5xx because a `no-cors` fetch RESOLVES for any HTTP
 * status; only a transport failure rejects, which is the shape a restarting dashboard really has.
 * It is held open until the test has seen the document settle, rather than lifted after exactly one
 * request, because Chromium may retry a reset connection — a count-based window could be lifted by
 * a retry and leave the failure unobserved.
 */
function refusingOrigin(): {
  origin: Promise<string>
  probeCount: () => number
  stopRefusing: () => void
} {
  let probes = 0
  let refusing = true
  const server = createServer((req, res) => {
    if ((req.url ?? '/') === '/') {
      probes += 1
      if (refusing) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>inner</title>ok')
  })
  openServers.push(server)
  const origin = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    )
  })
  return { origin, probeCount: () => probes, stopRefusing: () => { refusing = false } }
}

/** A loopback port with NOTHING listening on it — the unreachable origin, honestly produced. */
async function deadOrigin(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

const mint = (handle: number, origin: string, expiresAt: number): AppWrapperMint => ({
  handle,
  liveUrl: `${origin}/live/${RUN_ID}#v2.body${handle}.sig${handle}`,
  expiresAt,
  streamKind: 'cdp-screencast',
})

/** Serve the wrapper for these mints and answer the URL a browser can open it at. */
async function serveWrapper(mints: readonly AppWrapperMint[], permanentLink: string): Promise<string> {
  return serveStatic(
    renderAppWrapperPage({
      runId: RUN_ID,
      mints,
      permanentLink,
      runLive: mints.length > 0,
      now: Date.now(),
    }),
    'text/html; charset=utf-8',
  )
}

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error(
      `${BROWSER_INSTALL_INSTRUCTION} underlying error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}, 120_000)

afterAll(async () => {
  await browser?.close()
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const held = (): Browser => {
  if (browser === undefined) throw new Error('the chromium fixture never came up')
  return browser
}

describe('the wrapper in a real browser', () => {
  it('(3) a dead inner origin ends as `unreachable-origin`, with the sentence and a live link', async () => {
    const dead = await deadOrigin()
    const permanentLink = `${await serveStatic('<!doctype html>ok', 'text/html')}/runs/${RUN_ID}/live`
    const url = await serveWrapper([mint(0, dead, Date.now() + 300_000)], permanentLink)

    const page = await held().newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page
        .locator('[data-app-state="unreachable-origin"]')
        .waitFor({ state: 'attached', timeout: APP_WRAPPER_LOAD_TIMEOUT_MS + 15_000 })

      // Asserted against the constant the page renders, never a restated literal.
      expect(await page.locator('[data-app-message]').textContent()).toBe(
        APP_WRAPPER_UNREACHABLE_MESSAGE,
      )
      // The named state still carries the browser path, so a person always has a way out.
      const link = page.locator('[data-app-permanent-link]')
      expect(await link.getAttribute('href')).toBe(permanentLink)
      expect(await link.textContent()).toBe(APP_WRAPPER_PERMANENT_LINK_LABEL)
      // A locator matching nothing is truthy, so the anchor is counted instead.
      expect(await link.count(), 'the permanent link slot is in the document').toBe(1)
    } finally {
      await page.close()
    }
  }, 180_000)

  it('(4) the picker swaps the frame among PRE-MINTED urls, with zero wrapper-issued requests', async () => {
    const inner = await serveStatic('<!doctype html><title>inner</title>ok', 'text/html')
    const permanentLink = `${inner}/runs/${RUN_ID}/live`
    const mints = [mint(0, inner, Date.now() + 300_000), mint(1, inner, Date.now() + 300_000)]
    const url = await serveWrapper(mints, permanentLink)

    const page = await held().newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-app-state="live"]').waitFor({ state: 'attached', timeout: 30_000 })
      expect(await page.locator('[data-app-live-frame]').getAttribute('src')).toBe(mints[0]!.liveUrl)

      // Only the wrapper document's requests count; the inner frame navigating is the swap itself.
      const wrapperRequests: string[] = []
      page.on('request', (request) => {
        if (request.frame() === page.mainFrame()) wrapperRequests.push(request.url())
      })

      await page.locator('[data-app-handle-picker]').selectOption('1')
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-app-live-frame]')?.getAttribute('src') === expected,
        mints[1]!.liveUrl,
        { timeout: 15_000 },
      )

      expect(await page.locator('[data-app-live-frame]').getAttribute('src')).toBe(mints[1]!.liveUrl)
      expect(wrapperRequests, 'the picker swaps LOCALLY — it never asks anybody for anything').toEqual(
        [],
      )
    } finally {
      await page.close()
    }
  }, 180_000)

  it('(5) a reachable, unexpired frame reaches `live` and hides the message paragraph', async () => {
    const inner = await serveStatic('<!doctype html><title>inner</title>ok', 'text/html')
    const permanentLink = `${inner}/runs/${RUN_ID}/live`
    const url = await serveWrapper([mint(0, inner, Date.now() + 300_000)], permanentLink)

    const page = await held().newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('[data-app-state="live"]').waitFor({ state: 'attached', timeout: 30_000 })

      // Present and hidden is the display rule; presence is a count, as a locator is always truthy.
      expect(
        await page.locator('[data-app-message]').count(),
        'the message paragraph exists and is HIDDEN in live, not absent',
      ).toBe(1)
      expect(await page.locator('[data-app-message]').isVisible()).toBe(false)
      expect(await page.locator('[data-app-live-frame]').isVisible()).toBe(true)
      // A single mint needs no picker, so it is not shown — one pane and no chrome.
      expect(await page.locator('[data-app-handle-picker]').isVisible()).toBe(false)
    } finally {
      await page.close()
    }
  }, 180_000)

  // Forced past actionability, so the wrapper's guard is under test, not Playwright's refusal.
  it('(6) an expired document STAYS expired when the picker is changed, and keeps the link and hint', async () => {
    const inner = await serveStatic('<!doctype html><title>inner</title>ok', 'text/html')
    const permanentLink = `${inner}/runs/${RUN_ID}/live`
    const expiresAt = Date.now() + 2_000
    const mints = [mint(0, inner, expiresAt), mint(1, inner, expiresAt)]
    const url = await serveWrapper(mints, permanentLink)

    const page = await held().newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // Live first, or a document born expired would pass; the transition is under test.
      await page.locator('[data-app-state="live"]').waitFor({ state: 'attached', timeout: 30_000 })
      await page
        .locator('[data-app-state="expired"]')
        .waitFor({ state: 'attached', timeout: 30_000 })

      await page.locator('[data-app-handle-picker]').selectOption('1', { force: true })
      // Longer than the wrapper's OWN bound, so any competing transition the change could have
      // started — `connecting`, a probe resolving to `live`, the timeout arm naming
      // `unreachable-origin` — has had its full chance to land before the reads below.
      await page.waitForTimeout(APP_WRAPPER_LOAD_TIMEOUT_MS + 2_000)

      expect(
        await page.locator('[data-app-state]').getAttribute('data-app-state'),
        'expired is ABSORBING — no interaction the page offers can leave it',
      ).toBe('expired')
      expect(
        await page.locator('[data-app-live-frame]').getAttribute('src'),
        'no aged liveUrl is ever re-assigned to the frame',
      ).toBeNull()

      // The expired state keeps the way out for the life of the document, not just at first.
      expect(await page.locator('[data-app-message]').textContent()).toBe(APP_WRAPPER_EXPIRED_MESSAGE)
      expect(await page.locator('[data-app-hint]').textContent()).toBe(APP_WRAPPER_EXPIRED_HINT)
      const link = page.locator('[data-app-permanent-link]')
      expect(await link.getAttribute('href')).toBe(permanentLink)

      // The affordance and the state cannot disagree.
      expect(
        await page.locator('[data-app-handle-picker]').getAttribute('disabled'),
        'the picker is an affordance of the embedded variant — it goes when the variant goes',
      ).not.toBeNull()
    } finally {
      await page.close()
    }
  }, 180_000)

  // `javaScriptEnabled: false` stands in for a `script-src 'none'` host: painted, no script run.
  it('(7) with the script never running, the document still names a state and offers the way out', async () => {
    const inner = await serveStatic('<!doctype html><title>inner</title>ok', 'text/html')
    const permanentLink = `${inner}/runs/${RUN_ID}/live`
    const url = await serveWrapper([mint(0, inner, Date.now() + 300_000)], permanentLink)

    const context = await held().newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })

      // The way out, complete and clickable with no script at all.
      const link = page.locator('[data-app-permanent-link]')
      expect(await link.count(), 'the anchor is in the served markup').toBe(1)
      expect(await link.getAttribute('href')).toBe(permanentLink)
      expect(await link.textContent()).toBe(APP_WRAPPER_PERMANENT_LINK_LABEL)
      expect(await link.isVisible(), 'and a person can actually see it').toBe(true)

      // A NAMED state with a named second line — not an indefinite progress claim on its own.
      expect(await page.locator('[data-app-state]').getAttribute('data-app-state')).toBe('connecting')
      expect(await page.locator('[data-app-message]').textContent()).toBe(
        APP_WRAPPER_CONNECTING_MESSAGE,
      )
      expect(await page.locator('[data-app-hint]').textContent()).toBe(APP_WRAPPER_CONNECTING_HINT)
      expect(await page.locator('[data-app-hint]').isVisible()).toBe(true)

      // And no dead pane under it: the frame was never handed a src, so there is nothing to mistake
      // for a stalled one. `hidden` here is the stylesheet's, not the script's.
      expect(await page.locator('[data-app-live-frame]').getAttribute('src')).toBeNull()
      expect(await page.locator('[data-app-live-frame]').isVisible()).toBe(false)
    } finally {
      await page.close()
      await context.close()
    }
  }, 180_000)

  // The reachability memo caches only success, so one refused probe cannot pin it unreachable.
  it('(8) a REFUSED probe is not remembered — a later handle swap probes again and reaches live', async () => {
    const refusing = refusingOrigin()
    const inner = await refusing.origin
    const permanentLink = `${inner}/runs/${RUN_ID}/live`
    const mints = [mint(0, inner, Date.now() + 300_000), mint(1, inner, Date.now() + 300_000)]
    const url = await serveWrapper(mints, permanentLink)

    const page = await held().newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })

      // The honest first verdict: nothing answered for that origin, so the document says so by name
      // rather than showing a pane it cannot vouch for.
      await page
        .locator('[data-app-state="unreachable-origin"]')
        .waitFor({ state: 'attached', timeout: APP_WRAPPER_LOAD_TIMEOUT_MS + 15_000 })
      expect(await page.locator('[data-app-message]').textContent()).toBe(
        APP_WRAPPER_UNREACHABLE_MESSAGE,
      )
      const probesWhileRefusing = refusing.probeCount()
      expect(probesWhileRefusing, 'the wrapper really did probe').toBeGreaterThan(0)

      // The dashboard comes back. Nothing about the DOCUMENT changed — only the world it was wrong
      // about. Settling before the swap so no probe issued during the refusing window is still in
      // flight when the picker fires (that promise would answer false and mask the recovery).
      refusing.stopRefusing()
      await page.waitForTimeout(1_000)

      await page.locator('[data-app-handle-picker]').selectOption('1')

      // THE PATH BACK, which did not exist before this plan.
      await page.locator('[data-app-state="live"]').waitFor({ state: 'attached', timeout: 30_000 })
      expect(await page.locator('[data-app-live-frame]').getAttribute('src')).toBe(mints[1]!.liveUrl)
      expect(
        refusing.probeCount(),
        'a SECOND probe was issued — the false was forgotten, not reused',
      ).toBeGreaterThan(probesWhileRefusing)
      expect(refusing.probeCount(), 'more than one probe reached the origin').toBeGreaterThan(1)
    } finally {
      await page.close()
    }
  }, 180_000)
})
