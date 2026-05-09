import { remote } from 'webdriverio'
import type { IOSAdapterConfig } from './types.js'

export async function createIOSSession(
  config: IOSAdapterConfig,
  farmSession?: { hostname: string; port: number; path: string; capabilities: Record<string, unknown> },
) {
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

  if (farmSession) {
    Object.assign(capabilities, farmSession.capabilities)
    return remote({
      protocol: 'https',
      hostname: farmSession.hostname,
      port: farmSession.port,
      path: farmSession.path,
      logLevel: config.verbose ? 'info' : 'silent',
      capabilities: capabilities as WebdriverIO.Capabilities,
    })
  }

  return remote({
    hostname: url.hostname,
    port: parseInt(url.port || '4723', 10),
    path: url.pathname === '/' ? '/' : url.pathname,
    logLevel: config.verbose ? 'info' : 'silent',
    capabilities: capabilities as WebdriverIO.Capabilities,
  })
}
