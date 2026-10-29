// @vitest-environment jsdom

// A SAVED MODEL'S ROW, COMPLETED (429-24 · D-12, D-17, D-23, D-24 · UI-SPEC S4, S6, E4, E6).
//
// Deleting a model, signing out and removing a key act at once and offer Undo: no dialog, no
// question. The default model cannot be deleted from under the project, a delete writes only
// that model's change, and a failure puts the row or its status word back.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModelList } from '@/components/config-manager/model-list'
import { ConfigAutosaveProvider, useConfigAutosave, type ConfigAutosave } from '@/hooks/use-config-autosave'
import {
  ApiError,
  applyConfigChanges,
  deleteAuthCredential,
  exchangePluginAuthCode,
  fetchAuthStatus,
  fetchConfig,
  fetchConfigRevision,
  fetchLLMProviders,
  pollPluginAuthResult,
  saveCredential,
  startPluginAuth,
  testLLMConnection,
  undoConfigAction,
  type AuthCredentialInfo,
  type LLMProviderMetadata,
} from '@/lib/api'
import {
  ADD_FLOW_FIELD_LABELS,
  ADD_HEADER_LABEL,
  ADD_MODEL_LABEL,
  DEFAULT_CANNOT_DELETE_LINE,
  DELETE_MODEL_LABEL,
  FIXED_CONNECTION_LABELS,
  KEEP_CURRENT_KEY_LABEL,
  MAKE_DEFAULT_LABEL,
  MODEL_SETTING_HELP,
  MODEL_SETTING_LABELS,
  NEW_KEY_LABEL,
  REMOVE_KEY_LABEL,
  REPLACE_KEY_LABEL,
  SAVE_HEADER_LABEL,
  SAVE_KEY_AND_TEST_LABEL,
  SETTLE_DELAY_MS,
  SIGN_IN_AGAIN_LABEL,
  SIGN_OUT_LABEL,
  TEST_CONNECTION_LABEL,
  TEST_RESULT_TEXT,
  fixedFactsLine,
  undoLine,
} from '@/lib/config-copy'

const API_EXPORTS = Object.keys(await vi.importActual<typeof import('@/lib/api')>('@/lib/api'))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
  fetchAuthStatus: vi.fn(),
  fetchLLMProviders: vi.fn(),
  testLLMConnection: vi.fn(),
  deleteAuthCredential: vi.fn(),
  saveCredential: vi.fn(),
  startPluginAuth: vi.fn(),
  pollPluginAuthResult: vi.fn(),
  exchangePluginAuthCode: vi.fn(),
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

// The credential-status read carries no secret; SECRET is what a leak would look like.
const SECRET = 'sk-live-never-in-the-page'
const HEADER_SECRET = 'org-header-secret'
// The server shows a declared header value as its marker.
const HEADER_MARKER = '[secret:PW_441]'

const PROXY = {
  name: 'claude-proxy',
  provider: 'anthropic-compatible',
  model: 'claude-sonnet-4-20250514',
  baseURL: 'https://proxy.example/anthropic',
  providerHeaders: { 'X-Org': HEADER_MARKER },
}

function credentials(): AuthCredentialInfo[] {
  return [
    { configName: 'gpt-5.6', provider: 'openai-subscription', type: 'oauth', expires: Date.now() + HOUR, source: 'auth' },
    { configName: 'flash', provider: 'gemini', type: 'api', expires: null, source: 'auth' },
    { configName: 'router', provider: 'openai-compatible', type: 'api', expires: null, source: 'auth' },
    { configName: 'sonnet', provider: 'anthropic-subscription', type: 'oauth', expires: Date.now() - HOUR, source: 'auth' },
  ]
}

function modelsConfig(
  llms: readonly Record<string, unknown>[] = LLMS,
  defaultName: string | undefined = 'flash',
) {
  return {
    registry: { llms },
    use: defaultName === undefined ? {} : { llm: defaultName },
  }
}

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_PATH, lines: [] } }
}

let hook: ConfigAutosave | undefined

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

