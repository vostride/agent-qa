// An older database is refused by name; `IF NOT EXISTS` would carry it forward half-old.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase, RunsDatabaseVersionRefusedError, runSqliteMigrations } from '../db/database.js'
import { createDashboardSqliteDatabase } from '../db/sqlite.js'
import { MIGRATIONS, SCHEMA_VERSION } from '../db/schema.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-qa-schema-v2-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// A v1 database: the old `runs` shape stamped `user_version = 1`; the refusal keys on the stamp.
function writeV1Database(dbPath: string): void {
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    raw.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        healing_screenshot_paths TEXT,
        screenshot_path TEXT
      );
      PRAGMA user_version = 1;
    `)
  } finally {
    raw.close()
  }
}

describe('a fresh dashboard database opens at the current version', () => {
  it('stamps user_version 2 and creates the three bus-shaped projection tables', () => {
    const db = new DashboardDatabase({ dbPath: join(workDir, 'fresh.db') })
    try {
      const raw = db as unknown as { db: { pragma(q: string, o?: { simple?: boolean }): unknown; prepare(sql: string): { all(): unknown[] } } }
      expect(raw.db.pragma('user_version', { simple: true })).toBe(2)
      expect(SCHEMA_VERSION).toBe(2)

      const tables = (raw.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>).map((row) => row.name)
      expect(tables).toContain('run_members')
      expect(tables).toContain('run_steps')
      expect(tables).toContain('run_sub_actions')

      const executionLogColumns = (raw.db
        .prepare('PRAGMA table_info(execution_logs)')
        .all() as Array<{ name: string }>).map((row) => row.name)
      expect(executionLogColumns).toContain('test_index')
      expect(executionLogColumns).toContain('step_index')

      // The v1 `steps` table defaults tokens to 0; these columns are nullable: absent is not zero.
      const stepColumns = raw.db
        .prepare('PRAGMA table_info(run_steps)')
        .all() as Array<{ name: string; dflt_value: unknown; notnull: number }>
      for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        const column = stepColumns.find((one) => one.name === name)
        expect(column, `run_steps.${name} exists`).toBeDefined()
        expect(column?.dflt_value, `run_steps.${name} has no default`).toBeNull()
        expect(column?.notnull, `run_steps.${name} is nullable`).toBe(0)
      }
    } finally {
      db.close()
    }
  })

  it('ships ONE migration entry, stamped at the current version', () => {
    expect(MIGRATIONS).toHaveLength(1)
    expect(MIGRATIONS[0].version).toBe(SCHEMA_VERSION)
  })
})

describe('an older or newer database is refused BY NAME, never migrated', () => {
  it('refuses a v1 database with the remove-the-database message', () => {
    const dbPath = join(workDir, 'legacy-v1.db')
    writeV1Database(dbPath)

    // The refusal names the file, its version and the remedy.
    expect(() => new DashboardDatabase({ dbPath })).toThrow(RunsDatabaseVersionRefusedError)
    expect(() => new DashboardDatabase({ dbPath })).toThrow(dbPath)
    expect(() => new DashboardDatabase({ dbPath })).toThrow(/runs database version 1\)/)
    expect(() => new DashboardDatabase({ dbPath })).toThrow(/Delete it and run again/)
  })

  it('leaves the refused v1 file exactly as it found it', () => {
    const dbPath = join(workDir, 'untouched-v1.db')
    writeV1Database(dbPath)
    expect(() => new DashboardDatabase({ dbPath })).toThrow()

    const raw = createDashboardSqliteDatabase(dbPath)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(1)
      const tables = (raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>).map((row) => row.name)
      // A guard that only refused newer files would create these three beside the old `runs`.
      expect(tables).not.toContain('run_members')
      expect(tables).not.toContain('run_steps')
      expect(tables).not.toContain('run_sub_actions')
    } finally {
      raw.close()
    }
  })

  it('refuses a database stamped 5 by name with the remove-the-database message', () => {
    const dbPath = join(workDir, 'older-v5.db')
    const seed = createDashboardSqliteDatabase(dbPath)
    try {
      seed.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT); INSERT INTO runs VALUES ('r_old', 'flaky')")
      seed.exec('PRAGMA user_version = 5')
    } finally {
      seed.close()
    }

    expect(() => new DashboardDatabase({ dbPath })).toThrow(RunsDatabaseVersionRefusedError)
    expect(() => new DashboardDatabase({ dbPath })).toThrow(
      `${dbPath}: SQLite database user_version 5 is not compatible with schema version 2. `
        + 'Remove the dashboard database or use a compatible agent-qa version.',
    )
  })

  it('still refuses a database from a FUTURE build with the not-compatible message', () => {
    const dbPath = join(workDir, 'future-v7.db')
    const seed = createDashboardSqliteDatabase(dbPath)
    try {
      seed.exec('PRAGMA user_version = 7')
    } finally {
      seed.close()
    }

    expect(() => new DashboardDatabase({ dbPath }))
      .toThrow(/user_version 7 is not compatible with schema version 2/)
    expect(() => new DashboardDatabase({ dbPath })).toThrow(`${dbPath}: `)
  })
})

describe('the single-entry migration contract', () => {
  it('accepts exactly one entry stamped at the schema version', () => {
    const raw = createDashboardSqliteDatabase(':memory:')
    try {
      runSqliteMigrations(raw, [{ version: 2, sql: [] }], 2)
      expect(raw.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      raw.close()
    }
  })

  it('refuses a two-entry chain, because no database is ever walked forward through one', () => {
    const raw = createDashboardSqliteDatabase(':memory:')
    try {
      expect(() => runSqliteMigrations(raw, [
        { version: 1, sql: [] },
        { version: 2, sql: [] },
      ], 2)).toThrow('Expected exactly 1 SQLite migration at version 2')
      expect(raw.pragma('user_version', { simple: true })).toBe(0)
    } finally {
      raw.close()
    }
  })
})
