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
import { useTheme } from "@/components/theme-provider"

const navItems = [
  { title: "Runs", url: routes.runs, icon: Play },
  { title: "Tests", url: routes.tests, icon: FileText },
  { title: "Hooks", url: routes.hooks, icon: Webhook },
  { title: "Suites", url: routes.suites, icon: FolderOpen },
  { title: "Memory", url: routes.memory, icon: BrainCircuit },
  { title: "Insights", url: routes.insights, icon: BarChart3 },
  { title: "Config", url: routes.config, icon: SlidersHorizontal },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const { theme, setTheme } = useTheme()
  const { state, toggleSidebar } = useSidebar()
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

  const supportItems = [
    {
      title: "Report a bug",
      href: GITHUB_ISSUE_URL,
      icon: Bug,
      external: true,
    },
    {
      title: "Help and feedback",
      href: buildFeedbackMailto(agentQaVersion),
      icon: LifeBuoy,
      external: false,
    },
    {
      title: "View on GitHub",
      href: GITHUB_REPOSITORY_URL,
      icon: FaGithub,
      external: true,
    },
  ]

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
                    <Link to={item.url}>
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
          {supportItems.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild tooltip={item.title}>
                <a
                  href={item.href}
                  aria-label={item.title}
                  target={item.external ? "_blank" : undefined}
                  rel={item.external ? "noopener noreferrer" : undefined}
                >
                  <item.icon className="size-4" />
                  <span>{item.title}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
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
