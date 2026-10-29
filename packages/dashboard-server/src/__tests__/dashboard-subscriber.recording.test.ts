import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { asRunId, EVIDENCE_ABSENCE_REASONS, RecordingEntrySchema } from '@vostride/agent-qa-schema'
import type { SubActionRecordedPayload } from '@vostride/agent-qa-schema'
import { createRunEventBus, createMemberEventSink, executeStep, makeScreenState } from '@vostride/agent-qa-runner'
import { DashboardDatabase } from '../db/database.js'
import { createDashboardSqliteDatabase } from '../db/sqlite.js'
import { createDashboardRunIngest } from '../reporter/dashboard-subscriber.js'
import { createDashboardRunDetailReader } from '../run-service/run-detail-reader.js'

let dir: string
let dbPath: string
let db: DashboardDatabase
let runId: ReturnType<typeof asRunId>
const buses: ReturnType<typeof createRunEventBus>[] = []
const recording = RecordingEntrySchema.parse({
  state: 'present',
  ref: { id: `recording:${'a'.repeat(64)}`, sha: 'a'.repeat(64) },
  contentType: 'video/webm',
  byteLength: 12345,
  durationMs: 2400.5,
})
const child: SubActionRecordedPayload = {
  testIndex: 0,
  stepIndex: 0,
  subActionIndex: 0,
  plan: 'Open the page',
  plannedAction: { type: 'navigate', to: 'url', url: 'https://example.invalid' },
  result: { success: true },
  screenStateHash: 'before',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-424-recording-subscriber-'))
  dbPath = join(dir, 'dashboard.db')
  db = new DashboardDatabase({ dbPath })
  runId = asRunId(generateRunId())
})
afterEach(() => {
  for (const bus of buses.splice(0)) bus.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function startBus() {
  const ingest = createDashboardRunIngest({ db, runId })
  const bus = createRunEventBus({ runId })
  buses.push(bus)
  bus.subscribe(1, ingest.handler)
  bus.publish('runStarted', {})
  return { bus, ingest }
}

it('ANNOTATION-PRODUCER-COLD-READ: dispatch witness survives bus, result JSON and reopened read', async () => {
  const { bus } = startBus()
  const witness = { startMs: 105.5, endMs: 140.25, scene: 'recorded-page' as const, transform: 'identity' as const, width: 390, height: 844 }
  await executeStep('Click Log in', {
    adapter: { platform: 'web', setup: async () => {}, cleanup: async () => {}, observe: async () => makeScreenState(),
      execute: async () => ({ success: true, coordinates: { x: 40, y: 50 } }),
      recording: { start: async () => ({}), stop: async () => undefined, beginAnnotation: () => () => witness },
    },
    planner: { plan: async () => ({ plan: { reasoning: 'Click', action: { type: 'click', ref: 'e2' }, confidence: 1, stepComplete: true, stepFailed: false } }) },
    events: createMemberEventSink({ bus, mask: text => text, testIndex: 0 }).loopEmitFor(0),
  }, { stepInstruction: 'Click Log in', testName: 'Annotation', previousSteps: [],
    plannerModel: {} as never, verifierModel: {} as never })
  bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording })
  db.close()
  db = new DashboardDatabase({ dbPath })
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.subActions[0]?.result.annotation?.recording).toEqual(witness)
  expect(rows?.subActions[0]).not.toHaveProperty('recordingOffsetMs')
})

it.each([
  recording,
  ...EVIDENCE_ABSENCE_REASONS.map(reason => RecordingEntrySchema.parse({
    state: 'absent', reason, evidenceIncomplete: true,
  })),
])('REC-SUB-MEMBER-MIRRORED: testFinished preserves entry %j', async entry => {
  const { bus } = startBus()
  bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording: entry })
  bus.publish('testFinished', { testIndex: 0, outcome: 'passed' })
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.members).toHaveLength(1)
  expect(rows?.members[0]?.recording).toEqual(entry)
})

