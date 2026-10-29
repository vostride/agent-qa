import { RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
// @vitest-environment jsdom

// A GATE RUN'S KNOWLEDGE TAB READS ITS CURATION AS SKIPPED, NEVER PENDING (444 D-61, D-39, D-13).
//
// Origin `444 D-61`. A gate run and an outcome-excluded run never enqueue curation, so the chip
// beside them is a defaulted `pending` no job will ever move. `runs.knowledge` carries the skipped
// fact beside it (444-26), and these cells hold the tab to it on the page's own path: every world
// is a schema-parsed projection, folded by `projectKnowledgeView`, mounted as `TabKnowledge`
// through `createRoot` into `document.body`, as `main.tsx` does.

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import {
  RunKnowledgeProjectionSchema,
  type PostProcessingSkipReason,
  type RunKnowledgeProjection,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from "@vostride/agent-qa-schema"

import { TabKnowledge } from "@/components/run-detail/tab-knowledge"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ATTRIBUTION_PENDING_TEXT,
  ATTRIBUTION_SKIPPED_TEXT,
  CHANGES_PENDING_TEXT,
  EFFECT_NOTHING_MEASURED_TEXT,
  EFFECT_SENTENCES,
  projectKnowledgeView,
  type KnowledgeView,
} from "@/lib/knowledge-view"
import { STAGE_SKIPPED_TEXT } from "@/lib/post-processing-view"

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
  // A cell that mounts a second world unmounts the first, so only one tab is ever in the document.
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => { root?.render(<TooltipProvider delayDuration={0}>{element}</TooltipProvider>) })
  return container
}

const RUN = "run-444-29-tab"
const CANARY_ID = "rec_cart_url"

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: "ready" }>
type LearnedChange = ReadyProjection["learned"]["changes"][number]
type CanaryAttribution = ReadyProjection["learned"]["canaryAttributions"][number]

interface WorldOptions {
  readonly reason?: PostProcessingSkipReason
  readonly changes?: readonly LearnedChange[]
  readonly canaryAttributions?: readonly CanaryAttribution[]
}

/**
 * One step whose single channel-1 line was served as a canary, with no plan source, so the canary
 * is the only record the run used. Curation's chip is the defaulted `pending`; `reason` adds the
 * skipped fact beside it, and leaving it out is the control world with no `skipped` key at all.
 */
function world({ reason, changes = [], canaryAttributions = [] }: WorldOptions = {}): ReadyProjection {
  const projection = RunKnowledgeProjectionSchema.parse({
    kind: "ready",
    runId: RUN,
    buildOrdinal: 3,
    knowledgeStore: "bound",
    steps: [{
      testId: "t_checkout",
      testIndex: 0,
      stepIndex: 0,
      stepText: "click checkout",
      served: {
        channel1: [{
          id: CANARY_ID,
          kind: "fact",
          summary: "the cart page lives at /view_cart",
          trust: 0.9,
          status: "active",
          servedAsCanary: true,
          tier: "confirmed",
        }],
        channel2: [],
        channel3: [],
      },
      trace: {
        kind: "answered",
        trace: {
          schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
          servedLines: [{ recordId: CANARY_ID, leg: "anchor", rank: 1, score: 1.48695 }],
          truncated: [],
        },
      },
    }],
    curation: { status: "pending", ...(reason === undefined ? {} : { skipped: { reason } }) },
    learned: { changes, canaryAttributions },
  })
  if (projection.kind !== "ready") throw new Error("the world must parse as the ready arm")
  return projection
}

function view(projection: ReadyProjection): KnowledgeView {
  return projectKnowledgeView({ kind: "read", projection })
}

function change(recordId: string, kind: LearnedChange["change"], atOrdinal: number): LearnedChange {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change: kind, atOrdinal, sourceRunId: RUN,
    evidenceToken: `receipt-${recordId}-${String(atOrdinal)}`,
  }
}

function joined(row: LearnedChange): LearnedChange {
  return {
    ...row,
    recordContent: {
      content: `body ${row.recordId}`, summary: `summary ${row.recordId}`, kind: "fact",
      applicability: { product: "shop", scope: "checkout", anchors: [], openedAtOrdinal: 1 },
      currentStatus: "active",
      currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 30 },
    },
  }
}

function attribution(outcome: CanaryAttribution["outcome"]): CanaryAttribution {
  return { testIndex: 0, stepIndex: 0, recordId: CANARY_ID, observationId: "canary-outcome:444-29", outcome }
}

function changesSection(tab: HTMLElement): HTMLElement {
  const section = tab.querySelector<HTMLElement>('[data-knowledge-section="changes"]')
  if (section === null) throw new Error("no Memory changes section")
  return section
}

// 427 D-19: the per-step ledger renders only once the collapsed Retrieval details is opened.
function openRetrievalDetails(tab: HTMLElement): void {
  const trigger = tab.querySelector('[data-knowledge-section="retrieval-details"] [data-slot="collapsible-trigger"]')
  if (trigger === null) throw new Error("no Retrieval details trigger")
  act(() => { (trigger as HTMLElement).click() })
}

function openStepRow(tab: HTMLElement): void {
  const trigger = tab.querySelector('[data-step-index] [data-slot="collapsible-trigger"]')
  if (trigger === null) throw new Error("no step row trigger")
  act(() => { (trigger as HTMLElement).click() })
}

