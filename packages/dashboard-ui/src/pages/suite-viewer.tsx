import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import { FileCode, Zap } from "lucide-react"
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
import { SuiteVisualBuilder } from "@/components/suite-visual-builder"
import { SuiteNavbar } from "@/components/suite-navbar"
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
  fetchSuiteAnalytics,
  fetchSuiteFile,
  triggerRun,
  type SuiteAnalyticsDetail,
} from "@/lib/api"
import {
  normalizeViewerUrlState,
  serializeViewerUrlState,
  type ViewerTopTab,
} from "@/lib/viewer-url-state"
import {
  formatDate,
  formatDateShort,
  formatDuration,
  normalizeTimestamp,
} from "@/lib/utils"

const VALID_SUITE_VIEWS = ["builder", "yaml", "memory"] as const
type SuiteViewerView = (typeof VALID_SUITE_VIEWS)[number]
type MetricScopeMode = "scoped" | "all"

function normalizeSuiteName(rawName: string): string {
  const trimmedName = rawName.trim()
  if (
    trimmedName.length >= 2 &&
    ((trimmedName.startsWith('"') && trimmedName.endsWith('"')) ||
      (trimmedName.startsWith("'") && trimmedName.endsWith("'")))
  ) {
    return trimmedName.slice(1, -1).trim()
  }
  return trimmedName
}

function createEmptySuiteAnalytics(suiteId: string): SuiteAnalyticsDetail {
  return {
    suiteId,
    total: 0,
    flakyScore: 0,
    isFlaky: false,
    runs: [],
    trends: {
      daily: [],
      passRate: 0,
      totalRuns: 0,
      avgDuration: 0,
    },
  }
}

function formatRelativeCompact(iso: string): string {
  if (!iso) return ""
  const date = new Date(normalizeTimestamp(iso))
  const diffMs = Date.now() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return "just now"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return formatDate(iso)
}

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

