// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunsPage from "@/pages/runs"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))

const FINISHED = ["passed", "healed", "failed", "timeout", "cancelled"]

function runRow(id: string, name: string, status: string) {
  return {
    id,
    name,
    filePath: `tests/${id}.yaml`,
    status,
    duration: 1000,
    attributes: {},
    environment: null,
    metadata: null,
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: status === "running" || status === "pending" ? null : "2026-10-17T10:00:01.000Z",
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: `t_${id}`,
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-10-17T10:00:00.000Z",
    members: [],
  }
}

const STORE = [
  runRow("r_pass", "Passing probe", "passed"),
  runRow("r_fail", "Failing probe", "failed"),
  runRow("r_cancel", "Cancelled probe", "cancelled"),
  runRow("r_live", "Live probe", "running"),
  runRow("r_queued", "Queued probe", "pending"),
]

const runsRequests: URL[] = []

function json(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  })
}

function fakeServer(input: string) {
  const url = new URL(input, "http://dashboard.test")
  if (url.pathname === "/api/runs") {
    runsRequests.push(url)
    const statuses = url.searchParams.getAll("status")
    const runs = statuses.length === 0 ? STORE : STORE.filter((run) => statuses.includes(run.status))
    return json({ runs, total: runs.length, targets: [] })
  }
  if (url.pathname === "/api/queue/status") {
    return json({ concurrency: 1, activeSlots: 0, pending: { count: 0 }, running: { count: 0 } })
  }
  if (url.pathname === "/api/execution/active") return json({ executions: [] })
  return json({})
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

async function renderRuns() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={["/runs"]}>
        <Routes>
          <Route path="/runs" element={<RunsPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await flush()
}

async function openTab(label: string) {
  const tab = Array.from(container?.querySelectorAll('[role="tab"]') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  expect(tab, `the ${label} tab`).toBeTruthy()
  runsRequests.length = 0
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  await flush()
  expect(runsRequests.length, `a /api/runs request after opening ${label}`).toBeGreaterThan(0)
  return runsRequests[runsRequests.length - 1]!
}

function renderedNames() {
  return STORE.map((run) => run.name).filter((name) => container?.textContent?.includes(name))
}

beforeEach(() => {
  runsRequests.length = 0
  vi.stubGlobal("fetch", vi.fn((input: string) => fakeServer(input)))
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

describe("C444-COMPLETED-TAB", () => {
  it("the Completed tab asks for the five finished words", async () => {
    await renderRuns()
    const request = await openTab("Completed")
    expect(request.searchParams.getAll("status")).toEqual(FINISHED)
    expect(request.search).toContain(
      "status=passed&status=healed&status=failed&status=timeout&status=cancelled",
    )
  })

  it("the Completed tab lists a passed, a failed and a cancelled run", async () => {
    await renderRuns()
    await openTab("Completed")
    expect(renderedNames()).toEqual(["Passing probe", "Failing probe", "Cancelled probe"])
  })

  it("the Failed tab asks for failed and timeout", async () => {
    await renderRuns()
    const request = await openTab("Failed")
    expect(request.searchParams.getAll("status")).toEqual(["failed", "timeout"])
    expect(renderedNames()).toEqual(["Failing probe"])
  })

  it("All, Running and Queued keep their requests", async () => {
    await renderRuns()
    const running = await openTab("Running")
    expect(running.searchParams.getAll("status")).toEqual(["running"])
    const queued = await openTab("Queued")
    expect(queued.searchParams.getAll("status")).toEqual(["pending"])
    const all = await openTab("All")
    expect(all.searchParams.getAll("status")).toEqual([])
    expect(renderedNames()).toEqual(STORE.map((run) => run.name))
  })
})
