// C444.1-RETRY-BACKOFF (444.1-12, D-23): two real `agent-qa run`s in one workspace. Run A fails
// and its analyze-run author is refused, so A's own tail leaves that row retrying. Run B passes,
// and its tail must complete B's own chain behind A's retrying row instead of stopping on it.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { printedRunIds, refuseWithoutRecordingTools } from './run-doors-fixture.js'
import {
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_SECOND_TEST_PATH,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
  type FixtureServer,
  type PopulatedRunProject,
  type StubModelServer,
} from './populated-run-fixture.js'
import { CLI_ENTRY, cleanupTempRoots, hermeticEnv } from './spawned-chat.js'

const FILE_BUDGET_MS = 600_000
const SPAWN_BUDGET_MS = 240_000

const FORWARDED_CI = process.env.CI

interface JobRow {
  readonly kind: string
  readonly status: string
  readonly attempts: number
}

interface Leg {
  readonly runId: string
  exit?: { code: number | null; signal: NodeJS.Signals | null }
  exitLines?: string[]
  closeOutLines?: string[]
  printed?: boolean
  rows?: JobRow[] | string
  tail?: string
}

interface Scene {
  first?: Leg
  later?: Leg
  firstAfterLater?: JobRow[] | string
  error?: string
}

const scene: Scene = {}
let model: StubModelServer | undefined
let target: FixtureServer | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seen(): string {
  return JSON.stringify(scene, null, 2)
}

async function runOnce(project: PopulatedRunProject, testPath: string): Promise<Leg> {
  const leg: Leg = { runId: generateRunId() }
  const args = [CLI_ENTRY, '--config', project.configPath, 'run', testPath]
  const child = spawn(process.execPath, args, {
    cwd: project.root,
    env: {
      ...hermeticEnv(project.root),
      ...populatedRunSpawnEnv(),
      ...(FORWARDED_CI === undefined ? {} : { CI: FORWARDED_CI }),
      NO_COLOR: '1',
      AGENT_QA_RUN_ID: leg.runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const budget = setTimeout(() => { child.kill('SIGKILL') }, SPAWN_BUDGET_MS)
  try {
    leg.exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (settle, fail) => {
        child.once('error', fail)
        child.once('close', (code, signal) => { settle({ code, signal }) })
      },
    )
  } finally {
    clearTimeout(budget)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const output = `${stdout}\n${stderr}`
  leg.exitLines = output.split('\n').filter((line) => line.startsWith('post-processing — '))
  leg.closeOutLines = output.split('\n')
    .filter((line) => line.startsWith('post-processing complete for '))
  leg.printed = printedRunIds(output).includes(leg.runId)
  leg.tail = output.slice(-2_000)
  leg.rows = chainRows(project, leg.runId)
  return leg
}

function chainRows(project: PopulatedRunProject, runId: string): JobRow[] | string {
  try {
    const db = new DatabaseSync(join(project.agentQaRoot, 'agent-jobs.db'), {
      readOnly: true,
      timeout: 5_000,
    })
    try {
      return db.prepare(
        `SELECT kind, status, attempts FROM jobs
         WHERE json_extract(payload, '$.runId') = ?
         ORDER BY created_at ASC, id ASC`,
      ).all(runId).map((row) => ({
        kind: String(row.kind),
        status: String(row.status),
        attempts: Number(row.attempts),
      }))
    } finally {
      db.close()
    }
  } catch (error) {
    return `unreadable: ${message(error)}`
  }
}

async function drive(): Promise<void> {
  target = await startTargetPageServer()
  model = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
    analysisOutcome: 'error',
  })
  const project = populatedRunFixtureProject(
    '444-1-retry-backoff',
    { modelBaseUrl: model.baseUrl, targetUrl: target.url },
    { stepText: POPULATED_FAILURE_STEP_TEXT, secondStepText: POPULATED_PASSING_STEP_TEXT },
  )
  scene.first = await runOnce(project, project.testPath)
  scene.later = await runOnce(project, POPULATED_SECOND_TEST_PATH)
  scene.firstAfterLater = chainRows(project, scene.first.runId)
}

describe('a later run behind a retrying analysis', () => {
  beforeAll(async () => {
    refuseWithoutRecordingTools()
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    try {
      await drive()
    } catch (error) {
      scene.error = message(error)
    }
  }, FILE_BUDGET_MS)

  afterAll(async () => {
    await model?.close().catch(() => undefined)
    await target?.close().catch(() => undefined)
    cleanupTempRoots()
  }, 120_000)

  it('a later run in the same workspace completes its own chain behind an earlier retrying analysis', () => {
    expect(scene.error, seen()).toBeUndefined()
    const first = scene.first
    const later = scene.later
    expect(first?.exit, `the earlier run failed\n${seen()}`).toEqual({ code: 1, signal: null })
    expect(first?.rows, `the earlier run left its analysis retrying\n${seen()}`).toEqual(
      expect.arrayContaining([{ kind: 'analyze-run', status: 'queued', attempts: 1 }]),
    )

    const rows = later?.rows
    expect(Array.isArray(rows), `the later run's rows are readable\n${seen()}`).toBe(true)
    const kinds = (rows as JobRow[]).map((row) => row.kind)
    expect(kinds, `the later run's chain reached curation\n${seen()}`).toEqual(
      expect.arrayContaining(['analyze-run', 'curate-memory']),
    )
    for (const row of rows as JobRow[]) {
      expect(row.status, `the later run's ${row.kind} drained in its own tail\n${seen()}`)
        .toBe('done')
    }
    expect(later?.closeOutLines?.length, `the later run's one close-out line\n${seen()}`).toBe(1)
    expect(
      later?.closeOutLines?.[0]?.startsWith(`post-processing complete for ${later?.runId ?? ''} `),
      `the later run's close-out line names its run\n${seen()}`,
    ).toBe(true)
    expect(later?.exitLines, `the later run printed no summary line\n${seen()}`).toEqual([])
    expect(later?.exit, `the later run passed\n${seen()}`).toEqual({ code: 0, signal: null })
    expect(later?.printed, seen()).toBe(true)

    const firstAnalysis = Array.isArray(scene.firstAfterLater)
      ? scene.firstAfterLater.find((row) => row.kind === 'analyze-run')
      : undefined
    expect(firstAnalysis, `the earlier run's analysis row\n${seen()}`).toBeDefined()
    expect(firstAnalysis?.status, `the earlier run's refused analysis never completed\n${seen()}`)
      .not.toBe('done')
  })
})
