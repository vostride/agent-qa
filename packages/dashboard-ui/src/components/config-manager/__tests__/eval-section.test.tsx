// @vitest-environment jsdom

// EVERY EVAL SETTING, GROUPED, AND THE JUDGE PICKER (429-28 Task 1 · D-06, D-07 · UI-SPEC S7, E9).
//
// Every eval leaf has a field inside an eval group. Judges are picked from the registered
// models, at most three; one pick writes eval.judge, two or three write eval.judges, and the other
// key is removed in the same write, so the file never declares both.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { CONFIG_SCHEMA_LEAVES, configLeafOwner } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EvalSection } from '@/components/config-manager/eval-section'
import { ConfigAutosaveProvider, useConfigAutosave } from '@/hooks/use-config-autosave'
import { ApiError, applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import {
  EVAL_GROUP_LABELS,
  JUDGE_LIMIT_TEXT,
  JUDGE_MODELS_LABEL,
  JUDGE_NO_MODELS_TEXT,
} from '@/lib/config-copy'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
  undoConfigAction: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MODELS = ['alpha', 'beta', 'gamma', 'delta']

function withModels(names: readonly string[], evalBlock?: Record<string, unknown>) {
  return {
    registry: { llms: names.map((name) => ({ name, provider: 'openai-compatible', model: `${name}-model` })) },
    ...(evalBlock === undefined ? {} : { eval: evalBlock }),
  }
}

const JUDGE = ['eval', 'judge']
const JUDGES = ['eval', 'judges']

/** The two expect ops every judge write leads with: what the page computed from, null when absent. */
function expectsRead(judge: string | null, judges: string[] | null) {
  return [
    { op: 'expect', path: JUDGE, value: judge },
    { op: 'expect', path: JUDGES, value: judges },
  ]
}

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: '/work/agent-qa.config.yaml', lines: [] } }
}

function Harness() {
  const autosave = useConfigAutosave()
  if (autosave.load.kind !== 'ready') return null
  return (
    <MemoryRouter>
      <ConfigAutosaveProvider value={autosave}>
        <section data-config-section="eval">
          <EvalSection config={autosave.load.answer.config} />
        </section>
      </ConfigAutosaveProvider>
    </MemoryRouter>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount(config: Record<string, unknown>) {
  vi.mocked(fetchConfig).mockResolvedValue(answer(config) as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Harness />)
  })
  await flush()
}

function section() {
  return container!.querySelector('[data-config-section="eval"]') as HTMLElement
}

function labelOf(control: Element): string | undefined {
  return control.ownerDocument.querySelector(`label[for="${control.id}"]`)?.textContent?.trim()
}

function judgeBoxes() {
  return Array.from(section().querySelectorAll('[data-judge-picker] [role="checkbox"]')) as HTMLButtonElement[]
}

