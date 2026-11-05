import { randomUUID } from 'node:crypto'
import { PluginError, z } from '@vostride/agent-qa-plugin-kit'
import { browserStackApiFor, type BrowserStackApi } from './browserstack-api.js'
import {
  failureText,
  sessionDetails,
  sessionMark,
  warn,
  type SessionOutcome,
} from './devices.js'
import type { BrowserStackOptions, BrowserStackSettings } from './options.js'
import {
  BROWSERSTACK_PLAYWRIGHT_VERSIONS,
  listedPlaywright,
  playwrightMajorMinor,
} from './playwright-versions.js'

type Json = z.core.util.JSONType
type Engine = 'chromium' | 'firefox' | 'webkit'

// BrowserStack's created_at and this machine's clock may disagree by a few seconds.
const START_SLACK_MS = 5_000

export const WebHandleSchema = z.object({
  kind: z.literal('web'),
  id: z.string().min(1),
  build: z.string().optional(),
  name: z.string().optional(),
  startedAt: z.string(),
})

export type WebHandle = z.output<typeof WebHandleSchema>

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
  localIdentifier: string | undefined
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
  const ours = playwrightMajorMinor(version)
  const which = ours === undefined ? "and agent-qa's Playwright version is unknown" : `not ${ours}`
  throw new PluginError(
    `BrowserStack lists Playwright ${first} to ${last}, ${which}, so web tests cannot run there yet; run this test here or on another remote.`,
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
    ...(request.localIdentifier === undefined
      ? {}
      : { 'browserstack.local': true, 'browserstack.localIdentifier': request.localIdentifier }),
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
      id: randomUUID(),
      ...(typeof build === 'string' ? { build } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      startedAt: new Date().toISOString(),
    },
    protocol: 'playwright',
    url,
    mask: [url],
  }
}

export interface WebSession {
  hashedId: string
  link: string | undefined
}

function itemsOf(body: unknown, wrapper: string): Record<string, unknown>[] {
  if (!Array.isArray(body)) return []
  return body.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const wrapped = (item as Record<string, unknown>)[wrapper]
    if (typeof wrapped === 'object' && wrapped !== null) return [wrapped as Record<string, unknown>]
    return [item as Record<string, unknown>]
  })
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export interface FindWebSessionInput {
  api: BrowserStackApi
  build: string
  name: string
  startedAt: string
  signal: AbortSignal
}

// Reads automate/builds.json, each matching build's sessions.json and each candidate's details.
// The session is found only when exactly one running session in the build carries the test's
// name and started after the acquire; a guessed session is never linked or marked.
export async function findWebSession(input: FindWebSessionInput): Promise<WebSession | undefined> {
  const { api, signal } = input
  const earliest = Date.parse(input.startedAt) - START_SLACK_MS
  const builds = itemsOf(await api.runningBuilds(signal), 'automation_build').filter(
    (build) => build.name === input.build,
  )
  const found: WebSession[] = []
  for (const build of builds) {
    const buildId = text(build.hashed_id)
    if (buildId === undefined) continue
    const sessions = itemsOf(
      await api.runningBuildSessions(buildId, signal),
      'automation_session',
    ).filter((session) => session.name === input.name)
    for (const session of sessions) {
      const hashedId = text(session.hashed_id)
      if (hashedId === undefined) continue
      const details = sessionDetails(await api.webSession(hashedId, signal))
      const createdAt = Date.parse(text(details?.created_at) ?? '')
      if (!Number.isFinite(createdAt) || createdAt < earliest) continue
      // browser_url needs a BrowserStack login; public_url is shareable, so it is never recorded.
      found.push({ hashedId, link: text(details?.browser_url) ?? text(session.browser_url) })
    }
  }
  return found.length === 1 ? found[0] : undefined
}

export interface WebStartedInput {
  options: BrowserStackOptions
  handle: WebHandle
  signal: AbortSignal
}

export async function webStarted(
  input: WebStartedInput,
): Promise<{ session: WebSession | undefined; link?: string }> {
  const { build, name, startedAt } = input.handle
  const unmarked = `BrowserStack: no single web session matched build ${build ?? '(none)'} and name ${name ?? '(none)'}; it stays unmarked.`
  if (build === undefined || name === undefined) {
    warn(unmarked)
    return { session: undefined }
  }
  let session: WebSession | undefined
  try {
    const api = browserStackApiFor(input.options)
    session = await findWebSession({ api, build, name, startedAt, signal: input.signal })
  } catch (error) {
    warn(
      `BrowserStack: could not look up the web session for build ${build} and name ${name}: ${failureText(error)}; it stays unmarked.`,
    )
    return { session: undefined }
  }
  if (session === undefined) {
    warn(unmarked)
    return { session: undefined }
  }
  if (session.link === undefined) {
    warn(`BrowserStack: Automate session ${session.hashedId} has no dashboard link.`)
    return { session }
  }
  return { session, link: session.link }
}

export interface MarkWebSessionInput {
  options: BrowserStackOptions
  sessionId: string
  outcome: SessionOutcome
  reason: string | undefined
  signal: AbortSignal
}

export async function markWebSession(input: MarkWebSessionInput): Promise<void> {
  const mark = sessionMark(input.outcome, input.reason)
  if (mark === undefined) return
  try {
    // Automate's mark documents reason as required, so a passed mark sends an empty one.
    const body = { ...mark, reason: mark.reason ?? '' }
    await browserStackApiFor(input.options).markWebSession(input.sessionId, body, input.signal)
  } catch (error) {
    warn(
      `BrowserStack: could not mark Automate session ${input.sessionId} ${mark.status}: ${failureText(error)}`,
    )
  }
}
