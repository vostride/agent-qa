// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TabOverview, type ScreenshotEmptyState } from "@/components/run-detail/tab-overview"
import type { DisplayStep } from "@/lib/display-step"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/screenshot-viewer", () => ({
  ScreenshotViewer: ({ screenshotPath }: { screenshotPath: string }) => (
    <div data-testid="screenshot-viewer">{screenshotPath}</div>
  ),
}))

vi.mock("@/components/reasoning-pipeline", () => ({
  ReasoningPipeline: () => <div data-testid="reasoning-pipeline" />,
}))

vi.mock("@/components/healing-chain", () => ({
  HealingChain: () => <div data-testid="healing-chain" />,
}))

function makeStep(overrides: Partial<DisplayStep> = {}): DisplayStep {
  return {
    id: "step-1",
    name: "Open dashboard",
    status: "running",
    duration: 0,
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
    runId: "run-1",
    stepOrder: 0,
    consoleLogs: null,
    networkLogs: null,
    healingAttempts: null,
    screenContextBefore: null,
    screenContextAfter: null,
    rawRunId: "run-1",
    rawStepOrder: 0,
    displayStepOrder: 1,
    displayStepTotal: 1,
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderOverview(step: DisplayStep, screenshotEmptyState: ScreenshotEmptyState = "absent") {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <TabOverview
        step={step}
        subAction={null}
        runId={null}
        screenshotEmptyState={screenshotEmptyState}
      />,
    )
  })

  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe("TabOverview screenshot empty states", () => {
  it("shows pending copy while a screenshot is still expected", async () => {
    const view = await renderOverview(makeStep(), "pending")

    expect(view.textContent).toContain("Waiting for screenshot")
    expect(view.textContent).not.toContain("No screenshot captured")
    expect(view.textContent).not.toContain("No screenshot for this step")
  })

  it("shows absent copy when no terminal screenshot was captured", async () => {
    const view = await renderOverview(makeStep({ status: "passed" }), "absent")

    expect(view.textContent).toContain("No screenshot captured")
    expect(view.textContent).not.toContain("Waiting for screenshot")
    expect(view.textContent).not.toContain("No screenshot for this step")
  })

  it("renders the screenshot viewer when a screenshot exists", async () => {
    const view = await renderOverview(makeStep({ screenshotPath: "after.png" }), "pending")

    expect(view.querySelector('[data-testid="screenshot-viewer"]')?.textContent).toBe("after.png")
    expect(view.textContent).not.toContain("Waiting for screenshot")
    expect(view.textContent).not.toContain("No screenshot captured")
  })
})
