import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `driver.$` answers each focused XPath from a small field model, as UiAutomator2 does.

const ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.EditText text="" content-desc="Username" bounds="[100,250][980,350]" enabled="true" />
      <android.widget.EditText text="" content-desc="Password" password="true" bounds="[100,400][980,500]" enabled="true" />
      <android.widget.Button text="Sign In" bounds="[100,550][980,650]" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const SCREENSHOT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const FOCUSED_XPATH = '//*[@focused="true"]'
const FOCUSED_HINT_XPATH = '//*[@focused="true" and @showing-hint="true"]'
const FOCUSED_MULTILINE_XPATH = '//*[@focused="true" and @multiline="true"]'
const FOCUSED_SINGLE_LINE_XPATH = '//*[@focused="true" and @multiline="false"]'
const PRESS_ENTER = 'execute:mobile: pressKey:{"keycode":66}'

interface FieldModel {
  value: string
  hint?: string
  multiline?: boolean
  password: boolean
  readBack?: () => string
  getTextThrows: boolean
  setValueThrows: boolean
  focusThrows: boolean
  pressKeyError?: string
  // A hidden handle makes the focused XPath absent; `revealOnType` shows it after `mobile: type`.
  focusHidden?: boolean
  revealOnType?: boolean
  typeThrows?: boolean
  clearThrows?: boolean
  // The focused node's `bounds`; unset answers as UiAutomator2 does for an unknown attribute.
  bounds?: string
}

// A WebView field: the focus probe, W3C keys and `mobile: type` act on it; `readBack` overrides.
interface WebFieldModel {
  editable: boolean
  matches: boolean
  multiline: boolean
  secure: boolean
  value: string
  probeValue?: unknown
  readBack?: () => unknown
  typeThrows?: boolean
  keysThrow?: boolean
  // Answers for the first probes, in order; later probes answer from the model.
  probes?: Array<{ editable: boolean; matches: boolean }>
  probeThrows?: boolean
}

const WEB_CTX = 'WEBVIEW_app.shop'
const WEB_NODES = [
  { role: 'textbox', name: 'Email', bounds: { x: 10.4, y: 20.2, width: 201, height: 41 } },
  { role: 'button', name: 'Place order', bounds: { x: 10, y: 100, width: 200, height: 40 } },
].map((node) => ({ ...node, state: {}, labels: {}, attributes: {} }))

let calls: string[] = []
let field: FieldModel
let web: WebFieldModel | null = null
let ctx = 'NATIVE_APP'
let observing = false
let scripts: string[] = []
let taps: Array<{ ctx: string; move: unknown }> = []
let selectedAll = false
let pageXml = ANDROID_XML

// The observed Username EditText with a raw input-type attribute.
function usernameInputType(value: string): void {
  pageXml = ANDROID_XML.replace('content-desc="Username"', `content-desc="Username" input-type="${value}"`)
}

function newField(): FieldModel {
  return { value: '', password: false, getTextThrows: false, setValueThrows: false, focusThrows: false }
}

function newWebField(): WebFieldModel {
  return { editable: true, matches: true, multiline: false, secure: false, value: '' }
}

function webScript(source: string, args: unknown[]): unknown {
  if (observing) {
    return {
      nodes: WEB_NODES,
      viewport: { width: 400, height: 800 },
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 400, contentHeight: 800 },
      url: 'https://shop.local/checkout',
    }
  }
  scripts.push(source)
  const w = web!
  if (args.length === 2) {
    calls.push(`script:probe:${args.join(',')}`)
    if (w.probeThrows) throw new Error('no such window')
    const next = w.probes?.shift()
    return {
      editable: next ? next.editable : w.editable,
      matches: next ? next.matches : w.matches,
      multiline: w.multiline,
      secure: w.secure,
      value: 'probeValue' in w ? w.probeValue : w.value,
    }
  }
  calls.push('script:read')
  return w.readBack ? w.readBack() : w.value
}

function webKeys(k: unknown): void {
  const keys = JSON.stringify(k)
  if (keys === '["Control","a"]') selectedAll = true
  else if (keys === '["Backspace"]' && selectedAll) {
    web!.value = ''
    selectedAll = false
  } else selectedAll = false
}

function showingHint(): boolean {
  return field.value === '' && field.hint !== undefined
}

function nativeKey(args: { keycode: number; metastate?: number }): void {
  if (args.keycode === 29 && args.metastate === 0x1000) selectedAll = true
  else if (args.keycode === 67 && selectedAll) {
    field.value = ''
    selectedAll = false
  } else selectedAll = false
}

function createFocusedElement() {
  return {
    isExisting: vi.fn().mockImplementation(() => Promise.resolve(field.focusHidden !== true)),
    setValue: vi.fn().mockImplementation((v: string) => {
      calls.push(`setValue:${v}`)
      if (field.setValueThrows) return Promise.reject(new Error('socket hang up'))
      field.value = v
      return Promise.resolve()
    }),
    addValue: vi.fn().mockImplementation((v: string) => {
      calls.push(`addValue:${v}`)
      field.value += v
      return Promise.resolve()
    }),
    getText: vi.fn().mockImplementation(() => {
      calls.push('getText')
      if (field.getTextThrows) return Promise.reject(new Error('stale element'))
      if (field.readBack) return Promise.resolve(field.readBack())
      return Promise.resolve(showingHint() ? field.hint : field.value)
    }),
    getAttribute: vi.fn().mockImplementation((name: string) => {
      calls.push(`getAttr:${name}`)
      if (name === 'password') return Promise.resolve(field.password ? 'true' : 'false')
      if (name === 'bounds' && field.bounds !== undefined) return Promise.resolve(field.bounds)
      return Promise.reject(new Error(`attribute is unknown: ${name}`))
    }),
    clearValue: vi.fn().mockImplementation(() => {
      calls.push('clearValue')
      if (field.clearThrows) return Promise.reject(new Error('socket hang up'))
      field.value = ''
      return Promise.resolve()
    }),
  }
}
let focused: ReturnType<typeof createFocusedElement>

function probe(matches: () => boolean) {
  return { isExisting: vi.fn().mockImplementation(() => Promise.resolve(matches())) }
}

