// @vitest-environment jsdom

// THE CHIPS A PERSON ACTUALLY SEES (404-07 · LIFE-03, D-20..D-23, T-404-01).
//
// WHY THESE CELLS RENDER INTO `document.body` THROUGH `createRoot`. That is the call `main.tsx`
// makes. A component mounted into a detached node can satisfy every query in a file like this one
// while the real mount path is broken, and the cell would never know.
//
// THE DOM CONTRACT IS THE SUBJECT, not the styling. `data-chip`, `data-chip-status`,
// `data-stage-state`, `data-chips-state`, `data-stage-card` and `data-stage-card-line` are what
// 404-08's Playwright cells address on the built bundle, so every one of them is pinned here in the
// cheap medium first. Colours are deliberately NOT asserted — a cell that pinned `text-emerald-500`
// would go red on a design change that broke nothing a person relies on. The GLYPH NAME is asserted
// instead, because shape is what carries the state once the colour is stripped out (SC2).
//
// THE ABSENCE CELLS ARE THE POINT. `never blank` and `never pending` are claims about elements that
// must NOT exist, and an assertion that only ever checks what IS rendered cannot see either one.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PostProcessingChips,
  STAGE_CARD_LINE_SELECTORS,
  type CardLineKind,
} from "@/components/run-detail/post-processing-chips"
import { RunNavbar } from "@/components/run-detail/run-navbar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ANALYSIS_COMPLETE_NO_ISSUES_TEXT,
  BREAKDOWN_NOT_RECORDED_TEXT,
  CHIPS_UNAVAILABLE_TEXT,
  COUNTS_NOT_RECORDED_TEXT,
  FAILED_REASON_ABSENT_TEXT,
  OPEN_KNOWLEDGE_TAB_TEXT,
  OPEN_VERDICT_TEXT,
  PENDING_POSTURE_TEXT,
  POST_PROCESSING_LOADING_LABEL,
  POST_PROCESSING_UNAVAILABLE_WORD,
  STAGE_INDICATOR_WORDS,
  STAGE_SKIPPED_TEXT,
  stageIndicatorAccessibleName,
  type PostProcessingView,
  type StageIndicatorState,
} from "@/lib/post-processing-view"
import type { RunRow } from "@/lib/api"
import type { PostProcessingSkipReason } from "@vostride/agent-qa-schema"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

// The component carries NO provider on purpose (the page owns the one at `run-detail.tsx`), so a
// real-primitive mount without this wrapper throws inside Radix before a card can ever open. The
// delay mirrors the page's `delayDuration={0}`, so a focused root opens its card in the same tick.
function mount(element: ReactElement): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>) })
  return container
}

/** The projection's own mapping, restated once so a loose record below need only name its word. */
const STATE_OF: Record<string, StageIndicatorState> = {
  complete: "complete",
  running: "running",
  pending: "pending",
  failed: "failed",
}

/** A chips view built from two loose chip records — the projection has its own cells. */
function chipsView(analysis: Record<string, unknown>, curation: Record<string, unknown>): PostProcessingView {
  const chip = (stage: "analysis" | "curation", loose: Record<string, unknown>) => {
    const state = (loose.state as StageIndicatorState | undefined) ?? STATE_OF[loose.status as string]!
    return { state, word: STAGE_INDICATOR_WORDS[stage][state], ...loose }
  }
  return {
    kind: "chips",
    analysis: chip("analysis", analysis),
    curation: chip("curation", curation),
  } as unknown as PostProcessingView
}

function render(view: PostProcessingView | undefined): HTMLElement {
  return mount(<PostProcessingChips view={view} />)
}

