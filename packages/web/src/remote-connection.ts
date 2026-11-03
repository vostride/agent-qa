import { createRequire } from 'node:module'

import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type {
  RemoteBrowserConfig,
  RemoteFailureKind,
  RemoteProtocol,
} from '@vostride/agent-qa-runner'
import { connectionSecretNames, remoteLabel, remoteOrigin } from '@vostride/agent-qa-schema'

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

export function playwrightVersion(): string {
  const manifest = require('playwright-core/package.json') as { version: string }
  return manifest.version
}

// Resolved at classification, so loading this module does not load Playwright.
function isPlaywrightTimeout(error: unknown): boolean {
  const { errors } = require('playwright-core') as typeof import('playwright-core')
  return error instanceof errors.TimeoutError
}

export function playwrightMajorMinor(): string {
  return playwrightVersion().split('.').slice(0, 2).join('.')
}

export function formatConnectTimeout(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${String(ms / 60_000)}m`
  if (ms > 0 && ms % 1_000 === 0) return `${String(ms / 1_000)}s`
  return `${String(ms)}ms`
}

const UPGRADE_STATUS = /WebSocket error: \S+ (\d{3})\b/
const DISCOVERY_STATUS = /Unexpected status (\d{3})\b/

function connectStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || typeof error.message !== 'string') return undefined
  const firstLine = error.message.split('\n', 1)[0] ?? ''
  const found = UPGRADE_STATUS.exec(firstLine) ?? DISCOVERY_STATUS.exec(firstLine)
  return found ? Number(found[1]) : undefined
}

export function classifyConnectError(error: unknown, protocol: RemoteProtocol): RemoteFailureKind {
  if (isPlaywrightTimeout(error)) return 'timeout'
  const status = connectStatus(error)
  if (status === 401 || status === 403) return 'auth'
  if (status === 428 && protocol === 'playwright') return 'version'
  if (status === 429 || status === 503) return 'capacity'
  return 'unreachable'
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`
}

function refusalSentence(
  kind: RemoteFailureKind,
  remote: RemoteBrowserConfig,
  context: { secretsFile?: string },
): string {
  const label = remoteLabel(remote)
  switch (kind) {
    case 'auth': {
      const names = [...connectionSecretNames([remote])].sort()
      if (names.length === 0) {
        return `Remote ${label} refused the credentials. Check its headers, query and basicAuth in registry.remotes.`
      }
      const secretsFile = context.secretsFile ?? 'workspace.secretsFile'
      return `Remote ${label} refused the credentials. Check ${listNames(names)} in ${secretsFile}.`
    }
    case 'timeout':
      return `Remote ${label} did not connect within ${formatConnectTimeout(remote.connectTimeoutMs)}. Raise its connectTimeout or check the service.`
    case 'capacity':
      return `Remote ${label} has no free session. Lower use.workers or raise the service's limit.`
    case 'version':
      return `Remote ${label} runs another Playwright version; agent-qa uses ${playwrightMajorMinor()}.`
    default:
      return `Remote ${label} did not answer. Check its url and that the service is running.`
  }
}

// Playwright's connect errors repeat the endpoint, its credentials and the server's reply, so none of it is kept.
export function rewriteConnectError(
  error: unknown,
  remote: RemoteBrowserConfig,
  context: { secretsFile?: string } = {},
): RemoteRefusalError {
  const kind = classifyConnectError(error, remote.protocol)
  return new RemoteRefusalError(refusalSentence(kind, remote, context), {
    remote: remoteLabel(remote),
    kind,
  })
}

const PLAYWRIGHT_LOGGERS = ['pw:api', 'pw:protocol'] as const

function namespacePattern(pattern: string): RegExp {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${parts.join('.*')}$`)
}

// The debug package's own rules: comma or whitespace separated, `-` skips, `*` matches anything.
export function debugEnablesPlaywright(debug: string | undefined): boolean {
  const patterns = (debug ?? '').split(/[\s,]+/).filter((pattern) => pattern !== '')
  const includes = patterns.filter((pattern) => !pattern.startsWith('-')).map(namespacePattern)
  const skips = patterns
    .filter((pattern) => pattern.startsWith('-'))
    .map((pattern) => namespacePattern(pattern.slice(1)))
  return PLAYWRIGHT_LOGGERS.some(
    (name) =>
      !skips.some((skip) => skip.test(name)) && includes.some((include) => include.test(name)),
  )
}

const ENDPOINT_URL = /\b(?:wss?|https?):\/\/[^\s'"`<>]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)'"]+$/

function urlHost(url: string): string | undefined {
  const origin = remoteOrigin(url)
  if (origin !== undefined) return origin.host.toLowerCase()
  const authority = url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/, 1)[0] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const bracketed = /^\[([^\]]*)\]/.exec(hostPort)
  const host = bracketed ? bracketed[1] : hostPort.split(':', 1)[0]
  return host === undefined || host === '' ? undefined : host.toLowerCase()
}

// A remote's endpoint can carry credentials in its userinfo, path or query; text shows its label.
export function scrubRemoteEndpoint(
  text: string,
  remote: Pick<RemoteBrowserConfig, 'name' | 'protocol' | 'url'>,
): string {
  const label = remoteLabel(remote)
  const host = urlHost(remote.url)
  if (host === undefined) return remote.url === '' ? text : text.split(remote.url).join(label)
  // The label itself holds the remote's origin, so it is kept as it is.
  return text
    .split(label)
    .map((part) =>
      part.replace(ENDPOINT_URL, (found) => {
        const trailing = TRAILING_PUNCTUATION.exec(found)?.[0] ?? ''
        const url = found.slice(0, found.length - trailing.length)
        return urlHost(url) === host ? `${label}${trailing}` : found
      }),
    )
    .join(label)
}
