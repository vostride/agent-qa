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

/**
 * THE HONEST RUN-TIME SURFACE (403 · HNST-01/HNST-02/HNST-03, LIVE-04, INVK-05, D-09..D-13).
 *
 * WHAT THIS PAGE STOPPED DOING. It used to render the whole run-detail apparatus live: a clickable
 * step tree, tab panels over reasoning and console and network, per-step screenshots — all of it
 * fed by the legacy execution-events feed and all of it PROVISIONAL, because a step that has not
 * finalized has no settled answer to give. A person watching it was reading a draft as though it
 * were a record. That apparatus still serves run detail, over durable state, where it is true; it
 * is gone from here.
 *
 * WHAT IT DOES INSTEAD. Two panes and nothing else: a status-only step list off the run event bus,
 * and one embedded live preview of the browser the run is actually driving. What is on screen is
 * either a fact the bus published or a picture of the real thing.
 *
 * THE THREE HONESTY CLAIMS ARE STRUCTURAL, NOT EDITORIAL.
 *  - HNST-01: nothing provisional is reachable because {@link StepList} accepts nothing that could
 *    carry it — the reducer dropped those fields at ingest and the props never name them.
 *  - HNST-02: a status, never a phase word, because the page has no way to know what happens
 *    between two sub-actions and will not guess. Since 428 D-19/D-20 a row carries no count and no
 *    clock either, and since the owner's 2026-09-26 review its running glyph is still;
 *    durations live in run detail.
 *  - HNST-03, AS 428 D-03 LEFT IT: the page makes no claim about the bus channel at all. There is
 *    no liveness pill and no pulsing icon; a dead bus shows as rows that stop advancing, and the
 *    facts the page does state (the gap marker, the terminal band, the run-over sentence) come
 *    from the stream's own envelopes and the door's classification of a close.
 *
 * AND AT THE END IT MOVES WITH THE RUN (2026-08-26, Phase 404 · LIFE-01, D-13/D-14 — this
 * paragraph replaces 403's D-12 "it does not navigate", which deferred the decision to the phase
 * that owns verdict-exactly-once against a run-detail page 405 had not yet rebuilt; both are now
 * true, so the deferral is spent).
 *
 * THE TRIGGER IS THE `verdict` ENVELOPE, NOT `runFinished`. The verdict is the moment the run's
 * answer exists; `runFinished` comes after the post-verdict step, which D-10 says never gates
 * anything a person sees. Navigating on the later one would tie a person's screen to a lease
 * consult and a durable enqueue. The reducer takes the FIRST verdict and drops any second
 * so the effect below keyed on that field fires exactly once per run.
 *
 * AND IT REPLACES HISTORY. Back returns to wherever the person came from — never to a live page
 * whose socket the door has already closed, which is a screen that would immediately move them
 * forward again. The arrival carries ONE field of navigation state, `arrivedOnVerdict`, which is
 * the only thing run detail cannot work out for itself: the run row's status is written by the
 * dashboard subscriber at the SAME envelope, so a `fetchRun` a millisecond later may still read
 * `running` and would otherwise bounce the viewer straight back here.
 *
 * THE TERMINAL BAND SURVIVES AS THE HONEST FALLBACK, rendered on exactly the paths where
 * navigation CANNOT happen — a `runFinished` observed with no verdict at all (a malformed
 * producer), and a close the door classifies past the end of its retention window, where the
 * replay delivers no verdict to move on. A page that deleted the band would show a run that ended
 * without a verdict nothing whatsoever. `state.verdict` is read FIRST in both arms: if a replay
 * delivered one, the navigation fires and the band is moot.
 */

const SOURCE_CLOSED = 2

/**
 * D-13's visible gap, in words. The bus never silently truncates and neither does this page: a
 * step that flips `pending` → `failed` with no visible reason is the failure the marker exists to
 * refuse, and the range is inclusive on both ends because both ends are envelopes nobody will see.
 */
export function gapMarkerText(from: number, to: number): string {
  return `${String(to - from + 1)} events missed (seq ${String(from)}–${String(to)}) — see run detail`
}

/** What the terminal band says beside the verdict. */
export const RUN_ENDED_TEXT = 'run ended'

