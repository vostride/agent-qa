// @vitest-environment jsdom

// No curator activity is claimed only when every settled run's curation changed nothing.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

const EMPTY_CLAIM = "No memory-curator activity"

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

function tokenStats() {
  return {
    byModel: [{ date: "2026-10-04", model: "gpt-5.4-mini", promptTokens: 684_000, completionTokens: 477 }],
    bySource: { "test-run": { promptTokens: 684_000, completionTokens: 477 } },
    totals: { promptTokens: 684_000, completionTokens: 477 },
    testRunUnmeasuredSteps: 0,
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

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

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
    await flush()
  })
}

function memorySection(): HTMLElement {
  const grid = Array.from(container?.querySelectorAll<HTMLElement>("[data-insights-line-grid]") ?? [])
    .find((element) => element.children.length === 2 && /token usage/i.test(element.children[0].textContent ?? ""))
  expect(grid, "the Token Usage and Memory grid is rendered").toBeDefined()
  return grid!.children[1] as HTMLElement
}

function changesValue(section: HTMLElement): string | undefined {
  const label = Array.from(section.querySelectorAll("p")).find((p) => p.textContent === "Changes")
  return label?.nextElementSibling?.textContent ?? undefined
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

describe("Memory curation state", () => {
  it("failed curation is named and never read as no activity", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      runsInWindow: 6,
      runsRead: 0,
      runsCurationFailed: 6,
    }))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toContain("Curation failed for 6 of 6 runs")
    expect(section.textContent).not.toContain(EMPTY_CLAIM)
    expect(container?.textContent).not.toContain(EMPTY_CLAIM)
  })

  it("unfinished curation is named", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      runsInWindow: 6,
      runsRead: 4,
      runsCurationUnfinished: 2,
    }))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toContain("Curation has not finished for 2 of 6 runs")
    expect(section.textContent).not.toContain(EMPTY_CLAIM)
  })

  it("runs still in flight are named, not reported as unreadable", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      runsInWindow: 5,
      runsRead: 5,
      runsInFlight: 1,
    }))

    await renderPage()

    const section = memorySection()
    expect(section.textContent).toContain("1 run in this window has not finished yet")
    expect(section.textContent).not.toContain("Could not read curation")
    expect(section.textContent).not.toContain(EMPTY_CLAIM)
  })

  it("the empty claim needs every count at zero", async () => {
    await renderPage()

    expect(memorySection().textContent).toContain("No memory-curator activity in this window")
  })

  it("changing the window clears the previous window's counts until the new read lands", async () => {
    fetchInsightsKnowledgeChangesMock.mockResolvedValue(knowledgeRead({
      byKind: { added: 6, confirmed: 2, superseded: 0, deprecated: 0, promoted: 0, purged: 0 },
    }))

    await renderPage()

    expect(changesValue(memorySection())).toBe("8")

    let landNext: (value: unknown) => void = () => {}
    fetchInsightsKnowledgeChangesMock.mockImplementationOnce(() => new Promise((resolve) => {
      landNext = resolve
    }))
    const button = Array.from(container!.querySelectorAll("button")).find((element) => element.textContent === "30D")
    expect(button, "the 30D window button is rendered").toBeDefined()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await flush()
    })

    expect(fetchInsightsKnowledgeChangesMock).toHaveBeenCalledTimes(2)
    const pending = memorySection()
    expect(changesValue(pending)).toBeUndefined()
    expect(pending.textContent).not.toMatch(/\b8\b/)
    expect(pending.textContent).toContain("Reading curation changes for this window.")

    await act(async () => {
      landNext(knowledgeRead({
        byKind: { added: 3, confirmed: 0, superseded: 0, deprecated: 0, promoted: 0, purged: 0 },
      }))
      await flush()
    })

    expect(changesValue(memorySection())).toBe("3")
  })
})
