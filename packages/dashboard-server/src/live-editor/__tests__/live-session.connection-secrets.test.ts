import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { generateHookId } from '@vostride/agent-qa-ids'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  adapterOptions,
  adapterSetups,
  mockExecuteStep,
  mockHookExecute,
  mockPlan,
  mockRunHooks,
  real,
} = vi.hoisted(() => ({
  adapterOptions: [] as unknown[],
  adapterSetups: [] as unknown[],
  mockExecuteStep: vi.fn(),
  mockHookExecute: vi.fn(),
  mockPlan: vi.fn(),
  mockRunHooks: vi.fn(),
  real: { adapter: false },
}))

vi.mock('@vostride/agent-qa-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-web')>()
  return {
    ...actual,
    WebPlatformAdapter: vi.fn().mockImplementation(function (options: unknown) {
      adapterOptions.push(options)
      if (real.adapter) {
        return new actual.WebPlatformAdapter(
          options as ConstructorParameters<typeof actual.WebPlatformAdapter>[0],
        )
      }
      return {
        platform: 'web',
        setup: vi.fn(async (config: unknown) => {
          adapterSetups.push(config)
        }),
        cleanup: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ success: true }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
        observe: vi.fn().mockResolvedValue({ tree: '', elements: [], timestamp: 0, metadata: {} }),
        drainConsoleLogs: vi.fn(() => []),
        drainNetworkLogs: vi.fn(() => []),
      }
    }),
  }
})

vi.mock('@vostride/agent-qa-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner')>()),
  executeStep: (...args: unknown[]) => mockExecuteStep(...args),
  LLMPlanner: vi.fn().mockImplementation(function () {
    return { plan: mockPlan }
  }),
  LLMVerifier: vi.fn().mockImplementation(function () {
    return { verify: vi.fn() }
  }),
  runHooks: (...args: unknown[]) => mockRunHooks(...args),
}))

vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()),
  DockerHookExecutor: class {
    execute(...args: unknown[]) {
      return mockHookExecute(...args)
    }
  },
}))

vi.mock('@vostride/agent-qa-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-model')>()),
  createModel: vi.fn().mockReturnValue({ modelId: 'test-model' }),
}))

import { splitConnectionSecrets } from '@vostride/agent-qa-core'
import type { HookDefinition } from '@vostride/agent-qa-core'
import { SecretRedactor, SecretStore, basicAuthMaskEntries } from '@vostride/agent-qa-runner'
import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'

import { LiveSession } from '../live-session.js'
import type { LiveSessionConfig } from '../types.js'
import { createSessionHandler } from '../ws-handler.js'

const REMOTE_TOKEN = 'remote-token-7f3a91c2'
const LOGIN_PASSWORD = 'login-pass-55e1'

const declared = SecretStore.fromEnvContent(
  `REMOTE_TOKEN=${REMOTE_TOKEN}\nLOGIN_PASSWORD=${LOGIN_PASSWORD}\n`,
)

function remoteEntry(url: string): RemoteBrowserConfig {
  return {
    name: 'grid',
    protocol: 'playwright',
    url,
    headers: { Authorization: 'Bearer {{secret:REMOTE_TOKEN}}' },
    connectTimeoutMs: 30_000,
  }
}

function sessionConfig(
  remote: RemoteBrowserConfig,
  extra: Partial<LiveSessionConfig> = {},
): LiveSessionConfig {
  const { stepStore, connectionNames } = splitConnectionSecrets(declared, { registry: { remotes: [remote] } })
  return {
    platform: 'web',
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'test-model',
      baseURL: 'http://127.0.0.1:1/',
    },
    headless: true,
    secretStore: stepStore,
    connectionSecretStore: declared,
    connectionSecretNames: connectionNames,
    secretsFile: '.env.secrets.local',
    secretRedactor: new SecretRedactor(declared, basicAuthMaskEntries([remote], declared)),
    ...extra,
  }
}

const hook: HookDefinition = {
  id: generateHookId(),
  name: 'seed',
  runtime: 'node',
  file: '/tmp/seed.js',
  deps: [],
  timeout: 30_000,
  network: false,
} as HookDefinition

function passedStep(name: string) {
  return {
    name,
    status: 'passed',
    duration: 5,
    trace: {
      observation: '',
      reasoning: '',
      plannedAction: {},
      result: 'success',
      screenStateBefore: '',
    },
  }
}

function secretNames(store: unknown): string[] {
  const names: string[] = []
  ;(store as SecretStore).forEachSecret((name) => names.push(name))
  return names.sort()
}

const misuseSentence =
  "REMOTE_TOKEN is a remote's or device's credential and only connects to it; the draft \"checkout\" uses it in a step. Use another secret there."

beforeEach(() => {
  adapterOptions.length = 0
  adapterSetups.length = 0
  real.adapter = false
  mockExecuteStep
    .mockReset()
    .mockImplementation(async (instruction: string) => passedStep(instruction))
  mockHookExecute.mockReset().mockResolvedValue({
    success: true,
    duration: 1,
    stdout: '',
    stderr: '',
    variables: {},
  })
  mockPlan.mockReset()
  mockRunHooks.mockReset().mockResolvedValue({
    results: new Map([
      ['seed', { success: true, duration: 1, stdout: '', stderr: '', variables: {} }],
    ]),
    variables: {},
    allPassed: true,
    duration: 1,
  })
})

