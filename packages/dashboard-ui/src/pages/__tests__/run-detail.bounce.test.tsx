// @vitest-environment jsdom

// RUN DETAIL'S BOUNCE-TO-LIVE PREDICATE (404-06 · LIFE-01, D-07 / T-404-15).
//
// WHAT THIS FILE MEASURES, AND WHY IT IS ITS OWN FILE. Run detail owns exactly one navigation
// decision: whether the run it was asked for belongs on the live surface instead. Until 404 that
// decision read `/api/execution/active` — the dashboard's set of executions in flight — and D-07
// retires that reading for a reason a unit cell can state precisely: an execution stays "active"
// until its post-run tail is done, and the tail runs AFTER the verdict. A viewer whom the live
// page had just moved here on the verdict (D-13) would be thrown straight back to `/live`, and the
// live page would move them here again on the very next render. That is T-404-15, and it is a
// ping-pong nobody can click their way out of.
//
// THE PREDICATE IS NOW THE ROW'S OWN STATUS, and the row is written by the dashboard subscriber's
// `updateRun` at the SAME `verdict` envelope the live page navigated on. Those two race by design.
// So the arrival carries one field of navigation state saying "I just watched the verdict land",
// and an arrival carrying it NEVER bounces — it renders the row it got and re-asks on a bounded
// cadence until the row reads terminal.
//
// EVERY CLOCK IS FAKE. The catch-up is 250 ms × 8; a cell that waited on a real one would be a
// two-second sleep whose failure mode is a flake that reads as a product defect.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunDetailPage from "@/pages/run-detail"
import { VERDICT_ROW_CATCH_UP_MAX, VERDICT_ROW_CATCH_UP_MS, routes } from "@/lib/routes"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = "r_bounce"

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchActiveExecutionsMock,
  fetchExecutionLogsMock,
  navigateMock,
} = vi.hoisted(() => ({
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchActiveExecutionsMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
  navigateMock: vi.fn(),
}))

// `fetchActiveExecutions` IS STILL EXPORTED BY THE MOCK, DELIBERATELY. The claim is that run
// detail no longer CALLS it — a mock that omitted it would make the same cells pass by making the
// import fail, which is a different fact wearing the same green.
vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  // 2026-08-28 (405-08): the page's second read. It is STUBBED TO RESOLVE, not left off the mock:
  // an omitted export is `undefined` at the call site, the page catches that and renders its
  // could-not-load posture, and every cell below would then pass while the page was in an error
  // state nobody asked for. The bounce must be measured on a page that loaded.
  fetchRunDetail: fetchRunDetailMock,
  // 2026-08-29 (406-01, D-04): the page's THIRD read — the failure view's. This whole-module
  // mock replaces `@/lib/api`, so an omitted export is `undefined` at the call site and every
  // cell here dies before it asserts. Its own behaviour is measured in `run-detail.analysis.test.tsx`.
  fetchRunAnalysis: () => Promise.resolve({ runId: '', verdicts: [], sentences: [], clusters: [] }),
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

// `useLocation` STAYS REAL — the navigation state under test is what the router hands the page,
// so doubling it would replace the contract these cells exist to bind. Only `useNavigate` is held,
// because "did not navigate" is a claim about a call that must not happen.
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router")
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div data-loading>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: ({ run }: { run: { status: string } }) => (
    <div data-testid="run-navbar" data-navbar-status={run.status}>navbar</div>
  ),
}))
vi.mock("@/components/run-detail/step-tree", () => ({ StepTree: () => <div data-testid="step-tree" /> }))
vi.mock("@/components/run-detail/tab-panels", () => ({ TabPanels: () => <div data-testid="tab-panels" /> }))
vi.mock("@/components/run-detail/artifact-drawer", () => ({ ArtifactDrawer: () => <div /> }))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: () => <span>view</span>,
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

