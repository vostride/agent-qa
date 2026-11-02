// @vitest-environment jsdom

// Views come from the real `effectSectionView` over schema-parsed projections.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunKnowledgeProjectionSchema, type RunKnowledgeProjection } from "@vostride/agent-qa-schema"

import { KnowledgeEffect } from "@/components/run-detail/knowledge-effect"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  EFFECT_HEADING,
  EFFECT_NOTHING_MEASURED_TEXT,
  EFFECT_NOTHING_USED_TEXT,
  EFFECT_OUTCOMES,
  UNCOUNTED_TRIALS_TOOLTIP,
  effectSectionView,
  uncountedTrialsLine,
  unmeasuredRecordsLine,
  type EffectSectionView,
  type StepRefContext,
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
  act(() => { root?.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>) })
  return container
}

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: "ready" }>
type Outcome = "confirmed" | "contradicted" | "helpful" | "harmful"

function line(id: string, summary: string, canary = true) {
  return { id, kind: "fact", summary, trust: 0.9, status: "candidate", servedAsCanary: canary, tier: "confirmed" }
}

function step(stepIndex: number, channel1: ReturnType<typeof line>[], planSource?: Record<string, unknown>) {
  return {
    testId: "t_effect",
    testIndex: 0,
    stepIndex,
    stepText: `step text ${String(stepIndex)}`,
    served: { channel1, channel2: [], channel3: [] },
    trace: { kind: "no-trace", reason: "pre-trace-run" },
    ...(planSource === undefined ? {} : { planSource }),
  }
}

function attributed(recordId: string, stepIndex: number, outcome: Outcome) {
  return { testIndex: 0, stepIndex, recordId, observationId: `obs-${recordId}`, outcome }
}

function projection(
  steps: ReturnType<typeof step>[],
  learned: { attributions?: ReturnType<typeof attributed>[]; status?: "pending" | "complete"; scanIncomplete?: true } = {},
): ReadyProjection {
  const parsed = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: "run-effect",
    buildOrdinal: 1,
    knowledgeStore: "bound",
    steps,
    curation: { status: learned.status ?? "complete" },
    learned: {
      changes: [],
      canaryAttributions: learned.attributions ?? [],
      ...(learned.scanIncomplete === undefined ? {} : { scanIncomplete: true }),
    },
  })
  if (parsed.kind !== "ready") throw new Error("expected a ready projection")
  return parsed
}

// Runner-shaped: `total` counts this test step's attempted actions; the procedure's size is `flow.length`.
function replay(procedureId: string, guard: Record<string, unknown>, flow?: { cursor: number; length: number }) {
  return { kind: "procedure-replay", procedureId, guard, ...(flow === undefined ? {} : { flow }) }
}

const PASSED = { checksPassed: 1, total: 1 }

// Seven outcomes from one settled, partially read run; the eighth (pending) from an unsettled one;
// the uncounted line from a settled, clean-read run.
function everyOutcome(): EffectSectionView {
  const settled = effectSectionView(projection(
    [
      step(0, [line("rec_c", "the coupon field accepts lowercase"), line("rec_h", "the sale banner is accurate")]),
      step(1, [line("rec_k", "the cart badge counts items"), line("rec_p", "search is instant")]),
      step(2, [line("rec_u", "the filter panel remembers choices")], replay("rec_r", PASSED, { cursor: 0, length: 2 })),
      step(3, [], replay("rec_r", PASSED, { cursor: 1, length: 2 })),
      step(4, [], replay(
        "rec_s",
        { checksPassed: 0, total: 1, miss: { procedureStepIndex: 0, reason: "descriptor-missing" } },
        { cursor: 0, length: 3 },
      )),
    ],
    {
      scanIncomplete: true,
      attributions: [
        attributed("rec_c", 0, "contradicted"),
        attributed("rec_h", 0, "harmful"),
        attributed("rec_k", 1, "confirmed"),
        attributed("rec_p", 1, "helpful"),
      ],
    },
  ))
  const unsettled = effectSectionView(projection([step(4, [line("rec_w", "the footer links to help")])], { status: "pending" }))
  const clean = effectSectionView(projection([step(5, [line("rec_q1", "quiet trial one"), line("rec_q2", "quiet trial two")])]))
  const entries = [...settled.entries, ...unsettled.entries].map((entry, index) => ({ ...entry, key: String(index) }))
  if (clean.uncounted === undefined) throw new Error("expected uncounted trials")
  return { entries, uncounted: clean.uncounted }
}