function buttonNamed(scope: ParentNode | null | undefined, text: string) {
  return buttonsNamed(scope, text)[0] ?? null
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

async function openModel(name: string) {
  const header = toggle(row(name))
  expect(header, name).not.toBeNull()
  if (header!.getAttribute('aria-expanded') !== 'true') await click(header)
  return row(name)!.querySelector('[data-model-panel]')
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

function undoTicket(token: string) {
  return { token, expiresAt: Date.now() + 30_000 }
}

function noDialog() {
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  expect(window.confirm).not.toHaveBeenCalled()
}

function status(name: string) {
  return row(name)?.getAttribute('data-model-status')
}

async function type(input: Element | null, value: string) {
  expect(input).not.toBeNull()
  await act(async () => {
    ;(input as HTMLInputElement).focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function waitPastSettle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 3)
  })
  await flush()
}

function field(scope: ParentNode | null | undefined, pattern: string) {
  return scope?.querySelector(`[data-field-path="${pattern}"]`) ?? null
}

function inputIn(scope: ParentNode | null | undefined, pattern: string) {
  return (field(scope, pattern)?.querySelector('input') ?? null) as HTMLInputElement | null
}

function passwordInputs(scope: ParentNode | null | undefined) {
  return Array.from(scope?.querySelectorAll('input[type="password"]') ?? []) as HTMLInputElement[]
}

function writes() {
  return vi.mocked(applyConfigChanges).mock.calls
}

async function undo() {
  await act(async () => {
    await hook!.undo()
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig()) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  // The mocked write answers the polled revision, so a poll does not re-read the unchanged fixture over a landed write.
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-1', undo: undoTicket('undo-config') } as never)
  vi.mocked(undoConfigAction).mockResolvedValue({ restored: true })
  vi.mocked(fetchAuthStatus).mockResolvedValue({ credentials: credentials() })
  vi.mocked(fetchLLMProviders).mockResolvedValue({ providers: PROVIDERS })
  vi.mocked(testLLMConnection).mockResolvedValue({ success: true })
  vi.mocked(deleteAuthCredential).mockResolvedValue({ deleted: true, undo: undoTicket('undo-credential') } as never)
  vi.mocked(saveCredential).mockResolvedValue({ saved: true, created: false } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('ModelRow explicit actions', () => {
  it('DELETE-MODEL-UNDO: Delete model removes the row at once in one undoable write, and Undo brings it back focused', async () => {
    await mount()
    const panel = await openModel('router')
    const write = deferred<{ revision: string; undo: { token: string; expiresAt: number } }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(write.promise as never)
    await click(buttonNamed(panel, DELETE_MODEL_LABEL))

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [
        [
          { op: 'unset', path: ['registry', 'llms', { name: 'router' }] },
        ],
        { undoable: true },
      ],
    ])
    expect(row('router')).toBeNull()
    noDialog()

    await act(async () => {
      write.resolve({ revision: 'rev-2', undo: undoTicket('undo-router') })
    })
    await flush()
    expect(row('router')).toBeNull()
    expect(hook!.status.state).toBe('undo')
    expect(hook!.status.undo?.line).toBe(undoLine('delete-model', 'router'))
    expect(hook!.status.undo?.line).toBe('Deleted router')

    await undo()
    expect(undoConfigAction).toHaveBeenCalledWith('undo-router')
    expect(row('router')).not.toBeNull()
    expect(document.activeElement).toBe(toggle(row('router')))
  })

  it('deleting a model writes only its own change and shows no judge line', async () => {
    await mount()

    const panel = await openModel('router')
    expect(panel?.querySelector('[data-model-judge]')).toBeNull()
    expect(panel?.textContent).not.toContain('judge')

    await click(buttonNamed(row('router'), DELETE_MODEL_LABEL))
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'unset', path: ['registry', 'llms', { name: 'router' }] }], { undoable: true }],
    ])
    const changes = vi.mocked(applyConfigChanges).mock.calls.flatMap(([sent]) => sent as { path: unknown[] }[])
    expect(changes.filter((change) => change.path[0] === 'eval')).toEqual([])
    expect(row('router')).toBeNull()
    expect(hook!.status.undo?.line).toBe('Deleted router')
  })

  it("a delete refused field_changed re-reads once and lands the same model's change", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig(LLMS, 'router')) as never)
    await mount()
    await openModel('flash')
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      new ApiError(409, 'Conflict', { error: 'field_changed', path: ['registry', 'llms'] }),
    )
    await click(buttonNamed(row('flash'), DELETE_MODEL_LABEL))
    await flush()

    const unsetFlash = { op: 'unset', path: ['registry', 'llms', { name: 'flash' }] }
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[unsetFlash], { undoable: true }],
      [[unsetFlash], { undoable: true }],
    ])
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(row('flash')).toBeNull()
    expect(hook!.status.state).toBe('undo')
    expect(hook!.status.undo?.line).toBe(undoLine('delete-model', 'flash'))
  })

  it('FOCUS-AFTER-MODEL-DELETE: focus moves to the next row, else the previous one, else Add model', async () => {
    vi.mocked(applyConfigChanges).mockReturnValue(new Promise(() => {}) as never)
    await mount()

    await openModel('gpt-5.6')
    await click(buttonNamed(row('gpt-5.6'), DELETE_MODEL_LABEL))
    expect(document.activeElement).toBe(toggle(row('flash')))

    await openModel('sonnet')
    await click(buttonNamed(row('sonnet'), DELETE_MODEL_LABEL))
    expect(document.activeElement).toBe(toggle(row('router')))
    await unmount()

    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([LLMS[2]], undefined)) as never)
    await mount()
    await openModel('router')
    await click(buttonNamed(row('router'), DELETE_MODEL_LABEL))
    expect(rows()).toHaveLength(0)
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe(ADD_MODEL_LABEL)
  })

  it('DEFAULT-CANNOT-DELETE: the default row offers no Delete model, only the line, and the others offer both', async () => {
    await mount()
    const panel = await openModel('flash')
    expect(panel?.textContent).toContain(DEFAULT_CANNOT_DELETE_LINE)
    expect(buttonNamed(panel, DELETE_MODEL_LABEL)).toBeNull()

    const other = await openModel('router')
    expect(other?.textContent).not.toContain(DEFAULT_CANNOT_DELETE_LINE)
    expect(buttonNamed(other, DELETE_MODEL_LABEL)).not.toBeNull()
    expect(buttonNamed(other, MAKE_DEFAULT_LABEL)).not.toBeNull()
    await unmount()

    // One model, and it is the default.
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([LLMS[1]], 'flash')) as never)
    await mount()
    const only = await openModel('flash')
    expect(only?.textContent).toContain(DEFAULT_CANNOT_DELETE_LINE)
    expect(buttonNamed(only, DELETE_MODEL_LABEL)).toBeNull()
  })

  it('SIGN-OUT-UNDO: Sign out acts at once through the credential door, and Undo restores the sign-in server-side', async () => {
    await mount()
    const panel = await openModel('gpt-5.6')
    const answered = deferred<{ deleted: boolean; undo: { token: string; expiresAt: number } }>()
    vi.mocked(deleteAuthCredential).mockReturnValueOnce(answered.promise as never)
    await click(buttonNamed(panel, SIGN_OUT_LABEL))

    expect(deleteAuthCredential).toHaveBeenCalledWith('gpt-5.6')
    expect(status('gpt-5.6')).toBe('not-connected')
    expect(applyConfigChanges).not.toHaveBeenCalled()
    noDialog()

    await act(async () => {
      answered.resolve({ deleted: true, undo: undoTicket('undo-signout') })
    })
    await flush()
    expect(hook!.status.state).toBe('undo')
    expect(hook!.status.undo?.line).toBe('Signed out of gpt-5.6')
    expect(container!.innerHTML).not.toContain('undo-signout')
    expect(container!.innerHTML).not.toContain(SECRET)

    await undo()
    expect(undoConfigAction).toHaveBeenCalledWith('undo-signout')
    expect(fetchAuthStatus).toHaveBeenCalledTimes(2)
    expect(status('gpt-5.6')).toBe('signed-in')
  })

  it('REMOVE-KEY-UNDO: Remove key acts at once, says so, and Undo puts the key back server-side', async () => {
    await mount()
    const panel = await openModel('flash')
    await click(buttonNamed(panel, REMOVE_KEY_LABEL))

    expect(deleteAuthCredential).toHaveBeenCalledWith('flash')
    expect(status('flash')).toBe('not-connected')
    expect(hook!.status.undo?.line).toBe('Removed the key for flash')
    expect(container!.innerHTML).not.toContain('undo-credential')
    noDialog()

    await undo()
    expect(undoConfigAction).toHaveBeenCalledWith('undo-credential')
    expect(status('flash')).toBe('key-saved')
  })

  it('EXPLICIT-FAILURE-RESTORES-ROW: a refused delete, sign-out or Undo puts things back and shows the failure', async () => {
    await mount()
    await openModel('router')
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(new Error('disk full'))
    await click(buttonNamed(row('router'), DELETE_MODEL_LABEL))
    expect(row('router')).not.toBeNull()
    expect(hook!.status.state).toBe('failed')
    expect(hook!.status.message).toBe('disk full')

    // Retry re-sends drafts only (UI-SPEC E2): a refused delete is not sent again, and the file shows as it is.
    await act(async () => {
      hook!.retry()
    })
    await flush()
    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(row('router')).not.toBeNull()
    expect(hook!.status.state).toBe('idle')

    await openModel('gpt-5.6')
    vi.mocked(deleteAuthCredential).mockRejectedValueOnce(new Error('auth store locked'))
    await click(buttonNamed(row('gpt-5.6'), SIGN_OUT_LABEL))
    expect(status('gpt-5.6')).toBe('signed-in')
    expect(hook!.status.state).toBe('failed')
    expect(hook!.status.message).toBe('auth store locked')

    await act(async () => {
      hook!.retry()
    })
    await flush()
    expect(deleteAuthCredential).toHaveBeenCalledTimes(1)
    expect(status('gpt-5.6')).toBe('signed-in')
    expect(hook!.status.state).toBe('idle')

    await click(buttonNamed(row('gpt-5.6'), SIGN_OUT_LABEL))
    expect(status('gpt-5.6')).toBe('not-connected')
    expect(hook!.status.state).toBe('undo')

    vi.mocked(undoConfigAction).mockRejectedValueOnce(new Error('expired'))
    await undo()
    expect(hook!.status.state).toBe('failed')
    expect(status('gpt-5.6')).toBe('not-connected')
  })
})

