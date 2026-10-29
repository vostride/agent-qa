// @vitest-environment jsdom

// THE READ-ONLY CONFIG FILE (429-28 Task 2 · D-05 · UI-SPEC S7 "Config file", E10).
//
// The whole file as the server sent it through the declared mask, one numbered line per item, with
// its path and a copy button. Nothing in it is editable, and there is no reveal.
// An outside edit swaps the lines in place; a failed quiet re-read keeps the last good text.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigFileView } from '@/components/config-manager/config-file-view'
import { ConfigAutosaveProvider, useConfigAutosave } from '@/hooks/use-config-autosave'
import { fetchConfig, fetchConfigRevision, type ConfigFileLine } from '@/lib/api'
import { CONFIG_FILE_NOTE, COPY_PATH_LABEL, COPY_STATUS_WORDS, REVISION_POLL_MS } from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/projects/a-rather-long-folder-name/agent-qa.config.yaml'
const DECLARED = '[secret:ACCESS_KEY]'

const LINES: ConfigFileLine[] = [
  { n: 1, text: 'workspace:' },
  { n: 2, text: '  name: demo' },
  { n: 3, text: 'plugins:' },
  { n: 4, text: '  auth:' },
  { n: 5, text: '    - package: "@acme/agent-qa-auth-sso"' },
  { n: 6, text: 'registry:' },
  { n: 7, text: '  llms:' },
  { n: 8, text: '    - name: gateway' },
  { n: 9, text: '      providerHeaders:' },
  { n: 10, text: `        x-access: ${DECLARED}` },
  { n: 11, text: '        X-Api-Key: undeclared-header-value' },
  { n: 12, text: 'services:' },
  { n: 13, text: '  mcp:' },
  { n: 14, text: '    port: 3471' },
]

function answer(lines: ConfigFileLine[], revision = 'rev-1') {
  return { config: {}, provider: null, revision, file: { path: CONFIG_PATH, lines } }
}

function Harness() {
  const autosave = useConfigAutosave()
  if (autosave.load.kind === 'error') return <p data-config-load-error>{autosave.load.reason}</p>
  if (autosave.load.kind !== 'ready') return <p data-config-loading />
  return (
    <ConfigAutosaveProvider value={autosave}>
      <section data-config-section="config-file">
        <ConfigFileView />
      </section>
      <button type="button" data-outside>
        outside
      </button>
    </ConfigAutosaveProvider>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let writeText: ReturnType<typeof vi.fn>

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
    root!.render(<Harness />)
  })
  await flush()
}

function section() {
  return container!.querySelector('[data-config-section="config-file"]') as HTMLElement
}

function line(n: number) {
  return section().querySelector(`li[data-line="${n}"]`) as HTMLLIElement | null
}

function copyButton() {
  return section().querySelector(`button[aria-label="${COPY_PATH_LABEL}"]`) as HTMLButtonElement | null
}

function copyStatus() {
  return section().querySelector('[role="status"]')?.textContent ?? ''
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfig).mockResolvedValue(answer(LINES) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  writeText = vi.fn().mockResolvedValue(undefined)
  setClipboard({ writeText })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
  setClipboard(undefined)
})

