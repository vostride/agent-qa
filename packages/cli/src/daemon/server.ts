import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { ANALYTICS_AGENT_PRODUCTS } from '@vostride/agent-qa-analytics'
import type { AnalyticsAgentProduct } from '@vostride/agent-qa-analytics'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { z } from 'zod'

export const INVOKE_ENVELOPE_SCHEMA_VERSION = 2
export const DAEMON_IDENTITY_SCHEMA_VERSION = 2
export const DAEMON_IDENTITY_TIMEOUT_MS = 1_000
export const STREAM_END_EVENT = 'stream-end'
export const STREAM_ERROR_EVENT = 'stream-error'

/** Conservative floor below macOS' and Linux' platform-specific `sun_path` limits. */
export const DAEMON_SOCKET_PATH_BUDGET_BYTES = 100

/** Bounded before JSON parsing so malformed peers cannot grow the daemon heap without limit. */
export const MAX_INVOKE_BODY_BYTES = 1_048_576

export const invokeEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(INVOKE_ENVELOPE_SCHEMA_VERSION),
    functionId: z.string().min(1),
    input: z.unknown(),
    agentProduct: z.enum(ANALYTICS_AGENT_PRODUCTS).optional(),
  })
  .strict()

export type InvokeEnvelope = z.infer<typeof invokeEnvelopeSchema>

// The submitter's agent product, scoped to the request that carried it.
const invokeAgentProductScope = new AsyncLocalStorage<AnalyticsAgentProduct | undefined>()

export function currentInvokeAgentProduct(): AnalyticsAgentProduct | undefined {
  return invokeAgentProductScope.getStore()
}

export const nudgeEnvelopeSchema = z
  .object({
    kind: z.literal('candidates-enqueued'),
    requireReceipt: z.boolean().default(false),
  })
  .strict()

export type NudgeEnvelope = z.infer<typeof nudgeEnvelopeSchema>

export const nudgeResponseSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict()

export type NudgeResponse = z.infer<typeof nudgeResponseSchema>

export const daemonIdentitySchema = z
  .object({
    schemaVersion: z.literal(DAEMON_IDENTITY_SCHEMA_VERSION),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
  })
  .strict()

export type DaemonIdentity = z.infer<typeof daemonIdentitySchema>

// The owner-only socket directory authenticates the local operator, so the caller is minted here.
export const DAEMON_FUNCTION_CALLER: FunctionCaller = Object.freeze({
  surface: 'daemon',
  // Nobody typed anything. The daemon is the standing counterexample to reading `surface` as a
  // proxy for a person: it shares `cli`'s process shape and none of its consent.
  origin: 'agent',
})

export class DaemonSocketInUseError extends Error {
  readonly socketPath: string

  constructor(socketPath: string) {
    super(`agent-qa daemon socket is already served by a live process: ${socketPath}`)
    this.name = 'DaemonSocketInUseError'
    this.socketPath = socketPath
  }
}

export class InvokeEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvokeEnvelopeError'
  }
}

export class NudgeEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NudgeEnvelopeError'
  }
}

export class InvokeBodyTooLargeError extends Error {
  readonly limitBytes: number

  constructor(limitBytes: number) {
    super(`Invoke request body exceeds ${limitBytes} bytes`)
    this.name = 'InvokeBodyTooLargeError'
    this.limitBytes = limitBytes
  }
}

export interface InvokeServerHandle {
  readonly socketPath: string
  close(): Promise<void>
}

export interface StartInvokeServerOptions {
  readonly socketPath: string
  readonly registry: FunctionRegistry
  readonly identity?: DaemonIdentity
  readonly onNudge?: (nudge: NudgeEnvelope) => NudgeResponse
}

interface WireError {
  readonly [field: string]: unknown
  readonly name: string
  readonly message: string
}

interface StreamResponseState {
  readonly active: WeakSet<ServerResponse>
  readonly terminal: WeakSet<ServerResponse>
}

function projectHash(projectRoot: string): string {
  return createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 12)
}

