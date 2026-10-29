import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ConfigSaveStatus, ConfigSaveUndoLine } from '@/lib/config-autosave'
import {
  NOT_SAVED_ACTION_NAME,
  RETRY_LABEL,
  SAVE_STATUS_WORDS,
  STATUS_SEPARATOR,
  UNDO_LABEL,
} from '@/lib/config-copy'

/** The Saved word's fade, matching duration-300 on it. */
const SAVED_FADE_MS = 300

const LINK_CLASS = 'h-auto p-0 text-xs'

export interface SaveStatusProps {
  status: ConfigSaveStatus
  onRetry: () => void
  onUndo: () => void
  onGoToDraft: () => void
}

/** What the polite region says for a status; Saving and idle say nothing. */
function announcementFor(status: ConfigSaveStatus): string {
  switch (status.state) {
    case 'saved':
      return SAVE_STATUS_WORDS.saved
    case 'draft':
      return SAVE_STATUS_WORDS.draft
    case 'failed':
      return SAVE_STATUS_WORDS.failed
    case 'undo':
      return status.undo?.line ?? ''
    case 'saving':
    case 'idle':
      return ''
  }
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground">
      {STATUS_SEPARATOR.trim()}
    </span>
  )
}

function SavedWord({ fading }: { fading: boolean }) {
  return (
    <span
      data-save-status-saved
      aria-hidden={fading ? 'true' : undefined}
      className={`inline-flex items-center gap-1 font-medium text-muted-foreground transition-opacity duration-300 motion-reduce:transition-none ${fading ? 'opacity-0' : 'opacity-100'}`}
    >
      <Check className="size-3" aria-hidden="true" />
      {SAVE_STATUS_WORDS.saved}
    </span>
  )
}

function UndoLine({ undo }: { undo: ConfigSaveUndoLine }) {
  const at = undo.name === '' ? -1 : undo.line.indexOf(undo.name)
  return (
    <span
      data-save-undo-line
      role="group"
      aria-label={undo.line}
      title={undo.line}
      className="inline-flex min-w-0 items-baseline whitespace-pre text-muted-foreground"
    >
      {at < 0 ? (
        <span aria-hidden="true">{undo.line}</span>
      ) : (
        <>
          <span aria-hidden="true">{undo.line.slice(0, at)}</span>
          <span
            aria-hidden="true"
            data-save-undo-name
            className="inline-block max-w-40 truncate align-bottom"
          >
            {undo.name}
          </span>
          <span aria-hidden="true">{undo.line.slice(at + undo.name.length)}</span>
        </>
      )}
    </span>
  )
}

/**
 * The Config page's one quiet status. It renders deriveSaveStatus's answer and
 * never decides precedence itself. Nothing here moves focus.
 */
export function SaveStatus({ status, onRetry, onUndo, onGoToDraft }: SaveStatusProps) {
  const state = status.state
  const previous = useRef(state)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const was = previous.current
    previous.current = state
    if (was !== 'saved' || state !== 'idle') {
      setFading(false)
      return
    }
    setFading(true)
    const timer = setTimeout(() => setFading(false), SAVED_FADE_MS)
    return () => clearTimeout(timer)
  }, [state])

  let content: ReactNode = null
  switch (state) {
    case 'idle':
      content = fading ? <SavedWord fading /> : null
      break
    case 'saving':
      content = (
        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
          <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          {SAVE_STATUS_WORDS.saving}
        </span>
      )
      break
    case 'saved':
      content = <SavedWord fading={false} />
      break
    case 'draft':
      content = (
        <>
          <span
            data-save-status-dot
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-amber-500"
          />
          <Button
            type="button"
            variant="link"
            size="xs"
            className={`${LINK_CLASS} font-medium`}
            aria-label={NOT_SAVED_ACTION_NAME}
            onClick={onGoToDraft}
          >
            {SAVE_STATUS_WORDS.draft}
          </Button>
        </>
      )
      break
    case 'failed':
      content = (
        <>
          <CircleAlert className="size-3 shrink-0 text-destructive" aria-hidden="true" />
          <span className="font-medium text-destructive">{SAVE_STATUS_WORDS.failed}</span>
          <Separator />
          <Button type="button" variant="link" size="xs" className={LINK_CLASS} onClick={onRetry}>
            {RETRY_LABEL}
          </Button>
        </>
      )
      break
    case 'undo':
      content =
        status.undo === undefined ? null : (
          <>
            <UndoLine undo={status.undo} />
            <Separator />
            <Button type="button" variant="link" size="xs" className={LINK_CLASS} onClick={onUndo}>
              {UNDO_LABEL}
            </Button>
          </>
        )
      break
  }

  return (
    <>
      <div
        data-save-status={state}
        className="flex min-h-6 min-w-0 shrink-0 items-center gap-1 pb-2 text-xs"
      >
        {content}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcementFor(status)}
      </div>
    </>
  )
}
