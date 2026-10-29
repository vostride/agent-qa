// @vitest-environment jsdom

// THE ONE MODEL WORKSPACE (429-23 · D-10, D-11, D-17, D-18 · UI-SPEC S4, E4 · PXH-CONF-02).
//
// Every model is one row that opens in place, with one honest status word read from the
// credential-status answer and the provider's label. A test result exists only after a test runs
// here, and the line shows the latest test's answer; Make default is a routine autosave.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelList } from '@/components/config-manager/model-list'
import { ConfigAutosaveProvider, useConfigAutosave, type ConfigAutosave } from '@/hooks/use-config-autosave'
import {
  applyConfigChanges,
  fetchAuthStatus,
  fetchConfig,
  fetchConfigRevision,
  fetchLLMProviders,
  testLLMConnection,
  type AuthCredentialInfo,
  type LLMTestResult,
  type LLMProviderMetadata,
} from '@/lib/api'
import {
  ADD_MODEL_LABEL,
  DEFAULT_BADGE,
  MAKE_DEFAULT_LABEL,
  MODEL_STATUS_WORDS,
  NO_DEFAULT_TEXT,
  NO_MODELS_TEXT,
  TEST_CONNECTION_LABEL,
  TEST_RESULT_TEXT,
  connectionSentence,
  fixedFactsLine,
  modelLine,
  providerErrorSentence,
} from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
  fetchAuthStatus: vi.fn(),
  fetchLLMProviders: vi.fn(),
  testLLMConnection: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/agent-qa.config.yaml'
const HOUR = 60 * 60 * 1000

const PROVIDERS: LLMProviderMetadata[] = [
  { id: 'openai-compatible', label: 'OpenAI-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true }, needsBaseURL: true },
  { id: 'anthropic-compatible', label: 'Anthropic-compatible', auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true }, needsBaseURL: true },
  { id: 'gemini', label: 'Gemini', auth: { kind: 'api-key', credentialTypes: ['api-key'] }, needsBaseURL: false },
  { id: 'openai-subscription', label: 'ChatGPT plan', auth: { kind: 'oauth-plugin', mode: 'browser-poll' } },
  { id: 'anthropic-subscription', label: 'Claude plan', auth: { kind: 'oauth-plugin', mode: 'manual-code' } },
]

const LLMS = [
  { name: 'gpt-5.6', provider: 'openai-subscription', model: 'gpt-5.6' },
  { name: 'flash', provider: 'gemini', model: 'gemini-2.5-flash' },
  { name: 'router', provider: 'openai-compatible', model: 'openrouter/auto', baseURL: 'https://openrouter.ai/api/v1' },
  { name: 'sonnet', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
]

function credentials(): AuthCredentialInfo[] {
  return [
    { configName: 'gpt-5.6', provider: 'openai-subscription', type: 'oauth', expires: Date.now() + HOUR, source: 'auth' },
    { configName: 'flash', provider: 'gemini', type: 'api', expires: null, source: 'auth' },
    { configName: 'sonnet', provider: 'anthropic-subscription', type: 'oauth', expires: Date.now() - HOUR, source: 'auth' },
    // Same name, other provider: never counts for the row.
    { configName: 'router', provider: 'gemini', type: 'api', expires: null, source: 'auth' },
  ]
}

function modelsConfig(llms: readonly Record<string, unknown>[], defaultName?: string) {
  return {
    registry: { llms },
    use: defaultName === undefined ? {} : { llm: defaultName },
  }
}

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_PATH, lines: [] } }
}

let hook: ConfigAutosave | undefined

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location" data-pathname={location.pathname} data-search={location.search} />
}

