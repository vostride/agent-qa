import { setTimeout as delay } from 'node:timers/promises'
import {
  credential,
  definePlugin,
  PluginError,
  z,
  type AcquireInput,
  type PluginCallContext,
} from '@vostride/agent-qa-plugin-kit'
import {
  createKernelApi,
  KernelBrowserSchema,
  type KernelApi,
  type PoolAcquireAnswer,
} from './kernel-api.js'

const KERNEL_API_URL = 'https://api.onkernel.com'
// Kernel answers 204 at once when the acquire timeout is short, so a poll waits at least this long.
const POOL_POLL_FLOOR_MS = 1_000
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
  pool: z
    .string()
    .min(1)
    .optional()
    .describe('A Kernel browser pool, by id or name, to acquire from instead of creating a browser'),
  profile: z
    .union([z.string().min(1), z.strictObject({ id: z.string().min(1) })])
    .optional()
    .describe('A Kernel profile loaded read-only, by name or as { id }; needs context: reuse'),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields merged last into the create or pool acquire request, overriding the rest'),
})

type KernelSettings = z.output<typeof settings>
type Session = AcquireInput<unknown, unknown>['session']

function apiUrlAllowed(value: string): boolean {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return LOOPBACK_HOSTS.has(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
}

const CREATE_ONLY_SETTINGS = ['stealth', 'region', 'proxy', 'viewport'] as const

function profileBody(input: KernelSettings, session: Session) {
  const { profile } = input
  if (profile === undefined) return undefined
  if (session.platform !== 'web' || session.context !== 'reuse') {
    throw new PluginError(
      'profile loads only into a reused context; set context: reuse on the remote.',
      { kind: 'refused', path: 'settings.profile' },
    )
  }
  const named = typeof profile === 'string' ? { name: profile } : { id: profile.id }
  return { ...named, save_changes: false }
}

function createBody(input: KernelSettings, profile: object | undefined): Record<string, unknown> {
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
    ...(profile === undefined ? {} : { profile }),
    ...input.extra,
  }
}

const HandleSchema = z.object({
  sessionId: z.string().min(1),
  pool: z.string().min(1).optional(),
  reuse: z.boolean().optional(),
})
type KernelHandle = z.output<typeof HandleSchema>

function sessionIdOf(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null || !('session_id' in answer)) return undefined
  const id = answer.session_id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function cdpAnswer(answer: unknown, place: Omit<KernelHandle, 'sessionId'>) {
  const sessionId = sessionIdOf(answer)
  const handle = sessionId === undefined ? undefined : { sessionId, ...place }
  const browser = KernelBrowserSchema.safeParse(answer)
  if (!browser.success) {
    throw new PluginError('Kernel answered a browser without a session_id and a cdp_ws_url.', {
      kind: 'refused',
      ...(handle === undefined ? {} : { handle }),
    })
  }
  const { cdp_ws_url: url, browser_live_view_url: liveView } = browser.data
  return {
    handle: { sessionId: browser.data.session_id, ...place },
    protocol: 'cdp' as const,
    url,
    mask: liveView === undefined ? [url] : [url, liveView],
  }
}

async function acquireFromPool(
  api: KernelApi,
  pool: string,
  body: Record<string, unknown>,
  reuse: boolean,
  ctx: PluginCallContext,
) {
  const stopped = () => new PluginError(`stopped waiting for pool ${pool}`, { kind: 'timeout' })
  // Unlike a create, a wait that ends in 204 holds no browser, so the cancel stops the wait.
  for (;;) {
    const began = Date.now()
    let answer: PoolAcquireAnswer
    try {
      answer = await api.acquireFromPool(pool, body, ctx.signal)
    } catch (error) {
      if (ctx.signal.aborted) throw stopped()
      throw error
    }
    if (answer.acquired) return cdpAnswer(answer.browser, { pool, reuse })
    if (ctx.signal.aborted) throw stopped()
    ctx.progress({ message: `waiting for pool ${pool}` })
    const rest = POOL_POLL_FLOOR_MS - (Date.now() - began)
    if (rest > 0) await delay(rest, undefined, { signal: ctx.signal }).catch(() => {})
    if (ctx.signal.aborted) throw stopped()
  }
}

