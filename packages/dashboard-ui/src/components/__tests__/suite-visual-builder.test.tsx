// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteVisualBuilder } from '@/components/suite-visual-builder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchTestFiles: vi.fn().mockResolvedValue({
      files: [
        { path: 'web/login.yaml', name: 'Login', testId: 't_login', platform: 'web', modified: '2026-04-17' },
        { path: 'web/smoke.yaml', name: 'Smoke', testId: 't_smoke', platform: 'web', modified: '2026-04-17' },
      ],
    }),
  }
})

vi.mock('@/components/test-hooks-form', () => ({
  useTestHookCatalog: () => ({
    hooks: [
      { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'login', runtime: 'node', file: '/tmp/login.js', timeout: 30_000, network: false },
      { id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper', name: 'cleanup', runtime: 'node', file: '/tmp/cleanup.js', timeout: 30_000, network: false },
    ],
    warningCopy: null,
  }),
}))

vi.mock('@/components/suite-metadata-form', () => ({
  SuiteMetadataForm: ({ name, suiteId, target }: { name: string; suiteId: string; target: string }) => (
    <div data-testid="metadata-form">{name}|{suiteId}|{target}</div>
  ),
}))

vi.mock('@/components/suite-test-picker', () => ({
  SuiteTestPicker: ({
    availableTests,
    onAdd,
  }: {
    availableTests: Array<{ path: string; testId: string | null; name: string }>
    onAdd: (entry: { test: string; id: string }) => void
  }) => (
    <div data-testid="test-picker">
      picker:{availableTests.length}
      <button
        type="button"
        data-testid="suite-test-picker-trigger-add"
        onClick={() =>
          onAdd({
            test: availableTests[0]?.path ?? 'web/x.yaml',
            id: availableTests[0]?.testId ?? 't_x',
          })
        }
      >
        mock-add
      </button>
    </div>
  ),
}))

vi.mock('@/components/test-hook-token-field', () => ({
  TestHookListField: ({ phase, values }: { phase: string; values: string[] }) => (
    <div data-testid={`hook-list-${phase}`}>{values.length}</div>
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  closestCenter: () => null,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: () => null,
  useSensors: () => [],
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactElement }) => <>{children}</>,
  sortableKeyboardCoordinates: () => null,
  verticalListSortingStrategy: null,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}))

let container: HTMLDivElement
let root: Root

function mount(el: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MemoryRouter>{el}</MemoryRouter>)
  })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const yamlWithTwoTests = [
  'name: Smoke',
  'suite-id: s_able-acre-add-age-ago-air',
  'target: web',
  'tests:',
  '  - test: web/login.yaml',
  '    id: t_login',
  '  - test: web/smoke.yaml',
  '    id: t_smoke',
].join('\n')

describe('SuiteVisualBuilder', () => {
  it('renders metadata form, hooks (setup+teardown), and Add-new-test button (picker hidden by default)', async () => {
    mount(
      <SuiteVisualBuilder
        content={yamlWithTwoTests}
        onChange={vi.fn()}
        suggestions={[]}
      />
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="metadata-form"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hook-list-setup"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hook-list-teardown"]')).not.toBeNull()
    // Picker is now hidden behind a button (Gap 3)
    expect(container.querySelector('[data-testid="test-picker"]')).toBeNull()
    const addBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Add new test'),
    )
    expect(addBtn).toBeTruthy()
  })

  it('renders Tests-in-Suite count chip', async () => {
    mount(<SuiteVisualBuilder content={yamlWithTwoTests} onChange={vi.fn()} suggestions={[]} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('2 tests')
  })

  it('shows empty state when tests list is empty', async () => {
    mount(
      <SuiteVisualBuilder
        content={'name: Smoke\ntarget: web\ntests: []'}
        onChange={vi.fn()}
        suggestions={[]}
      />
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('No tests added yet')
  })

  it('renders YAML error banner for invalid YAML', () => {
    mount(<SuiteVisualBuilder content={'name: [unclosed'} onChange={vi.fn()} suggestions={[]} />)
    expect(container.textContent).toContain('YAML has errors')
  })

  it('forwards Hooks section to TestHookListField verbatim', async () => {
    const withHooks = [
      'name: S', 'target: t',
      'setup:', '  - login',
      'tests:', '  - test: a.yaml', '    id: t_a',
    ].join('\n')
    mount(<SuiteVisualBuilder content={withHooks} onChange={vi.fn()} suggestions={[]} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="hook-list-setup"]')!.textContent).toBe('1')
    expect(container.querySelector('[data-testid="hook-list-teardown"]')!.textContent).toBe('0')
  })

  // Gap 3 regression tests — Phase 181-04
  it('hides SuiteTestPicker by default behind an Add new test button', async () => {
    mount(<SuiteVisualBuilder content={yamlWithTwoTests} onChange={vi.fn()} suggestions={[]} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('[data-testid="test-picker"]')).toBeNull()
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Add new test'),
    )
    expect(btn).toBeTruthy()
    expect(btn!.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows SuiteTestPicker when Add new test button is clicked and keeps it open after onAdd (multi-add UX)', async () => {
    const onChange = vi.fn()
    mount(<SuiteVisualBuilder content={yamlWithTwoTests} onChange={onChange} suggestions={[]} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Add new test'),
    )
    expect(btn).toBeTruthy()
    act(() => { btn!.click() })
    expect(container.querySelector('[data-testid="test-picker"]')).toBeTruthy()
    // After add, picker stays visible so the user can add multiple tests in sequence
    const addTrigger = container.querySelector(
      '[data-testid="suite-test-picker-trigger-add"]',
    ) as HTMLButtonElement | null
    expect(addTrigger).not.toBeNull()
    act(() => { addTrigger!.click() })
    expect(container.querySelector('[data-testid="test-picker"]')).toBeTruthy()
    // onAdd wired through: onChange called with updated YAML (add flow invoked)
    expect(onChange).toHaveBeenCalled()
    // Toggle label reflects open state
    const hideBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Hide picker'),
    )
    expect(hideBtn).toBeTruthy()
    expect(hideBtn!.getAttribute('aria-expanded')).toBe('true')
  })
})