function createMockDriver() {
  const chain: Record<string, any> = {}
  chain.move = vi.fn().mockReturnValue(chain)
  chain.down = vi.fn().mockReturnValue(chain)
  chain.up = vi.fn().mockReturnValue(chain)
  chain.pause = vi.fn().mockReturnValue(chain)
  chain.perform = vi.fn().mockImplementation(() => {
    calls.push('tap')
    taps.push({ ctx, move: chain.move.mock.lastCall?.[0] })
    return Promise.resolve()
  })
  return {
    getPageSource: vi.fn().mockImplementation(() => Promise.resolve(pageXml)),
    getWindowSize: vi.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    takeScreenshot: vi.fn().mockResolvedValue(SCREENSHOT_BASE64),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    action: vi.fn().mockReturnValue(chain),
    keys: vi.fn().mockImplementation((k: unknown) => {
      calls.push(`keys:${JSON.stringify(k)}`)
      if (web?.keysThrow) return Promise.reject(new Error('socket hang up'))
      if (web) webKeys(k)
      return Promise.resolve()
    }),
    pause: vi.fn().mockImplementation((ms: number) => {
      calls.push(`pause:${ms}`)
      return Promise.resolve()
    }),
    execute: vi.fn().mockImplementation((command: unknown, ...rest: unknown[]) => {
      if (typeof command !== 'string' || (web && !command.startsWith('mobile:'))) {
        return Promise.resolve(webScript(String(command), rest))
      }
      const args = rest[0]
      calls.push(`execute:${command}:${JSON.stringify(args ?? null)}`)
      if (command === 'mobile: pressKey' && field.pressKeyError) {
        return Promise.reject(new Error(field.pressKeyError))
      }
      if (command === 'mobile: type' && web) {
        if (web.typeThrows) return Promise.reject(new Error('socket hang up'))
        web.value += (args as { text: string }).text
      } else if (command === 'mobile: type') {
        if (field.typeThrows) return Promise.reject(new Error('socket hang up'))
        field.value += (args as { text: string }).text
        if (field.revealOnType) field.focusHidden = false
      } else if (command === 'mobile: pressKey' && !web) {
        nativeKey(args as { keycode: number; metastate?: number })
      }
      return Promise.resolve(undefined)
    }),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    switchContext: vi.fn().mockImplementation((name: string) => {
      if (!observing) calls.push(`switch:${name}`)
      ctx = name
      return Promise.resolve()
    }),
    url: vi.fn().mockRejectedValue(new Error('not supported')),
    $: vi.fn().mockImplementation((selector: string) => {
      calls.push(`$:${selector}`)
      if (field.focusThrows) return Promise.reject(new Error('session busy'))
      switch (selector) {
        case FOCUSED_XPATH:
          return Promise.resolve(focused)
        case FOCUSED_HINT_XPATH:
          return Promise.resolve(probe(showingHint))
        case FOCUSED_MULTILINE_XPATH:
          return Promise.resolve(probe(() => field.multiline === true))
        case FOCUSED_SINGLE_LINE_XPATH:
          return Promise.resolve(probe(() => field.multiline === false))
        default:
          return Promise.resolve(probe(() => false))
      }
    }),
  }
}

vi.mock('webdriverio', () => ({ remote: vi.fn() }))

import { AndroidPlatformAdapter } from '../adapter.js'

type ExecAction = Parameters<AndroidPlatformAdapter['execute']>[0]

function count(prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length
}

let adapter: AndroidPlatformAdapter
let driver: ReturnType<typeof createMockDriver>

