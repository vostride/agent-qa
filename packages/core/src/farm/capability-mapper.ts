import { createRequire } from 'node:module'
import type { BrowserConfig } from '../types/platform.js'

const BROWSER_MAP: Record<string, string> = {
  chromium: 'playwright-chromium',
  firefox: 'playwright-firefox',
  webkit: 'playwright-webkit',
}

export function detectPlaywrightVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('playwright-core/package.json') as { version: string }
    return pkg.version
  } catch {
    return '1.59.1'
  }
}

export function mapWebCapabilities(
  browser: BrowserConfig,
  credentials: { username: string; accessKey: string },
  opts?: { testName?: string; playwrightVersion?: string },
): Record<string, unknown> {
  if (!browser.viewport) {
    throw new Error('Farm mode requires browser.viewport to be set (e.g. { width: 1280, height: 720 })')
  }
  const bstackBrowser = BROWSER_MAP[browser.name]
  if (!bstackBrowser) {
    throw new Error(`Unsupported browser for BrowserStack: "${browser.name}". Supported: ${Object.keys(BROWSER_MAP).join(', ')}`)
  }

  return {
    browser: bstackBrowser,
    os: 'os x',
    os_version: 'sonoma',
    resolution: '1920x1080',
    'browserstack.username': credentials.username,
    'browserstack.accessKey': credentials.accessKey,
    'client.playwrightVersion': opts?.playwrightVersion ?? detectPlaywrightVersion(),
    project: 'agent-qa',
    build: 'agent-qa-' + Date.now(),
    name: opts?.testName,
  }
}

export function mapMobileCapabilities(
  match: Record<string, unknown>,
  platform: 'android' | 'ios',
  credentials: { username: string; accessKey: string },
  opts?: { testName?: string; testTimeout?: number },
): Record<string, unknown> {
  if (!opts?.testTimeout) {
    throw new Error('Farm mode requires timeout.test to be set in config')
  }

  return {
    'bstack:options': {
      userName: credentials.username,
      accessKey: credentials.accessKey,
      deviceName: match.deviceName as string | undefined,
      osVersion: match.platformVersion as string | undefined,
      projectName: 'agent-qa',
      buildName: 'agent-qa-' + Date.now(),
      sessionName: opts.testName,
      idleTimeout: Math.ceil(opts.testTimeout / 1000),
    },
  }
}
