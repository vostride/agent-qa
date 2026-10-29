import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Compound fill, scroll and openApp sequences against a call-logging mocked driver; no live Appium.

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.TextView text="Login" bounds="[100,100][980,200]" content-desc="" enabled="true" />
      <android.widget.EditText text="" content-desc="Username" bounds="[100,250][980,350]" enabled="true" />
      <android.widget.EditText text="" content-desc="Password" password="true" bounds="[100,400][980,500]" enabled="true" />
      <android.widget.Button text="Sign In" bounds="[100,550][980,650]" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function createMockPointerAction() {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockReturnValue(chain)
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.pause = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockResolvedValue(undefined)
  return chain
}

// Ordered driver-call log so ordering/count pins survive implementation detail.
let calls: string[] = []

// A call-logging fake focused element. getText/getAttribute returns are configurable.
let focusedGetTextReturn: string
let focusedPasswordAttr: string | null
function createMockElement() {
  return {
    isExisting: vi.fn().mockResolvedValue(true),
    setValue: vi.fn().mockImplementation((v: string) => { calls.push(`setValue:${v}`); return Promise.resolve() }),
    addValue: vi.fn().mockImplementation((v: string) => { calls.push(`addValue:${v}`); return Promise.resolve() }),
    getText: vi.fn().mockImplementation(() => { calls.push('getText'); return Promise.resolve(focusedGetTextReturn) }),
    getAttribute: vi.fn().mockImplementation((n: string) => {
      calls.push(`getAttr:${n}`)
      return Promise.resolve(n === 'password' ? focusedPasswordAttr : null)
    }),
    clearValue: vi.fn().mockResolvedValue(undefined),
  }
}
let mockElement: ReturnType<typeof createMockElement>

// `mobile: listApps` returns a package-id-keyed map. Configurable per test.
let listAppsReturn: Record<string, Record<string, unknown>>
let listAppsThrows: boolean
// `mobile: scrollGesture` answers, one per call; the last repeats.
let scrollGestureReturns: unknown[]
let scrollGestureCalls: number

