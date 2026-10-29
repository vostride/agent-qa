// @vitest-environment jsdom

// Cells mount the real autosave hook over a mocked write route, so they pin what a person sees.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigField, type ConfigFieldTarget } from '@/components/config-manager/config-field'
import {
  ConfigAutosaveProvider,
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosave,
  type ConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import { DURATION_INPUT_ERROR } from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/agent-qa.config.yaml'

const step: ConfigFieldTarget = { segments: ['use', 'timeout', 'step'], tab: 'execution', pattern: 'use.timeout.step' }
const headless: ConfigFieldTarget = {
  segments: ['use', 'browser', 'headless'],
  tab: 'execution',
  pattern: 'use.browser.headless',
}
const envFile: ConfigFieldTarget = { segments: ['workspace', 'envFile'], tab: 'project', pattern: 'workspace.envFile' }
const width: ConfigFieldTarget = {
  segments: ['use', 'browser', 'viewport', 'width'],
  tab: 'execution',
  pattern: 'use.browser.viewport.width',
}

const fullConfig = {
  workspace: { envFile: '.env.local' },
  use: {
    timeout: { step: '30s', test: '10m', navigation: '10s' },
    browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } },
  },
}

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_PATH, lines: [] } }
}

let hook: ConfigAutosave | undefined
let showFields = true

function Harness({ children }: { children: ReactNode }) {
  const autosave = useConfigAutosave()
  hook = autosave
  if (autosave.load.kind !== 'ready') return null
  return <ConfigAutosaveProvider value={autosave}>{showFields ? children : null}</ConfigAutosaveProvider>
}

function Fields() {
  return (
    <>
      <ConfigField field={step} label="Step timeout" kind="duration" placeholder="30s" help="A number and a unit." />
      <ConfigField field={headless} label="Headless" kind="switch" defaultChecked />
      <ConfigField field={envFile} label="Env file" kind="text" placeholder=".env" />
      <ConfigField field={width} label="Viewport width" kind="number" placeholder="1280" number={{ min: 1, integer: true }} />
    </>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <Harness>
        <Fields />
      </Harness>,
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

async function rerender() {
  await act(async () => {
    root!.render(
      <Harness>
        <Fields />
      </Harness>,
    )
  })
  await flush()
}

function row(field: ConfigFieldTarget) {
  return container?.querySelector(`[data-field-path="${field.pattern}"]`) as HTMLElement | null
}

function control<T extends HTMLElement = HTMLInputElement>(field: ConfigFieldTarget) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(field.segments))) as T | null
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function type(field: ConfigFieldTarget, value: string) {
  const input = control(field)
  expect(input, field.pattern).not.toBeNull()
  await act(async () => {
    input!.focus()
    setValue(input!, value)
  })
  await flush()
}

async function blur(field: ConfigFieldTarget) {
  await act(async () => {
    control(field)!.blur()
  })
  await flush()
}

