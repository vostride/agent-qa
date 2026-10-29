import { RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom

// THE KNOWLEDGE TAB A PERSON ACTUALLY SEES.
//
// WHY THESE CELLS RENDER INTO `document.body` THROUGH `createRoot`. That is the call `main.tsx`
// makes. A component mounted into a detached node can satisfy every query in a file like this one
// while the real mount path is broken, and the cell would never know.
//
// THE DOM CONTRACT IS THE SUBJECT, not the styling. `data-knowledge-state`, `data-used-summary`,
// `data-step-index`, `data-test-index`, `data-plan-source`, `data-brief-lines` and
// `data-canary-lines` are what the later plans' Playwright cells address on the built bundle, so
// every one of them is pinned here in the cheap medium first. Colours and badge variants are
// deliberately NOT asserted — a cell that pinned `bg-muted/40` would go red on a design change
// that broke nothing a person relies on. The two class assertions that DO appear (`break-words`
// on the error body) pin a legibility rule the Copywriting Contract states, not a look.
//
// THE FIVE STATE CELLS ARE THE POINT. D-06 and D-16 exist because a tab that renders blank when
// its read has not landed, or when the project has no store, is indistinguishable from a tab
// whose op is broken. Each state is asserted BY ATTRIBUTE and by its own sentence, and the
// loading cell additionally asserts the absence of any text at all.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import {
  CurationSnapshotSchema,
  RunKnowledgeProjectionSchema,
  type RunKnowledgeProjection,
} from "@vostride/agent-qa-schema"

import { TabKnowledge } from "@/components/run-detail/tab-knowledge"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  NO_MEMORY_CHANGES_SENTENCE,
  CHANNEL_EYEBROWS,
  EFFECT_HEADING,
  EFFECT_NOTHING_USED_TEXT,
  KNOWLEDGE_SECTIONS,
  MEMORY_CHANGES_HEADING,
  NO_BRIEF_LINES_TEXT,
  NO_BRIEF_SERVED_TEXT,
  NO_STORE_BODY,
  NO_STORE_HEADING,
  READ_FAILED_HEADING,
  RECORD_UNREADABLE_LEAD,
  STEP_NO_BRIEF_TEXT,
  USED_HEADING,
  CURATION_FAILED_PARTIAL_TEXT,
  CURATION_FAILED_TEXT,
  projectKnowledgeView,
  readFailedBody,
  type KnowledgeView,
  type LearnedView,
  type StepRowView,
} from "@/lib/knowledge-view"
import { legacyCurationPairText } from "@/lib/post-processing-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  // `tab-panels.tsx` wraps the tab in this provider; bucket labels are tooltip triggers.
  act(() => { root?.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>) })
  return container
}

/** One step row, ready to paint. The projection has its own cells; these build views by hand. */
function row(overrides: Partial<StepRowView> = {}): StepRowView {
  return {
    testIndex: 0,
    stepIndex: 0,
    title: "Step 1 — click checkout",
    briefLines: 2,
    canaryLines: 1,
    planSource: "none",
    facts: ["2 brief lines", "1 canary"],
    detail: { channel1: [], channel2: [], channel3: [] },
    ...overrides,
  }
}

const LEARNED_NOTHING: LearnedView = {
  state: "complete",
  countLine: legacyCurationPairText(0, 0),
  sentence: NO_MEMORY_CHANGES_SENTENCE,
  rows: [],
}

function readyView(
  steps: StepRowView[],
  summary = "1 step briefed · 1 canary line served",
  learned: LearnedView = LEARNED_NOTHING,
): KnowledgeView {
  return {
    state: "ready",
    used: { records: [], absence: steps.length === 0 ? NO_BRIEF_SERVED_TEXT : NO_BRIEF_LINES_TEXT },
    effect: { entries: [], absence: EFFECT_NOTHING_USED_TEXT },
    ledger: { summary, steps, changes: [] },
    learned,
  }
}

// the per-step ledger renders only once the collapsed Retrieval details is opened.
function openRetrievalDetails(view: HTMLElement): void {
  const trigger = view.querySelector('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]')
  if (trigger === null) throw new Error("no Retrieval details trigger")
  act(() => { (trigger as HTMLElement).click() })
}

function stateOf(view: HTMLElement): string | null {
  return view.querySelector("[data-knowledge-state]")?.getAttribute("data-knowledge-state") ?? null
}

