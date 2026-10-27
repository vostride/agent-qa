// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { formatDate } from "@/lib/utils"
import SuiteViewerPage from "@/pages/suite-viewer"
import SuitesPage from "@/pages/suites"
import TestViewerPage from "@/pages/test-viewer"
import TestsPage from "@/pages/tests"

// 2026-10-18 (444-31, D-64): the Tests and Suites pages read every per-row figure from the
// server's batch read. A 200-run page served beside it disagrees on purpose, so a page that
// still folds it fails.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/monaco-editor", () => ({ MonacoEditor: () => <div /> }))
vi.mock("@/components/visual-builder", () => ({ VisualBuilder: () => <div /> }))
vi.mock("@/components/suite-visual-builder", () => ({ SuiteVisualBuilder: () => <div /> }))
vi.mock("@/components/test-navbar", () => ({ TestNavbar: () => <div /> }))
vi.mock("@/components/suite-navbar", () => ({ SuiteNavbar: () => <div /> }))
vi.mock("@/components/pass-rate-chart", () => ({ PassRateChart: () => <div data-testid="pass-rate-chart" /> }))
vi.mock("@/components/duration-chart", () => ({ DurationChart: () => <div /> }))
vi.mock("@/components/token-usage-chart", () => ({ TokenUsageChart: () => <div /> }))

const EM_DASH = "—"

interface Member {
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string
  outcome: string | null
}

