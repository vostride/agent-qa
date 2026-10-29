// @vitest-environment jsdom

// WHO OWNS THE CHIP CLIENT.
//
// THE NAVBAR IS PRESENTATIONAL. It takes a view and paints it; it opens no socket, holds no timer
// and knows no run id. The page owns the client, and this file is where that ownership is measured
// rather than asserted — `watchPostProcessing` is held, and the cells count its calls, invoke its
// disposer and read what the navbar was handed. A header that fetched for itself would still paint
// correctly in a component test and would open one client per mount of a component that remounts.
//
// THIS IS ITS OWN FILE ON PURPOSE. 404-06's `run-detail.bounce.test.tsx` measures the page's ONE
// navigation decision and mocks the navbar down to a status probe; folding these cells into it
// would have made that file answer two questions and made this plan edit that plan's subject.
//
// THE PROJECTION IS REAL, NOT MOCKED. `projectPostProcessingView` is pure and total, so doubling it
// would replace the very contract that "the navbar gets the projection of the last read, and
// nothing else" is about.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunDetailPage from "@/pages/run-detail"
import { routes } from "@/lib/routes"
import {
  ANALYSIS_COMPLETE_NO_ISSUES_TEXT,
  FAILED_REASON_ABSENT_TEXT,
  PENDING_POSTURE_TEXT,
  STAGE_INDICATOR_WORDS,
  STAGE_SKIPPED_TEXT,
} from "@/lib/post-processing-view"
import type { PostProcessingRead } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = "r_chips"
const OTHER_RUN_ID = "r_chips_two"

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
  fetchRunAnalysisMock,
  watchPostProcessingMock,
  disposeMock,
  navbarProps,
  stepTreeProps,
  tabPanelProps,
  treeScene,
} = vi.hoisted(() => ({
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
  fetchRunAnalysisMock: vi.fn(),
  watchPostProcessingMock: vi.fn(),
  disposeMock: vi.fn(),
  navbarProps: [] as Array<{
    postProcessing: unknown
    hasPostProcessing: unknown
    models: unknown
    onOpenVerdict: unknown
  }>,
  // WHAT THE TREE BELOW THE HEADER WAS HANDED, render by render. The door must move
  // scroll and focus and NOTHING else, and "nothing else" is only observable as props that did
  // not change — so the probes record rather than assert.
  stepTreeProps: [] as Array<{ playhead: unknown; selection: unknown }>,
  tabPanelProps: [] as Array<{ activeTab: unknown }>,
  /**
   * How many verdict blocks and collapsed member groups the mocked tree mounts this render, and
   * whether the two OTHER `aria-expanded` emitters of the real scroll container (the member-filter
   * trigger and the Error Details disclosure) are mounted ahead of the groups.
   * `verdictGroup` is the one collapsed group whose toggle carries the verdict-bearing contract
   * attribute the real `MemberGroup` writes; unset, every group renders alike.
   */
  treeScene: { blocks: 0, collapsedGroups: 0, trap: false, verdictGroup: undefined as number | undefined },
}))

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    fetchRun: fetchRunMock,
    // the page's second read, stubbed to RESOLVE. Left unstubbed it would hit
    // the real one against a `fetch` these cells do not provide, and the page would sit in its
    // could-not-load posture while the chip client under test was measured on a broken screen.
    fetchRunDetail: fetchRunDetailMock,
    // the page's third read, stubbed to RESOLVE for the same reason —
    // the real one would reach a `fetch` these cells do not provide.
    // held rather than inlined, because the verdict door is gated on the
    // page's own `analysisView` being non-empty — a fixed empty answer could only ever prove the
    // closed half of that gate.
    fetchRunAnalysis: fetchRunAnalysisMock,
    fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
    fetchRunArtifact: fetchRunArtifactMock,
    fetchExecutionLogs: fetchExecutionLogsMock,
    fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
    fetchActiveExecutions: vi.fn(),
    triggerRun: vi.fn(),
    watchPostProcessing: watchPostProcessingMock,
  }
})

