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
  Languages,
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
import { getLocale, setLocale, t, type Locale } from "@/lib/i18n"

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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"

// Module-level t() is safe here: switching locale calls setLocale + a full
// window.location.reload(), so there is no module reactivity dependency.
const navItems = [
  { title: t("Runs"), url: routes.runs, icon: Play, tourId: "tour-nav-runs" },
  { title: t("Tests"), url: routes.tests, icon: FileText, tourId: "tour-nav-tests" },
  { title: t("Hooks"), url: routes.hooks, icon: Webhook, tourId: "tour-nav-hooks" },
  { title: t("Suites"), url: routes.suites, icon: FolderOpen, tourId: "tour-nav-suites" },
  { title: t("Insights"), url: routes.insights, icon: BarChart3 },
  { title: t("Config"), url: routes.config, icon: SlidersHorizontal, tourId: "tour-nav-config" },
]

// Shown before a language switch, which is a full page reload: editors on
// other pages keep drafts in memory, so warn in both languages.
export const LOCALE_SWITCH_CONFIRMATION =
  "Switch the interface language?\nThe page reloads, and unsaved edits may be lost.\n\n切换界面语言？\n页面将重新加载，未保存的修改可能会丢失。"

// Single entry point for the language menu. Keeps the guard rails in one
// place: same-locale picks are a no-op, a cancelled confirmation writes
// nothing, and only a confirmed switch persists the locale and reloads.
export function selectLocale(next: Locale): void {
  if (next === getLocale()) return
  if (!window.confirm(LOCALE_SWITCH_CONFIRMATION)) return
  setLocale(next)
  window.location.reload()
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { theme, setTheme } = useTheme()
  const locale = getLocale()
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
          <SidebarGroupLabel>{t("Navigation")}</SidebarGroupLabel>
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
            <SidebarMenuButton asChild tooltip={t("Report a bug")}>
              <a
                href={GITHUB_ISSUE_URL}
                aria-label={t("Report a bug")}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Bug className="size-4" />
                <span>{t("Report a bug")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={t("Help and feedback")} data-tour-id="tour-help-menu">
                  <LifeBuoy className="size-4" />
                  <span>{t("Help and feedback")}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-52">
                <DropdownMenuItem
                  data-tour-id="tour-help-product-tour"
                  onSelect={() => restartTour()}
                >
                  <Play className="size-4" />
                  <span>{t("Take product tour")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={feedbackHref} aria-label={t("Send feedback")}>
                    <LifeBuoy className="size-4" />
                    <span>{t("Send feedback")}</span>
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("View on GitHub")}>
              <a
                href={GITHUB_REPOSITORY_URL}
                aria-label={t("View on GitHub")}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FaGithub className="size-4" />
                <span>{t("View on GitHub")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator className="-mx-2" style={{ width: "calc(100% + 1rem)" }} />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={t("Language")} aria-label={t("Language")}>
                  <Languages className="size-4" />
                  <span>{t("Language")}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-52">
                <DropdownMenuRadioGroup
                  value={locale}
                  onValueChange={(value) => selectLocale(value as Locale)}
                >
                  <DropdownMenuRadioItem value="en">
                    {t("English")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zh-CN">
                    {t("Simplified Chinese")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              tooltip={t("Toggle theme")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span>{theme === "dark" ? t("Light Mode") : t("Dark Mode")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={toggleSidebar}
              tooltip={state === "expanded" ? t("Collapse sidebar") : t("Expand sidebar")}
            >
              {state === "expanded"
                ? <ChevronLeft className="size-4" />
                : <ChevronRight className="size-4" />}
              <span>{t("Collapse")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
