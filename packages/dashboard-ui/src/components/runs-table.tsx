import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  type Column,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, ChevronDown, ChevronRight, Plus, SlidersHorizontal, Trash2 } from "lucide-react"

import { ElapsedTimer } from "@/components/elapsed-timer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
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
import {
  fetchRunAttributeKeys,
  fetchRunAttributeValues,
  type AttributePredicate,
  type AttributeKeySuggestion,
  type AttributeValueSuggestion,
  type RunRow,
} from "@/lib/api"
import { getRunStatusDescriptor, getStatusBadgeClassName } from "@/lib/status"
import { cn, formatDate, formatDateShort, formatDuration } from "@/lib/utils"

export type SuiteRunRow = RunRow & { tests?: RunRow[] }

export interface VisibleRunRow {
  id: string
  run: RunRow
  isChild: boolean
  parentId: string | null
}

const COLUMN_WIDTHS: Partial<Record<string, string>> = {
  select: "44px",
  status: "136px",
  target: "180px",
  attributes: "260px",
  duration: "104px",
  createdAt: "128px",
}

const INTERNAL_ATTRIBUTE_ORDER = ["agent-qa.trigger", "agent-qa.runner"]

function formatPlatform(platform: string) {
  return platform === "ios"
    ? "iOS"
    : platform.charAt(0).toUpperCase() + platform.slice(1)
}

function formatTarget(run: RunRow) {
  const targetName = run.targetName?.trim() || "No target"
  return `${targetName} (${formatPlatform(run.platform)})`
}

function isSuiteParent(run: RunRow) {
  return run.suiteId != null && run.parentRunId == null
}

function sortAttributeEntries(
  attributes: Record<string, string> | null | undefined,
  activeKeys: readonly string[],
) {
  const activeOrder = new Map(activeKeys.map((key, index) => [key, index]))
  const internalOrder = new Map(INTERNAL_ATTRIBUTE_ORDER.map((key, index) => [key, index]))

  return Object.entries(attributes ?? {})
    .filter(([, value]) => typeof value === "string")
    .sort(([leftKey], [rightKey]) => {
      const leftActive = activeOrder.get(leftKey)
      const rightActive = activeOrder.get(rightKey)
      if (leftActive !== undefined || rightActive !== undefined) {
        return (leftActive ?? Number.MAX_SAFE_INTEGER) - (rightActive ?? Number.MAX_SAFE_INTEGER)
      }

      const leftInternal = internalOrder.get(leftKey)
      const rightInternal = internalOrder.get(rightKey)
      if (leftInternal !== undefined || rightInternal !== undefined) {
        return (leftInternal ?? Number.MAX_SAFE_INTEGER) - (rightInternal ?? Number.MAX_SAFE_INTEGER)
      }

      return leftKey.localeCompare(rightKey)
    })
}

