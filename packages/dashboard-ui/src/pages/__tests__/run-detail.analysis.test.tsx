// @vitest-environment jsdom
//
// THE FAILURE VIEW ON THE PAGE (406-01 · DETL-04, D-03 / D-05 / D-10).
//
// FOUR CLAIMS, ALL ABOUT WHAT A PERSON SEES AND WHEN:
//
//   1. the page reads `/analysis` once at mount and again on EVERY analysis-chip TRANSITION, and
//      never on a frame whose word did not change (D-03);
//   2. a failed member's group carries the op's sentence VERBATIM, with the provenance chip built
//      from that verdict's own producer and confidence (D-05/D-10);
//   3. a member with no verdict — a passed one — carries no block at all;
//   4. a sentence containing markup renders as a TEXT NODE, never an element (T-406-02).
//
// AND FIVE MORE, ADDED IN 406-06, all about what the chip word and the op's evidence DO to the page:
//
//   5. the marker follows the chip through its whole lifecycle — provisional while the chain is
//      running, gone when it is done, and the sentence is swapped IN PLACE (D-09);
//   6. a permanently failed chain marks every failed member's block while the verdict itself is not
//      re-graded — the producer stays the deterministic classifier (D-11);
//   7. a cited step selects that step in the tree, through the page's existing `Selection` and the
//      existing scroll effect — no new id spelling and no second scroller (D-02);
//   8. a cluster sibling link narrows the member filter to that sibling's own group (D-08);
//   9. EVERY member wears an outcome badge and only the failed one carries a block (D-07/D-05).
//
// THE MOCK BLOCK IS `run-detail.members.test.tsx`'S, with one addition: `watchPostProcessing`
// CAPTURES its `onRead` so a cell can push frames. The real watcher constructs an `EventSource`
// and a 3 s interval against a `fetch` these cells do not stub; its own behaviour is measured in
// `run-detail.post-processing.test.tsx`.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AnalysisGetOutput,
  RunDetailMember,
  RunDetailProjection,
  RunDetailStep,
} from "@vostride/agent-qa-schema"

import RunDetailPage from "@/pages/run-detail"
import {
  ANALYSIS_FAILED_FALLBACK_TEXT,
  ANALYSIS_PROVISIONAL_TEXT,
  DETERMINISTIC_FALLBACK_LABEL,
  missingEvidenceLine,
  provenanceLabel,
  siblingLine,
} from "@/lib/analysis-view"
import { EVIDENCE_INCOMPLETE_LABEL } from "@/lib/run-detail-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = "run-406"
/** The op's sentence, spelled once. Every assertion below compares against THIS string. */
const FLOOR_SENTENCE =
  'observed (step 0): "Error: element \\"Submit\\" not found" — root cause undetermined'

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunAnalysisMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
  pushPostProcessing,
} = vi.hoisted(() => {
  // The captured `onRead`, module-level so a cell can push a frame after mount (RESEARCH
  // Pitfall 8). A watcher double that dropped its callback would make every transition cell
  // vacuous — it would assert on a channel nothing can ever send down.
  let onRead: ((read: unknown) => void) | undefined
  return {
    fetchRunMock: vi.fn(),
    fetchRunDetailMock: vi.fn(),
    fetchRunAnalysisMock: vi.fn(),
    fetchRunArtifactMock: vi.fn(),
    fetchExecutionLogsMock: vi.fn(),
    pushPostProcessing: {
      capture: (next: ((read: unknown) => void) | undefined) => { onRead = next },
      send: (read: unknown) => { onRead?.(read) },
      reset: () => { onRead = undefined },
    },
  }
})

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  fetchRunAnalysis: fetchRunAnalysisMock,
  fetchRunKnowledge: () => Promise.resolve({ kind: 'evidence-incomplete', runId: '' }),
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  watchPostProcessing: (_id: string, options: { onRead: (read: unknown) => void }) => {
    pushPostProcessing.capture(options.onRead)
    return () => { pushPostProcessing.capture(undefined) }
  },
}))

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitle: (title: string) => { document.title = title },
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
  TabPanels: () => <div data-testid="tab-panels" />,
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>member filter</span>,
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

