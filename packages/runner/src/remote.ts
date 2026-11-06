export type RemoteProtocol = 'playwright' | 'cdp' | 'appium'

export type RemoteBrowserProtocol = 'playwright' | 'cdp'

// Connection values keep their `{{secret:NAME}}` references; the adapter resolves them at connect.
export interface RemoteBrowserConfig {
  name: string
  protocol: RemoteBrowserProtocol
  url: string
  query?: Record<string, string | Record<string, unknown>>
  headers?: Record<string, string>
  basicAuth?: { user: string; password: string }
  connectTimeoutMs: number
  context?: 'new' | 'reuse'
}

// The Appium server a device connects to, with its `{{secret:NAME}}` references unresolved.
export interface RemoteDeviceConfig {
  name: string
  protocol: 'appium'
  url: string
  headers?: Record<string, string>
  basicAuth?: { user: string; password: string }
  connectTimeoutMs: number
  capabilities?: Record<string, unknown>
}

export const DEFAULT_REMOTE_CONNECT_TIMEOUT_MS = 5 * 60 * 1000

export const DEFAULT_REMOTE_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

// A remote served by a plugins entry: the entry's host answers with the connection at acquire.
export interface RemotePluginRef {
  entry: string
  settings?: Record<string, unknown>
}

export interface RemotePluginBrowserConfig {
  name: string
  plugin: RemotePluginRef
  connectTimeoutMs: number
  context?: 'new' | 'reuse'
}

export interface RemotePluginDeviceConfig {
  name: string
  plugin: RemotePluginRef
  connectTimeoutMs: number
  uploadTimeoutMs: number
  capabilities?: Record<string, unknown>
}

export function isPluginRemote<T extends object>(
  remote: T,
): remote is Extract<T, { plugin: RemotePluginRef }> {
  return 'plugin' in remote
}

export type RemoteLeaseOutcome = 'passed' | 'failed' | 'error' | 'cancelled'

export type RemotePluginOrigin = 'first-party' | 'third-party' | 'path'

export interface RemotePluginEvidence {
  entry: string
  package?: string
  path?: string
  version: string
  protocol: number
  origin: RemotePluginOrigin
}

// Values here are resolved: the plugin answered with what to connect to.
export interface RemoteLeaseAnswer {
  protocol: RemoteProtocol
  url: string
  headers?: Record<string, string>
  capabilities?: Record<string, unknown>
}

// A plugin's report on a call still under way, such as a farm queue position or an upload's
// percentage. It never extends the call's deadline.
export interface RemoteProgress {
  message: string
  queued?: number
  percent?: number
}

export interface RemoteLeaseRequest {
  remote: string
  plugin: RemotePluginRef
  deadlineMs: number
  session:
    | { platform: 'web'; engine: 'chromium' | 'firefox' | 'webkit'; context: 'new' | 'reuse' }
    | { platform: 'android' | 'ios'; capabilities: Record<string, unknown> }
  testName?: string
  onProgress?(progress: RemoteProgress): void
}

export interface RemoteLeaseEnded {
  kind: 'lost' | 'timeout'
  message: string
}

export interface RemoteLease {
  connection: RemoteLeaseAnswer
  plugin: RemotePluginEvidence
  link?: string
  started(input: { sessionId?: string }): Promise<{ link?: string; appiumVersion?: string }>
  end(outcome: RemoteLeaseOutcome, reason?: string): Promise<void>
  release(): Promise<void>
  // The session ended under the test, because its plugin stopped. A listener added after the
  // end is called at once.
  onEnded(listener: (ended: RemoteLeaseEnded) => void): () => void
}

// A lease goes back to its plugin once, however many paths ask; a failed release is not retried.
export function releasingOnce(lease: Pick<RemoteLease, 'release'>): () => Promise<void> {
  let released: Promise<void> | undefined
  return () => (released ??= lease.release().catch(() => undefined))
}

// A plugin's acquire spends the remote's connect budget; the session after it still gets this much.
export const MIN_PLUGIN_CONNECT_MS = 1_000

export interface RemoteLeaseSource {
  acquire(request: RemoteLeaseRequest): Promise<RemoteLease>
  uploadApp?(request: {
    remote: string
    plugin: RemotePluginRef
    platform: 'android' | 'ios'
    path: string
    deadlineMs: number
    onProgress?(progress: RemoteProgress): void
  }): Promise<{ ref: string }>
}

export type RemoteFailureKind =
  | 'unreachable'
  | 'auth'
  | 'capacity'
  | 'timeout'
  | 'refused'
  | 'version'
  | 'ended'
  | 'lost'

export interface RemoteUnsupported {
  capability: string
  reason: string
}

export type IOSDeviceType = 'simulator' | 'real device' | 'unknown'

// Names the remote by its origin only: the path, query and header values may carry secrets.
export type RemotePlaceEvidence =
  | { place: 'here'; deviceType?: IOSDeviceType }
  | {
      place: 'remote'
      name: string
      protocol: RemoteBrowserProtocol
      origin: string
      browserVersion: string
      headless: 'decided by the remote'
      unsupported: readonly RemoteUnsupported[]
      heartbeat?: { sent: number; failed: number; suspect: boolean }
      failureKind?: RemoteFailureKind
      plugin?: RemotePluginEvidence
      link?: string
    }
  | {
      place: 'remote'
      name: string
      protocol: 'appium'
      origin: string
      device: string
      appiumVersion?: string
      sessionId?: string
      deviceType?: IOSDeviceType
      heartbeat?: { sent: number; failed: number; suspect: boolean }
      failureKind?: RemoteFailureKind
      notes?: readonly string[]
      plugin?: RemotePluginEvidence
      link?: string
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
  'refused',
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

/** How long a plugin's lease release and its shutdown each get on a signal. */
export const PLUGIN_RELEASE_BOUND_MS = 5_000

// One per host process: an adapter registers its session's release after a connect. An entry
// registered with its own bound is handed and raced against that bound instead of releaseAll's.
export interface RemoteSessionRegistry {
  register(
    release: (boundMs: number) => Promise<void>,
    options?: { boundMs?: number },
  ): () => void
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
  const releases = new Set<{
    release: (boundMs: number) => Promise<void>
    boundMs: number | undefined
  }>()
  return {
    register(release, options) {
      const entry = { release, boundMs: options?.boundMs }
      releases.add(entry)
      return () => {
        releases.delete(entry)
      }
    },
    async releaseAll(boundMs) {
      const due = [...releases]
      releases.clear()
      await Promise.all(
        due.map((entry) => {
          const bound = entry.boundMs ?? boundMs
          return settleWithin(() => entry.release(bound), bound)
        }),
      )
    },
  }
}