describe('ConfigFileView', () => {
  it('FILE-VIEW-READ-ONLY-MASKED: the whole file, one li per line with the text the server sent, the path and the note, and nothing editable or revealable', async () => {
    await mount()

    const path = section().querySelector('code[data-config-file-path]')
    expect(path?.textContent).toBe(CONFIG_PATH)
    expect(path?.className).toContain('font-mono')
    expect(path?.className).toContain('wrap-anywhere')
    expect(section().textContent).toContain(CONFIG_FILE_NOTE)

    const view = section().querySelector('[data-config-file-view]') as HTMLElement
    expect(view).not.toBeNull()
    expect(view.className).toContain('overflow-x-auto')
    expect(view.className).not.toMatch(/max-h-/)
    const list = view.querySelector('ol') as HTMLOListElement
    expect(list.className).toContain('whitespace-pre')
    expect(list.className).toContain('font-mono')

    const items = Array.from(list.querySelectorAll(':scope > li'))
    expect(items.map((item) => item.getAttribute('data-line'))).toEqual(LINES.map((l) => String(l.n)))
    expect(items.map((item) => item.textContent)).toEqual(LINES.map((l) => l.text))
    expect(items.every((item) => !item.hasAttribute('data-masking-class'))).toBe(true)
    expect(line(5)!.textContent).toContain('@acme/agent-qa-auth-sso')
    expect(line(10)!.textContent).toBe(`        x-access: ${DECLARED}`)
    expect(line(11)!.textContent).toBe('        X-Api-Key: undeclared-header-value')

    expect(list.querySelectorAll('button')).toHaveLength(0)
    expect(section().querySelector('input, textarea, select, [contenteditable]')).toBeNull()
    expect(section().querySelector('[role="textbox"]')).toBeNull()
  })

  it('FILE-VIEW-QUIET-REFRESH: an outside edit swaps the lines in place with no notice and no spinner', async () => {
    await mount()
    expect(line(2), 'the line renders').not.toBeNull()
    expect(line(2)!.textContent).toContain('name: demo')

    const edited = LINES.map((l) => (l.n === 2 ? { ...l, text: '  name: renamed' } : l))
    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-2' })
    vi.mocked(fetchConfig).mockResolvedValue(answer(edited, 'rev-2') as never)
    const view = section().querySelector('[data-config-file-view]')

    await advance(REVISION_POLL_MS)

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(section().querySelector('[data-config-file-view]')).toBe(view)
    expect(line(2)!.textContent).toContain('name: renamed')
    expect(container!.querySelector('[data-config-loading], [data-config-load-error]')).toBeNull()
    expect(section().querySelector('[role="alert"], svg.animate-spin')).toBeNull()
    expect(copyStatus()).toBe('')
  })

  it('FILE-VIEW-QUIET-REFRESH: a failed quiet re-read keeps the last good text without a notice', async () => {
    await mount()

    vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-2' })
    vi.mocked(fetchConfig).mockRejectedValue(new TypeError('Failed to fetch'))
    await advance(REVISION_POLL_MS)

    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(container!.querySelector('[data-config-load-error]')).toBeNull()
    expect(line(2), 'the last good line still renders').not.toBeNull()
    expect(line(2)!.textContent).toContain('name: demo')

    const edited = LINES.map((l) => (l.n === 2 ? { ...l, text: '  name: renamed' } : l))
    vi.mocked(fetchConfig).mockResolvedValue(answer(edited, 'rev-2') as never)
    await advance(REVISION_POLL_MS)
    expect(line(2)!.textContent).toContain('name: renamed')
  })

  it('COPY-PATH-FAILURE-HONEST: a rejected clipboard write announces Couldn\'t copy and never shows the check; a resolved one shows it for 2 s and announces Copied', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    await mount()

    const button = copyButton()
    expect(button).not.toBeNull()
    expect(button!.querySelector('[data-copy-icon="copy"]')).not.toBeNull()

    await click(button)
    expect(writeText).toHaveBeenCalledWith(CONFIG_PATH)
    expect(copyStatus()).toBe(COPY_STATUS_WORDS.failed)
    expect(button!.querySelector('[data-copy-icon="check"]')).toBeNull()

    setClipboard(undefined)
    await click(button)
    expect(copyStatus()).toBe(COPY_STATUS_WORDS.failed)
    expect(button!.querySelector('[data-copy-icon="check"]')).toBeNull()

    setClipboard({ writeText })
    await click(button)
    expect(copyStatus()).toBe(COPY_STATUS_WORDS.copied)
    expect(button!.querySelector('[data-copy-icon="check"]')).not.toBeNull()

    await advance(1_999)
    expect(button!.querySelector('[data-copy-icon="check"]')).not.toBeNull()
    await advance(1)
    expect(button!.querySelector('[data-copy-icon="check"]')).toBeNull()
    expect(button!.querySelector('[data-copy-icon="copy"]')).not.toBeNull()
  })
})
