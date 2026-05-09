import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DashboardDatabase } from '../db/database.js'
import { SCHEMA_VERSION } from '../db/schema.js'
import type { LogEntry } from '@vostride/agent-qa-core'

let db: DashboardDatabase

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
})

afterEach(() => {
  db.close()
})

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    stepId: null,
    runId: 'run-1',
    level: 'info',
    source: 'agent',
    message: 'Test log message',
    data: {},
    timestamp: '2026-03-17T10:00:00.000Z',
    ...overrides,
  }
}

function insertSampleRun(id = 'run-1') {
  return db.insertRun({
    id,
    name: 'Test Run',
    status: 'running',
    duration: 0,
    startedAt: '2026-03-17T10:00:00Z',
    endedAt: '2026-03-17T10:00:00Z',
  })
}

function insertSampleStep(runId = 'run-1', id?: string) {
  return db.insertStep({
    runId,
    name: 'Click button',
    status: 'passed',
    duration: 100,
    stepOrder: 0,
  })
}

describe('Log Storage v1 Baseline', () => {
  it('SCHEMA_VERSION is the v1 baseline', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it('creates logs table with correct columns', () => {
    const columns = (db as any).db
      .prepare("PRAGMA table_info('logs')")
      .all() as { name: string; type: string; notnull: number }[]
    const names = columns.map((c: any) => c.name)
    expect(names).toContain('id')
    expect(names).toContain('step_id')
    expect(names).toContain('run_id')
    expect(names).toContain('level')
    expect(names).toContain('source')
    expect(names).toContain('message')
    expect(names).toContain('data')
    expect(names).toContain('timestamp')
  })

  it('creates expected indexes for logs table', () => {
    const indexes = (db as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_logs_%'")
      .all() as { name: string }[]
    const names = indexes.map((i: any) => i.name)
    expect(names).toContain('idx_logs_step_id')
    expect(names).toContain('idx_logs_run_id')
    expect(names).toContain('idx_logs_level')
    expect(names).toContain('idx_logs_source')
    expect(names).toContain('idx_logs_run_level_source')
  })

  it('sets user_version to current schema version after migrations', () => {
    const version = (db as any).db.pragma('user_version', { simple: true })
    expect(version).toBe(SCHEMA_VERSION)
  })
})

describe('DashboardDatabase.insertLogs', () => {
  it('inserts entries that getLogs retrieves', () => {
    insertSampleRun()
    const entries = [
      makeLogEntry({ id: 'log-1', message: 'First' }),
      makeLogEntry({ id: 'log-2', message: 'Second' }),
    ]
    db.insertLogs(entries)
    const logs = db.getLogs({ runId: 'run-1' })
    expect(logs).toHaveLength(2)
    expect(logs[0].message).toBe('First')
    expect(logs[1].message).toBe('Second')
  })

  it('handles empty array gracefully', () => {
    expect(() => db.insertLogs([])).not.toThrow()
  })

  it('stores data as JSON and parses it back', () => {
    insertSampleRun()
    const entry = makeLogEntry({
      id: 'log-json',
      data: { model: 'gpt-4', tokens: 500 },
    })
    db.insertLogs([entry])
    const logs = db.getLogs({ runId: 'run-1' })
    expect(logs[0].data).toEqual({ model: 'gpt-4', tokens: 500 })
  })

  it('inserts entries with step_id FK', () => {
    insertSampleRun()
    const stepId = insertSampleStep()
    const entry = makeLogEntry({ id: 'log-step', stepId })
    db.insertLogs([entry])
    const logs = db.getLogs({ stepId })
    expect(logs).toHaveLength(1)
    expect(logs[0].stepId).toBe(stepId)
  })
})

describe('DashboardDatabase.getLogs filtering', () => {
  beforeEach(() => {
    insertSampleRun('run-1')
    insertSampleRun('run-2')
    const stepId = insertSampleStep('run-1')

    db.insertLogs([
      makeLogEntry({ id: 'log-1', runId: 'run-1', level: 'debug', source: 'agent', stepId, timestamp: '2026-03-17T10:00:01Z' }),
      makeLogEntry({ id: 'log-2', runId: 'run-1', level: 'info', source: 'planner', stepId: null, timestamp: '2026-03-17T10:00:02Z' }),
      makeLogEntry({ id: 'log-3', runId: 'run-1', level: 'warn', source: 'cache', stepId: null, timestamp: '2026-03-17T10:00:03Z' }),
      makeLogEntry({ id: 'log-4', runId: 'run-2', level: 'error', source: 'healer', stepId: null, timestamp: '2026-03-17T10:00:04Z' }),
    ])
  })

  it('filters by runId', () => {
    const logs = db.getLogs({ runId: 'run-1' })
    expect(logs).toHaveLength(3)
    expect(logs.every(l => l.runId === 'run-1')).toBe(true)
  })

  it('filters by stepId', () => {
    const allLogs = db.getLogs({ runId: 'run-1' })
    const stepId = allLogs.find(l => l.stepId !== null)?.stepId
    const logs = db.getLogs({ stepId: stepId! })
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('log-1')
  })

  it('filters by level', () => {
    const logs = db.getLogs({ level: 'warn' })
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('log-3')
  })

  it('filters by source', () => {
    const logs = db.getLogs({ source: 'planner' })
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('log-2')
  })

  it('combines multiple filters', () => {
    const logs = db.getLogs({ runId: 'run-1', level: 'debug' })
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe('log-1')
  })

  it('returns entries in timestamp order (ASC)', () => {
    const logs = db.getLogs({ runId: 'run-1' })
    expect(logs[0].timestamp).toBe('2026-03-17T10:00:01Z')
    expect(logs[1].timestamp).toBe('2026-03-17T10:00:02Z')
    expect(logs[2].timestamp).toBe('2026-03-17T10:00:03Z')
  })

  it('supports pagination with limit and offset', () => {
    const page1 = db.getLogs({ runId: 'run-1', limit: 2, offset: 0 })
    expect(page1).toHaveLength(2)
    expect(page1[0].id).toBe('log-1')

    const page2 = db.getLogs({ runId: 'run-1', limit: 2, offset: 2 })
    expect(page2).toHaveLength(1)
    expect(page2[0].id).toBe('log-3')
  })
})

describe('Cascade delete', () => {
  it('deleting a run cascades to delete its logs', () => {
    insertSampleRun('run-cascade')
    db.insertLogs([
      makeLogEntry({ id: 'log-c1', runId: 'run-cascade' }),
      makeLogEntry({ id: 'log-c2', runId: 'run-cascade' }),
    ])

    // Verify logs exist
    expect(db.getLogs({ runId: 'run-cascade' })).toHaveLength(2)

    // Delete the run (direct SQL since no deleteRun method)
    ;(db as any).db.prepare('DELETE FROM runs WHERE id = ?').run('run-cascade')

    // Logs should be gone
    expect(db.getLogs({ runId: 'run-cascade' })).toHaveLength(0)
  })

  it('deleting a step cascades to delete its logs', () => {
    insertSampleRun('run-step-cascade')
    const stepId = insertSampleStep('run-step-cascade')

    db.insertLogs([
      makeLogEntry({ id: 'log-sc1', runId: 'run-step-cascade', stepId }),
      makeLogEntry({ id: 'log-sc2', runId: 'run-step-cascade', stepId: null }),
    ])

    // Delete the step
    ;(db as any).db.prepare('DELETE FROM steps WHERE id = ?').run(stepId)

    // Step-linked log should be gone, run-only log should remain
    const remaining = db.getLogs({ runId: 'run-step-cascade' })
    expect(remaining).toHaveLength(1)
    expect(remaining[0].stepId).toBeNull()
  })
})

describe('insertLogs FK resilience', () => {
  it('does not throw when run_id has no matching run row', () => {
    expect(() => {
      db.insertLogs([makeLogEntry({ runId: 'nonexistent-run' })])
    }).not.toThrow()
  })

  it('still persists entries with valid run_id', () => {
    insertSampleRun('valid-run')
    db.insertLogs([
      makeLogEntry({ id: 'log-valid-1', runId: 'valid-run', message: 'persisted' }),
      makeLogEntry({ id: 'log-valid-2', runId: 'valid-run', message: 'also persisted' }),
    ])
    const logs = db.getLogs({ runId: 'valid-run' })
    expect(logs).toHaveLength(2)
    expect(logs[0].message).toBe('persisted')
    expect(logs[1].message).toBe('also persisted')
  })
})
