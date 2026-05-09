import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"

import {
  type ChartConfig,
  ChartContainer,
} from "@/components/ui/chart"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"

interface TokenUsageChartProps {
  data: { date: string; model: string; promptTokens: number; completionTokens: number }[]
  className?: string
}

const chartConfig = {
  promptTokens: {
    label: "Input",
    color: "var(--chart-1)",
  },
  completionTokens: {
    label: "Output",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

function formatAxis(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function aggregateByModel(data: TokenUsageChartProps["data"]) {
  const byModel = new Map<string, { model: string; promptTokens: number; completionTokens: number }>()

  for (const row of data) {
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

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ dataKey: string; value: number }>
  label?: string
}) {
  if (!active || !payload?.length) return null

  const promptTokens = payload.find((entry) => entry.dataKey === "promptTokens")?.value ?? 0
  const completionTokens = payload.find((entry) => entry.dataKey === "completionTokens")?.value ?? 0
  const totalTokens = promptTokens + completionTokens

  return (
    <div className="rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <p className="mb-1 font-medium">{label ?? ""}</p>
      <div className="grid gap-1">
        {[
          { label: "Input", value: promptTokens, color: "var(--chart-1)" },
          { label: "Output", value: completionTokens, color: "var(--chart-2)" },
          { label: "Total", value: totalTokens, color: "var(--muted-foreground)" },
        ].map((entry) => (
          <div key={entry.label} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: entry.color }} />
              <span className="text-muted-foreground">{entry.label}</span>
            </div>
            <span className="font-mono font-medium tabular-nums">{formatTokens(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TokenUsageChart({ data, className }: TokenUsageChartProps) {
  const chartData = aggregateByModel(data)

  return (
    <ChartContainer config={chartConfig} className={cn("h-[220px] w-full aspect-auto", className)}>
      <BarChart
        data={chartData}
        layout="vertical"
        accessibilityLayer
        margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
      >
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={formatAxis}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="model"
          tickLine={false}
          axisLine={false}
          width={96}
        />
        <Tooltip content={<CustomTooltip />} isAnimationActive={false} />
        <Bar
          dataKey="promptTokens"
          fill="var(--color-promptTokens)"
          stackId="tokens"
          radius={[4, 0, 0, 4]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="completionTokens"
          fill="var(--color-completionTokens)"
          stackId="tokens"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
