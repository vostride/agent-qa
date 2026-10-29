// @vitest-environment jsdom
//
// THE MEMBER-GROUPED STEP TREE (405-08 · DETL-01, D-16 / D-17 / D-18).
//
// The tree these cells drive reads the DURABLE projection and nothing else. Every fixture below is
// a real `RunDetailMember` / `RunDetailStep` / `RunDetailSubAction` — no casts through `unknown`,
// because a cast would throw away the one property that makes typing the UI on the op's contract
// worth anything: a payload drift becomes a compile error here rather than an `undefined` in a
// text node.
//
// COPY IS ASSERTED BY CONSTANT (405-06's law). `reranLabel`, `memberNote` and `DID_NOT_RUN_LABEL`
// come from `lib/run-detail-view.ts`, so a sentence moves in one place and these cells move with
// it. A string re-typed here would stay green while the page said something else.
//
// THE `data-*` ATTRIBUTES CARRY RAW WORDS, not labels — `data-member-outcome="failed"`,
// `data-sub-action-result="success"` — because 405-12's Playwright cells address the built bundle
// and a cell reading visible text would be asserting on presentation.

import { act, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  RunDetailMember,
  RunDetailStep,
  RunDetailSubAction,
} from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import { MemberGroup } from "@/components/run-detail/member-group"
import { StepTree } from "@/components/run-detail/step-tree"
import { statusBadgeLook } from "@/lib/status"
import { provenanceLabel, type MemberVerdictView } from "@/lib/analysis-view"
import { SubActionTreeItem } from "@/components/run-detail/sub-action-tree-item"
import {
  DID_NOT_RUN_LABEL,
  memberDisplayName,
  memberHandleLabel,
  reranLabel,
  type RunDetailGroup,
} from "@/lib/run-detail-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

let container: HTMLDivElement
let root: Root

function mount(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(element)
  })
  return container
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function member(testIndex: number, extra: Partial<RunDetailMember> = {}): RunDetailMember {
  return { testIndex, attempts: 1, ...extra }
}

function step(testIndex: number, stepIndex: number, extra: Partial<RunDetailStep> = {}): RunDetailStep {
  return {
    testIndex,
    stepIndex,
    stepText: `Step ${String(stepIndex)} of member ${String(testIndex)}`,
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "looks right" },
    selfHealOccurred: false,
    briefDigest: `d${String(testIndex)}${String(stepIndex)}`,
    status: "passed",
    durationMs: 1200,
    ...extra,
  }
}

function subAction(
  subActionIndex: number,
  extra: Partial<RunDetailSubAction> = {},
): RunDetailSubAction {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex,
    plan: "click the primary button",
    plannedAction: { type: "click", ref: asRef("e1") },
    result: { success: true },
    screenStateHash: "abcdef0123456789".repeat(4),
    ...extra,
  }
}

function group(m: RunDetailMember, steps: RunDetailStep[], subActions: RunDetailSubAction[] = []): RunDetailGroup {
  return {
    member: m,
    steps: steps.map((s) => ({
      step: s,
      subActions: subActions.filter((a) => a.testIndex === s.testIndex && a.stepIndex === s.stepIndex),
    })),
  }
}

function tree(groups: RunDetailGroup[], showMemberChrome: boolean) {
  return mount(
    <StepTree
      groups={groups}
      showMemberChrome={showMemberChrome}
      selection={null}
      onSelect={() => {}}
    />,
  )
}

describe("the step tree groups by member", () => {
  it("renders one group per member in handle order, each named and handled", () => {
    const view = tree(
      [
        group(member(0, { name: "Login" }), [step(0, 0)]),
        group(member(1, { name: "Checkout" }), [step(1, 0)]),
      ],
      true,
    )

    const members = [...view.querySelectorAll("[data-member]")]
    expect(members.map((el) => el.getAttribute("data-member"))).toEqual(["0", "1"])

    const text = view.textContent ?? ""
    expect(text).toContain("Login")
    expect(text).toContain(memberHandleLabel(0))
    expect(text).toContain("Checkout")
    expect(text).toContain(memberHandleLabel(1))
    expect(text.indexOf("Login")).toBeLessThan(text.indexOf("Checkout"))
  })

  it("names a member the projection never named, without inventing an identity", () => {
    const view = tree([group(member(0), [step(0, 0)]), group(member(1), [step(1, 0)])], true)

    expect(view.textContent).toContain(memberDisplayName(member(0)))
    expect(view.textContent).toContain(memberDisplayName(member(1)))
  })

  it("shows no grouping chrome at all for a single-member run", () => {
    const view = tree([group(member(0, { name: "Login" }), [step(0, 0)])], false)

    expect(view.querySelector("[data-member]")).toBeNull()
    expect(view.textContent).toContain("Step 0 of member 0")
  })

})

