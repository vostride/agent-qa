// @vitest-environment jsdom
//
// ONE MEMBER'S VERDICT BLOCK (406-06 · DETL-04, D-08 / D-09 / D-10 / D-11).
//
// THE BLOCK DERIVES NOTHING, so every cell here hands it a view and reads the DOM back. What is
// pinned is the mapping from view to markup: which element exists, which attribute carries which
// raw word, and which callback a click reaches. The projection that BUILDS the view is pinned
// separately in `lib/__tests__/analysis-view.test.ts`, and neither file re-derives the other's job.
//
// THE COPY IS ASSERTED BY CONSTANT (405-06's law). `ANALYSIS_PROVISIONAL_TEXT`,
// `ANALYSIS_FAILED_FALLBACK_TEXT`, `siblingLine` and `citedStepLabel` come from
// `lib/analysis-view.ts`, so a sentence moves in one place and these cells move with it. A string
// re-typed here would stay green while the page said something else.
//
// THE `data-*` ATTRIBUTES ARE THE CELL CONTRACT, never the visible text — 406-11's shipped-binary
// cells address the built bundle by these same selectors, and a cell reading rendered prose would
// be asserting on presentation.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { MARKS, type RunDetailMemberMark } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from "vitest"

import { VerdictBlock } from "@/components/run-detail/verdict-block"
import { MemberGroup } from "@/components/run-detail/member-group"
import {
  ANALYSIS_FAILED_FALLBACK_TEXT,
  ANALYSIS_PROVISIONAL_TEXT,
  CITED_ARTIFACT_LABEL,
  citedStepLabel,
  MEMORY_ON_PATH_NONE_TEXT,
  MEMORY_ON_PATH_RECORDS_LABEL,
  memoryOnPathLine,
  missingEvidenceLine,
  provenanceLabel,
  siblingLine,
  type MemberVerdictView,
} from "@/lib/analysis-view"
import { EVIDENCE_INCOMPLETE_LABEL } from "@/lib/run-detail-view"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function mount(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MemoryRouter>{element}</MemoryRouter>)
  })
  return container
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

/** The floor verdict, terminal and unremarkable — every cell narrows from here. */
function view(over: Partial<MemberVerdictView> = {}): MemberVerdictView {
  return {
    testIndex: 0,
    sentence: 'observed (step 0): "Submit never became enabled"',
    producer: "deterministic-classifier",
    confidence: 0,
    provenance: provenanceLabel("deterministic-classifier", 0),
    citedSteps: [],
    citedArtifacts: [],
    siblings: [],
    ...over,
  }
}

function render(over: Partial<MemberVerdictView> = {}, handlers: {
  onCitedStep?: (testIndex: number, stepIndex: number) => void
  onSelectMember?: (testIndex: number) => void
  onCitedArtifact?: (sha: string) => void
} = {}) {
  return mount(
    <VerdictBlock
      view={view(over)}
      onCitedStep={handlers.onCitedStep ?? (() => {})}
      onSelectMember={handlers.onSelectMember ?? (() => {})}
      onCitedArtifact={handlers.onCitedArtifact ?? (() => {})}
    />,
  )
}

/** Two content addresses, distinct and 64-hex, so a cell can tell one ref from the other. */
const SHA_PRESENT = "a".repeat(64)
const SHA_GONE = "b".repeat(64)

