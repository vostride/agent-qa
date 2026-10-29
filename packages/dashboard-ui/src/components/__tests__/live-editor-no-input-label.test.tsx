// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { EditorSubActionRow } from "@/components/editor/editable-step-wrapper"
import { EditorStepDetail } from "@/components/editor/editor-step-detail"
import { SubActionStatusIcon } from "@/components/step-card-editor"
import { formatSubActionSummary } from "@/components/suite-test-row"
import type { LiveSubAction } from "@/hooks/use-live-editor"
import type { DisplayStep } from "@/lib/display-step"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STEP: DisplayStep = {
  id: "s1",
  name: "turn Wi-Fi on",
  status: "passed",
  duration: 10,
  stepOrder: 0,
  rawStepOrder: 0,
  displayStepOrder: 1,
  displayStepTotal: null,
}

function liveSubAction(result: LiveSubAction["result"], error?: string): LiveSubAction {
  return {
    index: 0,
    observation: "Wi-Fi switch",
    reasoning: "turn Wi-Fi on",
    plannedAction: { type: "tap", ref: "e3" },
    result,
    ...(error === undefined ? {} : { error }),
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderDetail(subAction: LiveSubAction): HTMLElement {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<EditorStepDetail step={STEP} subAction={subAction} />))
  return container
}

function outcomeOf(view: HTMLElement) {
  const words = ["success", "failure", "no input sent"]
  return [...view.querySelectorAll("span.text-xs.font-medium")].find((span) =>
    words.includes(span.textContent ?? ""),
  )
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe("a skipped tap that sent no input", () => {
  it("the live editor detail names a skipped tap no input sent in the muted colour", () => {
    const view = renderDetail(liveSubAction("no-input"))
    const outcome = outcomeOf(view)
    expect(outcome?.textContent).toBe("no input sent")
    expect(outcome?.className).toContain("text-muted-foreground")
    expect(view.innerHTML).not.toContain("failure")
    expect(view.innerHTML).not.toContain("text-red-500")
    act(() => root!.unmount())
    container?.remove()

    const passed = outcomeOf(renderDetail(liveSubAction("success")))
    expect(passed?.textContent).toBe("success")
    expect(passed?.className).toContain("text-emerald-500")
    act(() => root!.unmount())
    container?.remove()

    const failed = outcomeOf(renderDetail(liveSubAction("failure", "element not found")))
    expect(failed?.textContent).toBe("failure")
    expect(failed?.className).toContain("text-red-500")
  })

  it("the live editor row draws a skipped tap with a muted dot", () => {
    const row = (result: LiveSubAction["result"]) => {
      if (root) act(() => root!.unmount())
      container?.remove()
      container = document.createElement("div")
      document.body.appendChild(container)
      root = createRoot(container)
      act(() =>
        root!.render(
          <ul>
            <EditorSubActionRow
              sub={liveSubAction(result)}
              index={0}
              stepId="s1"
              isSelected={false}
              onSelect={() => {}}
            />
          </ul>,
        ),
      )
      return container.querySelector("li[data-sub-action-id]") as HTMLElement
    }

    const skipped = row("no-input")
    expect(skipped.querySelector("span.rounded-full")?.className).toContain("bg-muted-foreground")
    expect(skipped.innerHTML).not.toContain("bg-red-500")

    expect(row("success").querySelector("span.rounded-full")?.className).toContain("bg-emerald-500")
    expect(row("failure").querySelector("span.rounded-full")?.className).toContain("bg-red-500")

    const running = row("in-progress")
    expect(running.querySelector("svg.animate-spin")).not.toBeNull()
    expect(running.querySelector("span.rounded-full")).toBeNull()
  })

  it("the step card marks a skipped tap with the muted no-input glyph", () => {
    const icon = (result: LiveSubAction["result"]) => {
      if (root) act(() => root!.unmount())
      container?.remove()
      container = document.createElement("div")
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => root!.render(<SubActionStatusIcon result={result} />))
      return container.querySelector("svg") as SVGElement
    }

    const skipped = icon("no-input")
    const label = skipped.getAttribute("aria-label") ?? skipped.getAttribute("title")
    expect(label).toBe("no input sent")
    expect(skipped.getAttribute("class")).toContain("text-muted-foreground")
    expect(skipped.getAttribute("class")).not.toContain("text-destructive")

    expect(icon("success").getAttribute("class")).toContain("text-emerald-500")
    expect(icon("failure").getAttribute("class")).toContain("text-destructive")
  })

  it("the suite row summary of a bare skipped tap reads no input sent", () => {
    const bare: LiveSubAction = {
      index: 0,
      observation: "",
      reasoning: "",
      plannedAction: null,
      result: "no-input",
    }
    expect(formatSubActionSummary(bare)).toBe("no input sent")
    expect(formatSubActionSummary(bare)).not.toBe("no-input")
    expect(formatSubActionSummary({ ...bare, observation: "Wi-Fi switch" })).toBe("Wi-Fi switch")
    expect(formatSubActionSummary({ ...bare, result: "success" })).toBe("success")
    expect(formatSubActionSummary({ ...bare, result: "failure" })).toBe("failure")
  })
})
