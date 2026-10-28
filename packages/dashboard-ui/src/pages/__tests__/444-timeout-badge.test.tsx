// @vitest-environment jsdom

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import SuiteViewerPage from "@/pages/suite-viewer"
import SuitesPage from "@/pages/suites"
import TestViewerPage from "@/pages/test-viewer"
import TestsPage from "@/pages/tests"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/monaco-editor", () => ({ MonacoEditor: () => <div /> }))
vi.mock("@/components/visual-builder", () => ({ VisualBuilder: () => <div /> }))
vi.mock("@/components/suite-visual-builder", () => ({ SuiteVisualBuilder: () => <div /> }))
vi.mock("@/components/test-navbar", () => ({ TestNavbar: () => <div /> }))
vi.mock("@/components/suite-navbar", () => ({ SuiteNavbar: () => <div /> }))
vi.mock("@/components/pass-rate-chart", () => ({ PassRateChart: () => <div /> }))
vi.mock("@/components/duration-chart", () => ({ DurationChart: () => <div /> }))

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
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt,
    members: members.map((member, testIndex) => ({ testIndex, ...member })),
  }
}

interface TestDef {
  name: string
  path: string
  testId: string
}

function testFile(test: TestDef) {
  return { path: test.path, name: test.name, testId: test.testId, targetName: null, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

function member(test: TestDef, outcome: string | null, suiteId: string | null = null): Member {
  return { testId: test.testId, filePath: test.path, suiteId, name: test.name, outcome }
}

const SLOW = { name: "Slow checkout", path: "tests/slow-checkout.yaml", testId: "t_slow" }
const QUICK = { name: "Quick login", path: "tests/quick-login.yaml", testId: "t_quick" }
const BROKEN = { name: "Broken search", path: "tests/broken-search.yaml", testId: "t_broken" }
const MENDED = { name: "Mended profile", path: "tests/mended-profile.yaml", testId: "t_mended" }

function suiteFile(name: string, path: string, suiteId: string) {
  return { path, name, suiteId, testCount: 1, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

const SLOW_SUITE = suiteFile("Slow suite", "suites/slow.yaml", "s_slow")
const QUICK_SUITE = suiteFile("Quick suite", "suites/quick.yaml", "s_quick")
const BROKEN_SUITE = suiteFile("Broken suite", "suites/broken.yaml", "s_broken")
const MENDED_SUITE = suiteFile("Mended suite", "suites/mended.yaml", "s_mended")

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

let served: {
  tests: unknown[]
  suites: unknown[]
  runs: Array<ReturnType<typeof run>>
  testAnalyticsRuns: unknown[]
  suiteAnalyticsRuns: unknown[]
  testSummaries: unknown[]
  suiteSummaries: unknown[]
} = { tests: [], suites: [], runs: [], testAnalyticsRuns: [], suiteAnalyticsRuns: [], testSummaries: [], suiteSummaries: [] }

type Run = ReturnType<typeof run>

// The batch read's row for a test, with the figures the server gives for its seeded runs.
function testSummary(test: TestDef, passRate: number | null, passed: number, decided: number, last: Run, outcome: string | null) {
  return {
    path: test.path,
    testId: test.testId,
    passRate,
    passed,
    decided,
    lastRun: { id: last.id, status: last.status, startedAt: last.startedAt, createdAt: last.createdAt, duration: last.duration, memberOutcome: outcome },
  }
}

// The batch read's row for a suite, with the figures the server gives for its seeded runs.
function suiteSummary(suite: ReturnType<typeof suiteFile>, passRate: number | null, passed: number, decided: number, last: Run) {
  return {
    path: suite.path,
    suiteId: suite.suiteId,
    passRate,
    passed,
    decided,
    lastRun: { id: last.id, status: last.status, startedAt: last.startedAt, createdAt: last.createdAt, duration: last.duration },
    platform: "web",
    targetName: null,
  }
}

function analytics(runs: unknown[]) {
  return {
    runs,
    total: runs.length,
    trends: { passRate: 0.5, avgDuration: 1000, totalRuns: runs.length, daily: [] },
    isFlaky: false,
    flakyScore: 0,
    scope: { configured: false, predicates: [], scopedCount: 0, totalCount: runs.length },
  }
}

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(body) })
}

function fakeServer(input: string) {
  const url = new URL(input, "http://dashboard.test")
  if (url.pathname === "/api/tests") return json({ files: served.tests, targets: [] })
  if (url.pathname === "/api/analytics/test-summaries") return json({ tests: served.testSummaries })
  if (url.pathname === "/api/analytics/suite-summaries") return json({ suites: served.suiteSummaries })
  if (url.pathname === "/api/suites") return json({ files: served.suites })
  if (url.pathname === `/api/tests/${VIEWED_TEST.testId}`) return json(VIEWED_TEST)
  if (url.pathname === `/api/suites/${VIEWED_SUITE.suiteId}`) return json(VIEWED_SUITE)
  if (url.pathname.startsWith("/api/analytics/tests/")) return json({ name: "Checkout flow", ...analytics(served.testAnalyticsRuns) })
  if (url.pathname === `/api/analytics/suites/${VIEWED_SUITE.suiteId}`) {
    return json({ suiteId: VIEWED_SUITE.suiteId, ...analytics(served.suiteAnalyticsRuns) })
  }
  if (url.pathname === "/api/runs") {
    const statuses = url.searchParams.getAll("status")
    const runs = statuses.length > 0 ? served.runs.filter((row) => statuses.includes(row.status)) : served.runs
    return json({ runs, total: runs.length, targets: [] })
  }
  return json({})
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
          <Route path="/suites" element={<SuitesPage />} />
          <Route path="/test/:t_id" element={<TestViewerPage />} />
          <Route path="/suite/:suite-id" element={<SuiteViewerPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

function rowNamed(name: string): Element | undefined {
  return Array.from(container?.querySelectorAll("tbody tr") ?? []).find((candidate) =>
    candidate.textContent?.includes(name),
  )
}

function listedTests(): string[] {
  return [SLOW, QUICK, BROKEN, MENDED].map((test) => test.name).filter((name) => rowNamed(name) !== undefined)
}

function listedSuites(): string[] {
  return [SLOW_SUITE, QUICK_SUITE, BROKEN_SUITE, MENDED_SUITE].map((suite) => suite.name).filter((name) => rowNamed(name) !== undefined)
}

function look(badge: Element | null | undefined, what: string) {
  expect(badge, what).toBeTruthy()
  return { variant: badge!.getAttribute("data-variant"), text: badge!.textContent }
}

function lastRunBadge(name: string) {
  const row = rowNamed(name)
  expect(row, `a row for ${name}`).toBeTruthy()
  return look(row!.querySelector('a[href^="/runs/"] [data-slot="badge"]'), `a last-run badge for ${name}`)
}

function runListBadge(runId: string) {
  const row = container?.querySelector(`a[href="/runs/${runId}"]`)?.closest("tr")
  expect(row, `a run-list row for ${runId}`).toBeTruthy()
  return look(row!.querySelector('[data-slot="badge"]'), `a badge in ${runId}'s row`)
}

const PAGE_FILES = ["tests.tsx", "suites.tsx", "test-viewer.tsx", "suite-viewer.tsx"]

function pageSource(file: string): string {
  const text = readFileSync(resolve(process.cwd(), "src/pages", file), "utf8")
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

beforeEach(() => {
  served = { tests: [], suites: [], runs: [], testAnalyticsRuns: [], suiteAnalyticsRuns: [], testSummaries: [], suiteSummaries: [] }
  vi.stubGlobal("fetch", vi.fn((input: string) => fakeServer(input)))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

describe('C444-TIMEOUT-BADGE', () => {
  it("the Tests page shows a timed-out last run as a destructive Timed out badge", async () => {
    served.tests = [SLOW, QUICK].map(testFile)
    served.runs = [
      run("r_slow", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout")]),
      run("r_quick", "passed", "2026-10-17T10:00:00.000Z", [member(QUICK, "passed")]),
    ]
    served.testSummaries = [
      testSummary(SLOW, 0, 0, 1, served.runs[0]!, "timeout"),
      testSummary(QUICK, 1, 1, 1, served.runs[1]!, "passed"),
    ]
    await renderPage("/tests")

    expect(lastRunBadge(QUICK.name)).toEqual({ variant: "default", text: "Passed" })
    expect(lastRunBadge(SLOW.name)).toEqual({ variant: "destructive", text: "Timed out" })
  })

  it("the Tests page's Failed filter lists a test whose last run timed out", async () => {
    served.tests = [SLOW, QUICK, BROKEN].map(testFile)
    served.runs = [
      run("r_slow", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout")]),
      run("r_quick", "passed", "2026-10-17T10:30:00.000Z", [member(QUICK, "passed")]),
      run("r_broken", "failed", "2026-10-17T10:00:00.000Z", [member(BROKEN, "failed")]),
    ]
    served.testSummaries = [
      testSummary(SLOW, 0, 0, 1, served.runs[0]!, "timeout"),
      testSummary(QUICK, 1, 1, 1, served.runs[1]!, "passed"),
      testSummary(BROKEN, 0, 0, 1, served.runs[2]!, "failed"),
    ]
    await renderPage("/tests?status=failed")

    expect(listedTests()).toEqual([SLOW.name, BROKEN.name])
  })

  it("the Tests page's Passed filter lists a test whose last run healed", async () => {
    served.tests = [SLOW, QUICK, MENDED].map(testFile)
    served.runs = [
      run("r_slow", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout")]),
      run("r_quick", "passed", "2026-10-17T10:30:00.000Z", [member(QUICK, "passed")]),
      run("r_mended", "healed", "2026-10-17T10:00:00.000Z", [member(MENDED, "healed")]),
    ]
    served.testSummaries = [
      testSummary(SLOW, 0, 0, 1, served.runs[0]!, "timeout"),
      testSummary(QUICK, 1, 1, 1, served.runs[1]!, "passed"),
      testSummary(MENDED, 1, 1, 1, served.runs[2]!, "healed"),
    ]
    await renderPage("/tests?status=passed")

    expect(listedTests()).toEqual([QUICK.name, MENDED.name])
  })

  it("the Suites page shows a timed-out last run as a destructive Timed out badge", async () => {
    served.suites = [SLOW_SUITE, QUICK_SUITE]
    served.runs = [
      run("r_slow_suite", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout", SLOW_SUITE.suiteId)]),
      run("r_quick_suite", "passed", "2026-10-17T10:00:00.000Z", [member(QUICK, "passed", QUICK_SUITE.suiteId)]),
    ]
    served.suiteSummaries = [
      suiteSummary(SLOW_SUITE, 0, 0, 1, served.runs[0]!),
      suiteSummary(QUICK_SUITE, 1, 1, 1, served.runs[1]!),
    ]
    await renderPage("/suites")

    expect(lastRunBadge(QUICK_SUITE.name)).toEqual({ variant: "default", text: "Passed" })
    expect(lastRunBadge(SLOW_SUITE.name)).toEqual({ variant: "destructive", text: "Timed out" })
  })

  it("the Suites page's Failed filter lists a suite whose last run timed out", async () => {
    served.suites = [SLOW_SUITE, QUICK_SUITE, BROKEN_SUITE]
    served.runs = [
      run("r_slow_suite", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout", SLOW_SUITE.suiteId)]),
      run("r_quick_suite", "passed", "2026-10-17T10:30:00.000Z", [member(QUICK, "passed", QUICK_SUITE.suiteId)]),
      run("r_broken_suite", "failed", "2026-10-17T10:00:00.000Z", [member(BROKEN, "failed", BROKEN_SUITE.suiteId)]),
    ]
    served.suiteSummaries = [
      suiteSummary(SLOW_SUITE, 0, 0, 1, served.runs[0]!),
      suiteSummary(QUICK_SUITE, 1, 1, 1, served.runs[1]!),
      suiteSummary(BROKEN_SUITE, 0, 0, 1, served.runs[2]!),
    ]
    await renderPage("/suites?status=failed")

    expect(listedSuites()).toEqual([SLOW_SUITE.name, BROKEN_SUITE.name])
  })

  it("the Suites page's Passed filter lists a suite whose last run healed", async () => {
    served.suites = [SLOW_SUITE, QUICK_SUITE, MENDED_SUITE]
    served.runs = [
      run("r_slow_suite", "timeout", "2026-10-17T11:00:00.000Z", [member(SLOW, "timeout", SLOW_SUITE.suiteId)]),
      run("r_quick_suite", "passed", "2026-10-17T10:30:00.000Z", [member(QUICK, "passed", QUICK_SUITE.suiteId)]),
      run("r_mended_suite", "healed", "2026-10-17T10:00:00.000Z", [member(MENDED, "healed", MENDED_SUITE.suiteId)]),
    ]
    served.suiteSummaries = [
      suiteSummary(SLOW_SUITE, 0, 0, 1, served.runs[0]!),
      suiteSummary(QUICK_SUITE, 1, 1, 1, served.runs[1]!),
      suiteSummary(MENDED_SUITE, 1, 1, 1, served.runs[2]!),
    ]
    await renderPage("/suites?status=passed")

    expect(listedSuites()).toEqual([QUICK_SUITE.name, MENDED_SUITE.name])
  })

  it("the test viewer shows a timed-out member outcome as a destructive Timed out badge", async () => {
    const viewed = { name: "Checkout flow", path: VIEWED_TEST.path, testId: VIEWED_TEST.testId }
    served.testAnalyticsRuns = [
      { ...run("r_view_timeout", "timeout", "2026-10-17T12:00:00.000Z", [member(viewed, "timeout")]), memberOutcome: "timeout" },
      { ...run("r_view_passed", "passed", "2026-10-17T11:00:00.000Z", [member(viewed, "passed")]), memberOutcome: "passed" },
    ]
    await renderPage(`/test/${VIEWED_TEST.testId}`)

    expect(runListBadge("r_view_passed")).toEqual({ variant: "default", text: "Passed" })
    expect(runListBadge("r_view_timeout")).toEqual({ variant: "destructive", text: "Timed out" })
  })

  it("the suite viewer shows a timed-out run as a destructive Timed out badge", async () => {
    served.suiteAnalyticsRuns = [
      { id: "r_nightly_timeout", status: "timeout", duration: 1000, createdAt: "2026-10-17T12:00:00.000Z", source: "suite" },
      { id: "r_nightly_passed", status: "passed", duration: 1000, createdAt: "2026-10-17T11:00:00.000Z", source: "suite" },
    ]
    await renderPage(`/suite/${VIEWED_SUITE.suiteId}`)

    expect(runListBadge("r_nightly_passed")).toEqual({ variant: "default", text: "Passed" })
    expect(runListBadge("r_nightly_timeout")).toEqual({ variant: "destructive", text: "Timed out" })
  })

  it("no page keeps its own status badge switch", () => {
    for (const file of PAGE_FILES) {
      const source = pageSource(file)
      expect(source.length, `${file} has source`).toBeGreaterThan(0)
      expect(source, `${file} imports RunStatusBadge`).toMatch(/import \{[^}]*\bRunStatusBadge\b[^}]*\} from "@\/components\/run-status-badge"/)
      expect(source, `${file} switches over status words`).not.toMatch(/^\s*case "(passed|timeout)":/m)
      expect(source, `${file} copies the palette's success class`).not.toContain("bg-emerald-500/15")
      expect(source, `${file} copies the palette's running class`).not.toContain("bg-blue-500/15")
    }
  })
})
