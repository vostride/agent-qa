// THE V2 HARD CUT, PINNED (Phase 405 plan 01, D-02 · RESEARCH Pitfall 4).
//
// D-02 is one of the two ONE-WAY decisions in this phase: `user_version = 2` becomes a published
// compatibility contract, and a database written by an older build is REFUSED BY NAME rather than
// migrated. The owner chose it in 405-CONTEXT.md in these words — "hard cut, no migration etc, as
// there are no users and users need to delete the existing run date so you do what's right also
// bump the version to v2 for the DDLs etc".
//
// WHY THIS FILE EXISTS AT ALL, and why the refusal is not just a comment in `database.ts`. Before
// this plan the guard compared `currentVersion > schemaVersion` and nothing else. With
// `SCHEMA_VERSION` moving 1 → 2, a developer's existing `dashboard.db` would have been seen as
// `1 < 2` and CARRIED FORWARD: every statement in the v2 list is `CREATE TABLE IF NOT EXISTS`, so
// the three new tables would have been created BESIDE the untouched v1 wide `steps` table and the
// app would have come up against a half-old schema, reporting success. That failure has no
// symptom until a read returns the wrong shape, which is why it is measured here rather than
// argued about.
//
// THE V1 DDL IS SPELLED INLINE BELOW, and this is the ONE legal place in the tree it may be. The
// fixture has to be a database this build did not write; deriving it from `MIGRATIONS` would make
// the cell a tautology (it would test that the current schema refuses the current schema).

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

/**
 * A database written by a PRE-405 build: the v1 `runs` shape, stamped `user_version = 1`.
 *
 * Deliberately partial — a fixture that reproduced the whole v1 DDL would be a second copy of a
 * schema this phase is deleting. What matters is the STAMP and the fact that a table exists under
 * it, because the refusal keys on the stamp and the corruption it prevents is "new tables created
 * beside old ones".
 */
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

      // the token columns exist and are NULLABLE WITH NO DEFAULT. The v1 `steps`
      // table declares `prompt_tokens INTEGER DEFAULT 0`, and that zero is the lie the whole
      // "absent is not zero" rule exists to stop this schema from being able to tell.
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

    // the refusal names the file, its version and the remedy.
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
      // THE WHOLE POINT: the pre-405 guard would have created these three beside the old `runs`.
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
