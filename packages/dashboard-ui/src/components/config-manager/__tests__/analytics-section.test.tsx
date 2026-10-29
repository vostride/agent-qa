// @vitest-environment jsdom

// Attribute values are secret-classed, so each row shows its key in clear and its value masked.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsSection } from '@/components/config-manager/analytics-section'
import { ConfigAutosaveProvider, useConfigAutosave, type ConfigAutosave } from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import {
  ADD_ATTRIBUTE_LABEL,
  ATTRIBUTE_FIELD_LABELS,
  ATTRIBUTE_PATTERN_TAG,
  DISCARD_SETTING_LABEL,
  MATCH_AS_PATTERN_LABEL,
  PRIVACY_FIELD_LABELS,
  SAVE_SETTING_LABEL,
  SETTLE_DELAY_MS,
  attributeValueLabel,
  removeAttributeName,
  replaceValueName,
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
const MASK = '[masked]'
const TYPED = 'staging-typed-7Q'
const ATTRIBUTES = ['analytics', 'passRateScope', 'attributes']

// The server's masked form of { 'git.branch': 'main', team: { regex: 'qa-.*' } }.
const twoAttributes = {
  analytics: {
    passRateScope: {
      attributes: {
        'git.branch': MASK,
        team: { regex: MASK },
      },
    },
  },
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
      <AnalyticsSection config={autosave.load.answer.config} onConfigChange={autosave.refresh} />
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
    root!.render(<Harness />)
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

function list() {
  return container?.querySelector('[data-field-list="analytics.passRateScope.attributes"]') as HTMLElement | null
}

function attributeRow(key: string) {
  return (Array.from(container?.querySelectorAll('[data-pass-rate-attribute]') ?? []) as HTMLElement[]).find(
    (row) => row.getAttribute('data-pass-rate-attribute') === key,
  ) ?? null
}

function buttonIn(scope: ParentNode | null | undefined, text: string) {
  const buttons = Array.from(scope?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text) ?? null
}

function inputLabelled(scope: ParentNode | null | undefined, label: string) {
  const inputs = Array.from(scope?.querySelectorAll('input') ?? []) as HTMLInputElement[]
  return inputs.find((input) => input.getAttribute('aria-label') === label) ?? null
}

function switchLabelled(label: string) {
  const labels = Array.from(container?.querySelectorAll('label') ?? []) as HTMLLabelElement[]
  const match = labels.find((item) => item.textContent?.trim() === label)
  const id = match?.getAttribute('for')
  return id ? (document.getElementById(id) as HTMLButtonElement | null) : null
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.focus()
    element!.click()
  })
  await flush()
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input!, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.mocked(fetchConfig).mockResolvedValue(answer(twoAttributes) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('AnalyticsSection', () => {
  it('PASS-RATE-ATTRIBUTES-SECRET-ROWS: each attribute is its key in clear and a SecretValue showing the server mask, a dotted key staying one segment', async () => {
    await mount()

    expect(list()).not.toBeNull()
    const branch = attributeRow('git.branch')
    const team = attributeRow('team')
    expect(branch).not.toBeNull()
    expect(team).not.toBeNull()
    expect(branch!.querySelector('.font-mono')?.textContent).toBe('git.branch')
    expect(team!.querySelector('.font-mono')?.textContent).toBe('team')

    const branchSecret = branch!.querySelector('[data-secret-field]')
    const teamSecret = team!.querySelector('[data-secret-field]')
    expect(branchSecret?.getAttribute('data-field-path')).toBe('analytics.passRateScope.attributes.*')
    expect(teamSecret?.getAttribute('data-field-path')).toBe('analytics.passRateScope.attributes.*.regex')
    for (const secret of [branchSecret, teamSecret]) {
      expect(secret?.querySelector('code')?.textContent).toBe(MASK)
      expect(secret?.querySelectorAll('button')).toHaveLength(1)
    }
    expect(team!.textContent).toContain(ATTRIBUTE_PATTERN_TAG)
    expect(branch!.textContent).not.toContain(ATTRIBUTE_PATTERN_TAG)
    expect(buttonIn(branch, replaceValueName(attributeValueLabel('git.branch')))).not.toBeNull()
    expect(container!.querySelectorAll('input[type="text"], input[type="password"], textarea')).toHaveLength(0)
    expect(applyConfigChanges).not.toHaveBeenCalled()
  })

  it('ADD-ATTRIBUTE-EXPLICIT: a typed key and value write nothing until Save setting, which writes one set, as a pattern when switched', async () => {
    await mount()

    await click(buttonIn(container, ADD_ATTRIBUTE_LABEL))
    const key = inputLabelled(container, ATTRIBUTE_FIELD_LABELS.key)
    const value = inputLabelled(container, ATTRIBUTE_FIELD_LABELS.value)
    expect(key?.type).toBe('text')
    expect(value?.type).toBe('password')
    expect(value?.getAttribute('autocomplete')).toBe('off')
    await type(key, 'build.env')
    await type(value, TYPED)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 3)
    })
    await flush()
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)

    await click(buttonIn(container, SAVE_SETTING_LABEL))
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: [...ATTRIBUTES, 'build.env'], value: TYPED }]],
    ])
    // The landed write is mirrored as written.
    expect(attributeRow('build.env')?.querySelector('[data-secret-field] code')?.textContent).toBe(TYPED)
    expect(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.value)).toBeNull()
    expect(hook!.status.state).not.toBe('undo')

    await click(buttonIn(container, ADD_ATTRIBUTE_LABEL))
    await type(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.key), 'owner')
    await type(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.value), '^qa-')
    const pattern = switchLabelled(MATCH_AS_PATTERN_LABEL)
    expect(pattern?.getAttribute('role')).toBe('switch')
    await click(pattern)
    expect(applyConfigChanges).toHaveBeenCalledTimes(1)
    await click(buttonIn(container, SAVE_SETTING_LABEL))
    expect(vi.mocked(applyConfigChanges).mock.calls.at(-1)).toEqual([
      [{ op: 'set', path: [...ATTRIBUTES, 'owner'], value: { regex: '^qa-' } }],
    ])

    await click(buttonIn(container, ADD_ATTRIBUTE_LABEL))
    await type(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.key), 'extra')
    await type(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.value), 'discarded')
    await click(buttonIn(container, DISCARD_SETTING_LABEL))
    expect(applyConfigChanges).toHaveBeenCalledTimes(2)
    expect(inputLabelled(container, ATTRIBUTE_FIELD_LABELS.value)).toBeNull()
    expect(document.activeElement).toBe(buttonIn(container, ADD_ATTRIBUTE_LABEL))
  })

  it('REMOVE-ATTRIBUTE-AT-ONCE: the remove button takes the row away and writes one unset at once', async () => {
    await mount()

    const remove = buttonIn(attributeRow('git.branch'), removeAttributeName('git.branch'))
    expect(remove?.querySelector('svg')).not.toBeNull()
    await click(remove)

    expect(attributeRow('git.branch')).toBeNull()
    expect(attributeRow('team')).not.toBeNull()
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'unset', path: [...ATTRIBUTES, 'git.branch'] }]],
    ])
  })

  it('PASS-RATE-PRIVACY-SWITCH: switching privacy on writes true, and switching it off removes the key', async () => {
    await mount()

    const privacy = switchLabelled(PRIVACY_FIELD_LABELS.privacy)
    expect(privacy?.getAttribute('role')).toBe('switch')
    expect(privacy?.closest('[data-field-path]')?.getAttribute('data-field-path')).toBe('analytics.privacy')
    expect(privacy?.getAttribute('aria-checked')).toBe('false')

    await click(privacy)
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['analytics', 'privacy'], value: true }]],
    ])
    expect(privacy?.getAttribute('aria-checked')).toBe('true')

    await click(privacy)
    expect(vi.mocked(applyConfigChanges).mock.calls.at(-1)).toEqual([
      [{ op: 'unset', path: ['analytics', 'privacy'] }],
    ])
    expect(privacy?.getAttribute('aria-checked')).toBe('false')
    expect(vi.mocked(applyConfigChanges).mock.calls.flat(2)).not.toContainEqual(
      expect.objectContaining({ value: false }),
    )
  })
})
