import {
  connectionSecretNames,
  formatRemoteOrigin,
  remoteLabel,
  remoteOrigin,
  type RemoteEntryLike,
} from '@vostride/agent-qa-schema'

import { readDeclaredSecrets } from '../composition/declared-secrets.js'
import type { CheckResult, DoctorCheck } from './doctor.js'

export const REMOTE_PROBE_TIMEOUT_MS = 3000

export interface RemoteChecksInput {
  config: Record<string, unknown> | null
  configPath: string
  secretsFile?: { configuredPath: string; absolutePath: string }
  only?: string
  loopbackTargetsByRemote?: ReadonlyMap<string, readonly string[]>
  fetchTimeoutMs?: number
}

const REMOTE_FIX =
  'Check the remote under registry.remotes in agent-qa.config.yaml and its secrets in workspace.secretsFile.'

const HTTP_SCHEMES: Partial<Record<string, string>> = {
  ws: 'http',
  wss: 'https',
  http: 'http',
  https: 'https',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function listedRemotes(config: Record<string, unknown> | null): RemoteEntryLike[] {
  const registry = config?.registry
  const remotes = isRecord(registry) ? registry.remotes : undefined
  if (!Array.isArray(remotes)) return []
  return remotes.filter(isRecord).flatMap((entry) =>
    typeof entry.name === 'string'
      ? [
          {
            ...entry,
            name: entry.name,
            protocol: typeof entry.protocol === 'string' ? entry.protocol : '',
            url: typeof entry.url === 'string' ? entry.url : '',
          } as RemoteEntryLike,
        ]
      : [],
  )
}

// Only the scheme, host, port and path go out: never the query, headers or basicAuth.
function probeUrl(entry: RemoteEntryLike): string | undefined {
  const origin = remoteOrigin(entry.url)
  const scheme = origin ? HTTP_SCHEMES[origin.scheme] : undefined
  if (!origin || !scheme) return undefined
  const base = formatRemoteOrigin({ ...origin, scheme })
  const pathname = new URL(entry.url).pathname
  // A path still holding a {{…}} reference is not sent.
  const path = /\{\{|%7B%7B/i.test(pathname) ? '' : pathname.replace(/\/+$/, '')
  if (entry.protocol === 'playwright') return `${base}${path}/json`
  if (entry.protocol === 'cdp' && (origin.scheme === 'http' || origin.scheme === 'https')) {
    return `${base}${path}/json/version`
  }
  return base
}

async function answers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

function formatBound(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

function declaredNames(absolutePath: string, names: readonly string[]): Set<string> {
  try {
    const store = readDeclaredSecrets(absolutePath)
    return new Set(names.filter((name) => store.has(name)))
  } catch {
    // A missing or invalid file is the Secrets file row's to report; here nothing is declared.
    return new Set()
  }
}

function secretsProblem(
  entry: RemoteEntryLike,
  label: string,
  secretsFile: RemoteChecksInput['secretsFile'],
): string | undefined {
  const names = connectionSecretNames([entry])
  if (names.length === 0) return undefined
  if (!secretsFile) {
    return `${label}: ${names.join(', ')} cannot be checked; workspace.secretsFile is not set.`
  }
  const declared = declaredNames(secretsFile.absolutePath, names)
  const missing = names.filter((name) => !declared.has(name))
  if (missing.length === 0) return undefined
  return `${label}: ${missing.join(', ')} not declared in ${secretsFile.configuredPath}.`
}

function loopbackNote(targets: readonly string[]): string {
  const named =
    targets.length === 1 ? `target ${targets[0]} is` : `targets ${targets.join(', ')} are`
  return `${named} on this machine's loopback, which the remote reaches only through a tunnel you run.`
}

function remoteCheck(
  entry: RemoteEntryLike,
  input: RemoteChecksInput,
  timeoutMs: number,
): () => Promise<CheckResult> {
  return async () => {
    const label = remoteLabel(entry)
    const problems: string[] = []
    const secrets = secretsProblem(entry, label, input.secretsFile)
    if (secrets) problems.push(secrets)

    const url = probeUrl(entry)
    const answered = url !== undefined && (await answers(url, timeoutMs))
    if (url === undefined) problems.push(`${label}: the url is not a valid url.`)
    else if (!answered) problems.push(`${label} did not answer within ${formatBound(timeoutMs)}.`)

    const loopback = input.loopbackTargetsByRemote?.get(entry.name) ?? []
    if (loopback.length > 0) {
      problems.push(
        answered ? `${label} answers; ${loopbackNote(loopback)}` : `${label}: ${loopbackNote(loopback)}`,
      )
    }

    if (problems.length > 0) return { status: 'warn', message: problems.join(' ') }
    return { status: 'pass', message: `${label} answers; credentials are checked when a test connects.` }
  }
}

// Each row makes plain HTTP requests only, so it never opens a browser session, and it never fails.
export function createRemoteChecks(input: RemoteChecksInput): DoctorCheck[] {
  const timeoutMs = input.fetchTimeoutMs ?? REMOTE_PROBE_TIMEOUT_MS
  return listedRemotes(input.config)
    .filter((entry) => input.only === undefined || entry.name === input.only)
    .map((entry) => ({
      name: `Remote ${entry.name}`,
      fixInstructions: REMOTE_FIX,
      check: remoteCheck(entry, input, timeoutMs),
    }))
}
