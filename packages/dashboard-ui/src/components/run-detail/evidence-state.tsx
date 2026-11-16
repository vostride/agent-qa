import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EVIDENCE_ICON_OF_STATE, EVIDENCE_LOADING_LABEL, EVIDENCE_TONE_OF_STATE, type EvidenceFailure, type EvidenceKindLabel, type EvidenceState as State, type EvidenceTone } from '@/lib/evidence-state-view'
import { cn } from '@/lib/utils'

const TONE_CLASS = {
  positive: 'text-emerald-500', neutral: 'text-muted-foreground', alert: 'text-destructive',
} satisfies Record<EvidenceTone, string>

interface EvidenceStateProps {
  kind: EvidenceKindLabel
  variant?: 'pane' | 'inline'
  state: State
  failure?: EvidenceFailure
  incomplete?: boolean
  title: string
  explanation: string
  actionLabel?: string
  onAction?: () => void
}

export function EvidenceState({ kind, state, failure, incomplete, title, explanation, actionLabel, onAction, variant = 'pane' }: EvidenceStateProps) {
  const tone = EVIDENCE_TONE_OF_STATE[state]
  const Icon = EVIDENCE_ICON_OF_STATE[state]
  const attributes = {
    'data-evidence-state': state,
    'data-evidence-kind': kind,
    'data-evidence-tone': tone,
    'data-evidence-failure': state === 'failed' ? failure : undefined,
    'data-evidence-incomplete': incomplete ? true : undefined,
    role: tone === 'alert' ? 'alert' : 'status',
  }
  if (variant === 'inline') return (
    <Badge {...attributes} variant="outline" className="gap-1 align-baseline border-border font-normal">
      <Icon className={cn('h-3 w-3', TONE_CLASS[tone])} aria-hidden="true" />
      {title}
    </Badge>
  )
  return (
    <div {...attributes}
      className="flex min-h-[16rem] w-full flex-col items-center justify-center gap-2 py-12 text-center">
      <Icon className={cn('h-8 w-8', TONE_CLASS[tone])} aria-hidden="true" />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <p className="max-w-sm text-xs text-muted-foreground">{explanation}</p>
      {actionLabel && onAction && <Button size="sm" variant={state === 'not-captured' ? 'link' : 'outline'} onClick={onAction}>{actionLabel}</Button>}
    </div>
  )
}

export function EvidenceLoading({ kind }: { kind: EvidenceKindLabel }) {
  return (
    <div data-evidence-loading data-evidence-kind={kind} aria-busy="true" className="space-y-2 p-3">
      <span role="status" className="sr-only">{EVIDENCE_LOADING_LABEL()}</span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  )
}
