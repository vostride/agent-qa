// @vitest-environment jsdom

// Views come from the real `projectKnowledgeView` over schema-parsed projections.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { RunKnowledgeProjectionSchema, type RetrievalRung, type RetrievalRungReason } from "@vostride/agent-qa-schema"

import { KnowledgeUsed } from "@/components/run-detail/knowledge-used"
import { TabKnowledge } from "@/components/run-detail/tab-knowledge"
import {
  DOCTOR_POINTER_TEXT,
  USED_HEADING,
  projectKnowledgeView,
  retrievalStatement,
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
})

function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(element) })
  return container
}

type LowerRung = Exclude<RetrievalRung, "memidex">

interface Recorded {
  readonly rung: RetrievalRung
  readonly reason?: RetrievalRungReason
}

function servedStep() {
  return {
    testId: "t_retrieval",
    testIndex: 0,
    stepIndex: 0,
    stepText: "open the cart",
    served: {
      channel1: [{ id: "rec_a", kind: "fact", summary: "the cart lives at /view_cart", trust: 0.9, status: "active", servedAsCanary: false, tier: "confirmed" }],
      channel2: [],
      channel3: [],
    },
    trace: { kind: "no-trace", reason: "pre-trace-run" },
  }
}

function view(recorded: Recorded | undefined, options: { withRows?: boolean; knowledgeStore?: "bound" | "unbound" } = {}): KnowledgeView {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: "run-427-11-retrieval",
    buildOrdinal: 1,
    knowledgeStore: options.knowledgeStore ?? "bound",
    steps: options.withRows === true ? [servedStep()] : [],
    curation: { status: "complete" },
    learned: { changes: [], canaryAttributions: [] },
    ...(recorded === undefined ? {} : { retrievalRung: { schemaVersion: 2, ...recorded } }),
  })
  return projectKnowledgeView({ kind: "read", projection })
}

function usedSection(recorded: Recorded | undefined, withRows = false): HTMLElement {
  const ready = view(recorded, { withRows })
  if (ready.state !== "ready") throw new Error("expected a ready view")
  return mount(<KnowledgeUsed view={ready.used} />)
}

function glyphClass(el: Element | null | undefined): string {
  return [...(el?.querySelector("svg")?.classList ?? [])].find(name => name.startsWith("lucide-")) ?? ""
}

const statement = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-retrieval-statement]")

const INFO: ReadonlyArray<readonly [LowerRung, RetrievalRungReason | undefined, string, string]> = [
  ["bundle-scan", "index-not-built", "fresh-index", "lucide-package-open"],
  ["bundle-scan", "index-unavailable", "cause-not-recorded", "lucide-circle-question-mark"],
  ["lexical-only", undefined, "cause-not-recorded", "lucide-circle-question-mark"],
  ["static-floor", "profile-static-configured", "by-configuration", "lucide-sliders-horizontal"],
  ["lexical-only", "floor-disabled", "by-configuration", "lucide-sliders-horizontal"],
]

const WARNING: ReadonlyArray<readonly [LowerRung, RetrievalRungReason, string, string]> = [
  ["bundle-scan", "index-locked", "index-problem", "lucide-triangle-alert"],
  ["bundle-scan", "index-corrupt", "index-problem", "lucide-triangle-alert"],
  ["static-floor", "native-runtime-unavailable", "semantic-search-unavailable", "lucide-search-x"],
]

function recorded(rung: LowerRung, reason: RetrievalRungReason | undefined): Recorded {
  return { rung, ...(reason === undefined ? {} : { reason }) }
}

