import { credential, definePlugin, PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { createKernelApi, KernelBrowserSchema } from './kernel-api.js'

const KERNEL_API_URL = 'https://api.onkernel.com'
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

const options = z.strictObject({
  apiKey: credential('The Kernel API key'),
  apiUrl: z
    .url()
    .default(KERNEL_API_URL)
    .describe("Kernel's API, https:// unless it points at this machine"),
})

const settings = z.strictObject({
  headless: z
    .boolean()
    .default(true)
    .describe('Run a headless browser; Kernel offers a live view only for a headful one'),
  timeoutSeconds: z
    .int()
    .min(10)
    .max(259_200)
    .default(60)
    .describe('Seconds with no connection before Kernel deletes the browser'),
  stealth: z.boolean().optional().describe("Kernel's stealth mode"),
  region: z.string().min(1).optional().describe('The Kernel region, for example eu-west'),
  proxy: z.record(z.string(), z.unknown()).optional().describe("Kernel's proxy, sent as given"),
  viewport: z
    .strictObject({
      width: z.int().positive(),
      height: z.int().positive(),
      refreshRate: z.int().positive().optional(),
    })
    .optional()
    .describe('The browser window size'),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields merged last into the create request, overriding the settings above'),
})

type KernelSettings = z.output<typeof settings>

function apiUrlAllowed(value: string): boolean {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return LOOPBACK_HOSTS.has(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
}

function createBody(input: KernelSettings): Record<string, unknown> {
  const { viewport } = input
  return {
    headless: input.headless,
    timeout_seconds: input.timeoutSeconds,
    ...(input.stealth === undefined ? {} : { stealth: input.stealth }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
    ...(viewport === undefined
      ? {}
      : {
          viewport: {
            width: viewport.width,
            height: viewport.height,
            ...(viewport.refreshRate === undefined ? {} : { refresh_rate: viewport.refreshRate }),
          },
        }),
    ...input.extra,
  }
}

const HandleSchema = z.object({ sessionId: z.string().min(1) })

function sessionIdOf(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null || !('session_id' in answer)) return undefined
  const id = answer.session_id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export default definePlugin({
  options,
  settings,
  serves: ['cdp'],
  skill: './skill',

  initialize({ options }) {
    if (!apiUrlAllowed(options.apiUrl)) {
      throw new PluginError('apiUrl must use https:// unless it points at this machine.', {
        kind: 'refused',
        path: 'apiUrl',
      })
    }
  },

  async acquire({ options, settings, session }) {
    if (session.platform !== 'web' || session.engine !== 'chromium') {
      const what = session.platform === 'web' ? session.engine : session.platform
      throw new PluginError(`Kernel runs Chromium web sessions only, not ${what}.`, {
        kind: 'refused',
      })
    }
    // The create is not cancelled: once Kernel has a browser, the handle must come back to be
    // deleted, and the kit releases a handle that arrives after a cancel was answered.
    const answer = await createKernelApi(options).createBrowser(createBody(settings))
    const sessionId = sessionIdOf(answer)
    const handle = sessionId === undefined ? undefined : { sessionId }
    const browser = KernelBrowserSchema.safeParse(answer)
    if (!browser.success) {
      throw new PluginError('Kernel answered a browser without a session_id and a cdp_ws_url.', {
        kind: 'refused',
        ...(handle === undefined ? {} : { handle }),
      })
    }
    const { cdp_ws_url: url, browser_live_view_url: liveView } = browser.data
    return {
      handle: { sessionId: browser.data.session_id },
      protocol: 'cdp',
      url,
      mask: liveView === undefined ? [url] : [url, liveView],
    }
  },

  async release({ options, handle }, ctx) {
    const parsed = HandleSchema.safeParse(handle)
    if (!parsed.success) {
      throw new PluginError('A Kernel handle names its browser by sessionId.', { kind: 'refused' })
    }
    await createKernelApi(options).deleteBrowser(parsed.data.sessionId, ctx.signal)
  },
})
