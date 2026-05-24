import { useState, useEffect, useMemo, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useNavigate, Link } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { useTestsSearchParams } from "@/hooks/use-tests-search-params"
import { Plus, FileText, ArrowUpDown, Keyboard, X } from "lucide-react"
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
import { TestRunOptionsPopover } from "@/components/test-run-options-popover"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import { useSelectionQueue } from "@/hooks/use-selection-queue"
import { useRunConfig } from "@/hooks/use-run-config"
import {
  getSharedTestsSuitesColumnWidth,
  SHARED_TESTS_SUITES_COLUMN_IDS,
} from "@/pages/tests-suites-table-widths"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { deleteTestFile, fetchTestFiles, fetchRuns, purgeCache, triggerRun, type TestFileInfo, type RunRow } from "@/lib/api"
import { cn, formatDate } from "@/lib/utils"

interface TestRow {
  path: string
  name: string
  testId: string | null
  targetName: string | null
  platform: string | null
  lastRunStatus: string | null
  lastRun: RunRow | null
  passRate: number | null
  passCount: number
  completedRunCount: number
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

const PASS_STATUSES = new Set(["passed", "healed"])
const COMPLETED_RUN_STATUSES = new Set(["passed", "healed", "failed", "flaky", "cancelled"])

function formatPlatformLabel(platform: string | null): string {
  if (!platform) return "\u2014"
  return platform === "ios" ? "iOS" : platform.charAt(0).toUpperCase() + platform.slice(1)
}

function normalizeTestPath(path: string): string {
  return path.replace(/\\/g, "/")
}

function stripDisplayPrefix(path: string): string {
  const parts = normalizeTestPath(path).split("/").filter(Boolean)
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0] ?? path
}

function getRunTimestamp(run: RunRow): string {
  return run.createdAt || run.startedAt || run.endedAt || ""
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
    (columnId === "target" || columnId === "targetName") && "max-w-0 px-3",
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

const columns: ColumnDef<TestRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <Button
        variant="ghost"
        className="-ml-4"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Test Name
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
    cell: ({ row }) => (
      <div className="min-w-0 space-y-0.5">
        <span className="block whitespace-normal break-words text-sm font-medium leading-snug text-foreground">
          {row.getValue("name") as string}
        </span>
        <span className="block whitespace-normal break-all text-xs leading-snug text-muted-foreground">
          {stripDisplayPrefix(row.original.path)}
        </span>
      </div>
    ),
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
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatPlatformLabel(row.getValue("platform") as string | null)}
      </span>
    ),
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
    sortingFn: (rowA, rowB) => {
      const a = getRunTimestamp(rowA.original.lastRun ?? { createdAt: "", startedAt: null, endedAt: null } as RunRow)
      const b = getRunTimestamp(rowB.original.lastRun ?? { createdAt: "", startedAt: null, endedAt: null } as RunRow)
      return a.localeCompare(b)
    },
  },
]

