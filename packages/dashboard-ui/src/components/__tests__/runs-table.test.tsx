// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunsTable, type SuiteRunRow, type VisibleRunRow } from "@/components/runs-table"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LONG_RUN_NAME = "Open homepage with a deliberately long run name that should wrap inside a compact cell instead of truncating into a single overflowing line"

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  ScrollBar: () => null,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => <button type="button" className={className}>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => <div data-value={value}>{children}</div>,
}))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: (event: React.MouseEvent) => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    variant,
    size,
    ...props
  }: {
    children: React.ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    className?: string
    variant?: string
    size?: string
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type="button"
      onClick={onClick}
      className={className}
      data-variant={variant}
      data-size={size}
      {...props}
    >
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked?: boolean | string }) => <input type="checkbox" checked={Boolean(checked)} readOnly />,
}))
vi.mock("@/components/elapsed-timer", () => ({
  ElapsedTimer: ({ startedAt }: { startedAt: string }) => <span>{startedAt}</span>,
}))

const runs: SuiteRunRow[] = [
  {
    id: "suite_run_1",
    name: "Nightly smoke suite",
    filePath: "tests/smoke.suite.yaml",
    status: "failed",
    duration: 22000,
    attributes: {
      "agent-qa.trigger": "cli",
      "agent-qa.runner": "browserstack",
      "git.branch": "phase223-main",
      "user.email": "CI",
    },
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:22.000Z",
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: null,
    suiteId: "s_smoke",
    platform: "android",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-18T00:00:00.000Z",
    targetName: "hn-staging",
    tests: [
      {
        id: "child_run_1",
        name: "Login works",
        filePath: "tests/login.yaml",
        status: "passed",
        duration: 4300,
        attributes: {
          "agent-qa.trigger": "cli",
          "agent-qa.runner": "browserstack",
          "git.branch": "phase223-main",
        },
        environment: null,
        metadata: null,
        startedAt: "2026-04-18T00:00:00.000Z",
        endedAt: "2026-04-18T00:00:04.300Z",
        videoPath: null,
        failureSummary: null,
        errorLog: null,
        memoryLog: null,
        testId: "t_login",
        suiteId: "s_smoke",
        platform: "android",
        testFileContent: null,
        modelName: null,
        llmProvider: null,
        parentRunId: "suite_run_1",
        attemptNumber: 1,
        retryCount: 0,
        maxRetries: 0,
        createdAt: "2026-04-18T00:00:00.000Z",
        targetName: "hn-staging",
      },
    ],
  },
  {
    id: "run_2",
    name: LONG_RUN_NAME,
    filePath: "tests/open-home.yaml",
    status: "passed",
    duration: 1800,
    attributes: {
      "agent-qa.trigger": "dashboard",
      "agent-qa.runner": "local",
      "myCustomKey.xx": "custom-123",
    },
    environment: null,
    metadata: null,
    startedAt: "2026-04-17T00:00:00.000Z",
    endedAt: "2026-04-17T00:00:01.800Z",
    videoPath: null,
    failureSummary: null,
    errorLog: null,
    memoryLog: null,
    testId: "t_home",
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
    parentRunId: null,
    attemptNumber: 1,
    retryCount: 0,
    maxRetries: 0,
    createdAt: "2026-04-17T00:00:00.000Z",
    targetName: null,
  },
]

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

interface RenderTableOptions {
  selectedRunId?: string | null
  expandedSuites?: Set<string>
  onOpenRun?: (...args: unknown[]) => void
  onVisibleRunsChange?: (rows: VisibleRunRow[]) => void
  tableRuns?: SuiteRunRow[]
  total?: number
}

