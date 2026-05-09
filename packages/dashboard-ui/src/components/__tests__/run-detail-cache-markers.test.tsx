// @vitest-environment jsdom

import { act, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { StepTreeItem } from "@/components/run-detail/step-tree-item"
import { StepTree } from "@/components/run-detail/step-tree"
import { SubActionTreeItem } from "@/components/run-detail/sub-action-tree-item"
import type { ExecutionLogEntry, RunRow, SubActionData } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

function mount(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return container
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function makeSubAction(overrides: Partial<SubActionData> = {}): SubActionData {
  return {
    index: overrides.index ?? 0,
    observation: "Observed the current page",
    reasoning: "Clicking the primary button is safe",
    plannedAction: { type: "click", target: "button.primary" },
    result: "success",
    screenStateBefore: "Dashboard page with primary button",
    cached: false,
    phaseDurations: { observe: 10, plan: 20, execute: 30, verify: 40 },
    ...overrides,
  }
}

function makeDisplayStep(subActionsData: SubActionData[]): DisplayStep {
  return {
    id: "step-1",
    name: "Open the dashboard",
    status: "passed",
    duration: 1200,
    subActionsData,
    observation: null,
    reasoning: null,
    plannedAction: null,
    error: null,
    stepOrder: 0,
    displayStepOrder: 1,
    displayStepTotal: 1,
    runId: "run-1",
    rawRunId: "run-1",
    rawStepOrder: 0,
    action: null,
    result: null,
    screenshotPath: null,
    screenshotBeforePath: null,
    annotationData: null,
    healingAttempts: null,
    retryCount: 0,
    capturedVariables: null,
    variableSnapshot: null,
    originalStepName: null,
    screenContextBefore: null,
    screenContextAfter: null,
    healingScreenshotPaths: null,
    accessibilityViolations: null,
    consoleLogs: null,
    networkLogs: null,
    confidence: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    createdAt: "2026-04-29T00:00:00.000Z",
  } as DisplayStep
}

function makeRunRow(id: string, name: string, status: string): RunRow {
  return {
    id,
    name,
    filePath: null,
    status,
    duration: 0,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: null,
    endedAt: null,
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: 'suite-1',
    platform: 'web',
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: 'suite-1',
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
  }
}

function makeHook(id: string, runId: string, name: string, phase: 'setup' | 'teardown'): ExecutionLogEntry {
  return {
    id,
    runId,
    stepId: null,
    type: 'hook',
    name,
    hookId: id,
    phase,
    status: 'passed',
    duration: 5,
    stdout: null,
    stderr: null,
    returnData: null,
    variables: null,
    createdAt: '2026-04-29T00:00:00.000Z',
  }
}

describe("run detail cache markers", () => {
  it("renders a status-attached primary marker for fully cached steps", () => {
    const view = mount(
      <ul>
        <StepTreeItem
          step={makeDisplayStep([
            makeSubAction({ index: 0, cached: true }),
            makeSubAction({ index: 1, cached: true }),
          ])}
          isSelected={false}
          isExpanded={false}
          selection={null}
          onSelect={() => {}}
        />
      </ul>,
    )

    const marker = view.querySelector('[data-cache-marker="step-status"][data-cache-state="all"]')
    const icon = marker?.querySelector("svg")

    expect(marker).toBeTruthy()
    expect(marker?.className).toContain("size-2")
    expect(marker?.className).toContain("rounded-full")
    expect(marker?.className).toContain("border")
    expect(marker?.className).not.toContain("ring-background")
    expect(icon?.getAttribute("class")).toContain("size-1.5")
    expect(view.textContent).toContain("All actions cached")
    expect(view.textContent).not.toContain("accelerated")
  })

  it("renders an amber status-attached marker for partially cached steps", () => {
    const view = mount(
      <ul>
        <StepTreeItem
          step={makeDisplayStep([
            makeSubAction({ index: 0, cached: true }),
            makeSubAction({ index: 1, cached: false }),
            makeSubAction({ index: 2, cached: true }),
            makeSubAction({ index: 3, cached: false }),
            makeSubAction({ index: 4, cached: false }),
          ])}
          isSelected={false}
          isExpanded={false}
          selection={null}
          onSelect={() => {}}
        />
      </ul>,
    )

    const marker = view.querySelector('[data-cache-marker="step-status"][data-cache-state="some"]')

    expect(marker).toBeTruthy()
    expect(marker?.className).toContain("text-amber-500")
    expect(view.textContent).toContain("2 of 5 actions cached")
    expect(view.textContent).not.toContain("accelerated")
  })

  it("renders a status-dot-attached marker for cached sub-actions", () => {
    const view = mount(
      <ul>
        <SubActionTreeItem
          sub={makeSubAction({ cached: true })}
          index={0}
          stepId="step-1"
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>,
    )

    const marker = view.querySelector('[data-cache-marker="sub-action-status"][data-cache-state="cached"]')

    expect(marker).toBeTruthy()
    expect(view.textContent).toContain("Cached action")
    expect(view.textContent).not.toContain("Cache hit")
  })

  it("keeps suite setup, child groups, skipped children, and teardown in grouped order", () => {
    const step = {
      ...makeDisplayStep([makeSubAction({ index: 0, reasoning: 'First child action' })]),
      id: 'child-a-step-1',
      rawRunId: 'child-a',
      runId: 'child-a',
      name: 'First child step',
    }
    const view = mount(
      <StepTree
        steps={[step]}
        selection={null}
        onSelect={() => {}}
        suiteTests={[
          makeRunRow('child-a', 'Login', 'passed'),
          makeRunRow('child-b', 'Checkout', 'skipped'),
        ]}
        suiteSelectedView="all"
        setupHooks={[
          makeHook('suite-setup', 'suite-1', 'Suite setup', 'setup'),
          makeHook('child-setup', 'child-a', 'Child setup', 'setup'),
        ]}
        teardownHooks={[makeHook('suite-teardown', 'suite-1', 'Suite teardown', 'teardown')]}
        inlineLogs={[]}
      />,
    )

    const text = view.textContent ?? ''
    expect(text).toContain('Suite setup')
    expect(text).toContain('Login')
    expect(text).toContain('Child setup')
    expect(text).toContain('First child step')
    expect(text).toContain('Checkout')
    expect(text).toContain('Skipped')
    expect(text).toContain('Suite teardown')
    expect(text.indexOf('Suite setup')).toBeLessThan(text.indexOf('Login'))
    expect(text.indexOf('Login')).toBeLessThan(text.indexOf('Checkout'))
    expect(text.indexOf('Checkout')).toBeLessThan(text.indexOf('Suite teardown'))
  })
})
