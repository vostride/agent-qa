import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FunctionInputError,
  FunctionNotBoundError,
  StreamReplayFloorError,
  UnknownFunctionError,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type {
  ConfigReaderPort,
  FunctionRegistry,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import { composeLocalAgent } from '@vostride/agent-qa-agent-local'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createFnCommand } from '../commands/fn.js'
import { DaemonNotRunningError, invokeViaDaemon } from '../daemon/client.js'
import {
  DAEMON_IDENTITY_SCHEMA_VERSION,
  DAEMON_SOCKET_PATH_BUDGET_BYTES,
  DAEMON_FUNCTION_CALLER,
  INVOKE_ENVELOPE_SCHEMA_VERSION,
  DaemonSocketInUseError,
  startInvokeServer,
  type InvokeServerHandle,
} from '../daemon/server.js'
import {
  runDaemonHost,
  type DaemonHostOperations,
} from '../daemon/host.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  readDaemonRegistration,
  writeDaemonRegistration,
} from '../daemon/registration.js'
import { removeTempRoots } from './temp-roots.js'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

/**
 * The composition's REQUIRED quarantine identity mint. Passthrough here: this
 * fixture already speaks canonical workspace-relative bytes, and the recipe itself stays pinned
 * in core's `workspace-paths.test.ts` — what these hosts exercise is everything BUT quarantine.
 */
const MINT_IDENTITY = (filePath: string): string => filePath

const roots: string[] = []
const hosts: LocalAgentHost[] = []
const servers: InvokeServerHandle[] = []
const ENDPOINT_INSTANCE_ID = '33333333-3333-4333-8333-333333333333'
const ENDPOINT_IDENTITY = {
  schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION as typeof DAEMON_IDENTITY_SCHEMA_VERSION,
  instanceId: ENDPOINT_INSTANCE_ID,
  pid: process.pid,
}

const MASKED_CONFIG = {
  schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION as typeof MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
  configPath: '/fixture/agent-qa.config.yaml',
  entries: [{ key: 'use.llm', value: 'default', source: 'config-file' as const, masked: false }],
}

const TEST_CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve(MASKED_CONFIG),
}

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:daemon-endpoint',
  generate: () => Promise.resolve({ text: 'unused' }),
}

function temporaryRoot(label: string): string {
  // Keep direct-socket fixtures below Darwin's shorter sun_path limit. The deep-path case below
  // deliberately grows from this short base to prove the production fallback.
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const root = mkdtempSync(join(base, `agent-qa-daemon-endpoint-${label}-`))
  roots.push(root)
  return root
}

function localHost(agentQaRoot: string, knowledgeRoot: string): LocalAgentHost {
  const host = composeLocalAgent({
    mask: (text) => text,
    mintQuarantineIdentityPath: MINT_IDENTITY,
    agentQaRoot,
    config: TEST_CONFIG,
    knowledgeRoot: () => knowledgeRoot,
    model: () => TEST_MODEL,
  })
  hosts.push(host)
  return host
}

function register(agentQaRoot: string, socketPath: string): void {
  writeDaemonRegistration(agentQaRoot, {
    schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
    instanceId: ENDPOINT_INSTANCE_ID,
    pid: process.pid,
    socketPath,
    startedAtMs: Date.now(),
  })
}

interface TestRegistryFixture {
  readonly registry: FunctionRegistry
}

interface FnInvocationResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: typeof process.exitCode
}

interface SemanticEndpointModules {
  readonly FunctionInputError: typeof FunctionInputError
  readonly FunctionNotBoundError: typeof FunctionNotBoundError
  readonly StreamReplayFloorError: typeof StreamReplayFloorError
  readonly UnknownFunctionError: typeof UnknownFunctionError
  readonly invokeFunction: typeof invokeFunction
  readonly invokeViaDaemon: typeof invokeViaDaemon
  readonly startInvokeServer: typeof startInvokeServer
}

let semanticEndpointModules: Promise<SemanticEndpointModules> | undefined