function instanceDiscriminator(instanceId: string): string {
  const validated = z.string().uuid().parse(instanceId)
  return createHash('sha256').update(validated).digest('hex').slice(0, 12)
}

/**
 * Resolve the generation-scoped IPC address, falling back before POSIX silently truncates it.
 *
 * The instance discriminator is the whole point: a daemon generation must never be able to bind
 * — or be blocked by — an address another generation owns. An uncooperative predecessor (stopped,
 * wedged, or merely slow to close) keeps its own kernel object and gates nothing. Consumers do not
 * recompute this: every client dials the `socketPath` its registration recorded, so discovery
 * follows the registration automatically.
 */
export function daemonSocketPath(
  agentQaRoot: string,
  projectRoot: string,
  instanceId: string,
): string {
  const hash = projectHash(projectRoot)
  const instance = instanceDiscriminator(instanceId)
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-qa-${hash}-${instance}`

  const socketFile = `daemon-${instance}.sock`
  const projectLocal = join(agentQaRoot, socketFile)
  if (Buffer.byteLength(projectLocal) <= DAEMON_SOCKET_PATH_BUDGET_BYTES) return projectLocal

  const fallback = join(tmpdir(), `agent-qa-${hash}`, socketFile)
  if (Buffer.byteLength(fallback) > DAEMON_SOCKET_PATH_BUDGET_BYTES) {
    throw new Error(
      `OS temporary directory is too deep for an agent-qa daemon socket: ${fallback}`,
    )
  }
  return fallback
}

function isNamedPipe(path: string): boolean {
  return process.platform === 'win32' || path.startsWith('\\\\.\\pipe\\')
}

/**
 * The instance discriminator's exact shape: `sha256(uuid)` hex, truncated to twelve characters.
 *
 * Pinned as a literal rather than derived at match time because the containment arm has no
 * instance to derive from. It is anchored to
 * `instanceDiscriminator` by construction and by the accepting controls in `daemon-host.test.ts`,
 * which feed it a real `daemonSocketPath` output.
 */
const DAEMON_SOCKET_INSTANCE_PATTERN = '[0-9a-f]{12}'
const GENERATED_DAEMON_SOCKET_FILE = new RegExp(
  `^daemon-${DAEMON_SOCKET_INSTANCE_PATTERN}\\.sock$`,
)
const GENERATED_DAEMON_PIPE_TAIL = new RegExp(`^-${DAEMON_SOCKET_INSTANCE_PATTERN}$`)

/** The project-local default socket filename (`registration.ts`'s `daemonRegistrationSocketPath`). */
const LEGACY_DAEMON_SOCKET_FILE = 'daemon.sock'

// Only the legacy or generated daemon filename passes, so other live sockets stay out of reach.
function isBindableDaemonSocketFile(file: string): boolean {
  return file === LEGACY_DAEMON_SOCKET_FILE || GENERATED_DAEMON_SOCKET_FILE.test(file)
}

/**
 * Everything needed to decide whether a recorded address is one this project may delete.
 *
 * `instanceId` is present for every registration this build reads. Without it the check is the
 * containment arm, which has no instance to compare against.
 */
export interface DaemonSocketOwnership {
  readonly agentQaRoot: string
  readonly projectRoot: string
  readonly instanceId?: string
}

/** Resolve a container for comparison; an absent directory can hold nothing, so `resolve` is safe. */
function containerPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isWithin(candidateParent: string, container: string): boolean {
  const root = containerPath(container)
  return candidateParent === root || candidateParent.startsWith(root + sep)
}

// The single deletion gate: a recorded address must be one this project's daemon could bind.
export function isOwnedDaemonSocketPath(
  candidate: string,
  ownership: DaemonSocketOwnership,
): boolean {
  if (candidate.length === 0) return false
  if (ownership.instanceId !== undefined) {
    try {
      return candidate === daemonSocketPath(
        ownership.agentQaRoot,
        ownership.projectRoot,
        ownership.instanceId,
      )
    } catch {
      return false
    }
  }

  const projectPipePrefix = `\\\\.\\pipe\\agent-qa-${projectHash(ownership.projectRoot)}`
  if (isNamedPipe(candidate)) {
    return candidate.startsWith(projectPipePrefix)
      && GENERATED_DAEMON_PIPE_TAIL.test(candidate.slice(projectPipePrefix.length))
  }

  if (!isBindableDaemonSocketFile(basename(candidate))) return false
  const parent = containerPath(dirname(resolve(candidate)))
  return isWithin(parent, ownership.agentQaRoot)
    || isWithin(parent, join(tmpdir(), `agent-qa-${projectHash(ownership.projectRoot)}`))
}

/**
 * Derive the ownership scope a recorded registration must be judged against.
 *
 * Factored because two independent reclaim paths need it — the daemon's own startup recovery and
 * the drain command's — and each deriving its own scope is how one of them ends up judging a
 * candidate against a container the other would have rejected. The project root is the runtime
 * root's parent by construction (`<project>/.agent-qa`), and `instanceId` is carried over whenever
 * the registration names one, so `isOwnedDaemonSocketPath` judges it by exact address rather than
 * by containment.
 */
export function daemonSocketOwnershipFor(
  agentQaRoot: string,
  registration: { readonly socketPath: string; readonly instanceId?: string },
): DaemonSocketOwnership {
  return {
    agentQaRoot,
    projectRoot: dirname(agentQaRoot),
    ...(registration.instanceId === undefined ? {} : { instanceId: registration.instanceId }),
  }
}

/**
 * A registration's recorded socket path is attacker-shaped input; it is never dialled blind.
 *
 * `connect()` on a POSIX path that is not a socket throws out of band on darwin (EINVAL) instead
 * of emitting an `error` event, which crashed the classifying host. Statting first turns that into
 * an ordinary unreachable verdict.
 */
function isDialableAddress(socketPath: string): boolean {
  if (isNamedPipe(socketPath)) return true
  try {
    return lstatSync(socketPath).isSocket()
  } catch {
    return false
  }
}

export class DaemonSocketAddressError extends Error {
  readonly socketPath: string

  constructor(socketPath: string) {
    super(`agent-qa daemon address is not a socket: ${socketPath}`)
    this.name = 'DaemonSocketAddressError'
    this.socketPath = socketPath
  }
}

// A recorded path can name anything, so only an owned generation's real socket is unlinked.
export function unlinkDaemonSocket(
  socketPath: string,
  ownership: DaemonSocketOwnership,
): boolean {
  if (!isOwnedDaemonSocketPath(socketPath, ownership)) return false
  if (isNamedPipe(socketPath)) return false
  try {
    if (!lstatSync(socketPath).isSocket()) return false
    unlinkSync(socketPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function prepareSocketParent(socketPath: string): void {
  if (isNamedPipe(socketPath)) return
  const parent = dirname(socketPath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

function probeSocket(socketPath: string): Promise<'live' | 'stale'> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolveProbe('live')
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') {
        resolveProbe('stale')
        return
      }
      rejectProbe(error)
    })
  })
}

async function listenWithStaleRecovery(server: Server, socketPath: string): Promise<void> {
  try {
    await listen(server, socketPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Darwin reports EINVAL when the conflicting path is a plain file. It is still attacker-
    // shaped input, so it goes through the same probe-before-unlink rule as EADDRINUSE.
    if ((code !== 'EADDRINUSE' && code !== 'EINVAL') || isNamedPipe(socketPath)) {
      throw error
    }
    const probe = await probeSocket(socketPath)
    if (probe === 'live') throw new DaemonSocketInUseError(socketPath)
    rmSync(socketPath)
    await listen(server, socketPath)
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_INVOKE_BODY_BYTES) throw new InvokeBodyTooLargeError(MAX_INVOKE_BODY_BYTES)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function parseEnvelope(request: IncomingMessage): Promise<InvokeEnvelope> {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(await readRequestBody(request)) as unknown
  } catch (error) {
    if (error instanceof InvokeBodyTooLargeError) throw error
    throw new InvokeEnvelopeError(
      `Invoke body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const parsed = invokeEnvelopeSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new InvokeEnvelopeError(
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    )
  }
  return parsed.data
}