// THE MEMBER'S PILLS ARE GONE (426-15 · D-05). Every cell below used to drive the block's own mark
// form; the behaviour now lives in the composer and its history, and each title names the cell that
// proves it there. What stays here is the negative: the block renders no mark control at all.
describe('member mark control', () => {
  const mark: RunDetailMemberMark = { markId: 'mark_0123456789ab', kind: 'false-fail', ordinal: 2,
    disposition: { kind: 'drafted', fix: 'fact', proposalId: 'prop_0123456789ab', proposalKind: 'knowledge' } }
  const markAttributes = () => [...container.querySelectorAll('*')]
    .flatMap(element => element.getAttributeNames().filter(name => name.startsWith('data-mark')))
  const controls = () => container.querySelectorAll('button, textarea, input, select, a, [role="radio"]')

  it('renders no button, textarea or data-mark element with marks bound; choosing and noting moved to the composer (TRACER-HEADER-ENTRY-TO-RECORDED)', () => {
    render({ testIndex: 4, marks: [] })
    expect(controls()).toHaveLength(0)
    expect(markAttributes()).toEqual([])
    for (const kind of MARKS) expect(container.textContent).not.toContain(kind)
    expect(container.querySelector('[data-verdict-sentence]')?.textContent)
      .toBe('observed (step 0): "Submit never became enabled"')
  })

  it('paints the same block whether marks are bound or unbound; neither offers a control (TRACER-HEADER-ENTRY-TO-RECORDED)', () => {
    render({ marks: [] })
    const bound = container.innerHTML
    act(() => root.render(<MemoryRouter><VerdictBlock view={view()} onCitedStep={() => {}} onSelectMember={() => {}} onCitedArtifact={() => {}} /></MemoryRouter>))
    expect(container.innerHTML).toBe(bound)
    expect(controls()).toHaveLength(0)
  })

  it('paints no chip, triage line, review control or link for a drafted mark; the command lives in the composer history (HISTORY-REVIEW-COMMAND)', () => {
    render({ marks: [mark] })
    expect(markAttributes()).toEqual([])
    expect(container.querySelector('[data-review-command]')).toBeNull()
    expect(container.querySelector('[data-verdict-block] a')).toBeNull()
    expect(container.textContent).not.toContain('prop_0123456789ab')
    expect(container.textContent).not.toContain('false-fail')
  })

  it('puts no proposal id, canonical or not, into any command on the block (HISTORY-PROPOSAL-COPY)', () => {
    render({ marks: [{ ...mark, disposition: { ...mark.disposition, proposalId: "prop_x'; rm -rf ~" } as RunDetailMemberMark['disposition'] }] })
    expect(container.querySelector('[data-review-command]')).toBeNull()
    expect(container.textContent).not.toContain('rm -rf')
  })

  it.each([
    [{ kind: 'quarantined', class: 'flake' }, 'quarantined: flake'],
    [{ kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } }, 'no draftable fix'],
    [{ kind: 'confirmed-bug', confirmedRecords: 0 }, 'confirmed-bug: no fix drafted'],
  ] as const)('paints no triage line for %s; dispositions read in the composer history (HISTORY-PROPOSAL-STATES)', (disposition, text) => {
    render({ marks: [{ ...mark, disposition }] })
    expect(container.textContent).not.toContain(text)
    expect(markAttributes()).toEqual([])
    expect(controls()).toHaveLength(0)
  })

  it('no longer accepts a mark callback or a denial; a refused mark is the composer\'s alert (RETAINED-KEEPS-DRAFT)', () => {
    const onMark = vi.fn()
    mount(
      <VerdictBlock
        view={view({ marks: [] })}
        // @ts-expect-error the block takes no mark callback
        onMark={onMark}
        onCitedStep={() => {}}
        onSelectMember={() => {}}
        onCitedArtifact={() => {}}
      />,
    )
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(controls()).toHaveLength(0)
    expect(onMark).not.toHaveBeenCalled()
  })

  it('shows neither a member nor a step mark on the block, the standing mark is the member header glyph (MEMBER-GLYPH), and constructs no producer markup', () => {
    render({ marks: [mark, { ...mark, stepIndex: 2 }] })
    expect(markAttributes()).toEqual([])
    expect(container.querySelector('[data-feedback-mark-glyph]')).toBeNull()
    expect(readFileSync('src/components/run-detail/verdict-block.tsx', 'utf8')).not.toContain('dangerouslySetInnerHTML')
  })
})

