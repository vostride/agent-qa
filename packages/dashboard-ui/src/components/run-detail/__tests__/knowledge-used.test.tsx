// @vitest-environment jsdom

// Views come from the real `projectKnowledgeView` over schema-parsed projections, never by hand.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { RunKnowledgeProjectionSchema } from "@vostride/agent-qa-schema"

import { KnowledgeUsed } from "@/components/run-detail/knowledge-used"
import { TabKnowledge } from "@/components/run-detail/tab-knowledge"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  CHANNEL_EYEBROWS,
  CONTENT_ABSENCE_REASON_TEXT,
  ON_TRIAL_TAG,
  ON_TRIAL_TOOLTIP,
  SHOW_FULL_RECORD_LABEL,
  SINCE_STATUS_TAGS,
  RECORD_KIND_LABELS,
  RECORD_UNREADABLE_LEAD,
  USED_PAGE_SIZE,
  projectKnowledgeView,
  showAllRecordsLabel,
  type KnowledgeView,
  type UsedSectionView,
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

type Join = {
  recordContent?: ReturnType<typeof content> & { currentTrust: { trustNarrative?: string } }
  contentAbsence?: { reason: "not-found" | "scan-incomplete" | "not-bound" }
}

function content(summary: string, kind: string, applicability: { product?: string; scope?: string; anchors?: string[] } = {}) {
  return {
    content: `body of ${summary}`,
    summary,
    kind,
    applicability: { product: "shop", scope: "shop", anchors: [] as string[], openedAtOrdinal: 1, ...applicability },
    currentStatus: "active",
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [] as string[], lastEventOrdinal: 1 },
  }
}

function line(id: string, summary: string, kind = "fact", join: Join = {}) {
  return { id, kind, summary, trust: 0.9, status: "active", servedAsCanary: false, tier: "confirmed", ...join }
}

interface Served {
  readonly channel1?: ReturnType<typeof line>[]
  readonly channel2?: Array<{ id: string; detailLevel: string; bodyDigest: string } & Join>
  readonly channel3?: Array<{ id: string; summary: string } & Join>
  readonly planSource?: Record<string, unknown>
}

function step(stepIndex: number, served: Served) {
  return {
    testId: "t_used",
    testIndex: 0,
    stepIndex,
    stepText: `step text ${String(stepIndex)}`,
    served: { channel1: served.channel1 ?? [], channel2: served.channel2 ?? [], channel3: served.channel3 ?? [] },
    trace: { kind: "no-trace", reason: "pre-trace-run" },
    ...(served.planSource === undefined ? {} : { planSource: served.planSource }),
  }
}

function readyView(steps: ReturnType<typeof step>[]): Extract<KnowledgeView, { state: "ready" }> {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: "run-427-05-used",
    buildOrdinal: 1,
    knowledgeStore: "bound",
    steps,
    curation: { status: "complete" },
    learned: { changes: [], canaryAttributions: [] },
  })
  const view = projectKnowledgeView({ kind: "read", projection })
  if (view.state !== "ready") throw new Error("expected a ready view")
  return view
}

function usedOf(steps: ReturnType<typeof step>[]): UsedSectionView {
  return readyView(steps).used
}

function rows(view: HTMLElement): HTMLElement[] {
  return [...view.querySelectorAll<HTMLElement>("li[data-used-record]")]
}

describe("a used row wears its record's kind", () => {
  it("KIND-LABEL: a caution reads Caution, the unknown kind reads Open question, no known kind has no label", () => {
    const view = mount(<KnowledgeUsed view={usedOf([
      step(0, {
        channel3: [{ id: "rec_c", summary: "do not trust the banner", recordContent: content("do not trust the banner", "caution") }],
        channel1: [line("rec_u", "maybe the cart resets", "unknown"), line("rec_h", "a served line of no known kind", "hunch")],
      }),
    ])} />)

    const [unknown, noKind, caution] = rows(view)
    expect(caution?.getAttribute("data-record-kind")).toBe("caution")
    expect(caution?.querySelector('[data-slot="badge"]')?.textContent).toBe(RECORD_KIND_LABELS.caution)
    expect(unknown?.getAttribute("data-record-kind")).toBe("unknown")
    expect(unknown?.querySelector('[data-slot="badge"]')?.textContent).toBe("Open question")
    expect(noKind?.hasAttribute("data-record-kind")).toBe(false)
    expect(noKind?.querySelector('[data-slot="badge"]')).toBeNull()
  })
})

