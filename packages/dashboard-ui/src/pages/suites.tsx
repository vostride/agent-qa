import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useNavigate, Link } from "react-router"
import { routes } from "@/lib/routes"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import {
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { Plus, FolderOpen, ArrowUpDown, Keyboard } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SelectionCheckboxCell } from "@/components/table-selection-checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { TableSkeleton } from "@/components/page-skeleton"
import { EmptyState } from "@/components/empty-state"
import { BatchActionBar } from "@/components/batch-action-bar"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import {
  getSharedTestsSuitesColumnWidth,
  SHARED_TESTS_SUITES_COLUMN_IDS,
} from "@/pages/tests-suites-table-widths"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { useSuitesSearchParams } from "@/hooks/use-suites-search-params"
import { deleteSuiteFile, fetchSuiteFiles, fetchRuns, triggerRun, type SuiteFileInfo, type RunRow } from "@/lib/api"
import { formatDate } from "@/lib/utils"

interface SuiteListRow {
  path: string
  suiteId: string | null
  name: string
  platform: string | null
  lastRunStatus: string | null
  lastRun: RunRow | null
  targetName: string | null
  passRate: number | null
  passCount: number
  completedRunCount: number
}

const PASS_STATUSES = new Set(["passed", "healed"])
const COMPLETED_RUN_STATUSES = new Set(["passed", "healed", "failed", "flaky", "cancelled"])
const SUITES_TABLE_PAGE_SIZE = 50

function formatPlatformLabel(platform: string | null): string {
  if (!platform) return "\u2014"
  return platform === "ios" ? "iOS" : platform.charAt(0).toUpperCase() + platform.slice(1)
}

function getRunTimestamp(run: RunRow): string {
  return run.createdAt || run.startedAt || run.endedAt || ""
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/20">
          Passed
        </Badge>
      )
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
    case "healed":
      return (
        <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">
          Healed
        </Badge>
      )
    case "flaky":
      return (
        <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/20">
          Flaky
        </Badge>
      )
    case "running":
      return (
        <Badge className="bg-blue-500/15 text-blue-500 border-blue-500/20 animate-pulse">
          Running
        </Badge>
      )
    case "cancelled":
      return (
        <Badge className="bg-muted text-muted-foreground border-border">
          Cancelled
        </Badge>
      )
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function getHeaderClassName(columnId: string) {
  return cn(
    "h-10 bg-background text-[13px] font-medium text-foreground/90",
    columnId === "select" ? "px-2 text-center" : "px-3",
    (columnId === "passRate" || columnId === "lastRun") && "text-right",
  )
}

function getCellClassName(columnId: string) {
  return cn(
    "py-2 align-top",
    columnId === "select" && "px-2",
    columnId === "name" && "max-w-0 px-3",
    columnId === "targetName" && "max-w-0 px-3",
    columnId === "platform" && "px-3",
    columnId === "passRate" && "px-3 text-right",
    columnId === "lastRun" && "max-w-0 px-3 text-right",
  )
}

function getRowClassName({
  isActive,
  isBatchSelected,
}: {
  isActive: boolean
  isBatchSelected: boolean
}) {
  return cn(
    "cursor-pointer outline-none hover:bg-muted/20 focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
    isBatchSelected && !isActive && "bg-muted/20",
    isActive && "bg-primary/10 ring-1 ring-inset ring-primary/60",
  )
}

