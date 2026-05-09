import { X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ObservationMarkdown } from '@/components/observation-markdown'
import { Button } from '@/components/ui/button'
import type { ObservationSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

function trustColor(trust: number): string {
  if (trust >= 0.7) return 'text-emerald-500'
  if (trust >= 0.4) return 'text-amber-500'
  return 'text-destructive'
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

interface ObservationCardProps {
  observation: ObservationSummary
  onDelete: (id: string) => void
  isDeleting?: boolean
}

export function ObservationCard({ observation, onDelete, isDeleting }: ObservationCardProps) {
  return (
    <div className="rounded-md border bg-card/60 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-3 text-[11px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('font-mono tabular-nums font-medium cursor-default', trustColor(observation.trust))}>
              {observation.trust.toFixed(2)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            Trust score (0–1). Higher means the agent is more confident this observation is accurate. Increases when confirmed across runs, decreases when contradicted.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground cursor-default">{formatDate(observation.created)}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">First observed on this date</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground cursor-default">
              {observation.confirmed_count}x confirmed · {observation.contradicted_count}x contradicted
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            Confirmed: how many runs validated this observation. Contradicted: how many runs found it inaccurate.
          </TooltipContent>
        </Tooltip>
        <div className="ml-auto">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={isDeleting}
                aria-label={`Delete observation: ${observation.title.slice(0, 40)}`}
                className="shrink-0 text-muted-foreground/70 hover:text-destructive"
              >
                <X className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete observation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This observation will be permanently removed. The agent will no longer use it during future runs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => onDelete(observation.id)}
                  disabled={isDeleting}
                >
                  Delete Observation
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold tracking-tight text-foreground">
          {observation.title}
        </h4>
        <ObservationMarkdown content={observation.content} />
      </div>
    </div>
  )
}
