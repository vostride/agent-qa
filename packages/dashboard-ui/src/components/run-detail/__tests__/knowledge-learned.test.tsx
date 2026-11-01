import { RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom

// Rendered into `document.body` through `createRoot`, as `main.tsx` does, so the mount is real.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CurationSnapshotSchema,
  RunKnowledgeProjectionSchema,
  formatEntityUri,
  type RunKnowledgeProjection,
} from "@vostride/agent-qa-schema"

import { KnowledgeLearned } from "@/components/run-detail/knowledge-learned"
import { RetrievalDetails } from "@/components/run-detail/retrieval-details"
import {
  BREAKDOWN_NOT_RECORDED_TEXT,
  COUNTS_NOT_RECORDED_TEXT,
  curationBreakdownLine,
  legacyCurationPairText,
} from "@/lib/post-processing-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  BUCKET_LABELS,
  BUCKET_MEANINGS,
  CHANGES_NOT_AVAILABLE_TEXT,
  CHANGES_PENDING_TEXT,
  CHANGES_UNREADABLE_TEXT,
  COUNTS_NOT_RECORDED_SENTENCE,
  CURATION_FAILED_PARTIAL_TEXT,
  CURATION_FAILED_TEXT,
  MEMORY_CHANGES_HEADING,
  NO_MEMORY_CHANGES_SENTENCE,
  OPEN_QUESTION_NOTE,
  PROPOSED_NOTE,
  RECONCILIATION_UNATTRIBUTED_TEXT,
  RECORD_UNREADABLE_LEAD,
  SHOW_FULL_RECORD_LABEL,
  STORE_READ_INCOMPLETE_TEXT,
  WAS_PREFIX,
  learnedView,
  projectKnowledgeView,
  reconciliationCountText,
  sinceThisRunHeading,
  type LearnedRowView,
  type LearnedView,
} from "@/lib/knowledge-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A build whose entity routes resolve a memory reference. The shipped table routes none
// (`ENTITY_KIND_ROUTES.MEM` is null), so the routed-link cell names the one reference it routes; the
// href still reaches the ledger only through the view's `entityRefRoute` call.
const routedRefs = vi.hoisted(() => new Map<string, string>())
vi.mock("@/lib/entity-routes", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/entity-routes")>()
  return { ...actual, entityRefRoute: (ref: string) => routedRefs.get(ref) ?? actual.entityRefRoute(ref) }
})

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
  // A routed reference renders a `<Link>`, which throws outside a router, so both arms use one.
  act(() => { root?.render(<MemoryRouter><TooltipProvider delayDuration={0}>{element}</TooltipProvider></MemoryRouter>) })
  return container
}

function render(view: LearnedView): HTMLElement {
  return mount(<KnowledgeLearned view={view} />)
}

type LedgerChange = Extract<RunKnowledgeProjection, { kind: "ready" }>["learned"]["changes"][number]

function ledgerChange(recordId: string, change: LedgerChange["change"], atOrdinal: number, extra: Partial<LedgerChange> = {}): LedgerChange {
  return { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION, recordId, change, atOrdinal, ...extra }
}

// The ledger a page paints: a schema-valid read folded by the real `projectKnowledgeView`.
function renderLedger(changes: LedgerChange[]): HTMLElement {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready", runId: "run-ledger", buildOrdinal: 2, knowledgeStore: "bound", steps: [],
    curation: { status: "complete", counts: { curated: changes.length, deprecated: 0 } },
    learned: { changes, canaryAttributions: [] },
  })
  const view = projectKnowledgeView({ kind: "read", projection })
  if (view.state !== "ready") throw new Error("expected ready")
  const host = mount(<RetrievalDetails ledger={view.ledger} />)
  const trigger = host.querySelector<HTMLElement>('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]')
  if (trigger === null) throw new Error("no Retrieval details trigger")
  act(() => { trigger.click() })
  return host
}

function ledgerBlocks(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("dl[data-ledger-changes]")]
}

function ledgerRow(block: Element | undefined, row: string): HTMLElement | null {
  return block?.querySelector<HTMLElement>(`dd[data-ledger-row="${row}"]`) ?? null
}

function stateOf(host: HTMLElement): string | null {
  return host.querySelector("[data-learned-state]")?.getAttribute("data-learned-state") ?? null
}

function rowsOf(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("li[data-record-change]")]
}

// A row is a bucket and what it leads with; its key is the index the view assigns.
function row(overrides: Partial<LearnedRowView> = {}): LearnedRowView {
  return {
    key: "0",
    bucket: "confirmed",
    primary: "the cart page lives at /view_cart",
    leadSource: "joined",
    ...overrides,
  }
}

function primariesOf(host: HTMLElement): (string | null | undefined)[] {
  return rowsOf(host).map(el => el.querySelector("[data-row-primary]")?.textContent)
}

