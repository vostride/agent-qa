// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TabOverview } from "@/components/run-detail/tab-overview"
import { EVIDENCE_COPY } from "@/lib/evidence-state-view"
import { buildTimelineModel } from "@/lib/playhead"
import { fromRunDetailStep } from "@/lib/display-step"
import { routes } from "@/lib/routes"
import { EVIDENCE_INCOMPLETE_LABEL } from "@/lib/run-detail-view"
import type { ArtifactRef, RunDetailSubAction } from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The viewer double renders the real `img` and failure callback, so the cells measure the seam.
vi.mock("@/components/screenshot-viewer", () => ({
  ScreenshotViewer: ({ src, onUnavailable }: { src: string; onUnavailable?: () => void }) => (
    <img data-testid="screenshot-viewer" src={src} onError={() => onUnavailable?.()} />
  ),
}))


const SHA = "a1b2c3d4".repeat(8)

const RAW_STEP = {
    testIndex: 0,
    stepIndex: 0,
    stepText: "Open dashboard",
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "the dashboard is up" },
    selfHealOccurred: false,
    briefDigest: "d00",
    status: "passed",
    durationMs: 1000,
  } as const
const STEP = fromRunDetailStep(RAW_STEP, [])

function makeSubAction(artifactRefs?: readonly ArtifactRef[]): RunDetailSubAction {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex: 0,
    plan: "Open the dashboard",
    plannedAction: { type: "click", ref: asRef("dashboard") },
    result: { success: true },
    screenStateHash: "f".repeat(64),
    ...(artifactRefs === undefined ? {} : { artifactRefs }),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderOverview(
  subAction: RunDetailSubAction | null,
  _legacyState: "pending" | "absent" = "absent",
) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <TabOverview
        step={STEP}
        subAction={subAction}
        runId="run-1"
        model={buildTimelineModel({ member: { testIndex: 0, name: "Test", attempts: 1 }, steps: [{ step: RAW_STEP, subActions: subAction ? [subAction] : [] }] })}
        playhead={subAction ?? null}
      />,
    )
  })

  return container
}

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
})

describe("TabOverview screenshot states", () => {
  it("cleans icon glyphs from grounding display without changing Unicode or stored evidence", async () => {
    const sub = makeSubAction([])
    const name = "\uE001 Café 日本語 \u{F0001} [secret:PW]"
    sub.grounding = { descriptor: { role: "button", name }, attempts: [] }
    const view = await renderOverview(sub)
    const grounding = Array.from(view.querySelectorAll("button")).find(button => button.textContent?.includes("Grounding"))!
    await act(async () => grounding.click())
    const rendered = view.querySelector("[data-grounding-descriptor]")!
    expect(rendered.textContent).toContain("button Café 日本語")
    expect(rendered.textContent).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
    expect(rendered.textContent).toContain("[secret:PW]")
    expect(rendered.querySelector("[data-masked]")).toBeNull()
    expect(sub.grounding.descriptor.name).toBe(name)
  })

  it("shows pending copy while a screenshot is still expected", async () => {
    const view = await renderOverview(null, "pending")

    expect(view.textContent).toContain(EVIDENCE_COPY.frame["not-captured"].step.title)
    expect(view.textContent).not.toContain(EVIDENCE_COPY.frame["not-captured"]["sub-action"].title)
    expect(view.querySelector("img")).toBeNull()
  })

  it("shows absent copy when this turn recorded no decision screenshot", async () => {
    const view = await renderOverview(makeSubAction([]), "absent")

    expect(view.textContent).toContain(EVIDENCE_COPY.frame["not-captured"]["sub-action"].title)
    expect(view.textContent).not.toContain(EVIDENCE_COPY.frame["not-captured"].step.title)
    expect(view.textContent).not.toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(view.querySelector('[data-evidence-state="unavailable"][data-evidence-incomplete]')).toBeNull()
    expect(view.querySelector("img")).toBeNull()
  })

  it("mints the image src from the ref through the one route minter", async () => {
    const view = await renderOverview(
      makeSubAction([{ id: `decision-screenshot:${SHA}`, sha: SHA }]),
    )

    expect(view.querySelector('[data-artifact-state="available"]')).not.toBeNull()
    expect(view.querySelector("img")?.getAttribute("src")).toBe(routes.runArtifact("run-1", SHA))
  })

  // The producer already told us the bytes are not there. Asking anyway would turn a known fact
  // into a round-trip whose 404 we would then have to interpret.
  it("refuses without requesting when the ref says the evidence is incomplete", async () => {
    const view = await renderOverview(
      makeSubAction([{ id: `decision-screenshot:${SHA}`, sha: SHA, evidenceIncomplete: true }]),
    )

    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
    expect(view.querySelector("img")).toBeNull()
  })

  it("flips to the same refusal when the request for the blob fails", async () => {
    const view = await renderOverview(
      makeSubAction([{ id: `decision-screenshot:${SHA}`, sha: SHA }]),
    )

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }))
    const image = view.querySelector("img")
    expect(image).not.toBeNull()

    await act(async () => {
      image!.dispatchEvent(new Event("error"))
    })

    expect(view.querySelector("img")).toBeNull()
    expect(
      view.querySelector('[data-artifact-state="unavailable"] [data-evidence-state="unavailable"][data-evidence-incomplete]'),
    ).not.toBeNull()
    expect(view.textContent).toContain(EVIDENCE_INCOMPLETE_LABEL)
  })

  // An `artifactRefs` list is open — the producer may attach other evidence to the same turn — so
  // the pane selects the decision screenshot by its id rather than taking whatever came first.
  // Taking the first entry would put an arbitrary blob into the image the moment a second channel
  // starts recording, which is a WRONG picture rather than a missing one.
  it("selects the decision screenshot by id rather than taking the first ref", async () => {
    const other = "b".repeat(64)
    const view = await renderOverview(
      makeSubAction([
        { id: `dom-snapshot:${other}`, sha: other },
        { id: `decision-screenshot:${SHA}`, sha: SHA },
      ]),
    )

    expect(view.querySelector("img")?.getAttribute("src")).toBe(routes.runArtifact("run-1", SHA))
  })
})

describe("a skipped tap that sent no input", () => {
  function resultOutcome(view: HTMLElement) {
    const words = ["success", "failure", "no input sent"]
    return [...view.querySelectorAll("span.text-xs.font-medium")].find((span) => words.includes(span.textContent ?? ""))
  }

  it("the overview tab's result reads no input sent", async () => {
    const skipped: RunDetailSubAction = {
      ...makeSubAction(),
      plannedAction: { type: "tap", ref: asRef("wifi") },
      result: { success: false, metadata: { idempotentNoop: { currentState: "checked", inputSent: false } } },
    }
    const outcome = resultOutcome(await renderOverview(skipped))
    expect(outcome?.textContent).toBe("no input sent")
    expect(outcome?.className).toContain("text-muted-foreground")
    expect(outcome?.className).not.toContain("text-red-500")
    expect(outcome?.className).not.toContain("text-emerald-500")
  })

  it("success and failure results are unchanged", async () => {
    const passed = resultOutcome(await renderOverview(makeSubAction()))
    expect(passed?.textContent).toBe("success")
    expect(passed?.className).toContain("text-emerald-500")
    act(() => root!.unmount())
    container?.remove()
    const failed = resultOutcome(await renderOverview({ ...makeSubAction(), result: { success: false, error: "boom" } }))
    expect(failed?.textContent).toBe("failure")
    expect(failed?.className).toContain("text-red-500")
  })
})
