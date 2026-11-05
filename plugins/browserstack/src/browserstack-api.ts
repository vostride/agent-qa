import { PluginError } from '@vostride/agent-qa-plugin-kit'
import type { BrowserStackOptions } from './options.js'

export type BrowserStackFailureKind = 'auth' | 'capacity' | 'refused' | 'unreachable'

export interface BrowserStackApiInput {
  apiUrl: string
  appApiUrl: string
  username: string
  accessKey: string
}

export interface AppSessionMark {
  status: 'passed' | 'failed'
  reason?: string
}

export interface BrowserStackApi {
  appSession(id: string, signal?: AbortSignal): Promise<unknown>
  markAppSession(id: string, mark: AppSessionMark, signal?: AbortSignal): Promise<void>
  recentApps(customId: string, signal?: AbortSignal): Promise<unknown>
  uploadApp(form: FormData, signal?: AbortSignal): Promise<unknown>
}

export function browserStackFailureKind(status: number | undefined): BrowserStackFailureKind {
  if (status === undefined) return 'unreachable'
  if (status === 401) return 'auth'
  if (status === 429) return 'capacity'
  return 'refused'
}

const MAX_REASON_LENGTH = 200

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}…` : line
}

function vendorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  for (const field of ['message', 'error'] as const) {
    if (field in body) {
      const value = (body as Record<string, unknown>)[field]
      if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
    }
  }
  return undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function statusFailure(response: Response, request: string): Promise<PluginError> {
  const text = await response.text().catch(() => '')
  const message = vendorMessage(parseJson(text))
  const reason = message === undefined ? '' : `: ${message}`
  const retryAfter = response.headers.get('retry-after')
  const wait = response.status === 429 && retryAfter !== null ? `, retry after ${retryAfter} s` : ''
  return new PluginError(`BrowserStack answered ${response.status} to ${request}${reason}${wait}`, {
    kind: browserStackFailureKind(response.status),
  })
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error))
  const cause = error.cause
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : cause.message
    return oneLine(code)
  }
  return oneLine(error.message)
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

interface SendInit {
  headers?: Record<string, string>
  body?: string | FormData
  signal?: AbortSignal | undefined
}

export function createBrowserStackApi(input: BrowserStackApiInput): BrowserStackApi {
  const appBase = withSlash(input.appApiUrl)
  const token = Buffer.from(`${input.username}:${input.accessKey}`).toString('base64')
  const authorization = `Basic ${token}`

  const send = async (method: string, path: string, init: SendInit): Promise<Response> => {
    const url = new URL(path, appBase)
    try {
      return await fetch(url, {
        method,
        headers: { accept: 'application/json', ...init.headers, authorization },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      throw new PluginError(
        `BrowserStack could not be reached at ${url.origin}: ${causeText(error)}`,
        { kind: 'unreachable' },
      )
    }
  }

  const readJson = async (response: Response, request: string): Promise<unknown> => {
    if (!response.ok) throw await statusFailure(response, request)
    return parseJson(await response.text())
  }

  const sessionPath = (id: string) => `app-automate/sessions/${encodeURIComponent(id)}.json`

  return {
    async appSession(id, signal) {
      const response = await send('GET', sessionPath(id), { signal })
      return readJson(response, 'GET /app-automate/sessions/{id}.json')
    },

    async markAppSession(id, mark, signal) {
      const response = await send('PUT', sessionPath(id), {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mark),
        signal,
      })
      if (!response.ok) throw await statusFailure(response, 'PUT /app-automate/sessions/{id}.json')
      await response.body?.cancel()
    },

    async recentApps(customId, signal) {
      const path = `app-automate/recent_apps/${encodeURIComponent(customId)}`
      const response = await send('GET', path, { signal })
      // An unknown custom id may answer 404 with a message, which means nothing is uploaded yet.
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      return readJson(response, 'GET /app-automate/recent_apps/{custom_id}')
    },

    async uploadApp(form, signal) {
      const response = await send('POST', 'app-automate/upload', { body: form, signal })
      return readJson(response, 'POST /app-automate/upload')
    },
  }
}

export function browserStackApiFor(options: BrowserStackOptions): BrowserStackApi {
  return createBrowserStackApi({
    apiUrl: options.apiUrl,
    appApiUrl: options.appApiUrl,
    username: options.username,
    accessKey: options.accessKey,
  })
}