// The receipt is a technical fact, so it reads in Retrieval details.
describe('receipt-backed promotion attribution', () => {
  it.each(['user-sovereign', 'deterministic-verdict-floor'] as const)(
    'renders the recorded %s path and receipt prefix', promotionPath => {
      const promotionReceiptDigest = '0123456789abcdef'.repeat(4)
      const host = renderLedger([ledgerChange('fact-promoted', 'promoted', 7, { promotionPath, promotionReceiptDigest })])
      const block = ledgerBlocks(host)[0]
      expect(ledgerRow(block, 'promotion')?.textContent).toBe(promotionPath)
      expect(ledgerRow(block, 'receipt')?.textContent).toBe(promotionReceiptDigest)
      expect(ledgerRow(block, 'receipt')?.textContent?.startsWith('0123456789ab')).toBe(true)
      expect(ledgerRow(block, 'bucket')?.textContent).toBe('confirmed')
    },
  )

  it('renders a path without inventing a receipt', () => {
    const host = renderLedger([ledgerChange('fact-promoted', 'promoted', 7, { promotionPath: 'user-sovereign' })])
    const block = ledgerBlocks(host)[0]
    expect(ledgerRow(block, 'promotion')?.textContent).toBe('user-sovereign')
    expect(ledgerRow(block, 'receipt')).toBeNull()
  })

  it('leaves historical promoted rows without an attribution element', () => {
    const host = renderLedger([ledgerChange('fact-promoted', 'promoted', 7)])
    expect(ledgerBlocks(host).length).toBe(1)
    expect(host.querySelector('[data-ledger-row="promotion"]')).toBeNull()
    expect(host.querySelector('[data-ledger-row="receipt"]')).toBeNull()
  })
})

describe("an unsettled curation says so in words, never in a spinner", () => {
  it("carries the pending word on the root and the one sentence a reader can act on", () => {
    const host = render({ state: "pending", sentence: CHANGES_PENDING_TEXT, rows: [] })

    expect(stateOf(host)).toBe("pending")
    expect(host.textContent).toContain(CHANGES_PENDING_TEXT)
    expect(rowsOf(host).length).toBe(0)
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull()
  })

  it("carries the running word with the SAME sentence — one fact is being waited on, not two", () => {
    const host = render({ state: "running", sentence: CHANGES_PENDING_TEXT, rows: [] })

    expect(stateOf(host)).toBe("running")
    expect(host.textContent).toContain(CHANGES_PENDING_TEXT)
  })

  it("renders NO count line while curation is unsettled — counts come only from the frozen row", () => {
    const host = render({ state: "pending", sentence: CHANGES_PENDING_TEXT, rows: [] })

    expect(host.querySelector("[data-learned-count-line]")).toBeNull()
  })
})

describe("a failed curation states the consequence, not just the failure", () => {
  it("carries the failed word and says nothing was learned — and offers no retry", () => {
    const host = render({ state: "failed", sentence: CURATION_FAILED_TEXT, rows: [] })

    expect(stateOf(host)).toBe("failed")
    expect(host.textContent).toContain(CURATION_FAILED_TEXT)
    expect(rowsOf(host).length).toBe(0)
    expect(host.querySelector("button")).toBeNull()
  })
})