beforeEach(async () => {
  vi.clearAllMocks()
  calls = []
  scripts = []
  taps = []
  web = null
  ctx = 'NATIVE_APP'
  observing = false
  selectedAll = false
  pageXml = ANDROID_XML
  field = newField()
  focused = createFocusedElement()
  driver = createMockDriver()
  const { remote } = await import('webdriverio')
  vi.mocked(remote).mockResolvedValue(driver as any)
  adapter = new AndroidPlatformAdapter()
  await adapter.setup({ platform: 'android' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function fill(
  name: string,
  text: string,
  opts: { clearMode?: 'replace' | 'append'; submit?: boolean } = {},
) {
  const ref = await refFor(name)
  return await adapter.execute({
    type: 'fill',
    ref,
    text,
    clearMode: opts.clearMode ?? 'replace',
    submit: opts.submit ?? false,
  } as unknown as ExecAction)
}

async function refFor(name: string): Promise<string> {
  observing = true
  const state = await adapter.observe()
  observing = false
  const el = state.elements.find((e) => e.name === name)
  if (!el) throw new Error(`test fixture: element "${name}" not observed`)
  calls.length = 0
  scripts.length = 0
  taps.length = 0
  return el.ref
}

async function webView(model: Partial<WebFieldModel> = {}): Promise<void> {
  web = { ...newWebField(), ...model }
  driver.getContexts.mockResolvedValue(['NATIVE_APP', WEB_CTX])
  await adapter.setup({ platform: 'android', appPackage: 'app.shop' } as never)
}

async function clear(name: string) {
  const ref = await refFor(name)
  return await adapter.execute({ type: 'clearText', ref } as unknown as ExecAction)
}

const WEB_PRESS_ENTER = [
  'switch:NATIVE_APP',
  PRESS_ENTER,
  `switch:${WEB_CTX}`,
]

describe('fill on the native setValue path', () => {
  it('an unreadable read-back still sends the requested Enter once', async () => {
    field.getTextThrows = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count(PRESS_ENTER)).toBe(1)
    expect(calls.indexOf(PRESS_ENTER)).toBeGreaterThan(calls.indexOf('setValue:hello'))
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'native' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(result.metadata).not.toHaveProperty('fillReread')
  })

  it('a mismatch holds Enter', async () => {
    field.readBack = () => 'wrong'

    const result = await fill('Username', 'intended', { submit: true })

    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.error).toBe('field reads "wrong" after typing "intended" — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'mismatch', path: 'native' })
    expect(result.metadata?.fillReread).toEqual({ expected: 'intended', actual: 'wrong' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: false, outcome: 'not-sent', reason: 'mismatch' })
  })

  it('a normalized read-back passes and submits', async () => {
    field.readBack = () => '+1 392-074-1751'

    const result = await fill('Username', '+13920741751', { submit: true })

    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'normalized', path: 'native' })
    expect(result.metadata?.fillReread).toEqual({ expected: '+13920741751', actual: '+1 392-074-1751' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(count(PRESS_ENTER)).toBe(1)
  })

  it("an empty field's hint is not its value", async () => {
    field.hint = 'Search settings'

    const appended = await fill('Username', 'abc', { clearMode: 'append' })

    expect(calls.indexOf(`$:${FOCUSED_HINT_XPATH}`)).toBeLessThan(calls.indexOf('addValue:abc'))
    expect(appended.success).toBe(true)
    expect(appended.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    expect(appended.metadata?.fillReread).toEqual({ expected: 'abc', actual: 'abc' })

    field = { ...newField(), hint: 'Search settings' }
    focused.setValue.mockImplementation((v: string) => {
      calls.push(`setValue:${v}`)
      return Promise.resolve()
    })

    const dropped = await fill('Username', 'hello')

    expect(dropped.success).toBe(false)
    expect(dropped.metadata?.fillReread).toEqual({ expected: 'hello', actual: '' })
  })

  it('a failed Enter is recorded and not repeated', async () => {
    field.pressKeyError = 'socket hang up\n    at Request.emit (node:events)'

    const result = await fill('Username', 'hello', { submit: true })

    expect(count('execute:mobile: pressKey')).toBe(1)
    expect(count('setValue:')).toBe(1)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/typed/)
    expect(result.error).toMatch(/Enter failed/)
    expect(result.error).toMatch(/not sent again/)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'failed',
      detail: 'socket hang up',
    })
  })

  it('a secure field is never exact', async () => {
    field.password = true

    const result = await fill('Password', 'topSecretPw', { submit: true })

    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'fill',
      verdict: 'unverified',
      path: 'native',
      secure: true,
    })
    expect(result.metadata?.fillReread).toEqual({ expected: '<len:11>', actual: '<len:11>' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it('submit false sends no Enter and records no fillSubmit', async () => {
    const result = await fill('Username', 'hello')

    expect(result.success).toBe(true)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.metadata).not.toHaveProperty('fillSubmit')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
  })

  it('a multi-line field never gets Enter', async () => {
    field.multiline = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(true)
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'multi-line-field',
    })
    expect(result.data).toBe(
      'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control',
    )
  })

  it.each([
    ['a newline', 'l1\nl2'],
    ['a carriage return', 'l1\rl2'],
  ])('line breaks into a single-line field are refused before typing (%s)', async (_label, text) => {
    field.multiline = false

    const result = await fill('Username', text, { submit: true })

    expect(count('setValue:')).toBe(0)
    expect(count('addValue:')).toBe(0)
    expect(count('keys:')).toBe(0)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'fill: this field is single-line and the text has line breaks; nothing was typed. '
        + 'Send the text without line breaks, or use a multi-line field.',
    )
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'single-line-field',
      evidence: 'text-has-line-breaks',
    })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
    expect(result.metadata).not.toHaveProperty('fillVerdict')
  })

  it.each([
    ['multi-line text with blank lines into a multi-line field', 'line one\n\nline three\n  indented\ttab |;," end  ', true],
    ['leading and trailing spaces and tabs', '\t  lead and trail  \t', false],
    ['commas, semicolons, pipes and quotes', `a,b;c|d "q" 's'`, false],
    ['accented, CJK and emoji characters', 'é ü 中文 😀', false],
  ])('whitespace, punctuation and non-ASCII texts are typed once and read back exact: %s', async (_label, text, multiline) => {
    field.multiline = multiline

    const result = await fill('Username', text)

    expect(calls.filter((c) => c.startsWith('setValue:'))).toEqual([`setValue:${text}`])
    expect(count('keys:')).toBe(0)
    expect(count('execute:mobile: type')).toBe(0)
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    expect(result.metadata?.fillReread).toEqual({ expected: text, actual: text })
  })

  it('a character the path could not type is recorded as a mismatch, never hidden', async () => {
    field.readBack = () => 'é ü 中文 '

    const result = await fill('Username', 'é ü 中文 😀', { submit: true })

    expect(count('setValue:')).toBe(1)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'mismatch', path: 'native' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: false, outcome: 'not-sent', reason: 'mismatch' })
  })

  // The tap must leave the referenced field focused; only read bounds outside the ref's refuse.
  const PASSWORD_BOUNDS = '[100,400][980,500]'
  const FOCUS_ELSEWHERE_ERROR =
    /^fill: after tapping \S+, input focus is on another field; nothing was typed\. Input is never sent to a field other than the target\. Re-observe and target the field itself\.$/
  const MOVED_FILL_ERROR =
    /^fill: after tapping \S+, the focused field is no longer where it was observed; nothing was typed\. Re-observe and target the field where it is now\.$/

  function typedCount(): number {
    return focused.setValue.mock.calls.length
      + focused.addValue.mock.calls.length
      + driver.execute.mock.calls.filter(([c]) => c === 'mobile: type').length
  }

  function enterCount(): number {
    return driver.execute.mock.calls
      .filter(([c, a]) => c === 'mobile: pressKey' && (a as { keycode?: number })?.keycode === 66).length
  }

  it('a fill whose tap left another field focused is refused with nothing typed', async () => {
    field.value = 'pw-kept'
    field.bounds = PASSWORD_BOUNDS

    const plain = await fill('Username', 'hello')

    expect(plain.success).toBe(false)
    expect(plain.error).toMatch(FOCUS_ELSEWHERE_ERROR)
    expect(plain.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'focus-elsewhere',
    })
    expect(plain.metadata).not.toHaveProperty('fillSubmit')
    expect(plain.metadata).not.toHaveProperty('fillVerdict')

    const submitted = await fill('Username', 'hello', { submit: true })

    expect(submitted.success).toBe(false)
    expect(submitted.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'focus-elsewhere',
    })
    expect(submitted.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
    expect(typedCount()).toBe(0)
    expect(enterCount()).toBe(0)
    expect(driver.keys).not.toHaveBeenCalled()
    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(field.value).toBe('pw-kept')
  })

  it("a focused field within the ref's bounds keeps the native path", async () => {
    for (const bounds of ['[100,250][980,350]', '[101,251][979,349]', '[99,249][981,351]']) {
      field = { ...newField(), bounds }

      const result = await fill('Username', 'hello')

      expect(calls.filter((c) => c.startsWith('setValue:')), bounds).toEqual(['setValue:hello'])
      expect(result.success, bounds).toBe(true)
      expect(result.metadata?.fillVerdict, bounds).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
      expect(result.metadata, bounds).not.toHaveProperty('fillRefusal')
    }
  })

  it('a focused field whose bounds cannot be read keeps the native path', async () => {
    for (const bounds of [undefined, 'not-bounds', '[100,400][980]']) {
      field = { ...newField(), bounds }

      const result = await fill('Username', 'hello', { submit: true })

      expect(count('getAttr:bounds'), String(bounds)).toBe(1)
      expect(calls.filter((c) => c.startsWith('setValue:')), String(bounds)).toEqual(['setValue:hello'])
      expect(count(PRESS_ENTER), String(bounds)).toBe(1)
      expect(result.success, String(bounds)).toBe(true)
      expect(result.metadata?.fillVerdict, String(bounds)).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    }
  })

  it('a field the keyboard moved after the tap is refused, and the re-observed fill types once', async () => {
    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1500][980,1600]"')
    field.bounds = '[100,1100][980,1200]'

    const moved = await fill('Username', 'hello')

    expect(moved.success).toBe(false)
    expect(moved.error).toMatch(MOVED_FILL_ERROR)
    expect(moved.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'target-not-found',
      evidence: 'stale-target',
    })
    expect(moved.metadata).not.toHaveProperty('fillSubmit')
    expect(typedCount()).toBe(0)
    expect(field.value).toBe('')

    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1100][980,1200]"')
    const reobserved = await fill('Username', 'hello')

    expect(taps.at(-1)?.move).toEqual({ x: 540, y: 1150 })
    expect(typedCount()).toBe(1)
    expect(field.value).toBe('hello')
    expect(reobserved.success).toBe(true)
    expect(reobserved.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
  })

  it('a clipped field focused beyond its observed bounds is refused as moved, and the re-observed fill types once', async () => {
    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1880][980,1920]"')
    field.bounds = '[100,1880][980,1980]'

    const clipped = await fill('Username', 'hello')

    expect(clipped.success).toBe(false)
    expect(clipped.error).toMatch(MOVED_FILL_ERROR)
    expect(clipped.error).not.toContain('another field')
    expect(clipped.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'target-not-found',
      evidence: 'stale-target',
    })
    expect(typedCount()).toBe(0)
    expect(field.value).toBe('')

    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1100][980,1200]"')
    field.bounds = '[100,1100][980,1200]'
    const reobserved = await fill('Username', 'hello')

    expect(taps.at(-1)?.move).toEqual({ x: 540, y: 1150 })
    expect(typedCount()).toBe(1)
    expect(field.value).toBe('hello')
    expect(reobserved.success).toBe(true)
    expect(reobserved.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
  })

  it('a moved field fill planned twice types nothing either time', async () => {
    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1500][980,1600]"')
    field.bounds = '[100,1100][980,1200]'

    const first = await fill('Username', 'hello', { submit: true })
    const second = await fill('Username', 'hello', { submit: true })

    for (const result of [first, second]) {
      expect(result.success).toBe(false)
      expect(result.error).toMatch(MOVED_FILL_ERROR)
      expect(result.metadata?.fillRefusal).toEqual({
        verb: 'fill',
        cause: 'target-not-found',
        evidence: 'stale-target',
      })
      expect(result.metadata?.fillSubmit).toEqual({
        sent: false,
        outcome: 'not-sent',
        reason: 'input-failed',
      })
    }
    expect(typedCount()).toBe(0)
    expect(enterCount()).toBe(0)
    expect(field.value).toBe('')

    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1100][980,1200]"')
    const reobserved = await fill('Username', 'hello', { submit: true })

    expect(reobserved.success).toBe(true)
    expect(typedCount()).toBe(1)
    expect(enterCount()).toBe(1)
    expect(field.value).toBe('hello')
  })

  it('a focus-elsewhere fill planned twice types nothing either time', async () => {
    field.value = 'pw-kept'
    field.bounds = PASSWORD_BOUNDS

    const first = await fill('Username', 'hello', { submit: true })
    const second = await fill('Username', 'hello', { submit: true })

    for (const result of [first, second]) {
      expect(result.success).toBe(false)
      expect(result.metadata?.fillRefusal).toEqual({
        verb: 'fill',
        cause: 'not-editable',
        evidence: 'focus-elsewhere',
      })
      expect(result.metadata?.fillSubmit).toEqual({
        sent: false,
        outcome: 'not-sent',
        reason: 'input-failed',
      })
    }
    expect(typedCount()).toBe(0)
    expect(enterCount()).toBe(0)
    expect(field.value).toBe('pw-kept')
  })
})

