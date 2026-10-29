// 2026-10-17 (443-05, D-02/D-06/D-08/D-22): every runs.start door records its run through one
// builder; these cells read the rows each door leaves.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, resolveRunOwnerHost, startServer } from '@vostride/agent-qa-dashboard'
import type { RunStartAcknowledgement, RunsStartInput } from '@vostride/agent-qa-schema'

import { composeDashboardDoor, composeRunServicePorts, createDashboardRunDoor } from '../../commands/dashboard.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import { composeRunOwnership } from '../run-owner-probe.js'
import {
  CountingTarget,
  createInProcessFixture,
  runDirs,
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

function rowsAt(path: string): Array<{ id: string; status: string; attributes: Record<string, string> }> {
  if (!existsSync(path)) return []
  const db = new DashboardDatabase({ dbPath: path })
  try {
    return db.getRuns({}).map((row) => ({
      id: row.id,
      status: row.status,
      attributes: (row.attributes ?? {}) as Record<string, string>,
    }))
  } finally {
    db.close()
  }
}

function ownerAt(path: string, runId: string): { pid: number; host: string } | undefined {
  const db = new DashboardDatabase({ dbPath: path })
  try {
    const owner = db.readRunOwner(runId)
    return owner === undefined ? undefined : { pid: owner.pid, host: owner.host }
  } finally {
    db.close()
  }
}

async function startThroughHost(host: Fixture, request: RunsStartInput): Promise<RunStartAcknowledgement> {
  const composed = composeCliLocalAgent({ agentQaRoot: host.agentQaRoot, configPath: host.configPath })
  opened.push(() => composed.close())
  return await invokeFunction(composed.registry, 'runs.start', request, CLI_FUNCTION_CALLER) as RunStartAcknowledgement
}

interface Scene {
  readonly origin: string
  readonly db: DashboardDatabase
  readonly settled: string[]
}

async function openScene(project: Fixture, dbPath: string): Promise<Scene> {
  const db = new DashboardDatabase({ dbPath, runOwnership: composeRunOwnership() })
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
  return { origin: boundOrigin, db, settled }
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

async function triggerQueued(scene: Scene, project: Fixture): Promise<string> {
  const answer = await postJson(scene, '/api/runs/trigger', { file: project.testPattern })
  const runId = answer['runId']
  expect(typeof runId, 'the trigger route answered no run id').toBe('string')
  const deadline = Date.now() + RUN_BUDGET_MS
  while (!scene.settled.includes(runId as string)) {
    if (Date.now() > deadline) throw new Error(`queued run ${String(runId)} never settled`)
    await new Promise((tick) => setTimeout(tick, 50))
  }
  return runId as string
}

async function postRun(scene: Scene, project: Fixture): Promise<string> {
  const answer = await postJson(scene, '/run', { patterns: [project.testPattern] })
  const runId = answer['runId']
  expect(typeof runId, 'POST /run answered no run id').toBe('string')
  return runId as string
}

describe('one run record per door', () => {
  it('a runs.start through the shared host writes one row under the returned id, stamped with this process', async () => {
    const project = fixture()
    const ack = await startThroughHost(project, { patterns: [project.testPattern] })

    expect(runDirs(project).map((dir) => dir.split('/').pop())).toEqual([ack.runId])
    const rows = rowsAt(runsDbOf(project))
    expect(rows.map((row) => row.id).join(','), 'runs.db rows').toBe(ack.runId)
    expect(TERMINAL).toContain(rows[0]!.status)
    expect(Object.keys(rows[0]!.attributes)).toEqual(expect.arrayContaining(['agent-qa.trigger', 'agent-qa.runner']))
    expect(ownerAt(runsDbOf(project), ack.runId)).toEqual({ pid: process.pid, host: resolveRunOwnerHost() })
  }, RUN_BUDGET_MS)

  it("a queued dashboard run keeps its one row and its routes' attributes", async () => {
    const project = fixture()
    const scene = await openScene(project, runsDbOf(project))
    const runId = await triggerQueued(scene, project)

    const rows = scene.db.getRuns({})
    expect(rows.map((row) => row.id).join(','), 'runs.db rows').toBe(runId)
    expect(TERMINAL).toContain(rows[0]!.status)
    expect(rows[0]!.attributes?.['agent-qa.trigger']).toBe('dashboard')
  }, RUN_BUDGET_MS)

  it("a POST /run run gets a row through the dashboard's own handle", async () => {
    const project = fixture()
    const scene = await openScene(project, runsDbOf(project))
    const runId = await postRun(scene, project)

    const row = scene.db.getRun(runId)
    expect(row?.id, 'the dashboard handle reads no row for the POST /run id').toBe(runId)
    expect(TERMINAL).toContain(row!.status)
    expect(scene.db.readRunOwner(runId)?.pid).toBe(process.pid)
  }, RUN_BUDGET_MS)
})

describe('the runs.db a run record writes', () => {
  it("a run naming another config writes that config's runs.db", async () => {
    const host = fixture()
    const other = fixture()
    const ack = await startThroughHost(host, { configPath: other.configPath, patterns: [other.testPattern] })

    expect(rowsAt(runsDbOf(other)).map((row) => row.id).join(','), "the other config's rows").toBe(ack.runId)
    expect(rowsAt(runsDbOf(host)).map((row) => row.id).join(','), "the host's rows").toBe('')
  }, RUN_BUDGET_MS)

  it("a queued run keeps the dashboard's file when the dashboard holds another path", async () => {
    const project = fixture()
    const elsewhere = join(project.project, 'elsewhere', 'dashboard-only.db')
    const scene = await openScene(project, elsewhere)

    const queuedId = await triggerQueued(scene, project)
    const postedId = await postRun(scene, project)

    expect(scene.db.getRuns({}).map((row) => row.id).join(','), "the dashboard's own file").toBe(queuedId)
    expect(rowsAt(runsDbOf(project)).map((row) => row.id).join(','), "the config's runs.db").toBe(postedId)
  }, 2 * RUN_BUDGET_MS)
})
