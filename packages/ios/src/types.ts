import type { PlatformConfig } from '@vostride/agent-qa-core'

export interface IOSAdapterConfig extends PlatformConfig {
  appiumUrl?: string
  bundleId?: string
  udid?: string
}
