// @vitest-environment jsdom

// DATA PATHS CHANGE ONLY THROUGH APPLY (429-20 Task 1 · D-23, D-24 · UI-SPEC S6, E7).
//
// A path that points at existing data never autosaves. Typing keeps a draft and shows Apply,
// Keep current path and one true sentence about what changes; Apply is one undoable write.
// These cells mount the real autosave hook over a mocked write route.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataPathField, type DataPathTarget } from '@/components/config-manager/data-path-field'
import {
  CONFIG_DRAFTS_STORAGE_PREFIX,
  ConfigAutosaveProvider,
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosave,
  type ConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import {
  APPLY_CONSEQUENCES,
  APPLY_LABEL,
  KEEP_CURRENT_PATH_LABEL,
  applyActionName,
  keepPathName,
  undoLine,
} from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG_PATH = '/work/agent-qa.config.yaml'
const DB_LABEL = 'Database file'
const KNOWLEDGE_LABEL = 'Knowledge folder'
const CURRENT_DB = '.agent-qa/runs.db'
const NEW_DB = 'data/runs.db'

const dbPath: DataPathTarget = {
  segments: ['services', 'dashboard', 'dbPath'],
  tab: 'project',
  pattern: 'services.dashboard.dbPath',
}
const knowledgeDir: DataPathTarget = { segments: ['knowledge', 'dir'], tab: 'project', pattern: 'knowledge.dir' }

const fullConfig = {
  knowledge: { dir: 'agent-qa-knowledge' },
  services: { dashboard: { port: 4173, dbPath: CURRENT_DB } },
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
      <DataPathField field={dbPath} label={DB_LABEL} explicitKind="change-db-path" />
      <DataPathField field={knowledgeDir} label={KNOWLEDGE_LABEL} explicitKind="change-knowledge-dir" />
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

async function render() {
  await act(async () => {
    root!.render(
      <Harness>
        <Fields />
      </Harness>,
    )
  })
  await flush()
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await render()
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

function row(field: DataPathTarget) {
  return container?.querySelector(`[data-field-path="${field.pattern}"]`) as HTMLElement | null
}

function input(field: DataPathTarget) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(field.segments))) as HTMLInputElement | null
}

function buttonNamed(name: string) {
  const buttons = Array.from(container?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.getAttribute('aria-label') === name) ?? null
}

function consequence(field: DataPathTarget) {
  return row(field)?.querySelector('[data-apply-consequence]') ?? null
}

function setValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function type(field: DataPathTarget, value: string) {
  const element = input(field)
  expect(element, field.pattern).not.toBeNull()
  await act(async () => {
    element!.focus()
    setValue(element!, value)
  })
  await flush()
}

async function blur(field: DataPathTarget) {
  await act(async () => {
    input(field)!.blur()
  })
  await flush()
}

async function click(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull()
  await act(async () => {
    button!.click()
  })
  await flush()
}

function writeCalls() {
  return vi.mocked(applyConfigChanges).mock.calls.map((call) => call[0])
}

function expectControlsHidden(field: DataPathTarget, label: string) {
  expect(row(field)?.getAttribute('data-apply-state')).toBe('clean')
  expect(buttonNamed(applyActionName(label))).toBeNull()
  expect(buttonNamed(keepPathName(label))).toBeNull()
  expect(consequence(field)).toBeNull()
}