describe("the tab states every lower retrieval level in plain words", () => {
  it.each(INFO)("TAB-STATEMENT-PER-CLASS: %s / %s reads as %s information", (rung, reason, cls, glyph) => {
    const host = usedSection(recorded(rung, reason))
    const el = statement(host)
    expect(el).not.toBeNull()
    expect(el?.tagName).toBe("P")
    expect(el?.getAttribute("data-retrieval-class")).toBe(cls)
    expect(el?.getAttribute("data-retrieval-tone")).toBe("info")
    expect(el?.getAttribute("data-rung")).toBe(rung)
    if (reason === undefined) expect(el?.hasAttribute("data-rung-reason")).toBe(false)
    else expect(el?.getAttribute("data-rung-reason")).toBe(reason)
    expect(el?.getAttribute("class")).toContain("text-xs")
    expect(el?.getAttribute("class")).toContain("text-muted-foreground")
    expect(glyphClass(el)).toBe(glyph)
    expect(el?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
    expect(el?.textContent).toBe(retrievalStatement(rung, reason))
  })

  it.each(WARNING)("TAB-STATEMENT-PER-CLASS: %s / %s reads as a %s warning with the doctor pointer", (rung, reason, cls, glyph) => {
    const host = usedSection(recorded(rung, reason))
    const el = statement(host)
    expect(el).not.toBeNull()
    expect(el?.tagName).toBe("DIV")
    expect(el?.getAttribute("role")).toBe("note")
    expect(el?.getAttribute("data-retrieval-class")).toBe(cls)
    expect(el?.getAttribute("data-retrieval-tone")).toBe("warning")
    expect(el?.getAttribute("data-rung")).toBe(rung)
    expect(el?.getAttribute("data-rung-reason")).toBe(reason)
    expect(el?.getAttribute("class")).toContain("border-amber-500/20")
    expect(el?.getAttribute("class")).toContain("bg-amber-500/5")
    expect(glyphClass(el)).toBe(glyph)
    expect(el?.querySelector("svg")?.getAttribute("class")).toContain("text-amber-500")
    const [sentence, pointer] = [...(el?.querySelectorAll("p") ?? [])]
    expect(sentence?.textContent).toBe(retrievalStatement(rung, reason))
    expect(pointer?.hasAttribute("data-doctor-pointer")).toBe(true)
    expect(el?.textContent).toBe(`${retrievalStatement(rung, reason)}${DOCTOR_POINTER_TEXT}`)
  })

  it("NO-POINTER-ON-INFO: no info statement carries the doctor pointer or names doctor", () => {
    for (const [rung, reason] of INFO) {
      const host = usedSection(recorded(rung, reason))
      expect(statement(host)).not.toBeNull()
      expect(host.querySelector("[data-doctor-pointer]")).toBeNull()
      expect(host.textContent).not.toContain("agent-qa doctor")
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
  })

  it("STATEMENT-TEXT-EQUALS-CONSTANT: the pointer's text is the constant byte for byte, with the command in code and no backtick anywhere", () => {
    for (const [rung, reason] of WARNING) {
      const host = usedSection(recorded(rung, reason))
      const pointer = host.querySelector("[data-doctor-pointer]")
      expect(pointer?.textContent).toBe(DOCTOR_POINTER_TEXT)
      expect(pointer?.querySelector("code")?.textContent).toBe("agent-qa doctor")
      expect(pointer?.querySelector("code")?.getAttribute("class")).toContain("font-mono")
      expect(statement(host)?.textContent).not.toContain("`")
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
    for (const [rung, reason] of INFO) {
      const host = usedSection(recorded(rung, reason))
      expect(statement(host)?.textContent).not.toContain("`")
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
  })
})

describe("memidex, no rung and no store say nothing; the statement sits under the heading", () => {
  it("MEMIDEX-NOTHING: memidex, a run with no recorded rung and an unbound store render no statement", () => {
    expect(statement(usedSection({ rung: "memidex" }, true))).toBeNull()
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    expect(statement(usedSection(undefined, true))).toBeNull()
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    const host = mount(<TabKnowledge view={view({ rung: "bundle-scan", reason: "index-corrupt" }, { knowledgeStore: "unbound" })} />)
    expect(host.querySelector("[data-retrieval-statement]")).toBeNull()
    expect(host.textContent).not.toContain("agent-qa doctor")
  })

  it("MEMIDEX-NOTHING: the statement follows the heading row and precedes the rows or the absence sentence", () => {
    const withRows = usedSection({ rung: "bundle-scan", reason: "index-not-built" }, true)
    const section = withRows.querySelector("[data-knowledge-section='used']")
    const children = [...(section?.children ?? [])]
    const headingRow = children.findIndex(child => child.querySelector("h4")?.textContent === USED_HEADING)
    const at = children.findIndex(child => child.hasAttribute("data-retrieval-statement"))
    const list = children.findIndex(child => child.tagName === "UL")
    expect(headingRow).toBe(0)
    expect(at).toBe(1)
    expect(list).toBeGreaterThan(at)
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined

    const empty = usedSection({ rung: "static-floor", reason: "native-runtime-unavailable" })
    const emptyChildren = [...(empty.querySelector("[data-knowledge-section='used']")?.children ?? [])]
    const statementAt = emptyChildren.findIndex(child => child.hasAttribute("data-retrieval-statement"))
    const absenceAt = emptyChildren.findIndex(child => child.hasAttribute("data-section-absence"))
    expect(statementAt).toBe(1)
    expect(absenceAt).toBeGreaterThan(statementAt)
  })

  it("the statement sits in the default view, so it speaks none of Retrieval details' machinery words", () => {
    // knowledge-default-view.test.tsx's MACHINERY list, applied to every class's rendered text.
    const machinery = ["canary", "leg ", "rank ", "score ", "attribution", "digest", "tier ", "channel"]
    for (const [rung, reason] of [...INFO, ...WARNING]) {
      const host = usedSection(recorded(rung, reason))
      const text = (statement(host)?.textContent ?? "").toLowerCase()
      expect(text.length).toBeGreaterThan(0)
      for (const word of machinery) expect(text.includes(word), `${rung}/${String(reason)} says ${word}`).toBe(false)
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
  })

  it("the tab statement never truncates: it wraps and shows the whole sentence", () => {
    for (const [rung, reason] of [...INFO, ...WARNING]) {
      const host = usedSection(recorded(rung, reason))
      const el = statement(host)
      for (const node of [el, ...(el?.querySelectorAll("*") ?? [])]) {
        expect(node?.getAttribute("class") ?? "").not.toMatch(/\btruncate\b|line-clamp/)
      }
      expect(el?.textContent).toContain(retrievalStatement(rung, reason))
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
    }
  })
})
