import { RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom

// The default view holds no record id or retrieval machinery; every id is inside Retrieval details.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it } from "vitest"

import {
  CurationSnapshotSchema,
  RunKnowledgeProjectionSchema,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from "@vostride/agent-qa-schema"

import { TabKnowledge } from "@/components/run-detail/tab-knowledge"
import { TooltipProvider } from "@/components/ui/tooltip"
import { RECORD_UNREADABLE_LEAD, projectKnowledgeView, type KnowledgeView } from "@/lib/knowledge-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  unmount()
})

function unmount(): void {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
}

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<MemoryRouter><TooltipProvider delayDuration={0}>{element}</TooltipProvider></MemoryRouter>) })
  return container
}

// ── The fixture: every kind of id a run can carry, in content-derived shape ──────────────────────

const RUN = "run-427-10-default-view"
const SERVED_CANARY = "fact-el-button-add-to-cart-0f9a1c2b3d4e5f60"
const SERVED_PLAIN = "fact-page-https-shop-example-com-cart-1a2b3c4d5e6f7081"
const OPENED = "fact-flow-checkout-login-2b3c4d5e6f708192"
const OPENED_GONE = "fact-page-https-shop-example-com-gone-4d5e6f708192a3b4"
const CAUTION = "caution-el-button-pay-now-3c4d5e6f708192a3"
const REPLAYED = "procedure-flow-checkout-5e6f708192a3b4c5"
const HINTED = "procedure-flow-search-6f708192a3b4c5d6"
const CUT = "fact-el-link-help-708192a3b4c5d6e7"
const ADDED = "fact-el-textbox-email-8192a3b4c5d6e7f8"
const CONFIRMED = "fact-el-heading-orders-92a3b4c5d6e7f809"
const VICTIM = "fact-el-button-buy-a3b4c5d6e7f8091a"
const REPLACEMENT = "fact-el-button-buy-now-b4c5d6e7f8091a2b"
const DEPRECATED = "fact-page-https-shop-example-com-old-c5d6e7f8091a2b3c"
const PROPOSED = "policy-flow-refunds-d6e7f8091a2b3c4d"

const OPENED_DIGEST = "sha256:9e1f2a3b4c5d6e7f8091a2b3c4d5e6f7"
const GONE_DIGEST = "sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f9"
const TRUST_NUMBERS = ["0.87", "0.64"]

/** Every record id and digest the fixture carries. */
const RECORD_IDS = [
  SERVED_CANARY, SERVED_PLAIN, OPENED, OPENED_GONE, CAUTION, REPLAYED, HINTED, CUT,
  ADDED, CONFIRMED, VICTIM, REPLACEMENT, DEPRECATED, PROPOSED,
]
const DIGESTS = [OPENED_DIGEST, GONE_DIGEST]

const CONTENT_DERIVED_ID = /^(fact|caution|procedure|policy|unknown)-[a-z0-9:-]+-[0-9a-f]{16}$/

function content(summary: string, kind = "fact") {
  return {
    content: `The body of: ${summary}`,
    summary,
    kind,
    applicability: { product: "shop", scope: "shop", anchors: ["page:/cart"], openedAtOrdinal: 3 },
    currentStatus: "active",
    currentTrust: { confirmations: 2, contradictions: 0, evidenceTokens: [] as string[], lastEventOrdinal: 30 },
  }
}

function recorded(recordId: string, change: string, atOrdinal: number, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change, atOrdinal, sourceRunId: RUN,
    evidenceToken: `receipt-${String(atOrdinal)}`, ...extra,
  }
}

function snapshot() {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: ADDED, bucket: "added", changes: [{ bucket: "added", change: recorded(ADDED, "added", 20) }] },
      { recordId: CONFIRMED, bucket: "confirmed", changes: [{ bucket: "confirmed", change: recorded(CONFIRMED, "confirmed", 21) }] },
      { recordId: VICTIM, bucket: "superseded", byRecordId: REPLACEMENT, changes: [
        { bucket: "superseded", change: recorded(VICTIM, "superseded", 22, { byRecordId: REPLACEMENT }) },
        { bucket: "added", change: recorded(REPLACEMENT, "added", 22) },
      ] },
      { recordId: DEPRECATED, bucket: "deprecated", changes: [{ bucket: "deprecated", change: recorded(DEPRECATED, "deprecated", 23) }] },
      { recordId: PROPOSED, bucket: "proposed", changes: [{ bucket: "proposed", change: recorded(PROPOSED, "added", 24) }] },
    ],
    breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
  })
}

