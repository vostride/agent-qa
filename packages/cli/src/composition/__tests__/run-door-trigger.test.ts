// 2026-10-17 (443-06, D-10/D-24): every runs.start door's row records its door in the existing
// agent-qa.trigger values; the dashboard tells POST /run from the co-hosted MCP by a request scope.

import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
  mountCoHostedMcp,
} from '../../commands/dashboard.js'
import { createMcpHttpRequestListener } from '../../commands/mcp.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type Fixture = ReturnType<typeof createInProcessFixture>

const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_BUDGET_MS = 180_000
const RUN_ID = /\br_[a-z]+(?:-[a-z]+)+/u

const target = new CountingTarget()
const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
const opened: Array<() => Promise<void> | void> = []

beforeAll(async () => { await target.listen() })
afterAll(async () => {
  await target.close()
  if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  removeInProcessFixtures()
})
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close()
})

function fixture(): Fixture {
  const created = createInProcessFixture({ origin: target.origin, environment: 'local' })
  const browsersRoot = join(created.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return created
}

function runsDbOf(project: Fixture): string {
  return join(project.project, '.agent-qa', 'runs.db')
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

async function triggerOf(db: DashboardDatabase, runId: string): Promise<string | undefined> {
  await waitFor(() => TERMINAL.includes(db.getRun(runId)?.status ?? ''), `run ${runId} never finished`)
  return db.getRun(runId)?.attributes?.['agent-qa.trigger']
}

async function triggerAt(path: string, runId: string): Promise<string | undefined> {
  const db = new DashboardDatabase({ dbPath: path })
  try {
    return await triggerOf(db, runId)
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
  const client = new Client({ name: 'agent-qa-443-06-door-trigger', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    const result = await client.callTool(
      { name: 'agent_qa_start_run', arguments: { patterns: [pattern] } },
      { timeout: RUN_BUDGET_MS },
    ) as { content?: ReadonlyArray<{ text?: string }>; structuredContent?: { runId?: unknown }; isError?: boolean }
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

interface Scene {
  readonly origin: string
  readonly db: DashboardDatabase
  readonly registry: FunctionRegistry
  readonly settled: string[]
}

async function openScene(project: Fixture): Promise<Scene> {
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

async function mountCoHosted(scene: Scene): Promise<string> {
  const mount = await mountCoHostedMcp({
    server: createServer(createMcpHttpRequestListener({
      registry: scene.registry,
      maskText: (text) => text,
      liveLink: { dashboardBaseUrl: () => scene.origin },
    })),
    port: 0,
    warn: () => undefined,
  })
  const server = mount.server
  expect(server, mount.warning ?? 'the co-hosted MCP endpoint did not mount').toBeDefined()
  opened.push(() => new Promise<void>((closed) => server!.close(() => closed())))
  return `http://127.0.0.1:${String(mount.boundPort)}/mcp`
}

async function postJson(scene: Scene, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${scene.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  expect(response.status, `${path} answered ${String(response.status)}: ${text}`).toBeLessThan(300)
  return JSON.parse(text) as Record<string, unknown>
}

async function postRun(scene: Scene, project: Fixture): Promise<string> {
  const runId = (await postJson(scene, '/run', { patterns: [project.testPattern] }))['runId']
  expect(typeof runId, 'POST /run answered no run id').toBe('string')
  return runId as string
}

async function queued(scene: Scene, path: string, body: unknown): Promise<string> {
  const runId = (await postJson(scene, path, body))['runId']
  expect(typeof runId, `${path} answered no run id`).toBe('string')
  await waitFor(() => scene.settled.includes(runId as string), `queued run ${String(runId)} never settled`)
  return runId as string
}

describe('C443-DOOR-TRIGGER', () => {
  it('fn records cli', async () => {
    const project = fixture()
    const host = composeCliLocalAgent({ agentQaRoot: project.agentQaRoot, configPath: project.configPath })
    opened.push(() => host.close())
    const ack = await invokeFunction(
      host.registry,
      'runs.start',
      { patterns: [project.testPattern] },
      CLI_FUNCTION_CALLER,
    ) as RunStartAcknowledgement

    expect(await triggerAt(runsDbOf(project), ack.runId), 'the fn row trigger').toBe('cli')
  }, RUN_BUDGET_MS)

  it('the standalone MCP host records mcp', async () => {
    const project = fixture()
    const host = composeCliLocalAgent({
      agentQaRoot: project.agentQaRoot,
      configPath: project.configPath,
      runTrigger: 'mcp',
    })
    opened.push(() => host.close())
    const url = await listen(createMcpHttpRequestListener({
      registry: host.registry as FunctionRegistry,
      maskText: (text) => text,
    }))
    const runId = await startOverMcp(url, project.testPattern)

    expect(await triggerAt(runsDbOf(project), runId), 'the standalone MCP row trigger').toBe('mcp')
  }, RUN_BUDGET_MS)

  it('dashboard POST /run records api', async () => {
    const project = fixture()
    const scene = await openScene(project)
    const runId = await postRun(scene, project)

    expect(await triggerOf(scene.db, runId), 'the POST /run row trigger').toBe('api')
  }, RUN_BUDGET_MS)

  it('the co-hosted MCP endpoint records mcp', async () => {
    const project = fixture()
    const scene = await openScene(project)
    const runId = await startOverMcp(await mountCoHosted(scene), project.testPattern)

    expect(await triggerOf(scene.db, runId), 'the co-hosted MCP row trigger').toBe('mcp')
  }, RUN_BUDGET_MS)

  it("a queued run keeps its routes' trigger", async () => {
    const project = fixture()
    const scene = await openScene(project)
    const triggered = await queued(scene, '/api/runs/trigger', { file: project.testPattern })
    const enqueued = await queued(scene, '/api/queue/enqueue', { name: 'the enqueue door', file: project.testPattern })

    expect(await triggerOf(scene.db, triggered), 'the trigger route row trigger').toBe('dashboard')
    expect(await triggerOf(scene.db, enqueued), 'the enqueue route row trigger').toBe('api')
  }, RUN_BUDGET_MS * 2)

  it('a scope does not outlive its request', async () => {
    const project = fixture()
    const scene = await openScene(project)
    const coHosted = await mountCoHosted(scene)
    const viaMcp = await startOverMcp(coHosted, project.testPattern)
    const outside = await invokeFunction(
      scene.registry,
      'runs.start',
      { patterns: [project.testPattern] },
      CLI_FUNCTION_CALLER,
    ) as RunStartAcknowledgement

    expect(await triggerOf(scene.db, viaMcp), 'the co-hosted row trigger').toBe('mcp')
    expect(await triggerOf(scene.db, outside.runId), 'the out-of-request row trigger').toBe('dashboard')

    const [viaPost, viaMcpAgain] = await Promise.all([
      postRun(scene, project),
      startOverMcp(coHosted, project.testPattern),
    ])
    expect(await triggerOf(scene.db, viaPost), 'the concurrent POST /run row trigger').toBe('api')
    expect(await triggerOf(scene.db, viaMcpAgain), 'the concurrent co-hosted row trigger').toBe('mcp')
  }, RUN_BUDGET_MS * 3)
})
