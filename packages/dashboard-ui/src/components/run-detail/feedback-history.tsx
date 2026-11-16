import { Fragment, useId } from 'react'
import { ChevronRight } from 'lucide-react'
import type { MarkHistoryEntry, RunDetailProjection } from '@vostride/agent-qa-schema'
import { markAddressKey } from '@vostride/agent-qa-schema'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/i18n'
import type { MarksHistoryRead } from '@/lib/api'
import {
  ACTIVE_TEXT,
  APPLIED_CORRECTION_TEXT,
  CHOICE_LABELS,
  HISTORY_EMPTY_TEXT,
  HISTORY_READ_FAILED_TEXT,
  HISTORY_RETRY_ACCESSIBLE_NAME,
  HISTORY_TITLE_TEXT,
  REPLACEMENT_EXPLANATION,
  RETRY_LABEL,
  appliedChangeView,
  appliedRecordUnavailableText,
  dispositionText,
  feedbackHistoryState,
  feedbackReadFailureReason,
  formatMarkTime,
  historyChangePieces,
  historyStateText,
  historyTargetLabel,
  historyTitle,
  quotedParts,
  replacedByText,
  runHistoryLabel,
  type AppliedChangeView,
  type FeedbackEntryScope,
  type FeedbackTextParts,
  type HistoryChangeSlot,
} from '@/lib/feedback-view'
import { cn } from '@/lib/utils'

export interface FeedbackHistoryProps {
  scope: FeedbackEntryScope
  /** The pinned target's mark address (markAddressKey). */
  address: string
  /** The last history read that landed; undefined until the first one settles. */
  read: MarksHistoryRead | undefined
  detail: Pick<RunDetailProjection, 'members' | 'steps'> | null | undefined
  /** The receipt just recorded here, marked in the target list until the next edit. */
  newMarkId?: string
  onRetry?: () => void
}

function TextParts({ parts }: { parts: FeedbackTextParts }) {
  return (
    <>
      {parts.prefix}
      {parts.name}
      {parts.suffix}
    </>
  )
}

// Every absence of the read is named as itself, never as an empty list; the page owns the read.
export function FeedbackHistory({ scope, address, read, detail, newMarkId, onRetry }: FeedbackHistoryProps) {
  useTranslation()
  const titleId = useId()
  const state = feedbackHistoryState(read)
  const entries: readonly MarkHistoryEntry[] = read?.kind === 'read' && read.result.kind === 'history' ? read.result.entries : []
  const loaded = state === 'history' || state === 'empty'
  const newestFirst = [...entries].reverse()
  const targetEntries = newestFirst.filter((entry) => markAddressKey(entry) === address)
  const targetState = state === 'history' && targetEntries.length === 0 ? 'empty' : state
  const timeOf = (markId: string | undefined) => formatMarkTime(entries.find((entry) => entry.markId === markId)?.markedAt)
  const replaced = entries.some((entry) => !entry.active)
  // The correction pointer shows with the first applied change, not only after a replacement.
  const appliedAny = entries.some((entry) => entry.disposition.kind === 'applied')

  return (
    <div className="space-y-3">
      {replaced ? (
        <p data-feedback-replaced-note className="text-xs text-muted-foreground">
          {REPLACEMENT_EXPLANATION()}
        </p>
      ) : null}
      {appliedAny ? (
        <p data-feedback-correction-note className="text-xs text-muted-foreground">
          {APPLIED_CORRECTION_TEXT()}
        </p>
      ) : null}
      <section data-feedback-history="target" data-history-state={targetState} aria-labelledby={titleId} className="space-y-2">
        <h3 id={titleId} className="text-sm font-medium">
          {loaded ? historyTitle(scope, targetEntries.length) : HISTORY_TITLE_TEXT[scope]}
        </h3>
        {state === 'loading' ? (
          <div className="space-y-2">
            <Skeleton className="h-10 motion-reduce:animate-none" />
            <Skeleton className="h-10 motion-reduce:animate-none" />
          </div>
        ) : !loaded ? (
          <AbsentHistory read={read} onRetry={onRetry} />
        ) : targetEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{HISTORY_EMPTY_TEXT[scope]}</p>
        ) : (
          <ol className="space-y-2">
            {targetEntries.map((entry) => (
              <HistoryEntry key={entry.markId} entry={entry} replacedAt={timeOf(entry.supersededBy)} isNew={entry.markId === newMarkId} />
            ))}
          </ol>
        )}
      </section>
      {loaded ? (
        <div data-feedback-history="run" data-history-state={state}>
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              {runHistoryLabel(entries.length)}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {newestFirst.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">{HISTORY_EMPTY_TEXT.run}</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {newestFirst.map((entry) => (
                    <HistoryEntry
                      key={entry.markId}
                      entry={entry}
                      replacedAt={timeOf(entry.supersededBy)}
                      target={historyTargetLabel(entry, detail)}
                    />
                  ))}
                </ol>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
    </div>
  )
}

