import type { AgentQaConfig } from '@vostride/agent-qa-core'

export interface ResolvedTarget {
  name: string
  product: string
  platform: 'web' | 'android' | 'ios'
  url?: string
  bundleId?: string
  appPackage?: string
  appActivity?: string
  device?: string
}

export interface TargetSummary {
  name: string
  platform: 'web' | 'android' | 'ios'
}

interface TargetEntry {
  product?: string
  platform: 'web' | 'android' | 'ios'
  bundleId?: string
  appPackage?: string
  appActivity?: string
  url?: string
  device?: string
}

export function resolveTarget(
  config: AgentQaConfig,
  targetName: string,
): ResolvedTarget {
  const targets = (config as any).registry?.targets
  if (!targets || !(targetName in targets)) {
    throw new Error(`Target "${targetName}" not found in config. Available targets: ${targets ? Object.keys(targets).join(', ') : 'none'}`)
  }

  const target = targets[targetName] as TargetEntry

  return {
    name: targetName,
    product: target.product ?? targetName,
    platform: target.platform,
    url: target.url,
    bundleId: target.bundleId,
    appPackage: target.appPackage,
    appActivity: target.appActivity,
    device: target.device,
  }
}

export function listTargets(config: AgentQaConfig): TargetSummary[] {
  const targets = (config as any).registry?.targets
  if (!targets) return []

  return Object.entries(targets).map(([name, entry]) => {
    const typedEntry = entry as TargetEntry
    return {
      name,
      platform: typedEntry.platform,
    }
  })
}