function mountOpened(projection: ReadyProjection): HTMLElement {
  const tab = mount(<TabKnowledge view={view(projection)} />)
  openRetrievalDetails(tab)
  openStepRow(tab)
  return tab
}

describe("C444-KNOWLEDGE-TAB-SKIPPED", () => {
  it("a gate run's Memory changes reads the gate run's curation-skipped sentence, not pending", () => {
    const section = changesSection(mount(<TabKnowledge view={view(world({ reason: "gate-run" }))} />))

    expect(section.getAttribute("data-learned-state")).toBe("skipped")
    expect(section.querySelector("[data-learned-sentence]")?.textContent).toBe(STAGE_SKIPPED_TEXT["gate-run"].curation)
    expect(section.querySelector("[data-learned-count-line]")).toBeNull()
    expect(section.textContent).not.toContain(CHANGES_PENDING_TEXT)
  })

  it("an outcome-excluded run's Memory changes reads the outcome-excluded sentence", () => {
    const section = changesSection(mount(<TabKnowledge view={view(world({ reason: "outcome-excluded" }))} />))

    expect(section.getAttribute("data-learned-state")).toBe("skipped")
    expect(section.querySelector("[data-learned-sentence]")?.textContent)
      .toBe(STAGE_SKIPPED_TEXT["outcome-excluded"].curation)
    expect(section.querySelector("[data-learned-count-line]")).toBeNull()
    expect(section.textContent).not.toContain(CHANGES_PENDING_TEXT)
  })

  it("a skipped run's attributed rows are painted with the skip stated beside them", () => {
    const projection = world({ reason: "gate-run", changes: [joined(change("fact-added", "added", 20))] })
    const tabView = view(projection)
    const section = changesSection(mount(<TabKnowledge view={tabView} />))

    expect(section.querySelectorAll("li[data-record-change]").length).toBe(1)
    expect(section.querySelector("li[data-record-change]")?.getAttribute("data-record-change")).toBe("added")
    expect(section.querySelector("[data-learned-sentence]")).toBeNull()
    expect(section.querySelector("[data-learned-chain-note]")?.textContent).toBe(STAGE_SKIPPED_TEXT["gate-run"].curation)
    if (tabView.state !== "ready") throw new Error("the view must be ready")
    expect(tabView.ledger.changes.length).toBe(1)
  })

  it("a run with no skipped fact still reads its pending chip", () => {
    const projection = world()
    expect("skipped" in projection.curation).toBe(false)
    const section = changesSection(mount(<TabKnowledge view={view(projection)} />))

    expect(section.getAttribute("data-learned-state")).toBe("pending")
    expect(section.querySelector("[data-learned-sentence]")?.textContent).toBe(CHANGES_PENDING_TEXT)
  })

  it("a gate run's canary line reads attribution skipped in Retrieval details", () => {
    const skippedLine = canaryLine(mountOpened(world({ reason: "gate-run" })))
    expect(skippedLine.getAttribute("data-canary-outcome")).toBe("skipped")
    expect(skippedLine.textContent).toContain(ATTRIBUTION_SKIPPED_TEXT)

    // Rows win (407-22): a served attribution row is the line's answer on a skipped run too.
    const servedLine = canaryLine(mountOpened(world({ reason: "gate-run", canaryAttributions: [attribution("confirmed")] })))
    expect(servedLine.getAttribute("data-canary-outcome")).toBe("confirmed")
  })

  it("a gate run's Effect section counts its canary as unmeasured, not on trial", () => {
    const tabView = view(world({ reason: "gate-run" }))
    const effect = mount(<TabKnowledge view={tabView} />).querySelector('[data-knowledge-section="effect"]')

    expect(effect).not.toBeNull()
    expect(effect?.querySelector("[data-effect-entry]")).toBeNull()
    expect(effect?.querySelector("[data-section-absence]")?.textContent).toBe(EFFECT_NOTHING_MEASURED_TEXT)
    if (tabView.state !== "ready") throw new Error("the view must be ready")
    expect("uncounted" in tabView.effect).toBe(false)
  })

  it("a gate run's tab reads pending nowhere", () => {
    const pendingAttributes = [
      '[data-learned-state="pending"]',
      '[data-canary-outcome="pending"]',
      '[data-effect-outcome="pending"]',
    ]
    const pendingTexts = [CHANGES_PENDING_TEXT, ATTRIBUTION_PENDING_TEXT, EFFECT_SENTENCES.pending.tail]

    // The control world, with no skipped key, shows every pending mark, so the probe can see them.
    const control = mountOpened(world())
    for (const selector of pendingAttributes) expect(control.querySelector(selector), selector).not.toBeNull()
    for (const text of pendingTexts) expect(control.textContent, text).toContain(text)

    const gate = mountOpened(world({ reason: "gate-run" }))
    for (const selector of pendingAttributes) expect(gate.querySelector(selector), selector).toBeNull()
    for (const text of pendingTexts) expect(gate.textContent, text).not.toContain(text)
  })
})

function canaryLine(tab: HTMLElement): HTMLElement {
  const line = tab.querySelector<HTMLElement>('li[data-served-channel="1"][data-served-as-canary="true"]')
  if (line === null) throw new Error("no canary line in the expanded step row")
  return line
}