describe("the sentence's lifecycle is a marker, and the marker is the view's", () => {
  it("paints the provisional marker with its exported sentence while the chain may still upgrade", () => {
    const block = render({ marker: "provisional", markerText: ANALYSIS_PROVISIONAL_TEXT })

    const marker = block.querySelector("[data-verdict-marker]")
    expect(marker?.getAttribute("data-verdict-marker"), "the raw word, not the copy").toBe("provisional")
    expect(marker?.textContent).toBe(ANALYSIS_PROVISIONAL_TEXT)
  })

  it("paints the failed marker when the chain fell back permanently", () => {
    const block = render({ marker: "failed", markerText: ANALYSIS_FAILED_FALLBACK_TEXT })

    const marker = block.querySelector("[data-verdict-marker]")
    expect(marker?.getAttribute("data-verdict-marker")).toBe("failed")
    expect(marker?.textContent).toBe(ANALYSIS_FAILED_FALLBACK_TEXT)
  })

  it("renders NO marker element at all on a terminal chain — not an empty one", () => {
    // AN EMPTY MARKER ELEMENT WOULD STILL MATCH `[data-verdict-marker]`, and 406-11's shipped-binary
    // cells assert on exactly that selector. A block that always rendered the element and left it
    // blank would read as "there is a marker here" to every reader of the DOM.
    const block = render()

    expect(block.querySelector("[data-verdict-marker]")).toBeNull()
    expect(block.textContent).not.toContain(ANALYSIS_PROVISIONAL_TEXT)
    expect(block.textContent).not.toContain(ANALYSIS_FAILED_FALLBACK_TEXT)
  })
})

describe("the verdict block's provenance attributes and sentence", () => {
  it("keeps every attribute the tracer put on the block, and reads provenance off the view", () => {
    const block = render({
      producer: "analyze-run",
      confidence: 0.86,
      provenance: provenanceLabel("analyze-run", 0.86),
    })

    const root_ = block.querySelector("[data-verdict-block]")
    expect(root_?.getAttribute("data-verdict-producer")).toBe("analyze-run")
    expect(root_?.getAttribute("data-verdict-confidence")).toBe("0.86")
    expect(block.querySelector("[data-verdict-provenance]")?.textContent)
      .toBe(provenanceLabel("analyze-run", 0.86))
    expect(block.querySelector("[data-verdict-sentence]")?.textContent)
      .toBe('observed (step 0): "Submit never became enabled"')
  })

  it("renders a markup-bearing sentence as TEXT and shows its stored marker as written", () => {
    const hostile = "<img src=x onerror=alert(1)> observed with [secret:PW]"
    const block = render({ sentence: hostile })

    const sentence = block.querySelector("[data-verdict-sentence]")
    expect(sentence?.querySelectorAll("img").length, "no element was ever constructed").toBe(0)
    expect(block.querySelectorAll("img").length).toBe(0)
    expect(sentence?.textContent).toBe(hostile)
    expect(block.querySelector("[data-masked]")).toBeNull()
  })
})

describe("a cited step is one click from its row", () => {
  it("renders one button per cited step and hands the click back with both handles", () => {
    const onCitedStep = vi.fn()
    const block = render({ testIndex: 4, citedSteps: [2, 3] }, { onCitedStep })

    const buttons = [...block.querySelectorAll("[data-cited-step]")]
    expect(buttons.map((el) => el.getAttribute("data-cited-step"))).toEqual(["2", "3"])
    expect(buttons.every((el) => el.tagName === "BUTTON"), "an affordance, not a label").toBe(true)
    expect(buttons[0]?.textContent).toBe(citedStepLabel(2))

    act(() => {
      ;(buttons[0] as HTMLButtonElement).click()
    })
    expect(onCitedStep, "the member handle travels with the step ordinal").toHaveBeenCalledWith(4, 2)
  })

  it("renders no cited-step affordance when the verdict cited no step", () => {
    const block = render({ citedSteps: [] })
    expect(block.querySelector("[data-cited-step]")).toBeNull()
  })
})

describe("a cluster is a sibling LINE under the sentence, never a panel", () => {
  it("counts the siblings on the line and links each one back to its own group", () => {
    const onSelectMember = vi.fn()
    const block = render(
      {
        siblings: [
          { testIndex: 0, testId: "t_0" },
          { testIndex: 7, testId: "t_7" },
        ],
        siblingText: siblingLine(2),
      },
      { onSelectMember },
    )

    const line = block.querySelector("[data-cluster-siblings]")
    expect(line?.getAttribute("data-cluster-siblings")).toBe("2")
    expect(line?.textContent).toContain(siblingLine(2))

    const links = [...block.querySelectorAll("[data-cluster-sibling]")]
    expect(links.map((el) => el.getAttribute("data-cluster-sibling"))).toEqual(["0", "7"])

    act(() => {
      ;(links[1] as HTMLButtonElement).click()
    })
    expect(onSelectMember).toHaveBeenCalledWith(7)
  })

  it("renders no sibling line for a lone failure", () => {
    const block = render({ siblings: [] })
    expect(block.querySelector("[data-cluster-siblings]")).toBeNull()
    expect(block.querySelector("[data-cluster-sibling]")).toBeNull()
  })
})

