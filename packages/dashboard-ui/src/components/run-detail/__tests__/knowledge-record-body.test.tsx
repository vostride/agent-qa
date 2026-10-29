// @vitest-environment jsdom

// Show full record: the record as read, its track record, then the curator's unverified note.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { RunKnowledgeProjectionSchema } from "@vostride/agent-qa-schema"

import { KnowledgeUsed } from "@/components/run-detail/knowledge-used"
import {
  EVIDENCE_NOTE_LABEL,
  SHOW_FULL_RECORD_LABEL,
  currentStatusLine,
  projectKnowledgeView,
  trustCountsLine,
} from "@/lib/knowledge-view"

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
  act(() => { root?.render(element) })
  return container
}

interface RecordShape {
  readonly body?: string
  readonly status?: string
  readonly confirmations?: number
  readonly contradictions?: number
  readonly narrative?: string
}

function recordContent(record: RecordShape) {
  return {
    content: record.body ?? "the cart page lives at /view_cart",
    summary: "the cart page",
    kind: "fact",
    applicability: { product: "shop", scope: "shop", anchors: [] as string[], openedAtOrdinal: 1 },
    currentStatus: record.status ?? "active",
    currentTrust: {
      confirmations: record.confirmations ?? 1,
      contradictions: record.contradictions ?? 0,
      evidenceTokens: ["evtok-7f3e"],
      lastEventOrdinal: 2,
      ...(record.narrative === undefined ? {} : { trustNarrative: record.narrative }),
    },
  }
}

function mountRecord(record: RecordShape | undefined): HTMLElement {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: "run-427-06-record",
    buildOrdinal: 1,
    knowledgeStore: "bound",
    steps: [{
      testId: "t_record",
      testIndex: 0,
      stepIndex: 0,
      stepText: "open the cart",
      served: {
        channel1: [{
          id: "rec_a",
          kind: "fact",
          summary: "the cart page",
          trust: 0.8765,
          status: "active",
          servedAsCanary: false,
          tier: "provisional",
          ...(record === undefined ? {} : { recordContent: recordContent(record) }),
        }],
        channel2: [],
        channel3: [],
      },
      trace: { kind: "no-trace", reason: "pre-trace-run" },
    }],
    curation: { status: "complete" },
    learned: { changes: [], canaryAttributions: [] },
  })
  const view = projectKnowledgeView({ kind: "read", projection })
  if (view.state !== "ready") throw new Error("expected a ready view")
  return mount(<KnowledgeUsed view={view.used} />)
}

function triggerOf(view: HTMLElement): HTMLElement | undefined {
  return [...view.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]')]
    .find(element => element.textContent === SHOW_FULL_RECORD_LABEL)
}

function open(view: HTMLElement): HTMLElement | null {
  const trigger = triggerOf(view)
  expect(trigger).toBeDefined()
  act(() => { trigger?.click() })
  return view.querySelector<HTMLElement>("[data-full-record]")
}

function attributeOrder(full: HTMLElement | null): (string | undefined)[] {
  return [...(full?.children ?? [])].map(child =>
    ["data-record-current-status", "data-record-content", "data-trust-counts", "data-evidence-note"].find(name => child.hasAttribute(name)))
}

