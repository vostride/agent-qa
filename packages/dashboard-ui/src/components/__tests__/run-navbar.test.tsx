// @vitest-environment jsdom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunNavbar } from "@/components/run-detail/run-navbar"
import { triggerRun } from "@/lib/api"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("@/lib/api", () => ({
  triggerRun: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock("@/components/id-badge", () => ({
  IdBadge: () => <div data-testid="id-badge">id-badge</div>,
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}))

vi.mock("@/components/ui/popover", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  let latestOpen = false
  let latestOnOpenChange: ((open: boolean) => void) | undefined

  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactElement
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      latestOpen = Boolean(open)
      latestOnOpenChange = onOpenChange
      return <>{children}</>
    },
    PopoverTrigger: ({ children }: { children: ReactElement }) => {
      if (!React.isValidElement(children)) return children
      const existingOnClick = (children.props as { onClick?: (event: unknown) => void }).onClick
      return React.cloneElement(children, {
        onClick: (event: unknown) => {
          existingOnClick?.(event)
          latestOnOpenChange?.(!latestOpen)
        },
      } as Record<string, unknown>)
    },
    PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  }
})

let container: HTMLDivElement
let root: Root

function mount(el: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MemoryRouter>{el}</MemoryRouter>)
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

const baseRun = {
  id: "r_run-id",
  name: "Login run",
  filePath: "tests/login.yaml",
  status: "passed",
  duration: 1200,
  attributes: {
    "agent-qa.trigger": "cli",
    "agent-qa.runner": "local",
  },
  environment: null,
  metadata: null,
  startedAt: "2026-04-18T00:00:00.000Z",
  endedAt: "2026-04-18T00:00:01.200Z",
  videoPath: null,
  failureSummary: null,
  errorLog: null,
  memoryLog: null,
  testId: null,
  suiteId: null,
  platform: "web",
  testFileContent: null,
  modelName: null,
  llmProvider: null,
  parentRunId: null,
  attemptNumber: 1,
  retryCount: 0,
  maxRetries: 0,
  createdAt: "2026-04-18T00:00:00.000Z",
}

describe("RunNavbar", () => {
  it("links test runs to the canonical test page in a new tab without showing ids", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, testId: "t_login", name: "Test run" }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const link = container.querySelector('a[aria-label="Open test"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/test/t_login")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.querySelector('[data-testid="id-badge"]')).toBeNull()
    expect(container.textContent).not.toContain("t_login")
  })

  it("links suite runs to the canonical suite page in a new tab", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, suiteId: "s_smoke", name: "Suite run" }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const link = container.querySelector('a[aria-label="Open suite"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/suite/s_smoke")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(container.textContent).not.toContain("s_smoke")
  })

  it("omits the source arrow when no test or suite id is available", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Detached run" }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.querySelector('a[aria-label="Open test"]')).toBeNull()
    expect(container.querySelector('a[aria-label="Open suite"]')).toBeNull()
  })

  it("documents the screenshot Before and After shortcuts", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Screenshot run" }}
        steps={[]}
        shortcutsOpen={true}
        onToggleShortcuts={() => {}}
      />,
    )

    expect(container.textContent).toContain("Screenshots")
    expect(container.textContent).toContain("Before screenshot")
    expect(container.textContent).toContain("After screenshot")
    expect(container.textContent).toContain("Details: Attributes")
    expect(container.textContent).toContain("Artifacts: Config")
    expect(container.textContent).toContain("Artifacts: Memory")
    expect(container.textContent).toContain("Shift+?")
  })

  it("links recording action to the canonical run video path", () => {
    mount(
      <RunNavbar
        run={{ ...baseRun, videoPath: "r_run-id/recording.webm" }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const link = container.querySelector('a[aria-label="Open recording"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("/api/videos/r_run-id/recording.webm")
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("opens run details on the Attributes tab from the navbar action", () => {
    const onOpenArtifacts = vi.fn()
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Artifact run" }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
        onOpenArtifacts={onOpenArtifacts}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Open run artifacts"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute("title")).toBe("Run details (I/C/M)")

    act(() => {
      trigger!.click()
    })

    expect(onOpenArtifacts).toHaveBeenCalledTimes(1)
    expect(onOpenArtifacts).toHaveBeenCalledWith("attributes")
  })

  it("toggles the shortcut popover once when closing from the trigger", () => {
    const onToggleShortcuts = vi.fn()
    mount(
      <RunNavbar
        run={{ ...baseRun, name: "Screenshot run" }}
        steps={[]}
        shortcutsOpen={true}
        onToggleShortcuts={onToggleShortcuts}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Keyboard shortcuts"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()

    act(() => {
      trigger!.click()
    })

    expect(onToggleShortcuts).toHaveBeenCalledTimes(1)
  })

  it("reruns suite parents with the stored suite file path", async () => {
    const triggerRunMock = vi.mocked(triggerRun)
    triggerRunMock.mockResolvedValue({ runId: "run_rerun", status: "queued" })

    mount(
      <RunNavbar
        run={{
          ...baseRun,
          name: "Sample Basic suite",
          filePath: "suites/sample-basic.suite.yaml",
          suiteId: "s_sample_basic",
          parentRunId: null,
        }}
        steps={[]}
        shortcutsOpen={false}
        onToggleShortcuts={() => {}}
      />,
    )

    const trigger = container.querySelector('button[aria-label="Re-run"]') as HTMLButtonElement | null
    expect(trigger).not.toBeNull()

    await act(async () => {
      trigger!.click()
      await Promise.resolve()
    })

    expect(triggerRunMock).toHaveBeenCalledWith({
      file: "suites/sample-basic.suite.yaml",
      local: true,
    })
  })
})
