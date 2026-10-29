// @vitest-environment jsdom

// TARGETS AND DEVICES AS IN-ROW RECORD LISTS (429-22 Task 1 · D-02, D-08, D-19, D-23, D-24 · UI-SPEC S2, S6, E6, E8).
//
// Every target and device edit happens in its row and autosaves; an add is an inline draft row
// that writes nothing until the whole entry is valid; a delete acts at once with Undo and moves
// focus to a neighbour, else the Add button. Device match values are secret-class: each key in
// clear, each value a SecretValue, a new setting saved only through Save setting.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DevicesSection } from '@/components/config-manager/devices-section'
import { TargetsSection } from '@/components/config-manager/targets-section'
import {
  ConfigAutosaveProvider,
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosave,
  type ConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision, undoConfigAction } from '@/lib/api'
import {
  ADD_DEVICE_LABEL,
  ADD_SETTING_LABEL,
  ADD_TARGET_LABEL,
  DEVICE_FIELD_LABELS,
  NO_DEVICES_TEXT,
  NO_TARGETS_TEXT,
  SAVE_SETTING_LABEL,
  SETTLE_DELAY_MS,
  TARGET_ENVIRONMENT_CHOICE_LABELS,
  TARGET_ENVIRONMENT_LABELS,
  TARGET_FIELD_LABELS,
  TARGET_URL_REQUIRED_ERROR,
  deleteActionName,
  deviceMatchSettingLabel,
  replaceValueName,
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
const MASK = '[masked]'

const records = {
  registry: {
    targets: {
      alpha: { platform: 'web', url: 'https://alpha.example.com' },
      staging: { platform: 'web', url: 'https://staging.example.com' },
      gamma: { platform: 'android', appPackage: 'com.example.gamma' },
    },
    devices: {
      iosLocal: { platform: 'ios', match: { udid: MASK } },
      pixel: { platform: 'android', match: {} },
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
  const config = autosave.load.answer.config
  return (
    <ConfigAutosaveProvider value={autosave}>
      <section data-config-section="targets">
        <TargetsSection config={config} onConfigChange={autosave.refresh} />
      </section>
      <section data-config-section="devices">
        <DevicesSection config={config} onConfigChange={autosave.refresh} />
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

function section(id: 'targets' | 'devices') {
  return container?.querySelector(`[data-config-section="${id}"]`) as HTMLElement | null
}

function targetRow(name: string) {
  return (Array.from(container?.querySelectorAll('[data-target]') ?? []) as HTMLElement[]).find(
    (row) => row.getAttribute('data-target') === name,
  ) ?? null
}

function deviceRow(name: string) {
  return (Array.from(container?.querySelectorAll('[data-device]') ?? []) as HTMLElement[]).find(
    (row) => row.getAttribute('data-device') === name,
  ) ?? null
}

function rowHeader(row: HTMLElement | null) {
  return (row?.querySelector('[data-row-header]') ?? null) as HTMLButtonElement | null
}

function buttonIn(scope: ParentNode | null | undefined, text: string) {
  const buttons = Array.from(scope?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  return buttons.find((button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text) ?? null
}

function inputLabelled(scope: ParentNode | null | undefined, label: string) {
  const inputs = Array.from(scope?.querySelectorAll('input') ?? []) as HTMLInputElement[]
  return inputs.find((input) => input.getAttribute('aria-label') === label) ?? null
}

function fieldInput(segments: readonly string[]) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(segments))) as HTMLInputElement | null
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
    input!.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input!, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function pressEnter(input: HTMLInputElement | null) {
  expect(input).not.toBeNull()
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flush()
}

async function waitPastSettle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS * 3)
  })
  await flush()
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
  vi.mocked(fetchConfig).mockResolvedValue(answer(records) as never)
  vi.mocked(fetchConfigRevision).mockResolvedValue({ revision: 'rev-1' })
  vi.mocked(applyConfigChanges).mockResolvedValue({ revision: 'rev-2' } as never)
})

