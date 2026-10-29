// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { TestSettingsPanel } from '@/components/test-settings-panel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const targetState = vi.hoisted(() => ({
  targets: {
    'web-app': { platform: 'web', url: 'https://example.com' },
    'mobile-app': { platform: 'android', appPackage: 'com.example.app' },
  },
  globalUse: {
    browser: { name: 'chromium', headless: true },
    mobile: { appState: 'preserve' },
  },
}))

vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: targetState.targets,
    globalUse: targetState.globalUse,
    isLoading: false,
  }),
}))

let container: HTMLDivElement
let root: Root
let latestYaml = ''

function renderPanel(initialContent: string, selectedTarget = 'web-app') {
  function Harness() {
    const [content, setContent] = useState(initialContent)
    latestYaml = content
    return (
      <TestSettingsPanel
        content={content}
        onChange={(next) => {
          latestYaml = next
          setContent(next)
        }}
        selectedTarget={selectedTarget}
      />
    )
  }

  act(() => {
    root.render(<Harness />)
  })
}

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id)
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${id}`)
  return input
}

function switchById(id: string): HTMLButtonElement {
  const button = document.getElementById(id)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing switch ${id}`)
  return button
}

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function expectSwitchState(id: string, checked: boolean) {
  expect(switchById(id).getAttribute('aria-checked')).toBe(String(checked))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  latestYaml = ''
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('TestSettingsPanel auth state controls', () => {
  it('hydrates shorthand auth state with default load and capture values', () => {
    renderPanel('name: Demo\nuse:\n  authState: admin\nsteps: []\n')

    expect(inputById('auth-state-name').value).toBe('admin')
    expectSwitchState('auth-state-load', true)
    expectSwitchState('auth-state-capture', false)
  })

  it('hydrates object-form auth state accurately', () => {
    renderPanel('name: Demo\nuse:\n  authState:\n    name: demo-acc\n    load: false\n    capture: true\nsteps: []\n')

    expect(inputById('auth-state-name').value).toBe('demo-acc')
    expectSwitchState('auth-state-load', false)
    expectSwitchState('auth-state-capture', true)
    expect(document.body.textContent).toContain('Starts without saved auth state')
    expect(document.body.textContent).toContain('Capture creates or replaces')
  })

  it('turning capture on writes object form', () => {
    renderPanel('name: Demo\nuse:\n  authState: admin\nsteps: []\n')

    click(switchById('auth-state-capture'))

    expect(latestYaml).toContain('authState:')
    expect(latestYaml).toContain('name: admin')
    expect(latestYaml).toContain('capture: true')
  })

  it('turning load off writes object form', () => {
    renderPanel('name: Demo\nuse:\n  authState: admin\nsteps: []\n')

    click(switchById('auth-state-load'))

    expect(latestYaml).toContain('authState:')
    expect(latestYaml).toContain('name: admin')
    expect(latestYaml).toContain('load: false')
  })

  it('returning to default load and capture writes shorthand', () => {
    renderPanel('name: Demo\nuse:\n  authState:\n    name: admin\n    capture: true\nsteps: []\n')

    click(switchById('auth-state-capture'))

    expect(latestYaml).toContain('authState: admin')
    expect(latestYaml).not.toContain('capture: true')
    expect(latestYaml).not.toContain('load: false')
  })

  it('clearing auth state name removes use.authState', () => {
    renderPanel('name: Demo\nuse:\n  authState: admin\nsteps: []\n')

    setInputValue(inputById('auth-state-name'), '')

    expect(latestYaml).not.toContain('authState')
    expect(switchById('auth-state-load').disabled).toBe(true)
    expect(switchById('auth-state-capture').disabled).toBe(true)
  })

  it('keeps invalid auth-state YAML empty and disabled', () => {
    renderPanel('name: Demo\nuse:\n  authState: ../admin.json\nsteps: []\n')

    expect(inputById('auth-state-name').value).toBe('')
    expect(switchById('auth-state-load').disabled).toBe(true)
    expect(switchById('auth-state-capture').disabled).toBe(true)
  })

  it('shows a mobile notice instead of producer controls when mobile YAML has authState', () => {
    renderPanel('name: Demo\nuse:\n  authState: admin\n  mobile:\n    appState: preserve\nsteps: []\n', 'mobile-app')

    expect(document.body.textContent).toContain('Web auth state is not available for mobile targets')
    expect(document.getElementById('auth-state-name')).toBeNull()
    expect(document.getElementById('auth-state-load')).toBeNull()
    expect(latestYaml).toContain('authState: admin')
  })
})

// 436-19 (D-02, D-03, WR-11): the panel writes a limit only as a positive whole number.
describe('the limit inputs', () => {
  function limitInput(label: string): HTMLInputElement {
    const owner = Array.from(document.querySelectorAll('label')).find((el) => el.textContent === label)
    const input = owner?.parentElement?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing limit input ${label}`)
    return input
  }

  function plannerOf(yaml: string): Record<string, unknown> | undefined {
    return (parseYaml(yaml) as { use?: { planner?: Record<string, unknown> } } | null)?.use?.planner
  }

  it('a positive whole number is written', () => {
    renderPanel('name: Demo\nsteps: []\n')

    setInputValue(limitInput('Max Actions'), '1')
    expect(plannerOf(latestYaml)?.maxActions).toBe(1)
    setInputValue(limitInput('Max Actions'), '60')
    expect(plannerOf(latestYaml)?.maxActions).toBe(60)

    setInputValue(limitInput('Planner Calls'), '1')
    expect(plannerOf(latestYaml)?.maxPlanningTurns).toBe(1)
    setInputValue(limitInput('Planner Calls'), '45')
    expect(plannerOf(latestYaml)?.maxPlanningTurns).toBe(45)
    expect(limitInput('Max Actions').getAttribute('aria-invalid')).toBeNull()
  })

  it('invalid input is refused in place', () => {
    const initial = 'name: Demo\nuse:\n  planner:\n    maxActions: 60\n    maxPlanningTurns: 12\nsteps: []\n'
    renderPanel(initial)

    for (const label of ['Max Actions', 'Planner Calls']) {
      for (const typed of ['0', '-3', '2.5', '1e9']) {
        setInputValue(limitInput(label), typed)
        const input = limitInput(label)
        expect(plannerOf(latestYaml)?.maxActions).toBe(60)
        expect(plannerOf(latestYaml)?.maxPlanningTurns).toBe(12)
        expect(latestYaml).toBe(initial)
        expect(input.value).toBe(typed)
        expect(input.getAttribute('aria-invalid')).toBe('true')
        const describedBy = input.getAttribute('aria-describedby') ?? ''
        const error = describedBy === '' ? null : document.getElementById(describedBy)
        expect(error?.textContent).toContain(label)
      }
    }
  })

  it('an empty input removes the key', () => {
    renderPanel('name: Demo\nuse:\n  planner:\n    maxActions: 60\n    maxPlanningTurns: 12\nsteps: []\n')

    setInputValue(limitInput('Max Actions'), '')
    expect(plannerOf(latestYaml)).toEqual({ maxPlanningTurns: 12 })
    expect(limitInput('Max Actions').getAttribute('aria-invalid')).toBeNull()
  })
})
