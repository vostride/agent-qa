import type { PlatformConfig } from '@vostride/agent-qa-core'
import type { LaunchOptions, BrowserContextOptions } from 'playwright-core'

export type RefMap = Record<string, { role: string; name?: string; nth?: number; bounds?: { x: number; y: number; width: number; height: number } }>

export interface WebAdapterConfig extends PlatformConfig {
  launchOptions?: LaunchOptions
  contextOptions?: BrowserContextOptions
  filterSelector?: string
}

export interface SnapshotResult {
  tree: string
  refs: RefMap
  elementCount: number
}
