// @vitest-environment jsdom

import {
  act,
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type ReactElement,
} from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import InsightsPage from "@/pages/insights"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type MockStats = {
  totalRuns: number
  passed: number
  failed: number
  flakeRate: number
  avgDuration: number
  runs: Array<{ date: string; passed: number; failed: number; healed: number; duration: number }>
  scope?: {
    configured: boolean
    predicates: Array<{ key: string; value: string; mode: "exact" | "regex" }>
    scopedCount: number
    totalCount: number
  }
  memory?: {
    runs: number
    added: number
    confirmed: number
    deprecated: number
    curatorTokens: number
  }
}

type MockBreakdownRow = {
  key: string
  label: string
  runs: number
  passRate?: number
  flakeRate?: number
  avgDuration?: number
  passed?: number
  failed?: number
  filePath?: string
  suiteId?: string
}

const {
  fetchStatsMock,
  fetchTokenEventStatsMock,
  fetchInsightsBreakdownMock,
  passRateChartPropsMock,
  durationChartPropsMock,
} = vi.hoisted(() => ({
  fetchStatsMock: vi.fn(),
  fetchTokenEventStatsMock: vi.fn(),
  fetchInsightsBreakdownMock: vi.fn(),
  passRateChartPropsMock: vi.fn(),
  durationChartPropsMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchStats: fetchStatsMock,
  fetchTokenEventStats: fetchTokenEventStatsMock,
  fetchInsightsBreakdown: fetchInsightsBreakdownMock,
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/page-skeleton", () => ({
  ChartSkeleton: () => <div>Loading insights...</div>,
}))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({
    title,
    description,
  }: {
    title: string
    description?: string
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </section>
  ),
}))
vi.mock("@/components/token-usage-chart", () => ({
  TokenUsageChart: () => <div>Token usage chart</div>,
}))
vi.mock("@/components/pass-rate-chart", () => ({
  PassRateChart: (props: { className?: string }) => {
    passRateChartPropsMock(props)
    return <div data-testid="pass-rate-chart">Pass rate chart</div>
  },
}))
vi.mock("@/components/duration-chart", () => ({
  DurationChart: (props: { className?: string }) => {
    durationChartPropsMock(props)
    return <div data-testid="duration-chart">Duration chart</div>
  },
}))
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => <section data-slot="card" className={className}>{children}</section>,
  CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div data-slot="card-header" className={className}>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => <div data-slot="card-content" className={className}>{children}</div>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    variant,
  }: {
    children: ReactNode
    disabled?: boolean
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    variant?: string
  }) => (
    <button type="button" data-variant={variant} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => <tr onClick={onClick}>{children}</tr>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}))
vi.mock("recharts", () => ({
  Area: () => <div data-recharts="area" />,
  AreaChart: ({ children }: { children: ReactNode }) => <div data-recharts="area-chart">{children}</div>,
  CartesianGrid: () => <div data-recharts="cartesian-grid" />,
  Line: ({
    type,
    strokeWidth,
    dot,
    isAnimationActive,
  }: {
    type?: string
    strokeWidth?: number
    dot?: boolean
    isAnimationActive?: boolean
  }) => (
    <div
      data-recharts="line"
      data-type={type}
      data-stroke-width={String(strokeWidth)}
      data-dot={String(dot)}
      data-animation={String(isAnimationActive)}
    />
  ),
  LineChart: ({ children }: { children: ReactNode }) => <div data-recharts="line-chart">{children}</div>,
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-recharts="responsive">{children}</div>,
  Tooltip: ({
    content,
    isAnimationActive,
  }: {
    content?: ReactNode
    isAnimationActive?: boolean
  }) => (
    <div data-recharts="tooltip" data-animation={String(isAnimationActive)}>
      {content}
    </div>
  ),
  XAxis: ({ tickFormatter }: { tickFormatter?: unknown }) => (
    <div data-recharts="x-axis" data-tick-formatter={String(Boolean(tickFormatter))} />
  ),
  YAxis: ({ tickFormatter }: { tickFormatter?: unknown }) => (
    <div data-recharts="y-axis" data-tick-formatter={String(Boolean(tickFormatter))} />
  ),
}))
vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => (
    <div data-chart-container className={className}>
      {children}
    </div>
  ),
  ChartTooltip: ({
    content,
    isAnimationActive,
  }: {
    content?: ReactNode
    isAnimationActive?: boolean
  }) => (
    <div data-chart-tooltip data-animation={String(isAnimationActive)}>
      {content}
    </div>
  ),
  ChartTooltipContent: ({
    formatter,
  }: {
    formatter?: (value: unknown, name: unknown, item: unknown, index: number, payload: unknown) => ReactNode
  }) => (
    <div data-chart-tooltip-content data-has-formatter={String(Boolean(formatter))}>
      {formatter ? formatter(1250, "Duration", {}, 0, {}) : null}
    </div>
  ),
}))

