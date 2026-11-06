import { randomUUID } from 'node:crypto'
import {
  checkEndpoints,
  credential,
  definePlugin,
  PluginError,
  z,
  type AcquireInput,
} from '@vostride/agent-qa-plugin-kit'
import { createSteelApi, SteelCreateFailure, SteelSessionSchema } from './steel-api.js'

const STEEL_API_URL = 'https://api.steel.dev'
const MINUTE_MS = 60_000
const LIFETIME_REFUSALS: readonly number[] = [400, 422]
const SMALLEST_PLAN_CAP_MINUTES = 15
const LIFETIME_WORDS = /timeout|lifetime|duration|minute|plan|limit/i

const options = z.strictObject({
  apiKey: credential('The Steel API key; leave it out for a self-hosted steel-browser').optional(),
  apiUrl: z
    .url()
    .default(STEEL_API_URL)
    .describe("Steel's API, https:// unless it points at this machine"),
})

const settings = z.strictObject({
  timeoutMinutes: z
    .int()
    .min(1)
    .max(1440)
    .default(1440)
    .describe('Minutes before Steel ends the session; your Steel plan may cap it lower'),
  idleMinutes: z
    .int()
    .min(1)
    .max(60)
    .default(5)
    .describe('Minutes with no CDP command before Steel ends the session'),
  solveCaptcha: z.boolean().default(false).describe("Steel's CAPTCHA solving"),
  blockAds: z.boolean().default(false).describe("Steel's ad blocking"),
  fingerprint: z
    .boolean()
    .default(false)
    .describe("Steel's browser fingerprint injection, which changes what pages see"),
  proxy: z
    .union([z.boolean(), z.record(z.string(), z.unknown())])
    .default(false)
    .describe("Steel's proxy, true or Steel's proxy object, sent as useProxy"),
  proxyUrl: credential(
    "Your own proxy, http(s)://user:password@host:port, sent instead of Steel's",
  ).optional(),
  dimensions: z
    .strictObject({ width: z.int().positive(), height: z.int().positive() })
    .optional()
    .describe('The browser window size'),
  region: z.string().min(1).optional().describe('The Steel region, for example us-east'),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('A Steel profile id loaded read-only; needs context: reuse'),
  extensions: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Steel extension ids loaded into the browser'),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields merged last into the session create request, overriding the rest'),
})

type SteelSettings = z.output<typeof settings>
type Session = AcquireInput<unknown, unknown>['session']

function checkSettings(input: SteelSettings, session: Session): void {
  if (input.profile !== undefined && (session.platform !== 'web' || session.context !== 'reuse')) {
    throw new PluginError(
      'profile loads only into a reused context; set context: reuse on the remote.',
      { kind: 'refused', path: 'settings.profile' },
    )
  }
  if (input.extra !== undefined && Object.hasOwn(input.extra, 'sessionId')) {
    throw new PluginError(
      'extra cannot set sessionId; the plugin chooses it to release the session.',
      { kind: 'refused', path: 'settings.extra.sessionId' },
    )
  }
  if (input.proxyUrl !== undefined && input.proxy !== false) {
    throw new PluginError('proxy and proxyUrl both choose a proxy; set one of them.', {
      kind: 'refused',
      path: 'settings.proxyUrl',
    })
  }
}

function createBody(sessionId: string, input: SteelSettings): Record<string, unknown> {
  return {
    sessionId,
    timeout: input.timeoutMinutes * MINUTE_MS,
    inactivityTimeout: input.idleMinutes * MINUTE_MS,
    solveCaptcha: input.solveCaptcha,
    blockAds: input.blockAds,
    ...(input.proxyUrl === undefined ? { useProxy: input.proxy } : {}),
    stealthConfig: { skipFingerprintInjection: !input.fingerprint },
    ...(input.proxyUrl === undefined ? {} : { proxyUrl: input.proxyUrl }),
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.profile === undefined ? {} : { profileId: input.profile }),
    ...(input.extensions === undefined ? {} : { extensionIds: input.extensions }),
    ...input.extra,
  }
}

// A create Steel refused with a 4xx made no session. Anything else (no answer, a 5xx, an
// unreadable answer) may have, so it carries the handle that releases it.
function mayHaveCreated(error: unknown): boolean {
  return !(error instanceof SteelCreateFailure) || error.status >= 500
}