/** Member 0 FAILED (it gets the verdict), member 1 PASSED (it gets nothing). */
const TWO_MEMBERS: RunDetailProjection = {
  runId: RUN_ID,
  members: [
    member(0, { name: "Checkout", outcome: "failed" }),
    member(1, { name: "Login", outcome: "passed" }),
  ],
  steps: [step(0, 0, "Click Submit"), step(1, 0, "Open login")],
  subActions: [],
  tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
}

function analysisOf(over: Partial<AnalysisGetOutput> = {}): AnalysisGetOutput {
  return {
    runId: RUN_ID,
    verdicts: [
      { perTest: 0, testId: "t_checkout", class: "unknown", producer: "deterministic-classifier", confidence: 0 },
    ],
    sentences: [{ perTest: 0, testId: "t_checkout", sentence: FLOOR_SENTENCE }],
    clusters: [],
    ...over,
  }
}

/** The read route's own frame shape — the only thing `watchPostProcessing` ever hands the page. */
const CHIP_PENDING = { kind: "read", status: { runId: RUN_ID, chips: { analysis: 'pending', curation: 'pending' } } }
const CHIP_RUNNING = { kind: "read", status: { runId: RUN_ID, chips: { analysis: 'running', curation: 'pending' } } }
const CHIP_DONE = { kind: "read", status: { runId: RUN_ID, chips: { analysis: 'complete', curation: 'pending' } } }
/** The SAME analysis word, a different curation word — a frame that must trigger nothing. */
const CHIP_DONE_AGAIN = { kind: "read", status: { runId: RUN_ID, chips: { analysis: 'complete', curation: 'complete' } } }
/** The chain fell over for good: the floor sentences are what exists (spec §1.2, D-11). */
const CHIP_FAILED = { kind: "read", status: { runId: RUN_ID, chips: { analysis: 'failed', curation: 'pending' } } }

/** Member 0 failed with TWO steps — a cited step that is not the page's default selection. */
const TWO_STEP_MEMBER: RunDetailProjection = {
  ...TWO_MEMBERS,
  steps: [step(0, 0, "Open checkout"), step(0, 1, "Click Submit"), step(1, 0, "Open login")],
}

/** Both members failed, and the producer grouped them — the shape a sibling line needs. */
const CLUSTERED_MEMBERS: RunDetailProjection = {
  ...TWO_MEMBERS,
  members: [
    member(0, { name: "Checkout", outcome: "failed" }),
    member(1, { name: "Login", outcome: "failed" }),
  ],
}

