import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { cn } from "@/lib/utils"

const chartConfig = {
  passRate: {
    label: "Pass Rate",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig

interface PassRateChartProps {
  data: { date: string; passRate: number }[]
  className?: string
}

function formatDate(value: string) {
  const d = new Date(value)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export function PassRateChart({ data, className }: PassRateChartProps) {
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
          domain={[0, 100]}
          unit="%"
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <ChartTooltip content={<ChartTooltipContent />} isAnimationActive={false} />
        <Line
          type="linear"
          dataKey="passRate"
          stroke="var(--color-passRate)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}