// The keyboard path: Ctrl+A then DEL, one `mobile: type`, a read-back, and Enter at most once.
const CTRL_A = 'execute:mobile: pressKey:{"keycode":29,"metastate":4096}'
const DEL = 'execute:mobile: pressKey:{"keycode":67}'

describe('fill on the keyboard (mobile: type) path', () => {
  it('a replace with submit is Ctrl+A, DEL, one mobile: type, read-back, one Enter', async () => {
    field.value = 'stale'
    field.focusHidden = true
    field.revealOnType = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(calls).toEqual([
      'tap',
      `$:${FOCUSED_XPATH}`,
      CTRL_A,
      DEL,
      'execute:mobile: type:{"text":"hello"}',
      `$:${FOCUSED_XPATH}`,
      'getAttr:password',
      `$:${FOCUSED_HINT_XPATH}`,
      'getText',
      PRESS_ENTER,
    ])
    expect(driver.keys).not.toHaveBeenCalled()
    expect(field.value).toBe('hello')
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'keyboard' })
    expect(result.metadata?.fillReread).toEqual({ expected: 'hello', actual: 'hello' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
  })

  it('no handle after typing is unverified and still submits', async () => {
    field.focusHidden = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count('execute:mobile: type')).toBe(1)
    expect(count(PRESS_ENTER)).toBe(1)
    expect(calls.indexOf(PRESS_ENTER)).toBeGreaterThan(calls.indexOf('execute:mobile: type:{"text":"hello"}'))
    expect(driver.keys).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'keyboard' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(result.metadata).not.toHaveProperty('fillReread')
  })

  it('append types at the cursor with no clear and is unverified', async () => {
    field.value = 'Hello'
    field.focusHidden = true
    field.revealOnType = true

    const result = await fill('Username', ' world', { clearMode: 'append', submit: true })

    expect(count(CTRL_A)).toBe(0)
    expect(count(DEL)).toBe(0)
    expect(calls.filter((c) => c.startsWith('execute:mobile: type'))).toEqual([
      'execute:mobile: type:{"text":" world"}',
    ])
    expect(field.value).toBe('Hello world')
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'keyboard' })
    expect(result.metadata).not.toHaveProperty('fillReread')
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
  })

  it.each([
    ['multi-line text with blank lines', 'line one\n\nline three\n  indented\ttab |;," end  '],
    ['leading and trailing spaces and tabs', '\t  lead and trail  \t'],
    ['commas, semicolons, pipes and quotes', `a,b;c|d "q" 's'`],
    ['accented, CJK and emoji characters', 'é ü 中文 😀'],
  ])('whitespace, punctuation and non-ASCII texts are each one mobile: type call: %s', async (_label, text) => {
    field.focusHidden = true
    field.revealOnType = true

    const result = await fill('Username', text)

    const typed = vi.mocked(driver.execute).mock.calls.filter((c) => c[0] === 'mobile: type')
    expect(typed).toEqual([['mobile: type', { text }]])
    expect(driver.keys).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'keyboard' })
    expect(result.metadata?.fillReread).toEqual({ expected: text, actual: text })
  })

  it('a multi-line field on the keyboard path never gets Enter', async () => {
    usernameInputType('131073')
    field.focusHidden = true

    const result = await fill('Username', 'line one\nline two', { submit: true })

    expect(count('execute:mobile: type')).toBe(1)
    expect(count(PRESS_ENTER)).toBe(0)
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'keyboard' })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'multi-line-field',
    })
    expect(result.data).toBe(
      'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control',
    )
  })

  it.each([
    ['input-type 0', '0'],
    ['no input-type', undefined],
  ])('an unknown field on the keyboard path gets the requested Enter (%s)', async (_label, inputType) => {
    if (inputType !== undefined) usernameInputType(inputType)
    field.focusHidden = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count(PRESS_ENTER)).toBe(1)
    expect(result.success).toBe(true)
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
  })

  it('line breaks into a known single-line keyboard field are refused', async () => {
    usernameInputType('1048577')
    field.value = 'kept'
    field.focusHidden = true

    const result = await fill('Username', 'a\nb', { submit: true })

    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(count('execute:mobile: type')).toBe(0)
    expect(driver.keys).not.toHaveBeenCalled()
    expect(field.value).toBe('kept')
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'fill: this field is single-line and the text has line breaks; nothing was typed. '
        + 'Send the text without line breaks, or use a multi-line field.',
    )
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'single-line-field',
      evidence: 'text-has-line-breaks',
    })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
  })

  it('a known single-line keyboard field still gets the requested Enter', async () => {
    usernameInputType('1048577')
    field.focusHidden = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count(PRESS_ENTER)).toBe(1)
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
  })
})

