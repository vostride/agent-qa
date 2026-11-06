import { createRequire } from 'node:module'
import { connect } from 'node:net'

import { basicAuthorizationValue, RemoteRefusalError } from '@vostride/agent-qa-runner'
import type {
  RemoteBrowserConfig,
  RemoteBrowserProtocol,
  RemoteFailureKind,
  SecretResolver,
} from '@vostride/agent-qa-runner'
import {
  connectionSecretNames,
  PLAYWRIGHT_VERSION_TOKEN,
  remoteLabel,
  remoteOrigin,
  SECRET_REFERENCE_PATTERN,
} from '@vostride/agent-qa-schema'

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

export function classifyConnectError(
  error: unknown,
  protocol: RemoteBrowserProtocol,
): RemoteFailureKind {
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

// A plugin remote connects to the endpoint its plugin answered, so its refusals name the remote
// by its plugins entry, point at that entry, and count the remote's whole connectTimeout.
export interface PluginConnect {
  entry: string
  connectTimeoutMs: number
}

interface ConnectContext {
  secretsFile?: string
  plugin?: PluginConnect
}

function connectLabel(remote: RemoteBrowserConfig, plugin: PluginConnect | undefined): string {
  return plugin === undefined
    ? remoteLabel(remote)
    : remoteLabel({ name: remote.name, plugin: plugin.entry })
}

function pluginRefusalSentence(kind: RemoteFailureKind, label: string, plugin: PluginConnect) {
  const entry = `plugin entry ${plugin.entry}`
  switch (kind) {
    case 'auth':
      return `Remote ${label} refused the credentials its plugin answered with. Check ${entry}'s options and the remote's settings.`
    case 'timeout':
      return `Remote ${label} did not connect within ${formatConnectTimeout(plugin.connectTimeoutMs)}. Raise its connectTimeout or check the service.`
    case 'capacity':
    case 'version':
      return undefined
    default:
      return `Remote ${label} did not answer at the endpoint its plugin gave. Check ${entry}'s options and that the service is running.`
  }
}

function refusalSentence(
  kind: RemoteFailureKind,
  remote: RemoteBrowserConfig,
  context: ConnectContext,
): string {
  const label = connectLabel(remote, context.plugin)
  const forPlugin =
    context.plugin === undefined ? undefined : pluginRefusalSentence(kind, label, context.plugin)
  if (forPlugin !== undefined) return forPlugin
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
  context: ConnectContext = {},
): RemoteRefusalError {
  const kind = classifyConnectError(error, remote.protocol)
  return new RemoteRefusalError(refusalSentence(kind, remote, context), {
    remote: connectLabel(remote, context.plugin),
    kind,
  })
}

// A remote that goes silent after its handshake would hold setup with no test timeout running yet.
export function withinConnectTimeout<T>(
  work: Promise<T>,
  remote: RemoteBrowserConfig,
  plugin?: PluginConnect,
): Promise<T> {
  void work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const label = connectLabel(remote, plugin)
      const budget = plugin?.connectTimeoutMs ?? remote.connectTimeoutMs
      reject(
        new RemoteRefusalError(
          `Remote ${label} connected but did not open a page within ${formatConnectTimeout(budget)}. Raise its connectTimeout or check the service.`,
          { remote: label, kind: 'timeout' },
        ),
      )
    }, remote.connectTimeoutMs)
    timer.unref?.()
  })
  return Promise.race([work, bound]).finally(() => clearTimeout(timer))
}

/** The longest the probe after a dropped session waits for the remote's host to answer. */
export const REMOTE_DISCONNECT_PROBE_MS = 2_000

export type RemoteDisconnectKind = Extract<RemoteFailureKind, 'ended' | 'lost'>

// The close code is not public, so a host that still accepts a connection ended the session.
export function classifyDisconnect(
  remote: Pick<RemoteBrowserConfig, 'url'>,
): Promise<RemoteDisconnectKind> {
  const origin = remoteOrigin(remote.url)
  if (origin === undefined) return Promise.resolve('lost')
  return new Promise((settle) => {
    const socket = connect({ host: origin.host, port: origin.port })
    const done = (kind: RemoteDisconnectKind): void => {
      clearTimeout(timer)
      socket.destroy()
      settle(kind)
    }
    const timer = setTimeout(() => done('lost'), REMOTE_DISCONNECT_PROBE_MS)
    timer.unref?.()
    socket.once('connect', () => done('ended'))
    socket.once('error', () => done('lost'))
  })
}

export function disconnectSentence(
  kind: RemoteDisconnectKind,
  remote: Pick<RemoteBrowserConfig, 'name' | 'protocol' | 'url'>,
): string {
  const label = remoteLabel(remote)
  return kind === 'ended'
    ? `Remote ${label} ended the session while this test ran.`
    : `The connection to remote ${label} was lost while this test ran.`
}

export interface RemoteConnection {
  readonly url: string
  readonly headers: Record<string, string>
}

export interface RemoteConnectionOptions {
  readonly secrets?: SecretResolver | undefined
  readonly secretsFile?: string | undefined
}

function resolveTokens(
  text: string,
  secrets: SecretResolver,
  encode: (value: string) => string = (value) => value,
): string {
  const pattern = new RegExp(SECRET_REFERENCE_PATTERN.source, 'g')
  return text
    .split(PLAYWRIGHT_VERSION_TOKEN)
    .map((part) => part.replace(pattern, (_found, name: string) => encode(secrets.require(name))))
    .join(encode(playwrightVersion()))
}

