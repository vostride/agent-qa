import { useCallback, useEffect, useState } from "react"
import { BrainCircuit } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import type { MemoryInvalidFile, MemoryWorkspaceObservation } from "@/lib/api"
import { fetchMemoryScope } from "@/lib/api"
import { ObservationBlock } from "@/pages/memory-product/observation-block"

interface SharedScopeMemoryReaderProps {
  scope: "suite" | "test"
  scopeId: string
  emptyTitle?: string
  emptyDescription?: string
}

export function SharedScopeMemoryReader({
  scope,
  scopeId,
  emptyTitle = `No ${scope} memory yet`,
  emptyDescription = `This ${scope} doesn't have cataloged observations in this workspace yet. Run the ${scope} with memory enabled, then reopen this tab.`,
}: SharedScopeMemoryReaderProps) {
  const [observations, setObservations] = useState<MemoryWorkspaceObservation[]>([])
  const [invalidFiles, setInvalidFiles] = useState<MemoryInvalidFile[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadObservations = useCallback(() => {
    let cancelled = false
    setIsLoading(true)
    setLoadError(null)
    setInvalidFiles([])

    fetchMemoryScope(scope, scopeId)
      .then((response) => {
        if (cancelled) return
        setObservations(response.observations)
        setInvalidFiles(response.invalidFiles)
        setIsLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setObservations([])
        setInvalidFiles([])
        setLoadError(error instanceof Error ? error.message : "Failed to load memory")
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [scope, scopeId])

  useEffect(() => {
    return loadObservations()
  }, [loadObservations])

  const heading = scope === "test" ? "Test memory" : "Suite memory"

  if (isLoading) {
    return (
      <div data-shared-scope-memory-reader="true" className="min-h-full w-full">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
          <div className="space-y-5">
            <Skeleton className="h-7 w-32" />
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div data-shared-scope-memory-reader="true" className="min-h-full w-full">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
          <div className="rounded-md border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            Couldn&apos;t load this {scope} memory. Refresh the page. If it continues, verify the dashboard server can read the workspace memory directory.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-shared-scope-memory-reader="true" className="min-h-full w-full">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
        {invalidFiles.length > 0 ? <InvalidFilesNotice invalidFiles={invalidFiles} /> : null}
        <h2 className="text-base font-medium tracking-tight text-foreground">{heading}</h2>

        {observations.length === 0 ? (
          <div className="pt-4">
            <EmptyState
              icon={BrainCircuit}
              title={emptyTitle}
              description={emptyDescription}
            />
          </div>
        ) : (
          <article className="mt-6 divide-y divide-border/60">
            {observations.map((observation) => (
              <section key={observation.id} className="py-6 first:pt-0 last:pb-0">
                <ObservationBlock observation={observation} query="" />
              </section>
            ))}
          </article>
        )}
      </div>
    </div>
  )
}

function InvalidFilesNotice({ invalidFiles }: { invalidFiles: MemoryInvalidFile[] }) {
  return (
    <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-200">
      <p className="font-medium">
        {invalidFiles.length} invalid memory file{invalidFiles.length === 1 ? "" : "s"} hidden from this reader.
      </p>
      <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
        {invalidFiles.map((file) => file.filename).join(", ")}
      </p>
    </div>
  )
}
