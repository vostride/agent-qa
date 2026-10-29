import { Ban, Check, Circle, CircleDashed, Minus, ShieldCheck, X, type LucideIcon } from 'lucide-react'

import { LIVE_STEP_STATUS_NAMES, liveLabelText, liveRowShown } from '@/lib/live-step-row'
import type { LiveStepRow, StepStatus } from '@/lib/run-stream-reducer'
import { cn } from '@/lib/utils'

// Inert and still: takes only `LiveStepRow`, wraps the whole label, draws nothing without text.

// One shape per status, so colour is never the only signal.
export const LIVE_STEP_GLYPHS = {
  pending: CircleDashed,
  running: Circle,
  passed: Check,
  failed: X,
  healed: ShieldCheck,
  skipped: Minus,
  cancelled: Ban,
} satisfies Record<StepStatus, LucideIcon>

const STATUS_TONE: Record<StepStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-blue-500',
  passed: 'text-emerald-500',
  failed: 'text-red-400',
  healed: 'text-amber-500',
  skipped: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
}

export function LiveStepRowView({ row }: { row: LiveStepRow }) {
  if (!liveRowShown(row)) return null
  const Glyph = LIVE_STEP_GLYPHS[row.status]

  return (
    <li
      data-step-status={row.status}
      data-step-ticks={String(row.ticks)}
      className="flex items-start gap-2 border-b border-border/40 px-3 py-1.5 text-sm last:border-b-0"
    >
      <span
        role="img"
        aria-label={LIVE_STEP_STATUS_NAMES[row.status]}
        className="inline-flex h-5 shrink-0 items-center"
      >
        <Glyph className={cn('size-3.5', STATUS_TONE[row.status])} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 whitespace-normal break-words leading-5 [overflow-wrap:anywhere]">
        {liveLabelText(row.text)}
      </span>
    </li>
  )
}
