import { useCallback, useEffect, useState } from 'react'
import { BrainCircuit, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { ObservationCard } from '@/components/observation-card'
import type { MemoryInvalidFile, ObservationSummary } from '@/lib/api'
import { fetchTestObservations, deleteTestObservation } from '@/lib/api'

interface MemoryObservationsPanelProps {
  testId: string
}

export function MemoryObservationsPanel({ testId }: MemoryObservationsPanelProps) {
  const [observations, setObservations] = useState<ObservationSummary[]>([])
  const [invalidFiles, setInvalidFiles] = useState<MemoryInvalidFile[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadObservations = useCallback(() => {
    let cancelled = false
    setIsLoading(true)
    setLoadError(null)
    setInvalidFiles([])

    fetchTestObservations(testId)
      .then((response) => {
        if (cancelled) return
        setObservations(response.observations)
        setInvalidFiles(response.invalidFiles)
        setIsLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setObservations([])
        setLoadError(error instanceof Error ? error.message : 'Failed to load observations')
        setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [testId])

  useEffect(() => {
    return loadObservations()
  }, [loadObservations])

  const handleDelete = useCallback(async (obsId: string) => {
    setDeletingId(obsId)
    try {
      await deleteTestObservation(testId, obsId)
      setObservations((prev) => prev.filter((o) => o.id !== obsId))
      toast.success('Observation deleted')
    } catch (err: unknown) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingId(null)
    }
  }, [testId])

  if (isLoading) {
    return (
      <div className="space-y-2 px-4 py-2">
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Could not load observations. Check that the dashboard server is running and try again.
        </p>
        <Button variant="outline" size="sm" onClick={loadObservations}>
          <RefreshCw className="mr-1.5 size-3.5" />
          Retry
        </Button>
      </div>
    )
  }

  if (observations.length === 0) {
    return (
      <div className="space-y-3 px-4 py-2">
        {invalidFiles.length > 0 ? <InvalidFilesNotice invalidFiles={invalidFiles} /> : null}
        <EmptyState
          icon={BrainCircuit}
          title="No observations yet"
          description="Memory observations are created automatically when this test runs. They help the agent remember facts about your product."
        />
      </div>
    )
  }

  return (
    <div className="space-y-2 px-4 py-2">
      {invalidFiles.length > 0 ? <InvalidFilesNotice invalidFiles={invalidFiles} /> : null}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {observations.length} observation{observations.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="space-y-2">
        {observations.map((obs) => (
          <ObservationCard
            key={obs.id}
            observation={obs}
            onDelete={handleDelete}
            isDeleting={deletingId === obs.id}
          />
        ))}
      </div>
    </div>
  )
}

function InvalidFilesNotice({ invalidFiles }: { invalidFiles: MemoryInvalidFile[] }) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-200">
      <p className="font-medium">
        {invalidFiles.length} invalid memory file{invalidFiles.length === 1 ? '' : 's'} hidden from this panel.
      </p>
      <p className="mt-1 text-[11px] text-amber-900/80 dark:text-amber-200/80">
        {invalidFiles.map((file) => file.filename).join(', ')}
      </p>
    </div>
  )
}
