// THE SHARED LIVE PREVIEW: one mint, one sandboxed embed, one status light.
//
// Both entry points render this component: a run (the active run page) and an editor session
// (Test → Live and the suite editor, Plan 18). It mints for its subject, embeds the served embed
// page in an iframe, listens to the closed-set facts that page posts, runs the pure machine in
// lib/live-preview.ts and draws the status.
//
// THE DOT IS THE CONTAINER'S STATUS LIGHT (owner decision 2026-09-26 (4), G-428-4). It leads the
// preview's chrome row, at the container's top-left, with the snapshot label, the words and the one
// action beside it, ahead of any host toolbar. Nothing is drawn over the tested page's pixels: the
// picture's box holds the iframe alone. This supersedes D-02's dot on the frame's top-right corner.
//
// THE TOKEN IS THE REASON FOR THE SANDBOX. The minted liveUrl carries a short-lived capability in
// its fragment. It lives in this component's state and the iframe's src, and nowhere else: it is
// never logged and never written to the page URL. The frame is sandboxed to scripts alone, with
// the same-origin escape withheld, so the embedded document sits in an opaque origin and cannot
// read this document or its storage.
//
// THE BRIDGE TRUSTS IDENTITY, NOT ORIGIN (Q-BRIDGE). The embed's origin is the string 'null' by
// construction, so the only check that means anything is that the event's source is this
// component's own iframe window. What passes is rebuilt by parseEmbedReport from closed sets, and
// no posted string is ever rendered: the status speaks only in this package's copy constants.
//
// RENEW IN PLACE, RECONNECT BY REMOUNT (RESEARCH P8). The silent half-life re-mint changes only
// the fragment of the same iframe, which the embed hears as a hashchange on a live socket. A dead
// socket never hears a hashchange, so a reconnect is a fresh mint and a new iframe element.
//
// NOT YET IS NOT NO. A member whose browser is not up yet answers `none`; the preview
// keeps asking every NO_STREAM_RETRY_MS, and the machine bounds that wait.

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
  /**
   * The handle to watch, decided by the host. The preview follows the running member, which
   * the host derives from the run stream; a new handle starts the preview over with a mint for it.
   */
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
  // A new key is a new iframe element, which is what a reconnect needs (P8).
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
            // A renew that fails while the embed's token still has time left (a network blip, a
            // 500) keeps the picture and asks again; the link has expired only once it has run out
            // The embed's own `refused: expired` says the same thing sooner.
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

  // THE NOT-YET POLL (403-07, gap 1). It fires only from waiting: firing from no-stream would poll
  // through a declared absence and turn the sentence into a flicker. An unanswered question is not
  // asked again, because a new token would discard the answer on its way; the interval it spent
  // still counts toward the bound, and at the bound the answer on its way is discarded.
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

  // THE STATUS IS SAID ONCE. The dot floats alone at the container's top-right and never makes a row
  // (owner decision 2026-09-26 (6)). With a dot or an iframe up, any words, label or action lead the
  // chrome; otherwise the words are a dot-less sentence in the middle of the pane.
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
      {/*
        One preview, which follows the running member (owner review 2026-09-26), never a grid.
        The handle selector this row used to hold is gone; the host decides the handle.
        The status words lead the row at the container's top-left (owner decision 2026-09-26 (4)).
      */}
      <PreviewChrome status={status}>{chrome}</PreviewChrome>

      {/*
        The dot's corner is reserved above the picture: the dot's box ends 28px below the area's top,
        and pt-8 keeps 4px clear, so a short area cannot centre the picture under it (G-433-7: at
        400x800 the narrow navigation row left the preview area 301px tall and the picture met the dot).
      */}
      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center [container-type:size]${dot !== null ? ' pt-8' : ''}`}
      >
        {dot !== null && (
          <div data-preview-dot-corner className="absolute right-1 top-1 z-10">
            {dot}
          </div>
        )}
        {framed && mint !== undefined ? (
          // THE BOX TAKES THE PICTURE'S OWN ASPECT RATIO (P10), and it holds the picture alone.
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
