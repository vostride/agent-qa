// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AccessibilitySummary, StepRow } from "@/lib/api"

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span data-testid="impact-badge" className={className}>{children}</span>
  ),
}))

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}))

import { TabA11y } from "@/components/run-detail/tab-a11y"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const summaryBase: AccessibilitySummary = {
  enabled: null,
  total: 0,
  bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
  byRule: [],
  stepsWithViolations: 0,
  scannedSteps: 0,
  unscannedSteps: 0,
  totalSteps: 0,
}

function makeStep(accessibilityViolations: StepRow["accessibilityViolations"]): StepRow {
  return {
    id: "step-1",
    runId: "run-1",
    name: "Inspect page",
    status: "passed",
    duration: 1000,
    action: null,
    observation: null,
    reasoning: null,
    plannedAction: null,
    result: null,
    error: null,
    screenshotPath: null,
    screenshotBeforePath: null,
    healingAttempts: null,
    retryCount: 0,
    capturedVariables: null,
    stepOrder: 0,
    annotationData: null,
    healingScreenshotPaths: null,
    accessibilityViolations,
    consoleLogs: null,
    networkLogs: null,
    confidence: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    subActionsData: null,
    variableSnapshot: null,
    originalStepName: null,
    screenContextBefore: null,
    screenContextAfter: null,
    createdAt: "2026-05-10T00:00:00.000Z",
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderA11y(
  accessibilityViolations: StepRow["accessibilityViolations"],
  summary: AccessibilitySummary | null = summaryBase,
) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(<TabA11y step={makeStep(accessibilityViolations)} summary={summary} />)
  })

  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
})

describe("TabA11y", () => {
  it("reports disabled checks separately from clean scans", async () => {
    const view = await renderA11y(null, { ...summaryBase, enabled: false })

    expect(view.textContent).toContain("Accessibility checks were disabled for this run.")
    expect(view.textContent).not.toContain("No accessibility violations detected")
  })

  it("reports missing per-step scan data separately from clean scans", async () => {
    const view = await renderA11y(null, { ...summaryBase, enabled: true })

    expect(view.textContent).toContain("Accessibility checks did not record data for this step.")
    expect(view.textContent).not.toContain("No accessibility violations detected")
  })

  it("reports a clean scan when the step has an empty violation list", async () => {
    const view = await renderA11y([], { ...summaryBase, enabled: true, scannedSteps: 1, totalSteps: 1 })

    expect(view.textContent).toContain("No accessibility violations detected")
  })

  it("renders recorded violations with impact, node html, and help link", async () => {
    const view = await renderA11y([
      {
        ruleId: "image-alt",
        impact: "critical",
        description: "Images must have alternate text",
        help: "Image elements must have alternate text",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.10/image-alt",
        nodes: [{ html: '<img src="hero.png">', target: ["img"] }],
      },
    ])

    expect(view.textContent).toContain("critical")
    expect(view.textContent).toContain("image-alt")
    expect(view.textContent).toContain("Image elements must have alternate text")
    expect(view.textContent).toContain('<img src="hero.png">')
    expect(view.querySelector("a")?.getAttribute("href")).toBe("https://dequeuniversity.com/rules/axe/4.10/image-alt")
  })
})
