import { useEffect, useMemo, useState } from 'react'

import type { HookCatalogEntry, HookCatalogResponse } from '@/lib/api'
import { fetchHookCatalog } from '@/lib/api'

interface WarningCopy {
  title: string
  body: string
}

interface UseTestHookCatalogResult {
  hooks: HookCatalogEntry[]
  warningCopy: WarningCopy | null
}

const EMPTY_CATALOG: HookCatalogResponse = {
  hooks: [],
  filePath: null,
  errors: [],
  missing: false,
}

export function useTestHookCatalog(): UseTestHookCatalogResult {
  const [catalog, setCatalog] = useState<HookCatalogResponse>(EMPTY_CATALOG)
  const [loadError, setLoadError] = useState<string | null>(null)

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
        setLoadError(error instanceof Error ? error.message : 'Failed to load hooks')
      })

    return () => {
      cancelled = true
    }
  }, [])

  const hookFileLabel = catalog.filePath ?? 'configured hooks file'
  const hooks = useMemo(
    () => [...catalog.hooks].sort((left, right) => left.name.localeCompare(right.name)),
    [catalog.hooks],
  )

  const warningCopy = useMemo(() => {
    if (loadError) {
      return {
        title: 'Hooks could not be loaded',
        body: `${loadError}. You can still paste canonical h_ IDs, but validate before running.`,
      }
    }

    if (catalog.missing) {
      return {
        title: `${hookFileLabel} not found`,
        body: 'You can still paste canonical h_ IDs. Setup runs before the live session starts; teardown runs after it ends.',
      }
    }

    if (catalog.errors.length > 0) {
      return {
        title: `Hooks could not be loaded from ${hookFileLabel}`,
        body: `${catalog.errors[0]}. You can still paste canonical h_ IDs, but validate before running.`,
      }
    }

    return null
  }, [catalog.errors, catalog.missing, hookFileLabel, loadError])

  return {
    hooks,
    warningCopy,
  }
}
