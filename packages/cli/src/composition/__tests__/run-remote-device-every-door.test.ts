// The model is unreachable, so a run fails after its session opens; the fake Appium server's
// request log is what proves where the device session went. Every door gets its own fake and
// project, and AppiumManager is spied so a door that started or leased Appium would show it.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction } from '@vostride/agent-qa-agent'
import type { AndroidHere } from '@vostride/agent-qa-core'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { AppiumManager, DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
} from '../../commands/dashboard.js'
import { createMcpHttpRequestListener } from '../../commands/mcp.js'
import { createRunCommand } from '../../commands/run.js'
import { invokeViaDaemon } from '../../daemon/client.js'
import { runDaemonHost } from '../../daemon/host.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  LOCAL_DEVICE_MODEL,
  LOCAL_DEVICE_NAME,
  REMOTE_DEVICE_NAME,
  REMOTE_DEVICE_TARGET_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: {
    readonly requireHeader?: readonly [string, string]
  }) => Promise<FakeAppiumServer>
}

const RUN_BUDGET_MS = 180_000
const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_ID = /\br_[a-z]+(?:-[a-z]+)+/u
const REMOTE_INACTIVITY_MS = 30 * 60 * 1000
const FARM_TOKEN = 'farm-token-value-mark'
const MODEL = 'Samsung Galaxy S24'
const IPHONE_MODEL = 'iPhone 16'

// The phone this machine has in the cells that run here, so no cell runs adb.
const HERE: AndroidHere = {
  attached: [{ serial: '37121FDJH000', state: 'device', model: LOCAL_DEVICE_MODEL, os: '15' }],
  avds: [],
}

const opened: Array<() => Promise<void> | void> = []

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface DeviceScene {
  readonly project: InProcessFixture
  readonly server: FakeAppiumServer
  readonly printed: string[]
  readonly acquire: ReturnType<typeof vi.spyOn>
  readonly acquireLease: ReturnType<typeof vi.spyOn>
  readonly exit: ReturnType<typeof vi.spyOn>
}

async function onRemoteDevice(
  drive: (scene: DeviceScene) => Promise<void>,
  knobs: {
    readonly device?: Partial<NonNullable<InProcessFixtureInput['remoteDevice']>>
    readonly fixture?: Omit<InProcessFixtureInput, 'origin' | 'remoteDevice'>
  } = {},
): Promise<void> {
  const server = await startFakeAppiumServer({ requireHeader: ['x-farm-token', FARM_TOKEN] })
  opened.push(() => server.close())
  const project = createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: {
      url: server.url,
      headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
      model: MODEL,
      os: '14',
      ...knobs.device,
    },
    extraSecrets: { FARM_TOKEN },
    ...knobs.fixture,
  })
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const printed: string[] = []
  const keep = (...args: unknown[]): void => {
    printed.push(plain(args.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('fixture command exit')
  })
  const noLocalAppium = (): Promise<never> =>
    Promise.reject(new Error('a remote device starts no Appium here'))
  const acquire = vi.spyOn(AppiumManager.prototype, 'acquire').mockImplementation(noLocalAppium)
  const acquireLease = vi
    .spyOn(AppiumManager.prototype, 'acquireLease')
    .mockImplementation(noLocalAppium)
  await drive({ project, server, printed, acquire, acquireLease, exit })
}

async function runThroughCli(
  project: InProcessFixture,
  args: readonly string[],
  options: { readonly logLevel?: string; readonly here?: AndroidHere } = {},
): Promise<void> {
  const here = options.here
  const program = new Command()
    .option('--config <path>')
    .option('--log-level <level>')
    .addCommand(
      createRunCommand(here === undefined ? {} : { listDevicesHere: async () => here }),
    )
  await expect(
    program.parseAsync(
      [
        '--config',
        project.configPath,
        ...(options.logLevel === undefined ? [] : ['--log-level', options.logLevel]),
        'run',
        ...args,
      ],
      { from: 'user' },
    ),
  ).rejects.toThrow('fixture command exit')
}

function newSessionsOn(server: FakeAppiumServer): readonly FakeAppiumRequest[] {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === '/wd/hub/session',
  )
}

function storedRunners(project: InProcessFixture): unknown[] {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => run.attributes['agent-qa.runner'])
  } finally {
    db.close()
  }
}

