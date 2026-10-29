import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { createDashboardRunIngest } from '../../reporter/index.js'
import { DashboardDatabase } from '../database.js'
import { createDashboardSqliteDatabase } from '../sqlite.js'

const SEVEN_WORDS = ['pending', 'running', 'passed', 'healed', 'failed', 'timeout', 'cancelled']

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-444-schema-v6-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function freshFile(name: string): string {
  const dbPath = join(root, name, 'runs.db')
  new DashboardDatabase({ dbPath }).close()
  return dbPath
}

describe('runs status words and the schema version', () => {
  it('a fresh runs database opens at version 2', () => {
    const raw = createDashboardSqliteDatabase(freshFile('fresh'))
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      raw.close()
    }
  })

  it('the runs table admits exactly the seven status words', () => {
    const raw = createDashboardSqliteDatabase(freshFile('words'))
    try {
      const insert = raw.prepare('INSERT INTO runs (id, name, status, owner_pid) VALUES (?, ?, ?, ?)')
      for (const word of SEVEN_WORDS) {
        expect(() => insert.run(`r_${word}`, word, word, 4242), word).not.toThrow()
      }
      for (const word of ['skipped', 'flaky']) {
        expect(() => insert.run(`r_${word}`, word, word, 4242), word).toThrow(/CHECK constraint failed/)
      }
      const stored = (raw.prepare('SELECT status FROM runs ORDER BY status').all() as Array<{ status: string }>)
        .map((row) => row.status)
      expect(stored.length).toBe(7)
      expect(stored).toEqual([...SEVEN_WORDS].sort())
    } finally {
      raw.close()
    }
  })

  it('a version 5 file is refused naming the file and left untouched', () => {
    const dbPath = join(root, 'v5', 'runs.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const raw = createDashboardSqliteDatabase(dbPath)
    try {
      raw.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL)')
      raw.exec("INSERT INTO runs (id, name, status) VALUES ('r_old', 'old run', 'flaky')")
      raw.exec('PRAGMA user_version = 5')
    } finally {
      raw.close()
    }
    const before = sha256(dbPath)

    let refusal: unknown
    try {
      new DashboardDatabase({ dbPath }).close()
    } catch (error) {
      refusal = error
    }

    expect((refusal as Error | undefined)?.name).toBe('RunsDatabaseVersionRefusedError')
    expect((refusal as Error).message).toBe(
      `${dbPath}: SQLite database user_version 5 is not compatible with schema version 2. `
        + 'Remove the dashboard database or use a compatible agent-qa version.',
    )
    expect(sha256(dbPath)).toBe(before)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  })

  it('a healed verdict and a timeout verdict are stored as their own words', () => {
    const db = new DashboardDatabase({ dbPath: join(root, 'ingest', 'runs.db') })
    try {
      for (const word of ['healed', 'timeout'] as const) {
        const runId = generateRunId()
        let seq = 0
        const ev = (type: RunEventType, payload: Record<string, unknown>): RunEventEnvelope =>
          ({ seq: ++seq, ts: seq, runId, type, payload }) as RunEventEnvelope
        const ingest = createDashboardRunIngest({
          db,
          runId,
          members: [{ name: `${word} test`, testId: generateTestId(), filePath: `tests/${word}.yaml` }],
          now: () => '2026-10-17T00:00:00.000Z',
        })
        ingest.handler(ev('runStarted', { memberTestCount: 1 }))
        expect(db.getRun(runId)?.status).toBe('running')
        ingest.handler(ev('verdict', { verdict: word }))
        expect(db.getRun(runId)?.status, `${word} after the verdict`).toBe(word)
        ingest.handler(ev('runFinished', { aggregateVerdict: word, disposition: 'detached', finalSeq: seq + 1 }))
        expect(db.getRun(runId)?.status, `${word} after runFinished`).toBe(word)
      }
    } finally {
      db.close()
    }
  })
})
