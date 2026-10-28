// @vitest-environment jsdom
//
// RUN DETAIL, READ AS ONE DURABLE PROJECTION (405-08 · DETL-01, D-16 / D-17 / D-18).
//
// WHAT THIS FILE REPLACED. `run-detail.suite-mode.test.tsx` pinned the parent/child walk: a suite
// parent whose `tests` array was walked with one `fetchRun` per child, a cumulative "step N of M"
// across those children, and a `?run=<childRunId>` param disambiguating step ordinals between
// them. 405-07 deleted the server side of that walk and 405-08 deletes the page side; the member
// grouping below is its successor on 402 D-10's handles, and the two cells worth keeping (the
// app-shell height contract and the page title) are carried over unchanged.
//
// THE PAGE MAKES EXACTLY TWO READS. `fetchRun` for the row — which is what the bounce keys on —
// and `fetchRunDetail` for everything under it. A cell that let the second one resolve from the
// first would be pinning a walk that no longer exists.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
  RunDetailSubAction,
} from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import RunDetailPage from "@/pages/run-detail"
import { DID_NOT_RUN_LABEL, RUN_DETAIL_UNAVAILABLE_LABEL } from "@/lib/run-detail-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
} = vi.hoisted(() => ({
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  // 2026-08-29 (406-01, D-04): the page's THIRD read — the failure view's. This whole-module
  // mock replaces `@/lib/api`, so an omitted export is `undefined` at the call site and every
  // cell here dies before it asserts. Its own behaviour is measured in `run-detail.analysis.test.tsx`.
  fetchRunAnalysis: () => Promise.resolve({ runId: '', verdicts: [], sentences: [], clusters: [] }),
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  // This whole-module mock REPLACES `@/lib/api`, so an omitted export is `undefined` at the call
  // site and every cell here dies before it asserts. The real `watchPostProcessing` constructs an
  // `EventSource` and a 3 s interval against a `fetch` these cells do not stub; its own behaviour
  // is measured in `run-detail.post-processing.test.tsx`.
  watchPostProcessing: () => () => {},
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
vi.mock("@/components/run-detail/tab-panels", () => ({
  TabPanels: ({ step }: { step: { id: string } | null }) => (
    <div data-testid="tab-panels" data-step-id={step?.id ?? ""} />
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
// The Select double keeps the OPTIONS addressable and the change handler real, so the cell that
// asserts the filter writes the URL exercises the page's own handler rather than a stand-in.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: {
    children: ReactNode
    value: string
    onValueChange: (next: string) => void
  }) => (
    <div data-testid="member-select" data-value={value}>
      <button type="button" data-select-change onClick={(e) => {
        onValueChange((e.currentTarget as HTMLButtonElement).getAttribute("data-next") ?? "")
      }} />
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>member filter</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-select-item={value}>{children}</div>
  ),
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
  Badge: ({ children, ...rest }: { children: ReactNode }) => <span {...rest}>{children}</span>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}))

function member(testIndex: number, extra: Partial<RunDetailMember> = {}): RunDetailMember {
  return { testIndex, attempts: 1, ...extra }
}

function step(testIndex: number, stepIndex: number, stepText: string): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    stepText,
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "looks right" },
    selfHealOccurred: false,
    briefDigest: `d${String(testIndex)}${String(stepIndex)}`,
    status: "passed",
    durationMs: 1000,
  }
}

function subAction(testIndex: number, stepIndex: number, subActionIndex: number): RunDetailSubAction {
  return {
    testIndex,
    stepIndex,
    subActionIndex,
    plan: `plan ${String(testIndex)}.${String(stepIndex)}.${String(subActionIndex)}`,
    plannedAction: { type: "click", ref: asRef("e1") },
    result: { success: true },
    screenStateHash: "abcdef0123456789".repeat(4),
  }
}

function projection(over: Partial<RunDetailProjection> = {}): RunDetailProjection {
  return {
    runId: "run-1",
    members: [],
    steps: [],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
    ...over,
  }
}

const TWO_MEMBERS = projection({
  members: [member(0, { name: "Login" }), member(1, { name: "Checkout" })],
  steps: [step(0, 0, "Open login"), step(0, 1, "Submit credentials"), step(1, 0, "Open cart")],
  subActions: [subAction(0, 0, 0)],
})

function runRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: "Suite run",
    filePath: "tests/suite.yaml",
    status: "failed",
    duration: 10000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:10.000Z",
    failureSummary: null,
    errorLog: null,
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
    ...over,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location" data-search={location.search} />
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
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchExecutionLogsMock.mockReset()

  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: "run-1" }, artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id) }))
  fetchRunDetailMock.mockResolvedValue(TWO_MEMBERS)
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

