// Every door runs a test on a device whose remote names a path plugins entry. The plugin answers
// acquire with the fake Appium server, whose request log proves where the device session went,
// and its ledger shows what the door's plugin host asked of it. The model is unreachable, so a run
// fails after its session opens. AppiumManager is spied so a door that started or leased Appium
// would show it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { AppiumManager, DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
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
  REMOTE_DEVICE_NAME,
  REMOTE_DEVICE_REMOTE_NAME,
  REMOTE_DEVICE_TARGET_NAME,
  REMOTE_IOS_DEVICE_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: {
    readonly status?: { readonly version?: string }
  }) => Promise<FakeAppiumServer>
}

const RUN_BUDGET_MS = 180_000
const PLUGIN_EXIT_BUDGET_MS = 20_000
const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_ID = /\br_[a-z]+(?:-[a-z]+)+/u
const ENTRY_NAME = 'farm-lab'
const MODEL = 'Samsung Galaxy S24'
const IPHONE_MODEL = 'iPhone 16'
const SESSION_APPIUM_VERSION = '3.2.0'
const HUB_APPIUM_VERSION = '2.45.0'
// A run marks its session before releasing it; the live editor's session ends unmarked.
const MARKED_ONCE = ['initialize', 'acquire', 'started', 'end', 'release', 'shutdown']
const LEASED_ONCE = ['initialize', 'acquire', 'started', 'release', 'shutdown']

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

interface LedgerLine {
  readonly method: string
  readonly pid?: number
  readonly sessionId?: string
}

interface DeviceScene {
  readonly project: InProcessFixture
  readonly server: FakeAppiumServer
  readonly ledgerFile: string
  readonly printed: string[]
  readonly ensureRunning: MockInstance
  readonly acquireLease: MockInstance
}

