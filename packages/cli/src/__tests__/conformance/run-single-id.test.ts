// A run without `AGENT_QA_RUN_ID` has one id in the run store, the runs.db row and CLI output.

import { generateRunId } from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  dashboardRunRows,
  printedRunIds,
  recordedDoorProject,
  runStoreEvents,
  runStoreIds,
  spawnCliRun,
  type CliRunOutcome,
  type RecordedDoorProject,
} from './run-doors-fixture.js'
import { populatedRunSpawnEnv } from './populated-run-fixture.js'
import { cleanupTempRoots, reserveEphemeralPort, spawnDashboard } from './spawned-chat.js'

const CELL_BUDGET_MS = 300_000

afterAll(() => {
  cleanupTempRoots()
})

function transcript(outcome: CliRunOutcome): string {
  return `exit ${String(outcome.status)}\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`
}

function expectOneId(project: RecordedDoorProject, outcome: CliRunOutcome): string {
  const storeIds = runStoreIds(project)
  expect(storeIds, `the run store holds exactly one run\n${transcript(outcome)}`).toHaveLength(1)
  const runId = storeIds[0]!
  expect(dashboardRunRows(project).map((row) => row.id), 'the dashboard database files the run under the store id').toEqual([runId])
  const printed = printedRunIds(`${outcome.stdout}\n${outcome.stderr}`)
  expect(printed.length, `the CLI prints the run id\n${transcript(outcome)}`).toBeGreaterThan(0)
  expect(printed, 'every run id the CLI prints is the store id').toEqual([runId])
  return runId
}

describe('the CLI test path', () => {
  let project: RecordedDoorProject
  let outcome: CliRunOutcome

  beforeAll(async () => {
    project = await recordedDoorProject('run-one-id-test')
    outcome = await spawnCliRun(project, ['run', project.testPath])
  }, CELL_BUDGET_MS)

  afterAll(async () => {
    await project?.close()
  })

  it('a CLI test run has one id in the run store, the dashboard and the CLI output', () => {
    expectOneId(project, outcome)
  })

  it('the overview reads the recording the run store holds', async () => {
    const runId = runStoreIds(project)[0]!
    const finished = runStoreEvents(project, runId).find(
      (event) => event.type === 'testFinished' && (event.payload as { testIndex?: number }).testIndex === 0,
    )
    const storeRecording = (finished?.payload as { recording?: { state?: string } } | undefined)?.recording
    expect(storeRecording?.state, `the run store records the member's recording\n${transcript(outcome)}`).toBe('present')

    const overview = await spawnCliRun(project, ['runs', 'overview', runId, '--json'], { budgetMs: 60_000 })
    expect(overview.status, transcript(overview)).toBe(0)
    const document = JSON.parse(overview.stdout) as { tests?: Array<{ recording?: { state?: string; reason?: string } }> }
    const read = document.tests?.[0]?.recording
    expect(read, `the overview under the printed id reads the store recording: ${JSON.stringify(read)}`).toMatchObject({
      state: storeRecording?.state,
    })
  }, CELL_BUDGET_MS)

  it('the dashboard answers the printed id', async () => {
    const runId = runStoreIds(project)[0]!
    const dashboard = await spawnDashboard(project.root, project.configPath, await reserveEphemeralPort(), 60_000,
      populatedRunSpawnEnv())
    try {
      expect(dashboard.ready, `the dashboard started\n${dashboard.stderr()}`).toBe(true)
      const run = await fetch(`${dashboard.origin}/api/runs/${runId}`)
      const runBody = await run.text()
      expect(run.status, `GET /api/runs/${runId}: ${runBody}`).toBe(200)
      const marks = await fetch(`${dashboard.origin}/api/runs/${runId}/marks`)
      const marksBody = await marks.text()
      expect(marksBody, `GET /api/runs/${runId}/marks (${String(marks.status)})`).not.toContain('run-not-found')
    } finally {
      await dashboard.stop()
    }
  }, CELL_BUDGET_MS)
})

describe('the CLI suite path', () => {
  let project: RecordedDoorProject

  beforeAll(async () => {
    project = await recordedDoorProject('run-one-id-suite')
  }, CELL_BUDGET_MS)

  afterAll(async () => {
    await project?.close()
  })

  it('a CLI suite run has one id', async () => {
    const outcome = await spawnCliRun(project, ['run', '--suite', project.suitePath])
    expectOneId(project, outcome)
  }, CELL_BUDGET_MS)
})

describe('an environment-supplied id', () => {
  let project: RecordedDoorProject

  beforeAll(async () => {
    project = await recordedDoorProject('run-one-id-env')
  }, CELL_BUDGET_MS)

  afterAll(async () => {
    await project?.close()
  })

  it('AGENT_QA_RUN_ID is still the run\'s id', async () => {
    const supplied = generateRunId()
    const outcome = await spawnCliRun(project, ['run', project.testPath], { env: { AGENT_QA_RUN_ID: supplied } })
    expect(expectOneId(project, outcome)).toBe(supplied)
  }, CELL_BUDGET_MS)
})
