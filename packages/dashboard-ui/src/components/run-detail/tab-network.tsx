import { useState, useMemo, useCallback, useDeferredValue, useEffect, Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, Search, X, Copy, Check } from "lucide-react"
import type { DisplayStep } from "@/lib/display-step"
import { cn } from "@/lib/utils"

export function formatRelativeTime(offsetMs: number): string {
  if (offsetMs >= 1000) return `+${(offsetMs / 1000).toFixed(1)}s`
  return `+${Math.round(offsetMs)}ms`
}

export function filterTimingEntries(timing: Record<string, number>): [string, number][] {
  return Object.entries(timing).filter(([key, ms]) => key !== 'startTime' && ms > 0)
}

interface NetworkEntry {
  url: string
  method: string
  status: number
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  body?: string
  requestBody?: string
  startTime: number
  endTime: number
  timing?: Record<string, number>
  isCurrent: boolean
}

interface TabNetworkProps {
  step: Pick<DisplayStep, "stepOrder" | "displayStepOrder" | "networkLogs">
  allSteps: Array<Pick<DisplayStep, "stepOrder" | "displayStepOrder" | "networkLogs">>
  platform?: string
}

function statusColor(status: number) {
  if (status >= 200 && status < 300) return "text-emerald-500"
  if (status >= 300 && status < 400) return "text-amber-500"
  if (status >= 400) return "text-red-500"
  return "text-muted-foreground"
}

