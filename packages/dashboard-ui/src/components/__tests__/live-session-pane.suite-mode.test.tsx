// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveSessionPane } from '@/components/live-session-pane'
import type { EditorTest, LiveHookExecution } from '@/hooks/use-live-editor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/editor/editor-step-detail', () => ({
  EditorStepDetail: ({
    step,
    subAction,
  }: {
    step: { name?: string }
    subAction?: { reasoning?: string } | null
  }) => <div data-testid="step-detail">{step.name}{subAction?.reasoning ? ` ${subAction.reasoning}` : ''}</div>,
}))

vi.mock('@/components/editor/aria-panel', () => ({
  EditorAriaPanel: () => <div data-testid="aria-panel" />,
}))

vi.mock('@/components/editor/screencast-viewer', () => ({
  ScreencastViewer: () => <div data-testid="screencast-viewer" />,
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactElement | ReactElement[] }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

let container: HTMLDivElement
let root: Root

const suiteHook: LiveHookExecution = {
  id: 'suite-hook-1',
  name: 'suite.setup',
  phase: 'setup',
  status: 'passed',
  stdout: 'suite ok',
  stderr: null,
  variables: null,
}

const testHook: LiveHookExecution = {
  id: 'test-hook-1',
  name: 'test.setup',
  phase: 'setup',
  status: 'passed',
  stdout: 'test ok',
  stderr: null,
  variables: null,
}

const selectedTest: EditorTest = {
  id: 'test-1',
  draftId: 'test-1',
  testId: 't_checkout',
  path: 'tests/web/checkout.yaml',
  name: 'Checkout flow',
  status: 'failed',
  duration: 1234,
  error: 'Checkout button missing',
  testExecutionId: 'exec-1',
  runningStepIndex: null,
  liveSteps: [
    {
      id: 'step-1',
      draftId: null,
      stepIndex: 0,
      instruction: 'click checkout',
      status: 'failed',
      duration: 12,
      error: 'missing button',
      phases: [{ phase: 'observe', text: 'Button missing', timestamp: '2026-04-18T00:00:00.000Z' }],
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
      duration: 22,
      error: undefined,
      phases: [],
      executionHistory: [],
      consoleLogs: [],
      networkLogs: [],
      variableSnapshot: null,
      originalStepName: null,
      subActionsData: [{
        index: 0,
        observation: 'Checkout dialog visible',
        reasoning: 'Confirmation control is available',
        plannedAction: null,
        result: 'success',
        screenStateBefore: '',
        cached: false,
      }],
      executionLogs: [],
      executionGeneration: 0,
    },
  ],
  perTestSetupHooks: [testHook],
  perTestTeardownHooks: [],
}

function mount(el: ReactElement) {
  act(() => {
    root.render(el)
  })
}

function renderPane(overrides: Partial<React.ComponentProps<typeof LiveSessionPane>> = {}) {
  mount(
    <LiveSessionPane
      connectionState="connected"
      isLaunching={false}
      targetName="web"
      targetLabel="https://example.com"
      platform="web"
      screenshot={null}
      currentUrl="https://example.com"
      pendingNavigation={null}
      steps={[]}
      setupHooks={[suiteHook]}
      teardownHooks={[]}
      tests={[selectedTest]}
      selection={{ type: 'test', testIndex: 0 }}
      runningStepId={null}
      terminalState={null}
      draftState="saved"
      ariaTree={null}
      errorMessage={null}
      devtoolsTab="reasoning"
      canRunAll={false}
      isRunningAll={false}
      isStoppingRunAll={false}
      onDevtoolsTabChange={vi.fn()}
      onRunAll={vi.fn()}
      onStopAll={vi.fn()}
      onEndSession={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onRefresh={vi.fn()}
      onNavigate={vi.fn()}
      onRequestAriaTree={vi.fn()}
      executionUnit="test"
      {...overrides}
    />,
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('LiveSessionPane suite mode', () => {
  it('renders selected test detail instead of the generic missing-selection state', () => {
    renderPane()

    expect(container.textContent).toContain('Checkout flow')
    expect(container.textContent).toContain('Checkout button missing')
    expect(container.querySelector('[data-testid="step-detail"]')?.textContent).toContain('click checkout')
    expect(container.textContent).toContain('confirm checkout')
    expect(container.textContent).toContain('Confirmation control is available')
    expect(container.textContent).not.toContain('Selection is no longer available')
  })

  it('keeps suite step selections attached to their owning test detail', () => {
    renderPane({
      selection: { type: 'subaction', stepId: 'step-2', subIndex: 0 },
    })

    expect(container.textContent).toContain('Checkout flow')
    expect(container.textContent).toContain('click checkout')
    expect(container.textContent).toContain('confirm checkout')
    expect(container.textContent).toContain('Confirmation control is available')
  })

  it('renders suite-hook detail without mixing in test-owned hook copy', () => {
    renderPane({
      selection: { type: 'suite-hook', phase: 'setup', hookId: 'suite-hook-1' },
    })

    expect(container.textContent).toContain('suite.setup')
    expect(container.textContent).not.toContain('test.setup')
  })

  it('renders test-owned hook detail when a test hook is selected', () => {
    renderPane({
      selection: { type: 'test-hook', testIndex: 0, phase: 'setup', hookId: 'test-hook-1' },
    })

    expect(container.textContent).toContain('test.setup')
    expect(container.textContent).not.toContain('suite.setup')
  })

  it('shows suite-mode empty copy when no test is selected', () => {
    renderPane({
      selection: null,
      tests: [selectedTest],
    })

    expect(container.textContent).toContain('Select a test to inspect it')
    expect(container.textContent).toContain('Choose a test in the live queue to see its reasoning, logs, hooks, and network activity.')
  })

  it('does not render a duplicate Run All / Stop Run All toolbar in suite mode', () => {
    renderPane({
      canRunAll: true,
      isRunningAll: true,
      stopAllLabel: 'Stop Run All',
    })

    expect(container.textContent).not.toContain('Stop Run All')
    expect(container.textContent).not.toContain('Run All Tests')
  })
})
