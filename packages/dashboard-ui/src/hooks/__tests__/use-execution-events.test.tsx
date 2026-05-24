// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useExecutionEvents } from '@/hooks/use-execution-events'
import type {
  ExecutionRunCompleteEvent,
  ExecutionStepCompleteEvent,
  ExecutionStepPhaseEvent,
  ExecutionStepStartEvent,
  ExecutionTestCompleteEvent,
  ExecutionTestStartEvent,
} from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { callbacksRef, closeMock, subscribeToExecutionEventsMock } = vi.hoisted(() => ({
  callbacksRef: {
    current: null as null | {
      onStepStart?: (data: ExecutionStepStartEvent) => void
      onStepPhase?: (data: ExecutionStepPhaseEvent) => void
      onStepComplete?: (data: ExecutionStepCompleteEvent) => void
      onTestStart?: (data: ExecutionTestStartEvent) => void
      onTestComplete?: (data: ExecutionTestCompleteEvent) => void
      onRunComplete?: (data: ExecutionRunCompleteEvent) => void
    },
  },
  closeMock: vi.fn(),
  subscribeToExecutionEventsMock: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    subscribeToExecutionEvents: subscribeToExecutionEventsMock,
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function Probe() {
  const state = useExecutionEvents('run-1', '2026-05-02T00:00:00.000Z')
  return (
    <div
      data-testid="state"
      data-run-status={state.runStatus}
      data-final-status={state.finalStatus ?? ''}
      data-display-steps={state.displaySteps.map((step) => `${step.name}:${step.status}`).join('|')}
      data-progress-label={state.progress.label ?? ''}
      data-progress-percent={state.progress.percent ?? ''}
    >
      {state.steps.map((step) => `${step.name}:${step.status}`).join('|')}
    </div>
  )
}

function startSuiteTest(runId: string, testName: string, suiteIndex: number, suiteTotal = 3) {
  act(() => {
    callbacksRef.current?.onTestStart?.({
      type: 'test-start',
      runId,
      parentRunId: 'run-1',
      suiteIndex,
      suiteTotal,
      testName,
      filePath: `/tests/${testName}.yaml`,
      totalSteps: 1,
      timestamp: '2026-05-02T00:00:00.000Z',
    })
  })
}

function completeSuiteTest(runId: string, testName: string, status: string) {
  act(() => {
    callbacksRef.current?.onTestComplete?.({
      type: 'test-complete',
      runId,
      testName,
      status,
      duration: 100,
    })
  })
}

function startStep(stepName: string, stepIndex = 0) {
  act(() => {
    callbacksRef.current?.onStepStart?.({
      type: 'step-start',
      runId: 'run-1',
      stepName,
      testName: 'Slow local model',
      stepIndex,
      stepId: `step-${stepIndex}`,
      timestamp: '2026-05-02T00:00:00.000Z',
    })
  })
}

function phaseStep(stepName: string, stepIndex: number, text: string) {
  act(() => {
    callbacksRef.current?.onStepPhase?.({
      type: 'step-phase',
      runId: 'run-1',
      stepName,
      testName: 'Slow local model',
      stepIndex,
      stepId: `step-${stepIndex}`,
      phase: 'plan',
      subActionIndex: 0,
      text,
      timestamp: '2026-05-02T00:00:00.000Z',
    })
  })
}

function completeStep(stepName: string, status: string, stepIndex = 0) {
  act(() => {
    callbacksRef.current?.onStepComplete?.({
      type: 'step-complete',
      runId: 'run-1',
      stepName,
      stepIndex,
      stepId: `step-${stepIndex}`,
      status,
      duration: 100,
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

async function renderProbe() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<Probe />)
  })

  return container.querySelector('[data-testid="state"]') as HTMLDivElement
}

beforeEach(() => {
  callbacksRef.current = null
  closeMock.mockReset()
  subscribeToExecutionEventsMock.mockReset()
  subscribeToExecutionEventsMock.mockImplementation((_runId: string, callbacks: typeof callbacksRef.current) => {
    callbacksRef.current = callbacks
    return { close: closeMock } as unknown as EventSource
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

describe('useExecutionEvents terminal status handling', () => {
  it('finalizes running steps as failed when the run times out', async () => {
    const state = await renderProbe()

    startStep('Wait for the local model')
    completeRun('timeout')

    expect(state.getAttribute('data-final-status')).toBe('timeout')
    expect(state.textContent).toContain('Wait for the local model:failed')
  })

  it('finalizes running steps as cancelled when the run is cancelled', async () => {
    const state = await renderProbe()

    startStep('Stop the local model run')
    completeRun('cancelled')

    expect(state.getAttribute('data-final-status')).toBe('cancelled')
    expect(state.textContent).toContain('Stop the local model run:cancelled')
  })

  it('completes only the current running step when names are duplicated', async () => {
    const state = await renderProbe()

    startStep('Repeat action', 0)
    startStep('Repeat action', 1)
    phaseStep('Repeat action', 1, 'phase for second repeat')
    completeStep('Repeat action', 'passed', 0)
    completeStep('Repeat action', 'failed', 1)

    expect(state.textContent).toBe('Repeat action:passed|Repeat action:failed')
    expect(state.getAttribute('data-display-steps')).toBe('Repeat action:passed|Repeat action:failed')
  })

  it('forwards test-complete events so suite progress advances', async () => {
    const state = await renderProbe()

    startSuiteTest('child-1', 'one', 0)

    expect(state.getAttribute('data-progress-label')).toBe('Test 1 of 3')
    expect(state.getAttribute('data-progress-percent')).toBe('0')

    completeSuiteTest('child-1', 'one', 'passed')

    expect(state.getAttribute('data-progress-label')).toBe('Test 2 of 3')
    expect(state.getAttribute('data-progress-percent')).toBe('33')

    startSuiteTest('child-2', 'two', 1)

    expect(state.getAttribute('data-progress-label')).toBe('Test 2 of 3')
    expect(state.getAttribute('data-progress-percent')).toBe('33')
  })
})
