import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
import { createBetterSqlite3Database } from '@vostride/agent-qa-core'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DashboardDatabase, runSqliteMigrations } from '../db/database.js'
import { SCHEMA_VERSION, MIGRATIONS } from '../db/schema.js'

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
  describe('schema creation', () => {
    it('SCHEMA_VERSION is 1', () => {
      expect(SCHEMA_VERSION).toBe(1)
    })

    it('has migrations for every schema version', () => {
      expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION)
      MIGRATIONS.forEach((migration, index) => {
        expect(migration.version).toBe(index + 1)
      })
    })

    it('creates all expected tables', () => {
      const tables = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
      const names = tables.map(t => t.name)
      expect(names).toContain('runs')
      expect(names).toContain('steps')
      expect(names).toContain('reasoning_traces')
      expect(names).toContain('logs')
      expect(names).toContain('execution_logs')
      expect(names).toContain('token_events')
      expect(names).toContain('run_artifacts')
    })

    it('sets user_version to the current schema version after migrations', () => {
      const version = db['db'].pragma('user_version', { simple: true })
      expect(version).toBe(SCHEMA_VERSION)
    })

    it('creates the current final runs columns directly in v1', () => {
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
        'video_path',
        'failure_summary',
        'platform',
        'test_file_content',
        'model_name',
        'llm_provider',
        'parallel',
        'parent_run_id',
        'attempt_number',
        'retry_count',
        'max_retries',
        'error_log',
        'memory_log',
        'test_id',
        'suite_id',
      ])
      const names = columnNames('runs')
      expect(names).not.toContain('automation_name')
      expect(names).not.toContain('matrix_label')
      expect(names).not.toContain('matrix_config')
    })

    it('creates the current final steps columns directly in v1', () => {
      expect(columnNames('steps')).toEqual([
        'id',
        'run_id',
        'name',
        'status',
        'duration',
        'action',
        'observation',
        'reasoning',
        'planned_action',
        'result',
        'error',
        'screenshot_path',
        'screenshot_before_path',
        'healing_attempts',
        'retry_count',
        'captured_variables',
        'step_order',
        'annotation_data',
        'healing_screenshot_paths',
        'accessibility_violations',
        'confidence',
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'sub_actions_data',
        'console_logs',
        'network_logs',
        'variable_snapshot',
        'original_step_name',
        'screen_context_before',
        'screen_context_after',
        'created_at',
      ])
      const names = columnNames('steps')
      expect(names).not.toContain('fix_suggestions')
    })

    it('creates the current final auxiliary table shapes directly in v1', () => {
      expect(columnNames('reasoning_traces')).toEqual([
        'id',
        'step_id',
        'observe_text',
        'observe_duration',
        'plan_reasoning',
        'plan_confidence',
        'plan_action',
        'plan_duration',
        'execute_action',
        'execute_duration',
        'verify_reasoning',
        'verify_success',
        'verify_duration',
        'heal_attempts',
        'total_duration',
        'screen_state_before',
        'screen_state_after',
        'created_at',
      ])
      expect(columnNames('logs')).toEqual(['id', 'step_id', 'run_id', 'level', 'source', 'message', 'data', 'timestamp'])
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
      expect(names).toContain('idx_runs_parent')
      expect(names).toContain('idx_steps_run_id')
      expect(names).toContain('idx_reasoning_traces_step_id')
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
    it('applies future migrations after the current user_version', () => {
      const raw = createBetterSqlite3Database(':memory:')
      try {
        runSqliteMigrations(raw, [
          {
            version: 1,
            sql: ['CREATE TABLE future_baseline (id TEXT PRIMARY KEY)'],
          },
          {
            version: 2,
            sql: ['ALTER TABLE future_baseline ADD COLUMN label TEXT'],
          },
          {
            version: 3,
            sql: ['CREATE INDEX idx_future_baseline_label ON future_baseline(label)'],
          },
        ], 3)

        const columns = raw.prepare('PRAGMA table_info(future_baseline)').all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).toContain('label')
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_future_baseline_label'").get())
          .toEqual({ name: 'idx_future_baseline_label' })
        expect(raw.pragma('user_version', { simple: true })).toBe(3)
      } finally {
        raw.close()
      }
    })

    it('skips migrations at or below the current user_version', () => {
      const raw = createBetterSqlite3Database(':memory:')
      try {
        raw.exec(`
          CREATE TABLE future_baseline (id TEXT PRIMARY KEY);
          PRAGMA user_version = 1;
        `)

        runSqliteMigrations(raw, [
          {
            version: 1,
            sql: ['CREATE TABLE should_not_run (id TEXT PRIMARY KEY)'],
          },
          {
            version: 2,
            sql: ['ALTER TABLE future_baseline ADD COLUMN label TEXT'],
          },
        ], 2)

        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'should_not_run'").get())
          .toBeUndefined()
        const columns = raw.prepare('PRAGMA table_info(future_baseline)').all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).toContain('label')
        expect(raw.pragma('user_version', { simple: true })).toBe(2)
      } finally {
        raw.close()
      }
    })

    it('does not apply migrations above the target schema version', () => {
      const raw = createBetterSqlite3Database(':memory:')
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
      const raw = createBetterSqlite3Database(':memory:')
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

    it('rejects missing and unsorted future migration sets', () => {
      const raw = createBetterSqlite3Database(':memory:')
      try {
        expect(() => runSqliteMigrations(raw, [
          { version: 1, sql: ['SELECT 1'] },
          { version: 3, sql: ['SELECT 1'] },
        ], 3)).toThrow('Expected 3 SQLite migration(s), found 2')
        expect(() => runSqliteMigrations(raw, [
          { version: 2, sql: ['SELECT 1'] },
          { version: 1, sql: ['SELECT 1'] },
        ], 2)).toThrow('expected version 1, got 2')
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
      expect(inserted.schemaVersion).toBe(1)
      expect(inserted.payload.schemaVersion).toBe(1)
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

    it('returns suite parent artifacts with child artifacts and deletes them with run rows', () => {
      const parentRunId = insertSampleRun({ name: 'Smoke suite', suiteId: 's_smoke' })
      const childRunId = insertSampleRun({
        name: 'Login Test',
        parentRunId,
        suiteId: 's_smoke',
        testId: 't_login',
      })

      db.insertRunArtifact({
        runId: parentRunId,
        kind: 'suite-parent',
        payload: { source: { kind: 'suite', suiteId: 's_smoke', members: [{ index: 0, ref: { test: 'login.yaml' }, loadStatus: 'loaded', childRunId }] } },
      })
      db.insertRunArtifact({
        runId: childRunId,
        kind: 'suite-child',
        payload: { source: { kind: 'test', testId: 't_login', name: 'Login Test', loadStatus: 'loaded' } },
      })

      const bundle = db.getRunArtifactBundle(parentRunId)
      expect(bundle.artifact?.kind).toBe('suite-parent')
      expect(bundle.children).toHaveLength(1)
      expect(bundle.children[0].run.id).toBe(childRunId)
      expect(bundle.children[0].artifact?.kind).toBe('suite-child')

      const deleted = db.deleteRun(parentRunId)
      expect(deleted.deletedRunIds.sort()).toEqual([childRunId, parentRunId].sort())
      expect(db.getRunArtifact(parentRunId)).toBeNull()
      expect(db.getRunArtifact(childRunId)).toBeNull()
    })
  })

  describe('insertStep and getSteps', () => {
    it('inserts and retrieves steps for a run', () => {
      const runId = insertSampleRun()
      db.insertStep({
        runId,
        name: 'Click login button',
        status: 'passed',
        duration: 1200,
        action: { type: 'click', ref: '[1]' },
        observation: 'Login form visible',
        reasoning: 'Need to click login',
        result: 'success',
        stepOrder: 0,
      })
      db.insertStep({
        runId,
        name: 'Enter username',
        status: 'passed',
        duration: 800,
        action: { type: 'fill', ref: '[2]', value: 'admin' },
        result: 'success',
        stepOrder: 1,
      })

      const steps = db.getSteps(runId)
      expect(steps).toHaveLength(2)
      expect(steps[0].name).toBe('Click login button')
      expect(steps[0].action).toEqual({ type: 'click', ref: '[1]' })
      expect(steps[0].observation).toBe('Login form visible')
      expect(steps[1].name).toBe('Enter username')
      expect(steps[1].stepOrder).toBe(1)
    })

    it('returns steps ordered by step_order', () => {
      const runId = insertSampleRun()
      db.insertStep({ runId, name: 'Step C', status: 'passed', duration: 100, stepOrder: 2 })
      db.insertStep({ runId, name: 'Step A', status: 'passed', duration: 100, stepOrder: 0 })
      db.insertStep({ runId, name: 'Step B', status: 'passed', duration: 100, stepOrder: 1 })

      const steps = db.getSteps(runId)
      expect(steps.map(s => s.name)).toEqual(['Step A', 'Step B', 'Step C'])
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

      const passed = db.getRuns({ status: 'passed' })
      expect(passed).toHaveLength(2)
      expect(passed.every(r => r.status === 'passed')).toBe(true)
    })

    it('filters by name (LIKE search)', () => {
      insertSampleRun({ name: 'Login Test' })
      insertSampleRun({ name: 'Checkout Test' })
      insertSampleRun({ name: 'Login Flow' })

      const results = db.getRuns({ name: 'Login' })
      expect(results).toHaveLength(2)
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

      const results = db.getRuns({ status: 'passed', platform: 'web' })
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

    it('calculates flake rate from healed steps', () => {
      const run1 = insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      const run2 = insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ status: 'passed', startedAt: '2026-03-01T10:00:00Z' })

      db.insertStep({ runId: run1, name: 'Step 1', status: 'healed', duration: 100, stepOrder: 0 })
      db.insertStep({ runId: run2, name: 'Step 1', status: 'healed', duration: 100, stepOrder: 0 })

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

    it('includes deleted memory counts in stats', () => {
      const runId = insertSampleRun({ startedAt: '2026-03-01T10:00:00Z' })
      db.updateRun(runId, {
        memoryLog: JSON.stringify({
          added: 1,
          confirmed: 2,
          deprecated: 3,
          deleted: 4,
          errors: [],
          curatorDuration: 10,
          tokenUsage: { totalTokens: 20 },
        }),
      })

      const stats = db.getStats()
      expect(stats.memory.added).toBe(1)
      expect(stats.memory.confirmed).toBe(2)
      expect(stats.memory.deprecated).toBe(3)
      expect(stats.memory.deleted).toBe(4)
      expect(stats.memory.curatorTokens).toBe(20)
    })
  })

  describe('step details', () => {
    it('stores healing attempts and captured variables', () => {
      const runId = insertSampleRun()
      db.insertStep({
        runId,
        name: 'Healed step',
        status: 'healed',
        duration: 3000,
        healingAttempts: [{ action: { type: 'click', ref: '[1]' }, success: false }],
        capturedVariables: { username: 'admin' },
        retryCount: 2,
        stepOrder: 0,
      })

      const steps = db.getSteps(runId)
      expect(steps[0].healingAttempts).toEqual([{ action: { type: 'click', ref: '[1]' }, success: false }])
      expect(steps[0].capturedVariables).toEqual({ username: 'admin' })
      expect(steps[0].retryCount).toBe(2)
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

    it('updates failureSummary and videoPath', () => {
      const id = insertSampleRun({ status: 'failed' })
      db.updateRun(id, {
        failureSummary: 'Step 2 failed: element not found',
        videoPath: '/recordings/test.mp4',
      })
      const run = db.getRun(id)
      expect(run!.failureSummary).toBe('Step 2 failed: element not found')
      expect(run!.videoPath).toBe('/recordings/test.mp4')
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

      const cancelled = db.getRuns({ status: 'cancelled' })
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

  describe('console and network log persistence', () => {
    it('round-trips console logs through insertStep and getSteps', () => {
      const runId = insertSampleRun()
      const consoleLogs = [{ level: 'log', text: 'hello', timestamp: 1000 }]
      db.insertStep({
        runId,
        name: 'Step with console logs',
        status: 'passed',
        duration: 500,
        stepOrder: 0,
        consoleLogs,
      })
      const steps = db.getSteps(runId)
      expect(steps[0].consoleLogs).toEqual(consoleLogs)
    })

    it('round-trips network logs through insertStep and getSteps', () => {
      const runId = insertSampleRun()
      const networkLogs = [{ url: 'https://example.com', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: {}, startTime: 2000, endTime: 2050 }]
      db.insertStep({
        runId,
        name: 'Step with network logs',
        status: 'passed',
        duration: 500,
        stepOrder: 0,
        networkLogs,
      })
      const steps = db.getSteps(runId)
      expect(steps[0].networkLogs).toEqual(networkLogs)
    })

    it('returns null for console/network logs when not provided', () => {
      const runId = insertSampleRun()
      db.insertStep({
        runId,
        name: 'Step without logs',
        status: 'passed',
        duration: 500,
        stepOrder: 0,
      })
      const steps = db.getSteps(runId)
      expect(steps[0].consoleLogs).toBeNull()
      expect(steps[0].networkLogs).toBeNull()
    })
  })

  describe('flaky detection', () => {
    it('insertRun with status flaky succeeds', () => {
      const id = db.insertRun({
        name: 'Flaky Test',
        status: 'flaky',
        duration: 5000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:05Z',
      })
      const run = db.getRun(id)
      expect(run).toBeDefined()
      expect(run!.status).toBe('flaky')
    })

    it('getRunsByParent returns child runs ordered by attempt_number', () => {
      const parentId = db.insertRun({
        name: 'Parent Run',
        status: 'running',
        duration: 0,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:00Z',
      })
      db.insertRun({
        name: 'Parent Run',
        status: 'failed',
        duration: 2000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:02Z',
        parentRunId: parentId,
        attemptNumber: 1,
        maxRetries: 2,
      })
      db.insertRun({
        name: 'Parent Run',
        status: 'passed',
        duration: 3000,
        startedAt: '2026-03-01T10:00:02Z',
        endedAt: '2026-03-01T10:00:05Z',
        parentRunId: parentId,
        attemptNumber: 2,
        maxRetries: 2,
      })

      const children = db.getRunsByParent(parentId)
      expect(children).toHaveLength(2)
      expect(children[0].attemptNumber).toBe(1)
      expect(children[0].status).toBe('failed')
      expect(children[1].attemptNumber).toBe(2)
      expect(children[1].status).toBe('passed')
    })

    it('getRuns excludes child runs (parent_run_id IS NULL filter)', () => {
      const parentId = insertSampleRun({ name: 'Parent' })
      db.insertRun({
        name: 'Child',
        status: 'failed',
        duration: 1000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
        parentRunId: parentId,
        attemptNumber: 1,
      })

      const runs = db.getRuns()
      const names = runs.map(r => r.name)
      expect(names).toContain('Parent')
      expect(names).not.toContain('Child')
    })

    it('getStats excludes child runs from counts', () => {
      insertSampleRun({ name: 'Normal', status: 'passed', startedAt: '2026-03-01T10:00:00Z' })
      const parentId = insertSampleRun({ name: 'Flaky Parent', status: 'flaky', startedAt: '2026-03-01T10:00:00Z' })
      db.insertRun({
        name: 'Child Attempt',
        status: 'failed',
        duration: 1000,
        startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T10:00:01Z',
        parentRunId: parentId,
        attemptNumber: 1,
      })

      const stats = db.getStats()
      expect(stats.totalRuns).toBe(2)
      expect(stats.passed).toBe(2) // flaky counts as passed
      expect(stats.flaky).toBe(1)
    })

    it('updateRunRetryInfo updates retry fields on parent', () => {
      const parentId = insertSampleRun({ name: 'Parent' })
      db.updateRunRetryInfo(parentId, { retryCount: 3, maxRetries: 5 })
      const run = db.getRun(parentId)
      expect(run!.retryCount).toBe(3)
      expect(run!.maxRetries).toBe(5)
    })

    it('idx_runs_parent index exists', () => {
      const indexes = db['db']
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_runs_parent'")
        .all() as { name: string }[]
      expect(indexes).toHaveLength(1)
    })
  })
})