// The navbar becomes a PROBE rather than a stub: what it was handed is the observable, so a page
// that wired the client but forgot to pass the view down has somewhere to be caught.
vi.mock("@/components/run-detail/run-navbar", () => ({
  RunNavbar: (props: {
    postProcessing?: unknown
    hasPostProcessing?: unknown
    models?: unknown
    onOpenVerdict?: unknown
  }) => {
    navbarProps.push({
      postProcessing: props.postProcessing,
      hasPostProcessing: props.hasPostProcessing,
      models: props.models,
      onOpenVerdict: props.onOpenVerdict,
    })
    return <div data-testid="run-navbar" />
  },
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: () => {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ DetailSkeleton: () => <div data-loading /> }))
vi.mock("@/components/empty-state", () => ({ EmptyState: ({ title }: { title: string }) => <div>{title}</div> }))
// THE TREE IS A PROBE THAT CAN ALSO MOUNT A TARGET. The real `StepTree` would
// drag the whole member/verdict projection into a file about the header's wiring; what the door
// needs from it is a `[data-verdict-block]` at a known place inside `stepTreeScrollRef`, and what
// idempotency needs from it is the props it was handed.
vi.mock("@/components/run-detail/step-tree", () => ({
  StepTree: (props: { playhead?: unknown; selection?: unknown }) => {
    stepTreeProps.push({ playhead: props.playhead, selection: props.selection })
    return (
      <div>
        {treeScene.trap ? (
          <>
            <button type="button" aria-expanded="false" data-probe-filter />
            <button type="button" aria-expanded="false" data-probe-error-details />
          </>
        ) : null}
        {Array.from({ length: treeScene.collapsedGroups }, (_, index) => (
          <button
            key={`group-${String(index)}`}
            type="button"
            aria-expanded="false"
            data-member-toggle
            {...(treeScene.verdictGroup === index ? { "data-member-has-verdict": "" } : {})}
            data-probe-group={String(index)}
          />
        ))}
        {Array.from({ length: treeScene.blocks }, (_, index) => (
          <div key={`block-${String(index)}`} data-verdict-block data-probe-block={String(index)} tabIndex={-1} />
        ))}
      </div>
    )
  },
}))
vi.mock("@/components/run-detail/tab-panels", () => ({
  TabPanels: (props: { activeTab?: unknown }) => {
    tabPanelProps.push({ activeTab: props.activeTab })
    return <div />
  },
}))
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

function runRow(id: string, status = "passed") {
  return {
    id,
    name: "a chip probe",
    filePath: "tests/probe.test.yaml",
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: "2026-08-27T00:00:01.000Z",
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

function statusRead(
  analysis: string,
  curation: string,
  extra: Record<string, unknown> = {},
  statusExtra: Record<string, unknown> = {},
): PostProcessingRead {
  return {
    kind: "read",
    status: { runId: RUN_ID, chips: { analysis, curation }, ...statusExtra },
    ...extra,
  } as unknown as PostProcessingRead
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let navigateTo: ((to: string) => void) | undefined

function NavProbe() {
  navigateTo = useNavigate()
  return null
}

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

async function renderPage(): Promise<void> {
  unmountHost()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[{ pathname: routes.runDetail(RUN_ID) }]}>
        <NavProbe />
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flushRender()
}

/** The `onRead` the page handed the client on its Nth subscription. */
function onReadOf(call = 0): (read: PostProcessingRead) => void {
  const args = watchPostProcessingMock.mock.calls[call]
  if (args === undefined) throw new Error(`no watchPostProcessing call ${String(call)}`)
  return (args[1] as { onRead: (read: PostProcessingRead) => void }).onRead
}

function lastNavbarView(): unknown {
  const last = navbarProps.at(-1)
  if (last === undefined) throw new Error("the navbar never rendered")
  return last.postProcessing
}

/** The model summary the header was handed on its last render. */
function lastNavbarModels(): unknown {
  const last = navbarProps.at(-1)
  if (last === undefined) throw new Error("the navbar never rendered")
  return last.models
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  navbarProps.length = 0
  stepTreeProps.length = 0
  tabPanelProps.length = 0
  treeScene.blocks = 0
  treeScene.collapsedGroups = 0
  treeScene.trap = false
  treeScene.verdictGroup = undefined
  navigateTo = undefined
  fetchRunMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchExecutionLogsMock.mockReset()
  fetchRunAnalysisMock.mockReset()
  watchPostProcessingMock.mockReset()
  disposeMock.mockReset()

  // The shipped default for every cell that is not about the door: the op answered, and answered
  // that this run has no verdicts. `runId: ''` also fails the page's own run-join guard, which is
  // exactly what the file has always exercised.
  fetchRunAnalysisMock.mockResolvedValue({ runId: '', verdicts: [], sentences: [], clusters: [] })
  watchPostProcessingMock.mockReturnValue(disposeMock)
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: RUN_ID }, artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id) }))
  fetchRunDetailMock.mockImplementation(async (id: string) => ({
    runId: id,
    members: [],
    steps: [],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
  }))
})

