import { parseDocument } from 'yaml'
import type { GlobalUseConfig, TargetDetail } from '@/hooks/use-target-details'

export interface LiveSessionBootstrap {
  platform: 'web' | 'android' | 'ios'
  targetName?: string
  url?: string
  headless?: boolean
  useDeviceName?: string
  appState?: 'preserve' | 'reset'
  authState?: unknown
}

interface DraftUse {
  headless?: boolean
  device?: string
  appState?: 'preserve' | 'reset'
  // As written; the server parses it with core's schema, as a run does.
  authState?: unknown
}

function readDraftUse(content: string): DraftUse {
  try {
    const doc = parseDocument(content)
    if (doc.errors.length > 0) return {}
    const data = doc.toJSON() as
      | {
          use?: {
            browser?: { headless?: boolean }
            mobile?: { appState?: string }
            device?: string
            authState?: unknown
          }
        }
      | null
    const appState = data?.use?.mobile?.appState

    return {
      headless: data?.use?.browser?.headless,
      device: typeof data?.use?.device === 'string' ? data.use.device : undefined,
      appState: appState === 'preserve' || appState === 'reset' ? appState : undefined,
      ...(data?.use?.authState === undefined ? {} : { authState: data.use.authState }),
    }
  } catch {
    return {}
  }
}

export function readDraftAuthStateName(content: string): string | null {
  const authState = readDraftUse(content).authState
  const name = typeof authState === 'string'
    ? authState
    : authState !== null && typeof authState === 'object' && !Array.isArray(authState)
      ? (authState as { name?: unknown }).name
      : undefined
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed.length > 0 ? trimmed : null
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
      ...(draftUse.authState === undefined ? {} : { authState: draftUse.authState }),
    }
  }

  return {
    platform: target.platform,
    targetName: opts.targetName,
    useDeviceName: draftUse.device,
    appState: draftUse.appState ?? opts.globalUse?.mobile?.appState,
    headless,
    ...(draftUse.authState === undefined ? {} : { authState: draftUse.authState }),
  }
}
