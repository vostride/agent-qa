import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { cn, formatDuration } from "@/lib/utils"

const chartConfig = {
  duration: {
    label: "Duration",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

interface DurationChartProps {
  data: { date: string; duration: number }[]
  className?: string
}

function formatDate(value: string) {
  const d = new Date(value)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function renderDurationTooltipValue(value: unknown, name: unknown) {
  const label = typeof name === "string" ? name : "Duration"
  const formattedValue = typeof value === "number" ? formatDuration(value) : String(value)

  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground tabular-nums">{formattedValue}</span>
    </>
  )
}

export function DurationChart({ data, className }: DurationChartProps) {
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
          content={<ChartTooltipContent formatter={renderDurationTooltipValue} />}
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