function runRow(id: string) {
  return {
    id,
    name: "Checkout suite",
    filePath: "tests/checkout.yaml",
    status: "failed",
    duration: 10000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:10.000Z",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: "s_suite",
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-08-28T00:00:00.000Z",
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

async function renderPage() {
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
  await flushRender()
  return container
}

/** Push one post-processing frame and let the effects it triggers settle. */
async function push(read: unknown) {
  await act(async () => { pushPostProcessing.send(read) })
  await flushRender()
}

beforeEach(() => {
  document.title = ""
  Element.prototype.scrollIntoView = vi.fn()
  pushPostProcessing.reset()
  fetchRunMock.mockReset()
  fetchRunDetailMock.mockReset()
  fetchRunAnalysisMock.mockReset()
  fetchRunArtifactMock.mockReset()
  fetchExecutionLogsMock.mockReset()

  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
  fetchRunArtifactMock.mockResolvedValue({ run: { id: RUN_ID }, artifact: null, children: [], missingSections: ["artifact"] })
  fetchRunMock.mockImplementation(async (id: string) => ({ run: runRow(id) }))
  fetchRunDetailMock.mockResolvedValue(TWO_MEMBERS)
  fetchRunAnalysisMock.mockResolvedValue(analysisOf())
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  if (container) container.remove()
  container = null
  vi.clearAllMocks()
})

describe("the page re-reads analysis on chip TRANSITIONS and on nothing else (D-03)", () => {
  it("reads once at mount, again per changed chip word, and NOT on a repeated frame", async () => {
    await renderPage()
    expect(fetchRunAnalysisMock, "one read at mount").toHaveBeenCalledTimes(1)
    expect(fetchRunAnalysisMock).toHaveBeenCalledWith(RUN_ID)

    await push(CHIP_PENDING)
    expect(fetchRunAnalysisMock, "undefined → pending is a transition").toHaveBeenCalledTimes(2)

    await push(CHIP_RUNNING)
    expect(fetchRunAnalysisMock, "pending → running is a transition").toHaveBeenCalledTimes(3)

    await push(CHIP_DONE)
    expect(fetchRunAnalysisMock, "running → complete is a transition").toHaveBeenCalledTimes(4)

    await push(CHIP_DONE)
    await push(CHIP_DONE_AGAIN)
    expect(
      fetchRunAnalysisMock,
      "a frame whose ANALYSIS word did not change is a trigger for nothing",
    ).toHaveBeenCalledTimes(4)
  })
})

describe("a failed member's group carries the op's sentence and its provenance (D-05/D-10)", () => {
  it("paints the sentence VERBATIM under the failed member, with the floor's provenance chip", async () => {
    const view = await renderPage()

    const block = view.querySelector('[data-member="0"] [data-verdict-block]')
    expect(block, "the failed member's group holds the block").not.toBeNull()
    expect(
      block?.querySelector("[data-verdict-sentence]")?.textContent,
      "the op's bytes, copied — the page composes no sentence",
    ).toBe(FLOOR_SENTENCE)
    expect(block?.getAttribute("data-verdict-producer")).toBe("deterministic-classifier")
    expect(block?.getAttribute("data-verdict-confidence")).toBe("0")
    expect(block?.querySelector("[data-verdict-provenance]")?.textContent)
      .toBe(DETERMINISTIC_FALLBACK_LABEL)
  })

  it("renders NO block on a member the analysis had no verdict for (a passed member)", async () => {
    const view = await renderPage()
    expect(view.querySelector('[data-member="1"]'), "member 1 is rendered").not.toBeNull()
    expect(
      view.querySelectorAll('[data-member="1"] [data-verdict-block]').length,
      "a passed member has nothing to explain, and no block is how that reads",
    ).toBe(0)
  })

  it("reads the LLM provenance off the verdict's own producer and confidence", async () => {
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        { perTest: 0, testId: "t_checkout", class: "app_bug", producer: "analyze-run", confidence: 0.86 },
      ],
    }))
    const view = await renderPage()

    const block = view.querySelector('[data-member="0"] [data-verdict-block]')
    expect(block?.getAttribute("data-verdict-producer")).toBe("analyze-run")
    expect(block?.getAttribute("data-verdict-confidence")).toBe("0.86")
    expect(block?.querySelector("[data-verdict-provenance]")?.textContent)
      .toBe(provenanceLabel("analyze-run", 0.86))
  })

  it("renders a sentence carrying markup as TEXT, never as an element (T-406-02)", async () => {
    const hostile = '<img src=x onerror=alert(1)> observed (step 0): "boom"'
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      sentences: [{ perTest: 0, testId: "t_checkout", sentence: hostile }],
    }))
    const view = await renderPage()

    const sentence = view.querySelector("[data-verdict-sentence]")
    expect(sentence?.textContent, "the markup is the sentence's own text").toBe(hostile)
    expect(sentence?.querySelectorAll("img").length, "no element was ever constructed").toBe(0)
    expect(view.querySelectorAll("img").length).toBe(0)
  })

  it("keeps the previous answer when a re-read rejects — a failed fetch is not a paint input", async () => {
    const view = await renderPage()
    expect(view.querySelector("[data-verdict-sentence]")?.textContent).toBe(FLOOR_SENTENCE)

    fetchRunAnalysisMock.mockRejectedValueOnce(new Error('read_failed'))
    await push(CHIP_RUNNING)

    expect(view.querySelector("[data-verdict-sentence]")?.textContent, "the last real answer stands")
      .toBe(FLOOR_SENTENCE)
  })
})

