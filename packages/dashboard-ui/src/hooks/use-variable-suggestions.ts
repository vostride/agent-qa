import { useEffect, useMemo, useState } from 'react'
import { fetchEnvVarKeys, fetchHookCatalog, fetchCapturedVarNames } from '@/lib/api'

export interface VariableSuggestion {
  namespace: string
  name: string
  label: string
  insertValue?: string
  description?: string
}

const RUNJS_SNIPPETS: VariableSuggestion[] = [
  { namespace: 'runJS', name: 'document.title', label: 'Page title' },
  { namespace: 'runJS', name: 'Date.now()', label: 'Current timestamp' },
  { namespace: 'runJS', name: 'window.location.href', label: 'Current URL' },
  { namespace: 'runJS', name: "document.querySelector('...').textContent", label: 'Extract element text' },
]

interface UseVariableSuggestionsResult {
  suggestions: VariableSuggestion[]
  isLoading: boolean
}

export function useVariableSuggestions(testId: string | null): UseVariableSuggestionsResult {
  const [envKeys, setEnvKeys] = useState<string[]>([])
  const [hookSuggestions, setHookSuggestions] = useState<Array<{ id: string; name: string }>>([])
  const [capturedNames, setCapturedNames] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

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
    for (const key of envKeys) result.push({ namespace: 'env', name: key, label: 'env' })
    for (const hook of hookSuggestions) {
      result.push({
        namespace: 'runHook',
        name: hook.name,
        label: 'hook',
        insertValue: hook.id,
        description: hook.id,
      })
    }
    for (const name of capturedNames) result.push({ namespace: 'capture', name, label: 'captured' })
    result.push(...RUNJS_SNIPPETS)
    return result
  }, [envKeys, hookSuggestions, capturedNames])

  return { suggestions, isLoading }
}