it('REC-SUB-OFFSET-MIRRORED: ordered rows retain zero and tied offsets verbatim', async () => {
  const { bus } = startBus()
  const children = [0, 1200, 1200].map((recordingOffsetMs, subActionIndex) => ({
    ...child, subActionIndex, recordingOffsetMs,
  }))
  for (const index of [2, 0, 1]) bus.publish('subActionRecorded', children[index]!)
  bus.publish('subActionRecorded', { ...child, subActionIndex: 3 })
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.subActions).toEqual([...children, { ...child, subActionIndex: 3 }])
  expect(rows?.subActions[3]).not.toHaveProperty('recordingOffsetMs')
})

it('REC-SUB-RETRY-DROPS: removes abandoned offsets and keeps only the final member entry', async () => {
  const { bus } = startBus()
  const testId = generateTestId()
  bus.publish('testStarted', { testIndex: 0, testId, name: 'Retry member' })
  bus.publish('testFinished', { testIndex: 1, outcome: 'passed', recording })
  bus.publish('subActionRecorded', { ...child, testIndex: 1, recordingOffsetMs: 55 })
  for (const subActionIndex of [0, 1]) {
    bus.publish('subActionRecorded', { ...child, subActionIndex, recordingOffsetMs: 900 })
  }
  bus.publish('testRetryScheduled', { testId, testIndex: 0, attempt: 2, maxAttempts: 2 })
  const abandoned = await createDashboardRunDetailReader(db).read(runId)
  expect(abandoned?.subActions.filter(row => row.testIndex === 0)).toEqual([])
  expect(abandoned?.members[0]?.attempts).toBe(2)
  bus.publish('subActionRecorded', { ...child, recordingOffsetMs: 0 })
  const finalEntry = RecordingEntrySchema.parse({ state: 'absent', reason: 'failed' })
  bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording: finalEntry })
  const final = await createDashboardRunDetailReader(db).read(runId)
  expect(final?.members.map(member => member.recording)).toEqual([finalEntry, recording])
  expect(final?.subActions).toEqual([
    { ...child, recordingOffsetMs: 0 },
    { ...child, testIndex: 1, recordingOffsetMs: 55 },
  ])
})

it.each(['member', 'sub-action'] as const)(
  'REC-SUB-NON-DARKENING: a failed %s insert leaves a readable run and subsequent facts',
  async kind => {
    const { bus } = startBus()
    const raw = createDashboardSqliteDatabase(dbPath)
    try {
      const table = kind === 'member' ? 'run_members' : 'run_sub_actions'
      raw.exec(`CREATE TRIGGER reject_projection BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END`)
      bus.publish('subActionRecorded', { ...child, recordingOffsetMs: 0 })
      bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording })
      const failed = await createDashboardRunDetailReader(db).read(runId)
      expect(failed).toBeDefined()
      expect(kind === 'member' ? failed?.members : failed?.subActions).toEqual([])
      // 2026-10-17 (444-02, D-06): a member's finish leaves the row `running`; the verdict moves it.
      expect(db.getRun(runId)?.status).toBe('running')
      raw.exec('DROP TRIGGER reject_projection')
      bus.publish('subActionRecorded', { ...child, recordingOffsetMs: 0 })
      bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording })
      const recovered = await createDashboardRunDetailReader(db).read(runId)
      expect(recovered?.members[0]?.recording).toEqual(recording)
      expect(recovered?.subActions[0]?.recordingOffsetMs).toBe(0)
      bus.publish('verdict', { verdict: 'passed' })
      expect(db.getRun(runId)?.status).toBe('passed')
    } finally { raw.close() }
  },
)

