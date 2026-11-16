import { Link } from "react-router"
import {
  ChevronRight, Save, CheckCircle2, Settings, Keyboard, Loader2, PlayCircle, Square,
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

interface TestNavbarProps {
  testName: string
  testId: string
  unsaved: boolean
  isCreateMode: boolean
  mode?: 'view' | 'edit'
  testHref?: string
  isSaving: boolean
  isValidating: boolean
  isRunning: boolean
  runDisabled?: boolean
  hasInvalidFilename: boolean
  shortcutsOpen: boolean
  showTestId?: boolean
  runButtonTourId?: string
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

export function TestNavbar({
  testName,
  testId,
  unsaved,
  isCreateMode,
  mode = 'view',
  testHref,
  isSaving,
  isValidating,
  isRunning,
  runDisabled = false,
  hasInvalidFilename,
  shortcutsOpen,
  showTestId = true,
  runButtonTourId,
  hasLiveSession = false,
  liveConnectionState = "disconnected",
  isLiveActionDisabled = false,
  liveSessionNumber = null,
  onSave,
  onValidate,
  onRun,
  onLiveConnect,
  onLiveEnd,
  onSettingsOpen,
  onToggleShortcuts,
}: TestNavbarProps) {
  const { t } = useTranslation()
  const isViewMode = mode === 'view' && !isCreateMode
  const showLiveAction = !!onLiveConnect || !!onLiveEnd || hasLiveSession || liveConnectionState === "connecting"
  const showDivider = !isCreateMode || showLiveAction
  const showEditCrumb = !isCreateMode && !isViewMode && mode === 'edit'
  const showSessionBadge = !isViewMode
    && hasLiveSession
    && typeof liveSessionNumber === "number"
    && (liveConnectionState === "connected" || liveConnectionState === "executing")
  const liveHelpText = t("tests.navbar.liveHelp")

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to="/tests"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          {t("tests.navbar.tests")}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {/* The name gives way first: Edit shrinks only once the name is gone. */}
        {isCreateMode ? (
          <span className="text-sm font-medium truncate">{t("tests.navbar.newTest")}</span>
        ) : testHref && !isViewMode ? (
          <Link to={testHref} className="shrink-[100000] truncate text-sm font-medium hover:text-primary transition-colors" title={testName}>
            {testName}
          </Link>
        ) : (
          <span className="shrink-[100000] text-sm font-medium truncate" title={testName}>{testName}</span>
        )}
        {showEditCrumb && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{t("common.edit")}</span>
          </>
        )}
        {unsaved && (
          <Badge variant="outline" className="text-xs">
            {t("tests.navbar.unsaved")}
          </Badge>
        )}
        {!isViewMode && !isCreateMode && testId && showTestId && <IdBadge label="T" value={testId} />}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {isViewMode ? (
          <>
            {testHref ? (
              <Button variant="outline" size="sm" asChild>
                <Link to={testHref}>
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
              label={isRunning ? t("tests.navbar.running") : t("tests.navbar.run")}
              shortcutKey="R"
              size="sm"
              runButtonTourId={runButtonTourId}
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
                    {liveConnectionState === "connecting" ? t("tests.navbar.connecting") : t("tests.navbar.connectLive")}
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
                      <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts} aria-label={t("tests.navbar.shortcuts")}>
                        <Keyboard className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("tests.navbar.shortcuts")}</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">{t("tests.navbar.actions")}</h4>
                      <ShortcutLegend hints={[
                        { key: "E", label: t("common.edit") },
                        { key: "R", label: t("tests.navbar.run") },
                        { key: "L", label: t("tests.navbar.connectLive") },
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
              {isValidating ? t("tests.navbar.validating") : t("tests.navbar.validate")}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSave} disabled={isSaving || hasInvalidFilename}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? t("tests.navbar.saving") : t("tests.navbar.save")}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSettingsOpen}>
              <Settings className="h-3.5 w-3.5" />
              {t("tests.navbar.settings")}
            </Button>

            {showDivider && <div className="h-4 w-px bg-border" />}

            {!isCreateMode && (
              <>
                <SplitButton
                  onRun={onRun}
                  disabled={isRunning || runDisabled}
                  label={isRunning ? t("tests.navbar.running") : t("tests.navbar.run")}
                  size="sm"
                  runButtonTourId={runButtonTourId}
                />
              </>
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
                  {t("tests.navbar.endLive")}
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
                      {liveConnectionState === "connecting" ? t("tests.navbar.connecting") : t("tests.navbar.connectLive")}
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
                {t("tests.navbar.session", { number: liveSessionNumber })}
              </Badge>
            )}

            {!isCreateMode && (
              <Popover open={shortcutsOpen} onOpenChange={(open) => { if (!open) onToggleShortcuts() }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts} aria-label={t("tests.navbar.shortcuts")}>
                      <Keyboard className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("tests.navbar.shortcuts")}</TooltipContent>
              </Tooltip>
              <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                <div className="space-y-3">
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">{t("tests.navbar.actions")}</h4>
                    <ShortcutLegend hints={[
                      { key: "R", label: t("tests.navbar.hint.runTest") },
                      { key: "Cmd+S", label: t("tests.navbar.save") },
                      { key: "Esc", label: t("tests.navbar.hint.closeResults") },
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
