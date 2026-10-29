// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RunsTable, type SuiteRunRow, type VisibleRunRow } from "@/components/runs-table"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LONG_RUN_NAME = "Open homepage with a deliberately long run name that should wrap inside a compact cell instead of truncating into a single overflowing line"

// A cell can switch to the real Radix tooltip, whose trigger slot overrides `data-slot`.
const tooltipMode = vi.hoisted(() => ({ real: false }))

vi.mock("@/components/ui/tooltip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/tooltip")>()
  return {
    TooltipProvider: (props: React.ComponentProps<typeof actual.TooltipProvider>) =>
      tooltipMode.real ? <actual.TooltipProvider {...props} /> : <>{props.children}</>,
    Tooltip: (props: React.ComponentProps<typeof actual.Tooltip>) =>
      tooltipMode.real ? <actual.Tooltip {...props} /> : <>{props.children}</>,
    TooltipTrigger: (props: React.ComponentProps<typeof actual.TooltipTrigger>) =>
      tooltipMode.real ? <actual.TooltipTrigger {...props} /> : <>{props.children}</>,
    TooltipContent: (props: React.ComponentProps<typeof actual.TooltipContent>) =>
      tooltipMode.real ? <actual.TooltipContent {...props} /> : <div data-tooltip-content="">{props.children}</div>,
  }
})
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
      "agent-qa.runner": "local",
      "git.branch": "phase223-main",
      "user.email": "CI",
    },
    environment: null,
    metadata: null,
    startedAt: "2026-04-18T00:00:00.000Z",
    endedAt: "2026-04-18T00:00:22.000Z",
    failureSummary: null,
    errorLog: null,
    testId: null,
    suiteId: "s_smoke",
    platform: "android",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
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
          "agent-qa.runner": "local",
          "git.branch": "phase223-main",
        },
        environment: null,
        metadata: null,
        startedAt: "2026-04-18T00:00:00.000Z",
        endedAt: "2026-04-18T00:00:04.300Z",
        failureSummary: null,
        errorLog: null,
        testId: "t_login",
        suiteId: "s_smoke",
        platform: "android",
        testFileContent: null,
        modelName: null,
        llmProvider: null,
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
    failureSummary: null,
    errorLog: null,
    testId: "t_home",
    suiteId: null,
    platform: "web",
    testFileContent: null,
    modelName: null,
    llmProvider: null,
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
  tooltipMode.real = false
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
    const badgeTexts = Array.from(view.querySelectorAll('[data-slot="badge"]')).map((element) => element.textContent)
    expect(badgeTexts).toContain("Failed")
    expect(badgeTexts).not.toContain("Timed out")

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

// A verify run's row carries the gate-run mark beside the name, with no filter for it.
describe("the Verify run mark on a gate run", () => {
  const GATE_RUN_KEY = "agent-qa.gate-run"

  function singleRun(id: string, name: string, attributes: Record<string, string>): SuiteRunRow {
    return { ...runs[1]!, id, name, attributes }
  }

  function nameCellOf(view: HTMLDivElement, name: string): HTMLTableCellElement | null {
    const span = Array.from(view.querySelectorAll("span")).find((element) => element.textContent === name)
    return span?.closest("td") ?? null
  }

  function toolbarControls(view: HTMLDivElement): string[] {
    const search = view.querySelector('input[placeholder="Search runs..."]')
    const toolbar = search?.parentElement
    if (!toolbar) return []
    return Array.from(toolbar.querySelectorAll("input, button, select")).map((element) =>
      `${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? element.textContent?.trim() ?? ""}`,
    )
  }

  it("the Runs list shows Verify run beside a marked run's name", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [singleRun("run_gate", "Draft verify run", { "agent-qa.trigger": "cli", [GATE_RUN_KEY]: "true" })],
    })
    const cell = nameCellOf(view, "Draft verify run")
    expect(cell, "the marked run's name cell").not.toBeNull()
    expect(cell?.textContent ?? "", "the marked run's name cell text").toContain("Verify run")
    const badge = Array.from(cell?.querySelectorAll('[data-slot="badge"]') ?? []).find(
      (element) => element.textContent === "Verify run",
    )
    expect(badge?.getAttribute("data-variant"), "the Verify run badge variant").toBe("secondary")
  })

  it("no badge on an unmarked run", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [
        singleRun("run_plain", "Started by someone", { "agent-qa.trigger": "cli" }),
        singleRun("run_false", "Marked false", { "agent-qa.trigger": "cli", [GATE_RUN_KEY]: "false" }),
        singleRun("run_none", "No attributes at all", {}),
      ],
    })
    for (const name of ["Started by someone", "Marked false", "No attributes at all"]) {
      expect(nameCellOf(view, name), `name cell of ${name}`).not.toBeNull()
    }
    expect(view.textContent ?? "", "the list text").not.toContain("Verify run")
  })

  it("no filter is added", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [singleRun("run_gate", "Draft verify run", { [GATE_RUN_KEY]: "true" })],
    })
    expect(toolbarControls(view).join(" | ")).toBe(
      "input:Search runs... | button:All platforms | button:All targets | button:Filter by attributes",
    )
  })
})

