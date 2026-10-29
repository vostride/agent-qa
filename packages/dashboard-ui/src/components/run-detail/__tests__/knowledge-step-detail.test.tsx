// @vitest-environment jsdom

// THE EXPANDED STEP ROW A PERSON ACTUALLY SEES (407-06 · LERN-01, D-03/D-04/D-07/D-08, T-407-14).
//
// WHAT THIS FILE IS FOR. `tab-knowledge.test.tsx` pins the COLLAPSED row and the five page states;
// this file pins what is behind the chevron — the three channels, the per-line why-trace, the cut
// ledger, the procedure outcome and the canary attribution. They are separate files because they
// are separate subjects: the shell is about which state the tab is in, and this is about whether
// a line that was served can be explained.
//
// THE DOM CONTRACT IS THE SUBJECT, not the styling. `data-served-channel`, `data-served-as-canary`,
// `data-canary-outcome`, `data-trace-state`, `data-cut-candidates`, `data-plan-source-outcome` and
// `data-channel-show-all` are what a later Playwright cell addresses on the built bundle, so each
// is pinned here in the cheap medium first. Badge tints are NOT asserted — a cell pinning
// `bg-emerald-500/15` would go red on a palette change that broke nothing a person relies on.
//
// EVERY NO-TRACE ARM GETS ITS OWN CELL, because D-04's whole claim is that nothing silently drops.
// A step that served a line the trace cannot explain must SAY which of the three absences applies;
// three arms collapsed into one silent branch is the failure these cells exist to catch.
//
// THE COPY IS ASSERTED BY ITS EXPORTED CONSTANT (403-05 D-5), never by literal prose — except
// where a cell is deliberately pinning the SENTENCE OF RECORD from the Copywriting Contract, in
// which case the literal IS the claim.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { KnowledgeStepDetail } from "@/components/run-detail/knowledge-step-detail"
import { KnowledgeBriefLine } from "@/components/run-detail/knowledge-brief-line"
import {
  ATTRIBUTION_PENDING_TEXT,
  ATTRIBUTION_UNKNOWN_TEXT,
  CHANNEL_EYEBROWS,
  LEDGER_ON_TRIAL_TEXT,
  NOT_ATTRIBUTED_TEXT,
  PRE_TRACE_TEXT,
  PROCEDURE_HINT_DEMOTED_TEXT,
  PROCEDURE_HINT_TEXT,
  STEP_NOT_FOUND_TEXT,
  attributionWordText,
  copyRecordIdLabel,
  cutCandidatesLabel,
  showAllLinesLabel,
  traceLineText,
  trustMetaLine,
  type BriefLineView,
  type StepDetailView,
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

function click(element: Element | null): void {
  if (element === null) throw new Error("nothing to click")
  act(() => { (element as HTMLElement).click() })
}

/** One channel-1 line view. Everything absent unless a cell asks for it. */
function line(overrides: Partial<BriefLineView> = {}): BriefLineView {
  return {
    id: "rec_1",
    kind: "fact",
    summary: "the cart page lives at /view_cart",
    trust: 0.9,
    status: "active",
    servedAsCanary: false,
    tier: "confirmed",
    why: { kind: "answered", leg: "anchor", rank: 1, score: 1.48695 },
    ...overrides,
  }
}

/**
 * The retired per-line disclosure's trigger copy (427 D-19). Spelled here as a literal because the
 * constant is deleted once no surface paints it; the cells below prove no element carries it.
 */
const RETIRED_WHY_TRIGGER = "Why this line?"

function detail(overrides: Partial<StepDetailView> = {}): StepDetailView {
  return { channel1: [], channel2: [], channel3: [], ...overrides }
}

/** The `li` elements of one channel, in render order. */
function linesOf(view: HTMLElement, channel: "1" | "2" | "3"): HTMLElement[] {
  return Array.from(view.querySelectorAll(`li[data-served-channel="${channel}"]`))
}

/**
 * The element whose text content is exactly `text` and which CONTAINS NO OTHER SUCH ELEMENT — the
 * box that actually paints it.
 *
 * Addressing the painted node by its CONTENT rather than by position keeps a styling cell honest
 * if the row is later rearranged: a positional query would happily go on measuring whatever moved
 * into the slot.
 *
 * THE RULE IS CONTAINMENT, NOT POSITION. This helper used to take the LAST match in document
 * order. That is right only while the subtree holds ONE match chain: document order puts an
 * ancestor before its descendant, so "last" and "deepest" coincide along a single chain. A LATER
 * SIBLING subtree painting the same exact string is also "last", and the helper would measure that
 * unrelated box instead. The expanded step row now mounts several same-shaped nodes in sibling
 * subtrees at once, so the coincidence can no longer be relied on.
 */
function deepestWithText(view: HTMLElement, text: string): HTMLElement | null {
  const matches = Array.from(view.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.textContent === text,
  )
  return matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) ?? null
}

