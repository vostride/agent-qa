import { RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom

// 427 · D-19 — Retrieval details, the one place technical facts live. These cells pin what a reader
// finds once the section is open: each step's recorded retrieval level when it was below the full
// index, and a copy button on every record id whose result is announced, failure included.
// Views are built through the real projectKnowledgeView over schema-parsed projections.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunKnowledgeProjectionSchema } from "@vostride/agent-qa-schema"

import { RetrievalDetails } from "@/components/run-detail/retrieval-details"
import {
  RECORD_ID_COPIED_TEXT,
  copyRecordIdLabel,
  ledgerRungLine,
  projectKnowledgeView,
  recordIdCopyFailedText,
  type KnowledgeView,
} from "@/lib/knowledge-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(navigator, "clipboard")
})

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(element) })
  return container
}

function click(element: Element | null | undefined): void {
  if (element === null || element === undefined) throw new Error("nothing to click")
  act(() => { (element as HTMLElement).click() })
}

function step(stepIndex: number, extra: Record<string, unknown> = {}) {
  return {
    testId: "t_details",
    testIndex: 0,
    stepIndex,
    stepText: `step text ${String(stepIndex)}`,
    served: {
      channel1: [{
        id: `fact-el-button-step-${String(stepIndex)}-0f9a1c2b3d4e5f60`,
        kind: "fact",
        summary: `served on step ${String(stepIndex)}`,
        trust: 0.9,
        status: "active",
        servedAsCanary: false,
        tier: "confirmed",
      }],
      channel2: [],
      channel3: [],
    },
    trace: { kind: "no-trace", reason: "pre-trace-run" },
    ...extra,
  }
}

function readyView(steps: ReturnType<typeof step>[], changes: unknown[] = []): Extract<KnowledgeView, { state: "ready" }> {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: "run-427-10-details",
    buildOrdinal: 1,
    knowledgeStore: "bound",
    steps,
    curation: { status: "complete", counts: { curated: changes.length, deprecated: 0 } },
    learned: { changes, canaryAttributions: [] },
  })
  const view = projectKnowledgeView({ kind: "read", projection })
  if (view.state !== "ready") throw new Error("expected a ready view")
  return view
}

/** Retrieval details mounted, opened, and every step row expanded. */
function openDetails(view: Extract<KnowledgeView, { state: "ready" }>): HTMLElement {
  const host = mount(<RetrievalDetails ledger={view.ledger} />)
  click(host.querySelector('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]'))
  for (const row of Array.from(host.querySelectorAll("[data-step-index]"))) {
    click(row.querySelector('[data-slot="collapsible-trigger"]'))
  }
  return host
}

describe("each step states the retrieval level it recorded, only when it was below the full index", () => {
  it("LEDGER-RUNG-LINE: a bundle-scan step reads its level and cause; a memidex step and a step with no rung read none", () => {
    const view = readyView([
      step(0, { retrievalRung: { schemaVersion: 2, rung: "bundle-scan", reason: "index-locked" } }),
      step(1, { retrievalRung: { schemaVersion: 2, rung: "memidex" } }),
      step(2),
    ])

    expect(view.ledger.steps[0]?.detail.rung).toEqual({ rung: "bundle-scan", reason: "index-locked" })
    expect(view.ledger.steps[1]?.detail).not.toHaveProperty("rung")
    expect(view.ledger.steps[2]?.detail).not.toHaveProperty("rung")

    const host = openDetails(view)
    const rows = Array.from(host.querySelectorAll("[data-step-index]"))
    const rungLines = rows.map(row => row.querySelector("[data-ledger-rung]")?.textContent ?? null)
    expect(rungLines).toEqual([ledgerRungLine("bundle-scan", "index-locked"), null, null])
    expect(ledgerRungLine("bundle-scan", "index-locked"))
      .toBe("Retrieval level: bundle scan — knowledge index locked by another process, scanning bundles")
    expect(ledgerRungLine("static-floor")).toBe("Retrieval level: static-floor embeddings")
  })
})

