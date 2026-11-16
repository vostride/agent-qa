// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RunDetailMember, RunDetailStep } from "@vostride/agent-qa-schema"

import i18n from "@/i18n"
import { StepTree } from "@/components/run-detail/step-tree"
import type { RunDetailGroup } from "@/lib/run-detail-view"

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

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage("en")
  })
  i18n.removeResourceBundle("fr", "translation")
  act(() => {
    root.unmount()
  })
  container.remove()
})

const member: RunDetailMember = { testIndex: 0, attempts: 1 }

const unnamedStep: RunDetailStep = {
  testIndex: 0,
  stepIndex: 0,
  cacheStatus: "miss",
  verifierVerdict: { pass: true, reasoning: "looks right" },
  selfHealOccurred: false,
  briefDigest: "d00",
  status: "passed",
  durationMs: 1200,
}

const group: RunDetailGroup = {
  member,
  steps: [{ step: unnamedStep, subActions: [] }],
}

describe("a mounted step tree after a language change", () => {
  it("shows an unnamed step's label in the new language in the same row, then English again", async () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<StepTree groups={[group]} selection={null} onSelect={() => {}} />)
    })
    const row = container.querySelector("[data-step-id]")
    expect(row?.textContent).toContain("Untitled step")

    i18n.addResourceBundle("fr", "translation", { "common.untitledStep": "Étape sans titre" })
    await act(async () => {
      await i18n.changeLanguage("fr")
    })
    expect(container.querySelector("[data-step-id]"), "not remounted").toBe(row)
    expect(row?.textContent).toContain("Étape sans titre")
    expect(row?.textContent).not.toContain("Untitled step")

    await act(async () => {
      await i18n.changeLanguage("en")
    })
    expect(row?.textContent).toContain("Untitled step")
  })
})