function AbsentHistory({ read, onRetry }: { read: MarksHistoryRead | undefined; onRetry: (() => void) | undefined }) {
  let sentence: string
  let retries = false
  if (read === undefined) return null
  if (read.kind === 'failed') {
    sentence = HISTORY_READ_FAILED_TEXT(feedbackReadFailureReason(read.reason))
    retries = true
  } else if (read.result.kind === 'ledger-corrupt') {
    sentence = historyStateText('ledger-corrupt', read.result.line)
  } else if (read.result.kind === 'run-not-found' || read.result.kind === 'ledger-unavailable') {
    sentence = historyStateText(read.result.kind)
    retries = read.result.kind === 'ledger-unavailable'
  } else {
    return null
  }
  return (
    <div className="space-y-2">
      <p className="break-words text-xs text-muted-foreground">{sentence}</p>
      {retries ? (
        <Button
          variant="outline"
          size="sm"
          data-feedback-history-retry
          aria-label={HISTORY_RETRY_ACCESSIBLE_NAME()}
          onClick={() => onRetry?.()}
        >
          {RETRY_LABEL()}
        </Button>
      ) : null}
    </div>
  )
}

function HistoryEntry({
  entry,
  replacedAt,
  target,
  isNew = false,
}: {
  entry: MarkHistoryEntry
  replacedAt: string | undefined
  /** Named in the run list only; the target list is all one place. */
  target?: FeedbackTextParts
  isNew?: boolean
}) {
  const time = formatMarkTime(entry.markedAt)
  const applied = appliedChangeView(entry)
  return (
    <li
      data-history-entry
      data-mark-id={entry.markId}
      data-history-active={String(entry.active)}
      data-history-new={isNew ? 'true' : undefined}
      className={cn('space-y-1 rounded-md border px-3 py-2 text-xs', !entry.active && 'text-muted-foreground')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words">
          {target === undefined ? null : (
            <>
              <span data-history-target>
                <TextParts parts={target} />
              </span>
              {' · '}
            </>
          )}
          <span className="font-medium">{CHOICE_LABELS[entry.kind]}</span>
        </span>
        {time === undefined ? null : (
          <time dateTime={new Date(entry.markedAt).toISOString()} className="shrink-0 tabular-nums text-muted-foreground">
            {time}
          </time>
        )}
      </div>
      <p className={entry.active ? 'font-medium text-foreground' : undefined}>
        {entry.active ? ACTIVE_TEXT() : replacedByText(replacedAt)}
      </p>
      {entry.note === undefined ? null : (
        <p className="break-words">
          <TextParts parts={quotedParts(entry.note)} />
        </p>
      )}
      <p data-history-disposition data-history-applied={applied?.kind} className="break-words">
        {historyChangePieces(entry, applied).map((piece, index) =>
          typeof piece === 'string' ? (
            <Fragment key={index}>{piece}</Fragment>
          ) : (
            <ChangeSlot key={index} slot={piece.slot} entry={entry} applied={applied} />
          ),
        )}
      </p>
    </li>
  )
}

// One slot of the entry's line, equal to `historyChangeText`; producer text stays text.
function ChangeSlot({
  slot,
  entry,
  applied,
}: {
  slot: HistoryChangeSlot
  entry: MarkHistoryEntry
  applied: AppliedChangeView | undefined
}) {
  switch (slot) {
    case 'disposition':
      return <span data-history-disposition-lead>{dispositionText(entry.disposition)}</span>
    case 'records':
      return applied?.kind !== 'knowledge'
        ? null
        : applied.records.map((record, index) => (
            <span key={record.recordId} data-history-applied-record={record.recordId}>
              {index === 0 ? null : '; '}
              {record.content === undefined ? (
                appliedRecordUnavailableText(record.recordId)
              ) : (
                <TextParts parts={quotedParts(record.content)} />
              )}
            </span>
          ))
    case 'file':
      return applied?.kind !== 'test-file' ? null : <code className="font-mono">{applied.filePath}</code>
    default:
      return slot satisfies never
  }
}