describe("the painted node is the one no other match contains", () => {
  const TARGET = "fact-page-https-example-com-9f2c1ad4"

  /** A `wrapper > leaf` chain whose leaf paints exactly `text`, tagged so a failure names it. */
  function chain(leafId: string, text: string): HTMLElement {
    const wrapper = document.createElement("div")
    const leaf = document.createElement("span")
    leaf.id = leafId
    leaf.textContent = text
    wrapper.append(leaf)
    return wrapper
  }

  it("returns the FIRST chain's leaf when a later sibling subtree paints the same text", () => {
    const outer = document.createElement("div")
    outer.append(chain("first-chain-leaf", TARGET), chain("later-sibling-leaf", TARGET))

    // Document order is [wrapper, leaf, wrapper, leaf]: the LAST match is the later sibling's
    // leaf, which is a different box in a different subtree. Only containment picks the box the
    // caller meant — the one that contains no other match.
    expect(deepestWithText(outer, TARGET)?.id).toBe("first-chain-leaf")
  })

  it("still answers null when nothing paints the text", () => {
    const outer = document.createElement("div")
    outer.append(chain("only-leaf", "a different string entirely"))

    expect(deepestWithText(outer, TARGET)).toBeNull()
  })
})

describe("a served line carries the trace that explains it, inline", () => {
  // 427 D-19: Retrieval details is already a disclosure, so the trace reads on the line itself.
  it("LEDGER-TRACE-INLINE: marks the line answered and prints its leg, rank and score inline, behind no trigger", () => {
    const view = mount(<KnowledgeBriefLine line={line()} />)

    const li = view.querySelector("li")
    expect(li?.getAttribute("data-served-channel")).toBe("1")
    expect(li?.getAttribute("data-trace-state")).toBe("answered")

    expect(view.textContent).toContain("leg anchor · rank 1 · score 1.487")
    expect(view.textContent).toContain(traceLineText("anchor", 1, 1.48695))
    expect(view.querySelector('[data-slot="collapsible-trigger"]')).toBeNull()
    expect(Array.from(view.querySelectorAll("*")).map(el => el.textContent)).not.toContain(RETIRED_WHY_TRIGGER)
    expect(view.textContent).not.toContain(RETIRED_WHY_TRIGGER)

    // The serve-time facts read as one mono meta line beside the trace.
    expect(view.textContent).toContain("trust 0.90 · tier confirmed · status active")
    expect(view.textContent).toContain(trustMetaLine(0.9, "confirmed", "active"))
  })

  it("renders the SHIPPED evidence-incomplete component when the artifact is gone", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ why: { kind: "no-trace", reason: "artifact-missing" } })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-trace-state")).toBe("artifact-missing")
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).not.toBeNull()
    // Nothing to expand: there is no answer behind a trigger that would open onto nothing.
    expect(view.textContent).not.toContain(RETIRED_WHY_TRIGGER)
  })

  it("says a trace was never captured for a run that predates trace capture", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ why: { kind: "no-trace", reason: "pre-trace-run" } })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-trace-state")).toBe("pre-trace-run")
    expect(view.textContent).toContain(PRE_TRACE_TEXT)
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).toBeNull()
  })

  it("says no evidence was recorded for the step when the trace holds nothing for this line", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ why: { kind: "no-trace", reason: "step-not-found" } })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-trace-state")).toBe("step-not-found")
    expect(view.textContent).toContain(STEP_NOT_FOUND_TEXT)
  })
})

