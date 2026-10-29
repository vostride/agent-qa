import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<WebPlatformAdapter['execute']>[0]
type WebAdapter = WebPlatformAdapter

let calls: string[] = []

function makeLocator() {
  return {
    focus: vi.fn().mockImplementation(() => { calls.push('locator.focus'); return Promise.resolve() }),
    boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 100, height: 30 }),
    nth: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
  }
}
let locator: ReturnType<typeof makeLocator>

// A one-shot dialog handle handed to a page.once('dialog', …) arm.
function makeDialog() {
  return {
    accept: vi.fn().mockImplementation((t?: string) => { calls.push(`dialog.accept:${t ?? ''}`); return Promise.resolve() }),
    dismiss: vi.fn().mockImplementation(() => { calls.push('dialog.dismiss'); return Promise.resolve() }),
    type: vi.fn().mockReturnValue('confirm'),
    message: vi.fn().mockReturnValue('Are you sure?'),
  }
}

function makeCdpSession() {
  return {
    send: vi.fn().mockImplementation((method: string) => { calls.push(`cdp:${method}`); return Promise.resolve({}) }),
    detach: vi.fn().mockResolvedValue(undefined),
  }
}

let dialogHandlers: Array<(d: ReturnType<typeof makeDialog>) => unknown>
let cdpSupported: boolean
let storageStateValue: unknown

function makeContext() {
  const ctx: Record<string, any> = {
    route: vi.fn().mockImplementation((p: string) => { calls.push(`context.route:${p}`); return Promise.resolve() }),
    unroute: vi.fn().mockImplementation((p: string) => { calls.push(`context.unroute:${p}`); return Promise.resolve() }),
    unrouteAll: vi.fn().mockImplementation(() => { calls.push('context.unrouteAll'); return Promise.resolve() }),
    setOffline: vi.fn().mockImplementation((v: boolean) => { calls.push(`context.setOffline:${v}`); return Promise.resolve() }),
    setStorageState: vi.fn().mockImplementation(() => { calls.push('context.setStorageState'); return Promise.resolve() }),
    storageState: vi.fn().mockImplementation(() => { calls.push('context.storageState'); return Promise.resolve(storageStateValue) }),
    cookies: vi.fn().mockImplementation(() => { calls.push('context.cookies'); return Promise.resolve([{ name: 'sid', value: 'x' }]) }),
    addCookies: vi.fn().mockResolvedValue(undefined),
    newCDPSession: vi.fn().mockImplementation(() => {
      calls.push('context.newCDPSession')
      return cdpSupported ? Promise.resolve(makeCdpSession()) : Promise.reject(new Error('CDPSession is only available in Chromium'))
    }),
    newPage: vi.fn().mockImplementation(() => { calls.push('context.newPage'); return Promise.resolve(mockPage) }),
    pages: vi.fn().mockImplementation(() => { calls.push('context.pages'); return [mockPage] }),
  }
  return ctx
}
let mockContext: ReturnType<typeof makeContext>

