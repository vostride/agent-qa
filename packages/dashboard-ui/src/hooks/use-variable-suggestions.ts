import { useEffect, useMemo, useState } from 'react'
import { fetchEnvVarKeys, fetchHookCatalog, fetchCapturedVarNames } from '@/lib/api'
import { useTranslation } from '@/i18n'

export interface VariableSuggestion {
  namespace: string
  name: string
  label: string
  insertValue?: string
  description?: string
}

interface UseVariableSuggestionsResult {
  suggestions: VariableSuggestion[]
  isLoading: boolean
}

export function useVariableSuggestions(testId: string | null): UseVariableSuggestionsResult {
  const [envKeys, setEnvKeys] = useState<string[]>([])
  const [hookSuggestions, setHookSuggestions] = useState<Array<{ id: string; name: string }>>([])
  const [capturedNames, setCapturedNames] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)

    const promises: Promise<void>[] = [
      fetchEnvVarKeys()
        .then((r) => { if (!cancelled) setEnvKeys(r.keys) })
        .catch(() => { if (!cancelled) setEnvKeys([]) }),
      fetchHookCatalog()
        .then((r) => {
          if (!cancelled) {
            setHookSuggestions(r.hooks.map((hook) => ({ id: hook.id, name: hook.name })))
          }
        })
        .catch(() => { if (!cancelled) setHookSuggestions([]) }),
    ]

    if (testId) {
      promises.push(
        fetchCapturedVarNames(testId)
          .then((r) => { if (!cancelled) setCapturedNames(r.names) })
          .catch(() => { if (!cancelled) setCapturedNames([]) }),
      )
    }

    Promise.allSettled(promises).then(() => {
      if (!cancelled) setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [testId])

  const suggestions = useMemo(() => {
    const result: VariableSuggestion[] = []
    for (const key of envKeys) {
      result.push({ namespace: 'env', name: key, label: t('editor.suggestions.group.env') })
    }
    for (const hook of hookSuggestions) {
      result.push({
        namespace: 'runHook',
        name: hook.name,
        label: t('editor.suggestions.group.hook'),
        insertValue: hook.id,
        description: hook.id,
      })
    }
    for (const name of capturedNames) {
      result.push({ namespace: 'capture', name, label: t('editor.suggestions.group.captured') })
    }
    result.push(
      { namespace: 'runJS', name: 'document.title', label: t('editor.suggestions.runJs.pageTitle') },
      {
        namespace: 'runJS',
        name: 'Date.now()',
        label: t('editor.suggestions.runJs.currentTimestamp'),
      },
      {
        namespace: 'runJS',
        name: 'window.location.href',
        label: t('editor.suggestions.runJs.currentUrl'),
      },
      {
        namespace: 'runJS',
        name: "document.querySelector('...').textContent",
        label: t('editor.suggestions.runJs.elementText'),
      },
    )
    return result
  }, [envKeys, hookSuggestions, capturedNames, t])

  return { suggestions, isLoading }
}
