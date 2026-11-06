import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import type { PluginDefinition } from '../define-plugin.js'
import { pluginManifest } from '../emit.js'
import { findPackageRoot, readPackageJson } from '../package-root.js'
import { pluginEnvironment } from '../protocol/environment.js'
import { createLineDecoder, encodeMessage } from '../protocol/framing.js'
import {
  PLUGIN_MANIFEST_FIELD,
  PluginManifestSchema,
  type RemotePluginManifest,
} from '../protocol/manifest.js'
import {
  AcquireResultSchema,
  CANCEL_METHOD,
  InitializeResultSchema,
  MAX_MESSAGE_BYTES,
  PLUGIN_ERROR_CODES,
  PLUGIN_PROTOCOL_VERSION,
  PluginErrorDataSchema,
  type AcquireParams,
  type InitializeParams,
} from '../protocol/messages.js'

export type ConformanceCheckName =
  | 'manifest'
  | 'handshake'
  | 'unknown-method'
  | 'idempotent-release'
  | 'answered-cancel'
  | 'clean-stdout'
  | 'exit-on-stdin-close'

export interface ConformanceCheck {
  name: ConformanceCheckName
  ok: boolean
  detail?: string
}

export interface ConformanceReport {
  ok: boolean
  checks: ConformanceCheck[]
}

export interface ConformanceInput {
  packageDir: string
  options: Record<string, unknown>
  settings?: Record<string, unknown>
  session?: AcquireParams['session']
  host?: Partial<InitializeParams['host']>
  quick?: boolean
  timeoutMs?: number
}

const DEFAULT_CALL_TIMEOUT_MS = 10_000
const CANCEL_ANSWER_WINDOW_MS = 5_000
const EXIT_WINDOW_MS = 5_000
const STDIO_DRAIN_MS = 1_000
const DRAFT_2020_12 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/
const DEFAULT_SESSION: AcquireParams['session'] = {
  platform: 'web',
  engine: 'chromium',
  context: 'new',
}

interface RpcAnswer {
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function kitVersion(): string {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)))
  const version = root === undefined ? undefined : readPackageJson(root).version
  return typeof version === 'string' ? version : 'unknown'
}

function hostIdentity(host: ConformanceInput['host']): InitializeParams['host'] {
  return {
    pid: process.pid,
    agentQaVersion: kitVersion(),
    playwrightVersion: 'unknown',
    webdriverioVersion: 'unknown',
    ...host,
  }
}

function readManifestField(packageDir: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const field = isRecord(parsed) ? parsed[PLUGIN_MANIFEST_FIELD] : undefined
  return isRecord(field) ? field.plugin : undefined
}

function insidePackage(packageRoot: string, path: string): string | undefined {
  const target = join(packageRoot, path)
  if (!existsSync(target)) return undefined
  const real = realpathSync(target)
  const fromRoot = relative(packageRoot, real)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined
  return real
}

interface CheckedManifest {
  check: ConformanceCheck
  manifest?: RemotePluginManifest
  entry?: string
}

function checkManifest(packageDir: string): CheckedManifest {
  const failed = (detail: string): CheckedManifest => ({
    check: { name: 'manifest', ok: false, detail },
  })
  let packageRoot: string
  let field: unknown
  try {
    packageRoot = realpathSync(packageDir)
    field = readManifestField(packageRoot)
  } catch (error) {
    return failed(`package.json could not be read: ${errorText(error)}`)
  }
  if (field === undefined) return failed(`package.json has no ${PLUGIN_MANIFEST_FIELD}.plugin`)
  const parsed = PluginManifestSchema.safeParse(field)
  if (!parsed.success) {
    return failed(
      parsed.error.issues
        .map(
          (issue) =>
            `${[PLUGIN_MANIFEST_FIELD, 'plugin', ...issue.path.map(String)].join('.')}: ${issue.message}`,
        )
        .join('; '),
    )
  }
  const manifest = parsed.data
  if (manifest.kind !== 'remote') {
    return failed(`a conformance run checks a remote plugin, and this one is ${manifest.kind}`)
  }

  const problems: string[] = []
  const resolved = (key: 'entry' | 'options' | 'settings' | 'skill', path: string) => {
    const real = insidePackage(packageRoot, path)
    if (real === undefined) problems.push(`${key} ${path} does not resolve inside the package`)
    return real
  }
  const entry = resolved('entry', manifest.entry)
  for (const key of ['options', 'settings'] as const) {
    const file = resolved(key, manifest[key])
    if (file === undefined) continue
    try {
      const schema: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isRecord(schema) || typeof schema.$schema !== 'string') {
        problems.push(`${key} ${manifest[key]} names no $schema`)
      } else if (!DRAFT_2020_12.test(schema.$schema)) {
        problems.push(`${key} ${manifest[key]} is ${schema.$schema}, not JSON Schema draft 2020-12`)
      }
    } catch (error) {
      problems.push(`${key} ${manifest[key]} is not JSON: ${errorText(error)}`)
    }
  }
  if (manifest.skill !== undefined) resolved('skill', manifest.skill)
  if (problems.length > 0) return failed(problems.join('; '))
  return { check: { name: 'manifest', ok: true }, manifest, ...(entry ? { entry } : {}) }
}