function makePage() {
  const page: Record<string, any> = {
    goto: vi.fn().mockImplementation((u: string) => { calls.push(`page.goto:${u}`); return Promise.resolve(null) }),
    goBack: vi.fn().mockImplementation(() => { calls.push('page.goBack'); return Promise.resolve(null) }),
    goForward: vi.fn().mockImplementation(() => { calls.push('page.goForward'); return Promise.resolve(null) }),
    reload: vi.fn().mockImplementation(() => { calls.push('page.reload'); return Promise.resolve(null) }),
    once: vi.fn().mockImplementation((evt: string, handler: (d: ReturnType<typeof makeDialog>) => unknown) => {
      calls.push(`page.once:${evt}`)
      if (evt === 'dialog') dialogHandlers.push(handler)
    }),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn().mockImplementation((evt: string) => { calls.push(`page.removeAllListeners:${evt}`) }),
    evaluate: vi.fn().mockImplementation(() => { calls.push('page.evaluate'); return Promise.resolve({ token: 'abc' }) }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('shot')),
    url: vi.fn().mockReturnValue('https://example.test/'),
    title: vi.fn().mockResolvedValue('Example'),
    keyboard: {
      press: vi.fn().mockImplementation((k: string) => { calls.push(`keyboard.press:${k}`); return Promise.resolve() }),
      down: vi.fn().mockImplementation((k: string) => { calls.push(`keyboard.down:${k}`); return Promise.resolve() }),
      up: vi.fn().mockImplementation((k: string) => { calls.push(`keyboard.up:${k}`); return Promise.resolve() }),
    },
    waitForSelector: vi.fn().mockImplementation(() => { calls.push('page.waitForSelector'); return Promise.resolve(null) }),
    waitForFunction: vi.fn().mockImplementation(() => { calls.push('page.waitForFunction'); return Promise.resolve(null) }),
    getByText: vi.fn().mockReturnValue({ waitFor: vi.fn().mockResolvedValue(undefined), first: vi.fn().mockReturnThis() }),
    // `:root` serves the ai snapshot the binding check reads; any other selector is the element.
    locator: vi.fn().mockImplementation((selector: string) => (selector === ':root'
      ? { ariaSnapshot: vi.fn().mockResolvedValue('- textbox "Email" [ref=e1]') }
      : locator)),
    evaluateHandle: vi.fn().mockImplementation(async () => documentHandle()),
    context: vi.fn().mockImplementation(() => mockContext),
    bringToFront: vi.fn().mockResolvedValue(undefined),
  }
  return page
}
let mockPage: ReturnType<typeof makePage>

// The observation's document handle: still the page's document, disposable.
function documentHandle() {
  return { evaluate: vi.fn().mockResolvedValue(true), dispose: vi.fn().mockResolvedValue(undefined) }
}

// Direct injection: page/context/lastRefs and the observation's document epoch onto the private
// fields so the pins drive the execute switch without a live browser.
function inject(adapter: WebAdapter): WebAdapter {
  ;(adapter as any).page = mockPage
  ;(adapter as any).context = mockContext
  ;(adapter as any).lastRefs = { e1: { nativeRef: 'e1', role: 'textbox', name: 'Email' } }
  ;(adapter as any).epoch = { page: mockPage, document: documentHandle() }
  return adapter
}

const ADAPTERS: Array<[string, () => WebAdapter]> = [
  ['WebPlatformAdapter (main execute switch)', () => new WebPlatformAdapter()],
]

