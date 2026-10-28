// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { InsightsBreakdownTable } from "@/components/insights/insights-breakdown-table"
import type { InsightsBreakdownRow } from "@/lib/api"
import InsightsPage from "@/pages/insights"
import SuiteViewerPage from "@/pages/suite-viewer"
import SuitesPage from "@/pages/suites"
import TestViewerPage from "@/pages/test-viewer"
import TestsPage from "@/pages/tests"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { chartData } = vi.hoisted(() => ({ chartData: [] as unknown[] }))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/monaco-editor", () => ({ MonacoEditor: () => <div /> }))
vi.mock("@/components/visual-builder", () => ({ VisualBuilder: () => <div /> }))
vi.mock("@/components/suite-visual-builder", () => ({ SuiteVisualBuilder: () => <div /> }))
vi.mock("@/components/test-navbar", () => ({ TestNavbar: () => <div /> }))
vi.mock("@/components/suite-navbar", () => ({ SuiteNavbar: () => <div /> }))
vi.mock("@/components/pass-rate-chart", () => ({
  PassRateChart: ({ data }: { data: unknown }) => {
    chartData.push(data)
    return <div data-testid="pass-rate-chart" />
  },
}))
vi.mock("@/components/duration-chart", () => ({ DurationChart: () => <div /> }))
vi.mock("@/components/token-usage-chart", () => ({ TokenUsageChart: () => <div /> }))

const EM_DASH = "—"

const VIEWED_TEST = {
  path: "tests/checkout.yaml",
  testId: "t_checkout",
  content: "name: Checkout flow\ntest-id: t_checkout\nsteps:\n  - open the cart\n",
}

const VIEWED_SUITE = {
  path: "suites/nightly.yaml",
  suiteId: "s_nightly",
  content: "suite-id: s_nightly\nname: Nightly suite\ntarget: web\ntests:\n  - test: tests/checkout.yaml\n",
}

type Daily = { date: string; passed: number; failed: number; total: number; avgDuration: number }

let trends: { passRate: number | null; totalRuns: number; avgDuration: number; daily: Daily[] }
let suiteAnalyticsFails = false

interface Member {
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string
  outcome: string | null
}

function run(id: string, status: string, createdAt: string, members: Member[]) {
  return {
    id,
    name: members.map((member) => member.name).join(" · "),
    filePath: null,
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: createdAt,
    endedAt: status === "running" ? null : createdAt,
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt,
    members: members.map((member, testIndex) => ({ testIndex, ...member })),
  }
}

const STEADY = { name: "Steady", path: "tests/steady.yaml", testId: "t_steady" }
const PARKED = { name: "Parked", path: "tests/parked.yaml", testId: "t_parked" }
const MIXED = { name: "Mixed", path: "tests/mixed.yaml", testId: "t_mixed" }

function member(test: typeof STEADY, outcome: string | null, suiteId: string | null = null): Member {
  return { testId: test.testId, filePath: test.path, suiteId, name: test.name, outcome }
}