/** D-15's word for a run this process can no longer stream. */
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

  // The resume point for the NEXT attach. Read from the reducer's `lastSeq` (the HIGHEST seq seen)
  // rather than tracked here off render order: a resume point that walked backward on an
  // out-of-order delivery would re-open a gap this viewer had already been served.
  const resumeRef = useRef<number | undefined>(undefined)
  const stateRef = useRef(state)
  stateRef.current = state
  // How many times this page has re-attached to a run the door does not know about YET. Bounded,
  // so D-15's refusal to hammer a settled door survives the not-yet probe below.
  const notYetAttemptsRef = useRef(0)

  // the page's own inline size decides docked or stacked. 0 until the observer reports,
  // and an unmeasured page is docked. The observer only sets a width; the layout is a pure function
  // of it, so it cannot feed back into the size it measures.
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

  // D-13. THE RUN ANSWERED, SO THE VIEWER MOVES TO THE RECORD OF IT — see the header block for
  // why this keys on `verdict` and not on `runFinished`, and why the history entry is REPLACED.
  // `state.verdict` is first-verdict-wins in the reducer, so this effect's dependency cannot
  // change twice for one run and cannot fire twice.
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
      // D-12. At `runFinished` the door closes the stream on its own terms and the reducer
      // freezes the rows; there is nothing left to attach to and nothing to classify.
      onEvent,
      onError: (_event, errored) => {
        if (disposed) return

        // The browser is retrying this socket itself, with `Last-Event-ID` for free. The page
        // says nothing about it: a retry that works resumes the rows, and one that does not ends
        // in a CLOSED source, which is classified below.
        if (errored.readyState !== SOURCE_CLOSED) return

        // A CLOSED source is one wordless event standing for three different situations, so the
        // page asks the door which one it was rather than guessing from `readyState`.
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
              // D-15, AND THE NOT-YET RUN IT USED TO SWALLOW (403-07, gap 1 arm 2).
              //
              // `unknown_run` is one word for two situations, and the discriminator is whether
              // this page has ever heard ANYTHING about the run. A page that has folded envelopes
              // and is now told the run is unknown has watched its retention elapse — retrying
              // would hammer a door that has already given its final answer, so D-15 stands and
              // the durable record is the honest destination. A page that has heard NOTHING yet
              // (`lastSeq === 0`) may simply have arrived before the session reached the registry,
              // which is the ordinary flow: every trigger surface navigates here the instant the
              // run id exists. Latching `this run is over` there is the same lie the preview pane
              // used to tell, one channel across — and it is worse, because it takes the whole
              // page down with it.
              //
              // THE PROBE IS BOUNDED, which is what keeps D-15's argument intact: a run that never
              // appears costs a fixed, short handful of attaches and then reads `over` for good.
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

  // THE PREVIEW FOLLOWS THE RUNNING MEMBER (G-428-3, owner decision 2026-09-26 (3)). Nobody picks a
  // handle: it is derived from the reduced stream, and the ref carries the last one watched so the
  // rule can keep a running member and hold a finished one until the next member starts.
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
        // a stop request is not a cancel; the verdict sets the status.
        if (typeof result.message !== 'string') toast.error('Failed to cancel run', toastOptions)
        else if (result.outcome === 'cancelled') toast.success(result.message, toastOptions)
        else toast.info(result.message, toastOptions)
      })
      .catch((error: unknown) => {
        // only the 409 refusals are worded for a person.
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

  // D-14, AND THE WHOLE OF WHY THE BAND IS NOT DEAD CODE. The band is what this page has to say
  // when it CANNOT move the viewer to the record: `runFinished` landed and no verdict ever did.
  // With a verdict the effect above has already navigated, and painting "run ended, stay put" in
  // the same tick would be the page contradicting itself. `runOver` — the door classified the
  // close past the end of its retention window — renders its own sentence just below, on the same
  // no-verdict reasoning.
  const bandsTerminal = state.terminal && state.verdict === undefined

  // The rung the FIRST evidence-carrying frame reported, if one has arrived. Named
  // here rather than read twice in the JSX below, so the strip's visibility condition and the
  // element inside it can never come apart.
  const rung = state.retrievalRung

  // THE SENTENCE, NOT THE VALUE (407-16 · REVIEW WR-01). `rungBannerText` is the SAME function
  // `RetrievalRungBanner` calls to decide whether it renders at all, so gating the container on
  // its result makes container and child structurally incapable of disagreeing. Reading the
  // banner's own predicate here is the point: any future silence the banner learns (a new top
  // rung, a new absent case) closes the strip with it, with nothing to keep in sync by hand.
  const rungSentence = rungBannerText(rung === undefined ? undefined : {
    rung: rung.rung,
    ...(rung.reason === undefined ? {} : { reason: rung.reason }),
  })

  // THE TWO ARRANGEMENTS (428 D-06, 426-11's idiom). Below 768 px the preview goes on top at full
  // width and the step list scrolls beneath it; otherwise the steps sit beside the preview as
  // before. The switch changes the Group's orientation, the panels' ids and their order, and never
  // the Group's key. The panels keep stable React keys, so React MOVES them rather than remounting
  // them: the step list and the preview component survive the switch. A real browser does reload
  // an iframe whose node moves; the embed reconnects by itself with its still-valid fragment token.
  // Docked sizes are the ones this page always had; stacked sizes are percentages of the height.
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
        {/*
          THE HEADER IS FOUR THINGS: the title and the file path here, Cancel while the
          run is running and the link to run detail on the right. The product tour's live-run
          anchor sits on this title group, so the tour step points at the name of the run being
          watched. Nothing here pulses or speaks about the bus channel.
        */}
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

      {/*
        THE HEADER'S SECOND LINE, AND THE RUNG JOINS IT RATHER THAN OPENING A PANE.
        403's two-pane rule is not negotiable here: the strip already exists, it already wraps, and
        a run whose retrieval was degraded has one more short sentence to say — not a third region.
        The rung is in the visibility condition on its own, because it can be the ONLY thing the
        strip has to say on an otherwise healthy, ungapped, still-running stream.

        BUT AS A SENTENCE, NOT AS A VALUE (407-16 · REVIEW WR-01). `memidex` is a perfectly
        defined rung with nothing to say — it is the TOP rung, so the banner renders null for it.
        Gating on the value's presence therefore opened this bordered rule, empty, under the
        header of every healthy live run the moment its first `stepFinalized` frame landed: a
        visible line the page had no statement to put on. The condition reads the banner's own
        predicate (`rungSentence`) instead, so the container opens exactly when some child will
        speak. A strip with nothing to say is not rendered.
      */}
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
