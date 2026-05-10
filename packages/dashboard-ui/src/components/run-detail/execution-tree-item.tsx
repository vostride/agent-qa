import { Webhook, Code, CheckCircle2, XCircle } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import type { ExecutionLogEntry } from '@/lib/api'

interface ExecutionTreeItemProps {
  log: ExecutionLogEntry
  isSelected: boolean
  onSelect: () => void
}

export function ExecutionTreeItem({ log, isSelected, onSelect }: ExecutionTreeItemProps) {
  const TypeIcon = log.type === 'runjs' ? Code : Webhook
  const statusDot = (
    <span className={cn(
      'h-1.5 w-1.5 rounded-full shrink-0',
      log.status === 'passed' ? 'bg-emerald-500' : 'bg-red-500',
    )} />
  )

  return (
    <li role="treeitem" aria-level={2} aria-selected={isSelected} data-execution-id={log.id}>
      <button
        className={cn(
          'flex w-full items-center gap-2 py-1.5 px-3 text-left rounded-[2px] text-sm',
          'hover:bg-muted/50 transition-colors',
          isSelected && 'bg-primary/10 ring-1 ring-primary/30',
        )}
        onClick={onSelect}
      >
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
          {statusDot}
        </span>
        <TypeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {log.phase === 'inline' && (
          <span className="text-[9px] px-1 py-0 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-medium shrink-0">
            pre
          </span>
        )}
        <span className="flex-1 min-w-0 text-xs break-all text-muted-foreground">{log.name}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {formatDuration(log.duration)}
        </span>
      </button>
    </li>
  )
}
