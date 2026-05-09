// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

const navigateSpy = vi.fn()
const { fetchHookCatalogMock } = vi.hoisted(() => ({
  fetchHookCatalogMock: vi.fn(),
}))

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router")
  return { ...actual, useNavigate: () => navigateSpy }
})

vi.mock("@/lib/api", () => ({
  fetchHookCatalog: fetchHookCatalogMock,
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock("@/components/page-skeleton", () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}))
vi.mock("@/components/shortcut-hints", () => ({
  ShortcutLegend: () => <div />,
}))

import HooksPage from "@/pages/hooks"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("hooks list navigation", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    navigateSpy.mockReset()
    vi.mocked(useKeyboardShortcuts).mockClear()
    fetchHookCatalogMock.mockReset()
    fetchHookCatalogMock.mockResolvedValue({
      hooks: [
        {
          id: "h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle",
          name: "login",
          runtime: "node",
          file: "./scripts/login.js",
          timeout: 30000,
          network: true,
          fileMissing: false,
        },
        {
          id: "h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper",
          name: "cleanup",
          runtime: "bash",
          file: "./scripts/cleanup.sh",
          timeout: 15000,
          network: false,
          fileMissing: true,
        },
      ],
      filePath: "./hooks.yaml",
      errors: [],
      missing: false,
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderPage() {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/hooks"]}>
          <HooksPage />
        </MemoryRouter>,
      )
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  function latestShortcuts() {
    return vi.mocked(useKeyboardShortcuts).mock.calls.at(-1)?.[0] as Record<string, (event?: KeyboardEvent) => void>
  }

  it("navigates to /hook/:id when a row is clicked", async () => {
    await renderPage()

    const row = Array.from(container.querySelectorAll("tr")).find((candidate) =>
      candidate.textContent?.includes("login"),
    )
    expect(row).toBeTruthy()

    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(navigateSpy).toHaveBeenCalledWith("/hook/h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle")
  })

  it("ArrowUp and ArrowDown move the active row with tests/suites-style focus classes", async () => {
    await renderPage()

    act(() => {
      latestShortcuts().arrowdown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    })

    let rows = Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true")
    expect(rows[0]?.tabIndex).toBe(0)
    expect(rows[0]?.className).toContain("bg-primary/10")
    expect(rows[0]?.className).toContain("ring-primary/60")

    act(() => {
      latestShortcuts().arrowdown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    })

    rows = Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false")
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true")
    expect(rows[1]?.tabIndex).toBe(0)
    expect(rows[1]?.className).toContain("bg-primary/10")

    act(() => {
      latestShortcuts().arrowup(new KeyboardEvent("keydown", { key: "ArrowUp" }))
    })

    rows = Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true")
  })

  it("Enter shortcut navigates to /hook/:id for the selected row", async () => {
    await renderPage()

    act(() => {
      latestShortcuts().arrowdown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    })
    act(() => {
      latestShortcuts().enter(new KeyboardEvent("keydown", { key: "Enter" }))
    })

    expect(navigateSpy).toHaveBeenCalledWith("/hook/h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle")
  })

  it("Cmd+Enter opens /hook/:id in a new tab for the selected row", async () => {
    await renderPage()

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)

    act(() => {
      latestShortcuts().arrowdown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    })
    act(() => {
      latestShortcuts().enter(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))
    })

    expect(openSpy).toHaveBeenCalledWith("/hook/h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle", "_blank")
    openSpy.mockRestore()
  })

  it("navigates to /hooks/new from the primary CTA", async () => {
    await renderPage()

    const createButton = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Create Hook"),
    )
    expect(createButton).toBeTruthy()

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(navigateSpy).toHaveBeenCalledWith("/hooks/new")
  })
})
