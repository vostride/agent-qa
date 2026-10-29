import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { MonitorPlay, XCircle } from 'lucide-react'

import { EmptyState } from '@/components/empty-state'
import { LivePreview } from '@/components/live-preview/live-preview'
import { StepList } from '@/components/live-run/step-list'
import { RetrievalRungBanner } from '@/components/run-detail/retrieval-rung-banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { usePageTitle } from '@/hooks/use-page-title'
import { getRunFaviconState, type RunFaviconState, useRunStatusFavicon } from '@/hooks/use-run-status-favicon'
import { ApiError, cancelRun, classifyRunStreamClose, fetchRun, openRunStream } from '@/lib/api'
import type { RunRow } from '@/lib/api'
import { rungBannerText } from '@/lib/knowledge-view'
import { liveRunLayoutOf, liveRunPanelIds } from '@/lib/live-run-layout'
import { watchedHandleOf } from '@/lib/live-run-watch'
import { routes, type RunDetailNavigationState } from '@/lib/routes'
import {
  createInitialRunStreamState,
  markGap,
  reduceRunStream,
  type RunStreamState,
} from '@/lib/run-stream-reducer'
import { getRunStatusDescriptor, getStatusBadgeClassName } from '@/lib/status'

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

// Moves to run detail on the first `verdict` with `replace`; the band covers ends with no verdict.

const SOURCE_CLOSED = 2

// The range is inclusive, because both ends are envelopes the viewer will not see.
export function gapMarkerText(from: number, to: number): string {
  return `${String(to - from + 1)} events missed (seq ${String(from)}–${String(to)}) — see run detail`
}

/** What the terminal band says beside the verdict. */
export const RUN_ENDED_TEXT = 'run ended'

// The word for a run this process cannot stream any further.
export const RUN_OVER_TEXT = 'this run is over — view run detail'

/**
 * The not-yet probe for a run the door has never heard of, in attempts and in cadence.
 *
 * ~20 s of bounded probing: long enough for a run whose session has not reached the registry to
 * appear, short enough that a link to a long-gone run settles on `this run is over` while the
 * person is still looking at it.
 */
const NOT_YET_ATTACH_RETRY_MS = 2_500
const NOT_YET_ATTACH_LIMIT = 8

