import { remote } from 'webdriverio'
import type { IOSAdapterConfig } from './types.js'

// WDA's default 50 cuts React Native trees, and deeper snapshots can fail inside XCTest on some hosts.
export const IOS_SNAPSHOT_MAX_DEPTH = 62
export const IOS_SNAPSHOT_FALLBACK_DEPTH = 50
export const IOS_SNAPSHOT_DEPTH_ENV = 'AGENT_QA_IOS_SNAPSHOT_MAX_DEPTH'
const IOS_SNAPSHOT_DEPTH_CAPABILITY = 'appium:settings[snapshotMaxDepth]'

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function resolveIOSSnapshotDepth(): number {
  return positiveInteger(process.env[IOS_SNAPSHOT_DEPTH_ENV]) ?? IOS_SNAPSHOT_MAX_DEPTH
}

export async function createIOSSession(config: IOSAdapterConfig) {
  const match = config.device?.match ?? {}
  const appiumUrl = process.env.AGENT_QA_APPIUM_URL ?? config.appiumUrl ?? 'http://localhost:4723'
  const url = new URL(appiumUrl)
  const browserName = typeof match.browserName === 'string' && match.browserName.trim().length > 0
    ? match.browserName.trim()
    : undefined
  const appStateNoReset =
    config.appState === 'preserve' ? true :
    config.appState === 'reset' ? false :
    undefined

  const capabilities: Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': (match.automationName as string) ?? 'XCUITest',
    'appium:deviceName': config.device?.name ?? 'iPhone Simulator',
    'appium:showIOSLog': true,
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    [IOS_SNAPSHOT_DEPTH_CAPABILITY]: resolveIOSSnapshotDepth(),
  }

  if (!browserName && appStateNoReset !== undefined) capabilities['appium:noReset'] = appStateNoReset

  if (match.platformVersion) capabilities['appium:platformVersion'] = match.platformVersion
  if (match.bundleId) capabilities['appium:bundleId'] = match.bundleId
  if (config.bundleId) capabilities['appium:bundleId'] = config.bundleId
  if (config.appPath) capabilities['appium:app'] = config.appPath
  if (match.udid) capabilities['appium:udid'] = match.udid
  if (config.udid) capabilities['appium:udid'] = config.udid

  // Strip undefined values
  for (const key of Object.keys(capabilities)) {
    if (capabilities[key] === undefined) {
      delete capabilities[key]
    }
  }

  return remote({
    hostname: url.hostname,
    port: parseInt(url.port || '4723', 10),
    path: url.pathname === '/' ? '/' : url.pathname,
    logLevel: config.verbose ? 'info' : 'silent',
    capabilities: capabilities as WebdriverIO.Capabilities,
  })
}
