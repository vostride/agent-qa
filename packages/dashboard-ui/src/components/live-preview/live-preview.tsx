// The token lives only in state and the iframe src; the sandbox keeps the embed opaque-origin.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { HealthDot } from '@/components/live-preview/health-dot'
import { PreviewChrome } from '@/components/live-preview/preview-chrome'
import { fetchEditorLiveUrl, fetchLiveUrl } from '@/lib/api'
import {
  LIVE_PREVIEW_ACTION_LABELS,
  LIVE_PREVIEW_HOST_QUERY,
  NO_STREAM_RETRY_MS,
  RENEW_RETRY_MS,
  SNAPSHOT_PREVIEW_LABEL,
  createInitialLivePreview,
  deriveLivePreview,
  parseEmbedReport,
  reduceLivePreview,
  type LivePreviewAction,
  type LivePreviewEvent,
  type LivePreviewMachine,
  type LivePreviewStateName,
} from '@/lib/live-preview'
import type { MemberRow } from '@/lib/run-stream-reducer'

import type { LiveStreamDeclaration } from '@vostride/agent-qa-schema'

export interface LivePreviewRunSubject {
  kind: 'run'
  runId: string
  // The host decides the handle; a new handle starts the preview over with a mint for it.
  handle: number
  /** The reducer's member rows by handle: whether the watched member's browser can be up yet. */
  membersByHandle: Readonly<Record<number, MemberRow>>
  terminal: boolean
  runOver: boolean
}

export interface LivePreviewEditorSubject {
  kind: 'editor'
  sessionId: string
  sessionGone: boolean
  onStartFresh: () => void
}

export type LivePreviewSubject = LivePreviewRunSubject | LivePreviewEditorSubject

export interface LivePreviewProps {
  subject: LivePreviewSubject
  /** Host content for the chrome row, such as the editor's toolbar. */
  chrome?: ReactNode
}

interface Mint {
  liveUrl: string
  expiresAt: number
}

interface MintAnswer {
  liveUrl: string
  expiresAt: number
  stream: LiveStreamDeclaration
}

/** `open` is a first ask, `renew` swaps the fragment in place, `remount` puts up a new iframe. */
type MintPurpose = 'open' | 'renew' | 'remount'

/** How often the status re-reads the newest frame's age while an iframe is up. */
const CLOCK_TICK_MS = 1_000

/** The states that keep the iframe up: the picture, or the last of it, under the status row. */
const FRAME_STATES: ReadonlySet<LivePreviewStateName> = new Set([
  'loading',
  'live',
  'delayed',
  'reconnecting',
  'disconnected',
  'expired',
])

/** The states whose socket is still worth renewing in place. */
const RENEWABLE_STATES: ReadonlySet<LivePreviewStateName> = new Set(['loading', 'live', 'delayed'])

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** The host hint is a query, never a credential; it goes before the fragment so the token stays where it was. */
export function withHostHint(liveUrl: string): string {
  const at = liveUrl.indexOf('#')
  const base = at === -1 ? liveUrl : liveUrl.slice(0, at)
  const fragment = at === -1 ? '' : liveUrl.slice(at)
  const hint = base.includes('?') ? `&${LIVE_PREVIEW_HOST_QUERY.slice(1)}` : LIVE_PREVIEW_HOST_QUERY
  return `${base}${hint}${fragment}`
}