const SelectContext = createContext<{
  onValueChange?: (value: string) => void
} | null>(null)

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
  }: {
    children: ReactNode
    value: string
  }) => {
    const context = useContext(SelectContext)
    return (
      <button type="button" data-select-value={value} onClick={() => context?.onValueChange?.(value)}>
        {children}
      </button>
    )
  },
}))

const TabsContext = createContext<{
  value: string
  onValueChange?: (value: string) => void
} | null>(null)

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    defaultValue,
    onValueChange,
    value,
  }: {
    children: ReactNode
    defaultValue?: string
    onValueChange?: (value: string) => void
    value?: string
  }) => {
    const [internalValue, setInternalValue] = useState(defaultValue ?? "")
    const resolvedValue = value ?? internalValue
    const contextValue = useMemo(
      () => ({
        value: resolvedValue,
        onValueChange: (next: string) => {
          if (value === undefined) setInternalValue(next)
          onValueChange?.(next)
        },
      }),
      [internalValue, onValueChange, resolvedValue, value],
    )

    return <TabsContext.Provider value={contextValue}>{children}</TabsContext.Provider>
  },
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({
    children,
    value,
  }: {
    children: ReactNode
    value: string
  }) => {
    const context = useContext(TabsContext)
    return (
      <button
        type="button"
        data-state={context?.value === value ? "active" : "inactive"}
        onClick={() => context?.onValueChange?.(value)}
      >
        {children}
      </button>
    )
  },
  TabsContent: ({
    children,
    value,
  }: {
    children: ReactNode
    value: string
  }) => {
    const context = useContext(TabsContext)
    if (context?.value !== value) return null
    return <div>{children}</div>
  },
}))

function defaultStats(overrides: Partial<MockStats> = {}): MockStats {
  return {
    totalRuns: 24,
    passed: 18,
    failed: 6,
    flakeRate: 0.125,
    avgDuration: 91234,
    runs: [
      { date: "2026-04-10", passed: 5, failed: 1, healed: 1, duration: 88000 },
      { date: "2026-04-11", passed: 6, failed: 2, healed: 1, duration: 94000 },
      { date: "2026-04-12", passed: 7, failed: 3, healed: 1, duration: 101000 },
    ],
    memory: {
      runs: 8,
      added: 5,
      confirmed: 3,
      deprecated: 1,
      curatorTokens: 4200,
    },
    ...overrides,
  }
}

function defaultTokenStats() {
  return {
    byModel: [
      { date: "2026-04-10", model: "gpt-5.4", promptTokens: 320, completionTokens: 180 },
      { date: "2026-04-10", model: "gpt-5.4-mini", promptTokens: 120, completionTokens: 60 },
    ],
    bySource: {
      "test-run": { promptTokens: 340, completionTokens: 190 },
      "live-editor": { promptTokens: 100, completionTokens: 50 },
    },
    totals: {
      promptTokens: 440,
      completionTokens: 240,
    },
  }
}

function defaultBreakdownRows(): MockBreakdownRow[] {
  return [
    {
      key: "checkout",
      label: "Checkout flow",
      runs: 8,
      passRate: 0.875,
      flakeRate: 0.125,
      avgDuration: 145000,
      filePath: "tests/checkout.yaml",
    },
    {
      key: "login",
      label: "Login flow",
      runs: 6,
      passRate: 0.833,
      flakeRate: 0.167,
      avgDuration: 98000,
      filePath: "tests/login.yaml",
    },
  ]
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function renderPage(initialEntry = "/insights") {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/insights" element={<InsightsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await flushAsyncWork()
  })
}

async function renderElement(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(element)
    await flushAsyncWork()
  })
}

function textContent(): string {
  return container?.textContent ?? ""
}

