// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TabAriaTree } from "@/components/run-detail/tab-aria-tree"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}))
vi.mock("@/lib/api", () => ({
  fetchStepReasoning: vi.fn(),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderTree() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <TabAriaTree
        step={{
          id: "step-1",
          name: "Open login",
          status: "passed",
          duration: 1000,
          subActionsData: null,
          originalStepName: null,
          variableSnapshot: null,
          screenshotPath: null,
          screenshotBeforePath: null,
          annotationData: null,
          observation: null,
          reasoning: null,
          plannedAction: null,
          action: null,
          error: null,
          confidence: null,
          runId: "run-1",
          stepOrder: 0,
          consoleLogs: null,
          networkLogs: null,
          healingAttempts: null,
          screenContextBefore: null,
          screenContextAfter: null,
          rawRunId: "run-1",
          rawStepOrder: 0,
          displayStepOrder: 1,
          displayStepTotal: 1,
        }}
        subAction={{
          index: 0,
          observation: "raw",
          reasoning: "",
          plannedAction: null,
          result: "success",
          screenStateBefore: "before:\n  - button \"Checkout\" [ref=e1]\n  - text \"Total\"",
          screenStateAfter: "after:\n  - button \"Checkout\" [ref=e1]\n  - text \"Paid\"",
          cached: false,
        }}
        runId="run-1"
      />,
    )
  })

  await flushRender()
  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  vi.clearAllMocks()
})

describe("TabAriaTree", () => {
  it("keeps the raw snapshot content inside a vertically contained scroll frame", async () => {
    const view = await renderTree()
    const beforeButton = Array.from(view.querySelectorAll("button")).find((button) => button.textContent === "Before") as HTMLButtonElement
    const afterButton = Array.from(view.querySelectorAll("button")).find((button) => button.textContent === "After") as HTMLButtonElement

    const rootSurface = view.firstElementChild as HTMLDivElement | null
    const frame = Array.from(view.querySelectorAll("div")).find((element) =>
      element.className.includes("flex-1")
      && element.className.includes("overflow-hidden")
      && element.className.includes("border-border/60")
      && element.className.includes("bg-muted/20"),
    ) as HTMLDivElement | undefined
    const wrapper = frame?.querySelector(".overflow-auto") as HTMLDivElement | null
    const pre = view.querySelector("pre")

    expect(rootSurface?.className).toContain("min-h-0")
    expect(rootSurface?.className).toContain("overflow-hidden")
    expect(beforeButton.className).toContain("bg-primary/10")
    expect(beforeButton.className).toContain("ring-primary/30")
    expect(afterButton.className).toContain("hover:bg-muted")
    expect(frame?.className).toContain("overflow-hidden")
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toContain("overscroll-contain")
    expect(pre?.textContent).toBe(
      'before:\n  - button "Checkout" [ref=e1]\n  - text "Total"',
    )

    await act(async () => {
      afterButton.click()
    })
    await flushRender()

    expect(afterButton.className).toContain("bg-primary/10")
    expect(afterButton.className).toContain("ring-primary/30")
    expect(view.querySelector("pre")?.textContent).toBe(
      'after:\n  - button "Checkout" [ref=e1]\n  - text "Paid"',
    )
  })
})
