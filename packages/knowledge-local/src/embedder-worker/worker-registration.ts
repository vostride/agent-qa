import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { EmbeddingProfile } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import type { EmbedderPort } from '../embedder-port.js'

export const EMBEDDER_WORKER_REGISTRATION_FILE = 'embedder-worker.json'
export const EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION = 2

/**
 * What a worker records when it cannot attribute its own process.
 *
 * The field is required rather than optional on purpose: an absent incarnation would let a forged
 * registration opt out of the check entirely. A worker that genuinely cannot resolve its own start
 * time says so explicitly, and the host reads that as `unverifiable` — which withholds every
 * signal, exactly as an unresolvable pid does.
 */
export const EMBEDDER_WORKER_UNVERIFIABLE_INCARNATION = 'unresolved'
export const EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION = 2
export const EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES = 100
export const MAX_EMBEDDER_WORKER_BODY_BYTES = 4_194_304

export const EMBEDDER_WORKER_REQUEST_TIMEOUT_MS = 30_000

export const EMBEDDER_WORKER_START_TIMEOUT_MS = 15_000

export const EMBEDDER_WORKER_TERM_GRACE_MS = 5_000

export type EmbedderWorkerTimeoutPhase = 'request' | 'start' | 'terminate'

/** A bounded worker wait expired; callers can defer by phase without parsing error text. */
export class EmbedderWorkerTimeoutError extends Error {
  readonly phase: EmbedderWorkerTimeoutPhase
  readonly timeoutMs: number

