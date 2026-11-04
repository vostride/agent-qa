import { useState, useEffect } from 'react'
import { fetchConfig } from '@/lib/api'

export interface TargetDetail {
  platform: 'web' | 'android' | 'ios'
  url?: string
  bundleId?: string
  appPackage?: string
  appActivity?: string
  app?: {
    path?: string
  }
  product?: string
  deviceName?: string
  device?: Record<string, unknown>
}

export interface GlobalUseConfig {
  browser?: {
    name?: string
    headless?: boolean
    viewport?: { width?: number; height?: number }
    remote?: string
  }
  mobile?: { appState?: 'preserve' | 'reset' }
  timeout?: { step?: string; test?: string; navigation?: string }
  planner?: { maxActions?: number; maxPlanningTurns?: number; previousStepCount?: number }
  logCapture?: { console?: boolean; network?: boolean }
  llm?: string
  parallel?: boolean
}

interface TargetDetailsState {
  targets: Record<string, TargetDetail>
  globalUse: GlobalUseConfig | null
  remotes: string[]
  isLoading: boolean
}

let cached: Omit<TargetDetailsState, 'isLoading'> | null = null
let cachedAt = 0
const TTL = 30_000
let pendingPromise: Promise<void> | null = null

// The listed names a test or suite may pick; `local` is this machine, never a remote.
function remoteNames(remotes: unknown): string[] {
  if (!Array.isArray(remotes)) return []
  const names = new Set<string>()
  for (const entry of remotes) {
    const name: unknown = entry?.name
    if (typeof name === 'string' && name !== '' && name !== 'local') names.add(name)
  }
  return [...names]
}

function isCacheValid(): boolean {
  return cached !== null && Date.now() - cachedAt < TTL
}

export function useTargetDetails(): TargetDetailsState {
  const [state, setState] = useState<TargetDetailsState>(() =>
    isCacheValid()
      ? { ...cached!, isLoading: false }
      : { targets: {}, globalUse: null, remotes: [], isLoading: true },
  )

  useEffect(() => {
    if (isCacheValid()) {
      setState({ ...cached!, isLoading: false })
      return
    }

    cached = null

    if (!pendingPromise) {
      pendingPromise = fetchConfig()
        .then((res) => {
          const cfg = res.config as any
          const raw = cfg?.registry?.targets ?? cfg?.targets
          const parsed: Record<string, TargetDetail> = {}
          if (raw && typeof raw === 'object') {
            for (const [name, val] of Object.entries(raw)) {
              const v = val as any
              const targetDevice = v.environments?.default?.device ?? v.device
              parsed[name] = {
                platform: v.platform ?? 'web',
                url: v.url,
                bundleId: v.bundleId,
                appPackage: v.appPackage,
                appActivity: v.appActivity,
                app: v.app && typeof v.app === 'object' && !Array.isArray(v.app)
                  ? {
                      path: typeof v.app.path === 'string' ? v.app.path : undefined,
                    }
                  : undefined,
                product: v.product,
                deviceName: typeof targetDevice === 'string' ? targetDevice : undefined,
                device: targetDevice && typeof targetDevice === 'object' && !Array.isArray(targetDevice)
                  ? targetDevice
                  : undefined,
              }
            }
          }
          const globalUse: GlobalUseConfig | null = cfg?.use ?? null
          cached = { targets: parsed, globalUse, remotes: remoteNames(cfg?.registry?.remotes) }
          cachedAt = Date.now()
        })
        .catch(() => {
          cached = { targets: {}, globalUse: null, remotes: [] }
          cachedAt = Date.now()
        })
        .finally(() => {
          pendingPromise = null
        })
    }

    pendingPromise.then(() => {
      setState({ ...cached!, isLoading: false })
    })
  }, [])

  return state
}