describe("every member wears its outcome, in the navbar's one palette", () => {
  // WHAT THIS REPLACED. Until 406-06 this file asserted the OPPOSITE — no badge on a member that
  // ran — because 405 D-16 was explicit that per-member outcomes beside the aggregate were 406's
  // DETL-04 and were not to be pre-claimed. 406 D-07 is that decision arriving: the badge goes on
  // every member that has an outcome, so "one aggregate + N members" reads as one vocabulary.
  //
  // AND IT IS ASSERTED THROUGH `statusBadgeLook`, never through colour strings typed here. The
  // navbar and this header now share one definition; a cell that re-typed `emerald-500` would keep
  // passing on the day the palette moved and the two surfaces diverged.
  it("badges a member that PASSED, in the palette the run's own verdict badge uses", () => {
    const view = tree([group(member(0, { name: "Login", outcome: "passed" }), [step(0, 0)])], true)

    const badge = view.querySelector('[data-member-outcome="passed"]')
    expect(badge, "a passed member says so — this is the D-07 reversal").not.toBeNull()
    expect(badge?.textContent).toBe(statusBadgeLook("passed").label)
    for (const cls of (statusBadgeLook("passed").className ?? "").split(" ")) {
      expect(badge?.className, `the navbar's own ${cls}`).toContain(cls)
    }
  })

  it("badges a member that FAILED with the same variant the header would paint", () => {
    const view = tree([group(member(1, { name: "Checkout", outcome: "failed" }), [step(1, 0)])], true)

    const badge = view.querySelector('[data-member-outcome="failed"]')
    expect(badge?.getAttribute("data-variant")).toBe(statusBadgeLook("failed").variant)
    expect(badge?.textContent).toBe(statusBadgeLook("failed").label)
  })

  it("carries the RAW outcome word on the attribute and the LABEL in the text", () => {
    const view = tree([group(member(2, { name: "Cart", outcome: "cancelled" }), [step(2, 0)])], true)

    const badge = view.querySelector("[data-member-outcome]")
    expect(badge?.getAttribute("data-member-outcome"), "raw, for the cells").toBe("cancelled")
    expect(badge?.textContent, "title-cased, for the reader").toBe(statusBadgeLook("cancelled").label)
  })

  it("renders no badge at all for a member the projection recorded no outcome for", () => {
    const view = tree([group(member(0, { name: "Login" }), [step(0, 0)])], true)

    expect(view.querySelector("[data-member-outcome]"), "no outcome is no badge").toBeNull()
  })
})

describe("the toggle of a group that holds a verdict says so, collapsed or not", () => {
  function verdictFor(testIndex: number): MemberVerdictView {
    return {
      testIndex,
      sentence: 'observed (step 0): "Submit never became enabled"',
      producer: "deterministic-classifier",
      confidence: 0,
      provenance: provenanceLabel("deterministic-classifier", 0),
      citedSteps: [],
      citedArtifacts: [],
      siblings: [],
    }
  }

  // The header's verdict door falls back to this toggle when the reader collapsed the group, so
  // the marker must survive the collapse that unmounts the block itself.
  it("MEMBER-TOGGLE-HAS-VERDICT: marks only the failed member's toggle, and keeps it when collapsed", () => {
    const view = mount(
      <ul role="tree">
        <MemberGroup group={group(member(0, { name: "Login", outcome: "passed" }), [step(0, 0)])} showChrome />
        <MemberGroup
          group={group(member(1, { name: "Checkout", outcome: "failed" }), [step(1, 0)])}
          showChrome
          verdict={verdictFor(1)}
        />
      </ul>,
    )

    const toggles = [...view.querySelectorAll<HTMLElement>("[data-member-toggle]")]
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.hasAttribute("data-member-has-verdict"), "a passed member holds no verdict").toBe(false)
    expect(toggles[1]!.hasAttribute("data-member-has-verdict")).toBe(true)
    expect(view.querySelector("[data-verdict-block]"), "the open group mounts its block").not.toBeNull()

    act(() => { toggles[1]!.click() })
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("false")
    expect(view.querySelector("[data-verdict-block]"), "collapsing unmounts the block").toBeNull()
    expect(toggles[1]!.hasAttribute("data-member-has-verdict")).toBe(true)
  })
})