function expectTextOrder(expected: string[]) {
  const content = textContent()
  let previousIndex = -1

  for (const value of expected) {
    const index = content.indexOf(value)
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

beforeEach(() => {
  fetchStatsMock.mockResolvedValue(defaultStats())
  fetchTokenEventStatsMock.mockResolvedValue(defaultTokenStats())
  fetchInsightsBreakdownMock.mockResolvedValue({
    dimension: "test",
    rows: defaultBreakdownRows(),
  })
  passRateChartPropsMock.mockClear()
  durationChartPropsMock.mockClear()
})

afterEach(async () => {
  vi.clearAllMocks()

  if (root) {
    await act(async () => {
      root?.unmount()
      await Promise.resolve()
    })
  }

  container?.remove()
  container = null
  root = null
})

describe("InsightsPage density and refresh behavior", () => {
  it("exposes the Phase 205 scroll owner and connected no-card line grid contract", async () => {
    await renderPage()

    const rootElement = container?.querySelector("[data-insights-page-root]")
    expect(rootElement).not.toBeNull()
    expect(rootElement?.className).toContain("h-full")
    expect(rootElement?.className).toContain("min-h-0")
    expect(rootElement?.className).toContain("overflow-y-auto")
    expect(rootElement?.className).toContain("p-4")
    expect(rootElement?.className).toContain("md:p-6")

    const lineGrids = Array.from(container?.querySelectorAll("[data-insights-line-grid]") ?? [])
    expect(lineGrids.length).toBeGreaterThan(0)
    expect(lineGrids.some((grid) => grid.className.includes("border"))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes("border-border"))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes("rounded-none"))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes("shadow-none"))).toBe(true)
    expect(lineGrids.some((grid) => grid.className.includes("bg-transparent"))).toBe(true)
    expect(
      lineGrids.some((grid) =>
        ["divide-x", "divide-y", "border-r", "border-b"].some((className) => grid.className.includes(className)),
      ),
    ).toBe(true)

    const breakdownBlock = container?.querySelector("[data-insights-breakdown-block]")
    expect(breakdownBlock).not.toBeNull()
    expect(breakdownBlock?.getAttribute("aria-busy")).toBe("false")
    expect(breakdownBlock?.className).toContain("divide-y-0")
    expect(breakdownBlock?.className).not.toContain("divide-x")
    expect(container?.querySelector('[data-insights-page-root] [data-slot="card"]')).toBeNull()
  })

  it("renders a compact top-level summary with new window options and token input/output emphasis", async () => {
    await renderPage()

    expect(container?.firstElementChild?.className).toContain("space-y-6")
    expect(container?.firstElementChild?.className).toContain("p-4")
    expect(container?.firstElementChild?.className).toContain("md:p-6")
    expect(container?.querySelector("header")?.className).toContain("md:items-start")
    expect(container?.querySelector("header")?.className).not.toContain("md:items-end")
    expect(textContent()).toContain("Insights")
    expect(textContent()).toContain("1D")
    expect(textContent()).toContain("All Time")
    expect(textContent()).toContain("Total Runs")
    expect(textContent()).toContain("Pass Rate")
    expect(textContent()).toContain("Avg Duration")
    expect(textContent()).toContain("Flake Rate")
    expect(textContent()).toContain("Token Usage")
    expect(textContent()).toContain("Memory Curator")
    expect(textContent()).toContain("Input")
    expect(textContent()).toContain("Output")
    expect(textContent()).toContain("Break down by")
    expect(textContent()).toContain("Test Breakdown")
    expect(textContent()).not.toContain("Scoped")
    expect(textContent()).not.toContain("All runs")
    expect(textContent()).not.toContain("No analytics scope configured")
    expect(textContent()).not.toContain("Models")

    const buttonLabels = Array.from(container?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent)
      .filter((value): value is string => Boolean(value))

    expect(buttonLabels).not.toContain("Usage")
    expect(buttonLabels).not.toContain("Tests")
    expect(buttonLabels).not.toContain("Trends")
    expect(passRateChartPropsMock).toHaveBeenCalledWith(expect.objectContaining({ className: expect.stringContaining("h-[200px]") }))
    expect(durationChartPropsMock).toHaveBeenCalledWith(expect.objectContaining({ className: expect.stringContaining("h-[200px]") }))
    const timeWindowGroup = container?.querySelector('[aria-label="Time window"]')
    expect(timeWindowGroup?.className).toContain("inline-flex")
    expect(timeWindowGroup?.className).toContain("border")
    expect(timeWindowGroup?.className).not.toContain("gap-2")

    expectTextOrder([
      "Insights",
      "Total Runs",
      "Pass Rate",
      "Avg Duration",
      "Flake Rate",
      "Token Usage",
      "Memory Curator",
      "Test Breakdown",
    ])
  })

  it("shows a top-level scoped metrics toggle when analytics scope is configured", async () => {
    fetchStatsMock
      .mockResolvedValueOnce(defaultStats({
        totalRuns: 24,
        passed: 18,
        failed: 6,
        scope: {
          configured: true,
          predicates: [{ key: "git.branch", value: "phase223-main", mode: "exact" }],
          scopedCount: 4,
          totalCount: 24,
        },
      }))
      .mockResolvedValueOnce(defaultStats({
        totalRuns: 4,
        passed: 3,
        failed: 1,
        scope: {
          configured: true,
          predicates: [{ key: "git.branch", value: "phase223-main", mode: "exact" }],
          scopedCount: 4,
          totalCount: 24,
        },
      }))

    await renderPage()

    const paragraphLabels = Array.from(container?.querySelectorAll("p") ?? []).map((element) => element.textContent)
    expect(paragraphLabels).not.toContain("Scope")
    expect(paragraphLabels).not.toContain("Window")
    expect(textContent()).toContain("Scoped")
    expect(textContent()).toContain("All runs")
    expect(textContent()).not.toContain("4 scoped / 24 total runs")
    const activeButtons = Array.from(container?.querySelectorAll("button[data-variant='default']") ?? []).map(
      (button) => button.textContent,
    )
    expect(activeButtons).toContain("All runs")
    expect(fetchStatsMock).toHaveBeenNthCalledWith(1, { from: expect.any(String), scope: undefined })
    expect(fetchInsightsBreakdownMock).toHaveBeenNthCalledWith(1, "test", { from: expect.any(String), limit: 25, scope: undefined })

    const scopedButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Scoped"),
    )

    await act(async () => {
      scopedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flushAsyncWork()
    })

    expect(fetchStatsMock).toHaveBeenNthCalledWith(2, { from: expect.any(String), scope: "passRate" })
    expect(fetchInsightsBreakdownMock).toHaveBeenNthCalledWith(2, "test", { from: expect.any(String), limit: 25, scope: "passRate" })
  })

  it("honors window=all and breakdown=platform from the URL on first render", async () => {
    await renderPage("/insights?window=all&breakdown=platform")

    const content = textContent()
    expect(content).toContain("Break down by")
    expect(content).toContain("Platform Breakdown")

    const activeButtons = Array.from(container?.querySelectorAll("button[data-variant='default']") ?? [])
      .map((button) => button.textContent)

    expect(activeButtons).toContain("All Time")
    expect(activeButtons).toContain("Platform")
  })

  it("changes only the breakdown data path when the lower comparison filter changes", async () => {
    fetchInsightsBreakdownMock
      .mockResolvedValueOnce({
        dimension: "test",
        rows: defaultBreakdownRows(),
      })
      .mockResolvedValueOnce({
        dimension: "suite",
        rows: [
          {
            key: "suite-smoke",
            suiteId: "suite-smoke",
            label: "Smoke Suite",
            runs: 5,
            passRate: 0.8,
            flakeRate: 0.2,
            avgDuration: 120000,
          },
        ],
      })

    await renderPage()

    const suiteButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Suite"),
    )

    await act(async () => {
      suiteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flushAsyncWork()
    })

    expect(fetchStatsMock).toHaveBeenCalledTimes(1)
    expect(fetchTokenEventStatsMock).toHaveBeenCalledTimes(1)
    expect(fetchInsightsBreakdownMock).toHaveBeenCalledTimes(2)
    expect(textContent()).toContain("Suite Breakdown")
  })

  it("keeps the loaded shell visible while a new window is refreshing", async () => {
    const refreshedStats = createDeferred<MockStats>()
    const refreshedTokens = createDeferred<ReturnType<typeof defaultTokenStats>>()
    const refreshedBreakdown = createDeferred<{ dimension: string; rows: MockBreakdownRow[] }>()

    fetchStatsMock
      .mockResolvedValueOnce(defaultStats())
      .mockImplementationOnce(() => refreshedStats.promise)
    fetchTokenEventStatsMock
      .mockResolvedValueOnce(defaultTokenStats())
      .mockImplementationOnce(() => refreshedTokens.promise)
    fetchInsightsBreakdownMock
      .mockResolvedValueOnce({
        dimension: "test",
        rows: defaultBreakdownRows(),
      })
      .mockImplementationOnce(() => refreshedBreakdown.promise)

    await renderPage()

    const oneDayButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("1D"),
    )

    await act(async () => {
      oneDayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flushAsyncWork()
    })

    expect(textContent()).toContain("Insights")
    expect(textContent()).toContain("Total Runs")
    expect(textContent()).toContain("Refreshing selected range")
    expect(textContent()).not.toContain("Loading insights...")

    refreshedStats.resolve(defaultStats({ totalRuns: 6, passed: 5, failed: 1 }))
    refreshedTokens.resolve(defaultTokenStats())
    refreshedBreakdown.resolve({ dimension: "test", rows: defaultBreakdownRows() })

    await act(async () => {
      await flushAsyncWork()
    })
  })

  it("keeps the analytical shell visible when a breakdown is empty and shows section-level empty copy", async () => {
    fetchInsightsBreakdownMock.mockResolvedValue({
      dimension: "platform",
      rows: [],
    })

    await renderPage("/insights?window=30d&breakdown=platform")

    const content = textContent()
    expect(content).toContain("Token Usage")
    expect(content).toContain("Memory Curator")
    expect(content).toContain("Platform Breakdown")
    expect(content).toContain("No platform data in this window")
    expect(content).toContain("Try another breakdown or widen the time window.")
  })

  it("renders plain text test rows in the breakdown table", async () => {
    await renderPage()

    const content = textContent()
    expect(content).toContain("Checkout flow")
    expect(content).toContain("Login flow")
    expect(container?.querySelector("a")).toBeNull()
  })

  it("renders plain text suite rows in the breakdown table when suite mode is selected", async () => {
    fetchInsightsBreakdownMock.mockResolvedValue({
      dimension: "suite",
      rows: [
        {
          key: "suite-smoke",
          suiteId: "suite-smoke",
          label: "Smoke Suite",
          runs: 5,
          passRate: 0.8,
          flakeRate: 0.2,
          avgDuration: 120000,
        },
      ],
    })

    await renderPage("/insights?breakdown=suite")

    expect(textContent()).toContain("Smoke Suite")
    expect(container?.querySelector("a")).toBeNull()
  })

  it("keeps the control rail visible when the selected window has no runs and shows the page-level empty state", async () => {
    fetchStatsMock.mockResolvedValue(defaultStats({ totalRuns: 0, passed: 0, failed: 0, flakeRate: 0, runs: [] }))
    fetchInsightsBreakdownMock.mockResolvedValue({ dimension: "test", rows: [] })
    fetchTokenEventStatsMock.mockResolvedValue({
      byModel: [],
      bySource: {},
      totals: { promptTokens: 0, completionTokens: 0 },
    })

    await renderPage()

    const content = textContent()
    expect(content).toContain("Insights")
    expect(content).toContain("No runs in this window")
    expect(content).toContain("All Time")
  })

  it("shows the neutral error state when analytics loading fails", async () => {
    fetchStatsMock.mockRejectedValue(new Error("stats unavailable"))

    await renderPage()

    const content = textContent()
    expect(content).toContain("Insights")
    expect(content).toContain("Insights unavailable")
    expect(content).toContain("Refresh the page.")
  })
})

