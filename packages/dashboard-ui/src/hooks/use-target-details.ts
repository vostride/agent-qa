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
    browserstack?: string
  }
  product?: string
  deviceName?: string
  device?: Record<string, unknown>
}

export interface GlobalUseConfig {
  browser?: { name?: string; headless?: boolean; viewport?: { width?: number; height?: number } }
  mobile?: { appState?: 'preserve' | 'reset' }
  timeout?: { step?: string; test?: string; navigation?: string }
  healing?: { maxAttempts?: number }
  planner?: { maxSubActions?: number; previousStepCount?: number }
  logCapture?: { console?: boolean; network?: boolean }
  llm?: string
  parallel?: boolean
}

interface TargetDetailsState {
  targets: Record<string, TargetDetail>
  globalUse: GlobalUseConfig | null
  isLoading: boolean
}

let cached: { targets: Record<string, TargetDetail>; globalUse: GlobalUseConfig | null } | null = null
let cachedAt = 0
const TTL = 30_000
let pendingPromise: Promise<void> | null = null

function isCacheValid(): boolean {
  return cached !== null && Date.now() - cachedAt < TTL
}

export function useTargetDetails(): TargetDetailsState {
  const [state, setState] = useState<TargetDetailsState>(() =>
    isCacheValid()
      ? { targets: cached!.targets, globalUse: cached!.globalUse, isLoading: false }
      : { targets: {}, globalUse: null, isLoading: true },
  )

  useEffect(() => {
    if (isCacheValid()) {
      setState({ targets: cached!.targets, globalUse: cached!.globalUse, isLoading: false })
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
                      browserstack: typeof v.app.browserstack === 'string' ? v.app.browserstack : undefined,
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
          cached = { targets: parsed, globalUse }
          cachedAt = Date.now()
        })
        .catch(() => {
          cached = { targets: {}, globalUse: null }
          cachedAt = Date.now()
        })
        .finally(() => {
          pendingPromise = null
        })
    }

    pendingPromise.then(() => {
      setState({ targets: cached!.targets, globalUse: cached!.globalUse, isLoading: false })
    })
  }, [])

  return state
}
