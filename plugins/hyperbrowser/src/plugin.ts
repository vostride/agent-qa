import {
  checkEndpoints,
  credential,
  definePlugin,
  PluginError,
  z,
  type AcquireInput,
} from '@vostride/agent-qa-plugin-kit'
import { createHyperbrowserApi, HyperbrowserSessionSchema } from './hyperbrowser-api.js'

const HYPERBROWSER_API_URL = 'https://api.hyperbrowser.ai'

const options = z.strictObject({
  apiKey: credential('The Hyperbrowser API key'),
  apiUrl: z
    .url()
    .default(HYPERBROWSER_API_URL)
    .describe("Hyperbrowser's API, https:// unless it points at this machine"),
})

const settings = z.strictObject({
  timeoutMinutes: z
    .int()
    .min(1)
    .max(720)
    .default(720)
    .describe('Minutes before Hyperbrowser stops the session'),
  recording: z
    .boolean()
    .optional()
    .describe("Hyperbrowser's web recording; unset keeps the account's default, which records"),
  stealth: z
    .boolean()
    .default(false)
    .describe("Hyperbrowser's stealth mode, which changes what pages see"),
  proxy: z
    .union([
      z.boolean(),
      z.strictObject({
        country: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
      }),
    ])
    .default(false)
    .describe("Hyperbrowser's proxy, true or { country, state, city }"),
  solveCaptchas: z.boolean().default(false).describe("Hyperbrowser's CAPTCHA solving"),
  adblock: z.boolean().default(false).describe("Hyperbrowser's ad blocking"),
  trackers: z.boolean().default(false).describe("Hyperbrowser's tracker blocking"),
  annoyances: z.boolean().default(false).describe("Hyperbrowser's annoyance blocking"),
  acceptCookies: z
    .boolean()
    .default(false)
    .describe("Hyperbrowser's automatic acceptance of cookie banners"),
  screen: z
    .strictObject({ width: z.int().positive(), height: z.int().positive() })
    .optional()
    .describe('The browser screen size in pixels'),
  region: z.string().min(1).optional().describe('The Hyperbrowser region the session runs in'),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('A Hyperbrowser profile id loaded read-only; needs context: reuse on the remote'),
  extensions: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('Hyperbrowser extension ids loaded into the browser'),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Fields merged last into the session create request, overriding the rest'),
})

type HyperbrowserSettings = z.output<typeof settings>
type Session = AcquireInput<unknown, unknown>['session']

function checkSettings(input: HyperbrowserSettings, session: Session): void {
  if (input.profile !== undefined && (session.platform !== 'web' || session.context !== 'reuse')) {
    throw new PluginError(
      'profile loads only into a reused context; set context: reuse on the remote.',
      { kind: 'refused', path: 'settings.profile' },
    )
  }
}

function proxyBody(proxy: HyperbrowserSettings['proxy']): Record<string, unknown> {
  if (typeof proxy === 'boolean') return { useProxy: proxy }
  return {
    useProxy: true,
    ...(proxy.country === undefined ? {} : { proxyCountry: proxy.country }),
    ...(proxy.state === undefined ? {} : { proxyState: proxy.state }),
    ...(proxy.city === undefined ? {} : { proxyCity: proxy.city }),
  }
}

function createBody(input: HyperbrowserSettings): Record<string, unknown> {
  return {
    timeoutMinutes: input.timeoutMinutes,
    useStealth: input.stealth,
    ...proxyBody(input.proxy),
    solveCaptchas: input.solveCaptchas,
    adblock: input.adblock,
    trackers: input.trackers,
    annoyances: input.annoyances,
    acceptCookies: input.acceptCookies,
    ...(input.recording === undefined ? {} : { enableWebRecording: input.recording }),
    ...(input.screen === undefined ? {} : { screen: input.screen }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.profile === undefined
      ? {}
      : { profile: { id: input.profile, persistChanges: false } }),
    ...(input.extensions === undefined ? {} : { extensionIds: input.extensions }),
    ...input.extra,
  }
}

function sessionIdOf(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null || !('id' in answer)) return undefined
  const id = answer.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function dashboardLink(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  return URL.parse(url)?.protocol === 'https:' ? url : undefined
}

const HandleSchema = z.object({ sessionId: z.string().min(1) })

const ActiveSessionsSchema = z.object({ totalCount: z.int().nonnegative() })

function activeLine(count: number): string {
  return count === 1 ? '1 active session' : `${String(count)} active sessions`
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
    let answer: unknown
    try {
      answer = await createHyperbrowserApi(options).activeSessions(ctx.signal)
    } catch (error) {
      if (error instanceof PluginError && error.kind === 'auth') {
        return { state: 'warn', lines: ['the API key was refused'] }
      }
      return { state: 'warn', lines: [failureLine(error)] }
    }
    const count = ActiveSessionsSchema.safeParse(answer)
    return {
      state: 'ok',
      lines: [
        'the API key was accepted',
        ...(count.success ? [activeLine(count.data.totalCount)] : []),
      ],
    }
  },

  async acquire({ options, settings, session }) {
    if (session.platform !== 'web' || session.engine !== 'chromium') {
      const what = session.platform === 'web' ? session.engine : session.platform
      throw new PluginError(`Hyperbrowser runs Chromium web sessions only, not ${what}.`, {
        kind: 'refused',
      })
    }
    checkSettings(settings, session)
    // The create is not cancelled: once Hyperbrowser has a session, the handle must come back to
    // be stopped, and the kit releases a handle that arrives after a cancel was answered.
    const created = await createHyperbrowserApi(options).createSession(createBody(settings))
    const answer = HyperbrowserSessionSchema.safeParse(created)
    if (!answer.success) {
      const sessionId = sessionIdOf(created)
      throw new PluginError('Hyperbrowser answered a session without an id and a wsEndpoint.', {
        kind: 'refused',
        ...(sessionId === undefined ? {} : { handle: { sessionId } }),
      })
    }
    const { id, wsEndpoint, liveUrl, token, sessionUrl } = answer.data
    const link = dashboardLink(sessionUrl)
    return {
      handle: { sessionId: id },
      protocol: 'cdp' as const,
      url: wsEndpoint,
      mask: [wsEndpoint, liveUrl, token].filter((value) => value !== undefined),
      ...(link === undefined ? {} : { link }),
    }
  },

  async release({ options, handle }, ctx) {
    const parsed = HandleSchema.safeParse(handle)
    if (!parsed.success) {
      throw new PluginError('A Hyperbrowser handle names its session by sessionId.', {
        kind: 'refused',
      })
    }
    await createHyperbrowserApi(options).stop(parsed.data.sessionId, ctx.signal)
  },
})
