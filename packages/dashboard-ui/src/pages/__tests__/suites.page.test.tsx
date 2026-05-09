// @vitest-environment jsdom

import { Children, act, cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import SuitesPage from "@/pages/suites"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const {
  LONG_SUITE_NAME,
  fetchSuiteFilesMock,
  fetchRunsMock,
  deleteSuiteFileMock,
  triggerRunMock,
  latestBatchActionBarProps,
} = vi.hoisted(() => ({
  LONG_SUITE_NAME:
    "This suite name is intentionally long enough to prove the suites list keeps the primary column wrap-friendly instead of widening the whole page",
  fetchSuiteFilesMock: vi.fn(),
  fetchRunsMock: vi.fn(),
  deleteSuiteFileMock: vi.fn(),
  triggerRunMock: vi.fn(),
  latestBatchActionBarProps: {
    current: null as { onDelete?: () => void | Promise<void>; selectedCount: number } | null,
  },
}))

vi.mock("@tanstack/react-table", () => {
  const flexRender = (renderer: unknown, context: unknown) =>
    typeof renderer === "function" ? (renderer as (ctx: unknown) => ReactNode)(context) : renderer

  return {
    flexRender,
    getCoreRowModel: () => () => ({}),
    getSortedRowModel: () => () => ({}),
    getFilteredRowModel: () => () => ({}),
    getPaginationRowModel: () => () => ({}),
    useReactTable: (options: any) => {
      const data = options.data as Array<Record<string, unknown>>
      const columns = options.columns as Array<Record<string, unknown>>
      const rowSelection = (options.state?.rowSelection ?? {}) as Record<string, boolean>
      let table: any

      const rows = data.map((item) => {
        const rowId = options.getRowId ? options.getRowId(item) : String(item.path ?? item.name)
        const row = {
          id: rowId,
          original: item,
          getValue: (key: string) => item[key],
          getIsSelected: () => Boolean(rowSelection[rowId]),
          toggleSelected: (selected: boolean) => {
            const next = { ...(options.state?.rowSelection ?? {}) }
            if (selected) next[rowId] = true
            else delete next[rowId]
            options.onRowSelectionChange?.(next)
          },
          getVisibleCells: () => columns.map((column, index) => ({
            id: `${rowId}_${String(column.id ?? column.accessorKey ?? index)}`,
            column: {
              id: String(column.id ?? column.accessorKey ?? index),
              columnDef: column,
            },
            row,
            getContext: () => ({
              row,
              table,
              column: {
                id: String(column.id ?? column.accessorKey ?? index),
                columnDef: column,
              },
            }),
          })),
        }
        return row
      })

      table = {
        getHeaderGroups: () => [
          {
            id: "header",
            headers: columns.map((column, index) => ({
              id: String(index),
              isPlaceholder: false,
              column: {
                id: String(column.id ?? column.accessorKey ?? index),
                columnDef: column,
              },
              getContext: () => ({
                table,
                column: {
                  id: String(column.id ?? column.accessorKey ?? index),
                  columnDef: column,
                },
              }),
            })),
          },
        ],
        getRowModel: () => ({ rows }),
        getFilteredRowModel: () => ({ rows }),
        getState: () => ({ pagination: options.initialState?.pagination ?? { pageIndex: 0, pageSize: 50 } }),
        previousPage: () => {},
        nextPage: () => {},
        getCanPreviousPage: () => false,
        getCanNextPage: () => false,
        setPageIndex: () => {},
        getColumn: (id: string) => {
          if (id !== "name") return undefined
          return {
            getFilterValue: () => undefined,
            setFilterValue: () => {},
          }
        },
        getIsAllPageRowsSelected: () => rows.length > 0 && rows.every((row) => row.getIsSelected()),
        getIsSomePageRowsSelected: () => rows.some((row) => row.getIsSelected()) && !rows.every((row) => row.getIsSelected()),
        toggleAllPageRowsSelected: (selected: boolean) => {
          const next: Record<string, boolean> = {}
          if (selected) {
            for (const row of rows) next[row.id] = true
          }
          options.onRowSelectionChange?.(next)
        },
      }

      return table
    },
  }
})

vi.mock("@/lib/api", () => ({
  fetchSuiteFiles: fetchSuiteFilesMock,
  fetchRuns: fetchRunsMock,
  deleteSuiteFile: deleteSuiteFileMock,
  triggerRun: triggerRunMock,
}))

vi.mock("@/hooks/use-run-config", () => ({ useRunConfig: () => ({ defaultRunMode: "local", hasFarm: false }) }))
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }))
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: vi.fn() }))
vi.mock("@/hooks/use-suites-search-params", () => ({
  useSuitesSearchParams: () => ({
    status: "",
    platform: "",
    sorting: [],
    onSortingChange: vi.fn(),
    setStatus: vi.fn(),
    setPlatform: vi.fn(),
  }),
}))
vi.mock("@/components/page-skeleton", () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }))
vi.mock("@/components/empty-state", () => ({ EmptyState: ({ title }: { title: string }) => <div>{title}</div> }))
vi.mock("@/components/shortcut-hints", () => ({ ShortcutLegend: () => <div /> }))
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    disabled,
    onClick,
    type = "button",
    ...props
  }: {
    children: ReactNode
    className?: string
    disabled?: boolean
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} className={className} disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))
vi.mock("@/components/batch-action-bar", () => ({
  BatchActionBar: ({
    onDelete,
    selectedCount,
  }: {
    onDelete?: () => void
    selectedCount: number
  }) => {
    latestBatchActionBarProps.current = { onDelete, selectedCount }
    if (selectedCount === 0) return null
    return onDelete ? (
      <button type="button" onClick={onDelete}>
        Delete
      </button>
    ) : (
      <div>{selectedCount} selected</div>
    )
  },
}))
vi.mock("@/components/ui/input", () => ({
  Input: ({
    className,
    onChange,
    placeholder,
    value,
  }: {
    className?: string
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
    value?: string
  }) => (
    <input
      className={className}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  ),
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange: onValueChange })
      })}
    </div>
  ),
  SelectTrigger: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button type="button" className={className}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({
    children,
    __onValueChange,
  }: {
    children: ReactNode
    __onValueChange?: (value: string) => void
  }) => (
    <div>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child
        return cloneElement(child as any, { __onValueChange })
      })}
    </div>
  ),
  SelectItem: ({
    children,
    value,
    __onValueChange,
  }: {
    children: ReactNode
    value: string
    __onValueChange?: (value: string) => void
  }) => (
    <button type="button" data-value={value} onClick={() => __onValueChange?.(value)}>
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
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean | string
    onCheckedChange?: (value: boolean) => void
    "aria-label"?: string
  } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange">) => (
    <input
      type="checkbox"
      checked={checked === true}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
}))
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

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

