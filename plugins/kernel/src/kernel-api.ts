import { PluginError, z } from '@vostride/agent-qa-plugin-kit'

type KernelFailureKind = 'auth' | 'capacity' | 'refused' | 'unreachable'

export const KernelBrowserSchema = z.object({
  session_id: z.string().min(1),
  cdp_ws_url: z.string().min(1),
  browser_live_view_url: z.string().min(1).optional(),
})

interface KernelApiInput {
  apiUrl: string
  apiKey: string
}

export type PoolAcquireAnswer = { acquired: true; browser: unknown } | { acquired: false }

export interface KernelApi {
  createBrowser(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  deleteBrowser(id: string, signal?: AbortSignal): Promise<void>
  acquireFromPool(
    pool: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PoolAcquireAnswer>
  releaseToPool(pool: string, sessionId: string, reuse: boolean, signal?: AbortSignal): Promise<void>
  listBrowsers(limit: number, signal?: AbortSignal): Promise<void>
  orgLimits(signal?: AbortSignal): Promise<unknown>
  getPool(pool: string, signal?: AbortSignal): Promise<boolean>
}

export function kernelFailureKind(status: number | undefined): KernelFailureKind {
  if (status === undefined) return 'unreachable'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 529) return 'capacity'
  return 'refused'
}

interface SendInit {
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal | undefined
}

const MAX_REASON_LENGTH = 200

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}…` : line
}

async function vendorReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body
      if (typeof message === 'string' && message.trim() !== '') return `: ${oneLine(message)}`
    }
  } catch {
    // a body that is not JSON carries no reason worth showing
  }
  return ''
}

async function statusFailure(response: Response, request: string): Promise<PluginError> {
  const retryAfter = response.headers.get('retry-after')
  const wait = response.status === 429 && retryAfter !== null ? `, retry after ${retryAfter} s` : ''
  const reason = await vendorReason(response)
  return new PluginError(`Kernel answered ${response.status} to ${request}${reason}${wait}`, {
    kind: kernelFailureKind(response.status),
  })
}

async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function causeText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : cause.message
    return oneLine(code)
  }
  return oneLine(error.message)
}

export function createKernelApi(input: KernelApiInput): KernelApi {
  const base = input.apiUrl.endsWith('/') ? input.apiUrl : `${input.apiUrl}/`
  const authorization = `Bearer ${input.apiKey}`

  const send = async (method: string, path: string, init: SendInit): Promise<Response> => {
    const url = new URL(path, base)
    try {
      return await fetch(url, {
        method,
        headers: { ...init.headers, authorization },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      throw new PluginError(`Kernel could not be reached at ${url.origin}: ${causeText(error)}`, {
        kind: 'unreachable',
      })
    }
  }

  const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' }
  const poolPath = (pool: string, action = '') =>
    `browser_pools/${encodeURIComponent(pool)}${action === '' ? '' : `/${action}`}`

  return {
    async createBrowser(body, signal) {
      const response = await send('POST', 'browsers', {
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw await statusFailure(response, 'POST /browsers')
      return jsonOf(response)
    },

    async deleteBrowser(id, signal) {
      const response = await send('DELETE', `browsers/${encodeURIComponent(id)}`, { signal })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await statusFailure(response, 'DELETE /browsers/{id}')
    },

    async acquireFromPool(pool, body, signal) {
      const response = await send('POST', poolPath(pool, 'acquire'), {
        headers: jsonHeaders,
        body: JSON.stringify(body),
        signal,
      })
      if (response.status === 204) {
        await response.body?.cancel()
        return { acquired: false }
      }
      if (!response.ok) throw await statusFailure(response, 'POST /browser_pools/{pool}/acquire')
      return { acquired: true, browser: await jsonOf(response) }
    },

    async releaseToPool(pool, sessionId, reuse, signal) {
      const response = await send('POST', poolPath(pool, 'release'), {
        headers: jsonHeaders,
        body: JSON.stringify({ session_id: sessionId, reuse }),
        signal,
      })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await statusFailure(response, 'POST /browser_pools/{pool}/release')
    },

    async listBrowsers(limit, signal) {
      const response = await send('GET', `browsers?limit=${String(limit)}`, {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await statusFailure(response, 'GET /browsers')
      await response.body?.cancel()
    },

    async orgLimits(signal) {
      const response = await send('GET', 'org/limits', {
        headers: { accept: 'application/json' },
        signal,
      })
      if (!response.ok) throw await statusFailure(response, 'GET /org/limits')
      return jsonOf(response)
    },

    async getPool(pool, signal) {
      const response = await send('GET', poolPath(pool), {
        headers: { accept: 'application/json' },
        signal,
      })
      if (response.status === 404) {
        await response.body?.cancel()
        return false
      }
      if (!response.ok) throw await statusFailure(response, 'GET /browser_pools/{pool}')
      await response.body?.cancel()
      return true
    },
  }
}