describe("every record id copies, and the result is announced", () => {
  const SERVED = "fact-el-button-step-0-0f9a1c2b3d4e5f60"
  const CHANGED = "fact-page-https-example-com-9f2c1ad4"

  function copyButtonFor(host: HTMLElement, id: string): HTMLElement {
    const buttons = Array.from(host.querySelectorAll<HTMLElement>("[data-record-id-copy]"))
    expect(buttons.length, `no record id copy button in Retrieval details (looking for ${id})`).toBeGreaterThan(0)
    const button = buttons.find(candidate => candidate.getAttribute("aria-label") === copyRecordIdLabel(id))
    expect(button, `no copy button for ${id}`).toBeDefined()
    return button as HTMLElement
  }

  function statusOf(button: HTMLElement): HTMLElement | null {
    return button.parentElement?.querySelector<HTMLElement>('[role="status"]') ?? null
  }

  function detailsWithAChange(): HTMLElement {
    return openDetails(readyView([step(0)], [{ schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: CHANGED, change: "confirmed", atOrdinal: 12 }]))
  }

  it("ID-COPY-ANNOUNCES-FAILURE: with no clipboard the button reads failed, the polite status spells the id, and no check shows", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
    const host = detailsWithAChange()

    for (const id of [SERVED, CHANGED]) {
      const button = copyButtonFor(host, id)
      expect(button.getAttribute("aria-label")).toBe(copyRecordIdLabel(id))
      expect(button.getAttribute("data-copy-status")).toBe("idle")

      await act(async () => { button.click() })

      expect(button.getAttribute("data-copy-status")).toBe("failed")
      const status = statusOf(button)
      expect(status?.getAttribute("aria-live")).toBe("polite")
      expect(status?.className).toContain("sr-only")
      expect(status?.textContent).toBe(recordIdCopyFailedText(id))
      expect(button.querySelector("svg")?.getAttribute("class")).not.toContain("text-success")
    }
    expect(recordIdCopyFailedText(CHANGED)).toBe(`Could not copy — select the id to copy it: ${CHANGED}`)
    expect(copyRecordIdLabel(CHANGED)).toBe(`Copy record id ${CHANGED}`)
  })

  it("ID-COPY-ANNOUNCES-FAILURE: a rejected write is announced as a failure, never as a copy", async () => {
    const writeText = vi.fn(async (_text: string) => { throw new Error("denied") })
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const host = detailsWithAChange()
    const button = copyButtonFor(host, CHANGED)

    await act(async () => { button.click() })

    expect(writeText).toHaveBeenCalledExactlyOnceWith(CHANGED)
    expect(button.getAttribute("data-copy-status")).toBe("failed")
    expect(statusOf(button)?.textContent).toBe(recordIdCopyFailedText(CHANGED))
    expect(button.querySelector("svg")?.getAttribute("class")).not.toContain("text-success")
  })

  it("a resolved write copies exactly the id, shows the check and announces it", async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const host = detailsWithAChange()
    const button = copyButtonFor(host, SERVED)

    await act(async () => { button.click() })

    expect(writeText).toHaveBeenCalledExactlyOnceWith(SERVED)
    expect(button.getAttribute("data-copy-status")).toBe("copied")
    expect(statusOf(button)?.textContent).toBe(RECORD_ID_COPIED_TEXT)
    expect(RECORD_ID_COPIED_TEXT).toBe("Record id copied to the clipboard")
    // RE-SPELLED 2026-10-03 (quick 261003-cpv): both copy controls wear the success token.
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("text-success")
  })

  it("gives both ids of a supersession their own copy button, and keeps each id line's text the id alone", () => {
    const host = openDetails(readyView([], [
      { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: "fact-old", change: "superseded", atOrdinal: 13, byRecordId: "fact-new" },
      { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: "fact-new", change: "added", atOrdinal: 13 },
    ]))

    const record = host.querySelector('dl[data-ledger-changes] dd[data-ledger-row="record"]')
    expect(record?.querySelectorAll("[data-record-id-copy]").length).toBe(2)
    expect(Array.from(record?.querySelectorAll("[data-record-id-copy]") ?? []).map(b => b.getAttribute("aria-label")))
      .toEqual([copyRecordIdLabel("fact-new"), copyRecordIdLabel("fact-old")])
    expect(Array.from(record?.children ?? []).map(child => child.textContent)).toEqual(["fact-new", "fact-old"])
  })
})
