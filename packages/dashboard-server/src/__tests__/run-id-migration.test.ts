import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
import { createBetterSqlite3Database } from '@vostride/agent-qa-core'
import { DashboardDatabase } from '../db/database.js'
import { migrateWorkspaceRunIds } from '../db/run-id-migration.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

function expectCanonicalRunId(id: string): void {
  expect(isCanonicalRunId(id)).toBe(true)
}

async function createMigrationFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-id-migration-'))
  tempDirs.push(rootDir)

  const workspaceDir = join(rootDir, '.agent-qa')
  const artifactsDir = join(workspaceDir, 'artifacts')
  const screenshotsDir = join(artifactsDir, 'screenshots')
  const videosDir = join(artifactsDir, 'videos')
  const dbPath = join(workspaceDir, 'dashboard.db')

  await mkdir(screenshotsDir, { recursive: true })
  await mkdir(videosDir, { recursive: true })

  const db = new DashboardDatabase({ dbPath })

  const standaloneRunId = 'legacy-standalone-run'
  const suiteParentRunId = 'legacy-suite-parent-run'
  const suiteChildRunId = 'legacy-suite-child-run'

  db.insertRun({
    id: standaloneRunId,
    name: 'Standalone Run',
    status: 'passed',
    duration: 1100,
    startedAt: '2026-04-20T00:00:00Z',
    endedAt: '2026-04-20T00:00:01Z',
    videoPath: join(videosDir, 'flat-video.webm'),
  })
  db.insertRun({
    id: suiteParentRunId,
    name: 'Suite Parent',
    status: 'passed',
    duration: 2200,
    startedAt: '2026-04-20T00:01:00Z',
    endedAt: '2026-04-20T00:01:02Z',
    suiteId: 'suite-smoke',
  })
  db.insertRun({
    id: suiteChildRunId,
    name: 'Suite Child',
    status: 'failed',
    duration: 1300,
    startedAt: '2026-04-20T00:01:10Z',
    endedAt: '2026-04-20T00:01:11Z',
    parentRunId: suiteParentRunId,
    videoPath: join(videosDir, suiteChildRunId, 'nested-video.webm'),
    testId: 'test-login',
    suiteId: 'suite-smoke',
  })

  const standaloneStepId = db.insertStep({
    id: 'step-standalone',
    runId: standaloneRunId,
    name: 'Standalone step',
    status: 'passed',
    duration: 100,
    stepOrder: 0,
    screenshotPath: `${standaloneRunId}/0-step.png`,
    screenshotBeforePath: `${standaloneRunId}/0-step-before.png`,
    healingScreenshotPaths: [
      `${standaloneRunId}/0-healing-0.png`,
      `${standaloneRunId}/0-missing-healing.png`,
    ],
  })

  db.insertStep({
    id: 'step-suite-child',
    runId: suiteChildRunId,
    name: 'Suite child step',
    status: 'failed',
    duration: 150,
    stepOrder: 0,
    screenshotPath: `${suiteChildRunId}/0-suite-step.png`,
    screenshotBeforePath: `${suiteChildRunId}/0-suite-step-before.png`,
  })

  db.insertLogs([
    {
      id: 'log-standalone',
      stepId: standaloneStepId,
      runId: standaloneRunId,
      level: 'info',
      source: 'runner',
      message: 'Standalone log',
      data: { ok: true },
      timestamp: '2026-04-20T00:00:00Z',
    },
    {
      id: 'log-suite-child',
      stepId: 'step-suite-child',
      runId: suiteChildRunId,
      level: 'error',
      source: 'hook',
      message: 'Suite child log',
      data: { ok: false },
      timestamp: '2026-04-20T00:01:10Z',
    },
  ])

  db.insertExecutionLog({
    id: 'exec-standalone',
    runId: standaloneRunId,
    stepId: standaloneStepId,
    type: 'hook',
    name: 'setup-env',
    phase: 'setup',
    status: 'passed',
    duration: 20,
    stdout: 'ok',
  })
  db.insertExecutionLog({
    id: 'exec-suite-child',
    runId: suiteChildRunId,
    stepId: 'step-suite-child',
    type: 'runjs',
    name: 'inline-script',
    phase: 'inline',
    status: 'failed',
    duration: 30,
    stderr: 'bad',
  })
  db.close()

  await mkdir(join(screenshotsDir, standaloneRunId), { recursive: true })
  await mkdir(join(screenshotsDir, suiteChildRunId), { recursive: true })
  await mkdir(join(videosDir, suiteChildRunId), { recursive: true })
  await writeFile(join(screenshotsDir, standaloneRunId, '0-step.png'), 'step')
  await writeFile(join(screenshotsDir, standaloneRunId, '0-step-before.png'), 'before')
  await writeFile(join(screenshotsDir, standaloneRunId, '0-healing-0.png'), 'healing')
  await writeFile(join(screenshotsDir, suiteChildRunId, '0-suite-step.png'), 'suite-step')
  await writeFile(join(screenshotsDir, suiteChildRunId, '0-suite-step-before.png'), 'suite-before')
  await writeFile(join(videosDir, 'flat-video.webm'), 'flat-video')
  await writeFile(join(videosDir, suiteChildRunId, 'nested-video.webm'), 'nested-video')

  return {
    dbPath,
    screenshotsDir,
    videosDir,
    standaloneRunId,
    suiteParentRunId,
    suiteChildRunId,
  }
}