describe("the full record reads in one order (memory.md §7.5)", () => {
  it("FULL-RECORD-ORDER: current status, the body with its line breaks, the counts, then the labelled note", () => {
    const full = open(mountRecord({ body: "line one\nline two", status: "superseded", confirmations: 2, contradictions: 1, narrative: "Seen twice.\nOnce contradicted." }))
    expect(full).not.toBeNull()
    expect(full?.className).toContain("bg-muted/40")
    expect(attributeOrder(full)).toEqual(["data-record-current-status", "data-record-content", "data-trust-counts", "data-evidence-note"])

    expect(full?.querySelector("[data-record-current-status]")?.textContent).toBe(currentStatusLine("superseded"))
    expect(currentStatusLine("superseded")).toBe("Current status: superseded")
    expect(currentStatusLine("active")).toBe("Current status: in use")
    expect(currentStatusLine("candidate")).toBe("Current status: on trial")
    expect(currentStatusLine("deprecated")).toBe("Current status: retired")

    const body = full?.querySelector<HTMLElement>("[data-record-content]")
    expect(body?.textContent).toBe("line one\nline two")
    expect(body?.className).toContain("whitespace-pre-wrap")
    expect(body?.className).toContain("wrap-anywhere")

    const note = full?.querySelector<HTMLElement>("[data-evidence-note]")
    expect(note?.firstElementChild?.textContent).toBe(EVIDENCE_NOTE_LABEL)
    expect(EVIDENCE_NOTE_LABEL).toBe("Curator's note — written by the curator, not verified")
    expect(note?.lastElementChild?.textContent).toBe("Seen twice.\nOnce contradicted.")
    expect(note?.lastElementChild?.className).toContain("whitespace-pre-wrap")
    expect(note?.className).toContain("pl-2")

    for (const element of [full, ...(full?.querySelectorAll("*") ?? [])]) {
      expect(element?.getAttribute("class") ?? "").not.toMatch(/max-h-|line-clamp|overflow-(auto|scroll|hidden)|truncate/)
    }
    for (const hidden of ["0.8765", "provisional", "evtok-7f3e"]) expect(full?.textContent).not.toContain(hidden)
  })

  it("FULL-RECORD-ORDER: a row with no joined record has no Show full record trigger at all", () => {
    const view = mountRecord(undefined)
    expect(triggerOf(view)).toBeUndefined()
    expect(view.querySelector("[data-full-record]")).toBeNull()
  })
})

describe("the curator's note is never the only thing said (memory.md §7.5)", () => {
  it("EVIDENCE-NOTE-NEVER-ALONE: no narrative means counts alone; with one, the counts always come first", () => {
    const bare = open(mountRecord({ confirmations: 0, contradictions: 0 }))
    expect(bare?.querySelector("[data-trust-counts]")?.textContent).toBe("Confirmed 0 times · contradicted 0 times")
    expect(bare?.querySelector("[data-evidence-note]")).toBeNull()
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined

    const shapes: RecordShape[] = [
      { narrative: "n" },
      { narrative: "n", confirmations: 0, contradictions: 0 },
      { narrative: "", body: "" },
      { confirmations: 5, contradictions: 5 },
    ]
    for (const shape of shapes) {
      const full = open(mountRecord(shape))
      expect(full?.querySelector("[data-trust-counts]")).not.toBeNull()
      const note = full?.querySelector("[data-evidence-note]")
      if (note !== null && note !== undefined) {
        expect(note.previousElementSibling?.hasAttribute("data-trust-counts")).toBe(true)
      }
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
  })

  it("TRUST-COUNTS-LINE: the rendered counts line reads once for 1 and is tabular", () => {
    const full = open(mountRecord({ confirmations: 1, contradictions: 0 }))
    const counts = full?.querySelector<HTMLElement>("[data-trust-counts]")
    expect(counts?.textContent).toBe(trustCountsLine(1, 0))
    expect(counts?.textContent).toBe("Confirmed once · contradicted 0 times")
    expect(counts?.className).toContain("tabular-nums")
  })
})

describe("producer text in the full record is text", () => {
  it("RECORD-BODY-HOSTILE-TEXT: a body and a note shaped like markup render as text and create no element", () => {
    const hostile = "<img src=x onerror=alert(1)>"
    const full = open(mountRecord({ body: hostile, narrative: hostile }))
    expect(full?.querySelector("[data-record-content]")?.textContent).toBe(hostile)
    expect(full?.querySelector("[data-evidence-note]")?.lastElementChild?.textContent).toBe(hostile)
    expect(container?.querySelector("img")).toBeNull()
  })
})
