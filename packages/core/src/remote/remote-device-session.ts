import type {
  IOSDeviceType,
  RemoteDeviceConfig,
  RemoteFailureKind,
} from '@vostride/agent-qa-runner'
import { formatRemoteOrigin, remoteLabel, remoteOrigin } from '@vostride/agent-qa-schema'

/** How long any request after the new session may go unanswered before the test ends as lost. */
export const REMOTE_COMMAND_BOUND_MS = 120_000

type RemoteNamed = Pick<RemoteDeviceConfig, 'name' | 'protocol' | 'url'>

export function remoteDeviceLabel(remote: RemoteNamed): string {
  return remoteLabel(remote)
}

export interface RemoteDeviceReply {
  readonly statusCode: number
  readonly body: unknown
}

export interface RemoteDeviceRequestBounds {
  readonly clientTimeoutMs: number
  boundRequest<T extends { signal?: AbortSignal | null | undefined }>(request: T): T
  captureReply<T extends RemoteDeviceReply>(reply: T): T
  markOpened(): void
  newSessionReply(): RemoteDeviceReply | undefined
}

// The new session waits up to the connect timeout and every later request up to the command bound.
// WebdriverIO's own per-request timeout must be at least the larger of the two.
export function createRemoteDeviceRequestBounds(options: {
  connectTimeoutMs: number
  commandBoundMs: number
}): RemoteDeviceRequestBounds {
  let opened = false
  let reply: RemoteDeviceReply | undefined
  return {
    clientTimeoutMs: Math.max(options.connectTimeoutMs, options.commandBoundMs),
    boundRequest(request) {
      const bound = AbortSignal.timeout(opened ? options.commandBoundMs : options.connectTimeoutMs)
      const existing = request.signal ?? undefined
      const signal = existing === undefined ? bound : AbortSignal.any([existing, bound])
      return Object.assign(request, { signal })
    },
    captureReply(received) {
      if (!opened) reply ??= { statusCode: received.statusCode, body: received.body }
      return received
    },
    markOpened() {
      opened = true
    },
    newSessionReply() {
      return reply
    },
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown }
    return typeof message === 'string' ? message : ''
  }
  return ''
}

function nameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error as { name: unknown }
    return typeof name === 'string' ? name : ''
  }
  return ''
}

const REQUEST_TIMED_OUT = 'Request timed out!'
const UNPARSABLE_BODY = 'Could not parse response body'

export function classifyNewSessionFailure(
  reply: RemoteDeviceReply | undefined,
  error: unknown,
): RemoteFailureKind {
  if (reply === undefined) {
    const message = messageOf(error)
    if (message.includes(REQUEST_TIMED_OUT)) return 'timeout'
    if (message.includes(UNPARSABLE_BODY)) return 'refused'
    return 'unreachable'
  }
  if (reply.statusCode === 401 || reply.statusCode === 403) return 'auth'
  if (reply.statusCode === 429 || reply.statusCode === 503) return 'capacity'
  return 'refused'
}

const ENDPOINT_URL = /\b(?:wss?|https?):\/\/[^\s'"`<>]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)'"]+$/
const SERVER_REASON_MAX = 200

function originText(url: string): string {
  const origin = remoteOrigin(url)
  if (origin !== undefined) return formatRemoteOrigin(origin)
  const scheme = /^([a-z]+):\/\//i.exec(url)?.[1]?.toLowerCase() ?? ''
  const authority = url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/, 1)[0] ?? ''
  return `${scheme}://${authority.slice(authority.lastIndexOf('@') + 1)}`
}

function replaceUrls(text: string, replace: (url: string) => string): string {
  return text.replace(ENDPOINT_URL, (found) => {
    const trailing = TRAILING_PUNCTUATION.exec(found)?.[0] ?? ''
    return `${replace(found.slice(0, found.length - trailing.length))}${trailing}`
  })
}

function replyMessage(reply: RemoteDeviceReply | undefined): string | undefined {
  const body = reply?.body
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as { value?: unknown }).value
  if (typeof value !== 'object' || value === null) return undefined
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