function renderTableElement({
  selectedRunId = "suite_run_1",
  expandedSuites = new Set<string>(),
  onOpenRun = vi.fn(),
  onVisibleRunsChange,
  tableRuns = runs,
  total = tableRuns.length,
}: RenderTableOptions = {}) {
  return (
    <MemoryRouter>
      <RunsTable
        runs={tableRuns}
        total={total}
        isLoading={false}
        page={0}
        onPageChange={() => {}}
        onSearchChange={() => {}}
        searchValue=""
        selectedRunId={selectedRunId}
        onSelectedRunIdChange={() => {}}
        expandedSuites={expandedSuites}
        onToggleSuite={() => {}}
        onOpenRun={onOpenRun}
        onVisibleRunsChange={onVisibleRunsChange}
        platformFilter=""
        onPlatformChange={() => {}}
        targetFilter=""
        targetOptions={["hn-staging", "android-staging"]}
        onTargetChange={() => {}}
        attributePredicates={[{ key: "git.branch", value: "phase223-main", mode: "exact" }]}
        onAttributePredicatesChange={() => {}}
        selectedRunIds={new Set(["suite_run_1"])}
        onToggleRunSelection={() => {}}
        onToggleVisibleSelection={() => {}}
      />
    </MemoryRouter>
  )
}

async function renderTable(options: RenderTableOptions = {}) {
  const onOpenRun = options.onOpenRun ?? vi.fn()
  const renderOptions = { ...options, onOpenRun }
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(renderTableElement(renderOptions))
  })

  await flushRender()

  const rerender = async (nextOptions: RenderTableOptions = {}) => {
    await act(async () => {
      root!.render(renderTableElement({ ...renderOptions, ...nextOptions }))
    })
    await flushRender()
  }

  return { view: container, onOpenRun, rerender }
}

function getHeaderButton(view: HTMLDivElement, label: string) {
  return Array.from(view.querySelectorAll("thead button")).find((element) =>
    element.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  ) as HTMLButtonElement | undefined
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  vi.clearAllMocks()
})

