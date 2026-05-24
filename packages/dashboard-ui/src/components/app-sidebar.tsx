import { useEffect, useState } from "react"
import { useLocation, Link } from "react-router"
import {
  Play,
  FileText,
  Webhook,
  FolderOpen,
  BrainCircuit,
  BarChart3,
  SlidersHorizontal,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  Bug,
  LifeBuoy,
} from "lucide-react"
import { FaGithub } from "react-icons/fa"
import { VostrideLogo } from "@/components/icons/vostride-logo"
import { routes } from "@/lib/routes"
import { fetchAppMetadata } from "@/lib/api"
import {
  buildFeedbackMailto,
  GITHUB_ISSUE_URL,
  GITHUB_REPOSITORY_URL,
} from "@/lib/support-links"
import { useProductTour } from "@/components/product-tour"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"

const navItems = [
  { title: "Runs", url: routes.runs, icon: Play, tourId: "tour-nav-runs" },
  { title: "Tests", url: routes.tests, icon: FileText, tourId: "tour-nav-tests" },
  { title: "Hooks", url: routes.hooks, icon: Webhook, tourId: "tour-nav-hooks" },
  { title: "Suites", url: routes.suites, icon: FolderOpen, tourId: "tour-nav-suites" },
  { title: "Memory", url: routes.memory, icon: BrainCircuit, tourId: "tour-nav-memory" },
  { title: "Insights", url: routes.insights, icon: BarChart3 },
  { title: "Config", url: routes.config, icon: SlidersHorizontal, tourId: "tour-nav-config" },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const { theme, setTheme } = useTheme()
  const { state, toggleSidebar } = useSidebar()
  const { restartTour } = useProductTour()
  const [agentQaVersion, setAgentQaVersion] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    fetchAppMetadata()
      .then((metadata) => {
        if (!isMounted) return

        const version = metadata.version?.trim()
        setAgentQaVersion(version || null)
      })
      .catch(() => {
        if (isMounted) {
          setAgentQaVersion(null)
        }
      })

    return () => {
      isMounted = false
    }
  }, [])

  const feedbackHref = buildFeedbackMailto(agentQaVersion)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="h-auto py-3">
              <Link to={routes.runs} className="group-data-[collapsible=icon]:justify-center">
                <VostrideLogo className="size-7! shrink-0 text-turquoise-600 dark:text-turquoise-500 group-data-[collapsible=icon]:size-6!" />
                <span className="text-[1.0625rem] font-mono font-semibold group-data-[collapsible=icon]:hidden">agent-qa</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu>
            {navItems.map((item) => {
              const isActive =
                pathname === item.url ||
                pathname.startsWith(item.url + "/")
              return (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.title}
                  >
                    <Link to={item.url} data-tour-id={item.tourId}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Report a bug">
              <a
                href={GITHUB_ISSUE_URL}
                aria-label="Report a bug"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="size-4" />
                <span>Report a bug</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip="Help and feedback" data-tour-id="tour-help-menu">
                  <LifeBuoy className="size-4" />
                  <span>Help and feedback</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-52">
                <DropdownMenuItem
                  data-tour-id="tour-help-product-tour"
                  onSelect={() => restartTour()}
                >
                  <Play className="size-4" />
                  <span>Take product tour</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={feedbackHref} aria-label="Send feedback">
                    <LifeBuoy className="size-4" />
                    <span>Send feedback</span>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="View on GitHub">
              <a
                href={GITHUB_REPOSITORY_URL}
                aria-label="View on GitHub"
                target="_blank"
                rel="noopener noreferrer"
              >
                <FaGithub className="size-4" />
                <span>View on GitHub</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator className="-mx-2" style={{ width: "calc(100% + 1rem)" }} />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              tooltip="Toggle theme"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              tooltip={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
            >
              {state === "expanded"
                ? <ChevronLeft className="size-4" />
                : <ChevronRight className="size-4" />}
              <span>Collapse</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
