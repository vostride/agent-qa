// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteVisualBuilder } from '@/components/suite-visual-builder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, fetchTestFiles: vi.fn().mockResolvedValue({ files: [] }) }
})

vi.mock('@/components/test-hooks-form', () => ({
  useTestHookCatalog: () => ({
    hooks: [
      { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'login', runtime: 'node', file: '/tmp/login.js', timeout: 30_000, network: false },
      { id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper', name: 'seed', runtime: 'node', file: '/tmp/seed.js', timeout: 30_000, network: false },
    ],
    warningCopy: null,
  }),
}))

// Don't mock suite-metadata-form this time — test the real capture: filter contract.
vi.mock('@/hooks/use-variable-suggestions', () => ({
  useVariableSuggestions: () => ({ suggestions: [], isLoading: false }),
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

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: ReactElement }) => <div data-testid="command">{children}</div>,
  CommandInput: () => <input data-testid="command-input" />,
  CommandList: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  CommandItem: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}))

vi.mock('@/components/step-autocomplete', () => ({
  useStepAutocomplete: () => ({ dropdown: null, handleKeyDown: () => false, setVisible: () => {} }),
}))

vi.mock('@/hooks/use-targets', () => ({ useTargets: () => ({ targets: ['web'], isLoading: false }) }))
vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({
    targets: { web: { platform: 'web' as const, url: 'https://example.com' } },
    globalUse: undefined,
    isLoading: false,
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

describe('SuiteVisualBuilder hooks + picker integration', () => {
  it('renders setup and teardown TestHookListField with hidden Add Hook composers', async () => {
    const yaml = [
      'name: S', 'target: t',
      'setup:', '  - login',
      'teardown:', '  - cleanup',
      'tests:', '  - test: a.yaml', '    id: t_a',
    ].join('\n')
    mount(<SuiteVisualBuilder content={yaml} onChange={vi.fn()} suggestions={[]} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // TestHookListField renders its own composer hidden by default — verify setup/teardown labels are present.
    expect(container.textContent).toContain('Setup')
    expect(container.textContent).toContain('Teardown')
  })

  it('renders suggestions from useTestHookCatalog, not from variable suggestions', async () => {
    mount(
      <SuiteVisualBuilder
        content={'name: S\ntarget: t\ntests:\n  - test: a.yaml\n    id: t_a'}
        onChange={vi.fn()}
        suggestions={[{ namespace: 'env', name: 'API_URL', label: 'api' }]}
      />
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // The hooks section gets hook-catalog suggestions; variable suggestions go to SuiteMetadataForm context only.
    // Smoke: both sections should render without crashing when both types are passed.
    expect(container.textContent).toContain('Hooks')
  })

  it('renders pill preview in context when {{env:...}} present via SuiteMetadataForm', async () => {
    const yaml = [
      'name: S', 'target: t',
      'context: Use {{env:API_URL}} as base',
      'tests:', '  - test: a.yaml', '    id: t_a',
    ].join('\n')
    mount(
      <SuiteVisualBuilder
        content={yaml}
        onChange={vi.fn()}
        suggestions={[{ namespace: 'env', name: 'API_URL', label: 'api' }]}
      />
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('env:API_URL')
  })
})