const SUMMARIES: Record<string, string> = {
  [ADDED]: "The email box accepts a plus sign",
  [CONFIRMED]: "The orders page has an Orders heading",
  [VICTIM]: "The buy button reads Buy",
  [REPLACEMENT]: "The buy button reads Buy now",
  [DEPRECATED]: "The old cart page still loads",
  [PROPOSED]: "Refunds need a manager to approve them",
}

function richView(): Extract<KnowledgeView, { state: "ready" }> {
  const snap = snapshot()
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: RUN,
    buildOrdinal: 7,
    knowledgeStore: "bound",
    steps: [
      {
        testId: "t_default_view",
        testIndex: 0,
        stepIndex: 0,
        stepText: "add the shirt to the cart",
        served: {
          channel1: [
            { id: SERVED_CANARY, kind: "fact", summary: "Add to cart opens the mini cart", trust: 0.87, status: "candidate", servedAsCanary: true, tier: "candidate", recordContent: content("Add to cart opens the mini cart") },
            { id: SERVED_PLAIN, kind: "fact", summary: "The cart page lists every item", trust: 0.64, status: "active", servedAsCanary: false, tier: "confirmed", recordContent: content("The cart page lists every item") },
          ],
          channel2: [
            { id: OPENED, detailLevel: "full", bodyDigest: OPENED_DIGEST, recordContent: content("Checkout asks for a login first") },
          ],
          channel3: [
            { id: CAUTION, summary: "Pay now can double charge on a slow network", recordContent: content("Pay now can double charge on a slow network", "caution") },
          ],
        },
        trace: {
          kind: "answered",
          trace: {
            schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
            servedLines: [
              { recordId: SERVED_CANARY, leg: "anchor", rank: 1, score: 1.48695 },
              { recordId: SERVED_PLAIN, leg: "lexical", rank: 2, score: 0.73112 },
            ],
            truncated: [{ recordId: CUT, leg: "dense", rank: 21, score: 0.11 }],
          },
        },
        planSource: { kind: "procedure-replay", procedureId: REPLAYED, guard: { checksPassed: 3, total: 3 } },
        retrievalRung: { schemaVersion: 2, rung: "bundle-scan", reason: "index-locked" },
      },
      {
        testId: "t_default_view",
        testIndex: 0,
        stepIndex: 1,
        stepText: "search for socks",
        served: {
          channel1: [],
          channel2: [{ id: OPENED_GONE, detailLevel: "summary", bodyDigest: GONE_DIGEST, contentAbsence: { reason: "not-found" } }],
          channel3: [],
        },
        trace: { kind: "no-trace", reason: "pre-trace-run" },
        planSource: { kind: "procedure-hint", procedureId: HINTED },
      },
    ],
    curation: { status: "complete", counts: { curated: 4, deprecated: 1 } },
    learned: {
      changes: snap.rows.flatMap(row => row.changes.map(entry => ({
        ...entry.change,
        recordContent: content(SUMMARIES[entry.change.recordId] ?? "a recorded change"),
      }))),
      canaryAttributions: [
        { testIndex: 0, stepIndex: 0, recordId: SERVED_CANARY, observationId: "canary-outcome:obs-1", outcome: "confirmed" },
      ],
      curationSnapshot: snap,
      sinceThen: { changes: [], count: 0 },
    },
  })
  const view = projectKnowledgeView({ kind: "read", projection })
  if (view.state !== "ready") throw new Error("expected a ready view")
  return view
}

// ── Reading the page ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS = ["used", "effect", "changes"] as const

function sectionOf(host: HTMLElement, name: string): HTMLElement {
  const section = host.querySelector<HTMLElement>(`[data-knowledge-section="${name}"]`)
  expect(section, `no ${name} section`).not.toBeNull()
  return section as HTMLElement
}

function detailsOf(host: HTMLElement): HTMLElement {
  return sectionOf(host, "retrieval-details")
}

function collapsibleStateOf(host: HTMLElement): string | null {
  return detailsOf(host).querySelector('[data-slot="collapsible"]')?.getAttribute("data-state") ?? null
}