// The badge alone displays the mark, explained and first-line aligned.
describe("the Verify run badge", () => {
  const GATE_RUN_KEY = "agent-qa.gate-run"
  const EXPLANATION = "Started by authoring verify. Not used for learning."

  function singleRun(id: string, name: string, attributes: Record<string, string>): SuiteRunRow {
    return { ...runs[1]!, id, name, attributes }
  }

  function nameCellOf(view: HTMLDivElement, name: string): HTMLTableCellElement | null {
    const span = Array.from(view.querySelectorAll("span")).find((element) => element.textContent === name)
    return span?.closest("td") ?? null
  }

  function verifyBadgeIn(cell: HTMLTableCellElement | null): Element | undefined {
    return Array.from(cell?.querySelectorAll('[data-slot="badge"]') ?? []).find(
      (element) => element.textContent === "Verify run",
    )
  }

  it("the Verify run badge explains itself and takes keyboard focus", async () => {
    const { view } = await renderTable({
      selectedRunId: "run_gate",
      tableRuns: [singleRun("run_gate", "Draft verify run", { "agent-qa.trigger": "cli", [GATE_RUN_KEY]: "true" })],
    })
    const cell = nameCellOf(view, "Draft verify run")
    const badge = verifyBadgeIn(cell)
    expect(badge, "the Verify run badge").toBeDefined()
    expect(badge?.getAttribute("tabindex"), "the badge's tabindex").toBe("0")
    expect(cell?.textContent ?? "", "the marked run's name cell text").toContain(EXPLANATION)
  })

  it("the attributes cell does not list the gate-run mark again", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [
        singleRun("run_gate", "Draft verify run", {
          "agent-qa.trigger": "cli",
          "agent-qa.runner": "local",
          [GATE_RUN_KEY]: "true",
        }),
      ],
    })
    const row = nameCellOf(view, "Draft verify run")?.closest("tr")
    const attributesCell = Array.from(row?.querySelectorAll("td") ?? []).find((element) =>
      (element.textContent ?? "").includes("agent-qa.trigger"),
    )
    expect(attributesCell, "the attributes cell").toBeDefined()
    const text = attributesCell?.textContent ?? ""
    expect(text, "the attributes cell text").not.toContain(GATE_RUN_KEY)
    expect(text, "the attributes cell's hidden count").not.toMatch(/\+\d+ more/)
    const labels = Array.from(attributesCell?.querySelectorAll("[aria-label]") ?? []).map(
      (element) => element.getAttribute("aria-label") ?? "",
    )
    expect(labels.length, "aria-labels in the attributes cell").toBeGreaterThan(0)
    for (const label of labels) {
      expect(label, "an aria-label in the attributes cell").toContain("agent-qa.trigger")
      expect(label, "an aria-label in the attributes cell").not.toContain(GATE_RUN_KEY)
    }
  })

  it("the badge lines up with the first line of a wrapped name", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [singleRun("run_gate", LONG_RUN_NAME, { "agent-qa.trigger": "cli", [GATE_RUN_KEY]: "true" })],
    })
    const badge = verifyBadgeIn(nameCellOf(view, LONG_RUN_NAME))
    expect(badge, "the Verify run badge").toBeDefined()
    const wrapperClasses = Array.from(badge?.parentElement?.classList ?? [])
    expect(wrapperClasses, "the name cell wrapper's classes").toContain("items-start")
    expect(wrapperClasses, "the name cell wrapper's classes").not.toContain("items-center")
    expect(Array.from(badge?.classList ?? []), "the badge's classes").toContain("mt-0.5")
  })
})

