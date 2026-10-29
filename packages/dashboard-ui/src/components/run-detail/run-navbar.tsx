import type * as React from "react"
import { useNavigate } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  ArrowUpRight, Clock, Cpu,
  RotateCcw, ChevronRight, Keyboard, PanelRightOpen,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { PostProcessingChips } from "@/components/run-detail/post-processing-chips"
import { RetrievalRungBanner } from "@/components/run-detail/retrieval-rung-banner"
import { RunUsageCard } from "@/components/run-detail/run-usage-card"
import { FeedbackEntryButton, type FeedbackEntryButtonProps } from "@/components/run-detail/feedback-entry"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import type { PostProcessingView } from "@/lib/post-processing-view"
import type { RunRow } from "@/lib/api"
import { triggerRun } from "@/lib/api"
import { TOKEN_USAGE_TRIGGER_LABEL, tokenPairLine } from "@/lib/run-detail-view"
import { statusBadgeLook } from "@/lib/status"
import { cn, formatDuration } from "@/lib/utils"
import type { RecordedRetrievalRung, RunModelSummary, RunTokenTotals } from "@vostride/agent-qa-schema"

// The badge root carries the raw status for DOM cells, as its visible text is a title-cased label.
function StatusBadge({ status }: { status: string }) {
  const { label, ...look } = statusBadgeLook(status)
  return (
    <Badge
      data-verdict-badge={status}
      {...look}
      className={cn(look.className, "text-sm font-medium px-2 py-1 rounded-sm")}
    >
      {label}
    </Badge>
  )
}

interface RunNavbarProps {
  run: RunRow
  // `undefined` means no answer yet and renders nothing; an unmeasured run renders its sentence.
  tokens?: RunTokenTotals
  // `undefined` renders no model line; the row's legacy model fields describe the host, not a run.
  models?: RunModelSummary
  shortcutsOpen: boolean
  onToggleShortcuts: () => void
  // The drawer tabs this header can ask for; `m` reaches the Knowledge tab via page shortcuts.
  onOpenArtifacts?: (tab: "test" | "config") => void
  // Paired with `hasPostProcessing`, so an unwired header and a read not yet landed differ.
  postProcessing?: PostProcessingView | undefined
  /** Whether a chip client is wired at all. See {@link RunNavbarProps.postProcessing}. */
  hasPostProcessing?: boolean
  // Forwarded, not decided; absent, the chip stays a `<span>`.
  onCurationClick?: () => void
  // Forwarded, not decided; absent, the analysis indicator stays a focusable `<span>`.
  onOpenVerdict?: () => void
  // `undefined` renders nothing, pending or unrecorded; the value is recorded, never probed.
  retrievalRung?: RecordedRetrievalRung
  // Absent means no element, never a disabled one; passed only when the member can be marked.
  feedbackEntry?: Omit<FeedbackEntryButtonProps, "scope">
}

