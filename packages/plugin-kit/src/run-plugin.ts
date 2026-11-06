import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'
import type { z } from 'zod'
import { PluginError, type PluginCallContext, type PluginDefinition } from './define-plugin.js'
import { findPackageRoot, readPackageJson } from './package-root.js'
import { createLineDecoder, encodeMessage } from './protocol/framing.js'
import {
  AcquireParamsSchema,
  AcquireResultSchema,
  CANCEL_METHOD,
  CancelParamsSchema,
  CheckParamsSchema,
  CheckResultSchema,
  EndParamsSchema,
  InitializeParamsSchema,
  MAX_MESSAGE_BYTES,
  OPTIONAL_PLUGIN_METHODS,
  PLUGIN_ERROR_CODES,
  PLUGIN_METHODS,
  PLUGIN_PROTOCOL_VERSION,
  PROGRESS_METHOD,
  ReleaseParamsSchema,
  StartedParamsSchema,
  StartedResultSchema,
  UploadAppParamsSchema,
  UploadAppResultSchema,
  type InitializeParams,
  type InitializeResult,
  type OptionalPluginMethod,
  type PluginMethod,
} from './protocol/messages.js'

export interface PluginIo {
  stdin: {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
    on(event: 'end' | 'error', listener: () => void): unknown
  }
  stdout: { write(chunk: string, callback?: (error?: Error | null) => void): unknown }
  exit(code: number): void
  entryPath?: string
  cancelAnswerGraceMs: number
  hostPidPollMs: number
}

type RequestId = string | number
type Json = z.core.util.JSONType

export const CANCEL_ANSWER_GRACE_MS = 4_000
export const HOST_PID_POLL_MS = 1_000
const RELEASE_ON_CLOSE_BOUND_MS = 30_000
const RELEASE_ON_SIGTERM_BOUND_MS = 4_000

const SUPPORTED_PROTOCOL_VERSIONS = [PLUGIN_PROTOCOL_VERSION]

class ProtocolFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function resolveIo(io: Partial<PluginIo>): PluginIo {
  return {
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    exit: io.exit ?? ((code) => process.exit(code)),
    entryPath: io.entryPath ?? process.argv[1],
    cancelAnswerGraceMs: io.cancelAnswerGraceMs ?? CANCEL_ANSWER_GRACE_MS,
    hostPidPollMs: io.hostPidPollMs ?? HOST_PID_POLL_MS,
  }
}

function routeStrayOutputToStderr() {
  const toLog = (...args: unknown[]) => {
    process.stderr.write(`${format(...args)}\n`)
  }
  console.log = toLog
  console.info = toLog
  console.debug = toLog
  console.warn = toLog
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
}

function hostGone(hostPid: number, startPpid: number): boolean {
  if (process.ppid !== startPpid) return true
  try {
    process.kill(hostPid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// Handles are JSON; two handles are the same session when their JSON is equal.
function handleKey(handle: Json): string {
  const canonical = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key] as Json)]),
    )
  }
  return JSON.stringify(canonical(handle))
}

function within<T>(work: Promise<T>, boundMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), boundMs)
  })
  return Promise.race([work, bound]).finally(() => clearTimeout(timer))
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

interface PendingCall {
  method: string
  controller: AbortController
  answered: boolean
  graceTimer?: NodeJS.Timeout
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number'
}

function isPluginMethod(method: string): method is PluginMethod {
  return (PLUGIN_METHODS as readonly string[]).includes(method)
}

function isOptionalMethod(method: PluginMethod): method is OptionalPluginMethod {
  return (OPTIONAL_PLUGIN_METHODS as readonly string[]).includes(method)
}

function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.map(String).join('.')
}