function section(view: HTMLElement): HTMLElement {
  const found = view.querySelector<HTMLElement>('[data-knowledge-section="effect"]')
  if (found === null) throw new Error("no effect section")
  return found
}

function entries(view: HTMLElement): HTMLElement[] {
  return [...view.querySelectorAll<HTMLElement>("li[data-effect-entry]")]
}

function describedBy(trigger: HTMLElement | null | undefined): { ids: string[]; targets: Array<HTMLElement | null> } {
  const ids = (trigger?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id.length > 0)
  return { ids, targets: ids.map(id => document.getElementById(id)) }
}

function glyphClass(entry: HTMLElement): string {
  return [...(entry.querySelector("svg")?.classList ?? [])].find(name => name.startsWith("lucide-")) ?? ""
}

describe("every outcome has its own glyph and tone", () => {
  it("EFFECT-GLYPH-PER-OUTCOME: eight outcomes, eight distinct aria-hidden glyphs, tone classes by group", () => {
    const view = mount(<KnowledgeEffect view={everyOutcome()} />)

    const rendered = entries(view)
    expect(rendered.map(entry => entry.getAttribute("data-effect-outcome")).sort()).toEqual([...EFFECT_OUTCOMES].sort())
    const glyphs = Object.fromEntries(rendered.map(entry => [entry.getAttribute("data-effect-outcome"), glyphClass(entry)]))
    expect(glyphs).toEqual({
      contradicted: "lucide-circle-x",
      harmful: "lucide-thumbs-down",
      "replay-stopped": "lucide-list-x",
      confirmed: "lucide-circle-check",
      helpful: "lucide-thumbs-up",
      "replay-complete": "lucide-list-checks",
      pending: "lucide-hourglass",
      unknown: "lucide-circle-question-mark",
    })

    for (const entry of rendered) {
      const tone = entry.getAttribute("data-effect-tone")
      const glyph = entry.querySelector("svg")
      const sentence = entry.querySelector("[data-effect-sentence]")
      expect(glyph?.getAttribute("aria-hidden")).toBe("true")
      expect(entry.className).toContain("grid-cols-[auto_minmax(0,1fr)]")
      if (tone === "problem") {
        expect(glyph?.classList.contains("text-destructive")).toBe(true)
        expect(sentence?.classList.contains("text-destructive")).toBe(true)
        expect(sentence?.classList.contains("font-medium")).toBe(true)
      } else if (tone === "positive") {
        expect(glyph?.classList.contains("text-emerald-500")).toBe(true)
        expect(sentence?.classList.contains("text-destructive")).toBe(false)
      } else if (tone === "pending") {
        expect(glyph?.classList.contains("text-amber-500")).toBe(true)
      } else {
        expect(tone).toBe("unknown")
        expect(glyph?.classList.contains("text-muted-foreground")).toBe(true)
        expect(sentence?.classList.contains("text-muted-foreground")).toBe(true)
      }
    }
    expect(rendered.map(entry => entry.getAttribute("data-effect-tone"))).toEqual([
      "problem", "problem", "problem", "positive", "positive", "positive", "unknown", "pending",
    ])
  })
})

describe("a procedure replayed step by step is one entry", () => {
  it("EFFECT-REPLAY-GROUPED: six replayed steps of one six-step procedure paint one sentence sized by its flow", () => {
    const view = mount(<KnowledgeEffect view={effectSectionView(projection([0, 1, 2, 3, 4, 5].map(index => step(
      index,
      index === 0 ? [line("rec_p", "check out as a guest", false)] : [],
      replay("rec_p", PASSED, { cursor: index, length: 6 }),
    ))))} />)

    const rendered = entries(view)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.getAttribute("data-effect-outcome")).toBe("replay-complete")
    expect(rendered[0]?.querySelector("[data-effect-sentence]")?.textContent).toBe("Replayed all 6 of its steps in steps 1–6")
  })
})

