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

export interface RemoteUnsupported {
  capability: string
  reason: string
}

// Names the remote by its origin only: the path, query and header values may carry secrets.
export type RemotePlaceEvidence =
  | { place: 'here' }
  | {
      place: 'remote'
      name: string
      protocol: RemoteProtocol
      origin: string
      browserVersion: string
      headless: 'decided by the remote'
      unsupported: readonly RemoteUnsupported[]
      heartbeat?: { sent: number; failed: number; suspect: boolean }
      failureKind?: RemoteFailureKind
    }

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

/** How long each open remote session gets to release on a signal; all release at once. */
export const REMOTE_RELEASE_BOUND_MS = 2_000

// One per host process: an adapter registers its session's release after a connect.
export interface RemoteSessionRegistry {
  register(release: (boundMs: number) => Promise<void>): () => void
  releaseAll(boundMs: number): Promise<void>
}

// Each release is raced against its own timer, so a silent remote never holds the others.
function settleWithin(work: () => Promise<void>, boundMs: number): Promise<void> {
  return new Promise<void>((settled) => {
    const handle = setTimeout(settled, boundMs) as unknown as { unref?: () => void }
    handle.unref?.()
    const done = (): void => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
      settled()
    }
    try {
      work().then(done, done)
    } catch {
      done()
    }
  })
}

export function createRemoteSessionRegistry(): RemoteSessionRegistry {
  const releases = new Set<{ release: (boundMs: number) => Promise<void> }>()
  return {
    register(release) {
      const entry = { release }
      releases.add(entry)
      return () => {
        releases.delete(entry)
      }
    },
    async releaseAll(boundMs) {
      const due = [...releases]
      releases.clear()
      await Promise.all(due.map((entry) => settleWithin(() => entry.release(boundMs), boundMs)))
    },
  }
}
