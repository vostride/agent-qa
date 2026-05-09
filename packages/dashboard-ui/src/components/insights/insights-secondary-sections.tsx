import type { Stats, TokenEventStats } from "@/lib/api"
import { formatTokens } from "@/lib/format"
import { TokenUsageChart } from "@/components/token-usage-chart"
import {
  InsightsLineCell,
  InsightsLineGrid,
  InsightsLineNotice,
} from "@/components/insights/insights-line-grid"

function QuietSectionEmpty({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <InsightsLineNotice
      className="min-h-48 px-5 py-6"
      title={title}
      description={description}
    />
  )
}

function hasTokenUsage(tokenStats: TokenEventStats | null) {
  if (!tokenStats) return false
  return tokenStats.byModel.some((row) => row.promptTokens > 0 || row.completionTokens > 0)
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function getModelTotals(tokenStats: TokenEventStats | null) {
  if (!tokenStats) return []

  const byModel = new Map<string, { model: string; promptTokens: number; completionTokens: number }>()

  for (const row of tokenStats.byModel) {
    const current = byModel.get(row.model) ?? {
      model: row.model,
      promptTokens: 0,
      completionTokens: 0,
    }
    current.promptTokens += row.promptTokens
    current.completionTokens += row.completionTokens
    byModel.set(row.model, current)
  }

  return Array.from(byModel.values())
    .map((row) => ({
      ...row,
      totalTokens: row.promptTokens + row.completionTokens,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}

export function InsightsSecondarySections({
  stats,
  tokenStats,
}: {
  stats: Stats
  tokenStats: TokenEventStats | null
}) {
  const memory = stats.memory
  const showTokenUsage = hasTokenUsage(tokenStats)
  const showMemory = Boolean(memory && memory.runs > 0)
  const modelTotals = getModelTotals(tokenStats)
  const totalTokens = (tokenStats?.totals.promptTokens ?? 0) + (tokenStats?.totals.completionTokens ?? 0)
  const totalObservations = memory ? memory.added + memory.confirmed + memory.deprecated : 0
  const observationMix = totalObservations > 0
    ? [
        { label: "Added", value: memory!.added, color: "bg-[var(--chart-1)]" },
        { label: "Confirmed", value: memory!.confirmed, color: "bg-[var(--chart-2)]" },
        { label: "Deprecated", value: memory!.deprecated, color: "bg-[var(--chart-5)]" },
      ]
    : []
  const runSource = tokenStats?.bySource["test-run"]
  const liveSource = tokenStats?.bySource["live-editor"]

  return (
    <InsightsLineGrid className="xl:grid-cols-2 xl:divide-x xl:divide-y-0 xl:items-stretch">
      {showTokenUsage && tokenStats ? (
        <InsightsLineCell className="flex h-full flex-col p-0">
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-base font-semibold">Token Usage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Window-wide model activity, independent of the breakdown selector.
            </p>
          </div>
          <div className="flex h-full flex-col">
            <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Total Tokens</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(totalTokens)}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Input</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(tokenStats.totals.promptTokens)}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Output</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(tokenStats.totals.completionTokens)}</p>
              </div>
            </div>

            <div className="space-y-2 border-b border-border px-5 py-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">By model</p>
                <p className="text-xs text-muted-foreground">
                  Input vs output across {modelTotals.length} active {modelTotals.length === 1 ? "model" : "models"}
                </p>
              </div>
              <TokenUsageChart data={tokenStats.byModel} className="h-[200px]" />
            </div>

            <div className="grid gap-0 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Test Runs</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatTokens((runSource?.promptTokens ?? 0) + (runSource?.completionTokens ?? 0))}
                </p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Live Editor</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatTokens((liveSource?.promptTokens ?? 0) + (liveSource?.completionTokens ?? 0))}
                </p>
              </div>
            </div>
          </div>
        </InsightsLineCell>
      ) : (
        <QuietSectionEmpty
          title="No token usage in this window"
          description="Token metrics appear after runs or live sessions use model calls."
        />
      )}

      {showMemory && memory ? (
        <InsightsLineCell className="flex h-full flex-col p-0">
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-base font-semibold">Memory Curator</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Observation activity and curator usage across the selected window.
            </p>
          </div>
          <div className="flex h-full flex-col">
            <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Runs With Memory</p>
                <p className="mt-1 text-xl font-semibold">{memory.runs}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Observations</p>
                <p className="mt-1 text-xl font-semibold">{totalObservations}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">Curator Tokens</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(memory.curatorTokens)}</p>
              </div>
            </div>

            <div className="grid flex-1 gap-0 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              <div className="px-4 py-4">
                <p className="text-sm font-medium">Observation Mix</p>
                {observationMix.length > 0 ? (
                  <>
                    <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted">
                      {observationMix.map((item) => (
                        <div
                          key={item.label}
                          className={item.color}
                          style={{ width: `${item.value === 0 ? 0 : (item.value / totalObservations) * 100}%` }}
                        />
                      ))}
                    </div>
                    <div className="mt-4 space-y-2">
                      {observationMix.map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 text-sm">
                          <div className="flex items-center gap-2">
                            <span className={`size-2 rounded-full ${item.color}`} />
                            <span className="text-muted-foreground">{item.label}</span>
                          </div>
                          <span className="font-mono tabular-nums">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No observation mix is available in this window yet.
                  </p>
                )}
              </div>

              <div className="px-4 py-4">
                <p className="text-sm font-medium">Curator Snapshot</p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Added Share</p>
                    <p className="mt-1 text-xl font-semibold">
                      {totalObservations > 0 ? formatPercent(memory.added / totalObservations) : "0%"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Tokens / Run</p>
                    <p className="mt-1 text-xl font-semibold">
                      {memory.runs > 0 ? formatTokens(Math.round(memory.curatorTokens / memory.runs)) : "0"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Confirmed</p>
                    <p className="mt-1 text-xl font-semibold">{memory.confirmed}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Deprecated</p>
                    <p className="mt-1 text-xl font-semibold">{memory.deprecated}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </InsightsLineCell>
      ) : (
        <QuietSectionEmpty
          title="No memory-curator activity in this window"
          description="Memory metrics appear after runs create or confirm observations."
        />
      )}
    </InsightsLineGrid>
  )
}
