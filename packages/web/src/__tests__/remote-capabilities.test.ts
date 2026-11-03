import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { chromium } from 'playwright-core'
import type { ActionResult, RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import {
  refuseWithoutChromium,
  startCdpBrowser,
  startCountingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CdpBrowser, CountingProxy, PlaywrightServer } from './fixtures/remote-browsers.js'

const VIEWPORT = { width: 1024, height: 640 }
const CONNECT_TIMEOUT_MS = 30_000
const FILE_BODY = 'hello'

// Any key names itself in the heading; Enter also downloads a file.
const PAGE = `<!DOCTYPE html><html><head><title>Keys</title></head><body>
<h1 id="key">No key yet</h1><a id="file" href="/file" download="note.txt">Get file</a>
<script>
addEventListener('keydown', (event) => {
  document.getElementById('key').textContent = 'Pressed ' + event.key
  if (event.key === 'Enter') document.getElementById('file').click()
})
</script></body></html>`

let site: Server
let siteOrigin = ''

beforeAll(async () => {
  refuseWithoutChromium()
  site = createServer((request, response) => {
    if (request.url === '/file') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="note.txt"',
      })
      response.end(FILE_BODY)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(PAGE)
  })
  await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()))
  siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`
})

afterAll(async () => {
  site.closeAllConnections()
  await new Promise<void>((closed) => site.close(() => closed()))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function remoteOf(
  protocol: RemoteBrowserConfig['protocol'],
  url: string,
  extra: Partial<RemoteBrowserConfig> = {},
): RemoteBrowserConfig {
  return { name: 'grid', protocol, url, connectTimeoutMs: CONNECT_TIMEOUT_MS, ...extra }
}

async function setUpOn(adapter: WebPlatformAdapter, remote: RemoteBrowserConfig): Promise<void> {
  await adapter.setup({ platform: 'web', browser: { name: 'chromium', viewport: VIEWPORT, remote } })
}

async function pressEnterOnPage(adapter: WebPlatformAdapter): Promise<ActionResult> {
  const navigated = await adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/` })
  expect(navigated.success).toBe(true)
  const pressed = await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press' })
  expect(pressed.success).toBe(true)
  return pressed
}

function downloadsOf(result: ActionResult): unknown {
  return (result.metadata as { download?: unknown } | undefined)?.download
}

function capabilitiesOf(adapter: WebPlatformAdapter): string[] {
  const evidence = adapter.placeEvidence
  if (evidence?.place !== 'remote') throw new Error('the adapter reports no remote place')
  return evidence.unsupported.map((entry) => entry.capability)
}

async function cdpPlatform(cdp: CdpBrowser): Promise<string> {
  const look = await chromium.connectOverCDP(cdp.endpoint, { timeout: CONNECT_TIMEOUT_MS })
  try {
    const context = await look.newContext()
    const page = await context.newPage()
    return await page.evaluate(() => navigator.platform)
  } finally {
    await look.close()
  }
}