/**
 * AN UNBROKEN TOKEN HAS TO BE ABLE TO SHRINK ITS OWN BOX (407-23 · G-407-2, LERN-01).
 *
 * A brief summary is a producer string and is regularly ONE UNBROKEN TOKEN — a URL, a selector
 * literal, a content-derived record id. `break-words` (`overflow-wrap: break-word`) offers such a
 * token a break opportunity only once the box has ALREADY been sized, and a flex item sized from
 * its own content never gets that far: the UAT measured the summary span grown to 895px inside a
 * 639px parent with `break-word` already computed on it. `overflow-wrap: anywhere` is the one that
 * reduces min-content width, so the item can shrink and the break opportunity is actually reached.
 *
 * These cells therefore pin the PROPERTY THAT SIZES, not the property that merely permits a break.
 */
describe("a content-derived brief line can shrink its own box, not merely overflow it", () => {
  const UNBROKEN_SUMMARY = "x".repeat(120)
  const UNBROKEN_ID = "fact-el-textbox-password-9a05ce7d3b1f4c28e6a09d5417bc32ea6f81d40c"

  it("lets an unbroken 120-char summary reduce its intrinsic width instead of widening the row", () => {
    const view = mount(<KnowledgeBriefLine line={line({ summary: UNBROKEN_SUMMARY })} />)

    const summary = deepestWithText(view, UNBROKEN_SUMMARY)
    expect(summary).not.toBeNull()
    expect(summary?.className).toContain("wrap-anywhere")
  })

  it("lets the served line's content-derived record id reduce its intrinsic width too", () => {
    const view = mount(<KnowledgeBriefLine line={line({ id: UNBROKEN_ID })} />)

    const recordId = deepestWithText(view, UNBROKEN_ID)
    expect(recordId).not.toBeNull()
    expect(recordId?.className).toContain("wrap-anywhere")
  })
})

/**
 * THE SAME LAW, EVERY CHANNEL OF THE EXPANDED ROW (407-28 · G-407-13, LERN-01).
 *
 * The block above pins channel 1 by mounting `KnowledgeBriefLine` alone — which is structurally
 * incapable of reaching channels 2 and 3, and is exactly why the identical nodes there went
 * unfixed. These cells mount the WHOLE step detail and drive ONE table over every node in it that
 * paints a content-derived token, so the next such node added to any channel is caught by an
 * existing rule rather than by another review round.
 *
 * The four subject strings are deliberately DISTINCT from one another: `deepestWithText` addresses
 * by exact text, and two identical strings in sibling subtrees is an ambiguity the helper's own
 * cells (below) exist to remove.
 */
describe("every unbroken token in the expanded row can shrink its own box, whichever channel served it", () => {
  const CHANNEL2_ID = "fact-page-https-automationexercise-com-view-cart-376e539e6c7b4e75"
  const CHANNEL3_SUMMARY = "https://automationexercise.com/product_details/44?variant=very-long-unbroken-query-string"
  const CHANNEL3_ID = "caution-el-button-add-to-cart-20f5876cc5299c11a4d0e93b7c6182fa"
  const CUT_RECORD_ID = "fact-flow-measurement-assert-value-url-df4af96cce9a48d9b310275e"
  // The `<li>` is the painted box, and it paints the whole composed sentence — only the LEADING
  // token is unbroken, which is why this one is the mildest of the four rather than absent.
  const CUT_LINE_TEXT = `${CUT_RECORD_ID} · leg lexical · rank 21 · score 0.110`

  /** The whole expanded row, cut ledger already disclosed, all four subjects painted at once. */
  function expandedRow(): HTMLElement {
    const view = mount(<KnowledgeStepDetail detail={detail({
      channel1: [line()],
      channel2: [{ id: CHANNEL2_ID, detailLevel: "full", bodyDigest: "sha256:c2" }],
      channel3: [{ id: CHANNEL3_ID, summary: CHANNEL3_SUMMARY }],
      cut: {
        label: cutCandidatesLabel(1),
        lines: [{ recordId: CUT_RECORD_ID, leg: "lexical", rank: 21, score: 0.11 }],
      },
    })} />)
    click(view.querySelector('[data-cut-candidates] [data-slot="collapsible-trigger"]'))
    return view
  }

  const SUBJECTS: readonly { readonly what: string; readonly text: string }[] = [
    { what: "the channel-2 read-trace id", text: CHANNEL2_ID },
    { what: "the channel-3 caution summary", text: CHANNEL3_SUMMARY },
    { what: "the channel-3 caution id", text: CHANNEL3_ID },
    { what: "the cut-candidate line", text: CUT_LINE_TEXT },
  ]

  for (const subject of SUBJECTS) {
    it(`${subject.what} carries the break that reduces its intrinsic width`, () => {
      const painted = deepestWithText(expandedRow(), subject.text)

      expect(painted).not.toBeNull()
      expect(painted?.className).toContain("wrap-anywhere")
    })
  }

  it("does not widen the shared mono class to get there — the why-answer row keeps its own", () => {
    const view = expandedRow()

    const channel2Id = deepestWithText(view, CHANNEL2_ID)
    expect(channel2Id?.className).toContain("font-mono text-xs text-muted-foreground tabular-nums")
  })
})