describe("the first read has not landed (UI-SPEC page-level states)", () => {
  it("renders three skeleton bars and NOT ONE WORD — a sentence here would be a guess", () => {
    const view = mount(<TabKnowledge view={undefined} />)

    expect(stateOf(view)).toBe("loading")
    expect(view.querySelectorAll('[data-slot="skeleton"]').length).toBe(3)
    expect(view.textContent).toBe("")
  })
})

describe("the read failed or was refused", () => {
  it("states the failure, forwards the masked reason and points at doctor", () => {
    const error = "read_failed"
    const view = mount(<TabKnowledge view={{ state: "error", heading: READ_FAILED_HEADING, body: readFailedBody(error) }} />)

    expect(stateOf(view)).toBe("error")
    expect(view.textContent).toContain(READ_FAILED_HEADING)
    expect(view.textContent).toContain(error)
    expect(view.textContent).toContain("agent-qa doctor")
  })

  it("lets a long masked reason WRAP rather than truncate the doctor pointer away", () => {
    const view = mount(<TabKnowledge view={{ state: "error", heading: READ_FAILED_HEADING, body: readFailedBody("x".repeat(200)) }} />)

    const body = view.querySelector("p")
    expect(body).not.toBeNull()
    expect(body?.className).toContain("break-words")
    expect(body?.className).not.toContain("truncate")
  })
})

describe("the handoff was pruned", () => {
  it("renders the SHIPPED evidence-incomplete pane rather than inventing a second wording", () => {
    const view = mount(<TabKnowledge view={{ state: "evidence-incomplete" }} />)

    expect(stateOf(view)).toBe("evidence-incomplete")
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
  })
})

describe("the project has no knowledge store", () => {
  it("says so, and says the one thing that changes it", () => {
    const view = mount(<TabKnowledge view={{ state: "empty-no-store", heading: NO_STORE_HEADING, body: NO_STORE_BODY }} />)

    expect(stateOf(view)).toBe("empty-no-store")
    expect(view.textContent).toContain(NO_STORE_HEADING)
    expect(view.textContent).toContain(NO_STORE_BODY)
  })
})