function chip(host: HTMLElement, stage: "analysis" | "curation"): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[data-chip="${stage}"]`)
  if (found === null) throw new Error(`no ${stage} chip rendered`)
  return found
}

/** Open a stage's card the way a keyboard reader does, and read it off the portal. */
async function cardOf(host: HTMLElement, stage: "analysis" | "curation"): Promise<HTMLElement> {
  const root = chip(host, stage)
  await act(async () => { root.focus() })
  const card = document.querySelector<HTMLElement>(`[data-stage-card="${stage}"]`)
  if (card === null) throw new Error(`no ${stage} card opened`)
  return card
}

/**
 * One card line, addressed through the component's OWN published selector (425-08).
 *
 * The cells and the bundle-level Playwright legs must reach the same elements; importing the
 * selector rather than re-spelling it is what stops a kind moving in the renderer and a hand-typed
 * string here quietly matching nothing and reporting an absence as a pass.
 */
function lineOf(card: HTMLElement, kind: CardLineKind): string | undefined {
  return card.querySelector(STAGE_CARD_LINE_SELECTORS[kind])?.textContent ?? undefined
}

/** What a SIGHTED reader sees on a root — the `sr-only` name is a separate claim, asserted apart. */
function visibleTextOf(el: HTMLElement): string {
  return [...el.childNodes]
    .filter((node) => !(node instanceof HTMLElement && node.classList.contains("sr-only")))
    .map((node) => node.textContent ?? "")
    .join("")
}

describe("two chips, in the ratified order, each saying its own word", () => {
  it("renders analysis then curation, with the word in the attribute AND in the text", () => {
    const host = render(chipsView({ status: "running" }, { status: "pending" }))
    const stages = [...host.querySelectorAll("[data-chip]")].map((el) => el.getAttribute("data-chip"))
    expect(stages).toEqual(["analysis", "curation"])
    expect(chip(host, "analysis").getAttribute("data-chip-status")).toBe("running")
    // The raw word rides the attribute; the VISIBLE word is the indicator's own, and the state is
    // said again in the accessible name (D-07).
    expect(chip(host, "analysis").textContent).toContain(STAGE_INDICATOR_WORDS.analysis.running)
    expect(chip(host, "analysis").querySelector(".sr-only")?.textContent).toContain("running")
    expect(chip(host, "curation").getAttribute("data-chip-status")).toBe("pending")
    expect(chip(host, "curation").textContent).toContain("pending")
  })

  it("a running chip carries no parenthetical, no facts, no error and no absent-reason", async () => {
    const host = render(chipsView(
      { status: "running", card: { outcome: "Analysis running" } },
      { status: "running", card: { outcome: "Curation running" } },
    ))
    for (const stage of ["analysis", "curation"] as const) {
      const el = chip(host, stage)
      // The detail left header chrome entirely (D-09/D-12): the root is a glyph and a word.
      expect(el.querySelectorAll("span").length).toBe(2)
      const card = await cardOf(host, stage)
      expect(lineOf(card, "note")).toBeUndefined()
      expect(lineOf(card, "retry")).toBeUndefined()
      expect(lineOf(card, "door")).toBeUndefined()
    }
  })
})

// THE TRACER (425-01 · D-06/D-07/D-10/D-13, UI-SPEC S3/S4). One indicator, end to end: the glyph
// and the word a person sees, the focusable root that reaches the card by keyboard, and the card's
// first line — the phase's copy cell. Every later state hangs off this anatomy.
describe("a settled analysis indicator explains itself (D-13, roadmap SC3)", () => {
  it("TRACER-PASSING-ANALYSIS-CARD: glyph plus word on a focusable root, card line 1 is the sentence", async () => {
    const host = render(chipsView(
      {
        status: "complete",
        state: "complete",
        word: STAGE_INDICATOR_WORDS.analysis.complete,
        card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT },
      },
      { status: "complete", state: "complete", word: STAGE_INDICATOR_WORDS.curation.complete },
    ))
    const root = chip(host, "analysis")

    expect(root.tagName).toBe("SPAN")
    expect(root.getAttribute("tabindex")).toBe("0")
    expect(root.getAttribute("data-stage-state")).toBe("complete")
    expect(root.getAttribute("data-chip-status")).toBe("complete")
    expect(root.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
    expect(root.textContent).toContain(STAGE_INDICATOR_WORDS.analysis.complete)
    expect(root.querySelector(".sr-only")?.textContent).toBe("Analysis: complete, no issues found")

    // Radix opens on focus as well as hover; the card is portalled, so it is read off `document`.
    await act(async () => { root.focus() })
    const card = document.querySelector('[data-stage-card="analysis"]')
    expect(card).not.toBeNull()
    expect(card!.querySelector(STAGE_CARD_LINE_SELECTORS.outcome)?.textContent)
      .toBe(ANALYSIS_COMPLETE_NO_ISSUES_TEXT)
  })
})

describe("a pending chip says who is going to move it (D-22)", () => {
  it("renders the posture the projection published, verbatim", async () => {
    const queued = (stage: "Analysis" | "Curation") => ({
      status: "pending",
      card: { outcome: `${stage} queued — ${PENDING_POSTURE_TEXT.handedOff}` },
    })
    const host = render(chipsView(queued("Analysis"), queued("Curation")))
    const card = await cardOf(host, "analysis")
    expect(lineOf(card, "outcome")).toContain(PENDING_POSTURE_TEXT.handedOff)
  })

  it("renders NO posture element when the run has not said one yet", async () => {
    const host = render(chipsView(
      { status: "pending", card: { outcome: "Analysis queued" } },
      { status: "pending", card: { outcome: "Curation queued" } },
    ))
    const card = await cardOf(host, "analysis")
    expect(lineOf(card, "outcome")).toBe("Analysis queued")
    expect(chip(host, "analysis").textContent).not.toContain(PENDING_POSTURE_TEXT.handedOff)
  })
})

describe("a terminal chip says what it committed (D-21)", () => {
  it("renders curation's counts in its card, and never on the analysis card", async () => {
    const host = render(chipsView(
      { status: "complete", card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT } },
      { status: "complete", card: { outcome: "Curation complete — 4 added · 2 deprecated" } },
    ))
    expect(lineOf(await cardOf(host, "curation"), "outcome"))
      .toBe("Curation complete — 4 added · 2 deprecated")
    expect(lineOf(await cardOf(host, "analysis"), "outcome")).toBe(ANALYSIS_COMPLETE_NO_ISSUES_TEXT)
  })

  it("renders the counts-absent line in the SAME slot — a `complete` chip is never silent about counts (D-12)", async () => {
    const host = render(chipsView(
      { status: "complete" },
      { status: "complete", card: { outcome: `Curation complete — ${COUNTS_NOT_RECORDED_TEXT}` } },
    ))
    expect(lineOf(await cardOf(host, "curation"), "outcome"))
      .toBe(`Curation complete — ${COUNTS_NOT_RECORDED_TEXT}`)
  })
})

// THE LEGACY COUNT SENTENCE LEAVES HEADER CHROME (D-16, PXH-RUN-04). RED under return: restore the
// old `curated N facts, deprecated M` line anywhere in the chips DOM or in a card and this goes red.
describe("`curated N facts, deprecated M` is gone from the header (D-16)", () => {
  const LEGACY = /curated \d+ facts?, deprecated/

  it("HEADER-NO-LEGACY-COUNT: neither a snapshot-bearing nor a legacy-pair read spells it", async () => {
    for (const outcome of [
      "Curation complete — 4 added · 2 deprecated",
      "Curation complete — 4 curated · 2 deprecated",
    ]) {
      const host = render(chipsView(
        { status: "complete", card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT } },
        { status: "complete", card: { outcome, note: BREAKDOWN_NOT_RECORDED_TEXT } },
      ))
      expect(host.textContent ?? "").not.toMatch(LEGACY)
      for (const stage of ["analysis", "curation"] as const) {
        expect((await cardOf(host, stage)).textContent ?? "").not.toMatch(LEGACY)
      }
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
      container = undefined
    }
  })
})

// THE CHIP AS A DOOR (D-01). The chip stays PRESENTATIONAL: it is handed a callback and calls it.
// It does not know a tab, a route or a run. Absent the callback it is exactly the shipped `<span>` —
// a header rendered without a page behind it must not grow an affordance that goes nowhere.
describe("the curation chip is a click-through into the Knowledge tab (D-01)", () => {
  const SETTLED_CURATION = {
    status: "complete",
    card: { outcome: `Curation complete — ${COUNTS_NOT_RECORDED_TEXT}` },
  }

  function renderWithClick(onCurationClick: () => void): HTMLElement {
    return mount(
      <PostProcessingChips
        view={chipsView({ status: "complete" }, SETTLED_CURATION)}
        onCurationClick={onCurationClick}
      />,
    )
  }

  it("renders the curation chip root as a button carrying the accessible name, and no native title", () => {
    const host = renderWithClick(vi.fn())
    const root = chip(host, "curation")

    expect(root.tagName).toBe("BUTTON")
    expect(root.getAttribute("type")).toBe("button")
    // A native tooltip beside a Radix one is two treatments of one concept (UI-SPEC S3).
    expect(root.getAttribute("title")).toBeNull()
    expect(root.getAttribute("aria-label")).toBe(
      stageIndicatorAccessibleName("curation", "complete", SETTLED_CURATION.card.outcome, "knowledge"),
    )
  })

  it("closes its card with the door line — the indicator itself is the control (D-10)", async () => {
    const host = renderWithClick(vi.fn())
    const card = await cardOf(host, "curation")

    expect(lineOf(card, "door")).toBe(OPEN_KNOWLEDGE_TAB_TEXT)
    expect([...card.querySelectorAll("[data-stage-card-line]")].at(-1)?.getAttribute("data-stage-card-line"))
      .toBe("door")
    expect(card.querySelector("a, button")).toBeNull()
  })

  it("keeps every data attribute on the root when it becomes a button — the contract does not move", async () => {
    const host = renderWithClick(vi.fn())
    const root = chip(host, "curation")

    expect(root.getAttribute("data-chip")).toBe("curation")
    expect(root.getAttribute("data-chip-status")).toBe("complete")
    expect(root.getAttribute("data-stage-state")).toBe("complete")
    expect(lineOf(await cardOf(host, "curation"), "outcome")).toBe(SETTLED_CURATION.card.outcome)
  })

  it("calls the page's handler exactly once per click and never navigates itself", () => {
    const onCurationClick = vi.fn()
    const host = renderWithClick(onCurationClick)

    act(() => { chip(host, "curation").click() })

    expect(onCurationClick).toHaveBeenCalledTimes(1)
  })

  it("NEVER makes the analysis chip a button — only curation has a half of the tab to open", () => {
    const host = renderWithClick(vi.fn())
    const analysis = chip(host, "analysis")

    expect(analysis.tagName).toBe("SPAN")
    expect(analysis.getAttribute("title")).toBeNull()
    expect(analysis.getAttribute("aria-label")).toBeNull()
  })

  it("stays today's span with no title when the page passes no handler", () => {
    const host = render(chipsView({ status: "complete" }, { status: "complete" }))
    const root = chip(host, "curation")

    expect(root.tagName).toBe("SPAN")
    expect(root.getAttribute("title")).toBeNull()
    expect(root.getAttribute("aria-label")).toBeNull()
  })
})

// THE OTHER DOOR (425-09 · D-11, UI-SPEC S4). Curation always has a half of the Knowledge tab to
// open; analysis has somewhere to go only on a run that produced a verdict, and only the PAGE can
// know that. So the affordance is the presence of the callback and nothing else — the component
// makes no judgement about run status, which is the rule `onCurationClick` has carried since
// 407-09 and the reason a header rendered without a page behind it grows no dead control.
describe("the analysis indicator is the door to the verdict when the page gave it one (D-11)", () => {
  const FAILED_ANALYSIS = {
    status: "failed",
    card: { outcome: `Analysis failed — ${FAILED_REASON_ABSENT_TEXT.handedOff}` },
  }
  const SETTLED_CURATION = {
    status: "complete",
    card: { outcome: `Curation complete — ${COUNTS_NOT_RECORDED_TEXT}` },
  }

  /**
   * A SECOND MOUNT INSIDE ONE CELL, torn down where it was made.
   *
   * The shared `mount` tracks exactly one root for `afterEach`, so a cell that mounts twice would
   * leave the first tree attached to `document.body` — and the cards here are PORTALLED, read off
   * `document`, so a stray tree is a stray card a later query could reach.
   */
  function mountAside(element: ReactElement): { host: HTMLElement; done: () => void } {
    const aside = document.createElement("div")
    document.body.append(aside)
    const asideRoot = createRoot(aside)
    act(() => { asideRoot.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>) })
    return { host: aside, done: () => { act(() => { asideRoot.unmount() }); aside.remove() } }
  }

  function chipsWithDoor(onOpenVerdict?: () => void): ReactElement {
    return (
      <PostProcessingChips
        view={chipsView(FAILED_ANALYSIS, SETTLED_CURATION)}
        onOpenVerdict={onOpenVerdict}
      />
    )
  }

  it("ANALYSIS-DOOR-ON-FAILED-RUN: a button that names where it goes and calls the page exactly once", async () => {
    const onOpenVerdict = vi.fn()
    const host = mount(chipsWithDoor(onOpenVerdict))
    const root = chip(host, "analysis")

    expect(root.tagName).toBe("BUTTON")
    expect(root.getAttribute("type")).toBe("button")
    expect(root.getAttribute("aria-label")).toBe(
      stageIndicatorAccessibleName("analysis", "failed", FAILED_ANALYSIS.card.outcome, "verdict"),
    )
    // Spelled out as well as composed: the spoken clause is the contract UI-SPEC S3 names, and a
    // change to the joiner that kept `stageIndicatorAccessibleName` self-consistent would be
    // invisible to an equality against that same function.
    expect(root.getAttribute("aria-label")!.endsWith(" — open verdict")).toBe(true)
    // The root swaps ELEMENT, never contract.
    expect(root.getAttribute("data-chip")).toBe("analysis")
    expect(root.getAttribute("data-chip-status")).toBe("failed")
    expect(root.getAttribute("data-stage-state")).toBe("failed")

    const card = await cardOf(host, "analysis")
    expect(lineOf(card, "door")).toBe(OPEN_VERDICT_TEXT)
    expect([...card.querySelectorAll("[data-stage-card-line]")].at(-1)?.getAttribute("data-stage-card-line"))
      .toBe("door")
    // Text only inside the card: the indicator the reader is already on IS the control (D-10).
    expect(card.querySelector("a, button")).toBeNull()

    act(() => { root.click() })
    expect(onOpenVerdict).toHaveBeenCalledTimes(1)

    // THE OTHER HALF OF THE HEADER IS UNTOUCHED. A verdict door must not hand curation an
    // affordance the page never gave it.
    const curation = chip(host, "curation")
    expect(curation.tagName).toBe("SPAN")
    expect(curation.getAttribute("aria-label")).toBeNull()
    expect(lineOf(await cardOf(host, "curation"), "door")).toBeUndefined()
  })

  it("ANALYSIS-NOT-A-CONTROL-WHEN-PASSED: no door from the page, no button, no door line", async () => {
    const host = mount(
      <PostProcessingChips
        view={chipsView(
          { status: "complete", card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT } },
          SETTLED_CURATION,
        )}
      />,
    )
    const root = chip(host, "analysis")

    expect(root.tagName).toBe("SPAN")
    expect(root.getAttribute("tabindex")).toBe("0")
    expect(root.getAttribute("aria-label")).toBeNull()
    expect(root.querySelector(".sr-only")?.textContent).toBe(
      stageIndicatorAccessibleName("analysis", "complete", ANALYSIS_COMPLETE_NO_ISSUES_TEXT),
    )
    expect(lineOf(await cardOf(host, "analysis"), "door")).toBeUndefined()

    // THE FALSIFICATION, IN THE SAME SCENE. "Still a span" was true before this plan existed and
    // on its own proves nothing about the rule; the same component WITH a door must read
    // differently, or the absence above is not what makes this root a span.
    const aside = mountAside(chipsWithDoor(vi.fn()))
    try {
      expect(chip(aside.host, "analysis").tagName).toBe("BUTTON")
    } finally {
      aside.done()
    }
  })

  it("the navbar FORWARDS the door rather than deciding it (the `onCurationClick` idiom)", () => {
    const host = mount(
      <MemoryRouter><RunNavbar
        run={runRow("failed")}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
        hasPostProcessing
        postProcessing={chipsView(FAILED_ANALYSIS, SETTLED_CURATION)}
        onOpenVerdict={() => {}}
      /></MemoryRouter>,
    )
    expect(host.querySelector('[data-chip="analysis"]')?.tagName).toBe("BUTTON")

    const aside = mountAside(
      <MemoryRouter><RunNavbar
        run={runRow("failed")}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
        hasPostProcessing
        postProcessing={chipsView(FAILED_ANALYSIS, SETTLED_CURATION)}
      /></MemoryRouter>,
    )
    try {
      expect(aside.host.querySelector('[data-chip="analysis"]')?.tagName).toBe("SPAN")
    } finally {
      aside.done()
    }
  })
})

describe("a failed chip is never blank (D-21 as narrowed)", () => {
  it("renders the producer's text VERBATIM and says whether the chain will try again", async () => {
    const host = render(chipsView(
      {
        status: "failed",
        card: { outcome: "Analysis failed — analysis stage blew up on step 3", retry: "Will retry" },
      },
      { status: "pending", card: { outcome: "Curation queued" } },
    ))
    const card = await cardOf(host, "analysis")
    expect(lineOf(card, "outcome")).toBe("Analysis failed — analysis stage blew up on step 3")
    expect(lineOf(card, "retry")).toBe("Will retry")
    // The reason never sits beside the indicator again (D-09): the VISIBLE root is a glyph and a
    // word. The accessible name still carries the outcome clause, which is where it belongs.
    expect(visibleTextOf(chip(host, "analysis"))).toBe(STAGE_INDICATOR_WORDS.analysis.failed)
  })

  it("renders the posture-qualified absence when nobody recorded a reason — and NO error element", async () => {
    const host = render(chipsView(
      { status: "failed", card: { outcome: `Analysis failed — ${FAILED_REASON_ABSENT_TEXT.handedOff}` } },
      { status: "pending", card: { outcome: "Curation queued" } },
    ))
    const card = await cardOf(host, "analysis")
    expect(lineOf(card, "outcome")).toBe(`Analysis failed — ${FAILED_REASON_ABSENT_TEXT.handedOff}`)
    expect(lineOf(card, "retry")).toBeUndefined()
    expect(visibleTextOf(chip(host, "analysis"))).toBe(STAGE_INDICATOR_WORDS.analysis.failed)
  })

  it("the failure text is a TEXT NODE — markup in it is escaped, never parsed (T-404-01)", async () => {
    const host = render(chipsView(
      { status: "failed", card: { outcome: "Analysis failed — <img src=x onerror=alert(1)>" } },
      { status: "pending", card: { outcome: "Curation queued" } },
    ))
    const card = await cardOf(host, "analysis")
    const outcome = card.querySelector(STAGE_CARD_LINE_SELECTORS.outcome)
    expect(outcome?.textContent).toBe("Analysis failed — <img src=x onerror=alert(1)>")
    expect(outcome?.querySelector("img")).toBeNull()
  })
})

describe("a refusal is its own state, and it is not a chip (D-23)", () => {
  it("renders ONE unavailable element naming the refusal, and zero chips", () => {
    const host = render({ kind: "unavailable", error: "job_store_schema_version", reason: "stamped by another build" })
    const state = host.querySelectorAll('[data-chips-state="unavailable"]')
    expect(state).toHaveLength(1)
    expect(state[0]!.textContent).toContain(POST_PROCESSING_UNAVAILABLE_WORD)
    expect(state[0]!.getAttribute("data-stage-state")).toBe("unavailable")
    expect(state[0]!.getAttribute("tabindex")).toBe("0")
    expect(state[0]!.getAttribute("title")).toBeNull()
    // The detail LEAVES header chrome (D-09): the root names the refusal, the card carries why.
    expect(state[0]!.textContent).not.toContain("job_store_schema_version")
    expect(host.querySelectorAll("[data-chip]")).toHaveLength(0)
  })

  it("moves the refusal's error and reason into its card, each on its own line (D-09)", async () => {
    const host = render({ kind: "unavailable", error: "job_store_schema_version", reason: "stamped by another build" })
    const root = host.querySelector<HTMLElement>('[data-chips-state="unavailable"]')!

    await act(async () => { root.focus() })
    const card = document.querySelector('[data-stage-card="unavailable"]')
    expect(card).not.toBeNull()
    expect(card!.querySelector(STAGE_CARD_LINE_SELECTORS.outcome)?.textContent).toBe(CHIPS_UNAVAILABLE_TEXT)
    expect(card!.querySelector(STAGE_CARD_LINE_SELECTORS.error)?.textContent).toBe("job_store_schema_version")
    expect(card!.querySelector(STAGE_CARD_LINE_SELECTORS.reason)?.textContent).toBe("stamped by another build")
  })

  it("a view that has not arrived yet is `loading`, which is not `pending` and not blank", () => {
    const host = render(undefined)
    const loading = host.querySelectorAll('[data-chips-state="loading"]')
    expect(loading).toHaveLength(1)
    // An ellipsis is nothing at all to a screen reader; the wait is announced (UI-SPEC S3).
    expect(loading[0]!.getAttribute("role")).toBe("status")
    expect(loading[0]!.querySelector(".sr-only")?.textContent).toBe(POST_PROCESSING_LOADING_LABEL)
    expect(host.querySelectorAll("[data-chip]")).toHaveLength(0)
  })
})

// COLOUR IS NEVER ALONE (425 D-06, roadmap SC2). Six states, six distinguishable pairs of shape and
// word — the claim a grayscale render makes good on. `excluded` and `unavailable` share the dash
// glyph ON PURPOSE, so their words are what separate them, which this cell measures rather than
// asserts by eye.
describe("every indicator state is readable with the colour stripped out (D-06, SC2)", () => {
  /** Mount one view, read the analysis root's shape-and-word pair, unmount before the next. */
  function lookOf(loose: Record<string, unknown>): { glyph: string; words: string } {
    const host = render(chipsView(loose, loose))
    const el = chip(host, "analysis")
    const pair = {
      glyph: [...el.querySelector("svg")!.classList].find((c) => c.startsWith("lucide-")) ?? "",
      words: el.textContent ?? "",
    }
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    return pair
  }

  it("STAGE-INDICATOR-COLOUR-FREE: each state pairs a distinct glyph with a distinct word", () => {
    const pairs = new Map<string, { glyph: string; words: string }>()
    for (const state of ["complete", "running", "pending", "failed", "skipped"] as const) {
      pairs.set(state, lookOf({ status: "pending", state }))
    }

    const host = render({ kind: "unavailable", error: "e" })
    const refusal = host.querySelector<HTMLElement>('[data-chips-state="unavailable"]')!
    pairs.set("unavailable", {
      glyph: [...refusal.querySelector("svg")!.classList].find((c) => c.startsWith("lucide-")) ?? "",
      words: refusal.textContent ?? "",
    })

    expect([...pairs].map(([state, pair]) => [state, pair.glyph])).toEqual([
      ["complete", "lucide-circle-check"],
      ["running", "lucide-circle-dashed"],
      ["pending", "lucide-circle"],
      ["failed", "lucide-circle-x"],
      ["skipped", "lucide-circle-minus"],
      ["unavailable", "lucide-circle-minus"],
    ])

    // No two states share BOTH halves — the dash pair is separated by its word.
    const both = [...pairs.values()].map((pair) => `${pair.glyph}|${pair.words}`)
    expect(new Set(both).size).toBe(both.length)
  })

  it("the running glyph is the header's one piece of motion, and it respects reduced motion", () => {
    for (const state of ["complete", "running", "pending", "failed", "skipped"] as const) {
      const host = render(chipsView({ status: "pending", state }, { status: "pending", state }))
      const glyph = chip(host, "analysis").querySelector("svg")!
      expect(glyph.classList.contains("motion-safe:animate-pulse")).toBe(state === "running")
      expect(glyph.classList.contains("animate-pulse")).toBe(false)
      act(() => { root?.unmount() })
      container?.remove()
      root = undefined
      container = undefined
    }
  })
})

// THE CARD'S LINES, IN READING ORDER.
//
// The component composes NO prose: it paints the lines the projection built, keyed by kind, so the
// reading order lives in one place and a cell can address a line without parsing a paragraph.
describe("a card explains timing on its own line", () => {
  // Radix paints the content TWICE — once visibly, once inside a visually-hidden `role="tooltip"`
  // node for announcement — so an unfiltered walk reports every line twice and an order claim built
  // on it would pass for the wrong reason.
  function kindsOf(card: HTMLElement): (string | null)[] {
    return [...card.querySelectorAll("[data-stage-card-line]")]
      .filter((el) => el.closest('[role="tooltip"]') === null)
      .map((el) => el.getAttribute("data-stage-card-line"))
  }

  it("STAGE-CARD-LINES: timing paints as its own line on each card", async () => {
    const host = render(chipsView(
      {
        status: "complete",
        card: { outcome: ANALYSIS_COMPLETE_NO_ISSUES_TEXT, timing: "Queued 10:41:02 · finished in 5s" },
      },
      {
        status: "complete",
        card: {
          outcome: "Curation complete — 2 added",
          timing: "Queued 10:41:09 · finished in 2s",
        },
      },
    ))

    const analysis = await cardOf(host, "analysis")
    expect(kindsOf(analysis)).toEqual(["outcome", "timing"])
    expect(lineOf(analysis, "timing")).toBe("Queued 10:41:02 · finished in 5s")

    const curation = await cardOf(host, "curation")
    expect(kindsOf(curation)).toEqual(["outcome", "timing"])
    expect(lineOf(curation, "timing")).toBe("Queued 10:41:09 · finished in 2s")
  })

  it("STAGE-CARD-LINES: timing sits between the outcome and the retry and door lines", async () => {
    const host = mount(
      <PostProcessingChips
        view={chipsView(
          { status: "complete" },
          {
            status: "failed",
            card: {
              outcome: "Curation failed — the bundle would not commit",
              note: BREAKDOWN_NOT_RECORDED_TEXT,
              timing: "Queued 10:41:02 · started after 1s · 2 attempts",
              retry: "Will retry",
            },
          },
        )}
        onCurationClick={vi.fn()}
      />,
    )
    expect(kindsOf(await cardOf(host, "curation")))
      .toEqual(["outcome", "note", "timing", "retry", "door"])
  })
})

// A SKIPPED CHAIN READS NEUTRAL, AND THE STORE'S OWN WORDS SURVIVE UNDERNEATH (425-08 · D-08, SC2).
//
// The reason rides the CONTAINER as its own attribute rather than being spelled into a sentence a
// cell would have to parse, and `data-chip-status` keeps the raw chip word on each root — so the
// four-word vocabulary census still sees four words on a gate run, and a surface that does not know
// about the skipped fact still reads exactly what the store said.
describe("a run the chain never enqueued reads skipped on both indicators (D-08)", () => {
  function skippedView(reason: PostProcessingSkipReason): PostProcessingView {
    const chipFor = (stage: "analysis" | "curation") => ({
      status: "pending",
      state: "skipped",
      word: STAGE_INDICATOR_WORDS[stage].skipped,
      card: { outcome: STAGE_SKIPPED_TEXT[reason][stage] },
    })
    return {
      kind: "chips",
      skipped: { reason },
      analysis: chipFor("analysis"),
      curation: chipFor("curation"),
    } as unknown as PostProcessingView
  }

  it("EXCLUDED-PAINT: the reason on the container, both roots skipped, the raw words untouched", async () => {
    const host = render(skippedView("outcome-excluded"))
    const area = host.querySelector('[data-chips-state="chips"]')!

    expect(area.getAttribute("data-postprocessing-skipped")).toBe("outcome-excluded")
    expect(area.hasAttribute("data-postprocessing-excluded")).toBe(false)

    for (const stage of ["analysis", "curation"] as const) {
      const root = chip(host, stage)
      expect(root.getAttribute("data-stage-state")).toBe("skipped")
      // The store said `pending` and the store is still quoted verbatim (404 D-01).
      expect(root.getAttribute("data-chip-status")).toBe("pending")
      expect(root.tagName).toBe("SPAN")
      expect(visibleTextOf(root)).toBe(STAGE_INDICATOR_WORDS[stage].skipped)
      expect([...root.querySelector("svg")!.classList].find((c) => c.startsWith("lucide-")))
        .toBe("lucide-circle-minus")
      expect(lineOf(await cardOf(host, stage), "outcome")).toBe(STAGE_SKIPPED_TEXT["outcome-excluded"][stage])
    }

    // Nothing to open: a skipped run has no verdict to reach and nothing was curated.
    expect(host.querySelector("button")).toBeNull()
  })

  it("EXCLUDED-PAINT: a view carrying no skipped fact carries NO reason attribute at all", () => {
    const host = render(chipsView({ status: "complete" }, { status: "complete" }))
    const area = host.querySelector('[data-chips-state="chips"]')!
    expect(area.hasAttribute("data-postprocessing-skipped")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The header itself: the chips sit BESIDE the verdict badge, and there is still only one badge
// ---------------------------------------------------------------------------

function runRow(status: string): RunRow {
  return {
    id: "r_header",
    name: "a header probe",
    filePath: "tests/probe.test.yaml",
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: null,
    endedAt: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
  }
}

describe("RunNavbar puts the chips beside the verdict badge (D-20)", () => {
  it("renders the chips AFTER the verdict badge, and the badge still appears exactly once", () => {
    const host = mount(
      <MemoryRouter><RunNavbar
        run={runRow("passed")}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
        hasPostProcessing
        postProcessing={chipsView({ status: "complete" }, { status: "running" })}
      /></MemoryRouter>,
    )
    // The 404-06 acceptance: ONE render site for the badge, so one element carries the raw status.
    expect(host.querySelectorAll("[data-verdict-badge]")).toHaveLength(1)
    const badge = host.querySelector("[data-verdict-badge]")!
    const analysis = host.querySelector('[data-chip="analysis"]')!
    // Ordering, not counting: the badge must PRECEDE the chips in document order.
    expect(badge.compareDocumentPosition(analysis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("renders no chip area at all when the header was not wired for one", () => {
    const host = mount(
      <MemoryRouter>
        <RunNavbar run={runRow("passed")} shortcutsOpen={false} onToggleShortcuts={() => {}} />
      </MemoryRouter>,
    )
    expect(host.querySelectorAll("[data-verdict-badge]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-chip]")).toHaveLength(0)
    expect(host.querySelectorAll("[data-chips-state]")).toHaveLength(0)
  })
})