// Empty is exact, leftover text is a mismatch, and an unreadable field is unverified.
describe('clearText is read back like a fill', () => {
  it('a native clear reads back empty and is exact', async () => {
    field.value = 'old text'
    field.hint = 'Username'

    const result = await clear('Username')

    expect(count('clearValue')).toBe(1)
    expect(calls.indexOf(`$:${FOCUSED_HINT_XPATH}`)).toBeGreaterThan(calls.indexOf('clearValue'))
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(field.value).toBe('')
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'exact', path: 'native' })
    expect(result.metadata?.fillReread).toEqual({ expected: '', actual: '' })
  })

  it('a native clear that leaves text is a mismatch', async () => {
    field.value = 'abc'
    field.readBack = () => 'abc'

    const result = await clear('Username')

    expect(result.success).toBe(false)
    expect(result.error).toBe('field still reads "abc" after clearing — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'mismatch', path: 'native' })
    expect(result.metadata?.fillReread).toEqual({ expected: '', actual: 'abc' })
  })

  it('a native clear whose read-back fails is unverified, not a failure', async () => {
    field.value = 'abc'
    field.getTextThrows = true

    const result = await clear('Username')

    expect(count('clearValue')).toBe(1)
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'unverified', path: 'native' })
    expect(result.metadata).not.toHaveProperty('fillReread')
  })

  it('a secure native clear is never exact', async () => {
    field.value = 'topSecretPw'
    field.password = true

    const result = await clear('Password')

    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'native',
      secure: true,
    })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it('a secure native clear that leaves text is a mismatch and names only its length', async () => {
    field.value = 'topSecretPw'
    field.password = true
    field.readBack = () => 'topSecretPw'

    const result = await clear('Password')

    expect(count('clearValue')).toBe(1)
    expect(result.success).toBe(false)
    expect(result.error).toBe('field still reads "<len:11>" after clearing — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'mismatch',
      path: 'native',
      secure: true,
    })
    expect(result.metadata?.fillReread).toEqual({ expected: '<len:0>', actual: '<len:11>' })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it('a secure keyboard clear that leaves text is a mismatch', async () => {
    field.value = 'topSecretPw'
    field.password = true
    field.readBack = () => 'topSecretPw'
    focused.isExisting.mockResolvedValueOnce(false)

    const result = await clear('Password')

    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(count(CTRL_A)).toBe(1)
    expect(count(DEL)).toBe(1)
    expect(result.success).toBe(false)
    expect(result.error).toBe('field still reads "<len:11>" after clearing — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'mismatch',
      path: 'keyboard',
      secure: true,
    })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it('a keyboard clear is Ctrl+A then DEL, then a read-back or unverified', async () => {
    field.value = 'old text'
    field.focusHidden = true

    const unseen = await clear('Username')

    expect(calls).toEqual(['tap', `$:${FOCUSED_XPATH}`, CTRL_A, DEL, `$:${FOCUSED_XPATH}`])
    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(driver.keys).not.toHaveBeenCalled()
    expect(field.value).toBe('')
    expect(unseen.success).toBe(true)
    expect(unseen.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'keyboard',
    })

    field = { ...newField(), value: 'old text', hint: 'Username' }
    focused.isExisting.mockResolvedValueOnce(false)
    const seen = await clear('Username')

    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(count(CTRL_A)).toBe(1)
    expect(count(DEL)).toBe(1)
    expect(seen.success).toBe(true)
    expect(seen.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'exact', path: 'keyboard' })

    field = { ...newField(), value: 'old text', readBack: () => 'old text' }
    focused.isExisting.mockResolvedValueOnce(false)
    const left = await clear('Username')

    expect(left.success).toBe(false)
    expect(left.error).toBe('field still reads "old text" after clearing — re-observe and retry')
    expect(left.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'mismatch', path: 'keyboard' })
  })

  it('a clear interrupted by a driver error is reported and not repeated', async () => {
    field.value = 'old text'
    field.clearThrows = true

    const native = await clear('Username')

    expect(count('clearValue')).toBe(1)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(native.success).toBe(false)
    expect(native.error).toMatch(/clearText was interrupted/)
    expect(native.error).toMatch(/not cleared again/)
    expect(native.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'native',
    })

    field = { ...newField(), value: 'old text', focusHidden: true, pressKeyError: 'socket hang up' }
    const keyboard = await clear('Username')

    expect(count('execute:mobile: pressKey')).toBe(1)
    expect(count('clearValue')).toBe(0)
    expect(keyboard.success).toBe(false)
    expect(keyboard.error).toMatch(/clearText was interrupted/)
    expect(keyboard.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'keyboard',
    })
  })

  // The same focus-target check as the fill.
  it('a clear whose tap left another field focused clears nothing', async () => {
    field.value = 'pw-kept'
    field.bounds = '[100,400][980,500]'

    const result = await clear('Username')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(
      /^clearText: after tapping \S+, input focus is on another field; nothing was cleared\. Input is never sent to a field other than the target\. Re-observe and target the field itself\.$/,
    )
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'clearText',
      cause: 'not-editable',
      evidence: 'focus-elsewhere',
    })
    expect(result.metadata).not.toHaveProperty('fillVerdict')
    expect(result.metadata).not.toHaveProperty('fillSubmit')
    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(count(CTRL_A)).toBe(0)
    expect(count(DEL)).toBe(0)
    expect(driver.keys).not.toHaveBeenCalled()
    expect(field.value).toBe('pw-kept')
    expect(count(`$:${FOCUSED_XPATH}`)).toBe(1)
  })

  it('a clear whose field moved after the tap clears nothing', async () => {
    pageXml = ANDROID_XML.replace('bounds="[100,250][980,350]"', 'bounds="[100,1500][980,1600]"')
    field.value = 'old text'
    field.bounds = '[100,1100][980,1200]'

    const result = await clear('Username')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(
      /^clearText: after tapping \S+, the focused field is no longer where it was observed; nothing was cleared\. Re-observe and target the field where it is now\.$/,
    )
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'clearText',
      cause: 'target-not-found',
      evidence: 'stale-target',
    })
    expect(result.metadata).not.toHaveProperty('fillVerdict')
    expect(result.metadata).not.toHaveProperty('fillSubmit')
    expect(focused.clearValue).not.toHaveBeenCalled()
    expect(count(CTRL_A)).toBe(0)
    expect(count(DEL)).toBe(0)
    expect(driver.keys).not.toHaveBeenCalled()
    expect(field.value).toBe('old text')
  })

  it("a clear within the ref's bounds and a keyboard clear are unchanged", async () => {
    field.value = 'old text'
    field.bounds = '[101,251][979,349]'

    const native = await clear('Username')

    expect(count('clearValue')).toBe(1)
    expect(count(`$:${FOCUSED_XPATH}`)).toBe(1)
    expect(field.value).toBe('')
    expect(native.success).toBe(true)
    expect(native.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'exact', path: 'native' })

    field = { ...newField(), value: 'old text', focusHidden: true }
    const keyboard = await clear('Username')

    expect(calls).toEqual(['tap', `$:${FOCUSED_XPATH}`, CTRL_A, DEL, `$:${FOCUSED_XPATH}`])
    expect(focused.clearValue).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('')
    expect(keyboard.success).toBe(true)
    expect(keyboard.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'keyboard',
    })
  })
})