describe("a ready panel paints the Used half from the view it was handed", () => {
  it("heads the half, prints the derived summary, and gives every step its own row", () => {
    const steps = [
      row({ testIndex: 0, stepIndex: 0, briefLines: 3, canaryLines: 1, facts: ["3 brief lines", "1 canary"] }),
      row({ testIndex: 1, stepIndex: 4, title: "Step 5 — pay", briefLines: 1, canaryLines: 0, planSource: "procedure-replay", facts: ["1 brief line", "replay"] }),
    ]
    const view = mount(<TabKnowledge view={readyView(steps, "2 steps briefed · 1 canary line served · 1 procedure replay")} />)

    expect(stateOf(view)).toBe("ready")

    const heading = view.querySelector("h4")
    expect(heading?.textContent).toBe(USED_HEADING)

    openRetrievalDetails(view)

    const summary = view.querySelector("[data-used-summary]")
    expect(summary?.textContent).toBe("2 steps briefed · 1 canary line served · 1 procedure replay")

    const rows = Array.from(view.querySelectorAll("[data-step-index]"))
    expect(rows.length).toBe(2)
    expect(rows.map(r => r.getAttribute("data-step-index"))).toEqual(["0", "4"])
    expect(rows.map(r => r.getAttribute("data-test-index"))).toEqual(["0", "1"])
    expect(rows.map(r => r.getAttribute("data-plan-source"))).toEqual(["none", "procedure-replay"])
    expect(rows.map(r => r.getAttribute("data-brief-lines"))).toEqual(["3", "1"])
    expect(rows.map(r => r.getAttribute("data-canary-lines"))).toEqual(["1", "0"])
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining("Step 1 — click checkout"),
      expect.stringContaining("Step 5 — pay"),
    ])
  })

  it("LEDGER-IN-RETRIEVAL-DETAILS: the step rows render only inside a closed Retrieval details, and each opens CLOSED", () => {
    const view = mount(<TabKnowledge view={readyView([row(), row({ stepIndex: 1, title: "Step 2 — pay" })])} />)

    const details = view.querySelector('[data-knowledge-section="retrieval-details"]')
    expect(details?.querySelector('[data-slot="collapsible"]')?.getAttribute("data-state")).toBe("closed")
    expect(view.querySelectorAll("[data-step-index]").length).toBe(0)
    expect(view.querySelector("[data-used-summary]")).toBeNull()

    openRetrievalDetails(view)

    expect(details?.querySelector('[data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open")
    const rows = Array.from(view.querySelectorAll("[data-step-index]"))
    expect(rows.map(r => r.getAttribute("data-step-index"))).toEqual(["0", "1"])
    expect(rows.every(r => details?.contains(r) === true)).toBe(true)
    expect(rows.map(r => r.getAttribute("data-state"))).toEqual(["closed", "closed"])
    expect(rows.every(r => r.querySelector('[data-slot="collapsible-trigger"]') !== null)).toBe(true)
  })

  it("says a step served nothing in MUTED TEXT, never as a badge — an empty fact is not a fact", () => {
    const view = mount(<TabKnowledge view={readyView([row({ briefLines: 0, canaryLines: 0, facts: [], noBrief: true })])} />)
    openRetrievalDetails(view)

    const rowEl = view.querySelector("[data-step-index]") as HTMLElement
    expect(rowEl.textContent).toContain(STEP_NO_BRIEF_TEXT)
    expect(rowEl.querySelectorAll('[data-slot="badge"]').length).toBe(0)
    expect(rowEl.getAttribute("data-brief-lines")).toBe("0")
  })

  it("renders one outline badge per fact on a briefed row", () => {
    const view = mount(<TabKnowledge view={readyView([row({ facts: ["2 brief lines", "1 canary", "hint"], planSource: "procedure-hint" })])} />)
    openRetrievalDetails(view)

    const badges = Array.from(view.querySelectorAll('[data-slot="badge"]'))
    expect(badges.map(b => b.textContent)).toEqual(["2 brief lines", "1 canary", "hint"])
  })

  it("fills the row's detail slot with the channel sections it was served once it is expanded", () => {
    const view = mount(<TabKnowledge view={readyView([row({
      detail: {
        channel1: [{
          id: "rec_1",
          kind: "fact",
          summary: "the cart page lives at /view_cart",
          trust: 0.9,
          status: "active",
          servedAsCanary: true,
          tier: "confirmed",
          why: { kind: "answered", leg: "anchor", rank: 1, score: 1.48695 },
          canaryOutcome: "confirmed",
        }],
        channel2: [],
        channel3: [],
      },
    })])} />)

    // Closed, the detail is not in the document at all — Radix mounts the content on open.
    expect(view.textContent).not.toContain(CHANNEL_EYEBROWS[1])

    openRetrievalDetails(view)
    expect(view.textContent).not.toContain(CHANNEL_EYEBROWS[1])
    act(() => { (view.querySelector('[data-step-index] [data-slot="collapsible-trigger"]') as HTMLElement).click() })

    const slot = view.querySelector("[data-step-detail]")
    expect(slot).not.toBeNull()
    expect(slot?.textContent).toContain(CHANNEL_EYEBROWS[1])
    expect(slot?.textContent).not.toContain(CHANNEL_EYEBROWS[2])
    expect(slot?.textContent).not.toContain(CHANNEL_EYEBROWS[3])
    expect(view.querySelector('li[data-served-channel="1"][data-canary-outcome="confirmed"]')).not.toBeNull()
  })

  it("prints the no-brief-served sentence and NO rows when the run had no steps at all", () => {
    const view = mount(<TabKnowledge view={readyView([], NO_BRIEF_SERVED_TEXT)} />)

    expect(stateOf(view)).toBe("ready")
    const used = view.querySelector('[data-knowledge-section="used"]')
    expect(used?.querySelector("[data-section-absence]")?.textContent).toBe(NO_BRIEF_SERVED_TEXT)
    expect(used?.querySelectorAll("[data-used-record]").length).toBe(0)
    openRetrievalDetails(view)
    expect(view.querySelectorAll("[data-step-index]").length).toBe(0)
  })
})

describe("producer text reaches the DOM as TEXT, never as markup", () => {
  it("renders a hostile step title as a text node — no element is created from it", () => {
    const hostile = "Step 1 — <img src=x onerror=alert(1)>"
    const view = mount(<TabKnowledge view={readyView([row({ title: hostile })])} />)
    openRetrievalDetails(view)

    expect(view.querySelector("img")).toBeNull()
    expect(view.textContent).toContain("<img src=x onerror=alert(1)>")
  })

  it("renders a hostile masked error as a text node too", () => {
    const hostile = "<img src=x onerror=alert(1)>"
    const view = mount(<TabKnowledge view={{ state: "error", heading: READ_FAILED_HEADING, body: readFailedBody(hostile) }} />)

    expect(view.querySelector("img")).toBeNull()
    expect(view.textContent).toContain(hostile)
  })
})

