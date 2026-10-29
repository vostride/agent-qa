import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'
import { buildScrollPrimitives, runWebScrollCompound } from '../compound-web.js'
import type { RefMap } from '../types.js'

// Ordered call log shared across the mock so ordering pins survive implementation
// detail (which method, in what order, how many times).
let calls: string[] = []
let inputValueReturn: string
let inputValueThrows: boolean
let typeAttrReturn: string | null
let evaluateReturn: unknown

function makeLocator() {
  return {
    fill: vi.fn().mockImplementation((t: string) => { calls.push(`fill:${t}`); return Promise.resolve() }),
    click: vi.fn().mockImplementation(() => { calls.push('click'); return Promise.resolve() }),
    press: vi.fn().mockImplementation((k: string) => { calls.push(`press:${k}`); return Promise.resolve() }),
    pressSequentially: vi.fn().mockImplementation((t: string) => { calls.push(`pressSeq:${t}`); return Promise.resolve() }),
    inputValue: vi.fn().mockImplementation(() => {
      calls.push('inputValue')
      if (inputValueThrows) return Promise.reject(new Error("Node is not an <input>, <textarea> or <select> element"))
      return Promise.resolve(inputValueReturn)
    }),
    getAttribute: vi.fn().mockImplementation((name: string) => {
      calls.push(`getAttr:${name}`)
      return Promise.resolve(name === 'type' ? typeAttrReturn : null)
    }),
    boundingBox: vi.fn().mockResolvedValue({ x: 50, y: 100, width: 200, height: 40 }),
    evaluate: vi.fn().mockImplementation(() => { calls.push('evaluate'); return Promise.resolve(evaluateReturn) }),
    scrollIntoViewIfNeeded: vi.fn().mockImplementation(() => { calls.push('scrollIntoViewIfNeeded'); return Promise.resolve() }),
    nth: vi.fn().mockReturnThis(),
    first: vi.fn().mockReturnThis(),
    focus: vi.fn().mockImplementation(() => { calls.push('focus'); return Promise.resolve() }),
    selectOption: vi.fn().mockResolvedValue(undefined),
  }
}

let locator: ReturnType<typeof makeLocator>

// `:root` serves the ai snapshot the binding check reads; any other selector is the element.
const rootLocator = { ariaSnapshot: vi.fn().mockResolvedValue('- textbox "Email" [ref=e1]') }

const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  mouse: {
    move: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockImplementation(() => { calls.push('wheel'); return Promise.resolve() }),
    click: vi.fn().mockResolvedValue(undefined),
  },
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  waitForURL: vi.fn().mockResolvedValue(undefined),
  bringToFront: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  video: vi.fn().mockReturnValue(null),
  evaluateHandle: vi.fn().mockImplementation(async () => ({
    evaluate: vi.fn().mockResolvedValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
  locator: vi.fn((selector: string) => (selector === ':root' ? rootLocator : locator)),
  on: vi.fn(),
  url: vi.fn().mockReturnValue('https://example.com'),
  title: vi.fn().mockResolvedValue('Example Page'),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  getByText: vi.fn().mockImplementation((t: string) => { calls.push(`getByText:${t}`); return locator }),
}

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  pages: vi.fn().mockReturnValue([mockPage]),
  addInitScript: vi.fn().mockResolvedValue(undefined),
  grantPermissions: vi.fn().mockResolvedValue(undefined),
  exposeBinding: vi.fn().mockResolvedValue(undefined),
  setDefaultNavigationTimeout: vi.fn(),
  on: vi.fn(),
}

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
}

vi.mock('playwright-core', () => ({
  chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  firefox: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  webkit: { launch: vi.fn().mockResolvedValue(mockBrowser) },
}))

type ExecAction = Parameters<WebPlatformAdapter['execute']>[0]

async function setupWithEmailField(adapter: WebPlatformAdapter): Promise<string> {
  await adapter.setup({ platform: 'web' })
  const state = await adapter.observe()
  const el = state.elements.find(e => e.name === 'Email')
  if (!el) throw new Error('test fixture: Email textbox not observed')
  return el.ref
}

