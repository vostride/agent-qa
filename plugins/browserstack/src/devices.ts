import { randomUUID } from 'node:crypto'
import { z } from '@vostride/agent-qa-plugin-kit'
import { browserStackApiFor, type AppSessionMark } from './browserstack-api.js'
import type { BrowserStackOptions, BrowserStackSettings } from './options.js'

type Json = z.core.util.JSONType

// The newest Appium BrowserStack offers on its devices; it moves with each plugin release.
export const DEFAULT_APPIUM_VERSION = '3.5.2'

const MAX_MARK_REASON_LENGTH = 255

export const DeviceHandleSchema = z.object({
  kind: z.literal('device'),
  id: z.string().min(1),
  platform: z.enum(['android', 'ios']),
  appiumVersion: z.string().min(1),
})

export type DeviceHandle = z.output<typeof DeviceHandleSchema>

export interface DeviceRequest {
  options: BrowserStackOptions
  settings: BrowserStackSettings
  platform: 'android' | 'ios'
  capabilities: Record<string, unknown>
  testName: string | undefined
  runId: string | undefined
}

export interface DeviceAnswer {
  handle: Json
  protocol: 'appium'
  url: string
  capabilities: Record<string, unknown>
  mask: string[]
}

function ownAppiumVersion(capabilities: Record<string, unknown>): string | undefined {
  const own = capabilities['bstack:options']
  if (typeof own !== 'object' || own === null || !('appiumVersion' in own)) return undefined
  const { appiumVersion } = own
  return typeof appiumVersion === 'string' && appiumVersion !== '' ? appiumVersion : undefined
}

export function deviceAnswer(request: DeviceRequest): DeviceAnswer {
  const { options, settings } = request
  const appiumVersion =
    ownAppiumVersion(request.capabilities) ?? settings.appiumVersion ?? DEFAULT_APPIUM_VERSION
  const build = settings.build ?? request.runId
  const name = request.testName
  return {
    handle: {
      kind: 'device',
      id: randomUUID(),
      platform: request.platform,
      appiumVersion,
      ...(build === undefined ? {} : { build }),
      ...(name === undefined ? {} : { name }),
    },
    protocol: 'appium',
    url: options.hubUrl,
    capabilities: {
      'bstack:options': {
        userName: options.username,
        accessKey: options.accessKey,
        appiumVersion,
        projectName: settings.project,
        ...(build === undefined ? {} : { buildName: build }),
        ...(name === undefined ? {} : { sessionName: name }),
        ...settings.extra,
      },
    },
    mask: [],
  }
}

function sessionDetails(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const wrapped = (body as Record<string, unknown>).automation_session
  if (typeof wrapped === 'object' && wrapped !== null) return wrapped as Record<string, unknown>
  return body as Record<string, unknown>
}

function warn(line: string): void {
  process.stderr.write(`${line.replace(/\s+/g, ' ').trim()}\n`)
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface DeviceStartedInput {
  options: BrowserStackOptions
  handle: DeviceHandle
  sessionId: string | undefined
  signal: AbortSignal
}

export async function deviceStarted(
  input: DeviceStartedInput,
): Promise<{ link?: string; appiumVersion: string }> {
  const { appiumVersion } = input.handle
  if (input.sessionId === undefined) return { appiumVersion }
  try {
    const details = sessionDetails(
      await browserStackApiFor(input.options).appSession(input.sessionId, input.signal),
    )
    // browser_url needs a BrowserStack login; public_url is shareable, so it is never recorded.
    const link = details?.browser_url
    if (typeof link === 'string' && link !== '') return { link, appiumVersion }
    warn(`BrowserStack: App Automate session ${input.sessionId} has no dashboard link.`)
  } catch (error) {
    warn(
      `BrowserStack: could not read App Automate session ${input.sessionId}: ${failureText(error)}`,
    )
  }
  return { appiumVersion }
}

export type SessionOutcome = 'passed' | 'failed' | 'error' | 'cancelled'

export function sessionMark(
  outcome: SessionOutcome,
  reason: string | undefined,
): AppSessionMark | undefined {
  if (outcome === 'cancelled') return undefined
  if (outcome === 'passed') return { status: 'passed' }
  return {
    status: 'failed',
    ...(reason === undefined ? {} : { reason: reason.slice(0, MAX_MARK_REASON_LENGTH) }),
  }
}

export interface MarkAppSessionInput {
  options: BrowserStackOptions
  sessionId: string
  outcome: SessionOutcome
  reason: string | undefined
  signal: AbortSignal
}

export async function markAppSession(input: MarkAppSessionInput): Promise<void> {
  const mark = sessionMark(input.outcome, input.reason)
  if (mark === undefined) return
  try {
    await browserStackApiFor(input.options).markAppSession(input.sessionId, mark, input.signal)
  } catch (error) {
    warn(
      `BrowserStack: could not mark App Automate session ${input.sessionId} ${mark.status}: ${failureText(error)}`,
    )
  }
}
