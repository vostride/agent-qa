// 2026-10-17 (443-08, D-03/D-05/D-26): `agent-qa run` records every run it starts in runs.db,
// whatever the config holds, refuses a run it cannot record, and files a failure under the id it
// prints. 443-09 (D-03/D-20): the reporter list never decides the row or screenshot capture.

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  produceDirectRunMembers,
  resolveRunInvocationInputs,
} from '../../commands/run.js'
import type { RunOptions } from '../../commands/run.js'
import { runInProcessCliRun } from '../../composition/in-process-run-execution.js'
import {
  CountingTarget,
  closeTestRunRecords,
  createInProcessFixture,
  testRunRecord,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { InProcessFixture } from '../../composition/__tests__/in-process-run-fixture.js'
import { refuseWithoutPosixRunLifecycle, startCliRun } from './cli-run-fixture.js'
import type { CliRunExit } from './cli-run-fixture.js'

const memberConfigs = vi.hoisted(() => [] as Array<{ captureScreenshots?: boolean }>)

vi.mock('@vostride/agent-qa-runner', async (importOriginal) => {
  const original = await importOriginal<typeof import('@vostride/agent-qa-runner')>()
  return {
    ...original,
    runMemberTest: async (...args: Parameters<typeof original.runMemberTest>) => {
      memberConfigs.push({ captureScreenshots: args[1].captureScreenshots })
      return { name: args[0].name, filePath: '', status: 'failed', steps: [], duration: 0, failureSummary: 'capture probe' }
    },
  }
})

vi.mock('@vostride/agent-qa-web', async (importOriginal) => ({
  ...await importOriginal<typeof import('@vostride/agent-qa-web')>(),
  WebPlatformAdapter: class {
    platform = 'web' as const
    recording = { start: async () => ({}), stop: async () => undefined }
    async setup() {}
    async cleanup() {}
    async navigate() {}
    async observe() { return {} }
    async execute() { return { success: true } }
  },
}))

const CELL_BUDGET_MS = 300_000
const NOT_STARTED = 'The run was not started.'
const TERMINAL = ['passed', 'failed', 'skipped', 'cancelled']

interface RunRowRead {
  readonly id: string
  readonly status: string
  readonly ownerPid: number | null
  readonly attributes: Record<string, string>
}

const target = new CountingTarget()

beforeAll(async () => { await target.listen() })
afterAll(async () => {
  await target.close()
  removeInProcessFixtures()
})

function project(): InProcessFixture {
  refuseWithoutPosixRunLifecycle()
  const created = createInProcessFixture({ origin: target.origin, environment: 'local' })
  mkdirSync(join(created.project, 'no-browsers'), { recursive: true })
  return created
}

async function run(
  at: InProcessFixture,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliRunExit & { pid: number }> {
  const started = startCliRun(at, args, {
    PLAYWRIGHT_BROWSERS_PATH: join(at.project, 'no-browsers'),
    ...env,
  })
  return { ...(await started.done), pid: started.pid }
}

function runsDbOf(at: InProcessFixture): string {
  return join(at.agentQaRoot, 'runs.db')
}

function printedRunIds(stdout: string): string[] {
  return [...stdout.matchAll(/^Run ID: (\S+)$/gmu)].map((match) => match[1]!)
}

function namedRunIds(exit: CliRunExit): string[] {
  return [...new Set(`${exit.stdout}\n${exit.stderr}`.match(/\br_[a-z]+(?:-[a-z]+)+/gu) ?? [])]
}

function runDirectories(at: InProcessFixture): string[] {
  const runs = join(at.agentQaRoot, 'runs')
  return existsSync(runs) ? readdirSync(runs) : []
}

function rows(at: InProcessFixture): RunRowRead[] {
  const db = new DatabaseSync(runsDbOf(at), { readOnly: true })
  try {
    return (db.prepare('SELECT id, status, owner_pid, attributes FROM runs ORDER BY id').all() as Array<{
      id: string
      status: string
      owner_pid: number | null
      attributes: string | null
    }>).map((row) => ({
      id: row.id,
      status: row.status,
      ownerPid: row.owner_pid,
      attributes: row.attributes === null ? {} : JSON.parse(row.attributes) as Record<string, string>,
    }))
  } finally {
    db.close()
  }
}

function rawRow(path: string, runId: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').all(runId))
  } finally {
    db.close()
  }
}

const flat = (text: string): string => text.replace(/\s*\n\s*/gu, ' | ').slice(0, 800)

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

const PLUGIN_MARKER = 'plugin-loaded.marker'

function declareMarkerAuthPlugin(at: InProcessFixture): string {
  writeFileSync(join(at.project, 'marker-auth-plugin.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(new URL('./${PLUGIN_MARKER}', import.meta.url), String(process.pid))`,
    'export const providers = []',
    '',
  ].join('\n'))
  appendFileSync(at.configPath, 'plugins:\n  auth:\n    - path: ./marker-auth-plugin.mjs\n')
  return join(at.project, PLUGIN_MARKER)
}

function writeVersion4RunsDb(at: InProcessFixture): string {
  const path = runsDbOf(at)
  mkdirSync(at.agentQaRoot, { recursive: true })
  const old = new DatabaseSync(path)
  old.exec('CREATE TABLE runs (id TEXT PRIMARY KEY); PRAGMA user_version = 4')
  old.close()
  return path
}

describe('agent-qa run records its row', () => {
  it('a single-test run with no dashboard block writes its row under the printed id', async () => {
    const at = project()
    expect(readFileSync(at.configPath, 'utf8').includes('dashboard'), 'the config names a dashboard block').toBe(false)

    const exit = await run(at, ['run', at.testPattern])

    const ids = namedRunIds(exit)
    expect(ids.length, `printed run ids: ${flat(exit.stdout)} | ${flat(exit.stderr)}`).toBe(1)
    expect(existsSync(runsDbOf(at)), `no runs.db after the run: ${flat(exit.stderr)}`).toBe(true)
    const recorded = rows(at)
    expect(recorded.map((row) => row.id).join(','), 'the rows under runs.db').toBe(ids[0])
    expect(recorded[0]!.ownerPid, 'the row owner pid').toBe(exit.pid)
    expect(recorded[0]!.attributes['agent-qa.trigger'], 'the row trigger').toBe('cli')
    expect(TERMINAL.includes(recorded[0]!.status), `the row status ${recorded[0]!.status}`).toBe(true)
  }, CELL_BUDGET_MS)

  it('a suite run with no dashboard block writes one row under the printed id', async () => {
    const at = project()
    expect(readFileSync(at.configPath, 'utf8').includes('dashboard'), 'the config names a dashboard block').toBe(false)

    const exit = await run(at, ['run', '--suite', at.suitePattern])

    const ids = namedRunIds(exit)
    expect(ids.length, `printed run ids: ${flat(exit.stdout)} | ${flat(exit.stderr)}`).toBe(1)
    expect(existsSync(runsDbOf(at)), `no runs.db after the suite run: ${flat(exit.stderr)}`).toBe(true)
    const recorded = rows(at)
    expect(recorded.map((row) => row.id).join(','), 'the rows under runs.db').toBe(ids[0])
    expect(recorded[0]!.ownerPid, 'the row owner pid').toBe(exit.pid)
    expect(recorded[0]!.attributes['agent-qa.trigger'], 'the row trigger').toBe('cli')
  }, CELL_BUDGET_MS)
})

describe('a run whose row cannot be recorded is refused', () => {
  it('agent-qa run refuses a run whose runs.db cannot be opened, exit 2, no id', async () => {
    const at = project()
    const path = writeVersion4RunsDb(at)
    const before = sha256(path)

    const exit = await run(at, ['run', at.testPattern])

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    expect(exit.stderr.includes(path), `stderr names the file: ${flat(exit.stderr)}`).toBe(true)
    expect(exit.stderr.includes(NOT_STARTED), `stderr says the run was not started: ${flat(exit.stderr)}`).toBe(true)
    expect(printedRunIds(exit.stdout).join(','), 'printed run ids').toBe('')
    expect(namedRunIds(exit).join(','), 'run ids the command named').toBe('')
    expect(runDirectories(at).join(','), 'run directories').toBe('')
    expect(sha256(path) === before, 'the version-4 file changed').toBe(true)
  }, CELL_BUDGET_MS)

  it('a suite run whose runs.db cannot be opened is refused before its plugins load', async () => {
    const at = project()
    const marker = declareMarkerAuthPlugin(at)
    const path = writeVersion4RunsDb(at)
    const before = sha256(path)

    const exit = await run(at, ['run', '--suite', at.suitePattern])

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    expect(exit.stderr.includes(path), `stderr names the file: ${flat(exit.stderr)}`).toBe(true)
    expect(exit.stderr.includes(NOT_STARTED), `stderr says the run was not started: ${flat(exit.stderr)}`).toBe(true)
    expect(printedRunIds(exit.stdout).join(','), 'printed run ids').toBe('')
    expect(namedRunIds(exit).join(','), 'run ids the command named').toBe('')
    expect(runDirectories(at).join(','), 'run directories').toBe('')
    expect(existsSync(marker), 'the auth plugin loaded').toBe(false)
    expect(sha256(path) === before, 'the version-4 file changed').toBe(true)
  }, CELL_BUDGET_MS)
})

describe('a run that fails before it starts files one row', () => {
  it('a parse error writes one failed row under the printed id', async () => {
    const at = project()
    writeFileSync(join(at.project, at.testPattern), 'name: [an unclosed list\nsteps:\n  - Verify\n')

    const exit = await run(at, ['run', at.testPattern])

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    const ids = namedRunIds(exit)
    expect(ids.length, `printed run ids: ${flat(exit.stdout)}`).toBe(1)
    expect(existsSync(runsDbOf(at)), `no runs.db after the parse error: ${flat(exit.stderr)}`).toBe(true)
    const recorded = rows(at)
    expect(recorded.map((row) => `${row.id}:${row.status}`).join(','), 'the rows under runs.db').toBe(`${ids[0]}:failed`)
  }, CELL_BUDGET_MS)

  it('a suite preparation failure writes one failed row under the printed id', async () => {
    const at = project()
    const suiteFile = join(at.project, at.suitePattern)
    writeFileSync(suiteFile, readFileSync(suiteFile, 'utf8').replace('test: tests/member.yaml', 'test: ../outside.yaml'))

    const exit = await run(at, ['run', '--suite', at.suitePattern])

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    expect(exit.stderr.includes('Path traversal rejected'), `stderr names the refusal: ${flat(exit.stderr)}`).toBe(true)
    const ids = namedRunIds(exit)
    expect(ids.length, `printed run ids: ${flat(exit.stdout)}`).toBe(1)
    expect(existsSync(runsDbOf(at)), `no runs.db after the preparation failure: ${flat(exit.stderr)}`).toBe(true)
    const recorded = rows(at)
    expect(recorded.map((row) => `${row.id}:${row.status}`).join(','), 'the rows under runs.db').toBe(`${ids[0]}:failed`)
  }, CELL_BUDGET_MS)

  it('an AGENT_QA_RUN_ID naming another process\'s row is refused and the row is untouched', async () => {
    const at = project()
    const path = runsDbOf(at)
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

    const exit = await run(at, ['run', at.testPattern], { AGENT_QA_RUN_ID: runId })

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    expect(exit.stderr.includes('that id already names a run'), `stderr carries the in-use sentence: ${flat(exit.stderr)}`).toBe(true)
    expect(rawRow(path, runId) === before, 'the other process row changed').toBe(true)
    expect(runDirectories(at).join(','), 'run directories').toBe('')
  }, CELL_BUDGET_MS)
})

async function memberCaptureFor(flags: Partial<RunOptions>): Promise<string> {
  const at = project()
  appendFileSync(at.configPath, 'services:\n  dashboard: {}\n')
  vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', join(at.project, 'no-browsers'))
  vi.stubEnv('AGENT_QA_RUN_ID', undefined)
  memberConfigs.length = 0
  try {
    await runInProcessCliRun({
      configPath: at.configPath,
      agentQaRoot: at.agentQaRoot,
      executionContext: 'local-headless',
      runRecord: testRunRecord(),
      produceMembers: async ({ runId }) => {
        const inputs = await resolveRunInvocationInputs({ configPath: at.configPath, patterns: [at.testPattern] })
        const { parseAllTestBindings } = await import('@vostride/agent-qa-core')
        const parsed = await parseAllTestBindings([...inputs.discovered.tests])
        return produceDirectRunMembers({ inputs, bindings: parsed.bindings, runId, opts: flags as RunOptions })
      },
    }, { patterns: [at.testPattern] })
  } catch {
    // The member fails without a browser; the config it was handed is what this reads.
  }
  return memberConfigs.map((config) => String(config.captureScreenshots)).join(',')
}

describe('the reporter list and the run record', () => {
  afterEach(() => {
    closeTestRunRecords()
    vi.unstubAllEnvs()
  })

  it('a run still records its row under the default reporters', async () => {
    const at = project()

    const exit = await run(at, ['run', at.testPattern])

    const ids = namedRunIds(exit)
    expect(ids.length, `printed run ids: ${flat(exit.stdout)} | ${flat(exit.stderr)}`).toBe(1)
    expect(existsSync(runsDbOf(at)), `no runs.db after the run: ${flat(exit.stderr)}`).toBe(true)
    expect(rows(at).map((row) => row.id).join(','), 'the rows under runs.db').toBe(ids[0])
  }, CELL_BUDGET_MS)

  it('screenshot capture follows only --screenshot-mode', async () => {
    expect(await memberCaptureFor({}), 'capture without --screenshot-mode').toBe('false')
    expect(await memberCaptureFor({ screenshotMode: 'every-step' }), 'capture with --screenshot-mode every-step').toBe('true')
  }, CELL_BUDGET_MS)
})

// 2026-10-17 (443-10, D-26): the suite producer prints nothing; only `agent-qa run` names the id.
describe('a suite preparation failure\'s output', () => {
  function stdoutNotOneJsonDocument(stdout: string): string {
    if (stdout.trim() === '') return ''
    try {
      JSON.parse(stdout)
      return ''
    } catch {
      return flat(stdout)
    }
  }

  function preparationFailureProject(): InProcessFixture {
    const at = project()
    const suiteFile = join(at.project, at.suitePattern)
    writeFileSync(suiteFile, readFileSync(suiteFile, 'utf8').replace('test: tests/member.yaml', 'test: ../outside.yaml'))
    return at
  }

  it('a suite preparation failure through fn --json leaves stdout one JSON document and files its row', async () => {
    const at = preparationFailureProject()

    const exit = await run(at, ['fn', 'runs.start', '--input', JSON.stringify({ patterns: [at.suitePattern] }), '--json'])

    expect(exit.stderr.includes('Path traversal rejected'), `stderr names the refusal: ${flat(exit.stderr)}`).toBe(true)
    expect(stdoutNotOneJsonDocument(exit.stdout), 'stdout that is not one JSON document').toBe('')
    expect(existsSync(runsDbOf(at)), `no runs.db after the preparation failure: ${flat(exit.stderr)}`).toBe(true)
    const recorded = rows(at)
    expect(recorded.map((row) => row.status).join(','), 'the rows under runs.db').toBe('failed')
    expect(/^r_[a-z]+(?:-[a-z]+)+$/u.test(recorded[0]!.id), `the row is filed under a minted run id: ${recorded[0]!.id}`).toBe(true)
  }, CELL_BUDGET_MS)

  it('agent-qa run on a suite preparation failure still prints its Run ID line', async () => {
    const at = preparationFailureProject()

    const exit = await run(at, ['run', '--suite', at.suitePattern])

    expect(exit.code, `exit code; stderr: ${flat(exit.stderr)}`).toBe(2)
    const ids = printedRunIds(exit.stdout)
    expect(ids.length, `Run ID lines on stdout: ${flat(exit.stdout)}`).toBe(1)
    expect(exit.stdout.includes('Run attributes:'), `stdout names the run attributes: ${flat(exit.stdout)}`).toBe(true)
    expect(rows(at).map((row) => `${row.id}:${row.status}`).join(','), 'the rows under runs.db').toBe(`${ids[0]}:failed`)
  }, CELL_BUDGET_MS)
})
