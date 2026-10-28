// @vitest-environment jsdom

// C433-INSIGHTS-TRUTHFUL (433-30, G-433-6, F-433-26). Insights never shows missing data as zero:
// Token Usage counts what the runs recorded and names steps that recorded nothing, and Memory
// reflects the curation the runs' own knowledge reads report, or says it could not read them.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { formatTokens } from "@/lib/format"
import InsightsPage from "@/pages/insights"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchStatsMock,
  fetchTokenEventStatsMock,
  fetchInsightsBreakdownMock,
  fetchInsightsKnowledgeChangesMock,
} = vi.hoisted(() => ({
  fetchStatsMock: vi.fn(),
  fetchTokenEventStatsMock: vi.fn(),
  fetchInsightsBreakdownMock: vi.fn(),
  fetchInsightsKnowledgeChangesMock: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  fetchStats: fetchStatsMock,
  fetchTokenEventStats: fetchTokenEventStatsMock,
  fetchInsightsBreakdown: fetchInsightsBreakdownMock,
  fetchInsightsKnowledgeChanges: fetchInsightsKnowledgeChangesMock,
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/page-skeleton", () => ({
  ChartSkeleton: () => <div>Loading insights...</div>,
}))
vi.mock("@/components/token-usage-chart", () => ({
  TokenUsageChart: () => <div>Token usage chart</div>,
}))
vi.mock("@/components/pass-rate-chart", () => ({
  PassRateChart: () => <div>Pass rate chart</div>,
}))
vi.mock("@/components/duration-chart", () => ({
  DurationChart: () => <div>Duration chart</div>,
}))

function stats() {
  return {
    totalRuns: 6,
    passed: 5,
    failed: 1,
    flakeRate: 0,
    avgDuration: 42000,
    runs: [{ date: "2026-10-04", passed: 5, failed: 1, healed: 0, duration: 42000 }],
  }
}

function tokenStats(overrides: Record<string, unknown> = {}) {
  return {
    byModel: [
      { date: "2026-10-04", model: "gpt-5.4-mini", promptTokens: 684_000, completionTokens: 477 },
      { date: "2026-10-04", model: "claude-live", promptTokens: 69_000, completionTokens: 900 },
    ],
    bySource: {
      "test-run": { promptTokens: 684_000, completionTokens: 477 },
      "live-editor": { promptTokens: 69_000, completionTokens: 900 },
    },
    totals: { promptTokens: 753_000, completionTokens: 1_377 },
    testRunUnmeasuredSteps: 0,
    ...overrides,
  }
}

