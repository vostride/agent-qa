// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunDetailPage from "@/pages/run-detail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunMock,
  fetchRunArtifactMock,
  fetchActiveExecutionsMock,
  fetchExecutionLogsMock,
  fetchAccessibilitySummaryMock,
} = vi.hoisted(() => ({
  fetchRunMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchActiveExecutionsMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
  fetchAccessibilitySummaryMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunArtifact: fetchRunArtifactMock,
  fetchActiveExecutions: fetchActiveExecutionsMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchAccessibilitySummary: fetchAccessibilitySummaryMock,
  triggerRun: vi.fn(),
}))

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitle: (title: string) => {
    document.title = title
  },
}))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: () => <div data-testid="run-navbar">navbar</div>,
}))
vi.mock("@/components/run-detail/step-tree", () => ({
  StepTree: ({
    steps,
    selection,
  }: {
    steps: Array<{
      id: string
      name: string
      rawRunId: string | null
      rawStepOrder: number
      displayStepOrder: number
      displayStepTotal: number | null
    }>
    selection: { stepId?: string } | null
  }) => (
    <div data-testid="step-tree" data-selection={selection?.stepId ?? ""}>
      {steps.map((step) => (
        <div
          key={step.id}
          data-step-id={step.id}
          data-run-id={step.rawRunId ?? ""}
          data-raw-order={String(step.rawStepOrder)}
          data-display-order={String(step.displayStepOrder)}
          data-display-total={String(step.displayStepTotal)}
        >
          {`${step.name}:${step.displayStepOrder}/${step.displayStepTotal}`}
        </div>
      ))}
    </div>
  ),
}))
vi.mock("@/components/run-detail/tab-panels", () => ({
  TabPanels: ({
    runId,
    step,
  }: {
    runId: string | null
    step: { id: string; rawRunId: string | null; rawStepOrder: number; displayStepOrder: number; displayStepTotal: number | null } | null
  }) => (
    <div
      data-testid="tab-panels"
      data-run-id={runId ?? ""}
      data-step-id={step?.id ?? ""}
      data-raw-order={step ? String(step.rawStepOrder) : ""}
      data-display-order={step ? `${step.displayStepOrder}/${step.displayStepTotal}` : ""}
    />
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: () => <span>suite view</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}))

function makeStep(runId: string, id: string, stepOrder: number, name: string) {
  return {
    id,
    runId,
    name,
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
    stepOrder,
    annotationData: null,
    healingScreenshotPaths: null,
    accessibilityViolations: null,
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
    createdAt: "2026-04-18T00:00:00.000Z",
  }
}

function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs/:id"
            element={
              <>
                <LocationProbe />
                <RunDetailPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

beforeEach(() => {
  document.title = ""
  Element.prototype.scrollIntoView = vi.fn()
  fetchRunMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  fetchAccessibilitySummaryMock.mockReset()

  fetchActiveExecutionsMock.mockResolvedValue({ executions: [] })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchAccessibilitySummaryMock.mockResolvedValue({
    enabled: null,
    total: 0,
    bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    byRule: [],
    stepsWithViolations: 0,
    scannedSteps: 0,
    unscannedSteps: 0,
    totalSteps: 0,
  })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: "suite-1" }, artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => {
    if (id === "suite-1") {
      return {
        run: {
          id: "suite-1",
          name: "Suite run",
          filePath: "tests/suite.yaml",
          status: "failed",
          duration: 10000,
          tags: null,
          environment: null,
          metadata: null,
          startedAt: "2026-04-18T00:00:00.000Z",
          endedAt: "2026-04-18T00:00:10.000Z",
          source: "suite",
          videoPath: null,
          failureSummary: null,
          errorLog: null,
          memoryLog: null,
          testId: null,
          suiteId: "s_suite",
          platform: "web",
          testFileContent: null,
          modelName: null,
          llmProvider: null,
          parentRunId: null,
          attemptNumber: 1,
          retryCount: 0,
          maxRetries: 0,
          createdAt: "2026-04-18T00:00:00.000Z",
        },
        steps: [],
        attempts: [],
        tests: [
          { id: "child-a", name: "Login", status: "passed" },
          { id: "child-b", name: "Checkout", status: "failed" },
        ],
      }
    }
    if (id === "child-a") {
      return {
        run: { id: "child-a", source: "dashboard" },
        steps: [
          makeStep("child-a", "a-1", 0, "Open login"),
          makeStep("child-a", "a-2", 1, "Submit credentials"),
        ],
      }
    }
    if (id === "child-b") {
      return {
        run: { id: "child-b", source: "dashboard" },
        steps: [
          makeStep("child-b", "b-1", 0, "Open cart"),
          makeStep("child-b", "b-2", 1, "Pay now"),
        ],
      }
    }
    if (id === "timeout-run") {
      return {
        run: {
          id: "timeout-run",
          name: "Local model timeout",
          filePath: "tests/web/01-homepage-basics.yaml",
          status: "failed",
          duration: 5000,
          tags: null,
          environment: null,
          metadata: null,
          startedAt: "2026-05-02T00:00:00.000Z",
          endedAt: "2026-05-02T00:00:05.000Z",
          source: "dashboard",
          videoPath: null,
          failureSummary: "Timed out waiting for google/gemma-4-e4b after the configured deadline.",
          errorLog: null,
          memoryLog: null,
          testId: "t_homepage",
          suiteId: null,
          platform: "web",
          testFileContent: null,
          modelName: "google/gemma-4-e4b",
          llmProvider: "openai-compatible",
          parentRunId: null,
          attemptNumber: 1,
          retryCount: 0,
          maxRetries: 0,
          createdAt: "2026-05-02T00:00:00.000Z",
        },
        steps: [
          {
            ...makeStep("timeout-run", "timeout-step-1", 0, "Wait for local model"),
            status: "failed",
            error: "Timed out waiting for google/gemma-4-e4b",
          },
        ],
        attempts: [],
      }
    }
    throw new Error(`Unexpected run lookup: ${id}`)
  })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  vi.clearAllMocks()
})