function unparsableBody(error: unknown): string | undefined {
  const message = messageOf(error)
  const start = message.indexOf(`${UNPARSABLE_BODY}: "`)
  if (start === -1) return undefined
  const body = message.slice(start + UNPARSABLE_BODY.length + 3)
  const end = body.lastIndexOf('" when running "')
  return end === -1 ? body.replace(/"$/, '') : body.slice(0, end)
}

// The server's text can hold the endpoint, path tokens and echoed secrets.
export function serverReasonLine(
  source: { reply?: RemoteDeviceReply | undefined; error?: unknown },
  mask: (text: string) => string,
): string | undefined {
  const text = replyMessage(source.reply) ?? unparsableBody(source.error)
  if (text === undefined) return undefined
  const line = text
    .replace(/<[^>]*>/g, ' ')
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part !== '')
  if (line === undefined) return undefined
  const masked = mask(replaceUrls(line, originText))
  if (masked.length <= SERVER_REASON_MAX) return masked
  return `${masked.slice(0, SERVER_REASON_MAX - 1).trimEnd()}…`
}

export interface RemoteDeviceRefusalContext {
  readonly remote: RemoteDeviceConfig
  readonly device: string
  readonly secretsFile?: string | undefined
  readonly secretNames: readonly string[]
  readonly reason?: string | undefined
}

function formatDuration(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${String(ms / 60_000)}m`
  if (ms > 0 && ms % 1_000 === 0) return `${String(ms / 1_000)}s`
  return `${String(ms)}ms`
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`
}

export function remoteDeviceRefusalSentence(
  kind: RemoteFailureKind,
  context: RemoteDeviceRefusalContext,
): string {
  const label = remoteDeviceLabel(context.remote)
  const device = context.device
  switch (kind) {
    case 'auth': {
      if (context.secretNames.length === 0) {
        return `Remote ${label} refused the credentials for device ${device}. Check its headers and basicAuth in registry.remotes.`
      }
      const secretsFile = context.secretsFile ?? 'workspace.secretsFile'
      return `Remote ${label} refused the credentials for device ${device}. Check ${listNames(context.secretNames)} in ${secretsFile}.`
    }
    case 'refused': {
      const reason = context.reason?.replace(/[\s.]+$/, '')
      if (reason === undefined || reason === '') {
        return `Remote ${label} refused a session for device ${device}.`
      }
      return `Remote ${label} refused a session for device ${device}: ${reason}.`
    }
    case 'timeout':
      return `Remote ${label} did not open a session for device ${device} within ${formatDuration(context.remote.connectTimeoutMs)}. Raise its connectTimeout or check the service.`
    case 'capacity':
      return `Remote ${label} has no free device for ${device}. Lower use.workers or raise the service's limit.`
    default:
      return `Remote ${label} did not answer for device ${device}. Check its url and that the server is running.`
  }
}

const SOCKET_FAILURE =
  /Failed to fetch|fetch failed|socket hang up|other side closed|Request failed with error code|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|UND_ERR_/i
const SESSION_ENDED =
  /invalid session id|session (?:is )?not found|no such session|terminated or not started|session (?:was |has )?ended/i

function isRequestTimeout(error: unknown): boolean {
  const name = nameOf(error)
  return (
    messageOf(error).includes(REQUEST_TIMED_OUT) || name === 'TimeoutError' || name === 'AbortError'
  )
}

// A reply carries its status or names its W3C error; a transport failure is a plain Error.
function serverAnswered(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    if (typeof (error as { statusCode: unknown }).statusCode === 'number') return true
  }
  const name = nameOf(error)
  return name !== '' && name !== 'Error'
}

// A server that answered is still reachable, whatever its text says about its own connections.
export function classifyCommandFailure(error: unknown): 'lost' | 'ended' | undefined {
  const text = `${nameOf(error)} ${messageOf(error)}`
  if (SESSION_ENDED.test(text)) return 'ended'
  if (isRequestTimeout(error)) return 'lost'
  if (!serverAnswered(error) && SOCKET_FAILURE.test(text)) return 'lost'
  return undefined
}