async function parseNudgeEnvelope(request: IncomingMessage): Promise<NudgeEnvelope> {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(await readRequestBody(request)) as unknown
  } catch (error) {
    if (error instanceof InvokeBodyTooLargeError) throw error
    throw new NudgeEnvelopeError(
      `Nudge body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const parsed = nudgeEnvelopeSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new NudgeEnvelopeError(
      parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    )
  }
  return parsed.data
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    connection: 'close',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function handleIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  identity: DaemonIdentity | undefined,
): void {
  if (identity === undefined) {
    writeJson(response, 404, { name: 'NotFoundError', message: 'Route not found' })
    return
  }
  if (request.method !== 'GET') {
    writeJson(response, 405, { name: 'MethodNotAllowedError', message: 'GET required' })
    return
  }
  writeJson(response, 200, identity)
}

function wireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }

  // Error's own message/name fields are not enumerable, while the agent refusal classes expose
  // their structured context as enumerable readonly properties. Preserve those fields so the
  // client can reconstruct the exact public refusal class instead of flattening it to Error.
  return {
    ...Object.fromEntries(Object.entries(error)),
    name: error.name,
    message: error.message,
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof InvokeBodyTooLargeError) return 413
  if (error instanceof InvokeEnvelopeError || error instanceof NudgeEnvelopeError) return 400
  return 500
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  )
}

function streamElementSeq(element: unknown): number {
  if (
    typeof element !== 'object' ||
    element === null ||
    !('seq' in element) ||
    typeof element.seq !== 'number' ||
    !Number.isSafeInteger(element.seq) ||
    element.seq < 0
  ) {
    throw new Error('Stream elements must carry a non-negative integer seq resume token')
  }
  return element.seq
}

async function writeEventStream(
  response: ServerResponse,
  result: AsyncIterable<unknown>,
  streamResponses: StreamResponseState,
): Promise<void> {
  streamResponses.active.add(response)
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'close',
  })
  response.flushHeaders()

  try {
    for await (const element of result) {
      if (response.destroyed) return
      response.write(`id: ${streamElementSeq(element)}\ndata: ${JSON.stringify(element)}\n\n`)
    }
    if (response.destroyed) return

    // Element events use SSE's implicit `message` event. These reserved named events therefore
    // cannot collide with function output and are the only semantic completion signals.
    response.write(`event: ${STREAM_END_EVENT}\ndata: {}\n\n`)
    streamResponses.terminal.add(response)
    response.end()
  } catch (error) {
    if (response.destroyed) return
    response.write(
      `event: ${STREAM_ERROR_EVENT}\ndata: ${JSON.stringify(wireError(error))}\n\n`,
    )
    streamResponses.terminal.add(response)
    response.end()
  }
}

async function handleInvoke(
  request: IncomingMessage,
  response: ServerResponse,
  registry: FunctionRegistry,
  streamResponses: StreamResponseState,
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { name: 'MethodNotAllowedError', message: 'POST required' })
    return
  }

  try {
    const envelope = await parseEnvelope(request)
    const result = await invokeAgentProductScope.run(envelope.agentProduct, () =>
      invokeFunction(registry, envelope.functionId, envelope.input, DAEMON_FUNCTION_CALLER),
    )
    if (isAsyncIterable(result)) {
      await writeEventStream(response, result, streamResponses)
      return
    }
    writeJson(response, 200, result)
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    writeJson(response, errorStatus(error), wireError(error))
  }
}

async function handleNudge(
  request: IncomingMessage,
  response: ServerResponse,
  onNudge: StartInvokeServerOptions['onNudge'],
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { name: 'MethodNotAllowedError', message: 'POST required' })
    return
  }
  try {
    const envelope = await parseNudgeEnvelope(request)
    if (onNudge === undefined) {
      throw new NudgeEnvelopeError('Nudge handler is unavailable')
    }
    writeJson(response, 200, nudgeResponseSchema.parse(onNudge(envelope)))
  } catch (error) {
    writeJson(response, errorStatus(error), wireError(error))
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartInvokeServerOptions,
  streamResponses: StreamResponseState,
): Promise<void> {
  if (request.url === '/invoke') {
    await handleInvoke(request, response, options.registry, streamResponses)
    return
  }
  if (request.url === '/nudge') {
    await handleNudge(request, response, options.onNudge)
    return
  }
  if (request.url === '/identity') {
    handleIdentity(request, response, options.identity)
    return
  }
  writeJson(response, 404, { name: 'NotFoundError', message: 'Route not found' })
}

/** Start the local invoke transport plus its typed best-effort curation nudge route. */
export async function startInvokeServer(
  options: StartInvokeServerOptions,
): Promise<InvokeServerHandle> {
  prepareSocketParent(options.socketPath)
  const normalizedOptions = {
    ...options,
    ...(options.identity === undefined
      ? {}
      : { identity: daemonIdentitySchema.parse(options.identity) }),
  }

  const sockets = new Set<Socket>()
  const responses = new Set<ServerResponse>()
  const streamResponses: StreamResponseState = {
    active: new WeakSet<ServerResponse>(),
    terminal: new WeakSet<ServerResponse>(),
  }
  const server = createServer((request, response) => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    void handleRequest(request, response, normalizedOptions, streamResponses)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  try {
    await listenWithStaleRecovery(server, options.socketPath)
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    throw error
  }

  let closing: Promise<void> | undefined
  return {
    socketPath: options.socketPath,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolveClose, rejectClose) => {
        for (const response of responses) {
          if (
            streamResponses.active.has(response) &&
            !streamResponses.terminal.has(response)
          ) {
            response.destroy()
          } else {
            response.end()
          }
        }
        server.close((error) => {
          for (const socket of sockets) socket.destroy()
          if (!isNamedPipe(options.socketPath)) rmSync(options.socketPath, { force: true })
          if (error) rejectClose(error)
          else resolveClose()
        })
        server.closeIdleConnections()
      })
      return closing
    },
  }
}

/** Read and strictly validate the identity served by a listening daemon socket. */
export function fetchDaemonIdentity(socketPath: string): Promise<DaemonIdentity> {
  if (!isDialableAddress(socketPath)) {
    return Promise.reject(new DaemonSocketAddressError(socketPath))
  }
  return new Promise((resolveIdentity, rejectIdentity) => {
    let settled = false
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      rejectIdentity(error)
    }
    const outgoing = httpRequest(
      {
        socketPath,
        path: '/identity',
        method: 'GET',
        headers: { connection: 'close' },
      },
      (response) => {
        response.setEncoding('utf8')
        let body = ''
        response.on('data', (chunk: string) => {
          body += chunk
          if (Buffer.byteLength(body) > 4_096) {
            response.destroy()
            rejectOnce(new Error('Daemon identity response exceeds 4096 bytes'))
          }
        })
        response.once('error', (error) => rejectOnce(error))
        response.once('end', () => {
          if (settled) return
          const statusCode = response.statusCode ?? 500
          if (statusCode < 200 || statusCode >= 300) {
            rejectOnce(new Error(`Daemon identity request failed (${statusCode})`))
            return
          }
          try {
            const identity = daemonIdentitySchema.parse(JSON.parse(body) as unknown)
            settled = true
            resolveIdentity(identity)
          } catch (error) {
            rejectOnce(
              new Error(
                `Daemon identity response is invalid: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          }
        })
      },
    )
    outgoing.setTimeout(DAEMON_IDENTITY_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('Daemon identity request timed out'))
    })
    outgoing.once('error', (error) => rejectOnce(error))
    outgoing.end()
  })
}