describe("a record that can no longer be read keeps its row", () => {
  it("CONTENT-ABSENCE-KEEPS-ROW: an opened-only not-found record leads honestly and names the reason", () => {
    const view = mount(<KnowledgeUsed view={usedOf([
      step(0, { channel2: [{ id: "rec_gone", detailLevel: "full", bodyDigest: "d", contentAbsence: { reason: "not-found" } }] }),
    ])} />)

    const [row] = rows(view)
    expect(row).toBeDefined()
    expect(row?.getAttribute("data-content-absence")).toBe("not-found")
    expect(row?.querySelector("[data-row-primary]")?.textContent).toBe(RECORD_UNREADABLE_LEAD)
    expect(row?.querySelector("[data-row-absence-reason]")?.textContent).toBe(CONTENT_ABSENCE_REASON_TEXT["not-found"])
    expect([...view.querySelectorAll("*")].some(element => element.textContent === "Show full record")).toBe(false)
    expect(view.outerHTML).not.toContain("rec_gone")
  })

  it("CONTENT-ABSENCE-KEEPS-ROW: a joined row carries no absence attribute and no absence line", () => {
    const view = mount(<KnowledgeUsed view={usedOf([
      step(0, { channel1: [line("rec_ok", "the cart page lives at /view_cart", "fact", { recordContent: content("x", "fact") })] }),
    ])} />)

    const [row] = rows(view)
    expect(row?.hasAttribute("data-content-absence")).toBe(false)
    expect(row?.querySelector("[data-row-absence-reason]")).toBeNull()
  })
})

describe("the default view speaks of records, never channels", () => {
  it("NO-CHANNEL-IN-DEFAULT-VIEW: used, effect and changes carry no channel eyebrow, name or number", () => {
    const view = mount(<TabKnowledge view={readyView([
      step(0, {
        channel1: [line("rec_a", "the cart page lives at /view_cart")],
        channel3: [{ id: "rec_b", summary: "the promo banner lies about stock" }],
        channel2: [{ id: "rec_c", detailLevel: "full", bodyDigest: "d", recordContent: content("checkout needs a login", "procedure") }],
        planSource: { kind: "procedure-replay", procedureId: "rec_p", guard: { checksPassed: 2, total: 2 } },
      }),
    ])} />)

    expect(rows(view).length).toBe(4)
    for (const section of ["used", "effect", "changes"]) {
      const text = view.querySelector(`[data-knowledge-section="${section}"]`)?.textContent ?? ""
      expect(text.length).toBeGreaterThan(0)
      for (const eyebrow of Object.values(CHANNEL_EYEBROWS)) expect(text).not.toContain(eyebrow)
      expect(text).not.toMatch(/channel/i)
    }
  })
})

describe("a long run pages its used rows", () => {
  it("USED-PAGING: 60 records render 50, then Show all 60 records opens a second list with the other 10", () => {
    const lines = Array.from({ length: 60 }, (_, index) => line(`rec_${String(index)}`, `record number ${String(index)}`))
    const view = mount(<KnowledgeUsed view={usedOf([step(0, { channel1: lines })])} />)

    const section = view.querySelector('[data-knowledge-section="used"]')
    const lists = () => [...(section?.querySelectorAll("ul") ?? [])]
    expect(lists().length).toBe(1)
    expect(lists()[0]?.querySelectorAll(":scope > li").length).toBe(USED_PAGE_SIZE)

    const trigger = section?.querySelector<HTMLElement>('[data-used-show-all="60"]')
    expect(trigger?.textContent).toBe(showAllRecordsLabel(60))
    act(() => { trigger?.click() })

    expect(lists().length).toBe(2)
    const rest = lists()[1]?.querySelectorAll(":scope > li")
    expect(rest?.length).toBe(10)
    expect(rest?.[9]?.querySelector("[data-row-primary]")?.textContent).toBe("record number 59")
  })

  it("USED-PAGING: exactly 50 records render one list and no trigger", () => {
    const lines = Array.from({ length: 50 }, (_, index) => line(`rec_${String(index)}`, `record number ${String(index)}`))
    const view = mount(<KnowledgeUsed view={usedOf([step(0, { channel1: lines })])} />)
    expect(view.querySelectorAll("ul").length).toBe(1)
    expect(view.querySelector("[data-used-show-all]")).toBeNull()
  })
})

