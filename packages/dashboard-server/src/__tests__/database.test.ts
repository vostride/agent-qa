import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DashboardDatabase, runSqliteMigrations } from '../db/database.js'
import type { RunOwnership } from '../db/run-owner.js'
import { createDashboardSqliteDatabase } from '../db/sqlite.js'
import { SCHEMA_VERSION, MIGRATIONS } from '../db/schema.js'
import { RUN_ARTIFACT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

let db: DashboardDatabase
const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
})

afterEach(() => {
  db.close()
})

function insertSampleRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Login Test',
    filePath: 'tests/login.yaml',
    status: 'passed',
    duration: 5000,
    attributes: { 'git.branch': 'phase223-main', 'myCustomKey.xx': 'custom-123' },
    startedAt: '2026-03-01T10:00:00Z',
    endedAt: '2026-03-01T10:00:05Z',
    ...overrides,
  })
}

function columnNames(tableName: string): string[] {
  const columns = db['db'].prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.map((column) => column.name)
}

describe('DashboardDatabase', () => {
  it('closes the connection it opened when the file is not a database, so a retried open leaks nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-db-open-failure-'))
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      const dbPath = join(dir, 'runs.db')
      writeFileSync(dbPath, 'not a database\n')
      expect(() => new DashboardDatabase({ dbPath })).toThrow(/not a database/)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('SUITE-DURATION-READ projects complete member work for detail and paginated lists without rewriting history', () => {
    const durations = [31631.826750000007, 38765.66812499997, 35742.61929200002]
    const id = insertSampleRun({ duration: durations[2], parallel: true })
    for (const [testIndex, durationMs] of durations.entries()) {
      db.upsertRunMember({ runId: id, testIndex, durationMs, outcome: 'passed' })
    }
    const before = db.readRunDetailRows(id)
    expect(db.getRun(id)?.duration).toBeCloseTo(106140.114167, 7)
    expect(db.getRuns({ limit: 1 })[0].duration).toBeCloseTo(106140.114167, 7)
    expect(db['db'].prepare('SELECT duration FROM runs WHERE id = ?').get(id)).toEqual({ duration: durations[2] })
    expect(db.readRunDetailRows(id)).toEqual(before)
    db.upsertRunMember({ runId: id, testIndex: 1, durationMs: 0 })
    expect(db.getRun(id)?.duration).toBe(durations[0] + durations[2])
    db.upsertRunMember({ runId: id, testIndex: 3 })
    expect(db.getRun(id)?.duration).toBe(durations[2]) // Incomplete legacy projection: stored fallback.
    const zero = insertSampleRun({ duration: 123 })
    db.upsertRunMember({ runId: zero, testIndex: 0, durationMs: 0 })
    expect(db.getRun(zero)?.duration).toBe(0)
    expect(db.getRuns().find(run => run.id === zero)?.duration).toBe(0)
    expect(db.getRun(insertSampleRun({ duration: 42 }))?.duration).toBe(42)
  })

  describe('schema creation', () => {
    // `MIGRATIONS` is the ONE terminal entry stamped at `SCHEMA_VERSION`: no database is migrated
    // from another shape (any other stamp is refused by name), so a chain of intermediate versions
    // would be sql nothing can ever walk.
    it('SCHEMA_VERSION is 2', () => {
      expect(SCHEMA_VERSION).toBe(2)
    })

    it('MIGRATIONS is exactly one entry, stamped at the current schema version', () => {
      expect(MIGRATIONS).toHaveLength(1)
      expect(MIGRATIONS[0].version).toBe(SCHEMA_VERSION)
    })

    it('creates all expected tables', () => {
      const tables = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
      const names = tables.map(t => t.name)
      expect(names).toContain('runs')
      expect(names).toContain('execution_logs')
      expect(names).toContain('token_events')
      expect(names).toContain('run_artifacts')
      // the v2 bus-shaped projection.
      expect(names).toContain('run_members')
      expect(names).toContain('run_steps')
      expect(names).toContain('run_sub_actions')
      // the three v1 projection tables the census deleted. Each needle is built from
      // two halves so this assertion cannot be the hit that satisfies the D-21 grep-clean
      // inventory — a pin that matches ITSELF is a pin that proves nothing.
      expect(names).not.toContain('ste' + 'ps')
      expect(names).not.toContain('reasoning_' + 'traces')
      expect(names).not.toContain('lo' + 'gs')
    })

    it('sets user_version to the current schema version after migrations', () => {
      const version = db['db'].pragma('user_version', { simple: true })
      expect(version).toBe(SCHEMA_VERSION)
    })

    // the v2 runs shape after the census. Five columns left with their
    // readers — the recording path (no producer at all, D-14) and the four parent/attempt/retry
    // columns (nothing has written a child run row since 402-09 put one row per run).
    it('creates the current final runs columns directly at v2', () => {
      expect(columnNames('runs')).toEqual([
        'id',
        'name',
        'file_path',
        'status',
        'priority',
        'duration',
        'attributes',
        'environment',
        'metadata',
        'started_at',
        'ended_at',
        'created_at',
        'failure_summary',
        'platform',
        'test_file_content',
        'model_name',
        'llm_provider',
        'parallel',
        'error_log',
        'test_id',
        'suite_id',
        'owner_pid',
        'owner_incarnation',
        'owner_host',
      ])
      const names = columnNames('runs')
      expect(names).not.toContain('automation_name')
      expect(names).not.toContain('matrix_label')
      expect(names).not.toContain('matrix_config')
      // Split needles, for the reason given on the table pin above.
      expect(names).not.toContain('video_' + 'path')
      expect(names).not.toContain('parent_run' + '_id')
      expect(names).not.toContain('attempt_' + 'number')
      expect(names).not.toContain('max_' + 'retries')
    })

    it('creates the current final auxiliary table shapes directly at v2', () => {
      expect(columnNames('execution_logs')).toEqual([
        'id',
        'run_id',
        'step_id',
        'type',
        'name',
        'phase',
        'status',
        'duration',
        'stdout',
        'stderr',
        'return_data',
        'variables',
        'created_at',
        'hook_id',
        // where in the run tree the hook ran; NULL means run-scoped.
        'test_index',
        'step_index',
      ])
      expect(columnNames('token_events')).toEqual(['id', 'model_name', 'prompt_tokens', 'completion_tokens', 'source', 'created_at'])
      expect(columnNames('run_artifacts')).toEqual([
        'run_id',
        'kind',
        'schema_version',
        'payload',
        'finalized_at',
        'created_at',
        'updated_at',
      ])
    })

    it('sets busy_timeout to 5000ms', () => {
      const timeout = db['db'].pragma('busy_timeout', { simple: true })
      expect(timeout).toBe(5000)
    })

    it('uses .agent-qa/runs.db as the default database path', () => {
      const workspaceDir = mkdtempSync(join(tmpdir(), 'agent-qa-dashboard-db-default-'))
      const originalCwd = process.cwd()
      let defaultDb: DashboardDatabase | undefined
      try {
        process.chdir(workspaceDir)
        defaultDb = new DashboardDatabase()
        defaultDb.close()
        expect(existsSync(join(workspaceDir, '.agent-qa', 'runs.db'))).toBe(true)
      } finally {
        defaultDb?.close()
        process.chdir(originalCwd)
        rmSync(workspaceDir, { recursive: true, force: true })
      }
    })

    it('creates all expected indexes', () => {
      const indexes = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as { name: string }[]
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_runs_status')
      expect(names).toContain('idx_runs_started_at')
      expect(names).toContain('idx_runs_name')

      expect(names).not.toContain('idx_runs_source')
      expect(names).toContain('idx_runs_queue')
      expect(names).toContain('idx_run_members_run')
      expect(names).toContain('idx_run_steps_run')
      expect(names).toContain('idx_run_sub_actions_run')
      expect(names).toContain('idx_run_artifacts_kind')
      expect(names).toContain('idx_run_artifacts_finalized')
    })

    it('adds hook_id to execution_logs', () => {
      const columns = db['db'].prepare('PRAGMA table_info(execution_logs)').all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toContain('hook_id')
    })

    it('stores canonical run attributes without source or tags columns', () => {
      const columns = db['db'].prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
      const names = columns.map((column) => column.name)
      expect(names).toContain('attributes')
      expect(names).not.toContain('tags')
      expect(names).not.toContain('source')
    })
  })

  describe('generic migration infrastructure', () => {
    // the two cells that stood here asserted a WALKABLE CHAIN —
    // "applies future migrations after the current user_version" and "skips migrations at or
    // below it". Both described a shape this build no longer has and, worse, the second one
    // described the exact behaviour RESEARCH Pitfall 4 names as a silent corruption: a database
    // at version 1 being carried forward by re-running `CREATE TABLE IF NOT EXISTS` over the old
    // wide shape. What replaces them is the contract that replaced the chain.

    it('applies the single terminal migration to a fresh database', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        runSqliteMigrations(raw, [
          {
            version: 2,
            sql: [
              'CREATE TABLE future_baseline (id TEXT PRIMARY KEY, label TEXT)',
              'CREATE INDEX idx_future_baseline_label ON future_baseline(label)',
            ],
          },
        ], 2)

        const columns = raw.prepare('PRAGMA table_info(future_baseline)').all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).toContain('label')
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_future_baseline_label'").get())
          .toEqual({ name: 'idx_future_baseline_label' })
        expect(raw.pragma('user_version', { simple: true })).toBe(2)
      } finally {
        raw.close()
      }
    })

    it('REFUSES a database stamped at an older version rather than migrating it', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        raw.exec(`
          CREATE TABLE future_baseline (id TEXT PRIMARY KEY);
          PRAGMA user_version = 1;
        `)

        expect(() => runSqliteMigrations(raw, [
          { version: 2, sql: ['CREATE TABLE should_not_run (id TEXT PRIMARY KEY)'] },
        ], 2)).toThrow('Remove the dashboard database')

        // Nothing ran, and the old file is exactly as it was. The alternative — the pre-405
        // behaviour — created the new tables BESIDE the old shape and reported success.
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'should_not_run'").get())
          .toBeUndefined()
        expect(raw.pragma('user_version', { simple: true })).toBe(1)
      } finally {
        raw.close()
      }
    })

    it('refuses a migration set that is not the single terminal entry', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        expect(() => runSqliteMigrations(raw, [
          { version: 1, sql: [] },
          { version: 2, sql: [] },
        ], 2)).toThrow('Expected exactly 1 SQLite migration at version 2')
        // A set whose only runnable entry is stamped at the WRONG version is refused too — an
        // entry below the target would leave the file at a version this build cannot read.
        expect(() => runSqliteMigrations(raw, [{ version: 1, sql: [] }], 2))
          .toThrow('Expected exactly 1 SQLite migration at version 2')
        expect(raw.pragma('user_version', { simple: true })).toBe(0)
      } finally {
        raw.close()
      }
    })

    it('does not apply migrations above the target schema version', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        runSqliteMigrations(raw, [
          {
            version: 1,
            sql: ['CREATE TABLE future_baseline (id TEXT PRIMARY KEY)'],
          },
          {
            version: 2,
            sql: ['CREATE TABLE should_not_run (id TEXT PRIMARY KEY)'],
          },
        ], 1)

        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'future_baseline'").get())
          .toEqual({ name: 'future_baseline' })
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'should_not_run'").get())
          .toBeUndefined()
        expect(raw.pragma('user_version', { simple: true })).toBe(1)
      } finally {
        raw.close()
      }
    })

    it('rejects databases whose user_version is above the supported schema version', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        raw.exec('PRAGMA user_version = 17')

        expect(() => runSqliteMigrations(raw, [
          {
            version: 1,
            sql: ['CREATE TABLE fresh_baseline (id TEXT PRIMARY KEY)'],
          },
        ], 1)).toThrow('SQLite database user_version 17 is not compatible with schema version 1')
      } finally {
        raw.close()
      }
    })

    it('names the versions it found when the set is not the single terminal entry', () => {
      const raw = createDashboardSqliteDatabase(':memory:')
      try {
        // The message carries WHAT IT FOUND, not just what it wanted: a set that is wrong is
        // usually wrong in a way the author can see at a glance from the versions.
        expect(() => runSqliteMigrations(raw, [
          { version: 1, sql: ['SELECT 1'] },
          { version: 3, sql: ['SELECT 1'] },
        ], 3)).toThrow('found 2 at [1, 3]')
        expect(() => runSqliteMigrations(raw, [], 2))
          .toThrow('found 0 at []')
      } finally {
        raw.close()
      }
    })
  })

  describe('insertRun and getRun', () => {
    it('inserts and retrieves a run', () => {
      const id = insertSampleRun()
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.name).toBe('Login Test')
      expect(run!.filePath).toBe('tests/login.yaml')
      expect(run!.status).toBe('passed')
      expect(run!.duration).toBe(5000)
      expect(run!.attributes['git.branch']).toBe('phase223-main')
      expect(run!.attributes['myCustomKey.xx']).toBe('custom-123')
      expect(run!.startedAt).toBe('2026-03-01T10:00:00Z')
    })

    it('generates r_ ids for inserted runs', () => {
      const id = insertSampleRun()
      expect(isCanonicalRunId(id)).toBe(true)
    })

    it('returns undefined for non-existent run', () => {
      expect(db.getRun('non-existent')).toBeUndefined()
    })
  })

  describe('run artifact lifecycle', () => {
    it('inserts, stages, finalizes, and fetches immutable run artifacts', () => {
      const runId = insertSampleRun()

      const inserted = db.insertRunArtifact({
        runId,
        kind: 'test',
        payload: {
          source: {
            kind: 'test',
            testId: 't_login',
            name: 'Login Test',
            filePath: 'tests/login.yaml',
            rawYaml: 'name: Login Test',
            loadStatus: 'loaded',
          },
        },
      })

      expect(inserted.runId).toBe(runId)
      expect(inserted.kind).toBe('test')
      expect(inserted.schemaVersion).toBe(RUN_ARTIFACT_SCHEMA_VERSION)
      expect(inserted.payload.schemaVersion).toBe(RUN_ARTIFACT_SCHEMA_VERSION)
      expect(inserted.payload.source).toMatchObject({ kind: 'test', testId: 't_login' })

      const staged = db.stageRunArtifact(runId, {
        config: { rawConfigContent: 'registry: {}' },
        runtime: { status: 'running', duration: 10 },
      })
      expect(staged.payload.config).toMatchObject({ rawConfigContent: 'registry: {}' })
      expect(staged.payload.runtime).toMatchObject({ status: 'running', duration: 10 })

      const finalized = db.finalizeRunArtifact(runId, {
        runtime: { status: 'passed', duration: 25 },
        errors: [],
      })
      expect(finalized.finalizedAt).toBeTruthy()
      expect(finalized.payload.runtime).toMatchObject({ status: 'passed', duration: 25 })

      expect(() => db.stageRunArtifact(runId, { runtime: { status: 'failed' } }))
        .toThrow(`Run artifact ${runId} is finalized`)

      const finalizedAgain = db.finalizeRunArtifact(runId, {
        runtime: { status: 'failed' },
      })
      expect(finalizedAgain.finalizedAt).toBe(finalized.finalizedAt)
      expect(finalizedAgain.payload.runtime).toMatchObject({ status: 'passed', duration: 25 })
    })

    // the bundle is ONE run's artifact. The cell that stood here seeded
    // a suite parent with a child run row and asserted the bundle carried the child's artifact
    // beside its own. Nothing has written a child run row since 402-09, so the walk it exercised
    // was already structurally empty on every real database — and `children` is gone with it.
    it('answers the run\'s own artifact and nothing beside it, and the row goes with the run', () => {
      const runId = insertSampleRun({ name: 'Smoke suite', suiteId: 's_smoke' })

      db.insertRunArtifact({
        runId,
        kind: 'test',
        payload: { source: { kind: 'test', testId: 't_login', name: 'Login Test', loadStatus: 'loaded' } },
      })

      const bundle = db.getRunArtifactBundle(runId)
      expect(bundle.artifact?.kind).toBe('test')
      expect(Object.keys(bundle)).toEqual(['artifact'])

      const deleted = db.deleteRun(runId)
      expect(deleted.deleted).toBe(true)
      expect(deleted.deletedRunIds).toEqual([runId])
      expect(db.getRunArtifact(runId)).toBeNull()
      expect(db.getRun(runId)).toBeUndefined()
    })

    // The narrowed CHECK (RESEARCH Open Q4): two kinds are all anything mints.
    //
    // THE REFUSAL SURFACES THROUGH THE MEMBER'S POST-CONDITION, not as a raw constraint error, and
    // that is worth pinning rather than papering over: the insert is `INSERT OR IGNORE` — there so
    // a second insert for the same run is a no-op — and OR IGNORE swallows a CHECK failure exactly
    // as it swallows a duplicate key. What makes the refusal visible is the read-back the member
    // does immediately afterwards, which finds no row and throws by name.
    it('refuses a run-artifact kind outside the two the product still mints', () => {
      const runId = insertSampleRun({ name: 'Kind check' })
      expect(() => db.insertRunArtifact({ runId, kind: ('suite-' + 'parent') as never }))
        .toThrow(`Run artifact ${runId} was not created`)
      expect(db.getRunArtifact(runId)).toBeNull()
    })
  })

  describe('execution logs', () => {
    it('stores canonical hook_id on execution logs', () => {
      const runId = insertSampleRun()
      db.insertExecutionLog({
        id: 'hook-exec-1',
        runId,
        type: 'hook',
        name: 'seed-db',
        hookId: HOOK_ID,
        phase: 'setup',
        status: 'passed',
        duration: 50,
        stdout: 'ok',
        stderr: null,
        returnData: null,
        variables: { TOKEN: 'abc' },
      } as any)

      const logs = db.getExecutionLogs({ runId })
      expect(logs).toHaveLength(1)
      expect((logs[0] as any).hookId).toBe(HOOK_ID)
      expect(logs[0].name).toBe('seed-db')
    })
  })

  describe('getRuns filters', () => {
    it('filters by status', () => {
      insertSampleRun({ name: 'Pass 1', status: 'passed' })
      insertSampleRun({ name: 'Fail 1', status: 'failed' })
      insertSampleRun({ name: 'Pass 2', status: 'passed' })

      const passed = db.getRuns({ statuses: ['passed'] })
      expect(passed).toHaveLength(2)
      expect(passed.every(r => r.status === 'passed')).toBe(true)
    })

    it('filters by name (LIKE search)', () => {
      // Explicit ids, because the filter is `name LIKE ? OR id LIKE ?` and a generated run id is
      // ten dictionary words from `id-agent` — one of which is literally "login". Measured over
      // 20k generated ids, 0.21% contain it, so leaving the non-matching row's id to chance made
      // this assert 2-or-3 roughly once every 476 runs. It rolled a 3 on CI on 2026-08-02.
      insertSampleRun({ id: 'run_fixed-alpha', name: 'Login Test' })
      insertSampleRun({ id: 'run_fixed-bravo', name: 'Checkout Test' })
      insertSampleRun({ id: 'run_fixed-charlie', name: 'Login Flow' })

      const results = db.getRuns({ name: 'Login' })
      expect(results).toHaveLength(2)
      expect(results.map(run => run.name).sort()).toEqual(['Login Flow', 'Login Test'])
    })

    it('filters by id through the existing name search', () => {
      const runId = insertSampleRun({ name: 'Completely Different Name' })
      insertSampleRun({ name: 'Another Run' })

      const results = db.getRuns({ name: runId })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(runId)
    })

    it('filters by date range', () => {
      insertSampleRun({ name: 'Old', startedAt: '2026-01-01T00:00:00Z' })
      insertSampleRun({ name: 'Recent', startedAt: '2026-03-01T00:00:00Z' })

      const results = db.getRuns({ from: '2026-02-01T00:00:00Z' })
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Recent')
    })

    it('combines multiple filters', () => {
      insertSampleRun({ name: 'Match', status: 'passed', platform: 'web' })
      insertSampleRun({ name: 'Wrong Status', status: 'failed', platform: 'web' })
      insertSampleRun({ name: 'Wrong Platform', status: 'passed', platform: 'android' })

      const results = db.getRuns({ statuses: ['passed'], platform: 'web' })
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('Match')
    })
  })

  describe('pagination', () => {
    it('limits and offsets results', () => {
      for (let i = 0; i < 5; i++) {
        insertSampleRun({ name: `Test ${i}` })
      }

      const page1 = db.getRuns({ limit: 2 })
      expect(page1).toHaveLength(2)

      const page2 = db.getRuns({ limit: 2, offset: 2 })
      expect(page2).toHaveLength(2)

      const page3 = db.getRuns({ limit: 2, offset: 4 })
      expect(page3).toHaveLength(1)
    })
  })

  describe('stats', () => {
    it('calculates pass rate and avg duration', () => {
      insertSampleRun({ status: 'passed', duration: 4000, startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ status: 'passed', duration: 6000, startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ status: 'failed', duration: 2000, startedAt: '2026-03-01T10:00:00Z' })

      const stats = db.getStats()
      expect(stats.totalRuns).toBe(3)
      expect(stats.passed).toBe(2)
      expect(stats.failed).toBe(1)
      expect(stats.avgDuration).toBe(4000)
    })

    // the flake rate reads `run_steps.self_heal_occurred` now — the bus
    // payload's own boolean, projected verbatim — rather than a status word on a v1 projection with
    // no producer left. Same arithmetic, a fact the runner actually reported.
    it('calculates flake rate from steps a self-heal occurred on', () => {
      const run1 = insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      const run2 = insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      const run3 = insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })

      const healedStep = (runId: string, selfHealOccurred: boolean) => ({
        runId,
        testIndex: 0,
        stepIndex: 0,
        cacheStatus: 'miss',
        verifierVerdict: { pass: true, reasoning: 'ok' },
        selfHealOccurred,
        briefDigest: 'digest',
        status: 'passed',
      })
      db.insertRunStep(healedStep(run1, true))
      db.insertRunStep(healedStep(run2, true))
      db.insertRunStep(healedStep(run3, false))

      const stats = db.getStats()
      expect(stats.flakeRate).toBeCloseTo(2 / 3)
    })

    it('returns daily breakdown', () => {
      insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ status: 'failed', startedAt: '2026-03-01T11:00:00Z' })
      insertSampleRun({ status: 'passed', startedAt: '2026-03-02T10:00:00Z' })

      const stats = db.getStats()
      expect(stats.runs).toHaveLength(2)
      expect(stats.runs[0].date).toBe('2026-03-01')
      expect(stats.runs[0].passed).toBe(1)
      expect(stats.runs[0].failed).toBe(1)
      expect(stats.runs[1].date).toBe('2026-03-02')
      expect(stats.runs[1].passed).toBe(1)
    })

    it('filters stats by date range', () => {
      insertSampleRun({ status: 'passed', startedAt: '2026-01-01T10:00:00Z' })
      insertSampleRun({ status: 'failed', startedAt: '2026-03-01T10:00:00Z' })

      const stats = db.getStats({ from: '2026-02-01T00:00:00Z' })
      expect(stats.totalRuns).toBe(1)
      expect(stats.failed).toBe(1)
    })
  })

  describe('metadata', () => {
    it('stores and retrieves run metadata', () => {
      const id = insertSampleRun({ metadata: { browser: 'chromium', ci: true } })
      const run = db.getRun(id)
      expect(run!.metadata).toEqual({ browser: 'chromium', ci: true })
    })

    it('handles null optional fields', () => {
      const id = db.insertRun({
        name: 'Minimal',
        status: 'passed',
        duration: 1000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      const run = db.getRun(id)
      expect(run!.attributes).toEqual({})
      expect(run!.metadata).toBeNull()
      expect(run!.environment).toBeNull()
    })
  })

  describe('updateRun', () => {
    it('updates status of an existing run', () => {
      const id = insertSampleRun({ status: 'running' })
      db.updateRun(id, { status: 'passed' })
      const run = db.getRun(id)
      expect(run!.status).toBe('passed')
    })

    it('updates duration and endedAt', () => {
      const id = insertSampleRun({ status: 'running', duration: 0 })
      db.updateRun(id, { duration: 12345, endedAt: '2026-03-01T10:05:00Z' })
      const run = db.getRun(id)
      expect(run!.duration).toBe(12345)
      expect(run!.endedAt).toBe('2026-03-01T10:05:00Z')
    })

    it('updates failureSummary', () => {
      const id = insertSampleRun({ status: 'failed' })
      db.updateRun(id, { failureSummary: 'Step 2 failed: element not found' })
      const run = db.getRun(id)
      expect(run!.failureSummary).toBe('Step 2 failed: element not found')
    })

    it('does not modify fields not specified in update', () => {
      const id = insertSampleRun({ name: 'My Test', status: 'running', duration: 0 })
      db.updateRun(id, { status: 'cancelled' })
      const run = db.getRun(id)
      expect(run!.status).toBe('cancelled')
      expect(run!.name).toBe('My Test')
      expect(run!.duration).toBe(0)
    })

    it('is a no-op when called with empty updates', () => {
      const id = insertSampleRun({ status: 'passed' })
      db.updateRun(id, {})
      const run = db.getRun(id)
      expect(run!.status).toBe('passed')
    })
  })

  describe('status values', () => {
    it('allows inserting a run with cancelled status', () => {
      const id = db.insertRun({
        name: 'Cancelled Test',
        status: 'cancelled',
        duration: 3000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:03Z',
      })
      const run = db.getRun(id)
      expect(run!.status).toBe('cancelled')
    })

    it('allows updating a running run to cancelled', () => {
      const id = insertSampleRun({ status: 'running' })
      db.updateRun(id, { status: 'cancelled' })
      const run = db.getRun(id)
      expect(run!.status).toBe('cancelled')
    })

    it('filters runs by cancelled status', () => {
      insertSampleRun({ name: 'Pass', status: 'passed' })
      insertSampleRun({ name: 'Cancel 1', status: 'cancelled' })
      insertSampleRun({ name: 'Cancel 2', status: 'cancelled' })

      const cancelled = db.getRuns({ statuses: ['cancelled'] })
      expect(cancelled).toHaveLength(2)
      expect(cancelled.every(r => r.status === 'cancelled')).toBe(true)
    })
  })

  describe('attributes column', () => {
    it('defaults run attributes to an empty object', () => {
      const id = db.insertRun({
        name: 'Manual Run',
        status: 'passed',
        duration: 1000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      expect(db.getRun(id)!.attributes).toEqual({})
    })

    it('stores and retrieves string-only run attributes', () => {
      const id = db.insertRun({
        name: 'Attributed Run',
        status: 'passed',
        duration: 2000,
        attributes: { 'git.branch': 'phase223-main', 'user.email': 'CI' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:02Z',
      })

      expect(db.getRun(id)!.attributes).toEqual({
        'git.branch': 'phase223-main',
        'user.email': 'CI',
      })
    })

    it('stores attributes for pending runs', () => {
      const id = db.insertPendingRun({
        name: 'Pending Test',
        attributes: { 'git.branch': 'phase223-main' },
      })
      expect(db.getRun(id)!.attributes['git.branch']).toBe('phase223-main')
    })

    it('maps malformed stored attributes to an empty object', () => {
      const id = insertSampleRun()
      db['db'].prepare('UPDATE runs SET attributes = ? WHERE id = ?').run('{bad-json', id)
      expect(db.getRun(id)!.attributes).toEqual({})
    })

    it('filters runs by exact attribute predicates', () => {
      db.insertRun({
        name: 'Main Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      db.insertRun({
        name: 'Dev Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'dev' },
        startedAt: '2026-03-01T11:00:00Z',
        endedAt: '2026-03-01T11:00:01Z',
      })

      const runs = db.getRuns({
        attributePredicates: [{ key: 'git.branch', value: 'phase223-main', mode: 'exact' }],
      })
      expect(runs.map((run) => run.name)).toEqual(['Main Branch'])
    })

    it('filters runs by regex attribute predicates', () => {
      db.insertRun({
        name: 'Main Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'main' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      db.insertRun({
        name: 'Phase Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main' },
        startedAt: '2026-03-01T11:00:00Z',
        endedAt: '2026-03-01T11:00:01Z',
      })
      db.insertRun({
        name: 'Feature Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'feature' },
        startedAt: '2026-03-01T12:00:00Z',
        endedAt: '2026-03-01T12:00:01Z',
      })

      const runs = db.getRuns({
        attributePredicates: [{ key: 'git.branch', value: '^(phase223-main|main)$', mode: 'regex' }],
      })
      expect(runs.map((run) => run.name).sort()).toEqual(['Main Branch', 'Phase Branch'])
    })

    it('does not match predicates when an attribute key is missing', () => {
      db.insertRun({
        name: 'No Branch',
        status: 'passed',
        duration: 100,
        attributes: { 'user.email': 'CI' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })

      const runs = db.getRuns({
        attributePredicates: [{ key: 'git.branch', value: 'phase223-main', mode: 'exact' }],
      })
      expect(runs).toHaveLength(0)
    })

    it('ANDs multiple attribute predicates', () => {
      db.insertRun({
        name: 'Scoped CI',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main', 'user.email': 'CI' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      db.insertRun({
        name: 'Scoped Human',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main', 'user.email': 'dev@example.com' },
        startedAt: '2026-03-01T11:00:00Z',
        endedAt: '2026-03-01T11:00:01Z',
      })

      const runs = db.getRuns({
        attributePredicates: [
          { key: 'git.branch', value: 'phase223-main', mode: 'exact' },
          { key: 'user.email', value: 'CI', mode: 'exact' },
        ],
      })
      expect(runs.map((run) => run.name)).toEqual(['Scoped CI'])
    })

    it('suggests attribute keys and values with counts', () => {
      db.insertRun({
        name: 'Run A',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main', 'user.email': 'CI' },
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
      })
      db.insertRun({
        name: 'Run B',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'phase223-main' },
        startedAt: '2026-03-01T11:00:00Z',
        endedAt: '2026-03-01T11:00:01Z',
      })
      db.insertRun({
        name: 'Run C',
        status: 'passed',
        duration: 100,
        attributes: { 'git.branch': 'main' },
        startedAt: '2026-03-01T12:00:00Z',
        endedAt: '2026-03-01T12:00:01Z',
      })

      expect(db.listRunAttributeKeys({ q: 'git', limit: 50 })).toEqual([
        { key: 'git.branch', count: 3 },
      ])
      expect(db.listRunAttributeValues('git.branch', { q: 'phase', limit: 50 })).toEqual([
        { value: 'phase223-main', count: 2 },
      ])
    })
  })

  describe('pending status and priority', () => {
    it('allows inserting a run with pending status', () => {
      const id = db.insertPendingRun({ name: 'Pending Test' })
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.status).toBe('pending')
      expect(run!.priority).toBe(0)
    })

    it('generates r_ ids for pending runs', () => {
      const id = db.insertPendingRun({ name: 'Pending Test' })
      expect(isCanonicalRunId(id)).toBe(true)
    })

    it('inserts a pending run with custom priority', () => {
      const id = db.insertPendingRun({ name: 'High Priority', priority: 5 })
      const run = db.getRun(id)
      expect(run!.priority).toBe(5)
    })

    it('creates idx_runs_queue index', () => {
      const indexes = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_runs_queue'")
        .all() as { name: string }[]
      expect(indexes).toHaveLength(1)
    })
  })

  describe('queue operations', () => {
    it('insertPendingRun creates a row with status pending', () => {
      const id = db.insertPendingRun({ name: 'Queue Job' })
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.status).toBe('pending')
      expect(run!.duration).toBe(0)
      expect(run!.startedAt).toBeNull()
      expect(run!.endedAt).toBeNull()
    })

    it('getNextPendingRun returns highest priority first', () => {
      db.insertPendingRun({ name: 'Low', priority: 0 })
      db.insertPendingRun({ name: 'High', priority: 10 })
      db.insertPendingRun({ name: 'Medium', priority: 5 })

      const next = db.getNextPendingRun()
      expect(next).toBeDefined()
      expect(next!.name).toBe('High')
      expect(next!.priority).toBe(10)
    })

    it('getNextPendingRun returns FIFO within same priority', () => {
      db.insertPendingRun({ name: 'First' })
      db.insertPendingRun({ name: 'Second' })
      db.insertPendingRun({ name: 'Third' })

      const next = db.getNextPendingRun()
      expect(next).toBeDefined()
      expect(next!.name).toBe('First')
    })

    it('getNextPendingRun returns undefined when no pending runs', () => {
      insertSampleRun({ status: 'passed' })
      const next = db.getNextPendingRun()
      expect(next).toBeUndefined()
    })

    it('updateRunStatus changes status correctly', () => {
      const id = db.insertPendingRun({ name: 'To Run' })
      db.updateRunStatus(id, 'running')
      const run = db.getRun(id)
      expect(run!.status).toBe('running')
    })

    it('updateRunStatus can cancel a running run', () => {
      const id = db.insertPendingRun({ name: 'To Cancel' })
      db.updateRunStatus(id, 'running')
      db.updateRunStatus(id, 'cancelled')
      const run = db.getRun(id)
      expect(run!.status).toBe('cancelled')
    })
  })

  describe('parallel column', () => {
    it('insertPendingRun with parallel: true stores and retrieves parallel: true', () => {
      const id = db.insertPendingRun({ name: 'Parallel Test', parallel: true })
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.parallel).toBe(true)
    })

    it('insertPendingRun without parallel field defaults to parallel: false', () => {
      const id = db.insertPendingRun({ name: 'Sequential Test' })
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.parallel).toBe(false)
    })

    it('getPendingRuns returns all pending runs in correct order', () => {
      db.insertPendingRun({ name: 'Low Priority', priority: 0 })
      db.insertPendingRun({ name: 'High Priority', priority: 10 })
      db.insertPendingRun({ name: 'Medium Priority', priority: 5 })

      const runs = db.getPendingRuns()
      expect(runs).toHaveLength(3)
      expect(runs[0].name).toBe('High Priority')
      expect(runs[1].name).toBe('Medium Priority')
      expect(runs[2].name).toBe('Low Priority')
    })

    it('getPendingRuns excludes non-pending runs', () => {
      db.insertPendingRun({ name: 'Pending' })
      insertSampleRun({ name: 'Passed', status: 'passed' })

      const runs = db.getPendingRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].name).toBe('Pending')
    })
  })

  describe('flaky detection', () => {
    // four cells stood here over the parent/child run tree — an
    // ordered child read, two "excludes child runs" filters and a retry-info writer. Nothing has
    // written a child run row since 402-09, so all four exercised a shape no producer could
    // create; the columns, the reader, the writer and the index went together. What replaces them
    // is the pin that the index is GONE, so re-adding the column reddens here.
    it('counts every run, because every run is top-level now', () => {
      insertSampleRun({ name: 'Normal', status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ name: 'Flaky One', status: 'healed', startedAt: '2026-03-01T10:00:00Z' })

      const stats = db.getStats()
      expect(stats.totalRuns).toBe(2)
      expect(stats.passed).toBe(2) // a healed run counts as passed
      expect(stats.flaky).toBe(1)
    })

    it('no longer carries the deleted parent-link index', () => {
      const indexes = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[]
      expect(indexes.map((index) => index.name)).not.toContain('idx_runs' + '_parent')
    })
  })
})