it('REC-COLD-READBACK: the reader returns identical recording facts after closing and reopening', async () => {
  const { bus, ingest } = startBus()
  for (const [subActionIndex, recordingOffsetMs] of [0, 1200, 1200].entries()) {
    bus.publish('subActionRecorded', { ...child, subActionIndex, recordingOffsetMs })
  }
  bus.publish('testFinished', { testIndex: 0, outcome: 'passed', recording })
  bus.publish('testFinished', { testIndex: 1, outcome: 'skipped' })
  bus.publish('runFinished', { aggregateVerdict: 'passed' })
  await ingest.finalize({})
  const warm = await createDashboardRunDetailReader(db).read(runId)
  db.close()
  db = new DashboardDatabase({ dbPath })
  const cold = await createDashboardRunDetailReader(db).read(runId)
  expect(cold).toEqual(warm)
  expect(cold?.members[0]?.recording).toEqual(recording)
  expect(cold?.members[1]).not.toHaveProperty('recording')
  expect(cold?.subActions.map(row => row.recordingOffsetMs)).toEqual([0, 1200, 1200])
})

function seedRun() {
  db.insertRun({ id: runId, name: 'recording', status: 'passed', duration: 0,
    startedAt: '', endedAt: '' })
}

it('REC-SUB-ABSENT-KEY-NULL: omitted recording and offset persist as NULL and read as absent', async () => {
  seedRun()
  db.upsertRunMember({ runId, testIndex: 0 })
  db.insertRunSubAction({ runId, ...child })
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    expect(raw.prepare('SELECT recording_json FROM run_members WHERE run_id = ?').get(runId))
      .toEqual({ recording_json: null })
    expect(raw.prepare('SELECT recording_offset_ms FROM run_sub_actions WHERE run_id = ?').get(runId))
      .toEqual({ recording_offset_ms: null })
  } finally { raw.close() }
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.members).toHaveLength(1)
  expect(rows?.subActions).toHaveLength(1)
  expect(rows?.members[0]).not.toHaveProperty('recording')
  expect(rows?.subActions[0]).not.toHaveProperty('recordingOffsetMs')
})

it('REC-SUB-UPSERT-OMISSION: a terminal upsert without recording preserves the stored entry', async () => {
  seedRun()
  const member = { runId, testIndex: 0, recording }
  db.upsertRunMember(member)
  db.upsertRunMember({ runId, testIndex: 0, outcome: 'passed' })
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.members[0]?.recording).toEqual(recording)
  expect(rows?.members[0]?.outcome).toBe('passed')
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    expect(raw.prepare('SELECT recording_json FROM run_members WHERE run_id = ?').get(runId))
      .toEqual({ recording_json: JSON.stringify(recording) })
  } finally { raw.close() }
})

it('REC-SUB-MALFORMED-JSON: malformed recording JSON maps to an absent key without throwing', async () => {
  seedRun()
  db.upsertRunMember({ runId, testIndex: 0 })
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    raw.prepare('UPDATE run_members SET recording_json = ? WHERE run_id = ?')
      .run('{broken', runId)
  } finally { raw.close() }
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.members).toHaveLength(1)
  expect(rows?.members[0]).not.toHaveProperty('recording')
})

it('REC-SUB-OFFSET-ZERO: zero and fractional offsets survive storage separately from omission', async () => {
  seedRun()
  for (const [subActionIndex, recordingOffsetMs] of [0, 12.5, undefined].entries()) {
    const input = { runId, ...child, subActionIndex, recordingOffsetMs }
    db.insertRunSubAction(input)
  }
  const rows = await createDashboardRunDetailReader(db).read(runId)
  expect(rows?.subActions.map(row => row.recordingOffsetMs)).toEqual([0, 12.5, undefined])
  expect(rows?.subActions[2]).not.toHaveProperty('recordingOffsetMs')
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    expect(raw.prepare('SELECT recording_offset_ms FROM run_sub_actions WHERE run_id = ? ORDER BY sub_action_index').all(runId))
      .toEqual([{ recording_offset_ms: 0 }, { recording_offset_ms: 12.5 }, { recording_offset_ms: null }])
  } finally { raw.close() }
})
