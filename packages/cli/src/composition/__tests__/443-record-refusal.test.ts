// 2026-10-17 (443-05, D-05/D-27): a run that cannot be recorded is refused before any effect, and a
// write that fails after the start leaves the verdict alone and says so once on stderr.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { RunIdAlreadyInUseError } from '@vostride/agent-qa-agent-local'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import type { RunStartAcknowledgement, RunsStartInput } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

import { CLI_ENTRY, REBUILD_INSTRUCTION, buildFreshness, hermeticEnv } from '../../__tests__/conformance/spawned-chat.js'
import { createRunRecord, doorRunAttributes } from '../../commands/run.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import type { ComposeCliLocalAgentInput } from '../local-agent-host.js'
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

const RUN_BUDGET_MS = 180_000
const NOT_STARTED = 'The run was not started.'

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
  vi.restoreAllMocks()
})

function posixOnly(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

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

function declareDbPath(project: Fixture, dbPath: string): void {
  const config = readFileSync(project.configPath, 'utf8')
  writeFileSync(project.configPath, `${config}services:\n  dashboard:\n    dbPath: ${dbPath}\n`)
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

async function start(
  project: Fixture,
  request: RunsStartInput,
  runBridge?: ComposeCliLocalAgentInput['runBridge'],
): Promise<{ ack?: RunStartAcknowledgement; error?: unknown }> {
  const composed = composeCliLocalAgent({
    agentQaRoot: project.agentQaRoot,
    configPath: project.configPath,
    ...(runBridge === undefined ? {} : { runBridge }),
  })
  opened.push(() => composed.close())
  try {
    return { ack: await invokeFunction(composed.registry, 'runs.start', request, CLI_FUNCTION_CALLER) as RunStartAcknowledgement }
  } catch (error) {
    return { error }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rawRow(path: string, runId: string): string {
  const db = new DatabaseSync(path)
  try {
    return JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').all(runId))
  } finally {
    db.close()
  }
}

describe('C443-RECORD-REFUSAL', () => {
  it('a version-4 runs.db refuses the run naming the file and leaves it untouched', async () => {
    const project = fixture()
    const path = runsDbOf(project)
    mkdirSync(join(project.project, '.agent-qa'), { recursive: true })
    const old = new DatabaseSync(path)
    old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 4')
    old.close()
    const before = sha256(path)

    const outcome = await start(project, { patterns: [project.testPattern] })

    expect(outcome.ack?.runId, 'the door acknowledged a run').toBeUndefined()
    const message = messageOf(outcome.error)
    expect(message).toContain(path)
    expect(message).toContain('version 4')
    expect(message).toContain(NOT_STARTED)
    expect(runDirs(project).length, 'run directories').toBe(0)
    expect(sha256(path), 'the version-4 file changed').toBe(before)
  }, RUN_BUDGET_MS)

  it('an unwritable runs.db folder refuses the run in one plain sentence', async () => {
    posixOnly()
    const project = fixture()
    const locked = join(project.project, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    opened.push(() => chmodSync(locked, 0o755))
    let probeWrote = true
    try {
      writeFileSync(join(locked, 'probe'), '')
    } catch {
      probeWrote = false
    }
    if (probeWrote) throw new Error('the locked folder accepted a write; this cell cannot run as root')
    declareDbPath(project, 'locked/runs.db')

    const outcome = await start(project, { patterns: [project.testPattern] })

    expect(outcome.ack?.runId, 'the door acknowledged a run').toBeUndefined()
    expect(messageOf(outcome.error)).toContain(
      `agent-qa could not open the runs database at ${join(locked, 'runs.db')}, so the run was not started:`,
    )
    expect(runDirs(project).length, 'run directories').toBe(0)
  }, RUN_BUDGET_MS)

  it('a corrupt runs.db refuses the run in one plain sentence', async () => {
    const project = fixture()
    const path = runsDbOf(project)
    mkdirSync(join(project.project, '.agent-qa'), { recursive: true })
    writeFileSync(path, 'this is not a database, it is a sentence long enough to fill a header page\n'.repeat(20))

    const outcome = await start(project, { patterns: [project.testPattern] })

    expect(outcome.ack?.runId, 'the door acknowledged a run').toBeUndefined()
    expect(messageOf(outcome.error)).toContain(
      `agent-qa could not open the runs database at ${path}, so the run was not started:`,
    )
    expect(runDirs(project).length, 'run directories').toBe(0)
  }, RUN_BUDGET_MS)

  it('a run id whose row belongs to another process is refused before any effect', async () => {
    const project = fixture()
    const path = runsDbOf(project)
    const runId = generateRunId()
    const elsewhere = new DashboardDatabase({
      dbPath: path,
      runOwnership: {
        self: { pid: 4343, incarnation: 'proc-starttime:elsewhere', host: 'elsewhere' },
        probe: { isAlive: () => true, incarnationOf: () => undefined },
      },
    })
    elsewhere.insertRun({
      id: runId,
      name: 'owned elsewhere',
      status: 'running',
      duration: 0,
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-17T00:00:00.000Z',
      platform: 'web',
    })
    elsewhere.close()
    const before = rawRow(path, runId)

    const outcome = await start(project, {
      runId: runId as RunsStartInput['runId'],
      patterns: [project.testPattern],
    })

    expect(outcome.error, messageOf(outcome.error)).toBeInstanceOf(RunIdAlreadyInUseError)
    expect(rawRow(path, runId) === before, 'the other process row changed').toBe(true)
    expect(runDirs(project).length, 'run directories').toBe(0)
  }, RUN_BUDGET_MS)

  it('fn --json keeps stdout one JSON document while the run is recorded', async () => {
    posixOnly()
    expect(JSON.stringify(buildFreshness()), REBUILD_INSTRUCTION).toBe('{"missing":[],"stale":[]}')
    const project = fixture()
    const input = JSON.stringify({ patterns: [project.testPattern] })
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(
        process.execPath,
        [CLI_ENTRY, '--config', project.configPath, 'fn', 'runs.start', '--input', input, '--json'],
        {
          cwd: project.project,
          env: {
            ...hermeticEnv(project.project),
            AGENT_QA_LIVE_EVENTS: 'true',
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('close', (code) => done({ code, stdout, stderr }))
    })

    let parsed: unknown
    try {
      parsed = JSON.parse(outcome.stdout)
    } catch {
      parsed = undefined
    }
    expect(parsed !== undefined, `stdout is not one JSON document: ${outcome.stdout.slice(0, 400)} | stderr: ${outcome.stderr.slice(0, 400)}`).toBe(true)
    const runId = JSON.stringify(parsed).match(/r_[a-z-]+/)?.[0]
    expect(runId, 'the JSON document names no run id').toBeDefined()
    const db = new DashboardDatabase({ dbPath: runsDbOf(project) })
    try {
      expect(db.getRun(runId!)?.id, 'runs.db holds no row for the fn run').toBe(runId)
    } finally {
      db.close()
    }
  }, RUN_BUDGET_MS)
})

describe('C443-RECORD-INCOMPLETE', () => {
  it('a write that fails after the start leaves the verdict and says the record is incomplete', async () => {
    const project = fixture()
    const real = new DashboardDatabase({ dbPath: runsDbOf(project), runOwnership: composeRunOwnership() })
    opened.push(() => real.close())
    let thrown = false
    const failing = new Proxy(real, {
      get(subject, property, receiver) {
        const value = Reflect.get(subject, property, receiver) as unknown
        if (property === 'updateRun' && typeof value === 'function') {
          return (...args: unknown[]) => {
            if (!thrown) {
              thrown = true
              throw new Error('disk I/O error')
            }
            return (value as (...rest: unknown[]) => unknown).apply(subject, args)
          }
        }
        return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(subject) : value
      },
    })
    const warned: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')) })

    const outcome = await start(project, { patterns: [project.testPattern] }, {
      record: { db: failing, queueRun: () => undefined },
    })

    const runId = outcome.ack?.runId
    expect(runId, messageOf(outcome.error)).toBeDefined()
    expect(thrown, 'the failing write was never reached').toBe(true)
    const events = readFileSync(join(project.agentQaRoot, 'runs', runId!, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; payload?: { verdict?: string } })
    const verdict = events.find((event) => event.type === 'verdict')?.payload?.verdict
    expect(verdict, 'the run published no verdict').toBeDefined()
    expect(real.getRun(runId!)?.status).toBe(verdict)
    const incomplete = warned.flatMap((line) => line.split('\n')).filter((line) => line.includes('but its dashboard record is incomplete'))
    expect(incomplete.length, `incomplete-record lines: ${incomplete.join(' | ')}`).toBe(1)
  }, RUN_BUDGET_MS)
})

// 2026-10-17 (443-12, GAP-D1): the D-27 close-out in the two windows C443-RECORD-INCOMPLETE does not
// reach: a write that fails right after the claim, and one that fails after a member finished.
describe('C443-RECORD-CLOSE', () => {
  function failOn(
    real: DashboardDatabase,
    method: 'insertRunArtifact' | 'updateRun',
    fails: (args: unknown[]) => boolean,
  ): { db: DashboardDatabase; reached: () => boolean } {
    let thrown = false
    const db = new Proxy(real, {
      get(subject, property, receiver) {
        const value = Reflect.get(subject, property, receiver) as unknown
        if (property === method && typeof value === 'function') {
          return (...args: unknown[]) => {
            if (!thrown && fails(args)) {
              thrown = true
              throw new Error('disk I/O error')
            }
            return (value as (...rest: unknown[]) => unknown).apply(subject, args)
          }
        }
        return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(subject) : value
      },
    })
    return { db, reached: () => thrown }
  }

  function verdictOf(project: Fixture, runId: string): string | undefined {
    return readFileSync(join(project.agentQaRoot, 'runs', runId, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; payload?: { verdict?: string } })
      .find((event) => event.type === 'verdict')?.payload?.verdict
  }

  it('an artifact write that fails right after the claim still closes the row with the verdict status', async () => {
    const project = fixture()
    const real = new DashboardDatabase({ dbPath: runsDbOf(project), runOwnership: composeRunOwnership() })
    opened.push(() => real.close())
    const failing = failOn(real, 'insertRunArtifact', () => true)
    const warned: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')) })

    const outcome = await start(project, { patterns: [project.testPattern] }, {
      record: { db: failing.db, queueRun: () => undefined },
    })

    const runId = outcome.ack?.runId
    expect(runId, messageOf(outcome.error)).toBeDefined()
    expect(failing.reached(), 'the failing write was never reached').toBe(true)
    const verdict = verdictOf(project, runId!)
    expect(verdict, 'the run published no verdict').toBeDefined()
    expect(real.getRun(runId!)?.status).toBe(verdict)
    expect(real.readRunOwner(runId!)?.pid, 'the row is not owned by this process').toBe(process.pid)
    const incomplete = warned.flatMap((line) => line.split('\n')).filter((line) => line.includes('but its dashboard record is incomplete'))
    expect(incomplete.length, `incomplete-record lines: ${incomplete.join(' | ')}`).toBe(1)
  }, RUN_BUDGET_MS)

  it("a two-member run whose second member's write fails ends at the run's verdict status", async () => {
    const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-443-record-close-')))
    opened.push(() => rmSync(configDir, { recursive: true, force: true }))
    mkdirSync(join(configDir, '.agent-qa'), { recursive: true })
    const real = new DashboardDatabase({
      dbPath: join(configDir, '.agent-qa', 'runs.db'),
      runOwnership: composeRunOwnership(),
    })
    opened.push(() => real.close())
    // 2026-10-17 (444-02, D-06): a member's write is its duration, never a status.
    let memberWrites = 0
    const failing = failOn(real, 'updateRun', ([, updates]) => (
      (updates as { duration?: unknown } | undefined)?.duration !== undefined && ++memberWrites === 2
    ))
    const warned: string[] = []
    const record = createRunRecord({
      attributes: doorRunAttributes('cli'),
      host: { db: failing.db, queueRun: () => undefined },
      warn: (line) => { warned.push(line) },
    })
    opened.push(() => record.close())
    const runId = generateRunId()
    await record.open({ runId, configDir })
    expect(record.db, 'the record did not use the lent handle').toBe(failing.db)
    const subscriber = record.subscriber({
      mask: (text) => text,
      members: [
        { testId: 't-a', name: 'Member A', filePath: 'tests/a.yaml' },
        { testId: 't-b', name: 'Member B', filePath: 'tests/b.yaml' },
      ],
    })
    let seq = 0
    const send = (type: RunEventEnvelope['type'], payload: Record<string, unknown>): void => {
      seq += 1
      subscriber.handler({ seq, ts: seq, runId, type, payload } as RunEventEnvelope)
    }

    send('runStarted', { memberTestCount: 2 })
    send('testStarted', { testId: 't-a', testIndex: 0, name: 'Member A', filePath: 'tests/a.yaml' })
    send('testFinished', { testId: 't-a', testIndex: 0, outcome: 'passed', durationMs: 10 })
    expect(real.getRun(runId)?.duration, "the first member's write did not land").toBe(10)
    expect(real.getRun(runId)?.status, 'a member moved the row off running').toBe('running')
    send('testStarted', { testId: 't-b', testIndex: 1, name: 'Member B', filePath: 'tests/b.yaml' })
    send('testFinished', { testId: 't-b', testIndex: 1, outcome: 'failed', durationMs: 10 })
    send('verdict', { verdict: 'failed' })
    send('runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: seq + 1 })
    await subscriber.flush()

    expect(failing.reached(), 'the failing write was never reached').toBe(true)
    expect(real.getRun(runId)?.status).toBe('failed')
    expect(real.readRunOwner(runId)?.pid, 'the row is not owned by this process').toBe(process.pid)
    const incomplete = warned.flatMap((line) => line.split('\n'))
      .filter((line) => line.includes('The run finished (failed), but its dashboard record is incomplete'))
    expect(incomplete.length, `incomplete-record lines: ${warned.join(' | ')}`).toBe(1)
  }, RUN_BUDGET_MS)
})
