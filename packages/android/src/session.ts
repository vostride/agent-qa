import { remote } from 'webdriverio'
import { MobileSetupError } from '@vostride/agent-qa-core'
import type { AndroidAdapterConfig } from './types.js'

export async function createAndroidSession(
  config: AndroidAdapterConfig,
  farmSession?: { hostname: string; port: number; path: string; capabilities: Record<string, unknown> },
) {
  const match = config.device?.match ?? {}
  const appiumUrl = process.env.AGENT_QA_APPIUM_URL ?? config.appiumUrl ?? 'http://localhost:4723'
  const url = new URL(appiumUrl)

  const browserName = config.browserName ?? (match.browserName as string | undefined)
  const appPath = config.appPath
  if (browserName && appPath) {
    throw new MobileSetupError({
      category: 'app-install',
      message: 'Mobile browser mode cannot be combined with app.path',
      platform: 'android',
      deviceName: config.device?.name,
      appId: appPath,
    })
  }

  const appStateNoReset =
    config.appState === 'preserve' ? true :
    config.appState === 'reset' ? false :
    undefined

  const capabilities: Record<string, unknown> = {
    platformName: 'Android',
    'appium:automationName': (match.automationName as string) ?? 'UiAutomator2',
    'appium:deviceName': config.device?.name ?? 'Android Emulator',
    'appium:newCommandTimeout': config.timeouts?.test ? Math.ceil(config.timeouts.test / 1000) : 300,
    'appium:chromedriverAutodownload': true,
  }

  if (match.platformVersion) capabilities['appium:platformVersion'] = match.platformVersion
  if (match.avd) capabilities['appium:avd'] = match.avd
  if (config.avd) capabilities['appium:avd'] = config.avd
  if (appPath) capabilities['appium:app'] = appPath

  if (browserName) {
    capabilities.browserName = browserName
    capabilities['appium:autoWebview'] = true
  } else {
    if (appStateNoReset !== undefined) capabilities['appium:noReset'] = appStateNoReset
    if (match.appPackage) capabilities['appium:appPackage'] = match.appPackage
    if (config.appPackage) capabilities['appium:appPackage'] = config.appPackage
    if (match.appActivity) capabilities['appium:appActivity'] = match.appActivity
    if (config.appActivity) capabilities['appium:appActivity'] = config.appActivity
  }

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
