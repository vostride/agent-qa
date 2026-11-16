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
import { useTranslation } from "@/i18n"

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
  added: { label: "insights.memory.kind.added", color: "bg-[var(--chart-1)]" },
  confirmed: { label: "insights.memory.kind.confirmed", color: "bg-[var(--chart-2)]" },
  promoted: { label: "insights.memory.kind.promoted", color: "bg-[var(--chart-3)]" },
  superseded: { label: "insights.memory.kind.superseded", color: "bg-[var(--chart-4)]" },
  deprecated: { label: "insights.memory.kind.deprecated", color: "bg-[var(--chart-5)]" },
} as const satisfies Record<LearnedChangeKind, { label: string; color: string }>

function MemoryCell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <InsightsLineCell data-insights-memory className="flex h-full flex-col p-0">
      <div className="border-b border-border px-5 py-5">
        <h2 className="text-base font-semibold">{t("insights.memory.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("insights.memory.description")}</p>
      </div>
      <div className="flex h-full flex-col">{children}</div>
    </InsightsLineCell>
  )
}

function MemorySection({ knowledgeChanges }: { knowledgeChanges: InsightsKnowledgeChanges | null }) {
  const { t } = useTranslation()
  if (knowledgeChanges === null) {
    return (
      <MemoryCell>
        <p className="px-5 py-4 text-sm text-muted-foreground">{t("insights.memory.reading")}</p>
      </MemoryCell>
    )
  }

  if (knowledgeChanges.status === "unavailable") {
    return (
      <MemoryCell>
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {knowledgeChanges.reason === "agent_host_unavailable"
            ? t("insights.memory.noAgentHost")
            : t("insights.memory.unreadable")}
        </p>
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
        title={t("insights.memory.empty.title")}
        description={t("insights.memory.empty.description")}
      />
    )
  }

  const notes = [
    truncated
      ? t("insights.memory.truncated", { read: truncated.read, count: truncated.total })
      : undefined,
    runsUnreadable > 0
      ? t("insights.memory.runsUnreadable", { affected: runsUnreadable, count: runsAttempted })
      : undefined,
    runsCurationFailed > 0
      ? t("insights.memory.curationFailed", { affected: runsCurationFailed, count: runsAttempted })
      : undefined,
    runsCurationUnfinished > 0
      ? t("insights.memory.curationUnfinished", {
          affected: runsCurationUnfinished,
          count: runsAttempted,
        })
      : undefined,
    runsInFlight > 0 ? t("insights.memory.inFlight", { count: runsInFlight }) : undefined,
  ].filter((note) => note !== undefined)

  return (
    <MemoryCell>
      {totalChanges > 0 ? (
        <>
          <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{t("insights.memory.changes")}</p>
              <p className="mt-1 text-xl font-semibold">{totalChanges}</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{t("insights.memory.runsRead")}</p>
              <p className="mt-1 text-xl font-semibold">
                {t("insights.memory.runsReadValue", { read: runsRead, total: runsAttempted })}
              </p>
            </div>
          </div>
          <div className="px-4 py-4">
            <p className="text-sm font-medium">{t("insights.memory.changeMix")}</p>
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
                    <span className="text-muted-foreground">{t(row.label)}</span>
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
            ? t("insights.memory.noChanges", { count: runsRead })
            : t("insights.memory.noFinishedCuration")}
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
  const { t } = useTranslation()
  const showTokenUsage = hasTokenUsage(tokenStats)
  const modelTotals = getModelTotals(tokenStats)
  const totalTokens = (tokenStats?.totals.promptTokens ?? 0) + (tokenStats?.totals.completionTokens ?? 0)
  const runSource = tokenStats?.bySource["test-run"]
  const liveSource = tokenStats?.bySource["live-editor"]
  const unmeasuredSteps = tokenStats?.testRunUnmeasuredSteps ?? 0
  const testRunTokens = runSource
    ? formatTokens(runSource.promptTokens + runSource.completionTokens)
    : unmeasuredSteps > 0
      ? t("insights.tokens.notRecorded")
      : formatTokens(0)

  return (
    <InsightsLineGrid className="xl:grid-cols-2 xl:divide-x xl:divide-y-0 xl:items-stretch">
      {showTokenUsage && tokenStats ? (
        <InsightsLineCell data-insights-token-usage className="flex h-full flex-col p-0">
          <div className="border-b border-border px-5 py-5">
            <h2 className="text-base font-semibold">{t("insights.tokens.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("insights.tokens.description")}</p>
          </div>
          <div className="flex h-full flex-col">
            <div className="grid gap-0 divide-y divide-border border-b border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("insights.tokens.total")}</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(totalTokens)}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("insights.tokens.input")}</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(tokenStats.totals.promptTokens)}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("insights.tokens.output")}</p>
                <p className="mt-1 text-xl font-semibold">{formatTokens(tokenStats.totals.completionTokens)}</p>
              </div>
            </div>

            <div className="space-y-2 border-b border-border px-5 py-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">{t("insights.tokens.byModel")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("insights.tokens.activeModels", { count: modelTotals.length })}
                </p>
              </div>
              <TokenUsageChart data={tokenStats.byModel} className="h-[200px]" />
            </div>

            <div className="grid gap-0 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("insights.tokens.testRuns")}</p>
                <p className="mt-1 text-xl font-semibold">{testRunTokens}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-muted-foreground">{t("insights.tokens.liveEditor")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatTokens((liveSource?.promptTokens ?? 0) + (liveSource?.completionTokens ?? 0))}
                </p>
              </div>
            </div>
            {unmeasuredSteps > 0 ? (
              <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
                {t("insights.tokens.unmeasuredSteps", { count: unmeasuredSteps })}
              </p>
            ) : null}
          </div>
        </InsightsLineCell>
      ) : (
        <QuietSectionEmpty
          title={t("insights.tokens.empty.title")}
          description={t("insights.tokens.empty.description")}
        />
      )}

      <MemorySection knowledgeChanges={knowledgeChanges} />
    </InsightsLineGrid>
  )
}
