// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import RunsPage from "@/pages/runs"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  fetchRunsMock,
  fetchQueueStatusMock,
  fetchActiveExecutionsMock,
  triggerRunMock,
  purgeCacheMock,
  deleteRunMock,
  latestRunsTableProps,
  useRealKeyboardShortcuts,
  useRealRunsTable,
} = vi.hoisted(() => ({
  fetchRunsMock: vi.fn(),
  fetchQueueStatusMock: vi.fn(),
  fetchActiveExecutionsMock: vi.fn(),
  triggerRunMock: vi.fn(),
  purgeCacheMock: vi.fn(),
  deleteRunMock: vi.fn(),
  latestRunsTableProps: {
    current: null as { headerActions?: ReactNode } | null,
  },
  useRealKeyboardShortcuts: { current: false },
  useRealRunsTable: { current: false },
}))

vi.mock("@/lib/api", () => ({
  fetchRuns: fetchRunsMock,
  fetchQueueStatus: fetchQueueStatusMock,
  fetchActiveExecutions: fetchActiveExecutionsMock,
  triggerRun: triggerRunMock,
  purgeCache: purgeCacheMock,
  deleteRun: deleteRunMock,
}))

vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-run-config", () => ({
  useRunConfig: () => ({ defaultRunMode: "local", hasFarm: true, isLoading: false }),
}))
vi.mock("@/hooks/use-keyboard-shortcuts", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-keyboard-shortcuts")>(
    "@/hooks/use-keyboard-shortcuts",
  )

  return {
    useKeyboardShortcuts: (shortcuts: Record<string, (event: KeyboardEvent) => void>) => {
      if (useRealKeyboardShortcuts.current) {
        actual.useKeyboardShortcuts(shortcuts)
      }
    },
  }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/page-skeleton", () => ({ TableSkeleton: () => <div>Loading...</div> }))
vi.mock("@/components/empty-state", () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock("@/components/batch-action-bar", () => ({
  BatchActionBar: ({
    actionSlot,
    onDelete,
    onCancel,
    secondaryAriaLabel,
    secondaryIcon,
    secondaryLabel,
    selectedCount,
    summaryMeta,
  }: {
    actionSlot?: ReactNode
    onDelete?: () => void
    onCancel: () => void
    secondaryAriaLabel?: string
    secondaryIcon?: ReactNode
    secondaryLabel?: string
    selectedCount: number
    summaryMeta?: string
  }) => {
    if (selectedCount === 0) return null

    return (
      <div data-testid="batch-actions">
        <div>{selectedCount} selected</div>
        {summaryMeta ? <div>{summaryMeta}</div> : null}
        {actionSlot}
        {onDelete ? (
          <button type="button" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        <button
          type="button"
          aria-label={secondaryAriaLabel}
          onClick={onCancel}
        >
          {secondaryIcon ?? secondaryLabel ?? "Cancel"}
        </button>
      </div>
    )
  },
}))
vi.mock("@/components/test-run-options-popover", () => ({
  TestRunOptionsPopover: ({
    browserStackAvailable,
    disabled,
    hiddenCount,
    onOpenChange,
    onRunBrowserStack,
    onRunLocal,
    onUseCacheChange,
    onUseMemoryChange,
    open,
    selectedCount,
    useCache,
    useMemory,
  }: {
    browserStackAvailable: boolean
    disabled?: boolean
    hiddenCount: number
    onOpenChange: (open: boolean) => void
    onRunBrowserStack: () => void
    onRunLocal: () => void
    onUseCacheChange: (checked: boolean) => void
    onUseMemoryChange: (checked: boolean) => void
    open: boolean
    selectedCount: number
    useCache: boolean
    useMemory: boolean
  }) => (
    <div data-testid="run-options-popover">
      <button type="button" disabled={disabled} onClick={() => onOpenChange(!open)}>
        Run
      </button>
      {open ? (
        <div>
          <div>{selectedCount} selected</div>
          {hiddenCount > 0 ? <div>{hiddenCount} hidden by filters</div> : null}
          <label>
            <input
              type="checkbox"
              checked={useCache}
              onChange={(event) => onUseCacheChange(event.currentTarget.checked)}
            />
            <span>Use cache</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={useMemory}
              onChange={(event) => onUseMemoryChange(event.currentTarget.checked)}
            />
            <span>Use memory</span>
          </label>
          <button type="button" disabled={disabled} onClick={onRunLocal}>
            Run Local
          </button>
          <button
            type="button"
            disabled={disabled || !browserStackAvailable}
            onClick={onRunBrowserStack}
          >
            Run on BrowserStack
          </button>
        </div>
      ) : null}
    </div>
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}))
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    disabled,
    type = "button",
    ...props
  }: {
    children: ReactNode
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
    className?: string
    disabled?: boolean
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick} className={className} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  ScrollBar: () => null,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button type="button" className={className}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}))
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean | string
    onCheckedChange?: (value: boolean) => void
    "aria-label"?: string
  }) => (
    <input
      type="checkbox"
      checked={checked === true}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      readOnly={false}
      {...props}
    />
  ),
}))
vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    className,
  }: {
    value?: string
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
    className?: string
  }) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
    />
  ),
}))
vi.mock("@/components/elapsed-timer", () => ({
  ElapsedTimer: ({ startedAt }: { startedAt: string }) => <span>{startedAt}</span>,
}))
vi.mock("@/components/runs-table", async () => {
  const actual = await vi.importActual<typeof import("@/components/runs-table")>(
    "@/components/runs-table",
  )

  return {
    RunsTable: (props: any) => {
      latestRunsTableProps.current = { headerActions: props.headerActions }

      if (useRealRunsTable.current) {
        return <actual.RunsTable {...props} />
      }

      return (
        <div data-testid="runs-table" data-has-header-actions={String(Boolean(props.headerActions))}>
          <div
            data-testid="table-props"
            data-page={String(props.page)}
            data-search={props.searchValue}
            data-target={props.targetFilter ?? ""}
          />
          {props.headerActions ? (
            <div data-testid="runs-table-header-actions">{props.headerActions}</div>
          ) : null}
          <button type="button" onClick={() => props.onPageChange(2)}>Go page 3</button>
          <button type="button" onClick={() => props.onSearchChange("signup")}>Search signup</button>
          <button type="button" onClick={() => props.onTargetChange?.("android-staging")}>Target android-staging</button>
          <button
            type="button"
            onClick={() => props.onAttributePredicatesChange?.([{ key: "git.branch", value: "^(master|main)$", mode: "regex" }])}
          >
            Attribute regex
          </button>
        </div>
      )
    },
  }
})

