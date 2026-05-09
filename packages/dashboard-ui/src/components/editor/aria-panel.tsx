import { RefreshCw } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'

interface EditorAriaPanelProps {
  ariaTree: string | null
  onRefresh?: () => void
  isExecuting?: boolean
}

export function EditorAriaPanel({ ariaTree, onRefresh, isExecuting }: EditorAriaPanelProps) {
  if (!ariaTree) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm text-muted-foreground">
        <span>Run a step or click Fetch to capture the accessibility tree</span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isExecuting}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className="size-3" />
            Fetch
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end px-3 py-1 border-b border-border/50">
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isExecuting}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Refresh ARIA tree"
          >
            <RefreshCw className="size-3" />
            Refresh
          </button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <pre className="font-mono text-xs p-3 whitespace-pre-wrap">{ariaTree}</pre>
      </ScrollArea>
    </div>
  )
}
