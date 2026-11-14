import type { ReactNode } from "react"

import type { InsightsKnowledgeChanges, TokenEventStats } from "@/lib/api"
import { formatTokens } from "@/lib/format"
import { LEARNED_CHANGE_KINDS, type LearnedChangeKind } from "@/lib/knowledge-view"
import { TokenUsageChart } from "@/components/token-usage-chart"
import {
  InsightsLineCell,
  InsightsLineGrid,
  InsightsLineNotice,
} from "@/components/insights/insights-line-grid"
import { t } from "@/lib/i18n"

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
    || (tokenStats.testRunUnmeasuredSteps ?? 0) > 0
}

const CHANGE_KINDS = {
  added: { label: "Added", color: "bg-[var(--chart-1)]" },
  confirmed: { label: "Confirmed", color: "bg-[var(--chart-2)]" },
  promoted: { label: "Promoted", color: "bg-[var(--chart-3)]" },
  superseded: { label: "Superseded", color: "bg-[var(--chart-4)]" },
  deprecated: { label: "Deprecated", color: "bg-[var(--chart-5)]" },
} as const satisfies Record<LearnedChangeKind, { label: string; color: string }>

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function unavailableSentence(reason: string) {
  if (reason === "agent_host_unavailable") {
    return t("Curation changes could not be read: this dashboard was started without an agent host.")
  }
  return t("Curation changes could not be read for this window. Refresh the page to try again.")
}

