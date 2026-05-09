import { useState, useEffect } from 'react'
import { fetchTargets } from '@/lib/api'

interface TargetsState {
  targets: string[]
  isLoading: boolean
}

let cached: string[] | null = null
let cachedAt = 0
const TTL = 30_000
let pendingPromise: Promise<void> | null = null

function isCacheValid(): boolean {
  return cached !== null && Date.now() - cachedAt < TTL
}

export function useTargets(): TargetsState {
  const [state, setState] = useState<TargetsState>(() =>
    isCacheValid()
      ? { targets: cached!, isLoading: false }
      : { targets: [], isLoading: true },
  )

  useEffect(() => {
    if (isCacheValid()) {
      setState({ targets: cached!, isLoading: false })
      return
    }

    cached = null

    if (!pendingPromise) {
      pendingPromise = fetchTargets()
        .then((res) => {
          cached = res.targets
          cachedAt = Date.now()
        })
        .catch(() => {
          cached = []
          cachedAt = Date.now()
        })
        .finally(() => {
          pendingPromise = null
        })
    }

    pendingPromise.then(() => {
      setState({ targets: cached!, isLoading: false })
    })
  }, [])

  return state
}