afterEach(async () => {
  await unmount()
  vi.clearAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('TargetsSection and DevicesSection', () => {
  it('TARGET-EDIT-IN-ROW-AUTOSAVES: changing a target URL in its row writes that one leaf after the pause, with no dialog', async () => {
    await mount()

    expect(section('targets')!.querySelector('[data-field-list="registry.targets"]')).not.toBeNull()
    expect(buttonIn(section('targets'), 'Edit')).toBeNull()
    expect(buttonIn(section('targets'), 'Save Changes')).toBeNull()

    const header = rowHeader(targetRow('staging'))
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    await click(header)
    expect(rowHeader(targetRow('staging'))?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    const url = fieldInput(['registry', 'targets', 'staging', 'url'])
    expect(url?.value).toBe('https://staging.example.com')
    await type(url, 'https://staging-2.example.com')
    expect(applyConfigChanges).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS)
    })
    await flush()

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'targets', 'staging', 'url'], value: 'https://staging-2.example.com' }]],
    ])
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('TARGET-DELETE-UNDO: delete removes the row at once with one undoable unset, and Undo restores it with focus on it', async () => {
    await mount()
    const write = deferred<{ revision: string; undo: { token: string; expiresAt: number } }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(write.promise as never)

    const remove = buttonIn(targetRow('staging'), deleteActionName('delete-target', 'staging'))
    expect(remove?.querySelector('svg')?.getAttribute('class')).toContain('lucide-trash')
    await click(remove)

    expect(targetRow('staging')).toBeNull()
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'unset', path: ['registry', 'targets', 'staging'] }], { undoable: true }],
    ])

    await act(async () => {
      write.resolve({ revision: 'rev-2', undo: { token: 'tok-target', expiresAt: Date.now() + 30_000 } })
    })
    await flush()
    expect(targetRow('staging')).toBeNull()
    expect(hook!.status.state).toBe('undo')
    expect(hook!.status.undo?.line).toBe(undoLine('delete-target', 'staging'))

    vi.mocked(undoConfigAction).mockResolvedValueOnce({ restored: true, revision: 'rev-3' })
    await act(async () => {
      await hook!.undo()
    })
    await flush()

    expect(undoConfigAction).toHaveBeenCalledWith('tok-target')
    expect(targetRow('staging')).not.toBeNull()
    expect(document.activeElement).toBe(rowHeader(targetRow('staging')))
  })

  it('DEVICE-DELETE-UNDO: deleting a device removes its row at once with one undoable unset, and Undo restores it with focus on it', async () => {
    await mount()
    vi.mocked(applyConfigChanges).mockResolvedValueOnce({
      revision: 'rev-2',
      undo: { token: 'tok-device', expiresAt: Date.now() + 30_000 },
    } as never)

    await click(buttonIn(deviceRow('iosLocal'), deleteActionName('delete-device', 'iosLocal')))

    expect(deviceRow('iosLocal')).toBeNull()
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'unset', path: ['registry', 'devices', 'iosLocal'] }], { undoable: true }],
    ])
    expect(hook!.status.undo?.line).toBe(undoLine('delete-device', 'iosLocal'))

    vi.mocked(undoConfigAction).mockResolvedValueOnce({ restored: true, revision: 'rev-3' })
    await act(async () => {
      await hook!.undo()
    })
    await flush()

    expect(deviceRow('iosLocal')).not.toBeNull()
    expect(document.activeElement).toBe(rowHeader(deviceRow('iosLocal')))
  })

  it('FOCUS-AFTER-DELETE: focus moves to the next row, else the previous one, else the Add button beside the empty sentence', async () => {
    await mount()

    await click(buttonIn(targetRow('staging'), deleteActionName('delete-target', 'staging')))
    expect(document.activeElement).toBe(rowHeader(targetRow('gamma')))

    await click(buttonIn(targetRow('gamma'), deleteActionName('delete-target', 'gamma')))
    expect(document.activeElement).toBe(rowHeader(targetRow('alpha')))

    const write = deferred<{ revision: string }>()
    vi.mocked(applyConfigChanges).mockReturnValueOnce(write.promise as never)
    await click(buttonIn(targetRow('alpha'), deleteActionName('delete-target', 'alpha')))

    expect(section('targets')!.textContent).toContain(NO_TARGETS_TEXT)
    expect(document.activeElement).toBe(buttonIn(section('targets'), ADD_TARGET_LABEL))
    await act(async () => {
      write.resolve({ revision: 'rev-4' })
    })
    await flush()
    expect(section('targets')!.querySelector('[data-target]')).toBeNull()

    await click(buttonIn(deviceRow('iosLocal'), deleteActionName('delete-device', 'iosLocal')))
    await click(buttonIn(deviceRow('pixel'), deleteActionName('delete-device', 'pixel')))
    expect(section('devices')!.textContent).toContain(NO_DEVICES_TEXT)
    expect(document.activeElement).toBe(buttonIn(section('devices'), ADD_DEVICE_LABEL))
  })

  it('DEVICE-MATCH-SECRET-ROWS: each match key is in clear with its value through SecretValue, and Add setting writes only on Save setting', async () => {
    await mount()

    await click(rowHeader(deviceRow('iosLocal')))
    const row = deviceRow('iosLocal')!
    const secret = row.querySelector('[data-secret-field]') as HTMLElement | null
    expect(secret?.getAttribute('data-field-path')).toBe('registry.devices.*.match.*')
    expect(secret?.querySelector('code')?.textContent).toBe(MASK)
    expect(secret?.querySelectorAll('button')).toHaveLength(1)
    expect(row.querySelector('dt')?.textContent).toBe('udid')
    expect(buttonIn(row, replaceValueName(deviceMatchSettingLabel('iosLocal', 'udid')))).not.toBeNull()
    expect(row.querySelector('input[type="password"], textarea, pre')).toBeNull()

    await click(buttonIn(row, ADD_SETTING_LABEL))
    const key = inputLabelled(deviceRow('iosLocal'), DEVICE_FIELD_LABELS.key)
    const value = inputLabelled(deviceRow('iosLocal'), DEVICE_FIELD_LABELS.value)
    expect(value?.type).toBe('password')

    await type(key, 'serial')
    await type(value, 'device-secret')
    expect(buttonIn(deviceRow('iosLocal'), SAVE_SETTING_LABEL)?.disabled).toBe(true)

    await type(key, 'bundleId')
    await waitPastSettle()
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)

    await click(buttonIn(deviceRow('iosLocal'), SAVE_SETTING_LABEL))

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'devices', 'iosLocal', 'match', 'bundleId'], value: 'device-secret' }]],
    ])
    expect(deviceRow('iosLocal')!.querySelectorAll('[data-secret-field]')).toHaveLength(2)
    // the landed write is mirrored as written.
    expect(container!.textContent).toContain('device-secret')
  })

  it('ADD-ROW-DRAFT-UNTIL-VALID: Add target opens an inline draft row that writes nothing until it is valid, then one set of the whole target', async () => {
    await mount()

    await click(buttonIn(section('targets'), ADD_TARGET_LABEL))
    const draft = section('targets')!.querySelector('[data-target-draft]') as HTMLElement | null
    expect(draft).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    const name = draft!.querySelector('input[name="name"]') as HTMLInputElement | null
    expect(document.activeElement).toBe(name)

    await type(name, 'checkout')
    await pressEnter(name)
    await waitPastSettle()

    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect(draft!.querySelector('[data-field-error]')?.textContent).toContain(TARGET_URL_REQUIRED_ERROR)
    expect((draft!.querySelector('input[name="url"]') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true')
    expect(hook!.status.state).toBe('draft')
    expect(hook!.draftTabs.has('targets')).toBe(true)

    const url = draft!.querySelector('input[name="url"]') as HTMLInputElement
    await type(url, 'https://checkout.example.com')
    await pressEnter(url)

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'targets', 'checkout'], value: { platform: 'web', url: 'https://checkout.example.com' } }]],
    ])
    expect(section('targets')!.querySelector('[data-target-draft]')).toBeNull()
    expect(targetRow('checkout')).not.toBeNull()
    expect(hook!.draftTabs.has('targets')).toBe(false)
  })

  it('the add row offers Undeclared, Local, Shared and Production as plain choices, keeps typed labels, and saves the class', async () => {
    await mount()

    await click(buttonIn(section('targets'), ADD_TARGET_LABEL))
    const draft = section('targets')!.querySelector('[data-target-draft]') as HTMLElement
    const group = draft.querySelector('[data-target-environment]') as HTMLElement | null
    expect(group).not.toBeNull()
    expect(group!.querySelector('legend')?.textContent).toBe(TARGET_FIELD_LABELS.environment)

    const choices = ['undeclared', 'local', 'shared', 'production'] as const
    const labels = TARGET_ENVIRONMENT_CHOICE_LABELS
    expect(labels.undeclared).toBe('Undeclared')
    expect(Array.from(group!.querySelectorAll('[data-environment-choice]')).map((item) =>
      item.getAttribute('data-environment-choice'))).toEqual([...choices])
    for (const choice of choices) {
      const item = group!.querySelector(`[data-environment-choice="${choice}"]`) as HTMLElement
      expect(item.textContent).toBe(labels[choice])
      const radio = item.querySelector('[role="radio"]') as HTMLElement
      expect(radio.hasAttribute('aria-describedby')).toBe(false)
    }
    const radioFor = (choice: (typeof choices)[number]) =>
      group!.querySelector(`[data-environment-choice="${choice}"] [role="radio"]`) as HTMLElement
    expect(radioFor('undeclared').getAttribute('aria-checked')).toBe('true')

    // A class chosen before the row is valid writes nothing and keeps what was typed.
    const name = draft.querySelector('input[name="name"]') as HTMLInputElement
    await type(name, 'checkout-ünïcode')
    await click(radioFor('local'))
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect((draft.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('checkout-ünïcode')
    expect(radioFor('local').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radioFor('local'))

    // The label the file would refuse is held with its error, never rewritten.
    await pressEnter(draft.querySelector('input[name="name"]') as HTMLInputElement)
    expect(applyConfigChanges).not.toHaveBeenCalled()
    expect((draft.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('checkout-ünïcode')
    expect(draft.querySelector('[data-draft-field="name"] [data-field-error]')).not.toBeNull()

    await type(draft.querySelector('input[name="name"]') as HTMLInputElement, 'checkout')
    await type(draft.querySelector('input[name="url"]') as HTMLInputElement, 'http://localhost:3000')
    expect(radioFor('local').getAttribute('aria-checked')).toBe('true')

    const saved = {
      registry: {
        targets: {
          ...records.registry.targets,
          checkout: { platform: 'web', url: 'http://localhost:3000', environment: 'production' },
        },
        devices: records.registry.devices,
      },
    }
    vi.mocked(fetchConfig).mockResolvedValue(answer(saved) as never)
    await click(radioFor('production'))

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{
        op: 'set',
        path: ['registry', 'targets', 'checkout'],
        value: { platform: 'web', url: 'http://localhost:3000', environment: 'production' },
      }]],
    ])
    await flush()
    expect(section('targets')!.querySelector('[data-target-draft]')).toBeNull()

    // The saved declaration, read back through the row's own environment field.
    await click(rowHeader(targetRow('checkout')))
    const environment = fieldInput(['registry', 'targets', 'checkout', 'environment'])
    expect(environment?.textContent).toContain(TARGET_ENVIRONMENT_LABELS.production)
  })

  it('Undeclared saves no environment key, and the compact row wraps its choices', async () => {
    await mount()

    await click(buttonIn(section('targets'), ADD_TARGET_LABEL))
    const draft = section('targets')!.querySelector('[data-target-draft]') as HTMLElement
    const group = draft.querySelector('[data-target-environment] [role="radiogroup"]') as HTMLElement | null
    expect(group).not.toBeNull()
    expect(group?.className).toContain('flex-wrap')

    const radio = (choice: string) =>
      draft.querySelector(`[data-environment-choice="${choice}"] [role="radio"]`) as HTMLElement
    await click(radio('shared'))
    await click(radio('undeclared'))
    await type(draft.querySelector('input[name="name"]') as HTMLInputElement, 'plain')
    const url = draft.querySelector('input[name="url"]') as HTMLInputElement
    await type(url, 'https://plain.example.com')
    await pressEnter(url)

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'targets', 'plain'], value: { platform: 'web', url: 'https://plain.example.com' } }]],
    ])
  })

  it('an existing production target reads back as Production when its row is edited', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer({
      registry: {
        targets: {
          ...records.registry.targets,
          live: { platform: 'web', url: 'https://live.example.com', environment: 'production' },
        },
        devices: records.registry.devices,
      },
    }) as never)
    await mount()

    await click(rowHeader(targetRow('live')))
    expect(fieldInput(['registry', 'targets', 'live', 'environment'])?.textContent)
      .toContain(TARGET_ENVIRONMENT_LABELS.production)
    // The URL typed in the same row is kept while the class is shown, and saved as one leaf.
    const url = fieldInput(['registry', 'targets', 'live', 'url'])
    await type(url, 'https://live-2.example.com')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS)
    })
    await flush()
    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['registry', 'targets', 'live', 'url'], value: 'https://live-2.example.com' }]],
    ])
  })

  it('the chosen class is held with the draft, beside the typed name', async () => {
    await mount()

    await click(buttonIn(section('targets'), ADD_TARGET_LABEL))
    const draft = section('targets')!.querySelector('[data-target-draft]') as HTMLElement
    await click(draft.querySelector('[data-environment-choice="shared"] [role="radio"]') as HTMLElement)
    await type(draft.querySelector('input[name="name"]') as HTMLInputElement, 'phone')
    // The held draft is what a tab change restores, so the class must be part of it.
    expect(JSON.parse(String(hook!.valueOf({ segments: ['registry', 'targets'], tab: 'targets' })))).toMatchObject({
      name: 'phone',
      environment: 'shared',
    })
  })
})

// 2026-10-03 (quick 261003-cpv, 432 review IN-33): the guard that decides whether a draft writes
// `registry.targets.<name>.environment` admits the three classes and nothing a prototype carries.
describe('the target environment guard', () => {
  it('admits local, shared and production, and no inherited key', async () => {
    const { isTargetEnvironment } = await import('@/components/config-manager/targets-section')
    expect(typeof isTargetEnvironment).toBe('function')
    for (const value of ['local', 'shared', 'production']) expect(isTargetEnvironment(value), value).toBe(true)
    for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', 'undeclared']) {
      expect(isTargetEnvironment(value), value).toBe(false)
    }
  })
})