describe("a cited artifact is one click from the drawer", () => {
  it("renders one button per present cited artifact and hands the click back its sha", () => {
    const onCitedArtifact = vi.fn()
    const block = render(
      { citedArtifacts: [{ id: "art_0", sha: SHA_PRESENT, incomplete: false }] },
      { onCitedArtifact },
    )

    const link = block.querySelector("[data-cited-artifact]")
    expect(link?.getAttribute("data-cited-artifact"), "the sha VERBATIM — the content address itself")
      .toBe(SHA_PRESENT)
    expect(link?.tagName, "an affordance, not a label").toBe("BUTTON")
    expect(link?.textContent).toBe(CITED_ARTIFACT_LABEL)

    act(() => {
      ;(link as HTMLButtonElement).click()
    })
    expect(onCitedArtifact, "the sha is the only handle the page needs").toHaveBeenCalledWith(SHA_PRESENT)
  })

  it("renders no cited-artifact affordance when the verdict cited no artifact", () => {
    const block = render({ citedArtifacts: [] })
    expect(block.querySelector("[data-cited-artifact]")).toBeNull()
  })
})

describe("evidence that is GONE is a chip where the link was, and a count beside it", () => {
  /** One present ref and one whose bytes are gone — the shape D-19 is written about. */
  const ONE_OF_TWO: Partial<MemberVerdictView> = {
    citedArtifacts: [
      { id: "art_0", sha: SHA_PRESENT, incomplete: false },
      { id: "art_1", sha: SHA_GONE, incomplete: true },
    ],
    missingEvidence: { missing: 1, total: 2 },
    missingEvidenceText: missingEvidenceLine({ missing: 1, total: 2 }),
  }

  it("keeps the absent ref IN the row as a chip, and keeps its present sibling clickable", () => {
    const onCitedArtifact = vi.fn()
    const block = render(ONE_OF_TWO, { onCitedArtifact })

    expect(
      block.querySelector(`[data-cited-artifact="${SHA_GONE}"]`),
      "an affordance that opens nothing is a worse lie than the missing picture",
    ).toBeNull()
    expect(block.querySelector(`[data-cited-artifact="${SHA_PRESENT}"]`), "its sibling still opens")
      .not.toBeNull()

    const chip = block.querySelector('[data-cited-artifact-state="unavailable"]')
    expect(chip?.getAttribute("data-cited-artifact-sha"), "the ref is named, not silently dropped")
      .toBe(SHA_GONE)
    expect(chip?.tagName, "not a button").not.toBe("BUTTON")
    expect(chip?.querySelector("button"), "and nothing inside it is one either").toBeNull()

    expect(
      chip?.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]'),
      "rendered through the ONE component, so the overview and this row cannot drift (D-18)",
    ).not.toBeNull()
    expect(chip?.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)

    act(() => {
      ;(chip as HTMLElement).click()
    })
    expect(onCitedArtifact, "clicking the chip asks for nothing").not.toHaveBeenCalled()
  })

  it("says how many of how many are gone, in the exported line", () => {
    const block = render(ONE_OF_TWO)

    // ADDRESSED THE WAY 406-10 ADDRESSES IT — by the attribute's VALUE, not by reading it back off
    // a node found some other way. The count is the selector, so a wrong count is a missing node.
    const count = block.querySelector('[data-evidence-incomplete="1/2"]')
    expect(count, "one of two, and the attribute says which").not.toBeNull()
    expect(count?.textContent).toBe(missingEvidenceLine({ missing: 1, total: 2 }))
  })

  it("renders NO count line when every cited artifact is there", () => {
    const block = render({ citedArtifacts: [{ id: "art_0", sha: SHA_PRESENT, incomplete: false }] })
    expect(block.querySelector("[data-evidence-incomplete=\"1/1\"]")).toBeNull()
    expect(block.querySelector('[data-cited-artifact-state="unavailable"]')).toBeNull()
  })

  it("does NOT re-grade the verdict because a screenshot is gone", () => {
    // ONE MISSING SCREENSHOT IS NOT AN UNTRUSTWORTHY VERDICT (D-19). The whole-verdict badge was
    // rejected precisely because it conflates the two; these three readings are what a reader —
    // and 406-10's shipped-binary cells — use to tell a re-graded verdict from an intact one.
    const intact = render({ citedArtifacts: [{ id: "art_0", sha: SHA_PRESENT, incomplete: false }] })
    const producer = intact.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-producer")
    const confidence = intact.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-confidence")
    const sentence = intact.querySelector("[data-verdict-sentence]")?.textContent

    act(() => {
      root.unmount()
    })
    container.remove()

    const partial = render(ONE_OF_TWO)
    expect(partial.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-producer")).toBe(producer)
    expect(partial.querySelector("[data-verdict-block]")?.getAttribute("data-verdict-confidence")).toBe(confidence)
    expect(partial.querySelector("[data-verdict-sentence]")?.textContent).toBe(sentence)
  })

  it("CITED-BYTES-GONE-UNAVAILABLE renders exactly ONE cited-artifact node when the only cited artifact is gone", () => {
    // THE TWO MUTATIONS 406-11 LEGS, SHAPED AS ONE CELL. Dropping the absent ref would make this
    // zero; rendering it as an ordinary link would make it a BUTTON. Either edit reds here.
    const block = render({
      citedArtifacts: [{ id: "art_0", sha: SHA_GONE, incomplete: true }],
      missingEvidence: { missing: 1, total: 1 },
      missingEvidenceText: missingEvidenceLine({ missing: 1, total: 1 }),
    })

    const nodes = block.querySelectorAll("[data-cited-artifact], [data-cited-artifact-state]")
    expect(nodes.length, "never zero — the reader would count fewer citations than the verdict made")
      .toBe(1)
    expect(nodes[0]?.tagName, "never a button — that is the plain-pass mutation").not.toBe("BUTTON")
    expect(nodes[0]?.getAttribute("data-cited-artifact-state")).toBe("unavailable")
    expect(block.querySelector("[data-evidence-incomplete=\"1/1\"]")?.getAttribute("data-evidence-incomplete"))
      .toBe("1/1")
    expect(block.querySelector("[data-evidence-incomplete=\"1/1\"]")?.textContent)
      .toBe(missingEvidenceLine({ missing: 1, total: 1 }))
  })
})

