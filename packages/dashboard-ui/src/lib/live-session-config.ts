import { parseDocument } from 'yaml'
import type { GlobalUseConfig, TargetDetail } from '@/hooks/use-target-details'

export interface LiveSessionBootstrap {
  platform: 'web' | 'android' | 'ios'
  targetName?: string
  url?: string
  headless?: boolean
  device?: Record<string, unknown>
  useDeviceName?: string
  appState?: 'preserve' | 'reset'
  bundleId?: string
  appPackage?: string
  appActivity?: string
}

const AUTH_STATE_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/
const AUTH_STATE_OBJECT_KEYS = new Set(['name', 'load', 'capture'])

function readDraftUse(content: string): { headless?: boolean; device?: string; appState?: 'preserve' | 'reset' } {
  try {
    const doc = parseDocument(content)
    if (doc.errors.length > 0) return {}
    const data = doc.toJSON() as
      | {
          use?: {
            browser?: { headless?: boolean }
            mobile?: { appState?: string }
            device?: string
          }
        }
      | null
    const appState = data?.use?.mobile?.appState

    return {
      headless: data?.use?.browser?.headless,
      device: typeof data?.use?.device === 'string' ? data.use.device : undefined,
      appState: appState === 'preserve' || appState === 'reset' ? appState : undefined,
    }
  } catch {
    return {}
  }
}

export function readDraftAuthStateName(content: string): string | null {
  try {
    const doc = parseDocument(content)
    if (doc.errors.length > 0) return null
    const data = doc.toJSON() as { use?: { authState?: unknown } } | null
    const authState = data?.use?.authState
    const candidate = typeof authState === 'string'
      ? authState.trim()
      : authState
        && typeof authState === 'object'
        && !Array.isArray(authState)
        && Object.keys(authState).every((key) => AUTH_STATE_OBJECT_KEYS.has(key))
        && ((authState as { load?: unknown }).load === undefined || typeof (authState as { load?: unknown }).load === 'boolean')
        && ((authState as { capture?: unknown }).capture === undefined || typeof (authState as { capture?: unknown }).capture === 'boolean')
        && typeof (authState as { name?: unknown }).name === 'string'
        ? (authState as { name: string }).name.trim()
        : ''
    if (!candidate) return null
    return AUTH_STATE_NAME_PATTERN.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

export function buildLiveSessionConfig(opts: {
  content: string
  targetName: string
  targets: Record<string, TargetDetail>
  globalUse: GlobalUseConfig | null
}): LiveSessionBootstrap {
  const target = opts.targets[opts.targetName]
  if (!target) {
    throw new Error(`Selected target "${opts.targetName}" was not found in workspace config`)
  }

  const draftUse = readDraftUse(opts.content)
  const headless = draftUse.headless
    ?? opts.globalUse?.browser?.headless

  if (target.platform === 'web') {
    if (!target.url) {
      throw new Error(`Selected web target "${opts.targetName}" is missing a URL`)
    }

    return {
      platform: 'web',
      targetName: opts.targetName,
      url: target.url,
      headless,
    }
  }

  return {
    platform: target.platform,
    targetName: opts.targetName,
    useDeviceName: draftUse.device,
    appState: draftUse.appState ?? opts.globalUse?.mobile?.appState,
    bundleId: target.bundleId,
    appPackage: target.appPackage,
    appActivity: target.appActivity,
    headless,
  }
}
