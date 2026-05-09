// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="tabs-root" className={className}>
      {children}
    </div>
  ),
  TabsList: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="tabs-list" className={className}>
      {children}
    </div>
  ),
  TabsTrigger: ({ children, value, className }: { children: React.ReactNode; value: string; className?: string }) => (
    <button data-testid={`tabs-trigger-${value}`} className={className}>
      {children}
    </button>
  ),
  TabsContent: ({
    children,
    value,
    className,
  }: {
    children: React.ReactNode
    value: string
    className?: string
  }) => (
    <div data-testid={`tabs-content-${value}`} className={className}>
      {children}
    </div>
  ),
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

vi.mock("@/components/run-detail/tab-overview", () => ({
  TabOverview: () => <div>overview</div>,
}))

vi.mock("@/components/run-detail/tab-env", () => ({
  TabEnv: () => <div>env</div>,
}))

vi.mock("@/components/run-detail/tab-network", () => ({
  TabNetwork: () => <div>network</div>,
}))

vi.mock("@/components/run-detail/tab-console", () => ({
  TabConsole: () => <div>console</div>,
}))

vi.mock("@/components/run-detail/tab-aria-tree", () => ({
  TabAriaTree: () => <div>ARIA tree</div>,
}))

vi.mock("@/components/run-detail/tab-a11y", () => ({
  TabA11y: () => <div>a11y</div>,
}))

import { TabPanels } from "@/components/run-detail/tab-panels"
import { parseSegments } from "@/components/run-detail/step-name-pills"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderPanels() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <TabPanels
        activeTab="aria"
        onTabChange={() => {}}
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
        subAction={null}
        runId="run-1"
        allSteps={[]}
      />,
    )
  })

  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
})

describe("TabPanels", () => {
  it("keeps the ARIA tab path in its own contained scroll shell", async () => {
    const view = await renderPanels()

    const ariaPanel = view.querySelector('[data-testid="tabs-content-aria"]') as HTMLDivElement | null
    const ariaScrollArea = ariaPanel?.querySelector('[data-testid="scroll-area"]') as HTMLDivElement | null
    const ariaShell = ariaPanel?.firstElementChild as HTMLDivElement | null

    expect(ariaPanel?.className).toContain("min-h-0")
    expect(ariaPanel?.className).toContain("overflow-hidden")
    expect(ariaScrollArea).toBeNull()
    expect(ariaShell?.className).toContain("min-h-0")
    expect(ariaShell?.className).toContain("overflow-hidden")
    expect(ariaShell?.textContent).toContain("ARIA tree")
  })

  it("renders secret placeholders as runtime-only markers", () => {
    const segments = parseSegments(
      "Fill password with {{secret:loginPassword}}",
      "Fill password with {{secret:loginPassword}}",
      null,
    )

    expect(segments).toContainEqual(expect.objectContaining({
      type: "pill",
      resolvedValue: "[secret:loginPassword]",
      varName: "loginPassword",
      namespace: "secret",
      templateSyntax: "{{secret:loginPassword}}",
    }))
    expect(JSON.stringify(segments)).not.toContain("raw-secret-sentinel")
  })

  it("keeps the Env tab scoped to variables without a Secrets table", async () => {
    const actual = await vi.importActual<typeof import("@/components/run-detail/tab-env")>("@/components/run-detail/tab-env")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(
        <actual.TabEnv
          step={{
            variableSnapshot: {
              PASSWORD_HINT: { value: "[secret:loginPassword]", source: "env" },
            },
          }}
          executionLogs={[]}
        />,
      )
    })

    expect(container.textContent).toContain("Env")
    expect(container.textContent).toContain("PASSWORD_HINT")
    expect(container.textContent).toContain("[secret:loginPassword]")
    expect(container.textContent).not.toContain("Secrets")
    expect(container.textContent).not.toContain("raw-secret-sentinel")
  })
})