function writeCalls() {
  return vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  showFields = true
  vi.mocked(fetchConfig).mockResolvedValue(answer(fullConfig) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('ConfigField', () => {
  it('FIELD-UNSET-SHOWS-PLACEHOLDER-WRITES-NOTHING: an absent leaf shows its default as placeholder and writes nothing on mount, focus or blur', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer({ workspace: {} }) as never)
    await mount()

    const input = control(step)
    expect(input).not.toBeNull()
    expect(input!.value).toBe('')
    expect(input!.placeholder).toBe('30s')
    expect(control(envFile)!.value).toBe('')
    expect(control(envFile)!.placeholder).toBe('.env')
    const toggle = control<HTMLButtonElement>(headless)
    expect(toggle?.getAttribute('role')).toBe('switch')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      input!.focus()
    })
    await blur(step)
    await advance(5_000)

    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(row(step)?.getAttribute('data-field-state')).toBe('clean')
  })

  it('FIELD-CLEAR-UNSETS: clearing a set text field and blurring sends one unset of that path', async () => {
    await mount()
    expect(control(envFile)!.value).toBe('.env.local')

    await type(envFile, '')
    await blur(envFile)

    expect(writeCalls()).toEqual([[{ op: 'unset', path: ['workspace', 'envFile'] }]])
  })

  it('FIELD-SAVING-STAYS-EDITABLE: a field in a write in flight reads saving, stays editable, and a further edit joins the next write', async () => {
    const first = deferred<{ revision: string }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(first.promise as never)
    await mount()

    await type(step, '45s')
    await blur(step)
    expect(writeCalls()).toEqual([[{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }]])
    expect(row(step)?.getAttribute('data-field-state')).toBe('saving')
    expect(control(step)!.disabled).toBe(false)
    expect(control(step)!.readOnly).toBe(false)

    await type(step, '50s')
    await blur(step)
    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(control(step)!.value).toBe('50s')

    await act(async () => {
      first.resolve({ revision: 'rev-2' })
    })
    await flush()
    expect(writeCalls()).toEqual([
      [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }],
      [{ op: 'set', path: ['use', 'timeout', 'step'], value: '50s' }],
    ])
  })

  it('FIELD-INVALID-DRAFT: an unparseable duration stays a draft with its error across a tab change and a reload', async () => {
    await mount()

    await type(step, '30 seconds')
    await blur(step)
    await advance(5_000)

    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(row(step)?.getAttribute('data-field-state')).toBe('draft')
    expect(row(step)?.querySelector('[data-field-error]')?.textContent).toBe(DURATION_INPUT_ERROR)
    expect(hook!.status.state).toBe('draft')
    expect(hook!.draftTabs.has('execution')).toBe(true)

    showFields = false
    await rerender()
    expect(control(step)).toBeNull()
    showFields = true
    await rerender()
    expect(control(step)!.value).toBe('30 seconds')
    expect(row(step)?.getAttribute('data-field-state')).toBe('draft')

    await unmount()
    await mount()
    expect(control(step)!.value).toBe('30 seconds')
    expect(row(step)?.getAttribute('data-field-state')).toBe('draft')
    expect(row(step)?.querySelector('[data-field-error]')?.textContent).toBe(DURATION_INPUT_ERROR)
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('FIELD-INVALID-DRAFT: a server refusal marks the field failed with its reason', async () => {
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      Object.assign(new Error('validation_failed'), {
        payload: {
          error: 'validation_failed',
          issues: [{ path: ['use', 'timeout', 'step'], message: 'Step timeout must be at least 1s.' }],
        },
      }),
    )
    await mount()

    await type(step, '0s')
    await blur(step)

    expect(row(step)?.getAttribute('data-field-state')).toBe('failed')
    expect(row(step)?.querySelector('[data-field-error]')?.textContent).toBe('Step timeout must be at least 1s.')
    expect(control(step)!.value).toBe('0s')
  })

  it('FIELD-ARIA: the label names the control, and an invalid field is aria-invalid and described by its help and error', async () => {
    await mount()

    const field = row(step)!
    expect(field.hasAttribute('data-config-field')).toBe(true)
    expect(field.getAttribute('data-field-path')).toBe('use.timeout.step')
    const input = control(step)!
    expect(field.querySelector('label')?.getAttribute('for')).toBe(input.id)
    expect(field.querySelector('label')?.textContent).toBe('Step timeout')
    expect(input.getAttribute('aria-invalid')).not.toBe('true')

    await type(step, 'soon')
    await blur(step)

    expect(input.getAttribute('aria-invalid')).toBe('true')
    const help = field.querySelector('[data-field-help]')!
    const error = field.querySelector('[data-field-error]')!
    expect(help.id).not.toBe('')
    expect(error.id).not.toBe('')
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual([help.id, error.id])
    expect(error.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')

    const toggle = control<HTMLButtonElement>(headless)!
    expect(row(headless)?.querySelector('label')?.getAttribute('for')).toBe(toggle.id)
  })

  it('FIELD-WIDTHS: text inputs are w-full max-w-md, number and duration inputs w-32 tabular-nums, and lines never truncate', async () => {
    await mount()

    expect(control(envFile)!.className).toContain('w-full')
    expect(control(envFile)!.className).toContain('max-w-md')
    for (const field of [step, width]) {
      expect(control(field)!.className, field.pattern).toContain('w-32')
      expect(control(field)!.className, field.pattern).toContain('tabular-nums')
    }

    await type(step, 'soon')
    await blur(step)
    const lines = container!.querySelectorAll('[data-field-help], [data-field-error]')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of Array.from(lines)) {
      expect(line.className).not.toContain('truncate')
    }
  })

  it('a leaf typed into an absent block writes its required siblings, each set-if-absent, in the same write', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer({ workspace: {} }) as never)
    await mount()

    await type(step, '45s')
    await advance(1_000)

    expect(writeCalls()).toEqual([
      [
        { op: 'set', path: ['use', 'timeout', 'step'], value: '45s' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'navigation'], value: '2m' },
      ],
    ])
  })
})
