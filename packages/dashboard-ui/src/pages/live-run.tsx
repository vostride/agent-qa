import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useNavigate } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Radio,
  Square,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { DetailSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { HookDetailPanel } from "@/components/run-detail/hook-detail-panel"
import { StepTree } from "@/components/run-detail/step-tree"
import { TabPanels } from "@/components/run-detail/tab-panels"
import type { ScreenshotSide } from "@/components/run-detail/tab-overview"
import type { ReasoningPipelineHandle } from "@/components/reasoning-pipeline"
import { useExecutionEvents } from "@/hooks/use-execution-events"
import { usePageTitle } from "@/hooks/use-page-title"
import {
  getRunFaviconState,
  type RunFaviconState,
  useRunStatusFavicon,
} from "@/hooks/use-run-status-favicon"
import { cancelRun, fetchExecutionLogs, fetchRun } from "@/lib/api"
import type { ExecutionLogEntry, RunRow } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import { hasStepId, isSubactionSelection, type Selection } from "@/lib/selection"
import {
  getRunStatusDescriptor,
  getStatusBadgeClassName,
  getStatusTextClassName,
  isTerminalRunStatus,
} from "@/lib/status"
import { cn } from "@/lib/utils"

type FinalDetailState = "idle" | "loading" | "ready" | "failed"

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

function RunStatusBadge({
  status,
  finalStatus,
}: {
  status: "idle" | "connecting" | "running" | "complete" | "error"
  finalStatus?: string
}) {
  if (status === "complete" && finalStatus) {
    const descriptor = getRunStatusDescriptor(finalStatus)
    return (
      <Badge className={getStatusBadgeClassName(descriptor.tone)}>
        {descriptor.label}
      </Badge>
    )
  }
  switch (status) {
    case "connecting":
      return <Badge className="border-amber-500/20 bg-amber-500/15 text-amber-500">Connecting...</Badge>
    case "running":
      return <Badge className="border-blue-500/20 bg-blue-500/15 text-blue-500">Running</Badge>
    case "complete":
      return <Badge className="border-emerald-500/20 bg-emerald-500/15 text-emerald-500">Complete</Badge>
    case "error":
      return <Badge variant="destructive">Error</Badge>
    default:
      return <Badge variant="outline">Idle</Badge>
  }
}

function selectionKey(selection: Selection | null | undefined): string | null {
  if (!selection) return null
  if (selection.type === "step") return `step:${selection.stepId}`
  if (selection.type === "subaction") return `sub:${selection.stepId}:${selection.subIndex}`
  if (selection.type === "execution") return `exec:${selection.stepId}:${selection.logId}`
  if (selection.type === "hook") return `hook:${selection.hookId}`
  if (selection.type === "suite-hook") return `suite-hook:${selection.phase}:${selection.hookId}`
  if (selection.type === "test-hook") return `test-hook:${selection.testIndex}:${selection.phase}:${selection.hookId}`
  return `test:${selection.testIndex}`
}

function logBelongsToStep(log: ExecutionLogEntry, step: DisplayStep): boolean {
  if (!log.stepId) return false
  if (log.stepId === step.id) return true
  if (step.id.endsWith(`:${log.stepId}`)) return true
  if (step.rawRunId && log.runId && step.rawRunId !== log.runId) return false
  return Number.parseInt(log.stepId, 10) === step.rawStepOrder
}

function selectionExists(
  selection: Selection | null,
  steps: DisplayStep[],
  hooks: ExecutionLogEntry[],
  inlineLogs: ExecutionLogEntry[],
): boolean {
  if (!selection) return false
  if (selection.type === "hook") return hooks.some((log) => log.id === selection.hookId)
  if (selection.type === "execution") return inlineLogs.some((log) => log.id === selection.logId)
  if (hasStepId(selection)) {
    const step = steps.find((item) => item.id === selection.stepId)
    if (!step) return false
    if (selection.type === "subaction") {
      return Boolean(step.subActionsData?.[selection.subIndex])
    }
    return true
  }
  return false
}

function latestSelectionFor(
  steps: DisplayStep[],
  setupHooks: ExecutionLogEntry[],
  teardownHooks: ExecutionLogEntry[],
  inlineLogs: ExecutionLogEntry[],
): Selection | null {
  const activeStep = [...steps].reverse().find((step) => step.status === "running") ?? steps.at(-1)
  if (activeStep) {
    const stepLogs = inlineLogs.filter((log) => logBelongsToStep(log, activeStep))
    const activeExecution = [...stepLogs].reverse().find((log) => log.status === "running") ?? stepLogs.at(-1)
    if (activeExecution) {
      return { type: "execution", stepId: activeStep.id, logId: activeExecution.id }
    }
    const subActions = activeStep.subActionsData ?? []
    if (subActions.length > 0) {
      return { type: "subaction", stepId: activeStep.id, subIndex: subActions.length - 1 }
    }
    return { type: "step", stepId: activeStep.id }
  }

  const latestHook = [...setupHooks, ...teardownHooks].at(-1)
  return latestHook ? { type: "hook", hookId: latestHook.id } : null
}

export default function LiveRunPage() {
  usePageTitle("Live Run")
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [fallbackRun, setFallbackRun] = useState<RunRow | null>(null)
  const [isLoadingFallback, setIsLoadingFallback] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [isFollowingLatest, setIsFollowingLatest] = useState(true)
  const [activeTab, setActiveTab] = useState("overview")
  const [screenshotSide, setScreenshotSide] = useState<ScreenshotSide | undefined>()
  const pipelineRef = useRef<ReasoningPipelineHandle | null>(null)
  const navigatedRunIdRef = useRef<string | null>(null)
  const finalDetailStateRef = useRef<FinalDetailState>("idle")

  const {
    displaySteps,
    setupHooks,
    teardownHooks,
    inlineLogs,
    suiteTests,
    testInfo,
    runStatus,
    finalStatus,
    elapsed,
    error,
    passedSteps,
    failedSteps,
    progress,
    mergeFinalArtifacts,
  } = useExecutionEvents(id ?? null, fallbackRun?.startedAt)
  const [finalDetailState, setFinalDetailState] = useState<FinalDetailState>("idle")
  const updateFinalDetailState = useCallback((state: FinalDetailState) => {
    finalDetailStateRef.current = state
    setFinalDetailState(state)
  }, [])

  async function handleCancel() {
    if (isCancelling || !id) return
    setIsCancelling(true)
    try {
      await cancelRun(id)
      toast.success("Run cancelled")
    } catch {
      toast.error("Failed to cancel run")
    } finally {
      setIsCancelling(false)
    }
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setFallbackRun(null)
    updateFinalDetailState("idle")
    navigatedRunIdRef.current = null
    setIsLoadingFallback(true)

    fetchRun(id)
      .then((data) => {
        if (!cancelled) {
          setFallbackRun(data.run)
          if (data.tests && data.tests.length > 0) {
            mergeFinalArtifacts({ suiteTests: data.tests })
          }
        }
      })
      .catch((err) => {
        const is404 = err instanceof Error && err.message.includes("404")
        if (!cancelled && !is404) {
          toast.error("Failed to load run details")
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFallback(false)
      })

    return () => {
      cancelled = true
    }
  }, [id, mergeFinalArtifacts, updateFinalDetailState])

  const fallbackIsTerminal = Boolean(fallbackRun && isTerminalRunStatus(fallbackRun.status))

  useEffect(() => {
    if (!id || finalDetailStateRef.current !== "idle") return
    const shouldMerge = runStatus === "complete" || runStatus === "error" || fallbackIsTerminal
    if (!shouldMerge) return

    let cancelled = false
    updateFinalDetailState("loading")

    async function loadFinalArtifacts() {
      try {
        const [runData, logData] = await Promise.all([
          fetchRun(id!),
          fetchExecutionLogs(id!).catch(() => ({ logs: [] })),
        ])
        if (cancelled) return

        const childRuns = []
        if (runData.tests && runData.tests.length > 0) {
          for (const child of runData.tests) {
            try {
              const childData = await fetchRun(child.id)
              if (cancelled) return
              childRuns.push({
                run: childData.run,
                steps: childData.steps,
              })
            } catch {
              childRuns.push({ run: child, steps: [] })
            }
          }
        }

        mergeFinalArtifacts({
          run: runData.run,
          steps: runData.steps,
          logs: logData.logs,
          suiteTests: runData.tests,
          childRuns,
        })
        setFallbackRun(runData.run)
        updateFinalDetailState("ready")
      } catch {
        if (!cancelled) updateFinalDetailState("failed")
      }
    }

    void loadFinalArtifacts()

    return () => {
      cancelled = true
    }
  }, [
    fallbackIsTerminal,
    id,
    mergeFinalArtifacts,
    runStatus,
    updateFinalDetailState,
  ])

  useEffect(() => {
    if (!id || finalDetailState !== "ready") return
    if (navigatedRunIdRef.current === id) return
    navigatedRunIdRef.current = id
    navigate(routes.runDetail(id), { replace: true })
  }, [finalDetailState, id, navigate])

  const liveFaviconState: RunFaviconState = finalStatus
    ? getRunFaviconState(finalStatus)
    : fallbackRun && fallbackIsTerminal
      ? getRunFaviconState(fallbackRun.status)
      : runStatus === "error"
        ? "failed"
        : runStatus === "connecting" || runStatus === "running"
          ? "running"
          : "default"
  useRunStatusFavicon(id ? liveFaviconState : "default")

  const allHooks = useMemo(() => [...setupHooks, ...teardownHooks], [setupHooks, teardownHooks])
  const latestSelection = useMemo(
    () => latestSelectionFor(displaySteps, setupHooks, teardownHooks, inlineLogs),
    [displaySteps, inlineLogs, setupHooks, teardownHooks],
  )
  const latestKey = selectionKey(latestSelection)
  const currentSelectionKey = selectionKey(selection)

  useEffect(() => {
    if (!latestSelection) {
      if (selection) setSelection(null)
      return
    }

    if (isFollowingLatest || !selection) {
      if (currentSelectionKey !== latestKey) setSelection(latestSelection)
      return
    }

    if (!selectionExists(selection, displaySteps, allHooks, inlineLogs)) {
      const parentStep = hasStepId(selection)
        ? displaySteps.find((step) => step.id === selection.stepId)
        : null
      setSelection(parentStep ? { type: "step", stepId: parentStep.id } : latestSelection)
    }
  }, [
    allHooks,
    currentSelectionKey,
    displaySteps,
    inlineLogs,
    isFollowingLatest,
    latestKey,
    latestSelection,
    selection,
  ])

  const handleSelect = useCallback((nextSelection: Selection | null) => {
    setIsFollowingLatest(false)
    setSelection(nextSelection)
  }, [])

  const handleLatest = useCallback(() => {
    setIsFollowingLatest(true)
    if (latestSelection) setSelection(latestSelection)
  }, [latestSelection])

  const selectedStep = useMemo(() => {
    if (!hasStepId(selection)) return null
    return displaySteps.find((step) => step.id === selection.stepId) ?? null
  }, [displaySteps, selection])

  const selectedSubAction = useMemo(() => {
    if (!isSubactionSelection(selection) || !selectedStep) return null
    return selectedStep.subActionsData?.[selection.subIndex] ?? null
  }, [selection, selectedStep])

  const selectedStepLogs = useMemo(() => {
    if (!selectedStep) return []
    return inlineLogs.filter((log) => logBelongsToStep(log, selectedStep))
  }, [inlineLogs, selectedStep])

  const selectedHookLog = useMemo(() =>
    selection?.type === "hook"
      ? allHooks.find((log) => log.id === selection.hookId) ?? null
      : null,
    [allHooks, selection],
  )

  const selectedExecutionLog = useMemo(() =>
    selection?.type === "execution"
      ? inlineLogs.find((log) => log.id === selection.logId) ?? null
      : null,
    [inlineLogs, selection],
  )

  if (!id) {
    return (
      <EmptyState
        icon={Radio}
        title="No run selected"
        description="Select a test run to watch live execution"
      />
    )
  }

  if (runStatus === "idle" && isLoadingFallback) {
    return <DetailSkeleton />
  }

  const alreadyComplete = Boolean(
    fallbackIsTerminal && !finalStatus && runStatus !== "running",
  )
  const testName = testInfo?.name ?? fallbackRun?.name ?? "Test Run"
  const testFile = testInfo?.filePath ?? fallbackRun?.filePath ?? undefined
  const progressPercent = progress.percent ?? 0
  const isRunning = (runStatus === "running" || runStatus === "connecting") && !alreadyComplete
  const isDone = runStatus === "complete" || runStatus === "error" || alreadyComplete
  const terminalDescriptor = getRunStatusDescriptor(finalStatus ?? fallbackRun?.status)
  const hasTerminalStatus = Boolean(finalStatus || alreadyComplete)
  const isFinalizingDetails = finalDetailState === "loading"
  const hasLiveRows = displaySteps.length > 0 || setupHooks.length > 0 || teardownHooks.length > 0
  const suiteSelectedView = suiteTests.length > 0 ? "all" : undefined
  const selectedSubActionIsRunning = selectedSubAction?.result === "in-progress"
  const selectedStepIsRunning = selectedStep?.status === "running"
  const screenshotEmptyState = !isDone && (selectedSubActionIsRunning || (!selectedSubAction && selectedStepIsRunning))
    ? "pending"
    : "absent"

  return (
    <TooltipProvider>
      <div className="flex h-screen min-w-0 flex-col overflow-hidden">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Radio
              className={cn(
                "h-4 w-4 shrink-0",
                isRunning && "animate-pulse text-blue-500",
                isDone && "text-muted-foreground",
              )}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold leading-tight">Live Execution</h2>
                <RunStatusBadge status={alreadyComplete ? "complete" : runStatus} finalStatus={finalStatus ?? fallbackRun?.status} />
              </div>
              <div className="min-w-0 truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{testName}</span>
                {testFile && <span className="ml-2">{testFile}</span>}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLatest}
              disabled={!latestSelection || isFollowingLatest}
              className="h-7 px-2 text-xs"
            >
              Latest
            </Button>
            {isRunning && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={isCancelling}
                className="h-7 px-2 text-xs text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <XCircle className="size-3.5" />
                {isCancelling ? "Cancelling..." : "Cancel"}
              </Button>
            )}
            <span className="flex items-center gap-1 font-mono text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {formatElapsed(elapsed)}
            </span>
            <Button
              size="sm"
              onClick={() => navigate(routes.runDetail(id))}
              className="h-7 px-2 text-xs"
            >
              View Full Results
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="shrink-0 border-b px-3 py-2" data-tour-id="tour-live-run-status">
          {progress.total > 0 && progress.label ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{progress.label}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    runStatus === "error" || (hasTerminalStatus && terminalDescriptor.tone === "danger")
                      ? "bg-destructive"
                      : hasTerminalStatus && terminalDescriptor.tone === "muted"
                        ? "bg-muted-foreground"
                        : "bg-emerald-500",
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          {runStatus === "error" && error ? (
            <div className="mt-2 flex items-start gap-2 rounded-[2px] bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-sm">
                <p className="font-medium">Run Error</p>
                <p className="mt-1 text-xs">{error}</p>
                {isFinalizingDetails && (
                  <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                    Finalizing run details...
                  </p>
                )}
              </div>
            </div>
          ) : hasTerminalStatus ? (
            <div className="mt-2 flex items-center gap-4 text-sm">
              <span
                className={cn(
                  "flex items-center gap-1.5 font-medium",
                  getStatusTextClassName(terminalDescriptor.tone),
                )}
              >
                {terminalDescriptor.normalized === "passed" ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : terminalDescriptor.normalized === "cancelled" ? (
                  <Square className="h-4 w-4" />
                ) : terminalDescriptor.normalized === "flaky" || terminalDescriptor.normalized === "healed" ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                {terminalDescriptor.label}
              </span>
              {displaySteps.length > 0 && (
                <span className="text-muted-foreground">
                  {passedSteps} passed, {failedSteps} failed
                </span>
              )}
              {isFinalizingDetails && (
                <span className="text-muted-foreground" aria-live="polite">
                  Finalizing run details...
                </span>
              )}
              {finalDetailState === "failed" && (
                <span className="text-muted-foreground">
                  Open full results to inspect artifacts.
                </span>
              )}
            </div>
          ) : null}
        </div>

        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <ResizablePanel defaultSize={35} minSize={20}>
            <div className="flex h-full min-h-0 min-w-[280px] flex-col overflow-y-auto">
              {hasLiveRows ? (
                <StepTree
                  steps={displaySteps}
                  selection={selection}
                  onSelect={handleSelect}
                  suiteTests={suiteTests.length > 0 ? suiteTests : undefined}
                  suiteSelectedView={suiteSelectedView}
                  setupHooks={setupHooks}
                  teardownHooks={teardownHooks}
                  inlineLogs={inlineLogs}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Waiting for live events...
                </div>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={65} minSize={30}>
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
              {selection?.type === "hook" && selectedHookLog ? (
                <HookDetailPanel log={selectedHookLog} />
              ) : selection?.type === "execution" && selectedExecutionLog ? (
                <HookDetailPanel log={selectedExecutionLog} />
              ) : (
                <TabPanels
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  step={selectedStep}
                  subAction={selectedSubAction}
                  runId={selectedStep?.rawRunId ?? id}
                  allSteps={displaySteps}
                  executionLogs={selectedStepLogs}
                  platform={fallbackRun?.platform}
                  screenshotSide={screenshotSide}
                  onScreenshotSideChange={(side) => setScreenshotSide(side)}
                  screenshotEmptyState={screenshotEmptyState}
                  pipelineRef={pipelineRef}
                />
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </TooltipProvider>
  )
}