const STAMPED_OWNER = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
const inertProbe = { isAlive: () => true, incarnationOf: () => undefined }

describe('the runs table owner columns', () => {
  it('a fresh runs database opens at the current version with the owner columns', () => {
    expect(db['db'].pragma('user_version', { simple: true })).toBe(2)
    const columns = columnNames('runs')
    for (const name of ['owner_pid', 'owner_incarnation', 'owner_host']) expect(columns).toContain(name)
  })

  it('an owner-less running row is refused by the store', () => {
    const raw = db['db']
    expect(() => raw.prepare(
      "INSERT INTO runs (id, name, status) VALUES ('ownerless', 'Ownerless', 'running')",
    ).run()).toThrow(/CHECK constraint failed/)
    expect(db.getRun('ownerless')).toBeUndefined()

    const id = db.insertPendingRun({ name: 'Queued' })
    expect(() => raw.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id))
      .toThrow(/CHECK constraint failed/)
    expect(db.getRun(id)?.status).toBe('pending')
  })
})

describe('the owner stamp on a running row', () => {
  it('the queue flip stamps the dashboard', () => {
    const owned = new DashboardDatabase({
      dbPath: ':memory:',
      runOwnership: { self: STAMPED_OWNER, probe: inertProbe },
    })
    try {
      const byStatus = owned.insertPendingRun({ name: 'Flipped by status' })
      const byUpdate = owned.insertPendingRun({ name: 'Flipped by update' })
      expect(owned.readRunOwner(byStatus)).toBeUndefined()

      expect(owned.updateRunStatus(byStatus, 'running')).toBe(true)
      expect(() => owned.updateRun(byUpdate, { status: 'running', startedAt: '2026-10-16T00:00:00.000Z' }))
        .toThrow('updateRun cannot write status running; claim the row with claimRunningRow')

      expect(owned.getRun(byStatus)?.status).toBe('running')
      expect(owned.readRunOwner(byStatus)).toEqual(STAMPED_OWNER)
      const row = owned.getRun(byStatus) as unknown as Record<string, unknown>
      for (const key of Object.keys(row)) expect(key.toLowerCase()).not.toContain('owner')
      expect(owned.getRun(byUpdate)?.status).toBe('pending')
      expect(owned.readRunOwner(byUpdate)).toBeUndefined()
    } finally {
      owned.close()
    }
  })

  it('a handle with no injected owner stamps this process on this host with no incarnation', () => {
    const id = insertSampleRun({ status: 'running' })
    expect(db.runOwnership.self.pid).toBe(process.pid)
    expect(db.readRunOwner(id)).toEqual({
      pid: process.pid,
      incarnation: null,
      host: db.runOwnership.self.host,
    })
    expect(db.readRunOwner(insertSampleRun({ status: 'passed' }))).toBeUndefined()
  })
})

