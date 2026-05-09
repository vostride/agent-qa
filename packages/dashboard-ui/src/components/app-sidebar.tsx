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
} from "lucide-react"
import { VostrideLogo } from "@/components/icons/vostride-logo"
import { routes } from "@/lib/routes"

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
