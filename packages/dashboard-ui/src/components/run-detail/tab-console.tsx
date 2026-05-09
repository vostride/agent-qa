import { useState, useMemo, useDeferredValue } from "react"
import { Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ExecutionLogEntry, LiveExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import { cn } from "@/lib/utils"

interface TabConsoleProps {
  step: Pick<DisplayStep, "stepOrder" | "displayStepOrder" | "consoleLogs">
  allSteps: Array<Pick<DisplayStep, "stepOrder" | "displayStepOrder" | "consoleLogs">>
  executionLogs?: Array<ExecutionLogEntry | LiveExecutionLogEntry>
  isHookStep?: boolean
}

function levelTextColor(level: string): string {
  switch (level.toLowerCase()) {
    case 'error': return 'text-red-400'
    case 'warn': case 'warning': return 'text-amber-400'
    case 'info': return 'text-blue-400'
    case 'debug': return 'text-cyan-400'
    default: return 'text-muted-foreground'
  }
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'setup': return 'bg-blue-500/15 text-blue-400 border-blue-500/20'
    case 'teardown': return 'bg-purple-500/15 text-purple-400 border-purple-500/20'
    case 'inline': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20'
    default: return 'bg-muted text-muted-foreground'
  }
}

const LOG_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-400/30 text-inherit rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function TabConsole({ step, allSteps, executionLogs, isHookStep }: TabConsoleProps) {
  const accumulatedLogs = useMemo(() => {
    const currentOrder = step.displayStepOrder ?? step.stepOrder
    const logs: Array<{ level: string; text: string; location?: { url: string; lineNumber: number; columnNumber: number }; timestamp: number; isCurrent: boolean }> = []
    for (const s of allSteps) {
      const stepOrder = s.displayStepOrder ?? s.stepOrder
      if (stepOrder > currentOrder) continue
      const isCurrent = stepOrder === currentOrder
      for (const log of s.consoleLogs ?? []) {
        logs.push({ ...log, isCurrent })
      }
    }
    return logs.sort((a, b) => a.timestamp - b.timestamp)
  }, [step, allSteps])

  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [levelFilter, setLevelFilter] = useState<string>('all')

  const filteredLogs = useMemo(() => {
    let logs = accumulatedLogs
    if (levelFilter !== 'all') {
      logs = logs.filter(entry => {
        const lvl = entry.level.toLowerCase()
        const idx = LOG_LEVELS.indexOf(levelFilter as typeof LOG_LEVELS[number])
        if (idx === -1) return true
        const entryIdx = LOG_LEVELS.indexOf(lvl as typeof LOG_LEVELS[number])
        return entryIdx !== -1 && entryIdx >= idx
      })
    }
    if (deferredQuery) {
      const q = deferredQuery.toLowerCase()
      logs = logs.filter(entry =>
        entry.text.toLowerCase().includes(q) ||
        entry.level.toLowerCase().includes(q)
      )
    }
    return logs
  }, [accumulatedLogs, deferredQuery, levelFilter])

  const hasHookOutput = isHookStep && executionLogs && executionLogs.length > 0
  const hasConsoleLogs = accumulatedLogs.length > 0

  if (!hasHookOutput && !hasConsoleLogs) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
        No console output captured for this step
      </div>
    )
  }

  return (
    <div className="w-full overflow-hidden">
      {hasConsoleLogs && (
        <div className="sticky top-0 z-10 bg-background border-b border-border/50 px-3 py-1.5 flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <span className="text-xs text-muted-foreground shrink-0">
              {filteredLogs.length} of {accumulatedLogs.length}
            </span>
          )}
          <div className="h-3 w-px bg-border/50 shrink-0" />
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger size="sm" className="h-6 rounded-sm text-xs px-2 gap-1 border-border/50 min-w-0 w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-sm">
              <SelectItem value="all" className="text-xs">All levels</SelectItem>
              <SelectItem value="error" className="text-xs">Errors</SelectItem>
              <SelectItem value="warn" className="text-xs">Warnings</SelectItem>
              <SelectItem value="info" className="text-xs">Info</SelectItem>
              <SelectItem value="log" className="text-xs">Log</SelectItem>
              <SelectItem value="debug" className="text-xs">Debug</SelectItem>
            </SelectContent>
          </Select>
          {query && (
            <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div className="p-3 space-y-0.5 overflow-x-hidden w-full max-w-full">
        {hasHookOutput && (
          <div className="space-y-2 mb-3">
            {executionLogs!.map((log) => (
              <div key={log.id} className="border border-border/50 rounded-sm overflow-hidden">
                <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/20 border-b border-border/30">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                    {log.name}
                  </Badge>
                  <Badge className={cn("text-[10px] px-1.5 py-0", phaseColor(log.phase))}>
                    {log.phase}
                  </Badge>
                  <span className={cn(
                    "text-[10px] font-mono",
                    log.status === 'passed' ? 'text-emerald-500' : 'text-red-500'
                  )}>
                    {log.status}
                  </span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{log.duration}ms</span>
                </div>
                {log.stdout && (
                  <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground/90">{log.stdout}</pre>
                )}
                {log.stderr && (
                  <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-400/80 border-t border-border/30">{log.stderr}</pre>
                )}
              </div>
            ))}
          </div>
        )}

        {hasHookOutput && hasConsoleLogs && (
          <div className="border-t border-border/30 pt-2 mb-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Browser Console</span>
          </div>
        )}

        {hasConsoleLogs && filteredLogs.map((entry, i) => (
          <div key={i} className={cn(
            "flex items-start gap-1.5 py-0.5 px-2 hover:bg-muted/30 font-mono text-xs overflow-hidden max-w-full",
            !entry.isCurrent && "opacity-40"
          )}>
            <span className={cn("shrink-0 text-[10px]", levelTextColor(entry.level))}>
              {entry.level}
            </span>
            <span className="text-muted-foreground/60 shrink-0 text-[10px] tabular-nums">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span className="flex-1 min-w-0 break-all whitespace-pre-wrap overflow-hidden">
              <HighlightMatch text={entry.text} query={deferredQuery} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
