import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// An observed iOS screen drives fill and clearText through a call-logging mocked driver.

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735a1b0f2d'

type Rect = { x: number; y: number; width: number; height: number }

const RECTS: Record<string, Rect> = {
  heading: { x: 20, y: 60, width: 350, height: 30 },
  title: { x: 20, y: 100, width: 350, height: 44 },
  body: { x: 20, y: 160, width: 350, height: 120 },
  terms: { x: 20, y: 300, width: 350, height: 80 },
  send: { x: 20, y: 400, width: 350, height: 50 },
  notes: { x: 20, y: 470, width: 350, height: 120 },
  pin: { x: 20, y: 600, width: 350, height: 44 },
}

function attrs(r: Rect): string {
  return `x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"`
}

const FORM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="Probe" label="Probe" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther x="0" y="0" width="390" height="844">
      <XCUIElementTypeStaticText label="Heading" ${attrs(RECTS.heading)} enabled="true" />
      <XCUIElementTypeTextField label="Title" placeholderValue="Title" ${attrs(RECTS.title)} enabled="true" />
      <XCUIElementTypeTextView label="Body" ${attrs(RECTS.body)} enabled="true" />
      <XCUIElementTypeTextView label="Terms" value="Static terms text" ${attrs(RECTS.terms)} enabled="true" />
      <XCUIElementTypeButton label="Send" ${attrs(RECTS.send)} enabled="true" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const TWO_VIEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="Probe" label="Probe" x="0" y="0" width="390" height="844">
    <XCUIElementTypeTextView label="Body" ${attrs(RECTS.body)} enabled="true" />
    <XCUIElementTypeTextView label="Notes" ${attrs(RECTS.notes)} enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const PICKER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="Probe" label="Probe" x="0" y="0" width="390" height="844">
    <XCUIElementTypePicker label="Month" x="20" y="450" width="350" height="180" enabled="true" />
    <XCUIElementTypeTextView label="Locked" ${attrs(RECTS.body)} enabled="false" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const SECURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="Probe" label="Probe" x="0" y="0" width="390" height="844">
    <XCUIElementTypeTextField label="Title" placeholderValue="Title" ${attrs(RECTS.title)} enabled="true" />
    <XCUIElementTypeSecureTextField label="Pin" ${attrs(RECTS.pin)} enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const SCREENSHOT_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let calls: string[] = []
let lastTap: { x: number; y: number } | undefined

interface MockField {
  elementId: string
  value: string
  placeholder: string | null
  setValue: ReturnType<typeof vi.fn>
  addValue: ReturnType<typeof vi.fn>
  clearValue: ReturnType<typeof vi.fn>
  getAttribute: ReturnType<typeof vi.fn>
}

function createField(id: string, value = '', placeholder: string | null = null): MockField {
  const field: MockField = {
    elementId: id,
    value,
    placeholder,
    setValue: vi.fn().mockImplementation((v: string) => {
      calls.push(`setValue:${id}`)
      field.value = v
      return Promise.resolve()
    }),
    addValue: vi.fn().mockImplementation((v: string) => {
      calls.push(`addValue:${id}`)
      field.value += v
      return Promise.resolve()
    }),
    clearValue: vi.fn().mockImplementation(() => {
      calls.push(`clearValue:${id}`)
      field.value = ''
      return Promise.resolve()
    }),
    getAttribute: vi.fn().mockImplementation((name: string) => {
      calls.push(`getAttr:${id}:${name}`)
      if (name === 'value') return Promise.resolve(field.value === '' ? field.placeholder : field.value)
      if (name === 'placeholderValue') return Promise.resolve(field.placeholder)
      return Promise.resolve(null)
    }),
  }
  return field
}

let fields: Record<string, MockField>
let rects: Record<string, Rect>
let selectorResults: Record<string, MockField[]>
let activeElement: () => Promise<Record<string, string>>

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

