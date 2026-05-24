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
  onRun: (local: boolean) => void
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
  const isViewMode = mode === 'view' && !isCreateMode
  const showLiveAction = !!onLiveConnect || !!onLiveEnd || hasLiveSession || liveConnectionState === "connecting"
  const showDivider = !isCreateMode || showLiveAction
  const showEditCrumb = !isCreateMode && !isViewMode && mode === 'edit'
  const showSessionBadge = !isViewMode
    && hasLiveSession
    && typeof liveSessionNumber === "number"
    && (liveConnectionState === "connected" || liveConnectionState === "executing")
  const liveHelpText = "Start a disposable live session for this test. Setup hooks run on connect, teardown hooks run when the session ends, and changes are not saved automatically."

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <Link
          to="/tests"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          Tests
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {isCreateMode ? (
          <span className="text-sm font-medium truncate">New Test</span>
        ) : testHref && !isViewMode ? (
          <Link to={testHref} className="truncate text-sm font-medium hover:text-primary transition-colors">
            {testName}
          </Link>
        ) : (
          <span className="text-sm font-medium truncate">{testName}</span>
        )}
        {showEditCrumb && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">Edit</span>
          </>
        )}
        {unsaved && (
          <Badge variant="outline" className="text-xs">
            Unsaved
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
                  Edit
                  <ShortcutKey shortcut="E" />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Edit
                <ShortcutKey shortcut="E" />
              </Button>
            )}

            <SplitButton
              onRun={onRun}
              disabled={isRunning || runDisabled}
              label={isRunning ? "Running..." : "Run"}
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
                    {liveConnectionState === "connecting" ? "Connecting..." : "Connect Live Session"}
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
                      <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts} aria-label="Shortcuts">
                        <Keyboard className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Shortcuts</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                  <div className="space-y-3">
                    <div>
                      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Actions</h4>
                      <ShortcutLegend hints={[
                        { key: "E", label: "Edit" },
                        { key: "R", label: "Run" },
                        { key: "L", label: "Connect Live Session" },
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
              {isValidating ? "Validating..." : "Validate"}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSave} disabled={isSaving || hasInvalidFilename}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? "Saving..." : "Save"}
            </Button>

            <Button variant="ghost" size="sm" onClick={onSettingsOpen}>
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Button>

            {showDivider && <div className="h-4 w-px bg-border" />}

            {!isCreateMode && (
              <>
                <SplitButton
                  onRun={onRun}
                  disabled={isRunning || runDisabled}
                  label={isRunning ? "Running..." : "Run"}
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
                  End Live Session
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
                      {liveConnectionState === "connecting" ? "Connecting..." : "Connect Live Session"}
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
                Session #{liveSessionNumber}
              </Badge>
            )}

            {!isCreateMode && (
              <Popover open={shortcutsOpen} onOpenChange={(open) => { if (!open) onToggleShortcuts() }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" onClick={onToggleShortcuts} aria-label="Shortcuts">
                      <Keyboard className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Shortcuts</TooltipContent>
              </Tooltip>
              <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                <div className="space-y-3">
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Actions</h4>
                    <ShortcutLegend hints={[
                      { key: "R", label: "Run test" },
                      { key: "Cmd+S", label: "Save" },
                      { key: "Esc", label: "Close results panel" },
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
