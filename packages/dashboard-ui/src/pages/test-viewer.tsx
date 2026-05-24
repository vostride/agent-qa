import { useState, useEffect, useMemo } from "react"
import { useParams, useNavigate, Link, useSearchParams } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  Zap,
  FileCode,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EditorSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { MonacoEditor } from "@/components/monaco-editor"
import { VisualBuilder } from "@/components/visual-builder"
import { TestNavbar } from "@/components/test-navbar"
import { useOptionalProductTour } from "@/components/product-tour"
import { SharedScopeMemoryReader } from "@/components/memory-reader/shared-scope-memory-reader"
import {
  InsightsLineCell,
  InsightsLineGrid,
} from "@/components/insights/insights-line-grid"
import { PassRateChart } from "@/components/pass-rate-chart"
import { DurationChart } from "@/components/duration-chart"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import { useRunConfig } from "@/hooks/use-run-config"
import {
  fetchTestFile,
  fetchTestAnalytics,
  triggerRun,
  purgeCache,
  type TestAnalyticsDetail,
} from "@/lib/api"
import {
  normalizeViewerUrlState,
  serializeViewerUrlState,
  type ViewerTopTab,
} from "@/lib/viewer-url-state"
import { formatDuration, formatDate, formatDateShort, normalizeTimestamp } from "@/lib/utils"

function formatRelativeCompact(iso: string): string {
  if (!iso) return ''
  const date = new Date(normalizeTimestamp(iso))
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return formatDate(iso)
}

type MetricScopeMode = "scoped" | "all"

