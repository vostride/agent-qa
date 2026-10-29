import { MessageSquare, MessageSquarePlus } from 'lucide-react'
import type { Mark } from '@vostride/agent-qa-schema'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  FEEDBACK_ENTRY_MARKED_TOOLTIP,
  FEEDBACK_ENTRY_TOOLTIP,
  markGlyphLabel,
  type FeedbackEntryScope,
} from '@/lib/feedback-view'
import { cn } from '@/lib/utils'

export interface FeedbackEntryButtonProps {
  scope: FeedbackEntryScope
  label: string
  target: string
  marked: boolean
  expanded: boolean
  controls: string
  onOpen: (opener: HTMLElement) => void
  tooltip?: string
}

// Opens the composer and never records a mark itself; the tooltip opens on focus as well as hover.
export function FeedbackEntryButton({ scope, label, target, marked, expanded, controls, onOpen, tooltip }: FeedbackEntryButtonProps) {
  const Glyph = marked ? MessageSquare : MessageSquarePlus
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('shrink-0', scope === 'step' && 'size-7', marked ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
          data-feedback-entry={scope}
          data-feedback-target={target}
          data-feedback-marked={String(marked)}
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={controls}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <Glyph className={cn('h-3.5 w-3.5', marked && 'fill-current')} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={scope === 'step' ? 'left' : 'bottom'}>
        {tooltip ?? (marked ? FEEDBACK_ENTRY_MARKED_TOOLTIP : FEEDBACK_ENTRY_TOOLTIP)}
      </TooltipContent>
    </Tooltip>
  )
}

export interface MarkGlyphProps {
  scope: FeedbackEntryScope
  target: string
  kind: Mark
}

/** The passive trace of a recorded mark: named, never interactive, never a second door. */
export function MarkGlyph({ scope, target, kind }: MarkGlyphProps) {
  return (
    <span
      role="img"
      aria-label={markGlyphLabel(kind)}
      data-feedback-mark-glyph={scope}
      data-feedback-target={target}
      className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground"
    >
      <MessageSquare className="size-3 fill-current" aria-hidden="true" />
    </span>
  )
}