describe('migrateWorkspaceRunIds', () => {
  it('rewrites run-linked tables and artifacts while tolerating missing files', { timeout: 30_000 }, async () => {
    const fixture = await createMigrationFixture()

    const result = await migrateWorkspaceRunIds({
      dbPath: fixture.dbPath,
      screenshotsDir: fixture.screenshotsDir,
      videosDir: fixture.videosDir,
    })

    expect(result.totalRunCount).toBe(3)
    expect(result.migratedRunCount).toBe(3)
    expect(Object.keys(result.runIdMap)).toEqual([
      fixture.standaloneRunId,
      fixture.suiteParentRunId,
      fixture.suiteChildRunId,
    ])

    const migratedStandaloneRunId = result.runIdMap[fixture.standaloneRunId]
    const migratedSuiteParentRunId = result.runIdMap[fixture.suiteParentRunId]
    const migratedSuiteChildRunId = result.runIdMap[fixture.suiteChildRunId]
    expectCanonicalRunId(migratedStandaloneRunId)
    expectCanonicalRunId(migratedSuiteParentRunId)
    expectCanonicalRunId(migratedSuiteChildRunId)

    const db = createBetterSqlite3Database(fixture.dbPath)
    try {
      const runs = db.prepare('SELECT id, parent_run_id, video_path FROM runs ORDER BY rowid ASC').all() as Array<{
        id: string
        parent_run_id: string | null
        video_path: string | null
      }>
      expect(runs).toHaveLength(3)
      for (const run of runs) {
        expectCanonicalRunId(run.id)
      }
      expect(runs.find((run) => run.id === migratedSuiteChildRunId)?.parent_run_id).toBe(migratedSuiteParentRunId)

      const stepRows = db.prepare('SELECT run_id, screenshot_path, screenshot_before_path, healing_screenshot_paths FROM steps ORDER BY rowid ASC').all() as Array<{
        run_id: string
        screenshot_path: string | null
        screenshot_before_path: string | null
        healing_screenshot_paths: string | null
      }>
      expect(stepRows.map((row) => row.run_id)).toEqual([
        migratedStandaloneRunId,
        migratedSuiteChildRunId,
      ])
      expect(stepRows[0].screenshot_path).toBe(`${migratedStandaloneRunId}/0-step.png`)
      expect(stepRows[0].screenshot_before_path).toBe(`${migratedStandaloneRunId}/0-step-before.png`)
      expect(stepRows[0].healing_screenshot_paths).toContain(`${migratedStandaloneRunId}/0-healing-0.png`)
      expect(stepRows[0].healing_screenshot_paths).toContain(`${migratedStandaloneRunId}/0-missing-healing.png`)
      expect(stepRows[1].screenshot_path).toBe(`${migratedSuiteChildRunId}/0-suite-step.png`)

      const logRunIds = db.prepare('SELECT run_id FROM logs ORDER BY rowid ASC').all() as Array<{ run_id: string }>
      expect(logRunIds.map((row) => row.run_id)).toEqual([
        migratedStandaloneRunId,
        migratedSuiteChildRunId,
      ])

      const executionLogRunIds = db.prepare('SELECT run_id FROM execution_logs ORDER BY rowid ASC').all() as Array<{ run_id: string }>
      expect(executionLogRunIds.map((row) => row.run_id)).toEqual([
        migratedStandaloneRunId,
        migratedSuiteChildRunId,
      ])

      const migratedFlatVideoPath = runs.find((run) => run.id === migratedStandaloneRunId)?.video_path
      const migratedNestedVideoPath = runs.find((run) => run.id === migratedSuiteChildRunId)?.video_path
      expect(migratedFlatVideoPath).toBe(`${migratedStandaloneRunId}/flat-video.webm`)
      expect(migratedNestedVideoPath).toBe(join(fixture.videosDir, migratedSuiteChildRunId, 'nested-video.webm'))

      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally {
      db.close()
    }

    await access(join(fixture.screenshotsDir, migratedStandaloneRunId, '0-step.png'))
    await access(join(fixture.screenshotsDir, migratedStandaloneRunId, '0-step-before.png'))
    await access(join(fixture.screenshotsDir, migratedStandaloneRunId, '0-healing-0.png'))
    await access(join(fixture.screenshotsDir, migratedSuiteChildRunId, '0-suite-step.png'))
    await access(join(fixture.screenshotsDir, migratedSuiteChildRunId, '0-suite-step-before.png'))
    await expect(access(join(fixture.videosDir, 'flat-video.webm'))).rejects.toMatchObject({ code: 'ENOENT' })
    await access(join(fixture.videosDir, migratedStandaloneRunId, 'flat-video.webm'))
    await access(join(fixture.videosDir, migratedSuiteChildRunId, 'nested-video.webm'))

    expect(result.renamedScreenshotDirs).toEqual([
      {
        from: join(fixture.screenshotsDir, fixture.standaloneRunId),
        to: join(fixture.screenshotsDir, migratedStandaloneRunId),
      },
      {
        from: join(fixture.screenshotsDir, fixture.suiteChildRunId),
        to: join(fixture.screenshotsDir, migratedSuiteChildRunId),
      },
    ])
    expect(result.renamedVideoDirs).toEqual([
      {
        from: join(fixture.videosDir, fixture.suiteChildRunId),
        to: join(fixture.videosDir, migratedSuiteChildRunId),
      },
    ])
    expect(result.missingArtifacts).toContain(join(fixture.screenshotsDir, fixture.suiteParentRunId))
  })

  it('keeps external absolute video paths unchanged', { timeout: 30_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-id-migration-external-'))
    tempDirs.push(rootDir)
    const workspaceDir = join(rootDir, '.agent-qa')
    const artifactsDir = join(workspaceDir, 'artifacts')
    const videosDir = join(artifactsDir, 'videos')
    const externalDir = join(rootDir, 'external-videos')
    const externalVideo = join(externalDir, 'outside.webm')
    const dbPath = join(workspaceDir, 'dashboard.db')

    await mkdir(videosDir, { recursive: true })
    await mkdir(externalDir, { recursive: true })
    await writeFile(externalVideo, 'outside-video')

    const db = new DashboardDatabase({ dbPath })
    db.insertRun({
      id: 'legacy-external-video-run',
      name: 'External Video',
      status: 'passed',
      duration: 10,
      startedAt: '2026-04-20T00:00:00Z',
      endedAt: '2026-04-20T00:00:01Z',
      videoPath: externalVideo,
    })
    db.close()

    const result = await migrateWorkspaceRunIds({
      dbPath,
      videosDir,
    })
    const migratedRunId = result.runIdMap['legacy-external-video-run']

    const migratedDb = createBetterSqlite3Database(dbPath)
    try {
      const run = migratedDb.prepare('SELECT id, video_path FROM runs').get() as { id: string; video_path: string }
      expect(run.id).toBe(migratedRunId)
      expect(run.video_path).toBe(externalVideo)
    } finally {
      migratedDb.close()
    }
    await access(externalVideo)
  })
})