function parseParams<Schema extends z.ZodType>(
  schema: Schema,
  params: unknown,
  method: string,
): z.output<Schema> {
  const parsed = schema.safeParse(params ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const where = issue === undefined ? '' : issuePath(issue)
  throw new ProtocolFailure(
    PLUGIN_ERROR_CODES.invalidParams,
    `${method} params${where === '' ? '' : ` at ${where}`}: ${issue?.message ?? 'invalid'}`,
  )
}

// A refusal's path starts with options. or settings., naming the block that holds the field.
function refuse(schema: z.ZodType, value: unknown, prefix: 'options' | 'settings'): unknown {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const inner = issue === undefined ? '' : issuePath(issue)
  const path = inner === '' ? undefined : `${prefix}.${inner}`
  throw new PluginError(`${path ?? prefix}: ${issue?.message ?? 'invalid'}`, {
    kind: 'refused',
    ...(path === undefined ? {} : { path }),
  })
}

function checkedResult(schema: z.ZodType, value: unknown, method: string): unknown {
  const parsed = schema.safeParse(value)
  if (parsed.success) return value
  const issue = parsed.error.issues[0]
  const where = issue === undefined ? '' : issuePath(issue)
  const handle =
    method === 'acquire' && isRecord(value) && value.handle !== undefined
      ? (value.handle as Json)
      : undefined
  throw new PluginError(
    `${method} answered a malformed result${where === '' ? '' : ` at ${where}`}: ${issue?.message ?? 'invalid'}`,
    { kind: 'refused', ...(handle === undefined ? {} : { handle }) },
  )
}

function pluginIdentity(entryPath: string | undefined): InitializeResult['plugin'] {
  const unknown = { name: 'unknown', version: 'unknown' }
  if (entryPath === undefined) return unknown
  try {
    const root = findPackageRoot(dirname(realpathSync(entryPath)))
    if (root === undefined) return unknown
    const pkg = readPackageJson(root)
    return {
      name: typeof pkg.name === 'string' ? pkg.name : unknown.name,
      version: typeof pkg.version === 'string' ? pkg.version : unknown.version,
    }
  } catch {
    return unknown
  }
}

export function runPlugin<OptionsSchema extends z.ZodType, SettingsSchema extends z.ZodType>(
  definition: PluginDefinition<OptionsSchema, SettingsSchema>,
  ioInput: Partial<PluginIo> = {},
): void {
  const io = resolveIo(ioInput)
  const write = io.stdout.write.bind(io.stdout)
  // A caller that brings its own stdout keeps the process's console, streams and signals.
  const ownsProcess = ioInput.stdout === undefined
  if (ownsProcess) {
    routeStrayOutputToStderr()
    // Once the host is gone its pipes have no reader; EPIPE must not stop the releases.
    process.stdout.on('error', () => {})
    process.stderr.on('error', () => {})
    process.on('SIGINT', () => {})
  }

  const send = (message: Record<string, unknown>) => {
    if (leaving) return
    write(encodeMessage(message))
  }
  const answer = (id: RequestId, result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (
    id: RequestId | null,
    code: number,
    message: string,
    data?: Record<string, unknown>,
  ) =>
    send({
      jsonrpc: '2.0',
      id,
      error: { code, message: firstLine(message), ...(data === undefined ? {} : { data }) },
    })

  let options: z.output<OptionsSchema> | undefined
  let runFacts: InitializeParams['runFacts']
  let initialized = false
  let initializing = false
  let shutdownRan = false
  let leaving = false
  let hostPoll: NodeJS.Timeout | undefined
  const startPpid = process.ppid
  const pending = new Map<RequestId, PendingCall>()
  const inFlight = new Set<Promise<void>>()
  const held = new Map<string, Json>()
  const releasing = new Map<string, Promise<void>>()

  const detachedContext = (): PluginCallContext => ({
    signal: new AbortController().signal,
    progress: () => {},
    runFacts,
  })

  const hold = (handle: Json) => held.set(handleKey(handle), handle)

  // One release per handle at a time, whether the host or the kit asked for it.
  const releaseOnce = (handle: Json, ctx: PluginCallContext): Promise<void> => {
    const key = handleKey(handle)
    const running = releasing.get(key)
    if (running !== undefined) return running
    const work = (async () => {
      try {
        await definition.release({ handle, options: options as z.output<OptionsSchema> }, ctx)
        held.delete(key)
      } finally {
        releasing.delete(key)
      }
    })()
    releasing.set(key, work)
    return work
  }

  const releaseHeld = (attempted: Set<string>) =>
    Promise.allSettled(
      [...held]
        .filter(([key]) => !attempted.has(key))
        .map(([key, handle]) => {
          attempted.add(key)
          return releaseOnce(handle, detachedContext())
        }),
    )

  const settings = (value: unknown) =>
    refuse(definition.settings, value, 'settings') as z.output<SettingsSchema>

  const leave = async (boundMs: number) => {
    if (leaving) return
    leaving = true
    clearInterval(hostPoll)
    const sequence = async () => {
      if (!initialized) return
      for (const entry of pending.values()) {
        if (entry.method !== 'release' && entry.method !== 'shutdown') entry.controller.abort()
      }
      // A call still running may yet create a session; it lands in held and is released here.
      const attempted = new Set<string>()
      await Promise.allSettled([releaseHeld(attempted), ...inFlight])
      await releaseHeld(attempted)
      if (shutdownRan) return
      shutdownRan = true
      await definition.shutdown?.(
        { options: options as z.output<OptionsSchema> },
        detachedContext(),
      )
    }
    await within(
      sequence().catch(() => {}),
      boundMs,
    )
    write('', () => io.exit(0))
  }

  const watchHost = (hostPid: number) => {
    hostPoll = setInterval(() => {
      if (hostGone(hostPid, startPpid)) void leave(RELEASE_ON_CLOSE_BOUND_MS)
    }, io.hostPidPollMs)
    hostPoll.unref()
  }

  const initialize = async (params: unknown, ctx: PluginCallContext): Promise<InitializeResult> => {
    if (initialized || initializing) {
      throw new ProtocolFailure(PLUGIN_ERROR_CODES.invalidRequest, 'initialize was already called')
    }
    const input = parseParams(InitializeParamsSchema, params, 'initialize')
    const offered = input.protocolVersions.filter((version) =>
      SUPPORTED_PROTOCOL_VERSIONS.includes(version),
    )
    if (offered.length === 0) {
      throw new ProtocolFailure(
        PLUGIN_ERROR_CODES.plugin,
        `this plugin speaks protocol ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}, and the host offered ${input.protocolVersions.join(', ') || 'none'}`,
        {
          kind: 'version',
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested: input.protocolVersions,
        },
      )
    }
    const parsedOptions = refuse(definition.options, input.options, 'options') as z.output<OptionsSchema>
    initializing = true
    try {
      await definition.initialize?.(
        {
          options: parsedOptions,
          host: input.host,
          entry: input.entry,
          runFacts: input.runFacts,
        },
        { ...ctx, runFacts: input.runFacts },
      )
    } finally {
      initializing = false
    }
    options = parsedOptions
    runFacts = input.runFacts
    initialized = true
    watchHost(input.host.pid)
    return {
      protocolVersion: Math.max(...offered),
      plugin: pluginIdentity(io.entryPath),
      serves: [...definition.serves],
      methods: [...definition.methods],
    }
  }

  const call = async (
    method: string,
    params: unknown,
    ctx: PluginCallContext,
  ): Promise<unknown> => {
    if (method === 'initialize') return initialize(params, ctx)
    if (
      !isPluginMethod(method) ||
      (isOptionalMethod(method) &&
        (!definition.methods.includes(method) || typeof definition[method] !== 'function'))
    ) {
      throw new ProtocolFailure(
        PLUGIN_ERROR_CODES.methodNotFound,
        `${method} is not a method of this plugin`,
      )
    }
    if (!initialized) {
      throw new ProtocolFailure(
        PLUGIN_ERROR_CODES.invalidRequest,
        `${method} came before initialize`,
      )
    }
    const current = options as z.output<OptionsSchema>
    switch (method) {
      case 'acquire': {
        const input = parseParams(AcquireParamsSchema, params, method)
        const result = await definition.acquire(
          { ...input, settings: settings(input.settings), options: current },
          ctx,
        )
        return checkedResult(AcquireResultSchema, result, method)
      }
      case 'release': {
        const input = parseParams(ReleaseParamsSchema, params, method)
        await releaseOnce(input.handle, ctx)
        return {}
      }
      case 'shutdown': {
        shutdownRan = true
        // A handle whose release failed is still held; shutdown may dispose what releasing needs.
        await releaseHeld(new Set())
        await definition.shutdown?.({ options: current }, ctx)
        return {}
      }
      case 'check': {
        const input = parseParams(CheckParamsSchema, params, method)
        const remotes = input.remotes.map((remote) => ({
          name: remote.name,
          settings: settings(remote.settings),
        }))
        const result = await definition.check?.({ remotes, options: current }, ctx)
        return checkedResult(CheckResultSchema, result, method)
      }
      case 'uploadApp': {
        const input = parseParams(UploadAppParamsSchema, params, method)
        const result = await definition.uploadApp?.(
          { ...input, settings: settings(input.settings), options: current },
          ctx,
        )
        return checkedResult(UploadAppResultSchema, result, method)
      }
      case 'started': {
        const input = parseParams(StartedParamsSchema, params, method)
        const result = await definition.started?.({ ...input, options: current }, ctx)
        return checkedResult(StartedResultSchema, result, method)
      }
      case 'end': {
        const input = parseParams(EndParamsSchema, params, method)
        await definition.end?.({ ...input, options: current }, ctx)
        return {}
      }
      default:
        throw new ProtocolFailure(
          PLUGIN_ERROR_CODES.methodNotFound,
          `${method} is not a method of this plugin`,
        )
    }
  }

  const createdHandle = (method: string, outcome: Outcome): Json | undefined => {
    if (outcome.ok) {
      if (method !== 'acquire' || !isRecord(outcome.value)) return undefined
      return outcome.value.handle as Json | undefined
    }
    return outcome.error instanceof PluginError ? outcome.error.handle : undefined
  }

  const answerFailure = (id: RequestId, error: unknown) => {
    if (error instanceof ProtocolFailure) {
      fail(id, error.code, error.message, error.data)
    } else if (error instanceof PluginError) {
      fail(id, PLUGIN_ERROR_CODES.plugin, error.message, {
        kind: error.kind,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.handle === undefined ? {} : { handle: error.handle }),
      })
    } else {
      const message = error instanceof Error ? error.message : String(error)
      fail(id, PLUGIN_ERROR_CODES.plugin, message, { kind: 'unreachable' })
    }
  }

  const dispatch = async (id: RequestId, method: string, params: unknown) => {
    const entry: PendingCall = { method, controller: new AbortController(), answered: false }
    pending.set(id, entry)
    const ctx: PluginCallContext = {
      signal: entry.controller.signal,
      progress: (update) => {
        if (entry.answered) return
        send({ jsonrpc: '2.0', method: PROGRESS_METHOD, params: { id, ...update } })
      },
      runFacts,
    }
    let outcome: Outcome
    try {
      outcome = { ok: true, value: await call(method, params, ctx) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    clearTimeout(entry.graceTimer)
    if (pending.get(id) === entry) pending.delete(id)
    const handle = createdHandle(method, outcome)
    const tracked = initialized ? handle : undefined
    if (tracked !== undefined) hold(tracked)
    if (entry.answered) {
      // The cancel was already answered without this handle, so nobody else will release it.
      if (tracked !== undefined) await releaseOnce(tracked, detachedContext()).catch(() => {})
      return
    }
    if (leaving) return
    entry.answered = true
    if (outcome.ok) {
      answer(id, outcome.value)
    } else if (entry.controller.signal.aborted) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      fail(id, PLUGIN_ERROR_CODES.cancelled, message, {
        kind: 'timeout',
        ...(handle === undefined ? {} : { handle }),
      })
    } else {
      answerFailure(id, outcome.error)
    }
  }

  const cancel = (params: unknown) => {
    const parsed = CancelParamsSchema.safeParse(params)
    if (!parsed.success) return
    const { id } = parsed.data
    const entry = pending.get(id)
    if (entry === undefined || entry.controller.signal.aborted) return
    entry.controller.abort()
    entry.graceTimer = setTimeout(() => {
      if (entry.answered) return
      entry.answered = true
      fail(
        id,
        PLUGIN_ERROR_CODES.cancelled,
        `${entry.method} did not stop within ${io.cancelAnswerGraceMs} ms of its cancel`,
        { kind: 'timeout' },
      )
    }, io.cancelAnswerGraceMs)
  }

  const handleLine = (line: string) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      fail(null, PLUGIN_ERROR_CODES.parse, 'the line is not JSON')
      return
    }
    if (!isRecord(message)) {
      fail(null, PLUGIN_ERROR_CODES.invalidRequest, 'a message must be a JSON-RPC 2.0 object')
      return
    }
    const id = isRequestId(message.id) ? message.id : null
    if (message.method === undefined && ('result' in message || 'error' in message)) return
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      fail(id, PLUGIN_ERROR_CODES.invalidRequest, 'a request needs jsonrpc "2.0" and a method')
      return
    }
    if (!('id' in message)) {
      if (message.method === CANCEL_METHOD) cancel(message.params)
      return
    }
    if (id === null) {
      fail(null, PLUGIN_ERROR_CODES.invalidRequest, 'a request id is a string or a number')
      return
    }
    if (leaving) return
    const run = dispatch(id, message.method, message.params)
    inFlight.add(run)
    void run.catch(() => {}).finally(() => inFlight.delete(run))
  }

  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: handleLine,
    onOverflow: () =>
      fail(
        null,
        PLUGIN_ERROR_CODES.invalidRequest,
        `a message is longer than ${MAX_MESSAGE_BYTES} bytes`,
      ),
  })

  const stdinClosed = () => {
    if (leaving) return
    decoder.end()
    void leave(RELEASE_ON_CLOSE_BOUND_MS)
  }

  if (ownsProcess) process.on('SIGTERM', () => void leave(RELEASE_ON_SIGTERM_BOUND_MS))
  io.stdin.on('data', (chunk) => decoder.push(chunk))
  io.stdin.on('end', stdinClosed)
  io.stdin.on('error', stdinClosed)
}