  constructor(phase: EmbedderWorkerTimeoutPhase, timeoutMs: number) {
    super(`Embedder worker ${phase} timed out after ${timeoutMs} ms`)
    this.name = 'EmbedderWorkerTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export const embeddingProfileSchema = z
  .object({
    model_id: z.string().min(1),
    revision: z.string().min(1),
    dim: z.number().int().positive(),
    dtype: z.literal('q8'),
    pooling: z.literal('mean'),
    normalize: z.literal(true),
    query_prefix: z.string(),
    doc_prefix: z.string(),
    backend: z.enum(['node', 'static']),
    session_options: z.record(z.string(), z.unknown()),
    tau_dense: z.number().finite(),
  })
  .strict()

export const embedderWorkerRegistrationSchema = z
  .object({
    schemaVersion: z.literal(EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    socketPath: z.string().min(1),
    profile: embeddingProfileSchema,
    startedAtMs: z.number().int().nonnegative(),
    /** The registering process's own OS-anchored start-time token, or the unverifiable sentinel. */
    incarnation: z.string().min(1),
  })
  .strict()

export type EmbedderWorkerRegistration = z.infer<typeof embedderWorkerRegistrationSchema>

export type ReadEmbedderWorkerRegistrationOutcome =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'parsed'; registration: EmbedderWorkerRegistration }

export type ProcessIsAlive = (pid: number) => boolean

/** Three-valued because the third value is a refusal, never a permissive default. */
export type EmbedderWorkerIncarnationVerdict = 'match' | 'mismatch' | 'unverifiable'

const singleEmbeddingRequestSchema = z.discriminatedUnion('method', [
  z
    .object({
      schemaVersion: z.literal(EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION),
      method: z.literal('embedDocument'),
      rendering: z.string(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION),
      method: z.literal('embedQuery'),
      rendering: z.string(),
    })
    .strict(),
])

export const embedderWorkerRequestSchema = z.discriminatedUnion('method', [
  ...singleEmbeddingRequestSchema.options,
  z
    .object({
      schemaVersion: z.literal(EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION),
      method: z.literal('embedBatch'),
      requests: z.array(singleEmbeddingRequestSchema).min(1).max(256),
    })
    .strict(),
])

export type EmbedderWorkerRequest = z.infer<typeof embedderWorkerRequestSchema>

export const embedderWorkerResponseSchema = z
  .object({
    schemaVersion: z.literal(EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION),
    vectors: z.array(z.array(z.number().finite())),
  })
  .strict()

export type EmbedderWorkerResponse = z.infer<typeof embedderWorkerResponseSchema>

function projectHash(projectRoot: string): string {
  return createHash('sha256').update(realpathSync(projectRoot)).digest('hex').slice(0, 12)
}

export function embedderWorkerAgentQaRoot(projectRoot = process.cwd()): string {
  return join(realpathSync(projectRoot), '.agent-qa')
}

export function embedderWorkerRegistrationPath(agentQaRoot: string): string {
  return join(agentQaRoot, EMBEDDER_WORKER_REGISTRATION_FILE)
}

function instanceDiscriminator(instanceId: string): string {
  const validated = z.string().uuid().parse(instanceId)
  return createHash('sha256').update(validated).digest('hex').slice(0, 12)
}

/** Resolve an instance-scoped UDS path without crossing conservative POSIX sun_path limits. */
export function embedderWorkerSocketPath(
  agentQaRoot: string,
  projectRoot: string,
  instanceId: string,
): string {
  const hash = projectHash(projectRoot)
  const instance = instanceDiscriminator(instanceId)
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agent-qa-embedder-${hash}-${instance}`
  }

  const canonicalAgentQaRoot = join(realpathSync(dirname(agentQaRoot)), basename(agentQaRoot))
  const socketFile = `embedder-worker-${instance}.sock`
  const projectLocal = join(canonicalAgentQaRoot, socketFile)
  if (Buffer.byteLength(projectLocal) <= EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES) {
    return projectLocal
  }

  const fallback = join(tmpdir(), `agent-qa-${hash}`, `${instance}.sock`)
  if (Buffer.byteLength(fallback) > EMBEDDER_WORKER_SOCKET_PATH_BUDGET_BYTES) {
    throw new Error(
      `OS temporary directory is too deep for an agent-qa embedder socket: ${fallback}`,
    )
  }
  return fallback
}

export function prepareEmbedderWorkerSocketParent(socketPath: string): void {
  if (process.platform === 'win32' || socketPath.startsWith('\\\\.\\pipe\\')) return
  const parent = dirname(socketPath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT'
      && code !== 'EINVAL'
      && code !== 'EISDIR'
      && code !== 'EPERM'
      && code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function atomicRewrite(file: string, text: string): void {
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(parent)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function writeEmbedderWorkerRegistration(
  agentQaRoot: string,
  registration: EmbedderWorkerRegistration,
): void {
  const validated = embedderWorkerRegistrationSchema.parse(registration)
  atomicRewrite(
    embedderWorkerRegistrationPath(agentQaRoot),
    `${JSON.stringify(validated)}\n`,
  )
}

function readEmbedderWorkerRegistrationFile(
  file: string,
): ReadEmbedderWorkerRegistrationOutcome {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return existsSync(file) ? { kind: 'malformed' } : { kind: 'absent' }
  }

  try {
    const parsedJson = JSON.parse(raw) as unknown
    const parsed = embedderWorkerRegistrationSchema.safeParse(parsedJson)
    return parsed.success ? { kind: 'parsed', registration: parsed.data } : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

export function readEmbedderWorkerRegistration(
  agentQaRoot: string,
): ReadEmbedderWorkerRegistrationOutcome {
  return readEmbedderWorkerRegistrationFile(embedderWorkerRegistrationPath(agentQaRoot))
}

/** Signal-zero liveness probe: EPERM proves existence; only ESRCH proves a stale pid. */
export function embedderWorkerProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function sameRegistration(
  left: EmbedderWorkerRegistration,
  right: EmbedderWorkerRegistration,
): boolean {
  return left.pid === right.pid
    && left.startedAtMs === right.startedAtMs
    && left.socketPath === right.socketPath
    && left.instanceId === right.instanceId
    && left.incarnation === right.incarnation
}

export interface RemoveEmbedderWorkerRegistrationOptions {
  /** Test-only barrier after quarantine publication and before ownership verification. */
  readonly afterQuarantine?: (quarantinePath: string) => void
  /** Focused durability seam; production uses the best-effort platform fsync helper. */
  readonly fsyncDirectory?: (directory: string) => void
}

/** Atomically quarantine and remove only the exact registration owned by the caller. */
export function removeEmbedderWorkerRegistration(
  agentQaRoot: string,
  expected: EmbedderWorkerRegistration,
  options: RemoveEmbedderWorkerRegistrationOptions = {},
): boolean {
  const file = embedderWorkerRegistrationPath(agentQaRoot)
  const parent = dirname(file)
  const quarantine = `${file}.remove-${expected.instanceId}-${randomUUID()}`
  const fsyncDirectory = options.fsyncDirectory ?? bestEffortFsyncDirectory

  try {
    renameSync(file, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  fsyncDirectory(parent)
  options.afterQuarantine?.(quarantine)

  const outcome = readEmbedderWorkerRegistrationFile(quarantine)
  const quarantinedRegistration = outcome.kind === 'parsed' ? outcome.registration : undefined
  if (
    quarantinedRegistration !== undefined
    && sameRegistration(quarantinedRegistration, expected)
  ) {
    unlinkSync(quarantine)
    fsyncDirectory(parent)
    return true
  }

  try {
    linkSync(quarantine, file)
    fsyncDirectory(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  unlinkSync(quarantine)
  fsyncDirectory(parent)
  return false
}

export function probeEmbedderWorkerSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolveProbe(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolveProbe(false)
    })
  })
}

function requestWorker(
  socketPath: string,
  envelope: EmbedderWorkerRequest,
  options: CreateEmbedderWorkerPortOptions,
): Promise<EmbedderWorkerResponse> {
  const body = JSON.stringify(embedderWorkerRequestSchema.parse(envelope))
  return new Promise((resolveRequest, rejectRequest) => {
    const requestTimeoutMs = options.requestTimeoutMs ?? EMBEDDER_WORKER_REQUEST_TIMEOUT_MS
    const abortController = new AbortController()
    let responseStream: IncomingMessage | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const settle = (
      outcome: { kind: 'resolved'; response: EmbedderWorkerResponse }
        | { kind: 'rejected'; error: unknown },
    ): boolean => {
      if (settled) return false
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (outcome.kind === 'resolved') {
        resolveRequest(outcome.response)
      } else {
        try {
          options.onUnavailable?.(outcome.error)
        } catch {
          // Transport refusal remains authoritative even when best-effort invalidation cannot write.
        }
        rejectRequest(outcome.error)
      }
      return true
    }

    const workerRequest = request(
      {
        socketPath,
        path: '/embed',
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        responseStream = response
        const chunks: Buffer[] = []
        let bytes = 0
        response.once('aborted', () => {
          settle({ kind: 'rejected', error: new Error('Embedder worker response was aborted') })
        })
        response.once('error', (error) => {
          settle({ kind: 'rejected', error })
        })
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.byteLength
          if (bytes <= MAX_EMBEDDER_WORKER_BODY_BYTES) chunks.push(buffer)
        })
        response.on('end', () => {
          try {
            if (bytes > MAX_EMBEDDER_WORKER_BODY_BYTES) {
              throw new Error('Embedder worker response exceeded the body limit')
            }
            const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
            if (response.statusCode !== 200) {
              const message = z
                .object({ error: z.string() })
                .passthrough()
                .safeParse(parsedBody)
              throw new Error(
                message.success
                  ? `Embedder worker rejected the request: ${message.data.error}`
                  : `Embedder worker returned HTTP ${response.statusCode ?? 0}`,
              )
            }
            settle({
              kind: 'resolved',
              response: embedderWorkerResponseSchema.parse(parsedBody),
            })
          } catch (error) {
            settle({ kind: 'rejected', error })
          }
        })
      },
    )
    workerRequest.once('error', (error) => {
      const refusal = abortController.signal.aborted
        ? abortController.signal.reason
        : error
      settle({ kind: 'rejected', error: refusal })
    })
    timeout = setTimeout(() => {
      const error = new EmbedderWorkerTimeoutError('request', requestTimeoutMs)
      if (!settle({ kind: 'rejected', error })) return
      abortController.abort(error)
      responseStream?.destroy(error)
      workerRequest.destroy(error)
    }, requestTimeoutMs)
    workerRequest.end(body)
  })
}

function vectorFromResponse(
  response: EmbedderWorkerResponse,
  expectedDimension: number,
): Float32Array {
  const [vector] = response.vectors
  if (vector === undefined || response.vectors.length !== 1) {
    throw new Error('Embedder worker returned an invalid single-vector response')
  }
  if (vector.length !== expectedDimension) {
    throw new Error(
      `Embedder worker returned dimension ${vector.length}; expected ${expectedDimension}`,
    )
  }
  return Float32Array.from(vector)
}

export interface CreateEmbedderWorkerPortOptions {
  /** Test-only shortening seam; production always uses the pinned request deadline. */
  readonly requestTimeoutMs?: number
  /** Capability owner invalidates registration/cache after transport refusal. */
  readonly onUnavailable?: (error: unknown) => void
}

export function createEmbedderWorkerPort(
  socketPath: string,
  expectedDimension: number,
  options: CreateEmbedderWorkerPortOptions = {},
): EmbedderPort {
  return {
    async embedDocument(rendering) {
      return vectorFromResponse(
        await requestWorker(socketPath, {
          schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
          method: 'embedDocument',
          rendering,
        }, options),
        expectedDimension,
      )
    },
    async embedQuery(rendering) {
      return vectorFromResponse(
        await requestWorker(socketPath, {
          schemaVersion: EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION,
          method: 'embedQuery',
          rendering,
        }, options),
        expectedDimension,
      )
    },
  }
}

export function asEmbeddingProfile(
  profile: EmbedderWorkerRegistration['profile'],
): EmbeddingProfile {
  return profile as EmbeddingProfile
}
