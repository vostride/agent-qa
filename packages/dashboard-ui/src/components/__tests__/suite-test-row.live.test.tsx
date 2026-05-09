// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteTestRow } from '@/components/suite-test-row'
import type { LiveHookExecution } from '@/hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}))

let container: HTMLDivElement
let root: Root

function mount(el: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(el) })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const baseProps = {
  id: 'test-0',
  name: 'Login flow',
  path: 'web/login.yaml',
  testId: 't_login',
  isMissing: false,
  onRemove: vi.fn(),
}

function makeHook(overrides: Partial<LiveHookExecution>): LiveHookExecution {
  return {
    id: overrides.id ?? 'h1',
    name: overrides.name ?? 'auth-cookies',
    phase: overrides.phase ?? 'setup',
    status: overrides.status ?? 'pending',
    stdout: null,
    stderr: null,
    variables: null,
    ...overrides,
  }
}

describe('SuiteTestRow live mode', () => {
  it('renders drag handle and remove button when liveMode=false (existing behavior)', () => {
    mount(<SuiteTestRow {...baseProps} />)
    const drag = container.querySelector('[aria-label^="Reorder"]')
    const remove = container.querySelector('[aria-label^="Remove"]')
    expect(drag).toBeTruthy()
    expect(remove).toBeTruthy()
  })

  it('shows drag handle in liveMode when reordering is allowed', () => {
    mount(<SuiteTestRow {...baseProps} liveMode />)
    const drag = container.querySelector('[aria-label^="Reorder"]')
    expect(drag).toBeTruthy()
  })

  it('shows a disabled drag handle in liveMode when sortableDisabled=true', () => {
    mount(<SuiteTestRow {...baseProps} liveMode sortableDisabled />)
    const drag = container.querySelector('[aria-label^="Reorder"]') as HTMLButtonElement | null
    expect(drag).toBeTruthy()
    expect(drag?.disabled).toBe(true)
    expect(drag?.getAttribute('aria-disabled')).toBe('true')
  })

  // D-13 playground — test-list edits (including remove) flow through during live session
  it('SHOWS remove button when liveMode=true (D-13 playground)', () => {
    mount(<SuiteTestRow {...baseProps} liveMode />)
    const remove = container.querySelector('[aria-label^="Remove"]')
    expect(remove).toBeTruthy()
  })

  // D-05
  it('renders Run button with Play icon when liveMode && liveStatus=idle', () => {
    mount(<SuiteTestRow {...baseProps} liveMode liveStatus="idle" onRunTest={vi.fn()} />)
    const btn = container.querySelector('[aria-label="Run test Login flow"]')
    expect(btn).toBeTruthy()
    expect(btn!.querySelector('svg')).toBeTruthy()
  })

  it('renders Re-run aria when liveStatus=passed', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="passed"
        liveDuration={1200}
        onRunTest={vi.fn()}
      />,
    )
    const btn = container.querySelector('[aria-label="Re-run test Login flow"]')
    expect(btn).toBeTruthy()
  })

  it('renders the canonical running chrome when liveStatus=running (no clickable Run button)', () => {
    mount(<SuiteTestRow {...baseProps} liveMode liveStatus="running" onRunTest={vi.fn()} />)
    const runBtn = container.querySelector('[aria-label="Run test Login flow"]')
    expect(runBtn).toBeNull()
    const reRunBtn = container.querySelector('[aria-label="Re-run test Login flow"]')
    expect(reRunBtn).toBeNull()
    const runningSurface = container.querySelector('.live-running-surface')
    expect(runningSurface).toBeTruthy()
    expect(runningSurface?.className).toContain('border-border/60')
    expect(runningSurface?.className).toContain('bg-primary/5')
    expect(runningSurface?.className).not.toContain('ring-primary')
    expect(runningSurface?.querySelector('.text-primary')).toBeTruthy()
  })

  it('renders CheckCircle2 emerald icon when liveStatus=passed', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="passed"
        liveDuration={1200}
        onRunTest={vi.fn()}
      />,
    )
    const emerald = container.querySelector('.text-emerald-500')
    expect(emerald).toBeTruthy()
  })

  it('renders XCircle red icon when liveStatus=failed', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="failed"
        liveDuration={1200}
        liveError="Element not found"
        onRunTest={vi.fn()}
      />,
    )
    const red = container.querySelector('.text-red-500')
    expect(red).toBeTruthy()
  })

  it('applies failed-row emphasis when liveStatus=failed', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="failed"
        liveError="Element not found"
        onRunTest={vi.fn()}
      />,
    )
    expect(container.querySelector('.ring-destructive\\/20')).toBeTruthy()
  })

  it('disables Run button when canRunTest=false', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        canRunTest={false}
        onRunTest={vi.fn()}
      />,
    )
    const btn = container.querySelector('[aria-label="Run test Login flow"]') as HTMLButtonElement | null
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(true)
  })

  it('disables run and remove controls when actionsLocked=true', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        actionsLocked={true}
        onRunTest={vi.fn()}
      />,
    )
    const runButton = container.querySelector('[aria-label="Run test Login flow"]') as HTMLButtonElement | null
    const removeButton = container.querySelector('[aria-label="Remove Login flow"]') as HTMLButtonElement | null
    expect(runButton?.disabled).toBe(true)
    expect(removeButton?.disabled).toBe(true)
  })

  it('renders duration when liveStatus=passed && liveDuration is provided', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="passed"
        liveDuration={1200}
        onRunTest={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('1.2s')
  })

  it('surfaces every live step and nested sub-action inside the live row', () => {
    const onSelect = vi.fn()
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="failed"
        liveSteps={[
          {
            id: 'step-1',
            draftId: null,
            stepIndex: 0,
            instruction: 'click checkout',
            status: 'failed',
            error: 'missing button',
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
          {
            id: 'step-2',
            draftId: null,
            stepIndex: 1,
            instruction: 'confirm checkout',
            status: 'passed',
            error: undefined,
            phases: [],
            executionHistory: [],
            consoleLogs: [],
            networkLogs: [],
            variableSnapshot: null,
            originalStepName: null,
            subActionsData: [{
              index: 0,
              observation: 'checkout modal visible',
              reasoning: 'confirm button can be clicked',
              plannedAction: null,
              result: 'success',
              screenStateBefore: '',
              cached: false,
            }],
            executionLogs: [],
            executionGeneration: 0,
          },
        ]}
        testIndex={0}
        selection={{ type: 'test', testIndex: 0 }}
        onSelect={onSelect}
        onRunTest={vi.fn()}
      />,
    )

    expect(container.textContent).toContain('Step 1')
    expect(container.textContent).toContain('click checkout')
    expect(container.textContent).toContain('Step 2')
    expect(container.textContent).toContain('confirm checkout')
    expect(container.textContent).toContain('Sub 1')
    expect(container.textContent).toContain('checkout modal visible')

    const stepButton = container.querySelector('[aria-label="Select step 2 confirm checkout"]')
    act(() => {
      stepButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith({ type: 'step', stepId: 'step-2' })

    const subActionButton = container.querySelector('[aria-label="Select sub-action 1 for step 2"]')
    act(() => {
      subActionButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith({ type: 'subaction', stepId: 'step-2', subIndex: 0 })
  })

  it('keeps duration inside the top-aligned action rail with the live controls', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="passed"
        liveDuration={1200}
        onRunTest={vi.fn()}
      />,
    )

    const duration = Array.from(container.querySelectorAll('span')).find((node) => node.textContent === '1.2s')
    const actionRail = duration?.closest('div')

    expect(actionRail?.className).toContain('items-center')
    expect(actionRail?.className).toContain('self-start')
    expect(actionRail?.textContent).toContain('1.2s')
    expect(container.querySelector('[aria-label="Re-run test Login flow"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Remove Login flow"]')).toBeTruthy()
  })

  it('renders failure error line "<error> — see Reasoning tab for details" when liveStatus=failed && liveError set', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="failed"
        liveError="Element not found"
        onRunTest={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('Element not found — see Reasoning tab for details')
  })

  // D-10
  it('renders nested per-test setup hook rows indented', () => {
    const setupHook = makeHook({ id: 'h-setup', name: 'seed-db', phase: 'setup', status: 'passed' })
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        perTestSetupHooks={[setupHook]}
        onRunTest={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('setup: seed-db')
    // Indentation contract: pl-5 class somewhere in the nested list
    const list = Array.from(container.querySelectorAll('ul')).find((ul) => ul.className.includes('pl-5'))
    expect(list).toBeTruthy()
  })

  // D-10
  it('renders nested per-test teardown hook rows with "teardown: <name>" label', () => {
    const teardownHook = makeHook({ id: 'h-td', name: 'cleanup', phase: 'teardown', status: 'passed' })
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        perTestTeardownHooks={[teardownHook]}
        onRunTest={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('teardown: cleanup')
  })

  // UI-SPEC selection outline
  it('applies the quiet selected-state contract when selection.type=test and selection.testIndex matches', () => {
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        testIndex={2}
        selection={{ type: 'test', stepId: '' } as never}
        onRunTest={vi.fn()}
      />,
    )
    // not matching (wrong type shape above)
    const firstRing = container.querySelector('.ring-primary\\/20')
    expect(firstRing).toBeNull()

    // Re-mount with matching selection — use real Selection shape
    act(() => { root.unmount() })
    container.remove()
    mount(
      <SuiteTestRow
        {...baseProps}
        liveMode
        liveStatus="idle"
        testIndex={2}
        selection={{ type: 'test', testIndex: 2 } as never}
        onRunTest={vi.fn()}
      />,
    )
    const ring = container.querySelector('.ring-primary\\/30')
    expect(ring).toBeTruthy()
    const selectedSurface = ring?.closest('div')
    expect(selectedSurface?.className).toContain('bg-primary/10')
  })

  // UI-SPEC running state keeps a thin neutral frame while the moving beam carries the accent.
  it('renders canonical running state classes and primary-tinted iconography when liveStatus=running', () => {
    mount(<SuiteTestRow {...baseProps} liveMode liveStatus="running" onRunTest={vi.fn()} />)
    const runningBorder = container.querySelector('.border-border\\/60')
    const runningBackground = container.querySelector('.bg-primary\\/5')
    const runningRing = container.querySelector('.ring-primary\\/15')
    const runningIcon = container.querySelector('.text-primary')
    expect(runningBorder).toBeTruthy()
    expect(runningBackground).toBeTruthy()
    expect(runningRing).toBeNull()
    expect(runningIcon).toBeTruthy()
  })
})
