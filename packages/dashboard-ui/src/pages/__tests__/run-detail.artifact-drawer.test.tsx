// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RunDetailProjection } from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import { displayStepsForGroups } from "@/lib/display-step"
import type { RunDetailGroup } from "@/lib/run-detail-view"

import RunDetailPage from "@/pages/run-detail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchRunAnalysisMock,
  fetchActiveExecutionsMock,
  fetchExecutionLogsMock,
  useKeyboardShortcutsMock,
  latestShortcuts,
} = vi.hoisted(() => {
  let latest: Record<string, (event: KeyboardEvent) => void> | null = null
  return {
    fetchRunMock: vi.fn(),
    fetchRunDetailMock: vi.fn(),
    fetchRunArtifactMock: vi.fn(),
    fetchRunAnalysisMock: vi.fn(),
    fetchActiveExecutionsMock: vi.fn(),
    fetchExecutionLogsMock: vi.fn(),
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
  // 405-08: the page reads its steps and sub-actions from `runs.detail`, not from the run row.
  // A whole-module mock that omitted this export would leave it `undefined` at the call site, and
  // the page would render its could-not-load posture — these cells would then pass while pinning
  // nothing about the drawer.
  fetchRunDetail: fetchRunDetailMock,
  // 2026-08-29 (406-01, D-04): the page's THIRD read — the failure view's. This whole-module
  // mock replaces `@/lib/api`, so an omitted export is `undefined` at the call site and every
  // cell here dies before it asserts. Its own behaviour is measured in `run-detail.analysis.test.tsx`.
  // 2026-08-29 (406-08): now a MOCK rather than a constant double, because one cell here drives a
  // cited artifact off a real verdict and through the page's `onCitedArtifact` wiring.
  fetchRunAnalysis: fetchRunAnalysisMock,
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchActiveExecutions: fetchActiveExecutionsMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  // 2026-08-27 (404-07): run detail now subscribes a post-processing chip client on mount. This
  // whole-module mock REPLACES `@/lib/api`, so an omitted export is `undefined` at the call site
  // and every cell in this file dies before it asserts. It is a no-op DOUBLE rather than the real
  // function on purpose: the real one constructs an `EventSource` and a 3 s interval against a
  // `fetch` these cells do not stub, which is a socket and a poll inside a test about something
  // else. The client's own behaviour is measured in `run-detail.post-processing.test.tsx`.
  watchPostProcessing: () => () => {},
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
  RunNavbar: ({ onOpenArtifacts }: { onOpenArtifacts: (tab: "test" | "config") => void }) => (
    <button type="button" data-testid="navbar-artifacts" onClick={() => onOpenArtifacts("test")}>
      navbar artifacts
    </button>
  ),
}))