function knowledgeRead(overrides: Record<string, unknown> = {}) {
  return {
    status: "read",
    runsInWindow: 6,
    runsRead: 6,
    runsUnreadable: 0,
    runsCurationFailed: 0,
    runsCurationUnfinished: 0,
    runsInFlight: 0,
    byKind: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, promoted: 0, purged: 0 },
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderPage() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/insights"]}>
        <Routes>
          <Route path="/insights" element={<InsightsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

// The secondary grid holds two cells, Token Usage then Memory. Located by content rather than by a
// hook the fix adds, so the unmodified page is measured on the same terms.
function secondaryCells(): HTMLElement[] {
  const grid = Array.from(container?.querySelectorAll<HTMLElement>("[data-insights-line-grid]") ?? [])
    .find((element) => element.children.length === 2 && /token usage/i.test(element.children[0].textContent ?? ""))
  expect(grid, "the Token Usage and Memory grid is rendered").toBeDefined()
  return Array.from(grid!.children) as HTMLElement[]
}

function tokenSection(): HTMLElement {
  return secondaryCells()[0]
}

function memorySection(): HTMLElement {
  return secondaryCells()[1]
}

function testRunsValue(): string | undefined {
  const label = Array.from(tokenSection().querySelectorAll("p")).find((p) => p.textContent === "Test Runs")
  return label?.nextElementSibling?.textContent ?? undefined
}

function countFor(section: HTMLElement, label: string): string | undefined {
  const row = Array.from(section.querySelectorAll("[data-change-kind]"))
    .find((element) => element.textContent?.includes(label))
  if (row) return row.querySelector("[data-change-count]")?.textContent ?? undefined
  const text = Array.from(section.querySelectorAll("span, p")).find((element) => element.textContent === label)
  return text?.parentElement?.parentElement?.lastElementChild?.textContent ?? undefined
}

beforeEach(() => {
  fetchStatsMock.mockResolvedValue(stats())
  fetchTokenEventStatsMock.mockResolvedValue(tokenStats())
  fetchInsightsBreakdownMock.mockResolvedValue({ dimension: "test", rows: [] })
  fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead())
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

describe("C433-INSIGHTS-TRUTHFUL: Token Usage", () => {
  it("C433-INSIGHTS-TRUTHFUL: Test Runs shows the runs' tokens", async () => {
    await renderPage()

    expect(testRunsValue()).toBe(formatTokens(684_477))
    expect(testRunsValue()).not.toBe("0")
  })

  it("C433-INSIGHTS-TRUTHFUL: unmeasured steps are named", async () => {
    fetchTokenEventStatsMock.mockResolvedValue(tokenStats({ testRunUnmeasuredSteps: 3 }))

    await renderPage()

    expect(tokenSection().textContent).toMatch(/3 test-run steps recorded no token usage/)
  })

  it("C433-INSIGHTS-TRUTHFUL: Test Runs never reads 0 when the runs recorded no token counts", async () => {
    fetchTokenEventStatsMock.mockResolvedValue({
      byModel: [],
      bySource: {},
      totals: { promptTokens: 0, completionTokens: 0 },
      testRunUnmeasuredSteps: 4,
    })

    await renderPage()

    expect(container?.textContent).not.toContain("No token usage in this window")
    expect(testRunsValue()).toBe("Not recorded")
    expect(tokenSection().textContent).toMatch(/4 test-run steps recorded no token usage/)
  })

  it("C433-INSIGHTS-TRUTHFUL: Test Runs never reads 0 beside live-editor usage when the runs recorded no token counts", async () => {
    fetchTokenEventStatsMock.mockResolvedValue({
      byModel: [{ date: "2026-10-04", model: "claude-live", promptTokens: 69_000, completionTokens: 900 }],
      bySource: { "live-editor": { promptTokens: 69_000, completionTokens: 900 } },
      totals: { promptTokens: 69_000, completionTokens: 900 },
      testRunUnmeasuredSteps: 2,
    })

    await renderPage()

    expect(testRunsValue()).toBe("Not recorded")
    expect(tokenSection().textContent).toMatch(/2 test-run steps recorded no token usage/)
  })
})

describe("C433-INSIGHTS-TRUTHFUL: Memory", () => {
  it("C433-INSIGHTS-TRUTHFUL: Memory shows the curation that ran", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      byKind: { added: 2, confirmed: 0, superseded: 0, deprecated: 0, promoted: 0, purged: 0 },
    }))

    await renderPage()

    const section = memorySection()
    expect(countFor(section, "Added")).toBe("2")
    expect(countFor(section, "Confirmed")).toBeUndefined()
    expect(section.textContent).not.toContain("No memory-curator activity")
    expect(container?.textContent).not.toContain("No memory-curator activity")
    expect(fetchInsightsKnowledgeChangesMock).toHaveBeenCalledWith({ from: expect.any(String) })
  })

  it("C433-INSIGHTS-TRUTHFUL: Memory says when it could not read", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue({ status: "unavailable", reason: "agent_host_unavailable" })

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toMatch(/could not be read/i)
    expect(section.textContent).not.toContain("No memory-curator activity")
    expect(section.textContent).not.toMatch(/\b0\b/)
    expect(section.querySelectorAll("[data-change-count]")).toHaveLength(0)
  })

  it("C433-INSIGHTS-TRUTHFUL: Memory says when the read itself failed", async () => {
    fetchInsightsKnowledgeChangesMock.mockRejectedValue(new Error("network down"))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toMatch(/could not be read/i)
    expect(section.textContent).not.toMatch(/\b0\b/)
  })

  it("C433-INSIGHTS-TRUTHFUL: Memory names the runs it could not read", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      runsInWindow: 3,
      runsRead: 2,
      runsUnreadable: 1,
    }))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toContain("Could not read curation for 1 of 3 runs")
    expect(section.textContent).not.toContain("No memory-curator activity")
  })

  it("C433-INSIGHTS-TRUTHFUL: Memory says when only the latest runs were read", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      runsInWindow: 340,
      runsRead: 200,
      truncated: { read: 200, total: 340 },
    }))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toContain("latest 200 of 340 runs")
    expect(section.textContent).not.toContain("No memory-curator activity")
  })

  it("C433-INSIGHTS-TRUTHFUL: the empty claim needs a complete read", async () => {
    await renderPage()

    expect(memorySection().textContent).toContain("No memory-curator activity in this window")
  })
})