function activeByLastTap(): Promise<Record<string, string>> {
  const hit = Object.values(fields).find(f => lastTap && contains(rects[f.elementId], lastTap))
  if (!hit) return Promise.reject(new Error('no such element: no element has keyboard focus'))
  return Promise.resolve({ [W3C_ELEMENT_KEY]: hit.elementId })
}

function createMockDriver(xml: string) {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockImplementation((p: { x: number; y: number }) => {
    calls.push(`tap:${p.x},${p.y}`)
    lastTap = p
    return chain
  })
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.pause = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockResolvedValue(undefined)
  return {
    getPageSource: vi.fn().mockResolvedValue(xml),
    getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(chain),
    keys: vi.fn().mockImplementation((k: unknown) => {
      calls.push(`keys:${JSON.stringify(k)}`)
      return Promise.resolve()
    }),
    pause: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    getContext: vi.fn().mockResolvedValue('NATIVE_APP'),
    switchContext: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue({ isExisting: vi.fn().mockResolvedValue(false) }),
    $$: vi.fn().mockImplementation((selector: string) => {
      calls.push(`$$:${selector}`)
      return Promise.resolve(selectorResults[selector] ?? [])
    }),
    getElementRect: vi.fn().mockImplementation((id: string) => Promise.resolve(rects[id])),
    getActiveElement: vi.fn().mockImplementation(() => activeElement()),
    _pointerAction: chain,
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { IOSPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<IOSPlatformAdapter['execute']>[0]

const TEXT_VIEW = '-ios class chain:**/XCUIElementTypeTextView'
const TEXT_FIELD = '-ios class chain:**/XCUIElementTypeTextField'
const SECURE_FIELD = '-ios class chain:**/XCUIElementTypeSecureTextField'
const FOCUSED_TEXT_VIEW = '-ios class chain:**/XCUIElementTypeTextView[`hasFocus == 1`]'
const SUBMIT_NOTICE = 'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control'

describe('IOSPlatformAdapter text input', () => {
  let adapter: IOSPlatformAdapter
  let mockDriver: ReturnType<typeof createMockDriver>

  async function start(xml = FORM_XML): Promise<void> {
    mockDriver = createMockDriver(xml)
    const { remote } = await import('webdriverio')
    vi.mocked(remote).mockResolvedValue(mockDriver as any)
    adapter = new IOSPlatformAdapter()
    await adapter.setup({ platform: 'ios' })
  }

  async function refFor(name: string): Promise<string> {
    const state = await adapter.observe()
    const el = state.elements.find(e => e.name === name)
    if (!el) throw new Error(`test fixture: element "${name}" not observed`)
    calls.length = 0
    return el.ref
  }

  function clearText(ref: string) {
    return adapter.execute({ type: 'clearText', ref } as unknown as ExecAction)
  }

  function nothingTyped(): void {
    for (const field of Object.values(fields)) {
      expect(field.setValue).not.toHaveBeenCalled()
      expect(field.addValue).not.toHaveBeenCalled()
      expect(field.clearValue).not.toHaveBeenCalled()
    }
    expect(mockDriver.keys).not.toHaveBeenCalled()
  }

  function fill(ref: string, text: string, opts: { clearMode?: 'replace' | 'append'; submit?: boolean } = {}) {
    return adapter.execute({
      type: 'fill',
      ref,
      text,
      clearMode: opts.clearMode ?? 'replace',
      submit: opts.submit ?? false,
    } as unknown as ExecAction)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    calls = []
    lastTap = undefined
    rects = { ...RECTS }
    fields = {
      title: createField('title', '', 'Title'),
      body: createField('body'),
      terms: createField('terms', 'Static terms text'),
    }
    selectorResults = {
      [TEXT_FIELD]: [fields.title],
      [TEXT_VIEW]: [fields.body, fields.terms],
    }
    activeElement = activeByLastTap
  })

  afterEach(() => { vi.restoreAllMocks() })

  describe('fill into an editable text view', () => {
    it('fills a multi-line Unicode value into Body through its own handle after a focus check', async () => {
      await start()
      const ref = await refFor('Body')
      const text = 'Line one ✓\nLine two é'

      const result = await fill(ref, text)

      expect(result.success).toBe(true)
      expect(calls.filter(c => c.startsWith('tap:'))).toEqual(['tap:195,220'])
      expect(mockDriver.getActiveElement).toHaveBeenCalled()
      expect(fields.body.setValue).toHaveBeenCalledTimes(1)
      expect(fields.body.setValue).toHaveBeenCalledWith(text)
      expect(fields.title.setValue).not.toHaveBeenCalled()
      expect(fields.title.addValue).not.toHaveBeenCalled()
      expect(fields.title.clearValue).not.toHaveBeenCalled()
      expect(fields.terms.setValue).not.toHaveBeenCalled()
      const typeIdx = calls.indexOf('setValue:body')
      const readIdx = calls.lastIndexOf('getAttr:body:value')
      expect(readIdx).toBeGreaterThan(typeIdx)
      expect(result.metadata?.fillReread).toEqual({ expected: text, actual: text })
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact' })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    it('identifies the target by observed bounds, not by the first element of its type', async () => {
      fields = { body: createField('body'), notes: createField('notes') }
      selectorResults = { [TEXT_VIEW]: [fields.notes, fields.body] }
      await start(TWO_VIEWS_XML)
      const ref = await refFor('Notes')

      const result = await fill(ref, 'note text')

      expect(result.success).toBe(true)
      expect(fields.notes.setValue).toHaveBeenCalledWith('note text')
      expect(fields.body.setValue).not.toHaveBeenCalled()
      expect(fields.body.value).toBe('')
    })

    it('appends to Body with the prior value read first', async () => {
      fields.body.value = 'first'
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, '\nsecond', { clearMode: 'append' })

      expect(result.success).toBe(true)
      expect(fields.body.addValue).toHaveBeenCalledWith('\nsecond')
      expect(result.metadata?.fillReread).toEqual({ expected: 'first\nsecond', actual: 'first\nsecond' })
    })
  })

  describe('typed refusals', () => {
    it('refuses fill and clearText on a static text without an editable signal, before any tap or lookup', async () => {
      await start()
      const ref = await refFor('Heading')

      for (const [verb, run] of [['fill', () => fill(ref, 'typed words')], ['clearText', () => clearText(ref)]] as const) {
        const result = await run()
        expect(result.success).toBe(false)
        expect(result.error).toContain('not editable')
        expect(result.error).not.toContain('typed words')
        expect(result.metadata?.fillRefusal).toEqual({ verb, cause: 'not-editable', evidence: 'no-editable-signal' })
      }
      expect(mockDriver.action).not.toHaveBeenCalled()
      expect(mockDriver.$$).not.toHaveBeenCalled()
      nothingTyped()
    })

    it('refuses a picker (pointing at nativeSelect) and a disabled text view the same way', async () => {
      await start(PICKER_XML)
      const state = await adapter.observe()
      const month = state.elements.find(e => e.name === 'Month')!
      const locked = state.elements.find(e => e.name === 'Locked')!
      expect(month.role).toBe('combobox')

      const picker = await fill(month.ref, 'March')
      expect(picker.success).toBe(false)
      expect(picker.error).toContain('not editable')
      expect(picker.error).toContain('nativeSelect')
      expect(picker.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'no-editable-signal' })

      const disabled = await fill(locked.ref, 'text')
      expect(disabled.success).toBe(false)
      expect(disabled.error).toContain('not editable')
      expect(disabled.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'no-editable-signal' })
      expect(mockDriver.action).not.toHaveBeenCalled()
      nothingTyped()
    })

    it('refuses with focus-elsewhere and types nowhere when focus stays on another field', async () => {
      activeElement = () => Promise.resolve({ [W3C_ELEMENT_KEY]: 'title' })
      await start()
      const ref = await refFor('Terms')

      const result = await fill(ref, 'redirected text')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not editable')
      expect(result.error).toContain('after tapping it, keyboard focus is on another element.')
      expect(result.error).toContain('Input is never sent to an element other than the target')
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'focus-elsewhere' })
      expect(JSON.stringify(result)).not.toContain('redirected text')
      expect(calls.filter(c => c.startsWith('tap:'))).toEqual(['tap:195,340'])
      nothingTyped()
      expect(fields.title.value).toBe('')
      expect(fields.terms.value).toBe('Static terms text')
    })

    it('refuses with no-keyboard-focus after at most three polls when nothing reports focus', async () => {
      activeElement = () => Promise.reject(new Error('no such element'))
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, 'lost text')

      expect(result.success).toBe(false)
      expect(result.error).toContain('did not take keyboard focus')
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'no-keyboard-focus' })
      expect(mockDriver.getActiveElement.mock.calls.length).toBeLessThanOrEqual(3)
      expect(mockDriver.pause.mock.calls.length).toBeLessThanOrEqual(2)
      expect(calls).toContain(`$$:${FOCUSED_TEXT_VIEW}`)
      nothingTyped()
    })

    it('accepts focus from the hasFocus class chain over text views when no active element is reported', async () => {
      activeElement = () => Promise.reject(new Error('no such element'))
      selectorResults[FOCUSED_TEXT_VIEW] = [fields.body]
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, 'via hasFocus')

      expect(result.success).toBe(true)
      expect(fields.body.setValue).toHaveBeenCalledWith('via hasFocus')
      expect(fields.title.setValue).not.toHaveBeenCalled()
    })

    it('refuses a stale target whose observed bounds no longer match, without tapping', async () => {
      await start()
      const ref = await refFor('Body')
      rects.body = { ...RECTS.body, y: RECTS.body.y + 40 }

      const result = await fill(ref, 'late text')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found at its observed position')
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'target-not-found', evidence: 'stale-target' })
      expect(mockDriver.action).not.toHaveBeenCalled()
      nothingTyped()
    })

    it('keeps the typed secret out of a refused secure-field result', async () => {
      fields = { title: createField('title', '', 'Title'), pin: createField('pin') }
      selectorResults = { [TEXT_FIELD]: [fields.title], [SECURE_FIELD]: [fields.pin] }
      activeElement = () => Promise.resolve({ [W3C_ELEMENT_KEY]: 'title' })
      await start(SECURE_XML)
      const ref = await refFor('Pin')

      const result = await fill(ref, 'S3cretPw!')

      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'focus-elsewhere' })
      expect(JSON.stringify(result)).not.toContain('S3cretPw!')
      nothingTyped()
    })
  })

  describe('clearText', () => {
    it('clears only the target and verifies it is empty', async () => {
      fields.body.value = 'old body'
      fields.title.value = 'kept title'
      await start()
      const ref = await refFor('Body')

      const result = await clearText(ref)

      expect(result.success).toBe(true)
      expect(result.coordinates).toEqual({ x: 195, y: 220 })
      expect(fields.body.clearValue).toHaveBeenCalledTimes(1)
      expect(fields.title.clearValue).not.toHaveBeenCalled()
      expect(fields.terms.clearValue).not.toHaveBeenCalled()
      expect(fields.title.value).toBe('kept title')
      expect(calls.lastIndexOf('getAttr:body:value')).toBeGreaterThan(calls.indexOf('clearValue:body'))
    })

    it('treats a re-read equal to the empty-field hint text as empty', async () => {
      fields.title.value = 'draft'
      await start()
      const ref = await refFor('Title')

      const result = await clearText(ref)

      expect(result.success).toBe(true)
      expect(fields.title.clearValue).toHaveBeenCalledTimes(1)
    })

    it('fails when text remains after clearing', async () => {
      fields.body.value = 'stubborn'
      fields.body.clearValue.mockImplementation(() => Promise.resolve())
      await start()
      const ref = await refFor('Body')

      const result = await clearText(ref)

      expect(result.success).toBe(false)
      expect(result.error).toContain('still has text after clearing')
      expect(result.error).not.toContain('stubborn')
    })

    it('reports only the remaining length for a secure field', async () => {
      fields = { title: createField('title', '', 'Title'), pin: createField('pin', 'hunter22') }
      fields.pin.clearValue.mockImplementation(() => Promise.resolve())
      selectorResults = { [TEXT_FIELD]: [fields.title], [SECURE_FIELD]: [fields.pin] }
      await start(SECURE_XML)
      const ref = await refFor('Pin')

      const result = await clearText(ref)

      expect(result.success).toBe(false)
      expect(result.error).toContain('8 characters')
      expect(JSON.stringify(result)).not.toContain('hunter22')
    })

    it('refuses with focus-elsewhere and clears nothing', async () => {
      fields.title.value = 'kept title'
      activeElement = () => Promise.resolve({ [W3C_ELEMENT_KEY]: 'title' })
      await start()
      const ref = await refFor('Terms')

      const result = await clearText(ref)

      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'clearText', cause: 'not-editable', evidence: 'focus-elsewhere' })
      nothingTyped()
      expect(fields.title.value).toBe('kept title')
    })
  })

  describe('submit and append', () => {
    it('never presses Return in a text view and records the multi-line outcome', async () => {
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, 'message', { submit: true })

      expect(result.success).toBe(true)
      expect(mockDriver.keys).not.toHaveBeenCalled()
      expect(result.metadata?.fillSubmit).toEqual({ sent: false, reason: 'multi-line-field' })
      expect(result.data).toBe(SUBMIT_NOTICE)
      expect(fields.body.value).toBe('message')
    })

    it('presses Return in a single-line field after a passing re-read', async () => {
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello', { submit: true })

      expect(result.success).toBe(true)
      expect(result.metadata?.fillSubmit).toEqual({ sent: true })
      const keysIdx = calls.findIndex(c => c.startsWith('keys:'))
      expect(keysIdx).toBeGreaterThan(calls.lastIndexOf('getAttr:title:value'))
    })

    it('sends no Return when the re-read fails', async () => {
      fields.title.setValue.mockImplementation(() => Promise.resolve())
      fields.title.value = 'other'
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello', { submit: true })

      expect(result.success).toBe(false)
      expect(mockDriver.keys).not.toHaveBeenCalled()
      expect(result.metadata?.fillSubmit).toEqual({ sent: false })
    })

    it('records no submit outcome when submit was not requested', async () => {
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello')

      expect(result.success).toBe(true)
      expect(result.metadata).not.toHaveProperty('fillSubmit')
    })

    it('treats a prior value equal to the empty-field hint text as empty when appending', async () => {
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'abc', { clearMode: 'append' })

      expect(result.success).toBe(true)
      expect(result.metadata?.fillReread).toEqual({ expected: 'abc', actual: 'abc' })
      expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact' })
    })
  })

  describe('fill re-reads the iOS field and sends Return by the verdict', () => {
    it('a replace whose re-read equals the text records exact', async () => {
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello')

      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'Hello', actual: 'Hello' },
        fillVerdict: { verb: 'fill', verdict: 'exact' },
      })
    })

    it('a re-read with merged whitespace records mismatch and sends no Return', async () => {
      fields.title.setValue.mockImplementation((v: string) => {
        calls.push('setValue:title')
        fields.title.value = v.replace(/\s+/g, ' ')
        return Promise.resolve()
      })
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'foo  bar', { submit: true })

      expect(result.success).toBe(false)
      expect(result.error).toBe('field reads "foo bar" after typing "foo  bar" — re-observe and retry')
      expect(result.metadata).toEqual({
        fillReread: { expected: 'foo  bar', actual: 'foo bar' },
        fillVerdict: { verb: 'fill', verdict: 'mismatch' },
        fillSubmit: { sent: false },
      })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    function unreadable(field: MockField, id: string): void {
      field.getAttribute.mockImplementation((name: string) => {
        calls.push(`getAttr:${id}:${name}`)
        return name === 'value' ? Promise.reject(new Error('stale element')) : Promise.resolve(null)
      })
    }

    it('an unreadable re-read records unverified and still sends the requested Return once', async () => {
      unreadable(fields.title, 'title')
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello', { submit: true })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.metadata).toEqual({
        fillVerdict: { verb: 'fill', verdict: 'unverified' },
        fillSubmit: { sent: true },
      })
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\n'])
      expect(calls.findIndex(c => c.startsWith('keys:'))).toBeGreaterThan(
        calls.lastIndexOf('getAttr:title:value'),
      )
    })

    it('an unreadable re-read whose focus was lost sends no Return and records focus lost', async () => {
      unreadable(fields.title, 'title')
      fields.title.setValue.mockImplementation((v: string) => {
        calls.push('setValue:title')
        fields.title.value = v
        activeElement = () => Promise.resolve({ [W3C_ELEMENT_KEY]: 'body' })
        return Promise.resolve()
      })
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello', { submit: true })

      expect(fields.title.setValue).toHaveBeenCalledWith('Hello')
      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillVerdict: { verb: 'fill', verdict: 'unverified' },
        fillSubmit: { sent: false, reason: 'focus-lost' },
      })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    it('an unreadable re-read whose focus holds sends the requested Return once', async () => {
      unreadable(fields.title, 'title')
      activeElement = () => {
        calls.push('activeElement')
        return activeByLastTap()
      }
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello', { submit: true })

      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillVerdict: { verb: 'fill', verdict: 'unverified' },
        fillSubmit: { sent: true },
      })
      expect(mockDriver.keys).toHaveBeenCalledTimes(1)
      expect(mockDriver.keys).toHaveBeenCalledWith(['\n'])
      const reread = calls.lastIndexOf('getAttr:title:value')
      const sent = calls.findIndex(c => c.startsWith('keys:'))
      expect(reread).toBeGreaterThan(-1)
      expect(calls.slice(reread + 1, sent).filter(c => c === 'activeElement')).toHaveLength(1)
    })

    it('an unreadable re-read in a multi-line field sends no Return and records the multi-line outcome', async () => {
      unreadable(fields.body, 'body')
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, 'message', { submit: true })

      expect(result.success).toBe(true)
      expect(result.data).toBe(SUBMIT_NOTICE)
      expect(result.metadata).toEqual({
        fillVerdict: { verb: 'fill', verdict: 'unverified' },
        fillSubmit: { sent: false, reason: 'multi-line-field' },
      })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    it('an unreadable re-read without a submit sends nothing and records no submit outcome', async () => {
      unreadable(fields.title, 'title')
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'Hello')

      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({ fillVerdict: { verb: 'fill', verdict: 'unverified' } })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    it('a multi-line submit still records not sent for a multi-line field, with the notice', async () => {
      await start()
      const ref = await refFor('Body')

      const result = await fill(ref, 'message', { submit: true })

      expect(result.success).toBe(true)
      expect(result.data).toBe(SUBMIT_NOTICE)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'message', actual: 'message' },
        fillVerdict: { verb: 'fill', verdict: 'exact' },
        fillSubmit: { sent: false, reason: 'multi-line-field' },
      })
      expect(mockDriver.keys).not.toHaveBeenCalled()
    })

    describe('appends whose re-read never showed the appended text', () => {
      beforeEach(() => {
        fields.title.value = 'abc'
        fields.title.addValue.mockImplementation(() => {
          calls.push('addValue:title')
          return Promise.resolve()
        })
      })

      it('an append whose re-read equals the prior value is unverified', async () => {
        await start()
        const ref = await refFor('Title')

        const result = await fill(ref, 'XYZ', { clearMode: 'append' })

        expect(fields.title.addValue).toHaveBeenCalledWith('XYZ')
        expect(result.success).toBe(true)
        expect(result.error).toBeUndefined()
        expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified' })
        expect(result.metadata).not.toHaveProperty('fillReread')
        expect(JSON.stringify(result)).not.toContain('abcXYZ')
      })

      it('the same append into a single-line field with submit sends Return exactly once', async () => {
        await start()
        const ref = await refFor('Title')

        const result = await fill(ref, 'XYZ', { clearMode: 'append', submit: true })

        expect(result.success).toBe(true)
        expect(mockDriver.keys).toHaveBeenCalledTimes(1)
        expect(mockDriver.keys).toHaveBeenCalledWith(['\n'])
        expect(result.metadata).toEqual({
          fillVerdict: { verb: 'fill', verdict: 'unverified' },
          fillSubmit: { sent: true },
        })
        expect(JSON.stringify(result)).not.toContain('abcXYZ')
      })
    })

    it('an append whose re-read shows the appended text records exact', async () => {
      fields.title.value = 'abc'
      await start()
      const ref = await refFor('Title')

      const result = await fill(ref, 'XYZ', { clearMode: 'append' })

      expect(result.success).toBe(true)
      expect(result.metadata).toEqual({
        fillReread: { expected: 'abcXYZ', actual: 'abcXYZ' },
        fillVerdict: { verb: 'fill', verdict: 'exact' },
      })
    })
  })

  describe('a fill uses only the one candidate whose rect matches the observed bounds', () => {
    beforeEach(() => {
      fields = { body: createField('body'), notes: createField('notes') }
    })

    it('one candidate whose rect matches the observed bounds is used, wherever it sits in the list', async () => {
      selectorResults = { [TEXT_VIEW]: [fields.notes, fields.body] }
      await start(TWO_VIEWS_XML)
      const ref = await refFor('Notes')

      const result = await fill(ref, 'note text')

      expect(result.success).toBe(true)
      expect(fields.notes.setValue).toHaveBeenCalledWith('note text')
      expect(fields.body.setValue).not.toHaveBeenCalled()
    })

    it('two candidates matching the observed bounds refuse the fill, never taking the one at the same-type position', async () => {
      selectorResults = { [TEXT_VIEW]: [fields.body, fields.notes] }
      await start(TWO_VIEWS_XML)
      const ref = await refFor('Notes')
      rects.body = { ...RECTS.notes }

      const result = await fill(ref, 'note text')

      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'target-not-found', evidence: 'stale-target' })
      expect(mockDriver.action).not.toHaveBeenCalled()
      nothingTyped()
    })

    it('two matching candidates refuse whatever their order', async () => {
      selectorResults = { [TEXT_VIEW]: [fields.notes, fields.body] }
      await start(TWO_VIEWS_XML)
      const ref = await refFor('Body')
      rects.notes = { ...RECTS.body }

      const result = await fill(ref, 'body text')

      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'target-not-found', evidence: 'stale-target' })
      nothingTyped()
    })

    it('no candidate whose rect matches refuses the fill', async () => {
      selectorResults = { [TEXT_VIEW]: [fields.body, fields.notes] }
      await start(TWO_VIEWS_XML)
      const ref = await refFor('Notes')
      rects.notes = { ...RECTS.notes, y: RECTS.notes.y + 40 }

      const result = await fill(ref, 'note text')

      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({ verb: 'fill', cause: 'target-not-found', evidence: 'stale-target' })
      nothingTyped()
    })
  })
})
