import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { PluginError, type PluginDefinition } from './define-plugin.js'
import { findPackageRoot, readPackageJson } from './package-root.js'
import { createLineDecoder, encodeMessage } from './protocol/framing.js'
import {
  AcquireParamsSchema,
  CheckParamsSchema,
  EndParamsSchema,
  InitializeParamsSchema,
  MAX_MESSAGE_BYTES,
  OPTIONAL_PLUGIN_METHODS,
  PLUGIN_ERROR_CODES,
  PLUGIN_METHODS,
  PLUGIN_PROTOCOL_VERSION,
  ReleaseParamsSchema,
  StartedParamsSchema,
  UploadAppParamsSchema,
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
}

type RequestId = string | number

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

function processIo(): PluginIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    exit: (code) => process.exit(code),
    entryPath: process.argv[1],
  }
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

function refuse(schema: z.ZodType, value: unknown, prefix: string): unknown {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const inner = issue === undefined ? '' : issuePath(issue)
  const path = [prefix, inner].filter((part) => part !== '').join('.')
  const label = path === '' ? 'options' : path
  throw new PluginError(`${label}: ${issue?.message ?? 'invalid'}`, {
    kind: 'refused',
    ...(path === '' ? {} : { path }),
  })
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
  io: PluginIo = processIo(),
): void {
  const write = io.stdout.write.bind(io.stdout)
  const send = (message: Record<string, unknown>) => {
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
  let initialized = false
  let initializing = false
  let finished = false

  const settings = (value: unknown, prefix: string) =>
    refuse(definition.settings, value, prefix) as z.output<SettingsSchema>

  const initialize = async (params: unknown): Promise<InitializeResult> => {
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
    const parsedOptions = refuse(definition.options, input.options, '') as z.output<OptionsSchema>
    initializing = true
    try {
      await definition.initialize?.({
        options: parsedOptions,
        host: input.host,
        entry: input.entry,
        runFacts: input.runFacts,
      })
    } finally {
      initializing = false
    }
    options = parsedOptions
    initialized = true
    return {
      protocolVersion: Math.max(...offered),
      plugin: pluginIdentity(io.entryPath),
      serves: [...definition.serves],
      methods: [...definition.methods],
    }
  }

  const call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'initialize') return initialize(params)
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
        return definition.acquire({
          ...input,
          settings: settings(input.settings, 'settings'),
          options: current,
        })
      }
      case 'release': {
        const input = parseParams(ReleaseParamsSchema, params, method)
        await definition.release({ handle: input.handle, options: current })
        return {}
      }
      case 'shutdown': {
        await definition.shutdown?.({ options: current })
        return {}
      }
      case 'check': {
        const input = parseParams(CheckParamsSchema, params, method)
        const remotes = input.remotes.map((remote) => ({
          name: remote.name,
          settings: settings(remote.settings, 'settings'),
        }))
        return definition.check?.({ remotes, options: current })
      }
      case 'uploadApp': {
        const input = parseParams(UploadAppParamsSchema, params, method)
        return definition.uploadApp?.({
          ...input,
          settings: settings(input.settings, 'settings'),
          options: current,
        })
      }
      case 'started': {
        const input = parseParams(StartedParamsSchema, params, method)
        return definition.started?.({ ...input, options: current })
      }
      case 'end': {
        const input = parseParams(EndParamsSchema, params, method)
        await definition.end?.({ ...input, options: current })
        return {}
      }
      default:
        throw new ProtocolFailure(
          PLUGIN_ERROR_CODES.methodNotFound,
          `${method} is not a method of this plugin`,
        )
    }
  }

  const dispatch = async (id: RequestId, method: string, params: unknown) => {
    try {
      answer(id, await call(method, params))
    } catch (error) {
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
    if (!('id' in message)) return
    if (id === null) {
      fail(null, PLUGIN_ERROR_CODES.invalidRequest, 'a request id is a string or a number')
      return
    }
    void dispatch(id, message.method, message.params)
  }

  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: handleLine,
    onOverflow: () => {},
  })

  const finish = () => {
    if (finished) return
    finished = true
    decoder.end()
    write('', () => io.exit(0))
  }

  io.stdin.on('data', (chunk) => decoder.push(chunk))
  io.stdin.on('end', finish)
  io.stdin.on('error', finish)
}
