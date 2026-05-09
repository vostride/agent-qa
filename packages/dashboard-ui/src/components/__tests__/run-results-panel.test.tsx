// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunResultsPanel } from '@/components/run-results-panel'
import type { ExecutionRunCompleteEvent, ExecutionStepCompleteEvent, ExecutionStepStartEvent } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { callbacksRef, subscribeToExecutionEventsMock } = vi.hoisted(() => ({
  callbacksRef: {
    current: null as null | {
      onRunStart?: (data: { runId: string; status: string }) => void
      onStepStart?: (data: ExecutionStepStartEvent) => void
      onStepComplete?: (data: ExecutionStepCompleteEvent) => void
      onRunComplete?: (data: ExecutionRunCompleteEvent) => void
    },
  },
  subscribeToExecutionEventsMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    subscribeToExecutionEvents: subscribeToExecutionEventsMock,
  }
})
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function startRun() {
  act(() => {
    callbacksRef.current?.onRunStart?.({ runId: 'run-1', status: 'running' })
    callbacksRef.current?.onStepStart?.({
      type: 'step-start',
      runId: 'run-1',
      stepName: 'Wait for local model',
      testName: 'Local model regression',
      timestamp: '2026-05-02T00:00:00.000Z',
    })
  })
}

function completeRun(status: string) {
  act(() => {
    callbacksRef.current?.onRunComplete?.({
      type: 'run-complete',
      runId: 'run-1',
      status,
      duration: 1000,
    })
  })
}

async function renderPanel() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<RunResultsPanel runId="run-1" onClose={() => {}} />)
  })

  return container
}

beforeEach(() => {
  callbacksRef.current = null
  subscribeToExecutionEventsMock.mockReset()
  subscribeToExecutionEventsMock.mockImplementation((_runId: string, callbacks: typeof callbacksRef.current) => {
    callbacksRef.current = callbacks
    return { close: vi.fn() } as unknown as EventSource
  })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('RunResultsPanel terminal status rendering', () => {
  it('distinguishes cancelled run-complete events from failed runs', async () => {
    const view = await renderPanel()

    startRun()
    completeRun('cancelled')

    expect(view.textContent).toContain('Cancelled')
    expect(view.textContent).not.toContain('Failed')
  })

  it('renders timeout run-complete events with timeout wording', async () => {
    const view = await renderPanel()

    startRun()
    completeRun('timeout')

    expect(view.textContent).toContain('Timed Out')
    expect(view.textContent).not.toContain('Passed')
  })

  it('completes only the first matching running step when duplicate names are active', async () => {
    const view = await renderPanel()

    act(() => {
      callbacksRef.current?.onRunStart?.({ runId: 'run-1', status: 'running' })
      callbacksRef.current?.onStepStart?.({
        type: 'step-start',
        runId: 'run-1',
        stepName: 'Duplicate local step',
        testName: 'Local model regression',
        timestamp: '2026-05-02T00:00:00.000Z',
      })
      callbacksRef.current?.onStepStart?.({
        type: 'step-start',
        runId: 'run-1',
        stepName: 'Duplicate local step',
        testName: 'Local model regression',
        timestamp: '2026-05-02T00:00:01.000Z',
      })
      callbacksRef.current?.onStepComplete?.({
        type: 'step-complete',
        runId: 'run-1',
        stepName: 'Duplicate local step',
        status: 'passed',
        duration: 5,
      })
    })

    expect((view.textContent ?? '').match(/Duplicate local step/g)).toHaveLength(2)
    expect((view.textContent ?? '').match(/5ms/g)).toHaveLength(1)
  })
})
