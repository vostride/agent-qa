// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_FAVICON_HREF } from '@/hooks/use-run-status-favicon'
import LiveRunPage from '@/pages/live-run'
import type { RunRow, SubActionData } from '@/lib/api'
import type { DisplayStep } from '@/lib/display-step'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  cancelRunMock,
  executionState,
  fetchExecutionLogsMock,
  fetchRunMock,
} = vi.hoisted(() => ({
  cancelRunMock: vi.fn(),
  executionState: {
    current: {
      steps: [],
      displaySteps: [],
      setupHooks: [],
      teardownHooks: [],
      inlineLogs: [],
      suiteTests: [],
      testInfo: null,
      runStatus: 'idle' as const,
      finalStatus: undefined as string | undefined,
      elapsed: 0,
      error: undefined as string | undefined,
      completedSteps: 0,
      passedSteps: 0,
      failedSteps: 0,
      totalSteps: 0,
      mergeFinalArtifacts: vi.fn(),
    } as import('@/hooks/use-execution-events').UseExecutionEventsReturn,
  },
  fetchExecutionLogsMock: vi.fn(),
  fetchRunMock: vi.fn(),
}))

vi.mock('@/hooks/use-execution-events', () => ({
  useExecutionEvents: () => executionState.current,
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    cancelRun: cancelRunMock,
    fetchExecutionLogs: fetchExecutionLogsMock,
    fetchRun: fetchRunMock,
  }
})
vi.mock('@/hooks/use-page-title', () => ({ usePageTitle: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/page-skeleton', () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/run-detail/step-tree', () => ({
  StepTree: ({
    steps,
    selection,
    onSelect,
  }: {
    steps: DisplayStep[]
    selection: { type: string; stepId?: string; subIndex?: number } | null
    onSelect: (selection: { type: string; stepId?: string; subIndex?: number } | null) => void
  }) => (
    <div data-testid="step-tree" data-selection={selection?.stepId ?? ''}>
      {steps.map((step) => (
        <div key={step.id}>
          <button type="button" onClick={() => onSelect({ type: 'step', stepId: step.id })}>
            {step.name}
          </button>
          {step.subActionsData?.map((sub, index) => (
            <button
              key={sub.index}
              type="button"
              onClick={() => onSelect({ type: 'subaction', stepId: step.id, subIndex: index })}
            >
              {sub.reasoning || `Sub-action ${index + 1}`}
            </button>
          ))}
        </div>
      ))}
    </div>
  ),
}))
vi.mock('@/components/run-detail/tab-panels', () => ({
  TabPanels: ({
    step,
    subAction,
  }: {
    step: DisplayStep | null
    subAction: SubActionData | null
  }) => (
    <div data-testid="tab-panels">
      <span>Overview</span>
      <span>Variables</span>
      <span>Network</span>
      <span>stdout</span>
      <span>ARIA Tree</span>
      <span>A11y</span>
      <div data-testid="selected-step">{step?.name ?? 'No step'}</div>
      {subAction && <div data-testid="selected-subaction">{subAction.reasoning}</div>}
    </div>
  ),
}))
vi.mock('@/components/run-detail/hook-detail-panel', () => ({
  HookDetailPanel: ({ log }: { log: { name: string } }) => <div>{log.name}</div>,
}))
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div data-testid="split-pane">{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  ResizableHandle: () => <div />,
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => <button type="button" onClick={onClick}>{children}</button>,
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

function makeExecutionState(overrides: Partial<import('@/hooks/use-execution-events').UseExecutionEventsReturn> = {}): import('@/hooks/use-execution-events').UseExecutionEventsReturn {
  return {
    steps: [],
    displaySteps: [],
    setupHooks: [],
    teardownHooks: [],
    inlineLogs: [],
    suiteTests: [],
    testInfo: null,
    runStatus: 'idle',
    finalStatus: undefined,
    elapsed: 0,
    error: undefined,
    completedSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
    totalSteps: 0,
    mergeFinalArtifacts: vi.fn(),
    ...overrides,
  }
}

function makeRun(status: string): RunRow {
  return {
    id: `run-${status}`,
    name: 'Local model regression',
    filePath: 'tests/web/01-homepage-basics.yaml',
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: '2026-05-02T00:00:00.000Z',
    endedAt: '2026-05-02T00:00:01.000Z',
    videoPath: null,
    failureSummary: status === 'failed' ? 'Timed out waiting for the local model' : null,
    errorLog: null,
    memoryLog: null,
    testId: 't_home',
    suiteId: null,
    platform: 'web',
    testFileContent: null,
    modelName: 'google/gemma-4-e4b',
    llmProvider: 'openai-compatible',
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: '2026-05-02T00:00:00.000Z',
    targetName: 'local',
  }
}

function makeSubAction(reasoning: string, index = 0): SubActionData {
  return {
    index,
    observation: 'observed',
    reasoning,
    plannedAction: { type: 'click' },
    result: 'in-progress',
    screenStateBefore: '',
    cached: false,
  }
}

function makeDisplayStep(id: string, name: string, status = 'running', subActionsData: SubActionData[] | null = null): DisplayStep {
  return {
    id,
    name,
    status,
    duration: 0,
    subActionsData,
    originalStepName: null,
    variableSnapshot: null,
    screenshotPath: null,
    screenshotBeforePath: null,
    annotationData: null,
    observation: null,
    reasoning: null,
    plannedAction: null,
    action: null,
    error: null,
    confidence: null,
    runId: 'run-live',
    stepOrder: 0,
    consoleLogs: null,
    networkLogs: null,
    healingAttempts: null,
    screenContextBefore: null,
    screenContextAfter: null,
    rawRunId: 'run-live',
    rawStepOrder: 0,
    displayStepOrder: 1,
    displayStepTotal: 1,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function resetFavicon() {
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON_HREF}">`
}

function getFaviconHref() {
  return document
    .querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    ?.getAttribute('href')
}

function expectDefaultFavicon() {
  expect(getFaviconHref()).toBe(DEFAULT_FAVICON_HREF)
}

function expectStatusFavicon() {
  expect(getFaviconHref()).toMatch(/^data:image\/svg\+xml,/)
}

function expectFailedFavicon() {
  const href = getFaviconHref()
  expect(href).toMatch(/^data:image\/svg\+xml,/)
  expect(decodeURIComponent(href ?? '')).toContain('#EF4444')
}

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/runs/:id/live" element={<LiveRunPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

beforeEach(() => {
  resetFavicon()
  Element.prototype.scrollIntoView = vi.fn()
  executionState.current = makeExecutionState()
  fetchRunMock.mockResolvedValue({ run: makeRun('running') })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  document.head.innerHTML = ''
  vi.clearAllMocks()
})

describe('LiveRunPage status rendering', () => {
  it('renders run-complete timeout as a timed-out failure instead of generic Complete', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 1 },
      runStatus: 'complete',
      finalStatus: 'timeout',
      elapsed: 90,
      totalSteps: 1,
    }
    fetchRunMock.mockResolvedValue({ run: makeRun('failed') })

    const view = await renderAt('/runs/run-timeout/live')

    expect(view.textContent).toContain('Timed Out')
    expect(view.textContent).not.toContain('Complete')
    expect(view.textContent).toContain('View Full Results')
    expectFailedFavicon()
  })

  it('treats fallback cancelled rows as terminal and offers the persisted detail link', async () => {
    fetchRunMock.mockResolvedValue({ run: makeRun('cancelled') })

    const view = await renderAt('/runs/run-cancelled/live')

    expect(view.textContent).toContain('Cancelled')
    expect(view.textContent).toContain('View Full Results')
    expect(view.textContent).not.toContain('Waiting for steps')
    expectStatusFavicon()
  })

  it('sets a passed favicon for run-complete passed events', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 1 },
      runStatus: 'complete',
      finalStatus: 'passed',
      elapsed: 42,
      totalSteps: 1,
    }
    fetchRunMock.mockResolvedValue({ run: makeRun('running') })

    const view = await renderAt('/runs/run-passed/live')

    expect(view.textContent).toContain('Passed')
    expectStatusFavicon()
  })

  it('treats terminal fallback rows as complete while the live hook is connecting', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: null,
      runStatus: 'connecting',
      finalStatus: undefined,
      elapsed: 0,
    }
    fetchRunMock.mockResolvedValue({ run: makeRun('failed') })

    const view = await renderAt('/runs/run-failed/live')

    expect(view.textContent).toContain('Failed')
    expect(view.textContent).toContain('View Full Results')
    expect(view.textContent).not.toContain('Waiting for steps')
    expect(view.textContent).not.toContain('Cancel')
    expectStatusFavicon()
  })

  it('sets a running favicon while connecting without a terminal fallback', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: null,
      runStatus: 'connecting',
      finalStatus: undefined,
      elapsed: 0,
    }
    fetchRunMock.mockRejectedValue(new Error('404'))

    await renderAt('/runs/run-connecting/live')

    expectStatusFavicon()
    expect(getFaviconHref()).not.toBe(DEFAULT_FAVICON_HREF)
  })

  it('sets a failed favicon for live errors without a terminal status', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: null,
      runStatus: 'error',
      finalStatus: undefined,
      elapsed: 12,
      error: 'SSE connection failed',
    }
    fetchRunMock.mockResolvedValue({ run: makeRun('running') })

    const view = await renderAt('/runs/run-error/live')

    expect(view.textContent).toContain('Run Error')
    expectFailedFavicon()
  })

  it('restores the default favicon on unmount', async () => {
    executionState.current = {
      ...makeExecutionState(),
      testInfo: null,
      runStatus: 'connecting',
      finalStatus: undefined,
      elapsed: 0,
    }
    fetchRunMock.mockRejectedValue(new Error('404'))

    await renderAt('/runs/run-cleanup/live')

    expectStatusFavicon()

    act(() => root!.unmount())
    root = null

    expectDefaultFavicon()
  })

  it('renders the run-detail-like split pane with tree rows, tabs, latest, and results action', async () => {
    executionState.current = makeExecutionState({
      displaySteps: [makeDisplayStep('step-1', 'Open dashboard', 'running', [makeSubAction('Click the dashboard tab')])],
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 1 },
      runStatus: 'running',
      elapsed: 5,
      totalSteps: 1,
    })

    const view = await renderAt('/runs/run-live/live')

    expect(view.textContent).toContain('Live Execution')
    expect(view.textContent).toContain('Latest')
    expect(view.textContent).toContain('Open dashboard')
    expect(view.textContent).toContain('Overview')
    expect(view.textContent).toContain('Variables')
    expect(view.textContent).toContain('stdout')
    expect(view.textContent).toContain('View Full Results')
  })

  it('keeps manual selection stable until Latest is clicked', async () => {
    const first = makeDisplayStep('step-1', 'Earlier step', 'passed', [makeSubAction('Earlier subaction')])
    const second = makeDisplayStep('step-2', 'Current step', 'running', [makeSubAction('Current subaction')])
    executionState.current = makeExecutionState({
      displaySteps: [first, second],
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 2 },
      runStatus: 'running',
      totalSteps: 2,
    })

    const view = await renderAt('/runs/run-live/live')
    const buttons = Array.from(view.querySelectorAll('button'))
    const earlierButton = buttons.find((button) => button.textContent === 'Earlier step')!

    act(() => {
      earlierButton.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="selected-step"]')?.textContent).toBe('Earlier step')

    const third = makeDisplayStep('step-3', 'Newest step', 'running', [makeSubAction('Newest subaction')])
    executionState.current = makeExecutionState({
      displaySteps: [first, second, third],
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 3 },
      runStatus: 'running',
      totalSteps: 3,
    })

    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/runs/run-live/live']}>
          <Routes>
            <Route path="/runs/:id/live" element={<LiveRunPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    await flushRender()

    expect(view.querySelector('[data-testid="selected-step"]')?.textContent).toBe('Earlier step')

    const latestButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent === 'Latest')!
    act(() => {
      latestButton.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="selected-step"]')?.textContent).toBe('Newest step')
  })

  it('selects a live subaction into the right detail panel', async () => {
    executionState.current = makeExecutionState({
      displaySteps: [makeDisplayStep('step-1', 'Open dashboard', 'running', [makeSubAction('Inspect the dashboard state')])],
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 1 },
      runStatus: 'running',
      totalSteps: 1,
    })

    const view = await renderAt('/runs/run-live/live')
    const subactionButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent === 'Inspect the dashboard state')!

    act(() => {
      subactionButton.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="selected-subaction"]')?.textContent).toBe('Inspect the dashboard state')
  })

  it('merges final run rows and execution logs into the live timeline on terminal status', async () => {
    const mergeFinalArtifacts = vi.fn()
    executionState.current = makeExecutionState({
      displaySteps: [makeDisplayStep('step-1', 'Open dashboard', 'running')],
      testInfo: { name: 'Local model regression', filePath: 'tests/web/01-homepage-basics.yaml', totalSteps: 1 },
      runStatus: 'complete',
      finalStatus: 'passed',
      totalSteps: 1,
      mergeFinalArtifacts,
    })
    const finalRun = makeRun('passed')
    const finalStep = {
      id: 'step-1-final',
      runId: finalRun.id,
      name: 'Open dashboard',
      status: 'passed',
      duration: 100,
      stepOrder: 0,
    }
    const finalLog = {
      id: 'hook-1',
      runId: finalRun.id,
      stepId: null,
      type: 'hook',
      name: 'suite setup',
      hookId: 'hook-1',
      phase: 'setup',
      status: 'passed',
      duration: 5,
      stdout: 'ready',
      stderr: null,
      returnData: null,
      variables: null,
      createdAt: '2026-05-02T00:00:00.000Z',
    }
    fetchRunMock.mockResolvedValue({ run: finalRun, steps: [finalStep], attempts: [] })
    fetchExecutionLogsMock.mockResolvedValue({ logs: [finalLog] })

    await renderAt('/runs/run-passed/live')
    await flushRender()

    expect(fetchExecutionLogsMock).toHaveBeenCalledWith('run-passed')
    expect(mergeFinalArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      run: finalRun,
      steps: [finalStep],
      logs: [finalLog],
    }))
  })
})
