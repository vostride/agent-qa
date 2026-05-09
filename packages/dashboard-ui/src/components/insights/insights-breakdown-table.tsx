import type { InsightsBreakdownDimension, InsightsBreakdownRow } from "@/lib/api"
import {
  InsightsLineGrid,
  InsightsLineNotice,
} from "@/components/insights/insights-line-grid"
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

const BREAKDOWN_COPY: Record<InsightsBreakdownDimension, { title: string; label: string }> = {
  test: { title: "Test Breakdown", label: "Test" },
  suite: { title: "Suite Breakdown", label: "Suite" },
  platform: { title: "Platform Breakdown", label: "Platform" },
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

function toPercent(value: number) {
  const normalized = value <= 1 ? value * 100 : value
  return Math.round(normalized * 10) / 10
}

function renderCells(dimension: InsightsBreakdownDimension, row: InsightsBreakdownRow) {
  if (dimension === "platform") {
    return (
      <>
        <TableCell className="px-4 py-2 font-medium">{row.label}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.runs}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.passed ?? 0}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.failed ?? 0}</TableCell>
        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{toPercent(row.passRate)}%</TableCell>
      </>
    )
  }

  return (
    <>
      <TableCell className="px-4 py-2 font-medium">{row.label}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{row.runs}</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{toPercent(row.passRate)}%</TableCell>
      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{toPercent(row.flakeRate)}%</TableCell>
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
  const copy = BREAKDOWN_COPY[dimension]

  if (rows.length === 0) {
    return (
      <InsightsLineGrid>
        <InsightsLineNotice
          className="px-4 py-6"
          title={`No ${dimension} data in this window`}
          description="Try another breakdown or widen the time window."
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
              <TableHead className="px-4">{copy.label}</TableHead>
              <TableHead className="px-4 text-right">Runs</TableHead>
              {dimension === "platform" ? (
                <>
                  <TableHead className="px-4 text-right">Passed</TableHead>
                  <TableHead className="px-4 text-right">Failed</TableHead>
                  <TableHead className="px-4 text-right">Pass Rate</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="px-4 text-right">Pass Rate</TableHead>
                  <TableHead className="px-4 text-right">Flake Rate</TableHead>
                  <TableHead className="px-4 text-right">Avg Duration</TableHead>
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