/** Load a second server instance whose agent imports share the source registry test seam. */
function semanticModules(): Promise<SemanticEndpointModules> {
  semanticEndpointModules ??= (async () => {
    const agentPackage = '@vostride/agent-qa-agent'
    const invokeModuleUrl = new URL('../../../agent/src/functions/invoke.ts', import.meta.url)
    const streamModuleUrl = new URL(
      '../../../agent/src/functions/ops/runs-events.ts',
      import.meta.url,
    )
    const actual = await vi.importActual<Record<string, unknown>>(agentPackage)
    const invokeModule = (await import(invokeModuleUrl.href)) as Record<string, unknown>
    const streamModule = (await import(streamModuleUrl.href)) as Record<string, unknown>
    vi.doMock(agentPackage, () => ({ ...actual, ...invokeModule, ...streamModule }))

    const serverModulePath = '../daemon/server.js?semantic-endpoint'
    const clientModulePath = '../daemon/client.js?semantic-endpoint'
    const serverModule = (await import(serverModulePath)) as Record<string, unknown>
    const clientModule = (await import(clientModulePath)) as Record<string, unknown>

    return {
      FunctionInputError: invokeModule.FunctionInputError,
      FunctionNotBoundError: invokeModule.FunctionNotBoundError,
      StreamReplayFloorError: streamModule.StreamReplayFloorError,
      UnknownFunctionError: invokeModule.UnknownFunctionError,
      invokeFunction: invokeModule.invokeFunction,
      invokeViaDaemon: clientModule.invokeViaDaemon,
      startInvokeServer: serverModule.startInvokeServer,
    } as SemanticEndpointModules
  })()
  return semanticEndpointModules
}

/**
 * Endpoint conformance needs a high-tier op and deliberately interrupted stream declarations that
 * do not belong in the production catalog. The spec constructor stays absent from the public agent
 * barrel; this test-only dynamic load exercises the real registry and dispatch (no gate runs since
 * 432-19; re-spelled 2026-10-02, 432-42) without widening the surface firewall or admitting a
 * second production dispatch path.
 */
async function registryFixture(
  specs: readonly Record<string, unknown>[],
): Promise<TestRegistryFixture> {
  const registryModuleUrl = new URL('../../../agent/src/functions/registry.js', import.meta.url)
  const registryModule = (await import(registryModuleUrl.href)) as {
    createRegistryFromSpecs(
      specs: readonly Record<string, unknown>[],
      options: Record<string, unknown>,
    ): FunctionRegistry
  }
  const registry = registryModule.createRegistryFromSpecs(specs, {
    deps: {
      runs: {
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        readEvents: () => Promise.resolve([]),
        readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
      },
      knowledge: {
        listBundles: () => Promise.resolve([]),
        inspectRecords: () => Promise.resolve([]),
        diffSince: () => Promise.resolve([]),
        showRecord: ({ recordId }: { recordId: string }) => Promise.resolve({
          kind: 'not-found',
          schemaVersion: 2,
          recordId,
        } as const),
      },
      config: TEST_CONFIG,
    },
    // no `resolveExecutionContext` registry option and no `requiredScopes`
    // on the synthetic specs; the registry reads neither.
  })
  return { registry }
}

async function startRegistryServer(
  label: string,
  registry: FunctionRegistry,
  startServer: typeof startInvokeServer = startInvokeServer,
): Promise<{ agentQaRoot: string; socketPath: string }> {
  const root = temporaryRoot(label)
  const agentQaRoot = join(root, '.agent-qa')
  const socketPath = join(agentQaRoot, 'daemon.sock')
  register(agentQaRoot, socketPath)
  const server = await startServer({ socketPath, registry, identity: ENDPOINT_IDENTITY })
  servers.push(server)
  return { agentQaRoot, socketPath }
}

async function rawInvoke(
  socketPath: string,
  functionId: string,
  input: unknown,
): Promise<{ contentType: string; statusCode: number; text: string }> {
  const body = JSON.stringify({ schemaVersion: INVOKE_ENVELOPE_SCHEMA_VERSION, functionId, input })
  return new Promise((resolveInvoke, rejectInvoke) => {
    const outgoing = request(
      {
        socketPath,
        path: '/invoke',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
      },
      (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk: string) => {
          text += chunk
        })
        response.once('error', rejectInvoke)
        response.once('end', () => {
          resolveInvoke({
            contentType: String(response.headers['content-type'] ?? ''),
            statusCode: response.statusCode ?? 500,
            text,
          })
        })
      },
    )
    outgoing.once('error', rejectInvoke)
    outgoing.end(body)
  })
}