describe("the sentence's lifecycle is painted from the chip word (D-09/D-11)", () => {
  it("marks the floor provisional while the chain runs, then swaps the sentence IN PLACE", async () => {
    const view = await renderPage()

    await push(CHIP_RUNNING)
    const marker = view.querySelector("[data-verdict-marker]")
    expect(marker?.getAttribute("data-verdict-marker")).toBe("provisional")
    expect(marker?.textContent).toBe(ANALYSIS_PROVISIONAL_TEXT)
    expect(view.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-producer"))
      .toBe("deterministic-classifier")

    // The chain finishes and the op now answers an LLM verdict. D-03's re-read is the swap: the
    // same block, a new sentence, and no marker — nothing here waits for a reload.
    const upgraded = 'the Submit button never became enabled — the cart total never rendered'
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        { perTest: 0, testId: "t_checkout", class: "app_bug", producer: "analyze-run", confidence: 0.86 },
      ],
      sentences: [{ perTest: 0, testId: "t_checkout", sentence: upgraded }],
    }))
    await push(CHIP_DONE)

    expect(view.querySelector("[data-verdict-marker]"), "a complete chain warns about nothing").toBeNull()
    expect(view.querySelector("[data-verdict-sentence]")?.textContent).toBe(upgraded)
    expect(view.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-producer"))
      .toBe("analyze-run")
  })

  it("marks a permanently failed chain in the TREE, and does not re-grade the verdict (D-11)", async () => {
    // THE CHIP IS IN THE HEADER AND THE MARKER IS IN THE TREE, which is the whole decision: a
    // reader scrolled into a 40-member suite must not have to look up to learn that the sentence
    // beside them is the deterministic floor and is never going to improve.
    const view = await renderPage()
    await push(CHIP_FAILED)

    const marker = view.querySelector("[data-verdict-marker]")
    expect(marker?.getAttribute("data-verdict-marker")).toBe("failed")
    expect(marker?.textContent).toBe(ANALYSIS_FAILED_FALLBACK_TEXT)
    expect(
      view.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-producer"),
      "the floor verdict stands as it was authored",
    ).toBe("deterministic-classifier")
    expect(view.querySelector("[data-verdict-provenance]")?.textContent)
      .toBe(DETERMINISTIC_FALLBACK_LABEL)
  })
})

describe("the block's links do something (D-02, D-08)", () => {
  it("selects the cited step in the tree, by the tree's own key", async () => {
    fetchRunDetailMock.mockResolvedValue(TWO_STEP_MEMBER)
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        {
          perTest: 0,
          testId: "t_checkout",
          class: "app_bug",
          producer: "analyze-run",
          confidence: 0.9,
          evidence: { citedSteps: [1], citedArtifacts: [] },
        },
      ],
    }))
    const view = await renderPage()

    // The page selects its first step at mount, so the CITED step is deliberately the second one:
    // a cell citing `0:0` would pass without the wiring ever running.
    expect(view.querySelector('[data-step-id="0:0"]')?.getAttribute("aria-selected")).toBe("true")
    expect(view.querySelector('[data-step-id="0:1"]')?.getAttribute("aria-selected")).toBe("false")

    const cited = view.querySelector('[data-cited-step="1"]')
    expect(cited, "the verdict's own cited ordinal").not.toBeNull()
    await act(async () => { (cited as HTMLButtonElement).click() })
    await flushRender()

    expect(
      view.querySelector('[data-step-id="0:1"]')?.getAttribute("aria-selected"),
      "the cited step is the selected row — the key is `runDetailStepKey`'s, not a second spelling",
    ).toBe("true")
    expect(view.querySelector('[data-step-id="0:0"]')?.getAttribute("aria-selected")).toBe("false")
  })

  it("narrows the tree to a cluster sibling's own group when its link is clicked", async () => {
    fetchRunDetailMock.mockResolvedValue(CLUSTERED_MEMBERS)
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        { perTest: 0, testId: "t_checkout", class: "unknown", producer: "deterministic-classifier", confidence: 0 },
        { perTest: 1, testId: "t_login", class: "unknown", producer: "deterministic-classifier", confidence: 0 },
      ],
      sentences: [
        { perTest: 0, testId: "t_checkout", sentence: FLOOR_SENTENCE },
        { perTest: 1, testId: "t_login", sentence: FLOOR_SENTENCE },
      ],
      clusters: [{
        fingerprint: "not-found:submit",
        count: 2,
        members: [
          { testIndex: 0, testId: "t_checkout" },
          { testIndex: 1, testId: "t_login" },
        ],
        representative: { testIndex: 0, sentence: FLOOR_SENTENCE },
      }],
    }))
    const view = await renderPage()

    const line = view.querySelector('[data-member="0"] [data-cluster-siblings]')
    expect(line?.textContent, "one sibling, and the line says so in the singular")
      .toContain(siblingLine(1))

    const link = view.querySelector('[data-member="0"] [data-cluster-sibling="1"]')
    expect(link).not.toBeNull()
    await act(async () => { (link as HTMLButtonElement).click() })
    await flushRender()

    expect(view.querySelector('[data-member="1"]'), "the sibling's own group").not.toBeNull()
    expect(
      view.querySelector('[data-member="0"]'),
      "the member filter narrowed — the same control the picker writes",
    ).toBeNull()
  })
})

