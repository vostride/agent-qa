// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunDetailPage from "@/pages/run-detail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunMock,
  fetchRunArtifactMock,
  fetchActiveExecutionsMock,
  fetchExecutionLogsMock,
  fetchAccessibilitySummaryMock,
  useKeyboardShortcutsMock,
  latestShortcuts,
} = vi.hoisted(() => {
  let latest: Record<string, (event: KeyboardEvent) => void> | null = null
  return {
    fetchRunMock: vi.fn(),
    fetchRunArtifactMock: vi.fn(),
    fetchActiveExecutionsMock: vi.fn(),
    fetchExecutionLogsMock: vi.fn(),
    fetchAccessibilitySummaryMock: vi.fn(),
    useKeyboardShortcutsMock: vi.fn((shortcuts: Record<string, (event: KeyboardEvent) => void>) => {
      latest = shortcuts
    }),
    latestShortcuts: () => {
      if (!latest) throw new Error("useKeyboardShortcuts was not called")
      return latest
    },
  }
})

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

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: useKeyboardShortcutsMock,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/components/page-skeleton", () => ({
  DetailSkeleton: () => <div>Loading...</div>,
}))

vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: ({ onOpenArtifacts }: { onOpenArtifacts: (tab: "attributes" | "config" | "memory") => void }) => (
    <button type="button" data-testid="navbar-artifacts" onClick={() => onOpenArtifacts("attributes")}>
      navbar artifacts
    </button>
  ),
}))

vi.mock("@/components/run-detail/artifact-drawer", () => ({
  ArtifactDrawer: ({
    open,
    tab,
    response,
    loading,
    error,
    onOpenChange,
    onTabChange,
    onRetry,
  }: {
    open: boolean
    tab: "attributes" | "config" | "memory"
    response: { artifact: unknown; run?: { attributes?: Record<string, string> } } | null
    loading: boolean
    error: string | null
    onOpenChange: (open: boolean) => void
    onTabChange: (tab: "attributes" | "config" | "memory") => void
    onRetry: () => void
  }) => {
    if (!open) return null
    return (
      <div
        data-testid="artifact-drawer"
        data-tab={tab}
        data-loading={String(loading)}
        data-artifact={response?.artifact ? "present" : "missing"}
      >
        {loading ? <span>Loading artifact data...</span> : null}
        {error ? (
          <div>
            <h3>Could not load artifact data</h3>
            <p>Retry the request. If it continues, verify the dashboard server can read run artifacts.</p>
            <span>error:{error}</span>
            <button type="button" data-testid="drawer-retry" onClick={onRetry}>Retry</button>
          </div>
        ) : null}
        {!loading && !error && !response?.artifact ? (
          <div>
            <h3>Artifact data is not available for this run</h3>
            <p>This run does not have a persisted artifact record.</p>
          </div>
        ) : null}
        <div>Attributes Config Memory</div>
        {tab === "attributes" && response?.run?.attributes ? (
          <div>
            <button type="button">Copy JSON</button>
            {Object.entries(response.run.attributes).map(([key, value]) => (
              <div key={key}>
                <span>{key}</span>
                <span>{value}</span>
                <button type="button" aria-label={`Copy ${key} value`}>copy</button>
              </div>
            ))}
          </div>
        ) : null}
        <button type="button" data-testid="drawer-close" onClick={() => onOpenChange(false)}>close</button>
        <button type="button" data-testid="drawer-attributes" onClick={() => onTabChange("attributes")}>attributes</button>
        <button type="button" data-testid="drawer-memory" onClick={() => onTabChange("memory")}>memory</button>
      </div>
    )
  },
}))

vi.mock("@/components/run-detail/step-tree", () => ({
  StepTree: ({
    steps,
    selection,
  }: {
    steps: Array<{ id: string; name: string; rawRunId: string | null; rawStepOrder: number }>
    selection: { type: string; stepId?: string; subIndex?: number } | null
  }) => {
    const selectionLabel = selection
      ? `${selection.type}:${selection.stepId ?? ""}:${selection.subIndex ?? ""}`
      : ""
    return (
      <div data-testid="step-tree" data-selection={selectionLabel}>
        {steps.map((step) => (
          <div key={step.id} data-step-id={step.id}>
            {step.name}
          </div>
        ))}
      </div>
    )
  },
}))