/** A run row with only the fields this page reads on the path under test. */
function runRow(status: string) {
  return {
    id: RUN_ID,
    name: "a bounce probe",
    filePath: "tests/probe.test.yaml",
    status,
    duration: 1000,
    tags: null,
    environment: null,
    metadata: null,
    attributes: {},
    startedAt: "2026-08-26T00:00:00.000Z",
    endedAt: "2026-08-26T00:00:01.000Z",
    source: "cli",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
  }
}

const answers = (status: string) => ({ run: runRow(status), steps: [], tests: [], attempts: [] })

let observedPath = ""

function LocationProbe() {
  const location = useLocation()
  observedPath = location.pathname
  return null
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function unmountHost(): void {
  if (root === null) return
  const current = root
  const currentContainer = container
  root = null
  container = null
  act(() => { current.unmount() })
  currentContainer?.remove()
}

async function flushRender(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/**
 * Mount run detail at `/runs/:id`, optionally carrying the navigation state the live page writes.
 *
 * The entry is an OBJECT rather than a string precisely because `state` is the subject: a string
 * entry carries none, which is the "opened directly" arm several cells below need.
 */
async function renderAt(state?: unknown): Promise<void> {
  unmountHost()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const entry = state === undefined
    ? { pathname: routes.runDetail(RUN_ID) }
    : { pathname: routes.runDetail(RUN_ID), state }

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
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
}

beforeEach(() => {
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = vi.fn()
  observedPath = ""
  fetchRunMock.mockReset()
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  navigateMock.mockReset()

  fetchActiveExecutionsMock.mockResolvedValue({ executions: [] })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunDetailMock.mockResolvedValue({
    runId: RUN_ID,
    members: [],
    steps: [],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
  })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: RUN_ID }, artifact: null, children: [], missingSections: ["artifact"] })
})