export default function LiveRunPage() {
  usePageTitle('Live Run')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [state, setState] = useState<RunStreamState>(createInitialRunStreamState)
  const [attachToken, setAttachToken] = useState(0)
  const [runOver, setRunOver] = useState(false)
  const [fallbackRun, setFallbackRun] = useState<RunRow | null>(null)
  const [runMetaFailed, setRunMetaFailed] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  // Resumes from the reducer's highest `lastSeq`, so an out-of-order delivery never walks it back.
  const resumeRef = useRef<number | undefined>(undefined)
  const stateRef = useRef(state)
  stateRef.current = state
  // Bounded, so the not-yet probe never hammers a door that has settled.
  const notYetAttemptsRef = useRef(0)

  // The page's own width picks docked or stacked; the observer only sets a width, so no loop.
  const [pageRoot, setPageRoot] = useState<HTMLDivElement | null>(null)
  const [pageWidth, setPageWidth] = useState(0)
  useEffect(() => {
    if (!pageRoot) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setPageWidth(entry.contentRect.width)
    })
    observer.observe(pageRoot)
    return () => { observer.disconnect() }
  }, [pageRoot])

  // `state.verdict` is first-verdict-wins, so this effect fires once per run.
  useEffect(() => {
    if (id === undefined || state.verdict === undefined) return
    navigate(
      routes.runDetail(id),
      { replace: true, state: { arrivedOnVerdict: state.verdict } satisfies RunDetailNavigationState },
    )
  }, [id, state.verdict, navigate])

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    setRunMetaFailed(false)
    fetchRun(id)
      .then((data) => { if (!cancelled) setFallbackRun(data.run) })
      .catch(() => {
        // The BUS is the truth on this page. The run row only feeds a title and a link, so a door
        // that cannot answer for it is a notice, never a blocker — the stream is already attached.
        if (!cancelled) setRunMetaFailed(true)
      })
    return () => { cancelled = true }
  }, [id])

  const onEvent = useCallback((envelope: RunEventEnvelope) => {
    const at = Date.now()
    setState((previous) => reduceRunStream(previous, envelope, at))
  }, [])

  useEffect(() => {
    if (id === undefined) return
    let disposed = false

    // Every not-yet re-attach timer this attach armed, cleared with the attach that armed it — a
    // page unmounted mid-probe must not wake up and re-open a socket nobody is watching.
    const pendingTimers: ReturnType<typeof setTimeout>[] = []

    const source = openRunStream(id, {
      // `=== undefined`, never truthiness: seq 0 is a real resume point ("from the very
      // beginning"), and a falsy guard here would silently turn it into "from wherever you like".
      lastEventId: resumeRef.current,
      // At `runFinished` the door closes the stream and the reducer freezes the rows.
      onEvent,
      onError: (_event, errored) => {
        if (disposed) return

        // The browser is retrying this socket itself, with `Last-Event-ID` for free. The page
        // says nothing about it: a retry that works resumes the rows, and one that does not ends
        // in a CLOSED source, which is classified below.
        if (errored.readyState !== SOURCE_CLOSED) return

        // A closed source looks alike whatever closed it, so the page asks the door which.
        if (stateRef.current.terminal) return

        const lastSeq = stateRef.current.lastSeq
        void classifyRunStreamClose(id, { lastEventId: lastSeq }).then((reason) => {
          if (disposed) return
          switch (reason.kind) {
            case 'replay_floor': {
              // The door's own arithmetic: a floor at `earliestAvailableSeq` means everything from
              // `lastSeq + 1` to `earliestAvailableSeq - 1` is gone for good, and the stream can be
              // picked back up by asking for exactly that floor.
              setState((previous) => markGap(previous, lastSeq, reason.earliestAvailableSeq))
              resumeRef.current = reason.earliestAvailableSeq - 1
              setAttachToken((token) => token + 1)
              return
            }
            case 'reattach': {
              resumeRef.current = lastSeq
              setAttachToken((token) => token + 1)
              return
            }
            case 'unknown_run': {
              // `unknown_run` after envelopes is elapsed retention; before any, maybe unregistered.
              if (lastSeq > 0 || notYetAttemptsRef.current >= NOT_YET_ATTACH_LIMIT) {
                setRunOver(true)
                return
              }
              notYetAttemptsRef.current += 1
              const timer = setTimeout(() => {
                if (disposed) return
                setAttachToken((token) => token + 1)
              }, NOT_YET_ATTACH_RETRY_MS)
              pendingTimers.push(timer)
              return
            }
            case 'lost': {
              // The question could not be asked or could not be understood. The run may well
              // still be alive, and run detail is the durable place to find out.
              return
            }
          }
        })
      },
    })

    return () => {
      disposed = true
      for (const timer of pendingTimers) clearTimeout(timer)
      source.close()
    }
  }, [id, attachToken, onEvent])

  const members = useMemo(() => Object.values(state.members), [state.members])

  // The ref holds the last watched handle, so a finished member is held until the next one starts.
  const watchedRef = useRef<number | undefined>(undefined)
  const watchedHandle = watchedHandleOf({ handles: state.handles, members: state.members }, watchedRef.current)
  watchedRef.current = watchedHandle
  const verdictWord = state.verdict ?? fallbackRun?.status ?? 'unknown'
  const verdictDescriptor = getRunStatusDescriptor(verdictWord)

  const faviconState: RunFaviconState = state.verdict === undefined ? 'running' : getRunFaviconState(state.verdict)
  useRunStatusFavicon(id === undefined ? 'default' : faviconState)

  const handleCancel = useCallback(() => {
    if (id === undefined || isCancelling) return
    setIsCancelling(true)
    const toastOptions = { id: `cancel-${id}` }
    cancelRun(id)
      .then((result) => {
        // A stop request is not a cancel; the verdict sets the status.
        if (typeof result.message !== 'string') toast.error('Failed to cancel run', toastOptions)
        else if (result.outcome === 'cancelled') toast.success(result.message, toastOptions)
        else toast.info(result.message, toastOptions)
      })
      .catch((error: unknown) => {
        // Only the 409 refusals are worded for a person.
        const refused = error instanceof ApiError && error.status === 409
        toast.error(refused ? error.message : 'Failed to cancel run', toastOptions)
      })
      .finally(() => { setIsCancelling(false) })
  }, [id, isCancelling])

  if (id === undefined) {
    return <EmptyState icon={MonitorPlay} title="No run selected" description="Select a test run to watch live execution" />
  }

  const title = fallbackRun?.name ?? 'Live Run'
  const isOver = state.terminal || runOver

  // The band shows only when the run ended with no verdict; a verdict has already navigated.
  const bandsTerminal = state.terminal && state.verdict === undefined

  // Named once so the strip's condition and the element inside it cannot come apart.
  const rung = state.retrievalRung

  // Gated on `rungBannerText`, the banner's own predicate, so container and child cannot disagree.
  const rungSentence = rungBannerText(rung === undefined ? undefined : {
    rung: rung.rung,
    ...(rung.reason === undefined ? {} : { reason: rung.reason }),
  })

  // The switch keeps the Group and panel React keys, so the step list and preview are moved.
  const layout = liveRunLayoutOf(pageWidth)
  const panelIds = liveRunPanelIds(layout)
  const stacked = layout === 'stacked'

  const stepsPanel = (
    <ResizablePanel key="steps" id={panelIds.steps} defaultSize={stacked ? '55%' : 40} minSize={stacked ? '20%' : 20}>
      <section data-live-pane="steps" className="flex h-full min-h-0 min-w-[280px] flex-col overflow-y-auto">
        <StepList members={members} steps={state.steps} terminal={state.terminal} />
      </section>
    </ResizablePanel>
  )

  const previewPanel = (
    <ResizablePanel key="preview" id={panelIds.preview} defaultSize={stacked ? '45%' : 60} minSize={stacked ? '25%' : 30}>
      <section data-live-pane="preview" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <LivePreview
          subject={{
            kind: 'run',
            runId: id,
            handle: watchedHandle,
            membersByHandle: state.members,
            terminal: state.terminal,
            runOver,
          }}
        />
      </section>
    </ResizablePanel>
  )

  const handle = <ResizableHandle key="handle" withHandle />

  return (
    <div ref={setPageRoot} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3">
        {/* Title, path, Cancel while running and the run-detail link; nothing about the bus. */}
        <div data-tour-id="tour-live-run-status" className="flex min-w-0 items-center gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold leading-tight">{title}</h2>
            {fallbackRun?.filePath !== undefined && fallbackRun.filePath !== null && (
              <div className="min-w-0 truncate text-xs text-muted-foreground">{fallbackRun.filePath}</div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!isOver && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              disabled={isCancelling}
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
            >
              <XCircle className="size-3.5" />
              {isCancelling ? 'Cancelling...' : 'Cancel'}
            </Button>
          )}
          <Link data-run-detail-link to={routes.runDetail(id)} className="text-xs underline-offset-4 hover:underline">
            view run detail
          </Link>
        </div>
      </div>

      {/* The rung joins the second line, gated on its sentence so `memidex` adds no empty rule. */}
      {(bandsTerminal || runMetaFailed || runOver || state.gap !== undefined
        || rungSentence !== undefined || state.notices.length > 0) && (
        <div data-run-meta-strip className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2 text-xs">
          {bandsTerminal && (
            <div data-terminal-state={verdictDescriptor.normalized} className="flex items-center gap-2">
              <Badge className={getStatusBadgeClassName(verdictDescriptor.tone)}>{verdictDescriptor.label}</Badge>
              <span className="text-muted-foreground">{RUN_ENDED_TEXT}</span>
            </div>
          )}
          {runOver && (
            <p data-run-over className="text-muted-foreground">
              {RUN_OVER_TEXT}
            </p>
          )}
          {state.gap !== undefined && (
            // ONE TEMPLATE STRING, not a run of JSX children. A marker split across text nodes is
            // one reformat away from gaining or losing a space, and this sentence is a published
            // contract two suites read back verbatim.
            <p data-gap-marker className="text-amber-500">
              {gapMarkerText(state.gap.from, state.gap.to)}
            </p>
          )}
          {/*
            AFTER THE GAP MARKER, BEFORE THE NOTICES. The gap says what this VIEWER missed; the rung
            says what the RUN was served on; the notices are the producer's own words. Reading order
            is scope order.
          */}
          <RetrievalRungBanner variant="live" rung={rung?.rung} reason={rung?.reason} />
          {runMetaFailed && (
            <p data-run-meta-unavailable className="text-muted-foreground">
              run details unavailable — the live stream is unaffected
            </p>
          )}
          {state.notices.map((notice, index) => (
            <p key={`${notice.code}:${String(index)}`} data-run-notice={notice.code} className="text-amber-500">
              {notice.message}
            </p>
          ))}
        </div>
      )}

      <ResizablePanelGroup
        key="live-run-panels"
        orientation={stacked ? 'vertical' : 'horizontal'}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {stacked ? [previewPanel, handle, stepsPanel] : [stepsPanel, handle, previewPanel]}
      </ResizablePanelGroup>
    </div>
  )
}