describe("every member wears its outcome, and only a graded one carries a block (D-07/D-05)", () => {
  it("badges the passed member and the failed one, and blocks only the failed one", async () => {
    const view = await renderPage()

    expect(view.querySelector('[data-member="0"] [data-member-outcome]')?.getAttribute("data-member-outcome"))
      .toBe("failed")
    expect(
      view.querySelector('[data-member="1"] [data-member-outcome]')?.getAttribute("data-member-outcome"),
      "a passed member says PASSED — the D-07 reversal, on the page",
    ).toBe("passed")

    expect(view.querySelectorAll('[data-member="0"] [data-verdict-block]').length).toBe(1)
    expect(
      view.querySelectorAll('[data-member="1"] [data-verdict-block]').length,
      "nothing to explain is no block, badge or no badge",
    ).toBe(0)
  })
})

describe("evidence the durable read found MISSING is said so, and changes nothing else (D-19)", () => {
  /** 64-hex content addresses; the second one's bytes are gone at read time (`present: false`). */
  const SHA_PRESENT = "a".repeat(64)
  const SHA_GONE = "b".repeat(64)

  it("paints the chip and the count line without touching the member's outcome badge", async () => {
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        {
          perTest: 0,
          testId: "t_checkout",
          class: "unknown",
          producer: "deterministic-classifier",
          confidence: 0,
          evidence: {
            citedSteps: [],
            citedArtifacts: [
              { id: "art_0", sha: SHA_PRESENT, present: true },
              { id: "art_1", sha: SHA_GONE, present: false },
            ],
          },
        },
      ],
    }))
    const view = await renderPage()

    const chip = view.querySelector('[data-member="0"] [data-cited-artifact-state="unavailable"]')
    expect(chip?.getAttribute("data-cited-artifact-sha"), "the ref keeps its place").toBe(SHA_GONE)
    expect(chip?.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
    expect(chip?.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(
      view.querySelector(`[data-member="0"] [data-cited-artifact="${SHA_PRESENT}"]`),
      "the artifact that IS there is still one click from the sentence",
    ).not.toBeNull()

    const count = view.querySelector('[data-member="0"] [data-evidence-incomplete="1/2"]')
    expect(count?.getAttribute("data-evidence-incomplete")).toBe("1/2")
    expect(count?.textContent).toBe(missingEvidenceLine({ missing: 1, total: 2 }))

    expect(
      view.querySelector('[data-member="0"] [data-member-outcome]')?.getAttribute("data-member-outcome"),
      "the verdict is NOT re-graded — one missing screenshot is not an untrustworthy verdict",
    ).toBe("failed")
    expect(view.querySelector('[data-member="0"] [data-verdict-sentence]')?.textContent)
      .toBe(FLOOR_SENTENCE)
    expect(
      view.querySelector('[data-member="0"] [data-verdict-block]')?.getAttribute("data-verdict-producer"),
    ).toBe("deterministic-classifier")

    expect(
      view.querySelector('[data-member="1"] [data-evidence-incomplete]'),
      "the passed member is untouched — it has no block at all",
    ).toBeNull()
  })

  it("says nothing about evidence when presence is UNKNOWN — an omission is not a deletion", async () => {
    // 406-03's rule, on the page: a host that cannot cheaply stat its own blobs omits `present`,
    // and `!present` would render that omission as a claimed deletion.
    fetchRunAnalysisMock.mockResolvedValue(analysisOf({
      verdicts: [
        {
          perTest: 0,
          testId: "t_checkout",
          class: "unknown",
          producer: "deterministic-classifier",
          confidence: 0,
          evidence: { citedSteps: [], citedArtifacts: [{ id: "art_0", sha: SHA_PRESENT }] },
        },
      ],
    }))
    const view = await renderPage()

    expect(view.querySelector('[data-member="0"] [data-evidence-incomplete="1/2"]')).toBeNull()
    expect(view.querySelector('[data-member="0"] [data-cited-artifact-state="unavailable"]')).toBeNull()
    expect(view.querySelector(`[data-member="0"] [data-cited-artifact="${SHA_PRESENT}"]`)).not.toBeNull()
  })
})