interface PluginProcess {
  request(method: string, params: unknown, timeoutMs: number): Promise<RpcAnswer>
  send(method: string, params: unknown): { id: number; answered: Promise<RpcAnswer> }
  notify(method: string, params: unknown): void
  stdoutProblems(): string[]
  closeStdin(): void
  exitedWithin(ms: number): Promise<{ exited: boolean; code: number | null }>
  drained(ms: number): Promise<void>
  hasExited(): boolean
  kill(): void
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} got no answer within ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function startPlugin(entry: string, cwd: string): PluginProcess {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: pluginEnvironment(process.env, process.platform),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map<number, (answer: RpcAnswer) => void>()
  const problems: string[] = []
  let stderr = ''
  let exitCode: number | null = null
  let exited = false
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        problems.push(line)
        return
      }
      if (!isRecord(message) || message.jsonrpc !== '2.0') {
        problems.push(line)
        return
      }
      const resolve = typeof message.id === 'number' ? waiting.get(message.id) : undefined
      if (resolve === undefined || typeof message.id !== 'number') return
      waiting.delete(message.id)
      resolve(message as RpcAnswer)
    },
    onOverflow: () => problems.push(`a line longer than ${MAX_MESSAGE_BYTES} bytes`),
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  const exit = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      resolve(code)
    }),
  )
  // 'exit' can come before stdout delivers its last chunks; 'close' comes after the streams end.
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  let next = 0

  const plugin: PluginProcess = {
    send(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcAnswer>((resolve, reject) => {
        waiting.set(id, resolve)
        void exit.then((code) => {
          const reason = stderr.trim().split('\n')[0] ?? ''
          reject(new Error(`the plugin exited with ${code} before answering ${method} ${reason}`))
        })
      })
      answered.catch(() => {})
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return { id, answered }
    },
    request(method, params, timeoutMs) {
      return within(plugin.send(method, params).answered, timeoutMs, method)
    },
    notify(method, params) {
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }))
    },
    stdoutProblems() {
      return [...problems]
    },
    closeStdin() {
      child.stdin.end()
    },
    async exitedWithin(ms) {
      if (exited) return { exited: true, code: exitCode }
      try {
        const code = await within(exit, ms, 'exit')
        return { exited: true, code }
      } catch {
        return { exited: false, code: null }
      }
    },
    async drained(ms) {
      await within(closed, ms, 'stdout').catch(() => {})
      decoder.end()
    },
    hasExited() {
      return exited
    },
    kill() {
      if (!exited) child.kill('SIGKILL')
    },
  }
  return plugin
}

function describeError(answer: RpcAnswer): string {
  if (answer.error === undefined) return `answered ${JSON.stringify(answer.result)}`
  const data = PluginErrorDataSchema.safeParse(answer.error.data)
  const kind = data.success ? ` (kind ${data.data.kind})` : ''
  return `answered ${answer.error.code}: ${answer.error.message}${kind}`
}

function errorHandle(answer: RpcAnswer): unknown {
  const data = answer.error?.data
  return isRecord(data) ? data.handle : undefined
}