beforeEach(() => {
  latestBatchActionBarProps.current = null
  fetchSuiteFilesMock.mockReset()
  fetchRunsMock.mockReset()
  deleteSuiteFileMock.mockReset()
  triggerRunMock.mockReset()

  fetchSuiteFilesMock.mockResolvedValue({
    files: [
      {
        path: "long-suite.suite.yaml",
        suiteId: "s_long-suite",
        name: LONG_SUITE_NAME,
        testCount: 3,
        modified: "2026-04-19T00:00:00Z",
        platform: "web",
      },
    ],
  })
  fetchRunsMock.mockResolvedValue({ runs: [] })
  deleteSuiteFileMock.mockResolvedValue({ deleted: true })
  triggerRunMock.mockResolvedValue({ runId: "run_suite" })
})

async function renderPage() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  act(() => {
    root!.render(
      <MemoryRouter initialEntries={["/suites"]}>
        <Routes>
          <Route
            path="/suites"
            element={
              <>
                <LocationProbe />
                <SuitesPage />
              </>
            }
          />
          <Route path="/suite/:suiteId" element={<div>Suite detail</div>} />
          <Route path="/runs/:runId" element={<div>Run detail</div>} />
        </Routes>
      </MemoryRouter>,
    )
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function findRow(text: string) {
  return Array.from(container?.querySelectorAll("tr") ?? []).find((row) =>
    row.textContent?.includes(text),
  ) as HTMLTableRowElement | undefined
}

function getLocationPathname() {
  return container?.querySelector('[data-testid="location"]')?.getAttribute("data-pathname")
}

function getSharedColumnContract() {
  return Array.from(container?.querySelectorAll("colgroup col") ?? []).map((column) => ({
    id: column.getAttribute("data-column-id"),
    width: (column as HTMLTableColElement).style.width,
  }))
}

function findHeading(text: string) {
  return Array.from(container?.querySelectorAll("h1") ?? []).find((heading) =>
    heading.textContent?.trim() === text,
  ) as HTMLHeadingElement | undefined
}

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.click()
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function focusIn(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
})

describe("SuitesPage", () => {
  it("places Keyboard shortcuts beside New Suite in the heading actions instead of the filter row", async () => {
    await renderPage()

    const heading = findHeading("Suites")
    const headingRow = heading?.parentElement
    const filterRow = container?.querySelector('input[placeholder="Search suites..."]')?.parentElement

    expect(headingRow?.className).toContain("justify-between")
    expect(headingRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeTruthy()
    expect(Array.from(headingRow?.querySelectorAll("button") ?? []).some((button) =>
      button.textContent?.includes("New Suite"),
    )).toBe(true)
    expect(filterRow?.querySelector('button[aria-label="Keyboard shortcuts"]')).toBeNull()
  })

  it("renders tests-like columns and a dense stacked name/path cell without the row-level more-actions menu", async () => {
    await renderPage()

    const nameLabel = Array.from(container?.querySelectorAll("span") ?? []).find((element) =>
      element.textContent === LONG_SUITE_NAME,
    ) as HTMLSpanElement | undefined
    const pathLabel = Array.from(container?.querySelectorAll("span, p") ?? []).find((element) =>
      element.textContent === "long-suite.suite.yaml",
    ) as HTMLSpanElement | HTMLParagraphElement | undefined

    expect(nameLabel).toBeTruthy()
    expect(nameLabel?.className).toContain("whitespace-normal")
    expect(nameLabel?.className).toContain("break-words")
    expect(nameLabel?.className).not.toContain("truncate")
    expect(pathLabel).toBeTruthy()
    expect(pathLabel?.className).toContain("break-all")
    expect(container?.textContent).toContain("Target")
    expect(container?.textContent).toContain("Platform")
    expect(container?.textContent).toContain("Pass rate")
    expect(container?.textContent).toContain("Last run")
    expect(container?.textContent).not.toContain("Date")
    expect(container?.querySelector(".lucide-more-horizontal")).toBeNull()
  })

  it("shows no-runs pass-rate copy and the active row contract on focus", async () => {
    await renderPage()

    const row = findRow(LONG_SUITE_NAME)
    const lastRunHeader = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Last run"),
    ) as HTMLButtonElement | undefined
    const noRunsCell = row?.querySelector("td:last-child span") as HTMLSpanElement | null
    expect(row?.textContent).toContain("No runs")
    expect(row?.textContent).toContain("0 completed")
    expect(lastRunHeader?.className).toContain("justify-end")
    expect(noRunsCell?.className).toContain("block")

    await act(async () => {
      row?.focus()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(row?.getAttribute("aria-selected")).toBe("true")
    expect(row?.className).toContain("bg-primary/10")
    expect(row?.className).toContain("ring-primary/60")

    expect(getSharedColumnContract()).toEqual([
      { id: "select", width: "2.75rem" },
      { id: "name", width: "" },
      { id: "target", width: "10rem" },
      { id: "platform", width: "6.25rem" },
      { id: "passRate", width: "7.25rem" },
      { id: "lastRun", width: "9rem" },
    ])

    const legacyWidthClasses = Array.from(container?.querySelectorAll("th, td") ?? []).filter((cell) =>
      /\bw-\[\d+%]/.test((cell as HTMLElement).className),
    )
    expect(legacyWidthClasses).toHaveLength(0)
  })

  it("selects an unfocused suite row on the first select-cell click without navigating", async () => {
    await renderPage()

    const row = findRow(LONG_SUITE_NAME)
    expect(row?.getAttribute("aria-selected")).not.toBe("true")

    await click(row?.querySelector("[data-selection-checkbox-hit-area]") as HTMLElement | null)

    expect(getLocationPathname()).toBe("/suites")
    expect(row?.querySelector<HTMLInputElement>('input[aria-label="Select row"]')?.checked).toBe(true)
    expect(latestBatchActionBarProps.current?.selectedCount).toBe(1)
    expect(getSharedColumnContract()[0]).toEqual({ id: "select", width: "2.75rem" })
  })

  it("selects an unfocused suite row on the first checkbox click after browser focus", async () => {
    await renderPage()

    const row = findRow(LONG_SUITE_NAME)
    const checkbox = row?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null
    expect(row?.getAttribute("aria-selected")).not.toBe("true")

    await focusIn(checkbox)
    expect(row?.getAttribute("aria-selected")).not.toBe("true")

    await click(checkbox)

    expect(getLocationPathname()).toBe("/suites")
    expect(checkbox?.checked).toBe(true)
    expect(latestBatchActionBarProps.current?.selectedCount).toBe(1)
  })

  it("deletes selected suites from the shared bottom toolbar", async () => {
    await renderPage()

    await click(findRow(LONG_SUITE_NAME)?.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null)
    expect(latestBatchActionBarProps.current?.selectedCount).toBe(1)

    await act(async () => {
      await latestBatchActionBarProps.current?.onDelete?.()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(deleteSuiteFileMock).toHaveBeenCalledTimes(1)
    expect(deleteSuiteFileMock).toHaveBeenCalledWith("long-suite.suite.yaml")
    expect(findRow(LONG_SUITE_NAME)).toBeUndefined()
  })
})