function AttributeSummary({
  attributes,
  activeKeys,
}: {
  attributes: Record<string, string> | null | undefined
  activeKeys: readonly string[]
}) {
  const entries = sortAttributeEntries(attributes, activeKeys)
  if (entries.length === 0) {
    return <span className="text-[12px] text-muted-foreground">No attributes</span>
  }

  const visibleLimit = entries.length > 2 ? 1 : 2
  const visible = entries.slice(0, visibleLimit)
  const hiddenCount = entries.length - visible.length
  const fullSummary = entries.map(([key, value]) => `${key}=${value}`).join(", ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="max-h-[38px] overflow-hidden text-[12px] leading-[18px]" aria-label={fullSummary}>
          {visible.map(([key, value]) => (
            <div key={key} className="min-w-0 truncate font-mono">
              <span className="text-muted-foreground">{key}=</span>
              <span className="text-foreground">{value}</span>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="font-mono text-[11px] text-muted-foreground">+{hiddenCount} more</div>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[420px] p-2">
        <div className="max-h-64 overflow-auto font-mono text-[11px] leading-5">
          {entries.map(([key, value]) => (
            <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <span className="truncate text-muted-foreground">{key}</span>
              <span className="truncate text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function predicateText(predicate: AttributePredicate) {
  return predicate.mode === "regex"
    ? `${predicate.key} matches ${predicate.value}`
    : `${predicate.key} = ${predicate.value}`
}

function AttributeFilterControl({
  predicates,
  onChange,
}: {
  predicates: AttributePredicate[]
  onChange?: (predicates: AttributePredicate[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [valueInput, setValueInput] = useState("")
  const [mode, setMode] = useState<AttributePredicate["mode"]>("exact")
  const [error, setError] = useState<string | null>(null)
  const [keySuggestions, setKeySuggestions] = useState<AttributeKeySuggestion[]>([])
  const [valueSuggestions, setValueSuggestions] = useState<AttributeValueSuggestion[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchRunAttributeKeys({ q: keyInput, limit: 8 })
      .then((data) => {
        if (!cancelled) setKeySuggestions(data.keys)
      })
      .catch(() => {
        if (!cancelled) setKeySuggestions([])
      })
    return () => {
      cancelled = true
    }
  }, [keyInput, open])

  useEffect(() => {
    if (!open || !keyInput.trim()) {
      setValueSuggestions([])
      return
    }
    let cancelled = false
    fetchRunAttributeValues(keyInput.trim(), { q: valueInput, limit: 8 })
      .then((data) => {
        if (!cancelled) setValueSuggestions(data.values)
      })
      .catch(() => {
        if (!cancelled) setValueSuggestions([])
      })
    return () => {
      cancelled = true
    }
  }, [keyInput, open, valueInput])

  function applyFilter() {
    const key = keyInput.trim()
    const value = valueInput.trim()
    if (!key || !value) {
      setError("Enter an attribute key and value, or remove this filter.")
      return
    }
    if (mode === "regex") {
      try {
        new RegExp(value)
      } catch {
        setError("Enter a valid regular expression.")
        return
      }
    }

    setError(null)
    const withoutSameKey = predicates.filter((predicate) => predicate.key !== key)
    onChange?.([...withoutSameKey, { key, value, mode }])
    setKeyInput("")
    setValueInput("")
    setMode("exact")
  }

  function removeFilter(index: number) {
    onChange?.(predicates.filter((_, currentIndex) => currentIndex !== index))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={predicates.length > 0 ? "secondary" : "outline"}
          size="sm"
          aria-label="Filter by attributes"
          className="h-9 gap-2"
        >
          <SlidersHorizontal className="size-4" />
          Attributes{predicates.length > 0 ? ` (${predicates.length})` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-0">
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">Filter by attributes</h3>
        </div>

        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground" htmlFor="run-attribute-key">
                Key
              </label>
              <Input
                id="run-attribute-key"
                value={keyInput}
                onChange={(event) => {
                  setKeyInput(event.target.value)
                  setError(null)
                }}
                placeholder="git.branch"
              />
              <div className="max-h-28 overflow-y-auto rounded border border-border/60">
                {keySuggestions.length > 0 ? keySuggestions.map((suggestion) => (
                  <button
                    key={suggestion.key}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => setKeyInput(suggestion.key)}
                  >
                    <span className="truncate font-mono">{suggestion.key}</span>
                    <span className="text-muted-foreground tabular-nums">{suggestion.count}</span>
                  </button>
                )) : (
                  <div className="px-2 py-2 text-xs text-muted-foreground">No attributes found</div>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground" htmlFor="run-attribute-value">
                Value
              </label>
              <Input
                id="run-attribute-value"
                value={valueInput}
                onChange={(event) => {
                  setValueInput(event.target.value)
                  setError(null)
                }}
                placeholder={mode === "regex" ? "^(master|main)$" : "master"}
                aria-describedby={error ? "run-attribute-filter-error" : undefined}
              />
              <div className="max-h-28 overflow-y-auto rounded border border-border/60">
                {valueSuggestions.length > 0 ? valueSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.value}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => setValueInput(suggestion.value)}
                  >
                    <span className="truncate font-mono">{suggestion.value}</span>
                    <span className="text-muted-foreground tabular-nums">{suggestion.count}</span>
                  </button>
                )) : (
                  <div className="px-2 py-2 text-xs text-muted-foreground">No values found for this key</div>
                )}
              </div>
            </div>
          </div>

          <div className="inline-flex rounded border border-border p-0.5">
            <button
              type="button"
              className={cn("rounded-[2px] px-2 py-1 text-xs", mode === "exact" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
              aria-pressed={mode === "exact"}
              onClick={() => setMode("exact")}
            >
              Exact match
            </button>
            <button
              type="button"
              className={cn("rounded-[2px] px-2 py-1 text-xs", mode === "regex" ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
              aria-pressed={mode === "regex"}
              onClick={() => setMode("regex")}
            >
              Regex
            </button>
          </div>

          {error ? (
            <p id="run-attribute-filter-error" className="text-xs text-destructive">{error}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={applyFilter}>
              <Plus className="size-4" />
              Apply filter
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => onChange?.([])} disabled={predicates.length === 0}>
              Clear attributes
            </Button>
          </div>

          {predicates.length > 0 ? (
            <div className="space-y-1 border-t pt-3">
              {predicates.map((predicate, index) => (
                <div key={`${predicate.key}-${predicate.mode}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 break-all font-mono">{predicateText(predicate)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${predicate.key} filter`}
                    onClick={() => removeFilter(index)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function StatusBadge({ status }: { status: string }) {
  const descriptor = getRunStatusDescriptor(status)
  return (
    <Badge className={getStatusBadgeClassName(descriptor.tone)}>
      {descriptor.label}
    </Badge>
  )
}

function CompactSortableHeader({
  column,
  label,
}: {
  column: Column<RunRow, unknown>
  label: string
}) {
  return (
    <div className="flex justify-end">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-runs-sort-button="compact"
        className="h-7 max-w-full shrink justify-end px-1.5 text-[12px] leading-none text-foreground/90"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        <span className="truncate">{label}</span>
        <ArrowUpDown />
      </Button>
    </div>
  )
}

const columns: ColumnDef<RunRow>[] = [
  {
    accessorKey: "status",
    header: ({ column }) => (
      <Button
        variant="ghost"
        className="-ml-2"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Status
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <Button
        variant="ghost"
        className="-ml-2"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Test Name
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
  },
  {
    id: "target",
    accessorFn: (row) => `${row.targetName ?? "No target"} ${row.platform}`,
    header: ({ column }) => (
      <Button
        variant="ghost"
        className="-ml-2"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Target
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
  },
  {
    id: "attributes",
    accessorFn: (row) => Object.entries(row.attributes ?? {}).map(([key, value]) => `${key}=${value}`).join(" "),
    header: "Attributes",
  },
  {
    accessorKey: "duration",
    header: ({ column }) => <CompactSortableHeader column={column} label="Duration" />,
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => <CompactSortableHeader column={column} label="Started" />,
  },
]

function stopRowClick(event: MouseEvent | KeyboardEvent) {
  event.stopPropagation()
}

function getSelectAllState(ids: readonly string[], selectedIds: Set<string>): boolean | "indeterminate" {
  if (ids.length === 0) return false
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length
  if (selectedCount === 0) return false
  if (selectedCount === ids.length) return true
  return "indeterminate"
}

function getColumnWidthStyle(columnId: string): CSSProperties | undefined {
  const width = COLUMN_WIDTHS[columnId]
  if (!width) return undefined
  return { width, minWidth: width }
}

function getHeadClassName(columnId: string) {
  return cn(
    "h-10 bg-background text-[13px] font-medium text-foreground/90",
    columnId === "select" && "w-11 px-2 text-center",
    columnId === "status" && "w-[136px] px-3",
    columnId === "name" && "px-3",
    columnId === "target" && "w-[180px] px-3",
    columnId === "attributes" && "w-[260px] px-3",
    columnId === "duration" && "w-[104px] px-3 text-right",
    columnId === "createdAt" && "w-[128px] px-3 text-right",
  )
}

function getCellClassName(columnId: string, isChild: boolean) {
  return cn(
    "py-2 align-top",
    columnId === "select" && "w-11 px-2",
    columnId === "status" && "w-[136px] px-3",
    columnId === "name" && cn("max-w-0 px-3", isChild && "pl-8"),
    columnId === "target" && "w-[180px] max-w-0 px-3 text-muted-foreground",
    columnId === "attributes" && "w-[260px] max-w-0 px-3",
    columnId === "duration" && "w-[104px] px-3 text-right tabular-nums",
    columnId === "createdAt" && "w-[128px] px-3 text-right tabular-nums",
  )
}

function getRowClassName({
  isActive,
  isBatchSelected,
  isChild,
}: {
  isActive: boolean
  isBatchSelected: boolean
  isChild: boolean
}) {
  return cn(
    "cursor-pointer outline-none hover:bg-muted/20 focus-visible:bg-primary/10",
    isChild && "bg-muted/[0.04]",
    isBatchSelected && !isActive && "bg-muted/20",
    isActive && "bg-primary/10 ring-1 ring-inset ring-primary/60",
  )
}

export function flattenVisibleRuns(runs: SuiteRunRow[], expandedSuites: Set<string>): VisibleRunRow[] {
  const visibleRows: VisibleRunRow[] = []

  for (const run of runs) {
    visibleRows.push({
      id: run.id,
      run,
      isChild: false,
      parentId: null,
    })

    if (!isSuiteParent(run) || !expandedSuites.has(run.id)) continue

    for (const child of run.tests ?? []) {
      visibleRows.push({
        id: child.id,
        run: child,
        isChild: true,
        parentId: run.id,
      })
    }
  }

  return visibleRows
}

function areVisibleRunRowsEqual(left: VisibleRunRow[], right: VisibleRunRow[]) {
  if (left.length !== right.length) return false

  return left.every((row, index) => {
    const next = right[index]
    return Boolean(next)
      && row.id === next.id
      && row.isChild === next.isChild
      && row.parentId === next.parentId
      && row.run === next.run
  })
}

interface RunsTableProps {
  runs: SuiteRunRow[]
  total: number
  isLoading: boolean
  page: number
  onPageChange: (page: number) => void
  onSearchChange: (query: string) => void
  searchValue: string
  selectedRunId?: string | null
  onSelectedRunIdChange?: (runId: string | null) => void
  expandedSuites?: Set<string>
  onToggleSuite?: (suiteId: string) => void
  onOpenRun?: (run: RunRow, event?: MouseEvent | KeyboardEvent) => void
  onVisibleRunsChange?: (rows: VisibleRunRow[]) => void
  platformFilter?: string
  onPlatformChange?: (platform: string) => void
  targetFilter?: string
  targetOptions?: string[]
  onTargetChange?: (target: string) => void
  attributePredicates?: AttributePredicate[]
  onAttributePredicatesChange?: (predicates: AttributePredicate[]) => void
  sorting?: SortingState
  onSortingChange?: OnChangeFn<SortingState>
  headerActions?: ReactNode
  topSlot?: ReactNode
  enableSelection?: boolean
  selectedRunIds?: Set<string>
  onToggleRunSelection?: (run: RunRow, selected: boolean) => void
  onToggleVisibleSelection?: (runs: RunRow[], selected: boolean) => void
}

export function RunsTable({
  runs,
  total,
  isLoading,
  page,
  onPageChange,
  onSearchChange,
  searchValue,
  selectedRunId = null,
  onSelectedRunIdChange,
  expandedSuites = new Set<string>(),
  onToggleSuite,
  onOpenRun,
  onVisibleRunsChange,
  platformFilter = "",
  onPlatformChange,
  targetFilter = "",
  targetOptions = [],
  onTargetChange,
  attributePredicates = [],
  onAttributePredicatesChange,
  sorting: sortingProp,
  onSortingChange: onSortingChangeProp,
  headerActions,
  topSlot,
  enableSelection = false,
  selectedRunIds = new Set<string>(),
  onToggleRunSelection,
  onToggleVisibleSelection,
}: RunsTableProps) {
  const [localSorting, setLocalSorting] = useState<SortingState>([])
  const sorting = sortingProp ?? localSorting
  const handleSortingChange = onSortingChangeProp ?? setLocalSorting

  const selectColumn: ColumnDef<RunRow> = {
    id: "select",
    header: ({ table: t }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={getSelectAllState(
            t.getRowModel().rows.map((row) => row.original.id),
            selectedRunIds,
          )}
          onCheckedChange={(value) => onToggleVisibleSelection?.(
            t.getRowModel().rows.map((row) => row.original),
            value === true,
          )}
          onClick={(event) => event.stopPropagation()}
          aria-label="Select all"
        />
      </div>
    ),
    enableSorting: false,
  }
  const allColumns = [
    ...(enableSelection ? [selectColumn] : []),
    ...columns,
  ]

  const table = useReactTable({
    data: runs,
    columns: allColumns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: handleSortingChange,
    state: {
      sorting,
    },
  })

  const headerGroups = table.getHeaderGroups()
  const topLevelRows = table.getRowModel().rows
  const topLevelRuns = useMemo(
    () => topLevelRows.map((row) => row.original as SuiteRunRow),
    [topLevelRows],
  )
  const visibleRuns = useMemo(
    () => flattenVisibleRuns(topLevelRuns, expandedSuites),
    [expandedSuites, topLevelRuns],
  )
  const pageSize = 50
  const totalPages = Math.ceil(total / pageSize)
  const start = page * pageSize + 1
  const end = Math.min((page + 1) * pageSize, total)
  const availableTargets = Array.from(
    new Set([targetFilter, ...targetOptions].filter((value): value is string => Boolean(value))),
  )
  const visibleColumnIds = [
    ...(enableSelection ? ["select"] : []),
    "status",
    "name",
    "target",
    "attributes",
    "duration",
    "createdAt",
  ]
  const activeAttributeKeys = useMemo(
    () => attributePredicates.map((predicate) => predicate.key),
    [attributePredicates],
  )
  const lastNotifiedVisibleRunsRef = useRef<VisibleRunRow[]>([])

  useEffect(() => {
    if (!onVisibleRunsChange) return
    if (areVisibleRunRowsEqual(lastNotifiedVisibleRunsRef.current, visibleRuns)) return

    lastNotifiedVisibleRunsRef.current = visibleRuns
    onVisibleRunsChange(visibleRuns)
  }, [onVisibleRunsChange, visibleRuns])

  useEffect(() => {
    if (!selectedRunId) return
    const row = document.querySelector(
      `[data-runs-row-surface="${selectedRunId}"]`,
    ) as HTMLTableRowElement | null
    if (row && document.activeElement !== row) {
      row.focus()
    }
  }, [selectedRunId])

  function renderDuration(run: RunRow) {
    if (run.status === "running" && run.startedAt) {
      return (
        <span className="text-sm tabular-nums">
          <ElapsedTimer startedAt={run.startedAt} />
        </span>
      )
    }
    if (run.status === "running") {
      return <span className="text-sm text-blue-500">Starting...</span>
    }
    return <span className="text-sm text-muted-foreground">{formatDuration(run.duration)}</span>
  }

  function handleRunOpen(run: RunRow, event?: MouseEvent | KeyboardEvent) {
    onSelectedRunIdChange?.(run.id)
    onOpenRun?.(run, event)
  }

  function handleRowKeyDown(
    run: RunRow,
    event: KeyboardEvent<HTMLTableRowElement>,
  ) {
    if (event.key !== "Enter") return
    event.preventDefault()
    handleRunOpen(run, event)
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
        <div className="shrink-0 space-y-4">
          {topSlot}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search runs..."
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              className="max-w-[220px]"
            />
            {onPlatformChange && (
              <Select
                value={platformFilter || "all"}
                onValueChange={(value) => onPlatformChange(value === "all" ? "" : value)}
              >
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
            )}
            {onTargetChange && (
              <Select
                value={targetFilter || "all"}
                onValueChange={(value) => onTargetChange(value === "all" ? "" : value)}
              >
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
            )}
            {onAttributePredicatesChange && (
              <AttributeFilterControl
                predicates={attributePredicates}
                onChange={onAttributePredicatesChange}
              />
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {isLoading && (
                <span className="text-sm text-muted-foreground">Loading...</span>
              )}
              {headerActions}
            </div>
          </div>
        </div>

        <ScrollArea data-tour-id="tour-runs-table" className="min-h-0 flex-1 rounded-md border">
          <Table className="min-w-full table-fixed">
            <colgroup>
              {visibleColumnIds.map((columnId) => (
                <col key={columnId} style={getColumnWidthStyle(columnId)} />
              ))}
            </colgroup>

            <TableHeader>
              {headerGroups.map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={getHeadClassName(header.column.id)}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>

            <TableBody>
              {topLevelRows.length ? (
                topLevelRows.map((row) => {
                  const run = row.original as SuiteRunRow
                  const isSuite = isSuiteParent(run)
                  const isExpanded = isSuite && expandedSuites.has(run.id)
                  const childTests = run.tests ?? []
                  const passedCount = childTests.filter((test) => test.status === "passed").length
                  const rowIsActive = selectedRunId === run.id
                  const rowIsBatchSelected = selectedRunIds.has(run.id)

                  return (
                    <Fragment key={row.id}>
                      <TableRow
                        tabIndex={rowIsActive ? 0 : -1}
                        data-runs-row-surface={run.id}
                        data-active={String(rowIsActive)}
                        data-state={rowIsBatchSelected ? "selected" : undefined}
                        aria-selected={rowIsActive}
                        className={getRowClassName({
                          isActive: rowIsActive,
                          isBatchSelected: rowIsBatchSelected,
                          isChild: false,
                        })}
                        onClick={(event) => handleRunOpen(run, event)}
                        onFocus={() => onSelectedRunIdChange?.(run.id)}
                        onKeyDown={(event) => handleRowKeyDown(run, event)}
                      >
                        {enableSelection && (
                          <TableCell
                            className={getCellClassName("select", false)}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className="flex items-center justify-center">
                              <Checkbox
                                checked={selectedRunIds.has(run.id)}
                                onCheckedChange={(value) => onToggleRunSelection?.(run, value === true)}
                                aria-label="Select row"
                              />
                            </div>
                          </TableCell>
                        )}

                        <TableCell className={getCellClassName("status", false)}>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={run.status} />
                            {isSuite && childTests.length > 0 && (
                              <span className="text-[11px] text-muted-foreground/80 tabular-nums">
                                {passedCount}/{childTests.length}
                              </span>
                            )}
                          </div>
                        </TableCell>

                        <TableCell className={getCellClassName("name", false)}>
                          <div className="flex min-w-0 items-center gap-2.5">
                            {isSuite && (
                              <button
                                type="button"
                                className="rounded p-0.5 hover:bg-muted"
                                onClick={(event) => {
                                  stopRowClick(event)
                                  onToggleSuite?.(run.id)
                                }}
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                              </button>
                            )}
                            <span className="block whitespace-normal break-words text-sm font-medium leading-snug text-foreground">
                              {run.name}
                            </span>
                          </div>
                        </TableCell>

                        <TableCell className={getCellClassName("target", false)}>
                          <span className="block whitespace-normal break-words text-[13px] leading-snug text-muted-foreground/90">
                            {formatTarget(run)}
                          </span>
                        </TableCell>

                        <TableCell className={getCellClassName("attributes", false)}>
                          <AttributeSummary attributes={run.attributes} activeKeys={activeAttributeKeys} />
                        </TableCell>

                        <TableCell className={getCellClassName("duration", false)}>
                          {renderDuration(run)}
                        </TableCell>

                        <TableCell className={getCellClassName("createdAt", false)}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="truncate text-sm text-muted-foreground">
                                {formatDate(run.createdAt)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{formatDateShort(run.createdAt)}</TooltipContent>
                          </Tooltip>
                        </TableCell>

                      </TableRow>

                      {isExpanded && childTests.map((child) => {
                        const childIsActive = selectedRunId === child.id

                        return (
                          <TableRow
                            key={`${row.id}-child-${child.id}`}
                            tabIndex={childIsActive ? 0 : -1}
                            data-runs-row-surface={child.id}
                            data-active={String(childIsActive)}
                            aria-selected={childIsActive}
                            className={getRowClassName({
                              isActive: childIsActive,
                              isBatchSelected: false,
                              isChild: true,
                            })}
                            onClick={(event) => handleRunOpen(child, event)}
                            onFocus={() => onSelectedRunIdChange?.(child.id)}
                            onKeyDown={(event) => handleRowKeyDown(child, event)}
                          >
                            {enableSelection && (
                              <TableCell className={getCellClassName("select", true)} />
                            )}

                            <TableCell className={getCellClassName("status", true)}>
                              <StatusBadge status={child.status} />
                            </TableCell>

                            <TableCell className={getCellClassName("name", true)}>
                              <span className="block whitespace-normal break-words text-sm leading-snug text-foreground/90">
                                {child.name}
                              </span>
                            </TableCell>

                            <TableCell className={getCellClassName("target", true)}>
                              <span className="block whitespace-normal break-words text-[13px] leading-snug text-muted-foreground">
                                {formatTarget(child)}
                              </span>
                            </TableCell>

                            <TableCell className={getCellClassName("attributes", true)}>
                              <AttributeSummary attributes={child.attributes} activeKeys={activeAttributeKeys} />
                            </TableCell>

                            <TableCell className={getCellClassName("duration", true)}>
                              {renderDuration(child)}
                            </TableCell>

                            <TableCell className={getCellClassName("createdAt", true)}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate text-sm text-muted-foreground">
                                    {formatDate(child.createdAt)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{formatDateShort(child.createdAt)}</TooltipContent>
                              </Tooltip>
                            </TableCell>

                          </TableRow>
                        )
                      })}
                    </Fragment>
                  )
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={visibleColumnIds.length} className="h-24 text-center">
                    No results.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <div className="flex items-center justify-between px-1">
          <p className="text-sm text-muted-foreground">
            {total > 0 ? `Showing ${start}-${end} of ${total}` : "No runs found"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1 || totalPages === 0}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
