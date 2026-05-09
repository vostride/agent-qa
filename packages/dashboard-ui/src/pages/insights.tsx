import { startTransition, useEffect, useState } from "react"
import { useNavigate } from "react-router"
import {
  BarChart3,
  LoaderCircle,
} from "lucide-react"

import {
  fetchInsightsBreakdown,
  fetchStats,
  fetchTokenEventStats,
  type InsightsBreakdownDimension,
  type InsightsBreakdownRow,
  type Stats,
  type TokenEventStats,
} from "@/lib/api"
import { usePageTitle } from "@/hooks/use-page-title"
import { useInsightsSearchParams, type InsightsTimeWindow } from "@/hooks/use-insights-search-params"
import { routes } from "@/lib/routes"
import { ChartSkeleton } from "@/components/page-skeleton"
import { PassRateChart } from "@/components/pass-rate-chart"
import { DurationChart } from "@/components/duration-chart"
import { InsightsBreakdownTable } from "@/components/insights/insights-breakdown-table"
import { InsightsSecondarySections } from "@/components/insights/insights-secondary-sections"
import {
  InsightsLineCell,
  InsightsLineGrid,
  InsightsLineNotice,
  InsightsMetricCell,
} from "@/components/insights/insights-line-grid"
import { Button } from "@/components/ui/button"
import { cn, formatDuration } from "@/lib/utils"

const WINDOW_OPTIONS: Array<{ value: InsightsTimeWindow; label: string }> = [
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All Time" },
]

const BREAKDOWN_OPTIONS: Array<{ value: InsightsBreakdownDimension; label: string; title: string }> = [
  { value: "test", label: "Test", title: "Test Breakdown" },
  { value: "suite", label: "Suite", title: "Suite Breakdown" },
  { value: "platform", label: "Platform", title: "Platform Breakdown" },
]

type InsightsScopeMode = "scoped" | "all"

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function formatPercent(value: number) {
  const normalized = value <= 1 ? value * 100 : value
  return `${Math.round(normalized)}%`
}

function getWindowFrom(timeWindow: InsightsTimeWindow) {
  if (timeWindow === "all") return undefined
  if (timeWindow === "1d") return daysAgo(1)
  if (timeWindow === "30d") return daysAgo(30)
  return daysAgo(7)
}

