import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { BrainCircuit, Keyboard } from "lucide-react"
import { useNavigate } from "react-router"

import { EmptyState } from "@/components/empty-state"
import { TableSkeleton } from "@/components/page-skeleton"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { usePageTitle } from "@/hooks/use-page-title"
import { fetchMemoryCatalog, type MemoryCatalogProduct } from "@/lib/api"
import { routes } from "@/lib/routes"
import { cn, formatDate, formatDateShort } from "@/lib/utils"

const MAX_VISIBLE_TARGET_REFERENCES = 3
const MEMORY_SCAN_COLUMN_WIDTHS = {
  scope: "9rem",
  source: "8rem",
  lastConfirmed: "9rem",
} as const

type MemoryColumnId = "product" | keyof typeof MEMORY_SCAN_COLUMN_WIDTHS

export default function MemoryPage() {
  usePageTitle("Memory")

  const navigate = useNavigate()
  const [products, setProducts] = useState<MemoryCatalogProduct[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([])

  const loadCatalog = useCallback(() => {
    let cancelled = false
    setIsLoading(true)
    setHasError(false)

    fetchMemoryCatalog()
      .then((response) => {
        if (cancelled) return
        setProducts(response.products)
      })
      .catch(() => {
        if (cancelled) return
        setProducts([])
        setHasError(true)
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => loadCatalog(), [loadCatalog])

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return products
    return products.filter((product) => product.productKey.toLowerCase().includes(query))
  }, [products, search])

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    setSelectedIndex(-1)
  }, [])

  const handleRowOpen = useCallback((product: MemoryCatalogProduct, event?: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (event) {
      event.preventDefault()
    }
    navigate(routes.memoryProduct(product.productKey))
  }, [navigate])

  const shortcuts = useMemo(() => {
    const next = () => setSelectedIndex((index) => Math.min(index + 1, filteredProducts.length - 1))
    const prev = () => setSelectedIndex((index) => Math.max(index - 1, 0))

    return {
      j: next,
      arrowdown: next,
      k: prev,
      arrowup: prev,
      enter: (event: KeyboardEvent) => {
        if (selectedIndex < 0 || !filteredProducts[selectedIndex]) return
        const product = filteredProducts[selectedIndex]
        const href = routes.memoryProduct(product.productKey)

        if (event.metaKey || event.ctrlKey) {
          window.open(href, "_blank")
          return
        }

        navigate(href)
      },
    }
  }, [filteredProducts, navigate, selectedIndex])

  useKeyboardShortcuts(shortcuts)

  useEffect(() => {
    if (selectedIndex < 0) return
    const row = rowRefs.current[selectedIndex]
    if (row && document.activeElement !== row) {
      row.focus()
    }
  }, [selectedIndex, filteredProducts.length])

  if (isLoading) return <TableSkeleton />

  if (hasError) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <div className="rounded-md border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            Couldn't load memory. Refresh the page. If it continues, verify the dashboard server can read the workspace memory directory.
          </p>
          <Button className="mt-4" variant="outline" onClick={loadCatalog}>
            Refresh
          </Button>
        </div>
      </div>
    )
  }

  if (products.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <div data-tour-id="tour-memory-table">
          <EmptyState
            icon={BrainCircuit}
            title="No product memory yet"
            description="Run tests or suites with memory enabled to build memory for this workspace."
            actionLabel="Open Runs"
            onAction={() => navigate(routes.runs)}
          />
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <PageHeader actions={<MemoryShortcutsButton />} />

        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search products"
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="max-w-[220px]"
          />
        </div>

        <ScrollArea data-tour-id="tour-memory-table" className="rounded-md border">
          <Table className="min-w-full table-fixed">
            <colgroup>
              <col data-column-id="product" />
              <col data-column-id="scope" style={{ width: MEMORY_SCAN_COLUMN_WIDTHS.scope }} />
              <col data-column-id="source" style={{ width: MEMORY_SCAN_COLUMN_WIDTHS.source }} />
              <col
                data-column-id="lastConfirmed"
                style={{ width: MEMORY_SCAN_COLUMN_WIDTHS.lastConfirmed }}
              />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead data-column-id="product" className={getHeaderClassName("product")}>
                  Product
                </TableHead>
                <TableHead data-column-id="scope" className={getHeaderClassName("scope")}>
                  Product / Suite / Test
                </TableHead>
                <TableHead data-column-id="source" className={getHeaderClassName("source")}>
                  Suite / Test
                </TableHead>
                <TableHead
                  data-column-id="lastConfirmed"
                  className={getHeaderClassName("lastConfirmed")}
                >
                  Last confirmed
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProducts.length > 0 ? (
                filteredProducts.map((product, index) => {
                  const isActive = index === selectedIndex
                  const targetSummary = summarizeTargetReferences(product.targetReferences)
                  const groupedScopeCounts = [
                    product.scopeCounts.product,
                    product.scopeCounts.suite,
                    product.scopeCounts.test,
                  ].join(" / ")
                  const groupedSourceCounts = [
                    product.sourceCounts.suite,
                    product.sourceCounts.test,
                  ].join(" / ")

                  return (
                    <TableRow
                      key={product.productKey}
                      ref={(element) => {
                        rowRefs.current[index] = element
                      }}
                      data-memory-product={product.productKey}
                      tabIndex={isActive ? 0 : -1}
                      aria-selected={isActive}
                      className={getRowClassName(isActive)}
                      onClick={() => {
                        setSelectedIndex(index)
                        handleRowOpen(product)
                      }}
                      onFocus={() => setSelectedIndex(index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          handleRowOpen(product, event)
                        }
                      }}
                    >
                      <TableCell data-column-id="product" className={getCellClassName("product")}>
                        <div className="min-w-0 space-y-1">
                          <span className="block whitespace-normal break-words text-sm font-medium leading-snug text-foreground">
                            {product.productKey}
                          </span>
                          {targetSummary ? (
                            <span
                              data-memory-targets
                              title={product.targetReferences.join(", ")}
                              className="block truncate text-xs leading-snug text-muted-foreground"
                            >
                              {targetSummary}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell data-column-id="scope" className={getCellClassName("scope")}>
                        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-foreground">
                          {groupedScopeCounts}
                        </span>
                      </TableCell>
                      <TableCell data-column-id="source" className={getCellClassName("source")}>
                        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-foreground">
                          {groupedSourceCounts}
                        </span>
                      </TableCell>
                      <TableCell
                        data-column-id="lastConfirmed"
                        className={getCellClassName("lastConfirmed")}
                      >
                        {product.freshness ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate text-sm text-muted-foreground">
                                {formatDate(product.freshness)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{formatDateShort(product.freshness)}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="block truncate text-sm text-muted-foreground">
                            No confirmations yet
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-sm text-muted-foreground">
                    No matching products.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
    </TooltipProvider>
  )
}

function PageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="space-y-1">
      <div className="flex w-full items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Browse what the agent has learned for each product.
      </p>
    </header>
  )
}

function MemoryShortcutsButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
          <Keyboard className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="space-y-2 p-3">
        <p className="text-xs font-medium text-foreground">Keyboard shortcuts</p>
        <ShortcutLegend
          hints={[
            { key: "J / ↓", label: "Next row" },
            { key: "K / ↑", label: "Previous row" },
            { key: "Enter", label: "Open memory" },
            { key: "⌘ / Ctrl+Enter", label: "Open in new tab" },
          ]}
        />
      </TooltipContent>
    </Tooltip>
  )
}

function getHeaderClassName(columnId: MemoryColumnId) {
  return cn(
    "h-10 bg-background px-3 text-[13px] font-medium text-foreground/90",
    columnId !== "product" && "text-right",
  )
}

function getCellClassName(columnId: MemoryColumnId) {
  return cn(
    "py-2 align-top",
    columnId === "product" && "max-w-0 px-3",
    (columnId === "scope" || columnId === "source") && "px-3 text-right",
    columnId === "lastConfirmed" && "max-w-0 px-3 text-right",
  )
}

function getRowClassName(isActive: boolean) {
  return cn(
    "cursor-pointer outline-none hover:bg-muted/20 focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
    isActive && "bg-primary/10 ring-1 ring-inset ring-primary/60",
  )
}

function summarizeTargetReferences(targetReferences: string[]): string | null {
  if (targetReferences.length === 0) {
    return null
  }

  const visibleTargets = targetReferences.slice(0, MAX_VISIBLE_TARGET_REFERENCES)
  const remainingCount = targetReferences.length - visibleTargets.length

  if (remainingCount <= 0) {
    return visibleTargets.join(", ")
  }

  return `${visibleTargets.join(", ")}, +${remainingCount} more`
}