function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground italic">None</span>
  }
  return (
    <div className="space-y-0.5">
      {entries.map(([key, val]) => (
        <div key={key} className="flex gap-2 text-xs font-mono">
          <span className="text-muted-foreground shrink-0">{key}:</span>
          <span className="break-all">{val}</span>
        </div>
      ))}
    </div>
  )
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</h4>
      {children}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [text])
  return (
    <button onClick={handleCopy} className="text-muted-foreground hover:text-foreground">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function ResponseBody({ body, contentType }: { body: string; contentType: string }) {
  const ct = contentType.toLowerCase()
  if (ct.includes('application/json')) {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2)
      return <pre className="text-xs font-mono bg-background/60 rounded-sm px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{pretty}</pre>
    } catch {
      return <pre className="text-xs font-mono bg-background/60 rounded-sm px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{body}</pre>
    }
  }
  if (ct.includes('image/svg+xml')) {
    return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`} alt="SVG response" className="max-h-48" />
  }
  if (body.startsWith('data:image/')) {
    return <img src={body} alt="Image response" className="max-h-48 rounded-sm" />
  }
  if (ct.includes('image/')) {
    return <span className="text-xs text-muted-foreground italic">Image not previewable (re-run test to capture)</span>
  }
  return <pre className="text-xs font-mono bg-background/60 rounded-sm px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{body}</pre>
}

function ExpandedDetail({ entry }: { entry: NetworkEntry }) {
  const isPost = entry.method === "POST" || entry.method === "PUT" || entry.method === "PATCH"

  return (
    <tr>
      <td colSpan={6} className="px-0 py-0">
        <div className="bg-muted/20 border-b border-border/50 px-4 py-3 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <DetailSection label="Request Headers">
              <HeadersTable headers={entry.requestHeaders ?? {}} />
            </DetailSection>

            <DetailSection label="Response Headers">
              <HeadersTable headers={entry.responseHeaders ?? {}} />
            </DetailSection>
          </div>

          {isPost && (
            <DetailSection label="Request Body">
              {entry.requestBody ? (
                <pre className="text-xs font-mono bg-background/60 rounded-sm px-3 py-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{entry.requestBody}</pre>
              ) : (
                <span className="text-xs text-muted-foreground italic">No request body</span>
              )}
            </DetailSection>
          )}

          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Response Body</h4>
              {entry.body && <CopyButton text={entry.body} />}
            </div>
            {entry.body ? (
              <ResponseBody body={entry.body} contentType={(entry.responseHeaders?.['content-type'] ?? '')} />
            ) : (
              <span className="text-xs text-muted-foreground italic">Not captured</span>
            )}
          </div>

          {entry.timing && (() => {
            const validTimings = filterTimingEntries(entry.timing)
            if (validTimings.length === 0) return null
            return (
              <DetailSection label="Timing">
                <div className="flex flex-wrap gap-3">
                  {validTimings.map(([phase, ms]) => (
                    <div key={phase} className="text-xs font-mono">
                      <span className="text-muted-foreground">{phase}:</span>{" "}
                      <span>{Math.round(ms)}ms</span>
                    </div>
                  ))}
                </div>
              </DetailSection>
            )
          })()}
        </div>
      </td>
    </tr>
  )
}

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

export function TabNetwork({ step, allSteps, platform }: TabNetworkProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())

  const accumulatedLogs = useMemo(() => {
    const currentOrder = step.displayStepOrder ?? step.stepOrder
    const logs: NetworkEntry[] = []
    for (const s of allSteps) {
      const stepOrder = s.displayStepOrder ?? s.stepOrder
      if (stepOrder > currentOrder) continue
      const isCurrent = stepOrder === currentOrder
      for (const log of s.networkLogs ?? []) {
        logs.push({ ...log, isCurrent })
      }
    }
    return logs.sort((a, b) => a.startTime - b.startTime)
  }, [step, allSteps])

  const baseline = useMemo(() => {
    if (accumulatedLogs.length === 0) return 0
    return Math.min(...accumulatedLogs.map(l => l.startTime))
  }, [accumulatedLogs])

  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)

  const filteredLogs = useMemo(() => {
    if (!deferredQuery) return accumulatedLogs
    const q = deferredQuery.toLowerCase()
    return accumulatedLogs.filter(entry =>
      entry.url.toLowerCase().includes(q) ||
      entry.method.toLowerCase().includes(q) ||
      String(entry.status).includes(q)
    )
  }, [accumulatedLogs, deferredQuery])

  useEffect(() => { setExpandedRows(new Set()) }, [deferredQuery])

  const toggleRow = useCallback((index: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  if (accumulatedLogs.length === 0) {
    const isMobile = platform === 'android' || platform === 'ios'
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
        {isMobile
          ? 'Network capture is not available for mobile tests'
          : 'No network requests captured for this step'}
      </div>
    )
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-background border-b border-border/50 px-3 py-1.5 flex items-center gap-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <>
            <span className="text-xs text-muted-foreground shrink-0">
              {filteredLogs.length} of {accumulatedLogs.length}
            </span>
            <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="p-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="w-6" />
              <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground w-16">Method</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground">URL</th>
              <th className="text-left py-1.5 px-2 text-xs font-medium text-muted-foreground w-16">Status</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium text-muted-foreground w-20">Time</th>
              <th className="text-right py-1.5 px-2 text-xs font-medium text-muted-foreground w-20">Duration</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.map((entry, i) => {
              const duration = entry.endTime - entry.startTime
              const isExpanded = expandedRows.has(i)
              return (
                <Fragment key={i}>
                  <tr
                    onClick={() => toggleRow(i)}
                    className={cn(
                      "border-b border-border/50 cursor-pointer hover:bg-muted/30 transition-colors",
                      isExpanded && "bg-muted/20",
                      !entry.isCurrent && "opacity-40"
                    )}
                  >
                    <td className="py-1.5 pl-2 pr-0 w-6">
                      <ChevronRight className={cn(
                        "h-3 w-3 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90"
                      )} />
                    </td>
                    <td className="py-1.5 px-2">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                        <HighlightMatch text={entry.method} query={deferredQuery} />
                      </Badge>
                    </td>
                    <td className="py-1.5 px-2 text-xs font-mono truncate max-w-0 min-w-0">
                      <HighlightMatch text={entry.url} query={deferredQuery} />
                    </td>
                    <td className="py-1.5 px-2">
                      <span className={cn("text-xs font-mono", statusColor(entry.status))}>
                        <HighlightMatch text={String(entry.status)} query={deferredQuery} />
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-xs font-mono text-muted-foreground text-right">
                      {formatRelativeTime(entry.startTime - baseline)}
                    </td>
                    <td className="py-1.5 px-2 text-xs text-muted-foreground text-right">
                      {duration < 1 ? '<1' : Math.round(duration)}ms
                    </td>
                  </tr>
                  {isExpanded && <ExpandedDetail entry={entry} />}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