describe("RunsTable", () => {
  it("adds the attributes column and removes source and destination filters", async () => {
    const { view } = await renderTable()

    expect(view.textContent).toContain("Status")
    expect(view.textContent).toContain("Test Name")
    expect(view.textContent).toContain("Target")
    expect(view.textContent).toContain("Attributes")
    expect(view.textContent).toContain("git.branch=phase223-main")
    expect(view.textContent).toContain("+3 more")
    expect(view.textContent).toContain("Duration")
    expect(view.textContent).toContain("Started")
    expect(view.textContent).not.toContain("Source")
    expect(view.textContent).not.toContain("Destination")
    expect(view.textContent).toContain("Attributes (1)")
    expect(view.textContent).toContain("All targets")
  })

  it("uses a compact sort-header contract for narrow Duration and Started columns", async () => {
    const { view } = await renderTable()
    const columns = Array.from(view.querySelectorAll("col"))
    const durationButton = getHeaderButton(view, "Duration")
    const startedButton = getHeaderButton(view, "Started")

    expect(columns[4]?.getAttribute("style")).toContain("width: 104px")
    expect(columns[4]?.getAttribute("style")).toContain("min-width: 104px")
    expect(columns[5]?.getAttribute("style")).toContain("width: 128px")
    expect(columns[5]?.getAttribute("style")).toContain("min-width: 128px")

    expect(durationButton?.dataset.runsSortButton).toBe("compact")
    expect(durationButton?.dataset.size).toBe("xs")
    expect(durationButton?.className).toContain("max-w-full")
    expect(durationButton?.className).toContain("justify-end")

    expect(startedButton?.dataset.runsSortButton).toBe("compact")
    expect(startedButton?.dataset.size).toBe("xs")
    expect(startedButton?.className).toContain("max-w-full")
    expect(startedButton?.className).toContain("justify-end")
  })

  it("removes the row-level actions affordance so rows stay navigation-first", async () => {
    const { view } = await renderTable()

    expect(view.textContent).not.toContain("Actions")
  })

  it("renders target as targetName plus platform and falls back to No target", async () => {
    const { view } = await renderTable()

    expect(view.textContent).toContain("hn-staging (Android)")
    expect(view.textContent).toContain("No target (Web)")
  })

  it("shows expanded child rows on the same visible contract as parent rows", async () => {
    const { view } = await renderTable({
      selectedRunId: "child_run_1",
      expandedSuites: new Set(["suite_run_1"]),
    })

    expect(view.textContent).toContain("Login works")
    expect(view.textContent).toContain("hn-staging (Android)")
    expect(view.textContent).not.toContain("Source")
    expect(view.querySelector('[data-runs-row-surface="child_run_1"]')?.getAttribute("data-active")).toBe("true")
  })

  it("does not republish unchanged visible rows across parent rerenders", async () => {
    const onVisibleRunsChange = vi.fn()
    const { rerender } = await renderTable({
      selectedRunId: null,
      onVisibleRunsChange,
    })

    expect(onVisibleRunsChange).toHaveBeenCalledTimes(1)
    expect(onVisibleRunsChange.mock.calls[0]?.[0]).toHaveLength(2)

    await rerender()

    expect(onVisibleRunsChange).toHaveBeenCalledTimes(1)

    await rerender({
      tableRuns: [
        runs[0]!,
        {
          ...runs[1]!,
          status: "failed",
        },
      ],
    })

    expect(onVisibleRunsChange).toHaveBeenCalledTimes(2)
  })

  it("uses a single active row surface instead of segmented cell chrome", async () => {
    const { view } = await renderTable()
    const activeSurfaces = Array.from(
      view.querySelectorAll('[data-runs-row-surface][data-active="true"]'),
    )

    expect(activeSurfaces).toHaveLength(1)
    expect(activeSurfaces[0]?.getAttribute("data-runs-row-surface")).toBe("suite_run_1")
    expect(activeSurfaces[0]?.className).toContain("ring-primary/60")
    expect(activeSurfaces[0]?.className).toContain("bg-primary/10")
  })

  it("uses a compact wrap-friendly name contract instead of roomy single-line truncation", async () => {
    const { view } = await renderTable()
    const nameElement = Array.from(view.querySelectorAll("span")).find((element) =>
      element.textContent === LONG_RUN_NAME,
    ) as HTMLSpanElement | undefined

    expect(nameElement?.className).toContain("whitespace-normal")
    expect(nameElement?.className).toContain("break-words")
    expect(nameElement?.className).not.toContain("truncate")
    expect(nameElement?.className).not.toContain("text-[15px]")
  })

  it("opens runs from row click and does not render a duration tooltip", async () => {
    const { view, onOpenRun } = await renderTable()
    const runSurface = view.querySelector(
      '[data-runs-row-surface="run_2"]',
    ) as HTMLDivElement | null

    await act(async () => {
      runSurface?.click()
    })
    await flushRender()

    expect(onOpenRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run_2" }),
      expect.anything(),
    )
    expect(view.textContent).not.toContain("1,800ms")
  })

  it("renders cancelled and timeout-normalized failed rows as terminal persisted runs", async () => {
    const cancelledRun: SuiteRunRow = {
      ...runs[1]!,
      id: "run_cancelled",
      name: "User cancelled local model run",
      status: "cancelled",
    }
    const timeoutFailedRun: SuiteRunRow = {
      ...runs[1]!,
      id: "run_timeout_failed",
      name: "Timed out local model run",
      status: "failed",
      failureSummary: "Timed out waiting for the local model",
    }
    const { view, onOpenRun } = await renderTable({
      selectedRunId: "run_cancelled",
      tableRuns: [cancelledRun, timeoutFailedRun],
    })

    expect(view.textContent).toContain("Cancelled")
    expect(view.textContent).toContain("Failed")
    expect(view.textContent).not.toContain("Timed Out")

    const failedBadge = Array.from(view.querySelectorAll('[data-slot="badge"]')).find(
      (element) => element.textContent === "Failed",
    ) as HTMLElement | undefined
    expect(failedBadge?.className).toContain("bg-destructive")
    expect(failedBadge?.className).toContain("text-white")
    expect(failedBadge?.className).not.toContain("bg-red-500/15")

    await act(async () => {
      ;(view.querySelector('[data-runs-row-surface="run_cancelled"]') as HTMLTableRowElement | null)?.click()
    })
    await flushRender()

    expect(onOpenRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run_cancelled", status: "cancelled" }),
      expect.anything(),
    )
  })
})