export default function InsightsPage() {
  usePageTitle("Insights")

  const navigate = useNavigate()
  const { window: timeWindow, breakdown, setWindow, setBreakdown } = useInsightsSearchParams()

  const [stats, setStats] = useState<Stats | null>(null)
  const [tokenStats, setTokenStats] = useState<TokenEventStats | null>(null)
  const [breakdownRows, setBreakdownRows] = useState<InsightsBreakdownRow[]>([])
  const [hasLoadedOverview, setHasLoadedOverview] = useState(false)
  const [hasLoadedBreakdown, setHasLoadedBreakdown] = useState(false)
  const [isWindowRefreshing, setIsWindowRefreshing] = useState(false)
  const [isBreakdownRefreshing, setIsBreakdownRefreshing] = useState(false)
  const [hasWindowError, setHasWindowError] = useState(false)
  const [hasBreakdownError, setHasBreakdownError] = useState(false)
  const [scopeMode, setScopeMode] = useState<InsightsScopeMode>("all")

  useEffect(() => {
    let cancelled = false

    async function loadOverview() {
      const from = getWindowFrom(timeWindow)
      const scope = scopeMode === "scoped" ? "passRate" : undefined
      if (hasLoadedOverview) setIsWindowRefreshing(true)

      try {
        const [statsData, tokenData] = await Promise.all([
          fetchStats({ from, scope }),
          fetchTokenEventStats({ from }),
        ])

        if (cancelled) return

        setStats(statsData)
        setTokenStats(tokenData)
        setHasWindowError(false)
      } catch {
        if (cancelled) return

        if (!hasLoadedOverview) {
          setStats(null)
          setTokenStats(null)
        }
        setHasWindowError(true)
      } finally {
        if (cancelled) return
        setHasLoadedOverview(true)
        setIsWindowRefreshing(false)
      }
    }

    void loadOverview()

    return () => {
      cancelled = true
    }
  }, [timeWindow, scopeMode])

  useEffect(() => {
    let cancelled = false

    async function loadBreakdown() {
      const from = getWindowFrom(timeWindow)
      const scope = scopeMode === "scoped" ? "passRate" : undefined
      if (hasLoadedBreakdown) setIsBreakdownRefreshing(true)

      try {
        const breakdownData = await fetchInsightsBreakdown(breakdown, { from, limit: 25, scope })
        if (cancelled) return

        setBreakdownRows(breakdownData.rows)
        setHasBreakdownError(false)
      } catch {
        if (cancelled) return

        if (!hasLoadedBreakdown) {
          setBreakdownRows([])
        }
        setHasBreakdownError(true)
      } finally {
        if (cancelled) return
        setHasLoadedBreakdown(true)
        setIsBreakdownRefreshing(false)
      }
    }

    void loadBreakdown()

    return () => {
      cancelled = true
    }
  }, [timeWindow, breakdown, scopeMode])

  const isInitialLoading = !hasLoadedOverview || !hasLoadedBreakdown

  if (isInitialLoading) return <ChartSkeleton />

  const hasRuns = Boolean(stats && stats.totalRuns > 0)
  const passRate = stats && stats.totalRuns > 0 ? Math.round((stats.passed / stats.totalRuns) * 100) : 0
  const breakdownCopy = BREAKDOWN_OPTIONS.find((option) => option.value === breakdown) ?? BREAKDOWN_OPTIONS[0]
  const avgRunsPerDay = stats && stats.runs.length > 0 ? Math.round(stats.totalRuns / stats.runs.length) : 0
  const showFatalError = hasWindowError && !stats
  const selectedRangeLabel = timeWindow === "all" ? "selected range" : "selected window"
  const scopeConfigured = stats?.scope?.configured ?? false
  const scopeActive = scopeMode === "scoped" && scopeConfigured

  return (
    <div data-insights-page-root className="h-full min-h-0 overflow-y-auto p-4 md:p-6 space-y-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight">Insights</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Window-wide reliability, cost, and curator signals with a separate comparison section for tests,
            suites, and platforms.
          </p>
        </div>

        <div className="flex flex-col gap-2 md:items-end">
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {scopeConfigured ? (
              <div className="inline-flex rounded border border-border p-0.5" aria-label="Run scope">
                {(["scoped", "all"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="xs"
                    variant={scopeMode === value ? "default" : "ghost"}
                    aria-pressed={scopeMode === value}
                    className="h-7 rounded-[2px] px-2 text-xs"
                    onClick={() => setScopeMode(value)}
                  >
                    {value === "scoped" ? "Scoped" : "All runs"}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="inline-flex rounded border border-border p-0.5" aria-label="Time window">
              {WINDOW_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={timeWindow === option.value ? "default" : "ghost"}
                  size="xs"
                  aria-pressed={timeWindow === option.value}
                  className="h-7 rounded-[2px] px-2 text-xs"
                  onClick={() => startTransition(() => setWindow(option.value))}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          {isWindowRefreshing ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground md:justify-end">
              <LoaderCircle className="size-3 animate-spin" />
              <span>Refreshing selected range</span>
            </div>
          ) : null}
        </div>
      </header>

      {showFatalError ? (
        <InsightsLineGrid className="mt-6">
          <InsightsLineNotice
            title="Insights unavailable"
            description="Refresh the page. If the problem continues, change the time window and verify analytics data is available."
          />
        </InsightsLineGrid>
      ) : !hasRuns || !stats ? (
        <InsightsLineGrid className="mt-6 min-h-[50vh]">
          <InsightsLineCell className="flex min-h-[50vh] flex-col items-center justify-center text-center">
            <BarChart3 className="mb-4 h-8 w-8 text-muted-foreground" />
            <h3 className="text-lg font-semibold">No runs in this window</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Run or rerun tests to populate insights. If you expect older data, switch to 30D or All Time.
            </p>
            <Button className="mt-6" onClick={() => navigate(routes.runs)}>
              Open Runs
            </Button>
          </InsightsLineCell>
        </InsightsLineGrid>
      ) : (
        <div className="mt-6 space-y-6">
          {hasWindowError ? (
            <InsightsLineGrid className="border-amber-500/30">
              <InsightsLineNotice description={`The latest refresh failed. Showing the previous ${selectedRangeLabel} instead.`} />
            </InsightsLineGrid>
          ) : null}

          <section className="space-y-4">
            <InsightsLineGrid className="xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)_minmax(0,1fr)] xl:divide-x xl:divide-y-0 xl:items-stretch">
              <InsightsLineCell className="p-0">
                <div className="grid h-full auto-rows-fr gap-0 sm:grid-cols-2">
                  <InsightsMetricCell
                    className="border-b border-border sm:border-r"
                    label="Total Runs"
                    value={stats.totalRuns.toLocaleString()}
                    description={`${avgRunsPerDay} ${scopeActive ? "scoped " : ""}runs per active day in this ${timeWindow === "all" ? "range" : "window"}.`}
                  />
                  <InsightsMetricCell
                    className="border-b border-border"
                    label="Pass Rate"
                    value={`${passRate}%`}
                    description={`${stats.passed} successful ${scopeActive ? "scoped " : ""}runs out of ${stats.totalRuns}.`}
                  />
                  <InsightsMetricCell
                    className="border-b border-border sm:border-b-0 sm:border-r"
                    label="Avg Duration"
                    value={formatDuration(stats.avgDuration)}
                    description="Average runtime for completed runs in the selected range."
                  />
                  <InsightsMetricCell
                    label="Flake Rate"
                    value={formatPercent(stats.flakeRate)}
                    description={`${stats.failed} failed runs with healed/flaky behavior tracked separately.`}
                  />
                </div>
              </InsightsLineCell>

              <InsightsLineCell className="h-full">
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">Pass Rate</h2>
                  <p className="text-sm text-muted-foreground">Trend for successful outcomes across the selected window.</p>
                </div>
                <PassRateChart
                  data={stats.runs.map((run) => {
                    const total = run.passed + run.failed
                    return {
                      date: run.date,
                      passRate: total > 0 ? Math.round((run.passed / total) * 1000) / 10 : 0,
                    }
                  })}
                  className={cn("mt-4 h-[200px]", isWindowRefreshing && "opacity-70")}
                />
              </InsightsLineCell>

              <InsightsLineCell className="h-full">
                <div className="space-y-1">
                  <h2 className="text-base font-semibold">Duration</h2>
                  <p className="text-sm text-muted-foreground">Average run duration by day for the selected window.</p>
                </div>
                <DurationChart
                  data={stats.runs.map((run) => ({ date: run.date, duration: run.duration }))}
                  className={cn("mt-4 h-[200px]", isWindowRefreshing && "opacity-70")}
                />
              </InsightsLineCell>
            </InsightsLineGrid>

            <div className={cn("transition-opacity", isWindowRefreshing && "opacity-70")}>
              <InsightsSecondarySections stats={stats} tokenStats={tokenStats} />
            </div>
          </section>

          <section className="space-y-4">
            <InsightsLineGrid
              data-insights-breakdown-block
              aria-busy={isBreakdownRefreshing}
              className="divide-y-0 lg:grid-cols-[minmax(0,1fr)_auto]"
            >
              <InsightsLineCell className="space-y-1">
                <h2 className="text-lg font-semibold">{breakdownCopy.title}</h2>
                <p className="text-sm text-muted-foreground">
                  Compare reliability in a focused lower section so the overall window summary stays stable.
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {isBreakdownRefreshing ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  <span>
                    {hasBreakdownError
                      ? "Unable to refresh comparison. Showing previous results."
                      : isBreakdownRefreshing
                        ? "Updating comparison"
                        : `${breakdownCopy.label} comparison`}
                  </span>
                </div>
              </InsightsLineCell>

              <InsightsLineCell className="space-y-2 lg:text-right">
                <p className="text-xs text-muted-foreground">Break down by</p>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {BREAKDOWN_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      variant={breakdown === option.value ? "default" : "outline"}
                      size="sm"
                      onClick={() => startTransition(() => setBreakdown(option.value))}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </InsightsLineCell>
            </InsightsLineGrid>

            {hasBreakdownError && breakdownRows.length === 0 ? (
              <InsightsLineGrid>
                <InsightsLineNotice title="Breakdown unavailable">
                  <p className="mt-1 text-sm text-muted-foreground">
                    Refresh the page or pick another window to reload the selected comparison.
                  </p>
                </InsightsLineNotice>
              </InsightsLineGrid>
            ) : (
              <InsightsBreakdownTable
                dimension={breakdown}
                rows={breakdownRows}
                isRefreshing={isBreakdownRefreshing}
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}