async function capturedRejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`Expected an Error rejection, received ${String(error)}`)
  }
  throw new Error('Expected invocation to reject')
}

function fnFixture(label: string): {
  readonly root: string
  readonly agentQaRoot: string
  readonly configPath: string
  readonly socketPath: string
} {
  const root = temporaryRoot(label)
  const agentQaRoot = join(root, '.agent-qa')
  const configPath = join(root, 'agent-qa.config.yaml')
  const socketPath = join(agentQaRoot, 'daemon.sock')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'preserve' } },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return { root, agentQaRoot, configPath, socketPath }
}

async function invokeFn(
  configPath: string,
  args: readonly string[],
  viaDaemonEnv?: string,
  onStdout?: (line: string) => void,
): Promise<FnInvocationResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousExitCode = process.exitCode
  const previousViaDaemonEnv = process.env.AGENT_QA_VIA_DAEMON
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    const line = values.map(String).join(' ')
    stdout.push(line)
    onStdout?.(line)
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined
  if (viaDaemonEnv === undefined) delete process.env.AGENT_QA_VIA_DAEMON
  else process.env.AGENT_QA_VIA_DAEMON = viaDaemonEnv

  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createFnCommand())
    program.exitOverride()
    await program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      configPath,
      'fn',
      ...args,
    ])
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      exitCode: process.exitCode,
    }
  } finally {
    process.exitCode = previousExitCode
    if (previousViaDaemonEnv === undefined) delete process.env.AGENT_QA_VIA_DAEMON
    else process.env.AGENT_QA_VIA_DAEMON = previousViaDaemonEnv
    log.mockRestore()
    error.mockRestore()
  }
}

async function startFnServer(
  fixture: ReturnType<typeof fnFixture>,
  registry: FunctionRegistry,
): Promise<void> {
  register(fixture.agentQaRoot, fixture.socketPath)
  const server = await startInvokeServer({
    socketPath: fixture.socketPath,
    registry,
    identity: ENDPOINT_IDENTITY,
  })
  servers.push(server)
}