function MetricScopeControl({
  configured,
  mode,
  scopedCount,
  totalCount,
  onModeChange,
}: {
  configured: boolean
  mode: MetricScopeMode
  scopedCount: number
  totalCount: number
  onModeChange: (mode: MetricScopeMode) => void
}) {
  if (!configured) {
    return <p className="text-xs text-muted-foreground">No analytics scope configured</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded border border-border p-0.5">
        {(["scoped", "all"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="xs"
            variant={mode === value ? "default" : "ghost"}
            aria-pressed={mode === value}
            className="h-7 rounded-[2px] px-2 text-xs"
            onClick={() => onModeChange(value)}
          >
            {value === "scoped" ? "Scoped" : "All runs"}
          </Button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {scopedCount} scoped / {totalCount} total runs
      </span>
    </div>
  )
}

const VALID_TEST_VIEWS = ['builder', 'yaml', 'memory'] as const
type TestViewerView = typeof VALID_TEST_VIEWS[number]

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/20">
          Passed
        </Badge>
      )
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
    case "healed":
      return (
        <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">
          Healed
        </Badge>
      )
    case "flaky":
      return (
        <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">
          Flaky
        </Badge>
      )
    case "running":
      return (
        <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/20 animate-pulse">
          Running
        </Badge>
      )
    case "cancelled":
      return (
        <Badge className="bg-muted text-muted-foreground border-border">
          Cancelled
        </Badge>
      )
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function RunHistoryTable({
  runs,
}: {
  runs: TestAnalyticsDetail["runs"]
}) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        No runs yet — click Run to start
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.id}
            className="relative cursor-pointer hover:bg-muted/50"
          >
            <TableCell>
              <Link
                to={routes.runDetailOrLive(run.id, run.status)}
                className="absolute inset-0"
                tabIndex={-1}
              />
              <StatusBadge status={run.status} />
            </TableCell>
            <TableCell>
              {run.status === "running" ? (
                <span className="text-blue-500 text-sm">In progress...</span>
              ) : (
                <span className="text-muted-foreground">
                  {formatDuration(run.duration)}
                </span>
              )}
            </TableCell>
            <TableCell>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground">
                    {formatDate(run.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {formatDateShort(run.createdAt)}
                </TooltipContent>
              </Tooltip>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function TestViewerPage() {
  const { t_id } = useParams<{ t_id: string }>()
  const navigate = useNavigate()
  const { defaultRunMode } = useRunConfig()
  const [searchParams, setSearchParams] = useSearchParams()
  const productTour = useOptionalProductTour()

  const testId = t_id ?? ""
  const viewerState = useMemo(
    () => normalizeViewerUrlState(searchParams, VALID_TEST_VIEWS),
    [searchParams],
  )
  const canonicalViewerState = useMemo(
    () => serializeViewerUrlState(viewerState, searchParams),
    [searchParams, viewerState],
  )
  const activeTab = viewerState.tab
  const activeView = viewerState.view

  const [content, setContent] = useState("")
  const [filePath, setFilePath] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [analyticsData, setAnalyticsData] =
    useState<TestAnalyticsDetail | null>(null)
  const [metricScopeMode, setMetricScopeMode] = useState<MetricScopeMode>("all")
  const [isRunning, setIsRunning] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const testName = useMemo(() => {
    const match = content.match(/^name:\s*(.+)$/m)
    return match ? match[1].trim() : null
  }, [content])

  usePageTitle(testName || "Test")

  const scopeConfigured = analyticsData?.scope?.configured === true
  const selectedTrends = metricScopeMode === "scoped" && scopeConfigured && analyticsData?.scopedTrends
    ? analyticsData.scopedTrends
    : analyticsData?.trends
  const selectedFlakyScore = metricScopeMode === "scoped" && scopeConfigured && analyticsData?.scopedFlakyScore !== undefined
    ? analyticsData.scopedFlakyScore
    : analyticsData?.flakyScore ?? 0
  const selectedRuns = metricScopeMode === "scoped" && scopeConfigured
    ? analyticsData?.scopedRuns ?? []
    : analyticsData?.runs ?? []

  const passRateData = useMemo(() => {
    if (!selectedTrends?.daily) return []
    return selectedTrends.daily.map((d) => ({
      date: d.date,
      passRate:
        d.total > 0 ? Math.round((d.passed / d.total) * 1000) / 10 : 0,
    }))
  }, [selectedTrends])

  const durationData = useMemo(() => {
    if (!analyticsData?.trends.daily) return []
    return analyticsData.trends.daily.map((d) => ({
      date: d.date,
      duration: d.avgDuration,
    }))
  }, [analyticsData])

  const runs = selectedRuns

  useEffect(() => {
    if (!analyticsData) return
    setMetricScopeMode(analyticsData.scope?.configured ? "scoped" : "all")
  }, [analyticsData])

  useEffect(() => {
    if (canonicalViewerState.toString() !== searchParams.toString()) {
      setSearchParams(canonicalViewerState, { replace: true })
    }
  }, [canonicalViewerState, searchParams, setSearchParams])

  useEffect(() => {
    if (!testId) {
      setNotFound(true)
      setIsLoading(false)
      return
    }

    let cancelled = false

    fetchTestFile(testId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content)
          setFilePath(data.path)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotFound(true)
          toast.error("Failed to load test file")
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [testId])

  useEffect(() => {
    if (!testName) return
    let cancelled = false
    fetchTestAnalytics(testName, { limit: 50 })
      .then((data) => {
        if (!cancelled) setAnalyticsData(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [testName])

  const handleRun = async (local: boolean) => {
    if (isRunning) return
    setIsRunning(true)
    try {
      const result = await triggerRun({ file: filePath, local })
      toast.success("Run started")
      productTour?.advanceAfterRunStarted(result.runId, result.status)
      navigate(routes.runLive(result.runId))
    } catch (err) {
      toast.error(
        `Failed to start run: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setIsRunning(false)
    }
  }

  const handleRunNoCache = async (local: boolean) => {
    if (isRunning) return
    setIsRunning(true)
    try {
      const result = await triggerRun({ file: filePath, noCache: true, local })
      toast.success("Run started (no cache)")
      productTour?.advanceAfterRunStarted(result.runId, result.status)
      navigate(routes.runLive(result.runId))
    } catch (err) {
      toast.error(
        `Failed to start run: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setIsRunning(false)
    }
  }

  const handlePurgeCache = async () => {
    try {
      const { purged } = await purgeCache({ file: filePath })
      toast.success(`Purged ${purged} cached plan${purged !== 1 ? 's' : ''}`)
    } catch (err) {
      toast.error(
        `Cache purge failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const editRoute = routes.testEdit(testId)
  const liveRoute = routes.testEditLive(testId)

  useKeyboardShortcuts({
    e: () => navigate(editRoute),
    r: () => { void handleRun(defaultRunMode === 'local') },
    l: () => navigate(liveRoute),
  })

  const updateViewerState = (nextState: { tab: ViewerTopTab; view: TestViewerView }) => {
    setSearchParams(serializeViewerUrlState(nextState, searchParams), { replace: true })
  }

  if (isLoading) return <EditorSkeleton />

  if (notFound) {
    return (
      <EmptyState
        icon={FileCode}
        title="Test not found"
        description="This test file doesn't exist"
        actionLabel="View All Tests"
        onAction={() => navigate(routes.tests)}
      />
    )
  }

  const builderPanel = (
    <VisualBuilder content={content} onChange={() => {}} disabled />
  )

  const monacoPanel = (
    <MonacoEditor
      value={content}
      onChange={() => {}}
      readOnly
      className="h-full"
    />
  )

  const sidebarPanel = analyticsData && (
    <aside
      data-testid="test-detail-analytics-sidebar"
      className="flex flex-col gap-0 overflow-y-auto border-t border-border md:border-t-0 md:border-l md:border-border"
    >
      <div className="border-b border-border px-3 py-2">
        <MetricScopeControl
          configured={scopeConfigured}
          mode={metricScopeMode}
          scopedCount={analyticsData.scope?.scopedCount ?? 0}
          totalCount={analyticsData.scope?.totalCount ?? analyticsData.total}
          onModeChange={setMetricScopeMode}
        />
      </div>

      <InsightsLineGrid className="grid-cols-2 divide-x divide-y-0 border-x-0 border-t-0">
        <InsightsLineCell className="flex flex-col gap-0.5 px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Pass Rate</span>
          <span className="text-xl font-semibold text-foreground">
            {Math.round((selectedTrends ?? analyticsData.trends).passRate * 100)}%
          </span>
        </InsightsLineCell>
        <InsightsLineCell className="flex flex-col gap-0.5 px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Avg Duration</span>
          <span className="text-xl font-semibold text-foreground">
            {formatDuration(analyticsData.trends.avgDuration)}
          </span>
        </InsightsLineCell>
        <InsightsLineCell className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total Runs</span>
          <span className="text-xl font-semibold text-foreground">
            {analyticsData.total.toLocaleString()}
          </span>
        </InsightsLineCell>
        <InsightsLineCell className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Flaky Score</span>
          <span className="text-xl font-semibold text-foreground">
            {(selectedFlakyScore * 100).toFixed(0)}%
          </span>
        </InsightsLineCell>
      </InsightsLineGrid>

      <InsightsLineGrid className="border-x-0 border-y-0">
        <InsightsLineCell className="flex flex-col gap-2 px-3 py-3">
          <span className="text-sm font-medium text-foreground">
            {metricScopeMode === "scoped" && scopeConfigured ? "Scoped Runs" : "All Runs"} ({runs.length})
          </span>
          {runs.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-sm text-muted-foreground">
              No runs yet
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.slice(0, 5).map((run) => (
                  <TableRow
                    key={run.id}
                    className="relative cursor-pointer hover:bg-muted/50"
                  >
                    <TableCell>
                      <Link
                        to={routes.runDetailOrLive(run.id, run.status)}
                        className="absolute inset-0"
                        tabIndex={-1}
                      />
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>
                      {run.status === "running" ? (
                        <span className="text-blue-500 text-sm">In progress...</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {formatDuration(run.duration)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">
                        {formatRelativeCompact(run.createdAt)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </InsightsLineCell>
      </InsightsLineGrid>
    </aside>
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen">
        <TestNavbar
          testName={testName || "Test"}
          testId={testId}
          unsaved={false}
          isCreateMode={false}
          mode="view"
          testHref={editRoute}
          isSaving={false}
          isValidating={false}
          isRunning={isRunning}
          runButtonTourId="tour-test-run-action"
          hasInvalidFilename={false}
          showTestId={false}
          onBack={() => navigate(routes.tests)}
          onSave={() => {}}
          onValidate={() => {}}
          onRun={(local) => handleRun(local)}
          onLiveConnect={() => navigate(liveRoute)}
          onSettingsOpen={() => {}}
          shortcutsOpen={shortcutsOpen}
          onToggleShortcuts={() => setShortcutsOpen(prev => !prev)}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => updateViewerState({ tab: value as ViewerTopTab, view: activeView })}
          className="flex-1 min-h-0 flex flex-col"
        >
          <div className="px-4 border-b border-border">
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="insights">Insights</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value="overview"
            data-tour-id="tour-test-detail-overview"
            className="flex-1 min-h-0 mt-0 grid grid-cols-1 md:grid-cols-[minmax(480px,1fr)_minmax(260px,320px)]"
          >
            <div className="min-w-0 min-h-0 flex flex-col">
              <Tabs
                value={activeView}
                onValueChange={(value) => updateViewerState({ tab: activeTab, view: value as TestViewerView })}
                className="flex-1 min-h-0 flex flex-col"
              >
                <div className="px-4 border-b border-border">
                  <TabsList
                    variant="line"
                    className="w-full grid grid-cols-3 md:w-fit md:inline-flex"
                  >
                    <TabsTrigger value="builder">Builder</TabsTrigger>
                    <TabsTrigger value="yaml">YAML</TabsTrigger>
                    <TabsTrigger value="memory">Memory</TabsTrigger>
                  </TabsList>
                </div>
                <div className="relative flex-1 min-h-0">
                  <TabsContent
                    value="builder"
                    className="absolute inset-0 overflow-y-auto data-[state=inactive]:hidden"
                  >
                    {builderPanel}
                  </TabsContent>
                  <TabsContent
                    value="yaml"
                    className="absolute inset-0 data-[state=inactive]:hidden"
                  >
                    {monacoPanel}
                  </TabsContent>
                  <TabsContent
                    value="memory"
                    className="absolute inset-0 overflow-y-auto data-[state=inactive]:hidden"
                  >
                    <SharedScopeMemoryReader
                      scope="test"
                      scopeId={testId}
                      emptyTitle="No test memory yet"
                      emptyDescription="This test doesn't have cataloged observations in this workspace yet. Run the test with memory enabled, then reopen this tab."
                    />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
            {sidebarPanel}
          </TabsContent>

          <TabsContent value="insights" className="flex-1 overflow-y-auto mt-0">
            <div data-testid="test-detail-insights" className="px-4 py-3">
              {analyticsData ? (
                <div className="space-y-3">
                {analyticsData.isFlaky && (
                  <Badge variant="destructive">
                    <Zap className="size-3" />
                    Flaky (score: {analyticsData.flakyScore.toFixed(2)})
                  </Badge>
                )}

                <InsightsLineGrid className="grid-cols-2 divide-x divide-y-0 md:grid-cols-4">
                  <InsightsLineCell className="border-b border-border md:border-b-0">
                    <div>
                        <p className="text-sm text-muted-foreground">Total Runs</p>
                        <p className="text-2xl font-semibold mt-0.5">{analyticsData.total.toLocaleString()}</p>
                    </div>
                  </InsightsLineCell>
                  <InsightsLineCell className="border-b border-border md:border-b-0 md:border-r">
                    <div>
                        <p className="text-sm text-muted-foreground">Pass Rate</p>
                        <p className="text-2xl font-semibold mt-0.5">{Math.round((selectedTrends ?? analyticsData.trends).passRate * 100)}%</p>
                    </div>
                  </InsightsLineCell>
                  <InsightsLineCell>
                    <div>
                        <p className="text-sm text-muted-foreground">Avg Duration</p>
                        <p className="text-2xl font-semibold mt-0.5">{formatDuration(analyticsData.trends.avgDuration)}</p>
                    </div>
                  </InsightsLineCell>
                  <InsightsLineCell>
                    <div>
                        <p className="text-sm text-muted-foreground">Flaky Score</p>
                        <p className="text-2xl font-semibold mt-0.5">{(selectedFlakyScore * 100).toFixed(0)}%</p>
                    </div>
                  </InsightsLineCell>
                </InsightsLineGrid>

                <InsightsLineGrid>
                  <InsightsLineCell className="px-4 py-3">
                    <MetricScopeControl
                      configured={scopeConfigured}
                      mode={metricScopeMode}
                      scopedCount={analyticsData.scope?.scopedCount ?? 0}
                      totalCount={analyticsData.scope?.totalCount ?? analyticsData.total}
                      onModeChange={setMetricScopeMode}
                    />
                  </InsightsLineCell>
                </InsightsLineGrid>

                {(selectedTrends?.daily.length ?? 0) > 0 && (
                  <InsightsLineGrid className="md:grid-cols-2 md:divide-x md:divide-y-0">
                    <InsightsLineCell className="px-4 py-3">
                        <p className="text-sm font-medium mb-2">Pass Rate</p>
                        <div className="h-[160px] overflow-hidden">
                          <PassRateChart data={passRateData} />
                        </div>
                    </InsightsLineCell>
                    <InsightsLineCell className="px-4 py-3">
                        <p className="text-sm font-medium mb-2">Duration</p>
                        <div className="h-[160px] overflow-hidden">
                          <DurationChart data={durationData} />
                        </div>
                    </InsightsLineCell>
                  </InsightsLineGrid>
                )}

                <InsightsLineGrid>
                  <InsightsLineCell className="px-4 py-3">
                    <p className="text-sm font-medium mb-2">
                      {metricScopeMode === "scoped" && scopeConfigured ? "Scoped Runs" : "All Runs"} ({runs.length})
                    </p>
                    <RunHistoryTable runs={runs} />
                  </InsightsLineCell>
                </InsightsLineGrid>
                </div>
              ) : (
                <InsightsLineGrid>
                  <InsightsLineCell className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    No analytics data available
                  </InsightsLineCell>
                </InsightsLineGrid>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  )
}
