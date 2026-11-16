import { useEffect, useMemo, useState } from 'react'

import type { HookCatalogEntry, HookCatalogResponse } from '@/lib/api'
import { fetchHookCatalog } from '@/lib/api'
import { useTranslation } from '@/i18n'

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
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<HookCatalogResponse>(EMPTY_CATALOG)
  const [loadError, setLoadError] = useState<{ message?: string } | null>(null)

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
        setLoadError(error instanceof Error ? { message: error.message } : {})
      })

    return () => {
      cancelled = true
    }
  }, [])

  const hookFileLabel = catalog.filePath ?? t('editor.forms.hooks.configuredFile')
  const hooks = useMemo(
    () => [...catalog.hooks].sort((left, right) => left.name.localeCompare(right.name)),
    [catalog.hooks],
  )

  const warningCopy = useMemo(() => {
    if (loadError) {
      return {
        title: t('editor.forms.hooks.notLoadedTitle'),
        body: t('editor.forms.hooks.notLoadedBody', {
          reason: loadError.message ?? t('editor.forms.hooks.loadFailed'),
        }),
      }
    }

    if (catalog.missing) {
      return {
        title: t('editor.forms.hooks.missingTitle', { file: hookFileLabel }),
        body: t('editor.forms.hooks.missingBody'),
      }
    }

    if (catalog.errors.length > 0) {
      return {
        title: t('editor.forms.hooks.notLoadedFromTitle', { file: hookFileLabel }),
        body: t('editor.forms.hooks.notLoadedBody', { reason: catalog.errors[0] }),
      }
    }

    return null
  }, [catalog.errors, catalog.missing, hookFileLabel, loadError, t])

  return {
    hooks,
    warningCopy,
  }
}
