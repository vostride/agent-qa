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
import { ShortcutLegend } from "@/components/shortcut-hints"
import { useTranslation } from "@/i18n"

const NO_STATUSES: readonly string[] = []

const TAB_STATUS_MAP: Record<string, readonly string[]> = {
  all: NO_STATUSES,
  running: ['running'],
  queued: ['pending'],
  completed: ['passed', 'healed', 'failed', 'timeout', 'cancelled'],
  failed: ['failed', 'timeout'],
}

function showsLiveRuns(statuses: readonly string[]) {
  return statuses.length === 0 || (statuses.length === 1 && statuses[0] === 'running')
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
  const { t } = useTranslation()
  usePageTitle(t("runs.title"))
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

  const mergeActiveExecutions = useCallback(async (
    dbRuns: RunRow[],
    dbTotal: number,
    statuses: readonly string[],
    searchValue: string,
  ) => {
    try {
      if (!showsLiveRuns(statuses)) {
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
          name: e.testName ?? t("runs.runningTest"),
          filePath: null,
          status: "running",
          duration: e.duration,
          attributes: {},
          environment: null,
          metadata: null,
          startedAt: e.startedAt,
          endedAt: null,
          failureSummary: null,
          errorLog: null,
          testId: null,
          suiteId: null,
          platform: "web",
          testFileContent: null,
          modelName: null,
          llmProvider: null,
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
  }, [t])

  const buildFilter = useCallback((opts: {
    name: string
    statuses: readonly string[]
    platform: string
    target: string
    attributes: typeof attributePredicates
    page: number
  }) => ({
    limit: 50,
    offset: (opts.page - 1) * 50,
    name: opts.name || undefined,
    statuses: opts.statuses.length > 0 ? opts.statuses : undefined,
    platform: opts.platform || undefined,
    target: opts.target || undefined,
    attributes: opts.attributes,
  }), [])

  const apiStatuses = TAB_STATUS_MAP[tab] ?? NO_STATUSES

  const loadRuns = useCallback(async (opts: {
    page: number
    name: string
    statuses: readonly string[]
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
      await mergeActiveExecutions(data.runs, data.total, opts.statuses, opts.name)
    } catch {
      toast.error(t("runs.loadFailed"))
    } finally {
      setIsLoading(false)
      setHasLoadedOnce(true)
    }
  }, [mergeActiveExecutions, buildFilter, t])

  const refreshRuns = useCallback(async (opts: {
    page: number
    name: string
    statuses: readonly string[]
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
      await mergeActiveExecutions(data.runs, data.total, opts.statuses, opts.name)
    } catch {
      // Silent failure on background refresh
    }
  }, [mergeActiveExecutions, buildFilter])

  const requestState = useMemo(() => ({
    page,
    name: search,
    statuses: apiStatuses,
    platform,
    target,
    attributes: attributePredicates,
  }), [page, search, apiStatuses, platform, target, attributePredicates])

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
  }, [selectionQueue])

  const handleRun = useCallback(async () => {
    if (selectedRuns.length === 0) return
    const runnablePaths = selectedRuns.flatMap((run) => run.filePath ? [run.filePath] : [])
    if (runnablePaths.length === 0) {
      toast.error(t("runs.noRerunnable"))
      return
    }

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        runnablePaths.map((filePath) => triggerRun({
          file: filePath,
          noCache: !useCache,
        })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(t("runs.queuedWithFailures", { count: succeeded, failed }))
      } else {
        toast.success(t("runs.queued", { count: succeeded }))
      }
      setRunOptionsOpen(false)
    } finally {
      setBatchLoading(false)
    }
  }, [selectedRuns, useCache, t])

  const handlePurgeAllCachedPlans = useCallback(async () => {
    setBatchLoading(true)
    try {
      const { purged } = await purgeCache()
      toast.success(t("runs.purged", { count: purged }))
    } catch (err) {
      toast.error(t("runs.purgeFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBatchLoading(false)
    }
  }, [t])

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
        toast.error(t("runs.deletedWithFailures", { count: deletedRuns.length, failed: failedCount }))
      } else {
        toast.success(t("runs.deleted", { count: deletedRuns.length }))
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedRuns, selectionQueue, t])

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
          title={t("runs.empty.title")}
          description={t("runs.empty.description")}
          actionLabel={t("runs.empty.action")}
          onAction={() => navigate(routes.tests)}
        />
      </div>
    )
  }

  const tabsSlot = (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="flex items-center gap-2">
        <TabsList
          variant="line"
          className="max-w-full justify-start overflow-x-auto [&_[role=tab]]:shrink-0"
        >
          <TabsTrigger value="all">{t("runs.tab.all")}</TabsTrigger>
          <TabsTrigger value="running">
            {t("runs.tab.running")}
            {runningCount > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 text-xs">
                {runningCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="queued">
            {t("runs.tab.queued")}
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-1 px-1.5 text-xs">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="completed">{t("runs.tab.completed")}</TabsTrigger>
          <TabsTrigger value="failed">{t("runs.tab.failed")}</TabsTrigger>
        </TabsList>
        {showConcurrency && queueStatus && (
          <Badge variant="outline" className="text-xs">
            {t("runs.slots", { active: queueStatus.activeSlots, count: queueStatus.concurrency })}
          </Badge>
        )}
      </div>
    </Tabs>
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("runs.title")}</h1>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("runs.shortcuts.label")}>
                <Keyboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="p-3">
              <ShortcutLegend
                hints={[
                  { key: "J / ↓", label: t("runs.shortcuts.nextRow") },
                  { key: "K / ↑", label: t("runs.shortcuts.previousRow") },
                  { key: "Enter", label: t("runs.shortcuts.openRun") },
                  { key: "⌘+Enter", label: t("runs.shortcuts.openInNewTab") },
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
        summaryMeta={selectionQueue.hiddenCount > 0 ? t("runs.hiddenByFilters", { count: selectionQueue.hiddenCount }) : undefined}
        secondaryIcon={<X className="size-4" />}
        secondaryAriaLabel={t("runs.clearQueue")}
        onDelete={handleBatchDelete}
        actionSlot={(
          <div className="flex items-center gap-2">
            <TestRunOptionsPopover
              selectedCount={selectionQueue.selectedCount}
              hiddenCount={selectionQueue.hiddenCount}
              useCache={useCache}
              open={runOptionsOpen}
              onOpenChange={setRunOptionsOpen}
              onUseCacheChange={setUseCache}
              onRun={handleRun}
              disabled={batchLoading}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handlePurgeAllCachedPlans}
              disabled={batchLoading}
            >
              {t("common.run.purgeCache")}
            </Button>
          </div>
        )}
        onCancel={clearQueue}
        isRunning={batchLoading}
      />
    </div>
  )
}