function testFile(test: typeof STEADY) {
  return { path: test.path, name: test.name, testId: test.testId, targetName: null, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

function suiteFile(name: string, path: string, suiteId: string) {
  return { path, name, suiteId, testCount: 1, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

type Stats = {
  totalRuns: number
  passed: number
  failed: number
  flakeRate: number
  avgDuration: number
  runs: Array<{ date: string; passed: number; failed: number; healed: number; duration: number }>
}

let served: {
  tests: unknown[]
  suites: unknown[]
  runs: unknown[]
  stats: Stats | null
  testSummaries: unknown[]
  suiteSummaries: unknown[]
} = {
  tests: [],
  suites: [],
  runs: [],
  stats: null,
  testSummaries: [],
  suiteSummaries: [],
}

type Run = ReturnType<typeof run>

// The batch read's row for a test, with the figures the server gives for its seeded runs.
function testSummary(test: typeof STEADY, passRate: number | null, passed: number, decided: number, last: Run | null, outcome: string | null) {
  return {
    path: test.path,
    testId: test.testId,
    passRate,
    passed,
    decided,
    lastRun: last === null
      ? null
      : { id: last.id, status: last.status, startedAt: last.startedAt, createdAt: last.createdAt, duration: last.duration, memberOutcome: outcome },
  }
}

// The batch read's row for a suite, with the figures the server gives for its seeded runs.
function suiteSummary(
  path: string,
  suiteId: string,
  passRate: number | null,
  passed: number,
  decided: number,
  last: Run | null,
  platform: string | null,
  targetName: string | null,
) {
  return {
    path,
    suiteId,
    passRate,
    passed,
    decided,
    lastRun: last === null
      ? null
      : { id: last.id, status: last.status, startedAt: last.startedAt, createdAt: last.createdAt, duration: last.duration },
    platform,
    targetName,
  }
}

function analytics() {
  return {
    runs: [],
    total: trends.totalRuns,
    trends,
    isFlaky: false,
    flakyScore: 0,
    scope: { configured: false, predicates: [], scopedCount: 0, totalCount: trends.totalRuns },
  }
}

function json(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
  })
}

function fakeServer(input: string) {
  const url = new URL(input, "http://dashboard.test")
  if (url.pathname === "/api/tests") return json({ files: served.tests, targets: [] })
  if (url.pathname === "/api/suites") return json({ files: served.suites })
  if (url.pathname === "/api/runs") return json({ runs: served.runs, total: served.runs.length, targets: [] })
  if (url.pathname === "/api/analytics/test-summaries") return json({ tests: served.testSummaries })
  if (url.pathname === "/api/analytics/suite-summaries") return json({ suites: served.suiteSummaries })
  if (url.pathname === "/api/stats") return json(served.stats)
  if (url.pathname === "/api/token-events/stats") {
    return json({ byModel: [], bySource: {}, totals: { promptTokens: 0, completionTokens: 0 } })
  }
  if (url.pathname === "/api/insights/knowledge-changes") return json({ status: "unavailable", reason: "read_failed" })
  if (url.pathname === "/api/analytics/breakdowns") return json({ dimension: url.searchParams.get("dimension"), rows: [] })
  if (url.pathname === `/api/tests/${VIEWED_TEST.testId}`) return json(VIEWED_TEST)
  if (url.pathname === `/api/suites/${VIEWED_SUITE.suiteId}`) return json(VIEWED_SUITE)
  if (url.pathname.startsWith("/api/analytics/tests/")) return json({ name: "Checkout flow", ...analytics() })
  if (url.pathname === `/api/analytics/suites/${VIEWED_SUITE.suiteId}`) {
    return suiteAnalyticsFails
      ? json({ error: "unavailable" }, 500)
      : json({ suiteId: VIEWED_SUITE.suiteId, ...analytics() })
  }
  return json({})
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

async function renderPage(path: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/test/:t_id" element={<TestViewerPage />} />
          <Route path="/suite/:suite-id" element={<SuiteViewerPage />} />
          <Route path="/tests" element={<TestsPage />} />
          <Route path="/suites" element={<SuitesPage />} />
          <Route path="/insights" element={<InsightsPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
}

async function renderTable(node: ReactNode) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(node)
  })
}

function unmount() {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
}

// The value printed beside each "Pass Rate" label; the chart's own "Pass Rate" heading is not one.
function ratesBesideLabel(): string[] {
  return Array.from(container?.querySelectorAll("*") ?? [])
    .filter((element) => element.children.length === 0 && element.textContent?.trim() === "Pass Rate")
    .map((label) => label.nextElementSibling)
    .filter((next): next is Element => next !== null && next.querySelector('[data-testid="pass-rate-chart"]') === null)
    .map((next) => next.textContent?.trim() ?? "")
}

function passRateCells(dimension: "test" | "platform"): string[] {
  const column = dimension === "platform" ? 4 : 2
  return Array.from(container?.querySelectorAll("tbody tr") ?? [])
    .map((row) => row.querySelectorAll("td")[column]?.textContent?.trim() ?? "")
}

function passRateOf(name: string): string {
  const row = Array.from(container?.querySelectorAll("tbody tr") ?? []).find((candidate) =>
    candidate.textContent?.includes(name),
  )
  expect(row, `a row for ${name}`).toBeTruthy()
  return Array.from(row!.querySelectorAll("td")).map((cell) => cell.textContent ?? "")
    .find((text) => /%|0 completed/.test(text)) ?? ""
}

function insightsPassRateMetric(): { value: string; description: string } {
  const labels = Array.from(container?.querySelectorAll("p") ?? []).filter((element) =>
    element.textContent?.trim() === "Pass Rate" && element.nextElementSibling?.tagName === "P",
  )
  expect(labels, "one Pass Rate metric cell").toHaveLength(1)
  return {
    value: labels[0]!.nextElementSibling?.textContent?.trim() ?? "",
    description: labels[0]!.parentElement?.nextElementSibling?.textContent?.trim() ?? "",
  }
}

function everyCell(): string[] {
  return Array.from(container?.querySelectorAll("tbody td") ?? []).map((cell) => cell.textContent?.trim() ?? "")
}

beforeEach(() => {
  served = { tests: [], suites: [], runs: [], stats: null, testSummaries: [], suiteSummaries: [] }
  trends = { passRate: null, totalRuns: 2, avgDuration: 1000, daily: [] }
  suiteAnalyticsFails = false
  chartData.length = 0
  vi.stubGlobal("fetch", vi.fn((input: string) => fakeServer(input)))
})

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe('C444-PASS-RATE', () => {
  it("the test viewer shows an em dash for a test with no rate", async () => {
    for (const tab of ["overview", "insights"]) {
      trends = { passRate: null, totalRuns: 2, avgDuration: 1000, daily: [] }
      await renderPage(`/test/${VIEWED_TEST.testId}?tab=${tab}`)
      expect(ratesBesideLabel(), `the ${tab} layout with no rate`).toEqual([EM_DASH])
      unmount()

      trends = { passRate: 0.5, totalRuns: 2, avgDuration: 1000, daily: [] }
      await renderPage(`/test/${VIEWED_TEST.testId}?tab=${tab}`)
      expect(ratesBesideLabel(), `the ${tab} layout at one half`).toEqual(["50%"])
      unmount()
    }
  })

  it("the suite viewer shows an em dash for a suite with no rate", async () => {
    for (const tab of ["overview", "insights"]) {
      trends = { passRate: null, totalRuns: 2, avgDuration: 1000, daily: [] }
      await renderPage(`/suite/${VIEWED_SUITE.suiteId}?tab=${tab}`)
      expect(ratesBesideLabel(), `the ${tab} layout with no rate`).toEqual([EM_DASH])
      unmount()

      suiteAnalyticsFails = true
      await renderPage(`/suite/${VIEWED_SUITE.suiteId}?tab=${tab}`)
      expect(ratesBesideLabel(), `the ${tab} layout over the empty-analytics default`).toEqual([EM_DASH])
      unmount()
      suiteAnalyticsFails = false

      trends = { passRate: 0.5, totalRuns: 2, avgDuration: 1000, daily: [] }
      await renderPage(`/suite/${VIEWED_SUITE.suiteId}?tab=${tab}`)
      expect(ratesBesideLabel(), `the ${tab} layout at one half`).toEqual(["50%"])
      unmount()
    }
  })

  it("the insights breakdown shows an em dash for a group with no rate", async () => {
    const rows: InsightsBreakdownRow[] = [
      { key: "Unrated", label: "Unrated", runs: 3, passRate: null, flakeRate: 0.25, avgDuration: 1000, passed: 0, failed: 0 },
      { key: "Rated", label: "Rated", runs: 2, passRate: 0.5, flakeRate: 0.25, avgDuration: 1000, passed: 1, failed: 1 },
    ]
    await renderTable(<InsightsBreakdownTable dimension="test" rows={rows} />)
    expect(passRateCells("test")).toEqual([EM_DASH, "50%"])
    expect(everyCell()).not.toContain("0%")
    unmount()

    const platforms: InsightsBreakdownRow[] = [
      { key: "ios", label: "ios", runs: 3, passRate: null, flakeRate: 0.25, avgDuration: 1000, passed: 0, failed: 0 },
      { key: "web", label: "web", runs: 2, passRate: 0.5, flakeRate: 0.25, avgDuration: 1000, passed: 1, failed: 1 },
    ]
    await renderTable(<InsightsBreakdownTable dimension="platform" rows={platforms} />)
    expect(passRateCells("platform")).toEqual([EM_DASH, "50%"])
    expect(everyCell()).not.toContain("0%")
  })

  it("the viewers' chart rates a day by its passes and failures only", async () => {
    const daily: Daily[] = [
      { date: "2026-10-01", passed: 1, failed: 0, total: 3, avgDuration: 1000 },
      { date: "2026-10-02", passed: 0, failed: 0, total: 2, avgDuration: 1000 },
    ]
    for (const path of [`/test/${VIEWED_TEST.testId}?tab=insights`, `/suite/${VIEWED_SUITE.suiteId}?tab=insights`]) {
      trends = { passRate: 1, totalRuns: 5, avgDuration: 1000, daily }
      chartData.length = 0
      await renderPage(path)
      expect(chartData.length, `${path} renders its pass-rate chart`).toBeGreaterThan(0)
      expect(chartData[chartData.length - 1], path).toEqual([{ date: "2026-10-01", passRate: 100 }])
      unmount()
    }
  })

  // 2026-10-18 (444-31, D-64): the page prints the server's pass ÷ (pass + fail) for this seeded
  // history, which its cancelled, skipped and in-flight runs don't move.
  it("the Tests page rates a test over its pass and fail outcomes only", async () => {
    served.tests = [STEADY, PARKED, MIXED].map(testFile)
    const live = run("r_live", "running", "2026-10-17T13:00:00.000Z", [member(STEADY, null)])
    const skip = run("r_skip", "cancelled", "2026-10-17T12:00:00.000Z", [member(PARKED, "cancelled"), member(STEADY, "skipped")])
    const pass = run("r_pass", "passed", "2026-10-17T10:00:00.000Z", [member(STEADY, "passed"), member(MIXED, "passed")])
    served.runs = [
      live,
      skip,
      run("r_cancel", "cancelled", "2026-10-17T11:00:00.000Z", [member(STEADY, "cancelled"), member(PARKED, "skipped")]),
      pass,
      run("r_timeout", "timeout", "2026-10-17T09:30:00.000Z", [member(MIXED, "timeout")]),
    ]
    served.testSummaries = [
      testSummary(STEADY, 1, 1, 1, live, null),
      testSummary(PARKED, null, 0, 0, skip, "cancelled"),
      testSummary(MIXED, 0.5, 1, 2, pass, "passed"),
    ]
    await renderPage("/tests")

    expect(passRateOf(STEADY.name), "passed, cancelled, skipped and in flight").toBe("100%1/1")
    expect(passRateOf(PARKED.name), "cancelled and skipped only").toBe(`${EM_DASH}0 completed`)
    expect(passRateOf(MIXED.name), "passed and timed out").toBe("50%1/2")
  })

  // 2026-10-18 (444-31, D-64): the page prints the server's pass ÷ (pass + fail) for this seeded
  // history, which its cancelled runs don't move.
  it("the Suites page rates a suite over its passed and failed runs only", async () => {
    served.suites = [
      suiteFile("Rated suite", "suites/rated.yaml", "s_rated"),
      suiteFile("Unrated suite", "suites/unrated.yaml", "s_unrated"),
    ]
    const ratedCancel = run("r_rated_cancel", "cancelled", "2026-10-17T11:00:00.000Z", [member(STEADY, "cancelled", "s_rated")])
    const unratedCancel = run("r_unrated_cancel", "cancelled", "2026-10-17T09:00:00.000Z", [member(PARKED, "cancelled", "s_unrated")])
    served.runs = [
      ratedCancel,
      run("r_rated_pass", "passed", "2026-10-17T10:00:00.000Z", [member(STEADY, "passed", "s_rated")]),
      unratedCancel,
    ]
    served.suiteSummaries = [
      suiteSummary("suites/rated.yaml", "s_rated", 1, 1, 1, ratedCancel, "web", null),
      suiteSummary("suites/unrated.yaml", "s_unrated", null, 0, 0, unratedCancel, "web", null),
    ]
    await renderPage("/suites")

    expect(passRateOf("Rated suite"), "passed and cancelled").toBe("100%1/1")
    expect(passRateOf("Unrated suite"), "cancelled only").toBe(`${EM_DASH}0 completed`)
  })

  it("the insights summary rates the window over its passed and failed runs only", async () => {
    served.stats = {
      totalRuns: 4,
      passed: 1,
      failed: 1,
      flakeRate: 0,
      avgDuration: 1000,
      runs: [
        { date: "2026-10-16", passed: 1, failed: 1, healed: 0, duration: 1000 },
        { date: "2026-10-17", passed: 0, failed: 0, healed: 0, duration: 1000 },
      ],
    }
    chartData.length = 0
    await renderPage("/insights")

    expect(insightsPassRateMetric()).toEqual({
      value: "50%",
      description: "1 successful runs out of 2 that passed or failed.",
    })
    expect(chartData.length, "the insights pass-rate chart rendered").toBeGreaterThan(0)
    expect(chartData[chartData.length - 1]).toEqual([{ date: "2026-10-16", passRate: 50 }])
    unmount()

    served.stats = {
      totalRuns: 2,
      passed: 0,
      failed: 0,
      flakeRate: 0,
      avgDuration: 1000,
      runs: [{ date: "2026-10-17", passed: 0, failed: 0, healed: 0, duration: 1000 }],
    }
    await renderPage("/insights")

    expect(insightsPassRateMetric().value).toBe(EM_DASH)
    expect(insightsPassRateMetric().value).not.toContain("%")
  })
})