interface TestDef {
  name: string
  path: string
  testId: string
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
    memoryLog: null,
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

type Run = ReturnType<typeof run>

function member(test: TestDef, outcome: string | null, suiteId: string | null = null): Member {
  return { testId: test.testId, filePath: test.path, suiteId, name: test.name, outcome }
}

function testFile(test: TestDef) {
  return { path: test.path, name: test.name, testId: test.testId, targetName: null, platform: "web", modified: "2026-10-10T09:00:00.000Z" }
}

function lastRunOf(source: Run) {
  return { id: source.id, status: source.status, startedAt: source.startedAt, createdAt: source.createdAt, duration: source.duration }
}

function testSummary(test: TestDef, passRate: number | null, passed: number, decided: number, last: { run: Run; outcome: string | null } | null) {
  return {
    path: test.path,
    testId: test.testId,
    passRate,
    passed,
    decided,
    lastRun: last === null ? null : { ...lastRunOf(last.run), memberOutcome: last.outcome },
  }
}

const A: TestDef = { name: "Window A", path: "tests/window-a.yaml", testId: "t_window_a" }
const C: TestDef = { name: "Window C", path: "tests/window-c.yaml", testId: "t_window_c" }
const D: TestDef = { name: "Window D", path: "tests/window-d.yaml", testId: "t_window_d" }
const E: TestDef = { name: "Window E", path: "tests/window-e.yaml", testId: "t_window_e" }
const F: TestDef = { name: "Window F", path: "tests/window-f.yaml", testId: "t_window_f" }

const VIEWED_A = {
  path: A.path,
  testId: A.testId,
  content: `name: ${A.name}\ntest-id: ${A.testId}\nsteps:\n  - open the page\n`,
}

// A's five newest passes: what a 200-run page holds once its ten older failures fell off it.
const A_PASSES = [5, 4, 3, 2, 1].map((day) =>
  run(`r_a_pass_${String(day)}`, "passed", `2026-10-1${String(day)}T10:00:00.000Z`, [member(A, "passed")]))
const C_CANCEL = run("r_c_cancel", "cancelled", "2026-10-13T09:00:00.000Z", [member(C, "cancelled")])
const E_OLD = run("r_old", "failed", "2026-10-14T10:00:00.000Z", [member(A, "failed"), member(E, "passed")])

function suiteFile(name: string, path: string, suiteId: string) {
  return { path, name, suiteId, testCount: 1, platform: null, modified: "2026-10-10T09:00:00.000Z" }
}

function suiteSummary(
  suite: ReturnType<typeof suiteFile>,
  passRate: number | null,
  passed: number,
  decided: number,
  last: Run | null,
  platform: string | null,
  targetName: string | null,
) {
  return { path: suite.path, suiteId: suite.suiteId, passRate, passed, decided, lastRun: last === null ? null : lastRunOf(last), platform, targetName }
}

const WINDOW_SUITE = suiteFile("Window suite", "suites/window.suite.yaml", "s_window")
const UNRATED_SUITE = suiteFile("Unrated suite", "suites/unrated.suite.yaml", "s_unrated")
const OLD_SUITE = suiteFile("Old suite", "suites/old.suite.yaml", "s_old")
const IDLE_SUITE = suiteFile("Idle suite", "suites/idle.suite.yaml", "s_idle")
const FRESH_SUITE = suiteFile("Fresh suite", "suites/fresh.suite.yaml", "s_fresh")

const VIEWED_WINDOW_SUITE = {
  path: WINDOW_SUITE.path,
  suiteId: WINDOW_SUITE.suiteId,
  content: `suite-id: ${WINDOW_SUITE.suiteId}\nname: ${WINDOW_SUITE.name}\ntests:\n  - test: ${A.path}\n`,
}

const WINDOW_PASSES = [5, 4, 3, 2, 1].map((day) =>
  run(`r_window_pass_${String(day)}`, "passed", `2026-10-1${String(day)}T10:00:00.000Z`, [member(A, "passed", "s_window")]))
const UNRATED_CANCEL = run("r_unrated_cancel", "cancelled", "2026-10-13T09:00:00.000Z", [member(C, "cancelled", "s_unrated")])
const OLD_RUN = run("r_old", "failed", "2026-10-14T10:00:00.000Z", [member(A, "failed", "s_window"), member(E, "passed", "s_old")])

let served: {
  tests: unknown[]
  suites: unknown[]
  runs: unknown[]
  testSummaries: unknown[]
  testSummariesStatus: number
  suiteSummaries: unknown[]
  suiteSummariesStatus: number
  viewerPassRate: number | null
}

const requests: URL[] = []

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
  requests.push(url)
  if (url.pathname === "/api/tests") return json({ files: served.tests, targets: [] })
  if (url.pathname === "/api/runs") return json({ runs: served.runs, total: served.runs.length, targets: [] })
  if (url.pathname === "/api/analytics/test-summaries") {
    return served.testSummariesStatus === 200
      ? json({ tests: served.testSummaries })
      : json({ error: "Failed to read run summaries" }, served.testSummariesStatus)
  }
  if (url.pathname === "/api/suites") return json({ files: served.suites })
  if (url.pathname === "/api/analytics/suite-summaries") {
    return served.suiteSummariesStatus === 200
      ? json({ suites: served.suiteSummaries })
      : json({ error: "Failed to read run summaries" }, served.suiteSummariesStatus)
  }
  if (url.pathname === `/api/suites/${VIEWED_WINDOW_SUITE.suiteId}`) return json(VIEWED_WINDOW_SUITE)
  if (url.pathname.startsWith("/api/analytics/suites/")) {
    const trends = { passRate: served.viewerPassRate, totalRuns: 3, avgDuration: 1000, daily: [] }
    return json({
      suiteId: VIEWED_WINDOW_SUITE.suiteId,
      runs: [],
      total: 3,
      trends,
      isFlaky: false,
      flakyScore: 0,
      scope: { configured: false, predicates: [], scopedCount: 0, totalCount: 3 },
    })
  }
  if (url.pathname === `/api/tests/${VIEWED_A.testId}`) return json(VIEWED_A)
  if (url.pathname.startsWith("/api/analytics/tests/")) {
    const trends = { passRate: served.viewerPassRate, totalRuns: 3, avgDuration: 1000, daily: [] }
    return json({
      name: A.name,
      runs: [],
      total: 3,
      trends,
      isFlaky: false,
      flakyScore: 0,
      scope: { configured: false, predicates: [], scopedCount: 0, totalCount: 3 },
    })
  }
  return json({})
}

