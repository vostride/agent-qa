// @vitest-environment jsdom

import { act, cloneElement, isValidElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sidebarMock = vi.hoisted(() => ({
  state: "expanded" as "expanded" | "collapsed",
  toggleSidebar: vi.fn(),
  fetchAppMetadata: vi.fn(),
}))

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
  Bug: icon("Bug"),
  LifeBuoy: icon("LifeBuoy"),
}))

vi.mock("react-icons/fa", () => ({
  FaGithub: icon("Github"),
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

vi.mock("@/lib/api", () => ({
  fetchAppMetadata: sidebarMock.fetchAppMetadata,
}))

vi.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarSeparator: ({
    className,
    style,
  }: {
    className?: string
    style?: React.CSSProperties
  }) => <hr data-testid="sidebar-separator" className={className} style={style} />,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    asChild,
    tooltip,
  }: {
    children: React.ReactNode
    asChild?: boolean
    tooltip?: string
  }) => {
    if (asChild && isValidElement<{ "data-tooltip"?: string }>(children)) {
      return cloneElement(children, { "data-tooltip": tooltip })
    }

    return (
      <button type="button" data-tooltip={tooltip}>
        {children}
      </button>
    )
  },
  SidebarRail: () => null,
  useSidebar: () => ({
    state: sidebarMock.state,
    toggleSidebar: sidebarMock.toggleSidebar,
  }),
}))

import { AppSidebar } from "@/components/app-sidebar"

describe("AppSidebar", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    sidebarMock.state = "expanded"
    sidebarMock.toggleSidebar.mockReset()
    sidebarMock.fetchAppMetadata.mockReset()
    sidebarMock.fetchAppMetadata.mockResolvedValue({ version: "0.1.18" })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function renderSidebar(path = "/runs") {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function getSupportLink(label: string) {
    const link = container.querySelector(`a[aria-label="${label}"]`) as HTMLAnchorElement | null
    if (!link) {
      throw new Error(`Missing support link: ${label}`)
    }

    return link
  }

  function parseFeedbackParams(href: string) {
    const prefix = "mailto:support@vostride.com?"
    expect(href.startsWith(prefix)).toBe(true)
    return new URLSearchParams(href.slice(prefix.length))
  }

  it("renders the Hooks nav item with the Webhook icon", async () => {
    await renderSidebar("/hooks")

    const hooksLink = container.querySelector('a[href="/hooks"]')
    expect(hooksLink).not.toBeNull()
    expect(hooksLink?.querySelector('[data-icon="Webhook"]')).not.toBeNull()
    expect(hooksLink?.querySelector('[data-icon="Wrench"]')).toBeNull()
  })

  it("renders the Memory nav item with the BrainCircuit icon", async () => {
    await renderSidebar("/memory")

    const memoryLink = container.querySelector('a[href="/memory"]')
    expect(memoryLink).not.toBeNull()
    expect(memoryLink?.textContent).toContain("Memory")
    expect(memoryLink?.querySelector('[data-icon="BrainCircuit"]')).not.toBeNull()
  })

  it("renders footer support links with exact outbound targets", async () => {
    await renderSidebar()

    const bugLink = getSupportLink("Report a bug")
    expect(bugLink.href).toBe("https://github.com/vostride/agent-qa/issues/new")
    expect(bugLink.target).toBe("_blank")
    expect(bugLink.rel).toBe("noopener noreferrer")
    expect(bugLink.querySelector('[data-icon="Bug"]')).not.toBeNull()

    const feedbackLink = getSupportLink("Help and feedback")
    expect(feedbackLink.target).toBe("")
    expect(feedbackLink.rel).toBe("")
    expect(feedbackLink.querySelector('[data-icon="LifeBuoy"]')).not.toBeNull()

    const githubLink = getSupportLink("View on GitHub")
    expect(githubLink.href).toBe("https://github.com/vostride/agent-qa")
    expect(githubLink.target).toBe("_blank")
    expect(githubLink.rel).toBe("noopener noreferrer")
    expect(githubLink.querySelector('[data-icon="Github"]')).not.toBeNull()

    expect(container.querySelector('[data-testid="sidebar-separator"]')?.className).toContain("-mx-2")
    expect(container.querySelector<HTMLHRElement>('[data-testid="sidebar-separator"]')?.style.width).toBe("calc(100% + 1rem)")
  })

  it("keeps collapsed support actions accessible", async () => {
    sidebarMock.state = "collapsed"

    await renderSidebar()

    for (const label of ["Report a bug", "Help and feedback", "View on GitHub"]) {
      const link = getSupportLink(label)
      expect(link.getAttribute("aria-label")).toBe(label)
      expect(link.getAttribute("data-tooltip")).toBe(label)
    }
  })

  it("uses a safe feedback mailto body", async () => {
    await renderSidebar()

    const feedbackLink = getSupportLink("Help and feedback")
    const params = parseFeedbackParams(feedbackLink.getAttribute("href") ?? "")

    expect(params.get("subject")).toBe("agent-qa feedback")
    expect(params.get("body")).toContain("Please describe what happened:")
    expect(params.get("body")).toContain("agent-qa debug info")
    expect(params.get("body")).toContain("version: 0.1.18")
    expect(params.get("body")).toContain("surface: dashboard")
    expect(params.get("body")).not.toContain("token")
    expect(params.get("body")).not.toContain("key")
    expect(params.get("body")).not.toContain("workspace")
  })

  it("keeps feedback usable when app metadata fails", async () => {
    sidebarMock.fetchAppMetadata.mockRejectedValueOnce(new Error("metadata unavailable"))

    await renderSidebar()

    const feedbackLink = getSupportLink("Help and feedback")
    const params = parseFeedbackParams(feedbackLink.getAttribute("href") ?? "")
    expect(params.get("body")).toContain("version: unavailable")
  })

  it("does not render an explicit GitHub star action", async () => {
    await renderSidebar()

    const publicSurface = [
      container.textContent ?? "",
      ...Array.from(container.querySelectorAll("a")).map((link) =>
        [
          link.getAttribute("aria-label"),
          link.getAttribute("data-tooltip"),
          link.getAttribute("href"),
        ].join(" "),
      ),
    ].join(" ")

    expect(publicSurface).not.toMatch(/star/i)
    expect(container.querySelector('a[aria-label="Star us on GitHub"]')).toBeNull()
  })
})