function createMockDriver() {
  const pointerAction = createMockPointerAction()
  return {
    getPageSource: vi.fn().mockImplementation(() => { calls.push('getPageSource'); return Promise.resolve(ANDROID_XML) }),
    getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(pointerAction),
    actions: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockImplementation((k: unknown) => { calls.push(`keys:${JSON.stringify(k)}`); return Promise.resolve() }),
    pause: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockImplementation((id: string) => { calls.push(`activateApp:${id}`); return Promise.resolve() }),
    queryAppState: vi.fn().mockResolvedValue(1),
    terminateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockImplementation((command: string, args?: unknown) => {
      calls.push(`execute:${command}:${JSON.stringify(args ?? null)}`)
      if (command === 'mobile: listApps') {
        if (listAppsThrows) return Promise.reject(new Error('listApps unavailable'))
        return Promise.resolve(listAppsReturn)
      }
      if (command === 'mobile: scrollGesture') {
        const answer = scrollGestureReturns[Math.min(scrollGestureCalls, scrollGestureReturns.length - 1)]
        scrollGestureCalls += 1
        return Promise.resolve(answer)
      }
      return Promise.resolve(undefined)
    }),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    switchContext: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    // Only the focused-node lookup finds the field, so it reads as a non-empty single value.
    $: vi.fn().mockImplementation((selector: string) =>
      Promise.resolve(selector === '//*[@focused="true"]' ? mockElement : { isExisting: () => Promise.resolve(false) })),
    _pointerAction: pointerAction,
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { AndroidPlatformAdapter } from '../adapter.js'
import { WEBVIEW_SCROLLERS_SCRIPT } from '@vostride/agent-qa-core'

type ExecAction = Parameters<AndroidPlatformAdapter['execute']>[0]

describe('AndroidPlatformAdapter compound behaviors (RED — Wave-0)', () => {
  let adapter: AndroidPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  beforeEach(async () => {
    vi.clearAllMocks()
    calls = []
    focusedGetTextReturn = ''
    focusedPasswordAttr = null
    listAppsReturn = {}
    listAppsThrows = false
    scrollGestureReturns = [true]
    scrollGestureCalls = 0
    mockElement = createMockElement()
    mockDriver = createMockDriver()
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)
    adapter = new AndroidPlatformAdapter()
  })

  afterEach(() => { vi.restoreAllMocks() })

  async function refFor(name: string): Promise<string> {
    const state = await adapter.observe()
    const el = state.elements.find(e => e.name === name)
    if (!el) throw new Error(`test fixture: element "${name}" not observed`)
    return el.ref
  }

  describe('fill compound', () => {
    it('replace mode types via setValue then re-reads getText() from the SAME focused handle, in order', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Username')
      focusedGetTextReturn = 'hello'
      calls.length = 0

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(mockElement.setValue).toHaveBeenCalledWith('hello')
      expect(mockElement.getText).toHaveBeenCalled()
      const typeIdx = calls.findIndex(c => c.startsWith('setValue:'))
      const readIdx = calls.indexOf('getText')
      expect(readIdx).toBeGreaterThan(typeIdx)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'hello', actual: 'hello' },
        fillVerdict: { verb: 'fill', verdict: 'exact', path: 'native' },
      })
    })

    it('append mode captures prior getText() BEFORE typing and uses addValue (A1)', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Username')
      focusedGetTextReturn = 'abc'
      mockElement.addValue.mockImplementation((v: string) => {
        calls.push(`addValue:${v}`)
        focusedGetTextReturn = `abc${v}`
        return Promise.resolve()
      })
      calls.length = 0

      const result = await adapter.execute({ type: 'fill', ref, text: 'XYZ', clearMode: 'append', submit: false } as unknown as ExecAction)

      expect(mockElement.addValue).toHaveBeenCalledWith('XYZ')
      const priorReadIdx = calls.indexOf('getText')
      const typeIdx = calls.findIndex(c => c.startsWith('addValue:'))
      expect(priorReadIdx).toBeGreaterThanOrEqual(0)
      expect(priorReadIdx).toBeLessThan(typeIdx)
      expect(result.metadata?.fillReread).toEqual({ expected: 'abcXYZ', actual: 'abcXYZ' })
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    })

    it('submit=true presses KEYCODE_ENTER (mobile: pressKey keycode 66) AFTER the re-read (A4); submit=false does not', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Username')
      focusedGetTextReturn = 'hello'
      calls.length = 0

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: true } as unknown as ExecAction)

      expect(mockDriver.execute).toHaveBeenCalledWith('mobile: pressKey', { keycode: 66 })
      const readIdx = calls.indexOf('getText')
      const enterIdx = calls.findIndex(c => c.includes('mobile: pressKey') && c.includes('66'))
      expect(enterIdx).toBeGreaterThan(readIdx)
      expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })

      calls.length = 0
      const unsubmitted = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: false } as unknown as ExecAction)
      expect(calls.some(c => c.includes('mobile: pressKey'))).toBe(false)
      expect(unsubmitted.metadata).not.toHaveProperty('fillSubmit')
    })

    it('an unreadable re-read is unverified and still sends the requested Enter, after setValue and the read attempt', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Username')
      mockElement.getText.mockImplementation(() => { calls.push('getText'); return Promise.reject(new Error('stale element')) })
      calls.length = 0

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: true } as unknown as ExecAction)

      const typeIdx = calls.indexOf('setValue:hello')
      const readIdx = calls.indexOf('getText')
      const enterIdx = calls.findIndex(c => c.includes('mobile: pressKey') && c.includes('66'))
      expect(typeIdx).toBeGreaterThanOrEqual(0)
      expect(readIdx).toBeGreaterThan(typeIdx)
      expect(enterIdx).toBeGreaterThan(readIdx)
      expect(calls.filter(c => c.includes('mobile: pressKey'))).toHaveLength(1)
      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillVerdict: { verb: 'fill', verdict: 'unverified', path: 'native' },
        fillSubmit: { sent: true, outcome: 'sent' },
      })
    })

    it('mismatch yields success:false + §7.1 error + fillReread meta, single-shot typing', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Username')
      focusedGetTextReturn = 'wrong'

      const result = await adapter.execute({ type: 'fill', ref, text: 'intended', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/reads .* after typing .* re-observe and retry/i)
      expect(result.metadata?.fillReread).toEqual({ expected: 'intended', actual: 'wrong' })
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'mismatch', path: 'native' })
      expect(result.metadata).not.toHaveProperty('fillSubmit')
      expect(mockElement.setValue).toHaveBeenCalledTimes(1)
      expect(mockElement.addValue).not.toHaveBeenCalled()
    })

    it('secure field (password=true) verdicts on non-emptiness and never records the raw value', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Password')
      focusedPasswordAttr = 'true'
      focusedGetTextReturn = 'topSecretPw'

      const result = await adapter.execute({ type: 'fill', ref, text: 'topSecretPw', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(result.metadata?.fillReread).toEqual({ expected: '<len:11>', actual: '<len:11>' })
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'native', secure: true })
      expect(JSON.stringify(result)).not.toContain('topSecretPw')
    })
  })

  describe('scroll untilVisible escapes or refuses a hostile selector target', () => {
    it('tries native mobile: scroll with the -android uiautomator strategy FIRST', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()
      calls.length = 0

      const result = await adapter.execute({
        type: 'scroll', mode: 'untilVisible', text: 'Settings', direction: 'down', maxSwipes: 4, retryOpposite: true,
      } as unknown as ExecAction)

      expect(result.success).toBe(true)
      const scrollCall = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: scroll')
      expect(scrollCall).toBeDefined()
      expect((scrollCall![1] as any).strategy).toBe('-android uiautomator')
      expect(result.metadata?.scrollUntilVisible).toBeDefined()
    })

    it('escapes quote/backslash in a hostile target inside the UiSelector source string', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      await adapter.execute({
        type: 'scroll', mode: 'untilVisible', text: 'He said "hi" \\', direction: 'down', maxSwipes: 4, retryOpposite: false,
      } as unknown as ExecAction)

      const scrollCall = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: scroll')
      expect(scrollCall).toBeDefined()
      const selector = String((scrollCall![1] as any).selector)
      // the raw quote/backslash must be backslash-escaped, never interpolated verbatim
      expect(selector).toContain('\\"')
      expect(selector).toContain('\\\\')
    })

    it('rejects a control-character target with a structured error, never interpolating it', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()

      const result = await adapter.execute({
        type: 'scroll', mode: 'untilVisible', text: `evil${String.fromCharCode(1)}break`, direction: 'down', maxSwipes: 4, retryOpposite: false,
      } as unknown as ExecAction)

      expect(result.success).toBe(false)
      const scrollCall = mockDriver.execute.mock.calls.find(c => c[0] === 'mobile: scroll')
      expect(scrollCall).toBeUndefined()
    })
  })

  describe('Android scroll signals', () => {
    type Primitives = { swipeOnce(direction: string, ref?: string): Promise<string> }
    const primitivesOf = (a: AndroidPlatformAdapter): Promise<Primitives> =>
      (a as unknown as { buildAndroidScrollPrimitives(d: string, m: number): Promise<Primitives> })
        .buildAndroidScrollPrimitives('down', 0)
    const gestureCalls = () => mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: scrollGesture')

    it('swipeOnce maps mobile: scrollGesture true to moved and false to at-boundary', async () => {
      await adapter.setup({ platform: 'android' })
      const ref = await refFor('Sign In')
      scrollGestureReturns = [true, false]
      const p = await primitivesOf(adapter)

      expect(await p.swipeOnce('down')).toBe('moved')
      expect(gestureCalls()).toHaveLength(1)
      // The area keeps to the middle 60% of the swipe axis, clear of the system gesture zones.
      expect(gestureCalls()[0][1]).toEqual({ left: 0, top: 384, width: 1080, height: 1152, direction: 'down', percent: 0.75 })

      expect(await p.swipeOnce('up', ref)).toBe('at-boundary')
      expect(gestureCalls()).toHaveLength(2)
      expect(gestureCalls()[1][1]).toEqual({ left: 100, top: 550, width: 880, height: 100, direction: 'up', percent: 0.75 })
      // The gesture is the driver's own scroll; no raw pointer swipe is sent beside it.
      expect(mockDriver._pointerAction.perform).not.toHaveBeenCalled()
    })

    it('a swipe never starts in a system gesture zone', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()
      const p = await primitivesOf(adapter)

      await p.swipeOnce('left')
      await p.swipeOnce('up')
      expect(gestureCalls().map(c => c[1])).toEqual([
        { left: 216, top: 0, width: 648, height: 1920, direction: 'left', percent: 0.75 },
        { left: 0, top: 384, width: 1080, height: 1152, direction: 'up', percent: 0.75 },
      ])
    })

    it('the WebView context reports movement from window.scrollY', async () => {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_app.linear'])
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{ role: 'button', name: 'Create issue', bounds: { x: 1, y: 2, width: 3, height: 4 }, state: {}, labels: {}, attributes: {} }],
        viewport: { width: 200, height: 100 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 200, contentHeight: 800 },
        url: 'https://linear.local',
      })
      await adapter.setup({
        platform: 'android',
        device: { name: 'android-emu', platform: 'android', match: { automationName: 'UiAutomator2' } },
        appPackage: 'app.linear',
      } as never)
      await adapter.observe()
      // One document scroller per read: the WebView answers the array of every scroller.
      const offsets = [
        [{ id: 'document', x: 0, y: 0, maxX: 0, maxY: 700 }], [{ id: 'document', x: 0, y: 400, maxX: 0, maxY: 700 }],
        [{ id: 'document', x: 0, y: 700, maxX: 0, maxY: 700 }], [{ id: 'document', x: 0, y: 700, maxX: 0, maxY: 700 }],
        [{ id: 'document', x: 0, y: 300, maxX: 0, maxY: 700 }], [{ id: 'document', x: 0, y: 300, maxX: 0, maxY: 700 }],
      ]
      mockDriver.execute.mockImplementation((command: string) =>
        Promise.resolve(typeof command === 'string' && command.startsWith('mobile:') ? undefined : offsets.shift()))
      const p = await primitivesOf(adapter)

      expect(await p.swipeOnce('down')).toBe('moved')
      expect(await p.swipeOnce('down')).toBe('at-boundary')
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(gestureCalls()).toHaveLength(0)
      expect(mockDriver._pointerAction.perform).toHaveBeenCalledTimes(3)
    })

    it('toEnd stops on the first at-boundary signal', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()
      scrollGestureReturns = [true, true, false, true]

      const result = await adapter.execute({
        type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: false,
      } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(gestureCalls()).toHaveLength(3)
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 3, reversedOnce: false, outcome: 'found', endedBy: 'boundary' })
    })

    it('untilVisible keeps going through an unchanged tree while scrollGesture says it can scroll', async () => {
      await adapter.setup({ platform: 'android' })
      await adapter.observe()
      scrollGestureReturns = [true]

      const result = await adapter.execute({
        type: 'scroll', mode: 'untilVisible', text: 'Not on this screen', direction: 'down', maxSwipes: 4, retryOpposite: false,
      } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(gestureCalls().map(c => (c[1] as { direction: string }).direction)).toEqual(['down', 'down', 'down', 'down'])
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 4, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
    })
  })

  describe('a WebView touch swipe is judged over every WebView scroller', () => {
    type Primitives = { swipeOnce(direction: string, ref?: string): Promise<string> }
    type Member = { id: string; x: number; y: number; maxX: number; maxY: number }
    // Members carry an identity; the document scroller is always `document`.
    const doc = (y: number, maxY: number, x = 0, maxX = 0): Member => ({ id: 'document', x, y, maxX, maxY })
    const el = (id: string, y: number, maxY: number, x = 0, maxX = 0): Member => ({ id, x, y, maxX, maxY })
    const LIST = '0/1/0|div#list.feed'
    const A = '0/1/2|div#a.'
    const B = '0/1/3|div#b.'

    // A WebView session whose scroller read answers `reads` in order, one per read (before, after).
    async function webView(reads: unknown[]): Promise<Primitives> {
      mockDriver.getContexts.mockResolvedValue(['NATIVE_APP', 'WEBVIEW_app.linear'])
      mockDriver.execute.mockResolvedValueOnce({
        nodes: [{ role: 'button', name: 'Create issue', bounds: { x: 1, y: 2, width: 3, height: 4 }, state: {}, labels: {}, attributes: {} }],
        viewport: { width: 200, height: 100 },
        scroll: { offsetX: 0, offsetY: 0, contentWidth: 200, contentHeight: 800 },
        url: 'https://linear.local',
      })
      await adapter.setup({
        platform: 'android',
        device: { name: 'android-emu', platform: 'android', match: { automationName: 'UiAutomator2' } },
        appPackage: 'app.linear',
      } as never)
      await adapter.observe()
      const queue = [...reads]
      mockDriver.execute.mockImplementation((command: string) =>
        Promise.resolve(typeof command === 'string' && command.startsWith('mobile:') ? undefined : queue.shift()))
      return (adapter as unknown as { buildAndroidScrollPrimitives(d: string, m: number): Promise<Primitives> })
        .buildAndroidScrollPrimitives('down', 0)
    }

    it('a moving nested WebView scroller is moved, never a boundary', async () => {
      // The document is at its end; the nested list the finger landed on moved.
      const p = await webView([[doc(700, 700), el(LIST, 0, 1200)], [doc(700, 700), el(LIST, 600, 1200)]])
      expect(await p.swipeOnce('down')).toBe('moved')
      expect(mockDriver._pointerAction.perform).toHaveBeenCalledTimes(1)
      expect(mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: scrollGesture')).toHaveLength(0)
    })

    it('a boundary needs every WebView scroller at its extent', async () => {
      const p = await webView([
        [doc(700, 700), el(LIST, 1200, 1200)], [doc(700, 700), el(LIST, 1200, 1200)],
        [doc(700, 700), el(LIST, 300, 1200)], [doc(700, 700), el(LIST, 300, 1200)],
      ])
      expect(await p.swipeOnce('down')).toBe('at-boundary')
      // The document at its end with a nested scroller short of its end.
      expect(await p.swipeOnce('down')).toBe('unknown')
    })

    it('a WebView with no scroll range is unknown', async () => {
      const p = await webView([
        [doc(0, 0)], [doc(0, 0)],
        [doc(0, 0), el(LIST, 0, 0, 0, 500)], [doc(0, 0), el(LIST, 0, 0, 0, 500)],
      ])
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(await p.swipeOnce('down')).toBe('unknown')
    })

    it('a changed scroller count is unknown', async () => {
      const p = await webView([
        [doc(700, 700), el(LIST, 1200, 1200)], [doc(700, 700)],
        doc(700, 700), doc(700, 700),
        [doc(700, 700), { id: LIST, x: 0, y: 'end', maxX: 0, maxY: 1200 }], [doc(700, 700), { id: LIST, x: 0, y: 'end', maxX: 0, maxY: 1200 }],
      ])
      expect(await p.swipeOnce('down')).toBe('unknown')
      // A malformed answer (not an array, or a member without numeric offsets) proves nothing either.
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(await p.swipeOnce('down')).toBe('unknown')
    })

    it('a WebView with a frame on screen reads unknown', async () => {
      // The shared script answers null when a frame intersects the viewport.
      const p = await webView([null, null])
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(mockDriver._pointerAction.perform).toHaveBeenCalledTimes(1)
      expect(mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: scrollGesture')).toHaveLength(0)
      expect(mockDriver.execute.mock.calls.filter(c => c[0] === WEBVIEW_SCROLLERS_SCRIPT)).toHaveLength(2)
    })

    it('members are paired by identity, not position', async () => {
      // Index pairing compares `a` with `b` and reads at-boundary.
      const p = await webView([[doc(700, 700), el(A, 1200, 1200)], [doc(700, 700), el(B, 1200, 1200)]])
      expect(await p.swipeOnce('down')).toBe('unknown')
    })

    it('a changed membership with a common member moving reads moved', async () => {
      const p = await webView([[doc(0, 700), el(A, 0, 1200)], [doc(300, 700), el(B, 0, 1200)]])
      expect(await p.swipeOnce('down')).toBe('moved')
    })

    it('a same-count reorder is judged per member', async () => {
      // Index pairing compares `a` (1200) with `b` (0) and reads moved; per member nothing moved
      // and `b` is short of its extent.
      const p = await webView([
        [doc(700, 700), el(A, 1200, 1200), el(B, 0, 1200)],
        [doc(700, 700), el(B, 0, 1200), el(A, 1200, 1200)],
      ])
      expect(await p.swipeOnce('down')).toBe('unknown')
    })

    it('duplicate, missing or malformed ids read unknown', async () => {
      const p = await webView([
        [doc(700, 700), el(A, 1200, 1200), el(A, 1200, 1200)], [doc(700, 700), el(A, 1200, 1200), el(A, 1200, 1200)],
        [doc(700, 700), { x: 0, y: 1200, maxX: 0, maxY: 1200 }], [doc(700, 700), { x: 0, y: 1200, maxX: 0, maxY: 1200 }],
        [doc(700, 700), { id: A, x: 0, y: '1200', maxX: 0, maxY: 1200 }], [doc(700, 700), { id: A, x: 0, y: '1200', maxX: 0, maxY: 1200 }],
      ])
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(await p.swipeOnce('down')).toBe('unknown')
      expect(await p.swipeOnce('down')).toBe('unknown')
    })
  })

  describe('openApp resolution', () => {
    it('enumerates via mobile: listApps exactly ONCE across two consecutive resolutions (session cache)', async () => {
      listAppsReturn = { 'com.google.android.calendar': {}, 'com.android.settings': {} }
      await adapter.setup({ platform: 'android' })
      calls.length = 0

      await adapter.execute({ type: 'openApp', appName: 'calendar' } as unknown as ExecAction)
      await adapter.execute({ type: 'openApp', appName: 'settings' } as unknown as ExecAction)

      const listCount = mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: listApps').length
      expect(listCount).toBe(1)
    })

    it('re-enumerates exactly once on a resolution MISS before erroring', async () => {
      listAppsReturn = { 'com.android.settings': {} }
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({ type: 'openApp', appName: 'nonexistent-app-xyz' } as unknown as ExecAction)

      expect(result.success).toBe(false)
      const listCount = mockDriver.execute.mock.calls.filter(c => c[0] === 'mobile: listApps').length
      expect(listCount).toBe(2)
    })

    it('launches a resolved app via activateApp(resolvedId) with openApp metadata', async () => {
      listAppsReturn = { 'com.google.android.calendar': {} }
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({ type: 'openApp', appName: 'calendar' } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(mockDriver.activateApp).toHaveBeenCalledWith('com.google.android.calendar')
      expect(result.metadata?.openApp).toMatchObject({ resolvedId: 'com.google.android.calendar' })
    })

    it('listApps throwing with the shell env gate unset ⇒ structured error recommending bundleId, no crash', async () => {
      listAppsThrows = true
      const previous = process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL
      delete process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL
      await adapter.setup({ platform: 'android' })

      let result
      try {
        result = await adapter.execute({ type: 'openApp', appName: 'calendar' } as unknown as ExecAction)
      } finally {
        if (previous !== undefined) process.env.AGENT_QA_ANDROID_USE_MOBILE_SHELL = previous
      }

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/bundleId/i)
    })

    it('explicit {bundleId} variant skips fuzzy matching but errors when the id is not in the registry', async () => {
      listAppsReturn = { 'com.android.settings': {} }
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({ type: 'openApp', bundleId: 'com.not.installed' } as unknown as ExecAction)

      expect(result.success).toBe(false)
      // structured registry-validation error names the offending bundle id (not a generic throw)
      expect(result.error).toContain('com.not.installed')
      expect(mockDriver.activateApp).not.toHaveBeenCalledWith('com.not.installed')
    })

    it('unknown appName errors while naming candidate ids (top-3)', async () => {
      listAppsReturn = {
        'com.google.android.calendar': {},
        'com.android.settings': {},
        'com.android.chrome': {},
      }
      await adapter.setup({ platform: 'android' })

      const result = await adapter.execute({ type: 'openApp', appName: 'zzzzz-unknown' } as unknown as ExecAction)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/com\.(google\.android\.calendar|android\.settings|android\.chrome)/)
    })
  })
})