// ----------------------------------------------------------------------------------------------
// ONE RUN'S VERDICTS NEVER PAINT UNDER ANOTHER RUN'S MEMBERS (CR-02, measured 2026-08-29, phase
// 406 review).
//
// The route is `/runs/:id`, so React Router changes the param WITHOUT remounting this page. The
// analysis read held its answer across that change and `projectAnalysisView` keys on
// `perTest` / `testIndex` — an integer both runs have — so every member of run B whose index
// matched a failed member of run A wore run A's sentence, provenance, confidence, cited steps and
// cited artifact shas.
//
// It is not a one-round-trip window either: `request()` throws on any non-2xx and the read answers
// 404 for a run with no handoff, so navigating from a run WITH an analysis to one WITHOUT left the
// first run's sentences on the second run's page indefinitely — including, on the local human
// door, its RESTORED secret values, attributed to the wrong test.
// ----------------------------------------------------------------------------------------------

const RUN_B = "run-406-b"

/** Run B's own projection: the SAME member indexes, which is exactly why a stale join is silent. */
const TWO_MEMBERS_B: RunDetailProjection = { ...TWO_MEMBERS, runId: RUN_B }

function NavToRunB() {
  const navigate = useNavigate()
  return (
    <button type="button" data-testid="go-to-b" onClick={() => { navigate(`/runs/${RUN_B}`) }}>
      go
    </button>
  )
}

/**
 * Mount at run A with a control that navigates to run B on the SAME route. The element is one
 * position of one type, so the page keeps its state across the param change — the production
 * condition, not a simulation of it.
 */