afterEach(() => {
  unmountHost()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("the bounce keys on the run row, and never on the active-execution set", () => {
  it("a `running` row bounces to /live exactly once, with `replace`", async () => {
    fetchRunMock.mockResolvedValue(answers("running"))
    await renderAt()

    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith(routes.runLive(RUN_ID), { replace: true })
  })

  // ONE CELL PER TERMINAL WORD, not a loop over an array. A run that ended is the ordinary case
  // for this page, and `cancelled` in particular is the word the retired active-set predicate got
  // wrong most often: a cancelled run leaves the row terminal while its tail is still winding down.
  for (const word of ["passed", "failed", "cancelled"] as const) {
    it(`a \`${word}\` row does not navigate, and the page renders it`, async () => {
      fetchRunMock.mockResolvedValue(answers(word))
      await renderAt()

      expect(navigateMock, "a run that ended belongs here, not on the live surface").not.toHaveBeenCalled()
      expect(document.querySelector("[data-navbar-status]")?.getAttribute("data-navbar-status")).toBe(word)
      expect(observedPath).toBe(routes.runDetail(RUN_ID))
    })
  }

  it("never asks `/api/execution/active` — the retired predicate is gone, not merely unused", async () => {
    fetchRunMock.mockResolvedValue(answers("passed"))
    await renderAt()
    await advance(VERDICT_ROW_CATCH_UP_MS * (VERDICT_ROW_CATCH_UP_MAX + 2))

    expect(
      fetchActiveExecutionsMock.mock.calls.length,
      "the active set says a run is in flight until its POST-RUN TAIL ends (D-07) — reading it "
      + "here is what threw a viewer back to /live at the verdict",
    ).toBe(0)
  })
})

describe("an arrival that carries the verdict never bounces, and catches its row up", () => {
  it("a `running` row under `arrivedOnVerdict` does not navigate — the viewer just watched it end", async () => {
    fetchRunMock.mockResolvedValue(answers("running"))
    await renderAt({ arrivedOnVerdict: "passed" })

    expect(
      navigateMock,
      "the subscriber's `updateRun` at `verdict` and this page's `fetchRun` race BY DESIGN; the "
      + "fetch winning it is not evidence the run is live",
    ).not.toHaveBeenCalled()
    expect(document.querySelector("[data-navbar-status]")?.getAttribute("data-navbar-status")).toBe("running")
  })

  it("re-fetches at VERDICT_ROW_CATCH_UP_MS and stops the moment the row reads terminal", async () => {
    fetchRunMock
      .mockResolvedValueOnce(answers("running"))
      .mockResolvedValueOnce(answers("running"))
      .mockResolvedValue(answers("passed"))
    await renderAt({ arrivedOnVerdict: "passed" })
    expect(fetchRunMock).toHaveBeenCalledTimes(1)

    await advance(VERDICT_ROW_CATCH_UP_MS)
    await flushRender()
    expect(fetchRunMock).toHaveBeenCalledTimes(2)

    await advance(VERDICT_ROW_CATCH_UP_MS)
    await flushRender()
    expect(fetchRunMock).toHaveBeenCalledTimes(3)
    // The badge word FOLLOWS THE ROW, which is the whole reason to catch up rather than to shrug.
    expect(document.querySelector("[data-navbar-status]")?.getAttribute("data-navbar-status")).toBe("passed")

    // AND IT STOPS. A catch-up that kept polling a settled row would be a per-viewer poll loop on
    // every finished run the dashboard ever shows.
    const settled = fetchRunMock.mock.calls.length
    await advance(VERDICT_ROW_CATCH_UP_MS * 10)
    expect(fetchRunMock).toHaveBeenCalledTimes(settled)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("a row answering the verdict word FIRST costs exactly one fetch", async () => {
    fetchRunMock.mockResolvedValue(answers("passed"))
    await renderAt({ arrivedOnVerdict: "passed" })

    await advance(VERDICT_ROW_CATCH_UP_MS * 4)
    expect(fetchRunMock, "a row that already caught up needs no catch-up").toHaveBeenCalledTimes(1)
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("gives up after VERDICT_ROW_CATCH_UP_MAX consecutive `running` answers, stays put, and still never navigates", async () => {
    fetchRunMock.mockResolvedValue(answers("running"))
    await renderAt({ arrivedOnVerdict: "failed" })

    for (let i = 0; i < VERDICT_ROW_CATCH_UP_MAX + 4; i += 1) {
      await advance(VERDICT_ROW_CATCH_UP_MS)
      await flushRender()
    }

    expect(
      fetchRunMock.mock.calls.length,
      "the ceiling is the whole point: a row that has not caught up in two seconds has a different "
      + "problem, and spinning on it forever would be its own dishonesty",
    ).toBe(VERDICT_ROW_CATCH_UP_MAX + 1)
    expect(navigateMock).not.toHaveBeenCalled()
    expect(document.querySelector("[data-navbar-status]")?.getAttribute("data-navbar-status")).toBe("running")
    expect(observedPath).toBe(routes.runDetail(RUN_ID))
  })

  it("the catch-up timer is cleared on unmount — no fetch after the page is gone", async () => {
    fetchRunMock.mockResolvedValue(answers("running"))
    await renderAt({ arrivedOnVerdict: "passed" })
    const atUnmount = fetchRunMock.mock.calls.length

    unmountHost()
    await advance(VERDICT_ROW_CATCH_UP_MS * (VERDICT_ROW_CATCH_UP_MAX + 2))

    expect(fetchRunMock).toHaveBeenCalledTimes(atUnmount)
  })

  it("navigation state that is not the shape is read as `undefined`, so a genuinely running run still bounces", async () => {
    fetchRunMock.mockResolvedValue(answers("running"))
    // A crafted history entry, a stale state from another release, a bare string: none of them are
    // "I watched this verdict land", and none of them may buy the no-bounce exemption.
    await renderAt({ arrivedOnVerdict: "in-progress" })

    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith(routes.runLive(RUN_ID), { replace: true })
  })
})