describe("RunDetailPage suite all-tests mode", () => {
  it("uses the app-shell-safe height contract instead of h-screen", async () => {
    const view = await renderAt("/runs/suite-1")
    const rootSurface = view.querySelector('[data-testid="run-navbar"]')?.parentElement as HTMLDivElement | null

    expect(rootSurface?.className).toContain("h-full")
    expect(rootSurface?.className).toContain("min-h-0")
    expect(rootSurface?.className).toContain("overflow-hidden")
    expect(rootSurface?.className).not.toContain("h-screen")
  })

  it("keeps suite progress cumulative while selecting child steps by raw run identity", async () => {
    const view = await renderAt("/runs/suite-1?step=0&run=child-b")

    expect(view.textContent).toContain("Open login:1/4")
    expect(view.textContent).toContain("Submit credentials:2/4")
    expect(view.textContent).toContain("Open cart:3/4")
    expect(view.textContent).toContain("Pay now:4/4")

    const panels = view.querySelector('[data-testid="tab-panels"]')
    expect(panels?.getAttribute("data-run-id")).toBe("child-b")
    expect(panels?.getAttribute("data-step-id")).toBe("b-1")
    expect(panels?.getAttribute("data-raw-order")).toBe("0")
    expect(panels?.getAttribute("data-display-order")).toBe("3/4")
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?step=0&run=child-b")
  })

  it("sets the page title without exposing the run id", async () => {
    await renderAt("/runs/suite-1")

    expect(document.title).toBe("Run - Suite run")
    expect(document.title).not.toContain("suite-1")
  })

  it("shows failed timeout summaries on persisted run detail", async () => {
    const view = await renderAt("/runs/timeout-run")

    expect(view.textContent).toContain("Timed out waiting for google/gemma-4-e4b")
  })
})
