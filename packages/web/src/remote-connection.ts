import { createRequire } from 'node:module'

import { RemoteRefusalError } from '@vostride/agent-qa-runner'
import type {
  RemoteBrowserConfig,
  RemoteFailureKind,
  RemoteProtocol,
} from '@vostride/agent-qa-runner'
import { connectionSecretNames, remoteLabel } from '@vostride/agent-qa-schema'

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
