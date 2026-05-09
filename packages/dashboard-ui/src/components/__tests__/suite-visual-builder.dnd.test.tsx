// @vitest-environment jsdom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SuiteVisualBuilder } from '@/components/suite-visual-builder'
import type { EditorTest, LiveHookExecution, TestStepDetail } from '@/hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { dndOnDragEnds } = vi.hoisted(() => ({
  dndOnDragEnds: [] as Array<((event: { active: { id: string }; over: { id: string } | null }) => void) | undefined>,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchTestFiles: vi.fn().mockResolvedValue({
      files: [
        { path: 'tests/web/login.yaml', name: 'Login flow', testId: 't_login', platform: 'web', modified: '2026-04-17' },
        { path: 'tests/web/checkout.yaml', name: 'Checkout flow', testId: 't_checkout', platform: 'web', modified: '2026-04-17' },
      ],
    }),
  }
})

vi.mock('@/components/test-hooks-form', () => ({
  useTestHookCatalog: () => ({ hooks: [], warningCopy: null }),
}))

vi.mock('@/components/suite-metadata-form', () => ({
  SuiteMetadataForm: ({ name }: { name: string }) => <div data-testid="metadata-form">{name}</div>,
}))

vi.mock('@/components/test-hook-token-field', () => ({
  TestHookListField: ({ phase, disabled }: { phase: string; disabled?: boolean }) => (
    <div data-testid={`hook-list-${phase}`} data-disabled={String(Boolean(disabled))} />
  ),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react')

  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: ReactElement
      onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void
    }) => {
      const indexRef = React.useRef<number>(dndOnDragEnds.length)
      dndOnDragEnds[indexRef.current] = onDragEnd

      return <div data-dnd-context={String(indexRef.current)}>{children}</div>
    },
    closestCenter: () => null,
    PointerSensor: class PointerSensor {},
    KeyboardSensor: class KeyboardSensor {},
    useSensor: (...args: unknown[]) => ({ args }),
    useSensors: (...sensors: unknown[]) => sensors,
  }
})

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children, items }: { children: ReactElement; items: string[] }) => (
    <div data-sortable-context={items.join(',')}>{children}</div>
  ),
  useSortable: ({ id, disabled }: { id: string; disabled?: boolean }) => ({
    attributes: { 'data-sortable-item': id, 'data-sortable-disabled': String(Boolean(disabled)) },
    listeners: { 'data-sortable-handle': id },
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  sortableKeyboardCoordinates: () => ({ x: 0, y: 0 }),
  verticalListSortingStrategy: {},
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}))

const SUITE_YAML = `name: Suite DnD
target: web
tests:
  - test: tests/web/login.yaml
    id: t_login
  - test: tests/web/checkout.yaml
    id: t_checkout
`

const INVALID_YAML = `name: Suite DnD
tests:
  - [broken
`

function makeHook(status: LiveHookExecution['status'] = 'running'): LiveHookExecution {
  return {
    id: 'h_login',
    name: 'login',
    phase: 'setup',
    status,
    stdout: null,
    stderr: null,
    variables: null,
  }
}

function makeStep(status: TestStepDetail['status'] = 'running'): TestStepDetail {
  return {
    id: 'step-1',
    draftId: null,
    stepIndex: 0,
    instruction: 'Click login',
    status,
    phases: [],
    executionHistory: [],
    consoleLogs: [],
    networkLogs: [],
    variableSnapshot: null,
    originalStepName: null,
    subActionsData: null,
    executionLogs: [],
    executionGeneration: 0,
  }
}

function makeTest(overrides: Partial<EditorTest> = {}): EditorTest {
  return {
    id: overrides.id ?? 'test-1',
    draftId: overrides.draftId ?? null,
    testId: overrides.testId ?? 't_login',
    path: overrides.path ?? 'tests/web/login.yaml',
    name: overrides.name ?? 'Login flow',
    status: overrides.status ?? 'idle',
    testExecutionId: overrides.testExecutionId ?? null,
    liveSteps: overrides.liveSteps ?? [],
    runningStepIndex: overrides.runningStepIndex ?? null,
    perTestSetupHooks: overrides.perTestSetupHooks ?? [],
    perTestTeardownHooks: overrides.perTestTeardownHooks ?? [],
    ...overrides,
  }
}

function Harness({
  disabled = false,
  liveMode = false,
  liveTests = [],
  liveSetupHooks = [],
  liveTeardownHooks = [],
  runningTestIndex = null,
  isRunningAll = false,
  isStoppingRunAll = false,
}: {
  disabled?: boolean
  liveMode?: boolean
  liveTests?: EditorTest[]
  liveSetupHooks?: LiveHookExecution[]
  liveTeardownHooks?: LiveHookExecution[]
  runningTestIndex?: number | null
  isRunningAll?: boolean
  isStoppingRunAll?: boolean
}) {
  const [content, setContent] = useState(SUITE_YAML)

  return (
    <div>
      <button type="button" onClick={() => setContent(INVALID_YAML)}>Make YAML Invalid</button>
      <SuiteVisualBuilder
        content={content}
        onChange={setContent}
        suggestions={[]}
        disabled={disabled}
        liveMode={liveMode}
        liveTests={liveTests}
        liveSetupHooks={liveSetupHooks}
        liveTeardownHooks={liveTeardownHooks}
        runningTestIndex={runningTestIndex}
        isRunningAll={isRunningAll}
        isStoppingRunAll={isStoppingRunAll}
      />
      <pre data-testid="yaml-content">{content}</pre>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  dndOnDragEnds.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  document.body.innerHTML = ''
})

