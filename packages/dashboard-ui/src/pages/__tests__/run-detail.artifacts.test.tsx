// @vitest-environment jsdom

// THE FIVE FACTS, THROUGH THE WHOLE PAGE (405-11 · DETL-01/02/03, D-06, D-10, D-14, D-15,
// RESEARCH D2).
//
// Criterion 1 of this phase says reasoning, the sub-action timeline, screenshots, token usage and
// screen context "render populated". These cells are the last unit-level statement of that before
// 405-12 measures it in a real browser: they mount the PAGE, hand it one durable projection, and
// assert each of the five facts arrives at the DOM from the read rather than from a default.
//
// EVERY COPY ASSERTION IS BY CONSTANT and every URL assertion CALLS the minter. A literal sentence
// here would keep passing while the page said something else, and a literal URL would keep passing
// while the page minted a different one.

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RunDetailProjection } from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import { displayStepsForGroups } from "@/lib/display-step"
import type { RunDetailGroup } from "@/lib/run-detail-view"
import {
  EVIDENCE_INCOMPLETE_LABEL,
  TOKENS_NOT_MEASURED_LABEL,
  tokenPairLine,
} from "@/lib/run-detail-view"
import { routes } from "@/lib/routes"

import RunDetailPage from "@/pages/run-detail"

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
  // the page's THIRD read — the failure view's. This whole-module
  // mock replaces `@/lib/api`, so an omitted export is `undefined` at the call site and every
  // cell here dies before it asserts. Its own behaviour is measured in `run-detail.analysis.test.tsx`.
  fetchRunAnalysis: () => Promise.resolve({ runId: '', verdicts: [], sentences: [], clusters: [] }),
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  watchPostProcessing: () => () => {},
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({ EmptyState: ({ title }: { title: string }) => <div>{title}</div> }))

// The navbar is the run-level token line's home, so it is NOT mocked away — cell 5 reads it.
vi.mock("@/components/run-detail/step-tree", () => ({
  StepTree: ({ groups }: { groups: readonly RunDetailGroup[] }) => (
    <div data-testid="step-tree">
      {displayStepsForGroups(groups).map((step) => (
        <div key={step.id} data-step-id={step.id}>{step.name}</div>
      ))}
    </div>
  ),
}))

