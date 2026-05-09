// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function icon(name: string) {
  return ({ className }: { className?: string }) => <svg data-icon={name} className={className} />
}

vi.mock("lucide-react", () => ({
  Play: icon("Play"),
  FileText: icon("FileText"),
  Webhook: icon("Webhook"),
  Wrench: icon("Wrench"),
  FolderOpen: icon("FolderOpen"),
  BrainCircuit: icon("BrainCircuit"),
  BarChart3: icon("BarChart3"),
  SlidersHorizontal: icon("SlidersHorizontal"),
  Sun: icon("Sun"),
  Moon: icon("Moon"),
  ChevronLeft: icon("ChevronLeft"),
  ChevronRight: icon("ChevronRight"),
}))

vi.mock("@/components/icons/vostride-logo", () => ({
  VostrideLogo: ({ className }: { className?: string }) => <div data-testid="logo" className={className} />,
}))

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    theme: "light",
    setTheme: vi.fn(),
  }),
}))

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => (asChild ? children : <button type="button">{children}</button>),
  SidebarRail: () => null,
  useSidebar: () => ({
    state: "expanded",
    toggleSidebar: vi.fn(),
  }),
}))

import { AppSidebar } from "@/components/app-sidebar"

describe("AppSidebar", () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("renders the Hooks nav item with the Webhook icon", () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/hooks"]}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })

    const hooksLink = container.querySelector('a[href="/hooks"]')
    expect(hooksLink).not.toBeNull()
    expect(hooksLink?.querySelector('[data-icon="Webhook"]')).not.toBeNull()
    expect(hooksLink?.querySelector('[data-icon="Wrench"]')).toBeNull()
  })

  it("renders the Memory nav item with the BrainCircuit icon", () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/memory"]}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })

    const memoryLink = container.querySelector('a[href="/memory"]')
    expect(memoryLink).not.toBeNull()
    expect(memoryLink?.textContent).toContain("Memory")
    expect(memoryLink?.querySelector('[data-icon="BrainCircuit"]')).not.toBeNull()
  })
})
