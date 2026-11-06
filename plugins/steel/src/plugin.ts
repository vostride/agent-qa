import { randomUUID } from 'node:crypto'
import {
  checkEndpoints,
  credential,
  definePlugin,
  PluginError,
  z,
} from '@vostride/agent-qa-plugin-kit'
import { createSteelApi, SteelSessionSchema } from './steel-api.js'

const STEEL_API_URL = 'https://api.steel.dev'
const MINUTE_MS = 60_000

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
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields merged last into the session create request, overriding the rest'),
})

type SteelSettings = z.output<typeof settings>

function createBody(sessionId: string, input: SteelSettings): Record<string, unknown> {
  return {
    sessionId,
    timeout: input.timeoutMinutes * MINUTE_MS,
    inactivityTimeout: input.idleMinutes * MINUTE_MS,
    solveCaptcha: input.solveCaptcha,
    blockAds: input.blockAds,
    useProxy: input.proxy,
    stealthConfig: { skipFingerprintInjection: !input.fingerprint },
    ...input.extra,
  }
}

function withHandle(error: unknown, sessionId: string): PluginError {
  const message = error instanceof Error ? error.message : String(error)
  const kind = error instanceof PluginError ? error.kind : 'refused'
  return new PluginError(message, { kind, handle: { sessionId } })
}

function viewerLink(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return URL.parse(url)?.protocol === 'https:' ? url : undefined
}

const HandleSchema = z.object({ sessionId: z.string().min(1) })

export default definePlugin({
  options,
  settings,
  serves: ['cdp'],
  skill: './skill',

  initialize({ options }) {
    checkEndpoints(options, [{ path: 'apiUrl', scheme: 'https' }])
  },

  async acquire({ options, settings, session }) {
    if (session.platform !== 'web' || session.engine !== 'chromium') {
      const what = session.platform === 'web' ? session.engine : session.platform
      throw new PluginError(`Steel runs Chromium web sessions only, not ${what}.`, {
        kind: 'refused',
      })
    }
    const api = createSteelApi(options)
    const sessionId = randomUUID()
    let created: unknown
    // The create is not cancelled: once Steel has a session, the handle must come back to be
    // released, and the kit releases a handle that arrives after a cancel was answered.
    try {
      created = await api.createSession(createBody(sessionId, settings))
    } catch (error) {
      throw withHandle(error, sessionId)
    }
    const answer = SteelSessionSchema.safeParse(created)
    const url = answer.success ? URL.parse(answer.data.websocketUrl) : null
    if (!answer.success || url === null) {
      throw new PluginError('Steel answered a session without an id and a websocketUrl.', {
        kind: 'refused',
        handle: { sessionId: answer.success ? answer.data.id : sessionId },
      })
    }
    const { id, debugUrl, sessionViewerUrl } = answer.data
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
