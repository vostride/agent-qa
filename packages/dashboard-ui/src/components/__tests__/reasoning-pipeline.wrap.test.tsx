// @vitest-environment jsdom

import { act, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ReasoningPipeline, type SectionDef } from "@/components/reasoning-pipeline"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button type="button" className={className}>{children}</button>
  ),
  CollapsibleContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}))

vi.mock("@/components/confidence-badge", () => ({
  ConfidenceBadge: () => <span />,
}))

vi.mock("@/components/healing-chain", () => ({
  HealingChain: () => <span />,
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

function Icon({ className }: { className?: string }) {
  return <span className={className} />
}

describe("ReasoningPipeline wrapping contract", () => {
  it("renders prose with line-preserving wrapping and aggressive token breaking", () => {
    const longToken = "x".repeat(180)
    const sections: SectionDef[] = [
      {
        key: "reasoning",
        label: "Reasoning",
        icon: Icon,
        content: `first line\nsecond line ${longToken}`,
        duration: null,
      },
    ]

    const view = mount(<ReasoningPipeline mode="static" sections={sections} />)
    const prose = view.querySelector('[data-reasoning-prose="true"]') as HTMLElement | null

    expect(prose).toBeTruthy()
    expect(prose?.className).toContain("whitespace-pre-wrap")
    expect(prose?.className).toContain("break-words")
    expect(prose?.className).toContain("[overflow-wrap:anywhere]")
    expect(prose?.textContent).toContain("first line\nsecond line")
    expect(prose?.closest(".overflow-x-auto")).toBeNull()
  })

  it("keeps code-like children locally contained", () => {
    const sections: SectionDef[] = [
      {
        key: "plannedAction",
        label: "Planned Action",
        icon: Icon,
        content: null,
        duration: null,
        children: (
          <pre data-testid="planned-action-code" className="max-w-full min-w-0 overflow-x-auto">
            {"{\"type\":\"click\"}"}
          </pre>
        ),
      },
    ]

    const view = mount(<ReasoningPipeline mode="static" sections={sections} />)
    const code = view.querySelector('[data-testid="planned-action-code"]') as HTMLElement | null

    expect(code).toBeTruthy()
    expect(code?.className).toContain("max-w-full")
    expect(code?.className).toContain("min-w-0")
  })
})
