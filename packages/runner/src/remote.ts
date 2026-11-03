export type RemoteProtocol = 'playwright' | 'cdp'

// Connection values keep their `{{secret:NAME}}` references; the adapter resolves them at connect.
export interface RemoteBrowserConfig {
  name: string
  protocol: RemoteProtocol
  url: string
  query?: Record<string, string | Record<string, unknown>>
  headers?: Record<string, string>
  basicAuth?: { user: string; password: string }
  connectTimeoutMs: number
  context?: 'new' | 'reuse'
}

export const DEFAULT_REMOTE_CONNECT_TIMEOUT_MS = 5 * 60 * 1000

export type RemoteFailureKind =
  | 'unreachable'
  | 'auth'
  | 'capacity'
  | 'timeout'
  | 'version'
  | 'ended'
  | 'lost'

// Built from the refusal sentence alone, so nothing from the failed connection rides along.
export class RemoteRefusalError extends Error {
  readonly remote: string | undefined
  readonly kind: RemoteFailureKind | undefined

  constructor(message: string, details: { remote?: string; kind?: RemoteFailureKind } = {}) {
    super(message)
    this.name = 'RemoteRefusalError'
    this.remote = details.remote
    this.kind = details.kind
  }
}

export interface RemoteRefusalMemory {
  refusalFor(name: string): RemoteRefusalError | undefined
  remember(name: string, error: RemoteRefusalError): RemoteRefusalError
}

const REMEMBERED_KINDS: ReadonlySet<RemoteFailureKind> = new Set([
  'unreachable',
  'auth',
  'capacity',
  'version',
  'timeout',
])

export function createRemoteRefusalMemory(): RemoteRefusalMemory {
  const refusals = new Map<string, RemoteRefusalError>()
  return {
    refusalFor(name) {
      const refused = refusals.get(name)
      if (refused === undefined) return undefined
      return new RemoteRefusalError(refused.message, {
        ...(refused.remote !== undefined ? { remote: refused.remote } : {}),
        ...(refused.kind !== undefined ? { kind: refused.kind } : {}),
      })
    },
    remember(name, error) {
      if (error.kind !== undefined && REMEMBERED_KINDS.has(error.kind) && !refusals.has(name)) {
        refusals.set(name, error)
      }
      return error
    },
  }
}
