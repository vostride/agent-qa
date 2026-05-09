import { useState, useEffect } from "react"
import { ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { fetchRunLogs } from "@/lib/api"
import type { LogEntry } from "@/lib/api"
import { cn } from "@/lib/utils"

interface LogTimelineProps {
  runId: string
  stepId?: string | null
}

const LEVEL_OPTIONS = ["all", "debug", "info", "warn", "error"] as const
const SOURCE_OPTIONS = [
  "all",
  "agent",
  "adapter",
  "cache",
  "planner",
  "healer",
  "hook",
  "runner",
] as const

function levelBadgeClass(level: string): string {
  switch (level) {
    case "debug":
      return "bg-muted text-muted-foreground"
    case "info":
      return "bg-blue-500/15 text-blue-500 border-blue-500/20"
    case "warn":
      return "bg-amber-500/15 text-amber-500 border-amber-500/20"
    case "error":
      return "bg-red-500/15 text-red-500 border-red-500/20"
    default:
      return ""
  }
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    const h = String(d.getHours()).padStart(2, "0")
    const m = String(d.getMinutes()).padStart(2, "0")
    const s = String(d.getSeconds()).padStart(2, "0")
    const ms = String(d.getMilliseconds()).padStart(3, "0")
    return `${h}:${m}:${s}.${ms}`
  } catch {
    return ts
  }
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false)
  const hasData = entry.data && Object.keys(entry.data).length > 0

  return (
    <div className="border-b border-border/30 last:border-b-0">
      {hasData ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-1.5 px-2 text-left hover:bg-muted/50 transition-colors">
            <span className="text-[11px] font-mono text-muted-foreground shrink-0">
              {formatTimestamp(entry.timestamp)}
            </span>
            <Badge className={cn("text-[10px] px-1.5 py-0 shrink-0", levelBadgeClass(entry.level))}>
              {entry.level}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
              {entry.source}
            </Badge>
            <span className="text-sm truncate flex-1">{entry.message}</span>
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground transition-transform duration-200 shrink-0",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="text-xs font-mono bg-muted rounded-sm p-2 mx-2 mb-2 overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="flex items-center gap-2 py-1.5 px-2">
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">
            {formatTimestamp(entry.timestamp)}
          </span>
          <Badge className={cn("text-[10px] px-1.5 py-0 shrink-0", levelBadgeClass(entry.level))}>
            {entry.level}
          </Badge>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
            {entry.source}
          </Badge>
          <span className="text-sm truncate flex-1">{entry.message}</span>
        </div>
      )}
    </div>
  )
}

export function LogTimeline({ runId, stepId }: LogTimelineProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState<string>("all")
  const [sourceFilter, setSourceFilter] = useState<string>("all")

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    fetchRunLogs(runId, {
      stepId: stepId ?? undefined,
      level: levelFilter === "all" ? undefined : levelFilter,
      source: sourceFilter === "all" ? undefined : sourceFilter,
    })
      .then((data) => {
        if (!cancelled) setLogs(data.logs)
      })
      .catch(() => {
        if (!cancelled) setLogs([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [runId, stepId, levelFilter, sourceFilter])

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 shrink-0">
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-[120px] h-7 text-xs rounded-sm">
            <SelectValue placeholder="All levels" />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((l) => (
              <SelectItem key={l} value={l} className="text-xs">
                {l === "all" ? "All levels" : l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-[120px] h-7 text-xs rounded-sm">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s === "all" ? "All sources" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground ml-auto">
          {logs.length} {logs.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading logs...</div>
        ) : logs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No logs found</div>
        ) : (
          logs.map((entry) => <LogEntryRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}