export default function TestsPage() {
  usePageTitle("Tests")
  const [files, setFiles] = useState<TestFileInfo[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [targetOptions, setTargetOptions] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [batchLoading, setBatchLoading] = useState(false)
  const [runOptionsOpen, setRunOptionsOpen] = useState(false)
  const [useCache, setUseCache] = useState(true)
  const [useMemory, setUseMemory] = useState(true)
  const navigate = useNavigate()
  const { hasFarm, isLoading: isRunConfigLoading } = useRunConfig()

  useEffect(() => {
    let cancelled = false

    Promise.all([fetchTestFiles(), fetchRuns({ limit: 200 })])
      .then(([filesData, runsData]) => {
        if (!cancelled) {
          setFiles(filesData.files)
          setTargetOptions(filesData.targets ?? [])
          setRuns(runsData.runs)
        }
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to load test files")
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const {
    search,
    status,
    platform,
    target,
    page,
    sorting,
    pagination,
    onSortingChange,
    onPaginationChange,
    setSearch,
    setStatus,
    setPlatform,
    setTarget,
    setPage,
  } = useTestsSearchParams()
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([])

  const data: TestRow[] = useMemo(() => {
    const runsByExactPath = new Map<string, RunRow[]>()
    const runsByStrippedPath = new Map<string, RunRow[]>()

    const appendRun = (map: Map<string, RunRow[]>, key: string, run: RunRow) => {
      if (!key) return
      const current = map.get(key)
      if (current) {
        current.push(run)
      } else {
        map.set(key, [run])
      }
    }

    for (const run of runs) {
      if (!run.filePath) continue
      const exactPath = normalizeTestPath(run.filePath)
      appendRun(runsByExactPath, exactPath, run)
      appendRun(runsByStrippedPath, stripDisplayPrefix(exactPath), run)
    }

    return files.map((file) => {
      const exactPath = normalizeTestPath(file.path)
      const matchingRuns = runsByExactPath.get(exactPath)
        ?? runsByStrippedPath.get(stripDisplayPrefix(exactPath))
        ?? []
      const sortedRuns = [...matchingRuns].sort((left, right) =>
        getRunTimestamp(right).localeCompare(getRunTimestamp(left)),
      )
      const completedRuns = sortedRuns.filter((run) => COMPLETED_RUN_STATUSES.has(run.status))
      const passCount = completedRuns.filter((run) => PASS_STATUSES.has(run.status)).length
      const passRate = completedRuns.length > 0
        ? Math.round((passCount / completedRuns.length) * 100)
        : null
      const lastRun = sortedRuns[0] ?? null

      return {
        path: file.path,
        name: file.name,
        testId: file.testId,
        targetName: file.targetName,
        platform: file.platform,
        lastRunStatus: lastRun?.status ?? null,
        lastRun,
        passRate,
        passCount,
        completedRunCount: completedRuns.length,
      }
    })
  }, [files, runs])

  const filteredData = useMemo(() => {
    let result = data
    if (search) {
      const query = search.toLowerCase()
      result = result.filter((row) => {
        const targetName = row.targetName?.toLowerCase() ?? ""
        return row.name.toLowerCase().includes(query)
          || row.path.toLowerCase().includes(query)
          || targetName.includes(query)
      })
    }
    if (status) {
      result = status === "no-runs"
        ? result.filter((row) => !row.lastRunStatus)
        : result.filter((row) => row.lastRunStatus === status)
    }
    if (platform) {
      result = result.filter((row) => row.platform === platform)
    }
    if (target) {
      result = result.filter((row) => row.targetName === target)
    }
    return result
  }, [data, search, status, platform, target])

  const selectionQueue = useSelectionQueue({
    items: data,
    getId: (row) => row.path,
    visibleIds: filteredData.map((row) => row.path),
  })

  const availableTargets = useMemo(
    () => Array.from(new Set(
      [target, ...targetOptions, ...data.map((row) => row.targetName ?? "")]
        .filter((value): value is string => Boolean(value)),
    )),
    [data, target, targetOptions],
  )

  const selectColumn: ColumnDef<TestRow> = {
    id: "select",
    header: ({ table: t }) => (
      <div className="flex items-center justify-center">
        <SelectionCheckboxCell
          checked={selectionQueue.getVisibleSelectionState(
            t.getRowModel().rows.map((row) => row.original.path),
          )}
          onCheckedChange={(checked) => selectionQueue.setItemsSelected(
            t.getRowModel().rows.map((row) => row.original),
            checked,
          )}
          ariaLabel="Select all"
        />
      </div>
    ),
    cell: ({ row }) => (
      <SelectionCheckboxCell
        checked={selectionQueue.isSelected(row.original.path)}
        onCheckedChange={(checked) => selectionQueue.setItemSelected(row.original, checked)}
      />
    ),
    enableSorting: false,
    size: 48,
  }

  const selectedPaths = selectionQueue.selectedIds
  const selectedTests = selectionQueue.selectedItems

  const clearQueue = useCallback(() => {
    selectionQueue.clearSelection()
    setRunOptionsOpen(false)
    setUseCache(true)
    setUseMemory(true)
  }, [selectionQueue])

  const handleRunDestination = useCallback(async (local: boolean) => {
    if (selectedPaths.length === 0) return
    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedPaths.map((path) => triggerRun({
          file: path,
          local,
          noCache: !useCache,
          noMemory: !useMemory,
        })),
      )
      const succeeded = results.filter((r) => r.status === "fulfilled").length
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`${succeeded} runs queued, ${failed} failed`)
      } else {
        toast.success(`${succeeded} runs queued`)
      }
      setRunOptionsOpen(false)
    } finally {
      setBatchLoading(false)
    }
  }, [selectedPaths, useCache, useMemory])

  const handleBatchPurgeCache = useCallback(async () => {
    if (selectedPaths.length === 0) return
    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedPaths.map((path) => purgeCache({ file: path })),
      )
      const succeeded = results.filter((result) => result.status === "fulfilled").length
      const totalPurged = results
        .filter((result): result is PromiseFulfilledResult<{ purged: number }> => result.status === "fulfilled")
        .reduce((sum, result) => sum + result.value.purged, 0)
      const failed = results.length - succeeded
      if (failed > 0) {
        toast.error(`Purged ${totalPurged} plans from ${succeeded} tests, ${failed} failed`)
      } else {
        toast.success(`Purged ${totalPurged} cached plan${totalPurged !== 1 ? "s" : ""}`)
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedPaths])

  const handleBatchDelete = useCallback(async () => {
    if (selectedTests.length === 0) return

    setBatchLoading(true)
    try {
      const results = await Promise.allSettled(
        selectedTests.map((test) => {
          if (!test.testId) {
            return Promise.reject(new Error(`Missing test id for ${test.path}`))
          }
          return deleteTestFile(test.testId)
        }),
      )

      const deletedTests = selectedTests.filter((_, index) => results[index]?.status === "fulfilled")
      const deletedPaths = new Set(deletedTests.map((test) => test.path))
      const failedCount = results.length - deletedTests.length

      if (deletedTests.length > 0) {
        selectionQueue.setItemsSelected(deletedTests, false)
        setFiles((current) => current.filter((file) => !deletedPaths.has(file.path)))
        setRunOptionsOpen(false)
      }

      if (failedCount > 0) {
        toast.error(`Deleted ${deletedTests.length} test${deletedTests.length !== 1 ? "s" : ""}, ${failedCount} failed`)
      } else {
        toast.success(`Deleted ${deletedTests.length} test${deletedTests.length !== 1 ? "s" : ""}`)
      }
    } finally {
      setBatchLoading(false)
    }
  }, [selectedTests, selectionQueue])

  const table = useReactTable({
    data: filteredData,
    columns: [selectColumn, ...columns],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange,
    onPaginationChange,
    getRowId: (row) => row.path,
    state: { sorting, pagination },
  })

  const visibleRows = table.getRowModel().rows
  const hiddenCount = selectionQueue.hiddenCount
  const searchValue = search

  useEffect(() => {
    if (isLoading) return
    const pageCount = Math.max(1, Math.ceil(filteredData.length / pagination.pageSize))
    if (page > pageCount) {
      setPage(pageCount)
    }
  }, [filteredData.length, isLoading, page, pagination.pageSize, setPage])

  const handleSearchChange = useCallback((query: string) => {
    setSearch(query)
    setSelectedIndex(-1)
  }, [setSearch])

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
          const href = routes.testView(row.testId ?? row.path)
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

  const handleRowOpen = useCallback((row: TestRow, event?: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (event) {
      event.preventDefault()
    }
    navigate(routes.testView(row.testId ?? row.path))
  }, [navigate])

  if (isLoading) return <TableSkeleton />

  if (files.length === 0) {
    return (
      <div data-tour-id="tour-tests-table">
        <EmptyState
          icon={FileText}
          title="No tests found"
          description="Create your first test file to get started"
          actionLabel="Create Test"
          onAction={() => navigate(routes.testNew)}
        />
      </div>
    )
  }

  const filteredCount = filteredData.length
  const pageIndex = pagination.pageIndex
  const pageSize = pagination.pageSize
  const start = pageIndex * pageSize + 1
  const end = Math.min(start + pageSize - 1, filteredCount)

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Tests</h1>
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
                    { key: "J / ↓", label: "Next row" },
                    { key: "K / ↑", label: "Previous row" },
                    { key: "Enter", label: "Open test" },
                    { key: "⌘+Enter", label: "Open in new tab" },
                  ]}
                />
              </TooltipContent>
            </Tooltip>
            <Button size="sm" data-tour-id="tour-tests-new" onClick={() => navigate(routes.testNew)}>
              <Plus className="size-4" />
              New Test
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search tests..."
            value={searchValue}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="max-w-[220px]"
          />
          <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setSelectedIndex(-1) }}>
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
          <Select value={platform || "all"} onValueChange={(v) => { setPlatform(v === "all" ? "" : v); setSelectedIndex(-1) }}>
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
          <Select value={target || "all"} onValueChange={(v) => { setTarget(v === "all" ? "" : v); setSelectedIndex(-1) }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All targets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All targets</SelectItem>
              {availableTargets.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ScrollArea data-tour-id="tour-tests-table" className="rounded-md border">
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
                  const rowIsSelected = selectionQueue.isSelected(row.original.path)

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
                      onClick={() => handleRowOpen(row.original)}
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
                    No tests match the current search or filters.
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
              ? `Showing ${start}-${end} of ${filteredCount}${searchValue || status || platform || target ? ` (${data.length} total)` : ""}`
              : "No tests found"}
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
          selectedCount={selectionQueue.selectedCount}
          summaryMeta={hiddenCount > 0 ? `${hiddenCount} hidden by filters` : undefined}
          secondaryIcon={<X className="size-4" />}
          secondaryAriaLabel="Clear queue"
          onDelete={handleBatchDelete}
          actionSlot={(
            <div className="flex items-center gap-2">
              <TestRunOptionsPopover
                selectedCount={selectionQueue.selectedCount}
                hiddenCount={hiddenCount}
                useCache={useCache}
                useMemory={useMemory}
                browserStackAvailable={!isRunConfigLoading && hasFarm}
                open={runOptionsOpen}
                onOpenChange={setRunOptionsOpen}
                onUseCacheChange={setUseCache}
                onUseMemoryChange={setUseMemory}
                onRunLocal={() => handleRunDestination(true)}
                onRunBrowserStack={() => handleRunDestination(false)}
                disabled={batchLoading}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchPurgeCache}
                disabled={batchLoading}
              >
                Purge cache
              </Button>
            </div>
          )}
          onCancel={clearQueue}
          isRunning={batchLoading}
        />
      </div>
    </TooltipProvider>
  )
}