// THE FOUR SECTIONS, IN ORDER (427 · D-02, SC1). Knowledge used, then its effect, then what the
// run wrote back, then the collapsed ledger — and each of the first three states itself when empty.
describe("the ready arm paints four sections in KNOWLEDGE_SECTIONS order", () => {
  function allZeroView(): KnowledgeView {
    const projection = RunKnowledgeProjectionSchema.parse({
      kind: "ready", runId: "run-427-01-absence", buildOrdinal: 2, knowledgeStore: "bound", steps: [],
      curation: { status: "complete", counts: { curated: 0, deprecated: 0 } },
      learned: {
        changes: [], canaryAttributions: [],
        curationSnapshot: CurationSnapshotSchema.parse({
          schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
        }),
      },
    })
    return projectKnowledgeView({ kind: "read", projection })
  }

  it("SECTIONS-IN-ORDER: the ready arm's sections read in the published order", () => {
    const view = mount(<TabKnowledge view={readyView([row(), row({ stepIndex: 1 })])} />)

    expect([...view.querySelectorAll("[data-knowledge-section]")].map(section => section.getAttribute("data-knowledge-section")))
      .toEqual([...KNOWLEDGE_SECTIONS])
  })

  it("SECTION-ABSENCE-NOT-EMPTY: a run that used and changed nothing states each absence in one sentence and paints no empty list", () => {
    const view = mount(<TabKnowledge view={allZeroView()} />)

    expect(stateOf(view)).toBe("ready")
    expect([...view.querySelectorAll("h4")].map(heading => heading.textContent))
      .toEqual([USED_HEADING, EFFECT_HEADING, MEMORY_CHANGES_HEADING])
    for (const name of ["used", "effect", "changes"]) {
      const section = view.querySelector(`[data-knowledge-section="${name}"]`)
      expect(section?.querySelectorAll("[data-section-absence]").length).toBe(1)
      expect(section?.querySelectorAll("ul").length).toBe(0)
    }
    expect(view.querySelector('[data-knowledge-section="used"] [data-section-absence]')?.textContent).toBe(NO_BRIEF_SERVED_TEXT)
    expect(view.querySelector('[data-knowledge-section="effect"] [data-section-absence]')?.textContent).toBe(EFFECT_NOTHING_USED_TEXT)
    expect(view.querySelector('[data-knowledge-section="changes"] [data-section-absence]')?.textContent).toBe(NO_MEMORY_CHANGES_SENTENCE)
  })

  it("the Memory changes section renders its heading on every ready run", () => {
    const views: KnowledgeView[] = [
      readyView([row()]),
      readyView([], NO_BRIEF_SERVED_TEXT),
      pageView("pending", {}),
      pageView("failed", {}),
      allZeroView(),
    ]
    for (const knowledge of views) {
      const view = mount(<TabKnowledge view={knowledge} />)
      const changes = view.querySelector('[data-knowledge-section="changes"]')
      expect(changes?.querySelector("h4")?.textContent).toBe(MEMORY_CHANGES_HEADING)
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
      container = undefined
    }
  })
})

// 423 D-15 · WIN #313, ON THE PAGE'S OWN PATH. The tab is fed exactly what `run-detail.tsx` feeds
// it: a schema-valid `runs.knowledge` projection folded by `projectKnowledgeView`. A fix that held
// only for hand-built views would pass the cells above while the page dropped the rows.
const RUN_423 = "run-423-24-tab"
type ReadyProjection = Extract<RunKnowledgeProjection, { kind: "ready" }>
type LearnedChange = ReadyProjection["learned"]["changes"][number]

function change(recordId: string, kind: LearnedChange["change"], atOrdinal: number, extra: Partial<LearnedChange> = {}) {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION, recordId, change: kind, atOrdinal, sourceRunId: RUN_423,
    evidenceToken: `receipt-${recordId}-${String(atOrdinal)}`, ...extra,
  }
}

function joined(row: LearnedChange): LearnedChange {
  return {
    ...row,
    recordContent: {
      content: `body ${row.recordId}`, summary: `summary ${row.recordId}`, kind: "fact",
      applicability: { product: "shop", scope: "checkout", anchors: [], openedAtOrdinal: 1 },
      currentStatus: "active",
      currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 30 },
    },
  }
}