describe('the records on the failing path in the block', () => {
  const CANDIDATE = 'rec_cand_0001'
  const CANARY = 'rec_canary_01'

  const declared = {
    onPath: [
      { recordId: CANDIDATE, trust: 'candidate' as const },
      { recordId: CANARY, trust: 'candidate' as const },
    ],
    onPathText: memoryOnPathLine(2),
  }

  const attr = (selector: string, name: string) =>
    [...container.querySelectorAll(selector)].map((element) => element.getAttribute(name))

  it('lists every declared record with its trust word under the on-path label', () => {
    render({ memoryOnPath: declared })
    expect(container.querySelector('[data-misdirection-on-path]')?.textContent)
      .toBe(memoryOnPathLine(2))
    expect(container.querySelector('[data-misdirection-exposed]')?.getAttribute('data-misdirection-exposed'))
      .toBe('2')
    expect(container.querySelector('[data-misdirection-exposed] dt')?.textContent)
      .toBe(MEMORY_ON_PATH_RECORDS_LABEL)
    expect(attr('[data-misdirection-on-path-record]', 'data-misdirection-on-path-record'))
      .toEqual([CANDIDATE, CANARY])
    expect(attr('[data-misdirection-trust]', 'data-misdirection-trust'))
      .toEqual(['candidate', 'candidate'])
  })

  it('shows the none-declared line and no list for an empty declaration', () => {
    render({ memoryOnPath: { onPath: [], onPathText: MEMORY_ON_PATH_NONE_TEXT } })
    expect(container.querySelector('[data-misdirection-on-path]')?.textContent)
      .toBe(MEMORY_ON_PATH_NONE_TEXT)
    expect(container.querySelector('[data-misdirection-exposed]')).toBeNull()
  })

  it('renders nothing about memory on the path for a verdict that declared nothing', () => {
    render({ citedSteps: [0], siblings: [] })
    expect(container.querySelector('[data-misdirection-on-path]')).toBeNull()
    expect(container.querySelector('[data-misdirection-on-path-record]')).toBeNull()
    expect(container.querySelector('[data-verdict-sentence]'), 'the block is otherwise intact').not.toBeNull()
    expect(container.querySelector('[data-verdict-provenance]')).not.toBeNull()
    expect(container.querySelector('[data-cited-step="0"]')).not.toBeNull()
  })

  it('the block carries no mark control, and the passive trace sits on the member header', () => {
    const standing: RunDetailMemberMark = { markId: 'mark_0123456789ab', kind: 'false-fail', ordinal: 1,
      disposition: { kind: 'quarantined', class: 'flake' } }
    mount(
      <ul role="tree">
        <MemberGroup
          group={{ member: { testIndex: 4, attempts: 1, outcome: 'failed', marks: [standing] }, steps: [] }}
          showChrome
          verdict={view({ testIndex: 4, memoryOnPath: declared })}
        />
      </ul>,
    )
    const block = container.querySelector('[data-verdict-block]')!
    expect(block.querySelector('[data-misdirection-on-path]'), 'the on-path line still renders').not.toBeNull()
    expect(block.querySelectorAll('[data-mark-kind], textarea, [data-feedback-mark-glyph]')).toHaveLength(0)
    expect([...block.querySelectorAll('button')].every(button =>
      button.hasAttribute('data-cited-step') || button.hasAttribute('data-cited-artifact')
      || button.hasAttribute('data-cluster-sibling'))).toBe(true)
    const glyph = container.querySelector('[data-member="4"] [data-feedback-mark-glyph="test"]')
    expect(glyph, 'the member header carries the trace').not.toBeNull()
    expect(block.contains(glyph)).toBe(false)
  })
})

