import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { useParams, useNavigate, useSearchParams } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import { FileSearch, X, AlertCircle, ChevronRight, Copy, Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
import { HookDetailPanel } from "@/components/run-detail/hook-detail-panel"
import { StepTree } from "@/components/run-detail/step-tree"
import { TabPanels } from "@/components/run-detail/tab-panels"
import type { ScreenshotSide } from "@/components/run-detail/tab-overview"
import type { ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import { fetchRun, fetchActiveExecutions, triggerRun, fetchExecutionLogs, fetchRunArtifact, fetchAccessibilitySummary } from "@/lib/api"
import type { RunRow, StepRow, ExecutionLogEntry, RunArtifactResponse, AccessibilitySummary } from "@/lib/api"
import { resolveVideoSrc } from "@/lib/artifact-media"
import { getRunStatusDescriptor, getStatusBadgeClassName } from "@/lib/status"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import { getRunFaviconState, useRunStatusFavicon } from "@/hooks/use-run-status-favicon"
import { cn } from "@/lib/utils"
import { formatTokens } from "@/lib/format"
import { hasStepId, isSubactionSelection, type Selection } from "@/lib/selection"
import { fromStepRow, type DisplayStep, withDisplayStepProgress } from "@/lib/display-step"

function StatusBadge({ status }: { status: string }) {
  const descriptor = getRunStatusDescriptor(status)
  return (
    <Badge className={getStatusBadgeClassName(descriptor.tone)}>
      {descriptor.label}
    </Badge>
  )
}

function truncateWords(text: string, maxWords: number): { truncated: string; isTruncated: boolean } {
  const words = text.split(/\s+/)
  if (words.length <= maxWords) return { truncated: text, isTruncated: false }
  return { truncated: words.slice(0, maxWords).join(' ') + '...', isTruncated: true }
}

function FailureBanner({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const { truncated, isTruncated } = truncateWords(summary, 20)

  const handleCopy = () => {
    navigator.clipboard.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="mx-2 mt-2 rounded-[2px] border border-red-500/20 bg-red-500/5 px-3 py-2 shrink-0">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
        <span className="flex-1 text-sm text-foreground/80 select-text">
          {open ? summary : truncated}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 mt-0.5 p-0.5 rounded-sm hover:bg-red-500/10 transition-colors"
          title="Copy failure summary"
        >
          {copied
            ? <Check className="h-3.5 w-3.5 text-emerald-400" />
            : <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </button>
        {isTruncated && (
          <button
            onClick={() => setOpen(o => !o)}
            className="shrink-0 mt-0.5 p-0.5 rounded-sm hover:bg-red-500/10 transition-colors"
          >
            <ChevronRight className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-90"
            )} />
          </button>
        )}
      </div>
    </div>
  )
}

function sortStepsForSuiteAll(steps: StepRow[], suiteTests: RunRow[]) {
  const testOrder = new Map(suiteTests.map((test, index) => [test.id, index]))
  return [...steps].sort((a, b) => {
    const orderA = testOrder.get(a.runId) ?? 0
    const orderB = testOrder.get(b.runId) ?? 0
    if (orderA !== orderB) return orderA - orderB
    return a.stepOrder - b.stepOrder
  })
}

function isSuiteParentRun(run: RunRow | null | undefined) {
  return run?.suiteId != null && run.parentRunId == null
}

function buildDisplaySteps(steps: StepRow[], suiteTests: RunRow[], suiteSelectedView: string, isSuiteParent: boolean) {
  const ordered = isSuiteParent && suiteSelectedView === "all" && suiteTests.length > 0
    ? sortStepsForSuiteAll(steps, suiteTests)
    : [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
  return withDisplayStepProgress(ordered.map(fromStepRow))
}

function getSelectionFromUrlOrFirst(
  displaySteps: DisplayStep[],
  searchParams: URLSearchParams,
  isSuiteAll: boolean,
): Selection | null {
  const urlStepOrder = searchParams.get("step")
  const urlRunId = searchParams.get("run")
  const urlSubIndex = searchParams.get("sub")

  if (urlStepOrder) {
    const rawStepOrder = Number.parseInt(urlStepOrder, 10)
    const targetStep = displaySteps.find((step) => {
      if (step.rawStepOrder !== rawStepOrder) return false
      if (isSuiteAll && urlRunId) return step.rawRunId === urlRunId
      return true
    })
    if (targetStep) {
      if (urlSubIndex != null) {
        return { type: "subaction", stepId: targetStep.id, subIndex: Number.parseInt(urlSubIndex, 10) }
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

type CurrentScreenshotPair = {
  key: string
  beforePath: string | null
  afterPath: string | null
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const productTour = useOptionalProductTour()
  const recordRunDetailStatus = productTour?.recordRunDetailStatus

  const [run, setRun] = useState<RunRow | null>(null)
  const runTitle = run ? `Run - ${run.name}` : "Run"
  usePageTitle(runTitle)
  useRunStatusFavicon(getRunFaviconState(run?.status))
  const [steps, setSteps] = useState<StepRow[]>([])
  const [attempts, setAttempts] = useState<RunRow[]>([])
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showVideo, setShowVideo] = useState(false)
  const [videoSpeed, setVideoSpeed] = useState(1)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pipelineRef = useRef<ReasoningPipelineHandle | null>(null)
  const stepTreeScrollRef = useRef<HTMLDivElement | null>(null)
  const skippedInitialDefaultSelectionRef = useRef<string | null>(null)

  const [suiteTests, setSuiteTests] = useState<RunRow[]>([])
  const [suiteSelectedView, setSuiteSelectedView] = useState<string>('all')
  const [allTestsSteps, setAllTestsSteps] = useState<StepRow[]>([])

  const [selection, setSelection] = useState<Selection | null>(null)
  const [allExecutionLogs, setAllExecutionLogs] = useState<ExecutionLogEntry[]>([])
  const [accessibilitySummary, setAccessibilitySummary] = useState<AccessibilitySummary | null>(null)

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [screenshotSideSelection, setScreenshotSideSelection] = useState<{ key: string; side: ScreenshotSide } | null>(null)
  const [artifactDrawerOpen, setArtifactDrawerOpen] = useState(false)
  const [artifactDrawerTab, setArtifactDrawerTab] = useState<ArtifactDrawerTab>("attributes")
  const [artifactResponse, setArtifactResponse] = useState<RunArtifactResponse | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const artifactLoadedRunIdRef = useRef<string | null>(null)
  const artifactRequestRef = useRef(0)

  const [activeTab, setActiveTab] = useState<string>(() => {
    const param = searchParams.get('tab')
    if (param === 'screenshot') return 'overview'
    return param ?? 'overview'
  })

  useEffect(() => {
    if (!run?.status) return
    recordRunDetailStatus?.(run.status)
  }, [recordRunDetailStatus, run?.status])

  useEffect(() => {
    if (!id) return

    skippedInitialDefaultSelectionRef.current = null

    let cancelled = false
    let retryCount = 0

    async function loadRun() {
      try {
        const { executions } = await fetchActiveExecutions()
        if (cancelled) return
        if (executions.some(e => e.runId === id)) {
          navigate(routes.runLive(id!), { replace: true })
          return
        }
      } catch {
        // fall through
      }

      try {
        const data = await fetchRun(id!)
        if (cancelled) return
        setRun(data.run)

        if (isSuiteParentRun(data.run) && data.tests && data.tests.length > 0) {
          setSuiteTests(data.tests)
          setSuiteSelectedView('all')

          const allSteps: StepRow[] = []
          for (const child of data.tests) {
            try {
              const childData = await fetchRun(child.id)
              if (cancelled) return
              allSteps.push(...childData.steps)
            } catch {
              // skip
            }
          }
          setAllTestsSteps(allSteps)
          setSteps(allSteps)
          const displaySteps = buildDisplaySteps(allSteps, data.tests, "all", true)
          setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, true))
        } else {
          setSteps(data.steps)
          const fetchedAttempts = data.attempts ?? []
          setAttempts(fetchedAttempts)
          if (fetchedAttempts.length > 0) {
            const lastAttempt = fetchedAttempts[fetchedAttempts.length - 1]
            setSelectedAttemptId(lastAttempt.id)
            const attemptData = await fetchRun(lastAttempt.id)
            if (!cancelled) {
              setSteps(attemptData.steps)
              const displaySteps = buildDisplaySteps(attemptData.steps, [], "", false)
              setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, false))
            }
          } else {
            const displaySteps = buildDisplaySteps(data.steps, [], "", false)
            setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, false))
          }
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
    }
  }, [id, navigate])

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

  const openArtifactDrawer = useCallback((tab: ArtifactDrawerTab) => {
    setArtifactDrawerTab(tab)
    setArtifactDrawerOpen(true)
  }, [])

  const displaySteps = useMemo(
    () => buildDisplaySteps(steps, suiteTests, suiteSelectedView, isSuiteParentRun(run)),
    [steps, suiteTests, suiteSelectedView, run],
  )

  const selectedStep = useMemo(() => {
    if (!hasStepId(selection)) return null
    return displaySteps.find(s => s.id === selection.stepId) ?? null
  }, [selection, displaySteps])

  const accessibilityRunId = selectedStep?.rawRunId ?? run?.id ?? null

  useEffect(() => {
    if (!accessibilityRunId) {
      setAccessibilitySummary(null)
      return
    }
    setAccessibilitySummary(null)
    let cancelled = false
    fetchAccessibilitySummary(accessibilityRunId)
      .then((summary) => {
        if (!cancelled) setAccessibilitySummary(summary)
      })
      .catch(() => {
        if (!cancelled) setAccessibilitySummary(null)
      })
    return () => { cancelled = true }
  }, [accessibilityRunId])

  const selectedSubAction = useMemo(() => {
    if (!isSubactionSelection(selection) || !selectedStep) return null
    return selectedStep.subActionsData?.[selection.subIndex] ?? null
  }, [selection, selectedStep])

  const currentScreenshotPair = useMemo<CurrentScreenshotPair | null>(() => {
    if (!selectedStep) return null

    if (selectedSubAction) {
      const beforePath = selectedSubAction.screenshotBeforePath ?? null
      const afterPath = selectedSubAction.screenshotAfterPath ?? null
      if (!beforePath && !afterPath) return null
      return {
        key: [
          selectedStep.id,
          'sub',
          selectedSubAction.index,
          beforePath ?? '',
          afterPath ?? '',
        ].join('|'),
        beforePath,
        afterPath,
      }
    }

    const beforePath = selectedStep.screenshotBeforePath
    const afterPath = selectedStep.screenshotPath
    if (!beforePath && !afterPath) return null
    return {
      key: [
        selectedStep.id,
        'step',
        beforePath ?? '',
        afterPath ?? '',
      ].join('|'),
      beforePath,
      afterPath,
    }
  }, [selectedStep, selectedSubAction])

  const screenshotSide =
    currentScreenshotPair && screenshotSideSelection?.key === currentScreenshotPair.key
      ? screenshotSideSelection.side
      : undefined

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
  const selectedStepLogs = useMemo(() => {
    if (!selectedStep) return []
    return stepExecutionLogs.filter((log) => {
      if (log.stepId === selectedStep.id) return true
      if (!log.stepId) return false
      if (selectedStep.rawRunId && log.runId && selectedStep.rawRunId !== log.runId) return false
      return Number.parseInt(log.stepId, 10) === selectedStep.rawStepOrder
    })
  }, [stepExecutionLogs, selectedStep])
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
    const isSuiteAll = isSuiteParentRun(run) && suiteSelectedView === 'all' && suiteTests.length > 0
    const childRunIds = isSuiteAll ? new Set(suiteTests.map(t => t.id)) : null

    // Suite-level setup hooks (not associated with any child test)
    for (const hook of setupHooks) {
      if (!childRunIds || !childRunIds.has(hook.runId)) {
        items.push({ type: 'hook', logId: hook.id })
      }
    }

    if (isSuiteAll) {
      // Group steps by test runId, matching the step tree visual order
      const grouped = new Map<string, typeof displaySteps>()
      for (const step of displaySteps) {
        const key = step.rawRunId ?? step.id
        const existing = grouped.get(key) ?? []
        existing.push(step)
        grouped.set(key, existing)
      }

      for (const [runId, groupSteps] of grouped) {
        // Per-test setup hooks
        for (const hook of setupHooks) {
          if (hook.runId === runId) {
            items.push({ type: 'hook', logId: hook.id })
          }
        }
        // Steps + sub-actions
        for (const step of groupSteps) {
          items.push({ type: 'step', stepId: step.id })
          if (step.id === expandedStepId) {
            const stepLogs = stepExecutionLogs.filter((log) => {
              if (log.stepId === step.id) return true
              if (!log.stepId) return false
              if (step.rawRunId && log.runId && step.rawRunId !== log.runId) return false
              return Number.parseInt(log.stepId, 10) === step.rawStepOrder
            })
            for (const log of stepLogs) {
              items.push({ type: 'exec', stepId: step.id, logId: log.id })
            }
            if (step.subActionsData) {
              step.subActionsData.forEach((_, i) => {
                items.push({ type: 'sub', stepId: step.id, subIndex: i })
              })
            }
          }
        }
        // Per-test teardown hooks
        for (const hook of teardownHooks) {
          if (hook.runId === runId) {
            items.push({ type: 'hook', logId: hook.id })
          }
        }
      }
    } else {
      // Non-suite or single-test view: flat order
      for (const step of displaySteps) {
        items.push({ type: 'step', stepId: step.id })
        if (step.id === expandedStepId) {
          const stepLogs = stepExecutionLogs.filter((log) => {
            if (log.stepId === step.id) return true
            if (!log.stepId) return false
            if (step.rawRunId && log.runId && step.rawRunId !== log.runId) return false
            return Number.parseInt(log.stepId, 10) === step.rawStepOrder
          })
          for (const log of stepLogs) {
            items.push({ type: 'exec', stepId: step.id, logId: log.id })
          }
          if (step.subActionsData) {
            step.subActionsData.forEach((_, i) => {
              items.push({ type: 'sub', stepId: step.id, subIndex: i })
            })
          }
        }
      }
    }

    // Suite-level teardown hooks
    for (const hook of teardownHooks) {
      if (!childRunIds || !childRunIds.has(hook.runId)) {
        items.push({ type: 'hook', logId: hook.id })
      }
    }
    return items
  }, [displaySteps, expandedStepId, stepExecutionLogs, setupHooks, teardownHooks, run, suiteSelectedView, suiteTests])

  const currentNavIdx = useMemo(() => {
    if (!selection) return -1
    return navItems.findIndex(item => {
      if (selection.type === 'hook' && item.type === 'hook') return item.logId === selection.hookId
      if (selection.type === 'step' && item.type === 'step') return item.stepId === selection.stepId
      if (selection.type === 'subaction' && item.type === 'sub')
        return item.stepId === selection.stepId && item.subIndex === selection.subIndex
      if (selection.type === 'execution' && item.type === 'exec')
        return item.logId === selection.logId
      return false
    })
  }, [navItems, selection])

  function navItemToSelection(item: NavItem): Selection {
    if (item.type === 'hook') return { type: 'hook', hookId: item.logId }
    if (item.type === 'step') return { type: 'step', stepId: item.stepId }
    if (item.type === 'exec') return { type: 'execution', stepId: item.stepId, logId: item.logId }
    return { type: 'subaction', stepId: item.stepId, subIndex: item.subIndex }
  }

  const TAB_NAMES = ['overview', 'env', 'network', 'console', 'aria', 'a11y'] as const

  const selectScreenshotSide = useCallback((side: ScreenshotSide) => {
    if (activeTab !== 'overview') return
    if (!currentScreenshotPair) return
    const requestedPath = side === 'before'
      ? currentScreenshotPair.beforePath
      : currentScreenshotPair.afterPath
    if (!requestedPath) return
    setScreenshotSideSelection({ key: currentScreenshotPair.key, side })
  }, [activeTab, currentScreenshotPair])

  const shortcuts = useMemo(() => {
    const map: Record<string, (e: KeyboardEvent) => void> = {
      arrowdown: () => {
        if (navItems.length === 0) return
        if (currentNavIdx === -1) {
          setSelection(navItemToSelection(navItems[0]))
        } else {
          const next = Math.min(currentNavIdx + 1, navItems.length - 1)
          setSelection(navItemToSelection(navItems[next]))
        }
      },
      arrowup: () => {
        if (navItems.length === 0) return
        if (currentNavIdx === -1) {
          setSelection(navItemToSelection(navItems[navItems.length - 1]))
        } else {
          const prev = Math.max(currentNavIdx - 1, 0)
          setSelection(navItemToSelection(navItems[prev]))
        }
      },
      j: () => { map.arrowdown({} as KeyboardEvent) },
      k: () => { map.arrowup({} as KeyboardEvent) },
      'shift+arrowdown': () => {
        if (navItems.length === 0) return
        const nextStepIdx = navItems.findIndex((item, i) => i > currentNavIdx && item.type === 'step')
        if (nextStepIdx !== -1) setSelection(navItemToSelection(navItems[nextStepIdx]))
      },
      'shift+arrowup': () => {
        if (navItems.length === 0) return
        let prevStepIdx = -1
        for (let i = currentNavIdx - 1; i >= 0; i--) {
          if (navItems[i].type === 'step') { prevStepIdx = i; break }
        }
        if (prevStepIdx !== -1) setSelection(navItemToSelection(navItems[prevStepIdx]))
      },
      '1': () => setActiveTab(TAB_NAMES[0]),
      '2': () => setActiveTab(TAB_NAMES[1]),
      '3': () => setActiveTab(TAB_NAMES[2]),
      '4': () => setActiveTab(TAB_NAMES[3]),
      '5': () => setActiveTab(TAB_NAMES[4]),
      '6': () => setActiveTab(TAB_NAMES[5]),
      'a': () => selectScreenshotSide("after"),
      'b': () => selectScreenshotSide("before"),
      i: () => openArtifactDrawer("attributes"),
      c: () => openArtifactDrawer("config"),
      m: () => openArtifactDrawer("memory"),
      r: () => {
        if (!run) return
        const wasLocal = run.attributes["agent-qa.runner"] === "local"
        triggerRun({ file: run.filePath ?? run.name, local: wasLocal })
          .then((result) => {
            toast.success("Re-run started")
            navigate(routes.runLive(result.runId))
          })
          .catch(() => toast.error("Failed to start re-run"))
      },
      escape: () => {
        if (artifactDrawerOpen) setArtifactDrawerOpen(false)
        else if (showVideo) setShowVideo(false)
        else setSelection(null)
      },
      v: () => { if (run?.videoPath) setShowVideo(true) },
      'shift+?': () => setShortcutsOpen(prev => !prev),
      'shift+!': () => pipelineRef.current?.togglePhase(0),
      'shift+@': () => pipelineRef.current?.togglePhase(1),
      'shift+#': () => pipelineRef.current?.togglePhase(2),
      'shift+$': () => pipelineRef.current?.togglePhase(3),
    }
    return map
  }, [navItems, currentNavIdx, selection, run, navigate, artifactDrawerOpen, showVideo, pipelineRef, selectScreenshotSide, openArtifactDrawer])

  useKeyboardShortcuts(shortcuts)

  // Sync selection + tab to URL
  useEffect(() => {
    const step = hasStepId(selection)
      ? displaySteps.find(s => s.id === selection.stepId)
      : null
    const stepOrder = step?.rawStepOrder
    const stepRunId = step?.rawRunId

    const next = new URLSearchParams(searchParams)
    if (stepOrder != null) {
      next.set('step', String(stepOrder))
    } else {
      next.delete('step')
    }
    if (isSuiteParentRun(run) && suiteSelectedView === 'all' && stepRunId) {
      next.set('run', stepRunId)
    } else {
      next.delete('run')
    }
    if (isSubactionSelection(selection)) {
      next.set('sub', String(selection.subIndex))
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
  }, [selection, activeTab, displaySteps, run, suiteSelectedView, searchParams, setSearchParams])

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

  const handleAttemptSelect = useCallback(async (attemptId: string) => {
    setSelectedAttemptId(attemptId)
    try {
      const data = await fetchRun(attemptId)
      setSteps(data.steps)
      const displaySteps = buildDisplaySteps(data.steps, [], "", false)
      setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, false))
    } catch {
      toast.error("Failed to load attempt")
    }
  }, [searchParams])

  const handleSuiteViewChange = useCallback(async (value: string) => {
    setSuiteSelectedView(value)
    if (value === 'all') {
      setSteps(allTestsSteps)
      const displaySteps = buildDisplaySteps(allTestsSteps, suiteTests, "all", isSuiteParentRun(run))
      setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, true))
      if (id) {
        fetchExecutionLogs(id).then(({ logs }) => setAllExecutionLogs(logs)).catch(() => {})
      }
    } else {
      try {
        const data = await fetchRun(value)
        setSteps(data.steps)
        const { logs } = await fetchExecutionLogs(value)
        setAllExecutionLogs(logs)
        const displaySteps = buildDisplaySteps(data.steps, [], value, false)
        setSelection(getSelectionFromUrlOrFirst(displaySteps, searchParams, false))
      } catch {
        toast.error("Failed to load test steps")
      }
    }
  }, [allTestsSteps, id, run, searchParams, suiteTests])

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

  const videoSrc = resolveVideoSrc(run.id, run.videoPath)
  const speeds = [0.5, 1, 1.5, 2, 3, 4]

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <RunNavbar
          run={run}
          steps={steps}
          shortcutsOpen={shortcutsOpen}
          onToggleShortcuts={() => setShortcutsOpen(prev => !prev)}
          onOpenArtifacts={openArtifactDrawer}
        />

        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <ResizablePanel defaultSize={35} minSize={20}>
            <div ref={stepTreeScrollRef} className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
              {/* Suite test selector */}
              {isSuiteParentRun(run) && suiteTests.length > 0 ? (
                <div className="border-b px-3 py-2 shrink-0">
                  <Select value={suiteSelectedView} onValueChange={handleSuiteViewChange}>
                    <SelectTrigger className="w-full h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Tests ({suiteTests.length})</SelectItem>
                      {suiteTests.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span className="flex items-center gap-2">
                            {t.name}
                            <StatusBadge status={t.status} />
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : attempts.length > 0 ? (
                <div className="flex gap-1 border-b px-3 py-2 shrink-0">
                  {attempts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAttemptSelect(a.id)}
                      className={cn(
                        "px-3 py-1 text-xs rounded-sm border-b-2 transition-colors",
                        selectedAttemptId === a.id
                          ? "border-primary text-foreground font-medium"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      Attempt {a.attemptNumber}
                      <span className="ml-1.5">
                        <StatusBadge status={a.status} />
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {run.status === 'failed' && run.failureSummary && (
                <FailureBanner summary={run.failureSummary} />
              )}

              {run.status === 'failed' && run.errorLog && (
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

              {run.memoryLog && (() => {
                const mem = JSON.parse(run.memoryLog) as {
                  added: number; confirmed: number; deprecated: number
                  errors: string[]; curatorDuration: number
                  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
                }
                return (
                  <Collapsible className="mx-2 mt-1">
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group w-full">
                      <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                      <span>Memory</span>
                      <span className="ml-1 text-[10px] opacity-60">
                        {mem.added}A {mem.confirmed}C {mem.deprecated}D
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs px-3 py-2 bg-muted/30 border border-border/50 rounded-[2px]">
                        <div className="flex justify-between"><span className="text-muted-foreground">Added</span><span className="font-mono">{mem.added}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Confirmed</span><span className="font-mono">{mem.confirmed}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Deprecated</span><span className="font-mono">{mem.deprecated}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Errors</span><span className="font-mono">{mem.errors.length}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Curator Duration</span><span className="font-mono">{(mem.curatorDuration / 1000).toFixed(1)}s</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Tokens</span><span className="font-mono">{mem.tokenUsage ? `${formatTokens(mem.tokenUsage.promptTokens)} / ${formatTokens(mem.tokenUsage.completionTokens)}` : '\u2014'}</span></div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })()}

              <StepTree
                steps={displaySteps}
                selection={selection}
                onSelect={setSelection}
                suiteTests={isSuiteParentRun(run) ? suiteTests : undefined}
                suiteSelectedView={suiteSelectedView}
                setupHooks={setupHooks}
                teardownHooks={teardownHooks}
                inlineLogs={stepExecutionLogs}
              />
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={65} minSize={30} data-tour-id="tour-run-detail-reasoning">
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {selection?.type === 'hook' && selectedHookLog ? (
                <HookDetailPanel log={selectedHookLog} />
              ) : selection?.type === 'execution' && selectedExecutionLog ? (
                <HookDetailPanel log={selectedExecutionLog} />
              ) : (
                <TabPanels
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  step={selectedStep}
                  subAction={selectedSubAction}
                  runId={selectedStep?.rawRunId ?? run.id}
                  allSteps={displaySteps}
                  executionLogs={selectedStepLogs}
                  accessibilitySummary={accessibilitySummary}
                  platform={run.platform}
                  screenshotSide={screenshotSide}
                  onScreenshotSideChange={selectScreenshotSide}
                  pipelineRef={pipelineRef}
                />
              )}
            </div>
          </ResizablePanel>
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

        {showVideo && videoSrc && (
          <div
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center"
            onClick={() => setShowVideo(false)}
          >
            <Button
              variant="secondary"
              size="icon-sm"
              className="absolute top-4 right-4 h-8 w-8 bg-background/80 backdrop-blur-sm z-10"
              onClick={() => setShowVideo(false)}
            >
              <X className="h-4 w-4" />
            </Button>

            <div className="flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
              <video
                ref={videoRef}
                src={videoSrc}
                controls
                autoPlay
                className="rounded-lg"
                style={{ maxWidth: '90vw', maxHeight: 'calc(90vh - 3rem)' }}
                onLoadedMetadata={() => {
                  if (videoRef.current) videoRef.current.playbackRate = videoSpeed
                }}
              />
              <div className="flex items-center gap-1 bg-background/80 backdrop-blur-sm rounded-full px-1 py-0.5">
                {speeds.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setVideoSpeed(s)
                      if (videoRef.current) videoRef.current.playbackRate = s
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      videoSpeed === s
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