vi.mock("@/components/run-detail/tab-panels", () => ({
  TabPanels: () => <div data-testid="tab-panels" />,
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
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

function makeSubAction(index: number) {
  return {
    index,
    observation: "Observed checkout screen",
    reasoning: "Need to inspect artifacts",
    plannedAction: { type: "click", ref: "checkout" },
    result: "success" as const,
    screenStateBefore: "",
    confidence: 0.9,
    cached: false,
  }
}

function makeStep() {
  return {
    id: "step-1",
    runId: "run-1",
    name: "Inspect artifact behavior",
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
    accessibilityViolations: null,
    consoleLogs: null,
    networkLogs: null,
    confidence: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    subActionsData: [makeSubAction(0)],
    variableSnapshot: null,
    originalStepName: null,
    screenContextBefore: null,
    screenContextAfter: null,
    createdAt: "2026-04-18T00:00:00.000Z",
  }
}

function makeRun(id: string) {
  return {
    id,
    name: "Artifact run",
    filePath: "tests/artifact.yaml",
    status: "passed",
    duration: 1000,
    attributes: {
      "agent-qa.trigger": "cli",
      "agent-qa.runner": "local",
      "git.branch": "phase223-main",
    },
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.000Z",
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
  }
}

function makeArtifactResponse(id = "run-1") {
  return {
    run: makeRun(id),
    artifact: {
      runId: id,
      kind: "test" as const,
      schemaVersion: 1,
      payload: { schemaVersion: 1, metadata: { attributes: makeRun(id).attributes } },
      finalizedAt: "2026-04-18T00:00:01.000Z",
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:01.000Z",
    },
    children: [],
    missingSections: [],
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

function NavigationProbe() {
  const navigate = useNavigate()
  return (
    <button type="button" data-testid="navigate-run-2" onClick={() => navigate("/runs/run-2?step=0&sub=0")}>
      run 2
    </button>
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
                <NavigationProbe />
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

function searchParams(view: HTMLElement) {
  return new URLSearchParams(
    view.querySelector('[data-testid="location"]')?.getAttribute("data-search") ?? "",
  )
}

beforeEach(() => {
  document.title = ""
  fetchRunMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  fetchAccessibilitySummaryMock.mockReset()
  useKeyboardShortcutsMock.mockClear()

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
  fetchRunMock.mockImplementation(async (id: string) => ({
    run: makeRun(id),
    steps: [makeStep()],
    attempts: [],
  }))
  fetchRunArtifactMock.mockImplementation(async (id: string) => makeArtifactResponse(id))
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

describe("RunDetailPage artifact drawer", () => {
  it("opens Attributes with I and renders run attributes", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")

    await act(async () => {
      latestShortcuts().i(new KeyboardEvent("keydown", { key: "i" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("attributes")
    expect(drawer.textContent).toContain("Attributes")
    expect(drawer.textContent).toContain("Config")
    expect(drawer.textContent).toContain("Memory")
    expect(drawer.textContent).toContain("agent-qa.trigger")
    expect(drawer.textContent).toContain("agent-qa.runner")
    expect(drawer.textContent).toContain("git.branch")
    expect(drawer.textContent).toContain("Copy JSON")
    expect(drawer.querySelector('[aria-label="Copy git.branch value"]')).not.toBeNull()
  })

  it("opens Config with C without changing URL params or selected sub-action", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0&tab=network")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("config")
    expect(fetchRunArtifactMock).toHaveBeenCalledWith("run-1")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(searchParams(view).get("step")).toBe("0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("run")).toBeNull()
    expect(searchParams(view).get("tab")).toBe("network")
  })

  it("opens Memory with M and keeps navigation state stable", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().m(new KeyboardEvent("keydown", { key: "m" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("memory")
    expect(fetchRunArtifactMock).toHaveBeenCalledWith("run-1")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(searchParams(view).get("step")).toBe("0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("run")).toBeNull()
    expect(searchParams(view).get("tab")).toBeNull()
  })

  it("closes the drawer on first Escape before clearing selection", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    expect(view.querySelector('[data-testid="artifact-drawer"]')).not.toBeNull()

    await act(async () => {
      latestShortcuts().escape(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    await flushRender()

    expect(view.querySelector('[data-testid="artifact-drawer"]')).toBeNull()
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(searchParams(view).get("step")).toBe("0")
    expect(searchParams(view).get("sub")).toBe("0")
  })

  it("opens from the navbar action on Attributes", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")

    await act(async () => {
      ;(view.querySelector('[data-testid="navbar-artifacts"]') as HTMLButtonElement).click()
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("attributes")
    expect(fetchRunArtifactMock).toHaveBeenCalledWith("run-1")
  })

  it("keeps the drawer open on fetch error and retries the current run", async () => {
    fetchRunArtifactMock
      .mockRejectedValueOnce(new Error("server down"))
      .mockResolvedValueOnce(makeArtifactResponse("run-1"))
    const view = await renderAt("/runs/run-1?step=0&sub=0")

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    let drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.textContent).toContain("Could not load artifact data")
    expect(drawer.textContent).toContain("Retry the request. If it continues, verify the dashboard server can read run artifacts.")
    expect(drawer.textContent).toContain("server down")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(1)
    expect(fetchRunArtifactMock).toHaveBeenNthCalledWith(1, "run-1")

    await act(async () => {
      ;(view.querySelector('[data-testid="drawer-retry"]') as HTMLButtonElement).click()
    })
    await flushRender()

    drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-artifact")).toBe("present")
    expect(drawer.textContent).not.toContain("Could not load artifact data")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(2)
    expect(fetchRunArtifactMock).toHaveBeenNthCalledWith(2, "run-1")
  })

  it("shows quiet missing artifact copy when the response has no artifact row", async () => {
    fetchRunArtifactMock.mockResolvedValueOnce({
      ...makeArtifactResponse("run-1"),
      artifact: null,
    })
    const view = await renderAt("/runs/run-1?step=0&sub=0")

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-artifact")).toBe("missing")
    expect(drawer.textContent).toContain("Artifact data is not available for this run")
    expect(drawer.textContent).toContain("This run does not have a persisted artifact record.")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(1)
  })

  it("switches drawer tabs without refetching or mutating navigation state", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0&tab=network")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    await act(async () => {
      ;(view.querySelector('[data-testid="drawer-memory"]') as HTMLButtonElement).click()
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer.getAttribute("data-tab")).toBe("memory")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(1)
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(searchParams(view).get("step")).toBe("0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("tab")).toBe("network")
  })

  it("resets artifact state and fetches again when a different run is rendered", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(1)
    expect(fetchRunArtifactMock).toHaveBeenNthCalledWith(1, "run-1")

    await act(async () => {
      ;(view.querySelector('[data-testid="navigate-run-2"]') as HTMLButtonElement).click()
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-artifact")).toBe("present")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(2)
    expect(fetchRunArtifactMock).toHaveBeenNthCalledWith(2, "run-2")
    expect(searchParams(view).get("step")).toBe("0")
    expect(searchParams(view).get("sub")).toBe("0")
  })
})