vi.mock("@/components/run-detail/artifact-drawer", () => ({
  ArtifactDrawer: ({
    open,
    tab,
    screenshotSha,
    response,
    loading,
    error,
    onOpenChange,
    onTabChange,
    onRetry,
  }: {
    open: boolean
    tab: "test" | "config" | "screenshot"
    screenshotSha: string | null
    response: { artifact: unknown; run?: { attributes?: Record<string, string> } } | null
    loading: boolean
    error: string | null
    onOpenChange: (open: boolean) => void
    onTabChange: (tab: "test" | "config" | "screenshot") => void
    onRetry: () => void
  }) => {
    if (!open) return null
    return (
      <div
        data-testid="artifact-drawer"
        data-tab={tab}
        data-screenshot-sha={screenshotSha ?? ""}
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
        <div>Test Config</div>
        {tab === "test" && response?.run?.attributes ? (
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
        <button type="button" data-testid="drawer-test" onClick={() => onTabChange("test")}>test</button>
        <button type="button" data-testid="drawer-config" onClick={() => onTabChange("config")}>config</button>
      </div>
    )
  },
}))

vi.mock("@/components/run-detail/step-tree", () => ({
  // 405-08: the tree takes the member-grouped projection now, not a flat step list. The double
  // flattens it through the SAME helper the page uses, so the ids it renders are the ids the page
  // selects by — a second flattening here would let this file pass on keys nobody can click.
  StepTree: ({
    groups,
    selection,
    analysisView,
    onCitedArtifact,
  }: {
    groups: readonly RunDetailGroup[]
    selection: { type: string; stepId?: string; subIndex?: number } | null
    // 406-08: the double renders the cited-artifact affordance the real tree renders through
    // `MemberGroup` → `VerdictBlock`, because the claim under test here is the PAGE's wiring
    // (`onCitedArtifact` → the drawer on a sha-keyed screenshot tab). The block's own view→markup
    // mapping is pinned in `components/run-detail/__tests__/verdict-block.test.tsx`.
    analysisView?: ReadonlyMap<number, { citedArtifacts: readonly { sha: string; incomplete: boolean }[] }>
    onCitedArtifact?: (sha: string) => void
  }) => {
    const selectionLabel = selection
      ? `${selection.type}:${selection.stepId ?? ""}:${selection.subIndex ?? ""}`
      : ""
    return (
      <div data-testid="step-tree" data-selection={selectionLabel}>
        {displayStepsForGroups(groups).map((step) => (
          <div key={step.id} data-step-id={step.id}>
            {step.name}
          </div>
        ))}
        {[...(analysisView?.values() ?? [])].flatMap((view) =>
          view.citedArtifacts
            .filter((ref) => !ref.incomplete)
            .map((ref) => (
              <button
                key={ref.sha}
                type="button"
                data-cited-artifact={ref.sha}
                onClick={() => onCitedArtifact?.(ref.sha)}
              >
                screenshot
              </button>
            )),
        )}
      </div>
    )
  },
}))

vi.mock("@/components/run-detail/tab-panels", () => ({
  // The double carries `activeTab` so a shortcut cell can read the tab the PAGE handed down,
  // rather than inferring it from the URL the page also writes (407-02 · D-01/D-02).
  TabPanels: ({ activeTab }: { activeTab: string }) => (
    <div data-testid="tab-panels" data-active-tab={activeTab} />
  ),
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
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

function makeProjection(runId: string): RunDetailProjection {
  return {
    runId,
    members: [{ testIndex: 0, name: "Artifact test", attempts: 1 }],
    steps: [
      {
        testIndex: 0,
        stepIndex: 0,
        stepText: "Inspect artifact behavior",
        cacheStatus: "miss",
        verifierVerdict: { pass: true, reasoning: "the artifact panel is open" },
        selfHealOccurred: false,
        briefDigest: "d00",
        status: "passed",
        durationMs: 1000,
      },
    ],
    subActions: [
      {
        testIndex: 0,
        stepIndex: 0,
        subActionIndex: 0,
        plan: "Need to inspect artifacts",
        plannedAction: { type: "click", ref: asRef("checkout") },
        result: { success: true },
        screenStateHash: "abcdef0123456789".repeat(4),
      },
    ],
    tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
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
    failureSummary: null,
    errorLog: null,
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

/** A verdict citing ONE present artifact — the smallest shape the page's wiring needs (406-08). */
const CITED_SHA = "d".repeat(64)

function analysisCiting(sha: string) {
  return {
    runId: "run-1",
    verdicts: [
      {
        perTest: 0,
        testId: "t_artifact",
        class: "unknown" as const,
        producer: "deterministic-classifier" as const,
        confidence: 0,
        evidence: { citedSteps: [], citedArtifacts: [{ id: "art_0", sha, present: true }] },
      },
    ],
    sentences: [{ perTest: 0, testId: "t_artifact", sentence: "observed (step 0): nothing" }],
    clusters: [],
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
    <button type="button" data-testid="navigate-run-2" onClick={() => navigate("/runs/run-2?step=0:0&sub=0")}>
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
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchRunAnalysisMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  useKeyboardShortcutsMock.mockClear()

  fetchActiveExecutionsMock.mockResolvedValue({ executions: [] })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunAnalysisMock.mockResolvedValue({ runId: "", verdicts: [], sentences: [], clusters: [] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: makeRun(id) }))
  fetchRunDetailMock.mockImplementation(async (id: string) => makeProjection(id))
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
  it("DRAWER-SHORTCUT-I-OPENS-TEST", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")
    await act(async () => latestShortcuts().i(new KeyboardEvent("keydown", { key: "i" })))
    await flushRender()
    expect(view.querySelector('[data-testid="artifact-drawer"]')?.getAttribute('data-tab')).toBe('test')
    await act(async () => latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" })))
    await flushRender()
    expect(view.querySelector('[data-testid="artifact-drawer"]')?.getAttribute('data-tab')).toBe('config')
  })

  it("opens Test with I and renders run attributes", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    await act(async () => {
      latestShortcuts().i(new KeyboardEvent("keydown", { key: "i" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("test")
    expect(drawer.textContent).toContain("Test")
    expect(drawer.textContent).toContain("Config")
    expect(drawer.textContent).not.toContain("Memory")
    expect(drawer.textContent).toContain("agent-qa.trigger")
    expect(drawer.textContent).toContain("agent-qa.runner")
    expect(drawer.textContent).toContain("git.branch")
    expect(drawer.textContent).toContain("Copy JSON")
    expect(drawer.querySelector('[aria-label="Copy git.branch value"]')).not.toBeNull()
  })

  it("opens Config with C without changing URL params or selected sub-action", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0&tab=network")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().c(new KeyboardEvent("keydown", { key: "c" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("config")
    expect(fetchRunArtifactMock).toHaveBeenCalledWith("run-1")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
    expect(searchParams(view).get("step")).toBe("0:0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("run")).toBeNull()
    expect(searchParams(view).get("tab")).toBe("network")
  })

  // M NO LONGER OPENS A DRAWER (407-02 · D-02). The v1 memory drawer tab it used to open is dead
  // debris 407-05 deletes grep-clean; the key is re-pointed at the Knowledge tab HERE so it is
  // never dead for the length of a plan. The cell asserts BOTH halves of that: the tab the page
  // hands down moved, and no drawer opened — a shortcut that quietly did both would be two
  // surfaces answering one keypress.
  it("opens the Knowledge tab with M and keeps navigation state stable (D-02)", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().m(new KeyboardEvent("keydown", { key: "m" }))
    })
    await flushRender()

    expect(view.querySelector('[data-testid="artifact-drawer"]')).toBeNull()
    expect(view.querySelector('[data-testid="tab-panels"]')?.getAttribute("data-active-tab")).toBe("knowledge")
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
    expect(searchParams(view).get("step")).toBe("0:0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("run")).toBeNull()
    expect(searchParams(view).get("tab")).toBe("knowledge")
  })

  // The number key and the letter key reach the SAME tab — the legend promises both, and a
  // seventh trigger nobody can reach by number would be the one tab that broke the pattern.
  it("opens the Knowledge tab with 7 as well (D-01)", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    await act(async () => {
      latestShortcuts()["7"](new KeyboardEvent("keydown", { key: "7" }))
    })
    await flushRender()

    expect(view.querySelector('[data-testid="tab-panels"]')?.getAttribute("data-active-tab")).toBe("knowledge")
    expect(searchParams(view).get("tab")).toBe("knowledge")
  })

  it("closes the drawer on first Escape before clearing selection", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")
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
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
    expect(searchParams(view).get("step")).toBe("0:0")
    expect(searchParams(view).get("sub")).toBe("0")
  })

  it("opens from the navbar action on Test", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    await act(async () => {
      ;(view.querySelector('[data-testid="navbar-artifacts"]') as HTMLButtonElement).click()
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.getAttribute("data-tab")).toBe("test")
    expect(fetchRunArtifactMock).toHaveBeenCalledWith("run-1")
  })

  it("keeps the drawer open on fetch error and retries the current run", async () => {
    fetchRunArtifactMock
      .mockRejectedValueOnce(new Error("server down"))
      .mockResolvedValueOnce(makeArtifactResponse("run-1"))
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

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
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

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
    const view = await renderAt("/runs/run-1?step=0:0&sub=0&tab=network")
    const stepTree = view.querySelector('[data-testid="step-tree"]') as HTMLElement

    await act(async () => {
      latestShortcuts().i(new KeyboardEvent("keydown", { key: "i" }))
    })
    await flushRender()

    await act(async () => {
      ;(view.querySelector('[data-testid="drawer-config"]') as HTMLButtonElement).click()
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer.getAttribute("data-tab")).toBe("config")
    expect(fetchRunArtifactMock).toHaveBeenCalledTimes(1)
    expect(stepTree.getAttribute("data-selection")).toBe("subaction:0:0:0")
    expect(searchParams(view).get("step")).toBe("0:0")
    expect(searchParams(view).get("sub")).toBe("0")
    expect(searchParams(view).get("tab")).toBe("network")
  })

  it("opens the lightbox for an orphan cited artifact without opening the drawer (D-02)", async () => {
    fetchRunAnalysisMock.mockResolvedValue(analysisCiting(CITED_SHA))
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    expect(view.querySelector('[data-testid="artifact-drawer"]'), "closed until the click").toBeNull()

    await act(async () => {
      ;(view.querySelector(`[data-cited-artifact="${CITED_SHA}"]`) as HTMLButtonElement).click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="artifact-drawer"]')).toBeNull()
    expect(document.querySelector('[data-player-lightbox]')).not.toBeNull()
    expect(searchParams(view).get("step"), "opening evidence navigates nowhere").toBe("0:0")
  })

  it("leaves the I/C/M shortcuts exactly as they were — they carry no sha", async () => {
    fetchRunAnalysisMock.mockResolvedValue(analysisCiting(CITED_SHA))
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

    await act(async () => {
      ;(view.querySelector(`[data-cited-artifact="${CITED_SHA}"]`) as HTMLButtonElement).click()
    })
    await flushRender()

    await act(async () => {
      latestShortcuts().i(new KeyboardEvent("keydown", { key: "i" }))
    })
    await flushRender()

    const drawer = view.querySelector('[data-testid="artifact-drawer"]') as HTMLElement
    expect(drawer.getAttribute("data-tab")).toBe("test")
    expect(
      drawer.getAttribute("data-screenshot-sha"),
      "the three v1 tabs open with no artifact in hand, exactly as before",
    ).toBe("")
  })

  it("resets artifact state and fetches again when a different run is rendered", async () => {
    const view = await renderAt("/runs/run-1?step=0:0&sub=0")

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
    expect(searchParams(view).get("step")).toBe("0:0")
    expect(searchParams(view).get("sub")).toBe("0")
  })
})
