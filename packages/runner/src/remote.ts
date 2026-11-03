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