// A lost session that timed out names the command bound; any other loss is the connection.
export function remoteDeviceLostSentence(
  kind: 'lost' | 'ended',
  context: { remote: RemoteNamed; device: string; error?: unknown },
): string {
  const label = remoteDeviceLabel(context.remote)
  if (kind === 'ended') {
    return `Remote ${label} ended the session for device ${context.device} while this test ran.`
  }
  if (context.error !== undefined && isRequestTimeout(context.error)) {
    return `Remote ${label} did not answer a command for device ${context.device} within ${formatDuration(REMOTE_COMMAND_BOUND_MS)}.`
  }
  return `The connection to remote ${label} was lost while device ${context.device} ran this test.`
}

// WebdriverIO's errors repeat the full request url, with its path, session id and query.
export function scrubDeviceEndpoint(text: string, remote: RemoteNamed): string {
  const label = remoteDeviceLabel(remote)
  const origin = remoteOrigin(remote.url)
  if (origin === undefined) return remote.url === '' ? text : text.split(remote.url).join(label)
  const remoteOriginText = formatRemoteOrigin(origin)
  // The label holds the remote's origin itself, so it is kept as it is.
  return text
    .split(label)
    .map((part) =>
      replaceUrls(part, (url) => {
        const found = originText(url)
        return found === remoteOriginText ? label : found
      }),
    )
    .join(label)
}

function debugNames(value: string): RegExp[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const escaped = part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      return new RegExp(`^${escaped.join('.*')}$`, 'i')
    })
}

export function deviceDebugLoggingRefusal(
  env: { WDIO_LOG_LEVEL?: string | undefined; NODE_DEBUG?: string | undefined },
  context: { remote: Pick<RemoteDeviceConfig, 'name'>; device: string },
): string | undefined {
  const { remote, device } = context
  const level = env.WDIO_LOG_LEVEL?.trim() ?? ''
  if (level !== '' && level.toLowerCase() !== 'silent') {
    return `WDIO_LOG_LEVEL turns on WebdriverIO's own logging, which would print remote ${remote.name}'s address and requests. Unset WDIO_LOG_LEVEL to run device ${device}.`
  }
  const patterns = debugNames(env.NODE_DEBUG ?? '')
  const named = ['undici', 'fetch'].find((name) => patterns.some((pattern) => pattern.test(name)))
  if (named !== undefined) {
    return `NODE_DEBUG names ${named}, which prints remote ${remote.name}'s request paths. Remove undici and fetch from NODE_DEBUG to run device ${device}.`
  }
  return undefined
}

// WebdriverIO's logger level is global, so one remote device keeps every session silent.
export function webdriverLogLevel(options: {
  verbose: boolean
  anyRemoteDevice: boolean
}): 'info' | 'silent' {
  return options.verbose && !options.anyRemoteDevice ? 'info' : 'silent'
}

export function anyRemoteDevice(config: {
  registry?: { devices?: Record<string, { remote?: unknown }> | undefined } | undefined
}): boolean {
  return Object.values(config.registry?.devices ?? {}).some((device) => device.remote !== undefined)
}

export function iosDeviceTypeFromInfo(info: unknown): IOSDeviceType {
  if (typeof info !== 'object' || info === null) return 'unknown'
  const reply = info as { isSimulator?: unknown; lockdownInfo?: unknown }
  if (reply.isSimulator === true) return 'simulator'
  if (reply.isSimulator === false || reply.lockdownInfo !== undefined) return 'real device'
  return 'unknown'
}

export function isUnknownCommandError(error: unknown): boolean {
  const name = nameOf(error)
  return name === 'unknown command' || name === 'unknown method'
}

// A server may refuse one device and serve another, so a refused session is kept per device.
export function remoteDeviceRefusalKey(
  remote: Pick<RemoteDeviceConfig, 'name'>,
  device: string,
  kind: RemoteFailureKind | undefined,
): string {
  return kind === 'refused' ? `${remote.name}/${device}` : remote.name
}
