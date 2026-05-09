import { useCallback, useEffect, useMemo, useState } from "react"
import { BrainCircuit } from "lucide-react"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePageTitle } from "@/hooks/use-page-title"
import { ApiError, fetchMemoryProductDetail, type MemoryProductDetail } from "@/lib/api"
import { routes } from "@/lib/routes"
import { ObservationBlock } from "@/pages/memory-product/observation-block"
import { WorkspaceFilterRail } from "@/pages/memory-product/workspace-filter-rail"
import { WorkspaceNavbar } from "@/pages/memory-product/workspace-navbar"
import { WorkspaceOutline } from "@/pages/memory-product/workspace-outline"
import {
  applyWorkspaceFilters,
  buildWorkspaceDocument,
  DEFAULT_WORKSPACE_FILTERS,
  listWorkspaceOutlineAnchorIds,
  serializeWorkspaceMarkdown,
  type WorkspaceDateBasis,
  type WorkspaceDateWindow,
  type WorkspaceDocument,
  type WorkspaceFilters,
} from "@/pages/memory-product/workspace-model"

export default function MemoryProductPage() {
  const { product } = useParams()
  usePageTitle(product ? `Memory · ${product}` : "Memory")
  const navigate = useNavigate()

  const [detail, setDetail] = useState<MemoryProductDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [filters, setFilters] = useState<WorkspaceFilters>(DEFAULT_WORKSPACE_FILTERS)
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const isMobile = useIsMobile()

  const loadDetail = useCallback(() => {
    if (!product) {
      setIsLoading(false)
      setNotFound(true)
      return () => {}
    }

    let cancelled = false
    setIsLoading(true)
    setHasError(false)
    setNotFound(false)

    fetchMemoryProductDetail(product)
      .then((response) => {
        if (cancelled) return
        setDetail(response.product)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setDetail(null)
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true)
          return
        }
        setHasError(true)
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [product])

  useEffect(() => loadDetail(), [loadDetail])
  useEffect(() => {
    setFilters(DEFAULT_WORKSPACE_FILTERS)
  }, [product])
  useEffect(() => {
    setShortcutsOpen(false)
  }, [product])

  const now = useMemo(() => new Date(), [product])
  const fullDocument = useMemo(
    () =>
      detail ? buildWorkspaceDocument(detail.productKey, detail.observations) : null,
    [detail],
  )
  const visibleObservations = useMemo(
    () =>
      detail ? applyWorkspaceFilters(detail.observations, filters, now) : [],
    [detail, filters, now],
  )
  const visibleDocument = useMemo(
    () =>
      detail ? buildWorkspaceDocument(detail.productKey, visibleObservations) : null,
    [detail, visibleObservations],
  )
  const copyMarkdown = useMemo(
    () =>
      fullDocument && detail
        ? serializeWorkspaceMarkdown(fullDocument, detail.invalidFiles)
        : null,
    [detail, fullDocument],
  )
  const orderedAnchorIds = useMemo(
    () => (visibleDocument ? listWorkspaceOutlineAnchorIds(visibleDocument.outline) : []),
    [visibleDocument],
  )

  useEffect(() => {
    if (!visibleDocument) {
      setActiveAnchorId(null)
      return
    }

    const anchorIds = listWorkspaceOutlineAnchorIds(visibleDocument.outline)
    setActiveAnchorId((current) =>
      current && anchorIds.includes(current) ? current : anchorIds[0] ?? null,
    )

    if (typeof IntersectionObserver === "undefined") {
      return
    }

    const order = new Map(anchorIds.map((anchorId, index) => [anchorId, index]))
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => {
            const ratioDelta = right.intersectionRatio - left.intersectionRatio
            if (ratioDelta !== 0) {
              return ratioDelta
            }

            return (
              (order.get(left.target.id) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(right.target.id) ?? Number.MAX_SAFE_INTEGER)
            )
          })

        const activeEntry = visibleEntries[0]
        if (activeEntry) {
          setActiveAnchorId(activeEntry.target.id)
        }
      },
      {
        rootMargin: "-72px 0px -55% 0px",
        threshold: [0.2, 0.6, 1],
      },
    )

    for (const anchorId of anchorIds) {
      const element = document.getElementById(anchorId)
      if (element) {
        observer.observe(element)
      }
    }

    return () => observer.disconnect()
  }, [visibleDocument])

  const handleNavigateToAnchor = useCallback((anchorId: string) => {
    setActiveAnchorId(anchorId)
    document.getElementById(anchorId)?.scrollIntoView({ block: "start" })
  }, [])
  const handleCopyPage = useCallback(async () => {
    if (!copyMarkdown) {
      return
    }

    try {
      await navigator.clipboard.writeText(copyMarkdown)
      toast.success("Copied page as Markdown")
    } catch {
      toast.error("Couldn't copy page")
    }
  }, [copyMarkdown])
  const moveActiveAnchor = useCallback(
    (direction: 1 | -1) => {
      if (orderedAnchorIds.length === 0) {
        return
      }

      const currentIndex = activeAnchorId
        ? orderedAnchorIds.indexOf(activeAnchorId)
        : -1
      const nextIndex =
        currentIndex < 0
          ? 0
          : Math.min(
              orderedAnchorIds.length - 1,
              Math.max(0, currentIndex + direction),
            )
      const nextAnchorId = orderedAnchorIds[nextIndex]

      if (!nextAnchorId) {
        return
      }

      handleNavigateToAnchor(nextAnchorId)
    },
    [activeAnchorId, handleNavigateToAnchor, orderedAnchorIds],
  )

  const handleConfidenceChange = useCallback(
    (confidence: WorkspaceFilters["confidence"]) => {
      setFilters((current) => ({ ...current, confidence }))
    },
    [],
  )
  const handleDateBasisChange = useCallback((dateBasis: WorkspaceDateBasis) => {
    setFilters((current) => ({ ...current, dateBasis }))
  }, [])
  const handleDateWindowChange = useCallback(
    (dateWindow: WorkspaceDateWindow) => {
      setFilters((current) => ({ ...current, dateWindow }))
    },
    [],
  )

  const shortcuts = useMemo(
    () => ({
      j: () => moveActiveAnchor(1),
      arrowdown: () => moveActiveAnchor(1),
      k: () => moveActiveAnchor(-1),
      arrowup: () => moveActiveAnchor(-1),
      c: () => {
        void handleCopyPage()
      },
      "shift+?": () => setShortcutsOpen((current) => !current),
      escape: () => setShortcutsOpen(false),
    }),
    [handleCopyPage, moveActiveAnchor],
  )

  useKeyboardShortcuts(shortcuts)

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-3">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-28 w-full rounded-md" />
        <Skeleton className="h-56 w-full rounded-md" />
      </div>
    )
  }

  if (notFound) {
    return (
      <EmptyState
        icon={BrainCircuit}
        title="Memory not found for this product"
        description="This product doesn't currently have cataloged memory in this workspace, or the product key changed."
        actionLabel="Back to Memory"
        onAction={() => navigate(routes.memory)}
      />
    )
  }

  if (hasError || !detail) {
    return (
      <div className="rounded-md border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Couldn't load this memory workspace. Refresh the page. If it continues,
          verify the dashboard server can read the workspace memory directory.
        </p>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <WorkspaceNavbar
          onCopyPage={handleCopyPage}
          onShortcutsOpenChange={setShortcutsOpen}
          productKey={detail.productKey}
          shortcutsOpen={shortcutsOpen}
        />

        {isMobile ? (
          <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 py-3">
            <MobileWorkspaceLayout
              activeAnchorId={activeAnchorId}
              detail={detail}
              document={visibleDocument}
              filters={filters}
              onConfidenceChange={handleConfidenceChange}
              onDateBasisChange={handleDateBasisChange}
              onDateWindowChange={handleDateWindowChange}
              onNavigate={handleNavigateToAnchor}
            />
          </div>
        ) : (
          <div
            data-workspace-shell="true"
            className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_14rem] overflow-hidden"
          >
            <aside className="workspace-scrollbar min-h-0 overflow-y-auto overscroll-y-contain border-r border-border bg-background">
              <div className="min-h-full px-3 py-3">
                {visibleDocument ? (
                  <WorkspaceOutline
                    activeAnchorId={activeAnchorId}
                    document={visibleDocument}
                    onNavigate={handleNavigateToAnchor}
                  />
                ) : null}
              </div>
            </aside>

            <div className="workspace-scrollbar min-h-0 min-w-0 overflow-y-auto overscroll-y-contain bg-muted/[0.04]">
              <MemoryWorkspaceReader detail={detail} document={visibleDocument} />
            </div>

            <aside className="workspace-scrollbar min-h-0 overflow-y-auto overscroll-y-contain border-l border-border bg-background">
              <div className="min-h-full px-3 py-3">
                <WorkspaceFilterRail
                  filters={filters}
                  onConfidenceChange={handleConfidenceChange}
                  onDateBasisChange={handleDateBasisChange}
                  onDateWindowChange={handleDateWindowChange}
                />
              </div>
            </aside>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

function MobileWorkspaceLayout({
  activeAnchorId,
  detail,
  document,
  filters,
  onConfidenceChange,
  onDateBasisChange,
  onDateWindowChange,
  onNavigate,
}: {
  activeAnchorId: string | null
  detail: MemoryProductDetail
  document: WorkspaceDocument | null
  filters: WorkspaceFilters
  onConfidenceChange: (confidence: WorkspaceFilters["confidence"]) => void
  onDateBasisChange: (dateBasis: WorkspaceDateBasis) => void
  onDateWindowChange: (dateWindow: WorkspaceDateWindow) => void
  onNavigate: (anchorId: string) => void
}) {
  return (
    <div className="space-y-4">
      {document ? (
        <details className="border bg-card px-3 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            On this page
          </summary>
          <div className="mt-3">
            <WorkspaceOutline
              activeAnchorId={activeAnchorId}
              document={document}
              onNavigate={onNavigate}
              showHeading={false}
            />
          </div>
        </details>
      ) : null}

      <details className="border bg-card px-3 py-2.5">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Filters
        </summary>
        <div className="mt-3">
          <WorkspaceFilterRail
            filters={filters}
            onConfidenceChange={onConfidenceChange}
            onDateBasisChange={onDateBasisChange}
            onDateWindowChange={onDateWindowChange}
            showHeading={false}
          />
        </div>
      </details>

      <MemoryWorkspaceReader detail={detail} document={document} />
    </div>
  )
}

function MemoryWorkspaceReader({
  detail,
  document,
}: {
  detail: MemoryProductDetail
  document: WorkspaceDocument | null
}) {
  return (
    <div
      data-workspace-reader-page="true"
      className="min-h-full w-full bg-card/55"
    >
      <div className="px-4 py-4 sm:px-5">
        {detail.invalidFiles.length > 0 ? (
          <div className="mb-4 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-200">
            <p className="font-medium">
              {detail.invalidFiles.length} invalid memory file{detail.invalidFiles.length === 1 ? "" : "s"} hidden from this workspace.
            </p>
            <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
              {detail.invalidFiles.map((file) => file.filename).join(", ")}
            </p>
          </div>
        ) : null}

        {detail.observations.length === 0 ? (
          <EmptyState
            icon={BrainCircuit}
            title="No memory in this product yet"
            description="This product doesn't have cataloged observations in this workspace yet. Run tests or suites with memory enabled, then reopen this workspace."
          />
        ) : document && hasVisibleObservations(document) ? (
          <article className="w-full space-y-10">
            {document.sections.map((section) => (
              <section
                key={section.id}
                id={section.anchorId}
                data-workspace-section={section.id}
                className="scroll-mt-20 space-y-5"
              >
                <header className="border-b pb-3">
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {section.title}
                  </h2>
                </header>

                {section.groups.length > 0 ? (
                  <div className="space-y-8">
                    {section.groups.map((group) => (
                      <div key={group.anchorId} className="space-y-5">
                        <div id={group.anchorId} className="scroll-mt-20">
                          {group.title ? (
                            <h3 className="text-base font-medium tracking-tight text-foreground">
                              {group.title}
                            </h3>
                          ) : (
                            <span className="sr-only">Product observations</span>
                          )}
                        </div>

                        <div className="space-y-8">
                          {group.observations.map((entry) => (
                            <div
                              key={entry.observation.id}
                              id={entry.anchorId}
                              className="scroll-mt-24"
                            >
                              <ObservationBlock
                                observation={entry.observation}
                                query=""
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No {section.title.toLowerCase()} observations in this workspace yet.
                  </p>
                )}
              </section>
            ))}
          </article>
        ) : (
          <EmptyState
            icon={BrainCircuit}
            title="No observations match these filters"
            description="Clear one or more filters to return to the full document."
          />
        )}
      </div>
    </div>
  )
}

function hasVisibleObservations(document: WorkspaceDocument) {
  return document.sections.some((section) =>
    section.groups.some((group) => group.observations.length > 0),
  )
}
