import { RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom
//
// THE KNOWLEDGE TAB ON THE PAGE (407-06 · LERN-01, D-03 / D-05 / D-06, closing WINDOWS #310).
//
// WHY THIS FILE EXISTS. 407-02 shipped the tab and recorded an honest gap against itself: the
// seven page doubles all resolve a FIXED `evidence-incomplete` projection, so nothing pinned the
// READ CARDINALITY (one `runs.knowledge` per run id, none on re-render) and nothing drove a
// REJECTED read all the way into `data-knowledge-state="error"`. Both claims were arguments about
// an effect's dependency list rather than assertions. This file makes them measurements.
//
// IT RENDERS THE REAL `TabPanels` AND THE REAL `TabKnowledge`. A double for either would leave the
// page→projection→tab path — the thing the gap is about — unexercised. Only the primitives that
// need a layout engine or a socket are doubled: `ScrollArea` (Radix's uses `ResizeObserver`, which
// jsdom does not have), the resizable panels, the member `Select`, the tooltip and the navbar.
// `Tabs`, `Collapsible` and `Badge` are REAL, because which tab is mounted and whether a row is
// open are exactly what these cells read.
//
// THE TAB IS SELECTED FROM THE URL, `?tab=knowledge`, which is the page's own initial-state
// spelling. Driving it by keypress would measure the shortcut map (already pinned in
// `run-detail.artifact-drawer.test.tsx`) rather than the read.

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  asRef,
  type RunKnowledgeProjection,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from "@vostride/agent-qa-schema"

import RunDetailPage from "@/pages/run-detail"
import {
  ATTRIBUTION_UNKNOWN_TEXT,
  CHANNEL_EYEBROWS,
  CURATION_FAILED_PARTIAL_TEXT,
  CURATION_FAILED_TEXT,
  NOT_ATTRIBUTED_TEXT,
  NO_STORE_HEADING,
  READ_FAILED_HEADING,
  STORE_READ_INCOMPLETE_TEXT,
  readFailedBody,
} from "@/lib/knowledge-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RUN_ID = "run-407-06"

const {
  fetchRunMock,
  fetchRunDetailMock,
  fetchRunKnowledgeMock,
  fetchRunArtifactMock,
  fetchExecutionLogsMock,
} = vi.hoisted(() => ({
  fetchRunMock: vi.fn(),
  fetchRunDetailMock: vi.fn(),
  fetchRunKnowledgeMock: vi.fn(),
  fetchRunArtifactMock: vi.fn(),
  fetchExecutionLogsMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchRun: fetchRunMock,
  fetchRunDetail: fetchRunDetailMock,
  fetchRunAnalysis: () => Promise.resolve({ runId: "", verdicts: [], sentences: [], clusters: [] }),
  // THE SUBJECT of this file — a real spy, so a cell can count what the page asked for.
  fetchRunKnowledge: fetchRunKnowledgeMock,
  fetchRunArtifact: fetchRunArtifactMock,
  fetchExecutionLogs: fetchExecutionLogsMock,
  fetchRunEvidence: () => Promise.resolve({ kind: 'failed', error: 'Evidence read not configured in this fixture' }),
  triggerRun: vi.fn(),
  // The real watcher opens an `EventSource` and a 3 s interval against a `fetch` these cells do
  // not stub; its own behaviour is measured in `run-detail.post-processing.test.tsx`.
  watchPostProcessing: () => () => {},
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
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

function runRow(id: string) {
  return {
    id,
    name: "Checkout suite",
    filePath: "tests/checkout.yaml",
    status: "passed",
    duration: 10000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:10.000Z",
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
    createdAt: "2026-08-29T00:00:00.000Z",
  }
}

function detailProjection(id: string) {
  return {
    runId: id,
    members: [{ testIndex: 0, attempts: 1, name: "Checkout", outcome: "passed" as const }],
    steps: [{
      testIndex: 0,
      stepIndex: 0,
      stepText: "click checkout",
      cacheStatus: "miss" as const,
      verifierVerdict: { pass: true, reasoning: "looks right" },
      selfHealOccurred: false,
      briefDigest: "d00",
      status: "passed" as const,
      durationMs: 1000,
    }],
    subActions: [],
    tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
  }
}

/**
 * A run that really served a brief — the populated fixture 407-02 said this plan would need.
 *
 * One canary line with a committed outcome, one answered trace with a cut candidate, and a replay
 * whose guard passed: enough that the ready panel has something to be wrong about.
 */
const POPULATED: RunKnowledgeProjection = {
  kind: "ready",
  runId: RUN_ID,
  buildOrdinal: 3,
  knowledgeStore: "bound",
  steps: [{
    testId: "t_checkout",
    testIndex: 0,
    stepIndex: 0,
    stepText: "click checkout",
    served: {
      channel1: [{
        id: "rec_cart_url",
        kind: "fact",
        summary: "the cart page lives at /view_cart",
        trust: 0.9,
        status: "active",
        servedAsCanary: true,
        tier: "confirmed",
      }],
      channel2: [],
      channel3: [],
    },
    trace: {
      kind: "answered",
      trace: {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId: "rec_cart_url", leg: "anchor", rank: 1, score: 1.48695 }],
        truncated: [{ recordId: "rec_cut", leg: "lexical", rank: 21, score: 0.11 }],
      },
    },
    planSource: {
      kind: "procedure-replay",
      procedureId: "p_checkout",
      guard: { checksPassed: 5, total: 5 },
    },
  }],
  curation: { status: "complete" },
  learned: {
    changes: [],
    canaryAttributions: [{
      testIndex: 0,
      stepIndex: 0,
      recordId: "rec_cart_url",
      observationId: "canary-outcome:abc",
      outcome: "confirmed",
    }],
  },
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
    root?.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container as HTMLElement
}

/**
 * Select a tab the way Radix listens for it.
 *
 * `HTMLElement.click()` alone is NOT enough: `TabsTrigger` switches on `mousedown`, so a bare
 * click leaves the tab exactly where it was — and a cardinality cell driven by a click that
 * changed nothing would pass vacuously. The `data-knowledge-state` assertions beside every call
 * are what keep that honest.
 */
async function selectTab(view: HTMLElement, label: string): Promise<void> {
  const trigger = Array.from(view.querySelectorAll('[role="tab"]'))
    .find(candidate => candidate.textContent === label)
  if (trigger === undefined) throw new Error(`no tab trigger reads ${label}`)

  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  await flushRender()
}

// 427 D-19: the per-step ledger sits behind the collapsed Retrieval details section.
async function openRetrievalDetails(view: HTMLElement): Promise<void> {
  const trigger = view.querySelector('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]')
  if (trigger === null) throw new Error("no Retrieval details trigger")
  await act(async () => { (trigger as HTMLElement).click() })
}

function knowledgeState(view: HTMLElement): string | null {
  return view.querySelector("[data-knowledge-state]")?.getAttribute("data-knowledge-state") ?? null
}

beforeEach(() => {
  document.title = ""
  Element.prototype.scrollIntoView = vi.fn()
  for (const mock of [
    fetchRunMock,
    fetchRunDetailMock,
    fetchRunKnowledgeMock,
    fetchRunArtifactMock,
    fetchExecutionLogsMock,
  ]) {
    mock.mockReset()
  }
  fetchRunMock.mockImplementation((id: string) => Promise.resolve({ run: runRow(id) }))
  fetchRunDetailMock.mockImplementation((id: string) => Promise.resolve(detailProjection(id)))
  fetchRunKnowledgeMock.mockResolvedValue(POPULATED)
  fetchRunArtifactMock.mockResolvedValue({
    run: { id: RUN_ID },
    artifact: null,
    children: [],
    missingSections: ["artifact"],
  })
  fetchExecutionLogsMock.mockResolvedValue({ logs: [] })
})

afterEach(() => {
  if (root) act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe("the page owns ONE runs.knowledge read per run id (D-05)", () => {
  it("reads exactly once for the id it was mounted at, and asks for that id", async () => {
    await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(fetchRunKnowledgeMock).toHaveBeenCalledTimes(1)
    expect(fetchRunKnowledgeMock).toHaveBeenCalledWith(RUN_ID)
  })

  it("does NOT read again when the page re-renders — a tab change is not a new run", async () => {
    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)
    expect(fetchRunKnowledgeMock).toHaveBeenCalledTimes(1)

    // A real re-render through the page's own state: selecting another tab.
    await selectTab(view, "Overview")
    // The switch really happened — Radix unmounts the inactive tab's content, so the knowledge
    // panel is GONE. Without this the assertion below would pass against a click that did nothing.
    expect(view.querySelector("[data-knowledge-state]")).toBeNull()

    await selectTab(view, "Knowledge")
    expect(view.querySelector("[data-knowledge-state]")).not.toBeNull()

    expect(fetchRunKnowledgeMock).toHaveBeenCalledTimes(1)
  })
})

describe("a rejected read is a STATE on the tab, never a skeleton that never resolves (D-06)", () => {
  it("lands the refusal on data-knowledge-state=error with the producer's own reason", async () => {
    fetchRunKnowledgeMock.mockRejectedValue(new Error("read_failed"))

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("error")
    expect(view.textContent).toContain(READ_FAILED_HEADING)
    expect(view.textContent).toContain(readFailedBody("read_failed"))
    expect(view.querySelector('[data-slot="skeleton"]')).toBeNull()
  })

  it("forwards a non-Error rejection as its string rather than swallowing it", async () => {
    fetchRunKnowledgeMock.mockRejectedValue("agent_host_unavailable")

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("error")
    expect(view.textContent).toContain("agent_host_unavailable")
  })

  it("keeps the tab's OWN absences on the read arm — a pruned handoff is not an error", async () => {
    fetchRunKnowledgeMock.mockResolvedValue({ kind: "evidence-incomplete", runId: RUN_ID })

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("evidence-incomplete")
  })

  it("says there is no store when the run was executed with no reader bound (D-16)", async () => {
    fetchRunKnowledgeMock.mockResolvedValue({ ...POPULATED, knowledgeStore: "unbound" })

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("empty-no-store")
    expect(view.textContent).toContain(NO_STORE_HEADING)
  })
})

describe("a populated read paints the Used half, end to end (D-03 / D-04 / D-08)", () => {
  it("derives the summary line and gives the served step its row", async () => {
    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)
    await openRetrievalDetails(view)

    expect(knowledgeState(view)).toBe("ready")
    expect(view.querySelector("[data-used-summary]")?.textContent)
      .toBe("1 step briefed · 1 canary line served · 1 procedure replay")

    const rowEl = view.querySelector("[data-step-index]")
    expect(rowEl?.getAttribute("data-plan-source")).toBe("procedure-replay")
    expect(rowEl?.getAttribute("data-canary-lines")).toBe("1")
  })

  it("expands the row onto the channels, the attributed canary and the replay outcome", async () => {
    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    await openRetrievalDetails(view)
    const trigger = view.querySelector('[data-step-index] [data-slot="collapsible-trigger"]')
    await act(async () => { (trigger as HTMLElement).click() })

    expect(view.textContent).toContain(CHANNEL_EYEBROWS[1])

    const briefLine = view.querySelector('li[data-served-channel="1"]')
    expect(briefLine?.getAttribute("data-served-as-canary")).toBe("true")
    expect(briefLine?.getAttribute("data-canary-outcome")).toBe("confirmed")
    expect(briefLine?.getAttribute("data-trace-state")).toBe("answered")

    expect(view.querySelector("[data-cut-candidates]")?.getAttribute("data-cut-candidates")).toBe("1")
    expect(view.querySelector("[data-plan-source-outcome]")?.textContent).toContain("replayed 5/5")
  })
})

describe("427 D-02 / D-04 / D-05: a record given in three steps reads as one content-led row in a four-part tab", () => {
  const SERVED_LINE = POPULATED.kind === "ready" ? POPULATED.steps[0]!.served.channel1[0]! : undefined
  const GROUPED: RunKnowledgeProjection = {
    ...POPULATED,
    steps: [0, 1, 2].map(stepIndex => ({
      testId: "t_checkout",
      testIndex: 0,
      stepIndex,
      stepText: `step text ${String(stepIndex)}`,
      served: { channel1: [{ ...SERVED_LINE!, servedAsCanary: false }], channel2: [], channel3: [] },
      trace: { kind: "no-trace" as const, reason: "pre-trace-run" as const },
    })),
    learned: { changes: [], canaryAttributions: [] },
  }

  it("TRACER-GROUPED-USE: the page paints the four sections in order and one grouped row with no record id", async () => {
    fetchRunKnowledgeMock.mockResolvedValue(GROUPED)

    const view = await renderAt(`/runs/${RUN_ID}`)
    await selectTab(view, "Knowledge")

    expect(knowledgeState(view)).toBe("ready")
    expect([...view.querySelectorAll("[data-knowledge-section]")].map(section => section.getAttribute("data-knowledge-section")))
      .toEqual(["used", "effect", "changes", "retrieval-details"])

    const used = view.querySelector('[data-knowledge-section="used"]')
    const records = used?.querySelectorAll("[data-used-record]") ?? []
    expect(records.length).toBe(1)
    expect(records[0]?.getAttribute("data-use-verbs")).toBe("given")
    expect(records[0]?.querySelector("[data-row-primary]")?.textContent).toBe(SERVED_LINE?.summary)
    expect(records[0]?.querySelector("[data-row-uses]")?.textContent).toBe("Given in steps 1–3")
    expect(used?.outerHTML).not.toContain(SERVED_LINE?.id)
  })
})

/**
 * THE ONE REAL `RecordChange` THIS FILE OWNS, hoisted to module scope (407-27).
 *
 * Two describes now need a projection that actually carries a committed change — the partial-read
 * block below and the failed-chain block that closes G-407-12 — and a second hand-typed copy of
 * the wire shape is a fixture that drifts the moment a member is added. One object, spread into
 * both, so a future `RecordChangeSchema` member either lands in both fixtures or in neither.
 */
const SERVED_CHANGE = {
  schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION,
  recordId: "fact-el-textbox-password-9a05ce",
  change: "confirmed" as const,
  atOrdinal: 2,
  sourceRunId: RUN_ID,
}

describe("a partial store read paints the rows it was handed AND says the read was partial (REVIEW CR-01)", () => {
  // THE OP'S OWN SANCTIONED SHAPE, crossed through the real client double, the real
  // `projectKnowledgeView` and the real `KnowledgeLearned`. `runs.knowledge` degrades its two
  // Learned enrichments INDEPENDENTLY, so a failed attribution scan beside a readable diff ships
  // a change row AND the flag. Everything below the wire must render that as a row with a stamp,
  // never as an assertion that the store could not be read.
  const PARTIAL = {
    ...POPULATED,
    learned: {
      ...POPULATED.learned,
      changes: [SERVED_CHANGE],
      scanIncomplete: true as const,
    },
  }

  it("lists the served change, stamps the root incomplete and prints the read note", async () => {
    fetchRunKnowledgeMock.mockResolvedValue(PARTIAL)

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("ready")

    const rows = view.querySelectorAll('li[data-record-change="confirmed"]')
    expect(rows.length).toBe(1)
    // 427 D-15/D-19: the row carries its bucket, never its id; the id reads in Retrieval details.
    expect(rows[0]?.hasAttribute("data-record-id")).toBe(false)
    await openRetrievalDetails(view)
    expect(view.querySelector('dl[data-ledger-changes] dd[data-ledger-row="record"]')?.textContent)
      .toBe("fact-el-textbox-password-9a05ce")

    const learned = view.querySelector("[data-learned-state]")
    expect(learned?.getAttribute("data-learned-read")).toBe("incomplete")
    expect(view.querySelector("[data-learned-sentence]")).toBeNull()
    expect(view.querySelector("[data-learned-read-note]")?.textContent)
      .toBe(STORE_READ_INCOMPLETE_TEXT)
  })

  it("keeps a canary outcome that WAS read — a partial read does not un-answer an answered line", async () => {
    fetchRunKnowledgeMock.mockResolvedValue(PARTIAL)

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    await openRetrievalDetails(view)
    const trigger = view.querySelector('[data-step-index] [data-slot="collapsible-trigger"]')
    await act(async () => { (trigger as HTMLElement).click() })

    expect(view.querySelector('li[data-served-channel="1"]')?.getAttribute("data-canary-outcome"))
      .toBe("confirmed")
  })

  // REVIEW WR-02 AT THE PAGE. The op ships `canaryAttributions: []` whenever the attribution scan
  // failed, so a served canary line under a settled chain has no row to join — and the word it
  // wears must be a question, not the positive claim that the store said no.
  it("says the attribution is UNKNOWN for a served canary the partial read never answered", async () => {
    fetchRunKnowledgeMock.mockResolvedValue({
      ...PARTIAL,
      learned: { ...PARTIAL.learned, canaryAttributions: [] },
    })

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    await openRetrievalDetails(view)
    const trigger = view.querySelector('[data-step-index] [data-slot="collapsible-trigger"]')
    await act(async () => { (trigger as HTMLElement).click() })

    expect(view.querySelector('li[data-served-channel="1"]')?.getAttribute("data-canary-outcome")).toBe("unknown")
    expect(view.textContent).toContain(ATTRIBUTION_UNKNOWN_TEXT)
    expect(view.querySelector("[data-learned-state]")?.getAttribute("data-learned-read"))
      .toBe("incomplete")
  })
})

describe("a served attribution row beats a FAILED curation chain, at the page (407-22 · owner ruling 2026-08-30, UAT item 11)", () => {
  // TWO QUESTIONS, TWO ANSWERS, ONE PAGE. `curation.status` comes from a sibling op; the
  // `canaryAttributions` rows come from the committed store walk. They are independent facts that
  // meet only in the view fold, and the tab has a place for each: the chip reports what the
  // curation chain did, the line reports what the store answered about THIS record. Until 407-22
  // the line answered with the chain's fate — printing `not attributed`, a positive claim that the
  // store was consulted and said no, beside a `confirmed` row held in the very same projection.
  //
  // Fixtures are SPREAD FROM THE READY ONE and override only `curation` and `learned`, so a future
  // wire member cannot quietly make these cells stop resembling the page they claim to measure.
  //
  // WHAT THE LEARNED HALF DOES UNDER A FAILED CHAIN HAS SINCE BEEN RULED ON, and this block's
  // first cell was rewritten to match (407-26/27 · REVIEW CR-01 / G-407-12 · owner ruling
  // 2026-08-31). It is NOT that the half correctly lists nothing while the chip reads `failed`:
  // the half lists whatever the store committed before the chain stopped, and states the chain's
  // fate beneath the list. The cell below asserts that painted row; the describe after this one
  // owns the note, the sentence it replaced, and the no-rows arm that did not move.

  async function expandedLineOf(projection: RunKnowledgeProjection) {
    fetchRunKnowledgeMock.mockResolvedValue(projection)
    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)
    await openRetrievalDetails(view)
    const trigger = view.querySelector('[data-step-index] [data-slot="collapsible-trigger"]')
    await act(async () => { (trigger as HTMLElement).click() })
    return { view, line: view.querySelector('li[data-served-channel="1"]') }
  }

  // THE FIXTURE CARRIES A COMMITTED CHANGE RECORD (407-27, repairing WINDOWS #315). It did not
  // when 407-22 wrote this block: `POPULATED.learned.changes` is `[]`, so the closing assertion
  // below — `li[data-record-change]` count — was zero whatever the failed arm did with rows, and
  // pinned nothing about the arm it was written under. `SERVED_CHANGE` is the same wire object
  // the partial-read block uses, so the count is now a reading of the LAW and would go red if the
  // chain-status ladder ever swallowed a served record again.
  const FAILED_WITH_ROW: RunKnowledgeProjection = {
    ...POPULATED,
    curation: { status: "failed" },
    learned: { ...POPULATED.learned, changes: [SERVED_CHANGE] },
  }

  it("paints the row's outcome on the line while the Learned half still reads failed — two facts, side by side", async () => {
    const { view, line } = await expandedLineOf(FAILED_WITH_ROW)

    expect(knowledgeState(view)).toBe("ready")

    // THE LINE ANSWERS FROM THE STORE. A chain that fell over cannot un-commit an outcome event it
    // already appended, and this projection is holding the row that proves it appended one.
    expect(line?.getAttribute("data-canary-outcome")).toBe("confirmed")
    expect(line?.textContent).toContain("confirmed")
    expect(view.textContent).not.toContain(NOT_ATTRIBUTED_TEXT)

    // THE CHIP ANSWERS FROM THE CHAIN, and it is not softened by the row. These are different
    // questions and the page answers each from its own evidence — which is the whole point of the
    // ruling: neither half is allowed to speak for the other.
    const learned = view.querySelector("[data-learned-state]")
    expect(learned?.getAttribute("data-learned-state")).toBe("failed")

    // AND THE LEARNED LIST IS NOT EMPTIED BY THE CHAIN'S FATE EITHER (407-26/27 · owner ruling
    // 2026-08-31). This assertion used to read `.length).toBe(0)` over a fixture with no change
    // records at all — green for a reason that had nothing to do with the failed arm. The fixture
    // now carries one, so the count is a reading: a chain that fell over after committing a
    // record does not un-commit it, and the record is on screen beside the `failed` chip.
    const changeRows = view.querySelectorAll("li[data-record-change]")
    expect(changeRows.length).toBe(1)
    expect(changeRows[0]?.hasAttribute("data-record-id")).toBe(false)
    // Retrieval details is already open: expandedLineOf opened it to reach the step line.
    expect(view.querySelector('dl[data-ledger-changes] dd[data-ledger-row="record"]')?.textContent)
      .toBe(SERVED_CHANGE.recordId)
  })

  // THE SUB-QUESTION THE RULING LEFT OPEN, crossed at the page on both of its halves. With no row
  // there is nothing the store served, so the word is decided by whether anybody could FINISH
  // LOOKING — never by the chain's fate, which is already reported by the chip above.
  it("says UNKNOWN for a failed chain with no row when the read was partial — nobody could finish looking", async () => {
    const { view, line } = await expandedLineOf({
      ...POPULATED,
      curation: { status: "failed" },
      learned: { ...POPULATED.learned, canaryAttributions: [], scanIncomplete: true },
    })

    expect(line?.getAttribute("data-canary-outcome")).toBe("unknown")
    expect(view.textContent).toContain(ATTRIBUTION_UNKNOWN_TEXT)
  })

  it("says NOT-ATTRIBUTED for a failed chain with no row when the read was CLEAN — the walk finished and found nothing", async () => {
    const { view, line } = await expandedLineOf({
      ...POPULATED,
      curation: { status: "failed" },
      learned: { ...POPULATED.learned, canaryAttributions: [] },
    })

    expect(line?.getAttribute("data-canary-outcome")).toBe("not-attributed")
    expect(view.textContent).toContain(NOT_ATTRIBUTED_TEXT)
  })
})

describe("the Learned half paints what a failed chain committed, and states its fate beneath (407-26/27 · owner ruling 2026-08-31, REVIEW CR-01 / G-407-12)", () => {
  // THE SAME LAW AS THE BLOCK ABOVE, ONE HALF OVER. 407-22 settled it for the canary line: a
  // chain that fell over cannot un-answer a line the store already answered. This settles it for
  // the record list — a chain that fell over cannot un-commit a record it already wrote — and the
  // half now reports the failure BESIDE the list instead of printing a sentence over the top of
  // it saying nothing was learned, which the very projection carrying those records disproves.
  //
  // CROSSED END TO END, deliberately: the real client double, the real `projectKnowledgeView`
  // fold 407-26 hoisted, and the real `KnowledgeLearned` paragraph 407-27 added. A cell that
  // rendered the component directly would stay green if either the fold or the renderer regressed.
  const FAILED_WITH_CHANGES: RunKnowledgeProjection = {
    ...POPULATED,
    curation: { status: "failed" },
    learned: { ...POPULATED.learned, changes: [SERVED_CHANGE] },
  }

  it("lists the committed record and prints the chain note — and NO sentence denying it", async () => {
    fetchRunKnowledgeMock.mockResolvedValue(FAILED_WITH_CHANGES)

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(knowledgeState(view)).toBe("ready")

    const rows = view.querySelectorAll("li[data-record-change]")
    expect(rows.length).toBe(1)
    expect(rows[0]?.hasAttribute("data-record-id")).toBe(false)
    await openRetrievalDetails(view)
    expect(view.querySelector('dl[data-ledger-changes] dd[data-ledger-row="record"]')?.textContent)
      .toBe(SERVED_CHANGE.recordId)

    expect(view.querySelector("[data-learned-chain-note]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)

    // THE FALSIFIABLE CLAIM IS GONE FROM THE PAGE, not merely moved: the sentence slot is empty
    // and the words `nothing was learned from this run` appear nowhere above a painted record.
    expect(view.querySelector("[data-learned-sentence]")).toBeNull()
    expect(view.textContent).not.toContain(CURATION_FAILED_TEXT)

    // AND THE CHIP STILL REPORTS THE CHAIN. The two facts sit side by side, which is exactly the
    // pair 407-22 established on the Used half — neither half speaks for the other.
    expect(view.querySelector("[data-learned-state]")?.getAttribute("data-learned-state"))
      .toBe("failed")
  })

  it("prints BOTH notes when that failed chain's records arrive over a partly-read store", async () => {
    fetchRunKnowledgeMock.mockResolvedValue({
      ...FAILED_WITH_CHANGES,
      learned: { ...FAILED_WITH_CHANGES.learned, scanIncomplete: true as const },
    })

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(view.querySelectorAll("li[data-record-change]").length).toBe(1)

    const learned = view.querySelector("[data-learned-state]")
    expect(learned?.getAttribute("data-learned-read")).toBe("incomplete")
    expect(view.querySelector("[data-learned-chain-note]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(view.querySelector("[data-learned-read-note]")?.textContent)
      .toBe(STORE_READ_INCOMPLETE_TEXT)

    // Two producers, two paragraphs, in the order the component argues for: the chain note is
    // about the list on screen, the read note about how much of the store anyone could see.
    const notes = [...view.querySelectorAll<HTMLElement>(
      "p[data-learned-chain-note], p[data-learned-read-note]",
    )]
    expect(notes.map(note => note.textContent))
      .toEqual([CURATION_FAILED_PARTIAL_TEXT, STORE_READ_INCOMPLETE_TEXT])
  })

  it("still prints the APPROVED sentence, and no note, when the failed chain committed nothing", async () => {
    // The arm that did not move, pinned at the page so the round can show it did not move.
    fetchRunKnowledgeMock.mockResolvedValue({ ...POPULATED, curation: { status: "failed" } })

    const view = await renderAt(`/runs/${RUN_ID}?tab=knowledge`)

    expect(view.querySelector("[data-learned-sentence]")?.textContent).toBe(CURATION_FAILED_TEXT)
    expect(view.querySelectorAll("li[data-record-change]").length).toBe(0)
    expect(view.querySelector("[data-learned-chain-note]")).toBeNull()
    expect(view.querySelector("[data-learned-state]")?.getAttribute("data-learned-state"))
      .toBe("failed")
  })
})

/**
 * 427 D-03 · UI-SPEC S3: every step number in the Knowledge used rows is a control that selects its
 * step on the page (Open Question 4 follows onCitedStep: an address that exists anywhere in the run
 * is a control, and activation widens a hiding member filter; an address the run does not contain
 * is plain text).
 */
describe("427 D-03: a step reference in Knowledge used takes the reader to that step", () => {
  function servedLine(id: string, summary: string) {
    return { id, kind: "fact", summary, trust: 0.9, status: "active", servedAsCanary: false, tier: "confirmed" }
  }

  function knowledgeStep(testIndex: number, stepIndex: number, channel1: ReturnType<typeof servedLine>[]) {
    return {
      testId: `t_${String(testIndex)}`,
      testIndex,
      stepIndex,
      stepText: `step text ${String(testIndex)}:${String(stepIndex)}`,
      served: { channel1, channel2: [], channel3: [] },
      trace: { kind: "no-trace" as const, reason: "pre-trace-run" as const },
    }
  }

  function knowledgeOf(steps: ReturnType<typeof knowledgeStep>[]): RunKnowledgeProjection {
    return { ...POPULATED, steps, learned: { changes: [], canaryAttributions: [] } } as RunKnowledgeProjection
  }

  const shaOf = (testIndex: number, stepIndex: number) => `${String(testIndex)}${String(stepIndex)}`.repeat(32)

  function steppedDetail(id: string, members: { testIndex: number; name: string; steps: number }[]) {
    const addresses = members.flatMap(member =>
      Array.from({ length: member.steps }, (_, stepIndex) => ({ testIndex: member.testIndex, stepIndex })))
    return {
      runId: id,
      members: members.map(member => ({ testIndex: member.testIndex, attempts: 1, name: member.name, outcome: "passed" as const })),
      steps: addresses.map(({ testIndex, stepIndex }) => ({
        testIndex,
        stepIndex,
        stepText: `Step ${String(stepIndex + 1)}`,
        cacheStatus: "miss" as const,
        verifierVerdict: { pass: true, reasoning: "looks right" },
        selfHealOccurred: false,
        briefDigest: "d00",
        status: "passed" as const,
        durationMs: 1000,
      })),
      subActions: addresses.map(({ testIndex, stepIndex }) => ({
        testIndex,
        stepIndex,
        subActionIndex: 0,
        plan: `Action ${String(testIndex)}:${String(stepIndex)}`,
        plannedAction: { type: "click", ref: asRef(`button-${String(testIndex)}-${String(stepIndex)}`) },
        screenStateHash: "f".repeat(64),
        result: { success: true },
        artifactRefs: [{ id: `decision-screenshot:${shaOf(testIndex, stepIndex)}`, sha: shaOf(testIndex, stepIndex) }],
      })),
      tokens: { measuredSteps: 0, unmeasuredSteps: addresses.length },
    }
  }

  function LocationProbe() {
    const location = useLocation()
    return <output data-location={location.search} />
  }

  async function renderWithLocation(url: string): Promise<HTMLElement> {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe />
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })
    await flushRender()
    return container as HTMLElement
  }

  function query(view: HTMLElement): URLSearchParams {
    return new URLSearchParams(view.querySelector("[data-location]")?.getAttribute("data-location") ?? "")
  }

  function selectedStepId(view: HTMLElement): string | null {
    return view.querySelector('[role="treeitem"][data-step-id][aria-selected="true"]')?.getAttribute("data-step-id") ?? null
  }

  function playheadRow(view: HTMLElement): string | null {
    return view.querySelector("[data-playhead-row]")?.getAttribute("data-sub-action-id") ?? null
  }

  async function activate(control: HTMLElement): Promise<void> {
    await act(async () => {
      control.focus()
      control.click()
    })
    await flushRender()
  }

  it("STEP-REF-SELECTS-STEP: selects the step, parks the playhead there, keeps the Knowledge tab and the focus", async () => {
    fetchRunDetailMock.mockImplementation((id: string) =>
      Promise.resolve(steppedDetail(id, [{ testIndex: 0, name: "Checkout", steps: 3 }])))
    const cart = servedLine("rec_cart", "the cart page lives at /view_cart")
    const coupon = servedLine("rec_coupon", "coupons apply on the review step")
    fetchRunKnowledgeMock.mockResolvedValue(knowledgeOf([
      knowledgeStep(0, 0, [cart]),
      knowledgeStep(0, 1, [cart, coupon]),
      knowledgeStep(0, 2, [cart]),
    ]))

    const view = await renderWithLocation(`/runs/${RUN_ID}?tab=knowledge`)
    expect(knowledgeState(view)).toBe("ready")
    expect([...view.querySelectorAll("[data-row-uses]")].map(line => line.textContent))
      .toEqual(["Given in steps 1–3", "Given in step 2"])
    expect(selectedStepId(view)).toBe("0:0")

    const control = view.querySelector<HTMLElement>('button[data-step-ref][data-step-ref-test="0"][data-step-ref-step="1"]')
    expect(control).not.toBeNull()
    await activate(control!)

    expect(selectedStepId(view)).toBe("0:1")
    expect(playheadRow(view)).toBe("0:1-0")
    expect(query(view).get("step")).toBe("0:1")
    expect(knowledgeState(view)).toBe("ready")
    expect(view.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Knowledge")
    expect(document.activeElement).toBe(control)

    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))) })
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts
    expect(scrolled).toContain(view.querySelector('[data-step-id="0:1"]'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" })
  })

  it("STEP-REF-HIDDEN-MEMBER-WIDENS: a reference to a member the filter hides widens the filter, then selects", async () => {
    fetchRunDetailMock.mockImplementation((id: string) =>
      Promise.resolve(steppedDetail(id, [
        { testIndex: 0, name: "checkout", steps: 2 },
        { testIndex: 1, name: "login", steps: 1 },
      ])))
    const shared = servedLine("rec_shared", "the session cookie is named sid")
    fetchRunKnowledgeMock.mockResolvedValue(knowledgeOf([
      knowledgeStep(0, 1, [shared]),
      knowledgeStep(1, 0, [shared]),
    ]))

    const view = await renderWithLocation(`/runs/${RUN_ID}?tab=knowledge&member=0`)
    expect(knowledgeState(view)).toBe("ready")
    expect(view.querySelector('[data-step-id="1:0"]')).toBeNull()

    expect(view.querySelector("[data-row-uses]")?.textContent).toBe("Given in checkout · step 2; login · step 1")
    const control = view.querySelector<HTMLElement>('button[data-step-ref][data-step-ref-test="1"][data-step-ref-step="0"]')
    expect(control).not.toBeNull()
    expect(control?.getAttribute("aria-label")).toBe("Go to login · step 1 · step text 1:0")
    await activate(control!)

    expect(query(view).has("member")).toBe(false)
    expect(selectedStepId(view)).toBe("1:0")
    expect(knowledgeState(view)).toBe("ready")
  })

  it("STEP-REF-UNRESOLVABLE-PLAIN: an address the run detail does not contain is plain text, not a button", async () => {
    fetchRunDetailMock.mockImplementation((id: string) =>
      Promise.resolve(steppedDetail(id, [{ testIndex: 0, name: "Checkout", steps: 2 }])))
    const cart = servedLine("rec_cart", "the cart page lives at /view_cart")
    fetchRunKnowledgeMock.mockResolvedValue(knowledgeOf([
      knowledgeStep(0, 0, [cart]),
      knowledgeStep(0, 5, [cart]),
    ]))

    const view = await renderWithLocation(`/runs/${RUN_ID}?tab=knowledge`)
    const uses = view.querySelector("[data-row-uses]")
    expect(uses?.textContent).toBe("Given in steps 1 and 6")

    expect(uses?.querySelector('button[data-step-ref][data-step-ref-step="0"]')?.textContent).toBe("1")
    expect(uses?.querySelector('[data-step-ref-step="5"]')).toBeNull()
    expect([...(uses?.querySelectorAll("button") ?? [])].map(button => button.textContent)).toEqual(["1"])
    const plain = [...(uses?.querySelectorAll("span.tabular-nums") ?? [])].filter(span => span.textContent === "6")
    expect(plain).toHaveLength(1)
    expect(plain[0]?.hasAttribute("data-step-ref")).toBe(false)
  })
})
