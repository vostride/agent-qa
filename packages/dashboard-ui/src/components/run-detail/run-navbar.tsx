import { useNavigate } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  ArrowUpRight, Clock, Brain, Cpu, Video, ExternalLink,
  RotateCcw, ChevronRight, Keyboard, PanelRightOpen,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShortcutLegend } from "@/components/shortcut-hints"
import type { RunRow, StepRow } from "@/lib/api"
import { triggerRun } from "@/lib/api"
import { resolveVideoSrc } from "@/lib/artifact-media"
import { formatDuration } from "@/lib/utils"
import { formatTokens } from "@/lib/format"

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/20">Passed</Badge>
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
    case "healed":
      return <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">Healed</Badge>
    case "flaky":
      return <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">Flaky</Badge>
    case "skipped":
      return <Badge variant="secondary">Skipped</Badge>
    case "cancelled":
      return <Badge className="bg-muted text-muted-foreground border-border">Cancelled</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

interface RunNavbarProps {
  run: RunRow
  steps: StepRow[]
  shortcutsOpen: boolean
  onToggleShortcuts: () => void
  onOpenArtifacts?: (tab: "attributes" | "config" | "memory") => void
}

export function RunNavbar({ run, steps, shortcutsOpen, onToggleShortcuts, onOpenArtifacts }: RunNavbarProps) {
  const navigate = useNavigate()
  const totalTokens = steps.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  const totalPrompt = steps.reduce((sum, s) => sum + (s.promptTokens ?? 0), 0)
  const totalCompletion = steps.reduce((sum, s) => sum + (s.completionTokens ?? 0), 0)
  const isSuiteParent = run.suiteId != null && run.parentRunId == null
  const sourceHref = isSuiteParent && run.suiteId
    ? routes.suiteView(run.suiteId)
    : run.testId
      ? routes.testView(run.testId)
      : null
  const sourceLabel = isSuiteParent && run.suiteId ? "Open suite" : "Open test"

  const videoSrc = resolveVideoSrc(run.id, run.videoPath)
  const farmUrl = (run.metadata as Record<string, unknown>)?.farmSessionUrl as string | undefined

  const handleRerun = () => {
    const wasLocal = run.attributes["agent-qa.runner"] === "local"
    triggerRun({ file: run.filePath ?? run.name, local: wasLocal })
      .then((result) => {
        toast.success("Re-run started")
        navigate(routes.runLive(result.runId))
      })
      .catch(() => toast.error("Failed to start re-run"))
  }

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => navigate(routes.runs)}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          Runs
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate">{run.name}</span>
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
        <StatusBadge status={run.status} />
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {run.modelName && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Brain className="h-3.5 w-3.5" />
            {run.modelName}
          </span>
        )}
        {totalTokens > 0 && (
          <span
            className="text-xs text-muted-foreground flex items-center gap-1 cursor-default"
            title="Prompt tokens / Completion tokens"
          >
            <Cpu className="h-3.5 w-3.5" />
            {formatTokens(totalPrompt)} / {formatTokens(totalCompletion)}
          </span>
        )}
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(run.duration)}
        </span>

        <div className="h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open run artifacts"
          title="Run details (I/C/M)"
          onClick={() => onOpenArtifacts?.("attributes")}
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
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Screenshots</h4>
                  <ShortcutLegend hints={[
                    { key: "B", label: "Before screenshot" },
                    { key: "A", label: "After screenshot" },
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
                    { key: "M", label: "Artifacts: Memory" },
                    { key: "R", label: "Re-run" },
                    { key: "V", label: "Video" },
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

        {videoSrc && (
          <a href={videoSrc} target="_blank" rel="noopener noreferrer" aria-label="Open recording" title="Recording (V)">
            <Button variant="ghost" size="icon-sm">
              <Video className="h-3.5 w-3.5" />
            </Button>
          </a>
        )}

        {farmUrl && (
          <a href={farmUrl} target="_blank" rel="noopener noreferrer" title="BrowserStack">
            <Button variant="ghost" size="icon-sm">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </a>
        )}
      </div>
    </div>
  )
}
