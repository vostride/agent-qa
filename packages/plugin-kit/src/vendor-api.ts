import { PluginError, type PluginErrorOptions } from './define-plugin.js'

type FailureKind = PluginErrorOptions['kind']

export type VendorStatusKinds = Readonly<Partial<Record<number, FailureKind>>>

export function vendorFailureKind(
  status: number | undefined,
  kinds?: VendorStatusKinds,
): FailureKind {
  if (status === undefined) return 'unreachable'
  const own = kinds?.[status]
  if (own !== undefined) return own
  if (status === 401) return 'auth'
  if (status === 429) return 'capacity'
  return 'refused'
}

export interface VendorApiInput {
  vendor: string
  baseUrl: string
  headers?: Record<string, string>
  kinds?: VendorStatusKinds
}

export interface VendorRequestInit {
  headers?: Record<string, string>
  body?: string | FormData
  signal?: AbortSignal | undefined
}

export interface VendorApi {
  send(method: string, path: string, init?: VendorRequestInit): Promise<Response>
  failure(
    response: Response,
    request: string,
    extra?: { handle?: PluginErrorOptions['handle'] },
  ): Promise<PluginError>
  json(response: Response): Promise<unknown>
}

const MAX_REASON_LENGTH = 200

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}…` : line
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function vendorReason(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  for (const field of ['message', 'error'] as const) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  return undefined
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

export function createVendorApi(input: VendorApiInput): VendorApi {
  const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`

  return {
    async send(method, path, init = {}) {
      const url = new URL(path, base)
      // Headers match names case-insensitively, so a fixed credential always wins.
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value)
      try {
        return await fetch(url, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.signal === undefined ? {} : { signal: init.signal }),
        })
      } catch (error) {
        if (init.signal?.aborted === true) throw error
        throw new PluginError(
          `${input.vendor} could not be reached at ${url.origin}: ${causeText(error)}`,
          { kind: 'unreachable' },
        )
      }
    },

    async failure(response, request, extra = {}) {
      const text = await response.text().catch(() => '')
      const message = vendorReason(parseJson(text))
      const reason = message === undefined ? '' : `: ${message}`
      const retryAfter = response.headers.get('retry-after')
      const wait =
        response.status === 429 && retryAfter !== null ? `, retry after ${retryAfter} s` : ''
      return new PluginError(
        `${input.vendor} answered ${response.status} to ${request}${reason}${wait}`,
        {
          kind: vendorFailureKind(response.status, input.kinds),
          ...(extra.handle === undefined ? {} : { handle: extra.handle }),
        },
      )
    },

    async json(response) {
      return parseJson(await response.text())
    },
  }
}

export interface EndpointOption<Path extends string = string> {
  path: Path
  scheme: 'https' | 'wss'
}

const PLAIN_TWIN = { https: 'http:', wss: 'ws:' } as const

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function checkEndpoints<Options extends Record<string, unknown>>(
  options: Options,
  endpoints: readonly EndpointOption<keyof Options & string>[],
): void {
  for (const { path, scheme } of endpoints) {
    const value = options[path]
    if (value === undefined) continue
    const url = URL.parse(String(value))
    const allowed =
      url !== null &&
      url.username === '' &&
      url.password === '' &&
      (url.protocol === `${scheme}:` ||
        (url.protocol === PLAIN_TWIN[scheme] && isLoopback(url.hostname)))
    if (!allowed) {
      throw new PluginError(
        `${path} must use ${scheme}:// with no user or password, unless it points at this machine.`,
        { kind: 'refused', path },
      )
    }
  }
}
