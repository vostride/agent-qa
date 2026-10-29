// 2026-10-17 (443-15, GAP-D5): the WAL switch retries every SQLite busy code and nothing else.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '../database.js'

const wal = vi.hoisted(() => ({ codes: [] as number[], calls: 0 }))

vi.mock('../sqlite.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sqlite.js')>()
  return {
    ...original,
    createDashboardSqliteDatabase: (path: string) => {
      const real = original.createDashboardSqliteDatabase(path)
      return new Proxy(real, {
        get(target, property) {
          if (property === 'pragma') {
            return (source: string, options?: { simple?: boolean }) => {
              if (source === 'journal_mode = WAL') {
                wal.calls += 1
                const errcode = wal.codes.shift()
                if (errcode !== undefined) {
                  throw Object.assign(new Error('database is locked'), { errcode })
                }
              }
              return target.pragma(source, options)
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

let dir: string
const opened: DashboardDatabase[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-443-wal-retry-'))
  wal.codes = []
  wal.calls = 0
})

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('C443-WAL-BUSY', () => {
  it('a fresh open retries the WAL switch on an extended busy code', () => {
    wal.codes = [517, 261]
    let db: DashboardDatabase | undefined

    expect(() => {
      db = new DashboardDatabase({ dbPath: join(dir, 'runs.db') })
    }).not.toThrow()
    if (db === undefined) throw new Error('the fresh open returned no handle')
    opened.push(db)

    expect(wal.calls, 'WAL switch attempts').toBe(3)
    const at = '2026-10-17T00:00:00.000Z'
    const id = db.insertRun({ name: 'After busy', status: 'pending', duration: 0, startedAt: at, endedAt: at })
    expect(db.getRun(id)?.status).toBe('pending')
  })

  it('a WAL switch that fails for another reason is not retried', () => {
    wal.codes = [1]
    let thrown: unknown

    try {
      opened.push(new DashboardDatabase({ dbPath: join(dir, 'runs.db') }))
    } catch (error) {
      thrown = error
    }

    expect((thrown as { errcode?: unknown } | undefined)?.errcode, 'the thrown errcode').toBe(1)
    expect(wal.calls, 'WAL switch attempts').toBe(1)
  })
})
