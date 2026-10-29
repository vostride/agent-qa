// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import SuitesPage from "@/pages/suites"
import TestViewerPage from "@/pages/test-viewer"
import TestsPage from "@/pages/tests"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/components/monaco-editor", () => ({ MonacoEditor: () => <div /> }))
vi.mock("@/components/visual-builder", () => ({ VisualBuilder: () => <div /> }))
vi.mock("@/components/test-navbar", () => ({ TestNavbar: () => <div /> }))
vi.mock("@/components/pass-rate-chart", () => ({ PassRateChart: () => <div /> }))
vi.mock("@/components/duration-chart", () => ({ DurationChart: () => <div /> }))

interface Member {
  testId: string | null
  filePath: string | null
  suiteId: string | null
  name: string
  outcome: string | null
}

function run(
  id: string,
  status: string,
  createdAt: string,
  members: Member[],
  row: { filePath?: string | null; testId?: string | null; suiteId?: string | null; name?: string } = {},
) {
  return {
    id,
    name: row.name ?? members.map((member) => member.name).join(" · "),
    filePath: row.filePath ?? null,
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: createdAt,
    endedAt: status === "running" ? null : createdAt,
    failureSummary: null,
    errorLog: null,
    testId: row.testId ?? null,
    suiteId: row.suiteId ?? null,
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

function testFile(name: string, path: string, testId: string) {
  return { path, name, testId, targetName: null, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

function suiteFile(name: string, path: string, suiteId: string) {
  return { path, name, suiteId, testCount: 2, platform: "web", modified: "2026-10-17T09:00:00.000Z" }
}

const LOGIN = { name: "Sign in", path: "tests/sign-in.yaml", testId: "t_sign_in" }
const CART = { name: "Basket", path: "tests/basket.yaml", testId: "t_basket" }
const SEARCH = { name: "Lookup", path: "tests/lookup.yaml", testId: "t_lookup" }

function member(test: typeof LOGIN, outcome: string | null, suiteId: string | null = null): Member {
  return { testId: test.testId, filePath: test.path, suiteId, name: test.name, outcome }
}

let served: { tests: unknown[]; suites: unknown[]; runs: unknown[]; testSummaries: unknown[]; suiteSummaries: unknown[] } = {
  tests: [],
  suites: [],
  runs: [],
  testSummaries: [],
  suiteSummaries: [],
}

type Run = ReturnType<typeof run>

// The batch read's row for a test, with the figures the server gives for its seeded runs.
function testSummary(test: typeof LOGIN, passRate: number | null, passed: number, decided: number, last: Run | null, outcome: string | null) {
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

const VIEWED = {
  path: "tests/checkout.yaml",
  testId: "t_checkout",
  content: "name: Checkout flow\ntest-id: t_checkout\nsteps:\n  - open the cart\n",
}
let analyticsRuns: unknown[] = []
const analyticsRequests: URL[] = []

function analyticsDetail() {
  return {
    name: "Checkout flow",
    runs: analyticsRuns,
    total: analyticsRuns.length,
    trends: { passRate: 0.5, avgDuration: 1000, totalRuns: analyticsRuns.length, daily: [] },
    isFlaky: false,
    flakyScore: 0,
    scope: { configured: false, predicates: [], scopedCount: 0, totalCount: analyticsRuns.length },
  }
}

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(body) })
}

function fakeServer(input: string) {
  const url = new URL(input, "http://dashboard.test")
  if (url.pathname === "/api/tests") return json({ files: served.tests, targets: [] })
  if (url.pathname === "/api/suites") return json({ files: served.suites })
  if (url.pathname === "/api/runs") return json({ runs: served.runs, total: served.runs.length, targets: [] })
  if (url.pathname === "/api/analytics/test-summaries") return json({ tests: served.testSummaries })
  if (url.pathname === "/api/analytics/suite-summaries") return json({ suites: served.suiteSummaries })
  if (url.pathname === `/api/tests/${VIEWED.testId}`) return json(VIEWED)
  if (url.pathname.startsWith("/api/analytics/tests/")) {
    analyticsRequests.push(url)
    return json(analyticsDetail())
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
        </Routes>
      </MemoryRouter>,
    )
  })
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

function historyOf(name: string) {
  const row = Array.from(container?.querySelectorAll("tbody tr") ?? []).find((candidate) =>
    candidate.textContent?.includes(name),
  )
  expect(row, `a row for ${name}`).toBeTruthy()
  const cells = Array.from(row!.querySelectorAll("td")).map((cell) => cell.textContent ?? "")
  const passRate = cells.find((text) => /%|0 completed/.test(text)) ?? ""
  const lastRun = row!.querySelector('a[href^="/runs/"]')
  return {
    passRate,
    lastRunHref: lastRun?.getAttribute("href") ?? null,
    lastStatus: lastRun?.textContent ?? null,
  }
}

beforeEach(() => {
  served = { tests: [], suites: [], runs: [], testSummaries: [], suiteSummaries: [] }
  analyticsRuns = []
  analyticsRequests.length = 0
  vi.stubGlobal("fetch", vi.fn((input: string) => fakeServer(input)))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

describe("each member's history on the Tests page", () => {
  it("a three-test run updates all three tests on the Tests page", async () => {
    served.tests = [LOGIN, CART, SEARCH].map((test) => testFile(test.name, test.path, test.testId))
    const three = run("r_three", "failed", "2026-10-17T10:00:00.000Z", [
      member(LOGIN, "passed"),
      member(CART, "failed"),
      member(SEARCH, "passed"),
    ])
    served.runs = [three]
    served.testSummaries = [
      testSummary(LOGIN, 1, 1, 1, three, "passed"),
      testSummary(CART, 0, 0, 1, three, "failed"),
      testSummary(SEARCH, 1, 1, 1, three, "passed"),
    ]
    await renderPage("/tests")

    for (const [test, label, rate] of [
      [LOGIN, "Passed", "100%1/1"],
      [CART, "Failed", "0%0/1"],
      [SEARCH, "Passed", "100%1/1"],
    ] as const) {
      expect(historyOf(test.name)).toEqual({ passRate: rate, lastRunHref: "/runs/r_three", lastStatus: expect.stringContaining(label) })
    }
  })

  it("a healed member counts as a pass and a timed-out one as a fail", async () => {
    served.tests = [LOGIN, CART].map((test) => testFile(test.name, test.path, test.testId))
    const loginTimeout = run("r_timeout", "timeout", "2026-10-17T11:00:00.000Z", [member(LOGIN, "timeout")], { filePath: LOGIN.path, testId: LOGIN.testId })
    const cartTimeout = run("r_cart_timeout", "timeout", "2026-10-17T10:30:00.000Z", [member(CART, "timeout")], { filePath: CART.path, testId: CART.testId })
    served.runs = [
      loginTimeout,
      run("r_healed", "healed", "2026-10-17T10:00:00.000Z", [member(LOGIN, "healed")], { filePath: LOGIN.path, testId: LOGIN.testId }),
      cartTimeout,
    ]
    served.testSummaries = [
      testSummary(LOGIN, 0.5, 1, 2, loginTimeout, "timeout"),
      testSummary(CART, 0, 0, 1, cartTimeout, "timeout"),
    ]
    await renderPage("/tests")

    expect(historyOf(LOGIN.name).passRate).toBe("50%1/2")
    expect(historyOf(LOGIN.name).lastRunHref).toBe("/runs/r_timeout")
    expect(historyOf(CART.name).passRate).toBe("0%0/1")
  })

  it("a running run's member with no outcome shows running", async () => {
    served.tests = [LOGIN, CART].map((test) => testFile(test.name, test.path, test.testId))
    const live = run("r_live", "running", "2026-10-17T12:00:00.000Z", [member(LOGIN, "passed"), member(CART, null)])
    served.runs = [live]
    served.testSummaries = [
      testSummary(LOGIN, 1, 1, 1, live, "passed"),
      testSummary(CART, null, 0, 0, live, null),
    ]
    await renderPage("/tests")

    expect(historyOf(LOGIN.name)).toEqual({ passRate: "100%1/1", lastRunHref: "/runs/r_live", lastStatus: expect.stringContaining("Passed") })
    expect(historyOf(CART.name)).toEqual({ passRate: "\u20140 completed", lastRunHref: "/runs/r_live", lastStatus: expect.stringContaining("Running") })
  })
})

describe("each suite's history", () => {
  it("a run spanning two suites counts once in each suite's history", async () => {
    served.suites = [
      suiteFile("Checkout suite", "suites/checkout.yaml", "s_checkout"),
      suiteFile("Account suite", "suites/account.yaml", "s_account"),
      suiteFile("Idle suite", "suites/idle.yaml", "s_idle"),
    ]
    const later = run("r_later", "timeout", "2026-10-17T11:00:00.000Z", [member(SEARCH, "timeout", "s_account")], {
      suiteId: "s_account",
      name: "Account suite",
    })
    const span = run("r_span", "healed", "2026-10-17T10:00:00.000Z", [
      member(LOGIN, "passed", "s_checkout"),
      member(CART, "healed", "s_checkout"),
      member(SEARCH, "passed", "s_account"),
    ], { name: "Checkout suite · Account suite" })
    served.runs = [later, span]
    served.suiteSummaries = [
      suiteSummary("suites/checkout.yaml", "s_checkout", 1, 1, 1, span, "web", null),
      suiteSummary("suites/account.yaml", "s_account", 0.5, 1, 2, later, "web", null),
      suiteSummary("suites/idle.yaml", "s_idle", null, 0, 0, null, null, null),
    ]
    await renderPage("/suites")

    expect(historyOf("Checkout suite")).toEqual({ passRate: "100%1/1", lastRunHref: "/runs/r_span", lastStatus: expect.stringContaining("Healed") })
    expect(historyOf("Account suite")).toEqual({ passRate: "50%1/2", lastRunHref: "/runs/r_later", lastStatus: expect.stringContaining("Timed out") })
    expect(historyOf("Idle suite").lastRunHref).toBeNull()
  })
})

describe("the test viewer's history request", () => {
  it("the test viewer asks for its test by id and path", async () => {
    await renderPage(`/test/${VIEWED.testId}`)

    expect(analyticsRequests.length, "an analytics request").toBeGreaterThan(0)
    const request = analyticsRequests[analyticsRequests.length - 1]!
    expect(decodeURIComponent(request.pathname)).toBe("/api/analytics/tests/Checkout flow")
    expect(request.searchParams.get("testId")).toBe(VIEWED.testId)
    expect(request.searchParams.get("filePath")).toBe(VIEWED.path)
  })

  it("the test viewer's run list shows each run's member outcome", async () => {
    analyticsRuns = [
      { ...run("r_multi", "passed", "2026-10-17T12:00:00.000Z", [member(SEARCH, "passed"), { testId: VIEWED.testId, filePath: VIEWED.path, suiteId: null, name: "Checkout flow", outcome: "failed" }]), memberOutcome: "failed" },
      { ...run("r_solo", "passed", "2026-10-17T11:00:00.000Z", [{ testId: VIEWED.testId, filePath: VIEWED.path, suiteId: null, name: "Checkout flow", outcome: "passed" }]), memberOutcome: "passed" },
    ]
    await renderPage(`/test/${VIEWED.testId}`)

    const rowOf = (runId: string) => container?.querySelector(`a[href="/runs/${runId}"]`)?.closest("tr")?.textContent ?? null
    expect(rowOf("r_multi"), "the multi-test run's row").toContain("Failed")
    expect(rowOf("r_multi")).not.toContain("Passed")
    expect(rowOf("r_solo"), "the single-test run's row").toContain("Passed")
  })
})
