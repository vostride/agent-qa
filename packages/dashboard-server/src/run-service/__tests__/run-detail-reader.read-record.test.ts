// 2026-10-18 (444-12, D-14): the run-detail reader answers the row's stored status, and nothing else.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateRunId } from '@vostride/agent-qa-ids'
import { asRunId } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../../db/database.js'
import { createDashboardRunDetailReader } from '../run-detail-reader.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function database(): DashboardDatabase {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-444-run-record-'))
  roots.push(root)
  return new DashboardDatabase({ dbPath: join(root, 'runs.db') })
}

function seed(db: DashboardDatabase, status: string): string {
  return db.insertRun({
    id: generateRunId(),
    name: `a ${status} run`,
    status,
    duration: 1,
    startedAt: '2026-10-18T00:00:00.000Z',
    endedAt: '2026-10-18T00:00:01.000Z',
    failureSummary: 'The run ended before it reached a verdict.',
    metadata: { note: 'never served by readRecord' },
  })
}

describe('the stored run status', () => {
  it("the dashboard's reader answers the row's stored status and undefined for an unknown id", async () => {
    const db = database()
    try {
      const reader = createDashboardRunDetailReader(db)
      expect(typeof reader.readRecord).toBe('function')
      const statuses = ['failed', 'cancelled', 'passed', 'running']
      const ids = statuses.map(status => seed(db, status))
      expect(ids).toHaveLength(statuses.length)
      for (const [index, id] of ids.entries()) {
        const record = await reader.readRecord(asRunId(id))
        expect(record, statuses[index]).toEqual({ status: statuses[index] })
        expect(Object.keys(record ?? {}), statuses[index]).toEqual(['status'])
      }
      expect(await reader.readRecord(asRunId(generateRunId()))).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
