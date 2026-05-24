import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { useNavigate } from "react-router"
import { ArrowUpDown, FileCode, Keyboard, Plus } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { TableSkeleton } from "@/components/page-skeleton"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { useHooksSearchParams } from "@/hooks/use-hooks-search-params"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import {
  fetchHookCatalog,
  type HookCatalogEntry,
  type HookCatalogResponse,
  type HookRuntime,
} from "@/lib/api"
import { HOOK_RUNTIME_OPTIONS, getHookRuntimeMeta } from "@/lib/hook-runtime"
import { routes } from "@/lib/routes"
import { cn, formatDuration } from "@/lib/utils"

type HookHealth = "ready" | "file-missing"

const EMPTY_CATALOG: HookCatalogResponse = {
  hooks: [],
  filePath: null,
  errors: [],
  missing: false,
}
const HOOKS_TABLE_PAGE_SIZE = 50

function getHookHealth(hook: HookCatalogEntry): HookHealth {
  return hook.fileMissing ? "file-missing" : "ready"
}

function getHealthLabel(health: HookHealth): string {
  return health === "file-missing" ? "File missing" : "Ready"
}

function HealthBadge({ hook }: { hook: HookCatalogEntry }) {
  const health = getHookHealth(hook)
  if (health === "file-missing") {
    return <Badge variant="outline" className="border-amber-500/30 text-amber-600">File missing</Badge>
  }
  return <Badge variant="outline" className="border-emerald-500/30 text-emerald-600">Ready</Badge>
}

function RuntimePill({ runtime }: { runtime: HookRuntime }) {
  const meta = getHookRuntimeMeta(runtime)
  const Icon = meta.icon
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Icon className="h-4 w-4 shrink-0" />
      <span>{meta.label}</span>
    </span>
  )
}

function WarningBanner({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground">{body}</div>
    </div>
  )
}

function getRowClassName({ isActive }: { isActive: boolean }) {
  return cn(
    "cursor-pointer outline-none hover:bg-muted/20 focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
    isActive && "bg-primary/10 ring-1 ring-inset ring-primary/60",
  )
}