// How Steel refuses a lifetime above the plan's cap is undocumented, so the hint is added only when
// the lifetime asked for is above the smallest cap and Steel's reason, if any, may be about it.
function lifetimeMayBeRefused(error: unknown, timeoutMinutes: number): boolean {
  if (!(error instanceof SteelCreateFailure) || !LIFETIME_REFUSALS.includes(error.status)) {
    return false
  }
  if (timeoutMinutes <= SMALLEST_PLAN_CAP_MINUTES) return false
  const reason = error.message.split(': ').slice(1).join(': ')
  return reason === '' || LIFETIME_WORDS.test(reason)
}

function createFailure(error: unknown, sessionId: string, timeoutMinutes: number): PluginError {
  const message = error instanceof Error ? error.message : String(error)
  const kind = error instanceof PluginError ? error.kind : 'refused'
  const lifetime = lifetimeMayBeRefused(error, timeoutMinutes)
    ? `; if your Steel plan caps sessions below ${String(timeoutMinutes)} minutes, set settings.timeoutMinutes to the cap`
    : ''
  return new PluginError(`${message}${lifetime}`, {
    kind,
    ...(mayHaveCreated(error) ? { handle: { sessionId } } : {}),
  })
}

function minutesOf(ms: number): string {
  return String(Number((ms / MINUTE_MS).toFixed(1)))
}

function noteGrantedLifetime(granted: number | undefined, asked: unknown): void {
  if (granted === undefined || typeof asked !== 'number' || granted >= asked) return
  process.stderr.write(
    `Steel granted a ${minutesOf(granted)}-minute session; ${minutesOf(asked)} minutes were asked for\n`,
  )
}

function viewerLink(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return URL.parse(url)?.protocol === 'https:' ? url : undefined
}

const HandleSchema = z.object({ sessionId: z.string().min(1) })

function refusedKey(error: unknown): boolean {
  return error instanceof PluginError && error.kind === 'auth'
}

function failureLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default definePlugin({
  options,
  settings,
  serves: ['cdp'],
  skill: './skill',

  initialize({ options }) {
    checkEndpoints(options, [{ path: 'apiUrl', scheme: 'https' }])
  },

  async check({ options }, ctx) {
    try {
      await createSteelApi(options).listSessions(ctx.signal)
    } catch (error) {
      if (!refusedKey(error)) return { state: 'warn', lines: [failureLine(error)] }
      const line =
        options.apiKey === undefined
          ? 'Steel asked for an API key; set options.apiKey'
          : 'the API key was refused'
      return { state: 'warn', lines: [line] }
    }
    const line =
      options.apiKey === undefined
        ? 'Steel answered without an API key'
        : 'the API key was accepted'
    return { state: 'ok', lines: [line] }
  },

  async acquire({ options, settings, session }) {
    if (session.platform !== 'web' || session.engine !== 'chromium') {
      const what = session.platform === 'web' ? session.engine : session.platform
      throw new PluginError(`Steel runs Chromium web sessions only, not ${what}.`, {
        kind: 'refused',
      })
    }
    checkSettings(settings, session)
    const api = createSteelApi(options)
    const sessionId = randomUUID()
    const body = createBody(sessionId, settings)
    let created: unknown
    // The create is not cancelled: once Steel has a session, the handle must come back to be
    // released, and the kit releases a handle that arrives after a cancel was answered.
    try {
      created = await api.createSession(body)
    } catch (error) {
      throw createFailure(error, sessionId, settings.timeoutMinutes)
    }
    const answer = SteelSessionSchema.safeParse(created)
    const url = answer.success ? URL.parse(answer.data.websocketUrl) : null
    if (!answer.success || url === null) {
      throw new PluginError('Steel answered a session without an id and a websocketUrl.', {
        kind: 'refused',
        handle: { sessionId: answer.success ? answer.data.id : sessionId },
      })
    }
    const { id, debugUrl, sessionViewerUrl, timeout } = answer.data
    noteGrantedLifetime(timeout, body.timeout)
    if (options.apiKey !== undefined) url.searchParams.set('apiKey', options.apiKey)
    const link = viewerLink(sessionViewerUrl)
    return {
      handle: { sessionId: id },
      protocol: 'cdp' as const,
      url: url.href,
      mask: debugUrl === undefined ? [url.href] : [url.href, debugUrl],
      ...(link === undefined ? {} : { link }),
    }
  },

  async release({ options, handle }, ctx) {
    const parsed = HandleSchema.safeParse(handle)
    if (!parsed.success) {
      throw new PluginError('A Steel handle names its session by sessionId.', { kind: 'refused' })
    }
    await createSteelApi(options).release(parsed.data.sessionId, ctx.signal)
  },
})