describe('WebPlatformAdapter compound behaviors (RED — Wave-0)', () => {
  let adapter: WebPlatformAdapter

  beforeEach(() => {
    adapter = new WebPlatformAdapter()
    calls = []
    inputValueReturn = ''
    inputValueThrows = false
    typeAttrReturn = 'text'
    evaluateReturn = undefined
    locator = makeLocator()
    vi.clearAllMocks()
  })

  describe('fill compound', () => {
    it('replace mode re-reads via inputValue() AFTER fill, and only presses Enter after the re-read when submit is true', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = 'hello'

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: true } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(locator.inputValue).toHaveBeenCalled()
      // Enter is pressed only after the re-read.
      expect(locator.press).toHaveBeenCalledWith('Enter')
      const readIdx = calls.indexOf('inputValue')
      const enterIdx = calls.lastIndexOf('press:Enter')
      expect(enterIdx).toBeGreaterThan(readIdx)
    })

    it('replace mode with submit=false does NOT press Enter', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = 'hello'

      await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(locator.inputValue).toHaveBeenCalled()
      expect(calls).not.toContain('press:Enter')
    })

    it('append mode captures prior value FIRST, then click + End + pressSequentially; expected = prior + typed', async () => {
      const ref = await setupWithEmailField(adapter)
      // prior read returns 'abc'; after typing the field reads 'abcXYZ'
      inputValueReturn = 'abc'
      let firstRead = true
      locator.inputValue.mockImplementation(() => {
        calls.push('inputValue')
        const v = firstRead ? 'abc' : 'abcXYZ'
        firstRead = false
        return Promise.resolve(v)
      })

      const result = await adapter.execute({ type: 'fill', ref, text: 'XYZ', clearMode: 'append', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(calls[0]).toBe('inputValue')
      expect(locator.pressSequentially).toHaveBeenCalledWith('XYZ')
      expect(locator.press).toHaveBeenCalledWith('End')
      expect(result.metadata?.fillReread).toMatchObject({ expected: 'abcXYZ', actual: 'abcXYZ' })
    })

    it('mismatch yields success:false + §7.1 error + fillReread meta, with NO internal retry', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = 'wrong'

      const result = await adapter.execute({ type: 'fill', ref, text: 'intended', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/reads .* after typing .* re-observe and retry/i)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'intended', actual: 'wrong' },
        fillVerdict: { verb: 'fill', verdict: 'mismatch' },
      })
      expect(locator.fill).toHaveBeenCalledTimes(1)
    })

    it('secure field (type=password) verdicts on non-emptiness and never records the raw value', async () => {
      const ref = await setupWithEmailField(adapter)
      typeAttrReturn = 'password'
      inputValueReturn = 'sup3rSecret'

      const result = await adapter.execute({ type: 'fill', ref, text: 'sup3rSecret', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(true)
      // sentinel metadata present, but the raw secret is absent from the serialized result
      expect(result.metadata?.fillReread).toBeDefined()
      expect(JSON.stringify(result)).not.toContain('sup3rSecret')
    })

    it('inputValue throwing on a non-input element attempts an evaluate fallback; unreadable value ⇒ success with NO fillReread key (signal-presence law)', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueThrows = true
      evaluateReturn = undefined // nothing readable via the fallback either

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: false } as unknown as ExecAction)

      // fallback read attempted rather than crashing
      expect(locator.evaluate).toHaveBeenCalled()
      // never fabricate a re-read pair when nothing is readable
      expect(result.success).toBe(true)
      expect(result.metadata?.fillReread).toBeUndefined()
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified' })
    })
  })

  describe('fill re-read verdicts on web', () => {
    it('a re-read with formatting separators records normalized and presses Enter when submit is set', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = '+1 392-074-1751'

      const result = await adapter.execute({ type: 'fill', ref, text: '+13920741751', clearMode: 'replace', submit: true } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.metadata).toEqual({
        fillReread: { expected: '+13920741751', actual: '+1 392-074-1751' },
        fillVerdict: { verb: 'fill', verdict: 'normalized' },
      })
      expect(calls.filter(c => c === 'press:Enter')).toHaveLength(1)
    })

    it('a re-read with merged whitespace records mismatch, returns the error and never presses Enter', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = 'foo  bar'

      const result = await adapter.execute({ type: 'fill', ref, text: 'foo bar', clearMode: 'replace', submit: true } as unknown as ExecAction)

      expect(result.success).toBe(false)
      expect(result.error).toBe('field reads "foo  bar" after typing "foo bar" — re-observe and retry')
      expect(result.metadata).toEqual({
        fillReread: { expected: 'foo bar', actual: 'foo  bar' },
        fillVerdict: { verb: 'fill', verdict: 'mismatch' },
      })
      expect(calls).not.toContain('press:Enter')
    })

    it('an unreadable value keeps the early return (success, no Enter) and records unverified', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueThrows = true
      evaluateReturn = undefined

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: true } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.metadata).toEqual({ fillVerdict: { verb: 'fill', verdict: 'unverified' } })
      expect(calls).not.toContain('press:Enter')
    })

    it('an exact re-read records exact beside fillReread', async () => {
      const ref = await setupWithEmailField(adapter)
      inputValueReturn = 'hello'

      const result = await adapter.execute({ type: 'fill', ref, text: 'hello', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.metadata).toEqual({
        fillReread: { expected: 'hello', actual: 'hello' },
        fillVerdict: { verb: 'fill', verdict: 'exact' },
      })
    })

    it('a password field records unverified with secure true and never the raw value', async () => {
      const ref = await setupWithEmailField(adapter)
      typeAttrReturn = 'password'
      inputValueReturn = 'sup3rSecret'

      const result = await adapter.execute({ type: 'fill', ref, text: 'sup3rSecret', clearMode: 'replace', submit: false } as unknown as ExecAction)

      expect(result.success).toBe(true)
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', secure: true })
      expect(JSON.stringify(result)).not.toContain('sup3rSecret')
    })
  })

  describe('scroll untilVisible', () => {
    it('runs a native getByText scrollIntoView rung FIRST and records scrollUntilVisible metadata', async () => {
      await adapter.setup({ platform: 'web' })
      await adapter.observe()

      const result = await adapter.execute({
        type: 'scroll', mode: 'untilVisible', text: 'Load more', direction: 'down', maxSwipes: 3, retryOpposite: true,
      } as unknown as ExecAction)

      expect(result.success).toBe(true)
      // native search-scroll preferred before blind wheel scrolling (§12.12)
      expect(mockPage.getByText).toHaveBeenCalledWith('Load more')
      const nativeIdx = calls.findIndex(c => c.startsWith('getByText:'))
      const wheelIdx = calls.indexOf('wheel')
      if (wheelIdx !== -1) expect(nativeIdx).toBeLessThan(wheelIdx)
      expect(result.metadata?.scrollUntilVisible).toBeDefined()
    })
  })

  describe('scroll movement signals', () => {
    type Offsets = { x: number; y: number; maxX: number; maxY: number }

    // A page whose evaluate answers the settle string, whose evaluateHandle answers the no-ref
    // wheel's scroller snapshot (the handle's evaluate returns the pointer chain, here the document
    // scroller alone: one `doc` entry before the wheel, the next after), and whose aria-ref
    // locator answers scrollWithRef: the container ref resolves through ElementResolver, then
    // count() and evaluate(fn, [dx, dy, axis]).
    function signalPage(opts: { doc?: Offsets[]; container?: unknown[]; count?: number }) {
      const docReads = [...(opts.doc ?? [])]
      const containerResults = [...(opts.container ?? [])]
      const log: string[] = []
      const handle = (before: Offsets | undefined) => ({
        evaluate: vi.fn(async () => {
          log.push('chain')
          const after = docReads.shift()
          return before && after ? { before: [before], after: [after] } : undefined
        }),
        dispose: vi.fn(async () => undefined),
      })
      const container = {
        nth: vi.fn(() => container),
        count: vi.fn(async () => opts.count ?? 1),
        evaluate: vi.fn(async (_fn: unknown, _arg?: unknown) => {
          log.push('scrollWithRef')
          return containerResults.shift()
        }),
      }
      const page = {
        evaluate: vi.fn(async (fn: unknown) => {
          if (typeof fn === 'string') return 'raf'
          return undefined
        }),
        evaluateHandle: vi.fn(async (_fn: unknown, axis: unknown) => {
          log.push(`snapshot:${String(axis)}`)
          return handle(docReads.shift())
        }),
        mouse: { wheel: vi.fn(async (dx: number, dy: number) => { log.push(`wheel:${dx},${dy}`) }) },
        viewportSize: () => ({ width: 1280, height: 720 }),
        getByText: vi.fn(() => ({ first: () => ({ scrollIntoViewIfNeeded: vi.fn().mockRejectedValue(new Error('not found')) }) })),
        locator: vi.fn((selector: string) => selector.startsWith('aria-ref=')
          ? container
          : { ariaSnapshot: vi.fn().mockResolvedValue('- text "Row A"') }),
      }
      return { page, log, container }
    }

    const refs: RefMap = { e7: { nativeRef: 'e12', role: 'list', name: 'Results' } }
    const container = (before: number, after: number, max: number) => ({
      bounds: null,
      scrolledContainer: 'element',
      scrolled: before !== after,
      offsets: { before, after, max },
    })

    it('swipeOnce reports moved when scrollTop changes, at-boundary at the scroll extent, unknown otherwise', async () => {
      const noOffsets = { bounds: null, scrolledContainer: 'documentElement', scrolled: false }
      const { page, log, container: located } = signalPage({
        container: [container(0, 720, 2000), container(2000, 2000, 2000), container(300, 300, 2000), noOffsets, undefined],
      })
      const p = buildScrollPrimitives(page as never, refs, 720)
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('moved')
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('at-boundary')
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('unknown')
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('unknown')
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('unknown')
      expect(log).toEqual(['scrollWithRef', 'scrollWithRef', 'scrollWithRef', 'scrollWithRef', 'scrollWithRef'])
      // The container is the observed element's aria-ref locator, never a position, and the swipe
      // runs inside that element.
      expect(page.locator).toHaveBeenCalledWith('aria-ref=e12')
      expect(located.nth).not.toHaveBeenCalled()
      expect(located.evaluate.mock.calls[0][1]).toEqual([0, 720, 'vertical'])
      expect(page.mouse.wheel).not.toHaveBeenCalled()
    })

    it('a container ref that does not resolve performs no gesture and reports unknown', async () => {
      const gone = signalPage({ container: [container(0, 720, 2000)], count: 0 })
      const p = buildScrollPrimitives(gone.page as never, refs, 720)
      expect(await p.swipeOnce('down', 'e7' as never)).toBe('unknown')
      expect(gone.container.evaluate).not.toHaveBeenCalled()

      const unknownRef = signalPage({ container: [container(0, 720, 2000)] })
      const q = buildScrollPrimitives(unknownRef.page as never, refs, 720)
      expect(await q.swipeOnce('down', 'e99' as never)).toBe('unknown')
      expect(unknownRef.container.evaluate).not.toHaveBeenCalled()

      for (const { page, log } of [gone, unknownRef]) {
        expect(page.mouse.wheel).not.toHaveBeenCalled()
        expect(page.evaluateHandle).not.toHaveBeenCalled()
      }
    })

    it('the no-ref wheel path reads document.scrollingElement before and after', async () => {
      const { page, log } = signalPage({
        doc: [
          { x: 0, y: 0, maxX: 0, maxY: 3000 }, { x: 0, y: 720, maxX: 0, maxY: 3000 },
          { x: 0, y: 3000, maxX: 0, maxY: 3000 }, { x: 0, y: 3000, maxX: 0, maxY: 3000 },
          { x: 0, y: 500, maxX: 0, maxY: 3000 }, { x: 0, y: 500, maxX: 0, maxY: 3000 },
          { x: 0, y: 0, maxX: 0, maxY: 0 }, { x: 0, y: 0, maxX: 0, maxY: 0 },
        ],
      })
      const p = buildScrollPrimitives(page as never, {} as RefMap, 720)
      expect(await p.swipeOnce('down')).toBe('moved')
      expect(await p.swipeOnce('down')).toBe('at-boundary')
      expect(await p.swipeOnce('down')).toBe('unknown')
      // A document with no scroll range proves nothing: the wheel may have moved a nested scroller.
      expect(await p.swipeOnce('down')).toBe('unknown')
      // The scrollers are snapshotted before the wheel and the chain is read after it.
      expect(log.slice(0, 3)).toEqual(['snapshot:vertical', 'wheel:0,720', 'chain'])
      // No snapshot, or no observed wheel event, proves nothing.
      const blind = signalPage({ doc: [] })
      blind.page.evaluateHandle.mockRejectedValueOnce(new Error('navigated'))
      const q = buildScrollPrimitives(blind.page as never, {} as RefMap, 720)
      expect(await q.swipeOnce('down')).toBe('unknown')
      expect(await q.swipeOnce('down')).toBe('unknown')
      expect(blind.page.mouse.wheel).toHaveBeenCalledTimes(2)
    })

    it('toEnd stops on the first at-boundary offset and reports found by boundary', async () => {
      const { page } = signalPage({
        doc: [
          { x: 0, y: 0, maxX: 0, maxY: 1440 }, { x: 0, y: 720, maxX: 0, maxY: 1440 },
          { x: 0, y: 720, maxX: 0, maxY: 1440 }, { x: 0, y: 1440, maxX: 0, maxY: 1440 },
          { x: 0, y: 1440, maxX: 0, maxY: 1440 }, { x: 0, y: 1440, maxX: 0, maxY: 1440 },
        ],
      })
      const result = await runWebScrollCompound(page as never, {} as RefMap, {
        type: 'scroll', mode: 'direction', direction: 'down', amount: 'toEnd', retryOpposite: true,
      } as never)
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 3, reversedOnce: false, outcome: 'found', endedBy: 'boundary' })
      expect(page.mouse.wheel).toHaveBeenCalledTimes(3)
    })

    it('direction mode is one wheel gesture even with retryOpposite and an unknown signal', async () => {
      const { page } = signalPage({ doc: [] })
      const result = await runWebScrollCompound(page as never, {} as RefMap, {
        type: 'scroll', mode: 'direction', direction: 'down', amount: 'page', retryOpposite: true,
      } as never)
      expect(page.mouse.wheel).toHaveBeenCalledTimes(1)
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 1, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
    })

    it('a same-hash untilVisible scroll with moving offsets keeps going forward and stays unresolved', async () => {
      const doc: Offsets[] = []
      for (let i = 0; i < 3; i += 1) doc.push({ x: 0, y: i * 100, maxX: 0, maxY: 5000 }, { x: 0, y: (i + 1) * 100, maxX: 0, maxY: 5000 })
      const { page } = signalPage({ doc })
      const result = await runWebScrollCompound(page as never, {} as RefMap, {
        type: 'scroll', mode: 'untilVisible', text: 'Footer link', direction: 'down', maxSwipes: 3, retryOpposite: false,
      } as never)
      expect(page.mouse.wheel.mock.calls).toEqual([[0, 720], [0, 720], [0, 720]])
      expect(result.metadata?.scrollUntilVisible).toEqual({ swipes: 3, reversedOnce: false, outcome: 'unresolved', endedBy: 'max-swipes' })
    })
  })

  describe('openApp on web', () => {
    it('returns a structured error naming navigate(url) and never navigates the page', async () => {
      await adapter.setup({ platform: 'web' })
      mockPage.goto.mockClear()

      const result = await adapter.execute({ type: 'openApp', appName: 'Gmail' } as unknown as ExecAction)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/navigate/i)
      expect(mockPage.goto).not.toHaveBeenCalled()
    })
  })
})
