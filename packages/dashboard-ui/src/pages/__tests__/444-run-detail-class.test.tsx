// @vitest-environment jsdom
//
// C444-RUN-DETAIL-CLASS (444-16, D-49): the run detail page reads a failed run through the one
// classifier, so a `timeout` run shows its failure summary, error details and verdict link as a
// `failed` run does, and a `passed` run shows none of them.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnalysisGetOutput, RunDetailProjection } from "@vostride/agent-qa-schema"

import RunDetailPage from "@/pages/run-detail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = "r_run_detail_class"
const SUMMARY = "Step 2 never saw the confirmation banner."
const ERROR_LOG = "TimeoutError: waited 30000ms for the confirmation banner"

const { fetchRunMock } = vi.hoisted(() => ({ fetchRunMock: vi.fn() }))

const ANALYSIS: AnalysisGetOutput = {
  runId: RUN_ID,
  verdicts: [
    { perTest: 0, testId: "t_checkout", class: "unknown", producer: "deterministic-classifier", confidence: 0 },
  ],
  sentences: [{ perTest: 0, testId: "t_checkout", sentence: "The run stopped at step 2." }],
  clusters: [],
}

const DETAIL: RunDetailProjection = {
  runId: RUN_ID,
  members: [{ testIndex: 0, attempts: 1, name: "Checkout", outcome: "failed" }],
  steps: [],
  subActions: [],
  tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
}

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunDetail: () => Promise.resolve(DETAIL),
  fetchRunAnalysis: () => Promise.resolve(ANALYSIS),
  fetchRunKnowledge: () => Promise.resolve({ kind: "evidence-incomplete", runId: RUN_ID }),
  fetchRunArtifact: vi.fn(),
  fetchExecutionLogs: () => Promise.resolve({ logs: [] }),
  fetchRunEvidence: () => Promise.resolve({ kind: "failed", error: "not configured" }),
  triggerRun: vi.fn(),
  markRun: vi.fn(),
  watchPostProcessing: () => () => {},
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: ({ onOpenVerdict }: { onOpenVerdict?: () => void }) => (
    <div data-testid="run-navbar" data-verdict-door={onOpenVerdict === undefined ? "none" : "open"} />
  ),
}))
vi.mock("@/components/run-detail/tab-panels", () => ({ TabPanels: () => <div data-testid="tab-panels" /> }))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div data-testid="collapsible">{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

function runRow(status: string) {
  return {
    id: RUN_ID,
    name: "Checkout run",
    filePath: "tests/checkout.yaml",
    status,
    duration: 30000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-10-17T09:00:00.000Z",
    endedAt: "2026-10-17T09:00:30.000Z",
    failureSummary: SUMMARY,
    errorLog: ERROR_LOG,
    testId: "t_checkout",
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-10-17T09:00:00.000Z",
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderRun(status: string) {
  fetchRunMock.mockResolvedValue({ run: runRow(status) })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
  const view = container
  expect(view.querySelector('[data-testid="run-navbar"]'), `the ${status} run's page`).not.toBeNull()
  return {
    summary: (view.textContent ?? "").includes(SUMMARY),
    errorDetails: (view.textContent ?? "").includes("Error Details") && (view.textContent ?? "").includes(ERROR_LOG),
    verdictDoor: view.querySelector('[data-testid="run-navbar"]')?.getAttribute("data-verdict-door"),
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  fetchRunMock.mockReset()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

describe("C444-RUN-DETAIL-CLASS", () => {
  it("a timed-out run shows its failure summary, error details and verdict link", async () => {
    expect(await renderRun("timeout")).toEqual({ summary: true, errorDetails: true, verdictDoor: "open" })
  })

  it("a failed run still shows its failure summary, error details and verdict link", async () => {
    expect(await renderRun("failed")).toEqual({ summary: true, errorDetails: true, verdictDoor: "open" })
  })

  it("a passed run shows none of them", async () => {
    expect(await renderRun("passed")).toEqual({ summary: false, errorDetails: false, verdictDoor: "none" })
  })
})
