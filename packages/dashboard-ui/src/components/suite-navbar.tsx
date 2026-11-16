import { Link } from "react-router"
import {
  ChevronRight, Save, CheckCircle2, Settings, Keyboard,
  Loader2, PlayCircle, Square,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SplitButton } from "@/components/split-button"
import { IdBadge } from "@/components/id-badge"
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui/tooltip"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { ShortcutKey, ShortcutLegend } from "@/components/shortcut-hints"
import { useTranslation } from "@/i18n"

interface SuiteNavbarProps {
  suiteName: string
  suiteId: string
  unsaved: boolean
  isCreateMode: boolean
  mode?: 'view' | 'edit'
  suiteHref?: string
  isSaving: boolean
  isValidating: boolean
  isRunning: boolean
  runDisabled?: boolean
  hasInvalidFilename: boolean
  shortcutsOpen: boolean
  showSuiteId?: boolean
  hasLiveSession?: boolean
  liveConnectionState?: "idle" | "disconnected" | "connecting" | "connected" | "executing" | "error"
  isLiveActionDisabled?: boolean
  liveSessionNumber?: number | null
  onBack: () => void
  onSave: () => void
  onValidate: () => void
  onRun: () => void
  onLiveConnect?: () => void
  onLiveEnd?: () => void
  onSettingsOpen: () => void
  onToggleShortcuts: () => void
}