function resolveLeaves(value: unknown, secrets: SecretResolver): unknown {
  if (typeof value === 'string') return resolveTokens(value, secrets)
  if (Array.isArray(value)) return value.map((item) => resolveLeaves(item, secrets))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveLeaves(item, secrets)]),
    )
  }
  return value
}

// Encoded by hand, so the wire holds exactly the forms the redactor masks.
function withQuery(
  url: string,
  query: RemoteBrowserConfig['query'],
  secrets: SecretResolver,
): string {
  const pairs = Object.entries(query ?? {}).map(([key, value]) => {
    const resolved =
      typeof value === 'string'
        ? resolveTokens(value, secrets)
        : JSON.stringify(resolveLeaves(value, secrets))
    return `${encodeURIComponent(key)}=${encodeURIComponent(resolved)}`
  })
  if (pairs.length === 0) return url
  const hashAt = url.indexOf('#')
  const base = hashAt < 0 ? url : url.slice(0, hashAt)
  const fragment = hashAt < 0 ? '' : url.slice(hashAt)
  const separator = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&'
  return `${base}${separator}${pairs.join('&')}${fragment}`
}

const emptySecrets: SecretResolver = {
  get: () => undefined,
  has: () => false,
  require: (name) => {
    throw new Error(`Secret not found: ${name}`)
  },
}

// Resolved at connect into fresh values; the remote config keeps its references.
export function resolveRemoteConnection(
  remote: RemoteBrowserConfig,
  options: RemoteConnectionOptions = {},
): RemoteConnection {
  const secrets = options.secrets ?? emptySecrets
  const missing = connectionSecretNames([remote]).find((name) => !secrets.has(name))
  if (missing !== undefined) {
    const label = remoteLabel(remote)
    const secretsFile = options.secretsFile ?? 'workspace.secretsFile'
    throw new RemoteRefusalError(
      `Remote ${label} needs ${missing}, which ${secretsFile} does not declare. Add it there.`,
      { remote: label },
    )
  }
  const path = resolveTokens(remote.url, secrets, encodeURIComponent)
  const url = withQuery(path, remote.query, secrets)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(remote.headers ?? {})) {
    headers[name] = resolveTokens(value, secrets)
  }
  if (remote.basicAuth !== undefined) {
    const user = resolveTokens(remote.basicAuth.user, secrets)
    const password = resolveTokens(remote.basicAuth.password, secrets)
    headers.Authorization = `Basic ${basicAuthorizationValue(user, password)}`
  }
  return { url, headers }
}

// Playwright's own loggers, any of which can print a connect call's endpoint and headers.
const PLAYWRIGHT_LOGGERS = [
  'pw:api',
  'pw:protocol',
  'pw:install',
  'pw:download',
  'pw:browser',
  'pw:socks',
  'pw:client-certificates',
  'pw:error',
  'pw:channel',
  'pw:server',
  'pw:server:channel',
  'pw:server:metadata',
  'pw:recorder',
] as const

// Stands for every `pw:` name not listed: only a skip that covers all of `pw:` excludes it.
const UNLISTED_PLAYWRIGHT_LOGGER = 'pw:'

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
  const named = patterns
    .filter((pattern) => !pattern.startsWith('-'))
    .map((pattern) => pattern.replace(/\*/g, ''))
    .filter((name) => name.startsWith('pw:'))
  return [...PLAYWRIGHT_LOGGERS, UNLISTED_PLAYWRIGHT_LOGGER, ...named].some(
    (name) =>
      !skips.some((skip) => skip.test(name)) && includes.some((include) => include.test(name)),
  )
}

const ENDPOINT_URL = /\b(?:wss?|https?):\/\/[^\s'"`<>]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)'"]+$/

const DEFAULT_PORTS: Partial<Record<string, number>> = { ws: 80, http: 80, wss: 443, https: 443 }

// Host and port, so a url on another port of the remote's host is not taken for the remote.
function urlOrigin(url: string): string | undefined {
  const origin = remoteOrigin(url)
  if (origin !== undefined) return `${origin.host.toLowerCase()}:${String(origin.port)}`
  const scheme = /^([a-z]+):\/\//i.exec(url)?.[1]?.toLowerCase() ?? ''
  const authority = url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/, 1)[0] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(hostPort)
  const [host, port] = bracketed ? [bracketed[1], bracketed[2]] : hostPort.split(':', 2)
  const resolvedPort = port === undefined || port === '' ? DEFAULT_PORTS[scheme] : Number(port)
  if (host === undefined || host === '' || resolvedPort === undefined) return undefined
  return `${host.toLowerCase()}:${String(resolvedPort)}`
}

// A remote's endpoint can carry credentials in its userinfo, path or query; text shows its label.
export function scrubRemoteEndpoint(
  text: string,
  remote: Pick<RemoteBrowserConfig, 'name' | 'protocol' | 'url'>,
): string {
  const label = remoteLabel(remote)
  const origin = urlOrigin(remote.url)
  if (origin === undefined) return remote.url === '' ? text : text.split(remote.url).join(label)
  // The label itself holds the remote's origin, so it is kept as it is.
  return text
    .split(label)
    .map((part) =>
      part.replace(ENDPOINT_URL, (found) => {
        const trailing = TRAILING_PUNCTUATION.exec(found)?.[0] ?? ''
        const url = found.slice(0, found.length - trailing.length)
        return urlOrigin(url) === origin ? `${label}${trailing}` : found
      }),
    )
    .join(label)
}
