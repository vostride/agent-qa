// C433-ARTIFACT-CAPTURED (Phase 433 plan 29; G-433-5, F-433-15).
//
// A run started with `agent-qa run` or from the dashboard's Run stores its test as written, its
// resolved definition and the effective config on its run artifact, so the drawer has Test and
// Config to show. Every stored string crosses the run's own mask: a declared secret planted in the
// project's env file is a placeholder in the raw `run_artifacts` column, never its value.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  dashboardDbPath,
  openDashboardScene,
  recordedDoorProject,
  runStoreIds,
  spawnCliRun,
  type CliRunOutcome,
  type DashboardScene,
  type RecordedDoorProject,
} from './run-doors-fixture.js'
import {
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_SECRET_NAME,
  POPULATED_SECRET_ENV_VAR,
  POPULATED_SECRET_VALUE,
} from './populated-run-fixture.js'
import { cleanupTempRoots } from './spawned-chat.js'

const CELL_BUDGET_MS = 300_000
const SETTLE_BUDGET_MS = 180_000

afterAll(() => {
  cleanupTempRoots()
})

// Both secret values the fixture owns, planted where the config snapshot copies text verbatim.
function plantSecretsInEnvFile(project: RecordedDoorProject): void {
  writeFileSync(
    join(project.root, '.env'),
    `DOOR_PLANTED_DECLARED=${POPULATED_DECLARED_SECRET_VALUE}\nDOOR_PLANTED_AMBIENT=${POPULATED_SECRET_VALUE}\n`,
    'utf8',
  )
}

async function plantedProject(label: string): Promise<RecordedDoorProject> {
  const project = await recordedDoorProject(label)
  plantSecretsInEnvFile(project)
  return project
}

function transcript(outcome: CliRunOutcome): string {
  return `exit ${String(outcome.status)}\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`
}

/** The `run_artifacts.payload` column exactly as SQLite holds it. */
function rawArtifactColumn(db: DashboardDatabase, runId: string): string {
  const handle = (db as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): unknown } } }).db
  const row = handle.prepare('SELECT payload FROM run_artifacts WHERE run_id = ?').get(runId) as { payload?: string } | undefined
  expect(row?.payload, `run ${runId} has a run_artifacts row`).toBeTypeOf('string')
  return row!.payload!
}