// The fixture's url remote becomes a remote that names a path plugins entry, which answers with
// the fake server.
function placeOnPlugin(
  project: InProcessFixture,
  server: FakeAppiumServer,
  remoteCapabilities?: Record<string, unknown>,
): string {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), {
    serves: ['appium'],
    methods: ['started', 'end'],
  })
  const ledgerFile = join(project.project, 'plugin-ledger.jsonl')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [
    {
      name: REMOTE_DEVICE_REMOTE_NAME,
      plugin: ENTRY_NAME,
      ...(remoteCapabilities === undefined ? {} : { capabilities: remoteCapabilities }),
    },
  ]
  config.plugins = [
    {
      name: ENTRY_NAME,
      path: `./tools/${ENTRY_NAME}`,
      options: {
        answer: { protocol: 'appium', url: server.url },
        started: { appiumVersion: SESSION_APPIUM_VERSION },
        ledgerFile,
        recordProcess: true,
        recordParams: true,
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
  return ledgerFile
}

async function onPluginDevice(
  drive: (scene: DeviceScene) => Promise<void>,
  device: Partial<NonNullable<InProcessFixtureInput['remoteDevice']>> = {},
  remoteCapabilities?: Record<string, unknown>,
): Promise<void> {
  const server = await startFakeAppiumServer({ status: { version: HUB_APPIUM_VERSION } })
  opened.push(() => server.close())
  const project = createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: { url: server.url, model: MODEL, os: '14', ...device },
  })
  const ledgerFile = placeOnPlugin(project, server, remoteCapabilities)
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const printed: string[] = []
  const keep = (...args: unknown[]): void => {
    printed.push(plain(args.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('fixture command exit')
  })
  const noLocalAppium = (): Promise<never> =>
    Promise.reject(new Error('a device on a plugin remote starts no Appium here'))
  const ensureRunning = vi
    .spyOn(AppiumManager.prototype, 'ensureRunning')
    .mockImplementation(noLocalAppium)
  const acquireLease = vi
    .spyOn(AppiumManager.prototype, 'acquireLease')
    .mockImplementation(noLocalAppium)
  try {
    await drive({ project, server, ledgerFile, printed, ensureRunning, acquireLease })
  } finally {
    for (const close of opened.splice(0).reverse()) await close()
  }
}

function ledgerOf(scene: DeviceScene): LedgerLine[] {
  if (!existsSync(scene.ledgerFile)) return []
  return readFileSync(scene.ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerLine)
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  budgetMs = RUN_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

function runsDbOf(project: InProcessFixture): string {
  return join(project.agentQaRoot, 'runs.db')
}

function storedRuns(
  project: InProcessFixture,
): Array<{ runner: unknown; place: Record<string, unknown> | undefined }> {
  const db = new DashboardDatabase({ dbPath: runsDbOf(project) })
  try {
    return db.getRuns({}).map((run) => {
      const payload = db.getRunArtifact(run.id)?.payload as
        | { config?: { runtime?: { place?: Record<string, unknown> } } }
        | undefined
      return { runner: run.attributes['agent-qa.runner'], place: payload?.config?.runtime?.place }
    })
  } finally {
    db.close()
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

// The plugin process may outlive the run's terminal row by its host's shutdown, so both are
// awaited.
async function expectPluginWentAway(scene: DeviceScene): Promise<void> {
  const log = (): string => `${JSON.stringify(ledgerOf(scene))}\n${scene.printed.join('\n')}`
  await waitFor(
    () => ledgerOf(scene).at(-1)?.method === 'shutdown',
    `the plugin was never shut down: ${log()}`,
    PLUGIN_EXIT_BUDGET_MS,
  )
  const pid = ledgerOf(scene).find((line) => line.method === 'initialize')?.pid
  expect(typeof pid, log()).toBe('number')
  await waitFor(
    () => !running(pid!),
    `the plugin process ${String(pid)} is still running`,
    PLUGIN_EXIT_BUDGET_MS,
  )
}

// One session on the answered server, told to the plugin, deleted, and its lease released.
async function expectRanOnPlugin(
  scene: DeviceScene,
  options: { readonly ledger: readonly string[]; readonly recordsRun: boolean } = {
    ledger: MARKED_ONCE,
    recordsRun: true,
  },
): Promise<void> {
  const { project, server, ensureRunning, acquireLease } = scene
  await expectPluginWentAway(scene)
  const log = `${JSON.stringify(ledgerOf(scene))}\n${scene.printed.join('\n')}`
  const newSessions = server.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/session'),
  )
  expect(newSessions, log).toHaveLength(1)
  const [sessionId] = server.sessionsCreated()
  expect(sessionId, log).toBeDefined()
  expect(server.sessionsDeleted(), log).toEqual(server.sessionsCreated())
  const ledger = ledgerOf(scene)
  expect(
    ledger.map((line) => line.method),
    log,
  ).toEqual(options.ledger)
  expect(ledger.find((line) => line.method === 'started')?.sessionId, log).toBe(sessionId)
  if (options.recordsRun) {
    expect(
      storedRuns(project).map((run) => run.runner),
      log,
    ).toEqual(['remote'])
  }
  expect(server.requests.some((request) => request.path.endsWith('/status')), log).toBe(false)
  expect(ensureRunning).not.toHaveBeenCalled()
  expect(acquireLease).not.toHaveBeenCalled()
}

function alwaysMatchOf(server: FakeAppiumServer): Record<string, unknown> {
  const [newSession] = server.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/session'),
  )
  const body = newSession?.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } }
  return body.capabilities?.alwaysMatch ?? {}
}

async function runThroughCli(project: InProcessFixture): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', project.configPath, 'run', project.testPattern], {
      from: 'user',
    }),
  ).rejects.toThrow('fixture command exit')
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  opened.push(() => new Promise<void>((closed) => server.close(() => closed())))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
}

async function startOverMcp(url: string, pattern: string): Promise<string> {
  const client = new Client({ name: 'agent-qa-plugin-device-door', version: '0.0.0' })
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
  return { origin: boundOrigin, settled }
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
  modelId: 'test:plugin-device-every-door',
  generate: () => Promise.resolve({ text: 'unused' }),
}

