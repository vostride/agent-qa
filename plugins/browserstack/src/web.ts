import { PluginError, type z } from '@vostride/agent-qa-plugin-kit'
import type { BrowserStackOptions, BrowserStackSettings } from './options.js'
import {
  BROWSERSTACK_PLAYWRIGHT_VERSIONS,
  listedPlaywright,
  playwrightMajorMinor,
} from './playwright-versions.js'

type Json = z.core.util.JSONType
type Engine = 'chromium' | 'firefox' | 'webkit'

const ENGINE_BROWSERS = {
  chromium: 'chrome',
  firefox: 'playwright-firefox',
  webkit: 'playwright-webkit',
} as const

const BROWSER_ENGINES = {
  chrome: 'chromium',
  edge: 'chromium',
  'playwright-chromium': 'chromium',
  'playwright-firefox': 'firefox',
  'playwright-webkit': 'webkit',
} as const

export interface WebRequest {
  options: BrowserStackOptions
  settings: BrowserStackSettings
  engine: Engine
  playwrightVersion: string
  testName: string | undefined
  runId: string | undefined
}

export interface WebAnswer {
  handle: Json
  protocol: 'playwright'
  url: string
  mask: string[]
}

export function checkPlaywrightVersion(version: string): void {
  if (listedPlaywright(version)) return
  const first = BROWSERSTACK_PLAYWRIGHT_VERSIONS[0]
  const last = BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]
  const ours = playwrightMajorMinor(version) ?? `an unknown version (${version})`
  throw new PluginError(
    `BrowserStack lists Playwright ${first} to ${last}, not ${ours}, so web tests cannot run there yet; run this test here or on another remote.`,
    { kind: 'version' },
  )
}

export function webCapabilities(request: WebRequest): Record<string, unknown> {
  const { options, settings, engine } = request
  const browser = settings.browser ?? ENGINE_BROWSERS[engine]
  if (BROWSER_ENGINES[browser] !== engine) {
    throw new PluginError(`BrowserStack's ${browser} cannot run a ${engine} test.`, {
      kind: 'refused',
      path: 'settings.browser',
    })
  }
  const build = settings.build ?? request.runId
  return {
    'browserstack.username': options.username,
    'browserstack.accessKey': options.accessKey,
    browser,
    os: settings.os,
    os_version: settings.osVersion,
    ...(settings.browserVersion === undefined ? {} : { browser_version: settings.browserVersion }),
    'client.playwrightVersion': request.playwrightVersion,
    project: settings.project,
    ...(build === undefined ? {} : { build }),
    ...(request.testName === undefined ? {} : { name: request.testName }),
    ...settings.extra,
  }
}

export function playwrightAnswer(request: WebRequest): WebAnswer {
  checkPlaywrightVersion(request.playwrightVersion)
  const caps = webCapabilities(request)
  const base = request.options.playwrightUrl
  const query = `caps=${encodeURIComponent(JSON.stringify(caps))}`
  const url = `${base}${base.includes('?') ? '&' : '?'}${query}`
  const { build, name } = caps
  return {
    handle: {
      kind: 'web',
      ...(typeof build === 'string' ? { build } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      startedAt: new Date().toISOString(),
    },
    protocol: 'playwright',
    url,
    mask: [url],
  }
}