export function RunNavbar({
  run,
  tokens,
  models,
  shortcutsOpen,
  onToggleShortcuts,
  onOpenArtifacts,
  postProcessing,
  hasPostProcessing = false,
  onCurationClick,
  onOpenVerdict,
  retrievalRung,
  feedbackEntry,
}: RunNavbarProps) {
  const navigate = useNavigate()
  const isSuiteParent = run.suiteId != null
  const sourceHref = isSuiteParent && run.suiteId
    ? routes.suiteView(run.suiteId)
    : run.testId
      ? routes.testView(run.testId)
      : null
  const sourceLabel = isSuiteParent && run.suiteId ? "Open suite" : "Open test"

  const handleRerun = () => {
    triggerRun({ file: run.filePath ?? run.name })
      .then((result) => {
        toast.success("Re-run started")
        navigate(routes.runLive(result.runId))
      })
      .catch(() => toast.error("Failed to start re-run"))
  }

  return (
    // A container query with a 64rem step and 56px minimum, so the header grows rather than clips.
    <div className="shrink-0 @container">
    <div className="flex flex-col gap-y-2 min-h-14 border-b px-4 py-2 min-w-0 @5xl:flex-row @5xl:items-center @5xl:justify-between @5xl:gap-y-0 @5xl:py-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => navigate(routes.runs)}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          Runs
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {/* The one flexible item: it truncates first and keeps its full name in `title`. */}
        <span className="text-sm font-medium truncate min-w-[96px]" title={run.name}>
          {run.name}
        </span>
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={sourceLabel}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {/* The verdict, then the feedback entry's slot after it. */}
        <StatusBadge status={run.status} />
        {feedbackEntry === undefined ? null : (
          <FeedbackEntryButton scope="test" {...feedbackEntry} />
        )}
      </div>

      {/* Stacked, the meta wraps before the `ml-auto` actions, so nothing hides at ~400px. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 shrink-0">
        {/* The lifecycle on one line: execution truth, then post-processing truth. */}
        {hasPostProcessing ? (
          <PostProcessingChips
            view={postProcessing}
            onCurationClick={onCurationClick}
            onOpenVerdict={onOpenVerdict}
          />
        ) : null}
        {/* A focusable `span`, not a button: the card itself is the destination. */}
        {tokens === undefined ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-run-token-summary
                tabIndex={0}
                className="text-xs text-muted-foreground flex items-center gap-1 tabular-nums cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Cpu className="h-3.5 w-3.5" />
                {tokenPairLine(tokens)}
                <span className="sr-only">{TOKEN_USAGE_TRIGGER_LABEL}</span>
              </span>
            </TooltipTrigger>
            <RunUsageCard tokens={tokens} models={models} />
          </Tooltip>
        )}
        <span data-run-duration className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(run.duration)}
        </span>

        <div className="ml-auto flex items-center gap-3">
        <div className="h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open run artifacts"
          title="Run details (I/C/M)"
          onClick={() => onOpenArtifacts?.("test")}
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
        </Button>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            aria-expanded={shortcutsOpen}
            title="Shortcuts (Shift+?)"
            onClick={onToggleShortcuts}
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
          {shortcutsOpen ? (
            <div
              role="dialog"
              aria-label="Keyboard shortcuts"
              className="absolute right-0 top-full z-50 mt-2 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md"
            >
              <div className="space-y-3">
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Navigation</h4>
                  <ShortcutLegend hints={[
                    { key: '← →', label: 'Previous / next action' },
                    { key: 'Space', label: 'Play / pause' },
                    { key: 'V', label: 'Frames / Video' },
                    { key: "\u2191 / K", label: "Previous item" },
                    { key: "\u2193 / J", label: "Next item" },
                    { key: "Shift+\u2191", label: "Previous step" },
                    { key: "Shift+\u2193", label: "Next step" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Tabs</h4>
                  <ShortcutLegend hints={[
                    { key: "1", label: "Overview" },
                    { key: "2", label: "Env" },
                    { key: "3", label: "Network" },
                    { key: "4", label: "Console" },
                    { key: "5", label: "ARIA" },
                    { key: "6", label: "A11y" },
                    { key: "7", label: "Knowledge" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Phases</h4>
                  <ShortcutLegend hints={[
                    { key: "Shift+1", label: "Toggle Observe" },
                    { key: "Shift+2", label: "Toggle Plan" },
                    { key: "Shift+3", label: "Toggle Execute" },
                    { key: "Shift+4", label: "Toggle Verify" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Actions</h4>
                  <ShortcutLegend hints={[
                    { key: "I", label: "Details: Attributes" },
                    { key: "C", label: "Artifacts: Config" },
                    { key: "M", label: "Knowledge tab" },
                    { key: "R", label: "Re-run" },
                    { key: "Shift+?", label: "Shortcuts" },
                    { key: "Esc", label: "Close" },
                  ]} />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Re-run"
          title="Re-run (R)"
          onClick={handleRerun}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        </div>
      </div>
    </div>
    <RetrievalRungBanner rung={retrievalRung?.rung} reason={retrievalRung?.reason} />
    </div>
  )
}