vi.mock("@/components/screenshot-viewer", () => ({
  ScreenshotViewer: ({ src, onUnavailable }: { src: string; onUnavailable?: () => void }) => (
    <img data-testid="screenshot-viewer" src={src} onError={() => onUnavailable?.()} />
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
  Button: ({ children, ...props }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

const SHA = "a1b2c3d4".repeat(8)
const HASH_BEFORE = "1".repeat(64)
const HASH_AFTER = "2".repeat(64)

/** The planner's own sentence as stored: an undeclared email and a declared value's marker. */
const STORED_PLAN = "Sign in as qa-person@example.com using [secret:PW]"

function makeProjection(overrides: Partial<RunDetailProjection> = {}): RunDetailProjection {
  return {
    runId: "run-1",
    members: [{ testIndex: 0, name: "Checkout", attempts: 1 }],
    steps: [
      {
        testIndex: 0,
        stepIndex: 0,
        stepText: "Sign in",
        cacheStatus: "miss",
        verifierVerdict: { pass: true, reasoning: "signed in" },
        selfHealOccurred: false,
        briefDigest: "d00",
        status: "passed",
        durationMs: 1200,
        tokenUsage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000 },
      },
    ],
    subActions: [
      {
        testIndex: 0,
        stepIndex: 0,
        subActionIndex: 0,
        plan: STORED_PLAN,
        plannedAction: { type: "click", ref: asRef("submit") },
        result: { success: true },
        screenStateHash: HASH_BEFORE,
        screenStateHashAfter: HASH_AFTER,
        artifactRefs: [{ id: `decision-screenshot:${SHA}`, sha: SHA }],
      },
    ],
    tokens: {
      measuredSteps: 1,
      unmeasuredSteps: 0,
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
    },
    ...overrides,
  }
}

function makeRun() {
  return {
    id: "run-1",
    name: "Checkout run",
    filePath: "tests/checkout.yaml",
    status: "passed",
    duration: 1200,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:01.200Z",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
  }
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

async function renderAt(url = "/runs/run-1?step=0:0&sub=0") {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

beforeEach(() => {
  fetchRunMock.mockReset()
  fetchRunDetailMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchExecutionLogsMock.mockReset()

  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: makeRun(), artifact: null, children: [], missingSections: [] })
  fetchRunMock.mockImplementation(async () => ({ run: makeRun() }))
  fetchRunDetailMock.mockImplementation(async () => makeProjection())
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe("run detail renders the durable projection's five facts", () => {
  it("mints the decision screenshot src from the ref and marks the pane available", async () => {
    const view = await renderAt()

    expect(view.querySelector('[data-artifact-state="available"]')).not.toBeNull()
    expect(view.querySelector("img")?.getAttribute("src")).toBe(routes.runArtifact("run-1", SHA))
  })

  it("renders a visible unavailable state, and no image, for a ref flagged incomplete", async () => {
    const base = makeProjection()
    fetchRunDetailMock.mockImplementation(async () => ({
      ...base,
      subActions: [{ ...base.subActions[0], artifactRefs: [{ id: `decision-screenshot:${SHA}`, sha: SHA, evidenceIncomplete: true }] }],
    }))

    const view = await renderAt()

    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(view.querySelector("img")).toBeNull()
  })

  // 406-05 · D-17 / D-18, T-406-16. THREE ABSENCES ON ONE PAGE, AND ONLY ONE OF THEM IS TRUE HERE.
  // The read stat'd the store and found the bytes gone, so the page says so in the evidence
  // vocabulary — and in NEITHER of the other two. A masked chip here would tell the reader a value
  // was withheld on purpose and could be restored with a config change; the read-unavailable state
  // would tell them to retry a read that in fact succeeded. Both are actions taken on a false
  // belief, which is why the distinctness is a cell rather than a convention.
  it("says the bytes are gone in one vocabulary, and not in the other two", async () => {
    const base = makeProjection()
    fetchRunDetailMock.mockImplementation(async () => ({
      ...base,
      subActions: [
        {
          ...base.subActions[0],
          plan: "Sign in",
          artifactRefs: [{ id: `decision-screenshot:${SHA}`, sha: SHA, present: false }],
        },
      ],
    }))

    const view = await renderAt()

    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(view.querySelector("img")).toBeNull()
    expect(view.querySelector("[data-masked]")).toBeNull()
    expect(view.querySelector("[data-run-detail-error]")).toBeNull()
  })

  // the planner's stored sentence is shown as written, and nothing paints a chip over it.
  it("shows the planner's stored sentence as written, with no chip", async () => {
    const view = await renderAt()

    expect(view.querySelector("[data-sub-action-plan]")?.textContent).toBe(STORED_PLAN)
    expect(view.querySelector("[data-masked]")).toBeNull()
  })

  // Owner correction, 2026-09-21: Overview omits redundant hash/state rows.
  it("omits screen-state metadata for both changed and unchanged recorded states", async () => {
    for (const after of [HASH_BEFORE, HASH_AFTER]) {
      const base = makeProjection()
      fetchRunDetailMock.mockImplementation(async () => ({ ...base,
        subActions: [{ ...base.subActions[0], screenStateHashAfter: after }],
      }))
      const view = await renderAt()
      expect(view.querySelector("[data-screen-state], [data-screen-state-change]")).toBeNull()
      expect(view.querySelector("[data-overview]")?.textContent).not.toContain(HASH_BEFORE)
    }
  })

  // D-06 accounting remains in the navbar. A measured run reports its spend; an unmeasured one
  // says so rather than reporting a zero nobody measured.
  //
  // the header sentence is now the labelled PAIR, and coverage left it
  // entirely — the undercount caveat lives in the usage card behind the line. The claim this cell
  // makes is unchanged: the page's one token accounting is in the header, not in Overview.
  it("keeps run accounting while omitting the redundant Overview token line", async () => {
    const view = await renderAt()

    expect(view.querySelector("[data-token-summary]")).toBeNull()
    const line = view.querySelector("[data-run-token-summary]")
    expect(line?.textContent).toContain(
      tokenPairLine({
        measuredSteps: 1,
        unmeasuredSteps: 0,
        promptTokens: 800,
        completionTokens: 200,
        totalTokens: 1000,
      }),
    )
    expect(line?.textContent).not.toMatch(/of \d+ steps/)
  })

  it("never reports a zero for a step or a run nobody measured", async () => {
    const base = makeProjection()
    const { tokenUsage: _dropped, ...unmeasuredStep } = base.steps[0]
    fetchRunDetailMock.mockImplementation(async () => ({
      ...base,
      steps: [unmeasuredStep],
      tokens: { measuredSteps: 0, unmeasuredSteps: 1 },
    }))

    const view = await renderAt()

    expect(view.querySelector("[data-token-summary]")).toBeNull()
    expect(view.querySelector("[data-run-token-summary]")?.textContent).toContain(TOKENS_NOT_MEASURED_LABEL)
  })
})