export function SuiteNavbar({
  suiteName,
  suiteId,
  unsaved,
  isCreateMode,
  mode = 'view',
  suiteHref,
  isSaving,
  isValidating,
  isRunning,
  runDisabled = false,
  hasInvalidFilename,
  shortcutsOpen,
  showSuiteId = true,
  hasLiveSession = false,
  liveConnectionState = "idle",
  isLiveActionDisabled = false,
  liveSessionNumber = null,
  onSave,
  onValidate,
  onRun,
  onLiveConnect,
  onLiveEnd,
  onSettingsOpen,
  onToggleShortcuts,
}: SuiteNavbarProps) {
  const { t } = useTranslation()
  const isViewMode = mode === 'view' && !isCreateMode
  const showLiveAction = !!onLiveConnect || !!onLiveEnd || hasLiveSession || liveConnectionState === "connecting"
  const showDivider = !isCreateMode || showLiveAction
  const showEditCrumb = !isCreateMode && !isViewMode && mode === 'edit'
  const liveHelpText = t("suites.navbar.liveHelp")
  const showSessionBadge = !isViewMode
    && hasLiveSession
    && typeof liveSessionNumber === "number"
    && (liveConnectionState === "connected" || liveConnectionState === "executing")

  return (
    <div data-testid="suite-navbar-root" className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to="/suites"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          {t("suites.navbar.suites")}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {/* The name gives way first: Edit shrinks only once the name is gone. */}
        {isCreateMode ? (
          <span className="text-sm font-medium truncate">{t("suites.navbar.newSuite")}</span>
        ) : suiteHref && !isViewMode ? (
          <Link to={suiteHref} className="shrink-[100000] truncate text-sm font-medium hover:text-primary transition-colors" title={suiteName}>
            {suiteName}
          </Link>
        ) : (
          <span className="shrink-[100000] text-sm font-medium truncate" title={suiteName}>{suiteName}</span>
        )}
        {showEditCrumb && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{t("common.edit")}</span>
          </>
        )}
        {unsaved && (
          <Badge variant="outline" className="text-xs">
            {t("suites.navbar.unsaved")}
          </Badge>
        )}
        {!isViewMode && !isCreateMode && suiteId && showSuiteId && <IdBadge label="S" value={suiteId} />}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {isViewMode ? (
          <>
            {suiteHref ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={suiteHref}>
                  {t("common.edit")}
                  <ShortcutKey shortcut="E" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                {t("common.edit")}
                <ShortcutKey shortcut="E" />
              </Button>
            )}

            <SplitButton
              onRun={onRun}
              disabled={isRunning || runDisabled}
              label={isRunning ? t("suites.navbar.running") : t("suites.navbar.run")}
              shortcutKey="R"
              size="sm"
            />

            {showLiveAction && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    onClick={onLiveConnect}
                    disabled={isLiveActionDisabled || !onLiveConnect}
                  >
                    {liveConnectionState === "connecting" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlayCircle className="h-3.5 w-3.5" />
                    )}
                    {liveConnectionState === "connecting" ? t("suites.navbar.connecting") : t("suites.navbar.connectLive")}
                    <ShortcutKey
                      shortcut="L"
                      className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground"
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-[13px]">
                  {liveHelpText}
                </TooltipContent>
              </Tooltip>
            )}

            {!isCreateMode && (
              <Popover open={shortcutsOpen} onOpenChange={(open) => { if (!open) onToggleShortcuts() }}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts} aria-label={t("suites.navbar.shortcuts")}>
                        <Keyboard className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("suites.navbar.shortcuts")}</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">{t("suites.navbar.actions")}</h4>
                      <ShortcutLegend hints={[
                        { key: "E", label: t("common.edit") },
                        { key: "R", label: t("suites.navbar.run") },
                        { key: "L", label: t("suites.navbar.connectLive") },
                      ]} />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onValidate} disabled={isValidating || hasInvalidFilename}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              {isValidating ? t("suites.navbar.validating") : t("suites.navbar.validate")}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSave} disabled={isSaving || hasInvalidFilename}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? t("suites.navbar.saving") : t("suites.navbar.save")}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSettingsOpen}>
              <Settings className="h-3.5 w-3.5" />
              {t("suites.navbar.settings")}
            </Button>

            {showDivider && <div className="h-4 w-px bg-border" />}

            {!isCreateMode && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <SplitButton
                      onRun={onRun}
                      disabled={isRunning || runDisabled || hasLiveSession}
                      label={isRunning ? t("suites.navbar.running") : t("suites.navbar.runSuite")}
                      size="sm"
                    />
                  </span>
                </TooltipTrigger>
                {hasLiveSession && (
                  <TooltipContent>{t("suites.navbar.endLiveToRun")}</TooltipContent>
                )}
              </Tooltip>
            )}

            {showLiveAction && (
              hasLiveSession && liveConnectionState !== "connecting" ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onLiveEnd}
                  disabled={!onLiveEnd}
                >
                  <Square className="h-3.5 w-3.5" />
                  {t("suites.navbar.endLive")}
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={onLiveConnect}
                      disabled={isLiveActionDisabled || !onLiveConnect}
                    >
                      {liveConnectionState === "connecting" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PlayCircle className="h-3.5 w-3.5" />
                      )}
                      {liveConnectionState === "connecting" ? t("suites.navbar.connecting") : t("suites.navbar.connectLive")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm text-[13px]">
                    {liveHelpText}
                  </TooltipContent>
                </Tooltip>
              )
            )}

            {showSessionBadge && (
              <Badge
                variant="outline"
                aria-live="polite"
                className="text-[10px] tracking-wider font-medium text-muted-foreground bg-muted/50 border-border/50"
              >
                {t("suites.navbar.session", { number: liveSessionNumber })}
              </Badge>
            )}

            {!isCreateMode && (
              <Popover open={shortcutsOpen} onOpenChange={(open) => { if (!open) onToggleShortcuts() }}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts}>
                        <Keyboard className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("suites.navbar.shortcuts")}</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">{t("suites.navbar.actions")}</h4>
                      <ShortcutLegend hints={[
                        { key: "R", label: t("suites.navbar.hint.runSuite") },
                        { key: "Cmd+S", label: t("suites.navbar.save") },
                        { key: "Esc", label: t("suites.navbar.hint.closeResults") },
                      ]} />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </>
        )}
      </div>
    </div>
  )
}