describe('what a remote browser cannot give', () => {
  it('on a CDP browser, downloads, launch flags and clipboard read-back are reported unsupported with their reasons', async () => {
    let cdp: CdpBrowser | undefined
    let proxy: CountingProxy | undefined
    const adapter = new WebPlatformAdapter()
    try {
      cdp = await startCdpBrowser()
      proxy = await startCountingProxy(cdp.port)
      await setUpOn(adapter, remoteOf('cdp', `http://127.0.0.1:${String(proxy.port)}`, { context: 'new' }))

      expect(adapter.operationCaptureSupport).toEqual({
        download: false,
        clipboard: false,
        reason:
          'a cdp remote returns no download bytes; clipboard read-back is off because the remote decides whether its browser shows a window',
      })
      expect(adapter.placeEvidence).toEqual({
        place: 'remote',
        name: 'grid',
        protocol: 'cdp',
        origin: `http://127.0.0.1:${String(proxy.port)}`,
        browserVersion: cdp.owner.version(),
        headless: 'decided by the remote',
        unsupported: [
          { capability: 'launch flags', reason: "a remote browser starts with the service's own flags" },
          { capability: 'downloads', reason: 'a cdp remote returns no download bytes' },
          {
            capability: 'clipboard read-back',
            reason: 'the remote decides whether its browser shows a window',
          },
        ],
      })

      const pressed = await pressEnterOnPage(adapter)
      expect(downloadsOf(pressed)).toBeUndefined()
    } finally {
      await adapter.cleanup()
      await proxy?.close()
      await cdp?.close()
    }
  }, 60_000)

  it("with context: reuse, the clipboard probe is also reported unsupported because the browser's context is shared", async () => {
    let cdp: CdpBrowser | undefined
    const adapter = new WebPlatformAdapter()
    try {
      cdp = await startCdpBrowser()
      await setUpOn(adapter, remoteOf('cdp', cdp.endpoint, { context: 'reuse' }))

      expect(capabilitiesOf(adapter)).toEqual([
        'launch flags',
        'downloads',
        'clipboard read-back',
        'clipboard probe',
      ])
      const evidence = adapter.placeEvidence
      expect(evidence?.place === 'remote' ? evidence.unsupported[3] : undefined).toEqual({
        capability: 'clipboard probe',
        reason: "the browser's own context is shared with other sessions",
      })
      expect(adapter.operationCaptureSupport?.clipboard).toBe(false)
      expect(adapter.operationCaptureSupport?.reason).toContain(
        "the clipboard probe is off because the browser's own context is shared with other sessions",
      )
    } finally {
      await adapter.cleanup()
      await cdp?.close()
    }
  }, 60_000)

  it("on a Playwright server, downloads are captured, headless is the remote's and the browser version is the server's", async () => {
    let server: PlaywrightServer | undefined
    let proxy: CountingProxy | undefined
    const launch = vi.spyOn(chromium, 'launch')
    const adapter = new WebPlatformAdapter()
    try {
      server = await startPlaywrightServer()
      const upstream = new URL(server.wsEndpoint)
      const look = await chromium.connect(server.wsEndpoint, { timeout: CONNECT_TIMEOUT_MS })
      const serverVersion = look.version()
      await look.close()
      proxy = await startCountingProxy(Number(upstream.port))
      const remote = remoteOf('playwright', `ws://127.0.0.1:${String(proxy.port)}${upstream.pathname}`)
      launch.mockClear()

      await adapter.setup({
        platform: 'web',
        browser: { name: 'chromium', viewport: VIEWPORT, headless: false, remote },
      })

      expect(launch).not.toHaveBeenCalled()
      expect(adapter.operationCaptureSupport).toEqual({
        download: true,
        clipboard: false,
        reason:
          'clipboard read-back is off because the remote decides whether its browser shows a window',
      })
      const evidence = adapter.placeEvidence
      expect(evidence).toMatchObject({
        place: 'remote',
        name: 'grid',
        protocol: 'playwright',
        origin: `ws://127.0.0.1:${String(proxy.port)}`,
        browserVersion: serverVersion,
        headless: 'decided by the remote',
      })
      expect(JSON.stringify(evidence)).not.toContain(upstream.pathname)
      expect(capabilitiesOf(adapter)).toEqual(['launch flags', 'clipboard read-back'])

      const pressed = await pressEnterOnPage(adapter)
      expect(downloadsOf(pressed)).toEqual([
        expect.objectContaining({ suggestedFilename: 'note.txt', size: FILE_BODY.length }),
      ])
    } finally {
      await adapter.cleanup()
      await proxy?.close()
      await server?.close()
    }
  }, 60_000)

  it("keyboard shortcuts follow the remote browser's platform, not this machine's", async () => {
    let cdp: CdpBrowser | undefined
    const adapter = new WebPlatformAdapter()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (platform === undefined) throw new Error('process.platform has no descriptor')
    try {
      cdp = await startCdpBrowser()
      const remoteIsMac = /^Mac/.test(await cdpPlatform(cdp))
      await setUpOn(adapter, remoteOf('cdp', cdp.endpoint))
      const navigated = await adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/` })
      expect(navigated.success).toBe(true)

      // This machine claims the other platform, so only the remote's answer gives the right key.
      Object.defineProperty(process, 'platform', { value: remoteIsMac ? 'linux' : 'darwin' })
      try {
        const pressed = await adapter.execute({ type: 'keypress', keys: ['Meta'], mode: 'press' })
        expect(pressed.success).toBe(true)
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }

      const state = await adapter.observe()
      expect(state.tree).toContain(remoteIsMac ? 'Pressed Meta' : 'Pressed Control')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      await adapter.cleanup()
      await cdp?.close()
    }
  }, 60_000)

  it('a browser launched here reports its place as here, and cleanup clears it', async () => {
    const adapter = new WebPlatformAdapter()
    try {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', viewport: VIEWPORT } })
      expect(adapter.placeEvidence).toEqual({ place: 'here' })
      expect(adapter.operationCaptureSupport).toEqual({ download: true, clipboard: true })
    } finally {
      await adapter.cleanup()
    }
    expect(adapter.placeEvidence).toBeUndefined()
  }, 60_000)
})
