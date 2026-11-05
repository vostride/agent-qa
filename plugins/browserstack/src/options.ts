import { credential, PluginError, z } from '@vostride/agent-qa-plugin-kit'

export const BROWSERSTACK_BROWSERS = [
  'chrome',
  'edge',
  'playwright-chromium',
  'playwright-firefox',
  'playwright-webkit',
] as const

export const options = z.strictObject({
  username: credential('The BrowserStack username'),
  accessKey: credential('The BrowserStack access key'),
  apiUrl: z
    .url()
    .default('https://api.browserstack.com')
    .describe("BrowserStack's Automate API, https:// unless it points at this machine"),
  appApiUrl: z
    .url()
    .default('https://api-cloud.browserstack.com')
    .describe("BrowserStack's App Automate API, https:// unless it points at this machine"),
  hubUrl: z
    .url()
    .default('https://hub.browserstack.com/wd/hub')
    .describe("BrowserStack's Appium hub, https:// unless it points at this machine"),
  playwrightUrl: z
    .url()
    .default('wss://cdp.browserstack.com/playwright')
    .describe("BrowserStack's Playwright endpoint, wss:// unless it points at this machine"),
  local: z
    .boolean()
    .default(false)
    .describe(
      'Start a BrowserStack Local tunnel for this run, named by localIdentifier or a fresh one',
    ),
  localIdentifier: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The identifier of a BrowserStack Local tunnel; without local, a tunnel already running',
    ),
  localBinary: z
    .string()
    .min(1)
    .optional()
    .describe('The BrowserStackLocal binary to run instead of the one the wrapper downloads'),
})

export type BrowserStackOptions = z.output<typeof options>

export const settings = z.strictObject({
  os: z.string().min(1).default('OS X').describe('The operating system, for example Windows'),
  osVersion: z
    .string()
    .min(1)
    .default('Sequoia')
    .describe('The operating system version, for example 11 or Sequoia'),
  browser: z
    .enum(BROWSERSTACK_BROWSERS)
    .optional()
    .describe("BrowserStack's browser; by default it follows the test's engine"),
  browserVersion: z
    .string()
    .min(1)
    .optional()
    .describe('The Chrome or Edge version, for example latest or latest-1'),
  project: z
    .string()
    .min(1)
    .default('agent-qa')
    .describe('The BrowserStack project the sessions are filed under'),
  build: z
    .string()
    .min(1)
    .optional()
    .describe('The BrowserStack build name; by default the run id'),
  appiumVersion: z
    .string()
    .min(1)
    .optional()
    .describe("The Appium version device sessions ask for; by default the plugin's own"),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Capabilities merged last, overriding the ones above'),
})

export type BrowserStackSettings = z.output<typeof settings>

const ENDPOINTS = [
  { path: 'apiUrl', secure: 'https:', plain: 'http:' },
  { path: 'appApiUrl', secure: 'https:', plain: 'http:' },
  { path: 'hubUrl', secure: 'https:', plain: 'http:' },
  { path: 'playwrightUrl', secure: 'wss:', plain: 'ws:' },
] as const

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

export function checkLocal(input: BrowserStackOptions): void {
  if (input.localBinary !== undefined && !input.local) {
    throw new PluginError(
      'localBinary names the tunnel the plugin starts, so it needs local: true.',
      { kind: 'refused', path: 'localBinary' },
    )
  }
}

export function checkEndpoints(input: BrowserStackOptions): void {
  for (const endpoint of ENDPOINTS) {
    const url = new URL(input[endpoint.path])
    const allowed =
      url.username === '' &&
      url.password === '' &&
      (url.protocol === endpoint.secure ||
        (url.protocol === endpoint.plain && isLoopback(url.hostname)))
    if (!allowed) {
      const scheme = endpoint.secure.slice(0, -1)
      throw new PluginError(
        `${endpoint.path} must use ${scheme}:// with no user or password, unless it points at this machine.`,
        { kind: 'refused', path: endpoint.path },
      )
    }
  }
}
