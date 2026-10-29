// @vitest-environment jsdom

// The shown text is never an input value, so a mask can never be written back.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPathSegment } from '@vostride/agent-qa-schema'

import { SecretValue } from '@/components/config-manager/secret-value'
import {
  ConfigAutosaveProvider,
  useConfigAutosave,
  useConfigAutosaveContext,
  type ConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import { SETTLE_DELAY_MS, keepValueName, replaceValueName, saveValueName } from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/agent-qa.config.yaml'
const MASK = '[masked]'
const TYPED = 'typed-new-secret-9X4'

const HEADERS: ConfigPathSegment[] = ['registry', 'llms', { name: 'proxy' }, 'providerHeaders']
const accessKey = {
  segments: [...HEADERS, 'x-access'] as ConfigPathSegment[],
  pattern: 'registry.llms[].providerHeaders.*',
}
const region = {
  segments: [...HEADERS, 'x-region'] as ConfigPathSegment[],
  pattern: 'registry.llms[].providerHeaders.*',
}

function proxyWithHeaders(providerHeaders: Record<string, string>) {
  return {
    registry: {
      llms: [{
        name: 'proxy',
        provider: 'anthropic-compatible',
        model: 'claude-proxy',
        baseURL: 'https://llm.example.test/v1',
        providerHeaders,
      }],
    },
  }
}

const maskedConfig = proxyWithHeaders({ 'x-access': MASK, 'x-region': MASK })

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: CONFIG_PATH, lines: [] } }
}

let hook: ConfigAutosave | undefined

function Harness({ children }: { children: ReactNode }) {
  const autosave = useConfigAutosave()
  hook = autosave
  if (autosave.load.kind !== 'ready') return null
  return <ConfigAutosaveProvider value={autosave}>{children}</ConfigAutosaveProvider>
}

function Secrets() {
  const autosave = useConfigAutosaveContext()
  const maskedAt = (segments: ConfigPathSegment[]) => String(autosave.valueOf({ segments, tab: 'models' }) ?? '')
  return (
    <div>
      <SecretValue field={accessKey} label="Access key" maskedText={maskedAt(accessKey.segments)} />
      <SecretValue field={region} label="Region" maskedText={maskedAt(region.segments)} />
    </div>
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
      <Harness>
        <Secrets />
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

function groups() {
  return Array.from(container?.querySelectorAll('[data-secret-field]') ?? []) as HTMLElement[]
}

function buttonNamed(name: string) {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.getAttribute('aria-label') === name) ?? null
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function passwordIn(group: HTMLElement | undefined) {
  return (group?.querySelector('input[type="password"]') ?? null) as HTMLInputElement | null
}

async function replaceAndType(label: string, value: string) {
  await click(buttonNamed(replaceValueName(label)))
  const input = passwordIn(groups()[label === 'Access key' ? 0 : 1])
  expect(input).not.toBeNull()
  await act(async () => {
    setValue(input!, value)
  })
  await flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function storedText() {
  const parts: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!
    parts.push(key, localStorage.getItem(key) ?? '')
  }
  return parts.join('\n')
}

function inputValues() {
  return (Array.from(document.querySelectorAll('input')) as HTMLInputElement[]).map((input) => input.value).join('\n')
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfig).mockResolvedValue(answer(maskedConfig) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('SecretValue and masked header values', () => {
  it("the secret field shows the server's text and offers no reveal", async () => {
    vi.mocked(fetchConfig).mockResolvedValue(
      answer(proxyWithHeaders({ 'x-access': '[secret:ACCESS_KEY]', 'x-region': 'eu-west' })) as never,
    )
    const network = vi.spyOn(globalThis, 'fetch')
    await mount()
    const reads = vi.mocked(fetchConfig).mock.calls.length

    const [first, second] = groups()
    expect(first!.getAttribute('data-field-path')).toBe(accessKey.pattern)
    expect(first!.querySelector('code')?.textContent).toBe('[secret:ACCESS_KEY]')
    expect(first!.querySelector('code')?.className).toContain('wrap-anywhere')
    expect(second!.querySelector('code')?.textContent).toBe('eu-west')
    for (const group of [first!, second!]) {
      expect(Array.from(group.querySelectorAll('button')).map((button) => button.textContent?.trim())).toEqual(['Replace value'])
      expect(group.querySelector('[aria-pressed]')).toBeNull()
      await act(async () => {
        group.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        group.querySelector('button')!.focus()
      })
      await flush()
    }
    expect(network).not.toHaveBeenCalled()
    expect(vi.mocked(fetchConfig).mock.calls.length).toBe(reads)
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await replaceAndType('Access key', TYPED)
    await click(buttonNamed(saveValueName('Access key')))
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: accessKey.segments, value: TYPED }]],
    ])
    expect(network).not.toHaveBeenCalled()
  })
})