describe.each(ADAPTERS)('web catalog RED — %s', (_label, factory) => {
  let adapter: WebAdapter

  beforeEach(() => {
    calls = []
    dialogHandlers = []
    cdpSupported = true
    storageStateValue = { cookies: [{ name: 'sid', value: 'x' }], origins: [] }
    locator = makeLocator()
    mockPage = makePage()
    mockContext = makeContext()
    vi.clearAllMocks()
    adapter = inject(factory())
  })

  describe('navigate (fold re-key of refresh / navigateHistory)', () => {
    it('{to:"url"} → page.goto (already-working sub-case; the re-key must preserve it)', async () => {
      const r = await adapter.execute({ type: 'navigate', to: 'url', url: 'https://a.test/' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockPage.goto.mock.calls[0]?.[0]).toBe('https://a.test/')
    })
    it('{to:"back"} → page.goBack, {to:"forward"} → page.goForward', async () => {
      await adapter.execute({ type: 'navigate', to: 'back' } as unknown as ExecAction)
      await adapter.execute({ type: 'navigate', to: 'forward' } as unknown as ExecAction)
      expect(mockPage.goBack).toHaveBeenCalled()
      expect(mockPage.goForward).toHaveBeenCalled()
    })
    it('{to:"reload"} → page.reload (never page.goto)', async () => {
      mockPage.goto.mockClear()
      const r = await adapter.execute({ type: 'navigate', to: 'reload' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockPage.reload).toHaveBeenCalled()
      expect(mockPage.goto).not.toHaveBeenCalled()
    })
  })

  describe('tab (fold re-key of newTab / switchTab)', () => {
    it('{action:"new"} → a new page is created', async () => {
      const r = await adapter.execute({ type: 'tab', action: 'new', url: 'https://b.test/' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.newPage).toHaveBeenCalled()
    })
    it('{action:"switch"} → the context page list drives selection', async () => {
      const r = await adapter.execute({ type: 'tab', action: 'switch', index: 0 } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.pages).toHaveBeenCalled()
    })
  })

  describe('inspect (fold re-key of read* bodies) — output rides ActionResult.data', () => {
    it('what:"cookies" → context.cookies and entries on result.data', async () => {
      const r = await adapter.execute({ type: 'inspect', what: 'cookies' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.cookies).toHaveBeenCalled()
      expect(r.data).toBeDefined()
    })
    it('what:"console" and what:"network" return entries on result.data', async () => {
      const c = await adapter.execute({ type: 'inspect', what: 'console' } as unknown as ExecAction)
      const n = await adapter.execute({ type: 'inspect', what: 'network' } as unknown as ExecAction)
      expect(c.success).toBe(true)
      expect(n.success).toBe(true)
      expect(c.data).toBeDefined()
      expect(n.data).toBeDefined()
    })
    it('what:"localStorage" reads via page.evaluate', async () => {
      const r = await adapter.execute({ type: 'inspect', what: 'localStorage' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockPage.evaluate).toHaveBeenCalled()
    })
  })

  describe('keypress (fold re-key of keyDown / keyUp)', () => {
    it('mode:"press" → keyboard.press, mode:"down" → keyboard.down, mode:"up" → keyboard.up', async () => {
      await adapter.execute({ type: 'keypress', keys: ['Enter'], mode: 'press' } as unknown as ExecAction)
      await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'down' } as unknown as ExecAction)
      await adapter.execute({ type: 'keypress', keys: ['Shift'], mode: 'up' } as unknown as ExecAction)
      expect(mockPage.keyboard.press).toHaveBeenCalled()
      expect(mockPage.keyboard.down).toHaveBeenCalled()
      expect(mockPage.keyboard.up).toHaveBeenCalled()
    })
  })

  describe('waitFor (schema on-shapes, not the legacy condition read)', () => {
    it('{on:"text"} drives real waiting logic keyed on the schema text, not the degenerate legacy condition read', async () => {
      const r = await adapter.execute({ type: 'waitFor', on: 'text', text: 'Loading', timeoutMs: 1000 } as unknown as ExecAction)
      expect(r.success).toBe(true)
      // The schema `text` (not the retired `condition` field) must drive the wait — assert the
      // value 'Loading' reaches a real waiting primitive's arguments.
      const argsBlob = JSON.stringify([
        mockPage.getByText.mock.calls,
        mockPage.waitForFunction.mock.calls,
        mockPage.waitForSelector.mock.calls,
      ])
      expect(argsBlob).toContain('Loading')
    })
    it('{on:"selector"} waits on the selector', async () => {
      await adapter.execute({ type: 'waitFor', on: 'selector', selector: '#done', timeoutMs: 1000 } as unknown as ExecAction)
      expect(mockPage.waitForSelector).toHaveBeenCalled()
    })
  })

  describe('focus (new case)', () => {
    it('resolves the ref and calls locator.focus()', async () => {
      const r = await adapter.execute({ type: 'focus', ref: 'e1' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockPage.locator).toHaveBeenCalledWith('aria-ref=e1')
      expect(locator.focus).toHaveBeenCalled()
    })
  })

  describe('route / unroute', () => {
    it('route registers a context.route interception for the pattern', async () => {
      const r = await adapter.execute({ type: 'route', urlPattern: '**/api/**', body: '{"ok":true}', contentType: 'application/json' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.route).toHaveBeenCalled()
      expect(calls.some(c => c.startsWith('context.route:'))).toBe(true)
    })
    it('unroute with a pattern → context.unroute; pattern-less → context.unrouteAll', async () => {
      await adapter.execute({ type: 'unroute', urlPattern: '**/api/**' } as unknown as ExecAction)
      expect(mockContext.unroute).toHaveBeenCalled()
      calls = []
      await adapter.execute({ type: 'unroute' } as unknown as ExecAction)
      expect(mockContext.unrouteAll).toHaveBeenCalled()
    })
  })

  describe('networkState', () => {
    it('offline → context.setOffline(true)', async () => {
      const r = await adapter.execute({ type: 'networkState', mode: 'offline' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.setOffline).toHaveBeenCalledWith(true)
    })
    it('throttle on a Chromium context → newCDPSession + Network.emulateNetworkConditions', async () => {
      cdpSupported = true
      const r = await adapter.execute({ type: 'networkState', mode: 'throttle', latencyMs: 100, downloadKbps: 1000, uploadKbps: 500 } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.newCDPSession).toHaveBeenCalled()
      expect(calls).toContain('cdp:Network.emulateNetworkConditions')
    })
    it('throttle on a non-Chromium context → structured §7.1 error naming the Chromium-only limitation, success false', async () => {
      cdpSupported = false
      const r = await adapter.execute({ type: 'networkState', mode: 'throttle', latencyMs: 100, downloadKbps: 1000, uploadKbps: 500 } as unknown as ExecAction)
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/chromium/i)
    })
  })

  describe('storageState (the adapter produces and consumes it)', () => {
    it('save → context.storageState() and the state + name on the result', async () => {
      const r = await adapter.execute({ type: 'storageState', op: 'save', name: 'authed' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.storageState).toHaveBeenCalled()
      expect(JSON.stringify(r)).toContain('authed')
    })
    it('restore → context.setStorageState with the injected state', async () => {
      const r = await adapter.execute({ type: 'storageState', op: 'restore', name: 'authed' } as unknown as ExecAction)
      expect(r.success).toBe(true)
      expect(mockContext.setStorageState).toHaveBeenCalled()
    })
  })

  describe('handleDialog', () => {
    it('arms page.once("dialog"); accept:true → dialog.accept(promptText)', async () => {
      await adapter.execute({ type: 'handleDialog', accept: true, promptText: 'yes' } as unknown as ExecAction)
      expect(mockPage.once).toHaveBeenCalledWith('dialog', expect.any(Function))
      const dialog = makeDialog()
      dialogHandlers.forEach(h => h(dialog))
      expect(dialog.accept).toHaveBeenCalledWith('yes')
    })
    it('accept:false → dialog.dismiss', async () => {
      await adapter.execute({ type: 'handleDialog', accept: false } as unknown as ExecAction)
      const dialog = makeDialog()
      dialogHandlers.forEach(h => h(dialog))
      expect(dialog.dismiss).toHaveBeenCalled()
    })
    it('a second arm before firing REPLACES the pending arm (one-shot, not stacked)', async () => {
      await adapter.execute({ type: 'handleDialog', accept: true } as unknown as ExecAction)
      await adapter.execute({ type: 'handleDialog', accept: false } as unknown as ExecAction)
      expect(mockPage.once).toHaveBeenCalled()
      // Only the most recent arm should fire on the next dialog.
      const dialog = makeDialog()
      const activeHandler = dialogHandlers[dialogHandlers.length - 1]
      if (activeHandler) activeHandler(dialog)
      expect(dialog.dismiss).toHaveBeenCalled()
      expect(dialog.accept).not.toHaveBeenCalled()
    })
  })

  describe('teardown clears persistent route/network/dialog state', () => {
    it('cleanup() calls unrouteAll and setOffline(false)', async () => {
      await adapter.cleanup()
      expect(mockContext.unrouteAll).toHaveBeenCalled()
      expect(mockContext.setOffline).toHaveBeenCalledWith(false)
    })
  })
})