function allRawArtifactColumns(db: DashboardDatabase): Array<{ runId: string; payload: string }> {
  const handle = (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
  return handle.prepare('SELECT run_id AS runId, payload FROM run_artifacts').all() as Array<{ runId: string; payload: string }>
}

function withProjectDb<T>(project: RecordedDoorProject, read: (db: DashboardDatabase) => T): T {
  const db = new DashboardDatabase({ dbPath: dashboardDbPath(project) })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

interface ArtifactRead {
  readonly status: number
  readonly body: { missingSections?: string[]; artifact?: { payload?: Record<string, any> } }
  readonly text: string
}

async function readArtifactRoute(origin: string, runId: string): Promise<ArtifactRead> {
  const response = await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/artifact`)
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as ArtifactRead['body'], text }
}

function expectTestCaptured(
  project: RecordedDoorProject,
  stored: Record<string, any>,
  route: ArtifactRead,
  context: string,
): void {
  const testFile = readFileSync(join(project.root, project.testPath), 'utf8')
  const testName = /^name: (.+)$/mu.exec(testFile)?.[1]
  expect(route.status, `GET artifact: ${route.text}`).toBe(200)
  expect(route.body.missingSections, `missingSections ${context}\n${route.text.slice(0, 2_000)}`).toEqual([])
  expect(stored.source?.loadStatus, `stored source.loadStatus ${context}`).toBe('loaded')
  // 441-58 (D-18): the run's redactor records a `{{secret:x}}` reference as `[secret:x]`.
  const recordedTestFile = testFile.replace(/\{\{secret:(\w+)\}\}/gu, '[secret:$1]')
  expect(stored.source?.rawYaml, `stored source.rawYaml is the test file's bytes ${context}`).toBe(recordedTestFile)
  expect(stored.source?.resolvedDefinition?.name, `resolved definition ${context}`).toBe(testName)
  expect(stored.config?.effectiveConfig, `effective config ${context}`).toBeTypeOf('object')
  expect(stored.config?.rawConfigContent, `config as written ${context}`).toBe(readFileSync(project.configPath, 'utf8'))
  expect(stored.config?.model?.planner, `model ${context}`).toBeTypeOf('object')
  expect(stored.config?.runtime?.platform, `runtime ${context}`).toBe('web')
}

function expectNoSecretStored(raw: string, label: string): void {
  expect(raw.includes(POPULATED_DECLARED_SECRET_VALUE), `the declared secret is IN CLEAR in run_artifacts.payload (${label})`)
    .toBe(false)
}

function expectPlantedLineMasked(raw: string, label: string): void {
  const stored = JSON.parse(raw) as Record<string, any>
  const envContent = stored.config?.envFile?.content as string | undefined
  expect(envContent, `the stored config carries the env file as written (${label})`).toBeTypeOf('string')
  expect(envContent, `the planted declared value is its marker (${label})`)
    .toContain(`DOOR_PLANTED_DECLARED=[secret:${POPULATED_SECRET_NAME}]`)
  // 441-58 (D-01, D-12): an environment credential is not a declared secret, so it is recorded as written.
  expect(envContent, `the planted ambient value is recorded as written (${label})`)
    .toContain(`DOOR_PLANTED_AMBIENT=${POPULATED_SECRET_VALUE}`)
}

async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return check()
}

describe('C433-ARTIFACT-CAPTURED: the CLI door', () => {
  let project: RecordedDoorProject
  let suiteProject: RecordedDoorProject
  let outcome: CliRunOutcome
  let suiteOutcome: CliRunOutcome

  beforeAll(async () => {
    project = await plantedProject('artifact-cli-test')
    outcome = await spawnCliRun(project, ['run', project.testPath])
    suiteProject = await plantedProject('artifact-cli-suite')
    suiteOutcome = await spawnCliRun(suiteProject, ['run', '--suite', suiteProject.suitePath])
  }, CELL_BUDGET_MS * 2)

  afterAll(async () => {
    await project?.close()
    await suiteProject?.close()
  })

  it('C433-ARTIFACT-CAPTURED: the CLI door stores the test as written and the effective config', async () => {
    const ids = runStoreIds(project)
    expect(ids, `one run\n${transcript(outcome)}`).toHaveLength(1)
    const runId = ids[0]!
    const stored = JSON.parse(withProjectDb(project, (db) => rawArtifactColumn(db, runId))) as Record<string, any>
    const scene = await openDashboardScene(project)
    try {
      expectTestCaptured(project, stored, await readArtifactRoute(scene.origin, runId), `(CLI door, ${runId})`)
    } finally {
      await scene.close()
    }
  }, CELL_BUDGET_MS)

  it('C433-ARTIFACT-CAPTURED: a CLI suite run stores the suite as written, masked', () => {
    const ids = runStoreIds(suiteProject)
    expect(ids, `one run\n${transcript(suiteOutcome)}`).toHaveLength(1)
    const raw = withProjectDb(suiteProject, (db) => rawArtifactColumn(db, ids[0]!))
    const stored = JSON.parse(raw) as Record<string, any>
    expect(stored.source?.kind).toBe('suite')
    expect(stored.source?.rawYaml).toBe(readFileSync(join(suiteProject.root, suiteProject.suitePath), 'utf8'))
    expect(stored.config?.effectiveConfig).toBeTypeOf('object')
    expectNoSecretStored(raw, 'CLI suite path')
    expectPlantedLineMasked(raw, 'CLI suite path')
  })

  it('C433-ARTIFACT-CAPTURED: no declared secret value is stored — CLI door', () => {
    const rows = withProjectDb(project, (db) => allRawArtifactColumns(db))
    expect(rows.length, `the CLI run wrote an artifact\n${transcript(outcome)}`).toBeGreaterThan(0)
    for (const row of rows) expectNoSecretStored(row.payload, `CLI door ${row.runId}`)
    expectPlantedLineMasked(rows[0]!.payload, `CLI door ${rows[0]!.runId}`)
  })
})

describe('C433-ARTIFACT-CAPTURED: the dashboard door', () => {
  let project: RecordedDoorProject
  let scene: DashboardScene
  let testRunId: string
  let suiteRunId: string
  const priorAmbient = process.env[POPULATED_SECRET_ENV_VAR]

  async function trigger(file: string): Promise<string> {
    const response = await fetch(`${scene.origin}/api/runs/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file }),
    })
    const body = await response.json() as { runId?: string; error?: string }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    expect(body.runId).toBeTypeOf('string')
    const runId = body.runId!
    expect(
      await waitFor(() => scene.settled.some((entry) => entry.runId === runId), SETTLE_BUDGET_MS),
      `the dashboard run ${runId} never settled`,
    ).toBe(true)
    // The ingest finalizes on the subscriber flush; the artifact is read once it is sealed.
    await waitFor(() => Boolean(scene.db.getRunArtifact(runId)?.finalizedAt), 30_000)
    return runId
  }

  beforeAll(async () => {
    // The env value is in this process's environment and is recorded as written (441-58, D-12).
    process.env[POPULATED_SECRET_ENV_VAR] = POPULATED_SECRET_VALUE
    project = await plantedProject('artifact-dashboard')
    scene = await openDashboardScene(project)
    testRunId = await trigger(project.testPath)
    suiteRunId = await trigger(project.suitePath)
  }, CELL_BUDGET_MS * 2)

  afterAll(async () => {
    await scene?.close()
    await project?.close()
    if (priorAmbient === undefined) delete process.env[POPULATED_SECRET_ENV_VAR]
    else process.env[POPULATED_SECRET_ENV_VAR] = priorAmbient
  })

  it('C433-ARTIFACT-CAPTURED: the dashboard door replaces the queued source', async () => {
    const raw = rawArtifactColumn(scene.db, testRunId)
    const stored = JSON.parse(raw) as Record<string, any>
    expectTestCaptured(project, stored, await readArtifactRoute(scene.origin, testRunId), `(dashboard door, ${testRunId})`)
    expect(raw.includes('"loadStatus":"queued"'), 'no queued source remains').toBe(false)
  })

  it('C433-ARTIFACT-CAPTURED: a dashboard suite run stores the suite\'s source', async () => {
    const stored = JSON.parse(rawArtifactColumn(scene.db, suiteRunId)) as Record<string, any>
    const route = await readArtifactRoute(scene.origin, suiteRunId)
    expect(route.body.missingSections, route.text.slice(0, 2_000)).toEqual([])
    expect(stored.source?.kind).toBe('suite')
    expect(stored.source?.loadStatus).toBe('loaded')
    expect(stored.source?.rawYaml).toBe(readFileSync(join(project.root, project.suitePath), 'utf8'))
    expect(stored.config?.effectiveConfig).toBeTypeOf('object')
  })

  it('C433-ARTIFACT-CAPTURED: no declared secret value is stored — dashboard door', async () => {
    for (const runId of [testRunId, suiteRunId]) {
      const raw = rawArtifactColumn(scene.db, runId)
      expectNoSecretStored(raw, `dashboard door ${runId}`)
      expectPlantedLineMasked(raw, `dashboard door ${runId}`)
    }
    const route = await readArtifactRoute(scene.origin, testRunId)
    const displayed = route.body.artifact?.payload ?? {}
    expect(displayed.source?.name, 'the drawer still shows the test name').toBeTypeOf('string')
    expect(displayed.config?.effectiveConfig, 'the drawer still shows the effective config').toBeTypeOf('object')
    expect(displayed.config?.model?.planner, 'the drawer still shows the model').toBeTypeOf('object')
  })
})