describe("a re-run says so, and a first attempt says nothing", () => {
  it("reads the re-run count off `attempts` for a member that was re-run", () => {
    const label = reranLabel(3)
    expect(label).toBeDefined()

    const view = tree([group(member(0, { name: "Flaky", attempts: 3 }), [step(0, 0)])], true)

    expect(view.textContent).toContain(label!)
  })

  it("says nothing about a re-run that did not happen", () => {
    const view = tree([group(member(0, { name: "Steady", attempts: 1 }), [step(0, 0)])], true)

    expect(view.textContent).not.toContain("re-ran")
  })
})

describe("a member that never ran renders honestly, never as an empty tree", () => {
  it("shows the did-not-run note BESIDE the badge, and the producer's own summary", () => {
    const view = tree(
      [
        group(
          member(1, { name: "Checkout", outcome: "skipped", failureSummary: "skipped by fail-fast" }),
          [],
        ),
      ],
      true,
    )

    expect(view.textContent).toContain(DID_NOT_RUN_LABEL)
    // BOTH, and that is the D-07 point: the badge is now every member's, so the one place the
    // outcome word already appeared must not lose its note to it.
    expect(view.querySelector('[data-member-outcome="skipped"]')).toBeTruthy()
    expect(view.querySelector("[data-member-note]")?.textContent).toBe(DID_NOT_RUN_LABEL)
    expect(view.textContent).toContain("skipped by fail-fast")
  })

  it("shows the summary's stored marker as written, with no chip", () => {
    const view = tree(
      [
        group(
          member(2, {
            name: "Checkout",
            outcome: "failed",
            failureSummary: "could not sign in with [secret:PW] at step 3",
          }),
          [],
        ),
      ],
      true,
    )

    const summary = view.querySelector("[data-member-failure-summary]")
    expect(summary?.textContent).toBe("could not sign in with [secret:PW] at step 3")
    expect(view.querySelector("[data-masked]")).toBeNull()
  })

  it("leaves the member's NAME unmasked — structural identity is not a redaction", () => {
    // A CONTROL, and the asymmetry it pins is deliberate. `testStarted.name` is published UNMASKED
    // beside `testId` as structural identity, so a name that happens to contain a marker-shaped
    // sentence is not a redaction the producer made. Sending it through the seam would claim one.
    // Without this cell, a later reader could "fix" the header the same way and be greeted by a
    // green suite.
    const named = member(3, { name: "Checkout", outcome: "failed" })
    const view = tree([group(named, [])], true)

    expect(view.textContent).toContain(memberDisplayName(named))
    expect(view.querySelector("[data-member-failure-summary]")).toBeNull()
  })

  it("still renders the note when there is no grouping chrome to hang it on", () => {
    const view = mount(
      <ul>
        <MemberGroup group={group(member(0, { outcome: "cancelled" }), [])} showChrome={false} />
      </ul>,
    )

    expect(view.textContent).toContain(DID_NOT_RUN_LABEL)
    expect(view.querySelector("[data-member]")).toBeNull()
  })
})

describe("a sub-action carries its action sentence and its result word", () => {
  it("renders the action sentence and addresses itself by ordinal", () => {
    const view = mount(
      <ul>
        <SubActionTreeItem
          sub={subAction(0)}
          stepId="0:0"
          cached={false}
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>,
    )

    const item = view.querySelector('[data-sub-action="0"]')
    expect(item).toBeTruthy()
    expect(view.textContent).toContain("Clicked")
    expect(view.textContent).not.toContain("click the primary button")
    expect(item?.querySelector('[data-action-family="pointer"]')).toBeTruthy()
    expect(item?.getAttribute("data-sub-action-result")).toBe("success")
  })

  it("spells a failed sub-action's result as the raw word, not as presentation", () => {
    const view = mount(
      <ul>
        <SubActionTreeItem
          sub={subAction(2, { result: { success: false, error: "element detached" } })}
          stepId="0:0"
          cached={false}
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>,
    )

    const item = view.querySelector('[data-sub-action="2"]')
    expect(item?.getAttribute("data-sub-action-result")).toBe("failure")
  })
})