describe('every fill delivers its text through one path and presses Enter at most once', () => {
  it('a native setValue that throws is never typed again', async () => {
    field.setValueThrows = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count('setValue:')).toBe(1)
    expect(count('addValue:')).toBe(0)
    expect(count('keys:')).toBe(0)
    expect(count('execute:mobile: type')).toBe(0)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/typing was interrupted/)
    expect(result.error).toMatch(/may hold part of the text/)
    expect(result.error).toMatch(/not typed again/)
    expect(result.error).not.toContain('hello')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'native' })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
  })

  it('a native setValue that throws without a submit records no fillSubmit', async () => {
    field.setValueThrows = true

    const result = await fill('Username', 'hello')

    expect(count('keys:')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.metadata).not.toHaveProperty('fillSubmit')
  })

  it('a focus lookup that throws chooses the keyboard path before any text is delivered', async () => {
    field.focusThrows = true

    const result = await fill('Username', 'hello')

    expect(focused.setValue).not.toHaveBeenCalled()
    expect(focused.addValue).not.toHaveBeenCalled()
    expect(count('keys:') + count('execute:mobile: type')).toBe(1)
    expect(calls.findIndex((c) => c.startsWith('keys:') || c.startsWith('execute:mobile: type')))
      .toBeGreaterThan(calls.indexOf(`$:${FOCUSED_XPATH}`))
    expect(result.metadata?.fillVerdict).not.toEqual(expect.objectContaining({ path: 'native' }))
  })

  it('a replace fill run twice leaves the text once and presses Enter once per fill', async () => {
    field.value = 'stale'

    const first = await fill('Username', 'hello', { submit: true })
    const firstEnters = count('execute:mobile: pressKey')
    const second = await fill('Username', 'hello', { submit: true })
    const secondEnters = count('execute:mobile: pressKey')

    expect(field.value).toBe('hello')
    expect(focused.setValue.mock.calls).toEqual([['hello'], ['hello']])
    expect(first.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    expect(second.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'native' })
    expect(firstEnters + secondEnters).toBe(2)
    expect(firstEnters).toBe(1)
    expect(secondEnters).toBe(1)
  })

  it('a mobile: type that throws is not retried', async () => {
    await webView({ value: 'stale', typeThrows: true })

    const result = await fill('Email', 'hello', { submit: true })

    expect(count('execute:mobile: type')).toBe(1)
    expect(calls.filter((c) => c.startsWith('keys:'))).toEqual([
      'keys:["Control","a"]',
      'keys:["Backspace"]',
    ])
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(count('script:read')).toBe(0)
    expect(calls.at(-1)).toBe(`switch:${WEB_CTX}`)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/typing was interrupted/)
    expect(result.error).toMatch(/not typed again/)
    expect(result.error).not.toContain('hello')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'webview' })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
  })

  it('a keyboard-path mobile: type that throws is not retried', async () => {
    field.value = 'stale'
    field.focusHidden = true
    field.typeThrows = true

    const result = await fill('Username', 'hello', { submit: true })

    expect(count('execute:mobile: type')).toBe(1)
    expect(driver.keys).not.toHaveBeenCalled()
    expect(count(PRESS_ENTER)).toBe(0)
    expect(focused.setValue).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/typing was interrupted/)
    expect(result.error).toMatch(/not typed again/)
    expect(result.error).not.toContain('hello')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'keyboard' })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
  })

  it('a WebView key input that throws ends the fill before typing', async () => {
    await webView({ value: 'stale', keysThrow: true })

    const result = await fill('Email', 'hello', { submit: true })

    expect(count('keys:')).toBe(1)
    expect(count('execute:mobile: type')).toBe(0)
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'webview' })
  })

  it('a WebView clear whose key input throws is not repeated', async () => {
    await webView({ value: 'old', keysThrow: true })

    const result = await clear('Email')

    expect(count('keys:')).toBe(1)
    expect(count('script:read')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/clearText was interrupted/)
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'webview',
    })
  })

  it('a WebView replace fill run twice leaves the text once and presses Enter once per fill', async () => {
    await webView({ value: 'stale' })

    await fill('Email', 'hello', { submit: true })
    const firstEnters = count(PRESS_ENTER)
    await fill('Email', 'hello', { submit: true })
    const secondEnters = count(PRESS_ENTER)

    expect(web!.value).toBe('hello')
    expect(firstEnters).toBe(1)
    expect(secondEnters).toBe(1)
  })
})