describe("a canary line is marked ALWAYS, and its outcome is never blank", () => {
  /** The painted node for `text`, which must be plain 12px text and never a tinted Badge. */
  function plainWord(view: HTMLElement, text: string): HTMLElement {
    const painted = deepestWithText(view, text)
    expect(painted, `nothing paints ${JSON.stringify(text)}`).not.toBeNull()
    expect(painted?.closest('[data-slot="badge"]')).toBeNull()
    expect(painted?.className).toContain("text-xs")
    return painted as HTMLElement
  }

  // 427 D-19: the marker reads "on trial (canary)" and the store's word reads as plain text.
  it("wears the on-trial marker and the attributed outcome once curation settled", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ servedAsCanary: true, canaryOutcome: "confirmed" })} />,
    )

    const li = view.querySelector("li")
    expect(li?.getAttribute("data-served-as-canary")).toBe("true")
    expect(li?.getAttribute("data-canary-outcome")).toBe("confirmed")

    expect(view.querySelectorAll('[data-slot="badge"]').length).toBe(0)
    plainWord(view, LEDGER_ON_TRIAL_TEXT)
    plainWord(view, attributionWordText("confirmed"))
    expect(LEDGER_ON_TRIAL_TEXT).toBe("on trial (canary)")
    expect(attributionWordText("confirmed")).toBe("attribution: confirmed")
  })

  it("says ATTRIBUTION PENDING while curation has not settled — the marker stays either way", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ servedAsCanary: true, canaryOutcome: "pending" })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-canary-outcome")).toBe("pending")
    expect(view.querySelectorAll('[data-slot="badge"]').length).toBe(0)
    plainWord(view, LEDGER_ON_TRIAL_TEXT)
    plainWord(view, ATTRIBUTION_PENDING_TEXT)
  })

  it("says NOT ATTRIBUTED when the fold recorded nothing for it — never an empty slot", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ servedAsCanary: true, canaryOutcome: "not-attributed" })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-canary-outcome")).toBe("not-attributed")
    expect(view.textContent).toContain(NOT_ATTRIBUTED_TEXT)
    plainWord(view, NOT_ATTRIBUTED_TEXT)
  })

  /**
   * REVIEW WR-02 AT THE MOUNT. `not attributed` claims the store answered; on a partial read
   * nobody asked it. The look is the SAME muted text — the degradation is explained by the
   * Memory changes read note, not by a warning tint over here.
   */
  it("says ATTRIBUTION UNKNOWN when the read that would have answered was partial", () => {
    const view = mount(
      <KnowledgeBriefLine line={line({ servedAsCanary: true, canaryOutcome: "unknown" })} />,
    )

    expect(view.querySelector("li")?.getAttribute("data-canary-outcome")).toBe("unknown")
    expect(view.querySelectorAll('[data-slot="badge"]').length).toBe(0)
    plainWord(view, LEDGER_ON_TRIAL_TEXT)

    const outcome = plainWord(view, ATTRIBUTION_UNKNOWN_TEXT).className
    expect(outcome).toContain("text-muted-foreground")
    expect(outcome).not.toContain("text-amber-500")
    expect(outcome).not.toContain("text-emerald-500")
  })

  it("leaves a non-canary line with no outcome attribute and no on-trial marker at all", () => {
    const view = mount(<KnowledgeBriefLine line={line()} />)

    const li = view.querySelector("li")
    expect(li?.getAttribute("data-served-as-canary")).toBe("false")
    expect(li?.hasAttribute("data-canary-outcome")).toBe(false)
    expect(view.textContent).not.toContain(LEDGER_ON_TRIAL_TEXT)
    expect(view.textContent).not.toContain("canary")
  })
})