export default function HooksPage() {
  usePageTitle("Hooks")

  const navigate = useNavigate()
  const [catalog, setCatalog] = useState<HookCatalogResponse>(EMPTY_CATALOG)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [pageIndex, setPageIndex] = useState(0)
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([])
  const { search, runtime, health, sorting, onSortingChange, setSearch, setRuntime, setHealth } = useHooksSearchParams()

  useEffect(() => {
    let cancelled = false

    fetchHookCatalog()
      .then((response) => {
        if (cancelled) return
        setCatalog(response)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setCatalog(EMPTY_CATALOG)
        setLoadError(error instanceof Error ? error.message : "Failed to load hooks")
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const warningCopy = useMemo(() => {
    if (loadError) {
      return {
        title: "Hooks could not be loaded",
        body: loadError,
      }
    }

    if (catalog.missing) {
      const hookFileLabel = catalog.filePath ?? "configured hooks file"
      return {
        title: `${hookFileLabel} not found`,
        body: "Create the first hook to generate the configured hooks file for this workspace.",
      }
    }

    if (catalog.errors.length > 0) {
      const hookFileLabel = catalog.filePath ?? "configured hooks file"
      return {
        title: `Hooks could not be loaded from ${hookFileLabel}`,
        body: catalog.errors[0] ?? "Unknown registry error",
      }
    }

    return null
  }, [catalog.errors, catalog.filePath, catalog.missing, loadError])

  const filteredHooks = useMemo(() => {
    const query = search.trim().toLowerCase()
    const sort = sorting[0]

    const result = catalog.hooks.filter((hook) => {
      if (runtime && hook.runtime !== runtime) return false
      if (health && getHookHealth(hook) !== health) return false
      if (!query) return true
      return (
        hook.name.toLowerCase().includes(query)
        || hook.file.toLowerCase().includes(query)
        || hook.id.toLowerCase().includes(query)
      )
    })

    if (!sort) return result

        const sorted = [...result].sort((left, right) => {
      let comparison = 0
      switch (sort.id) {
        case "runtime":
          comparison = getHookRuntimeMeta(left.runtime).label.localeCompare(getHookRuntimeMeta(right.runtime).label)
          break
        case "timeout":
          comparison = left.timeout - right.timeout
          break
        case "health":
          comparison = getHealthLabel(getHookHealth(left)).localeCompare(getHealthLabel(getHookHealth(right)))
          break
        case "name":
        default:
          comparison = left.name.localeCompare(right.name)
          break
      }
      return sort.desc ? comparison * -1 : comparison
    })

    return sorted
  }, [catalog.hooks, health, runtime, search, sorting])

  const filteredCount = filteredHooks.length
  const totalPages = Math.ceil(filteredCount / HOOKS_TABLE_PAGE_SIZE)
  const safePageIndex = totalPages > 0 ? Math.min(pageIndex, totalPages - 1) : 0
  const pageStartIndex = safePageIndex * HOOKS_TABLE_PAGE_SIZE
  const visibleHooks = filteredHooks.slice(pageStartIndex, pageStartIndex + HOOKS_TABLE_PAGE_SIZE)
  const pageStart = filteredCount > 0 ? pageStartIndex + 1 : 0
  const pageEnd = Math.min(pageStartIndex + HOOKS_TABLE_PAGE_SIZE, filteredCount)

  useEffect(() => {
    if (pageIndex !== safePageIndex) {
      setPageIndex(safePageIndex)
    }
  }, [pageIndex, safePageIndex])

  const handleSearchChange = useCallback((value: string) => {
    setSelectedIndex(-1)
    setPageIndex(0)
    setSearch(value)
  }, [setSearch])

  const handleRuntimeChange = useCallback((value: string) => {
    setSelectedIndex(-1)
    setPageIndex(0)
    setRuntime(value === "all" ? "" : value)
  }, [setRuntime])

  const handleHealthChange = useCallback((value: string) => {
    setSelectedIndex(-1)
    setPageIndex(0)
    setHealth(value === "all" ? "" : value)
  }, [setHealth])

  const openHook = useCallback((hook: HookCatalogEntry, inNewTab = false) => {
    const href = routes.hookView(hook.id)
    if (inNewTab) {
      window.open(href, "_blank")
      return
    }
    navigate(href)
  }, [navigate])

  const shortcuts = useMemo(() => {
    const next = () => setSelectedIndex((index) => Math.min(index + 1, visibleHooks.length - 1))
    const prev = () => setSelectedIndex((index) => Math.max(index - 1, 0))

    return {
      j: next,
      arrowdown: next,
      k: prev,
      arrowup: prev,
      enter: (event: KeyboardEvent) => {
        if (selectedIndex < 0 || !visibleHooks[selectedIndex]) return
        openHook(visibleHooks[selectedIndex], event.metaKey || event.ctrlKey)
      },
    }
  }, [openHook, selectedIndex, visibleHooks])

  useKeyboardShortcuts(shortcuts)

  useEffect(() => {
    if (visibleHooks.length === 0) {
      if (selectedIndex !== -1) setSelectedIndex(-1)
      return
    }
    if (selectedIndex >= visibleHooks.length) {
      setSelectedIndex(visibleHooks.length - 1)
    }
  }, [selectedIndex, visibleHooks.length])

  useEffect(() => {
    if (selectedIndex < 0) return
    const row = rowRefs.current[selectedIndex]
    if (row && document.activeElement !== row) {
      row.focus()
    }
  }, [selectedIndex, visibleHooks.length])

  const handleRowOpen = useCallback((hook: HookCatalogEntry, event?: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (event) {
      event.preventDefault()
    }
    openHook(hook, Boolean(event && (event.metaKey || event.ctrlKey)))
  }, [openHook])

  function toggleSort(columnId: "name" | "runtime" | "timeout" | "health") {
    setSelectedIndex(-1)
    setPageIndex(0)
    onSortingChange((current) => {
      const existing = current[0]
      if (!existing || existing.id !== columnId) {
        return [{ id: columnId, desc: false }]
      }
      if (!existing.desc) {
        return [{ id: columnId, desc: true }]
      }
      return []
    })
  }

  if (isLoading) {
    return <TableSkeleton />
  }

  const hasNoHooks = filteredCount === 0
  const canCreate = !catalog.errors.length && !loadError

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Hooks</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage reusable setup, teardown, and inline hook scripts for this workspace.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" type="button" aria-label="Keyboard shortcuts">
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="p-3">
                <ShortcutLegend
                  hints={[
                    { key: "J / ↓", label: "Next row" },
                    { key: "K / ↑", label: "Previous row" },
                    { key: "Enter", label: "Open hook" },
                    { key: "⌘+Enter", label: "Open in new tab" },
                  ]}
                />
              </TooltipContent>
            </Tooltip>
            <Button type="button" data-tour-id="tour-hooks-new" onClick={() => navigate(routes.hookNew)}>
              <Plus className="h-4 w-4" />
              Create Hook
            </Button>
          </div>
        </div>

        {warningCopy && (
          <WarningBanner title={warningCopy.title} body={warningCopy.body} />
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <Input
              value={search}
              onChange={(event) => handleSearchChange(event.currentTarget.value)}
              placeholder="Search hooks"
              className="lg:max-w-sm"
              aria-label="Search hooks"
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <Select value={runtime || "all"} onValueChange={handleRuntimeChange}>
                <SelectTrigger className="w-full sm:w-44" aria-label="Runtime filter">
                  <SelectValue placeholder="Runtime" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All runtimes</SelectItem>
                  {HOOK_RUNTIME_OPTIONS.map((runtimeOption) => (
                    <SelectItem key={runtimeOption} value={runtimeOption}>
                      {getHookRuntimeMeta(runtimeOption).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={health || "all"} onValueChange={handleHealthChange}>
                <SelectTrigger className="w-full sm:w-44" aria-label="Health filter">
                  <SelectValue placeholder="Health" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All health</SelectItem>
                  <SelectItem value="ready">Ready</SelectItem>
                  <SelectItem value="file-missing">File missing</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {hasNoHooks ? (
          <div data-tour-id="tour-hooks-table">
            <EmptyState
              icon={FileCode}
              title={catalog.hooks.length === 0 ? "No hooks yet" : "No hooks match your filters"}
              description={
                catalog.hooks.length === 0
                  ? "Create a hook to add reusable setup, teardown, or inline automation to this workspace."
                  : "Adjust your search or filters to see more hook records."
              }
              actionLabel={canCreate ? "Create Hook" : undefined}
              onAction={canCreate ? () => navigate(routes.hookNew) : undefined}
            />
          </div>
        ) : (
          <>
            <ScrollArea data-tour-id="tour-hooks-table" className="rounded-md border">
              <Table className="min-w-full">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40%]">
                      <Button type="button" variant="ghost" className="-ml-3" onClick={() => toggleSort("name")}>
                        Hook
                        <ArrowUpDown className="h-4 w-4" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button type="button" variant="ghost" className="-ml-3" onClick={() => toggleSort("runtime")}>
                        Runtime
                        <ArrowUpDown className="h-4 w-4" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button type="button" variant="ghost" className="-ml-3" onClick={() => toggleSort("timeout")}>
                        Timeout / Network
                        <ArrowUpDown className="h-4 w-4" />
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button type="button" variant="ghost" className="-ml-3" onClick={() => toggleSort("health")}>
                        Health
                        <ArrowUpDown className="h-4 w-4" />
                      </Button>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleHooks.map((hook, index) => {
                    const rowIsActive = index === selectedIndex

                    return (
                      <TableRow
                        key={hook.id}
                        ref={(element) => {
                          rowRefs.current[index] = element
                        }}
                        data-hooks-row-surface={hook.id}
                        tabIndex={rowIsActive ? 0 : -1}
                        aria-selected={rowIsActive}
                        className={getRowClassName({ isActive: rowIsActive })}
                        onClick={() => {
                          setSelectedIndex(index)
                          openHook(hook)
                        }}
                        onFocus={() => setSelectedIndex(index)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            handleRowOpen(hook, event)
                          }
                        }}
                      >
                        <TableCell className="max-w-0">
                          <div className="min-w-0 space-y-1">
                            <div className="truncate text-sm font-medium text-foreground">{hook.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{hook.file}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <RuntimePill runtime={hook.runtime} />
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="text-sm text-foreground">{formatDuration(hook.timeout)}</div>
                            <div className="text-xs text-muted-foreground">
                              {hook.network ? "Network on" : "Network off"}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <HealthBadge hook={hook} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
            <div className="flex items-center justify-between px-2">
              <p className="text-sm text-muted-foreground">
                Showing {pageStart}-{pageEnd} of {filteredCount}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedIndex(-1)
                    setPageIndex((current) => Math.max(current - 1, 0))
                  }}
                  disabled={safePageIndex === 0}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedIndex(-1)
                    setPageIndex((current) => Math.min(current + 1, Math.max(totalPages - 1, 0)))
                  }}
                  disabled={safePageIndex >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