async function waitFor<T>(
  operation: () => Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`${message}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function signalHarness(): {
  operations: Partial<DaemonHostOperations>
  signal(signal: NodeJS.Signals): void
} {
  const signals = new Map<NodeJS.Signals, () => void>()
  return {
    operations: {
      onSignal: (signal, listener) => signals.set(signal, listener),
      offSignal: (signal, listener) => {
        if (signals.get(signal) === listener) signals.delete(signal)
      },
    },
    signal(signal) {
      const listener = signals.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const host of hosts.splice(0)) host.close()
  removeTempRoots(roots.splice(0))
})

describe('daemon /invoke endpoint tracer', () => {
  it('rejects an alive-pid registration whose identity endpoint is unreachable', async () => {
    const root = temporaryRoot('alive-pid-no-listener')
    const agentQaRoot = join(root, '.agent-qa')
    register(agentQaRoot, join(agentQaRoot, 'missing.sock'))

    await expect(invokeViaDaemon({
      agentQaRoot,
      functionId: 'config.get',
      input: {},
    })).rejects.toMatchObject({
      name: DaemonNotRunningError.name,
      reason: 'unreachable-lease-stale',
    })
  })

  it('keeps invokeFunction as the route module\'s only dispatch call', () => {
    const source = readFileSync(new URL('../daemon/server.ts', import.meta.url), 'utf8')
    expect(source.match(/\binvokeFunction\s*\(/g)).toHaveLength(1)
  })

  it('pins bounded stream resume attempts in source', async () => {
    const clientModule = (await import('../daemon/client.js')) as Record<string, unknown>
    const source = readFileSync(new URL('../daemon/client.ts', import.meta.url), 'utf8')

    expect(clientModule.STREAM_RESUME_MAX_ATTEMPTS).toBe(3)
    expect(source).toMatch(/STREAM_RESUME_MAX_ATTEMPTS\s*=\s*3/u)
  })

  it('serves the daemon instance identity without widening the function registry surface', async () => {
    const root = temporaryRoot('identity')
    const agentQaRoot = join(root, '.agent-qa')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    const host = localHost(agentQaRoot, join(root, 'agent-qa-knowledge'))
    const server = await startInvokeServer({
      socketPath,
      registry: host.registry,
      identity: ENDPOINT_IDENTITY,
    } as Parameters<typeof startInvokeServer>[0])
    servers.push(server)

    const response = await new Promise<{ statusCode: number; text: string }>((resolveResponse, rejectResponse) => {
      const outgoing = request({
        socketPath,
        path: '/identity',
        method: 'GET',
        headers: { connection: 'close' },
      }, (incoming) => {
        incoming.setEncoding('utf8')
        let text = ''
        incoming.on('data', (chunk: string) => { text += chunk })
        incoming.once('error', rejectResponse)
        incoming.once('end', () => resolveResponse({
          statusCode: incoming.statusCode ?? 500,
          text,
        }))
      })
      outgoing.once('error', rejectResponse)
      outgoing.end()
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.text)).toEqual({
      schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
      instanceId: ENDPOINT_INSTANCE_ID,
      pid: process.pid,
    })
  })

  it('matches in-process invocation through the registered over-budget fallback socket', async () => {
    const root = temporaryRoot('deep')
    const projectRoot = join(root, 'x'.repeat(64), 'y'.repeat(64))
    const agentQaRoot = join(projectRoot, '.agent-qa')
    const knowledgeRoot = join(projectRoot, 'agent-qa-knowledge')
    mkdirSync(projectRoot, { recursive: true })
    roots.push(projectRoot)

    const comparison = localHost(join(root, 'comparison-runtime'), join(root, 'comparison-knowledge'))
    const expected = await invokeFunction(
      comparison.registry,
      'config.get',
      {},
      DAEMON_FUNCTION_CALLER,
    )

    const harness = signalHarness()
    const running = runDaemonHost({
      agentQaRoot,
      knowledgeRoot,
      config: TEST_CONFIG,
      model: () => TEST_MODEL,
      operations: harness.operations,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const actual = await waitFor(
      () => invokeViaDaemon({ agentQaRoot, functionId: 'config.get', input: {} }),
      'daemon invocation never became reachable',
    )
    expect(actual).toEqual(expected)

    const registration = readDaemonRegistration(agentQaRoot)
    expect(registration.kind).toBe('parsed')
    if (registration.kind !== 'parsed') throw new Error('expected parsed daemon registration')
    expect(Buffer.byteLength(registration.registration.socketPath, 'utf8')).toBeLessThanOrEqual(
      DAEMON_SOCKET_PATH_BUDGET_BYTES,
    )
    expect(registration.registration.socketPath.startsWith(agentQaRoot)).toBe(false)
    expect(registration.registration.socketPath.startsWith(tmpdir())).toBe(true)

    harness.signal('SIGTERM')
    await expect(running).resolves.toBe(0)
    expect(existsSync(registration.registration.socketPath)).toBe(false)
  })

  it('recovers a stale plain-file endpoint and serves the one versioned route', async () => {
    const root = temporaryRoot('plain-file')
    const agentQaRoot = join(root, '.agent-qa')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    mkdirSync(agentQaRoot, { recursive: true })
    writeFileSync(socketPath, 'stale endpoint', 'utf8')

    const host = localHost(agentQaRoot, join(root, 'agent-qa-knowledge'))
    register(agentQaRoot, socketPath)
    const server = await startInvokeServer({
      socketPath,
      registry: host.registry,
      identity: ENDPOINT_IDENTITY,
    })
    servers.push(server)

    await expect(invokeViaDaemon({
      agentQaRoot,
      functionId: 'config.get',
      input: {},
    })).resolves.toEqual(MASKED_CONFIG)
    // the op gate's row was this cell's witness that the route dispatched through
    // `invokeFunction`; no row is written now, and the masked answer above is the dispatch's own.
    expect(existsSync(join(agentQaRoot, 'execution_audit.jsonl'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('recovers a dead Unix socket left by a crashed process', async () => {
    const root = temporaryRoot('dead-socket')
    const agentQaRoot = join(root, '.agent-qa')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    mkdirSync(agentQaRoot, { recursive: true })

    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `import net from 'node:net'; net.createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'))`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.stdout === null) throw new Error('child stdout was not piped')
    await once(child.stdout, 'data')
    child.kill('SIGKILL')
    await once(child, 'exit')
    expect(existsSync(socketPath)).toBe(true)

    const host = localHost(agentQaRoot, join(root, 'agent-qa-knowledge'))
    register(agentQaRoot, socketPath)
    const server = await startInvokeServer({
      socketPath,
      registry: host.registry,
      identity: ENDPOINT_IDENTITY,
    })
    servers.push(server)

    await expect(invokeViaDaemon({
      agentQaRoot,
      functionId: 'config.get',
      input: {},
    })).resolves.toEqual(MASKED_CONFIG)
  })

  it('refuses to unlink or replace a live listener', async () => {
    const root = temporaryRoot('live-listener')
    const agentQaRoot = join(root, '.agent-qa')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    const host = localHost(agentQaRoot, join(root, 'agent-qa-knowledge'))
    const first = await startInvokeServer({ socketPath, registry: host.registry })
    servers.push(first)

    await expect(startInvokeServer({ socketPath, registry: host.registry }))
      .rejects.toBeInstanceOf(DaemonSocketInUseError)
    expect(existsSync(socketPath)).toBe(true)
  })
})