describe("each channel the step was served is named, and an empty one is left out", () => {
  it("LEDGER-OMITS-EMPTY-CHANNEL: a step served only channel 1 names channel 1 in a 12px eyebrow and nothing else", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: [line()] })} />)

    const sections = Array.from(view.querySelectorAll("[data-ledger-channel]"))
    expect(sections.map(section => section.getAttribute("data-ledger-channel"))).toEqual(["1"])
    const eyebrow = deepestWithText(view, CHANNEL_EYEBROWS[1])
    expect(eyebrow?.className).toContain("text-xs")
    expect(eyebrow?.className).not.toContain("text-[10px]")
    expect(view.textContent).toContain("CHANNEL 1 · BRIEF")
    expect(view.textContent).not.toContain(CHANNEL_EYEBROWS[2])
    expect(view.textContent).not.toContain(CHANNEL_EYEBROWS[3])

    // A step served nothing at all names no channel.
    const empty = mount(<KnowledgeStepDetail detail={detail()} />)
    expect(empty.querySelectorAll("[data-ledger-channel]").length).toBe(0)
    for (const eyebrow of Object.values(CHANNEL_EYEBROWS)) {
      expect(empty.textContent).not.toContain(eyebrow)
    }
  })

  it("paints a read trace and a caution on their own channels", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({
      channel1: [line()],
      channel2: [{ id: "rec_b", detailLevel: "full", bodyDigest: "sha256:body-b" }],
      channel3: [{ id: "rec_c", summary: "this page is slow to settle" }],
    })} />)

    expect(linesOf(view, "1").length).toBe(1)
    expect(linesOf(view, "2")[0].textContent).toContain("rec_b")
    expect(linesOf(view, "2")[0].textContent).toContain("full")
    expect(linesOf(view, "2")[0].textContent).toContain("sha256:body-b")
    expect(linesOf(view, "3")[0].textContent).toContain("this page is slow to settle")
    // Every served id is copyable, whichever channel served it.
    for (const [channel, id] of [["1", "rec_1"], ["2", "rec_b"], ["3", "rec_c"]] as const) {
      const button = linesOf(view, channel)[0].querySelector("[data-record-id-copy]")
      expect(button?.getAttribute("aria-label")).toBe(copyRecordIdLabel(id))
    }
  })
})

describe("the cut ledger answers why it did NOT say something", () => {
  it("carries the ledger size on the disclosure and the producer cap in its label", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({
      cut: {
        label: cutCandidatesLabel(3),
        lines: [
          { recordId: "rec_x", leg: "lexical", rank: 21, score: 0.11 },
          { recordId: "rec_y", leg: "dense", rank: 22, score: 0.1 },
          { recordId: "rec_z", leg: "anchor", rank: 23, score: 0.09 },
        ],
      },
    })} />)

    const disclosure = view.querySelector("[data-cut-candidates]")
    expect(disclosure?.getAttribute("data-cut-candidates")).toBe("3")
    expect(disclosure?.textContent).toContain("Cut candidates (3 of top 20)")

    click(view.querySelector('[data-cut-candidates] [data-slot="collapsible-trigger"]'))
    expect(view.textContent).toContain("rec_x")
    expect(view.textContent).toContain("rec_z")
  })

  it("renders no disclosure at all for a step whose trace could not answer", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: [line()] })} />)

    expect(view.querySelector("[data-cut-candidates]")).toBeNull()
  })
})