export function LivePreview({ subject, chrome }: LivePreviewProps) {
  const kind = subject.kind
  const subjectId = subject.kind === 'run' ? subject.runId : subject.sessionId
  const over = subject.kind === 'run' ? subject.terminal || subject.runOver : subject.sessionGone
  const overReason = subject.kind === 'run' ? 'run-ended' : 'session-ended'

  const handle = subject.kind === 'run' ? subject.handle : 0
  const machineRef = useRef<LivePreviewMachine>(createInitialLivePreview())
  const [machine, setMachine] = useState<LivePreviewMachine>(machineRef.current)
  const [now, setNow] = useState(() => Date.now())
  const [mint, setMint] = useState<Mint | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  // A new key is a new iframe element, which is what a reconnect needs.
  const [frameKey, setFrameKey] = useState(0)
  // Each expiry of the not-yet poll, so the poll effect re-arms even when the state word holds.
  const [pollTick, setPollTick] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Read through refs because a mint's answer arrives later than the render that asked for it.
  const watched = subject.kind === 'run' ? subject.membersByHandle[handle] : undefined
  const memberAnswered =
    subject.kind === 'editor' || watched?.sawStepStarted === true || watched?.outcome !== undefined
  const answeredRef = useRef(memberAnswered)
  answeredRef.current = memberAnswered
  const startFreshRef = useRef<(() => void) | undefined>(undefined)
  startFreshRef.current = subject.kind === 'editor' ? subject.onStartFresh : undefined

  // Every mint carries the token of the request that asked for it, so a stale answer is dropped.
  const requestRef = useRef(0)
  const inFlightRef = useRef(false)
  // The TTL the current mint was issued with, so "less than half of it remains" is answerable.
  const mintedAtRef = useRef<number | undefined>(undefined)
  const ttlRef = useRef<number | undefined>(undefined)
  // When the token the embed holds runs out, and how many renews in a row have failed before then.
  const expiresAtRef = useRef<number | undefined>(undefined)
  const [renewRetry, setRenewRetry] = useState(0)

  const dispatch = useCallback((event: LivePreviewEvent): LivePreviewMachine => {
    const at = Date.now()
    const next = reduceLivePreview(machineRef.current, event, at)
    machineRef.current = next
    setMachine(next)
    setNow(at)
    return next
  }, [])

  /** Drop the mint and discard any answer on its way. */
  const forget = useCallback(() => {
    requestRef.current += 1
    inFlightRef.current = false
    mintedAtRef.current = undefined
    ttlRef.current = undefined
    expiresAtRef.current = undefined
    setRenewRetry(0)
    setMint(undefined)
  }, [])

  const mintFor = useCallback(
    (purpose: MintPurpose) => {
      const token = requestRef.current + 1
      requestRef.current = token
      inFlightRef.current = true
      dispatch({ type: 'mint-started' })
      const asked: Promise<MintAnswer> =
        kind === 'run' ? fetchLiveUrl(subjectId, handle) : fetchEditorLiveUrl(subjectId)
      asked.then(
        (answer) => {
          if (requestRef.current !== token) return
          inFlightRef.current = false
          setRefusal(undefined)
          setRenewRetry(0)
          if (answer.stream.kind === 'none') {
            // A `none` carries nothing to renew, so it arms no re-mint.
            mintedAtRef.current = undefined
            ttlRef.current = undefined
            expiresAtRef.current = undefined
            setMint(undefined)
          } else {
            mintedAtRef.current = Date.now()
            ttlRef.current = Math.max(0, answer.expiresAt - Date.now())
            expiresAtRef.current = answer.expiresAt
            setMint({ liveUrl: answer.liveUrl, expiresAt: answer.expiresAt })
            if (purpose === 'remount') setFrameKey((key) => key + 1)
          }
          dispatch({ type: 'minted', stream: answer.stream, memberAnswered: answeredRef.current })
        },
        (error: unknown) => {
          if (requestRef.current !== token) return
          inFlightRef.current = false
          if (purpose === 'renew') {
            // A failed renew with time left keeps the picture and retries until time runs out.
            const expiresAt = expiresAtRef.current
            if (expiresAt !== undefined && Date.now() < expiresAt) {
              setRenewRetry((count) => count + 1)
              return
            }
            mintedAtRef.current = undefined
            ttlRef.current = undefined
            expiresAtRef.current = undefined
            dispatch({ type: 'renew-failed' })
            return
          }
          mintedAtRef.current = undefined
          ttlRef.current = undefined
          expiresAtRef.current = undefined
          setMint(undefined)
          // The door's own word, kept as an attribute for a reader who needs it; the status says copy.
          const word = error instanceof Error ? error.message : 'live_url_mint_failed'
          setRefusal(word)
          dispatch({ type: 'mint-refused', word })
        },
      )
    },
    [dispatch, kind, subjectId, handle],
  )

  // One subject, one machine. A new subject, a new handle or an ending starts over.
  useEffect(() => {
    if (over) dispatch({ type: 'subject-over', reason: overReason })
    else mintFor('open')
    return () => {
      forget()
      dispatch({ type: 'reset' })
    }
  }, [over, overReason, mintFor, forget, dispatch])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const own = iframeRef.current?.contentWindow
      if (own === undefined || own === null || event.source !== own) return
      const report = parseEmbedReport(event.data)
      if (report === undefined) return
      dispatch({ type: 'embed', report })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [dispatch])

  const view = deriveLivePreview(machine, now)
  const framed = mint !== undefined && FRAME_STATES.has(view.state)
  const renewable = mint !== undefined && RENEWABLE_STATES.has(view.state)
  const reconnectIn = view.state === 'reconnecting' ? view.retryInMs : undefined
  const reconnectAttempt = machine.reconnectAttempts
  const waiting = kind === 'run' && view.state === 'waiting'

  // The status reads a frame's age, so it needs a clock while there is a frame to age.
  useEffect(() => {
    if (!framed) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, CLOCK_TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [framed])

  // Polls only from waiting, never from no-stream, and an unanswered question is not asked again.
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => {
      if (machineRef.current.phase !== 'waiting') return
      setPollTick((tick) => tick + 1)
      if (inFlightRef.current) {
        if (dispatch({ type: 'wait-unanswered' }).phase !== 'waiting') forget()
        return
      }
      mintFor('open')
    }, NO_STREAM_RETRY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [waiting, pollTick, dispatch, forget, mintFor])

  // THE SILENT RE-MINT, AT HALF-LIFE and not at expiry: a capability that expired mid-step would
  // black the frame out, and half the TTL leaves the same margin again for a slow door. After a
  // failed renew it asks again every RENEW_RETRY_MS, and last at the expiry itself.
  useEffect(() => {
    if (!renewable || mint === undefined) return
    const remaining = mint.expiresAt - Date.now()
    const delay = renewRetry === 0
      ? Math.max(0, remaining / 2)
      : Math.max(0, Math.min(RENEW_RETRY_MS, remaining))
    const timer = setTimeout(() => {
      mintFor('renew')
    }, delay)
    return () => {
      clearTimeout(timer)
    }
  }, [renewable, mint, renewRetry, mintFor])

  // A backgrounded tab's timers barely fire, so coming back into view is its own renew trigger.
  useEffect(() => {
    if (!renewable) return
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const mintedAt = mintedAtRef.current
      const ttl = ttlRef.current
      if (mintedAt === undefined || ttl === undefined) return
      if (Date.now() - mintedAt < ttl / 2) return
      mintFor('renew')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [renewable, mintFor])

  // Retry quietly: one fresh mint and a new iframe per backoff step.
  useEffect(() => {
    if (reconnectIn === undefined) return
    dispatch({ type: 'lost-scheduled' })
    const timer = setTimeout(() => {
      mintFor('remount')
    }, reconnectIn)
    return () => {
      clearTimeout(timer)
    }
  }, [reconnectIn, reconnectAttempt, dispatch, mintFor])

  const onAction = (action: LivePreviewAction) => {
    if (action === 'start-fresh') {
      startFreshRef.current?.()
      return
    }
    forget()
    dispatch({ type: 'retry' })
    mintFor('remount')
  }

  const frameSize = view.frameSize
  const ratio = frameSize === undefined || frameSize.width <= 0 || frameSize.height <= 0
    ? { width: 16, height: 9 }
    : frameSize

  const dot = view.dot === undefined ? null : <HealthDot state={view.dot} />
  const action = view.action === undefined ? null : (
    <button
      type="button"
      data-preview-action={view.action}
      onClick={() => {
        if (view.action !== undefined) onAction(view.action)
      }}
      className={`rounded-sm border bg-background px-1.5 py-0.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted ${FOCUS_RING}`}
    >
      {LIVE_PREVIEW_ACTION_LABELS[view.action]}
    </button>
  )

  // The dot never makes a row; with a dot or iframe up, words lead the chrome, else they centre.
  const statusShown = (dot !== null || framed) && (view.words !== undefined || view.snapshot || action !== null)
  const status = statusShown ? (
    <div data-preview-corner className="flex min-w-0 flex-wrap items-center gap-2">
      {view.snapshot && (
        <span data-snapshot-label className="text-xs text-muted-foreground">
          {SNAPSHOT_PREVIEW_LABEL}
        </span>
      )}
      {view.words !== undefined && (
        <span data-preview-words className="text-xs text-foreground">
          {view.words}
        </span>
      )}
      {action}
    </div>
  ) : null

  return (
    <section
      data-live-preview
      data-preview-subject={kind}
      data-preview-state={view.state}
      className="flex h-full min-h-0 flex-col"
    >
      {/* One preview that follows the running member; the host decides the handle. */}
      <PreviewChrome status={status}>{chrome}</PreviewChrome>

      {/* `pt-8` keeps the picture clear of the dot's corner even in a short preview area. */}
      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center [container-type:size]${dot !== null ? ' pt-8' : ''}`}
      >
        {dot !== null && (
          <div data-preview-dot-corner className="absolute right-1 top-1 z-10">
            {dot}
          </div>
        )}
        {framed && mint !== undefined ? (
          // The box takes the picture's own aspect ratio and holds the picture alone.
          <div
            data-preview-frame
            className="max-h-full max-w-full"
            style={{
              aspectRatio: `${String(ratio.width)} / ${String(ratio.height)}`,
              width: `min(100cqw, calc(100cqh * ${String(ratio.width)} / ${String(ratio.height)}))`,
            }}
          >
            <iframe
              key={frameKey}
              ref={iframeRef}
              data-live-embed
              sandbox="allow-scripts"
              src={withHostHint(mint.liveUrl)}
              title="live preview"
              className="size-full border-0"
            />
          </div>
        ) : (
          !statusShown && view.words !== undefined && (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              {/* A sibling, not a child: the sentence is read with exact equality. */}
              {view.label !== undefined && (
                <span
                  data-preview-reason-label
                  className="rounded-sm border border-amber-500/20 bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-500"
                >
                  {view.label}
                </span>
              )}
              <p
                data-preview-sentence
                {...(view.state === 'no-stream'
                  ? { 'data-preview-reason': view.label === undefined ? 'declared' : 'gave-up' }
                  : {})}
                {...(view.state === 'unavailable' && refusal !== undefined ? { 'data-preview-error': refusal } : {})}
                className="text-sm text-muted-foreground"
              >
                {view.words}
              </p>
            </div>
          )
        )}
      </div>
    </section>
  )
}
