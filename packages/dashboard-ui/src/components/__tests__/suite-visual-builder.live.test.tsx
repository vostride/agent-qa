// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SuiteVisualBuilder } from '@/components/suite-visual-builder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchTestFiles: vi.fn().mockResolvedValue({
      files: [
        { path: 'tests/web/login.yaml', name: 'Login flow' },
        { path: 'tests/web/checkout.yaml', name: 'Checkout flow' },
      ],
    }),
  }
})

vi.mock('@/components/test-hooks-form', () => ({
  useTestHookCatalog: () => ({
    hooks: [
      { id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle', name: 'login', runtime: 'node', file: '/tmp/login.js', timeout: 30_000, network: false },
    ],
    warningCopy: null,
  }),
}))

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
  Command: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  CommandInput: () => <input />,
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

const SUITE_YAML = [
  'name: Suite',
  'target: web',
  'setup:',
  '  - login',
  'teardown:',
  '  - cleanup',
  'tests:',
  '  - test: tests/web/login.yaml',
  '    id: t_login',
  '  - test: tests/web/checkout.yaml',
  '    id: t_checkout',
].join('\n')

function mount(el: ReactElement) {
  act(() => {
    root.render(<MemoryRouter>{el}</MemoryRouter>)
  })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SuiteVisualBuilder live queue locking', () => {
  it('applies the canonical running chrome to live suite hook rows', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        liveSetupHooks={[
          {
            id: 'hook-1',
            name: 'suite-setup',
            phase: 'setup',
            status: 'running',
            stdout: null,
            stderr: null,
            variables: null,
          },
        ]}
      />,
    )
    await flush()

    const hookButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('suite-setup'))
    expect(hookButton?.className).toContain('border-border/60')
    expect(hookButton?.className).toContain('bg-primary/5')
    expect(hookButton?.className).not.toContain('ring-primary')
    expect(hookButton?.querySelector('.text-primary')).toBeTruthy()
  })

  it('locks add/remove/per-test run actions while Run All Tests is active', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        isRunningAll
        liveTests={[
          {
            id: '1',
            draftId: '1',
            testId: 't_login',
            path: 'tests/web/login.yaml',
            name: 'Login flow',
            status: 'running',
            testExecutionId: 'exec-1',
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
          {
            id: '2',
            draftId: '2',
            testId: 't_checkout',
            path: 'tests/web/checkout.yaml',
            name: 'Checkout flow',
            status: 'idle',
            testExecutionId: null,
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Add new test')) as HTMLButtonElement | undefined
    const runButton = container.querySelector('[aria-label="Run test Checkout flow"]') as HTMLButtonElement | null
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      ['Remove Login flow', 'Remove Checkout flow'].includes(button.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement[]
    const hookAddButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Add Hook') as HTMLButtonElement[]
    const hookReorderButton = container.querySelector('[aria-label="Reorder login"]') as HTMLButtonElement | null

    expect(addButton?.disabled).toBe(true)
    expect(runButton?.disabled).toBe(true)
    expect(removeButtons.every((button) => button.disabled)).toBe(true)
    expect(hookAddButtons.every((button) => button.disabled)).toBe(true)
    expect(hookReorderButton?.disabled).toBe(true)
  })

  it('keeps suite add/remove available but locks reorder during single-test execution', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        runningTestIndex={0}
        liveTests={[
          {
            id: '1',
            draftId: '1',
            testId: 't_login',
            path: 'tests/web/login.yaml',
            name: 'Login flow',
            status: 'running',
            testExecutionId: 'exec-1',
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
          {
            id: '2',
            draftId: '2',
            testId: 't_checkout',
            path: 'tests/web/checkout.yaml',
            name: 'Checkout flow',
            status: 'idle',
            testExecutionId: null,
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Add new test')) as HTMLButtonElement | undefined
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      ['Remove Login flow', 'Remove Checkout flow'].includes(button.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement[]
    const reorderButton = container.querySelector('[aria-label="Reorder Login flow"]') as HTMLButtonElement | null
    const hookAddButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Add Hook') as HTMLButtonElement[]
    const hookReorderButton = container.querySelector('[aria-label="Reorder login"]') as HTMLButtonElement | null

    expect(addButton?.disabled).toBe(false)
    expect(removeButtons.every((button) => !button.disabled)).toBe(true)
    expect(reorderButton?.disabled).toBe(true)
    expect(hookAddButtons.every((button) => button.disabled)).toBe(true)
    expect(hookReorderButton?.disabled).toBe(true)
  })

  it('keeps suite and hook reorder available while live mode is idle', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        liveTests={[
          {
            id: '1',
            draftId: '1',
            testId: 't_login',
            path: 'tests/web/login.yaml',
            name: 'Login flow',
            status: 'idle',
            testExecutionId: null,
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Add new test')) as HTMLButtonElement | undefined
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      ['Remove Login flow', 'Remove Checkout flow'].includes(button.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement[]
    const reorderButton = container.querySelector('[aria-label="Reorder Login flow"]') as HTMLButtonElement | null
    const hookAddButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Add Hook') as HTMLButtonElement[]
    const hookReorderButton = container.querySelector('[aria-label="Reorder login"]') as HTMLButtonElement | null

    expect(addButton?.disabled).toBe(false)
    expect(removeButtons.every((button) => !button.disabled)).toBe(true)
    expect(reorderButton?.disabled).toBe(false)
    expect(hookAddButtons.every((button) => !button.disabled)).toBe(true)
    expect(hookReorderButton?.disabled).toBe(false)
  })

  it('locks queue actions and reorder controls while Run All Tests is stopping', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        isStoppingRunAll
        liveTests={[
          {
            id: '1',
            draftId: '1',
            testId: 't_login',
            path: 'tests/web/login.yaml',
            name: 'Login flow',
            status: 'idle',
            testExecutionId: null,
            liveSteps: [],
            runningStepIndex: null,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Add new test')) as HTMLButtonElement | undefined
    const runButton = container.querySelector('[aria-label="Run test Login flow"]') as HTMLButtonElement | null
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.getAttribute('aria-label')?.startsWith('Remove')) as HTMLButtonElement[]
    const reorderButton = container.querySelector('[aria-label="Reorder Login flow"]') as HTMLButtonElement | null
    const hookAddButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Add Hook') as HTMLButtonElement[]
    const hookReorderButton = container.querySelector('[aria-label="Reorder login"]') as HTMLButtonElement | null

    expect(addButton?.disabled).toBe(true)
    expect(runButton?.disabled).toBe(true)
    expect(removeButtons.every((button) => button.disabled)).toBe(true)
    expect(reorderButton?.disabled).toBe(true)
    expect(hookAddButtons.every((button) => button.disabled)).toBe(true)
    expect(hookReorderButton?.disabled).toBe(true)
  })

  it('locks reorder controls while suite hooks are running', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        liveSetupHooks={[
          {
            id: 'hook-1',
            name: 'suite-setup',
            phase: 'setup',
            status: 'running',
            stdout: null,
            stderr: null,
            variables: null,
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    const addButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Add new test')) as HTMLButtonElement | undefined
    const removeButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      ['Remove Login flow', 'Remove Checkout flow'].includes(button.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement[]
    const reorderButton = container.querySelector('[aria-label="Reorder Login flow"]') as HTMLButtonElement | null
    const hookAddButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Add Hook') as HTMLButtonElement[]
    const hookReorderButton = container.querySelector('[aria-label="Reorder login"]') as HTMLButtonElement | null

    expect(addButton?.disabled).toBe(false)
    expect(removeButtons.every((button) => !button.disabled)).toBe(true)
    expect(reorderButton?.disabled).toBe(true)
    expect(hookAddButtons.every((button) => button.disabled)).toBe(true)
    expect(hookReorderButton?.disabled).toBe(true)
  })

  it('surfaces current step context in the live queue instead of only hook rows', async () => {
    mount(
      <SuiteVisualBuilder
        content={SUITE_YAML}
        onChange={vi.fn()}
        suggestions={[]}
        liveMode
        canRunTest
        canRunAll
        runningTestIndex={0}
        selection={{ type: 'test', testIndex: 0 }}
        liveTests={[
          {
            id: '1',
            draftId: '1',
            testId: 't_login',
            path: 'tests/web/login.yaml',
            name: 'Login flow',
            status: 'running',
            testExecutionId: 'exec-1',
            liveSteps: [
              {
                id: 'step-1',
                draftId: null,
                stepIndex: 0,
                instruction: 'click login button',
                status: 'running',
                phases: [],
                executionHistory: [],
                consoleLogs: [],
                networkLogs: [],
                variableSnapshot: null,
                originalStepName: null,
                subActionsData: null,
                executionLogs: [],
                executionGeneration: 0,
              },
            ],
            runningStepIndex: 0,
            perTestSetupHooks: [],
            perTestTeardownHooks: [],
          },
        ]}
        onRunTest={vi.fn()}
      />,
    )
    await flush()

    expect(container.textContent).toContain('Current step')
    expect(container.textContent).toContain('click login button')
    expect(container.textContent).toContain('Inspecting below')
  })
})