describe('ModelRow key and settings', () => {
  it('REPLACE-KEY-SAVES-THEN-TESTS: the new key saves server-side, then the test runs, and a failed test keeps the key', async () => {
    await mount()
    expect(buttonNamed(await openModel('gpt-5.6'), REPLACE_KEY_LABEL)).toBeNull()

    const panel = await openModel('flash')
    await click(buttonNamed(panel, REPLACE_KEY_LABEL))
    const [input] = passwordInputs(row('flash'))
    expect(input).toBeDefined()
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(NEW_KEY_LABEL)
    expect(document.activeElement).toBe(input)

    await type(input, SECRET)
    await waitPastSettle()
    expect(saveCredential).not.toHaveBeenCalled()
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(hook!.draftTabs.size).toBe(0)
    expect(JSON.stringify(localStorage)).not.toContain(SECRET)

    const saved = deferred<{ saved: boolean; created: boolean }>()
    vi.mocked(saveCredential).mockReturnValueOnce(saved.promise as never)
    vi.mocked(testLLMConnection).mockResolvedValueOnce({ success: false, message: 'The key was refused.' })
    await click(buttonNamed(row('flash'), SAVE_KEY_AND_TEST_LABEL))
    expect(saveCredential).toHaveBeenCalledWith('flash', 'gemini', 'api-key', SECRET)
    expect(testLLMConnection).not.toHaveBeenCalled()

    await act(async () => {
      saved.resolve({ saved: true, created: false })
    })
    await flush()
    expect(testLLMConnection).toHaveBeenCalledTimes(1)
    expect(vi.mocked(testLLMConnection).mock.calls[0][0]).toMatchObject({ configName: 'flash', provider: 'gemini' })
    expect(passwordInputs(row('flash')).every((item) => item.value === '')).toBe(true)
    expect(container!.innerHTML).not.toContain(SECRET)

    const line = row('flash')!.querySelector('[data-test-result]')
    expect(line?.getAttribute('data-test-result')).toBe('failed')
    expect(line?.textContent).toContain('The key was refused.')
    expect(deleteAuthCredential).not.toHaveBeenCalled()
    expect(status('flash')).toBe('key-saved')
    expect(document.activeElement).toBe(buttonNamed(row('flash'), REPLACE_KEY_LABEL))
  })

  it('KEEP-CURRENT-KEY-RESTORES-FOCUS: Keep current key drops the typed key, saves nothing and focuses Replace key', async () => {
    await mount()
    const panel = await openModel('flash')
    await click(buttonNamed(panel, REPLACE_KEY_LABEL))
    await type(passwordInputs(row('flash'))[0], SECRET)

    await click(buttonNamed(row('flash'), KEEP_CURRENT_KEY_LABEL))
    expect(passwordInputs(row('flash'))).toHaveLength(0)
    expect(document.activeElement).toBe(buttonNamed(row('flash'), REPLACE_KEY_LABEL))
    expect(saveCredential).not.toHaveBeenCalled()
    expect(testLLMConnection).not.toHaveBeenCalled()
    expect(container!.innerHTML).not.toContain(SECRET)

    await click(buttonNamed(row('flash'), REPLACE_KEY_LABEL))
    expect(passwordInputs(row('flash'))[0].value).toBe('')
  })

  it('MODEL-SETTINGS-AUTOSAVE: the row settings write by leaf, vision at once, and header values never autosave', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([...LLMS, PROXY])) as never)
    await mount()

    const flash = await openModel('flash')
    expect(field(flash, 'registry.llms[].model')).not.toBeNull()
    expect(field(flash, 'registry.llms[].baseURL')).toBeNull()
    expect(field(flash, 'registry.llms[].providerHeaders')).toBeNull()

    const router = await openModel('router')
    expect(field(router, 'registry.llms[].providerHeaders')).toBeNull()
    await type(inputIn(router, 'registry.llms[].model'), 'openrouter/fast')
    await waitPastSettle()
    await type(inputIn(router, 'registry.llms[].baseURL'), 'https://openrouter.ai/api/v2')
    await waitPastSettle()
    await type(inputIn(router, 'registry.llms[].contextWindow'), '128k')
    await waitPastSettle()
    const leaf = (key: string) => ['registry', 'llms', { name: 'router' }, key]
    expect(writes()).toEqual([
      [[{ op: 'set', path: leaf('model'), value: 'openrouter/fast' }]],
      [[{ op: 'set', path: leaf('baseURL'), value: 'https://openrouter.ai/api/v2' }]],
      [[{ op: 'set', path: leaf('contextWindow'), value: '128k' }]],
    ])

    const vision = field(row('router'), 'registry.llms[].vision')?.querySelector('[role="switch"]') as HTMLElement | null
    expect(vision?.getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      vision!.click()
    })
    expect(writes()[3]).toEqual([[{ op: 'set', path: leaf('vision'), value: false }]])

    const proxy = await openModel('claude-proxy')
    const secret = field(proxy, 'registry.llms[].providerHeaders.*')
    expect(secret?.textContent).toContain(HEADER_MARKER)
    const name = inputIn(proxy, 'registry.llms[].providerHeaders')
    expect(name?.value).toBe('X-Org')
    await type(name, 'X-Team')
    await waitPastSettle()
    const headers = ['registry', 'llms', { name: 'claude-proxy' }, 'providerHeaders']
    expect(writes()[4]).toEqual([[{ op: 'move', from: [...headers, 'X-Org'], path: [...headers, 'X-Team'] }]])
    expect(container!.innerHTML).not.toContain(HEADER_SECRET)
    expect(Array.from(row('claude-proxy')!.querySelectorAll('[data-model-header]')).map((item) => item.getAttribute('data-model-header'))).toEqual(['X-Team'])

    await click(buttonNamed(row('claude-proxy'), ADD_HEADER_LABEL))
    const draft = row('claude-proxy')!.querySelector('[data-header-draft]')
    const [draftName] = Array.from(draft?.querySelectorAll('input:not([type="password"])') ?? []) as HTMLInputElement[]
    const [draftValue] = passwordInputs(draft)
    expect(draftValue?.getAttribute('autocomplete')).toBe('off')
    await type(draftName, 'X-Trace')
    await type(draftValue, 'trace-secret')
    await waitPastSettle()
    expect(writes()).toHaveLength(5)
    expect(JSON.stringify(localStorage)).not.toContain('trace-secret')
    expect(hook!.draftTabs.size).toBe(0)

    await click(buttonNamed(row('claude-proxy'), SAVE_HEADER_LABEL))
    expect(writes()[5]).toEqual([[{ op: 'set', path: [...headers, 'X-Trace'], value: 'trace-secret' }]])
    // the landed write is mirrored as written; the editor has no path-class mask.
    const traceValue = row('claude-proxy')!.querySelector('[data-model-header="X-Trace"] [data-secret-field] code')
    expect(traceValue?.textContent).toBe('trace-secret')
    expect(JSON.stringify(localStorage)).not.toContain('trace-secret')
  })

  it('NAME-AND-PROVIDER-FIXED: the open row states the name and connection as fixed facts and offers no input for them', async () => {
    await mount()
    const panel = await openModel('router')
    expect(panel?.querySelector('[data-model-fixed]')?.textContent).toBe(
      fixedFactsLine(FIXED_CONNECTION_LABELS['openai-compatible']),
    )
    // The row's editable fields are its leaves; name and provider are not among them.
    const paths = Array.from(panel?.querySelectorAll('[data-field-path]') ?? []).map((item) => item.getAttribute('data-field-path'))
    expect(paths).toEqual([
      'registry.llms[].model',
      'registry.llms[].baseURL',
      'registry.llms[].vision',
      'registry.llms[].contextWindow',
    ])
    expect(field(panel, 'registry.llms[].name')).toBeNull()
    expect(field(panel, 'registry.llms[].provider')).toBeNull()
    const values = (Array.from(panel?.querySelectorAll('input') ?? []) as HTMLInputElement[]).map((input) => input.value)
    expect(values).not.toContain('router')
    expect(values).not.toContain('openai-compatible')
    expect(panel?.querySelector('select, [role="combobox"], [role="radio"]')).toBeNull()
  })
})