function LocationProbe() {
  const location = useLocation()
  return (
    <div
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function flushRender() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderAt(url: string) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/runs"
            element={
              <>
                <LocationProbe />
                <RunsPage />
              </>
            }
          />
          <Route path="/runs/:runId" element={<LocationProbe />} />
          <Route path="/runs/:runId/live" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await flushRender()
  return container
}

async function clickByText(label: string) {
  const button = Array.from(container?.querySelectorAll("button") ?? []).find((candidate) =>
    candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  await act(async () => {
    button!.click()
  })
  await flushRender()
}

async function setSearch(value: string) {
  const input = container?.querySelector('input[placeholder="Search runs..."]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
  await act(async () => {
    descriptor?.set?.call(input, value)
    input!.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await flushRender()
}

beforeEach(() => {
  latestRunsTableProps.current = null
  useRealKeyboardShortcuts.current = false
  useRealRunsTable.current = false
  fetchRunsMock.mockReset()
  fetchQueueStatusMock.mockReset()
  fetchActiveExecutionsMock.mockReset()
  triggerRunMock.mockReset()
  purgeCacheMock.mockReset()
  deleteRunMock.mockReset()

  fetchRunsMock.mockImplementation(async (filters?: { name?: string; target?: string }) => {
    const baseRuns = [
      {
        id: "run_1",
        name: "Login test",
        filePath: "tests/web/login.yaml",
        status: "failed",
        duration: 1200,
        attributes: {
          "git.branch": "phase223-main",
          "agent-qa.trigger": "cli",
          "agent-qa.runner": "local",
        },
        environment: null,
        metadata: null,
        startedAt: "2026-04-18T00:00:00.000Z",
        endedAt: "2026-04-18T00:00:01.200Z",
        videoPath: null,
        failureSummary: null,
        errorLog: null,
        memoryLog: null,
        testId: "t_login",
        suiteId: null,
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
      },
    ]

    const runs = baseRuns.filter((run) => {
      if (filters?.name && !run.name.toLowerCase().includes(filters.name.toLowerCase())) {
        return false
      }
      if (filters?.target && run.targetName !== filters.target) {
        return false
      }
      return true
    })

    return {
      runs,
      total: runs.length,
      targets: ["hn-staging", "android-staging"],
    }
  })
  fetchQueueStatusMock.mockResolvedValue({
    concurrency: 2,
    activeSlots: 0,
    pending: { count: 0 },
    running: { count: 0 },
  })
  fetchActiveExecutionsMock.mockResolvedValue({ executions: [] })
  triggerRunMock.mockResolvedValue({ runId: "rerun_1", status: "queued" })
  purgeCacheMock.mockResolvedValue({ purged: 1 })
  deleteRunMock.mockResolvedValue({ deleted: true, deletedRunIds: ["run_1"] })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  useRealKeyboardShortcuts.current = false
  useRealRunsTable.current = false
  vi.clearAllMocks()
})

describe("RunsPage", () => {
  it("keeps the product tour runs anchor on the empty state", async () => {
    fetchRunsMock.mockResolvedValueOnce({
      runs: [],
      total: 0,
      targets: [],
    })

    const view = await renderAt("/runs")
    const emptyAnchor = view.querySelector('[data-tour-id="tour-runs-table"]')

    expect(emptyAnchor).not.toBeNull()
    expect(emptyAnchor?.textContent).toContain("No test runs yet")
    expect(view.querySelector('[data-testid="runs-table"]')).toBeNull()
  })

  it("places Keyboard shortcuts beside Runs and does not pass them through RunsTable headerActions", async () => {
    const view = await renderAt("/runs")

    const heading = Array.from(view.querySelectorAll("h1")).find((candidate) =>
      candidate.textContent?.trim() === "Runs",
    ) as HTMLHeadingElement | undefined
    const headingRow = heading?.parentElement
    const table = view.querySelector('[data-testid="runs-table"]')

    expect(headingRow?.className).toContain("justify-between")
    expect(headingRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeTruthy()
    expect(table?.getAttribute("data-has-header-actions")).toBe("false")
    expect(latestRunsTableProps.current?.headerActions).toBeUndefined()
    expect(view.querySelector('[data-testid="runs-table-header-actions"] button[aria-label="Keyboard shortcuts"]')).toBeNull()
  })

  it("uses the canonical URL contract and preserves attribute filters as search and target filters change", async () => {
    const view = await renderAt("/runs?tab=failed&search=login&platform=android&target=hn-staging&attributes[git.branch]=phase223-main&page=2")

    expect(fetchRunsMock).toHaveBeenCalledWith({
      limit: 50,
      offset: 50,
      name: "login",
      status: "failed",
      platform: "android",
      target: "hn-staging",
      attributes: [{ key: "git.branch", value: "phase223-main", mode: "exact" }],
    })
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=login&platform=android&target=hn-staging&attributes[git.branch]=phase223-main&page=2")
    expect(view.querySelector('[data-testid="table-props"]')?.getAttribute("data-page")).toBe("1")
    expect(view.querySelector('[data-testid="table-props"]')?.getAttribute("data-search")).toBe("login")

    fetchRunsMock.mockClear()

    await clickByText("Search signup")

    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup&platform=android&target=hn-staging&attributes%5Bgit.branch%5D=phase223-main")
    expect(fetchRunsMock).toHaveBeenLastCalledWith({
      limit: 50,
      offset: 0,
      name: "signup",
      status: "failed",
      platform: "android",
      target: "hn-staging",
      attributes: [{ key: "git.branch", value: "phase223-main", mode: "exact" }],
    })

    await clickByText("Target android-staging")

    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toBe("?tab=failed&search=signup&platform=android&target=android-staging&attributes%5Bgit.branch%5D=phase223-main")
    expect(fetchRunsMock).toHaveBeenLastCalledWith({
      limit: 50,
      offset: 0,
      name: "signup",
      status: "failed",
      platform: "android",
      target: "android-staging",
      attributes: [{ key: "git.branch", value: "phase223-main", mode: "exact" }],
    })

    await clickByText("Attribute regex")

    expect(fetchRunsMock).toHaveBeenLastCalledWith({
      limit: 50,
      offset: 0,
      name: "signup",
      status: "failed",
      platform: "android",
      target: "android-staging",
      attributes: [{ key: "git.branch", value: "^(master|main)$", mode: "regex" }],
    })
    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-search")).toContain("attributes%5Bgit.branch%5D%5Bregex%5D=%5E%28master%7Cmain%29%24")
  })

  it("preserves selected runs through search churn and shows hidden counts in the shared toolbar", async () => {
    useRealRunsTable.current = true
    await renderAt("/runs")

    const row = Array.from(container?.querySelectorAll("tr") ?? []).find((candidate) =>
      candidate.textContent?.includes("Login test"),
    ) as HTMLTableRowElement | undefined
    const checkbox = row?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox!.click()
    })
    await flushRender()

    await setSearch("no-match")

    expect(container?.textContent).toContain("1 selected")
    expect(container?.textContent).toContain("1 hidden by filters")

    await setSearch("")

    const rowAfterClear = Array.from(container?.querySelectorAll("tr") ?? []).find((candidate) =>
      candidate.textContent?.includes("Login test"),
    ) as HTMLTableRowElement | undefined
    const checkboxAfterClear = rowAfterClear?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(checkboxAfterClear?.checked).toBe(true)
  })

  it("routes run and purge-cache actions through the selection-only bottom toolbar", async () => {
    useRealRunsTable.current = true
    await renderAt("/runs")

    const row = Array.from(container?.querySelectorAll("tr") ?? []).find((candidate) =>
      candidate.textContent?.includes("Login test"),
    ) as HTMLTableRowElement | undefined
    const checkbox = row?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox!.click()
    })
    await flushRender()

    await clickByText("Run")
    await clickByText("Run Local")

    expect(triggerRunMock).toHaveBeenCalledWith({
      file: "tests/web/login.yaml",
      local: true,
      noCache: false,
      noMemory: false,
    })

    await clickByText("Purge cache")

    expect(purgeCacheMock).toHaveBeenCalledWith({ file: "tests/web/login.yaml" })
  })

  it("deletes selected runs from the shared bottom toolbar", async () => {
    useRealRunsTable.current = true
    await renderAt("/runs")

    const row = Array.from(container?.querySelectorAll("tr") ?? []).find((candidate) =>
      candidate.textContent?.includes("Login test"),
    ) as HTMLTableRowElement | undefined
    const checkbox = row?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox!.click()
    })
    await flushRender()

    await clickByText("Delete")

    expect(deleteRunMock).toHaveBeenCalledTimes(1)
    expect(deleteRunMock).toHaveBeenCalledWith("run_1")
    expect(Array.from(container?.querySelectorAll("tr") ?? []).find((candidate) =>
      candidate.textContent?.includes("Login test"),
    )).toBeUndefined()
    expect(container?.querySelector('[data-testid="batch-actions"]')).toBeNull()
  })

  it("opens a run from row click instead of requiring a row action menu", async () => {
    useRealRunsTable.current = true

    const view = await renderAt("/runs")
    const runSurface = view.querySelector(
      '[data-runs-row-surface="run_1"]',
    ) as HTMLDivElement | null

    await act(async () => {
      runSurface?.click()
    })
    await flushRender()

    expect(view.querySelector('[data-testid="location"]')?.getAttribute("data-pathname")).toBe("/runs/run_1")
  })

  it("matches synthetic active rows by hidden run id through the existing search box", async () => {
    useRealRunsTable.current = true
    fetchRunsMock.mockResolvedValue({
      runs: [],
      total: 0,
      targets: [],
    })
    fetchActiveExecutionsMock.mockResolvedValue({
      executions: [
        {
          runId: "r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet",
          testName: "Synthetic login run",
          duration: 1234,
          startedAt: "2026-04-18T00:00:00.000Z",
        },
      ],
    })

    await renderAt("/runs?tab=running&search=r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet")

    const searchInput = container?.querySelector('input[placeholder="Search runs..."]') as HTMLInputElement | null
    expect(searchInput?.value).toBe("r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet")
    expect(container?.textContent).toContain("Synthetic login run")
    expect(Array.from(container?.querySelectorAll("tr") ?? [])).toHaveLength(2)
  })
})