async function startThroughDaemon(scene: DeviceScene): Promise<string> {
  const { project } = scene
  const signals = new Map<NodeJS.Signals, () => void>()
  let started = false
  const daemon = runDaemonHost({
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
    await settledAt(project, ack.runId)
    return ack.runId
  } finally {
    const stop = signals.get('SIGTERM')
    if (stop === undefined) throw new Error('the daemon installed no SIGTERM listener')
    stop()
    await daemon
  }
}

describe('a test on a device on a plugin remote runs there from every door', () => {
  it(
    "agent-qa run opens an Android device's session on the plugin's answer, records the session's Appium version and starts no Appium",
    async () => {
      await onPluginDevice(async (scene) => {
        await runThroughCli(scene.project)

        await expectRanOnPlugin(scene)
        const asked = alwaysMatchOf(scene.server)
        expect(asked.platformName).toBe('Android')
        expect(asked['appium:deviceName']).toBe(MODEL)
        const [run] = storedRuns(scene.project)
        expect(run?.place, scene.printed.join('\n')).toMatchObject({
          place: 'remote',
          name: REMOTE_DEVICE_REMOTE_NAME,
          device: REMOTE_DEVICE_NAME,
          appiumVersion: SESSION_APPIUM_VERSION,
          plugin: { entry: ENTRY_NAME },
        })
        expect(JSON.stringify(run?.place)).not.toContain(HUB_APPIUM_VERSION)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    "agent-qa run opens an iOS device's session on the plugin's answer and starts no Appium",
    async () => {
      await onPluginDevice(
        async (scene) => {
          await runThroughCli(scene.project)

          await expectRanOnPlugin(scene)
          const asked = alwaysMatchOf(scene.server)
          expect(asked.platformName).toBe('iOS')
          expect(asked['appium:deviceName']).toBe(IPHONE_MODEL)
          expect(asked).not.toHaveProperty('appium:showIOSLog')
          const [run] = storedRuns(scene.project)
          expect(run?.place, scene.printed.join('\n')).toMatchObject({
            device: REMOTE_IOS_DEVICE_NAME,
            appiumVersion: SESSION_APPIUM_VERSION,
            plugin: { entry: ENTRY_NAME },
          })
        },
        { platform: 'ios', model: IPHONE_MODEL, os: '18.2' },
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    "a queued dashboard run opens the session on the plugin's answer and leases no Appium",
    async () => {
      await onPluginDevice(async (scene) => {
        const dashboard = await openDashboard(scene.project)
        const runId = (
          await postJson(dashboard, '/api/runs/trigger', { file: scene.project.testPattern })
        )['runId']
        expect(typeof runId, 'the trigger route answered no run id').toBe('string')
        await waitFor(
          () => dashboard.settled.includes(runId as string),
          `queued run ${String(runId)} never settled`,
        )

        await expectRanOnPlugin(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    "agent_qa_start_run over MCP opens the session on the plugin's answer and starts no Appium",
    async () => {
      await onPluginDevice(async (scene) => {
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

        await expectRanOnPlugin(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    "fn opens the session on the plugin's answer and starts no Appium",
    async () => {
      await onPluginDevice(async (scene) => {
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

        await expectRanOnPlugin(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    "the daemon opens the session on the plugin's answer and starts no Appium",
    async () => {
      await onPluginDevice(async (scene) => {
        await startThroughDaemon(scene)

        await expectRanOnPlugin(scene)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    "the live editor opens its device session on the plugin's answer, starts no Appium and returns the lease when it ends",
    async () => {
      await onPluginDevice(async (scene) => {
        const dashboard = await openDashboard(scene.project)
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
        expect(ledgerOf(scene).map((line) => line.method)).toEqual([
          'initialize',
          'acquire',
          'started',
        ])
        expect(scene.server.sessionsDeleted()).toEqual([])

        const ended = await endSession(sessionPath)
        expect(ended.status, await ended.text()).toBeLessThan(300)
        sessionPath = undefined

        await expectRanOnPlugin(scene, { ledger: LEASED_ONCE, recordsRun: false })
      })
    },
    RUN_BUDGET_MS,
  )

  it.each([
    [
      "its remote's capabilities",
      'FARM_KEY',
      {},
      { 'farm:options': { accessKey: '{{secret:FARM_KEY}}' } },
    ],
    [
      "its target's app.ref",
      'SHOP_BUILD_REF',
      { appRef: 'farm://{{secret:SHOP_BUILD_REF}}' },
      undefined,
    ],
  ] as const)(
    'agent-qa run refuses a device on a plugin remote with an undeclared secret in %s, before the plugin is asked for a session',
    async (_what, secret, device, remoteCapabilities) => {
      await onPluginDevice(
        async (scene) => {
          await runThroughCli(scene.project)

          const log = scene.printed.join('\n')
          expect(
            scene.printed.filter((line) =>
              line.includes(
                `Device ${REMOTE_DEVICE_NAME} on remote ${REMOTE_DEVICE_REMOTE_NAME} (plugin ${ENTRY_NAME}) needs ${secret}, which .env.secrets.local does not declare. Add it there.`,
              ),
            ),
            log,
          ).toHaveLength(1)
          expect(ledgerOf(scene).map((line) => line.method), log).not.toContain('acquire')
          expect(scene.server.requests, log).toEqual([])
          expect(storedRuns(scene.project), log).toEqual([])
        },
        device,
        remoteCapabilities,
      )
    },
    RUN_BUDGET_MS,
  )
})