describe('ModelRow header rename', () => {
  const HEADERS = ['registry', 'llms', { name: 'claude-proxy' }, 'providerHeaders']

  function headerNames() {
    return Array.from(row('claude-proxy')!.querySelectorAll('[data-model-header]')).map((item) =>
      item.getAttribute('data-model-header'),
    )
  }

  it('HEADER-RENAME-NEVER-REVEALS: a header rename is one server-side move, and the page never reads the value', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([...LLMS, PROXY])) as never)
    await mount()
    const proxy = await openModel('claude-proxy')
    await type(inputIn(proxy, 'registry.llms[].providerHeaders'), 'X-Team')
    await waitPastSettle()

    expect(writes()).toEqual([[[{ op: 'move', from: [...HEADERS, 'X-Org'], path: [...HEADERS, 'X-Team'] }]]])
    expect(headerNames()).toEqual(['X-Team'])
    expect(field(row('claude-proxy'), 'registry.llms[].providerHeaders.*')?.textContent).toContain(HEADER_MARKER)
    expect(inputIn(row('claude-proxy'), 'registry.llms[].providerHeaders')?.value).toBe('X-Team')
    expect(container!.innerHTML).not.toContain(HEADER_SECRET)
  })

  it("HEADER-RENAME-NEVER-REVEALS: a refused rename puts the saved name back and says Couldn't save, still without a reveal", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([...LLMS, PROXY])) as never)
    await mount()
    const proxy = await openModel('claude-proxy')
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(new ApiError(422, 'Unprocessable Entity', { error: 'validation_failed' }))
    await type(inputIn(proxy, 'registry.llms[].providerHeaders'), 'X-Team')
    await waitPastSettle()

    expect(writes()).toEqual([[[{ op: 'move', from: [...HEADERS, 'X-Org'], path: [...HEADERS, 'X-Team'] }]]])
    expect(inputIn(row('claude-proxy'), 'registry.llms[].providerHeaders')?.value).toBe('X-Org')
    expect(headerNames()).toEqual(['X-Org'])
    expect(hook!.status.state).toBe('failed')
    expect(container!.innerHTML).not.toContain(HEADER_SECRET)
  })
})

