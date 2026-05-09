// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SharedScopeMemoryReader } from "@/components/memory-reader/shared-scope-memory-reader"

const { fetchMemoryScopeMock } = vi.hoisted(() => ({
  fetchMemoryScopeMock: vi.fn(),
}))

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    fetchMemoryScope: fetchMemoryScopeMock,
  }
})

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode; className?: string }) => (
    <button type="button" onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}))

vi.mock("@/components/ui/popover", async () => {
  const React = await import("react")

  const PopoverContext = React.createContext<{
    open: boolean
    setOpen: (nextOpen: boolean) => void
  } | null>(null)

  function Popover({
    children,
    defaultOpen = false,
    onOpenChange,
    open,
  }: {
    children: React.ReactNode
    defaultOpen?: boolean
    onOpenChange?: (nextOpen: boolean) => void
    open?: boolean
  }) {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
    const resolvedOpen = open ?? internalOpen
    const setOpen = (nextOpen: boolean) => {
      onOpenChange?.(nextOpen)
      if (open === undefined) {
        setInternalOpen(nextOpen)
      }
    }

    return (
      <PopoverContext.Provider value={{ open: resolvedOpen, setOpen }}>
        {children}
      </PopoverContext.Provider>
    )
  }

  function PopoverTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean
    children: React.ReactNode
  }) {
    const ctx = React.useContext(PopoverContext)
    const toggle = () => ctx?.setOpen(!ctx.open)

    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, {
        onClick: (event: React.MouseEvent) => {
          ;(children as any).props.onClick?.(event)
          toggle()
        },
      } as Record<string, unknown>)
    }

    return (
      <button type="button" onClick={toggle}>
        {children}
      </button>
    )
  }

  function PopoverContent({
    children,
  }: {
    children: React.ReactNode
  }) {
    const ctx = React.useContext(PopoverContext)
    if (!ctx?.open) return null
    return <div data-popover-content="true">{children}</div>
  }

  return { Popover, PopoverTrigger, PopoverContent }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("SharedScopeMemoryReader", () => {
  beforeEach(() => {
    fetchMemoryScopeMock.mockReset()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderReader(scope: "suite" | "test" = "test") {
    await act(async () => {
      root.render(
        <SharedScopeMemoryReader
          scope={scope}
          scopeId={scope === "test" ? "t_alpha" : "s_alpha"}
          emptyTitle={scope === "test" ? "No test memory yet" : "No suite memory yet"}
          emptyDescription={`This ${scope} doesn't have cataloged observations in this workspace yet. Run the ${scope} with memory enabled, then reopen this tab.`}
        />,
      )
    })
    await flushRender()
  }

  it("renders a quiet document reader with invalid-file warning, markdown content, metadata popover, and no delete chrome", async () => {
    fetchMemoryScopeMock.mockResolvedValue({
      scope: "test",
      scopeId: "t_alpha",
      observations: [
        {
          id: "obs_alpha",
          title: "Security page: recovery codes are below the fold",
          content: "The recovery code panel is **below the fold**.",
          trust: 0.82,
          created: "2026-04-18T08:00:00.000Z",
          updated: "2026-04-20T09:15:00.000Z",
          last_confirmed: "2026-04-20T08:00:00.000Z",
          confirmed_count: 2,
          contradicted_count: 0,
          source_test: "t_alpha",
          scope: "test",
          scopeId: "t_alpha",
          scopeRef: {
            kind: "test",
            id: "t_alpha",
            label: "Alpha login",
            targetName: "alpha-target",
            href: "/test/t_alpha",
          },
          sourceTestRef: {
            kind: "source_test",
            id: "t_alpha",
            label: "Alpha login",
            targetName: "alpha-target",
            href: "/test/t_alpha",
          },
        },
      ],
      invalidFiles: [
        {
          scope: "test",
          scopeId: "t_alpha",
          filename: "obs_legacy-titleless.md",
          code: "parse_error",
          message: "Invalid observation frontmatter: title is required.",
        },
      ],
    })

    await renderReader("test")

    expect(fetchMemoryScopeMock).toHaveBeenCalledWith("test", "t_alpha")
    expect(container.textContent).toContain("Test memory")
    expect(container.textContent).toContain("Security page: recovery codes are below the fold")
    expect(container.textContent).toContain("The recovery code panel is below the fold.")
    expect(container.textContent).not.toContain("**below the fold**")
    expect(container.textContent).toContain("1 invalid memory file hidden from this reader.")
    expect(container.textContent).toContain("obs_legacy-titleless.md")
    expect(container.textContent).not.toContain("Delete Observation")

    const detailsButton = container.querySelector('button[aria-label="Observation details"]') as HTMLButtonElement | null
    expect(detailsButton).toBeTruthy()

    await act(async () => {
      detailsButton?.click()
      await Promise.resolve()
    })
    await flushRender()

    const popover = container.querySelector('[data-popover-content="true"]')
    expect(popover?.textContent).toContain("Scope reference")
    expect(popover?.textContent).toContain("Source test")
    expect(popover?.textContent).toContain("Updated")
    expect(popover?.textContent).toContain("Last confirmed")
  })

  it("renders the scope-specific empty state when no valid observations exist", async () => {
    fetchMemoryScopeMock.mockResolvedValue({
      scope: "suite",
      scopeId: "s_alpha",
      observations: [],
      invalidFiles: [],
    })

    await renderReader("suite")

    expect(container.textContent).toContain("Suite memory")
    expect(container.textContent).toContain("No suite memory yet")
    expect(container.textContent).toContain("This suite doesn't have cataloged observations in this workspace yet.")
  })

  it("renders a quiet scope-specific error block when the scope read fails", async () => {
    fetchMemoryScopeMock.mockRejectedValue(new Error("boom"))

    await renderReader("test")

    expect(container.textContent).toContain("Couldn't load this test memory.")
    expect(container.textContent).toContain("verify the dashboard server can read the workspace memory directory")
    expect(container.textContent).not.toContain("Delete Observation")
  })
})
