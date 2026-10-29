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
import { fetchRun, fetchRunAnalysis, fetchRunDetail, fetchRunKnowledge, triggerRun, fetchExecutionLogs, fetchRunArtifact, watchPostProcessing, markRun } from "@/lib/api"
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

// `?step=` is the `testIndex:stepIndex` key; one naming no rendered step falls back to the first.
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
  // Written by `live-run.tsx` and read structurally; `undefined` for anything else.
  const arrivedOnVerdict = arrivedOnVerdictFrom(location.state)
  const [searchParams, setSearchParams] = useSearchParams()
  const productTour = useOptionalProductTour()
  const recordRunDetailStatus = productTour?.recordRunDetailStatus

  const [run, setRun] = useState<RunRow | null>(null)
  const runTitle = run ? `Run - ${run.name}` : "Run"
  usePageTitle(runTitle)
  useRunStatusFavicon(getRunFaviconState(run?.status))
  // `undefined` is not asked yet and `null` a failed read; both differ from an empty projection.
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

  // The page's own width picks docked or stacked; an unmeasured page is docked.
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

  // The chip client lives here, not in the presentational header; the raw read is held.
  const [postProcessingRead, setPostProcessingRead] = useState<PostProcessingRead | undefined>(undefined)

  // The tab's read is held raw; `undefined` is the first read not landed, the tab's loading state.
  const [knowledgeRead, setKnowledgeRead] = useState<KnowledgeRead | undefined>(undefined)

  // Held raw, as `projectAnalysisView` is pure and total.
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

  // A pushed frame only triggers a re-read; nothing it carries is painted into a member's block.
  const analysisChip = postProcessingRead?.kind === 'read'
    ? postProcessingRead.status.chips.analysis
    : undefined

  // Clear the analysis on an id change, or run A's verdicts would join run B's members by index.
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

        // The row's own status decides the bounce, written by the subscriber at the verdict.
        const rowIsLive = shouldRouteRunToLive(data.run.status)
        if (rowIsLive && arrivedOnVerdict === undefined) {
          navigate(routes.runLive(id!), { replace: true })
          return
        }

        setRun(data.run)

        // An arrival with `arrivedOnVerdict` never bounces; it re-asks until the row is terminal.
        if (rowIsLive && catchUpAttempts < VERDICT_ROW_CATCH_UP_MAX) {
          catchUpAttempts += 1
          catchUpTimer = setTimeout(() => { if (!cancelled) void loadRun() }, VERDICT_ROW_CATCH_UP_MS)
        }

        // One `runs.detail` read; a failed read is its own state, so the header and banner stay.
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

  // Read once per id; a rejected read becomes an error state, never a skeleton forever.
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
  // Moves scroll and focus only; `preventScroll` keeps focus from scrolling a second time.
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

  // Chrome keys on the run, not the filter, so a narrowed suite keeps its way back.
  const hasMemberChrome = detail ? showMemberChrome(detail) : false
  const displaySteps = useMemo(() => displayStepsForGroups(visibleGroups), [visibleGroups])

  const selectedStep = useMemo(() => {
    if (!hasStepId(selection)) return null
    return displaySteps.find(s => s.id === selection.stepId) ?? null
  }, [selection, displaySteps])

  // Page state held by a hook, so `onMark` stays the one writer.
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
  // The open seed is in percent, as numeric panel sizes are pixels in react-resizable-panels 4.
  const feedbackOpen = feedback.composer !== undefined
  const layout = feedbackLayout(pageWidth, feedbackOpen)
  const panelIds = feedbackPanelIds(layout)
  // `defaultLayout` seeds only the first arrangement, so every switch re-seeds its own.
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

    // `displaySteps` is already in tree order, so keyboard navigation walks the tree as drawn.
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
      // M opens the Knowledge tab, which holds this run's memory story.
      m: () => setActiveTab('knowledge'),
      r: () => {
        if (!run) return
        triggerRun({ file: run.filePath ?? run.name })
          .then((result) => {
            toast.success("Re-run started")
            navigate(routes.runLive(result.runId))
          })
          .catch(() => toast.error("Failed to start re-run"))
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

  // The step param is the selection key itself; a stale `?run=` is deleted from the query.
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

  // The filter is URL state only; narrowing filters the projection already in hand.
  const handleMemberFilterChange = useCallback((value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === MEMBER_FILTER_ALL) next.delete('member')
    else next.set('member', value)
    // The selected step may belong to a member this filter just hid; the tree re-derives the
    // selection from the URL below, and an unrenderable key falls back to the first visible step.
    setSearchParams(next, { replace: false })
  }, [searchParams, setSearchParams])

  // A cited step with no row is a no-op; one the filter hides widens the filter first.
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

  // A hidden step is selected only after the widened tree renders, or the guard pulls it back.
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

  // Writes `?member=`, the picker's own spelling, so the link and picker are one control.
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
        {/* `bannerRung` reads `knowledgeRead`, so the rung costs no second fetch. */}
        <RunNavbar
          run={run}
          tokens={detail?.tokens}
          models={detail?.models}
          shortcutsOpen={shortcutsOpen}
          onToggleShortcuts={() => setShortcutsOpen(prev => !prev)}
          onOpenArtifacts={openArtifactDrawer}
          onCurationClick={() => setActiveTab('knowledge')}
          // Only a failed run with a verdict gets the verdict door; else the header stays a span.
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
              {/* One member filter that fetches nothing, absent on a single-member run. */}
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
