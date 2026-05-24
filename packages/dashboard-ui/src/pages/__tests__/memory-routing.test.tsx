// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}))

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarSeparator: () => <hr />,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    asChild,
    isActive,
  }: {
    children: React.ReactNode
    asChild?: boolean
    isActive?: boolean
  }) => <div data-active={isActive} data-as-child={asChild}>{children}</div>,
  SidebarRail: () => null,
  useSidebar: () => ({ state: "expanded", toggleSidebar: vi.fn() }),
}))

vi.mock("@/components/icons/vostride-logo", () => ({
  VostrideLogo: () => <div data-testid="logo" />,
}))

vi.mock("@/components/command-palette", () => ({ CommandPalette: () => null }))
vi.mock("@/components/product-tour", () => ({
  ProductTourProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ProductTourOverlay: () => null,
  useProductTour: () => ({ restartTour: vi.fn() }),
}))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))
vi.mock("@/components/error-boundary", () => ({ RouteErrorBoundary: () => <div>Route Error</div> }))
vi.mock("@/components/page-skeleton", () => ({
  TableSkeleton: () => <div />,
  DetailSkeleton: () => <div />,
  ChartSkeleton: () => <div />,
  FormSkeleton: () => <div />,
  EditorSkeleton: () => <div />,
}))

vi.mock("@/pages/runs", () => ({ default: () => <div>Runs Page</div> }))
vi.mock("@/pages/run-detail", () => ({ default: () => <div>Run Detail Page</div> }))
vi.mock("@/pages/live-run", () => ({ default: () => <div>Live Run Page</div> }))
vi.mock("@/pages/tests", () => ({ default: () => <div>Tests Page</div> }))
vi.mock("@/pages/hooks", () => ({ default: () => <div>Hooks Page</div> }))
vi.mock("@/pages/hook-editor", () => ({ default: () => <div>Hook Editor Page</div> }))
vi.mock("@/pages/hook-viewer", () => ({ default: () => <div>Hook Viewer Page</div> }))
vi.mock("@/pages/test-editor", () => ({ default: () => <div>Test Editor Page</div> }))
vi.mock("@/pages/test-viewer", () => ({ default: () => <div>Test Viewer Page</div> }))
vi.mock("@/pages/insights", () => ({ default: () => <div>Insights Page</div> }))
vi.mock("@/pages/config", () => ({ default: () => <div>Config Page</div> }))
vi.mock("@/pages/suites", () => ({ default: () => <div>Suites Page</div> }))
vi.mock("@/pages/suite-editor", () => ({ default: () => <div>Suite Editor Page</div> }))
vi.mock("@/pages/suite-viewer", () => ({ default: () => <div>Suite Viewer Page</div> }))
vi.mock("@/pages/memory", () => ({ default: () => <div data-testid="memory-route">Memory Route</div> }))
vi.mock("@/pages/memory-product", () => ({ default: () => <div data-testid="memory-product-route">Memory Product Route</div> }))

import { AppSidebar } from "@/components/app-sidebar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("memory routing", () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderSidebar(url: string) {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })
  }

  async function renderAppAt(url: string) {
    window.history.replaceState({}, "", url)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    vi.resetModules()
    const { default: App } = await import("@/app")

    await act(async () => {
      root.render(<App />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it("shows Memory as a top-level sidebar destination between Suites and Insights", async () => {
    await renderSidebar("/memory")

    const labels = Array.from(container.querySelectorAll("a, span"))
      .map((node) => node.textContent?.trim())
      .filter((value): value is string => Boolean(value))

    const suitesIndex = labels.indexOf("Suites")
    const memoryIndex = labels.indexOf("Memory")
    const insightsIndex = labels.indexOf("Insights")

    expect(memoryIndex).toBeGreaterThan(suitesIndex)
    expect(memoryIndex).toBeLessThan(insightsIndex)
    expect(container.textContent).toContain("Memory")
  })

  it("mounts the canonical /memory route in the main app router", async () => {
    await renderAppAt("/memory")
    expect(container.querySelector('[data-testid="memory-route"]')).not.toBeNull()
  })

  it("mounts the canonical /memory/:product route in the main app router", async () => {
    await renderAppAt("/memory/alpha-product")
    expect(container.querySelector('[data-testid="memory-product-route"]')).not.toBeNull()
  })
})