// In-row controls take the row's roving tab stop and never open the run; long cells truncate.
describe("the runs table's badge, tab stops and truncated cells", () => {
  const GATE_RUN_KEY = "agent-qa.gate-run"
  const LONG_TARGET = "checkout-service-staging-eu-west-with-a-very-long-registry-name"

  const suiteRun: SuiteRunRow = { ...runs[0]!, tests: [] }
  const gateRun: SuiteRunRow = {
    ...runs[1]!,
    id: "run_gate",
    name: "Draft verify run",
    attributes: { "agent-qa.trigger": "cli", [GATE_RUN_KEY]: "true" },
  }

  function rowOf(view: HTMLDivElement, id: string): HTMLTableRowElement {
    const row = view.querySelector(`[data-runs-row-surface="${id}"]`) as HTMLTableRowElement | null
    expect(row, `the row of ${id}`).not.toBeNull()
    return row!
  }

  function verifyBadgeOf(view: HTMLDivElement): HTMLElement {
    const badge = Array.from(rowOf(view, "run_gate").querySelectorAll<HTMLElement>("*")).find(
      (element) => element.textContent === "Verify run" && element.children.length === 0,
    )
    expect(badge, "the Verify run badge").toBeDefined()
    return badge!
  }

  function chevronOf(view: HTMLDivElement): HTMLButtonElement {
    const chevron = rowOf(view, "suite_run_1").querySelector("td button") as HTMLButtonElement | null
    expect(chevron, "the suite expand chevron").not.toBeNull()
    return chevron!
  }

  function cellsOfColumn(view: HTMLDivElement, header: string): HTMLElement[] {
    const heads = Array.from(view.querySelectorAll("thead th"))
    const index = heads.findIndex((th) => (th.textContent ?? "").trim().startsWith(header))
    expect(index, `the ${header} header`).toBeGreaterThanOrEqual(0)
    const cells = Array.from(view.querySelectorAll("tbody tr")).map(
      (tr) => tr.querySelectorAll("td")[index] as HTMLElement,
    )
    return [heads[index] as HTMLElement, ...cells]
  }

  async function press(element: HTMLElement, key: string) {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    })
  }

  it("the badge and the chevron take the row's tab stop", async () => {
    const { view, rerender } = await renderTable({
      selectedRunId: "run_gate",
      tableRuns: [suiteRun, gateRun],
    })
    expect(verifyBadgeOf(view).getAttribute("tabindex"), "the badge on the active row").toBe("0")
    expect(chevronOf(view).getAttribute("tabindex"), "the chevron on an inactive row").toBe("-1")

    await rerender({ selectedRunId: "suite_run_1" })
    expect(verifyBadgeOf(view).getAttribute("tabindex"), "the badge on an inactive row").toBe("-1")
    expect(chevronOf(view).getAttribute("tabindex"), "the chevron on the active row").toBe("0")
  })

  it("Enter and Space on the badge or the chevron never open the run", async () => {
    const onOpenRun = vi.fn()
    const { view } = await renderTable({
      selectedRunId: "run_gate",
      tableRuns: [suiteRun, gateRun],
      onOpenRun,
    })
    for (const key of ["Enter", " "]) {
      await press(verifyBadgeOf(view), key)
      await press(chevronOf(view), key)
    }
    expect(onOpenRun, "the row's open callback after keys on the controls").not.toHaveBeenCalled()

    await press(rowOf(view, "run_gate"), "Enter")
    expect(onOpenRun, "Enter on the row itself still opens it").toHaveBeenCalledWith(
      expect.objectContaining({ id: "run_gate" }),
      expect.anything(),
    )
  })

  it("the badge keeps its own data-slot under its tooltip", async () => {
    tooltipMode.real = true
    const { view } = await renderTable({ selectedRunId: "run_gate", tableRuns: [gateRun] })
    const badge = verifyBadgeOf(view)
    expect(badge.getAttribute("data-state"), "the badge is the real tooltip's trigger").toBe("closed")
    expect(badge.getAttribute("data-slot"), "the badge's data-slot").toBe("badge")
    const slotted = Array.from(view.querySelectorAll('[data-slot="badge"]')).map((element) => element.textContent)
    expect(slotted, "the badges [data-slot=badge] finds").toContain("Verify run")
  })

  it("Target and Attributes truncate with the full value in a tooltip, and Attributes carries the hide-below-1200 container class", async () => {
    const { view } = await renderTable({
      selectedRunId: null,
      tableRuns: [{ ...runs[1]!, id: "run_target", targetName: LONG_TARGET }],
    })
    const row = rowOf(view, "run_target")
    const [, targetCell] = cellsOfColumn(view, "Target")
    expect(row.contains(targetCell!), "the target cell is the row's").toBe(true)
    const fullTarget = `${LONG_TARGET} (Web)`
    const shown = Array.from(targetCell!.querySelectorAll<HTMLElement>(".truncate")).map((element) => element.textContent)
    expect(shown, "the target cell's truncated text").toContain(fullTarget)
    const targetTip = targetCell!.querySelector("[data-tooltip-content]")
    expect(targetTip?.textContent, "the target cell's tooltip").toBe(fullTarget)

    const [attributesHead, attributesCell] = cellsOfColumn(view, "Attributes")
    const lines = Array.from(attributesCell!.querySelectorAll<HTMLElement>(".truncate.font-mono"))
    expect(lines.length, "the attributes cell's truncated lines").toBeGreaterThan(0)
    const attributesTip = attributesCell!.querySelector("[data-tooltip-content]")?.textContent ?? ""
    for (const [key, value] of Object.entries(runs[1]!.attributes ?? {})) {
      expect(attributesTip, "the attributes tooltip").toContain(key)
      expect(attributesTip, "the attributes tooltip").toContain(value)
    }

    for (const element of [attributesHead!, attributesCell!]) {
      expect(Array.from(element.classList), `${element.tagName} of Attributes`).toContain("@max-[1200px]/runs:hidden")
    }
    let wrapper: HTMLElement | null = view.querySelector("table")
    while (wrapper && !wrapper.classList.contains("@container/runs")) wrapper = wrapper.parentElement
    expect(wrapper, "the table's scroll wrapper is the runs container").not.toBeNull()
  })
})
