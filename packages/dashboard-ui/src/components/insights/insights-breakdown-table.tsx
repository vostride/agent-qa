import type { InsightsBreakdownDimension, InsightsBreakdownRow } from "@/lib/api"
import {
  InsightsLineGrid,
  InsightsLineNotice,
} from "@/components/insights/insights-line-grid"
import { formatPercent, formatUnit, formatUnitList } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useTranslation } from "@/i18n"

const BREAKDOWN_COPY = {
  test: { label: "insights.breakdown.test", empty: "insights.breakdown.empty.test" },
  suite: { label: "insights.breakdown.suite", empty: "insights.breakdown.empty.suite" },
  platform: { label: "insights.breakdown.platform", empty: "insights.breakdown.empty.platform" },
} as const satisfies Record<InsightsBreakdownDimension, { label: string; empty: string }>

function formatDuration(ms: number) {
  if (ms < 1000) return formatUnit(Math.round(ms), "millisecond")
  if (ms < 60_000) {
    return formatUnit(Number((ms / 1000).toFixed(1)), "second", { minimumFractionDigits: 1 })
  }
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return formatUnitList([formatUnit(mins, "minute"), formatUnit(secs, "second")])
}

function toPercent(value: number) {
  const normalized = value <= 1 ? value * 100 : value
  return Math.round(normalized * 10) / 10
}

function formatPassRate(value: number | null) {
  return value === null ? "\u2014" : formatPercent(toPercent(value))
}

function renderCells(dimension: InsightsBreakdownDimension, row: InsightsBreakdownRow) {
  if (dimension === "platform") {
    return (
      <>
        <TableCell className="px-4 py-2 font-medium">{row.label}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.runs}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.passed ?? 0}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.failed ?? 0}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatPassRate(row.passRate)}</TableCell>
      </>
    )
  }

  return (
    <>
      <TableCell className="px-4 py-2 font-medium">{row.label}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.runs}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatPassRate(row.passRate)}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatPercent(toPercent(row.flakeRate))}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatDuration(row.avgDuration)}</TableCell>
    </>
  )
}

export function InsightsBreakdownTable({
  dimension,
  rows,
  isRefreshing = false,
}: {
  dimension: InsightsBreakdownDimension
  rows: InsightsBreakdownRow[]
  isRefreshing?: boolean
}) {
  const { t } = useTranslation()
  const copy = BREAKDOWN_COPY[dimension]

  if (rows.length === 0) {
    return (
      <InsightsLineGrid>
        <InsightsLineNotice
          className="px-4 py-6"
          title={t(copy.empty)}
          description={t("insights.breakdown.empty.description")}
        />
      </InsightsLineGrid>
    )
  }

  return (
    <InsightsLineGrid
      className={cn("overflow-hidden transition-opacity", isRefreshing && "opacity-70")}
      aria-busy={isRefreshing || undefined}
    >
      <ScrollArea className="w-full">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">{t(copy.label)}</TableHead>
              <TableHead className="px-4 text-right">{t("insights.breakdown.column.runs")}</TableHead>
              {dimension === "platform" ? (
                <>
                  <TableHead className="px-4 text-right">{t("insights.breakdown.column.passed")}</TableHead>
                  <TableHead className="px-4 text-right">{t("insights.breakdown.column.failed")}</TableHead>
                  <TableHead className="px-4 text-right">{t("insights.breakdown.column.passRate")}</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="px-4 text-right">{t("insights.breakdown.column.passRate")}</TableHead>
                  <TableHead className="px-4 text-right">{t("insights.breakdown.column.flakeRate")}</TableHead>
                  <TableHead className="px-4 text-right">
                    {t("insights.breakdown.column.avgDuration")}
                  </TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} className="hover:bg-transparent">
                {renderCells(dimension, row)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </InsightsLineGrid>
  )
}
