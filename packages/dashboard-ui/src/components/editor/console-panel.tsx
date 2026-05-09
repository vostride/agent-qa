import { useRef, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info'
  text: string
  timestamp: number
}

interface EditorConsolePanelProps {
  entries: ConsoleEntry[]
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const levelStyles: Record<string, string> = {
  log: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/15 text-amber-500',
  error: 'bg-red-500/15 text-red-500',
  info: 'bg-blue-500/15 text-blue-500',
}

export function EditorConsolePanel({ entries }: EditorConsolePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No console output yet
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div>
        {entries.map((entry, i) => (
          <div key={i} className="py-1 px-3 border-b border-border/30">
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums shrink-0">
                {formatTimestamp(entry.timestamp)}
              </span>
              <span className={`text-[10px] px-1.5 py-0 rounded-sm shrink-0 ${levelStyles[entry.level] ?? levelStyles.log}`}>
                {entry.level}
              </span>
              <span className="text-xs font-mono break-all whitespace-pre-wrap flex-1">
                {entry.text}
              </span>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