describe('ModelRow Sign in again', () => {
  it('SIGN-IN-AGAIN-SAVED-ROW: an expired or not-connected sign-in row runs the sign-in flow for its saved name, then its test', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
    await mount()
    const signedIn = await openModel('gpt-5.6')
    expect(buttonNamed(signedIn, SIGN_IN_AGAIN_LABEL)).toBeNull()

    const panel = await openModel('sonnet')
    expect(status('sonnet')).toBe('sign-in-expired')
    const again = buttonNamed(panel, SIGN_IN_AGAIN_LABEL)
    expect(again).not.toBeNull()
    expect(again!.getAttribute('data-variant')).toBe('outline')
    expect(again!.getAttribute('data-size')).toBe('sm')
    expect(again!.querySelector('svg')).not.toBeNull()

    vi.mocked(startPluginAuth).mockResolvedValueOnce({ authorizeUrl: 'https://auth.example/claude', sessionId: 'session-1', mode: 'manual-code', created: false })
    await click(again)
    expect(startPluginAuth).toHaveBeenCalledWith('anthropic-subscription', 'sonnet')
    expect(window.open).toHaveBeenCalled()
    const codeInput = row('sonnet')!.querySelector<HTMLInputElement>('[data-sign-in-code] input')
    expect(codeInput?.type).toBe('password')
    await type(codeInput, 'the-code')

    vi.mocked(exchangePluginAuthCode).mockResolvedValueOnce({ status: 'completed', saved: true })
    vi.mocked(fetchAuthStatus).mockClear()
    vi.mocked(testLLMConnection).mockClear()
    await click(row('sonnet')!.querySelector<HTMLButtonElement>('[data-sign-in-code] [data-sign-in-code-connect]'))
    await flush()
    expect(exchangePluginAuthCode).toHaveBeenCalledWith('anthropic-subscription', 'session-1', 'the-code')
    expect(fetchAuthStatus).toHaveBeenCalled()
    expect(testLLMConnection).toHaveBeenCalledTimes(1)
    expect(testLLMConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic-subscription', configName: 'sonnet' }))
    expect(row('sonnet')!.querySelector('[data-test-result="connected"]')).not.toBeNull()
    expect(row('sonnet')!.innerHTML).not.toContain('the-code')
    expect(writes()).toHaveLength(0)
    await unmount()

    vi.mocked(fetchAuthStatus).mockResolvedValue({
      credentials: credentials().filter((credential) => credential.configName !== 'sonnet'),
    })
    await mount()
    const notConnected = await openModel('sonnet')
    expect(status('sonnet')).toBe('not-connected')
    vi.mocked(startPluginAuth).mockResolvedValueOnce({ authorizeUrl: 'https://auth.example/claude', sessionId: 'session-2', mode: 'browser-poll', created: true })
    vi.mocked(pollPluginAuthResult).mockResolvedValueOnce({ status: 'completed', saved: true })
    vi.mocked(testLLMConnection).mockClear()
    await click(buttonNamed(notConnected, SIGN_IN_AGAIN_LABEL))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await flush()
    expect(pollPluginAuthResult).toHaveBeenCalledWith('anthropic-subscription', 'session-2')
    expect(testLLMConnection).toHaveBeenCalledTimes(1)
    expect(testLLMConnection).toHaveBeenCalledWith(expect.objectContaining({ configName: 'sonnet' }))
  })
})