export default function SuitesPage() {
  usePageTitle("Suites")
  const [suiteFiles, setSuiteFiles] = useState<SuiteFileInfo[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [batchLoading, setBatchLoading] = useState(false)
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([])
  const navigate = useNavigate()
  const { status, platform, sorting, onSortingChange, setStatus, setPlatform } = useSuitesSearchParams()

  useEffect(() => {
    let cancelled = false

    Promise.all([fetchSuiteFiles(), fetchRuns({ limit: 200 })])
      .then(([suitesData, runsData]) => {
        if (!cancelled) {
          setSuiteFiles(suitesData.files)
          setRuns(runsData.runs)
        }
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to load suites")
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const data: SuiteListRow[] = useMemo(() => {
    return suiteFiles.map((sf) => {
      const matchingRuns = runs.filter((run) => {
        if (run.suiteId && sf.suiteId) {
          return run.suiteId === sf.suiteId
        }

        if (!run.suiteId) {
          return run.name === sf.name
        }

        return false
      })
      const sortedRuns = [...matchingRuns].sort((left, right) =>
        getRunTimestamp(right).localeCompare(getRunTimestamp(left)),
      )
      const completedRuns = sortedRuns.filter((run) => COMPLETED_RUN_STATUSES.has(run.status))
      const passCount = completedRuns.filter((run) => PASS_STATUSES.has(run.status)).length
      const passRate = completedRuns.length > 0
        ? Math.round((passCount / completedRuns.length) * 100)
        : null
      const lastRun = sortedRuns[0] ?? null
      const latestTargetedRun = sortedRuns.find((run) => run.targetName?.trim()) ?? null

      return {
        path: sf.path,
        suiteId: sf.suiteId,
        name: sf.name,
        platform: sf.platform ?? latestTargetedRun?.platform ?? lastRun?.platform ?? null,
        lastRunStatus: lastRun?.status ?? null,
        lastRun,
        targetName: latestTargetedRun?.targetName?.trim() ?? lastRun?.targetName?.trim() ?? null,
        passRate,
        passCount,
        completedRunCount: completedRuns.length,
      }
    })
  }, [suiteFiles, runs])

  const filteredData = useMemo(() => {
    let result = data
    if (status) {
      result = status === "no-runs"
        ? result.filter(d => !d.lastRunStatus)
        : result.filter(d => d.lastRunStatus === status)
    }
    if (platform) {
      result = result.filter(d => d.platform === platform)
    }
    return result
  }, [data, status, platform])

  const selectColumn: ColumnDef<SuiteListRow> = {
    id: "select",
    header: ({ table: t }) => (
      <div className="flex items-center justify-center">
        <SelectionCheckboxCell
          checked={t.getIsAllPageRowsSelected() || (t.getIsSomePageRowsSelected() && "indeterminate")}
          onCheckedChange={(checked) => t.toggleAllPageRowsSelected(checked)}
          ariaLabel="Select all"
        />
      </div>
    ),
    cell: ({ row }) => (
      <SelectionCheckboxCell
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked)}
      />
    ),
    enableSorting: false,
    size: 48,
  }

  const columns: ColumnDef<SuiteListRow>[] = useMemo(() => [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="-ml-4"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <span className="block whitespace-normal break-words text-sm font-medium leading-snug text-foreground">
            {row.getValue("name") as string}
          </span>
          <span className="block whitespace-normal break-all text-xs leading-snug text-muted-foreground">
            {row.original.path}
          </span>
        </div>
      ),
      size: 400,
      filterFn: (row, _columnId, filterValue: string) => {
        const name = (row.getValue("name") as string).toLowerCase()
        const path = row.original.path.toLowerCase()
        const query = filterValue.toLowerCase()
        return name.includes(query) || path.includes(query)
      },
    },
    {
      accessorKey: "targetName",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="-ml-4"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Target
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="block whitespace-normal break-words text-sm leading-snug text-muted-foreground">
          {row.original.targetName ?? "No target"}
        </span>
      ),
    },
    {
      accessorKey: "platform",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="-ml-4"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Platform
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const platform = row.getValue("platform") as string | null
        return <span className="text-muted-foreground text-sm">{formatPlatformLabel(platform)}</span>
      },
    },
    {
      accessorKey: "passRate",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="-ml-4"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Pass rate
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        if (row.original.passRate === null) {
          return (
            <div className="space-y-0.5 text-right">
              <div className="text-sm font-medium text-foreground">No runs</div>
              <div className="text-xs tabular-nums text-muted-foreground">0 completed</div>
            </div>
          )
        }

        return (
          <div className="space-y-0.5 text-right">
            <div className="text-sm font-medium tabular-nums text-foreground">
              {row.original.passRate}%
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">
              {row.original.passCount}/{row.original.completedRunCount}
            </div>
          </div>
        )
      },
    },
    {
      id: "lastRun",
      accessorFn: (row) => row.lastRun?.createdAt ?? row.lastRun?.startedAt ?? row.lastRun?.endedAt ?? "",
      header: ({ column }) => (
        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            className="h-auto justify-end px-0 text-[13px] font-medium text-foreground/90 hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Last run
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        </div>
      ),
      cell: ({ row }) => {
        if (!row.original.lastRun) {
          return <span className="block text-sm text-muted-foreground">No runs</span>
        }

        return (
          <Link
            to={routes.runDetail(row.original.lastRun.id)}
            className="relative z-10 flex w-full flex-col items-end gap-1 rounded-sm text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            onClick={(event) => event.stopPropagation()}
          >
            <StatusBadge status={row.original.lastRun.status} />
            <span className="whitespace-normal break-words text-xs leading-snug text-muted-foreground">
              {formatDate(getRunTimestamp(row.original.lastRun))}
            </span>
          </Link>
        )
      },
    },
  ], [])

  const selectedPaths = useMemo(
    () => Object.keys(rowSelection).filter((k) => rowSelection[k]),
    [rowSelection],
  )
  const selectedSuites = useMemo(
    () => filteredData.filter((s) => selectedPaths.includes(s.path)),
    [filteredData, selectedPaths],
  )

  const handleBatchRun = useCallback(async (local: boolean) => {
    if (selectedSuites.length === 0) return
    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedSuites.map((s) => triggerRun({ file: s.path, local })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`${succeeded} runs queued, ${failed} failed`)
      } else {
        toast.success(`${succeeded} runs queued`)
      }
      setRowSelection({})
    } finally {
      setBatchLoading(false)
    }
  }, [selectedSuites])

  const handleBatchRunNoCache = useCallback(async (local: boolean) => {
    if (selectedSuites.length === 0) return
    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedSuites.map((s) => triggerRun({ file: s.path, noCache: true, local })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`${succeeded} runs queued (no cache), ${failed} failed`)
      } else {
        toast.success(`${succeeded} runs queued (no cache)`)
      }
      setRowSelection({})
    } finally {
      setBatchLoading(false)
    }
  }, [selectedSuites])

  const handleBatchDelete = useCallback(async () => {
    if (selectedSuites.length === 0) return

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedSuites.map((suite) => deleteSuiteFile(suite.path)),
      )

      const deletedSuites = selectedSuites.filter((_, index) => results[index]?.status === "fulfilled")
      const deletedPaths = new Set(deletedSuites.map((suite) => suite.path))
      const failedCount = results.length - deletedSuites.length

      if (deletedSuites.length > 0) {
        setSuiteFiles((current) => current.filter((suite) => !deletedPaths.has(suite.path)))
        setRowSelection((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([path]) => !deletedPaths.has(path)),
          ),
        )
      }

      if (failedCount > 0) {
        toast.error(`Deleted ${deletedSuites.length} suite${deletedSuites.length !== 1 ? "s" : ""}, ${failedCount} failed`)
      } else {
        toast.success(`Deleted ${deletedSuites.length} suite${deletedSuites.length !== 1 ? "s" : ""}`)
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedSuites])

  const table = useReactTable({
    data: filteredData,
    columns: [selectColumn, ...columns],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange,
    onColumnFiltersChange: setColumnFilters,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    getRowId: (row) => row.path,
    state: { sorting, columnFilters, rowSelection },
    initialState: { pagination: { pageSize: SUITES_TABLE_PAGE_SIZE } },
  })

  const visibleRows = table.getRowModel().rows

  const searchValue = (table.getColumn("name")?.getFilterValue() as string) ?? ""

  const handleSearchChange = useCallback((query: string) => {
    table.getColumn("name")?.setFilterValue(query || undefined)
    table.setPageIndex(0)
    setSelectedIndex(-1)
    setRowSelection({})
  }, [table])

  const shortcuts = useMemo(() => {
    const next = () => setSelectedIndex((i) => Math.min(i + 1, visibleRows.length - 1))
    const prev = () => setSelectedIndex((i) => Math.max(i - 1, 0))
    return {
      j: next,
      arrowdown: next,
      k: prev,
      arrowup: prev,
      enter: (e: KeyboardEvent) => {
        if (selectedIndex >= 0 && visibleRows[selectedIndex]) {
          const row = visibleRows[selectedIndex].original
          if (!row.suiteId) return
          const href = routes.suiteView(row.suiteId)
          if (e.metaKey || e.ctrlKey) {
            window.open(href, '_blank')
          } else {
            navigate(href)
          }
        }
      },
    }
  }, [visibleRows, selectedIndex, navigate])
  useKeyboardShortcuts(shortcuts)

  useEffect(() => {
    if (selectedIndex < 0) return
    const row = rowRefs.current[selectedIndex]
    if (row && document.activeElement !== row) {
      row.focus()
    }
  }, [selectedIndex, visibleRows.length])

  const handleRowOpen = useCallback((row: SuiteListRow, event?: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (!row.suiteId) return
    if (event) {
      event.preventDefault()
    }
    navigate(routes.suiteView(row.suiteId))
  }, [navigate])

  if (isLoading) return <TableSkeleton />

  if (suiteFiles.length === 0) {
    return (
      <div data-tour-id="tour-suites-table">
        <EmptyState
          icon={FolderOpen}
          title="No suites found"
          description="Create your first suite file"
          actionLabel="New Suite"
          onAction={() => navigate(routes.suiteNew)}
        />
      </div>
    )
  }

  const filteredCount = table.getFilteredRowModel().rows.length
  const pageIndex = table.getState().pagination.pageIndex
  const pageSize = table.getState().pagination.pageSize
  const start = pageIndex * pageSize + 1
  const end = Math.min(start + pageSize - 1, filteredCount)

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Suites</h1>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="p-3">
                <ShortcutLegend
                  hints={[
                    { key: "J / \u2193", label: "Next row" },
                    { key: "K / \u2191", label: "Previous row" },
                    { key: "Enter", label: "Open suite" },
                    { key: "\u2318+Enter", label: "Open in new tab" },
                  ]}
                />
              </TooltipContent>
            </Tooltip>
            <Button size="sm" data-tour-id="tour-suites-new" onClick={() => navigate(routes.suiteNew)}>
              <Plus className="size-4" />
              New Suite
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search suites..."
            value={searchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="max-w-[220px]"
          />
          <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setSelectedIndex(-1); setRowSelection({}) }}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="passed">Passed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="no-runs">No runs</SelectItem>
            </SelectContent>
          </Select>
          <Select value={platform || "all"} onValueChange={(v) => { setPlatform(v === "all" ? "" : v); setSelectedIndex(-1); setRowSelection({}) }}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All platforms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All platforms</SelectItem>
              <SelectItem value="web">Web</SelectItem>
              <SelectItem value="android">Android</SelectItem>
              <SelectItem value="ios">iOS</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <ScrollArea data-tour-id="tour-suites-table" className="rounded-md border">
          <Table className="min-w-full table-fixed">
            <colgroup>
              {SHARED_TESTS_SUITES_COLUMN_IDS.map((columnId) => {
                const width = getSharedTestsSuitesColumnWidth(columnId)
                return (
                <col
                  key={columnId}
                  data-column-id={columnId}
                  style={width ? { width } : undefined}
                />
                )
              })}
            </colgroup>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className={getHeaderClassName(header.column.id)}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {visibleRows.length ? (
                visibleRows.map((row, idx) => {
                  const rowIsActive = idx === selectedIndex
                  const rowIsSelected = row.getIsSelected()

                  return (
                    <TableRow
                      key={row.id}
                      ref={(element) => {
                        rowRefs.current[idx] = element
                      }}
                      data-runs-row-surface={row.id}
                      tabIndex={rowIsActive ? 0 : -1}
                      aria-selected={rowIsActive}
                      className={getRowClassName({
                        isActive: rowIsActive,
                        isBatchSelected: rowIsSelected,
                      })}
                      onClick={() => {
                        setSelectedIndex(idx)
                        handleRowOpen(row.original)
                      }}
                      onFocus={() => setSelectedIndex(idx)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleRowOpen(row.original, event)
                        }
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isSelect = cell.column.id === "select"
                        return (
                          <TableCell
                            key={cell.id}
                            className={cn(getCellClassName(cell.column.id), isSelect && "relative z-10")}
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length + 1}
                    className="h-24 text-center"
                  >
                    No results.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <div className="flex items-center justify-between px-2">
          <p className="text-sm text-muted-foreground">
            {filteredCount > 0
              ? `Showing ${start}-${end} of ${filteredCount}${searchValue || status || platform ? ` (${data.length} total)` : ""}`
              : "No suites found"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>

        <BatchActionBar
          selectedCount={selectedPaths.length}
          onRun={handleBatchRun}
          onRunNoCache={handleBatchRunNoCache}
          onDelete={handleBatchDelete}
          onCancel={() => setRowSelection({})}
          isRunning={batchLoading}
        />
      </div>
    </TooltipProvider>
  )
}