function RunHistoryTable({
  runs,
  compactDate = false,
}: {
  runs: SuiteAnalyticsDetail["runs"]
  compactDate?: boolean
}) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-16 text-sm text-muted-foreground">
        No runs yet
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
              {compactDate ? (
                <span className="text-muted-foreground">
                  {formatRelativeCompact(run.createdAt)}
                </span>
              ) : (
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
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function SuiteViewerPage() {
  const params = useParams<{ "suite-id": string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { defaultRunMode } = useRunConfig()

  const suiteId = params["suite-id"] ?? ""
  const viewerState = useMemo(
    () => normalizeViewerUrlState(searchParams, VALID_SUITE_VIEWS),
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
  const [analyticsData, setAnalyticsData] = useState<SuiteAnalyticsDetail>(() =>
    createEmptySuiteAnalytics(suiteId),
  )
  const [metricScopeMode, setMetricScopeMode] = useState<MetricScopeMode>("all")
  const [isRunning, setIsRunning] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const suiteName = useMemo(() => {
    const match = content.match(/^name:\s*(.+)$/m)
    return match ? normalizeSuiteName(match[1]) : null
  }, [content])

  usePageTitle(suiteName || "Suite")

  const scopeConfigured = analyticsData.scope?.configured === true
  const selectedTrends = metricScopeMode === "scoped" && scopeConfigured && analyticsData.scopedTrends
    ? analyticsData.scopedTrends
    : analyticsData.trends
  const selectedFlakyScore = metricScopeMode === "scoped" && scopeConfigured && analyticsData.scopedFlakyScore !== undefined
    ? analyticsData.scopedFlakyScore
    : analyticsData.flakyScore
  const selectedRuns = metricScopeMode === "scoped" && scopeConfigured
    ? analyticsData.scopedRuns ?? []
    : analyticsData.runs

  const passRateData = useMemo(() => {
    return selectedTrends.daily.map((day) => ({
      date: day.date,
      passRate: day.total > 0 ? Math.round((day.passed / day.total) * 1000) / 10 : 0,
    }))
  }, [selectedTrends])

  const durationData = useMemo(() => {
    return analyticsData.trends.daily.map((day) => ({
      date: day.date,
      duration: day.avgDuration,
    }))
  }, [analyticsData])

  const runs = selectedRuns

  useEffect(() => {
    setMetricScopeMode(analyticsData.scope?.configured ? "scoped" : "all")
  }, [analyticsData])

  useEffect(() => {
    if (canonicalViewerState.toString() !== searchParams.toString()) {
      setSearchParams(canonicalViewerState, { replace: true })
    }
  }, [canonicalViewerState, searchParams, setSearchParams])

  useEffect(() => {
    if (!suiteId) {
      setNotFound(true)
      setIsLoading(false)
      setAnalyticsData(createEmptySuiteAnalytics(""))
      return
    }

    let cancelled = false
    setIsLoading(true)
    setNotFound(false)
    setContent("")
    setFilePath("")
    setAnalyticsData(createEmptySuiteAnalytics(suiteId))

    fetchSuiteFile(suiteId)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content)
          setFilePath(data.path)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotFound(true)
          toast.error("Failed to load suite file")
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [suiteId])

  useEffect(() => {
    if (!suiteId) return
    let cancelled = false

    fetchSuiteAnalytics(suiteId, { limit: 50 })
      .then((data) => {
        if (!cancelled) setAnalyticsData(data)
      })
      .catch(() => {
        if (!cancelled) setAnalyticsData(createEmptySuiteAnalytics(suiteId))
      })

    return () => {
      cancelled = true
    }
  }, [suiteId])

  const handleRun = async (local: boolean) => {
    if (isRunning || !filePath) return
    setIsRunning(true)
    try {
      const result = await triggerRun({ file: filePath, local })
      toast.success("Run started")
      navigate(routes.runLive(result.runId))
    } catch (err) {
      toast.error(
        `Failed to start run: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setIsRunning(false)
    }
  }

  const editRoute = routes.suiteEdit(suiteId)
  const liveRoute = `${editRoute}?live=1`

  useKeyboardShortcuts({
    e: () => navigate(editRoute),
    r: () => {
      if (filePath) void handleRun(defaultRunMode === "local")
    },
    l: () => navigate(liveRoute),
  })

  const updateViewerState = (nextState: {
    tab: ViewerTopTab
    view: SuiteViewerView
  }) => {
    setSearchParams(serializeViewerUrlState(nextState, searchParams), {
      replace: true,
    })
  }

  if (isLoading) return <EditorSkeleton />

  if (notFound) {
    return (
      <EmptyState
        icon={FileCode}
        title="Suite not found"
        description="This suite doesn't exist"
        actionLabel="View All Suites"
        onAction={() => navigate(routes.suites)}
      />
    )
  }

  const builderPanel = (
    <SuiteVisualBuilder
      content={content}
      onChange={() => {}}
      disabled
      suggestions={[]}
    />
  )

  const monacoPanel = (
    <MonacoEditor
      value={content}
      onChange={() => {}}
      readOnly
      className="h-full"
    />
  )

  const sidebarPanel = (
    <aside
      data-testid="suite-detail-analytics-sidebar"
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
            {Math.round(selectedTrends.passRate * 100)}%
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
          <RunHistoryTable runs={runs.slice(0, 5)} compactDate />
        </InsightsLineCell>
      </InsightsLineGrid>
    </aside>
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen">
        <SuiteNavbar
          suiteName={suiteName || "Suite"}
          suiteId={suiteId}
          unsaved={false}
          isCreateMode={false}
          mode="view"
          suiteHref={editRoute}
          isSaving={false}
          isValidating={false}
          isRunning={isRunning}
          runDisabled={!filePath}
          hasInvalidFilename={false}
          shortcutsOpen={shortcutsOpen}
          showSuiteId={false}
          onBack={() => navigate(routes.suites)}
          onSave={() => {}}
          onValidate={() => {}}
          onRun={(local) => handleRun(local)}
          onLiveConnect={() => navigate(liveRoute)}
          onSettingsOpen={() => {}}
          onToggleShortcuts={() => setShortcutsOpen((prev) => !prev)}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            updateViewerState({
              tab: value as ViewerTopTab,
              view: activeView,
            })
          }
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
            className="flex-1 min-h-0 mt-0 grid grid-cols-1 md:grid-cols-[minmax(480px,1fr)_minmax(260px,320px)]"
          >
            <div className="min-w-0 min-h-0 flex flex-col">
              <Tabs
                value={activeView}
                onValueChange={(value) =>
                  updateViewerState({
                    tab: activeTab,
                    view: value as SuiteViewerView,
                  })
                }
                className="flex-1 min-h-0 flex flex-col"
              >
                <div className="border-b border-border">
                  <TabsList
                    variant="line"
                    className="w-full grid grid-cols-3 px-4 md:w-fit md:inline-flex"
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
                      scope="suite"
                      scopeId={suiteId}
                      emptyTitle="No suite memory yet"
                      emptyDescription="This suite doesn't have cataloged observations in this workspace yet. Run the suite with memory enabled, then reopen this tab."
                    />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
            {sidebarPanel}
          </TabsContent>

          <TabsContent value="insights" className="flex-1 overflow-y-auto mt-0">
            <div data-testid="suite-detail-insights" className="space-y-3 px-4 py-3">
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
                    <p className="mt-0.5 text-2xl font-semibold">{analyticsData.total.toLocaleString()}</p>
                  </div>
                </InsightsLineCell>
                <InsightsLineCell className="border-b border-border md:border-b-0 md:border-r">
                  <div>
                    <p className="text-sm text-muted-foreground">Pass Rate</p>
                    <p className="mt-0.5 text-2xl font-semibold">{Math.round(selectedTrends.passRate * 100)}%</p>
                  </div>
                </InsightsLineCell>
                <InsightsLineCell>
                  <div>
                    <p className="text-sm text-muted-foreground">Avg Duration</p>
                    <p className="mt-0.5 text-2xl font-semibold">{formatDuration(analyticsData.trends.avgDuration)}</p>
                  </div>
                </InsightsLineCell>
                <InsightsLineCell>
                  <div>
                    <p className="text-sm text-muted-foreground">Flaky Score</p>
                    <p className="mt-0.5 text-2xl font-semibold">{(selectedFlakyScore * 100).toFixed(0)}%</p>
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

              {selectedTrends.daily.length > 0 && (
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
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  )
}
