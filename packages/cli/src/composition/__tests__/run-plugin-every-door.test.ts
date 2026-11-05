// Every door runs a web test on a remote that names a path plugins entry. The plugin answers
// acquire with a loopback Playwright server, and its ledger shows what the door's plugin host
// asked of it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Command } from 'commander'
import { chromium } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
  mountCoHostedMcp,
} from '../../commands/dashboard.js'
import { createMcpHttpRequestListener } from '../../commands/mcp.js'
import { createRunCommand } from '../../commands/run.js'
import { invokeViaDaemon } from '../../daemon/client.js'
import { runDaemonHost } from '../../daemon/host.js'
import {
  POPULATED_MODEL_ID,
  POPULATED_PASSING_STEP_TEXT,
  startStubModelServer,
  startTargetPageServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const PLUGIN_EXIT_BUDGET_MS = 20_000
const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_ID = /\br_[a-z]+(?:-[a-z]+)+/u
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
// A run marks its session before releasing it; the live editor's session ends unmarked.
const MARKED_ONCE = ['initialize', 'acquire', 'end', 'release', 'shutdown']
const LEASED_ONCE = ['initialize', 'acquire', 'release', 'shutdown']

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

interface LedgerLine {
  readonly method: string
  readonly pid?: number
  readonly outcome?: string
}

interface PluginScene {
  readonly project: InProcessFixture
  readonly endpoint: RemoteBrowserEndpoint
  readonly targetOrigin: string
  readonly ledgerFile: string
  readonly printed: string[]
  readonly exit: MockInstance
  readonly launch: MockInstance
}

// The fixture's url remote becomes a remote that names a path plugins entry under the same pick.
function placeOnPlugin(project: InProcessFixture, wsEndpoint: string): string {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), { methods: ['end'] })
  const ledgerFile = join(project.project, 'plugin-ledger.jsonl')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [
    {
      name: ENTRY_NAME,
      path: `./tools/${ENTRY_NAME}`,
      options: {
        answer: { protocol: 'playwright', url: wsEndpoint },
        ledgerFile,
        recordProcess: true,
        recordParams: true,
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
  return ledgerFile
}

function ledgerOf(scene: PluginScene): LedgerLine[] {
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

// Every door gets its own page, model, Playwright server, plugin and project.
async function onPluginRemote(
  knobs: Partial<InProcessFixtureInput>,
  drive: (scene: PluginScene) => Promise<void>,
): Promise<void> {
  refuseWithoutChromium()
  const page = await startTargetPageServer()
  const model = await startStubModelServer()
  const endpoint = await startRemoteBrowserEndpoint()
  try {
    const project = createInProcessFixture({
      origin: page.url,
      environment: 'local',
      stepText: POPULATED_PASSING_STEP_TEXT,
      model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
      remote: { name: REMOTE_NAME, protocol: 'playwright', url: endpoint.wsEndpoint },
      ...knobs,
    })
    const ledgerFile = placeOnPlugin(project, endpoint.wsEndpoint)
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
    const launch = vi.spyOn(chromium, 'launch')
    try {
      await drive({ project, endpoint, targetOrigin: page.url, ledgerFile, printed, exit, launch })
    } finally {
      for (const close of opened.splice(0).reverse()) await close()
    }
  } finally {
    await endpoint.close()
    await model.close()
    await page.close()
  }
}

function storedRuns(project: InProcessFixture): Array<{ runner: unknown; outcomes: unknown[] }> {
  const db = new DashboardDatabase({ dbPath: runsDbOf(project) })
  try {
    return db.getRuns({}).map((run) => ({
      runner: run.attributes['agent-qa.runner'],
      outcomes: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => member.outcome),
    }))
  } finally {
    db.close()
  }
}

// The plugin process may outlive the run's terminal row by its host's shutdown, so both are
// awaited.
async function expectPluginWentAway(scene: PluginScene): Promise<void> {
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

async function expectPassedOnPlugin(scene: PluginScene, members = 1): Promise<void> {
  await expectPluginWentAway(scene)
  const log = scene.printed.join('\n')
  expect(storedRuns(scene.project), log).toEqual([
    { runner: 'remote', outcomes: Array.from({ length: members }, () => 'passed') },
  ])
  expect(scene.endpoint.sessions(), log).toBe(1)
  expect(scene.launch, log).not.toHaveBeenCalled()
  expect(
    ledgerOf(scene).map((line) => line.method),
    log,
  ).toEqual(MARKED_ONCE)
  expect(ledgerOf(scene).find((line) => line.method === 'end')?.outcome, log).toBe('passed')
}

async function runThroughCli(scene: PluginScene, pattern: string): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', scene.project.configPath, 'run', pattern], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
  expect(scene.exit.mock.calls[0]?.[0], scene.printed.join('\n')).toBe(0)
}

function runsDbOf(project: InProcessFixture): string {
  return join(project.agentQaRoot, 'runs.db')
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

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  opened.push(() => new Promise<void>((closed) => server.close(() => closed())))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
}

async function startOverMcp(url: string, pattern: string): Promise<string> {
  const client = new Client({ name: 'agent-qa-plugin-door', version: '0.0.0' })
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
  readonly registry: FunctionRegistry
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
  return { origin: boundOrigin, db, registry: door.host.registry as FunctionRegistry, settled }
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
  modelId: 'test:plugin-every-door',
  generate: () => Promise.resolve({ text: 'unused' }),
}

async function startThroughDaemon(scene: PluginScene): Promise<string> {
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

describe('a web test on a plugin remote runs there from every door', () => {
  it('agent-qa run runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern)

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it("agent-qa run runs a suite's two members on one lease of one session", async () => {
    await onPluginRemote({ secondSuiteMember: true }, async (scene) => {
      await runThroughCli(scene, scene.project.suitePattern)

      await expectPassedOnPlugin(scene, 2)
    })
  }, RUN_BUDGET_MS)

  it('fn runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
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

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it('the standalone MCP host runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
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

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it('the co-hosted MCP endpoint runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const mount = await mountCoHostedMcp({
        server: createServer(
          createMcpHttpRequestListener({
            registry: dashboard.registry,
            maskText: (text) => text,
            liveLink: { dashboardBaseUrl: () => dashboard.origin },
          }),
        ),
        port: 0,
        warn: () => undefined,
      })
      const server = mount.server
      expect(server, mount.warning ?? 'the co-hosted MCP endpoint did not mount').toBeDefined()
      opened.push(() => new Promise<void>((closed) => server!.close(() => closed())))
      const runId = await startOverMcp(
        `http://127.0.0.1:${String(mount.boundPort)}/mcp`,
        scene.project.testPattern,
      )
      await settledIn(dashboard.db, runId)

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it('POST /run runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const runId = (await postJson(dashboard, '/run', { patterns: [scene.project.testPattern] }))[
        'runId'
      ]
      expect(typeof runId, 'POST /run answered no run id').toBe('string')
      await settledIn(dashboard.db, runId as string)

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it('a queued dashboard run runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const runId = (
        await postJson(dashboard, '/api/runs/trigger', { file: scene.project.testPattern })
      )['runId']
      expect(typeof runId, 'the trigger route answered no run id').toBe('string')
      await waitFor(
        () => dashboard.settled.includes(runId as string),
        `queued run ${String(runId)} never settled`,
      )

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)

  it('the live editor opens a session on the plugin lease and returns it at its end', async () => {
    await onPluginRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const endSession = (path: string): Promise<Response> =>
        fetch(`${dashboard.origin}${path}`, { method: 'DELETE' })
      let sessionPath: string | undefined
      opened.push(async () => {
        if (sessionPath !== undefined) await endSession(sessionPath).catch(() => undefined)
      })
      const sessionId = (
        await postJson(dashboard, '/api/live-editor/sessions', {
          platform: 'web',
          targetName: scene.project.targetName,
          url: `${scene.targetOrigin}/in-process-thing`,
          headless: true,
        })
      )['sessionId']
      expect(typeof sessionId, 'the live editor answered no session id').toBe('string')
      sessionPath = `/api/live-editor/sessions/${sessionId as string}`
      expect(ledgerOf(scene).map((line) => line.method)).toEqual(['initialize', 'acquire'])
      const ended = await endSession(sessionPath)
      expect(ended.status, await ended.text()).toBeLessThan(300)
      sessionPath = undefined

      await expectPluginWentAway(scene)
      const log = scene.printed.join('\n')
      expect(scene.endpoint.sessions(), log).toBe(1)
      expect(scene.launch, log).not.toHaveBeenCalled()
      expect(
        ledgerOf(scene).map((line) => line.method),
        log,
      ).toEqual(LEASED_ONCE)
    })
  }, RUN_BUDGET_MS)

  it('the daemon runs a direct test on the session the plugin leased', async () => {
    await onPluginRemote({}, async (scene) => {
      await startThroughDaemon(scene)

      await expectPassedOnPlugin(scene)
    })
  }, RUN_BUDGET_MS)
})