// Acts like a user: no page script writes the field or builds a key event.
describe('fill on the WebView path', () => {
  const WRITES_OR_EVENTS = [
    /\.(value|innerText|textContent|innerHTML|outerHTML)\s*(\+?=)(?!=)/,
    /dispatchEvent/,
    /KeyboardEvent/,
    /InputEvent/,
    /new\s+Event\b/,
    /execCommand|setRangeText/,
  ]

  it('a replace with submit is tap, probe, Ctrl+A, Backspace, typing, read-back, one Enter, in that order', async () => {
    await webView({ value: 'stale' })

    const result = await fill('Email', 'hello', { submit: true })

    expect(calls).toEqual([
      'tap',
      'script:probe:111,41',
      'keys:["Control","a"]',
      'keys:["Backspace"]',
      'switch:NATIVE_APP',
      'execute:mobile: type:{"text":"hello"}',
      `switch:${WEB_CTX}`,
      'script:read',
      ...WEB_PRESS_ENTER,
    ])
    expect(taps).toEqual([{ ctx: WEB_CTX, move: { x: 111, y: 41, origin: 'viewport' } }])
    expect(driver.action).toHaveBeenCalledWith('pointer', { parameters: { pointerType: 'touch' } })
    expect(web!.value).toBe('hello')
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'webview' })
    expect(result.metadata?.fillReread).toEqual({ expected: 'hello', actual: 'hello' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
  })

  it('no executed script writes a value or builds a key event', async () => {
    await webView({ value: 'stale' })

    await fill('Email', 'hello', { submit: true })
    const executed = [...scripts]
    await fill('Email', ' world', { clearMode: 'append', submit: true })
    executed.push(...scripts)

    for (const source of executed) {
      for (const pattern of WRITES_OR_EVENTS) expect(source).not.toMatch(pattern)
    }
    expect(executed.length).toBeGreaterThanOrEqual(4)
  })

  it('an unreadable read-back still sends Enter once', async () => {
    await webView({ readBack: () => null })

    const result = await fill('Email', 'hello', { submit: true })

    expect(count(PRESS_ENTER)).toBe(1)
    expect(calls.indexOf(PRESS_ENTER)).toBeGreaterThan(calls.indexOf('script:read'))
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'webview' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(result.metadata).not.toHaveProperty('fillReread')
  })

  it('a mismatch holds Enter', async () => {
    await webView({ readBack: () => 'helo' })

    const result = await fill('Email', 'hello', { submit: true })

    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(false)
    expect(result.error).toBe('field reads "helo" after typing "hello" — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'mismatch', path: 'webview' })
    expect(result.metadata?.fillSubmit).toEqual({ sent: false, outcome: 'not-sent', reason: 'mismatch' })
  })

  const FOCUS_MISS =
    'fill: the tap on e1 did not focus an editable field; nothing was typed. '
    + 'Target the input itself and try again.'

  function expectNothingTyped(): void {
    expect(count('keys:')).toBe(0)
    expect(count('execute:mobile: type')).toBe(0)
    expect(count('execute:mobile: pressKey')).toBe(0)
  }

  it('a tap that focuses body writes nothing', async () => {
    await webView({ editable: false, matches: true, value: 'kept' })

    const result = await fill('Email', 'hello', { submit: true })

    expect(calls).toEqual([
      'tap',
      'script:probe:111,41',
      'pause:300',
      'script:probe:111,41',
      'pause:300',
      'script:probe:111,41',
    ])
    expectNothingTyped()
    expect(web!.value).toBe('kept')
    expect(result.success).toBe(false)
    expect(result.error).toBe(FOCUS_MISS)
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'no-keyboard-focus',
    })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
    expect(result.metadata).not.toHaveProperty('fillVerdict')
  })

  it('a tap that focuses a different editable field writes nothing', async () => {
    await webView({ editable: true, matches: false })

    const result = await fill('Email', 'hello')

    expectNothingTyped()
    expect(result.success).toBe(false)
    expect(result.error).toBe(FOCUS_MISS)
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'focus-elsewhere',
    })
    expect(result.metadata).not.toHaveProperty('fillSubmit')
  })

  const PROBE = 'script:probe:111,41'
  const NOT_FOCUSED = { editable: false, matches: true }

  it('a focus that lands on the second probe is typed once, with no refusal', async () => {
    await webView({ value: 'stale', probes: [NOT_FOCUSED] })

    const result = await fill('Email', 'hello', { submit: true })

    expect(calls).toEqual([
      'tap',
      PROBE,
      'pause:300',
      PROBE,
      'keys:["Control","a"]',
      'keys:["Backspace"]',
      'switch:NATIVE_APP',
      'execute:mobile: type:{"text":"hello"}',
      `switch:${WEB_CTX}`,
      'script:read',
      ...WEB_PRESS_ENTER,
    ])
    expect(driver.pause).toHaveBeenCalledTimes(1)
    expect(driver.pause).toHaveBeenCalledWith(300)
    expect(count('execute:mobile: type')).toBe(1)
    expect(web!.value).toBe('hello')
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'webview' })
    expect(result.metadata).not.toHaveProperty('fillRefusal')
  })

  it('a focus that never lands is refused after three probes with nothing typed', async () => {
    await webView({ editable: false, matches: true, value: 'kept' })

    const result = await fill('Email', 'hello', { submit: true })

    expect(calls).toEqual(['tap', PROBE, 'pause:300', PROBE, 'pause:300', PROBE])
    expectNothingTyped()
    expect(web!.value).toBe('kept')
    expect(result.success).toBe(false)
    expect(result.error).toBe(FOCUS_MISS)
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'no-keyboard-focus',
    })

    web = { ...newWebField(), matches: false, probes: [NOT_FOCUSED, NOT_FOCUSED] }
    const elsewhere = await fill('Email', 'hello')

    expect(count(PROBE)).toBe(3)
    expectNothingTyped()
    expect(elsewhere.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'focus-elsewhere',
    })
  })

  it('a WebView clear waits for focus the same way', async () => {
    await webView({ value: 'old text', probes: [NOT_FOCUSED] })

    const cleared = await clear('Email')

    expect(calls).toEqual([
      'tap',
      PROBE,
      'pause:300',
      PROBE,
      'keys:["Control","a"]',
      'keys:["Backspace"]',
      'script:read',
    ])
    expect(web!.value).toBe('')
    expect(cleared.success).toBe(true)
    expect(cleared.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'exact', path: 'webview' })

    web = { ...newWebField(), editable: false, value: 'kept' }
    const missed = await clear('Email')

    expect(calls).toEqual(['tap', PROBE, 'pause:300', PROBE, 'pause:300', PROBE])
    expect(count('keys:')).toBe(0)
    expect(web!.value).toBe('kept')
    expect(missed.success).toBe(false)
    expect(missed.metadata?.fillRefusal).toEqual({
      verb: 'clearText',
      cause: 'not-editable',
      evidence: 'no-keyboard-focus',
    })
  })

  it('a probe that throws on every poll ends in a refusal with nothing typed', async () => {
    await webView({ value: 'kept', probeThrows: true })

    const result = await fill('Email', 'hello', { submit: true })

    expect(count(PROBE)).toBe(3)
    expectNothingTyped()
    expect(web!.value).toBe('kept')
    expect(result.success).toBe(false)
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'not-editable',
      evidence: 'no-keyboard-focus',
    })
    expect(result.metadata).not.toHaveProperty('fillVerdict')
  })

  it('a WebView fill with late focus run twice types once per fill and presses Enter once per fill', async () => {
    await webView({ value: 'stale', probes: [NOT_FOCUSED] })

    await fill('Email', 'hello', { submit: true })
    const first = { types: count('execute:mobile: type'), enters: count(PRESS_ENTER), pauses: count('pause:') }
    web!.probes = [NOT_FOCUSED]
    await fill('Email', 'hello', { submit: true })
    const second = { types: count('execute:mobile: type'), enters: count(PRESS_ENTER), pauses: count('pause:') }

    expect(web!.value).toBe('hello')
    expect(first).toEqual({ types: 1, enters: 1, pauses: 1 })
    expect(second).toEqual({ types: 1, enters: 1, pauses: 1 })
  })

  it('append moves the caret to the end and keeps the prior text', async () => {
    await webView({ value: 'Hello' })

    const result = await fill('Email', ' world', { clearMode: 'append' })

    expect(calls.filter((c) => c.startsWith('keys:'))).toEqual(['keys:["End"]'])
    expect(calls.indexOf('keys:["End"]')).toBeLessThan(calls.indexOf('execute:mobile: type:{"text":" world"}'))
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'webview' })
    expect(result.metadata?.fillReread).toEqual({ expected: 'Hello world', actual: 'Hello world' })

    web = { ...newWebField(), multiline: true, value: 'line one' }
    const textarea = await fill('Email', '\nline two', { clearMode: 'append' })

    expect(calls.filter((c) => c.startsWith('keys:'))).toEqual(['keys:["Control","End"]'])
    expect(textarea.metadata?.fillReread).toEqual({
      expected: 'line one\nline two',
      actual: 'line one\nline two',
    })
  })

  it('an append whose prior value is unreadable is unverified', async () => {
    await webView({ value: 'Hello', probeValue: null })

    const result = await fill('Email', ' world', { clearMode: 'append', submit: true })

    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'unverified', path: 'webview' })
    expect(count(PRESS_ENTER)).toBe(1)
  })

  it('a textarea never gets Enter', async () => {
    const text = 'line one\n\nline three\n  indented\ttab |;," end  '
    await webView({ multiline: true })

    const result = await fill('Email', text, { submit: true })

    expect(calls.filter((c) => c.startsWith('execute:mobile: type'))).toEqual([
      `execute:mobile: type:${JSON.stringify({ text })}`,
    ])
    expect(count('execute:mobile: pressKey')).toBe(0)
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'webview' })
    expect(result.metadata?.fillReread).toEqual({ expected: text, actual: text })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'multi-line-field',
    })
    expect(result.data).toBe(
      'submit not sent: Return would add a new line in this multi-line field; tap its send or submit control',
    )
  })

  it.each([
    ['a newline', 'l1\nl2'],
    ['a carriage return', 'l1\rl2'],
  ])('line breaks into an INPUT are refused before any key input (%s)', async (_label, text) => {
    await webView({ multiline: false, value: 'kept' })

    const result = await fill('Email', text, { submit: true })

    expectNothingTyped()
    expect(web!.value).toBe('kept')
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'fill: this field is single-line and the text has line breaks; nothing was typed. '
        + 'Send the text without line breaks, or use a multi-line field.',
    )
    expect(result.metadata?.fillRefusal).toEqual({
      verb: 'fill',
      cause: 'single-line-field',
      evidence: 'text-has-line-breaks',
    })
    expect(result.metadata?.fillSubmit).toEqual({
      sent: false,
      outcome: 'not-sent',
      reason: 'input-failed',
    })
  })

  it('a password field is never exact', async () => {
    await webView({ secure: true })

    const result = await fill('Email', 'topSecretPw', { submit: true })

    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'fill',
      verdict: 'unverified',
      path: 'webview',
      secure: true,
    })
    expect(result.metadata?.fillSubmit).toEqual({ sent: true, outcome: 'sent' })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it('a secure WebView clear that leaves text is a mismatch', async () => {
    await webView({ secure: true, value: 'topSecretPw', readBack: () => 'topSecretPw' })

    const result = await clear('Email')

    expect(count('keys:')).toBe(2)
    expect(result.success).toBe(false)
    expect(result.error).toBe('field still reads "<len:11>" after clearing — re-observe and retry')
    expect(result.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'mismatch',
      path: 'webview',
      secure: true,
    })
    expect(result.metadata?.fillReread).toEqual({ expected: '<len:0>', actual: '<len:11>' })
    expect(JSON.stringify(result)).not.toContain('topSecretPw')
  })

  it.each([
    ['leading and trailing spaces and tabs', '\t  lead and trail  \t'],
    ['commas, semicolons, pipes and quotes', `a,b;c|d "q" 's'`],
    ['accented, CJK and emoji characters', 'é ü 中文 😀'],
  ])('single-line whitespace, punctuation and non-ASCII texts reach mobile: type exactly once: %s', async (_label, text) => {
    await webView()

    const result = await fill('Email', text)

    expect(calls.filter((c) => c.startsWith('execute:mobile: type'))).toEqual([
      `execute:mobile: type:${JSON.stringify({ text })}`,
    ])
    expect(result.success).toBe(true)
    expect(result.metadata?.fillVerdict).toEqual({ verb: 'fill', verdict: 'exact', path: 'webview' })
    expect(result.metadata?.fillReread).toEqual({ expected: text, actual: text })
  })

  it('a WebView clearText clears the named field by keys and reads it back', async () => {
    await webView({ value: 'old text' })

    const cleared = await clear('Email')

    expect(calls).toEqual([
      'tap',
      'script:probe:111,41',
      'keys:["Control","a"]',
      'keys:["Backspace"]',
      'script:read',
    ])
    expect(taps).toEqual([{ ctx: WEB_CTX, move: { x: 111, y: 41, origin: 'viewport' } }])
    expect(web!.value).toBe('')
    expect(cleared.success).toBe(true)
    expect(cleared.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'exact', path: 'webview' })

    web = { ...newWebField(), value: 'x', readBack: () => 'x' }
    const left = await clear('Email')

    expect(left.success).toBe(false)
    expect(left.error).toBe('field still reads "x" after clearing — re-observe and retry')
    expect(left.metadata?.fillVerdict).toEqual({ verb: 'clearText', verdict: 'mismatch', path: 'webview' })

    web = { ...newWebField(), value: 'x', readBack: () => null }
    const unreadable = await clear('Email')

    expect(unreadable.success).toBe(true)
    expect(unreadable.metadata?.fillVerdict).toEqual({
      verb: 'clearText',
      verdict: 'unverified',
      path: 'webview',
    })

    web = { ...newWebField(), editable: false, value: 'kept' }
    const missed = await clear('Email')

    expect(count('keys:')).toBe(0)
    expect(web!.value).toBe('kept')
    expect(missed.success).toBe(false)
    expect(missed.error).toBe(
      'clearText: the tap on e1 did not focus an editable field; nothing was cleared. '
        + 'Target the input itself and try again.',
    )
    expect(missed.metadata?.fillRefusal).toEqual({
      verb: 'clearText',
      cause: 'not-editable',
      evidence: 'no-keyboard-focus',
    })
  })

  it('every WebView script in the fill and clear paths only reads', async () => {
    await webView({ value: 'Hello', multiline: true })

    await fill('Email', ' world', { clearMode: 'append', submit: true })
    const executed = [...scripts]
    await clear('Email')
    executed.push(...scripts)

    for (const source of executed) {
      for (const pattern of WRITES_OR_EVENTS) expect(source).not.toMatch(pattern)
    }
    expect(executed.length).toBeGreaterThanOrEqual(4)
  })
})
