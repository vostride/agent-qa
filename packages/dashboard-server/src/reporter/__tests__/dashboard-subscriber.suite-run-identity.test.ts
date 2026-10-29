import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import { DashboardDatabase } from '../../db/database.js'
import { createDashboardRunIngest, type DashboardRunIngest } from '../dashboard-subscriber.js'
import { generateRunId } from '@vostride/agent-qa-ids'

// A suite is one run row with member handles, stored under the suite's own identity.

let db: DashboardDatabase
let seq = 0

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
  seq = 0
})

afterEach(() => {
  db.close()
})

function ev(type: RunEventType, payload: Record<string, unknown> = {}): RunEventEnvelope {
  return { seq: ++seq, ts: seq, runId: 'run-bus', type, payload } as RunEventEnvelope
}

const SUITE_ID = 's_lice-flat-otus-mult-mask-lack-messe-degree-ref-quite'
const SUITE_NAME = 'Automation Exercise'
const MEMBERS = [
  { testId: 't_home-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel', name: 'Automation Exercise home smoke', filePath: 'tests/ae-home.yaml' },
  { testId: 't_products-alpha-bravo-charlie-delta-echo-foxtrot-golf', name: 'Automation Exercise products smoke', filePath: 'tests/ae-products.yaml' },
  { testId: 't_cart-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel', name: 'Automation Exercise cart smoke', filePath: 'tests/ae-cart.yaml' },
] as const
const LAST = MEMBERS[2]
const SUITE_MEMBERS = MEMBERS.map((member) => ({ ...member, suiteId: SUITE_ID, suiteName: SUITE_NAME }))

function feedSuiteRun(ingest: DashboardRunIngest): void {
  ingest.handler(ev('runStarted', { memberTestCount: MEMBERS.length }))
  MEMBERS.forEach((member, testIndex) => {
    ingest.handler(ev('testStarted', {
      ...member,
      testIndex,
      suiteId: SUITE_ID,
      suiteName: SUITE_NAME,
      suiteIndex: 0,
      suiteTotal: 1,
      totalSteps: 2,
    }))
  })
  MEMBERS.forEach((member, testIndex) => {
    ingest.handler(ev('testFinished', { testId: member.testId, testIndex, outcome: 'passed', durationMs: 30000 + testIndex }))
  })
  ingest.handler(ev('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))
}

interface Door {
  label: string
  start: () => Promise<string>
}

const DOORS: Door[] = [
  {
    label: 'dashboard door',
    async start() {
      // What JobQueue.enqueue writes for a dashboard suite run: a pending row named after the suite.
      const runId = db.insertPendingRun({ name: SUITE_NAME, filePath: 'suites/automation-exercise.suite.yaml' })
      db.updateRunStatus(runId, 'running')
      const ingest = createDashboardRunIngest({
        db,
        runId,
        members: SUITE_MEMBERS,
        now: () => '2026-10-04T00:00:00.000Z',
      })
      feedSuiteRun(ingest)
      await ingest.finalize()
      return runId
    },
  },
  {
    label: 'CLI suite path (no correlation id)',
    async start() {
      const ingest = createDashboardRunIngest({
        db,
        runId: generateRunId(),
        sourceSnapshot: {
          kind: 'suite',
          suiteId: SUITE_ID,
          name: SUITE_NAME,
          filePath: 'suites/automation-exercise.suite.yaml',
          loadStatus: 'loaded',
        },
        configSnapshot: { runtime: { platform: 'web' } },
        members: SUITE_MEMBERS,
        now: () => '2026-10-04T00:00:00.000Z',
      })
      feedSuiteRun(ingest)
      await ingest.finalize()
      const rows = db.getRuns()
      expect(rows).toHaveLength(1)
      return rows[0]!.id
    },
  },
]

describe("a suite run keeps the suite's identity", () => {
  for (const door of DOORS) {
    it(`the run row carries the suite's name and id, not the last member's — ${door.label}`, async () => {
      const runId = await door.start()
      expect(db.getRuns().map((row) => row.id)).toEqual([runId])
      const row = db.getRun(runId)
      expect({ name: row?.name, suiteId: row?.suiteId, testId: row?.testId, status: row?.status })
        .toEqual({ name: SUITE_NAME, suiteId: SUITE_ID, testId: null, status: 'passed' })
    })

    it(`each member keeps its own identity — ${door.label}`, async () => {
      const runId = await door.start()
      const members = db.readRunDetailRows(runId)?.members ?? []
      expect(members.map((member) => [member.testIndex, member.testId, member.name, member.outcome])).toEqual(
        MEMBERS.map((member, testIndex) => [testIndex, member.testId, member.name, 'passed']),
      )
    })

    it(`the suite history lists the run and the last member's test history lists it by its member — ${door.label}`, async () => {
      const runId = await door.start()
      // `/api/analytics/suites/:suiteId` (suite viewer, /suites) reads these two.
      expect(db.getRunsBySuiteId(SUITE_ID).map((row) => row.id)).toEqual([runId])
      expect(db.getRunsBySuiteIdCount(SUITE_ID)).toBe(1)
      // The test viewer's history reads member rows by test id.
      expect(db.getRunsByTest({ testId: LAST.testId }).map((row) => [row.id, row.memberOutcome])).toEqual([[runId, 'passed']])
      expect(db.getRunsByTestCount({ testId: LAST.testId })).toBe(1)
      // And no run row is filed under the last member's test id.
      expect(db.getRuns().filter((row) => row.testId === LAST.testId)).toEqual([])
    })
  }

  it('a single-test run is unchanged', async () => {
    const runId = db.insertPendingRun({ name: 'tests/login.yaml', filePath: 'tests/login.yaml' })
    db.updateRunStatus(runId, 'running')
    const testId = 't_login-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    const ingest = createDashboardRunIngest({
      db,
      runId,
      members: [{ testId, name: 'Login Test', filePath: 'tests/login.yaml' }],
      now: () => '2026-10-04T00:00:00.000Z',
    })
    ingest.handler(ev('runStarted', { memberTestCount: 1 }))
    ingest.handler(ev('testStarted', { testId, testIndex: 0, name: 'Login Test', filePath: 'tests/login.yaml', totalSteps: 1 }))
    ingest.handler(ev('testFinished', { testId, testIndex: 0, outcome: 'passed', durationMs: 1200 }))
    ingest.handler(ev('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize()

    const row = db.getRun(runId)
    expect({ name: row?.name, suiteId: row?.suiteId, testId: row?.testId })
      .toEqual({ name: 'Login Test', suiteId: null, testId })
    expect(db.getRunsByTest({ testId }).map((r) => r.id)).toEqual([runId])
  })
})