async function checkHandshake(
  plugin: PluginProcess,
  manifest: RemotePluginManifest,
  input: ConformanceInput,
  timeoutMs: number,
): Promise<ConformanceCheck> {
  const name = 'handshake'
  let answer: RpcAnswer
  try {
    answer = await plugin.request(
      'initialize',
      {
        protocolVersions: [PLUGIN_PROTOCOL_VERSION],
        host: hostIdentity(input.host),
        entry: 'conformance',
        options: input.options,
      },
      timeoutMs,
    )
  } catch (error) {
    return { name, ok: false, detail: errorText(error) }
  }
  if (answer.error !== undefined) {
    const refusal =
      answer.error.code === PLUGIN_ERROR_CODES.plugin &&
      typeof answer.error.message === 'string' &&
      answer.error.message !== '' &&
      PluginErrorDataSchema.safeParse(answer.error.data).success
    if (input.quick === true && refusal) {
      return { name, ok: true, detail: `initialize refused: ${describeError(answer)}` }
    }
    return { name, ok: false, detail: `initialize ${describeError(answer)}` }
  }
  const result = InitializeResultSchema.safeParse(answer.result)
  if (!result.success) {
    return {
      name,
      ok: false,
      detail: `initialize answered a malformed result: ${result.error.message}`,
    }
  }
  const sorted = (values: readonly string[]) => [...values].sort()
  const problems: string[] = []
  if (result.data.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    problems.push(`protocol ${result.data.protocolVersion}, not ${PLUGIN_PROTOCOL_VERSION}`)
  }
  if (!isDeepStrictEqual(sorted(result.data.serves), sorted(manifest.serves))) {
    problems.push(
      `serves ${result.data.serves.join(', ')}, and the manifest says ${manifest.serves.join(', ')}`,
    )
  }
  if (!isDeepStrictEqual(sorted(result.data.methods), sorted(manifest.methods))) {
    problems.push(
      `methods ${result.data.methods.join(', ') || 'none'}, and the manifest says ${manifest.methods.join(', ') || 'none'}`,
    )
  }
  return problems.length === 0
    ? { name, ok: true }
    : { name, ok: false, detail: `initialize answered ${problems.join('; ')}` }
}

async function checkUnknownMethod(
  plugin: PluginProcess,
  timeoutMs: number,
): Promise<ConformanceCheck> {
  const name = 'unknown-method'
  try {
    const answer = await plugin.request('agent-qa/none', {}, timeoutMs)
    return answer.error?.code === PLUGIN_ERROR_CODES.methodNotFound
      ? { name, ok: true }
      : {
          name,
          ok: false,
          detail: `agent-qa/none ${describeError(answer)}, not ${PLUGIN_ERROR_CODES.methodNotFound}`,
        }
  } catch (error) {
    return { name, ok: false, detail: errorText(error) }
  }
}

async function release(plugin: PluginProcess, handle: unknown, timeoutMs: number) {
  return plugin.request('release', { handle }, timeoutMs)
}

async function checkIdempotentRelease(
  plugin: PluginProcess,
  acquireParams: AcquireParams,
  timeoutMs: number,
): Promise<ConformanceCheck> {
  const name = 'idempotent-release'
  try {
    const acquired = await plugin.request('acquire', acquireParams, timeoutMs)
    if (acquired.error !== undefined) {
      const handle = errorHandle(acquired)
      if (handle !== undefined) await release(plugin, handle, timeoutMs).catch(() => {})
      return { name, ok: false, detail: `acquire ${describeError(acquired)}` }
    }
    const result = AcquireResultSchema.safeParse(acquired.result)
    if (!result.success) {
      return {
        name,
        ok: false,
        detail: `acquire answered a malformed result: ${result.error.message}`,
      }
    }
    for (const attempt of ['first', 'second']) {
      const released = await release(plugin, result.data.handle, timeoutMs)
      if (released.error !== undefined || !isDeepStrictEqual(released.result, {})) {
        return { name, ok: false, detail: `the ${attempt} release ${describeError(released)}` }
      }
    }
    return { name, ok: true }
  } catch (error) {
    return { name, ok: false, detail: errorText(error) }
  }
}