describe('finalizing orphaned runs', () => {
  const OTHER_OWNER = { pid: 5151, incarnation: 'proc-starttime:9', host: 'h' }
  let dir: string
  let first: DashboardDatabase
  let second: DashboardDatabase

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-qa-442-orphan-'))
    const dbPath = join(dir, 'runs.db')
    first = new DashboardDatabase({ dbPath, runOwnership: { self: STAMPED_OWNER, probe: inertProbe } })
    second = new DashboardDatabase({ dbPath, runOwnership: { self: OTHER_OWNER, probe: inertProbe } })
  })

  afterEach(() => {
    first.close()
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function runningRow(handle: DashboardDatabase): string {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = handle.insertRun({ name: 'Owned run', status: 'running', duration: 0, startedAt, endedAt: startedAt })
    handle.insertRunArtifact({ runId: id, kind: 'test' })
    expect(handle.getRun(id)?.status).toBe('running')
    return id
  }

  function snapshotOf(handle: DashboardDatabase, id: string): string {
    return JSON.stringify({
      row: handle.getRun(id),
      owner: handle.readRunOwner(id),
      artifact: handle.getRunArtifact(id),
    })
  }

  it('an orphan is finalized failed with the plain sentence', () => {
    const id = runningRow(first)
    const owner = second.readRunOwner(id)
    expect(owner).toEqual(STAMPED_OWNER)

    expect(second.finalizeOrphanRun(id, owner!)).toBe(true)

    const sentence = 'The process running this run (pid 4242) ended before it finished.'
    const row = first.getRun(id)!
    expect(row.status).toBe('failed')
    expect(row.failureSummary).toBe(sentence)
    expect(row.duration).toBeGreaterThan(0)
    expect(row.endedAt).not.toBe(row.startedAt)
    const artifact = first.getRunArtifact(id)!
    expect(artifact.finalizedAt).not.toBeNull()
    expect(artifact.payload.errors).toEqual([
      { code: 'owner-gone', phase: 'orphan-cleanup', message: sentence },
    ])
    expect(artifact.payload.runtime).toMatchObject({ status: 'failed', duration: row.duration })
  })

  it('exactly one finalizer wins a race', () => {
    const endedAt = new Date().toISOString()
    const ownFirst = runningRow(first)
    const owner = first.readRunOwner(ownFirst)!
    expect(second.finalizeOwnRun(ownFirst, { status: 'cancelled', endedAt })).toBe(false)
    expect(first.getRun(ownFirst)?.status).toBe('running')
    expect(first.finalizeOwnRun(ownFirst, { status: 'cancelled', endedAt })).toBe(true)
    expect(first.finalizeOwnRun(ownFirst, { status: 'failed', endedAt })).toBe(false)
    expect(second.finalizeOrphanRun(ownFirst, owner)).toBe(false)
    expect(first.getRun(ownFirst)).toMatchObject({ status: 'cancelled', failureSummary: null })
    expect(first.getRunArtifact(ownFirst)?.finalizedAt).toBeNull()

    const orphanFirst = runningRow(first)
    expect(second.finalizeOrphanRun(orphanFirst, owner)).toBe(true)
    const afterOrphan = snapshotOf(first, orphanFirst)
    expect(first.finalizeOwnRun(orphanFirst, { status: 'cancelled', endedAt })).toBe(false)
    expect(second.finalizeOrphanRun(orphanFirst, owner)).toBe(false)
    expect(snapshotOf(first, orphanFirst)).toBe(afterOrphan)

    const untouched = runningRow(first)
    const before = snapshotOf(first, untouched)
    for (const stranger of [
      { ...owner, pid: owner.pid + 1 },
      { ...owner, incarnation: 'proc-starttime:other' },
      { ...owner, incarnation: null },
      { ...owner, host: 'another-host' },
    ]) {
      expect(second.finalizeOrphanRun(untouched, stranger)).toBe(false)
    }
    expect(snapshotOf(first, untouched)).toBe(before)

    expect(() => second.updateRun(untouched, { status: 'running' }))
      .toThrow('updateRun cannot write status running; claim the row with claimRunningRow')
    expect(first.readRunOwner(untouched)).toEqual(owner)
    expect(snapshotOf(first, untouched)).toBe(before)
  })

  it('the sweeps find nothing to do on an empty table', () => {
    expect(first.listRunningRunOwners()).toEqual([])
    first.insertPendingRun({ name: 'Queued' })
    first.insertRun({
      name: 'Done', status: 'passed', duration: 1, startedAt: '2026-10-16T00:00:00.000Z',
      endedAt: '2026-10-16T00:00:01.000Z',
    })
    expect(first.listRunningRunOwners()).toEqual([])

    const id = runningRow(first)
    expect(second.listRunningRunOwners()).toEqual([
      { id, startedAt: first.getRun(id)!.startedAt, owner: STAMPED_OWNER },
    ])
  })
})

