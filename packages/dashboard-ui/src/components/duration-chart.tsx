import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { formatDateTime } from "@/lib/format"
import { cn, formatDuration } from "@/lib/utils"
import { useTranslation } from "@/i18n"

interface DurationChartProps {
  data: { date: string; duration: number }[]
  className?: string
}

function formatDate(value: string) {
  return formatDateTime(new Date(value), { month: "short", day: "numeric" })
}

function renderDurationTooltipValue(value: unknown, name: unknown, fallbackLabel: string) {
  const label = typeof name === "string" ? name : fallbackLabel
  const formattedValue = typeof value === "number" ? formatDuration(value) : String(value)

  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground tabular-nums">{formattedValue}</span>
    </>
  )
}

export function DurationChart({ data, className }: DurationChartProps) {
  const { t } = useTranslation()
  const label = t("insights.chart.duration")
  const chartConfig = {
    duration: {
      label,
      color: "var(--chart-2)",
    },
  } satisfies ChartConfig

  return (
    <ChartContainer config={chartConfig} className={cn("h-[300px] w-full aspect-auto", className)}>
      <LineChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          minTickGap={32}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={formatDuration}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => renderDurationTooltipValue(value, name, label)}
            />
          }
          isAnimationActive={false}
        />
        <Line
          type="linear"
          dataKey="duration"
          stroke="var(--color-duration)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