describe("a replay states its guard outcome and a hint states its demotion", () => {
  /** The plan-source row, which states its procedure and its sentence in plain text (427 D-19). */
  function planSourceRow(view: HTMLElement, procedureId: string): Element | null {
    const row = view.querySelector("[data-plan-source-outcome]")
    expect(row?.querySelector('[data-slot="badge"]')).toBeNull()
    expect(deepestWithText(view, procedureId)?.className).toContain("font-mono")
    expect(row?.querySelector("[data-record-id-copy]")?.getAttribute("aria-label")).toBe(copyRecordIdLabel(procedureId))
    return row
  }

  it("names the step a replay broke at and the cause the guard recorded", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({
      planSource: {
        kind: "procedure-replay",
        procedureId: "procedure-flow-checkout-4be1",
        sentence: "broke at step 1: miss",
        tone: "broke",
        missReason: "gate-refused",
      },
    })} />)

    const row = planSourceRow(view, "procedure-flow-checkout-4be1")
    expect(row?.getAttribute("data-plan-source-outcome")).toBe("broke")
    expect(row?.textContent).toContain("broke at step 1: miss")
    expect(row?.textContent).toContain("gate-refused")
  })

  it("says replayed n/n when the guard passed", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({
      planSource: { kind: "procedure-replay", procedureId: "procedure-flow-login-77aa", sentence: "replayed 5/5", tone: "ok" },
    })} />)

    const row = planSourceRow(view, "procedure-flow-login-77aa")
    expect(row?.getAttribute("data-plan-source-outcome")).toBe("ok")
    expect(row?.textContent).toContain("replayed 5/5")
  })

  it("keeps a demoted hint tellable apart from an ordinary one", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({
      planSource: { kind: "procedure-hint", procedureId: "procedure-flow-search-12cd", sentence: PROCEDURE_HINT_DEMOTED_TEXT, tone: "hint" },
    })} />)

    const row = planSourceRow(view, "procedure-flow-search-12cd")
    expect(row?.getAttribute("data-plan-source-outcome")).toBe("hint")
    expect(row?.textContent).toContain(PROCEDURE_HINT_DEMOTED_TEXT)
    expect(PROCEDURE_HINT_DEMOTED_TEXT).not.toBe(PROCEDURE_HINT_TEXT)
  })

  it("renders no plan-source row on a step whose plan no procedure touched", () => {
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: [line()] })} />)

    expect(view.querySelector("[data-plan-source-outcome]")).toBeNull()
  })
})

describe("a channel longer than the page shows a page, and offers the rest", () => {
  it("renders the first 50 of 60 behind a Show all trigger, and all 60 once it is opened", () => {
    const many = Array.from({ length: 60 }, (_, index) => line({ id: `rec_${String(index)}` }))
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: many })} />)

    expect(linesOf(view, "1").length).toBe(50)

    const trigger = view.querySelector("[data-channel-show-all]")
    expect(trigger?.textContent).toContain(showAllLinesLabel(60))
    expect(trigger?.textContent).toContain("Show all 60 lines")

    click(trigger)
    expect(linesOf(view, "1").length).toBe(60)
  })

  it("offers no Show all trigger at exactly the page size", () => {
    const many = Array.from({ length: 50 }, (_, index) => line({ id: `rec_${String(index)}` }))
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: many })} />)

    expect(linesOf(view, "1").length).toBe(50)
    expect(view.querySelector("[data-channel-show-all]")).toBeNull()
  })
})

describe("producer text reaches the DOM as TEXT, never as markup", () => {
  it("renders a hostile brief summary as a text node — no element is created from it", () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const view = mount(<KnowledgeStepDetail detail={detail({ channel1: [line({ summary: hostile })] })} />)

    expect(view.querySelector("img")).toBeNull()
    expect(view.textContent).toContain(hostile)
  })

  it("renders a hostile caution summary as a text node too", () => {
    const hostile = '<script>alert(1)</script>'
    const view = mount(<KnowledgeStepDetail detail={detail({
      channel3: [{ id: "rec_c", summary: hostile }],
    })} />)

    expect(view.querySelector("script")).toBeNull()
    expect(view.textContent).toContain(hostile)
  })
})
