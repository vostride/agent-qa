// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StepNameWithPills } from '@/components/run-detail/step-name-pills'
import type { DisplayStep } from '@/lib/display-step'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeStep(overrides: Partial<DisplayStep> = {}): DisplayStep {
  return {
    id: 'step-1',
    name: 'Enter password [secret:loginPassword]',
    status: 'passed',
    duration: 10,
    subActionsData: null,
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
    runId: 'run-1',
    stepOrder: 0,
    consoleLogs: null,
    networkLogs: null,
    healingAttempts: null,
    screenContextBefore: null,
    screenContextAfter: null,
    rawRunId: 'run-1',
    rawStepOrder: 0,
    displayStepOrder: 1,
    displayStepTotal: 1,
    ...overrides,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

describe('StepNameWithPills', () => {
  it('highlights redacted secret markers when only artifact text is available', () => {
    if (!root || !container) throw new Error('Test root not initialized')

    act(() => {
      root!.render(<StepNameWithPills step={makeStep()} />)
    })

    const secretMarker = container.querySelector('[aria-label="variable: loginPassword"]') as HTMLSpanElement | null
    expect(container.textContent).toContain('Enter password ')
    expect(secretMarker?.textContent).toBe('[secret:loginPassword]')
    expect(secretMarker?.className).toContain('bg-rose-500/15')
  })
})
