// @vitest-environment jsdom

// Screenshot size and planner limits are ordinary fields that write once they settle.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlannerSection } from '@/components/config-manager/planner-section'
import { VisionSection } from '@/components/config-manager/vision-section'
import {
  ConfigAutosaveProvider,
  configFieldControlId,
  configFieldKeyOf,
  useConfigAutosave,
} from '@/hooks/use-config-autosave'
import { applyConfigChanges, fetchConfig, fetchConfigRevision } from '@/lib/api'
import { PLANNER_FIELD_LABELS, VISION_FIELD_LABELS } from '@/lib/config-copy'

const API_EXPORTS = Object.keys(await vi.importActual<typeof import('@/lib/api')>('@/lib/api'))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchConfig: vi.fn(),
  fetchConfigRevision: vi.fn(),
  applyConfigChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function answer(config: Record<string, unknown>) {
  return { config, provider: null, revision: 'rev-1', file: { path: '/work/agent-qa.config.yaml', lines: [] } }
}

function Harness() {
  const autosave = useConfigAutosave()
  if (autosave.load.kind !== 'ready') return null
  return (
    <ConfigAutosaveProvider value={autosave}>
      <section data-config-section="screenshot-size">
        <VisionSection />
      </section>
      <section data-config-section="planner-limits">
        <PlannerSection />
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

function input(segments: readonly string[]) {
  return document.getElementById(configFieldControlId(configFieldKeyOf(segments))) as HTMLInputElement | null
}

function labelFor(control: HTMLElement | null) {
  return control ? container?.querySelector(`label[for="${control.id}"]`)?.textContent : undefined
}

async function typeAndBlur(control: HTMLInputElement | null, value: string) {
  expect(control).not.toBeNull()
  await act(async () => {
    control!.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(control!, value)
    control!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    control!.blur()
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

describe('VisionSection and PlannerSection', () => {
  it('VISION-AUTOSAVES-BY-LEAF: the shared screenshot-size budget shows its saved values and each leaf writes itself, with no Save button or pop-up message', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(
      answer({ services: { vision: { screenshotSize: '128k', effectiveResolution: 512 } } }) as never,
    )
    await mount()

    const size = input(['services', 'vision', 'screenshotSize'])
    const edge = input(['services', 'vision', 'effectiveResolution'])
    expect(size?.value).toBe('128k')
    expect(edge?.value).toBe('512')
    expect(labelFor(size)).toBe(VISION_FIELD_LABELS.screenshotSize)
    expect(labelFor(edge)).toBe(VISION_FIELD_LABELS.effectiveResolution)
    expect(container!.querySelector('[data-field-path="services.vision.screenshotSize"]')).not.toBeNull()
    expect(container!.querySelector('[data-field-path="services.vision.effectiveResolution"]')).not.toBeNull()
    const buttons = Array.from(container!.querySelectorAll('button')).map((button) => button.textContent?.trim())
    expect(buttons).not.toContain('Save Changes')

    await typeAndBlur(size, '256k')
    await typeAndBlur(edge, '768')

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[{ op: 'set', path: ['services', 'vision', 'screenshotSize'], value: '256k' }]],
      [[{ op: 'set', path: ['services', 'vision', 'effectiveResolution'], value: 768 }]],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
    expect(document.body.querySelector('[data-sonner-toast]')).toBeNull()
  })

  it('PLANNER-LIMITS-AUTOSAVE: with no planner block, one limit writes itself with the other at its shown default', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(answer({ use: {} }) as never)
    await mount()

    const most = input(['use', 'planner', 'maxActions'])
    const earlier = input(['use', 'planner', 'previousStepCount'])
    expect(labelFor(most)).toBe(PLANNER_FIELD_LABELS.maxActions)
    expect(labelFor(earlier)).toBe(PLANNER_FIELD_LABELS.previousStepCount)
    expect(most?.value).toBe('')
    expect(most?.placeholder).toBe('30')
    expect(earlier?.placeholder).toBe('5')

    await typeAndBlur(most, '12')

    expect(vi.mocked(applyConfigChanges).mock.calls).toEqual([
      [[
        { op: 'set', path: ['use', 'planner', 'maxActions'], value: 12 },
        { op: 'set-if-absent', path: ['use', 'planner', 'previousStepCount'], value: 5 },
      ]],
    ])
    expect(API_EXPORTS).not.toContain('updateSettings')
  })
})
