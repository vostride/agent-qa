// THE GAP-ROUND DOOR FIXTURE (Phase 433 plan 28 onward).
//
// A recorded run over the stub model, started through the SHIPPED `agent-qa run` binary with the
// dashboard reporter on, so a cell can read what that one run left in each of its homes: the run
// store (`.agent-qa/runs/<id>/events.jsonl`), the project's dashboard database, the CLI's own
// output, and a dashboard composed the way `agent-qa dashboard` composes it. Nothing between the
// door and the run core is mocked; only the model is scripted.
//
// It returns data and never asserts. A missing browser, ffmpeg or runs database is a refusal
// (a thrown error), never a skip.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { DashboardDatabase, resolveDashboardDbPath, startServer } from '@vostride/agent-qa-dashboard'
import { generateHookId } from '@vostride/agent-qa-ids'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { composeDashboardDoor, composeRunServicePorts, createDashboardRunDoor } from '../../commands/dashboard.js'
import { composeRunOwnership } from '../../composition/run-owner-probe.js'
import {
  POPULATED_RUN_ANCHORED_BUILDS,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, buildFreshness, hermeticEnv } from './spawned-chat.js'

export interface RecordedDoorOptions {
  /** Give the test one bash setup hook that exits 0. */
  readonly setupHook?: boolean
  // 2026-10-14 (441-06): forwarded to the stub model as `fullBodies`.
  readonly fullBodies?: boolean
}

export interface RecordedDoorProject extends PopulatedRunProject {
  readonly model: StubModelServer
  readonly target: FixtureServer
  close(): Promise<void>
}

export interface CliRunOutcome {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export const RUN_ID_TOKEN = /\br_[a-z]+(?:-[a-z]+)+/gu

export function refuseWithoutRecordingTools(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const executable = chromium.executablePath()
  if (!existsSync(executable)) throw new Error('Playwright Chromium missing; never skip')
  let cache = dirname(executable)
  while (!readdirSync(cache).some((name) => name.startsWith('ffmpeg-'))) {
    const parent = dirname(cache)
    if (parent === cache) throw new Error('Playwright ffmpeg missing; never skip')
    cache = parent
  }
  const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) {
    throw new Error(`Run pnpm build before door checks: ${JSON.stringify(freshness)}`)
  }
}

export async function recordedDoorProject(label: string, opts: RecordedDoorOptions = {}): Promise<RecordedDoorProject> {
  refuseWithoutRecordingTools()
  const target = await startTargetPageServer()
  let model: StubModelServer | undefined
  try {
    model = await startStubModelServer(opts.fullBodies === true ? { fullBodies: true } : {})
    const project = populatedRunFixtureProject(label, { modelBaseUrl: model.baseUrl, targetUrl: target.url })

    const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as Record<string, any>
    config.services = { ...(config.services ?? {}), dashboard: {}, recording: { enabled: true } }
    writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    if (opts.setupHook) {
      const hookId = generateHookId()
      writeFileSync(join(project.root, 'setup-hook.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(project.root, 'hooks.yaml'), stringifyYaml({
        hooks: [{ id: hookId, name: 'Door setup', runtime: 'bash', file: 'setup-hook.sh', timeout: '30s' }],
      }), 'utf8')
      const testFile = join(project.root, project.testPath)
      const test = parseYaml(readFileSync(testFile, 'utf8')) as Record<string, unknown>
      test.setup = [hookId]
      writeFileSync(testFile, stringifyYaml(test), 'utf8')
    }

    const servers = { model, target }
    return {
      ...project,
      ...servers,
      close: async () => {
        await servers.model.close().catch(() => undefined)
        await servers.target.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await model?.close().catch(() => undefined)
    await target.close().catch(() => undefined)
    throw error
  }
}

/** The built `agent-qa` with CI posture, stdin closed and `AGENT_QA_RUN_ID` removed unless `env` sets it. */
export async function spawnCliRun(
  project: PopulatedRunProject,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>>; readonly budgetMs?: number } = {},
): Promise<CliRunOutcome> {
  if (!existsSync(CLI_ENTRY)) throw new Error(`The built CLI is missing at ${CLI_ENTRY}; run pnpm build first`)
  const env: NodeJS.ProcessEnv = {
    ...hermeticEnv(project.root),
    ...populatedRunSpawnEnv(),
    CI: 'true',
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
  }
  delete env.AGENT_QA_RUN_ID
  Object.assign(env, options.env ?? {})
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', project.configPath, ...args], {
    cwd: project.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, options.budgetMs ?? 240_000)
  try {
    const status = await new Promise<number | null>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code) => settle(code))
    })
    return { status, stdout, stderr }
  } finally {
    clearTimeout(budget)
  }
}