const OrgLimitsSchema = z.object({
  concurrent_sessions_available: z.int().nonnegative(),
  concurrent_sessions_used: z.int().nonnegative(),
})

function refusedKey(error: unknown): boolean {
  return error instanceof PluginError && error.kind === 'auth'
}

function failureLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function limitsLine(api: KernelApi, signal: AbortSignal): Promise<string> {
  let answer: unknown
  try {
    answer = await api.orgLimits(signal)
  } catch (error) {
    if (refusedKey(error)) return 'organization limits not readable with this key'
    return `organization limits not readable: ${failureLine(error)}`
  }
  const limits = OrgLimitsSchema.safeParse(answer)
  if (!limits.success) return 'organization limits not readable: Kernel answered another shape'
  const { concurrent_sessions_available: free, concurrent_sessions_used: used } = limits.data
  return `${String(free)} of ${String(free + used)} concurrent sessions free`
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

  async check({ options, remotes }, ctx) {
    const api = createKernelApi(options)
    try {
      await api.listBrowsers(1, ctx.signal)
    } catch (error) {
      const line = refusedKey(error) ? 'the API key was refused' : failureLine(error)
      return { state: 'warn', lines: [line] }
    }
    const lines = ['the API key was accepted', await limitsLine(api, ctx.signal)]
    let state: 'ok' | 'warn' = 'ok'
    const pools = new Set(remotes.flatMap(({ settings }) => settings.pool ?? []))
    for (const pool of pools) {
      let found: boolean
      try {
        found = await api.getPool(pool, ctx.signal)
      } catch (error) {
        state = 'warn'
        lines.push(`pool ${pool} not readable: ${failureLine(error)}`)
        continue
      }
      if (!found) state = 'warn'
      lines.push(found ? `pool ${pool} found` : `pool ${pool} not found`)
    }
    return { state, lines }
  },

  async acquire({ options, settings, session }, ctx) {
    if (session.platform !== 'web' || session.engine !== 'chromium') {
      const what = session.platform === 'web' ? session.engine : session.platform
      throw new PluginError(`Kernel runs Chromium web sessions only, not ${what}.`, {
        kind: 'refused',
      })
    }
    const profile = profileBody(settings, session)
    const api = createKernelApi(options)
    if (settings.pool !== undefined) {
      const fromCreate = CREATE_ONLY_SETTINGS.find((name) => settings[name] !== undefined)
      if (fromCreate !== undefined) {
        throw new PluginError(
          `${fromCreate} comes from the pool's own configuration; remove it from a remote with pool.`,
          { kind: 'refused', path: `settings.${fromCreate}` },
        )
      }
      const body = { ...(profile === undefined ? {} : { profile }), ...settings.extra }
      const reuse = session.context !== 'reuse'
      return acquireFromPool(api, settings.pool, body, reuse, ctx)
    }
    // The create is not cancelled: once Kernel has a browser, the handle must come back to be
    // deleted, and the kit releases a handle that arrives after a cancel was answered.
    return cdpAnswer(await api.createBrowser(createBody(settings, profile)), {})
  },

  async release({ options, handle }, ctx) {
    const parsed = HandleSchema.safeParse(handle)
    if (!parsed.success) {
      throw new PluginError('A Kernel handle names its browser by sessionId.', { kind: 'refused' })
    }
    const { sessionId, pool, reuse } = parsed.data
    const api = createKernelApi(options)
    if (pool === undefined) await api.deleteBrowser(sessionId, ctx.signal)
    else await api.releaseToPool(pool, sessionId, reuse ?? false, ctx.signal)
  },
})
