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
  restartTour: vi.fn(),
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

vi.mock("@/components/product-tour", () => ({
  useProductTour: () => ({
    restartTour: sidebarMock.restartTour,
  }),
}))

vi.mock("@/lib/api", () => ({
  fetchAppMetadata: sidebarMock.fetchAppMetadata,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    if (asChild && isValidElement<{ "data-dropdown-trigger"?: string }>(children)) {
      return cloneElement(children, { "data-dropdown-trigger": "true" })
    }

    return <button type="button">{children}</button>
  },
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="help-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    asChild,
    onSelect,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    onSelect?: () => void
  } & React.HTMLAttributes<HTMLElement>) => {
    if (asChild && isValidElement<Record<string, unknown>>(children)) {
      return cloneElement(children, props)
    }

    return (
      <button type="button" onClick={() => onSelect?.()} {...props}>
        {children}
      </button>
    )
  },
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
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    tooltip?: string
  } & React.HTMLAttributes<HTMLElement>) => {
    if (asChild && isValidElement<{ "data-tooltip"?: string } & Record<string, unknown>>(children)) {
      return cloneElement(children, { "data-tooltip": tooltip, ...props })
    }

    return (
      <button type="button" data-tooltip={tooltip} {...props}>
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
    sidebarMock.restartTour.mockReset()
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

  function getHelpTrigger() {
    const trigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Help and feedback"),
    ) as HTMLButtonElement | undefined
    if (!trigger) {
      throw new Error("Missing Help and feedback trigger")
    }

    return trigger
  }

  function parseFeedbackParams(href: string) {
    const prefix = "mailto:support@vostride.com?"
    expect(href.startsWith(prefix)).toBe(true)
    return new URLSearchParams(href.slice(prefix.length))
  }

  function expectNoPrivateHelpCopy(surface: string) {
    const forbiddenCopy = [
      "agent-qa.config.yaml",
      "file://",
      "http://localhost",
      "local logs",
      "logs",
      "memory content",
      "test content",
      "credential",
      "credentials",
      "token",
      "secret",
    ]

    for (const forbidden of forbiddenCopy) {
      expect(surface.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
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

  it("renders footer support links with exact outbound targets and grouped help control", async () => {
    await renderSidebar()

    const bugLink = getSupportLink("Report a bug")
    expect(bugLink.href).toBe("https://github.com/vostride/agent-qa/issues/new")
    expect(bugLink.target).toBe("_blank")
    expect(bugLink.rel).toBe("noopener noreferrer")
    expect(bugLink.querySelector('[data-icon="Bug"]')).not.toBeNull()

    const helpTrigger = getHelpTrigger()
    expect(helpTrigger.getAttribute("data-tour-id")).toBe("tour-help-menu")
    expect(helpTrigger.getAttribute("data-dropdown-trigger")).toBe("true")
    expect(helpTrigger.querySelector('[data-icon="LifeBuoy"]')).not.toBeNull()

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

    for (const label of ["Report a bug", "View on GitHub"]) {
      const link = getSupportLink(label)
      expect(link.getAttribute("aria-label")).toBe(label)
      expect(link.getAttribute("data-tooltip")).toBe(label)
    }

    const helpTrigger = getHelpTrigger()
    expect(helpTrigger.getAttribute("data-tooltip")).toBe("Help and feedback")
    expect(helpTrigger.getAttribute("data-tour-id")).toBe("tour-help-menu")
  })

  it("restarts the product tour from the help group", async () => {
    await renderSidebar()

    const tourButton = container.querySelector<HTMLButtonElement>(
      '[data-tour-id="tour-help-product-tour"]',
    )
    expect(tourButton).not.toBeNull()
    expect(tourButton?.textContent).toContain("Take product tour")

    act(() => {
      tourButton?.click()
    })

    expect(sidebarMock.restartTour).toHaveBeenCalledTimes(1)
  })

  it("keeps grouped help and tour launch copy free of local/private details", async () => {
    await renderSidebar()

    const helpSurface = [
      getHelpTrigger().textContent ?? "",
      container.querySelector('[data-tour-id="tour-help-product-tour"]')?.textContent ?? "",
      getSupportLink("Send feedback").textContent ?? "",
      getSupportLink("Send feedback").getAttribute("href") ?? "",
    ].join(" ")

    expect(helpSurface).toContain("Take product tour")
    expect(helpSurface).toContain("Send feedback")
    expectNoPrivateHelpCopy(helpSurface)
  })

  it("adds approved product tour anchors to primary nav items only", async () => {
    await renderSidebar()

    const expectedAnchors = [
      { href: "/runs", title: "Runs", tourId: "tour-nav-runs" },
      { href: "/tests", title: "Tests", tourId: "tour-nav-tests" },
      { href: "/hooks", title: "Hooks", tourId: "tour-nav-hooks" },
      { href: "/suites", title: "Suites", tourId: "tour-nav-suites" },
      { href: "/memory", title: "Memory", tourId: "tour-nav-memory" },
      { href: "/config", title: "Config", tourId: "tour-nav-config" },
    ]

    for (const { href, title, tourId } of expectedAnchors) {
      const navLink = Array.from(container.querySelectorAll(`a[href="${href}"]`)).find((link) =>
        link.textContent?.includes(title),
      )
      expect(navLink?.getAttribute("data-tour-id")).toBe(tourId)
    }

    expect(container.querySelector('a[href="/insights"]')?.getAttribute("data-tour-id")).toBeNull()
  })

  it("uses a safe grouped feedback mailto body", async () => {
    await renderSidebar()

    const feedbackLink = getSupportLink("Send feedback")
    const params = parseFeedbackParams(feedbackLink.getAttribute("href") ?? "")

    expect(params.get("subject")).toBe("agent-qa feedback")
    expect(params.get("body")).toContain("Please describe what happened:")
    expect(params.get("body")).toContain("agent-qa debug info")
    expect(params.get("body")).toContain("version: 0.1.18")
    expect(params.get("body")).toContain("surface: dashboard")
    expect(params.get("body")).not.toContain("token")
    expect(params.get("body")).not.toContain("key")
    expect(params.get("body")).not.toContain("secret")
    expect(params.get("body")).not.toContain("credentials")
    expect(params.get("body")).not.toContain("local config")
    expect(params.get("body")).not.toContain("logs")
    expect(params.get("body")).not.toContain("test content")
    expect(params.get("body")).not.toContain("memory")
    expect(params.get("body")).not.toContain("URL")
    expect(params.get("body")).not.toContain("workspace")
  })

  it("keeps feedback usable when app metadata fails", async () => {
    sidebarMock.fetchAppMetadata.mockRejectedValueOnce(new Error("metadata unavailable"))

    await renderSidebar()

    const feedbackLink = getSupportLink("Send feedback")
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
