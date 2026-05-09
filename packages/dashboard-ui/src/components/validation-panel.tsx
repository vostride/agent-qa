import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ValidationError {
  message: string
  line?: number
  column?: number
  suggestion?: string
}

interface ValidationPanelProps {
  errors: ValidationError[]
  onClickError?: (line: number) => void
}

export function ValidationPanel({ errors, onClickError }: ValidationPanelProps) {
  if (errors.length === 0) return null

  return (
    <div className="border-t border-border bg-destructive/5 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertCircle className="size-3.5" />
        {errors.length} {errors.length === 1 ? 'error' : 'errors'}
      </div>
      <div className="max-h-[100px] overflow-y-auto space-y-1">
        {errors.map((err, i) => (
          <button
            key={`${err.line ?? 0}-${i}`}
            type="button"
            className={cn(
              'flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
              err.line ? 'hover:bg-destructive/10 cursor-pointer' : 'cursor-default',
            )}
            onClick={() => err.line && onClickError?.(err.line)}
          >
            <span className="flex-1 text-foreground/80">{err.message}</span>
            {err.line && (
              <span className="shrink-0 text-muted-foreground tabular-nums">
                Ln {err.line}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
