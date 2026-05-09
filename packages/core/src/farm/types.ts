import type { BrowserConfig } from '../types/platform.js'

export interface FarmProvider {
  readonly name: string
  readonly slug: string

  resolveWebEndpoint(config: FarmWebConfig): Promise<{
    wsEndpoint: string
    capabilities: Record<string, unknown>
  }>

  resolveMobileCapabilities(config: FarmMobileConfig): Promise<{
    hostname: string
    port: number
    path: string
    capabilities: Record<string, unknown>
  }>

  resolveCredentials(providerConfig?: FarmProviderConfig): {
    username: string
    accessKey: string
  }

  validateDevice(
    deviceName: string,
    platform: 'android' | 'ios',
  ): Promise<{ valid: boolean; suggestions?: string[] }>

  getSessionUrl(sessionId: string, type: 'web' | 'mobile'): string
}

export interface FarmWebConfig {
  browser: BrowserConfig
  credentials: { username: string; accessKey: string }
  testName?: string
  playwrightVersion?: string
}

export interface FarmMobileConfig {
  match: Record<string, unknown>
  platform: 'android' | 'ios'
  credentials: { username: string; accessKey: string }
  testName?: string
  testTimeout?: number
  app?: string
  appState?: 'preserve' | 'reset'
  appBaseDir?: string
  appSourceTrace?: string[]
}

export interface FarmProviderConfig {
  username?: string
  accessKey?: string
}