describe("the page reads ONE durable projection and groups it by member (D-16)", () => {
  it("renders one group per member, and asks for the run row and its detail exactly once each", async () => {
    const view = await renderAt("/runs/run-1")

    expect(fetchRunDetailMock).toHaveBeenCalledTimes(1)
    expect(fetchRunDetailMock).toHaveBeenCalledWith("run-1")
    expect(fetchRunMock).toHaveBeenCalledTimes(1)

    const members = [...view.querySelectorAll("[data-member]")]
    expect(members.map((el) => el.getAttribute("data-member"))).toEqual(["0", "1"])
    expect(view.textContent).toContain("Open login")
    expect(view.textContent).toContain("Open cart")
  })

  it("narrows the tree to one member when the URL names one", async () => {
    const view = await renderAt("/runs/run-1?member=1")

    expect([...view.querySelectorAll("[data-member]")].map((el) => el.getAttribute("data-member"))).toEqual(["1"])
    expect(view.textContent).toContain("Open cart")
    expect(view.textContent).not.toContain("Open login")
    // The whole-run picker stays, because the viewer is still looking at a suite.
    expect(view.querySelector('[data-select-item="all"]')).toBeTruthy()
  })

  it("writes the chosen handle into the URL rather than into a second copy of the state", async () => {
    const view = await renderAt("/runs/run-1")
    const changer = view.querySelector("[data-select-change]") as HTMLButtonElement

    changer.setAttribute("data-next", "0")
    await act(async () => {
      changer.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toContain("member=0")
    expect([...view.querySelectorAll("[data-member]")].map((el) => el.getAttribute("data-member"))).toEqual(["0"])
  })

  it("selects a step by its member-scoped key and round-trips it through `?step=`", async () => {
    const view = await renderAt("/runs/run-1?step=1:0")

    expect(view.querySelector('[data-testid="tab-panels"]')?.getAttribute("data-step-id")).toBe("1:0")
    expect(new URLSearchParams(view.querySelector('[data-testid="location"]')?.getAttribute('data-search') ?? '').get('step')).toBe('1:0')
  })

  it("falls back to the first visible step for a key that names nothing, and never throws", async () => {
    const view = await renderAt("/runs/run-1?step=nonsense")

    expect(view.querySelector('[data-testid="tab-panels"]')?.getAttribute("data-step-id")).toBe("0:0")
  })
})

describe("a single-member run shows no grouping chrome (D-16)", () => {
  it("renders its steps with no member header and no filter", async () => {
    fetchRunDetailMock.mockResolvedValue(
      projection({
        members: [member(0, { name: "Solo" })],
        steps: [step(0, 0, "Open login")],
      }),
    )

    const view = await renderAt("/runs/run-1")

    expect(view.querySelector("[data-member]")).toBeNull()
    expect(view.querySelector('[data-testid="member-select"]')).toBeNull()
    expect(view.textContent).toContain("Open login")
  })
})

describe("a member that never ran renders honestly (D-18)", () => {
  it("shows the did-not-run note and the producer's own summary instead of an empty tree", async () => {
    fetchRunDetailMock.mockResolvedValue(
      projection({
        members: [
          member(0, { name: "Login" }),
          member(1, { name: "Checkout", outcome: "skipped", failureSummary: "skipped by fail-fast" }),
        ],
        steps: [step(0, 0, "Open login")],
      }),
    )

    const view = await renderAt("/runs/run-1")

    expect(view.textContent).toContain(DID_NOT_RUN_LABEL)
    expect(view.textContent).toContain("skipped by fail-fast")
    expect(view.querySelector('[data-member-outcome="skipped"]')).toBeTruthy()
  })
})

describe("a detail read that FAILED is not an empty run (D-03)", () => {
  it("renders an error posture distinct from the empty state, and does not navigate away", async () => {
    fetchRunDetailMock.mockRejectedValue(new Error("500 Internal Server Error"))

    const view = await renderAt("/runs/run-1")

    expect(view.textContent).toContain(RUN_DETAIL_UNAVAILABLE_LABEL)
    expect(view.textContent).not.toContain("No steps were executed.")
    expect(view.querySelector('[data-testid="run-navbar"]')).toBeTruthy()
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("")
  })

  it("says nothing was executed — not that the read failed — for a run that recorded nothing", async () => {
    fetchRunDetailMock.mockResolvedValue(projection())

    const view = await renderAt("/runs/run-1")

    expect(view.textContent).toContain("No steps were executed.")
    expect(view.textContent).not.toContain(RUN_DETAIL_UNAVAILABLE_LABEL)
  })
})

describe("carried over from the retired suite-mode cells", () => {
  it("uses the app-shell-safe height contract instead of h-screen", async () => {
    const view = await renderAt("/runs/run-1")
    const rootSurface = view.querySelector('[data-testid="run-navbar"]')?.parentElement as HTMLDivElement | null

    expect(rootSurface?.className).toContain("h-full")
    expect(rootSurface?.className).toContain("min-h-0")
    expect(rootSurface?.className).toContain("overflow-hidden")
    expect(rootSurface?.className).not.toContain("h-screen")
  })

  it("sets the page title without exposing the run id", async () => {
    await renderAt("/runs/run-1")

    expect(document.title).toBe("Run - Suite run")
    expect(document.title).not.toContain("run-1")
  })

  it("shows a failed run's summary on the durable page", async () => {
    fetchRunMock.mockImplementation(async (id: string) => ({
      run: runRow(id, { failureSummary: "Timed out waiting for google/gemma-4-e4b" }),
    }))

    const view = await renderAt("/runs/run-1")

    expect(view.textContent).toContain("Timed out waiting for google/gemma-4-e4b")
  })
})