// WHERE THE HEADER'S DOOR LANDS (425-09 · D-11, UI-SPEC S4 / Color 2).
//
// The block is the destination, so it has to be able to RECEIVE focus without joining the tab
// order — a reader tabbing through a failed run should not stop on every verdict sentence on the
// way to the controls. `-1` is exactly that: reachable programmatically, skipped by Tab.
//
// THE RING IS `:focus` AND NOT `:focus-visible` ON PURPOSE. The door is activated by pointer as
// often as by keyboard, and a browser suppresses `:focus-visible` after a mouse click — which
// would move a reader somewhere and then give them nothing to show where they landed.
describe("the verdict block is the door's landing site", () => {
  it("VERDICT-BLOCK-FOCUSABLE: carries tabindex -1 and a focus ring, and takes focus on demand", () => {
    const host = render()
    const block = host.querySelector<HTMLElement>("[data-verdict-block]")!

    expect(block.getAttribute("tabindex")).toBe("-1")
    expect(block.className).toContain("focus:ring-2")
    expect(block.className).toContain("focus:outline-none")
    expect(block.className).toContain("focus:ring-ring/50")

    block.focus()
    expect(document.activeElement).toBe(block)
  })

  it("changes nothing else about the block's markup", () => {
    const host = render({ citedSteps: [0] })
    const block = host.querySelector<HTMLElement>("[data-verdict-block]")!

    // The three attributes 406-11's shipped-binary cells address are untouched by the new one.
    expect(block.getAttribute("data-verdict-producer")).toBe("deterministic-classifier")
    expect(block.getAttribute("data-verdict-confidence")).toBe("0")
    expect(host.querySelector("[data-verdict-sentence]")).not.toBeNull()
    expect(host.querySelector("[data-verdict-provenance]")).not.toBeNull()
    expect(host.querySelector('[data-cited-step="0"]')).not.toBeNull()
    // It is a focus TARGET, not a control: nothing about it became clickable.
    expect(block.getAttribute("role")).toBeNull()
    expect(block.tagName).toBe("DIV")
  })
})