describe('daemon /invoke endpoint semantic parity', () => {
  it('frames terminal completion and resumes from lastEventId after clean shutdown', async () => {
    const semantic = await semanticModules()
    const elements = [
      { seq: 1, value: 'one' },
      { seq: 2, value: 'two' },
      { seq: 3, value: 'three' },
    ]
    const resumeInputs: Array<number | undefined> = []
    let releaseInitialStream!: () => void
    const initialStreamBlocked = new Promise<void>((resolveBlocked) => {
      releaseInitialStream = resolveBlocked
    })
    const streamInput = z.object({ lastEventId: z.number().int().optional() }).strict()
    const streamOutput = z.object({ seq: z.number().int(), value: z.string() }).strict()
    const { registry } = await registryFixture([
      {
        id: 'synthetic.frames',
        summary: 'Stable stream for exact SSE framing.',
        resultKind: 'stream',
        input: streamInput,
        output: streamOutput,
        risk: { name: 'fn:synthetic.frames', recognized: true, readOnly: true },
        async invoke(input: { lastEventId?: number }) {
          return (async function* () {
            for (const element of elements.filter(({ seq }) => seq > (input.lastEventId ?? 0))) {
              yield element
            }
          })()
        },
      },
      {
        id: 'synthetic.resume',
        summary: 'Interrupted stream for one reconnect with lastEventId.',
        resultKind: 'stream',
        input: streamInput,
        output: streamOutput,
        risk: { name: 'fn:synthetic.resume', recognized: true, readOnly: true },
        async invoke(input: { lastEventId?: number }) {
          resumeInputs.push(input.lastEventId)
          return (async function* () {
            for (const element of elements.filter(({ seq }) => seq > (input.lastEventId ?? 0))) {
              yield element
              if (input.lastEventId === undefined && element.seq === 1) {
                await initialStreamBlocked
              }
            }
          })()
        },
      },
    ])
    const root = temporaryRoot('sse')
    const agentQaRoot = join(root, '.agent-qa')
    const socketPath = join(agentQaRoot, 'daemon.sock')
    register(agentQaRoot, socketPath)
    const firstServer = await semantic.startInvokeServer({
      socketPath,
      registry,
      identity: ENDPOINT_IDENTITY,
    })
    servers.push(firstServer)

    const framed = await rawInvoke(socketPath, 'synthetic.frames', {})
    expect(framed.statusCode).toBe(200)
    expect(framed.contentType).toContain('text/event-stream')
    expect(framed.text).toBe(
      'id: 1\ndata: {"seq":1,"value":"one"}\n\n' +
        'id: 2\ndata: {"seq":2,"value":"two"}\n\n' +
        'id: 3\ndata: {"seq":3,"value":"three"}\n\n' +
        'event: stream-end\ndata: {}\n\n',
    )

    const result = await semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.resume',
      input: {},
    })
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first).toEqual({ done: false, value: elements[0] })

    const successorSocketPath = join(agentQaRoot, 'daemon-successor.sock')
    const successorServer = await semantic.startInvokeServer({
      socketPath: successorSocketPath,
      registry,
      identity: ENDPOINT_IDENTITY,
    })
    servers.push(successorServer)
    register(agentQaRoot, successorSocketPath)

    const remainderPromise = (async () => {
      const remainder: unknown[] = []
      while (true) {
        const next = await iterator.next()
        if (next.done) return remainder
        remainder.push(next.value)
      }
    })()

    await firstServer.close()
    releaseInitialStream()
    const observed = [first.value, ...(await remainderPromise)]

    expect(observed).toEqual(elements)
    expect(resumeInputs).toEqual([undefined, 1])
  })

  it('rejects a clean shutdown between events instead of accepting partial success', async () => {
    const semantic = await semanticModules()
    let releaseStream!: () => void
    const streamBlocked = new Promise<void>((resolveBlocked) => {
      releaseStream = resolveBlocked
    })
    const streamInput = z.object({ lastEventId: z.number().int().optional() }).strict()
    const streamOutput = z.object({ seq: z.number().int(), value: z.string() }).strict()
    const { registry } = await registryFixture([
      {
        id: 'synthetic.clean-shutdown',
        summary: 'Clean shutdown between two stream events.',
        resultKind: 'stream',
        input: streamInput,
        output: streamOutput,
        risk: { name: 'fn:synthetic.clean-shutdown', recognized: true, readOnly: true },
        async invoke() {
          return (async function* () {
            yield { seq: 1, value: 'before-shutdown' }
            await streamBlocked
            yield { seq: 2, value: 'after-shutdown' }
          })()
        },
      },
    ])
    const { agentQaRoot } = await startRegistryServer(
      'clean-shutdown',
      registry,
      semantic.startInvokeServer,
    )
    const result = await semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.clean-shutdown',
      input: {},
    })
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({
      done: false,
      value: { seq: 1, value: 'before-shutdown' },
    })
    const interrupted = iterator.next()
    const activeServer = servers.at(-1)
    if (activeServer === undefined) throw new Error('Expected an active daemon server')

    await activeServer.close()
    releaseStream()
    const error = await capturedRejection(interrupted)

    expect(error).toMatchObject({
      name: 'DaemonStreamInterruptedError',
      lastEventId: 1,
      reason: expect.any(String),
    })
  })

  it('rehydrates a terminal stream error with in-process named-error parity', async () => {
    const semantic = await semanticModules()
    const streamInput = z.object({ lastEventId: z.number().int().optional() }).strict()
    const streamOutput = z.object({ seq: z.number().int(), value: z.string() }).strict()
    const { registry } = await registryFixture([
      {
        id: 'synthetic.stream-error',
        summary: 'Named error after a delivered stream element.',
        resultKind: 'stream',
        input: streamInput,
        output: streamOutput,
        risk: { name: 'fn:synthetic.stream-error', recognized: true, readOnly: true },
        async invoke() {
          return (async function* () {
            yield { seq: 1, value: 'before-error' }
            throw new semantic.StreamReplayFloorError('run-stream-error', 1, 7)
          })()
        },
      },
    ])

    const inProcessResult = await semantic.invokeFunction(
      registry,
      'synthetic.stream-error',
      {},
      DAEMON_FUNCTION_CALLER,
    )
    const inProcessError = await capturedRejection((async () => {
      for await (const _element of inProcessResult as AsyncIterable<unknown>) {
        // Consume through the semantic failure boundary.
      }
    })())
    expect(inProcessError).toBeInstanceOf(semantic.StreamReplayFloorError)

    const { agentQaRoot } = await startRegistryServer(
      'terminal-stream-error',
      registry,
      semantic.startInvokeServer,
    )
    const overWireResult = await semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.stream-error',
      input: {},
    })
    const overWireError = await capturedRejection((async () => {
      for await (const _element of overWireResult as AsyncIterable<unknown>) {
        // Consume through the framed semantic failure boundary.
      }
    })())

    expect(overWireError).toBeInstanceOf(semantic.StreamReplayFloorError)
    expect(overWireError).toMatchObject({
      name: inProcessError.name,
      message: inProcessError.message,
      runId: 'run-stream-error',
      requestedSeq: 1,
      earliestAvailableSeq: 7,
    })
  })

  it('rehydrates every named refusal class with its structured fields intact', async () => {
    const semantic = await semanticModules()
    const emptyInput = z.object({}).strict()
    const output = z.object({ ok: z.literal(true) }).strict()
    const { registry } = await registryFixture([
      {
        id: 'synthetic.input',
        summary: 'Input refusal fixture.',
        resultKind: 'unary',
        input: z.object({ value: z.string() }).strict(),
        output,
        risk: { name: 'fn:synthetic.input', recognized: true, readOnly: true },
        invoke: () => Promise.resolve({ ok: true }),
      },
      {
        id: 'synthetic.scope',
        summary: 'Scope refusal fixture.',
        resultKind: 'unary',
        input: emptyInput,
        output,
        risk: { name: 'fn:synthetic.scope', recognized: true, readOnly: true },
        invoke: () => Promise.resolve({ ok: true }),
      },
      {
        id: 'synthetic.unbound',
        summary: 'Binding refusal fixture.',
        resultKind: 'unary',
        boundThrough: 'runInvocation',
        input: emptyInput,
        output,
        risk: { name: 'fn:synthetic.unbound', recognized: true, readOnly: true },
        invoke: () => Promise.resolve({ ok: true }),
      },
      {
        id: 'synthetic.floor',
        summary: 'Replay-floor refusal fixture.',
        resultKind: 'stream',
        input: emptyInput,
        output,
        risk: { name: 'fn:synthetic.floor', recognized: true, readOnly: true },
        invoke: () => Promise.reject(
          new semantic.StreamReplayFloorError('run-fixture', 2, 7),
        ),
      },
    ])
    const { agentQaRoot } = await startRegistryServer(
      'refusals',
      registry,
      semantic.startInvokeServer,
    )

    const unknown = await capturedRejection(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.missing',
      input: {},
    }))
    expect(unknown).toBeInstanceOf(semantic.UnknownFunctionError)
    expect(unknown).toMatchObject({ functionId: 'synthetic.missing' })

    const invalid = await capturedRejection(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.input',
      input: { value: 1 },
    }))
    expect(invalid).toBeInstanceOf(semantic.FunctionInputError)
    expect(invalid).toMatchObject({
      functionId: 'synthetic.input',
      issues: expect.stringContaining('value'),
    })

    // the scope refusal is deleted, so the op that declares a scope no caller holds
    // answers over the wire like any other; there is no scope class left to rehydrate.
    // the fixture no longer spells the retired `requiredScopes`
    // ('fixture-scope'); the registry never read it, so the op answers by construction.
    await expect(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.scope',
      input: {},
    })).resolves.toEqual({ ok: true })

    const unbound = await capturedRejection(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.unbound',
      input: {},
    }))
    expect(unbound).toBeInstanceOf(semantic.FunctionNotBoundError)
    expect(unbound).toMatchObject({ functionId: 'synthetic.unbound' })

    const floor = await capturedRejection(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.floor',
      input: {},
    }))
    expect(floor).toBeInstanceOf(semantic.StreamReplayFloorError)
    expect(floor).toMatchObject({
      runId: 'run-fixture',
      requestedSeq: 2,
      earliestAvailableSeq: 7,
    })
  })

  // RE-SPELLED 2026-09-30. Was 'surfaces the real fail-closed ask
  // denial with exactly the gate audit row': the daemon's `local-headless` posture failed an
  // ask-tier op closed, identically in process and over the wire. No gate runs now, so the same
  // ask-tier op DISPATCHES identically on both sides and neither writes a row. The wire half of the
  // retired claim (the neutral reason crossing `wireError`) has no producer left to carry.
  it('dispatches an ask-tier op identically in process and over the wire, with no audit row', async () => {
    const semantic = await semanticModules()
    const { registry } = await registryFixture([
      {
        id: 'synthetic.ask',
        summary: 'A mutating fixture the daemon local-headless posture dispatches directly.',
        resultKind: 'unary',
        input: z.object({}).strict(),
        output: z.object({ ok: z.literal(true) }).strict(),
        risk: {
          name: 'fn:synthetic.ask',
          recognized: true,
        },
        invoke: () => Promise.resolve({ ok: true }),
      },
    ])

    await expect(
      semantic.invokeFunction(registry, 'synthetic.ask', {}, DAEMON_FUNCTION_CALLER),
    ).resolves.toEqual({ ok: true })

    const { agentQaRoot } = await startRegistryServer(
      'ask-deny',
      registry,
      semantic.startInvokeServer,
    )
    await expect(semantic.invokeViaDaemon({
      agentQaRoot,
      functionId: 'synthetic.ask',
      input: {},
    })).resolves.toEqual({ ok: true })
  })
})