describe("the live editor and a remote's secrets", () => {
  it('gives the adapter the full store, the secrets file and a refusal memory', async () => {
    const remote = remoteEntry('ws://127.0.0.1:3000/')
    const session = new LiveSession('connection-secrets-adapter')
    await session.initialize(sessionConfig(remote, { remote }))

    expect(adapterOptions).toHaveLength(1)
    const options = adapterOptions[0] as {
      connectionSecrets?: SecretStore
      secretsFile?: string
      refusalMemory?: { refusalFor(name: string): unknown }
    }
    expect(options.connectionSecrets).toBe(declared)
    expect(options.secretsFile).toBe('.env.secrets.local')
    expect(typeof options.refusalMemory?.refusalFor).toBe('function')
    expect(adapterSetups[0]).toMatchObject({ browser: { name: 'chromium', remote } })
    await session.cleanup()
  })

  it('gives setup hooks, inline hooks and steps the step store without the remote secret', async () => {
    const remote = remoteEntry('ws://127.0.0.1:3000/')
    const session = new LiveSession('connection-secrets-hooks')
    await session.initialize(
      sessionConfig(remote, { setupHooks: [hook.id], resolvedHooks: new Map([[hook.id, hook]]) }),
    )

    const setupOptions = mockRunHooks.mock.calls[0]?.[1] as { secretStore?: SecretStore }
    expect(secretNames(setupOptions.secretStore)).toEqual(['LOGIN_PASSWORD'])

    const result = await session.executeStepCommand(
      `{{runHook:"${hook.id}"}} Type {{secret:LOGIN_PASSWORD}} into the password field`,
      0,
      undefined,
      { testName: 'checkout' },
    )
    expect(result.status).toBe('passed')
    const inline = mockHookExecute.mock.calls[0]?.[1] as { secretEnv: Record<string, string> }
    expect(inline.secretEnv).toEqual({ LOGIN_PASSWORD })
    const ports = mockExecuteStep.mock.calls[0]?.[1] as { secretStore?: SecretStore }
    expect(secretNames(ports.secretStore)).toEqual(['LOGIN_PASSWORD'])
    await session.cleanup()
  })

  it('never resolves a remote secret in the start url', async () => {
    const remote = remoteEntry('ws://127.0.0.1:3000/')
    const session = new LiveSession('connection-secrets-url')
    await expect(
      session.initialize(
        sessionConfig(remote, { url: 'http://127.0.0.1:8080/?k={{secret:REMOTE_TOKEN}}' }),
      ),
    ).rejects.toThrow('Secret not found: REMOTE_TOKEN')
    await session.cleanup()
  })

  it('refuses a step that uses a remote secret before any hook or planner runs', async () => {
    const remote = remoteEntry('ws://127.0.0.1:3000/')
    const session = new LiveSession('connection-secrets-refusal')
    await session.initialize(sessionConfig(remote, { resolvedHooks: new Map([[hook.id, hook]]) }))

    const result = await session.executeStepCommand(
      'Type {{secret:REMOTE_TOKEN}} into the field',
      0,
      undefined,
      { testName: 'checkout' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toBe(misuseSentence)

    const inline = await session.executeStepCommand(
      `{{runHook:"${hook.id}"}} Verify the banner reads "{{secret:REMOTE_TOKEN}}"`,
    )
    expect(inline.error).toBe(
      "REMOTE_TOKEN is a remote's or device's credential and only connects to it; this draft uses it in a step. Use another secret there.",
    )
    expect(mockHookExecute).not.toHaveBeenCalled()
    expect(mockExecuteStep).not.toHaveBeenCalled()
    expect(mockPlan).not.toHaveBeenCalled()
    await session.cleanup()
  })

  it('lets a step that uses another declared secret past the check', async () => {
    const remote = remoteEntry('ws://127.0.0.1:3000/')
    const session = new LiveSession('connection-secrets-other')
    await session.initialize(sessionConfig(remote))

    const result = await session.executeStepCommand(
      'Type {{secret:LOGIN_PASSWORD}} into the password field',
      0,
      undefined,
      { testName: 'checkout' },
    )
    expect(result.status).toBe('passed')
    expect(mockExecuteStep).toHaveBeenCalledTimes(1)
    await session.cleanup()
  })
})

interface PlaywrightServerLauncher {
  chromium: {
    executablePath(): string
    launchServer(options: {
      host: string
    }): Promise<{ wsEndpoint(): string; close(): Promise<void> }>
  }
}

// Playwright comes from the web adapter's own install, the same build the session drives.
const playwright = createRequire(createRequire(import.meta.url).resolve('@vostride/agent-qa-web'))(
  'playwright-core',
) as PlaywrightServerLauncher

interface HeaderGuardedEndpoint {
  readonly wsEndpoint: string
  sessions(): number
  refusals(): number
  close(): Promise<void>
}

// A Playwright server on loopback whose proxy answers 401 to an upgrade without the header.
async function startHeaderGuardedEndpoint(
  [header, value]: readonly [string, string],
): Promise<HeaderGuardedEndpoint> {
  if (!existsSync(playwright.chromium.executablePath())) {
    throw new Error('Playwright Chromium missing; never skip')
  }
  const server = await playwright.chromium.launchServer({ host: '127.0.0.1' })
  const upstream = new URL(server.wsEndpoint())
  const sockets = new Set<Socket>()
  let sessions = 0
  let refusals = 0
  const proxy: Server = createServer((client) => {
    const toServer = connect(Number(upstream.port), '127.0.0.1')
    sockets.add(client).add(toServer)
    const end = (): void => {
      client.destroy()
      toServer.destroy()
    }
    client.on('error', end).on('close', end)
    toServer.on('error', end).on('close', end)
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const text = head.toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      client.off('data', onData)
      const carries = text
        .split('\r\n')
        .slice(1)
        .some((line) => {
          const colon = line.indexOf(':')
          return (
            colon > 0 &&
            line.slice(0, colon).trim().toLowerCase() === header.toLowerCase() &&
            line.slice(colon + 1).trim() === value
          )
        })
      if (!carries) {
        refusals += 1
        toServer.off('close', end).destroy()
        client.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      sessions += 1
      toServer.write(head)
      client.pipe(toServer)
    }
    client.on('data', onData)
    toServer.pipe(client)
  })
  await new Promise<void>((ready) => proxy.listen(0, '127.0.0.1', () => ready()))
  const { port } = proxy.address() as AddressInfo
  return {
    wsEndpoint: `ws://127.0.0.1:${String(port)}${upstream.pathname}`,
    sessions: () => sessions,
    refusals: () => refusals,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((closed) => proxy.close(() => closed()))
      await server.close()
    },
  }
}

class FakeSocket {
  readyState = 1
  OPEN = 1
  readonly sent: Record<string, unknown>[] = []
  private handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  message(msg: object): void {
    for (const handler of this.handlers.get('message') ?? []) {
      void handler(Buffer.from(JSON.stringify(msg)))
    }
  }
}

describe('a live session on a remote that needs a declared secret', () => {
  let endpoint: HeaderGuardedEndpoint | undefined
  let session: LiveSession | undefined

  afterEach(async () => {
    await session?.cleanup().catch(() => undefined)
    session = undefined
    await endpoint?.close()
    endpoint = undefined
  })

  it('connects, keeps the secret from hooks and steps, and sends the page nothing that holds it', async () => {
    endpoint = await startHeaderGuardedEndpoint(['Authorization', `Bearer ${REMOTE_TOKEN}`])
    real.adapter = true
    const remote = remoteEntry(endpoint.wsEndpoint)
    session = new LiveSession('connection-secrets-remote')
    await session.initialize(
      sessionConfig(remote, {
        remote,
        setupHooks: [hook.id],
        resolvedHooks: new Map([[hook.id, hook]]),
      }),
    )
    expect(endpoint.sessions()).toBe(1)
    expect(endpoint.refusals()).toBe(0)

    const socket = new FakeSocket()
    createSessionHandler(session, () => undefined)(socket as never)
    socket.message({
      type: 'execute-step',
      stepInstruction: 'Type {{secret:REMOTE_TOKEN}} into the field',
      stepIndex: 0,
      draft: { testName: 'checkout' },
    })
    await vi.waitFor(() => {
      expect(socket.sent.filter((message) => message.type === 'step-complete')).toHaveLength(1)
    })
    socket.message({
      type: 'execute-step',
      stepInstruction: 'Type {{secret:LOGIN_PASSWORD}} into the password field',
      stepIndex: 1,
      draft: { testName: 'checkout' },
    })
    await vi.waitFor(() => {
      expect(socket.sent.filter((message) => message.type === 'step-complete')).toHaveLength(2)
    })

    const completes = socket.sent.filter((message) => message.type === 'step-complete')
    expect(completes.map((message) => message.result)).toMatchObject([
      { status: 'failed', error: misuseSentence },
      { status: 'passed' },
    ])
    const setupOptions = mockRunHooks.mock.calls[0]?.[1] as { secretStore?: SecretStore }
    expect(secretNames(setupOptions.secretStore)).toEqual(['LOGIN_PASSWORD'])
    const ports = mockExecuteStep.mock.calls[0]?.[1] as { secretStore?: SecretStore }
    expect(secretNames(ports.secretStore)).toEqual(['LOGIN_PASSWORD'])

    socket.message({ type: 'terminate-session' })
    await vi.waitFor(() => {
      expect(socket.sent.map((message) => message.type)).toContain('session-terminated')
    })
    const wire = JSON.stringify(socket.sent)
    expect(wire).not.toContain(REMOTE_TOKEN)
    expect(wire).not.toContain(encodeURIComponent(REMOTE_TOKEN))
  }, 60_000)
})