function snapshot() {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: "fact-added", bucket: "added", changes: [{ bucket: "added", change: change("fact-added", "added", 20) }] },
      { recordId: "fact-confirmed", bucket: "confirmed", changes: [{ bucket: "confirmed", change: change("fact-confirmed", "confirmed", 21) }] },
      { recordId: "fact-victim", bucket: "superseded", byRecordId: "fact-replacement", changes: [
        { bucket: "superseded", change: change("fact-victim", "superseded", 22, { byRecordId: "fact-replacement" }) },
        { bucket: "added", change: change("fact-replacement", "added", 22) },
      ] },
      { recordId: "fact-deprecated", bucket: "deprecated", changes: [{ bucket: "deprecated", change: change("fact-deprecated", "deprecated", 23) }] },
      { recordId: "fact-proposed", bucket: "proposed", changes: [{ bucket: "proposed", change: change("fact-proposed", "added", 24) }] },
    ],
    breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
  })
}

function pageView(status: ReadyProjection["curation"]["status"], learned: Partial<ReadyProjection["learned"]>): KnowledgeView {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready", runId: RUN_423, buildOrdinal: 2, knowledgeStore: "bound", steps: [],
    curation: { status, ...(status === "complete" ? { counts: { curated: 4, deprecated: 1 } } : {}) },
    learned: { changes: [], canaryAttributions: [], ...learned },
  })
  return projectKnowledgeView({ kind: "read", projection })
}

function learnedRows(view: HTMLElement): HTMLElement[] {
  return [...view.querySelectorAll<HTMLElement>("li[data-record-change]")]
}

describe("the page path keeps failed-chain rows and states the snapshot sections", () => {
  it("FAILED-CHAIN-ROWS-RETAINED: a failed chain's joined and absent changes reach the tab as rows", () => {
    const view = mount(<TabKnowledge view={pageView("failed", {
      changes: [
        joined(change("fact-before-failure", "added", 20)),
        { ...change("fact-purged-since", "confirmed", 21), contentAbsence: { reason: "not-found" } },
      ],
      scanIncomplete: true,
    })} />)

    expect(view.querySelector("[data-learned-state]")?.getAttribute("data-learned-state")).toBe("failed")
    expect(learnedRows(view).map(row => row.getAttribute("data-record-change"))).toEqual(["added", "confirmed"])
    expect(learnedRows(view).map(row => row.querySelector("[data-row-primary]")?.textContent))
      .toEqual(["summary fact-before-failure", RECORD_UNREADABLE_LEAD])
    expect(learnedRows(view).some(row => row.hasAttribute("data-record-id"))).toBe(false)
    expect(view.querySelector("[data-learned-chain-note]")?.textContent).toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(view.querySelector("[data-learned-state]")?.getAttribute("data-learned-read")).toBe("incomplete")
    expect(view.textContent).not.toContain(CURATION_FAILED_TEXT)
  })

  it("FAILED-NO-SNAPSHOT: the tab states the absent snapshot and paints no since-then count", () => {
    const view = mount(<TabKnowledge view={pageView("failed", { changes: [joined(change("fact-before-failure", "added", 20))] })} />)
    const section = view.querySelector("[data-learned-state]")

    expect(section?.getAttribute("data-learned-snapshot")).toBe("absent")
    expect(section?.hasAttribute("data-learned-since-then")).toBe(false)
    expect(view.querySelector("[data-learned-count-line]")).toBeNull()
    expect(learnedRows(view).length).toBe(1)
  })

  it("LATER-LINKED-ROWS: curation rows and a later promotion both reach the tab, sectioned by the op's own lists", () => {
    const recorded = snapshot()
    const curation = recorded.rows.flatMap(row => row.changes.map(entry => joined(entry.change)))
    const later = joined(change("fact-added", "promoted", 91))
    const view = mount(<TabKnowledge view={pageView("complete", {
      changes: [...curation, later], curationSnapshot: recorded, sinceThen: { changes: [later], count: 1 },
    })} />)
    const section = view.querySelector("[data-learned-state]")

    expect(section?.getAttribute("data-learned-snapshot")).toBe("recorded")
    expect(section?.getAttribute("data-learned-since-then")).toBe("1")
    // the curation rows are the snapshot's five records, and the later promotion
    // reads Confirmed in its own open "Since this run" subsection.
    expect(learnedRows(view).map(row => row.getAttribute("data-learned-section")))
      .toEqual([...recorded.rows.map(() => "curation"), "since-then"])
    expect(learnedRows(view).at(-1)?.getAttribute("data-record-change")).toBe("confirmed")
    expect(learnedRows(view).at(-1)?.closest("[data-since-this-run]")?.getAttribute("data-since-this-run")).toBe("1")
  })
})