function runsDbOf(project: InProcessFixture): string {
  return join(project.agentQaRoot, 'runs.db')
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

async function settledIn(db: DashboardDatabase, runId: string): Promise<void> {
  await waitFor(
    () => TERMINAL.includes(db.getRun(runId)?.status ?? ''),
    `run ${runId} never finished`,
  )
}

async function settledAt(project: InProcessFixture, runId: string): Promise<void> {
  const db = new DashboardDatabase({ dbPath: runsDbOf(project) })
  try {
    await settledIn(db, runId)
  } finally {
    db.close()
  }
}

// One session on the fake, asked with the resolved header and the model, and deleted after.
async function expectRanOnRemote(
  scene: DeviceScene,
  options: { readonly recordsRun: boolean } = { recordsRun: true },
): Promise<void> {
  const { project, server, acquire, acquireLease } = scene
  const log = scene.printed.join('\n')
  const newSessions = newSessionsOn(server)
  expect(newSessions, log).toHaveLength(1)
  expect(newSessions[0]?.headers['x-farm-token'], log).toBe(FARM_TOKEN)
  const body = newSessions[0]?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } }
  expect(body.capabilities?.alwaysMatch?.['appium:deviceName'], log).toBe(MODEL)
  expect(server.sessionsCreated(), log).toHaveLength(1)
  await waitFor(
    () => server.sessionsDeleted().length > 0,
    `the remote session was never deleted\n${log}`,
  )
  expect(server.sessionsDeleted(), log).toEqual(server.sessionsCreated())
  if (options.recordsRun) {
    expect(new Set(storedRunners(project)), log).toEqual(new Set(['remote']))
  }
  expect(acquire).not.toHaveBeenCalled()
  expect(acquireLease).not.toHaveBeenCalled()
  expect(log).not.toContain(FARM_TOKEN)
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  opened.push(() => new Promise<void>((closed) => server.close(() => closed())))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
}

async function startOverMcp(url: string, pattern: string): Promise<string> {
  const client = new Client({ name: 'agent-qa-remote-device-door', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    const result = (await client.callTool(
      { name: 'agent_qa_start_run', arguments: { patterns: [pattern] } },
      { timeout: RUN_BUDGET_MS },
    )) as {
      content?: ReadonlyArray<{ text?: string }>
      structuredContent?: { runId?: unknown }
      isError?: boolean
    }
    const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n')
    expect(result.isError === true, `agent_qa_start_run refused: ${text}`).toBe(false)
    const structured = result.structuredContent?.runId
    const runId = typeof structured === 'string' ? structured : text.match(RUN_ID)?.[0]
    expect(typeof runId, `agent_qa_start_run answered no run id: ${text}`).toBe('string')
    return runId!
  } finally {
    await client.close().catch(() => undefined)
  }
}

interface DashboardScene {
  readonly origin: string
  readonly db: DashboardDatabase
  readonly settled: string[]
}

async function openDashboard(project: InProcessFixture): Promise<DashboardScene> {
  const db = new DashboardDatabase({
    dbPath: runsDbOf(project),
    runOwnership: composeRunOwnership(),
  })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined
  const door = composeDashboardDoor({
    agentQaRoot: project.agentQaRoot,
    configPath: project.configPath,
    boundOrigin: () => boundOrigin,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(door.host)
  const runService = composeRunServicePorts({ door: runDoor })
  const settled: string[] = []
  runDoor.backend.on('run-settled', (runId: string) => {
    settled.push(runId)
  })
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath: project.configPath,
    workspacePaths: resolveWorkspacePaths({
      config: parseYaml(readFileSync(project.configPath, 'utf8')) as never,
      configPath: project.configPath,
    }),
    executionBackend: runDoor.backend,
    agentHost: door.agentHost,
    runService: runService.ports,
    runServiceReadiness: runService.readiness,
  })
  const address = started.server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('the dashboard bound no port')
  }
  boundOrigin = `http://127.0.0.1:${String(address.port)}`
  opened.push(async () => {
    started.close()
    runService.dispose()
    await door.host.close()
    db.close()
  })
  return { origin: boundOrigin, db, settled }
}

async function postJson(
  dashboard: DashboardScene,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${dashboard.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  expect(response.status, `${path} answered ${String(response.status)}: ${text}`).toBeLessThan(300)
  return JSON.parse(text) as Record<string, unknown>
}

const DAEMON_MODEL: JobModelCapability = {
  modelId: 'test:remote-device-every-door',
  generate: () => Promise.resolve({ text: 'unused' }),
}

async function startThroughDaemon(scene: DeviceScene): Promise<string> {
  const { project } = scene
  const signals = new Map<NodeJS.Signals, () => void>()
  let started = false
  const running = runDaemonHost({
    agentQaRoot: project.agentQaRoot,
    knowledgeRoot: join(project.project, 'agent-qa-knowledge'),
    configPath: project.configPath,
    config: {
      getMasked: () =>
        Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: project.configPath,
          entries: [],
        }),
    },
    model: () => DAEMON_MODEL,
    operations: {
      setInterval: (_callback, intervalMs) =>
        intervalMs as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      onSignal: (signal, listener) => signals.set(signal, listener),
      offSignal: (signal, listener) => {
        if (signals.get(signal) === listener) signals.delete(signal)
      },
      hardExit: (code) => {
        throw new Error(`unexpected daemon hard exit ${String(code)}`)
      },
    },
    logger: {
      info: () => {
        started = true
      },
      error: (message) => {
        scene.printed.push(message)
      },
    },
  })
  try {
    await waitFor(() => started, 'the daemon did not finish starting')
    const ack = (await invokeViaDaemon({
      agentQaRoot: project.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [project.testPattern] },
    })) as RunStartAcknowledgement
    return ack.runId
  } finally {
    const stop = signals.get('SIGTERM')
    if (stop === undefined) throw new Error('the daemon installed no SIGTERM listener')
    stop()
    await running
  }
}

