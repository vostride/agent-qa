import { Badge } from "@/components/ui/badge"
import { cn, formatDate, formatDateShort } from "@/lib/utils"

interface MemorySummaryStripProps {
  observationCount: number
  scopeCounts: {
    product: number
    suite: number
    test: number
  }
  freshness: string | null
  sourceCoverage: number
  className?: string
}

interface FreshnessDisplay {
  primary: string
  secondary: string
}

export function formatMemoryFreshness(freshness: string | null): FreshnessDisplay {
  if (!freshness) {
    return {
      primary: "No confirmations yet",
      secondary: "Awaiting memory confirmations",
    }
  }

  return {
    primary: formatDate(freshness),
    secondary: formatDateShort(freshness),
  }
}

export function MemorySummaryStrip({
  observationCount,
  scopeCounts,
  freshness,
  sourceCoverage,
  className,
}: MemorySummaryStripProps) {
  const freshnessDisplay = formatMemoryFreshness(freshness)

  return (
    <div className={cn("overflow-hidden rounded-md border bg-card", className)}>
      <div className="grid gap-0 md:grid-cols-4">
        <MetricCell
          label="Observations"
          primary={observationCount.toLocaleString()}
          secondary="Across all memory scopes"
          className="border-b md:border-b-0 md:border-r"
        />
        <div className="border-b p-3 md:border-b-0 md:border-r">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Scope mix</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="rounded-sm">Product {scopeCounts.product}</Badge>
            <Badge variant="outline" className="rounded-sm">Suite {scopeCounts.suite}</Badge>
            <Badge variant="outline" className="rounded-sm">Test {scopeCounts.test}</Badge>
          </div>
        </div>
        <MetricCell
          label="Freshness"
          primary={freshnessDisplay.primary}
          secondary={freshnessDisplay.secondary}
          className="border-b md:border-b-0 md:border-r"
        />
        <MetricCell
          label="Source coverage"
          primary={sourceCoverage.toLocaleString()}
          secondary="Distinct source tests"
        />
      </div>
    </div>
  )
}

function MetricCell({
  label,
  primary,
  secondary,
  className,
}: {
  label: string
  primary: string
  secondary: string
  className?: string
}) {
  return (
    <div className={cn("p-3", className)}>
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{primary}</p>
      <p className="mt-1 text-xs text-muted-foreground">{secondary}</p>
    </div>
  )
}
