// It floats at the container's top-right, so its tooltip opens leftward into the pane.

import { useId } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LIVE_DOT_MEANINGS, LIVE_DOT_NAMES, type LiveDotState } from '@/lib/live-preview'

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/**
 * The dot has no visible word, so its name is the aria-label and its meaning is a hidden sentence
 * the button is described by, open or closed. The tooltip repeats that sentence for a pointer.
 */
export function HealthDot({ state }: { state: LiveDotState }) {
  const meaningId = useId()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-live-dot={state}
          aria-label={LIVE_DOT_NAMES[state]}
          aria-describedby={meaningId}
          className={`inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full ${FOCUS_RING}`}
        >
          <span data-live-dot-mark aria-hidden className={`live-dot live-dot-${state}`} />
        </button>
      </TooltipTrigger>
      <span id={meaningId} hidden>{LIVE_DOT_MEANINGS[state]}</span>
      <TooltipContent side="bottom" align="end" sideOffset={4} className="max-w-[280px] text-left">
        {LIVE_DOT_MEANINGS[state]}
      </TooltipContent>
    </Tooltip>
  )
}