function judgeBox(name: string) {
  return judgeBoxes().find((box) => labelOf(box) === name) ?? null
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('EvalSection (429-28 Task 1)', () => {
  it('EVAL-EVERY-LEAF-GROUPED: every eval leaf has a field inside an eval group headed by an h3', async () => {
    await mount(withModels(MODELS))

    const headings = Array.from(section().querySelectorAll('[data-eval-group] > h3')).map((h) => h.textContent?.trim())
    expect(headings).toEqual(Object.values(EVAL_GROUP_LABELS))

    const evalLeaves = CONFIG_SCHEMA_LEAVES.filter((pattern) => pattern.startsWith('eval.'))
    for (const pattern of evalLeaves) {
      const owner = configLeafOwner(pattern)
      const field = section().querySelector(`[data-field-path="${owner}"]`)
      expect(field, pattern).not.toBeNull()
      const group = field!.closest('[data-eval-group]')
      expect(group, pattern).not.toBeNull()
      expect(Object.values(EVAL_GROUP_LABELS)).toContain(group!.querySelector(':scope > h3')?.textContent?.trim())
    }

    const picker = section().querySelector('[data-judge-picker]')
    expect(picker!.closest('[data-eval-group]')!.getAttribute('data-eval-group')).toBe('judge')
    expect(section().textContent).toContain(JUDGE_MODELS_LABEL)
    expect(judgeBoxes().map((box) => labelOf(box))).toEqual(MODELS)
  })

  it('JUDGE-ONE-WRITES-JUDGE: one pick writes eval.judge and removes eval.judges; a second writes eval.judges and removes eval.judge; each write first states what the page read', async () => {
    await mount(withModels(MODELS))

    await click(judgeBox('alpha'))
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[
        ...expectsRead(null, null),
        { op: 'set', path: ['eval', 'judge'], value: 'alpha' },
        { op: 'unset', path: ['eval', 'judges'] },
      ]],
    ])
    expect(judgeBox('alpha')!.getAttribute('aria-checked')).toBe('true')

    await click(judgeBox('beta'))
    expect(vi.mocked(applyConfigChanges).mock.calls[1]).toEqual([
      [
        ...expectsRead('alpha', null),
        { op: 'set', path: ['eval', 'judges'], value: ['alpha', 'beta'] },
        { op: 'unset', path: ['eval', 'judge'] },
      ],
    ])

    await click(judgeBox('alpha'))
    await click(judgeBox('beta'))
    expect(vi.mocked(applyConfigChanges).mock.calls[2]).toEqual([
      [
        ...expectsRead(null, ['alpha', 'beta']),
        { op: 'set', path: ['eval', 'judge'], value: 'beta' },
        { op: 'unset', path: ['eval', 'judges'] },
      ],
    ])
    expect(vi.mocked(applyConfigChanges).mock.calls[3]).toEqual([
      [
        ...expectsRead('beta', null),
        { op: 'unset', path: ['eval', 'judge'] },
        { op: 'unset', path: ['eval', 'judges'] },
      ],
    ])

    for (const [changes] of vi.mocked(applyConfigChanges).mock.calls) {
      const sets = changes.filter((change) => change.op === 'set').map((change) => change.path.join('.'))
      expect(sets.includes('eval.judge') && sets.includes('eval.judges')).toBe(false)
    }
  })

  it('JUDGE-THREE-DISABLES-REST: with three judges checked the rest are disabled and the limit line shows', async () => {
    await mount(withModels(MODELS, { judges: ['alpha', 'beta'] }))

    expect(section().textContent).not.toContain(JUDGE_LIMIT_TEXT)
    expect(judgeBoxes().map((box) => labelOf(box))).toEqual(MODELS)
    expect(judgeBox('gamma')!.disabled).toBe(false)

    await click(judgeBox('gamma'))
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[
        ...expectsRead(null, ['alpha', 'beta']),
        { op: 'set', path: ['eval', 'judges'], value: ['alpha', 'beta', 'gamma'] },
        { op: 'unset', path: ['eval', 'judge'] },
      ]],
    ])

    expect(judgeBoxes().filter((box) => box.getAttribute('aria-checked') === 'true').map(labelOf)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(judgeBox('delta')!.disabled).toBe(true)
    expect(judgeBox('alpha')!.disabled).toBe(false)
    expect(section().textContent).toContain(JUDGE_LIMIT_TEXT)

    await click(judgeBox('delta'))
    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
  })

  it('JUDGE-NO-MODELS: with no registered models the list shows the empty sentence and a link to add a model', async () => {
    await mount({})

    const picker = section().querySelector('[data-judge-picker]') as HTMLElement
    expect(picker).not.toBeNull()
    expect(judgeBoxes()).toEqual([])
    expect(picker.textContent).toContain(JUDGE_NO_MODELS_TEXT)
    const link = picker.querySelector('a') as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe('/config/models?add')
  })

  it('JUDGE-WRITE-EXPECTS-LIST: with eval.judge loaded, a second pick states the judge it read and that no list was there', async () => {
    await mount(withModels(MODELS, { judge: 'alpha' }))

    await click(judgeBox('beta'))
    expect(vi.mocked(applyConfigChanges).mock.calls.map(([changes]) => changes)).toEqual([
      [
        { op: 'expect', path: ['eval', 'judge'], value: 'alpha' },
        { op: 'expect', path: ['eval', 'judges'], value: null },
        { op: 'set', path: ['eval', 'judges'], value: ['alpha', 'beta'] },
        { op: 'unset', path: ['eval', 'judge'] },
      ],
    ])
  })
})

describe('EvalSection judge writes an outside edit moved (429-46 Task 2 · CR-01)', () => {
  function fieldChanged(path: string[]) {
    return new ApiError(409, 'Conflict', { error: 'field_changed', path })
  }

  function checkedNames() {
    return judgeBoxes().filter((box) => box.getAttribute('aria-checked') === 'true').map(labelOf)
  }

  it("JUDGE-TOGGLE-MERGES-OUTSIDE-JUDGE: a toggle refused field_changed lands on the file's new list after one re-read", async () => {
    await mount(withModels(MODELS, { judge: 'alpha' }))
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(fieldChanged(JUDGE))
    vi.mocked(fetchConfig).mockResolvedValue(answer(withModels(MODELS, { judges: ['alpha', 'delta'] })) as never)

    await click(judgeBox('gamma'))
    await flush()

    expect(vi.mocked(applyConfigChanges).mock.calls.map(([changes]) => changes)).toEqual([
      [
        ...expectsRead('alpha', null),
        { op: 'set', path: JUDGES, value: ['alpha', 'gamma'] },
        { op: 'unset', path: JUDGE },
      ],
      [
        ...expectsRead(null, ['alpha', 'delta']),
        { op: 'set', path: JUDGES, value: ['alpha', 'delta', 'gamma'] },
        { op: 'unset', path: JUDGE },
      ],
    ])
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(checkedNames()).toEqual(['alpha', 'gamma', 'delta'])
    expect(judgeBox('beta')!.disabled).toBe(true)
    expect(section().textContent).toContain(JUDGE_LIMIT_TEXT)
  })

  it("JUDGE-TOGGLE-MERGES-OUTSIDE-JUDGE: with the file's list full, the check is dropped and the full list shows", async () => {
    await mount(withModels(MODELS, { judges: ['alpha', 'beta'] }))
    vi.mocked(applyConfigChanges).mockRejectedValueOnce(fieldChanged(JUDGES))
    vi.mocked(fetchConfig).mockResolvedValue(
      answer(withModels(MODELS, { judges: ['alpha', 'beta', 'delta'] })) as never,
    )

    await click(judgeBox('gamma'))
    await flush()

    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    expect(fetchConfig).toHaveBeenCalledTimes(2)
    expect(checkedNames()).toEqual(['alpha', 'beta', 'delta'])
    expect(judgeBox('gamma')!.disabled).toBe(true)
    expect(section().textContent).toContain(JUDGE_LIMIT_TEXT)
  })
})
