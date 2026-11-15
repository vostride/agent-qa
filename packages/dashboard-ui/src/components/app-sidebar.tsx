import { useEffect, useState } from "react"
import { useLocation, Link } from "react-router"
import {
  Play,
  FileText,
  Webhook,
  FolderOpen,
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
import { useTranslation } from "@/i18n"

type PageTitleKey =
  | "nav.runs"
  | "nav.tests"
  | "nav.hooks"
  | "nav.suites"
  | "nav.insights"
  | "nav.config"

const navItems: { titleKey: PageTitleKey; url: string; icon: typeof Play; tourId?: string }[] = [
  { titleKey: "nav.runs", url: routes.runs, icon: Play, tourId: "tour-nav-runs" },
  { titleKey: "nav.tests", url: routes.tests, icon: FileText, tourId: "tour-nav-tests" },
  { titleKey: "nav.hooks", url: routes.hooks, icon: Webhook, tourId: "tour-nav-hooks" },
  { titleKey: "nav.suites", url: routes.suites, icon: FolderOpen, tourId: "tour-nav-suites" },
  { titleKey: "nav.insights", url: routes.insights, icon: BarChart3 },
  { titleKey: "nav.config", url: routes.config, icon: SlidersHorizontal, tourId: "tour-nav-config" },
]

export function AppSidebar() {
  const { t } = useTranslation()
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
          <SidebarGroupLabel>{t("nav.navigation")}</SidebarGroupLabel>
          <SidebarMenu>
            {navItems.map((item) => {
              const isActive =
                pathname === item.url ||
                pathname.startsWith(item.url + "/")
              const title = t(item.titleKey)
              return (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={title}
                  >
                    <Link to={item.url} data-tour-id={item.tourId}>
                      <item.icon />
                      <span>{title}</span>
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
            <SidebarMenuButton asChild tooltip={t("nav.reportBug")}>
              <a
                href={GITHUB_ISSUE_URL}
                aria-label={t("nav.reportBug")}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="size-4" />
                <span>{t("nav.reportBug")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={t("nav.helpAndFeedback")} data-tour-id="tour-help-menu">
                  <LifeBuoy className="size-4" />
                  <span>{t("nav.helpAndFeedback")}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-52">
                <DropdownMenuItem
                  data-tour-id="tour-help-product-tour"
                  onSelect={() => restartTour()}
                >
                  <Play className="size-4" />
                  <span>{t("nav.takeProductTour")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={feedbackHref} aria-label={t("nav.sendFeedback")}>
                    <LifeBuoy className="size-4" />
                    <span>{t("nav.sendFeedback")}</span>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("nav.viewOnGithub")}>
              <a
                href={GITHUB_REPOSITORY_URL}
                aria-label={t("nav.viewOnGithub")}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FaGithub className="size-4" />
                <span>{t("nav.viewOnGithub")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator className="-mx-2" style={{ width: "calc(100% + 1rem)" }} />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              tooltip={t("nav.toggleTheme")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span>{theme === "dark" ? t("nav.lightMode") : t("nav.darkMode")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              tooltip={state === "expanded" ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
            >
              {state === "expanded"
                ? <ChevronLeft className="size-4" />
                : <ChevronRight className="size-4" />}
              <span>{t("nav.collapse")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