/** Opens Retrieval details, then every disclosure inside it, until nothing inside is closed. */
function openEverything(host: HTMLElement): void {
  for (let pass = 0; pass < 10; pass += 1) {
    const closed = Array.from(detailsOf(host).querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"][data-state="closed"]'))
    if (closed.length === 0) return
    for (const trigger of closed) act(() => { trigger.click() })
  }
  throw new Error("Retrieval details kept a disclosure closed")
}

describe("the default view never shows a record id", () => {
  it("NO-ID-IN-DEFAULT-VIEW: the used, effect and changes sections carry no id or digest, no row leads with one, and the not-found record still has its row", () => {
    const host = mount(<TabKnowledge view={richView()} />)

    for (const name of DEFAULT_SECTIONS) {
      const html = sectionOf(host, name).outerHTML
      for (const id of [...RECORD_IDS, ...DIGESTS]) {
        expect(html.includes(id), `${name} section carries ${id}`).toBe(false)
      }
    }

    const primaries = Array.from(host.querySelectorAll("[data-row-primary]")).map(el => (el.textContent ?? "").trim())
    expect(primaries.length).toBeGreaterThan(0)
    for (const primary of primaries) {
      expect(primary, `a row leads with a record id: ${primary}`).not.toMatch(CONTENT_DERIVED_ID)
    }

    // The not-found opened record keeps its row, led by the absence lead rather than by its id.
    const gone = sectionOf(host, "used").querySelector('li[data-content-absence="not-found"]')
    expect(gone?.querySelector("[data-row-primary]")?.textContent).toBe(RECORD_UNREADABLE_LEAD)
  })

  it("IDS-ONLY-IN-DETAILS: once Retrieval details and its rows are opened, every one of those ids reads inside it", () => {
    const host = mount(<TabKnowledge view={richView()} />)
    openEverything(host)

    const details = detailsOf(host).outerHTML
    for (const id of [...RECORD_IDS, ...DIGESTS]) {
      expect(details.includes(id), `Retrieval details is missing ${id}`).toBe(true)
    }
    // Opening the ledger put nothing into the three sections above it.
    for (const name of DEFAULT_SECTIONS) {
      const html = sectionOf(host, name).outerHTML
      for (const id of RECORD_IDS) expect(html.includes(id), `${name} section carries ${id}`).toBe(false)
    }
  })
})

describe("the default view speaks no retrieval machinery", () => {
  const MACHINERY = ["canary", "leg ", "rank ", "score ", "attribution", "digest", "tier ", "channel"]

  it("NO-MACHINERY-IN-DEFAULT-VIEW: the three sections' text names no storage word and no trust number", () => {
    const host = mount(<TabKnowledge view={richView()} />)

    for (const name of DEFAULT_SECTIONS) {
      const text = (sectionOf(host, name).textContent ?? "").toLowerCase()
      expect(text.length).toBeGreaterThan(0)
      for (const word of [...MACHINERY, ...TRUST_NUMBERS]) {
        expect(text.includes(word), `${name} section says ${JSON.stringify(word)}: ${text}`).toBe(false)
      }
    }

    // The same words DO live one disclosure away, so the absence above is not an empty fixture.
    openEverything(host)
    const details = (detailsOf(host).textContent ?? "").toLowerCase()
    for (const word of ["canary", "leg ", "rank ", "score ", "attribution", "tier ", "channel", ...TRUST_NUMBERS]) {
      expect(details.includes(word), `Retrieval details lacks ${JSON.stringify(word)}`).toBe(true)
    }
  })

  it("DETAILS-COLLAPSED-BY-DEFAULT: Retrieval details is closed on first paint and closed again after a remount", () => {
    const first = mount(<TabKnowledge view={richView()} />)
    expect(collapsibleStateOf(first)).toBe("closed")
    expect(detailsOf(first).querySelector("[data-step-index]")).toBeNull()

    openEverything(first)
    expect(collapsibleStateOf(first)).toBe("open")
    unmount()

    const second = mount(<TabKnowledge view={richView()} />)
    expect(collapsibleStateOf(second)).toBe("closed")
    expect(detailsOf(second).querySelector("[data-step-index]")).toBeNull()
  })
})
