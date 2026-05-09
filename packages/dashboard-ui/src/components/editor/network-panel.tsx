import { useRef, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface NetworkEntry {
  url: string
  method: string
  status: number | null
  startTime: number
  endTime: number | null
}

interface EditorNetworkPanelProps {
  entries: NetworkEntry[]
}

function statusStyles(status: number | null): string {
  if (status === null) return 'bg-muted text-muted-foreground'
  if (status >= 200 && status < 300) return 'bg-emerald-500/15 text-emerald-500'
  if (status >= 300 && status < 400) return 'bg-blue-500/15 text-blue-500'
  if (status >= 400 && status < 500) return 'bg-amber-500/15 text-amber-500'
  return 'bg-red-500/15 text-red-500'
}

function formatDuration(start: number, end: number | null): string {
  if (end === null) return '...'
  const ms = end - start
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function extractPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}

export function EditorNetworkPanel({ entries }: EditorNetworkPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No network requests captured
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div>
        {entries.map((entry, i) => (
          <div key={i} className="flex items-center gap-2 py-1 px-3 border-b border-border/30 hover:bg-muted/30">
            <span className={`text-[10px] px-1.5 py-0 rounded-sm font-mono shrink-0 ${statusStyles(entry.status)}`}>
              {entry.status ?? '...'}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground uppercase w-10 shrink-0">
              {entry.method}
            </span>
            <span className="text-xs truncate flex-1 font-mono">
              {extractPath(entry.url)}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
              {formatDuration(entry.startTime, entry.endTime)}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