describe("the store's words never reach the Effect section", () => {
  it("EFFECT-NO-STORE-WORDS: every outcome, a replay and the uncounted line say none of them", async () => {
    const view = mount(<KnowledgeEffect view={everyOutcome()} />)

    const trigger = view.querySelector<HTMLElement>('[data-effect-uncounted] [data-slot="tooltip-trigger"]')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger?.focus() })
    const text = `${section(view).textContent ?? ""} ${document.querySelector('[role="tooltip"]')?.textContent ?? ""}`.toLowerCase()
    expect(text).toContain("replayed all 2 of its steps")
    for (const word of ["canary", "confirmed", "contradicted", "helpful", "harmful", "attribution", "not attributed"]) {
      expect(text).not.toContain(word)
    }
  })
})

describe("uncounted trials are one quiet, explained line", () => {
  it("EFFECT-UNCOUNTED-TOOLTIP: a focusable trigger with the fixed tooltip, no glyph and no warning tone", async () => {
    const view = mount(<KnowledgeEffect view={everyOutcome()} />)

    const line = view.querySelector<HTMLElement>('[data-effect-uncounted="2"]')
    expect(line).not.toBeNull()
    const trigger = line?.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')
    expect(trigger?.tabIndex).toBe(0)
    expect(trigger?.firstChild?.textContent).toBe(uncountedTrialsLine(2))
    // The meaning is announced without hover, as the other tooltip triggers' is.
    expect(describedBy(trigger).targets[0]?.textContent).toBe(UNCOUNTED_TRIALS_TOOLTIP)
    expect(line?.querySelector("svg")).toBeNull()
    expect(line?.outerHTML).not.toMatch(/amber|destructive/)

    await act(async () => { trigger?.focus() })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(UNCOUNTED_TRIALS_TOOLTIP)
  })

  it("TRIGGER-ACCESSIBLE-NAME: the uncounted line is a button named by its sentence, its meaning its one description, open or closed", async () => {
    const view = mount(<KnowledgeEffect view={everyOutcome()} />)
    const line = view.querySelector<HTMLElement>('[data-effect-uncounted="2"]')
    const trigger = line?.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')

    expect(trigger?.tagName).toBe("BUTTON")
    expect(trigger?.getAttribute("type")).toBe("button")
    for (const attribute of ["role", "aria-label", "title"]) expect(trigger?.hasAttribute(attribute), attribute).toBe(false)
    expect(trigger?.textContent?.trim()).toBe(uncountedTrialsLine(2))
    expect(trigger?.textContent).not.toContain(UNCOUNTED_TRIALS_TOOLTIP)
    for (const name of ["underline", "decoration-dotted", "cursor-help", "text-left"]) expect(trigger?.classList.contains(name), name).toBe(true)
    expect(line?.querySelector("svg")).toBeNull()
    expect(line?.outerHTML).not.toMatch(/amber|destructive/)

    const { ids, targets } = describedBy(trigger)
    expect(ids).toHaveLength(1)
    const description = targets[0]
    expect(description).not.toBeNull()
    expect(trigger?.contains(description ?? null)).toBe(false)
    expect(description?.hasAttribute("hidden")).toBe(true)
    expect(description?.textContent).toBe(UNCOUNTED_TRIALS_TOOLTIP)
    expect(`${trigger?.textContent ?? ""} ${description?.textContent ?? ""}`.split(UNCOUNTED_TRIALS_TOOLTIP).length - 1).toBe(1)

    await act(async () => { trigger?.focus() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.textContent).toBe(UNCOUNTED_TRIALS_TOOLTIP)
    expect(describedBy(trigger).ids).toEqual([tooltip?.id])

    await act(async () => { trigger?.blur() })
    expect(describedBy(trigger).ids).toEqual(ids)
  })

  it("EFFECT-UNCOUNTED-TOOLTIP: the uncounted line follows the absence sentence when nothing else was measured", () => {
    const view = mount(<KnowledgeEffect view={effectSectionView(projection([step(0, [line("rec_q", "a quiet trial")])]))} />)

    expect(view.querySelector("[data-effect-list]")).toBeNull()
    expect(view.querySelector("[data-section-absence]")?.textContent).toBe(EFFECT_NOTHING_MEASURED_TEXT)
    expect(view.querySelector('[data-effect-uncounted="1"] [data-slot="tooltip-trigger"]')?.firstChild?.textContent).toBe(uncountedTrialsLine(1))
    expect(view.querySelector("[data-effect-unmeasured]")).toBeNull()
  })
})

describe("an empty Effect section states its absence", () => {
  it("EFFECT-ABSENCE: knowledge used but nothing measured, and nothing used at all", () => {
    const measuredNothing = mount(<KnowledgeEffect view={effectSectionView(projection([step(0, [line("rec_o", "a plain line", false)])]))} />)
    expect(section(measuredNothing).querySelector("h4")?.textContent).toBe(EFFECT_HEADING)
    expect(measuredNothing.querySelectorAll("[data-section-absence]").length).toBe(1)
    expect(measuredNothing.querySelector("[data-section-absence]")?.textContent).toBe(EFFECT_NOTHING_MEASURED_TEXT)
    expect(measuredNothing.querySelector("[data-effect-list]")).toBeNull()
    act(() => { root?.unmount() })
    root = undefined

    const usedNothing = mount(<KnowledgeEffect view={effectSectionView(projection([step(0, [])]))} />)
    expect(usedNothing.querySelectorAll("[data-section-absence]").length).toBe(1)
    expect(usedNothing.querySelector("[data-section-absence]")?.textContent).toBe(EFFECT_NOTHING_USED_TEXT)
    expect(usedNothing.querySelector("[data-effect-list]")).toBeNull()
  })

  it("EFFECT-ABSENCE: the closing line counts the records with no measured effect, beside at least one entry", () => {
    const view = mount(<KnowledgeEffect view={effectSectionView(projection(
      [step(0, [line("rec_e", "the measured one"), line("rec_o", "a plain line", false), line("rec_z", "another plain line", false)])],
      { attributions: [attributed("rec_e", 0, "helpful")] },
    ))} />)

    const closing = view.querySelector<HTMLElement>('[data-effect-unmeasured="2"]')
    expect(closing?.textContent).toBe(unmeasuredRecordsLine(2))
    expect(closing?.classList.contains("tabular-nums")).toBe(true)
    expect(view.querySelector("[data-section-absence]")).toBeNull()
  })
})

describe("a record summary is text, never markup", () => {
  it("EFFECT-HOSTILE-TEXT: an img-onerror summary renders as text in the record line", () => {
    const hostile = "<img src=x onerror=alert(1)>"
    const view = mount(<KnowledgeEffect view={effectSectionView(projection(
      [step(0, [line("rec_x", hostile)])],
      { attributions: [attributed("rec_x", 0, "harmful")] },
    ))} />)

    const record = view.querySelector<HTMLElement>("[data-effect-record]")
    expect(record?.textContent).toBe(hostile)
    expect(record?.className).toContain("wrap-anywhere")
    expect(view.querySelector("img")).toBeNull()
  })
})

describe("the steps in an effect sentence take the reader there", () => {
  it("EFFECT-STEP-REFS: each step number in the sentence is a step-reference control", () => {
    const onSelect = vi.fn()
    const stepRefs: StepRefContext = { onSelect, resolvable: () => true, testNames: new Map() }
    const view = mount(<KnowledgeEffect view={effectSectionView(projection(
      [step(0, [line("rec_g", "the cart badge counts items")]), step(1, [line("rec_g", "the cart badge counts items")])],
      { attributions: [attributed("rec_g", 0, "confirmed"), attributed("rec_g", 1, "confirmed")] },
    ))} stepRefs={stepRefs} />)

    const sentence = view.querySelector<HTMLElement>("[data-effect-sentence]")
    expect(sentence?.textContent).toBe("Held up in steps 1 and 2 — the run saw the same thing")
    const controls = [...(sentence?.querySelectorAll<HTMLElement>("[data-step-ref]") ?? [])]
    expect(controls.map(control => control.textContent)).toEqual(["1", "2"])
    act(() => { controls[1]?.click() })
    expect(onSelect).toHaveBeenCalledWith({ testIndex: 0, stepIndex: 1, stepText: "step text 1" })
  })
})
