import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { useRecordingDurations } from '@/hooks/use-recording-durations'
import { useParams, useNavigate, useSearchParams, useLocation } from "react-router"
import { routes, arrivedOnVerdictFrom, VERDICT_ROW_CATCH_UP_MAX, VERDICT_ROW_CATCH_UP_MS } from "@/lib/routes"
import { toast } from "sonner"
import { FileSearch, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ResizablePanelGroup, ResizablePanel, ResizableHandle,
} from "@/components/ui/resizable"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { DetailSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { useOptionalProductTour } from "@/components/product-tour"
import { RunNavbar } from "@/components/run-detail/run-navbar"
import { ArtifactDrawer, type ArtifactDrawerTab } from "@/components/run-detail/artifact-drawer"
import { StepTree } from "@/components/run-detail/step-tree"
import { FailureBanner } from "@/components/run-detail/failure-banner"
import { TabPanels } from "@/components/run-detail/tab-panels"
import { FeedbackComposer } from "@/components/run-detail/feedback-composer"
import { useRunFeedback } from "@/hooks/use-run-feedback"
import { feedbackDefaultLayout, feedbackLayout, feedbackPanelIds, type FeedbackLayout } from "@/lib/feedback-view"
import { useGroupRef } from "react-resizable-panels"
import { initialPlayerSource, storePlayerSource } from "@/lib/player-view"
import { PlayerLightbox } from '@/components/run-detail/player-lightbox'
import { buildSuiteTimeline, suiteSeek, suiteProgress, suiteClock } from '@/lib/suite-timeline'
import { Timeline } from '@/components/run-detail/timeline'
import type { ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import { fetchRun, fetchRunAnalysis, fetchRunDetail, fetchRunKnowledge, triggerRun, RunDeniedError, fetchExecutionLogs, fetchRunArtifact, watchPostProcessing, markRun } from "@/lib/api"
import type { RunRow, ExecutionLogEntry, RunArtifactResponse, KnowledgeRead, PostProcessingRead } from "@/lib/api"
import type { AnalysisGetOutput, RunDetailProjection, RunDetailSubAction } from "@vostride/agent-qa-schema"
import {
  MEMBER_FILTER_ALL,
  RUN_DETAIL_UNAVAILABLE_LABEL,
  filterGroups,
  groupRunDetail,
  memberDisplayName,
  memberHandleLabel,
  parseMemberFilter,
  showMemberChrome,
} from "@/lib/run-detail-view"
import { projectPostProcessingView } from "@/lib/post-processing-view"
import { bannerRung, projectKnowledgeView, type StepAddress, type StepRefContext } from "@/lib/knowledge-view"
import { projectAnalysisView, type OnMark, type MarkDenial } from "@/lib/analysis-view"
import { runStatusClass, shouldRouteRunToLive } from "@/lib/status"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { RunNotice } from '@/components/run-detail/run-notice'
import { isPreMilestoneRun } from '@/lib/run-notice-view'
import { usePageTitle } from "@/hooks/use-page-title"
import { getRunFaviconState, useRunStatusFavicon } from "@/hooks/use-run-status-favicon"
import { hasStepId, isSubactionSelection, runDetailStepKey, type Selection } from "@/lib/selection"
import { displayStepsForGroups, type DisplayStep } from "@/lib/display-step"
import { buildTimelineModel, findMarkerBySha, latestUsableFrame, type PlayerSource, parkTargetForStep, playheadFromSelection, selectionFromPlayhead, type Playhead } from '@/lib/playhead'

const TAB_NAMES = ['overview', 'env', 'network', 'console', 'aria', 'a11y', 'knowledge'] as const

function tabFromUrl(searchParams: URLSearchParams): string {
  const tab = searchParams.get('tab')
  return TAB_NAMES.find(name => name === tab) ?? 'overview'
}

/**
 * Which step a link is pointing at (405-08 · D-16).
 *
 * `?step=` NOW CARRIES THE MEMBER-SCOPED KEY `<testIndex>:<stepIndex>`, the same string the tree
 * selects by. Until 405-08 it carried a bare step ordinal disambiguated by `?run=<childRunId>` —
 * the child run id came from the parent/child walk this plan deleted, and a bare ordinal on a
 * multi-member run names one row per member.
 *
 * A KEY THAT NAMES NO RENDERED STEP FALLS BACK TO THE FIRST ONE (T-405-25). The param is
 * hand-editable, and it can also point at a member the current `?member=` filter narrowed away —
 * both land the viewer at the top of the tree they can see, never on a blank panel.
 */
function getSelectionFromUrlOrFirst(
  displaySteps: DisplayStep[],
  searchParams: URLSearchParams,
): Selection | null {
  const urlStepKey = searchParams.get("step")
  const urlSubIndex = searchParams.get("sub")

  if (urlStepKey) {
    const targetStep = displaySteps.find((step) => step.id === urlStepKey)
    if (targetStep) {
      if (urlSubIndex != null) {
        const subIndex = /^\d+$/.test(urlSubIndex) ? Number(urlSubIndex) : NaN
        if (!Number.isSafeInteger(subIndex) || !targetStep.subActions?.some(sub => sub.subActionIndex === subIndex)) return null
        return { type: "subaction", stepId: targetStep.id, subIndex }
      }
      return { type: "step", stepId: targetStep.id }
    }
  }

  if (displaySteps.length > 0) {
    return { type: "step", stepId: displaySteps[0].id }
  }

  return null
}

function scrollElementIntoContainerView(container: HTMLElement, element: HTMLElement) {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const padding = 12
  const topEdge = containerRect.top + padding
  const bottomEdge = containerRect.bottom - padding

  if (elementRect.top >= topEdge && elementRect.bottom <= bottomEdge) return

  const nextTop =
    elementRect.top < topEdge
      ? container.scrollTop + (elementRect.top - topEdge)
      : container.scrollTop + (elementRect.bottom - bottomEdge)

  const top = Math.max(0, nextTop)

  if (typeof container.scrollTo === "function") {
    container.scrollTo({
      top,
      behavior: "smooth",
    })
    return
  }

  container.scrollTop = top
}


export function isTimelineKeyIgnored(event: KeyboardEvent): boolean {
  return !(event.target instanceof Element) || event.target.closest(
    'button, [role="tablist"], [role="radiogroup"], [role="tree"], [role="dialog"]:not([data-state="closed"]), dialog[open]',
  ) !== null
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  // D-07. The one thing this page cannot work out from the run row: whether the viewer arrived
  // here BECAUSE the live page just watched this run's verdict land. Written by `live-run.tsx`,
  // read structurally, `undefined` for anything that is not the shape. See the loader below.
  const arrivedOnVerdict = arrivedOnVerdictFrom(location.state)
  const [searchParams, setSearchParams] = useSearchParams()
  const productTour = useOptionalProductTour()
  const recordRunDetailStatus = productTour?.recordRunDetailStatus

  const [run, setRun] = useState<RunRow | null>(null)
  const runTitle = run ? `Run - ${run.name}` : "Run"
  usePageTitle(runTitle)
  useRunStatusFavicon(getRunFaviconState(run?.status))
  // THE PAGE'S ONE DURABLE READ (D-03/D-16). `undefined` = not asked yet; `null` = the read
  // FAILED. Those are different facts and the tree renders them differently: an unasked page is
  // still loading, a failed read is an error posture, and an empty projection is a run that
  // genuinely recorded nothing. Collapsing any two of them would make a server fault look like a
  // quiet test.
  const [detail, setDetail] = useState<RunDetailProjection | null | undefined>(undefined)
  const [markDenial, setMarkDenial] = useState<MarkDenial & { testIndex: number; stepIndex?: number }>()
  const [markPending, setMarkPending] = useState(false)
  const markingRef = useRef<object | undefined>(undefined)
  const markGeneration = useRef(0)
  const markRunRef = useRef(id)
  useEffect(() => {
    markGeneration.current += 1
    markRunRef.current = id
    markingRef.current = undefined
    setMarkPending(false)
    setMarkDenial(undefined)
    setDetail(undefined)
    return () => { markRunRef.current = undefined; markGeneration.current += 1 }
  }, [id])

  const reloadDetail = useCallback(async (generation = markGeneration.current) => {
    if (!id) return undefined
    const projection = await fetchRunDetail(id)
    if (markRunRef.current !== id || markGeneration.current !== generation) return undefined
    if (projection.runId === id) setDetail(projection)
    return projection
  }, [id])

  const onMark = useCallback<OnMark>(async (testIndex, stepIndex, kind, note) => {
    if (!id || detail?.runId !== id) return 'stale'
    if (markingRef.current) return 'retained'
    const member = detail.members.find(entry => entry.testIndex === testIndex)
    if (member?.marks === undefined) return 'retained'
    const address = { testIndex, ...(stepIndex === undefined ? {} : { stepIndex }) }
    // The wire addresses members by testId. Never silently mark a different member when a
    // suite has no unique testId for the selected row.
    if (detail.members.length > 1 && (!member.testId || detail.members.filter(entry => entry.testId === member.testId).length !== 1)) {
      setMarkDenial({ ...address, reason: 'This member has no unique mark address.' })
      return 'retained'
    }
    const request = {}
    const generation = markGeneration.current
    const isCurrent = () => markRunRef.current === id && markGeneration.current === generation && markingRef.current === request
    markingRef.current = request
    setMarkPending(true)
    setMarkDenial(undefined)
    try {
      const outcome = await markRun(id, {
        kind,
        ...(member.testId ? { testId: member.testId } : {}),
        ...(stepIndex === undefined ? {} : { stepIndex }),
        ...(note ? { note } : {}),
      })
      if (!isCurrent()) return 'stale'
      if (outcome.kind === 'marked' || outcome.kind === 'already-marked') {
        const projection = await reloadDetail(generation)
        if (!isCurrent()) return 'stale'
        const addressed = projection?.runId === id
          ? projection.members.find(entry => entry.testIndex === testIndex && entry.testId === member.testId)
            ?.marks?.find(entry => entry.stepIndex === stepIndex)
          : undefined
        if (addressed?.markId === outcome.receipt.markId && addressed.ordinal === outcome.receipt.ordinal && addressed.kind === outcome.receipt.kind && addressed.kind === kind) return 'refreshed'
        setMarkDenial({ ...address, reason: 'The matching mark receipt could not be refreshed. Reload this run before trying again.' })
      } else {
        setMarkDenial({ ...address, reason: `Mark refused: ${outcome.kind}.` })
      }
      return 'retained'
    } catch (error) {
      if (!isCurrent()) return 'stale'
      setMarkDenial({ ...address, reason: 'Could not complete the mark or refresh its receipt. Reload this run before trying again.' })
      return 'retained'
    } finally {
      if (isCurrent()) {
        markingRef.current = undefined
        setMarkPending(false)
      }
    }
  }, [id, detail, reloadDetail])

  // D-10: the page's own inline size decides docked or stacked. 0 until the observer reports, and an
  // unmeasured page is docked.
  const [pageRoot, setPageRoot] = useState<HTMLDivElement | null>(null)
  const [pageWidth, setPageWidth] = useState(0)
  useEffect(() => {
    if (!pageRoot) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry) setPageWidth(entry.contentRect.width)
    })
    observer.observe(pageRoot)
    return () => observer.disconnect()
  }, [pageRoot])
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const pipelineRef = useRef<ReasoningPipelineHandle | null>(null)
  const stepTreeScrollRef = useRef<HTMLDivElement | null>(null)
  const skippedInitialDefaultSelectionRef = useRef<string | null>(null)

  const [selection, setTreeSelection] = useState<Selection | null>(null)
  const [playheadTarget, setPlayheadTarget] = useState<Playhead | null>(null)
  const [seekFraction, setSeekFraction] = useState<number>()
  const [seekRevision, setSeekRevision] = useState(0)
  const [observedPosition, setObservedPosition] = useState<number>()
  const [timelineMemberIndex, setTimelineMemberIndex] = useState<number>()
  const [continueMember, setContinueMember] = useState<number>()
  const setSelection = useCallback((next: Selection | null) => {
    setTreeSelection(next)
    setTimelineMemberIndex(undefined)
    setContinueMember(undefined)
    setObservedPosition(undefined)
    setPlayheadTarget(null)
    setSeekFraction(undefined)
  }, [])
  const setPlayheadFrom = useCallback((address: Playhead) => {
    const next = selectionFromPlayhead(address)
    if (!hasStepId(next)) return
    setTreeSelection(next)
    setTimelineMemberIndex(undefined)
    setContinueMember(undefined)
    setObservedPosition(undefined)
    setPlayheadTarget(address)
    setSeekFraction(undefined)
  }, [])
  const [allExecutionLogs, setAllExecutionLogs] = useState<ExecutionLogEntry[]>([])

  // THE CHIP CLIENT LIVES HERE, NOT IN THE HEADER (404-07, D-20 / 400 D-13). The navbar is
  // presentational: it takes a view and paints it. A header that fetched for itself would open one
  // client per mount of a component that remounts, and would be a second answer to "what does this
  // page know about this chain". The raw READ is what is held — the projection is pure and total,
  // so re-deriving it on render costs nothing and keeps exactly one copy of the mapping.
  const [postProcessingRead, setPostProcessingRead] = useState<PostProcessingRead | undefined>(undefined)

  // THE KNOWLEDGE TAB'S OWN READ (407-02 · LERN-01, D-05). The page owns the client and the tab is
  // presentational, on the chip read's footing above: a tab that fetched for itself would open one
  // client per remount of a component the tab strip remounts. Held RAW because
  // `projectKnowledgeView` is pure and total — re-deriving it costs nothing and keeps exactly one
  // copy of the mapping. `undefined` is "the first read has not landed", which is the tab's
  // `loading` state and is deliberately not a member of the projection's own union.
  const [knowledgeRead, setKnowledgeRead] = useState<KnowledgeRead | undefined>(undefined)

  // THE FAILURE VIEW'S OWN READ (406-01 · DETL-04, D-03/D-04). Held raw, like the chip read above,
  // because `projectAnalysisView` is pure and total — re-deriving it on render costs nothing and
  // keeps exactly one copy of the join.
  const [analysis, setAnalysis] = useState<AnalysisGetOutput | undefined>(undefined)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [artifactDrawerOpen, setArtifactDrawerOpen] = useState(false)
  const [artifactDrawerTab, setArtifactDrawerTab] = useState<ArtifactDrawerTab>("test")
  const [lightboxSha, setLightboxSha] = useState<string | null>(null)
  const [pendingCitationSha, setPendingCitationSha] = useState<string | null>(null)
  const citationOpener = useRef<HTMLElement | null>(null)
  useEffect(() => { setLightboxSha(null) }, [id])
  const [artifactResponse, setArtifactResponse] = useState<RunArtifactResponse | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const artifactLoadedRunIdRef = useRef<string | null>(null)
  const artifactRequestRef = useRef(0)

  const [activeTab, setActiveTab] = useState<string>(() => tabFromUrl(searchParams))

  useEffect(() => {
    if (!run?.status) return
    recordRunDetailStatus?.(run.status)
  }, [recordRunDetailStatus, run?.status])

  // One read now, a 3 s poll while the chain is still moving, and the dedicated stream's frames as
  // triggers to read again — all of it inside `watchPostProcessing`. The page's whole part is to
  // subscribe for the id it was asked for, forget the previous run's answer when that id changes,
  // and hand back the disposer so nothing outlives the screen it was for.
  useEffect(() => {
    if (!id) return
    setPostProcessingRead(undefined)
    return watchPostProcessing(id, { onRead: setPostProcessingRead })
  }, [id])

  // THE CHIP WORD, AND NOTHING ELSE OFF THE FRAME (D-03, 404 D-17 applied a second time). A pushed
  // `watchPostProcessing` frame is a TRIGGER: it says the durable answer may have moved. Nothing a
  // frame carries is ever painted into a member's block — only `fetchRunAnalysis`'s result is.
  const analysisChip = postProcessingRead?.kind === 'read'
    ? postProcessingRead.status.chips.analysis
    : undefined

  // RE-READ ON EVERY TRANSITION OF THAT WORD, AND ON NO OTHER FRAME. The dependency list IS the
  // D-03 rule: `pending → running → done | failed` each move the value and re-run this effect,
  // while a repeated frame carrying the same word does not. No new socket, no new timer.
  //
  // A REJECTED READ LEAVES THE PREVIOUS ANSWER IN PLACE. Clearing on failure would blank a
  // sentence the reader is looking at because one poll hiccuped; the honest state of a failed
  // re-read is the last answer the op actually gave.
  //
  // ...BUT ONLY FOR THE RUN IT WAS AN ANSWER ABOUT (CR-02, measured 2026-08-29). The route is
  // `/runs/:id`, so a move from run A to run B changes the param WITHOUT remounting this page,
  // and `projectAnalysisView` joins on `perTest` / `testIndex` — an integer both runs have. So a
  // held answer does not go stale visibly; it JOINS, painting run A's sentence, provenance,
  // confidence, cited steps and cited artifact shas under run B's members. And the rejection rule
  // above made it permanent for the ordinary case, because the read answers 404 for a run with no
  // handoff: navigating from a run WITH an analysis to one WITHOUT left A's sentences on B's page
  // indefinitely, including this door's RESTORED secret values attributed to the wrong test.
  //
  // The sibling read above forgets the previous run on an id change for exactly this reason; the
  // same rule applies here.
  useEffect(() => { setAnalysis(undefined) }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void fetchRunAnalysis(id).then(
      // THE ANSWER MUST BE ABOUT THE RUN ON SCREEN. The reset above closes the in-flight window;
      // this closes the one an in-flight answer for the previous run would otherwise slip
      // through. Two guards, each documenting a different way the join goes silently wrong.
      (result) => { if (!cancelled && result.runId === id) setAnalysis(result) },
      () => { /* the previous answer FOR THIS RUN stands — a rejected fetch is not a paint input */ },
    )
    return () => { cancelled = true }
  }, [id, analysisChip])

  useEffect(() => {
    if (!id) return

    skippedInitialDefaultSelectionRef.current = null

    let cancelled = false
    let retryCount = 0
    // The bounded row catch-up below, so the effect's own teardown can disarm it. A page that
    // unmounted mid-catch-up and still woke up to fetch would be a request for a screen nobody
    // is looking at.
    let catchUpAttempts = 0
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined

    async function loadRun() {
      try {
        const data = await fetchRun(id!)
        if (cancelled) return

        // THE BOUNCE, RE-KEYED (2026-08-26, Phase 404 · D-07, T-404-15).
        //
        // WHAT THIS REPLACED. Until 404 the loader began by reading `/api/execution/active` and
        // bounced to `/live` for any run in that set. D-07 retires that reading: an execution
        // stays "active" until its POST-RUN TAIL finishes, and the tail runs after the verdict —
        // so a viewer whom the live page had just moved here on the verdict (D-13) was thrown
        // straight back to `/live`, which navigated them here again. A ping-pong nobody can click
        // their way out of, for as long as curation takes.
        //
        // THE PREDICATE IS NOW THE ROW'S OWN STATUS, which the dashboard subscriber writes at the
        // `verdict` envelope. One producer, one fact.
        const rowIsLive = shouldRouteRunToLive(data.run.status)
        if (rowIsLive && arrivedOnVerdict === undefined) {
          navigate(routes.runLive(id!), { replace: true })
          return
        }

        setRun(data.run)

        // AND THE RACE THE PREDICATE CANNOT SEE. `updateRun` at `verdict` and this `fetchRun`
        // race by design — D-13 navigates on the ENVELOPE, the earliest honest moment, and the
        // durable row follows within milliseconds. An arrival carrying `arrivedOnVerdict` never
        // bounces on any attempt; it renders the row it got and re-asks on a bounded cadence
        // until the row reads terminal, so the header badge follows the row rather than freezing
        // on a stale `running`.
        if (rowIsLive && catchUpAttempts < VERDICT_ROW_CATCH_UP_MAX) {
          catchUpAttempts += 1
          catchUpTimer = setTimeout(() => { if (!cancelled) void loadRun() }, VERDICT_ROW_CATCH_UP_MS)
        }

        // ONE DURABLE READ, AND ONLY ONE (D-03/D-16). What stood here until 405-08 was a walk:
        // read the parent, then read every child run in a loop for its steps, then read the last
        // attempt again for ITS steps — N+2 requests to draw one page, each of them able to fail
        // on its own and silently drop a member (the `catch { // skip }` that used to sit in that
        // loop). `runs.detail` answers the whole run in one unpaged projection, so a member that
        // did not run arrives as a row rather than as an absence nobody noticed.
        //
        // A FAILED READ IS ITS OWN STATE, not a bounce and not an empty tree. The run row already
        // rendered above, so the header, the verdict and the failure banner stay; only the tree
        // says it could not be loaded.
        try {
          const projection = await reloadDetail()
          if (cancelled) return
          if (projection === undefined) return
          const groups = filterGroups(
            groupRunDetail(projection),
            parseMemberFilter(searchParams.get("member")),
          )
          setSelection(getSelectionFromUrlOrFirst(displayStepsForGroups(groups), searchParams))
        } catch {
          if (cancelled) return
          setDetail(null)
          setSelection(null)
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof Error && err.message.includes("404")) {
          if (retryCount < 5) {
            retryCount++
            setTimeout(() => { if (!cancelled) loadRun() }, 1000)
            return
          }
          setNotFound(true)
        } else {
          toast.error("Failed to load run")
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadRun()
    return () => {
      cancelled = true
      if (catchUpTimer !== undefined) clearTimeout(catchUpTimer)
    }
  }, [id, navigate, arrivedOnVerdict])

  useEffect(() => {
    if (!id || isLoading) return
    let cancelled = false
    fetchExecutionLogs(id)
      .then(({ logs }) => {
        if (!cancelled) setAllExecutionLogs(logs)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id, isLoading])

  // ONE READ FOR THE WHOLE KNOWLEDGE TAB (407-02 · D-03/D-05). Not a poll and not a subscription:
  // a run's served brief is a durable fact about a run that already happened, so it is read once
  // per id and never again. The Learned half moves with curation, which the chip read already
  // watches; 407-09 spends that trigger rather than adding a second timer here.
  //
  // A REJECTED READ IS A STATE, NOT A SWALLOWED ERROR. `runs.knowledge` answers its own absences
  // as RESULTS — a pruned handoff and a project with no store both arrive on the `read` arm — so
  // the only thing reaching the catch is a door that refused or fell over, and the tab says so
  // (D-06). Clearing to `undefined` would show a skeleton forever for a read that already failed.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    setKnowledgeRead(undefined)
    fetchRunKnowledge(id)
      .then(projection => {
        if (!cancelled) setKnowledgeRead({ kind: 'read', projection })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setKnowledgeRead({ kind: 'unavailable', error: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => { cancelled = true }
  }, [id])

  const knowledgeView = useMemo(
    () => (knowledgeRead === undefined ? undefined : projectKnowledgeView(knowledgeRead)),
    [knowledgeRead],
  )

  useEffect(() => {
    artifactLoadedRunIdRef.current = null
    artifactRequestRef.current += 1
    setArtifactResponse(null)
    setArtifactError(null)
    setArtifactLoading(false)
  }, [run?.id])

  const loadArtifact = useCallback(async () => {
    if (!run?.id) return
    const requestId = artifactRequestRef.current + 1
    artifactRequestRef.current = requestId
    setArtifactLoading(true)
    setArtifactError(null)

    try {
      const response = await fetchRunArtifact(run.id)
      if (artifactRequestRef.current !== requestId) return
      artifactLoadedRunIdRef.current = run.id
      setArtifactResponse(response)
    } catch (err) {
      if (artifactRequestRef.current !== requestId) return
      setArtifactError(err instanceof Error ? err.message : "Failed to load artifact data")
    } finally {
      if (artifactRequestRef.current === requestId) {
        setArtifactLoading(false)
      }
    }
  }, [run?.id])

  useEffect(() => {
    if (!artifactDrawerOpen || !run?.id) return
    if (artifactLoading || artifactError) return
    if (artifactLoadedRunIdRef.current === run.id && artifactResponse) return
    void loadArtifact()
  }, [artifactDrawerOpen, artifactError, artifactLoading, artifactResponse, loadArtifact, run?.id])

  const openArtifactDrawer = useCallback((tab: ArtifactDrawerTab = "test") => {
    setArtifactDrawerTab(tab)
    setArtifactDrawerOpen(true)
  }, [])

  const memberFilter = parseMemberFilter(searchParams.get("member"))
  const recordedGroups = useMemo(
    () => (detail ? groupRunDetail(detail) : []),
    [detail],
  )
  const { groups, ready: mediaDurationsReady, decodedDurations } = useRecordingDurations(recordedGroups, id ?? '')
  const visibleGroups = useMemo(() => filterGroups(groups, memberFilter), [groups, memberFilter])
  // The op's bytes and the chip word, joined to member handles. The page composes no sentence.
  const analysisView = useMemo(
    () => projectAnalysisView(analysis, analysisChip, detail),
    [analysis, analysisChip, detail],
  )
  /**
   * THE HEADER'S ANALYSIS INDICATOR, OPENED (425-09 · D-11, PXH-RUN-03, UI-SPEC S4).
   *
   * THE DOOR MOVES SCROLL AND FOCUS AND NOTHING ELSE. It switches no tab, does not touch the
   * playhead and does not change the selection — those are the page's own state, and a header
   * control that rewrote them would be reaching past what it was asked for (the declined option in
   * D-11). That also makes it idempotent for free: opening it twice lands the same reader in the
   * same place, because there is no state for a second call to advance.
   *
   * THE FIRST MOUNTED BLOCK IS THE FIRST FAILED MEMBER. A passed member mounts no block at all, so
   * tree order already answers "which member" without this page re-deriving the projection the
   * tree is rendering from. Member groups own their open state locally and default open.
   *
   * ...AND WHEN A READER HAS COLLAPSED THEM ALL, THE TOGGLE IS THE TARGET. Scrolling to nothing
   * and focusing nothing would lose the reader entirely. The target is the toggle of the group that
   * HOLDS a verdict (`data-member-has-verdict`, written only on a group handed a verdict), so the
   * verdict is one keypress away rather than behind a passed member's group that happens to come
   * first (425 review WR-01). The first toggle remains only for a tree that marks no group.
   *
   * THE TOGGLE IS NAMED BY CONTRACT, NOT BY ARIA STATE (425-14 · WR-01). `aria-expanded` is also
   * emitted by the member-filter trigger and by the Error Details disclosure, and both render
   * earlier in this same container on exactly the run the door is enabled for — a failed run with
   * an error log. `[data-member-toggle]` is written only on the group's own disclosure.
   *
   * `preventScroll` on the focus call because the scroll above already placed the target — without
   * it the browser scrolls a second time, to its own idea of where the element should sit.
   */
  const openVerdict = useCallback(() => {
    const container: ParentNode = stepTreeScrollRef.current ?? document
    const target =
      container.querySelector<HTMLElement>('[data-verdict-block]')
      ?? container.querySelector<HTMLElement>('[data-member-toggle][data-member-has-verdict]')
      ?? container.querySelector<HTMLElement>('[data-member-toggle]')
    if (target === null) return
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    target.scrollIntoView({ block: 'center', behavior })
    target.focus({ preventScroll: true })
  }, [])

  // CHROME KEYS ON THE RUN, NOT ON THE FILTER (D-16). A viewer who narrowed a five-member suite to
  // one member is still looking at a suite, and hiding the header and the picker would strand them
  // there with no way back.
  const hasMemberChrome = detail ? showMemberChrome(detail) : false
  const displaySteps = useMemo(() => displayStepsForGroups(visibleGroups), [visibleGroups])

  const selectedStep = useMemo(() => {
    if (!hasStepId(selection)) return null
    return displaySteps.find(s => s.id === selection.stepId) ?? null
  }, [selection, displaySteps])

  // THE FEEDBACK COMPOSER'S STATE IS PAGE STATE (426 D-09), held by a hook so `onMark` above stays
  // the one writer. The header entry's target follows the selection and the member filter (D-03).
  const feedback = useRunFeedback({
    runId: id,
    runStatus: run?.status,
    detail,
    onMark,
    markPending,
    selectedStep: selectedStep?.testIndex !== undefined && selectedStep.stepIndex !== undefined
      ? { testIndex: selectedStep.testIndex, stepIndex: selectedStep.stepIndex }
      : null,
    memberFilter: memberFilter === MEMBER_FILTER_ALL ? undefined : memberFilter,
    markDenial,
    reloadDetail,
    setSelection,
  })
  // D-10 / RESEARCH Pattern 3: the orientation switch changes panel ids, never the Group's key, so the
  // library keeps a layout per arrangement and the tree, the tabs and the player are never remounted.
  // The open seed is in percent because numeric panel sizes are pixels in react-resizable-panels 4.
  const feedbackOpen = feedback.composer !== undefined
  const layout = feedbackLayout(pageWidth, feedbackOpen)
  const panelIds = feedbackPanelIds(layout)
  // `defaultLayout` seeds only the Group's first open arrangement. Coming back to docked from stacked,
  // the library restored the docked panes with the composer at its 50% cap and the tree squeezed to a
  // sliver (426-17 LAYOUT-SWITCH-NO-REMOUNT), so every later switch re-seeds its own arrangement.
  const panelGroup = useGroupRef()
  const seededLayout = useRef<FeedbackLayout | undefined>(undefined)
  useEffect(() => {
    if (!feedbackOpen) {
      seededLayout.current = undefined
      return
    }
    if (seededLayout.current === layout) return
    const first = seededLayout.current === undefined
    seededLayout.current = layout
    if (!first) panelGroup.current?.setLayout(feedbackDefaultLayout(layout, pageWidth))
  }, [feedbackOpen, layout, pageWidth, panelGroup])

  const playhead = useMemo<Playhead | null>(() => {
    const address = playheadFromSelection(selection)
    if (!address || !selectedStep) return null
    if (playheadTarget?.testIndex === address.testIndex && playheadTarget.stepIndex === address.stepIndex) return playheadTarget
    if (selection?.type === 'subaction') return address
    const group = groups.find(entry => entry.member.testIndex === address.testIndex)
      ?.steps.find(entry => entry.step.stepIndex === address.stepIndex)
    return group ? parkTargetForStep(group) : null
  }, [selection, selectedStep, playheadTarget, groups])
  const playheadSubAction = useMemo<RunDetailSubAction | null>(() =>
    selectedStep?.subActions?.find(sub => sub.subActionIndex === playhead?.subActionIndex) ?? null,
  [selectedStep, playhead])
  const timelineGroup = visibleGroups.find(group => group.member.testIndex === (timelineMemberIndex ?? playhead?.testIndex))
    ?? visibleGroups[0]
  const timelineModel = useMemo(() => timelineGroup ? buildTimelineModel(timelineGroup) : null, [timelineGroup])
  const suiteModel = useMemo(() => buildSuiteTimeline(visibleGroups), [visibleGroups])
  const recording = timelineGroup?.member.recording
  const [sourceChoice, setSourceChoice] = useState<{ member: string; source: PlayerSource }>()
  const playerMember = `${id}:${timelineGroup?.member.testIndex}:${recording?.state}`
  const playerSource = sourceChoice?.member === playerMember ? sourceChoice.source : initialPlayerSource(recording, timelineModel?.axis ?? 'ordinal')
  const setPlayerSource = (source: PlayerSource) => {
    setContinueMember(undefined)
    setObservedPosition(undefined)
    setSourceChoice({ member: playerMember, source })
  }
  const observePlayhead = (address: Playhead) => {
    setTreeSelection(selectionFromPlayhead(address))
    setPlayheadTarget(address)
  }
  const seekSuite = (fraction: number, address?: Playhead) => {
    const target = suiteSeek(suiteModel, fraction, address)
    if (!target) return
    if (address ?? target.playhead) setPlayheadFrom((address ?? target.playhead)!)
    else { setSelection(null); setTimelineMemberIndex(target.member.model.testIndex) }
    const member = target.member.group.member
    // An explicit video scrub keeps Video, including a truthful absence pane at gaps.
    if (playerSource === 'video') setSourceChoice({ member: `${id}:${member.testIndex}:${member.recording?.state}`, source: 'video' })
    setSeekFraction(target.localFraction)
    setSeekRevision(value => value + 1)
    setObservedPosition(fraction)
  }
  const advanceRecording = () => {
    const index = visibleGroups.findIndex(group => group === timelineGroup)
    const next = visibleGroups[index + 1]
    if (!next) { setContinueMember(undefined); return }
    const model = buildTimelineModel(next)
    const address = model.markers[0] ?? model.playhead
    if (address) setPlayheadFrom(address)
    else { setSelection(null); setTimelineMemberIndex(next.member.testIndex) }
    const recording = next.member.recording
    setSourceChoice({ member: `${id}:${next.member.testIndex}:${recording?.state}`, source: 'video' })
    setSeekFraction(model.axis === 'time' ? 0 : undefined)
    setSeekRevision(value => value + 1)
    const playable = recording?.state === 'present' && !recording.ref.evidenceIncomplete
    setContinueMember(playable ? next.member.testIndex : undefined)
    setObservedPosition(suiteModel.members[index + 1]?.start)
  }
  const handleCitedArtifact = useCallback((sha: string) => {
    for (const group of groups) {
      const marker = findMarkerBySha(buildTimelineModel(group), sha)
      if (!marker) continue
      if (!visibleGroups.includes(group)) {
        setPendingCitationSha(sha)
        const next = new URLSearchParams(searchParams)
        next.delete('member')
        next.set('step', runDetailStepKey(marker.testIndex, marker.stepIndex))
        next.set('sub', String(marker.subActionIndex))
        next.delete('tab')
        setSearchParams(next, { replace: true })
        return
      }
      setPlayheadFrom(marker)
      setSourceChoice({ member: `${id}:${group.member.testIndex}:${group.member.recording?.state}`, source: 'frames' })
      setActiveTab('overview')
      return
    }
    citationOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setLightboxSha(sha)
  }, [groups, visibleGroups, searchParams, setSearchParams, setPlayheadFrom, id])
  useEffect(() => {
    if (pendingCitationSha && memberFilter === MEMBER_FILTER_ALL) {
      setPendingCitationSha(null)
      handleCitedArtifact(pendingCitationSha)
    }
  }, [pendingCitationSha, memberFilter, handleCitedArtifact])
  const foldedFrame = selection?.type === "step" && !playheadTarget
    ? latestUsableFrame(selectedStep?.subActions ?? []) : undefined

  type NavItem =
    | { type: 'hook'; logId: string }
    | { type: 'step'; stepId: string }
    | { type: 'sub'; stepId: string; subIndex: number }
    | { type: 'exec'; stepId: string; logId: string }

  const expandedStepId = hasStepId(selection) ? selection.stepId : null

  const setupHooks = useMemo(() =>
    allExecutionLogs.filter(l => l.stepId === null && l.phase === 'setup'),
    [allExecutionLogs]
  )
  const teardownHooks = useMemo(() =>
    allExecutionLogs.filter(l => l.stepId === null && l.phase === 'teardown'),
    [allExecutionLogs]
  )
  const stepExecutionLogs = useMemo(() =>
    allExecutionLogs.filter(l => l.stepId !== null),
    [allExecutionLogs]
  )
  const selectedHookLog = useMemo(() =>
    selection?.type === 'hook'
      ? allExecutionLogs.find(l => l.id === selection.hookId) ?? null
      : null,
    [selection, allExecutionLogs]
  )
  const selectedExecutionLog = useMemo(() =>
    selection?.type === 'execution'
      ? allExecutionLogs.find(l => l.id === selection.logId) ?? null
      : null,
    [selection, allExecutionLogs]
  )

  const navItems = useMemo(() => {
    const items: NavItem[] = []

    // Run-level setup hooks
    for (const hook of setupHooks) {
      items.push({ type: 'hook', logId: hook.id })
    }

    // ONE FLAT ORDER, AND IT IS ALREADY THE TREE'S (405-08). `displaySteps` comes out of the
    // member-grouped projection in handle-then-ordinal order, so keyboard navigation walks the
    // tree exactly as drawn without a second grouping pass to keep in step with the first.
    for (const step of displaySteps) {
      if (!step.subActions?.length) items.push({ type: 'step', stepId: step.id })
      {
        for (const log of stepExecutionLogs) {
          // Match the tree's single-member ordinal ownership rule; never guess a suite owner.
          if (visibleGroups.length === 1 && (log.stepId === step.id || Number(log.stepId) === step.rawStepOrder)) {
            items.push({ type: 'exec', stepId: step.id, logId: log.id })
          }
        }
        for (const sub of step.subActions ?? []) {
          items.push({ type: 'sub', stepId: step.id, subIndex: sub.subActionIndex })
        }
      }
    }

    // Run-level teardown hooks
    for (const hook of teardownHooks) {
      items.push({ type: 'hook', logId: hook.id })
    }
    return items
  }, [displaySteps, stepExecutionLogs, setupHooks, teardownHooks, visibleGroups.length])

  const currentNavIdx = useMemo(() => {
    const cursor = selection?.type === 'step' && playhead?.subActionIndex !== null
      ? selectionFromPlayhead(playhead) : selection
    if (!cursor) return -1
    return navItems.findIndex(item => {
      if (cursor.type === 'hook' && item.type === 'hook') return item.logId === cursor.hookId
      if (cursor.type === 'step' && item.type === 'step') return item.stepId === cursor.stepId
      if (cursor.type === 'subaction' && item.type === 'sub')
        return item.stepId === cursor.stepId && item.subIndex === cursor.subIndex
      if (cursor.type === 'execution' && item.type === 'exec')
        return item.logId === cursor.logId
      return false
    })
  }, [navItems, selection, playhead])

  function navItemToSelection(item: NavItem): Selection {
    if (item.type === 'hook') return { type: 'hook', hookId: item.logId }
    if (item.type === 'step') return { type: 'step', stepId: item.stepId }
    if (item.type === 'exec') return { type: 'execution', stepId: item.stepId, logId: item.logId }
    return { type: 'subaction', stepId: item.stepId, subIndex: item.subIndex }
  }

  function selectNavItem(item: NavItem) {
    const next = navItemToSelection(item)
    const address = playheadFromSelection(next)
    if (item.type === 'sub' && address) setPlayheadFrom(address)
    else setSelection(next)
  }

  const shortcuts = useMemo(() => {
    const navigationIgnored = (event: KeyboardEvent) => event.target instanceof Element
      && event.target.closest('[role="dialog"]:not([data-state="closed"]), dialog[open], [role="listbox"], [role="combobox"]') !== null
    const moveMarker = (event: KeyboardEvent, direction: number) => {
      if (isTimelineKeyIgnored(event)) return false
      const markers = visibleGroups.flatMap(group => buildTimelineModel(group).markers)
      if (markers.length === 0) return false
      const index = markers.findIndex(marker => marker.testIndex === playhead?.testIndex
        && marker.stepIndex === playhead.stepIndex && marker.subActionIndex === playhead.subActionIndex)
      const next = index < 0 ? (direction === 1 ? 0 : markers.length - 1)
        : Math.max(0, Math.min(markers.length - 1, index + direction))
      setPlayheadFrom(markers[next]!)
    }
    const map: Record<string, (e: KeyboardEvent) => void | boolean> = {
      arrowleft: event => moveMarker(event, -1),
      arrowright: event => moveMarker(event, 1),
      v: event => {
        if (isTimelineKeyIgnored(event)) return false
        const source = playerSource === 'video' ? 'frames' : 'video'
        storePlayerSource(source)
        setPlayerSource(source)
      },
      arrowdown: event => {
        if (navigationIgnored(event)) return false
        if (navItems.length === 0) return
        if (currentNavIdx === -1) {
          selectNavItem(navItems[0])
        } else {
          const next = Math.min(currentNavIdx + 1, navItems.length - 1)
          selectNavItem(navItems[next])
        }
      },
      arrowup: event => {
        if (navigationIgnored(event)) return false
        if (navItems.length === 0) return
        if (currentNavIdx === -1) {
          selectNavItem(navItems[navItems.length - 1])
        } else {
          const prev = Math.max(currentNavIdx - 1, 0)
          selectNavItem(navItems[prev])
        }
      },
      j: event => map.arrowdown(event),
      k: event => map.arrowup(event),
      'shift+arrowdown': event => {
        if (navigationIgnored(event)) return false
        const index = displaySteps.findIndex(step => step.id === expandedStepId)
        const next = displaySteps[index + 1]
        if (next) setSelection({ type: 'step', stepId: next.id })
      },
      'shift+arrowup': event => {
        if (navigationIgnored(event)) return false
        const index = displaySteps.findIndex(step => step.id === expandedStepId)
        const previous = displaySteps[index - 1]
        if (previous) setSelection({ type: 'step', stepId: previous.id })
      },
      '1': () => setActiveTab(TAB_NAMES[0]),
      '2': () => setActiveTab(TAB_NAMES[1]),
      '3': () => setActiveTab(TAB_NAMES[2]),
      '4': () => setActiveTab(TAB_NAMES[3]),
      '5': () => setActiveTab(TAB_NAMES[4]),
      '6': () => setActiveTab(TAB_NAMES[5]),
      '7': () => setActiveTab(TAB_NAMES[6]),
      i: () => openArtifactDrawer("test"),
      c: () => openArtifactDrawer("config"),
      // `M` RE-POINTED, NOT RETIRED (407 D-02). The v1 memory drawer tab this key opened is dead
      // debris that 407-05 deletes grep-clean; re-pointing it here rather than there means the
      // shortcut is never dead for the length of a plan, and the muscle memory lands on the
      // surface that actually holds this run's memory story.
      m: () => setActiveTab('knowledge'),
      r: () => {
        if (!run) return
        const wasLocal = run.attributes["agent-qa.runner"] === "local"
        triggerRun({ file: run.filePath ?? run.name, local: wasLocal })
          .then((result) => {
            toast.success("Re-run started")
            navigate(routes.runLive(result.runId))
          })
          .catch((err: unknown) => toast.error(err instanceof RunDeniedError ? err.message : "Failed to start re-run"))
      },
      escape: () => {
        if (lightboxSha) setLightboxSha(null)
        else if (artifactDrawerOpen) setArtifactDrawerOpen(false)
        else setSelection(null)
      },
      'shift+?': () => setShortcutsOpen(prev => !prev),
      'shift+!': () => pipelineRef.current?.togglePhase(0),
      'shift+@': () => pipelineRef.current?.togglePhase(1),
      'shift+#': () => pipelineRef.current?.togglePhase(2),
      'shift+$': () => pipelineRef.current?.togglePhase(3),
    }
    return map
  }, [navItems, currentNavIdx, selection, run, navigate, artifactDrawerOpen, pipelineRef, openArtifactDrawer,
    visibleGroups, playhead, playerSource, playerMember, lightboxSha, displaySteps, expandedStepId])

  useKeyboardShortcuts(shortcuts)

  // Sync selection + tab to URL
  //
  // THE STEP PARAM IS THE SELECTION KEY ITSELF (405-08 · D-16) — `<testIndex>:<stepIndex>`, the
  // same string the tree highlights by, so the round-trip is an identity rather than a
  // translation. `?run=` is DELETED rather than left dormant: it named a child run id, and after
  // 405-07 there are no child runs to name; a stale one in a bookmarked link must not survive into
  // the rewritten query.
  useEffect(() => {
    if (isLoading || detail === undefined || pendingCitationSha) return
    const step = hasStepId(selection)
      ? displaySteps.find(s => s.id === selection.stepId)
      : null

    const next = new URLSearchParams(searchParams)
    if (step) {
      next.set('step', step.id)
    } else {
      next.delete('step')
    }
    next.delete('run')
    if (playhead?.subActionIndex != null) {
      next.set('sub', String(playhead.subActionIndex))
    } else {
      next.delete('sub')
    }
    if (activeTab !== 'overview') {
      next.set('tab', activeTab)
    } else {
      next.delete('tab')
    }

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true })
    }
  }, [selection, playhead, activeTab, displaySteps, searchParams, setSearchParams, isLoading, detail, pendingCitationSha])

  // Scroll selected item into view
  useEffect(() => {
    if (!hasStepId(selection)) return
    const container = stepTreeScrollRef.current
    if (!container) return

    const isDefaultInitialStepSelection =
      selection.type === 'step' &&
      !searchParams.has('step') &&
      !searchParams.has('sub') &&
      displaySteps[0]?.id === selection.stepId

    if (isDefaultInitialStepSelection) {
      skippedInitialDefaultSelectionRef.current = selection.stepId
      return
    }

    skippedInitialDefaultSelectionRef.current = null

    const selector = selection.type === 'step'
      ? `[data-step-id="${selection.stepId}"]`
      : selection.type === 'execution'
      ? `[data-execution-id="${selection.logId}"]`
      : isSubactionSelection(selection)
      ? `[data-sub-action-id="${selection.stepId}-${selection.subIndex}"]`
      : null

    if (!selector) return

    const animationFrameId = requestAnimationFrame(() => {
      const el = container.querySelector<HTMLElement>(selector)
      if (el) {
        scrollElementIntoContainerView(container, el)
      }
    })

    return () => cancelAnimationFrame(animationFrameId)
  }, [selection, displaySteps, searchParams])

  /**
   * Narrow the tree to one member, or widen it back (D-16).
   *
   * THE FILTER IS URL STATE AND NOTHING ELSE. There is no second copy in React state to fall out
   * of step with the address bar, and no fetch: the projection for the whole run is already in
   * hand, so narrowing is a `filter` over it. That is the difference from what stood here — the
   * suite picker re-fetched a child run and its logs on every change, so a link into one member
   * showed a different page than clicking to it.
   */
  const handleMemberFilterChange = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === MEMBER_FILTER_ALL) next.delete('member')
    else next.set('member', value)
    // The selected step may belong to a member this filter just hid; the tree re-derives the
    // selection from the URL below, and an unrenderable key falls back to the first visible step.
    setSearchParams(next, { replace: false })
  }, [searchParams, setSearchParams])

  /**
   * Jump to a step the verdict cited (406-06 · D-02, first half).
   *
   * IT MINTS NO ID AND NO SCROLLER. The step key is `runDetailStepKey`'s — the one spelling the
   * tree renders as `data-step-id`, the panels resolve by, and the `?step=` deep link round-trips
   * through — so this is a `setSelection` and nothing more; the page's existing scroll-into-view
   * effect finds the row inside `stepTreeScrollRef`. A second flattening or a second id spelling
   * here would be the exact drift `displayStepsForGroups` exists to prevent.
   *
   * A CITED INDEX WITH NO STEP IS A NO-OP (T-406-18). The ordinals come off the producer's own
   * evidence, and a verdict citing a step this run never recorded must not select a row that is not
   * there, nor throw. The existence check is against ALL groups rather than the visible ones, which
   * is what distinguishes "the filter is hiding it" from "it does not exist".
   *
   * AND WHEN THE FILTER IS HIDING IT, THE FILTER WIDENS FIRST. Selecting a step outside the visible
   * tree would be undone one effect later by the guard below, which pulls the selection back to the
   * first visible row — so the reader would click a cited step and land somewhere else entirely.
   */
  const onCitedStep = useCallback((testIndex: number, stepIndex: number) => {
    const stepId = runDetailStepKey(testIndex, stepIndex)
    const exists = groups.some(
      (entry) =>
        entry.member.testIndex === testIndex
        && entry.steps.some(({ step }) => step.stepIndex === stepIndex),
    )
    if (!exists) return

    if (!displaySteps.some((step) => step.id === stepId)) {
      const next = new URLSearchParams(searchParams)
      next.delete('member')
      setSearchParams(next, { replace: false })
    }
    setSelection({ type: 'step', stepId })
  }, [groups, displaySteps, searchParams, setSearchParams])

  // 427 D-03: a Knowledge step reference is a cited step that also brings its tree row into view.
  // The tab and the focus stay where the reader left them.
  //
  // A STEP THE MEMBER FILTER HIDES IS SELECTED ONLY ONCE THE WIDENED TREE HAS RENDERED. The router
  // lands the URL in a transition, so a selection set in the same click renders first against the
  // narrowed tree, where the visible-tree guard pulls it back and the URL sync rewrites the member
  // param the click had just removed.
  const [pendingKnowledgeStep, setPendingKnowledgeStep] = useState<string | null>(null)
  const scrollTreeRowIntoView = useCallback((stepId: string) => {
    requestAnimationFrame(() => {
      const container: ParentNode = stepTreeScrollRef.current ?? document
      const row = container.querySelector<HTMLElement>(`[data-step-id="${stepId}"]`)
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      row?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
    })
  }, [])
  const onKnowledgeStep = useCallback((address: StepAddress) => {
    const stepId = runDetailStepKey(address.testIndex, address.stepIndex)
    if (displaySteps.some((step) => step.id === stepId)) {
      onCitedStep(address.testIndex, address.stepIndex)
      scrollTreeRowIntoView(stepId)
      return
    }
    const exists = groups.some(
      (entry) =>
        entry.member.testIndex === address.testIndex
        && entry.steps.some(({ step }) => step.stepIndex === address.stepIndex),
    )
    if (!exists) return
    const next = new URLSearchParams(searchParams)
    next.delete('member')
    setSearchParams(next, { replace: false })
    setPendingKnowledgeStep(stepId)
  }, [displaySteps, groups, onCitedStep, scrollTreeRowIntoView, searchParams, setSearchParams])
  useEffect(() => {
    if (pendingKnowledgeStep === null) return
    if (!displaySteps.some((step) => step.id === pendingKnowledgeStep)) return
    setPendingKnowledgeStep(null)
    setSelection({ type: 'step', stepId: pendingKnowledgeStep })
    scrollTreeRowIntoView(pendingKnowledgeStep)
  }, [pendingKnowledgeStep, displaySteps, setSelection, scrollTreeRowIntoView])

  const knowledgeStepRefs = useMemo<StepRefContext>(() => ({
    onSelect: onKnowledgeStep,
    resolvable: (address) => groups.some(
      (entry) =>
        entry.member.testIndex === address.testIndex
        && entry.steps.some(({ step }) => step.stepIndex === address.stepIndex),
    ),
    testNames: groups.length > 1
      ? new Map(groups.map(({ member }) => [member.testIndex, memberDisplayName(member)]))
      : new Map(),
  }), [groups, onKnowledgeStep])

  /**
   * Narrow the tree to a cluster sibling's own group (406-06 · D-08).
   *
   * THE FILTER'S OWN SPELLING, NOT A SECOND ONE. `?member=<testIndex>` is what the picker writes
   * and what `parseMemberFilter` reads, so a sibling link and the picker are the same control
   * reached two ways — and the link is shareable for free.
   */
  const onSelectMember = useCallback((testIndex: number) => {
    const next = new URLSearchParams(searchParams)
    next.set('member', String(testIndex))
    setSearchParams(next, { replace: false })
  }, [searchParams, setSearchParams])

  // Keep the selection inside the visible tree. A member filter (or a deep link into a member that
  // is filtered out) can leave `selection` pointing at a step nobody can see, and a highlighted row
  // with no row is a panel showing details for something off-screen.
  useEffect(() => {
    if (isLoading) return
    if (!hasStepId(selection)) return
    if (displaySteps.some((step) => step.id === selection.stepId)) return
    setSelection(displaySteps.length > 0 ? { type: 'step', stepId: displaySteps[0].id } : null)
  }, [displaySteps, selection, isLoading])

  if (isLoading) return <DetailSkeleton />

  if (notFound || !run) {
    return (
      <EmptyState
        icon={FileSearch}
        title="Run not found"
        description="This test run doesn't exist or has been deleted"
        actionLabel="View All Runs"
        onAction={() => navigate(routes.runs)}
      />
    )
  }

  return (
    <TooltipProvider>
      {lightboxSha && <PlayerLightbox runId={run.id} sha={lightboxSha} open onOpenChange={open => { if (!open) setLightboxSha(null) }} returnFocus={citationOpener.current} />}
      <div ref={setPageRoot} className="flex h-full min-h-0 flex-col overflow-hidden">
        {/*
          THE DURABLE RUNG RIDES THE READ THIS PAGE ALREADY MADE (407-10 · D-13). `bannerRung` is a
          pure read of `knowledgeRead` — no second fetch, no new effect, and no new dependency on
          the one-read-per-id effect above, whose cardinality 407-06 pinned.
        */}
        <RunNavbar
          run={run}
          tokens={detail?.tokens}
          models={detail?.models}
          shortcutsOpen={shortcutsOpen}
          onToggleShortcuts={() => setShortcutsOpen(prev => !prev)}
          onOpenArtifacts={openArtifactDrawer}
          onCurationClick={() => setActiveTab('knowledge')}
          // THE DOOR EXISTS ONLY WHERE THERE IS SOMEWHERE TO GO (D-11). A passed run has no
          // verdict to open, and neither has a failed run the op answered nothing about — which
          // is also the excluded run's reading, since a chain that was never enqueued produced no
          // verdicts. The header stays a focusable span in every one of those cases rather than
          // growing a control that would do nothing.
          onOpenVerdict={runStatusClass(run.status) === 'fail' && analysisView.size > 0 ? openVerdict : undefined}
          retrievalRung={bannerRung(knowledgeRead)}
          feedbackEntry={feedback.headerEntry}
          hasPostProcessing
          postProcessing={
            postProcessingRead === undefined ? undefined : projectPostProcessingView(postProcessingRead)
          }
        />

        {detail && isPreMilestoneRun(detail) && <RunNotice key={run.id} runId={run.id} />}

        <ResizablePanelGroup
          groupRef={panelGroup}
          orientation={layout === "stacked" ? "vertical" : "horizontal"}
          className="min-h-0 flex-1 overflow-hidden"
          defaultLayout={feedbackOpen ? feedbackDefaultLayout(layout, pageWidth) : undefined}
        >
          <ResizablePanel key="tree" id={panelIds.tree} defaultSize={35} minSize={20}>
            <div ref={stepTreeScrollRef} className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
              {/*
                THE MEMBER FILTER (D-16). What stood here was a picker over CHILD RUNS that
                re-fetched one on every change, and beside it an attempts tab strip that re-fetched
                a whole earlier attempt. D-17 retires the attempts picker outright — the projection
                keeps the FINAL attempt's steps per handle plus a count, and the attempt-by-attempt
                story stays in the run's own event log. So one control remains, it fetches nothing,
                and it is absent entirely on a single-member run.
              */}
              {hasMemberChrome ? (
                <div className="border-b px-3 py-2 shrink-0">
                  <Select
                    value={memberFilter === MEMBER_FILTER_ALL ? MEMBER_FILTER_ALL : String(memberFilter)}
                    onValueChange={handleMemberFilterChange}
                  >
                    <SelectTrigger className="w-full h-8 text-xs" data-member-filter>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MEMBER_FILTER_ALL}>
                        All tests ({groups.length})
                      </SelectItem>
                      {groups.map(({ member }) => (
                        <SelectItem key={member.testIndex} value={String(member.testIndex)}>
                          {memberDisplayName(member)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              {runStatusClass(run.status) === 'fail' && run.failureSummary && (
                <FailureBanner summary={run.failureSummary} />
              )}

              {runStatusClass(run.status) === 'fail' && run.errorLog && (
                <Collapsible className="mx-2 mt-1">
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group w-full">
                    <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                    <span>Error Details</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-1 text-xs font-mono bg-muted/30 border border-border/50 rounded-[2px] px-3 py-2 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto text-foreground/70 select-text">
                      {run.errorLog}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}

              {detail === null ? (
                <div
                  data-run-detail-error
                  className="flex-1 flex items-center justify-center px-4 text-center text-sm text-muted-foreground"
                >
                  {RUN_DETAIL_UNAVAILABLE_LABEL}
                </div>
              ) : (
                <StepTree
                  groups={visibleGroups}
                  showMemberChrome={hasMemberChrome}
                  analysisView={analysisView}
                  onCitedStep={onCitedStep}
                  onSelectMember={onSelectMember}
                  onCitedArtifact={handleCitedArtifact}
                  selection={selection}
                  playhead={playhead}
                  onSelect={setSelection}
                  setupHooks={setupHooks}
                  teardownHooks={teardownHooks}
                  inlineLogs={stepExecutionLogs}
                  feedback={detail ? feedback.tree : undefined}
                />
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel key="evidence" id={panelIds.evidence} defaultSize={65} minSize={30} data-tour-id="tour-run-detail-reasoning">
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {detail === null ? (
                <div data-run-detail-error className='flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground'>
                  {RUN_DETAIL_UNAVAILABLE_LABEL}
                </div>
              ) : <>
                <div className='flex min-h-0 flex-1 flex-col'>
                <TabPanels
                  timeline={<Timeline
                    model={suiteModel}
                    mediaDurationsReady={mediaDurationsReady}
                    playhead={playhead}
                    source={playerSource}
                    memberLabel={suiteModel.members.length > 1 ? 'All tests' : suiteModel.members[0]?.label}
                    observedPosition={observedPosition}
                    onPlayheadChange={setPlayheadFrom}
                    onSeekFraction={seekSuite}
                  />}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  step={selectedStep}
                  subAction={playheadSubAction}
                  model={timelineModel} playhead={playhead} recording={recording} frame={foldedFrame}
                  clock={suiteClock(suiteModel, decodedDurations, timelineGroup?.member.testIndex ?? -1)}
                  playerSource={playerSource} onPlayerSourceChange={setPlayerSource}
                  onPlayheadChange={setPlayheadFrom} seekFraction={seekFraction} seekRevision={seekRevision}
                  onPlayheadObserved={observePlayhead}
                  onProgress={(testIndex, seconds) => setObservedPosition(suiteProgress(suiteModel, testIndex, seconds))}
                  onRecordingEnded={advanceRecording} autoPlay={continueMember === timelineGroup?.member.testIndex}
                  isTimelineKeyIgnored={isTimelineKeyIgnored}
                  runId={selectedStep?.rawRunId ?? run.id}
                  allSteps={displaySteps}
                  executionLogs={selection?.type === 'hook' && selectedHookLog ? [selectedHookLog]
                    : selection?.type === 'execution' && selectedExecutionLog ? [selectedExecutionLog] : []}
                  platform={run.platform}
                  pipelineRef={pipelineRef}
                  knowledge={knowledgeView}
                  knowledgeStepRefs={knowledgeStepRefs}
                  onSelectStep={stepId => setSelection({ type: 'step', stepId })}
                />
                </div>
              </>}
            </div>
          </ResizablePanel>

          {feedback.composer === undefined ? null : (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                key="feedback"
                id={panelIds.feedback}
                minSize={layout === "stacked" ? "240px" : "320px"}
                maxSize={layout === "stacked" ? undefined : "50%"}
              >
                <FeedbackComposer {...feedback.composer} layout={layout} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>

        {artifactDrawerOpen ? (
          <ArtifactDrawer
            run={run}
            open={artifactDrawerOpen}
            tab={artifactDrawerTab}
            response={artifactResponse}
            loading={artifactLoading}
            error={artifactError}
            onOpenChange={setArtifactDrawerOpen}
            onTabChange={setArtifactDrawerTab}
            onRetry={loadArtifact}
          />
        ) : null}

      </div>
    </TooltipProvider>
  )
}
