import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { formatTokens } from "@/lib/format"

const chartConfig = {
  input: {
    label: "Input Tokens",
    color: "var(--chart-1)",
  },
  output: {
    label: "Output Tokens",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig

interface CostChartProps {
  data: { date: string; input: number; output: number }[]
}

function formatDate(value: string) {
  const d = new Date(value)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function formatAxis(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export function CostChart({ data }: CostChartProps) {
  return (
    <ChartContainer config={chartConfig} className="h-[300px] w-full">
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDate}
          minTickGap={32}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={formatAxis}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <ChartTooltip content={<ChartTooltipContent formatter={(value) => formatTokens(value as number)} />} />
        <Bar
          dataKey="input"
          fill="var(--color-input)"
          stackId="tokens"
          radius={[0, 0, 0, 0]}
        />
        <Bar
          dataKey="output"
          fill="var(--color-output)"
          stackId="tokens"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  )
}