describe("the heading counts records the way a person reads them", () => {
  it("USED-COUNT-LINE: 1 record, 3 records, and no count line at zero", () => {
    const one = mount(<KnowledgeUsed view={usedOf([step(0, { channel1: [line("rec_a", "a")] })])} />)
    expect(one.querySelector("[data-used-count-line]")?.textContent).toBe("1 record")
    act(() => { root?.unmount() })
    one.remove()

    const three = mount(<KnowledgeUsed view={usedOf([
      step(0, { channel1: [line("rec_a", "a")], channel3: [{ id: "rec_b", summary: "b" }] }),
      step(1, { channel2: [{ id: "rec_c", detailLevel: "full", bodyDigest: "d" }] }),
    ])} />)
    expect(three.querySelector("[data-used-count-line]")?.textContent).toBe("3 records")
    act(() => { root?.unmount() })
    three.remove()

    const zero = mount(<KnowledgeUsed view={usedOf([step(0, {})])} />)
    expect(zero.querySelector("[data-used-count-line]")).toBeNull()
    expect(zero.querySelector("[data-section-absence]")).not.toBeNull()
  })
})

describe("producer text is text", () => {
  it("USED-HOSTILE-TEXT: a summary shaped like markup renders as text and creates no element", () => {
    const hostile = "<img src=x onerror=alert(1)>"
    const view = mount(<KnowledgeUsed view={usedOf([step(0, { channel1: [line("rec_h", hostile)] })])} />)

    expect(view.querySelector("[data-row-primary]")?.textContent).toBe(hostile)
    expect(view.querySelector("img")).toBeNull()
  })
})

function appliesRow(anchors: string[], place: { product?: string; scope?: string } = {}): HTMLElement {
  const view = mount(<KnowledgeUsed view={usedOf([
    step(0, { channel1: [line("rec_a", "the url is asserted", "fact", { recordContent: content("the url is asserted", "fact", { ...place, anchors }) })] }),
  ])} />)
  const applies = view.querySelector<HTMLElement>("[data-row-applicability]")
  expect(applies).not.toBeNull()
  return applies!
}

describe("a used row says where its record applies", () => {
  it("APPLICABILITY-KNOWN-ANSWER: the demo-store record's line reads exactly the known answer", () => {
    const applies = appliesRow(
      ['{"platform":"web","t":"platform"}', '{"name":"measurement:assert-value:url","t":"flow"}'],
      { product: "example-web", scope: "example-web" },
    )
    expect(applies.textContent).toBe("Applies to example-web · web · flow measurement:assert-value:url")
    expect(applies.className).toContain("wrap-anywhere")
    expect([...applies.querySelectorAll("[data-anchor-type]")].map(span => span.getAttribute("data-anchor-type")))
      .toEqual(["platform", "flow"])
  })

  it("APPLICABILITY-ORDER: phrases paint platform, page, flow, element, selector, error, unparsed", () => {
    const applies = appliesRow([
      "not an anchor",
      '{"message":"Out of stock","t":"error"}',
      '{"literal":"#buy","t":"selector"}',
      '{"name":"Buy","ordinal":2,"role":"button","t":"el"}',
      '{"route":"/cart","t":"page"}',
      '{"name":"checkout","t":"flow"}',
      '{"platform":"ios","t":"platform"}',
    ])
    expect([...applies.querySelectorAll("[data-anchor-type]")].map(span => span.getAttribute("data-anchor-type")))
      .toEqual(["platform", "page", "flow", "el", "selector", "error", "unparsed"])
    expect(applies.querySelector('[data-anchor-type="el"]')?.textContent).toBe('element button "Buy" #2')
  })

  it("APPLICABILITY-PRODUCT-SCOPE: a differing product and scope both print; no anchors is the lead alone", () => {
    expect(appliesRow([], { product: "shop", scope: "checkout" }).textContent).toBe("Applies to shop · checkout")
    act(() => { root?.unmount() })
    container?.remove()
    expect(appliesRow([]).textContent).toBe("Applies to shop")
  })

  it("ANCHOR-UNPARSED-VERBATIM: an anchor that does not parse renders verbatim in mono, never dropped", () => {
    const applies = appliesRow(["token=[secret:API_TOKEN]", '{"t":"page"}', '{"route":"/cart","t":"page"}'])
    const unparsed = [...applies.querySelectorAll<HTMLElement>('[data-anchor-type="unparsed"]')]
    expect(unparsed.length).toBe(2)
    for (const span of unparsed) expect(span.className).toContain("font-mono")
    expect(unparsed[1]?.textContent).toBe('{"t":"page"}')
    expect(unparsed[0]?.textContent).toBe("token=[secret:API_TOKEN]")
    expect(applies.querySelector("[data-masked]")).toBeNull()
    expect([...applies.querySelectorAll("[data-anchor-type]")].map(span => span.getAttribute("data-anchor-type")))
      .toEqual(["page", "unparsed", "unparsed"])
  })

  it("SELECTOR-IN-MONO: a selector literal sits in a mono code element after the word selector", () => {
    const applies = appliesRow(['{"literal":"div.cart > button[data-buy]","t":"selector"}'])
    const selector = applies.querySelector('[data-anchor-type="selector"]')
    expect(selector?.textContent).toBe("selector div.cart > button[data-buy]")
    const code = selector?.querySelector("code")
    expect(code?.textContent).toBe("div.cart > button[data-buy]")
    expect(code?.className).toContain("font-mono")
    expect(code?.className).toContain("wrap-anywhere")
  })

  it("APPLICABILITY-KNOWN-ANSWER: a row with no joined content has no applicability line", () => {
    const view = mount(<KnowledgeUsed view={usedOf([step(0, { channel1: [line("rec_a", "served only")] })])} />)
    expect(view.querySelector("[data-row-applicability]")).toBeNull()
  })
})