// `chainNote` reports the chain and `readNote` the read, each by its own attribute.
describe("a failed chain paints the records it committed and notes its fate BESIDE them", () => {
  it("paints the row and the chain note, and prints NO sentence over the records", () => {
    const host = render({
      state: "failed",
      rows: [row()],
      chainNote: CURATION_FAILED_PARTIAL_TEXT,
    })

    expect(stateOf(host)).toBe("failed")
    expect(rowsOf(host).length).toBe(1)
    expect(host.querySelector("[data-learned-chain-note]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)
    // The falsifiable claim is the one that must be gone: `Curation failed — nothing was learned
    // from this run.` printed over a record the same projection carries is a claim that projection
    // disproves. The slot it lived in is empty here, not reworded.
    expect(host.querySelector("[data-learned-sentence]")).toBeNull()
    expect(host.textContent).not.toContain(CURATION_FAILED_TEXT)
  })

  it("leaves the no-rows arm exactly as it shipped — the approved sentence, and no note ELEMENT", () => {
    const host = render({ state: "failed", sentence: CURATION_FAILED_TEXT, rows: [] })

    expect(stateOf(host)).toBe("failed")
    expect(host.querySelector("[data-learned-sentence]")?.textContent).toBe(CURATION_FAILED_TEXT)
    expect(rowsOf(host).length).toBe(0)
    // Absent, never blank. An empty paragraph would be a chain-failure stamp on an arm whose
    // failure is already stated above it, and a cell could not tell the two apart.
    expect(host.querySelector("[data-learned-chain-note]")).toBeNull()
  })

  it("prints BOTH notes when a failed chain's records arrive over a partly-read store", () => {
    const host = render({
      state: "failed",
      rows: [row()],
      chainNote: CURATION_FAILED_PARTIAL_TEXT,
      scanIncomplete: true,
      readNote: STORE_READ_INCOMPLETE_TEXT,
    })

    expect(rowsOf(host).length).toBe(1)
    expect(host.querySelector("[data-learned-state]")?.getAttribute("data-learned-read"))
      .toBe("incomplete")
    expect(host.querySelector("[data-learned-chain-note]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(host.querySelector("[data-learned-read-note]")?.textContent)
      .toBe(STORE_READ_INCOMPLETE_TEXT)

    // ORDER IS PART OF THE CONTRACT: the chain note is about the LIST a reader is already looking
    // at, the read note is about how much of the store anyone could see, so the chain note rides
    // directly under the rows and the read note under it. Read off a query naming BOTH paragraphs
    // by their own attributes — an index into a broader `<p>` query would also catch the heading
    // region and would pass on an ordering nobody asserted.
    const notes = [...host.querySelectorAll<HTMLElement>(
      "p[data-learned-chain-note], p[data-learned-read-note]",
    )]
    expect(notes.map(note => note.textContent))
      .toEqual([CURATION_FAILED_PARTIAL_TEXT, STORE_READ_INCOMPLETE_TEXT])

    const chain = host.querySelector("[data-learned-chain-note]")
    const read = host.querySelector("[data-learned-read-note]")
    expect(chain).not.toBeNull()
    expect(read).not.toBeNull()
    expect(
      (chain?.compareDocumentPosition(read as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe("a settled curation with no counts says so — never a zero", () => {
  it("carries the counts-absent word, the sentence and the fragment, with no digit anywhere", () => {
    const host = render({
      state: "counts-absent",
      countLine: COUNTS_NOT_RECORDED_TEXT,
      sentence: COUNTS_NOT_RECORDED_SENTENCE,
      rows: [],
    })

    expect(stateOf(host)).toBe("counts-absent")
    expect(host.textContent).toContain(COUNTS_NOT_RECORDED_SENTENCE)
    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe(COUNTS_NOT_RECORDED_TEXT)
    expect(host.textContent).not.toContain("0")
  })
})

describe("a settled curation that changed nothing says that, and lists nothing", () => {
  it("renders the both-zero phrase beside the heading and the changed-nothing sentence", () => {
    const host = render({
      state: "complete",
      countLine: legacyCurationPairText(0, 0),
      sentence: NO_MEMORY_CHANGES_SENTENCE,
      rows: [],
    })

    expect(stateOf(host)).toBe("complete")
    expect(host.querySelector("[data-learned-count-line]")?.textContent).toBe(legacyCurationPairText(0, 0))
    expect(host.textContent).toContain(NO_MEMORY_CHANGES_SENTENCE)
    expect(rowsOf(host).length).toBe(0)
  })

  it("keeps the counts on screen when they moved but no change record reached this run", () => {
    const host = render({
      state: "complete",
      countLine: legacyCurationPairText(3, 1),
      sentence: CHANGES_NOT_AVAILABLE_TEXT,
      rows: [],
    })

    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe(legacyCurationPairText(3, 1))
    expect(host.textContent).toContain(CHANGES_NOT_AVAILABLE_TEXT)
    expect(rowsOf(host).length).toBe(0)
  })
})

// The note is a separate element from the count line, so a cell can assert its absence.
describe("the heading spells one number one way, and labels a coarser one", () => {
  it("LEARNED-BREAKDOWN-LINE: renders the five-bucket line in the heading's own count slot", () => {
    const breakdown = { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 }
    const host = render({ state: "complete", countLine: curationBreakdownLine(breakdown), rows: [] })

    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe("1 added · 1 confirmed · 1 superseded · 1 deprecated · 1 proposed")
    expect(host.querySelector("[data-learned-count-note]")).toBeNull()
  })

  it("LEARNED-LEGACY-NOTE: renders the note as its own muted paragraph beneath the heading row", () => {
    const host = render({
      state: "complete",
      countLine: legacyCurationPairText(2, 0),
      countNote: BREAKDOWN_NOT_RECORDED_TEXT,
      rows: [],
    })

    const note = host.querySelector("[data-learned-count-note]")
    expect(note?.tagName).toBe("P")
    expect(note?.textContent).toBe(BREAKDOWN_NOT_RECORDED_TEXT)
    expect(note?.className).toContain("text-xs")
    expect(note?.className).toContain("text-muted-foreground")
    expect(host.querySelector("[data-learned-count-line]")?.textContent).toBe("2 curated · 0 deprecated")
  })

  it("LEARNED-LEGACY-NOTE: omits the note element ENTIRELY when there is no absence to label", () => {
    const host = render({ state: "complete", countLine: legacyCurationPairText(3, 1), rows: [] })

    expect(host.querySelector("[data-learned-count-note]")).toBeNull()
  })
})

// The gap and its cause are separate elements, so a matching run can assert neither exists.
describe("a mismatch is explained beneath the heading, and only when there is one", () => {
  const breakdown = { added: 3, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 }

  it("RECONCILIATION-ONLY-ON-MISMATCH: renders the count and the cause as their own paragraphs", () => {
    const host = render({
      state: "complete",
      countLine: curationBreakdownLine(breakdown),
      rows: [row()],
      curationSnapshot: {
        breakdown,
        reconciliation: {
          count: reconciliationCountText(3, 1),
          cause: RECONCILIATION_UNATTRIBUTED_TEXT,
        },
      },
    })

    const block = host.querySelector("[data-learned-reconciliation]")
    expect(block?.tagName).toBe("DIV")
    const count = host.querySelector("[data-learned-reconciliation-count]")
    const cause = host.querySelector("[data-learned-reconciliation-cause]")
    expect(count?.tagName).toBe("P")
    expect(count?.textContent).toBe("3 changes counted · 1 shown")
    expect(count?.className).toContain("tabular-nums")
    expect(count?.className).toContain("text-xs")
    expect(cause?.tagName).toBe("P")
    expect(cause?.textContent).toBe(RECONCILIATION_UNATTRIBUTED_TEXT)
    expect(cause?.className).toContain("text-muted-foreground")
    // Both paragraphs carry `tabular-nums`, so a cause that later names a count lines up.
    expect(cause?.className).toContain("tabular-nums")
  })

  it("RECONCILIATION-ONLY-ON-MISMATCH: renders NO element at all when the numbers agree", () => {
    const host = render({
      state: "complete",
      countLine: curationBreakdownLine(breakdown),
      rows: [row()],
      curationSnapshot: { breakdown, sinceThenCount: 0 },
    })

    expect(host.querySelector("[data-learned-reconciliation]")).toBeNull()
    expect(host.querySelector("[data-learned-reconciliation-count]")).toBeNull()
    expect(host.querySelector("[data-learned-reconciliation-cause]")).toBeNull()
  })

  it("RECONCILIATION-CAUSE-FROM-READ: leaves the since-then attribute and its rows untouched", () => {
    const host = render({
      state: "failed",
      rows: [row()],
      chainNote: CURATION_FAILED_PARTIAL_TEXT,
      curationSnapshot: {
        breakdown,
        sinceThenCount: 2,
        reconciliation: {
          count: reconciliationCountText(3, 1),
          cause: CURATION_FAILED_PARTIAL_TEXT,
        },
      },
    })

    const section = host.querySelector("[data-learned-state]")
    expect(section?.getAttribute("data-learned-since-then")).toBe("2")
    expect(section?.getAttribute("data-learned-snapshot")).toBe("recorded")
    expect(host.querySelector("[data-learned-reconciliation-cause]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(host.querySelector("[data-learned-chain-note]")?.textContent)
      .toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(rowsOf(host).length).toBe(1)
  })
})

describe("the record list is one row per affected record, in the curation bucket words", () => {
  const populated: LearnedView = {
    state: "complete",
    countLine: legacyCurationPairText(3, 1),
    rows: [
      row({ key: "0", bucket: "confirmed", primary: "a fact promoted to trusted" }),
      row({ key: "1", bucket: "deprecated", primary: "a fact that no longer holds" }),
    ],
  }

  it("renders the heading, the count line and one li per change, in the projection's order", () => {
    const host = render(populated)

    expect(host.querySelector("h4")?.textContent).toBe(MEMORY_CHANGES_HEADING)
    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe(legacyCurationPairText(3, 1))
    expect(rowsOf(host).map((el) => el.getAttribute("data-record-change")))
      .toEqual(["confirmed", "deprecated"])
    expect(primariesOf(host)).toEqual(["a fact promoted to trusted", "a fact that no longer holds"])
    // E6 overflow: line 1 wraps and the summary breaks anywhere rather than truncating.
    const line = rowsOf(host)[0]?.querySelector("[data-row-primary]")
    expect(line?.className).toContain("wrap-anywhere")
    expect(line?.parentElement?.className).toContain("flex-wrap")
    expect(line?.className).not.toContain("truncate")
  })

  it("BUCKET-LABEL-VOCABULARY: each row's label reads the curation breakdown word it is stamped with", () => {
    const snapshot = fiveBucketSnapshot()
    const host = render(learnedView(readyProjection("complete", {
      changes: snapshotChanges(), curationSnapshot: snapshot, sinceThen: { changes: [], count: 0 },
    }, { curated: 4, deprecated: 1 })))
    const line = curationBreakdownLine(snapshot.breakdown)

    expect(rowsOf(host).length).toBe(5)
    for (const el of rowsOf(host)) {
      const label = el.querySelector<HTMLElement>("[data-bucket-label]")
      const bucket = el.getAttribute("data-record-change")
      const hidden = label?.querySelector(".sr-only")?.textContent ?? ""
      const visible = (label?.textContent ?? "").replace(hidden, "").trim().toLowerCase()
      expect(label?.getAttribute("data-bucket-label")).toBe(bucket)
      expect(visible).toBe(bucket)
      expect(line).toContain(`1 ${visible}`)
      expect(label?.className).toContain("uppercase")
    }
    expect(Object.values(BUCKET_LABELS).map(word => word.toLowerCase())).toEqual(snapshot.rows.map(entry => entry.bucket))
  })

  it("CHANGE-LEDGER-ENTRIES: one ledger block per changed record, with every id and raw event in mono", () => {
    const host = renderLedger([
      ledgerChange("fact-kept", "confirmed", 12),
      ledgerChange("fact-old", "superseded", 13, { byRecordId: "fact-new" }),
      ledgerChange("fact-new", "added", 13),
    ])
    const blocks = ledgerBlocks(host)

    expect(blocks.length).toBe(2)
    for (const block of blocks) {
      const ids = ledgerRow(block, "record")
      expect(ids?.className).toContain("font-mono")
      expect(ids?.className).toContain("break-all")
    }
    expect([...(ledgerRow(blocks[0], "record")?.querySelectorAll("span.block") ?? [])].map(el => el.textContent))
      .toEqual(["fact-kept"])
    expect([...(ledgerRow(blocks[1], "record")?.querySelectorAll("span.block") ?? [])].map(el => el.textContent))
      .toEqual(["fact-new", "fact-old"])
    expect([...(ledgerRow(blocks[1], "events")?.querySelectorAll("span.block") ?? [])].map(el => el.textContent))
      .toEqual(["superseded @ 13", "added @ 13"])
    expect(ledgerRow(blocks[1], "bucket")?.textContent).toBe("superseded")
  })

  // Ledger values sit in a `minmax(0,1fr)` column and break anywhere, so a long id shrinks its box.
  it("lets a content-derived record id shrink its own box rather than widen the row", () => {
    const host = renderLedger([ledgerChange("fact-page-https-example-com-0f9a-and-a-much-longer-tail", "confirmed", 12)])
    const block = ledgerBlocks(host)[0]

    expect(block?.className).toContain("grid-cols-[auto_minmax(0,1fr)]")
    expect(ledgerRow(block, "record")?.className).toContain("break-all")
  })

  it("renders a ROUTED reference as an accent anchor with the truncation rule the SPEC states", () => {
    const ref = formatEntityUri("MEM", "MEM-002")
    routedRefs.set(ref, "/memory/MEM-002")
    try {
      const host = renderLedger([ledgerChange("MEM-002", "confirmed", 12)])
      const link = ledgerRow(ledgerBlocks(host)[0], "link")
      const anchor = link?.querySelector<HTMLAnchorElement>("a")

      expect(anchor).not.toBeNull()
      expect(anchor?.getAttribute("href")).toBe("/memory/MEM-002")
      expect(anchor?.textContent).toBe(ref)
      expect(anchor?.className).toContain("text-primary")
      // Ledger values break anywhere rather than truncate, so nothing is hidden.
      expect(link?.className).toContain("break-all")
    } finally {
      routedRefs.clear()
    }
  })

  it("renders an UNROUTED reference as text — this build says what, not where to click", () => {
    const host = renderLedger([ledgerChange("MEM-001", "confirmed", 12)])
    const link = ledgerRow(ledgerBlocks(host)[0], "link")

    expect(link?.textContent).toBe(formatEntityUri("MEM", "MEM-001"))
    expect(host.querySelector("dl[data-ledger-changes] a")).toBeNull()
  })

  it("renders no reference element at all for a record that has no canonical address", () => {
    const host = renderLedger([ledgerChange("fact-page-https-example-com-0f9a", "confirmed", 12)])

    expect(host.querySelector('[data-ledger-row="link"]')).toBeNull()
    expect(ledgerRow(ledgerBlocks(host)[0], "record")?.textContent).toBe("fact-page-https-example-com-0f9a")
  })

  it("drops the state sentence once rows are painted — the rows ARE the answer", () => {
    const host = render(populated)

    expect(host.querySelector("[data-learned-sentence]")).toBeNull()
  })
})

describe("a curated NEW fact is painted, not denied", () => {
  it("PROPOSED-NOT-APPLIED: a proposed row says it is recorded and not applied, and an open question says so", () => {
    const host = render({
      state: "complete",
      countLine: curationBreakdownLine({ added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 2 }),
      rows: [
        row({ key: "0", bucket: "proposed", primary: "the cart page lives at /view_cart", kind: "fact", note: PROPOSED_NOTE }),
        row({ key: "1", bucket: "proposed", primary: "does checkout need a login?", kind: "unknown", note: OPEN_QUESTION_NOTE }),
      ],
    })

    const notes = rowsOf(host).map(el => el.querySelector<HTMLElement>("[data-proposed-note]"))
    expect(notes.map(note => note?.textContent)).toEqual([`· ${PROPOSED_NOTE}`, `· ${OPEN_QUESTION_NOTE}`])
    expect(notes[0]?.className).toContain("text-muted-foreground")
    expect(rowsOf(host).map(el => el.getAttribute("data-record-change"))).toEqual(["proposed", "proposed"])
  })

  it("NO-ID-ON-CHANGE-ROWS: no row carries a record id in any attribute or text, and none is tinted", () => {
    const snapshot = fiveBucketSnapshot()
    const ids = ["fact-added", "fact-confirmed", "fact-victim", "fact-replacement", "fact-deprecated", "fact-proposed"]
    const changes = snapshot.rows.flatMap(entry => entry.changes.map(({ change }, index) => ({
      ...change,
      recordContent: { ...joinedContent(change.recordId), summary: `a stored fact, number ${String(index)}`, content: "a body" },
    })))
    const host = render(learnedView(readyProjection("complete", {
      changes, curationSnapshot: snapshot, sinceThen: { changes: [], count: 0 },
    }, { curated: 4, deprecated: 1 })))

    expect(rowsOf(host).length).toBe(5)
    for (const el of rowsOf(host)) {
      expect(el.hasAttribute("data-record-id")).toBe(false)
      for (const node of [el, ...el.querySelectorAll("*")]) {
        for (const attribute of [...node.attributes]) {
          for (const id of ids) expect(attribute.value).not.toContain(id)
        }
        expect(String(node.getAttribute("class") ?? "")).not.toMatch(/emerald|destructive/)
      }
      for (const id of ids) expect(el.textContent).not.toContain(id)
    }
  })

  it("BUCKET-LABEL-MEANINGS: every bucket label is a button named by its word, whose tooltip and one description are its meaning", async () => {
    const buckets = ["added", "confirmed", "superseded", "deprecated", "proposed"] as const
    const host = render({
      state: "complete",
      countLine: curationBreakdownLine({ added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 }),
      rows: buckets.map((bucket, index) => row({ key: String(index), bucket, primary: `a ${bucket} fact` })),
    })

    expect(host.querySelector("[data-learned-sentence]")).toBeNull()
    expect(rowsOf(host).map(el => el.getAttribute("data-record-change"))).toEqual([...buckets])
    for (const el of rowsOf(host)) {
      const bucket = el.getAttribute("data-record-change") as keyof typeof BUCKET_MEANINGS
      const label = el.querySelector<HTMLElement>("[data-bucket-label]")
      expect(label?.tagName).toBe("BUTTON")
      expect(label?.getAttribute("type")).toBe("button")
      expect(label?.hasAttribute("aria-label")).toBe(false)
      expect(label?.hasAttribute("title")).toBe(false)
      expect(label?.className).toContain("cursor-help")
      expect(label?.className).toContain("decoration-dotted")
      expect(label?.textContent?.trim()).toBe(BUCKET_LABELS[bucket])
      const ids = (label?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id.length > 0)
      expect(ids).toHaveLength(1)
      const description = document.getElementById(ids[0] ?? "")
      expect(description?.hasAttribute("hidden")).toBe(true)
      expect(label?.contains(description)).toBe(false)
      expect(description?.textContent).toBe(BUCKET_MEANINGS[bucket])
      await act(async () => { label?.focus() })
      const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
      expect(tooltip?.textContent).toBe(BUCKET_MEANINGS[bucket])
      expect(label?.getAttribute("aria-describedby")).toBe(tooltip?.id)
      await act(async () => { label?.blur() })
      expect(label?.getAttribute("aria-describedby")).toBe(ids[0])
    }
    // Nothing reviews a proposed record.
    expect(BUCKET_MEANINGS.proposed).toBe("Recorded, but not applied: agents are not given it.")
  })

  // Two changes on one bundle share a `recordId`, so the cell also watches for a duplicate key.
  it("renders BOTH changes of one record as one row, both events in its ledger block, with no duplicate-key warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const projection = readyProjection("complete", {
        changes: [recorded("r", "confirmed", 12), recorded("r", "superseded", 13)],
      }, { curated: 1, deprecated: 0 })
      const view = projectKnowledgeView({ kind: "read", projection })
      if (view.state !== "ready") throw new Error("expected ready")
      const host = mount(<>
        <KnowledgeLearned view={view.learned} />
        <RetrievalDetails ledger={view.ledger} />
      </>)
      const trigger = host.querySelector<HTMLElement>('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]')
      act(() => { trigger?.click() })

      expect(rowsOf(host).map((el) => el.getAttribute("data-record-change"))).toEqual(["superseded"])
      expect([...host.querySelectorAll('[data-ledger-row="events"] span.block')].map(el => el.textContent))
        .toEqual(["confirmed @ 12", "superseded @ 13"])
      const warned = spy.mock.calls.some((call) => String(call[0]).includes("same key"))
      expect(warned).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("an unreadable store is stamped on the root, never inferred from an empty list", () => {
  const unreadable: LearnedView = {
    state: "complete",
    countLine: legacyCurationPairText(3, 1),
    sentence: CHANGES_UNREADABLE_TEXT,
    rows: [],
    scanIncomplete: true,
  }

  it("carries data-learned-read=incomplete, the counts, the sentence and no rows", () => {
    const host = render(unreadable)

    expect(host.querySelector("[data-learned-state]")?.getAttribute("data-learned-read"))
      .toBe("incomplete")
    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe(legacyCurationPairText(3, 1))
    expect(host.querySelector("[data-learned-sentence]")?.textContent)
      .toBe(CHANGES_UNREADABLE_TEXT)
    expect(rowsOf(host).length).toBe(0)
  })

  it("omits the attribute ENTIRELY on a clean read — absent, never an empty string", () => {
    const host = render({
      state: "complete",
      countLine: legacyCurationPairText(3, 1),
      sentence: CHANGES_NOT_AVAILABLE_TEXT,
      rows: [],
    })

    const section = host.querySelector("[data-learned-state]")
    expect(section?.hasAttribute("data-learned-read")).toBe(false)
    expect(stateOf(host)).toBe("complete")
    // No note at all: the element is absent on a clean read, not blank.
    expect(host.querySelector("[data-learned-read-note]")).toBeNull()
  })
})

describe("a partial read is painted beside the rows, and beneath an unsettled sentence", () => {
  it("paints the row, the incomplete stamp and the read note — and NO sentence", () => {
    const host = render({
      state: "complete",
      countLine: legacyCurationPairText(1, 0),
      rows: [row()],
      scanIncomplete: true,
      readNote: STORE_READ_INCOMPLETE_TEXT,
    })

    expect(host.querySelector("[data-learned-state]")?.getAttribute("data-learned-read"))
      .toBe("incomplete")
    expect(rowsOf(host).length).toBe(1)
    expect(host.querySelector("[data-learned-sentence]")).toBeNull()
    expect(host.querySelector("[data-learned-read-note]")?.textContent)
      .toBe(STORE_READ_INCOMPLETE_TEXT)
  })

  it("paints the pending sentence AND the note when a chain has not settled over an unreadable store", () => {
    const host = render({
      state: "pending",
      sentence: CHANGES_PENDING_TEXT,
      rows: [],
      scanIncomplete: true,
      readNote: STORE_READ_INCOMPLETE_TEXT,
    })

    expect(stateOf(host)).toBe("pending")
    expect(host.querySelector("[data-learned-state]")?.getAttribute("data-learned-read"))
      .toBe("incomplete")
    expect(host.querySelector("[data-learned-sentence]")?.textContent).toBe(CHANGES_PENDING_TEXT)
    expect(host.querySelector("[data-learned-read-note]")?.textContent)
      .toBe(STORE_READ_INCOMPLETE_TEXT)
    expect(host.querySelector("[data-learned-count-line]")).toBeNull()
    expect(rowsOf(host).length).toBe(0)
  })

  // Two confirmations at one ordinal survive the dedupe when their tokens differ; keys must too.
  it("folds two confirmations that differ ONLY in the evidence token into one row, with no duplicate-key warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const host = render(learnedView(readyProjection("complete", {
        changes: [
          recorded("r", "confirmed", 12, { evidenceToken: "tok-a" }),
          recorded("r", "confirmed", 12, { evidenceToken: "tok-b" }),
        ],
      }, { curated: 2, deprecated: 0 })))

      expect(rowsOf(host).length).toBe(1)
      const warned = spy.mock.calls.some((call) => String(call[0]).includes("same key"))
      expect(warned).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("renders the row() default key as the row index the view assigns", () => {
    expect(row().key).toBe("0")
    const view = learnedView(readyProjection("complete", {
      changes: [recorded("a", "added", 1), recorded("b", "confirmed", 2)],
    }, { curated: 2, deprecated: 0 }))
    expect(view.rows.map(entry => entry.key)).toEqual(["0", "1"])
  })
})

describe("no pending-proposals line or review command is rendered", () => {
  it.each([
    ["complete", { state: "complete", countLine: legacyCurationPairText(0, 0), sentence: NO_MEMORY_CHANGES_SENTENCE, rows: [] }],
    ["pending", { state: "pending", sentence: CHANGES_PENDING_TEXT, rows: [] }],
  ] as const)("a %s half renders no proposals line, command or copy button", (_state, view) => {
    const host = render(view as LearnedView)

    expect(host.querySelector("[data-pending-proposals]")).toBeNull()
    expect(host.querySelector("[data-pending-proposals-command]")).toBeNull()
    expect(host.querySelector("[data-review-proposals]")).toBeNull()
    expect(host.querySelector("[data-review-command]")).toBeNull()
    expect(host.querySelector("button")).toBeNull()
    expect(host.textContent).not.toMatch(/proposals? waiting|agent-qa proposals|review command/i)
  })
})

describe("projection text reaches the DOM as TEXT, never as markup", () => {
  it("renders a hostile record id as a text node — no element is created from it", () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const host = renderLedger([ledgerChange(hostile, "confirmed", 12)])

    expect(host.querySelector("img")).toBeNull()
    expect(ledgerRow(ledgerBlocks(host)[0], "record")?.textContent).toBe(hostile)
  })

  it("renders a hostile reference string as a text node too — an href is never taken from one", () => {
    const hostile = 'javascript:alert(1)'
    const host = renderLedger([ledgerChange(hostile, "confirmed", 12)])

    expect(host.querySelector("dl[data-ledger-changes] a")).toBeNull()
    expect(host.querySelector('[data-ledger-row="link"]')).toBeNull()
    expect(ledgerRow(ledgerBlocks(host)[0], "record")?.textContent).toBe(hostile)
  })
})

// Schema-valid projections drive the real `learnedView` into the component, the path a page takes.
const RECORDED_RUN_ID = "run-learned"
type ReadyProjection = Extract<RunKnowledgeProjection, { kind: "ready" }>
type LearnedChange = ReadyProjection["learned"]["changes"][number]

function joinedContent(recordId: string): NonNullable<LearnedChange["recordContent"]> {
  return {
    content: `body ${recordId}`,
    summary: `summary ${recordId}`,
    kind: "fact",
    applicability: { product: "shop", scope: "checkout", anchors: ["page:/checkout"], openedAtOrdinal: 3 },
    currentStatus: "active",
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 30 },
  }
}

function recorded(recordId: string, change: LearnedChange["change"], atOrdinal: number, extra: Partial<LearnedChange> = {}) {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION, recordId, change, atOrdinal, sourceRunId: RECORDED_RUN_ID,
    evidenceToken: `receipt-${recordId}-${String(atOrdinal)}`, ...extra,
  }
}

function fiveBucketSnapshot() {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: "fact-added", bucket: "added", changes: [{ bucket: "added", change: recorded("fact-added", "added", 20) }] },
      { recordId: "fact-confirmed", bucket: "confirmed", changes: [{ bucket: "confirmed", change: recorded("fact-confirmed", "confirmed", 21) }] },
      { recordId: "fact-victim", bucket: "superseded", byRecordId: "fact-replacement", changes: [
        { bucket: "superseded", change: recorded("fact-victim", "superseded", 22, { byRecordId: "fact-replacement" }) },
        { bucket: "added", change: recorded("fact-replacement", "added", 22) },
      ] },
      { recordId: "fact-deprecated", bucket: "deprecated", changes: [{ bucket: "deprecated", change: recorded("fact-deprecated", "deprecated", 23) }] },
      { recordId: "fact-proposed", bucket: "proposed", changes: [{ bucket: "proposed", change: recorded("fact-proposed", "added", 24) }] },
    ],
    breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
  })
}

function joined(change: LearnedChange): LearnedChange {
  return { ...change, recordContent: joinedContent(change.recordId) }
}

function readyProjection(
  status: ReadyProjection["curation"]["status"],
  learned: Partial<ReadyProjection["learned"]>,
  counts?: { curated: number; deprecated: number },
): ReadyProjection {
  return RunKnowledgeProjectionSchema.parse({
    kind: "ready", runId: RECORDED_RUN_ID, buildOrdinal: 2, knowledgeStore: "bound", steps: [],
    curation: { status, ...(counts === undefined ? {} : { counts }) },
    learned: { changes: [], canaryAttributions: [], ...learned },
  }) as ReadyProjection
}

function snapshotChanges(): LearnedChange[] {
  return fiveBucketSnapshot().rows.flatMap(row => row.changes.map(entry => joined(entry.change)))
}

function sectionOf(host: HTMLElement): HTMLElement {
  const section = host.querySelector<HTMLElement>("[data-learned-state]")
  if (section === null) throw new Error("expected the Learned section")
  return section
}

describe("a failed chain keeps its learned rows beside the snapshot sections", () => {
  it("FAILED-CHAIN-ROWS-RETAINED: a chain that learned before failing paints every served change, joined or absent", () => {
    const projection = readyProjection("failed", {
      changes: [
        joined(recorded("fact-before-failure", "added", 20)),
        { ...recorded("fact-purged-since", "confirmed", 21), contentAbsence: { reason: "not-found" } },
      ],
    })
    const host = render(learnedView(projection))

    expect(stateOf(host)).toBe("failed")
    expect(primariesOf(host)).toEqual(["summary fact-before-failure", RECORD_UNREADABLE_LEAD])
    expect(rowsOf(host).map(el => el.getAttribute("data-record-change"))).toEqual(["added", "confirmed"])
    expect(rowsOf(host).some(el => el.hasAttribute("data-record-id"))).toBe(false)
    expect(host.querySelector("[data-learned-chain-note]")?.textContent).toBe(CURATION_FAILED_PARTIAL_TEXT)
    expect(host.querySelector("[data-learned-sentence]")).toBeNull()
    expect(host.textContent).not.toContain(CURATION_FAILED_TEXT)
  })

  it("FAILED-NO-SNAPSHOT: an absent snapshot is stated on the half, with no since-then count and no invented counts", () => {
    const projection = readyProjection("failed", { changes: [joined(recorded("fact-before-failure", "added", 20))] })
    const view = learnedView(projection)
    const host = render(view)
    const section = sectionOf(host)

    expect(view.curationSnapshot).toBeUndefined()
    expect(section.getAttribute("data-learned-snapshot")).toBe("absent")
    expect(section.hasAttribute("data-learned-since-then")).toBe(false)
    expect(host.querySelector("[data-learned-count-line]")).toBeNull()
    expect(rowsOf(host).length).toBe(1)
    expect(rowsOf(host)[0]?.hasAttribute("data-learned-section")).toBe(false)
  })

  it("FAILED-NO-SNAPSHOT: a historical settled chain states the same absence and keeps its legacy counts", () => {
    const projection = readyProjection("complete", { changes: [joined(recorded("fact-legacy", "confirmed", 9))] }, { curated: 1, deprecated: 0 })
    const host = render(learnedView(projection))

    expect(sectionOf(host).getAttribute("data-learned-snapshot")).toBe("absent")
    expect(host.querySelector("[data-learned-count-line]")?.textContent).toBe(legacyCurationPairText(1, 0))
    expect(rowsOf(host).length).toBe(1)
  })

  it("ALL-FIVE-BUCKETS: a completed snapshot is recorded, and every change it names stays in this run's curation", () => {
    const snapshot = fiveBucketSnapshot()
    const changes = snapshotChanges()
    const projection = readyProjection("complete", {
      changes, curationSnapshot: snapshot, sinceThen: { changes: [], count: 0 },
    }, { curated: 4, deprecated: 1 })
    const view = learnedView(projection)
    const host = render(view)
    const section = sectionOf(host)

    // The rows are the snapshot's affected records, one per supersession, so counts and rows agree.
    expect(view.curationSnapshot?.breakdown).toEqual(snapshot.breakdown)
    expect(view.curationSnapshot?.sinceThenCount).toBe(0)
    expect(view.curationSnapshot?.reconciliation).toBeUndefined()
    expect(host.querySelector("[data-learned-reconciliation]")).toBeNull()
    expect(host.querySelector("[data-learned-count-line]")?.textContent)
      .toBe("1 added · 1 confirmed · 1 superseded · 1 deprecated · 1 proposed")
    expect(section.getAttribute("data-learned-snapshot")).toBe("recorded")
    expect(section.getAttribute("data-learned-since-then")).toBe("0")
    expect(rowsOf(host).map(el => el.getAttribute("data-record-change"))).toEqual(snapshot.rows.map(entry => entry.bucket))
    expect(rowsOf(host).map(el => el.getAttribute("data-learned-section"))).toEqual(snapshot.rows.map(() => "curation"))

    const supersession = rowsOf(host)[2]
    expect(supersession?.querySelector("[data-row-primary]")?.textContent).toBe("summary fact-replacement")
    expect(supersession?.querySelector("[data-superseded-was]")?.textContent).toBe(`${WAS_PREFIX} summary fact-victim`)
    expect(rowsOf(host).filter(el => el.querySelector("[data-superseded-was]") !== null).length).toBe(1)
    for (const el of rowsOf(host)) {
      expect(el.querySelector("[data-row-applicability]")).not.toBeNull()
      expect([...el.querySelectorAll("button")].some(button => button.textContent === SHOW_FULL_RECORD_LABEL)).toBe(true)
    }
    expect(host.querySelector("[data-since-this-run]")).toBeNull()
  })

  it("LATER-LINKED-ROWS: a later promotion is painted as a since-then row beside the unchanged curation rows", () => {
    const snapshot = fiveBucketSnapshot()
    const later = joined(recorded("fact-added", "promoted", 91))
    const projection = readyProjection("complete", {
      changes: [...snapshotChanges(), later], curationSnapshot: snapshot, sinceThen: { changes: [later], count: 1 },
    }, { curated: 4, deprecated: 1 })
    const view = learnedView(projection)
    const host = render(view)
    const rows = rowsOf(host)
    const since = host.querySelector<HTMLElement>("[data-since-this-run]")
    const laterRows = [...(since?.querySelectorAll<HTMLElement>("li[data-record-change]") ?? [])]

    expect(view.curationSnapshot?.sinceThenCount).toBe(1)
    expect(sectionOf(host).getAttribute("data-learned-since-then")).toBe("1")
    expect(host.querySelector("[data-learned-count-line]")?.textContent).toBe(curationBreakdownLine(snapshot.breakdown))
    expect(rows.length).toBe(snapshot.rows.length + 1)
    expect(rows.map(el => el.getAttribute("data-learned-section")))
      .toEqual([...snapshot.rows.map(() => "curation"), "since-then"])
    expect(since?.getAttribute("data-since-this-run")).toBe("1")
    expect(since?.querySelector("h5")?.textContent).toBe(sinceThisRunHeading(1))
    expect(laterRows.length).toBe(1)
    expect(laterRows[0]?.getAttribute("data-record-change")).toBe("confirmed")
    expect(laterRows[0]?.querySelector("[data-since-detail]")?.textContent).toBe("promoted to trusted, later")
  })
})
