import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { useNavigate } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import { Play, Keyboard, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TableSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { RunsTable, type VisibleRunRow } from "@/components/runs-table"
import { BatchActionBar } from "@/components/batch-action-bar"
import { TestRunOptionsPopover } from "@/components/test-run-options-popover"
import { deleteRun, fetchRuns, fetchActiveExecutions, fetchQueueStatus, triggerRun, purgeCache, type RunRow, type QueueStatus } from "@/lib/api"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { useRunsSearchParams } from "@/hooks/use-runs-search-params"
import { usePageTitle } from "@/hooks/use-page-title"
import { useSelectionQueue } from "@/hooks/use-selection-queue"
import { useRunConfig } from "@/hooks/use-run-config"
import { ShortcutLegend } from "@/components/shortcut-hints"

const TAB_STATUS_MAP: Record<string, string> = {
  all: '',
  running: 'running',
  queued: 'pending',
  completed: 'passed',
  failed: 'failed',
}

function matchesSyntheticRunSearch(
  searchValue: string,
  execution: { runId: string; testName?: string | null },
) {
  const normalizedSearch = searchValue.trim().toLowerCase()
  if (!normalizedSearch) return true

  const runIdMatches = execution.runId.toLowerCase().includes(normalizedSearch)
  const testNameMatches = (execution.testName ?? '').toLowerCase().includes(normalizedSearch)
  return runIdMatches || testNameMatches
}

export default function RunsPage() {
  usePageTitle("Runs")
  const navigate = useNavigate()
  const [runs, setRuns] = useState<RunRow[]>([])
  const [total, setTotal] = useState(0)
  const [targetOptions, setTargetOptions] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const {
    tab,
    search,
    platform,
    target,
    attributePredicates,
    page,
    sorting,
    onSortingChange,
    setTab,
    setSearch,
    setPlatform,
    setTarget,
    setAttributePredicates,
    setPage,
  } = useRunsSearchParams()
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [visibleRuns, setVisibleRuns] = useState<VisibleRunRow[]>([])
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(() => new Set())
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null)
  const [batchLoading, setBatchLoading] = useState(false)
  const [runOptionsOpen, setRunOptionsOpen] = useState(false)
  const [useCache, setUseCache] = useState(true)
  const [useMemory, setUseMemory] = useState(true)
  const { hasFarm, isLoading: isRunConfigLoading } = useRunConfig()

  const mergeActiveExecutions = useCallback(async (
    dbRuns: RunRow[],
    dbTotal: number,
    statusFilter: string,
    searchValue: string,
  ) => {
    try {
      if (statusFilter && statusFilter !== 'running') {
        setRuns(dbRuns)
        setTotal(dbTotal)
        return
      }
      const { executions } = await fetchActiveExecutions()
      if (executions.length === 0) {
        setRuns(dbRuns)
        setTotal(dbTotal)
        return
      }
      const dbIds = new Set(dbRuns.map(r => r.id))
      const syntheticRuns: RunRow[] = executions
        .filter(e => !dbIds.has(e.runId))
        .filter(e => matchesSyntheticRunSearch(searchValue, e))
        .map(e => ({
          id: e.runId,
          name: e.testName ?? `Running test...`,
          filePath: null,
          status: "running",
          duration: e.duration,
          attributes: {},
          environment: null,
          metadata: null,
          startedAt: e.startedAt,
          endedAt: null,
          videoPath: null,
          failureSummary: null,
          errorLog: null,
          memoryLog: null,
          testId: null,
          suiteId: null,
          platform: "web",
          testFileContent: null,
          modelName: null,
          llmProvider: null,
          parentRunId: null,
          attemptNumber: 1,
          retryCount: 0,
          maxRetries: 0,
          createdAt: e.startedAt,
        }))
      setRuns([...syntheticRuns, ...dbRuns])
      setTotal(dbTotal + syntheticRuns.length)
    } catch {
      setRuns(dbRuns)
      setTotal(dbTotal)
    }
  }, [])

  const buildFilter = useCallback((opts: {
    name: string
    status: string
    platform: string
    target: string
    attributes: typeof attributePredicates
    page: number
  }) => ({
    limit: 50,
    offset: (opts.page - 1) * 50,
    name: opts.name || undefined,
    status: opts.status || undefined,
    platform: opts.platform || undefined,
    target: opts.target || undefined,
    attributes: opts.attributes,
  }), [])

  const apiStatus = TAB_STATUS_MAP[tab] ?? ''

  const loadRuns = useCallback(async (opts: {
    page: number
    name: string
    status: string
    platform: string
    target: string
    attributes: typeof attributePredicates
  }) => {
    try {
      setIsLoading(true)
      const [data, qs] = await Promise.all([
        fetchRuns(buildFilter(opts)),
        fetchQueueStatus(),
      ])
      setQueueStatus(qs)
      setTargetOptions(data.targets ?? [])
      await mergeActiveExecutions(data.runs, data.total, opts.status, opts.name)
    } catch {
      toast.error("Failed to load runs")
    } finally {
      setIsLoading(false)
      setHasLoadedOnce(true)
    }
  }, [mergeActiveExecutions, buildFilter])

  const refreshRuns = useCallback(async (opts: {
    page: number
    name: string
    status: string
    platform: string
    target: string
    attributes: typeof attributePredicates
  }) => {
    try {
      const [data, qs] = await Promise.all([
        fetchRuns(buildFilter(opts)),
        fetchQueueStatus(),
      ])
      setQueueStatus(qs)
      setTargetOptions(data.targets ?? [])
      await mergeActiveExecutions(data.runs, data.total, opts.status, opts.name)
    } catch {
      // Silent failure on background refresh
    }
  }, [mergeActiveExecutions, buildFilter])

  const requestState = useMemo(() => ({
    page,
    name: search,
    status: apiStatus,
    platform,
    target,
    attributes: attributePredicates,
  }), [page, search, apiStatus, platform, target, attributePredicates])

  useEffect(() => {
    loadRuns(requestState)
  }, [loadRuns, requestState])

  useEffect(() => {
    if (!hasLoadedOnce) return
    const interval = setInterval(() => {
      refreshRuns(requestState)
    }, 5000)
    return () => clearInterval(interval)
  }, [hasLoadedOnce, refreshRuns, requestState])

  useEffect(() => {
    setSelectedRunId(null)
    setExpandedSuites(new Set())
    setVisibleRuns([])
  }, [tab, search, platform, target, attributePredicates, page])

  useEffect(() => {
    if (!selectedRunId) return
    if (visibleRuns.some((row) => row.id === selectedRunId)) return

    const parentRun = runs.find((run) => run.tests?.some((child) => child.id === selectedRunId))
    setSelectedRunId(parentRun?.id ?? null)
  }, [runs, selectedRunId, visibleRuns])

  const selectionQueue = useSelectionQueue({
    items: runs,
    getId: (run) => run.id,
    visibleIds: runs.map((run) => run.id),
  })

  const selectedIds = selectionQueue.selectedIds
  const selectedRuns = selectionQueue.selectedItems

  const clearQueue = useCallback(() => {
    selectionQueue.clearSelection()
    setRunOptionsOpen(false)
    setUseCache(true)
    setUseMemory(true)
  }, [selectionQueue])

  const handleRunDestination = useCallback(async (local: boolean) => {
    if (selectedRuns.length === 0) return
    const runnablePaths = selectedRuns.flatMap((run) => run.filePath ? [run.filePath] : [])
    if (runnablePaths.length === 0) {
      toast.error("No selected runs can be rerun")
      return
    }

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        runnablePaths.map((filePath) => triggerRun({
          file: filePath,
          local,
          noCache: !useCache,
          noMemory: !useMemory,
        })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`${succeeded} runs queued, ${failed} failed`)
      } else {
        toast.success(`${succeeded} runs queued`)
      }
      setRunOptionsOpen(false)
    } finally {
      setBatchLoading(false)
    }
  }, [selectedRuns, useCache, useMemory])

  const handleBatchPurgeCache = useCallback(async () => {
    if (selectedRuns.length === 0) return
    const filePaths = Array.from(new Set(
      selectedRuns.flatMap((run) => run.filePath ? [run.filePath] : []),
    ))
    if (filePaths.length === 0) {
      toast.error("No selected runs have file paths to purge")
      return
    }

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        filePaths.map((filePath) => purgeCache({ file: filePath })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const totalPurged = results
        .filter((r): r is PromiseFulfilledResult<{ purged: number }> => r.status === "fulfilled")
        .reduce((sum, r) => sum + r.value.purged, 0)
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`Purged ${totalPurged} plans from ${succeeded} tests, ${failed} failed`)
      } else {
        toast.success(`Purged ${totalPurged} cached plan${totalPurged !== 1 ? 's' : ''} from ${succeeded} test${succeeded !== 1 ? 's' : ''}`)
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedRuns])

  const handleBatchDelete = useCallback(async () => {
    if (selectedRuns.length === 0) return

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedRuns.map((run) => deleteRun(run.id)),
      )

      const deletedRuns = selectedRuns.filter((_, index) => results[index]?.status === "fulfilled")
      const deletedRunIds = new Set(
        results.flatMap((result) =>
          result.status === "fulfilled" ? result.value.deletedRunIds : [],
        ),
      )
      const failedCount = results.length - deletedRuns.length

      if (deletedRuns.length > 0) {
        selectionQueue.setItemsSelected(deletedRuns, false)
        setRuns((current) => current.filter((run) => !deletedRunIds.has(run.id)))
        setTotal((current) => Math.max(0, current - deletedRuns.length))
        setRunOptionsOpen(false)
      }

      if (failedCount > 0) {
        toast.error(`Deleted ${deletedRuns.length} run${deletedRuns.length !== 1 ? "s" : ""}, ${failedCount} failed`)
      } else {
        toast.success(`Deleted ${deletedRuns.length} run${deletedRuns.length !== 1 ? "s" : ""}`)
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedRuns, selectionQueue])

  const handleToggleSuite = useCallback((suiteId: string) => {
    setExpandedSuites((current) => {
      const next = new Set(current)
      if (next.has(suiteId)) {
        next.delete(suiteId)
      } else {
        next.add(suiteId)
      }
      return next
    })
  }, [])

  const openRun = useCallback((run: RunRow, trigger?: {
    metaKey?: boolean
    ctrlKey?: boolean
    button?: number
  }) => {
    const href = routes.runDetailOrLive(run.id, run.status)
    const shouldOpenInNewTab =
      Boolean(trigger?.metaKey || trigger?.ctrlKey) ||
      trigger?.button === 1

    if (shouldOpenInNewTab) {
      window.open(href, "_blank", "noopener,noreferrer")
      return
    }

    navigate(href)
  }, [navigate])

  const handleOpenRun = useCallback((
    run: RunRow,
    event?: ReactKeyboardEvent<Element> | ReactMouseEvent<Element>,
  ) => {
    openRun(run, event)
  }, [openRun])

  const selectedRunIndex = useMemo(
    () => visibleRuns.findIndex((row) => row.id === selectedRunId),
    [selectedRunId, visibleRuns],
  )

  const shortcuts = useMemo(() => {
    const moveSelection = (direction: 1 | -1) => {
      if (visibleRuns.length === 0) return

      if (selectedRunIndex === -1) {
        setSelectedRunId(direction > 0 ? visibleRuns[0]!.id : visibleRuns[visibleRuns.length - 1]!.id)
        return
      }

      const nextIndex = Math.max(0, Math.min(selectedRunIndex + direction, visibleRuns.length - 1))
      setSelectedRunId(visibleRuns[nextIndex]!.id)
    }

    const next = () => moveSelection(1)
    const prev = () => moveSelection(-1)

    return {
      j: next,
      arrowdown: next,
      k: prev,
      arrowup: prev,
      enter: (e: KeyboardEvent) => {
        if (selectedRunIndex < 0) return
        openRun(visibleRuns[selectedRunIndex]!.run, e)
      },
    }
  }, [openRun, selectedRunIndex, visibleRuns])
  useKeyboardShortcuts(shortcuts)

  const runningCount = queueStatus?.running.count ?? 0
  const pendingCount = queueStatus?.pending.count ?? 0
  const showConcurrency = pendingCount > 0 || runningCount > 0

  if (!hasLoadedOnce) return <TableSkeleton />

  const hasFilters = !!search || tab !== "all" || !!platform || !!target || attributePredicates.length > 0
  if (runs.length === 0 && !hasFilters) {
    return (
      <div data-tour-id="tour-runs-table">
        <EmptyState
          icon={Play}
          title="No test runs yet"
          description="Run your first test to see results here"
          actionLabel="View Tests"
          onAction={() => navigate(routes.tests)}
        />
      </div>
    )
  }

  const tabsSlot = (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="flex items-center gap-2">
        <TabsList variant="line">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="running">
            Running
            {runningCount > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 text-xs">
                {runningCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="queued">
            Queued
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 text-xs">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="failed">Failed</TabsTrigger>
        </TabsList>
        {showConcurrency && queueStatus && (
          <Badge variant="outline" className="text-xs">
            {queueStatus.activeSlots}/{queueStatus.concurrency} slots
          </Badge>
        )}
      </div>
    </Tabs>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
                <Keyboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="p-3">
              <ShortcutLegend
                hints={[
                  { key: "J / ↓", label: "Next row" },
                  { key: "K / ↑", label: "Previous row" },
                  { key: "Enter", label: "Open run" },
                  { key: "⌘+Enter", label: "Open in new tab" },
                ]}
              />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <RunsTable
        topSlot={tabsSlot}
        runs={runs}
        total={total}
        isLoading={isLoading}
        page={page - 1}
        onPageChange={(p) => setPage(p + 1)}
        onSearchChange={setSearch}
        searchValue={search}
        selectedRunId={selectedRunId}
        onSelectedRunIdChange={setSelectedRunId}
        expandedSuites={expandedSuites}
        onToggleSuite={handleToggleSuite}
        onOpenRun={handleOpenRun}
        onVisibleRunsChange={setVisibleRuns}
        platformFilter={platform}
        onPlatformChange={setPlatform}
        targetFilter={target}
        targetOptions={targetOptions}
        onTargetChange={setTarget}
        attributePredicates={attributePredicates}
        onAttributePredicatesChange={setAttributePredicates}
        sorting={sorting}
        onSortingChange={onSortingChange}
        enableSelection
        selectedRunIds={selectionQueue.selectedIdSet}
        onToggleRunSelection={selectionQueue.setItemSelected}
        onToggleVisibleSelection={selectionQueue.setItemsSelected}
      />
      <BatchActionBar
        selectedCount={selectedIds.length}
        summaryMeta={selectionQueue.hiddenCount > 0 ? `${selectionQueue.hiddenCount} hidden by filters` : undefined}
        secondaryIcon={<X className="size-4" />}
        secondaryAriaLabel="Clear queue"
        onDelete={handleBatchDelete}
        actionSlot={(
          <div className="flex items-center gap-2">
            <TestRunOptionsPopover
              selectedCount={selectionQueue.selectedCount}
              hiddenCount={selectionQueue.hiddenCount}
              useCache={useCache}
              useMemory={useMemory}
              browserStackAvailable={!isRunConfigLoading && hasFarm}
              open={runOptionsOpen}
              onOpenChange={setRunOptionsOpen}
              onUseCacheChange={setUseCache}
              onUseMemoryChange={setUseMemory}
              onRunLocal={() => handleRunDestination(true)}
              onRunBrowserStack={() => handleRunDestination(false)}
              disabled={batchLoading}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBatchPurgeCache}
              disabled={batchLoading}
            >
              Purge cache
            </Button>
          </div>
        )}
        onCancel={clearQueue}
        isRunning={batchLoading}
      />
    </div>
  )
}