// THE MODEL MODAL'S CLAIMS ON A SAVED ROW. The modal is gone. Each claim its suite
// made about a saved model is asserted here on the open row, or pinned as gone where the phase
// reversed it (the Edit dialog, the Save Changes footer, and the milliseconds on a passed test).

const MODAL_BUTTONS = ['Save Changes', 'Save Credential', 'Keep Credential', 'Delete Credential', 'Delete Configuration', 'Add Configuration']

describe("The model modal's claims on a saved row", () => {
  it('LEGACY-LLM-VISION-AND-CONTEXT-WINDOW: the row edits vision and context window by leaf, with no per-model screenshot sizing', async () => {
    await mount()
    const panel = await openModel('router')
    const vision = field(panel, 'registry.llms[].vision')?.querySelector('[role="switch"]') ?? null
    expect(vision?.getAttribute('aria-checked')).toBe('true')
    expect(inputIn(panel, 'registry.llms[].contextWindow')).not.toBeNull()
    expect(panel?.textContent).toContain(MODEL_SETTING_LABELS.vision)
    expect(panel?.textContent).toContain(MODEL_SETTING_LABELS.contextWindow)
    expect(panel?.textContent).toContain(MODEL_SETTING_HELP.vision)
    expect(panel?.textContent).toContain(MODEL_SETTING_HELP.contextWindow)
    expect(panel?.querySelector('[data-field-path^="services.vision"]')).toBeNull()
    expect(panel?.querySelector('[data-field-path="registry.llms[].effectiveResolution"]')).toBeNull()
    expect(panel?.querySelector('[data-field-path="registry.llms[].screenshotSize"]')).toBeNull()
    expect(panel?.textContent).not.toContain('Screenshot Size')
    expect(panel?.textContent).not.toContain('Effective Resolution')

    await type(inputIn(row('router'), 'registry.llms[].contextWindow'), '256k')
    await waitPastSettle()
    expect(writes()).toEqual([
      [[{ op: 'set', path: ['registry', 'llms', { name: 'router' }, 'contextWindow'], value: '256k' }]],
    ])
    expect(JSON.stringify(writes())).not.toMatch(/screenshotSize|effectiveResolution/)
    expect(API_EXPORTS).not.toContain('updateSettings')
  })

  it('LEGACY-LLM-SAVED-VISION-AUTHORITATIVE: a saved vision off stays off, whatever the model id suggests', async () => {
    const llms = LLMS.map((llm) => (llm.name === 'router' ? { ...llm, model: 'claude-sonnet-4-20250514', vision: false } : llm))
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig(llms)) as never)
    await mount()
    const panel = await openModel('router')
    const vision = field(panel, 'registry.llms[].vision')?.querySelector('[role="switch"]') ?? null
    expect(vision?.getAttribute('aria-checked')).toBe('false')
  })

  it('LEGACY-LLM-HEADERS-ANTHROPIC-ONLY: only an Anthropic-compatible row offers headers, their values masked, beside its own vision and context window', async () => {
    const proxy = { ...PROXY, vision: false, contextWindow: '200k' }
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([...LLMS, proxy])) as never)
    await mount()
    const panel = await openModel('claude-proxy')
    const headers = panel?.querySelector('[data-model-headers]')
    expect(headers?.querySelector('legend')?.textContent).toBe(ADD_FLOW_FIELD_LABELS.headers)
    expect(field(panel, 'registry.llms[].providerHeaders.*')?.textContent).toContain(HEADER_MARKER)
    expect(field(panel, 'registry.llms[].vision')?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    expect(inputIn(panel, 'registry.llms[].contextWindow')?.value).toBe('200k')
    expect(panel?.textContent).not.toContain('Provider Headers (optional)')
    expect(panel?.textContent).not.toContain('Optional non-secret headers')

    for (const name of ['router', 'flash', 'gpt-5.6', 'sonnet']) {
      const other = await openModel(name)
      expect(other?.querySelector('[data-model-headers]'), name).toBeNull()
    }
  })

  it('LEGACY-LLM-CONNECTION-FAILURE-RENDERS-SERVER-SENTENCE: a failed test shows the server sentence verbatim', async () => {
    const sentence = 'Invalid request. Check model and provider settings.'
    vi.mocked(testLLMConnection).mockResolvedValueOnce({ success: false, error: 'invalid_request', message: sentence })
    await mount()
    const panel = await openModel('router')
    await click(buttonNamed(panel, TEST_CONNECTION_LABEL))
    expect(testLLMConnection).toHaveBeenCalledTimes(1)
    expect(row('router')!.querySelector('[data-test-result="failed"]')?.textContent).toBe(sentence)
    expect(container!.textContent).not.toContain('Connection failed.')
  })

  it('LEGACY-LLM-EDIT-DIALOG-GONE: no Edit configuration button, no configurations table, and no dialog opens from a row or Add model', async () => {
    await mount()
    expect(container!.querySelector('button[title="Edit configuration"]')).toBeNull()
    expect(container!.querySelector('table')).toBeNull()
    expect(container!.textContent).not.toContain('LLM Configurations')
    for (const name of ['gpt-5.6', 'flash', 'router', 'sonnet']) {
      await openModel(name)
      expect(document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'), name).toBeNull()
      expect(document.body.textContent).not.toContain(`Edit ${name}`)
    }
    await click(container!.querySelector<HTMLButtonElement>('[data-model-add]'))
    expect(container!.querySelector('[data-model-list] > li[data-model-draft]')).not.toBeNull()
    noDialog()
  })

  it('LEGACY-LLM-SAVE-CHANGES-GONE: no open row and not the add row renders Save Changes or the modal\'s credential buttons', async () => {
    await mount()
    for (const name of ['gpt-5.6', 'flash', 'router', 'sonnet']) {
      const panel = await openModel(name)
      for (const label of MODAL_BUTTONS) {
        expect(buttonNamed(panel, label), `${name}: ${label}`).toBeNull()
      }
    }
    await click(container!.querySelector<HTMLButtonElement>('[data-model-add]'))
    const add = container!.querySelector('[data-model-list] > li[data-model-draft]')
    expect(add).not.toBeNull()
    for (const label of MODAL_BUTTONS) {
      expect(buttonNamed(add, label), `add row: ${label}`).toBeNull()
    }
  })

  it('LEGACY-LLM-SUCCESS-MILLISECONDS-GONE: a passed test says Connected, with no response time', async () => {
    vi.mocked(testLLMConnection).mockResolvedValueOnce({ success: true, responseTime: 123, provider: 'openai-compatible', model: 'openrouter/auto' })
    await mount()
    const panel = await openModel('router')
    await click(buttonNamed(panel, TEST_CONNECTION_LABEL))
    const line = row('router')!.querySelector('[data-test-result="connected"]')
    expect(line?.textContent).toBe(TEST_RESULT_TEXT.connected)
    expect(row('router')!.textContent).not.toContain('123')
    expect(row('router')!.textContent).not.toMatch(/\d\s*ms\b/)
    expect(row('router')!.textContent).not.toContain('Connection successful')
  })
})

// a header shown as its declared marker is left out of the connection test, so the
// server sends the saved value (routes.llm-test-saved-headers MASK-HEADER-NEVER-SENT).
describe('the model row and masked header values', () => {
  it('the model row does not resend a header shown as a marker', async () => {
    const proxy = { ...PROXY, providerHeaders: { 'X-Org': HEADER_MARKER, 'X-Trace': 't-1' } }
    vi.mocked(fetchConfig).mockResolvedValue(answer(modelsConfig([...LLMS, proxy])) as never)
    await mount()
    const panel = await openModel('claude-proxy')
    await click(buttonNamed(panel, TEST_CONNECTION_LABEL))

    expect(testLLMConnection).toHaveBeenCalledTimes(1)
    const request = vi.mocked(testLLMConnection).mock.calls[0][0]
    expect(request).toMatchObject({ configName: 'claude-proxy', provider: 'anthropic-compatible' })
    expect(request.providerHeaders).toEqual({ 'X-Trace': 't-1' })
    expect(JSON.stringify(request)).not.toContain('[secret:')
    expect(writes()).toHaveLength(0)
  })
})
