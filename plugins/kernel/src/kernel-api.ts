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

interface KernelApi {
  createBrowser(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  deleteBrowser(id: string, signal?: AbortSignal): Promise<void>
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

  return {
    async createBrowser(body, signal) {
      const response = await send('POST', 'browsers', {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw await statusFailure(response, 'POST /browsers')
      const text = await response.text()
      try {
        return JSON.parse(text) as unknown
      } catch {
        return undefined
      }
    },

    async deleteBrowser(id, signal) {
      const response = await send('DELETE', `browsers/${encodeURIComponent(id)}`, { signal })
      if (response.ok || response.status === 404) {
        await response.body?.cancel()
        return
      }
      throw await statusFailure(response, 'DELETE /browsers/{id}')
    },
  }
}
