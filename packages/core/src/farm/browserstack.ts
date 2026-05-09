import type { FarmProvider, FarmWebConfig, FarmMobileConfig, FarmProviderConfig } from './types.js'
import { resolveFarmCredentials } from './credentials.js'
import { mapWebCapabilities, mapMobileCapabilities } from './capability-mapper.js'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { MobileSetupError } from '../mobile/launch-resolver.js'

function isAbsoluteAppValue(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function isExplicitRelativePath(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../')
}

export async function resolveBrowserStackApp(config: FarmMobileConfig): Promise<string | undefined> {
  if (!config.app) return undefined
  if (isAbsoluteAppValue(config.app)) {
    throw new MobileSetupError({
      category: 'app-install',
      message: `BrowserStack app value must be a BrowserStack reference or relative upload path: ${config.app}`,
      platform: config.platform,
      appId: config.app,
      sourceTrace: config.appSourceTrace,
    })
  }

  const appBaseDir = config.appBaseDir ?? process.cwd()
  const resolvedPath = resolvePath(appBaseDir, config.app)
  const mustExist = isExplicitRelativePath(config.app)
  if (!existsSync(resolvedPath)) {
    if (mustExist) {
      throw new MobileSetupError({
        category: 'app-install',
        message: `Configured BrowserStack app upload path not found: ${resolvedPath}`,
        platform: config.platform,
        appId: config.app,
        sourceTrace: config.appSourceTrace,
      })
    }
    return config.app
  }

  const auth = Buffer.from(`${config.credentials.username}:${config.credentials.accessKey}`).toString('base64')
  const form = new FormData()
  form.append('file', new Blob([readFileSync(resolvedPath)]), basename(resolvedPath))

  let res: Response
  try {
    res = await fetch('https://api-cloud.browserstack.com/app-automate/upload', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    })
  } catch (err) {
    throw new MobileSetupError({
      category: 'app-install',
      message: `Failed to upload BrowserStack app: ${err instanceof Error ? err.message : String(err)}`,
      platform: config.platform,
      appId: config.app,
      sourceTrace: config.appSourceTrace,
      cause: err,
    })
  }

  if (!res.ok) {
    throw new MobileSetupError({
      category: 'app-install',
      message: `Failed to upload BrowserStack app: HTTP ${res.status}`,
      platform: config.platform,
      appId: config.app,
      sourceTrace: config.appSourceTrace,
    })
  }

  const body = await res.json() as { app_url?: string }
  if (!body.app_url) {
    throw new MobileSetupError({
      category: 'app-install',
      message: 'Failed to upload BrowserStack app: response missing app_url',
      platform: config.platform,
      appId: config.app,
      sourceTrace: config.appSourceTrace,
    })
  }
  return body.app_url
}

export const browserstackProvider: FarmProvider = {
  name: 'BrowserStack',
  slug: 'browserstack',

  async resolveWebEndpoint(config: FarmWebConfig) {
    const caps = mapWebCapabilities(config.browser, config.credentials, {
      testName: config.testName,
      playwrightVersion: config.playwrightVersion,
    })
    const wsEndpoint = `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`
    return { wsEndpoint, capabilities: caps }
  },

  async resolveMobileCapabilities(config: FarmMobileConfig) {
    const bstackCaps = mapMobileCapabilities(config.match, config.platform, config.credentials, {
      testName: config.testName,
      testTimeout: config.testTimeout,
    })

    const automationName = (config.match.automationName as string) ??
      (config.platform === 'android' ? 'UiAutomator2' : 'XCUITest')
    const platformName = config.platform === 'android' ? 'Android' : 'iOS'

    const capabilities: Record<string, unknown> = {
      platformName,
      'appium:automationName': automationName,
    }

    for (const [key, value] of Object.entries(config.match)) {
      if (key !== 'automationName' && key !== 'noReset') {
        capabilities[`appium:${key}`] = value
      }
    }

    Object.assign(capabilities, bstackCaps)

    const browserName = typeof config.match.browserName === 'string' ? config.match.browserName.trim() : ''
    const appStateNoReset = config.appState === 'preserve'
      ? true
      : config.appState === 'reset'
        ? false
        : undefined
    if (!browserName && appStateNoReset !== undefined) {
      capabilities['appium:noReset'] = appStateNoReset
    }

    const resolvedAppValue = await resolveBrowserStackApp(config)
    if (resolvedAppValue) {
      capabilities['appium:app'] = resolvedAppValue
    }

    return {
      hostname: 'hub.browserstack.com',
      port: 443,
      path: '/wd/hub',
      capabilities,
    }
  },

  resolveCredentials(providerConfig?: FarmProviderConfig) {
    return resolveFarmCredentials('browserstack', providerConfig)
  },

  async validateDevice(deviceName: string, platform: 'android' | 'ios') {
    let credentials: { username: string; accessKey: string }
    try {
      credentials = resolveFarmCredentials('browserstack')
    } catch {
      return { valid: false, suggestions: ['Could not validate — credentials not configured'] }
    }

    const auth = Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')
    try {
      const res = await fetch('https://api-cloud.browserstack.com/app-automate/devices.json', {
        headers: { Authorization: `Basic ${auth}` },
      })
      if (!res.ok) {
        return { valid: false, suggestions: ['Could not validate — API returned ' + res.status] }
      }

      const devices = (await res.json()) as Array<{ device: string; os: string }>
      const targetOs = platform === 'android' ? 'android' : 'ios'
      const match = devices.find(
        (d) => d.device.toLowerCase() === deviceName.toLowerCase() && d.os.toLowerCase() === targetOs,
      )

      if (match) return { valid: true }

      const similar = devices
        .filter((d) => d.os.toLowerCase() === targetOs)
        .filter((d) => d.device.toLowerCase().includes(deviceName.toLowerCase().split(' ')[0]))
        .map((d) => d.device)
        .slice(0, 5)

      return { valid: false, suggestions: similar.length > 0 ? similar : undefined }
    } catch {
      return { valid: false, suggestions: ['Could not validate — network error'] }
    }
  },

  getSessionUrl(sessionId: string, type: 'web' | 'mobile') {
    if (type === 'web') {
      return `https://automate.browserstack.com/sessions/${sessionId}`
    }
    return `https://app-automate.browserstack.com/sessions/${sessionId}`
  },
}