describe('a run stamped before its start time was read', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-qa-442-own-start-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a run stamped before its own start time was read is still finalized as its own', () => {
    const dbPath = join(dir, 'runs.db')
    const unread = { pid: 4242, incarnation: null, host: 'h' }
    let selfReads = 0
    const lateRead: RunOwnership = {
      get self() {
        selfReads += 1
        return { ...unread, incarnation: selfReads === 1 ? null : 'proc-starttime:7' }
      },
      probe: inertProbe,
    }
    const endedAt = new Date().toISOString()
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const running = { name: 'Own run', status: 'running', duration: 0, startedAt, endedAt: startedAt }
    const own = new DashboardDatabase({ dbPath, runOwnership: lateRead })
    const stamper = new DashboardDatabase({ dbPath, runOwnership: { self: unread, probe: inertProbe } })
    const stranger = new DashboardDatabase({ dbPath, runOwnership: { self: unread, probe: inertProbe } })
    try {
      const id = own.insertRun(running)
      expect(own.readRunOwner(id)).toEqual(unread)
      expect(own.runOwnership.self.incarnation).toBe('proc-starttime:7')

      expect(own.finalizeOwnRun(id, { status: 'cancelled', endedAt })).toBe(true)
      expect(own.getRun(id)?.status).toBe('cancelled')

      const fresh = stamper.insertRun(running)
      expect(stranger.readRunOwner(fresh)).toEqual(unread)
      expect(stranger.finalizeOwnRun(fresh, { status: 'cancelled', endedAt })).toBe(false)
      expect(stranger.getRun(fresh)?.status).toBe('running')
    } finally {
      own.close()
      stamper.close()
      stranger.close()
    }
  })
})