async function render(ui: ReactElement): Promise<HTMLElement> {
  const currentRoot = root
  const currentContainer = container

  if (!currentRoot || !currentContainer) {
    throw new Error('Test root not initialized')
  }

  await act(async () => {
    currentRoot.render(<MemoryRouter>{ui}</MemoryRouter>)
  })
  await flush()
  return currentContainer
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function getSuiteNames(rootElement: HTMLElement): string[] {
  return Array.from(rootElement.querySelectorAll('button[aria-label^="Reorder "]'))
    .map((button) => button.getAttribute('aria-label')?.replace('Reorder ', '') ?? '')
}

function getHandle(rootElement: HTMLElement, id: string): HTMLButtonElement {
  const handle = rootElement.querySelector(`[data-sortable-handle="${id}"]`)
  if (!(handle instanceof HTMLButtonElement)) {
    throw new Error(`Unable to find suite handle "${id}"`)
  }
  return handle
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function dragSuiteTest(rootElement: HTMLElement, activeId = 'test-1', overId = 'test-0'): Promise<void> {
  const handle = getHandle(rootElement, activeId)
  const contextElement = handle.closest('[data-dnd-context]')
  const contextIndex = Number(contextElement?.getAttribute('data-dnd-context'))
  const callback = dndOnDragEnds[contextIndex]

  if (!callback) {
    throw new Error(`Missing drag callback for context ${String(contextIndex)}`)
  }

  await act(async () => {
    callback({
      active: { id: activeId },
      over: { id: overId },
    })
  })
  await flush()
}

describe('SuiteVisualBuilder suite test drag and drop', () => {
  it('reorders suite tests by current YAML indices and updates visible order', async () => {
    const rootElement = await render(<Harness />)

    expect(rootElement.querySelector('[data-sortable-context]')?.getAttribute('data-sortable-context')).toBe('test-0,test-1')
    expect(getSuiteNames(rootElement)).toEqual(['Login flow', 'Checkout flow'])

    await dragSuiteTest(rootElement)

    expect(getSuiteNames(rootElement)).toEqual(['Checkout flow', 'Login flow'])
    const yaml = rootElement.querySelector('[data-testid="yaml-content"]')?.textContent ?? ''
    expect(yaml.indexOf('tests/web/checkout.yaml')).toBeLessThan(yaml.indexOf('tests/web/login.yaml'))
  })

  it('does not reorder against the last valid display while YAML is invalid', async () => {
    const rootElement = await render(<Harness />)

    await click(Array.from(rootElement.querySelectorAll('button')).find((button) => button.textContent === 'Make YAML Invalid')!)
    expect(rootElement.textContent).toContain('YAML has errors')
    expect(getHandle(rootElement, 'test-1').disabled).toBe(true)

    await dragSuiteTest(rootElement)

    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toBe(INVALID_YAML)
    expect(getSuiteNames(rootElement)).toEqual(['Login flow', 'Checkout flow'])
  })

  it('does not reorder when the builder is disabled even if the drag callback fires directly', async () => {
    const rootElement = await render(<Harness disabled />)

    expect(getHandle(rootElement, 'test-1').disabled).toBe(true)

    await dragSuiteTest(rootElement)

    expect(getSuiteNames(rootElement)).toEqual(['Login flow', 'Checkout flow'])
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toBe(SUITE_YAML)
  })

  it.each([
    ['Run All is active', { liveMode: true, isRunningAll: true }],
    ['Run All is stopping', { liveMode: true, isStoppingRunAll: true }],
    ['a test is running', { liveMode: true, runningTestIndex: 0, liveTests: [makeTest({ status: 'running' })] }],
    ['a nested step is running', { liveMode: true, liveTests: [makeTest({ liveSteps: [makeStep('running')] })] }],
    ['a nested step is cancelling', { liveMode: true, liveTests: [makeTest({ liveSteps: [makeStep('cancelling')] })] }],
    ['a per-test hook is running', { liveMode: true, liveTests: [makeTest({ perTestSetupHooks: [makeHook('running')] })] }],
    ['a suite hook is running', { liveMode: true, liveSetupHooks: [makeHook('running')] }],
  ])('does not reorder while %s', async (_label, props) => {
    const rootElement = await render(<Harness {...props} />)

    expect(getHandle(rootElement, 'test-1').disabled).toBe(true)

    await dragSuiteTest(rootElement)

    expect(getSuiteNames(rootElement)).toEqual(['Login flow', 'Checkout flow'])
    expect(rootElement.querySelector('[data-testid="yaml-content"]')?.textContent).toBe(SUITE_YAML)
  })
})