afterEach(() => {
  unmountHost()
  vi.clearAllMocks()
})

describe("run detail owns the chip client, and hands the navbar its projection", () => {
  it("subscribes exactly ONCE for the id it was asked for", async () => {
    await renderPage()
    expect(watchPostProcessingMock).toHaveBeenCalledTimes(1)
    expect(watchPostProcessingMock.mock.calls[0]![0]).toBe(RUN_ID)
  })

  it("hands the navbar `undefined` until the first read lands, then the projected chips", async () => {
    await renderPage()
    expect(lastNavbarView()).toBeUndefined()
    expect(navbarProps.at(-1)!.hasPostProcessing).toBe(true)

    await act(async () => {
      onReadOf()(statusRead("running", "pending", { disposition: "handedOff" }))
    })
    expect(lastNavbarView()).toEqual({
      kind: "chips",
      analysis: {
        status: "running",
        state: "running",
        word: STAGE_INDICATOR_WORDS.analysis.running,
        card: { outcome: "Analysis running" },
      },
      curation: {
        status: "pending",
        state: "pending",
        word: STAGE_INDICATOR_WORDS.curation.pending,
        card: { outcome: `Curation queued — ${PENDING_POSTURE_TEXT.handedOff}` },
      },
    })
  })

  it("projects a failure with no recorded envelope into the posture-qualified absence", async () => {
    await renderPage()
    await act(async () => {
      onReadOf()(statusRead("failed", "pending", { disposition: "handedOff", failures: {} }))
    })
    expect(lastNavbarView()).toMatchObject({
      kind: "chips",
      analysis: {
        status: "failed",
        state: "failed",
        card: { outcome: `Analysis failed — ${FAILED_REASON_ABSENT_TEXT.handedOff}` },
      },
    })
  })

  it("hands a refusal down as the unavailable view — never as chips", async () => {
    await renderPage()
    await act(async () => {
      onReadOf()({ kind: "unavailable", error: "function_not_bound", reason: "runs.postprocessing is not bound" })
    })
    expect(lastNavbarView()).toEqual({
      kind: "unavailable",
      error: "function_not_bound",
      reason: "runs.postprocessing is not bound",
    })
  })

  // The tracer's page leg: the outcome sentence must reach the navbar off the read
  // the page already holds. A projection that only composed correctly in a unit test would pass its
  // own cells and still hand this header nothing.
  it("hands the navbar the passing run's analysis card, straight off the read", async () => {
    await renderPage()
    await act(async () => {
      onReadOf()(statusRead("complete", "complete", { disposition: "drained" }, {
        notification: {
          schemaVersion: 2,
          runId: RUN_ID,
          outcome: "complete",
          verdictSummary: { total: 0, byClass: {} },
          stages: { analysis: { status: "complete" }, curation: { status: "complete" } },
        },
      }))
    })
    expect(lastNavbarView()).toMatchObject({
      kind: "chips",
      analysis: { state: "complete", card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT } },
    })
  })

  // THE SKIPPED FACT TRAVELS THE WHOLE WAY. Plan 02 put it on the read over all
  // four doors; the observable here is that the page's own wiring carries it to the header without
  // the header having to know what a gate run is. A projection that only folded correctly in a unit
  // test would pass its own cells and still hand this navbar a chain that reads `pending` forever.
  it("PAGE-EXCLUDED-READ: hands the navbar the skipped view, reason included, off the read", async () => {
    await renderPage()
    await act(async () => {
      onReadOf()(statusRead("pending", "pending", {}, { skipped: { reason: "gate-run" } }))
    })
    expect(lastNavbarView()).toMatchObject({
      kind: "chips",
      skipped: { reason: "gate-run" },
      analysis: { status: "pending", state: "skipped", card: { outcome: STAGE_SKIPPED_TEXT["gate-run"].analysis } },
      curation: { status: "pending", state: "skipped", card: { outcome: STAGE_SKIPPED_TEXT["gate-run"].curation } },
    })
  })

  // MODEL IDENTITY REACHES THE HEADER FROM THE DURABLE READ, AND FROM NOWHERE ELSE.
  //
  // The page holds the `runs.detail` projection; the header is presentational and can only paint
  // what it is handed. The observable is therefore the PROP, not a rendered string — a page that
  // held the summary and forgot to pass it down would paint no model line and look, from the DOM,
  // exactly like a pre-423 run that never recorded one.
  it("PAGE-PASSES-MODELS: hands down the summary the read answered, and nothing when it answered none", async () => {
    const models = { declared: [{ provider: "openai", modelId: "gpt-5.6-terra", stepCount: 3 }] }
    fetchRunDetailMock.mockImplementation(async (id: string) => ({
      runId: id,
      members: [],
      steps: [],
      subActions: [],
      tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
      models,
    }))
    await renderPage()
    expect(lastNavbarModels()).toEqual(models)

    fetchRunDetailMock.mockImplementation(async (id: string) => ({
      runId: id,
      members: [],
      steps: [],
      subActions: [],
      tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
    }))
    await renderPage()
    expect(lastNavbarModels()).toBeUndefined()
  })

  it("invokes the disposer on unmount", async () => {
    await renderPage()
    expect(disposeMock).not.toHaveBeenCalled()
    unmountHost()
    expect(disposeMock).toHaveBeenCalledTimes(1)
  })

  it("disposes and re-subscribes ONCE when the id changes, and forgets the old run's read", async () => {
    await renderPage()
    await act(async () => {
      onReadOf()(statusRead("complete", "complete"))
    })
    expect(lastNavbarView()).toMatchObject({ kind: "chips" })

    await act(async () => { navigateTo!(routes.runDetail(OTHER_RUN_ID)) })
    await flushRender()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(watchPostProcessingMock).toHaveBeenCalledTimes(2)
    expect(watchPostProcessingMock.mock.calls[1]![0]).toBe(OTHER_RUN_ID)
    // The previous run's chips must not survive the change — that would be another run's truth.
    expect(lastNavbarView()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// THE VERDICT DOOR (425-09 · D-11, PXH-RUN-03, UI-SPEC S4)
//
// The header is presentational and the tree is below it, so the ONLY place the two can be joined
// is here. What is pinned is the page's judgement — when a door exists at all — and its mechanics:
// scroll the first mounted block into view honouring reduced motion, then put focus on it and stop.
// Everything the door must NOT touch is observable only as props that did not move, which is why
// the tree and the tab panels are probes rather than stubs.
// ---------------------------------------------------------------------------

/** The door the page handed the header on its last render, or `undefined` when it gave none. */
function doorOf(): unknown {
  const last = navbarProps.at(-1)
  if (last === undefined) throw new Error("the navbar never rendered")
  return last.onOpenVerdict
}

/** An op answer FOR THIS RUN carrying one verdict — the page's gate is `analysisView.size > 0`. */
function analysisWithVerdict() {
  return {
    runId: RUN_ID,
    verdicts: [{ perTest: 0, producer: "deterministic-classifier", confidence: 0 }],
    sentences: [{ perTest: 0, sentence: 'observed (step 0): "Submit never became enabled"' }],
    clusters: [],
  }
}

/**
 * Every `scrollIntoView` the page makes, with the element it was made ON.
 *
 * A bare `vi.fn()` on the prototype records the arguments but not the receiver, and "scrolled
 * something, with the right options" is not the claim — the claim is that it scrolled THE BLOCK.
 */
function recordScrolls(): Array<{ el: Element; options: unknown }> {
  const scrolled: Array<{ el: Element; options: unknown }> = []
  Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
    scrolled.push({ el: this, options })
  } as typeof Element.prototype.scrollIntoView
  return scrolled
}

/** Pin the one media query the door reads, and hand back the restore. */
function pinReducedMotion(reduce: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia
  return () => { window.matchMedia = original }
}

function blockAt(index: number): HTMLElement {
  const el = container?.querySelector<HTMLElement>(`[data-probe-block="${String(index)}"]`)
  if (el == null) throw new Error(`no verdict block ${String(index)} mounted`)
  return el
}

async function invokeDoor(): Promise<void> {
  const door = doorOf()
  if (typeof door !== "function") throw new Error("the page handed the header no door")
  await act(async () => { (door as () => void)() })
}

describe("the failed run's analysis indicator is the door to its verdict", () => {
  async function renderFailedRunWithVerdict(): Promise<void> {
    fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "failed") }))
    fetchRunAnalysisMock.mockResolvedValue(analysisWithVerdict())
    treeScene.blocks = 2
    await renderPage()
  }

  it("PAGE-OPENS-VERDICT: scrolls the FIRST mounted block into view and lands focus on it", async () => {
    const restore = pinReducedMotion(false)
    try {
      await renderFailedRunWithVerdict()
      const scrolled = recordScrolls()

      // The gate first: a failed run whose op answered with a verdict HAS somewhere to go.
      expect(typeof doorOf()).toBe("function")
      await invokeDoor()

      const first = blockAt(0)
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0]!.el).toBe(first)
      // `center` so the block is not pinned under the sticky header; `smooth` because this reader
      // has not asked for less motion.
      expect(scrolled[0]!.options).toEqual({ block: "center", behavior: "smooth" })
      // FOCUS IS THE POINT, not the scroll: a reader sent somewhere must be able to read on from
      // there with the keyboard, and the block's own `:focus` ring is what shows where they were
      // sent after a POINTER activation.
      expect(document.activeElement).toBe(first)
      // Tree order decides "first failed member": a passed member mounts no block at all.
      expect(document.activeElement).not.toBe(blockAt(1))
    } finally {
      restore()
    }
  })

  it("PAGE-OPENS-VERDICT: asks for no motion when the reader asked for none", async () => {
    const restore = pinReducedMotion(true)
    try {
      await renderFailedRunWithVerdict()
      const scrolled = recordScrolls()

      await invokeDoor()

      expect(scrolled[0]!.options).toEqual({ block: "center", behavior: "auto" })
      expect(document.activeElement).toBe(blockAt(0))
    } finally {
      restore()
    }
  })

  it("PAGE-OPENS-VERDICT: no door on a passed run, and none on a failed run with no verdict", async () => {
    // A passed run HAS no verdict to open, whatever the tree below happens to be showing.
    fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "passed") }))
    fetchRunAnalysisMock.mockResolvedValue(analysisWithVerdict())
    treeScene.blocks = 1
    await renderPage()
    expect(doorOf()).toBeUndefined()

    // ...and a failed run the op has answered nothing about has nowhere to send anyone either.
    // This is also the excluded run's reading: a chain that was never enqueued produces no
    // verdicts, so the gate closes without the page having to know what a gate run is.
    fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "failed") }))
    fetchRunAnalysisMock.mockResolvedValue({ runId: RUN_ID, verdicts: [], sentences: [], clusters: [] })
    await renderPage()
    expect(doorOf()).toBeUndefined()
  })

  // focus must not be lost when the reader has collapsed the groups. The toggle is
  // inside the same scroll container, so the verdict stays one keypress away instead of nowhere.
  it("PAGE-OPENS-VERDICT: falls back to the first member group's toggle when no block is mounted", async () => {
    const restore = pinReducedMotion(false)
    try {
      fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "failed") }))
      fetchRunAnalysisMock.mockResolvedValue(analysisWithVerdict())
      treeScene.blocks = 0
      treeScene.collapsedGroups = 2
      await renderPage()
      const scrolled = recordScrolls()

      await invokeDoor()

      const toggle = container!.querySelector<HTMLElement>('[data-probe-group="0"]')!
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0]!.el).toBe(toggle)
      expect(document.activeElement).toBe(toggle)
    } finally {
      restore()
    }
  })

  // WR-01. The run the door is enabled for is a FAILED run, and a failed run with an error
  // log mounts the Error Details disclosure — and, on a suite, the member-filter trigger — above the
  // groups in this same container. Both emit `aria-expanded`, so a fallback that named that state
  // landed on whichever of them rendered first. The probes stand in for exactly those two controls.
  it("PAGE-OPENS-VERDICT-FALLBACK-IS-SCOPED: lands on the group's own toggle, never on the controls above it", async () => {
    const restore = pinReducedMotion(false)
    try {
      fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "failed") }))
      fetchRunAnalysisMock.mockResolvedValue(analysisWithVerdict())
      treeScene.blocks = 0
      treeScene.collapsedGroups = 2
      treeScene.trap = true
      await renderPage()
      const scrolled = recordScrolls()

      await invokeDoor()

      const toggle = container!.querySelector<HTMLElement>('[data-probe-group="0"]')!
      const filter = container!.querySelector<HTMLElement>("[data-probe-filter]")!
      const errorDetails = container!.querySelector<HTMLElement>("[data-probe-error-details]")!
      const failure =
        "the reader pressing a failed run's analysis indicator was sent to a control nobody asked for"
      expect(document.activeElement, failure).not.toBe(filter)
      expect(document.activeElement, failure).not.toBe(errorDetails)
      expect(document.activeElement, failure).toBe(toggle)
      expect(scrolled.map(entry => entry.el), failure).toEqual([toggle])
    } finally {
      restore()
    }
  })

  // WR-01 (425 review). Only a failed member mounts a verdict, so on a suite whose first member
  // passed, the first group's toggle opens onto nothing. The fallback lands on the toggle of the
  // group that holds the verdict, named by its own contract attribute rather than by tree order.
  it("PAGE-OPENS-VERDICT-FALLBACK-FINDS-THE-FAILED-GROUP: skips a passed member's group ahead of it", async () => {
    const restore = pinReducedMotion(false)
    try {
      fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id, "failed") }))
      fetchRunAnalysisMock.mockResolvedValue(analysisWithVerdict())
      treeScene.blocks = 0
      treeScene.collapsedGroups = 2
      treeScene.verdictGroup = 1
      treeScene.trap = true
      await renderPage()
      const scrolled = recordScrolls()

      await invokeDoor()

      const passed = container!.querySelector<HTMLElement>('[data-probe-group="0"]')!
      const failed = container!.querySelector<HTMLElement>('[data-probe-group="1"]')!
      const failure = "the door sent the reader to a passed member's group, which holds no verdict"
      expect(document.activeElement, failure).not.toBe(passed)
      expect(document.activeElement, failure).toBe(failed)
      expect(scrolled.map(entry => entry.el), failure).toEqual([failed])
    } finally {
      restore()
    }
  })

  it("DOOR-IDEMPOTENT: opening it twice lands the same reader in the same place, and moves nothing else", async () => {
    const restore = pinReducedMotion(false)
    try {
      await renderFailedRunWithVerdict()
      const scrolled = recordScrolls()
      const tabsBefore = [...tabPanelProps]
      const treeBefore = [...stepTreeProps]

      await invokeDoor()
      const landed = document.activeElement
      await invokeDoor()

      expect(landed).toBe(blockAt(0))
      expect(document.activeElement).toBe(landed)
      expect(scrolled).toHaveLength(2)
      expect(scrolled[1]!.el).toBe(scrolled[0]!.el)

      // THE ELEVATION CLAIM. A header control that changed a tab, the playhead or
      // the selection would be mutating page state it does not own — and because the page re-renders
      // on any of those, "it changed nothing" is exactly "the tree and the tabs were not handed
      // anything new". The declined option (drive the playhead) is measured here, not asserted.
      expect(tabPanelProps).toEqual(tabsBefore)
      expect(stepTreeProps).toEqual(treeBefore)
      expect(tabPanelProps.at(-1)!.activeTab).toBe("overview")
      expect(stepTreeProps.at(-1)!.playhead).toBeNull()
      expect(stepTreeProps.at(-1)!.selection).toBeNull()
    } finally {
      restore()
    }
  })
})