describe("insights chart contracts", () => {
  it("renders pass rate as a line chart with the shared line settings", async () => {
    const { PassRateChart } = await vi.importActual<typeof import("@/components/pass-rate-chart")>("@/components/pass-rate-chart")

    await renderElement(
      <PassRateChart
        data={[
          { date: "2026-04-10", passRate: 75 },
          { date: "2026-04-11", passRate: 80 },
        ]}
      />,
    )

    expect(container?.querySelector('[data-recharts="line-chart"]')).not.toBeNull()
    expect(container?.querySelector('[data-recharts="area-chart"]')).toBeNull()

    const line = container?.querySelector('[data-recharts="line"]')
    expect(line?.getAttribute("data-type")).toBe("linear")
    expect(line?.getAttribute("data-stroke-width")).toBe("2")
    expect(line?.getAttribute("data-dot")).toBe("false")
    expect(line?.getAttribute("data-animation")).toBe("false")
  })

  it("formats duration tooltips through the shared compact formatter", async () => {
    const { DurationChart } = await vi.importActual<typeof import("@/components/duration-chart")>("@/components/duration-chart")

    await renderElement(
      <DurationChart
        data={[
          { date: "2026-04-10", duration: 1250 },
          { date: "2026-04-11", duration: 61000 },
        ]}
      />,
    )

    const tooltip = container?.querySelector('[data-chart-tooltip-content]')
    expect(tooltip?.getAttribute("data-has-formatter")).toBe("true")
    expect(container?.textContent).toContain("1.3s")
    expect(container?.querySelector('[data-recharts="y-axis"]')?.getAttribute("data-tick-formatter")).toBe("true")
  })
})