function runsRoot(project: PopulatedRunProject): string {
  return join(project.agentQaRoot, 'runs')
}

/** The run id each run-store directory's event log names, one per run directory. */
export function runStoreIds(project: PopulatedRunProject): string[] {
  const root = runsRoot(project)
  if (!existsSync(root)) return []
  const ids: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, entry.name, 'events.jsonl')
    if (!existsSync(file)) continue
    const first = readFileSync(file, 'utf8').split('\n').find((line) => line.trim() !== '')
    const envelope = first === undefined ? undefined : JSON.parse(first) as { runId?: string }
    ids.push(envelope?.runId ?? entry.name)
  }
  return ids.sort()
}

export function runStoreEvents(project: PopulatedRunProject, runId: string): RunEventEnvelope[] {
  for (const entry of readdirSync(runsRoot(project), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(runsRoot(project), entry.name, 'events.jsonl')
    if (!existsSync(file)) continue
    const envelopes = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try { return [JSON.parse(line) as RunEventEnvelope] } catch { return [] }
      })
    if (envelopes[0]?.runId === runId) return envelopes
  }
  throw new Error(`No run-store event log names run ${runId} under ${runsRoot(project)}`)
}

export function dashboardDbPath(project: PopulatedRunProject): string {
  const path = resolveDashboardDbPath({ configDir: project.root })
  if (!existsSync(path)) throw new Error(`No runs database at ${path}; the CLI did not write one`)
  return path
}

export function dashboardRunRows(project: PopulatedRunProject): Array<{ id: string; status: string; name: string }> {
  const db = new DashboardDatabase({ dbPath: dashboardDbPath(project) })
  try {
    return db.getRuns({}).map((row) => ({ id: row.id, status: row.status, name: row.name }))
  } finally {
    db.close()
  }
}

export function printedRunIds(text: string): string[] {
  return [...new Set(text.match(RUN_ID_TOKEN) ?? [])]
}

export interface DashboardScene {
  readonly origin: string
  readonly db: DashboardDatabase
  readonly registry: FunctionRegistry
  readonly settled: Array<{ runId: string; status: string; details: Record<string, unknown> }>
  close(): Promise<void>
}

/**
 * The dashboard in this process, composed as 432-direct-parity's `openDashboard` composes it, over
 * the project's own runs database so it reads what the CLI wrote.
 */
export async function openDashboardScene(
  project: PopulatedRunProject,
  options: { readonly dbPath?: string } = {},
): Promise<DashboardScene> {
  const db = new DashboardDatabase({
    dbPath: options.dbPath ?? resolveDashboardDbPath({ configDir: project.root }),
    runOwnership: composeRunOwnership(),
  })
  // The command hands the door its config path; the scene composes it the same way.
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
  const settled: DashboardScene['settled'] = []
  runDoor.backend.on('run-settled', (runId: string, status: string, details: Record<string, unknown>) => {
    settled.push({ runId, status, details })
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
    started.close()
    throw new TypeError('the dashboard bound no port')
  }
  boundOrigin = `http://127.0.0.1:${String(address.port)}`
  let closed = false
  return {
    origin: boundOrigin,
    db,
    registry: door.host.registry,
    settled,
    close: async () => {
      if (closed) return
      closed = true
      started.close()
      runService.dispose()
      await door.host.close()
      db.close()
    },
  }
}
