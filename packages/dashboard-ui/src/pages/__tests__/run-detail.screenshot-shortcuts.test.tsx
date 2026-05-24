// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_FAVICON_HREF } from "@/hooks/use-run-status-favicon"
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
    }>
    selection: { type: string; stepId?: string; subIndex?: number } | null
  }) => {
    const selectionLabel = selection
      ? `${selection.type}:${selection.stepId ?? ""}:${selection.subIndex ?? ""}`
      : ""
    return (
      <div data-testid="step-tree" data-selection={selectionLabel}>
        {steps.map((step) => (
          <div
            key={step.id}
            data-step-id={step.id}
            data-run-id={step.rawRunId ?? ""}
            data-raw-order={String(step.rawStepOrder)}
          >
            {step.name}
          </div>
        ))}
      </div>
    )
  },
}))

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

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
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
  Button: ({ children, ...props }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

function makeSubAction(index: number, beforePath: string | null, afterPath: string | null) {
  return {
    index,
    observation: "Observed checkout screen",
    reasoning: "Need to compare screenshots",
    plannedAction: { type: "click", ref: "checkout" },
    result: "success" as const,
    screenStateBefore: "",
    confidence: 0.9,
    cached: false,
    screenshotBeforePath: beforePath ?? undefined,
    screenshotAfterPath: afterPath ?? undefined,
  }
}

function makeStep(afterPath: string | null = "screens/run-1/after.png") {
  return {
    id: "step-1",
    runId: "run-1",
    name: "Compare checkout screenshots",
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
    subActionsData: [makeSubAction(0, "screens/run-1/before.png", afterPath)],
    variableSnapshot: null,
    originalStepName: null,
    screenContextBefore: null,
    screenContextAfter: null,
    createdAt: "2026-04-18T00:00:00.000Z",
  }
}

function makeRun(id: string, status = "passed") {
  return {
    id,
    name: "Screenshot run",
    filePath: "tests/screenshots.yaml",
    status,
    duration: 1000,
    tags: null,
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.000Z",
    source: "dashboard",
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
    parallel: false,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
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

function resetFavicon() {
  document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${DEFAULT_FAVICON_HREF}">`
}

function getFaviconHref() {
  return document
    .querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    ?.getAttribute("href")
}

function expectDefaultFavicon() {
  expect(getFaviconHref()).toBe(DEFAULT_FAVICON_HREF)
}

function expectStatusFavicon() {
  expect(getFaviconHref()).toMatch(/^data:image\/svg\+xml,/)
}

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

function screenshotPath(view: HTMLElement) {
  return view.querySelector('[data-testid="screenshot-viewer"]')?.textContent ?? ""
}

function expectSearchParams(
  location: HTMLElement,
  expected: Record<string, string | null>,
) {
  const params = new URLSearchParams(location.getAttribute("data-search") ?? "")
  for (const [key, value] of Object.entries(expected)) {
    expect(params.get(key)).toBe(value)
  }
}

beforeEach(() => {
  resetFavicon()
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
  fetchRunArtifactMock.mockResolvedValue({ run: makeRun("run-1"), artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({
    run: makeRun(id),
    steps: [makeStep(id === "missing-after" ? null : "screens/run-1/after.png")],
    attempts: [],
  }))
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  document.head.innerHTML = ""
  vi.clearAllMocks()
})

describe("RunDetailPage screenshot shortcuts", () => {
  it("syncs the default selected step into the URL without repeated rewrites", async () => {
    const view = await renderAt("/runs/run-1")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement

    expect(location.getAttribute("data-search")).toBe("?step=0")

    await flushRender()

    expect(location.getAttribute("data-search")).toBe("?step=0")
  })

  it("uses useKeyboardShortcuts A/B handlers to select After and Before without changing navigation state", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    expect(screenshotPath(view)).toBe("screens/run-1/before.png")
    expect(view.textContent).toContain("Before")
    expect(view.textContent).toContain("After")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(location.getAttribute("data-search")).toBe("?step=0&sub=0")

    await act(async () => {
      latestShortcuts().a(new KeyboardEvent("keydown", { key: "a" }))
    })

    expect(screenshotPath(view)).toBe("screens/run-1/after.png")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(location.getAttribute("data-search")).toBe("?step=0&sub=0")

    await act(async () => {
      latestShortcuts().b(new KeyboardEvent("keydown", { key: "b" }))
    })

    expect(screenshotPath(view)).toBe("screens/run-1/before.png")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(location.getAttribute("data-search")).toBe("?step=0&sub=0")
  })

  it("no-ops outside overview without changing the active tab URL or selected sub-action marker", async () => {
    const view = await renderAt("/runs/run-1?step=0&sub=0&tab=network")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    expectSearchParams(location, { step: "0", sub: "0", tab: "network" })
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")

    await act(async () => {
      latestShortcuts().a(new KeyboardEvent("keydown", { key: "a" }))
      latestShortcuts().b(new KeyboardEvent("keydown", { key: "b" }))
    })

    expectSearchParams(location, { step: "0", sub: "0", tab: "network" })
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
  })

  it("keeps the Before screenshot when the current pair has no After screenshot", async () => {
    const view = await renderAt("/runs/missing-after?step=0&sub=0")
    const location = view.querySelector('[data-testid="location"]') as HTMLElement
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    expect(screenshotPath(view)).toBe("screens/run-1/before.png")

    await act(async () => {
      latestShortcuts().a(new KeyboardEvent("keydown", { key: "a" }))
    })

    expect(screenshotPath(view)).toBe("screens/run-1/before.png")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:step-1:0")
    expect(location.getAttribute("data-search")).toBe("?step=0&sub=0")
  })
})

describe("RunDetailPage favicon lifecycle", () => {
  it("keeps the default favicon while fetchRun is unresolved", async () => {
    fetchRunMock.mockReturnValue(new Promise(() => {}))

    await renderAt("/runs/run-loading")

    expectDefaultFavicon()
  })

  it.each(["passed", "failed", "cancelled"] as const)(
    "sets a non-default favicon for loaded %s runs",
    async (status) => {
      fetchRunMock.mockImplementation(async (id: string) => ({
        run: makeRun(id, status),
        steps: [makeStep()],
        attempts: [],
      }))

      await renderAt(`/runs/run-${status}`)

      expectStatusFavicon()
    },
  )

  it("restores the default favicon on unmount", async () => {
    fetchRunMock.mockImplementation(async (id: string) => ({
      run: makeRun(id, "failed"),
      steps: [makeStep()],
      attempts: [],
    }))

    await renderAt("/runs/run-failed")

    expectStatusFavicon()

    act(() => root!.unmount())
    root = null

    expectDefaultFavicon()
  })
})