function requestsTo(pathname: string): number {
  return requests.filter((url) => url.pathname === pathname).length
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderPage(path: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tests" element={<TestsPage />} />
          <Route path="/test/:t_id" element={<TestViewerPage />} />
          <Route path="/suites" element={<SuitesPage />} />
          <Route path="/suite/:suite-id" element={<SuiteViewerPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function unmount() {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
}

function rowNamed(name: string): Element | undefined {
  return Array.from(container?.querySelectorAll("tbody tr") ?? []).find((candidate) =>
    candidate.textContent?.includes(name),
  )
}

function listed(names: string[]): string[] {
  return names.filter((name) => rowNamed(name) !== undefined)
}

function columnIndex(label: string): number {
  const headers = Array.from(container?.querySelectorAll("thead th") ?? [])
  const index = headers.findIndex((header) => header.textContent?.trim() === label)
  expect(index, `a ${label} column`).toBeGreaterThanOrEqual(0)
  return index
}

function cellOf(name: string, label: string): Element {
  const row = rowNamed(name)
  expect(row, `a row for ${name}`).toBeTruthy()
  const cell = row!.querySelectorAll("td")[columnIndex(label)]
  expect(cell, `${name}'s ${label} cell`).toBeTruthy()
  return cell!
}

function rateOf(name: string): string {
  return cellOf(name, "Pass rate").textContent ?? ""
}

function rateLineOf(name: string): string {
  return cellOf(name, "Pass rate").querySelector("div > div")?.textContent?.trim() ?? ""
}

function lastRunOfRow(name: string) {
  const cell = cellOf(name, "Last run")
  const link = cell.querySelector('a[href^="/runs/"]')
  return {
    text: cell.textContent ?? "",
    href: link?.getAttribute("href") ?? null,
    badge: link?.querySelector('[data-slot="badge"]')?.textContent ?? null,
  }
}

function rowOrder(names: string[]): string[] {
  return Array.from(container?.querySelectorAll("tbody tr") ?? [])
    .map((row) => names.find((name) => row.textContent?.includes(name)))
    .filter((name): name is string => name !== undefined)
}

// The value printed beside each "Pass Rate" label; the chart's own "Pass Rate" heading is not one.
function ratesBesideLabel(): string[] {
  return Array.from(container?.querySelectorAll("*") ?? [])
    .filter((element) => element.children.length === 0 && element.textContent?.trim() === "Pass Rate")
    .map((label) => label.nextElementSibling)
    .filter((next): next is Element => next !== null && next.querySelector('[data-testid="pass-rate-chart"]') === null)
    .map((next) => next.textContent?.trim() ?? "")
}

function expectEmpty(name: string, labels: string[], what: string) {
  for (const label of labels) {
    const cell = cellOf(name, label)
    expect(cell.textContent, `${name}'s ${label} cell ${what}`).toBe("")
    expect(cell.querySelector("a"), `${name}'s ${label} link ${what}`).toBeNull()
  }
}

function expectUnknown(name: string, what: string) {
  for (const label of ["Pass rate", "Last run"]) {
    const cell = cellOf(name, label)
    const text = cell.textContent ?? ""
    expect(text, `${name}'s ${label} cell ${what}`).not.toMatch(/%|completed|No runs/)
    expect(text, `${name}'s ${label} cell ${what}`).not.toContain(EM_DASH)
    expect(cell.querySelector('a[href^="/runs/"]'), `${name}'s ${label} link ${what}`).toBeNull()
  }
}

beforeEach(() => {
  served = {
    tests: [],
    suites: [],
    runs: [],
    testSummaries: [],
    testSummariesStatus: 200,
    suiteSummaries: [],
    suiteSummariesStatus: 200,
    viewerPassRate: null,
  }
  requests.length = 0
  vi.mocked(toast.error).mockClear()
  vi.stubGlobal("fetch", vi.fn((input: string) => fakeServer(input)))
})

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
})

describe("C444-RATE-WINDOW", () => {
  it("the Tests page reads each test's rate from one batch read, not from its 200-run page", async () => {
    served.tests = [A, C].map(testFile)
    served.runs = [...A_PASSES, C_CANCEL]
    served.testSummaries = [
      testSummary(A, 1 / 3, 5, 15, { run: A_PASSES[0]!, outcome: "passed" }),
      testSummary(C, null, 0, 0, { run: C_CANCEL, outcome: "cancelled" }),
    ]
    await renderPage("/tests")

    expect(rateOf(A.name), "A over its whole history").toBe("33%5/15")
    expect(rateOf(C.name), "C with no pass or fail").toBe(`${EM_DASH}0 completed`)
    expect(lastRunOfRow(A.name)).toMatchObject({ href: `/runs/${A_PASSES[0]!.id}`, badge: "Passed" })
    expect(requestsTo("/api/analytics/test-summaries"), "one batch request").toBe(1)
    expect(requestsTo("/api/runs"), "no 200-run read").toBe(0)
    expect(requests.filter((url) => url.pathname.startsWith("/api/analytics/tests/")), "no per-row viewer read").toEqual([])
    unmount()

    served.testSummariesStatus = 500
    await renderPage("/tests")

    expectUnknown(A.name, "after a failed batch read")
    expectUnknown(C.name, "after a failed batch read")
    expect(vi.mocked(toast.error).mock.calls).toEqual([["Failed to load run history"]])
  })

  it("the Tests page prints a server rate as the test viewer prints it", async () => {
    served.tests = [testFile(A)]
    for (const [rate, passed, decided, printed] of [
      [1 / 3, 1, 3, "33%"],
      [2 / 3, 2, 3, "67%"],
      [1, 1, 1, "100%"],
      [0, 0, 1, "0%"],
      [null, 0, 0, EM_DASH],
    ] as const) {
      served.testSummaries = [testSummary(A, rate, passed, decided, null)]
      served.viewerPassRate = rate
      await renderPage("/tests")
      const listPage = rateLineOf(A.name)
      unmount()
      await renderPage(`/test/${A.testId}`)
      const viewer = ratesBesideLabel()
      unmount()

      expect(listPage, `the Tests page at ${String(rate)}`).toBe(printed)
      expect(viewer, `the test viewer at ${String(rate)}`).toEqual([printed])
    }
  })

  it("the Tests page reads each test's last run from the batch read, and No runs means no run at all", async () => {
    served.tests = [A, E, D, F].map(testFile)
    served.runs = [A_PASSES[0]!]
    served.testSummaries = [
      testSummary(A, 1, 1, 1, { run: A_PASSES[0]!, outcome: "passed" }),
      testSummary(E, 1, 1, 1, { run: E_OLD, outcome: "passed" }),
      testSummary(D, null, 0, 0, null),
    ]
    const names = [A.name, E.name, D.name, F.name]

    await renderPage("/tests")
    const old = lastRunOfRow(E.name)
    expect(old, "E's run fell off the 200-run page").toMatchObject({ href: "/runs/r_old", badge: "Passed" })
    expect(old.text, "E's last-run time").toContain(formatDate(E_OLD.createdAt))
    expect(old.text).not.toContain("No runs")
    expect(lastRunOfRow(D.name).text, "D never ran").toBe("No runs")
    expectUnknown(F.name, "for a file the answer does not name")
    expect(vi.mocked(toast.error), "no toast for an unnamed file").not.toHaveBeenCalled()
    unmount()

    await renderPage("/tests?status=no-runs")
    expect(listed(names), "the No runs filter").toEqual([D.name])
    unmount()

    await renderPage("/tests?status=passed")
    expect(listed(names), "the Passed filter").toEqual([A.name, E.name])
    unmount()

    await renderPage("/tests?sort=lastRun&order=desc")
    expect(rowOrder([A.name, E.name]), "newest last run first").toEqual([A.name, E.name])
    unmount()

    await renderPage("/tests?sort=lastRun&order=asc")
    expect(rowOrder([A.name, E.name]), "oldest last run first").toEqual([E.name, A.name])
    unmount()

    expect(requestsTo("/api/runs"), "no 200-run read").toBe(0)
  })

  it("the Suites page reads each suite's rate from one batch read, not from its 200-run page", async () => {
    served.suites = [WINDOW_SUITE, UNRATED_SUITE]
    served.runs = [...WINDOW_PASSES, UNRATED_CANCEL]
    served.suiteSummaries = [
      suiteSummary(WINDOW_SUITE, 1 / 3, 5, 15, WINDOW_PASSES[0]!, "web", null),
      suiteSummary(UNRATED_SUITE, null, 0, 0, UNRATED_CANCEL, "web", null),
    ]
    await renderPage("/suites")

    expect(rateOf(WINDOW_SUITE.name), "the Window suite over its whole history").toBe("33%5/15")
    expect(rateOf(UNRATED_SUITE.name), "the unrated suite with no pass or fail").toBe(`${EM_DASH}0 completed`)
    expect(lastRunOfRow(WINDOW_SUITE.name)).toMatchObject({ href: `/runs/${WINDOW_PASSES[0]!.id}`, badge: "Passed" })
    expect(lastRunOfRow(UNRATED_SUITE.name)).toMatchObject({ href: `/runs/${UNRATED_CANCEL.id}`, badge: "Cancelled" })
    expect(requestsTo("/api/analytics/suite-summaries"), "one batch request").toBe(1)
    expect(requestsTo("/api/runs"), "no 200-run read").toBe(0)
    expect(requests.filter((url) => url.pathname.startsWith("/api/analytics/suites/")), "no per-row viewer read").toEqual([])
    unmount()

    served.suiteSummariesStatus = 500
    await renderPage("/suites")

    for (const suite of [WINDOW_SUITE, UNRATED_SUITE]) {
      expectEmpty(suite.name, ["Pass rate", "Last run", "Target"], "after a failed batch read")
    }
    expect(vi.mocked(toast.error).mock.calls).toEqual([["Failed to load run history"]])
  })

  it("the Suites page prints a server rate as the suite viewer prints it", async () => {
    served.suites = [WINDOW_SUITE]
    for (const [rate, passed, decided, printed] of [
      [1 / 3, 1, 3, "33%"],
      [2 / 3, 2, 3, "67%"],
      [1, 1, 1, "100%"],
      [0, 0, 1, "0%"],
      [null, 0, 0, EM_DASH],
    ] as const) {
      served.suiteSummaries = [suiteSummary(WINDOW_SUITE, rate, passed, decided, null, null, null)]
      served.viewerPassRate = rate
      await renderPage("/suites")
      const listPage = rateLineOf(WINDOW_SUITE.name)
      unmount()
      await renderPage(`/suite/${WINDOW_SUITE.suiteId}`)
      const viewer = ratesBesideLabel()
      unmount()

      expect(listPage, `the Suites page at ${String(rate)}`).toBe(printed)
      expect(viewer, `the suite viewer at ${String(rate)}`).toEqual([printed])
    }
  })

  it("the Suites page reads each suite's last run, target and platform from the batch read, and No runs means no run at all", async () => {
    served.suites = [WINDOW_SUITE, OLD_SUITE, IDLE_SUITE, FRESH_SUITE]
    served.runs = [WINDOW_PASSES[0]!]
    served.suiteSummaries = [
      suiteSummary(WINDOW_SUITE, 1, 1, 1, WINDOW_PASSES[0]!, "web", null),
      suiteSummary(OLD_SUITE, 0, 0, 1, OLD_RUN, "android", "staging"),
      suiteSummary(IDLE_SUITE, null, 0, 0, null, null, null),
    ]
    const names = [WINDOW_SUITE.name, OLD_SUITE.name, IDLE_SUITE.name, FRESH_SUITE.name]

    await renderPage("/suites")
    const old = lastRunOfRow(OLD_SUITE.name)
    expect(old, "the Old suite's run fell off the 200-run page").toMatchObject({ href: "/runs/r_old", badge: "Failed" })
    expect(old.text).toContain(formatDate(OLD_RUN.createdAt))
    expect(old.text).not.toContain("No runs")
    expect(cellOf(OLD_SUITE.name, "Target").textContent, "the Old suite's target").toBe("staging")
    expect(cellOf(OLD_SUITE.name, "Platform").textContent, "the Old suite's platform").toBe("Android")
    expect(lastRunOfRow(IDLE_SUITE.name).text, "the Idle suite never ran").toBe("No runs")
    expect(cellOf(IDLE_SUITE.name, "Target").textContent, "the Idle suite's target").toBe("No target")
    expectEmpty(FRESH_SUITE.name, ["Pass rate", "Last run", "Target"], "for a file the answer does not name")
    expect(vi.mocked(toast.error), "no toast for an unnamed file").not.toHaveBeenCalled()
    unmount()

    await renderPage("/suites?status=no-runs")
    expect(listed(names), "the No runs filter").toEqual([IDLE_SUITE.name])
    unmount()

    await renderPage("/suites?status=failed")
    expect(listed(names), "the Failed filter").toEqual([OLD_SUITE.name])
    unmount()

    await renderPage("/suites?platform=android")
    expect(listed(names), "the Android filter").toEqual([OLD_SUITE.name])
    unmount()

    expect(requestsTo("/api/runs"), "no 200-run read").toBe(0)
  })
})