describe('agent-qa fn explicit daemon routing', () => {
  it('keeps the default invocation local even while a divergent daemon is live', async () => {
    const fixture = fnFixture('fn-default-local')
    const daemonHost = localHost(
      join(fixture.root, 'daemon-runtime'),
      join(fixture.root, 'daemon-knowledge'),
    )
    await startFnServer(fixture, daemonHost.registry)

    const result = await invokeFn(fixture.configPath, ['config.get', '--json'])

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).not.toEqual(MASKED_CONFIG)
  })

  it('routes the flag and env switch through the same daemon with in-process parity', async () => {
    const fixture = fnFixture('fn-via-daemon')
    const daemonHost = localHost(
      join(fixture.root, 'daemon-runtime'),
      join(fixture.root, 'daemon-knowledge'),
    )
    await startFnServer(fixture, daemonHost.registry)
    const expected = await invokeFunction(
      daemonHost.registry,
      'config.get',
      {},
      DAEMON_FUNCTION_CALLER,
    )

    const viaFlag = await invokeFn(fixture.configPath, [
      'config.get',
      '--via-daemon',
      '--json',
    ])
    const viaEnv = await invokeFn(fixture.configPath, ['config.get', '--json'], '1')

    expect(viaFlag).toEqual(viaEnv)
    expect(viaFlag.stderr).toBe('')
    expect(viaFlag.exitCode).toBeUndefined()
    expect(JSON.parse(viaFlag.stdout)).toEqual(expected)
  })

  it('fails clearly without a live daemon and never falls back to local dispatch', async () => {
    const fixture = fnFixture('fn-no-daemon')

    const result = await invokeFn(fixture.configPath, [
      'runs.list',
      '--via-daemon',
      '--json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('DaemonNotRunningError')
    expect(result.stderr).toContain('Start `agent-qa daemon`')
    expect(result.stderr).toContain('omit --via-daemon')
  })

  it('exits non-zero with the named interruption when a streamed CLI result is truncated', async () => {
    const semantic = await semanticModules()
    const fixture = fnFixture('fn-interrupted-stream')
    let firstElementRendered!: () => void
    const firstElement = new Promise<void>((resolveElement) => {
      firstElementRendered = resolveElement
    })
    let releaseStream!: () => void
    const streamBlocked = new Promise<void>((resolveBlocked) => {
      releaseStream = resolveBlocked
    })
    const { registry } = await registryFixture([
      {
        id: 'synthetic.cli-interrupted',
        summary: 'CLI stream interrupted after its first element.',
        resultKind: 'stream',
        input: z.object({ lastEventId: z.number().int().optional() }).strict(),
        output: z.object({ seq: z.number().int(), type: z.string() }).strict(),
        risk: { name: 'fn:synthetic.cli-interrupted', recognized: true, readOnly: true },
        async invoke(input: { lastEventId?: number }) {
          return (async function* () {
            if ((input.lastEventId ?? 0) < 1) {
              yield { seq: 1, type: 'before-shutdown' }
              await streamBlocked
            }
            if ((input.lastEventId ?? 0) < 2) {
              yield { seq: 2, type: 'after-shutdown' }
            }
          })()
        },
      },
    ])
    register(fixture.agentQaRoot, fixture.socketPath)
    const server = await semantic.startInvokeServer({
      socketPath: fixture.socketPath,
      registry,
      identity: ENDPOINT_IDENTITY,
    })
    servers.push(server)

    const invocation = invokeFn(fixture.configPath, [
      'synthetic.cli-interrupted',
      '--via-daemon',
    ], undefined, (line) => {
      if (line.includes('seq 1')) firstElementRendered()
    })
    await firstElement
    const activeServer = servers.at(-1)
    if (activeServer === undefined) throw new Error('Expected an active daemon server')

    const closing = activeServer.close()
    releaseStream()
    await closing
    const result = await invocation

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('DaemonStreamInterruptedError')
    expect(result.stderr).toContain('after event 1')
    expect(result.stdout).toContain('seq 1')
    expect(result.stdout).not.toContain('1 event · last seq 1')
  })
})