function servedLine(id: string, summary: string, status: string, servedAsCanary: boolean, join: Join = {}) {
  return { ...line(id, summary, "fact", join), status, servedAsCanary }
}

function withCurrent(summary: string, currentStatus: string) {
  return { ...content(summary, "fact"), currentStatus }
}

function mountTrial(): HTMLElement {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const used = usedOf([
    step(0, { channel1: [servedLine("rec_t", "the promo code field is optional", "candidate", false), servedLine("rec_n", "a proven line", "active", false)] }),
    step(1, { channel1: [servedLine("rec_t", "the promo code field is optional", "candidate", true)] }),
  ])
  act(() => { root?.render(<TooltipProvider delayDuration={0}><KnowledgeUsed view={used} /></TooltipProvider>) })
  return container
}

function describedBy(trigger: HTMLElement | null | undefined): { ids: string[]; targets: Array<HTMLElement | null> } {
  const ids = (trigger?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id.length > 0)
  return { ids, targets: ids.map(id => document.getElementById(id)) }
}

describe("a record on trial says what that means, without the store's word for it", () => {
  it("ON-TRIAL-TAG: a focusable on-trial tag with its meaning as tooltip and as its description; no other row wears it", async () => {
    const view = mountTrial()

    const [trial, proven] = rows(view)
    expect(trial?.getAttribute("data-on-trial")).toBe("true")
    expect(proven?.hasAttribute("data-on-trial")).toBe(false)
    expect(proven?.textContent).not.toContain(ON_TRIAL_TAG)

    const trigger = trial?.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.querySelector('[data-slot="badge"]')?.textContent).toBe(ON_TRIAL_TAG)
    expect(describedBy(trigger).targets[0]?.textContent).toBe(ON_TRIAL_TOOLTIP)
    expect(trigger?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")

    const section = view.querySelector('[data-knowledge-section="used"]')
    expect(section?.textContent).not.toMatch(/canary/i)
    await act(async () => { trigger?.focus() })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(ON_TRIAL_TOOLTIP)
    expect(section?.textContent).not.toMatch(/canary/i)
  })

  it("TRIGGER-ACCESSIBLE-NAME: the on-trial tag is a button named by its label, its meaning its one static description", async () => {
    const view = mountTrial()
    const [trial] = rows(view)
    const trigger = trial?.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')

    expect(trigger?.tagName).toBe("BUTTON")
    expect(trigger?.getAttribute("type")).toBe("button")
    for (const attribute of ["role", "aria-label", "title"]) expect(trigger?.hasAttribute(attribute), attribute).toBe(false)
    expect(trigger?.textContent?.trim()).toBe(ON_TRIAL_TAG)
    expect(trigger?.textContent).not.toContain(ON_TRIAL_TOOLTIP)

    const { ids, targets } = describedBy(trigger)
    expect(ids).toHaveLength(1)
    const description = targets[0]
    expect(description).not.toBeNull()
    expect(trigger?.contains(description ?? null)).toBe(false)
    expect(description?.hasAttribute("hidden")).toBe(true)
    expect(description?.textContent).toBe(ON_TRIAL_TOOLTIP)
    expect(`${trigger?.textContent ?? ""} ${description?.textContent ?? ""}`.split(ON_TRIAL_TOOLTIP).length - 1).toBe(1)

    await act(async () => { trigger?.focus() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.textContent).toBe(ON_TRIAL_TOOLTIP)
    expect(trigger?.getAttribute("aria-describedby")).toBe(ids[0])
    expect(trigger?.getAttribute("aria-describedby")).not.toBe(tooltip?.id)
  })
})

describe("a record that changed since the run says how", () => {
  it("SINCE-TAG-RULE: served on trial and now superseded or proven wears the tag; unchanged or opened-only rows do not", () => {
    const view = mount(<KnowledgeUsed view={usedOf([
      step(0, {
        channel1: [
          servedLine("rec_s", "superseded since", "candidate", false, { recordContent: withCurrent("superseded since", "superseded") }),
          servedLine("rec_p", "proven since", "candidate", false, { recordContent: withCurrent("proven since", "active") }),
          servedLine("rec_u", "unchanged", "active", false, { recordContent: withCurrent("unchanged", "active") }),
        ],
        channel2: [{ id: "rec_o", detailLevel: "full", bodyDigest: "d", recordContent: withCurrent("opened only", "deprecated") }],
      }),
    ])} />)

    const [superseded, proven, unchanged, opened] = rows(view)
    expect(superseded?.getAttribute("data-since-status")).toBe("superseded")
    expect(superseded?.textContent).toContain("since superseded")
    expect(proven?.getAttribute("data-since-status")).toBe("active")
    expect(proven?.textContent).toContain(SINCE_STATUS_TAGS.active)
    for (const row of [unchanged, opened]) {
      expect(row?.hasAttribute("data-since-status")).toBe(false)
      expect(row?.textContent).not.toMatch(/\bsince\b/)
    }
  })
})

describe("a used row opens to its whole record, counts before the curator's note", () => {
  it("FULL-RECORD-ORDER: status, body, counts, note — and no numeric trust, tier or evidence token anywhere", () => {
    const joined = {
      ...content("the cart page lives at /view_cart", "fact"),
      currentStatus: "candidate",
      currentTrust: { confirmations: 3, contradictions: 1, evidenceTokens: ["evtok-7f3e"], lastEventOrdinal: 4, trustNarrative: "Seen on two runs." },
    }
    const view = mount(<KnowledgeUsed view={usedOf([
      step(0, { channel1: [{ ...line("rec_a", "the cart page lives at /view_cart", "fact", { recordContent: joined }), trust: 0.8765, tier: "provisional" }] }),
    ])} />)

    const trigger = [...view.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]')]
      .find(element => element.textContent === SHOW_FULL_RECORD_LABEL)
    expect(trigger).toBeDefined()
    act(() => { trigger?.click() })

    const full = view.querySelector<HTMLElement>("[data-full-record]")
    expect(full).not.toBeNull()
    const order = [...(full?.children ?? [])].map(child =>
      ["data-record-current-status", "data-record-content", "data-trust-counts", "data-evidence-note"].find(name => child.hasAttribute(name)))
    expect(order).toEqual(["data-record-current-status", "data-record-content", "data-trust-counts", "data-evidence-note"])
    expect(full?.querySelector("[data-trust-counts]")?.textContent).toBe("Confirmed 3 times · contradicted once")

    const section = view.querySelector('[data-knowledge-section="used"]')?.textContent ?? ""
    for (const hidden of ["0.8765", "0.88", "provisional", "evtok-7f3e"]) expect(section).not.toContain(hidden)
  })
})
