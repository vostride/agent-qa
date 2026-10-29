import { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import type { MarkPreviewKnowledgeRecord, RunsMarkPreviewResult } from '@vostride/agent-qa-schema'
import { DenialBlock } from '@/components/run-detail/denial-block'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import type { FeedbackReadFailure } from '@/lib/api'
import {
  CLI_ESCAPE_PARTS,
  CONTENT_ABSENCE_TEXT,
  DRAFT_WORDING_NOT_SHOWN_TEXT,
  PREVIEW_IDLE_TEXT,
  PREVIEW_LINE_LABELS,
  PREVIEW_READ_FAILED_TEXT,
  PREVIEW_RETRY_ACCESSIBLE_NAME,
  PREVIEW_TITLE,
  PREVIEW_UPDATING_TEXT,
  RETRY_LABEL,
  alreadyMarkedText,
  feedbackReadFailureReason,
  isPreviewRefusal,
  previewRefusalText,
  quarantinedText,
  draftHasWording,
  knowledgeLine,
  previewFixText,
  recordEffectLine,
  replacesLine,
  showRecordsLabel,
  type FeedbackPreviewState,
} from '@/lib/feedback-view'
import { cn } from '@/lib/utils'

type Consequences = Extract<RunsMarkPreviewResult, { kind: 'consequences' }>

export interface FeedbackPreviewProps {
  state: FeedbackPreviewState
  /** The displayed read was computed for the form's current request key. */
  current: boolean
  /** The read on screen, kept while a re-fetch is in flight so nothing blanks. */
  read?: RunsMarkPreviewResult
  updating?: boolean
  /** When the superseded mark was made, from history; absent until history is read. */
  replacesTime?: string
  /** When the identical prior mark was made, from history; absent until history is read. */
  alreadyMarkedTime?: string
  /** Looks an earlier mark's time up in the loaded history; the explicit times above win. */
  timeFor?: (markId: string) => string | undefined
  /** Why the read on screen failed. */
  failure?: FeedbackReadFailure
  /** Re-issues the failed read; never submits. */
  onRetry?: () => void
}

const SKELETON_WIDTHS = ['w-full', 'w-5/6', 'w-2/3', 'w-3/4'] as const

// Every word comes from the preview read; not a live region, as the composer's footer announces.
export function FeedbackPreview({
  state,
  current,
  read,
  updating = false,
  replacesTime,
  alreadyMarkedTime,
  timeFor,
  failure,
  onRetry,
}: FeedbackPreviewProps) {
  const titleId = useId()
  return (
    <section
      data-feedback-preview
      data-preview-state={state}
      data-preview-current={String(current)}
      aria-labelledby={titleId}
      aria-busy={state === 'loading' || updating}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 id={titleId} className="text-sm font-medium">
          {PREVIEW_TITLE}
        </h3>
        {updating ? <span className="text-xs text-muted-foreground">{PREVIEW_UPDATING_TEXT}</span> : null}
      </div>
      {state === 'idle' ? (
        <p className="text-xs text-muted-foreground">{PREVIEW_IDLE_TEXT}</p>
      ) : state === 'loading' ? (
        <div className="space-y-2">
          {SKELETON_WIDTHS.map((width) => (
            <Skeleton key={width} className={cn('h-4 motion-reduce:animate-none', width)} />
          ))}
        </div>
      ) : (
        <div className={cn(updating && 'opacity-60')}>
          {state === 'consequences' && read?.kind === 'consequences' ? (
            <ConsequenceLines
              read={read}
              replacesTime={replacesTime ?? (read.latest.kind === 'supersedes' ? timeFor?.(read.latest.markId) : undefined)}
            />
          ) : state === 'quarantined' && read?.kind === 'quarantined' ? (
            <div data-preview-line="quarantined" className={ARM_BLOCK_CLASS}>
              {quarantinedText(read.class)}
            </div>
          ) : state === 'already-marked' && read?.kind === 'already-marked' ? (
            <div data-preview-line="already-marked" className={ARM_BLOCK_CLASS}>
              {alreadyMarkedText(alreadyMarkedTime ?? timeFor?.(read.prior.markId))}
            </div>
          ) : state === 'refused' && read !== undefined && isPreviewRefusal(read) ? (
            <div data-preview-refusal={read.kind}>
              <DenialBlock neutralReason={previewRefusalText(read)} />
            </div>
          ) : state === 'failed' && failure !== undefined ? (
            <FailedRead failure={failure} onRetry={onRetry} />
          ) : null}
        </div>
      )}
    </section>
  )
}

const ARM_BLOCK_CLASS = 'rounded-md bg-muted/40 px-3 py-2 text-xs'

function FailedRead({ failure, onRetry }: { failure: FeedbackReadFailure; onRetry: (() => void) | undefined }) {
  return (
    <div className="space-y-2">
      <DenialBlock neutralReason={PREVIEW_READ_FAILED_TEXT(feedbackReadFailureReason(failure))} />
      <Button
        variant="outline"
        size="sm"
        data-feedback-preview-retry
        aria-label={PREVIEW_RETRY_ACCESSIBLE_NAME}
        onClick={() => onRetry?.()}
      >
        {RETRY_LABEL}
      </Button>
      <p className="text-xs text-muted-foreground">
        {CLI_ESCAPE_PARTS.prefix}
        <span className="font-mono">{CLI_ESCAPE_PARTS.name}</span>
        {CLI_ESCAPE_PARTS.suffix}
      </p>
    </div>
  )
}

function ConsequenceLines({ read, replacesTime }: { read: Consequences; replacesTime: string | undefined }) {
  const { knowledge, draft, latest } = read
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="font-medium text-muted-foreground">{PREVIEW_LINE_LABELS.knowledge}</dt>
        <dd data-preview-line="knowledge" className="space-y-1 break-words text-foreground">
          <p>{knowledgeLine(knowledge.evidence, knowledge.records.length)}</p>
          {knowledge.records.length === 0 ? null : (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                {showRecordsLabel(knowledge.records.length)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 space-y-2">
                  {knowledge.records.map((record) => (
                    <RecordItem key={record.recordId} record={record} />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </dd>

        <dt className="font-medium text-muted-foreground">{PREVIEW_LINE_LABELS.change}</dt>
        <dd data-preview-line="change" className="space-y-1 break-words text-foreground">
          <p>{previewFixText(draft)}</p>
          {draftHasWording(draft) ? <p className="text-muted-foreground">{DRAFT_WORDING_NOT_SHOWN_TEXT}</p> : null}
        </dd>
      </dl>
      {latest.kind === 'supersedes' ? (
        <p data-preview-line="replaces" className="text-xs text-foreground">
          {replacesLine(latest.ordinal, replacesTime)}
        </p>
      ) : null}
    </div>
  )
}

function RecordItem({ record }: { record: MarkPreviewKnowledgeRecord }) {
  const place = record.evidence.kind === 'unreadable' ? 'unreadable' : record.served ? 'served' : 'unserved'
  return (
    <li data-preview-record={place} className="space-y-0.5 break-words">
      <p className="text-foreground">
        {record.recordContent !== undefined ? (
          record.recordContent.content
        ) : record.contentAbsence !== undefined ? (
          CONTENT_ABSENCE_TEXT[record.contentAbsence.reason]
        ) : null}
      </p>
      <p className="text-muted-foreground">{recordEffectLine(record)}</p>
    </li>
  )
}