async function renderPageWithNav() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Routes>
          <Route
            path="/runs/:id"
            element={
              <>
                <NavToRunB />
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

async function goToRunB(view: HTMLElement) {
  const button = view.querySelector('[data-testid="go-to-b"]') as HTMLButtonElement
  await act(async () => { button.click() })
  await flushRender()
}

describe("the analysis read is forgotten when the run id changes (CR-02)", () => {
  beforeEach(() => {
    fetchRunDetailMock.mockImplementation(async (id: string) =>
      id === RUN_B ? TWO_MEMBERS_B : TWO_MEMBERS,
    )
  })

  it("leaves run B's members bare when run B has no analysis at all (the 404 that made it permanent)", async () => {
    fetchRunAnalysisMock.mockImplementation(async (id: string) => {
      if (id === RUN_B) throw new Error("404 unknown_run")
      return analysisOf()
    })

    const view = await renderPageWithNav()
    expect(
      view.querySelector('[data-member="0"] [data-verdict-sentence]')?.textContent,
      "run A is painted from its own answer",
    ).toBe(FLOOR_SENTENCE)

    await goToRunB(view)

    expect(fetchRunAnalysisMock).toHaveBeenCalledWith(RUN_B)
    expect(
      view.querySelectorAll("[data-verdict-block]").length,
      "a run with no analysis has no blocks — not the previous run's",
    ).toBe(0)
    expect(
      view.textContent,
      "not one byte of run A's sentence survives the id change",
    ).not.toContain(FLOOR_SENTENCE)
  })

  it("refuses an answer that is about another run, however it arrives", async () => {
    // The belt-and-braces half: `AnalysisGetOutput.runId` is on the wire, so an answer for the
    // run we just left can be recognised as such rather than joining silently on `perTest`.
    fetchRunAnalysisMock.mockImplementation(async (id: string) => {
      if (id === RUN_B) return analysisOf({ runId: RUN_ID })
      return analysisOf()
    })

    const view = await renderPageWithNav()
    await goToRunB(view)

    expect(
      view.querySelectorAll("[data-verdict-block]").length,
      "an answer whose runId is not the run on screen is not a paint input",
    ).toBe(0)
    expect(view.textContent).not.toContain(FLOOR_SENTENCE)
  })

  it("still paints run B's OWN answer under run B's members", async () => {
    // The other direction, pinned in the same group: forgetting the previous run must not turn
    // into forgetting the current one.
    const B_SENTENCE = 'observed (step 0): "Error: login timed out" — root cause undetermined'
    fetchRunAnalysisMock.mockImplementation(async (id: string) =>
      id === RUN_B
        ? analysisOf({ runId: RUN_B, sentences: [{ perTest: 0, testId: "t_login", sentence: B_SENTENCE }] })
        : analysisOf(),
    )

    const view = await renderPageWithNav()
    await goToRunB(view)

    expect(view.querySelector('[data-member="0"] [data-verdict-sentence]')?.textContent)
      .toBe(B_SENTENCE)
  })
})

// The records a verdict declared on its failing path reach that member's row and no other.

const REC_CANDIDATE = "rec_cand_0001"
const REC_CANARY = "rec_canary_01"

/** Both members failed, so both carry a block — the shape a leakage claim needs. */
function twoFailedVerdicts(
  zero: AnalysisGetOutput["verdicts"][number]["memoryOnPath"],
  one: AnalysisGetOutput["verdicts"][number]["memoryOnPath"],
): AnalysisGetOutput {
  return analysisOf({
    verdicts: [
      {
        perTest: 0, testId: "t_checkout", class: "unknown",
        producer: "deterministic-classifier", confidence: 0,
        ...(zero === undefined ? {} : { memoryOnPath: zero }),
      },
      {
        perTest: 1, testId: "t_login", class: "unknown",
        producer: "deterministic-classifier", confidence: 0,
        ...(one === undefined ? {} : { memoryOnPath: one }),
      },
    ],
    sentences: [
      { perTest: 0, testId: "t_checkout", sentence: FLOOR_SENTENCE },
      { perTest: 1, testId: "t_login", sentence: 'observed (step 0): "Login timed out"' },
    ],
  })
}

describe("the records on the failing path reach the visible member and no other", () => {
  beforeEach(() => { fetchRunDetailMock.mockResolvedValue(CLUSTERED_MEMBERS) })

  const recordsOf = (view: HTMLElement, member: number, attribute: string) =>
    [...view.querySelectorAll(`[data-member="${String(member)}"] [${attribute}]`)]
      .map((element) => element.getAttribute(attribute))

  it("lists each member's declared records under that member only", async () => {
    fetchRunAnalysisMock.mockResolvedValue(twoFailedVerdicts(
      [
        { recordId: REC_CANDIDATE, trust: "candidate" },
        { recordId: REC_CANARY, trust: "candidate" },
      ],
      [],
    ))
    const view = await renderPage()

    expect(view.querySelectorAll("[data-verdict-block]").length, "both members failed").toBe(2)
    expect(recordsOf(view, 0, "data-misdirection-on-path-record")).toEqual([REC_CANDIDATE, REC_CANARY])
    expect(recordsOf(view, 1, "data-misdirection-on-path-record"), "member 1 declared none").toEqual([])
    expect(view.querySelector('[data-member="1"] [data-misdirection-on-path]')).not.toBeNull()
  })

  it("leaves a member whose verdict declared nothing with no on-path element", async () => {
    fetchRunAnalysisMock.mockResolvedValue(twoFailedVerdicts(
      [{ recordId: REC_CANDIDATE, trust: "candidate" }],
      undefined,
    ))
    const view = await renderPage()

    expect(recordsOf(view, 0, "data-misdirection-on-path-record")).toEqual([REC_CANDIDATE])
    expect(view.querySelector('[data-member="1"] [data-misdirection-on-path]')).toBeNull()
    expect(view.querySelector('[data-member="1"] [data-verdict-sentence]')?.textContent)
      .toBe('observed (step 0): "Login timed out"')
    expect(view.querySelector('[data-member="1"] [data-verdict-provenance]')?.textContent)
      .toBe(DETERMINISTIC_FALLBACK_LABEL)
  })
})