function MemoryCell({ children }: { children: ReactNode }) {
  return (
    <InsightsLineCell data-insights-memory className="flex h-full flex-col p-0">
      <div className="border-b border-border px-5 py-5">
        <h2 className="text-base font-semibold">{t("Memory Curator")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Knowledge changes curation recorded for the runs in the selected window.
        </p>
      </div>
      <div className="flex h-full flex-col">{children}</div>
    </InsightsLineCell>
  )
}

function MemorySection({ knowledgeChanges }: { knowledgeChanges: InsightsKnowledgeChanges | null }) {
  if (knowledgeChanges === null) {
    return (
      <MemoryCell>
        <p className="px-5 py-4 text-sm text-muted-foreground">{t("Reading curation changes for this window.")}</p>
      </MemoryCell>
    )
  }

  if (knowledgeChanges.status === "unavailable") {
    return (
      <MemoryCell>
        <p className="px-5 py-4 text-sm text-muted-foreground">{unavailableSentence(knowledgeChanges.reason)}</p>
      </MemoryCell>
    )
  }

  const {
    runsInWindow,
    runsRead,
    runsUnreadable,
    runsCurationFailed,
    runsCurationUnfinished,
    runsInFlight,
    truncated,
    byKind,
  } = knowledgeChanges
  const rows = LEARNED_CHANGE_KINDS
    .map((kind) => ({ kind, ...CHANGE_KINDS[kind], value: byKind[kind] ?? 0 }))
    .filter((row) => row.value > 0)
  const totalChanges = rows.reduce((sum, row) => sum + row.value, 0)
  const runsAttempted = truncated?.read ?? runsInWindow

  // The empty claim is made only when every run in the window settled, was read with its curation
  // finished, and none changed anything. A missing count never yields the claim.
  if (
    totalChanges === 0
    && runsUnreadable === 0
    && runsCurationFailed === 0
    && runsCurationUnfinished === 0
    && runsInFlight === 0
    && truncated === undefined
  ) {
    return (
      <QuietSectionEmpty
        title={t("No memory-curator activity in this window")}
        description={t("Memory metrics appear after runs create or confirm observations.")}
      />
    )
  }

  const notes = [
    truncated
      ? `Counted the latest ${truncated.read} of ${truncated.total} runs in this window; older runs were not read.`
      : undefined,
    runsUnreadable > 0
      ? `Could not read curation for ${runsUnreadable} of ${plural(runsAttempted, "run")}; their changes are not counted.`
      : undefined,
    runsCurationFailed > 0
      ? `Curation failed for ${runsCurationFailed} of ${plural(runsAttempted, "run")}; their changes are not counted.`
      : undefined,
    runsCurationUnfinished > 0
      ? `Curation has not finished for ${runsCurationUnfinished} of ${plural(runsAttempted, "run")}; their changes are not counted yet.`
      : undefined,
    runsInFlight > 0
      ? runsInFlight === 1
        ? "1 run in this window has not finished yet and is not counted."
        : `${runsInFlight} runs in this window have not finished yet and are not counted.`
      : undefined,
  ].filter((note): note is string => note !== undefined)

  return (
    <MemoryCell>
      {totalChanges > 0 ? (
        <>
          <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">Changes</p>
              <p className="mt-1 text-xl font-semibold">{totalChanges}</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{t("Runs Read")}</p>
              <p className="mt-1 text-xl font-semibold">{runsRead} of {runsAttempted}</p>
            </div>
          </div>
          <div className="px-4 py-4">
            <p className="text-sm font-medium">{t("Change Mix")}</p>
            <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted">
              {rows.map((row) => (
                <div key={row.kind} className={row.color} style={{ width: `${(row.value / totalChanges) * 100}%` }} />
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {rows.map((row) => (
                <div key={row.kind} data-change-kind={row.kind} className="flex items-center justify-between gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${row.color}`} />
                    <span className="text-muted-foreground">{row.label}</span>
                  </div>
                  <span data-change-count className="font-mono tabular-nums">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="px-5 pt-4 text-sm text-muted-foreground">
          {runsRead > 0
            ? `No changes found in the ${plural(runsRead, "run")} whose curation finished.`
            : "No run in this window has a finished curation to count."}
        </p>
      )}
      {notes.length > 0 ? (
        <div className="space-y-1 px-5 py-4">
          {notes.map((note) => (
            <p key={note} className="text-sm text-muted-foreground">{note}</p>
          ))}
        </div>
      ) : null}
    </MemoryCell>
  )
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
  tokenStats,
  knowledgeChanges,
}: {
  tokenStats: TokenEventStats | null
  knowledgeChanges: InsightsKnowledgeChanges | null
}) {
  const showTokenUsage = hasTokenUsage(tokenStats)
  const modelTotals = getModelTotals(tokenStats)
  const totalTokens = (tokenStats?.totals.promptTokens ?? 0) + (tokenStats?.totals.completionTokens ?? 0)
  const runSource = tokenStats?.bySource["test-run"]
  const liveSource = tokenStats?.bySource["live-editor"]
  const unmeasuredSteps = tokenStats?.testRunUnmeasuredSteps ?? 0
  const testRunTokens = runSource
    ? formatTokens(runSource.promptTokens + runSource.completionTokens)
    : unmeasuredSteps > 0
      ? "Not recorded"
      : formatTokens(0)

  return (
    <InsightsLineGrid className="xl:grid-cols-2 xl:divide-x xl:divide-y-0 xl:items-stretch">
      {showTokenUsage && tokenStats ? (
        <InsightsLineCell data-insights-token-usage className="flex h-full flex-col p-0">
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-base font-semibold">{t("Token Usage")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Window-wide model activity, independent of the breakdown selector.
            </p>
          </div>
          <div className="flex h-full flex-col">
            <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("Total Tokens")}</p>
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
                <p className="text-sm font-medium">{t("By model")}</p>
                <p className="text-xs text-muted-foreground">
                  Input vs output across {modelTotals.length} active {modelTotals.length === 1 ? "model" : "models"}
                </p>
              </div>
              <TokenUsageChart data={tokenStats.byModel} className="h-[200px]" />
            </div>

            <div className="grid gap-0 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("Test Runs")}</p>
                <p className="mt-1 text-xl font-semibold">{testRunTokens}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("Live Editor")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatTokens((liveSource?.promptTokens ?? 0) + (liveSource?.completionTokens ?? 0))}
                </p>
              </div>
            </div>
            {unmeasuredSteps > 0 ? (
              <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                {plural(unmeasuredSteps, "test-run step")} recorded no token usage and {unmeasuredSteps === 1 ? "is" : "are"} not counted.
              </p>
            ) : null}
          </div>
        </InsightsLineCell>
      ) : (
        <QuietSectionEmpty
          title={t("No token usage in this window")}
          description={t("Token metrics appear after runs or live sessions use model calls.")}
        />
      )}

      <MemorySection knowledgeChanges={knowledgeChanges} />
    </InsightsLineGrid>
  )
}
