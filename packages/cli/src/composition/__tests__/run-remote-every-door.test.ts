// `fetch` to the target is refused, so every hit the target counts came from the remote browser. A
// member on a remote gets no baseline probe from this machine at all.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Command } from 'commander'
import { chromium } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
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
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  CountingTarget,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_ID = /\br_[a-z]+(?:-[a-z]+)+/u

const opened: Array<() => Promise<void> | void> = []

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
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

function urlOf(input: unknown): string {
  return input instanceof Request ? input.url : String(input)
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

interface RemoteScene {
  readonly project: InProcessFixture
  readonly endpoint: RemoteBrowserEndpoint
  readonly target: CountingTarget
  readonly printed: string[]
  readonly stderr: string[]
  readonly exit: MockInstance
  readonly fetched: MockInstance<typeof fetch>
  readonly launch: MockInstance
}

// Every door gets its own target, Playwright server and project whose config names that server.
async function onRemote(
  knobs: Partial<InProcessFixtureInput>,
  drive: (scene: RemoteScene) => Promise<void>,
): Promise<void> {
  refuseWithoutChromium()
  const target = new CountingTarget()
  await target.listen()
  try {
    const endpoint = await startRemoteBrowserEndpoint()
    try {
      const project = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
        ...knobs,
      })
      vi.stubEnv('HOME', freshUpdateCheckHome())
      const printed: string[] = []
      const stderr: string[] = []
      const keep = (...args: unknown[]): void => { printed.push(plain(args.map(String).join(' '))) }
      vi.spyOn(console, 'log').mockImplementation(keep)
      vi.spyOn(console, 'warn').mockImplementation(keep)
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        keep(...args)
        stderr.push(...plain(args.map(String).join(' ')).split('\n'))
      })
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('fixture command exit')
      })
      const realFetch = globalThis.fetch.bind(globalThis)
      const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
        urlOf(input).startsWith(target.origin)
          ? Promise.reject(new Error('only the remote browser reaches the target'))
          : realFetch(input, init),
      )
      const launch = vi.spyOn(chromium, 'launch')
      try {
        await drive({ project, endpoint, target, printed, stderr, exit, fetched, launch })
      } finally {
        for (const close of opened.splice(0).reverse()) await close()
      }
    } finally {
      await endpoint.close()
    }
  } finally {
    await target.close()
  }
}

function expectReachedRemote(scene: RemoteScene): void {
  const log = scene.printed.join('\n')
  expect(scene.endpoint.sessions(), log).toBe(1)
  expect(scene.target.hits.length, log).toBeGreaterThan(0)
  expect(scene.launch).not.toHaveBeenCalled()
  const probes = scene.fetched.mock.calls.filter(([input]) =>
    urlOf(input).startsWith(scene.target.origin),
  )
  expect(probes, log).toEqual([])
}

async function runThroughCli(scene: RemoteScene, pattern: string): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', scene.project.configPath, 'run', pattern], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
}

function runsDbOf(project: InProcessFixture): string {
  return join(project.project, '.agent-qa', 'runs.db')
}

async function settledIn(db: DashboardDatabase, runId: string): Promise<void> {
  await waitFor(() => TERMINAL.includes(db.getRun(runId)?.status ?? ''), `run ${runId} never finished`)
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
  const client = new Client({ name: 'agent-qa-remote-door', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    const result = await client.callTool(
      { name: 'agent_qa_start_run', arguments: { patterns: [pattern] } },
      { timeout: RUN_BUDGET_MS },
    ) as {
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
  const db = new DashboardDatabase({ dbPath: runsDbOf(project), runOwnership: composeRunOwnership() })
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
  runDoor.backend.on('run-settled', (runId: string) => { settled.push(runId) })
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
  if (address === null || typeof address === 'string') throw new TypeError('the dashboard bound no port')
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
  modelId: 'test:remote-every-door',
  generate: () => Promise.resolve({ text: 'unused' }),
}

async function startThroughDaemon(scene: RemoteScene): Promise<string> {
  const { project } = scene
  const signals = new Map<NodeJS.Signals, () => void>()
  let started = false
  const running = runDaemonHost({
    agentQaRoot: project.agentQaRoot,
    knowledgeRoot: join(project.project, 'agent-qa-knowledge'),
    configPath: project.configPath,
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: project.configPath,
        entries: [],
      }),
    },
    model: () => DAEMON_MODEL,
    operations: {
      setInterval: (_callback, intervalMs) => intervalMs as unknown as ReturnType<typeof setInterval>,
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
      info: () => { started = true },
      error: (message) => { scene.printed.push(message) },
    },
  })
  try {
    await waitFor(() => started, 'the daemon did not finish starting')
    const ack = await invokeViaDaemon({
      agentQaRoot: project.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [project.testPattern] },
    }) as RunStartAcknowledgement
    return ack.runId
  } finally {
    const stop = signals.get('SIGTERM')
    if (stop === undefined) throw new Error('the daemon installed no SIGTERM listener')
    stop()
    await running
  }
}