const setDb = { op: 'set', path: ['services', 'dashboard', 'dbPath'], value: NEW_DB }

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  showFields = true
  vi.mocked(fetchConfig).mockResolvedValue(answer(fullConfig) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2', undo: { token: 'undo-1' } } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('DataPathField', () => {
  it('APPLY-HIDDEN-WHEN-EQUAL: a path equal to the file shows no Apply, Keep current path or consequence line', async () => {
    await mount()

    expect(row(dbPath)?.hasAttribute('data-config-field')).toBe(true)
    expect(input(dbPath)?.value).toBe(CURRENT_DB)
    expectControlsHidden(dbPath, DB_LABEL)
    expectControlsHidden(knowledgeDir, KNOWLEDGE_LABEL)

    await type(dbPath, NEW_DB)
    expect(row(dbPath)?.getAttribute('data-apply-state')).toBe('pending')
    await type(dbPath, CURRENT_DB)
    expectControlsHidden(dbPath, DB_LABEL)
    expect(hook!.status.state).toBe('idle')
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('TYPING-NEVER-SAVES: a typed path writes nothing and shows Apply, Keep current path and its consequence line', async () => {
    await mount()

    await type(dbPath, NEW_DB)
    await blur(dbPath)
    await advance(5_000)

    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expect(row(dbPath)?.getAttribute('data-apply-state')).toBe('pending')
    const apply = buttonNamed(applyActionName(DB_LABEL))
    expect(apply?.textContent).toBe(APPLY_LABEL)
    expect(apply?.hasAttribute('data-apply-path')).toBe(true)
    expect(buttonNamed(keepPathName(DB_LABEL))?.textContent).toBe(KEEP_CURRENT_PATH_LABEL)
    expect(consequence(dbPath)?.textContent).toBe(APPLY_CONSEQUENCES['services.dashboard.dbPath'])
    expect(consequence(dbPath)?.textContent).not.toBe('')
    expectControlsHidden(knowledgeDir, KNOWLEDGE_LABEL)
    expect(hook!.status.state).toBe('draft')
  })

  it('APPLY-WRITES-UNDOABLE: Apply writes the path once as an undoable explicit action and shows the Undo line', async () => {
    await mount()

    await type(dbPath, NEW_DB)
    await click(buttonNamed(applyActionName(DB_LABEL)))
    await advance(5_000)

    expect(writeCalls()).toEqual([[setDb]])
    expect(vi.mocked(applyConfigChanges).mock.calls[0]![1]).toEqual({ undoable: true })
    expect(hook!.status.state).toBe('undo')
    expect(hook!.status.undo?.line).toBe(undoLine('change-db-path', DB_LABEL))
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expectControlsHidden(dbPath, DB_LABEL)
    expect(document.activeElement).toBe(input(dbPath))
    expect(localStorage.getItem(`${CONFIG_DRAFTS_STORAGE_PREFIX}${CONFIG_PATH}`)).toBeNull()
  })

  it('KEEP-CURRENT-PATH-RESTORES: Keep current path puts the file value back, drops the draft and hides the controls', async () => {
    await mount()

    await type(dbPath, NEW_DB)
    expect(hook!.draftTabs.has('project')).toBe(true)
    await click(buttonNamed(keepPathName(DB_LABEL)))

    expect(input(dbPath)?.value).toBe(CURRENT_DB)
    expectControlsHidden(dbPath, DB_LABEL)
    expect(hook!.draftTabs.has('project')).toBe(false)
    expect(hook!.status.state).toBe('idle')
    expect(document.activeElement).toBe(input(dbPath))
    expect(localStorage.getItem(`${CONFIG_DRAFTS_STORAGE_PREFIX}${CONFIG_PATH}`)).toBeNull()
    await advance(5_000)
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('APPLY-FAILURE-KEEPS-PENDING: a refused Apply keeps the typed path, both buttons and the server reason; Retry sends it again', async () => {
    const reason = 'The database folder cannot be created.'
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(
      Object.assign(new Error('validation_failed'), {
        payload: { error: 'validation_failed', issues: [{ path: ['services', 'dashboard', 'dbPath'], message: reason }] },
      }),
    )
    await mount()

    await type(dbPath, NEW_DB)
    await click(buttonNamed(applyActionName(DB_LABEL)))

    expect(writeCalls()).toEqual([[setDb]])
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expect(row(dbPath)?.getAttribute('data-apply-state')).toBe('pending')
    expect(buttonNamed(applyActionName(DB_LABEL))).not.toBeNull()
    expect(buttonNamed(keepPathName(DB_LABEL))).not.toBeNull()
    expect(consequence(dbPath)).not.toBeNull()
    expect(row(dbPath)?.querySelector('[data-field-error]')?.textContent).toBe(reason)
    expect(input(dbPath)?.getAttribute('aria-invalid')).toBe('true')
    expect(hook!.status.state).toBe('failed')

    await act(async () => {
      hook!.retry()
    })
    await flush()

    expect(writeCalls()).toEqual([[setDb], [setDb]])
    expect(vi.mocked(applyConfigChanges).mock.calls[1]![1]).toEqual({ undoable: true })
    expectControlsHidden(dbPath, DB_LABEL)
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expect(hook!.status.state).toBe('undo')
  })

  it('PENDING-SURVIVES-RELOAD: a pending path stays a draft across a tab change and a reload until applied or kept', async () => {
    await mount()

    await type(dbPath, NEW_DB)
    await blur(dbPath)
    expect(hook!.draftTabs.has('project')).toBe(true)

    showFields = false
    await render()
    expect(input(dbPath)).toBeNull()
    showFields = true
    await render()
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expect(row(dbPath)?.getAttribute('data-apply-state')).toBe('pending')

    await unmount()
    await mount()
    expect(input(dbPath)?.value).toBe(NEW_DB)
    expect(row(dbPath)?.getAttribute('data-apply-state')).toBe('pending')
    expect(consequence(dbPath)?.textContent).toBe(APPLY_CONSEQUENCES['services.dashboard.dbPath'])
    expect(hook!.draftTabs.has('project')).toBe(true)
    expect(hook!.status.state).toBe('draft')
    await advance(5_000)
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await click(buttonNamed(applyActionName(DB_LABEL)))
    expect(writeCalls()).toEqual([[setDb]])
    expectControlsHidden(dbPath, DB_LABEL)
  })
})