describe('a test on a remote device runs there from every door', () => {
  it(
    'agent-qa run opens the session on the remote with its resolved header, records the run remote and starts no Appium',
    async () => {
      await onRemoteDevice(async ({ project, server, printed, acquire, acquireLease }) => {
        await runThroughCli(project, [project.testPattern])

        const log = printed.join('\n')
        const newSessions = server.requests.filter(
          (request) => request.method === 'POST' && request.path === '/wd/hub/session',
        )
        expect(newSessions, log).toHaveLength(1)
        const [newSession] = newSessions
        expect(newSession?.headers['x-farm-token']).toBe(FARM_TOKEN)
        const body = newSession?.body as {
          capabilities?: { alwaysMatch?: Record<string, unknown> }
        }
        expect(body.capabilities?.alwaysMatch?.['appium:deviceName']).toBe(MODEL)

        const [sessionId] = server.sessionsCreated()
        expect(sessionId, log).toBeDefined()
        expect(
          server.requests.some(
            (request) =>
              request.method === 'DELETE' &&
              request.path === `/wd/hub/session/${String(sessionId)}`,
          ),
          log,
        ).toBe(true)

        const runners = storedRunners(project)
        expect(runners.length, log).toBeGreaterThan(0)
        expect(new Set(runners), log).toEqual(new Set(['remote']))

        expect(acquire).not.toHaveBeenCalled()
        expect(acquireLease).not.toHaveBeenCalled()
        expect(log).not.toContain(FARM_TOKEN)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'agent-qa run opens one session for an iOS device on the remote, asking for no simulator log',
    async () => {
      await onRemoteDevice(
        async ({ project, server, printed, acquire, acquireLease }) => {
          await runThroughCli(project, [project.testPattern])

          const log = printed.join('\n')
          const newSessions = newSessionsOn(server)
          expect(newSessions, log).toHaveLength(1)
          const body = newSessions[0]?.body as {
            capabilities?: { alwaysMatch?: Record<string, unknown> }
          }
          const asked = body.capabilities?.alwaysMatch ?? {}
          expect(asked.platformName, log).toBe('iOS')
          expect(asked['appium:deviceName'], log).toBe(IPHONE_MODEL)
          expect(asked, log).not.toHaveProperty('appium:showIOSLog')
          expect(newSessions[0]?.headers['x-farm-token'], log).toBe(FARM_TOKEN)
          expect(server.sessionsDeleted(), log).toEqual(server.sessionsCreated())
          expect(new Set(storedRunners(project)), log).toEqual(new Set(['remote']))
          expect(acquire).not.toHaveBeenCalled()
          expect(acquireLease).not.toHaveBeenCalled()
        },
        { device: { platform: 'ios', model: IPHONE_MODEL, os: '18.2' } },
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    'a debug run on a device here stays silent when the config lists a remote device, and a remote run after it still opens',
    async () => {
      await onRemoteDevice(
        async ({ project, server, printed }) => {
          const here = await startFakeAppiumServer()
          opened.push(() => here.close())
          vi.stubEnv('AGENT_QA_APPIUM_URL', here.url)
          vi.stubEnv('WDIO_LOG_LEVEL', undefined)
          const wdioLines: string[] = []
          const keepWdio = (...args: unknown[]): void => {
            wdioLines.push(plain(args.map(String).join(' ')))
          }
          vi.spyOn(console, 'info').mockImplementation(keepWdio)
          vi.spyOn(console, 'debug').mockImplementation(keepWdio)
          vi.spyOn(console, 'trace').mockImplementation(keepWdio)

          await runThroughCli(project, [project.testPattern, '--device', LOCAL_DEVICE_NAME], {
            logLevel: 'debug',
            here: HERE,
          })

          const log = printed.join('\n')
          expect(newSessionsOn(here), log).toHaveLength(1)
          expect(process.env.WDIO_LOG_LEVEL ?? 'silent', log).toBe('silent')
          const webdriverLine = /\b(?:webdriver|webdriverio|devtools):/
          expect([...printed, ...wdioLines].filter((line) => webdriverLine.test(line))).toEqual([])

          await runThroughCli(project, [project.testPattern])

          expect(newSessionsOn(server), printed.join('\n')).toHaveLength(1)
        },
        { fixture: { localDevice: true } },
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    "agent-qa run refuses a remote device whose capabilities need an undeclared secret before the run is recorded",
    async () => {
      await onRemoteDevice(
        async ({ project, server, printed, acquire, acquireLease, exit }) => {
          await runThroughCli(project, [project.testPattern])

          const log = printed.join('\n')
          const { port } = new URL(server.url)
          expect(exit.mock.calls.at(-1)?.[0], log).toBe(2)
          expect(
            printed.filter((line) =>
              line.includes(
                `Device galaxy-farm on remote farm (appium http://127.0.0.1:${port}) needs FARM_KEY, which .env.secrets.local does not declare. Add it there.`,
              ),
            ),
            log,
          ).toHaveLength(1)
          expect(server.requests, log).toEqual([])
          expect(storedRunners(project), log).toEqual([])
          expect(acquire).not.toHaveBeenCalled()
          expect(acquireLease).not.toHaveBeenCalled()
        },
        { device: { capabilities: { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } } } },
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    'a queued dashboard run opens the session on the remote and leases no Appium',
    async () => {
      await onRemoteDevice(async (scene) => {
        const dashboard = await openDashboard(scene.project)
        const runId = (
          await postJson(dashboard, '/api/runs/trigger', { file: scene.project.testPattern })
        )['runId']
        expect(typeof runId, 'the trigger route answered no run id').toBe('string')
        await waitFor(
          () => dashboard.settled.includes(runId as string),
          `queued run ${String(runId)} never settled`,
        )

        await expectRanOnRemote(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'agent_qa_start_run over MCP opens the session on the remote and starts no Appium',
    async () => {
      await onRemoteDevice(async (scene) => {
        const host = composeCliLocalAgent({
          agentQaRoot: scene.project.agentQaRoot,
          configPath: scene.project.configPath,
          runTrigger: 'mcp',
        })
        opened.push(() => host.close())
        const url = await listen(
          createMcpHttpRequestListener({
            registry: host.registry as FunctionRegistry,
            maskText: (text) => text,
          }),
        )
        const runId = await startOverMcp(url, scene.project.testPattern)
        await settledAt(scene.project, runId)

        await expectRanOnRemote(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'fn opens the session on the remote and starts no Appium',
    async () => {
      await onRemoteDevice(async (scene) => {
        const host = composeCliLocalAgent({
          agentQaRoot: scene.project.agentQaRoot,
          configPath: scene.project.configPath,
        })
        opened.push(() => host.close())
        const ack = (await invokeFunction(
          host.registry,
          'runs.start',
          { patterns: [scene.project.testPattern] },
          CLI_FUNCTION_CALLER,
        )) as RunStartAcknowledgement
        await settledAt(scene.project, ack.runId)

        await expectRanOnRemote(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'the daemon opens the session on the remote and starts no Appium',
    async () => {
      await onRemoteDevice(async (scene) => {
        const runId = await startThroughDaemon(scene)
        await settledAt(scene.project, runId)

        await expectRanOnRemote(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'the live editor opens its device session on the remote, arms the inactivity window and deletes the session when it ends',
    async () => {
      await onRemoteDevice(async (scene) => {
        const dashboard = await openDashboard(scene.project)
        const timers = vi.spyOn(globalThis, 'setTimeout')
        const endSession = (path: string): Promise<Response> =>
          fetch(`${dashboard.origin}${path}`, { method: 'DELETE' })
        let sessionPath: string | undefined
        opened.push(async () => {
          if (sessionPath !== undefined) await endSession(sessionPath).catch(() => undefined)
        })
        const sessionId = (
          await postJson(dashboard, '/api/live-editor/sessions', {
            platform: 'android',
            targetName: REMOTE_DEVICE_TARGET_NAME,
            useDeviceName: REMOTE_DEVICE_NAME,
          })
        )['sessionId']
        expect(typeof sessionId, 'the live editor answered no session id').toBe('string')
        sessionPath = `/api/live-editor/sessions/${sessionId as string}`
        expect(
          timers.mock.calls.filter(([, delay]) => delay === REMOTE_INACTIVITY_MS),
          scene.printed.join('\n'),
        ).toHaveLength(1)
        expect(scene.server.sessionsDeleted()).toEqual([])

        const ended = await endSession(sessionPath)
        expect(ended.status, await ended.text()).toBeLessThan(300)
        sessionPath = undefined

        await expectRanOnRemote(scene, { recordsRun: false })
      })
    },
    RUN_BUDGET_MS,
  )
})