function Harness() {
  const autosave = useConfigAutosave()
  hook = autosave
  if (autosave.load.kind !== 'ready') return null
  return (
    <ConfigAutosaveProvider value={autosave}>
      <section data-config-section="models">
        <ModelList config={autosave.load.answer.config} onConfigChange={autosave.refresh} />
      </section>
    </ConfigAutosaveProvider>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/config/models']}>
        <LocationProbe />
        <Routes>
          <Route path="/config/:tab" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

async function unmount() {
  if (root) {
    await act(async () => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  hook = undefined
}

function location() {
  const probe = container?.querySelector('[data-testid="location"]')
  return { pathname: probe?.getAttribute('data-pathname'), search: probe?.getAttribute('data-search') }
}

function rows() {
  return Array.from(container?.querySelectorAll('[data-model-list] > li[data-model-row]') ?? []) as HTMLLIElement[]
}

function row(name: string) {
  return rows().find((item) => item.getAttribute('data-model-name') === name) ?? null
}

function toggle(item: Element | null) {
  return (item?.querySelector('[data-model-row-toggle]') ?? null) as HTMLButtonElement | null
}

function buttonsNamed(scope: ParentNode | null | undefined, text: string) {
  return (Array.from(scope?.querySelectorAll('button') ?? []) as HTMLButtonElement[]).filter(
    (button) => button.textContent?.trim() === text,
  )
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const STATUS_WORDS = Object.values(MODEL_STATUS_WORDS)

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig(LLMS, 'flash')) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
  vi.mocked(fetchAuthStatus).mockResolvedValue({ credentials: credentials() })
  vi.mocked(fetchLLMProviders).mockResolvedValue({ providers: PROVIDERS })
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('ModelList closed rows', () => {
  it('ONE-STATUS-WORD-PER-ROW: signed in, key saved, not connected and sign-in expired read one word each, with one Default badge', async () => {
    const auth = deferred<{ credentials: AuthCredentialInfo[] }>()
    vi.mocked(fetchAuthStatus).mockReturnValueOnce(auth.promise)
    await mount()

    // The list waits for the credential-status read, so no row ever claims a status it has not read.
    expect(container!.querySelector('[data-model-list]')).toBeNull()
    await act(async () => {
      auth.resolve({ credentials: credentials() })
    })
    await flush()

    expect(rows().map((item) => item.getAttribute('data-model-name'))).toEqual(['gpt-5.6', 'flash', 'router', 'sonnet'])
    expect(rows().map((item) => item.getAttribute('data-model-status'))).toEqual([
      'signed-in',
      'key-saved',
      'not-connected',
      'sign-in-expired',
    ])
    for (const item of rows()) {
      const status = item.querySelector('[data-model-row-status]')!
      const words = STATUS_WORDS.filter((word) => status.textContent?.includes(word))
      expect(words, item.getAttribute('data-model-name')!).toEqual([
        MODEL_STATUS_WORDS[item.getAttribute('data-model-status') as keyof typeof MODEL_STATUS_WORDS],
      ])
      expect(toggle(item)?.getAttribute('aria-expanded')).toBe('false')
    }

    const expired = row('sonnet')!.querySelector('[data-model-row-status]')!
    expect(expired.querySelector('svg')?.getAttribute('class')).toContain('lucide-triangle-alert')
    expect(expired.querySelector('svg')?.getAttribute('class')).toContain('text-amber-500')
    expect(row('flash')!.querySelector('[data-model-row-status] svg')).toBeNull()

    const badges = container!.querySelectorAll('[data-model-default-badge]')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe(DEFAULT_BADGE)
    expect(row('flash')!.contains(badges[0])).toBe(true)
    expect(row('flash')!.getAttribute('data-model-default')).toBe('true')
    expect(row('router')!.hasAttribute('data-model-default')).toBe(false)
  })

  it('PROVIDER-LABELS-NOT-IDS: the model line reads the model and the provider label, full text in title, and names wrap anywhere', async () => {
    await mount()
    expect(rows()).toHaveLength(4)

    const cases: [string, string, string][] = [
      ['gpt-5.6', 'gpt-5.6', 'ChatGPT plan'],
      ['flash', 'gemini-2.5-flash', 'Gemini'],
      ['router', 'openrouter/auto', 'OpenAI-compatible'],
      ['sonnet', 'claude-sonnet-4-20250514', 'Claude plan'],
    ]
    for (const [name, model, label] of cases) {
      const line = row(name)!.querySelector('[data-model-row-model]')!
      expect(line.textContent).toBe(modelLine(model, label))
      expect(line.getAttribute('title')).toBe(modelLine(model, label))
      expect(line.getAttribute('class')).toContain('truncate')
      const nameSpan = row(name)!.querySelector('[data-model-row-name]')!
      expect(nameSpan.textContent).toBe(name)
      expect(nameSpan.getAttribute('class')).toContain('wrap-anywhere')
      expect(nameSpan.getAttribute('class')).toContain('font-mono')
    }
    const text = container!.querySelector('[data-model-list]')!.textContent ?? ''
    for (const id of ['openai-subscription', 'anthropic-subscription', 'openai-compatible', 'gemini ']) {
      expect(text).not.toContain(id)
    }
    expect(text).not.toMatch(/\brole\b/i)
  })

  it('STATUS-READ-FAILURE-NOT-CONNECTED: a failed credential-status read shows every row Not connected and keeps the rest of the section', async () => {
    vi.mocked(fetchAuthStatus).mockRejectedValueOnce(new Error('auth store unreadable'))
    await mount()

    expect(rows()).toHaveLength(4)
    expect(rows().map((item) => item.getAttribute('data-model-status'))).toEqual([
      'not-connected',
      'not-connected',
      'not-connected',
      'not-connected',
    ])
    const text = container!.querySelector('[data-model-list]')!.textContent ?? ''
    expect(text).not.toContain(MODEL_STATUS_WORDS['signed-in'])
    expect(text).not.toContain(MODEL_STATUS_WORDS['key-saved'])
    expect(text).not.toContain(MODEL_STATUS_WORDS['sign-in-expired'])
    expect(container!.querySelectorAll('[data-model-default-badge]')).toHaveLength(1)
  })

  it('NO-DEFAULT-LINE: with models and no default, or a default naming no model, one amber line sits above the list', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(answer(modelsConfig(LLMS)) as never)
    await mount()

    let line = container!.querySelector('[data-no-default]')
    expect(line?.textContent).toBe(NO_DEFAULT_TEXT)
    expect(line?.querySelector('svg')?.getAttribute('class')).toContain('lucide-triangle-alert')
    expect(line?.querySelector('svg')?.getAttribute('class')).toContain('text-amber-500')
    expect(line?.compareDocumentPosition(container!.querySelector('[data-model-list]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(container!.querySelectorAll('[data-model-default-badge]')).toHaveLength(0)
    await unmount()

    vi.mocked(fetchConfig).mockResolvedValueOnce(answer(modelsConfig(LLMS, 'retired')) as never)
    await mount()
    line = container!.querySelector('[data-no-default]')
    expect(line?.textContent).toBe(NO_DEFAULT_TEXT)
    await unmount()

    await mount()
    expect(container!.querySelector('[data-no-default]')).toBeNull()
  })

  it('NO-MODELS-EMPTY-STATE: no models shows one sentence and Add model as the one filled button, and Add model opens the add row', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce(answer(modelsConfig([])) as never)
    await mount()

    const empty = container!.querySelector('[data-models-empty]')
    expect(empty?.textContent).toContain(NO_MODELS_TEXT)
    expect(container!.querySelector('[data-model-list]')).toBeNull()
    expect(container!.querySelector('[data-no-default]')).toBeNull()
    const adds = buttonsNamed(container, ADD_MODEL_LABEL)
    expect(adds).toHaveLength(1)
    expect(empty!.contains(adds[0])).toBe(true)
    expect(adds[0].getAttribute('data-variant')).toBe('default')

    // 429-25 re-target: Add model opens the add row in place (it no longer goes through ?add).
    await click(adds[0])
    expect(container!.querySelector('[data-model-list] > li[data-model-draft]')).not.toBeNull()
    expect(container!.querySelector('[data-models-empty]')).toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    expect(location()).toEqual({ pathname: '/config/models', search: '' })
    await unmount()
    localStorage.clear()

    await mount()
    const headingAdds = buttonsNamed(container, ADD_MODEL_LABEL)
    expect(headingAdds).toHaveLength(1)
    expect(headingAdds[0].getAttribute('data-variant')).toBe('outline')
    expect(headingAdds[0].querySelector('svg')?.getAttribute('class')).toContain('lucide-plus')
    expect(container!.querySelector('[data-models-empty]')).toBeNull()
  })

  it('ROW-OPENS-IN-PLACE: a row header opens its panel inside the same row, one saved row at a time, with no dialog', async () => {
    await mount()

    const first = toggle(row('flash'))
    await click(first)
    expect(toggle(row('flash'))?.getAttribute('aria-expanded')).toBe('true')
    const panelId = toggle(row('flash'))!.getAttribute('aria-controls')
    expect(panelId).toBeTruthy()
    const panel = document.getElementById(panelId!)
    expect(panel?.hasAttribute('data-model-panel')).toBe(true)
    expect(row('flash')!.contains(panel)).toBe(true)
    expect(row('flash')!.getAttribute('data-model-open')).toBe('true')

    await click(toggle(row('router')))
    expect(toggle(row('router'))?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle(row('flash'))?.getAttribute('aria-expanded')).toBe('false')
    expect(row('flash')!.querySelector('[data-model-panel]')).toBeNull()
    expect(container!.querySelectorAll('[data-model-panel]')).toHaveLength(1)

    await click(toggle(row('router')))
    expect(container!.querySelectorAll('[data-model-panel]')).toHaveLength(0)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})

function panelOf(name: string) {
  return row(name)?.querySelector('[data-model-panel]') ?? null
}

function testButton(name: string) {
  return buttonsNamed(panelOf(name), TEST_CONNECTION_LABEL)[0] ?? null
}

function makeDefaultButton(name: string) {
  return buttonsNamed(panelOf(name), MAKE_DEFAULT_LABEL)[0] ?? null
}

function testLine(name: string) {
  return (row(name)?.querySelector('[data-test-result]') ?? null) as HTMLElement | null
}

async function openModel(name: string) {
  if (toggle(row(name))?.getAttribute('aria-expanded') !== 'true') await click(toggle(row(name)))
  expect(panelOf(name), name).not.toBeNull()
}

describe('ModelRow connection block', () => {
  it('TEST-LINE-STATES: Test connection reads Testing, then Connected with no number, the server sentence verbatim when it fails, or Connected without a key', async () => {
    await mount()
    await openModel('router')

    expect(panelOf('router')!.querySelector('[data-model-connection]')?.textContent).toContain(
      connectionSentence('not-connected', 'OpenAI-compatible', { signIn: false, keyOptional: true }),
    )
    expect(panelOf('router')!.querySelector('[data-model-fixed]')?.textContent).toBe(fixedFactsLine('an OpenAI-compatible API key'))

    const first = deferred<LLMTestResult>()
    vi.mocked(testLLMConnection).mockReturnValueOnce(first.promise)
    await click(testButton('router'))

    expect(testLLMConnection).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      configName: 'router',
    })
    let line = testLine('router')
    expect(line?.getAttribute('data-test-result')).toBe('testing')
    expect(line?.getAttribute('role')).toBe('status')
    expect(line?.getAttribute('aria-live')).toBe('polite')
    expect(line?.textContent).toBe(TEST_RESULT_TEXT.testing)
    expect(testButton('router')?.getAttribute('aria-disabled')).toBe('true')
    expect(testButton('router')?.querySelector('svg')?.getAttribute('class')).toContain('lucide-loader-circle')
    expect(makeDefaultButton('router')?.getAttribute('aria-disabled')).not.toBe('true')

    // Activating the busy button starts nothing.
    await click(testButton('router'))
    expect(testLLMConnection).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ success: true, responseTime: 412, provider: 'openai-compatible', model: 'openrouter/auto' })
    })
    await flush()
    line = testLine('router')
    expect(line?.getAttribute('data-test-result')).toBe('connected')
    expect(line?.textContent).toBe(TEST_RESULT_TEXT.connected)
    expect(line?.textContent).not.toMatch(/\d/)
    expect(line?.querySelector('svg')?.getAttribute('class')).toContain('lucide-circle-check')
    expect(line?.querySelector('svg')?.getAttribute('class')).toContain('text-emerald-500')
    expect(testButton('router')?.getAttribute('aria-disabled')).not.toBe('true')

    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: false,
      error: 'rate_limit',
      message: 'Rate limited. Try again later.',
    })
    await click(testButton('router'))
    line = testLine('router')
    expect(line?.getAttribute('data-test-result')).toBe('failed')
    expect(line?.textContent).toBe('Rate limited. Try again later.')
    expect(line?.querySelector('p')?.getAttribute('class')).toContain('text-destructive')
    expect(line?.querySelector('svg')?.getAttribute('class')).toContain('lucide-circle-x')

    vi.mocked(testLLMConnection).mockResolvedValueOnce({
      success: true,
      unauthenticated: true,
      message: 'Testing without a saved API key.',
    })
    await click(testButton('router'))
    line = testLine('router')
    expect(line?.getAttribute('data-test-result')).toBe('connected-without-key')
    expect(line?.textContent).toBe(TEST_RESULT_TEXT['connected-without-key'])

    vi.mocked(testLLMConnection).mockRejectedValueOnce(new Error('offline'))
    await click(testButton('router'))
    line = testLine('router')
    expect(line?.getAttribute('data-test-result')).toBe('failed')
    expect(line?.textContent).toBe(providerErrorSentence('network_error', ''))
  })

  it('LATEST-TEST-WINS: an older test that answers after a newer one never overwrites the line', async () => {
    await mount()
    const older = deferred<LLMTestResult>()
    const newer = deferred<LLMTestResult>()
    vi.mocked(testLLMConnection).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    await openModel('flash')
    await click(testButton('flash'))
    expect(testLine('flash')?.getAttribute('data-test-result')).toBe('testing')

    // Closing the row drops its line; reopening starts clean, and a new test starts at once.
    await click(toggle(row('flash')))
    await openModel('flash')
    expect(testLine('flash')).toBeNull()
    await click(testButton('flash'))
    expect(testLLMConnection).toHaveBeenCalledTimes(2)
    expect(testLine('flash')?.getAttribute('data-test-result')).toBe('testing')

    await act(async () => {
      newer.resolve({ success: false, error: 'model_not_found', message: 'Model not found. Check the model name.' })
    })
    await flush()
    expect(testLine('flash')?.textContent).toBe('Model not found. Check the model name.')

    await act(async () => {
      older.resolve({ success: true })
    })
    await flush()
    expect(testLine('flash')?.getAttribute('data-test-result')).toBe('failed')
    expect(testLine('flash')?.textContent).toBe('Model not found. Check the model name.')
    expect(testButton('flash')?.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('NO-STORED-TEST-RESULT: a fresh mount shows no test line, and a result lives only until its row closes', async () => {
    await mount()
    for (const name of ['gpt-5.6', 'flash', 'router', 'sonnet']) {
      await openModel(name)
      expect(testLine(name), name).toBeNull()
    }
    expect(testLLMConnection).not.toHaveBeenCalled()

    vi.mocked(testLLMConnection).mockResolvedValue({ success: true })
    await openModel('flash')
    await click(testButton('flash'))
    expect(testLine('flash')?.getAttribute('data-test-result')).toBe('connected')

    await click(toggle(row('flash')))
    await openModel('flash')
    expect(testLine('flash')).toBeNull()

    await click(testButton('flash'))
    expect(testLine('flash')?.getAttribute('data-test-result')).toBe('connected')
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '').join('\n')
    expect(stored).not.toContain(TEST_RESULT_TEXT.connected)
    await unmount()

    await mount()
    await openModel('flash')
    expect(testLine('flash')).toBeNull()
  })

  it('MAKE-DEFAULT-AUTOSAVES: Make default writes the default model once, moves the badge at once and keeps focus on the row header', async () => {
    await mount()
    await openModel('flash')
    expect(makeDefaultButton('flash')).toBeNull()

    await openModel('router')
    const write = deferred<{ revision: string }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(write.promise as never)
    await click(makeDefaultButton('router'))

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([[[{ op: 'set', path: ['use', 'llm'], value: 'router' }]]])
    expect(row('router')!.querySelector('[data-model-default-badge]')).not.toBeNull()
    expect(row('flash')!.querySelector('[data-model-default-badge]')).toBeNull()
    expect(container!.querySelectorAll('[data-model-default-badge]')).toHaveLength(1)
    expect(makeDefaultButton('router')).toBeNull()
    expect(document.activeElement).toBe(toggle(row('router')))
    expect(hook!.status.state).toBe('saving')

    await act(async () => {
      write.resolve({ revision: 'rev-2' })
    })
    await flush()
    expect(hook!.status.state).toBe('saved')
    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
  })
})