async function checkAnsweredCancel(
  plugin: PluginProcess,
  acquireParams: AcquireParams,
  timeoutMs: number,
): Promise<ConformanceCheck> {
  const name = 'answered-cancel'
  try {
    const acquire = plugin.send('acquire', acquireParams)
    plugin.notify(CANCEL_METHOD, { id: acquire.id })
    const answer = await within(acquire.answered, CANCEL_ANSWER_WINDOW_MS, 'a cancelled acquire')
    if (answer.error === undefined) {
      const result = AcquireResultSchema.safeParse(answer.result)
      if (result.success) await release(plugin, result.data.handle, timeoutMs).catch(() => {})
      return result.success
        ? { name, ok: true }
        : { name, ok: false, detail: 'a cancelled acquire answered a malformed result' }
    }
    const handle = errorHandle(answer)
    if (handle !== undefined) await release(plugin, handle, timeoutMs).catch(() => {})
    return answer.error.code === PLUGIN_ERROR_CODES.cancelled
      ? { name, ok: true }
      : {
          name,
          ok: false,
          detail: `a cancelled acquire ${describeError(answer)}, not a result or ${PLUGIN_ERROR_CODES.cancelled}`,
        }
  } catch (error) {
    return { name, ok: false, detail: errorText(error) }
  }
}

async function checkExitOnStdinClose(plugin: PluginProcess): Promise<ConformanceCheck> {
  const name = 'exit-on-stdin-close'
  if (plugin.hasExited()) {
    return { name, ok: false, detail: 'the plugin exited before its stdin closed' }
  }
  plugin.closeStdin()
  const { exited } = await plugin.exitedWithin(EXIT_WINDOW_MS)
  return exited
    ? { name, ok: true }
    : {
        name,
        ok: false,
        detail: `the plugin was still running ${EXIT_WINDOW_MS} ms after stdin closed`,
      }
}

export async function runConformance(input: ConformanceInput): Promise<ConformanceReport> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const checked = checkManifest(input.packageDir)
  const checks: ConformanceCheck[] = [checked.check]
  if (checked.manifest === undefined || checked.entry === undefined) {
    return { ok: false, checks }
  }

  const plugin = startPlugin(checked.entry, input.packageDir)
  try {
    checks.push(await checkHandshake(plugin, checked.manifest, input, timeoutMs))
    checks.push(await checkUnknownMethod(plugin, timeoutMs))
    if (input.quick !== true) {
      const acquireParams: AcquireParams = {
        remote: 'conformance',
        settings: input.settings ?? {},
        session: input.session ?? DEFAULT_SESSION,
      }
      checks.push(await checkIdempotentRelease(plugin, acquireParams, timeoutMs))
      checks.push(await checkAnsweredCancel(plugin, acquireParams, timeoutMs))
    }
    const exitCheck = await checkExitOnStdinClose(plugin)
    if (exitCheck.ok) await plugin.drained(STDIO_DRAIN_MS)
    const unclean = plugin.stdoutProblems()
    checks.push(
      unclean.length === 0
        ? { name: 'clean-stdout', ok: true }
        : {
            name: 'clean-stdout',
            ok: false,
            detail: `stdout carried ${unclean.length} line(s) that are not JSON-RPC, the first: ${unclean[0]?.slice(0, 200)}`,
          },
    )
    checks.push(exitCheck)
  } finally {
    plugin.kill()
  }
  return { ok: checks.every((check) => check.ok), checks }
}

export function expectManifestCurrent<
  OptionsSchema extends z.ZodType,
  SettingsSchema extends z.ZodType,
>(packageDir: string, definition: PluginDefinition<OptionsSchema, SettingsSchema>): void {
  const expected: Record<string, unknown> = { ...pluginManifest(definition) }
  const field = readManifestField(packageDir)
  const actual: Record<string, unknown> = isRecord(field) ? field : {}
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  const differing = keys.filter((key) => !isDeepStrictEqual(actual[key], expected[key]))
  if (differing.length > 0) {
    throw new Error(
      `package.json's ${PLUGIN_MANIFEST_FIELD}.plugin differs from the definition in ${differing.join(', ')}; run the build's emit step`,
    )
  }
}