describe('SecretValue', () => {
  it('REPLACE-VALUE-EMPTY-INPUT: Replace value shows an empty password input beside Save value and Keep current value, never the mask', async () => {
    await mount()

    const replace = buttonNamed(replaceValueName('Access key'))
    expect(replace?.textContent?.trim()).toBe('Replace value')
    await click(replace)

    const input = passwordIn(groups()[0])
    expect(input).not.toBeNull()
    expect(input!.value).toBe('')
    expect(input!.value).not.toBe(MASK)
    expect(input!.getAttribute('autocomplete')).toBe('off')
    expect(inputValues()).not.toContain(MASK)
    expect(buttonNamed(saveValueName('Access key'))?.textContent?.trim()).toBe('Save value')
    expect(buttonNamed(keepValueName('Access key'))?.textContent?.trim()).toBe('Keep current value')
    expect(passwordIn(groups()[1])).toBeNull()
  })

  it('SAVE-VALUE-SAVING: Save value shows Saving… in the status until the write lands', async () => {
    await mount()

    const write = deferred<{ revision: string }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(write.promise as never)
    await replaceAndType('Region', TYPED)
    await click(buttonNamed(saveValueName('Region')))
    expect(hook!.status.state).toBe('saving')

    await act(async () => {
      write.resolve({ revision: 'rev-2' })
    })
    await flush()
    expect(hook!.status.state).toBe('saved')
  })

  // The landed write is mirrored as written; the editor has no path-class mask.
  it('SAVE-VALUE-EXPLICIT: typing writes nothing; Save value writes one set at the path and the page shows the value as written', async () => {
    await mount()

    await replaceAndType('Access key', TYPED)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 3)
    })
    await flush()
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(hook!.status.state).toBe('idle')
    expect(storedText()).not.toContain(TYPED)

    await click(buttonNamed(saveValueName('Access key')))

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: accessKey.segments, value: TYPED }]],
    ])
    expect(hook!.status.state).toBe('saved')
    expect(passwordIn(groups()[0])).toBeNull()
    expect(groups()[0]!.querySelector('code')?.textContent).toBe(TYPED)
    expect(groups()[1]!.querySelector('code')?.textContent).toBe(MASK)
    expect(inputValues()).not.toContain(TYPED)
    expect(storedText()).not.toContain(TYPED)
    expect(fetchConfig).toHaveBeenCalledTimes(1)
  })

  it('SAVE-VALUE-FAILURE-KEEPS-TYPED: a failed Save value keeps the typed value in the input and fails the status', async () => {
    await mount()
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(new Error('write_failed'))

    await replaceAndType('Access key', TYPED)
    await click(buttonNamed(saveValueName('Access key')))

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(hook!.status.state).toBe('failed')
    const input = passwordIn(groups()[0])
    expect(input).not.toBeNull()
    expect(input!.value).toBe(TYPED)
    expect(storedText()).not.toContain(TYPED)
  })

  it('KEEP-CURRENT-VALUE-RESTORES-FOCUS: Keep current value closes the input, forgets the typed value and focuses Replace value', async () => {
    await mount()

    await replaceAndType('Access key', TYPED)
    await click(buttonNamed(keepValueName('Access key')))

    expect(passwordIn(groups()[0])).toBeNull()
    const replace = buttonNamed(replaceValueName('Access key'))
    expect(replace).not.toBeNull()
    expect(document.activeElement).toBe(replace)
    expect(inputValues()).not.toContain(TYPED)
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await click(replace)
    expect(passwordIn(groups()[0])!.value).toBe('')
  })
})