describe('a web test placed on a remote runs there from every door', () => {
  it('agent-qa run connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it("agent-qa run runs a suite's members on its remote through one session", async () => {
    await onRemote({ secondSuiteMember: true }, async (scene) => {
      await runThroughCli(scene, scene.project.suitePattern)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('agent-qa run refuses a test whose remote pick is unknown before it starts', async () => {
    await onRemote({ directTestPick: 'nope' }, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern)

      expect(scene.exit).toHaveBeenCalledWith(2)
      const refusal = 'Unknown remote "nope" in tests/direct.yaml. registry.remotes lists: grid.'
      const stderr = scene.stderr.join('\n')
      expect(scene.stderr.filter((line) => line.includes(refusal)), stderr).toHaveLength(1)
      expect(scene.stderr.filter((line) => /^\s+at /.test(line)), stderr).toEqual([])
      expect(scene.endpoint.sessions(), stderr).toBe(0)
    })
  }, RUN_BUDGET_MS)

  it('fn connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const host = composeCliLocalAgent({
        agentQaRoot: scene.project.agentQaRoot,
        configPath: scene.project.configPath,
      })
      opened.push(() => host.close())
      const ack = await invokeFunction(
        host.registry,
        'runs.start',
        { patterns: [scene.project.testPattern] },
        CLI_FUNCTION_CALLER,
      ) as RunStartAcknowledgement
      await settledAt(scene.project, ack.runId)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('the standalone MCP host connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const host = composeCliLocalAgent({
        agentQaRoot: scene.project.agentQaRoot,
        configPath: scene.project.configPath,
        runTrigger: 'mcp',
      })
      opened.push(() => host.close())
      const url = await listen(createMcpHttpRequestListener({
        registry: host.registry as FunctionRegistry,
        maskText: (text) => text,
      }))
      const runId = await startOverMcp(url, scene.project.testPattern)
      await settledAt(scene.project, runId)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('the co-hosted MCP endpoint connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const mount = await mountCoHostedMcp({
        server: createServer(createMcpHttpRequestListener({
          registry: dashboard.registry,
          maskText: (text) => text,
          liveLink: { dashboardBaseUrl: () => dashboard.origin },
        })),
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

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('POST /run connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const runId = (await postJson(dashboard, '/run', { patterns: [scene.project.testPattern] }))['runId']
      expect(typeof runId, 'POST /run answered no run id').toBe('string')
      await settledIn(dashboard.db, runId as string)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('a queued dashboard run connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const dashboard = await openDashboard(scene.project)
      const runId = (
        await postJson(dashboard, '/api/runs/trigger', { file: scene.project.testPattern })
      )['runId']
      expect(typeof runId, 'the trigger route answered no run id').toBe('string')
      await waitFor(
        () => dashboard.settled.includes(runId as string),
        `queued run ${String(runId)} never settled`,
      )

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)

  it('the daemon connects a direct test to the Playwright server its config names', async () => {
    await onRemote({}, async (scene) => {
      const runId = await startThroughDaemon(scene)
      await settledAt(scene.project, runId)

      expectReachedRemote(scene)
    })
  }, RUN_BUDGET_MS)
})
