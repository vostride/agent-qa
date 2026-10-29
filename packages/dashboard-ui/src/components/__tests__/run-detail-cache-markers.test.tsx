// @vitest-environment jsdom
//
// THE CACHE MARKERS ON THE DURABLE TREE.
//
// The projection records `cacheStatus` on the step (`hit`, `miss`, `bypass` or `disabled`) and
// nothing per sub-action. So the step's own status is what the marker reads, and a sub-action's
// marker is the step's answer applied to it: when the step was served from cache, every action
// under it was. A step that was not served from cache renders no marker at all; there is no
// partial state to invent.

import { act, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunDetailMember, RunDetailStep, RunDetailSubAction } from "@vostride/agent-qa-schema"
import { asRef } from "@vostride/agent-qa-schema"

import { StepTreeItem } from "@/components/run-detail/step-tree-item"
import { StepTree } from "@/components/run-detail/step-tree"
import { SubActionTreeItem } from "@/components/run-detail/sub-action-tree-item"
import type { ExecutionLogEntry } from "@/lib/api"
import { fromRunDetailStep } from "@/lib/display-step"
import { DID_NOT_RUN_LABEL, type RunDetailGroup } from "@/lib/run-detail-view"

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

function makeStep(overrides: Partial<RunDetailStep> = {}): RunDetailStep {
  return {
    testIndex: 0,
    stepIndex: 0,
    stepText: "Open the dashboard",
    cacheStatus: "miss",
    verifierVerdict: { pass: true, reasoning: "the dashboard is on screen" },
    selfHealOccurred: false,
    briefDigest: "d00",
    status: "passed",
    durationMs: 1200,
    ...overrides,
  }
}

function makeSubAction(subActionIndex: number, overrides: Partial<RunDetailSubAction> = {}): RunDetailSubAction {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex,
    plan: "Clicking the primary button is safe",
    plannedAction: { type: "click", ref: asRef("primary") },
    result: { success: true },
    screenStateHash: "abcdef0123456789".repeat(4),
    ...overrides,
  }
}

function makeHook(id: string, runId: string, name: string, phase: "setup" | "teardown"): ExecutionLogEntry {
  return {
    id,
    runId,
    stepId: null,
    type: "hook",
    name,
    hookId: id,
    phase,
    status: "passed",
    duration: 5,
    stdout: null,
    stderr: null,
    returnData: null,
    variables: null,
    createdAt: "2026-04-29T00:00:00.000Z",
  }
}

function group(m: RunDetailMember, steps: RunDetailStep[]): RunDetailGroup {
  return { member: m, steps: steps.map((step) => ({ step, subActions: [] })) }
}

describe("run detail cache markers", () => {
  it("renders a status-attached primary marker for a step served from cache", () => {
    const view = mount(
      <ul>
        <StepTreeItem
          step={fromRunDetailStep(makeStep({ cacheStatus: "hit" }), [makeSubAction(0), makeSubAction(1)])}
          isSelected={false}
          isExpanded={false}
          selection={null}
          onSelect={() => {}}
        />
      </ul>,
    )

    const marker = view.querySelector('[data-cache-marker="step-status"][data-cache-state="all"]')
    const icon = marker?.querySelector("svg")

    expect(marker).toBeTruthy()
    expect(marker?.className).toContain("size-2")
    expect(marker?.className).toContain("rounded-full")
    expect(marker?.className).toContain("border")
    expect(marker?.className).not.toContain("ring-background")
    expect(icon?.getAttribute("class")).toContain("size-1.5")
    expect(view.textContent).toContain("All actions cached")
    expect(view.textContent).not.toContain("accelerated")
  })

  it.each(["miss", "bypass", "disabled"] as const)(
    "renders NO cache marker for a step whose cache status is %s",
    (cacheStatus) => {
      const view = mount(
        <ul>
          <StepTreeItem
            step={fromRunDetailStep(makeStep({ cacheStatus }), [makeSubAction(0), makeSubAction(1)])}
            isSelected={false}
            isExpanded={false}
            selection={null}
            onSelect={() => {}}
          />
        </ul>,
      )

      expect(view.querySelector('[data-cache-marker="step-status"]')).toBeNull()
      expect(view.textContent).not.toContain("All actions cached")
      expect(view.textContent).not.toContain("accelerated")
    },
  )

  it("renders a status-dot-attached marker for the sub-actions of a cached step", () => {
    const view = mount(
      <ul>
        <SubActionTreeItem
          sub={makeSubAction(0)}
          stepId="0:0"
          cached
          isSelected={false}
          onSelect={() => {}}
        />
      </ul>,
    )

    const marker = view.querySelector('[data-cache-marker="sub-action-status"][data-cache-state="cached"]')

    expect(marker).toBeTruthy()
    expect(view.textContent).toContain("Cached action")
    expect(view.textContent).not.toContain("Cache hit")
  })

  it("keeps run setup, member groups, a member that never ran, and teardown in grouped order", () => {
    const view = mount(
      <StepTree
        groups={[
          group(member(0, { name: "Login" }), [makeStep({ stepText: "First child step" })]),
          group(member(1, { name: "Checkout", outcome: "skipped" }), []),
        ]}
        showMemberChrome
        selection={null}
        onSelect={() => {}}
        setupHooks={[makeHook("suite-setup", "run-1", "Suite setup", "setup")]}
        teardownHooks={[makeHook("suite-teardown", "run-1", "Suite teardown", "teardown")]}
        inlineLogs={[]}
      />,
    )

    const text = view.textContent ?? ""
    expect(text).toContain("Suite setup")
    expect(text).toContain("Login")
    expect(text).toContain("First child step")
    expect(text).toContain("Checkout")
    expect(text).toContain(DID_NOT_RUN_LABEL)
    expect(text).toContain("Suite teardown")
    expect(text.indexOf("Suite setup")).toBeLessThan(text.indexOf("Login"))
    expect(text.indexOf("Login")).toBeLessThan(text.indexOf("Checkout"))
    expect(text.indexOf("Checkout")).toBeLessThan(text.indexOf("Suite teardown"))
  })
})
