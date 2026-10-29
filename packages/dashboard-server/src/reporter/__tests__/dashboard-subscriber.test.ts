import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import { generateRunId } from '@vostride/agent-qa-ids'
import { DashboardDatabase } from '../../db/database.js'
import type { RunOwner } from '../../db/run-owner.js'
import { createDashboardRunIngest } from '../dashboard-subscriber.js'

let db: DashboardDatabase
let seq = 0

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
  seq = 0
})

afterEach(() => {
  db.close()
})

function ev(runId: string, type: RunEventType, payload: Record<string, unknown> = {}): RunEventEnvelope {
  return { seq: ++seq, ts: seq, runId, type, payload } as RunEventEnvelope
}

const attributes = {
  'agent-qa.trigger': 'cli',
  'agent-qa.runner': 'local',
} as const

function testSource(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'test' as const,
    testId: 't_login-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india',
    name: 'Login Test',
    filePath: 'tests/login.yaml',
    loadStatus: 'loaded' as const,
    ...overrides,
  }
}

function testConfig() {
  return {
    runtime: { platform: 'web' },
    model: { planner: { provider: 'openai', model: 'gpt-planner' } },
  }
}

// A whole `StepFinalizedPayload`, because the arm takes the schema type.
function stepFinalized(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testIndex: 0,
    stepIndex: 0,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: 'brief-digest-fixture',
    status: 'passed',
    durationMs: 100,
    ...overrides,
  }
}

/** A whole `SubActionRecordedPayload`, including the ref the bus fold carries. */
function subActionRecorded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testIndex: 0,
    stepIndex: 0,
    subActionIndex: 0,
    plan: 'Click Save',
    plannedAction: { type: 'click', ref: 'e2' },
    result: { success: true },
    screenStateHash: 'b'.repeat(64),
    screenStateHashAfter: 'c'.repeat(64),
    artifactRefs: [{ id: `decision-screenshot:${'d'.repeat(64)}`, sha: 'd'.repeat(64) }],
    ...overrides,
  }
}

describe('createDashboardRunIngest', () => {
  it('SUITE-DURATION-WRITE accumulates parallel member work once and replaces retries, including zero', async () => {
    const runId = db.insertPendingRun({ name: 'Duration probe', parallel: true })
    db.updateRunStatus(runId, 'running')
    const ingest = createDashboardRunIngest({ db, runId })
    ingest.handler(ev(runId, 'runStarted', { memberTestCount: 3 }))
    const durations = [31631.826750000007, 38765.66812499997, 35742.61929200002]
    for (const testIndex of [2, 0, 1]) {
      ingest.handler(ev(runId, 'testFinished', { testIndex, outcome: 'passed', durationMs: durations[testIndex] }))
    }
    const stored = () => db['db'].prepare('SELECT duration FROM runs WHERE id = ?').get(runId) as { duration: number }
    expect(stored().duration).toBeCloseTo(106140.114167, 7)
    ingest.handler(ev(runId, 'testFinished', { testIndex: 1, outcome: 'passed', durationMs: durations[1] }))
    expect(stored().duration).toBeCloseTo(106140.114167, 7)
    ingest.handler(ev(runId, 'testRetryScheduled', { testIndex: 1 }))
    ingest.handler(ev(runId, 'testFinished', { testIndex: 1, outcome: 'passed', durationMs: 0 }))
    ingest.handler(ev(runId, 'runFinished', { aggregateVerdict: 'passed' }))
    await ingest.finalize({})
    expect(stored().duration).toBe(durations[0] + durations[2])
    expect(db.getRun(runId)?.duration).toBe(stored().duration)
    expect(db.getRunArtifact(runId)?.payload.runtime?.duration).toBe(stored().duration)
  })

  it('plain run: envelope stream produces run + finalized run_artifacts rows readable via getRunArtifact', async () => {
    const runId = 'r_plain-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const busRunId = 'run-bus-1'
    const ingest = createDashboardRunIngest({
      db,
      configSnapshot: testConfig(),
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-07-08T00:00:00.000Z',
    })

    ingest.handler(ev(busRunId, 'runStarted', { memberTestCount: 1 }))
    // running row visible immediately (survives a mid-run kill)
    expect(db.getRun(runId)?.status).toBe('running')

    ingest.handler(ev(busRunId, 'testStarted', { testIndex: 0, name: 'Login Test', testId: testSource().testId }))
    ingest.handler(ev(busRunId, 'stepFinalized', stepFinalized({ durationMs: 120 })))
    ingest.handler(ev(busRunId, 'testFinished', { testId: 't-1', testIndex: 0, outcome: 'passed', durationMs: 5000 }))
    ingest.handler(ev(busRunId, 'verdict', { verdict: 'passed' }))
    ingest.handler(ev(busRunId, 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))

    await ingest.finalize({})

    const run = db.getRun(runId)
    expect(run?.status).toBe('passed')
    expect(run?.duration).toBe(5000)

    const artifact = db.getRunArtifact(runId)
    expect(artifact).not.toBeNull()
    expect(artifact?.finalizedAt).toBeTruthy()
    // Config and source sections are present, and there is no `memory` section.
    expect((artifact?.payload.source as Record<string, unknown>).name).toBe('Login Test')
    expect((artifact?.payload.config as Record<string, unknown>).model).toBeDefined()
    expect(Object.keys(artifact!.payload)).not.toContain('memory')
    expect(artifact?.payload.metadata?.attributes).toEqual(attributes)
    expect((artifact?.payload.runtime as Record<string, unknown>).status).toBe('passed')

    // Step progress lands in the v2 projection, read the way the op reads it.
    expect(db.readRunDetailRows(runId)?.steps).toHaveLength(1)
  })

  it('a healed verdict is stored as healed on the run row and the step keeps its healed status', () => {
    const runId = 'r_healed-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-07-08T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testIndex: 0 }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ status: 'healed', durationMs: 90 })))
    ingest.handler(ev('run-bus', 'testFinished', { testId: 't-1', testIndex: 0, outcome: 'healed', durationMs: 1000 }))
    // The row takes the run's verdict, never the member's outcome.
    expect(db.getRun(runId)?.status).toBe('running')
    ingest.handler(ev('run-bus', 'verdict', { verdict: 'healed' }))

    expect(db.getRun(runId)?.status).toBe('healed')
    expect(db.readRunDetailRows(runId)?.steps[0].status).toBe('healed')
    expect(db.readRunDetailRows(runId)?.members[0].outcome).toBe('healed')
  })

  it('correlation env — plain mode adopts an existing queued row without duplicating it', () => {
    const runId = 'r_queued-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    db.insertPendingRun({ id: runId, name: 'Queued', attributes })
    db.updateRunStatus(runId, 'running')
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource({ name: 'Adopted Test' }),
      members: [{ testId: testSource().testId, name: 'Adopted Test', filePath: testSource().filePath }],
      attributes,
      runId,
      now: () => '2026-07-08T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))

    expect(db.getRuns()).toHaveLength(1)
    expect(db.getRun(runId)?.status).toBe('running')
    expect(db.getRun(runId)?.name).toBe('Adopted Test')
  })

  it('correlation env — a suite run adopts the queued row and mints NO children', async () => {
    const suiteRunId = 'r_suite-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      configSnapshot: testConfig(),
      sourceSnapshot: { kind: 'suite', suiteId: 'suite-smoke', name: 'Smoke Suite', loadStatus: 'loaded' },
      attributes,
      runId: suiteRunId,
      now: () => '2026-07-08T00:00:00.000Z',
    })

    ingest.handler(ev('run-bus', 'runStarted', { memberTestCount: 2 }))
    const parent = db.getRun(suiteRunId)
    expect(parent?.status).toBe('running')
    // The queued row is ADOPTED, not parented: the artifact kind is an ordinary run's.
    expect(db.getRunArtifact(suiteRunId)?.kind).toBe('test')

    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-a', testIndex: 0, name: 'Test A', filePath: 'tests/a.yaml' }))
    ingest.handler(ev('run-bus', 'testFinished', { testId: 't-a', testIndex: 0, outcome: 'passed', durationMs: 100 }))
    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-b', testIndex: 1, name: 'Test B', filePath: 'tests/b.yaml' }))
    ingest.handler(ev('run-bus', 'testFinished', { testId: 't-b', testIndex: 1, outcome: 'failed', durationMs: 200 }))
    ingest.handler(ev('run-bus', 'runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize()

    // `getRuns()` is the whole runs table, so a child row minted anywhere would show up here.
    expect(db.getRuns().map((r) => r.id)).toEqual([suiteRunId])
    expect(db.getRun(suiteRunId)?.status).toBe('failed')

    // Two member rows on one run row.
    const members = db.readRunDetailRows(suiteRunId)?.members ?? []
    expect(members.map((member) => [member.testIndex, member.name, member.outcome]))
      .toEqual([[0, 'Test A', 'passed'], [1, 'Test B', 'failed']])
  })

  it('step rows carry the stepStarted instruction text, not a generic "Step N" label', () => {
    const runId = 'r_named-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-07-09T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testIndex: 0 }))
    ingest.handler(ev('run-bus', 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Open Apple Maps' }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ stepIndex: 0, durationMs: 100 })))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ stepIndex: 1, durationMs: 50 })))

    // A step with no `stepStarted` has no `stepText` at all, never a made-up label.
    const steps = db.readRunDetailRows(runId)?.steps ?? []
    expect(steps.map((step) => step.stepText)).toEqual(['Open Apple Maps', undefined])
  })

  it('hookFinished writes an execution_logs row with stdout/stderr/variables', () => {
    const runId = 'r_hooked-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-07-09T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testIndex: 0 }))
    ingest.handler(ev('run-bus', 'hookFinished', {
      hookName: 'seed-db',
      phase: 'setup',
      hookExecutionId: 'hx-1',
      scope: 'test',
      testIndex: 0,
      status: 'passed',
      durationMs: 340,
      stdout: 'seeded 3 rows',
      stderr: '',
      variables: { USER_ID: 'u-1' },
    }))
    // skipped hooks carry no output and are not persisted (CHECK admits passed|failed)
    ingest.handler(ev('run-bus', 'hookFinished', {
      hookName: 'optional-hook', phase: 'teardown', hookExecutionId: 'hx-2',
      status: 'skipped', durationMs: 0, stdout: '', stderr: '', variables: {},
    }))

    const logs = db.getExecutionLogs({ runId })
    expect(logs).toHaveLength(1)
    expect(logs[0].name).toBe('seed-db')
    expect(logs[0].stdout).toBe('seeded 3 rows')
    expect(logs[0].variables).toEqual({ USER_ID: 'u-1' })
    // The hook's place in the run tree; NULL would mean run-scoped.
    expect(logs[0].testIndex).toBe(0)
  })

  it('testRetryScheduled drops the abandoned attempt so step rows never duplicate', () => {
    const runId = 'r_retried-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-07-09T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testIndex: 0 }))
    ingest.handler(ev('run-bus', 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Login' }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ status: 'failed', durationMs: 80 })))
    ingest.handler(ev('run-bus', 'subActionRecorded', subActionRecorded()))
    // A second member, whose completed history must survive the first member's retry.
    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-2', testIndex: 1, name: 'Other' }))
    ingest.handler(ev('run-bus', 'stepStarted', { testIndex: 1, stepIndex: 0, stepText: 'Other step' }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ testIndex: 1, durationMs: 30 })))

    ingest.handler(ev('run-bus', 'testRetryScheduled', { testId: 't-1', testIndex: 0, attempt: 2, maxAttempts: 2 }))
    ingest.handler(ev('run-bus', 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Login' }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ status: 'passed', durationMs: 90 })))
    ingest.handler(ev('run-bus', 'testFinished', { testId: 't-1', testIndex: 0, outcome: 'passed', durationMs: 400 }))

    const rows = db.readRunDetailRows(runId)
    const memberSteps = (rows?.steps ?? []).filter((step) => step.testIndex === 0)
    expect(memberSteps).toHaveLength(1)
    expect(memberSteps[0].status).toBe('passed')
    expect(memberSteps[0].stepText).toBe('Login')
    // The abandoned attempt's SUB-ACTIONS went with its steps.
    expect((rows?.subActions ?? []).filter((one) => one.testIndex === 0)).toHaveLength(0)
    // The OTHER member's history is untouched — the whole point of scoping the delete.
    expect((rows?.steps ?? []).filter((step) => step.testIndex === 1)).toHaveLength(1)
    // The attempt ordinal the member header renders.
    expect(rows?.members.find((member) => member.testIndex === 0)?.attempts).toBe(2)
    expect(rows?.members.find((member) => member.testIndex === 1)?.attempts).toBe(1)
  })

  it('finalize is idempotent and safe when no run was ever started', async () => {
    const ingest = createDashboardRunIngest({ db, runId: 'r_never-started' })
    await expect(ingest.finalize()).resolves.toBeUndefined()
    await expect(ingest.finalize()).resolves.toBeUndefined()
    expect(db.getRuns()).toHaveLength(0)
  })

  it('subActionRecorded writes the whole payload verbatim, artifactRefs included', () => {
    const runId = 'r_subact-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-1', testIndex: 0 }))
    ingest.handler(ev('run-bus', 'subActionRecorded', subActionRecorded()))
    ingest.handler(ev('run-bus', 'subActionRecorded', subActionRecorded({
      subActionIndex: 1,
      plan: 'Type the value',
      // No refs and no after-hash: both are ABSENT keys on the row, never nulls.
      artifactRefs: undefined,
      screenStateHashAfter: undefined,
    })))

    const subActions = db.readRunDetailRows(runId)?.subActions ?? []
    expect(subActions).toHaveLength(2)
    expect(subActions[0].artifactRefs?.[0].sha).toBe('d'.repeat(64))
    expect(subActions[0].plannedAction).toEqual({ type: 'click', ref: 'e2' })
    expect(subActions[0].result).toEqual({ success: true })
    expect(subActions[0].screenStateHashAfter).toBe('c'.repeat(64))
    expect(subActions[1].plan).toBe('Type the value')
    expect(subActions[1].artifactRefs).toBeUndefined()
    expect(subActions[1].screenStateHashAfter).toBeUndefined()
  })

  it('stepFinalized persists the WHOLE payload, not the five fields the v1 row kept', () => {
    const runId = 'r_wholestep-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-1', testIndex: 0 }))
    ingest.handler(ev('run-bus', 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Save it' }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({
      cacheStatus: 'hit',
      verifierVerdict: { pass: false, reasoning: 'value never appeared' },
      selfHealOccurred: true,
      briefDigest: 'digest-xyz',
      status: 'failed',
      error: 'assertion failed',
    })))

    const step = db.readRunDetailRows(runId)?.steps[0]
    expect(step?.cacheStatus).toBe('hit')
    expect(step?.verifierVerdict).toEqual({ pass: false, reasoning: 'value never appeared' })
    expect(step?.selfHealOccurred).toBe(true)
    expect(step?.briefDigest).toBe('digest-xyz')
    expect(step?.status).toBe('failed')
    expect(step?.error).toBe('assertion failed')
    expect(step?.stepText).toBe('Save it')
    // This fixture measured nothing, so the row carries no `tokenUsage`, not zeros.
    expect(step?.tokenUsage).toBeUndefined()
  })

  it('a measured stepFinalized persists its tokenUsage; an unmeasured one leaves the columns NULL', () => {
    const runId = 'r_tokens-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-in'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', { testId: 't-1', testIndex: 0 }))
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({
      stepIndex: 0,
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })))
    // A cache hit: the loop made no model call, so the payload carries no tokenUsage at all.
    ingest.handler(ev('run-bus', 'stepFinalized', stepFinalized({ stepIndex: 1, cacheStatus: 'hit' })))

    const steps = db.readRunDetailRows(runId)?.steps ?? []
    expect(steps).toHaveLength(2)
    expect(steps[0].tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect('tokenUsage' in steps[0]).toBe(true)
    expect('tokenUsage' in steps[1]).toBe(false)

    // The read mapper could hide a zero-fill, so this asserts the COLUMN. `absent ≠ zero` has to
    // be true at rest, not just on the way out: a `0` here would be a measurement nobody made.
    const raw = db as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }

    // The parts persisted separately — not one blob, and not a re-derived total.
    const parts = raw.db
      .prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM run_steps WHERE run_id = ? AND step_index = 0')
      .all(runId) as Array<{ prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null }>
    expect(parts[0]).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    // And the unmeasured step is NULL at rest, in every one of the three columns.
    const totals = raw.db
      .prepare('SELECT total_tokens FROM run_steps WHERE run_id = ? ORDER BY step_index')
      .all(runId) as Array<{ total_tokens: number | null }>
    expect(totals.map(r => r.total_tokens)).toEqual([15, null])
    const unmeasured = raw.db
      .prepare('SELECT prompt_tokens, completion_tokens, total_tokens FROM run_steps WHERE run_id = ? AND step_index = 1')
      .all(runId) as Array<{ prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null }>
    expect(unmeasured[0]).toEqual({ prompt_tokens: null, completion_tokens: null, total_tokens: null })
  })

  it('a thin member — testFinished with no testStarted — still gets a row', () => {
    const runId = 'r_thin-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    // The member's stream BEGINS with its terminal event: skipped by fail-fast.
    ingest.handler(ev('run-bus', 'testFinished', {
      testId: 't-skipped',
      testIndex: 3,
      outcome: 'skipped',
      failureSummary: 'skipped by fail-fast',
    }))

    const members = db.readRunDetailRows(runId)?.members ?? []
    expect(members).toHaveLength(1)
    expect(members[0].testIndex).toBe(3)
    expect(members[0].outcome).toBe('skipped')
    expect(members[0].failureSummary).toBe('skipped by fail-fast')
    expect(members[0].attempts).toBe(1)
    // Never an empty tree that looks like a bug: the member is there, with nothing under it.
    expect(db.readRunDetailRows(runId)?.steps).toEqual([])
  })

  it('a testFinished never blanks the identity fields testStarted wrote (the upsert coalesces)', () => {
    const runId = 'r_coalesce-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    ingest.handler(ev('run-bus', 'testStarted', {
      testId: 't-1', testIndex: 0, name: 'Named Test', filePath: 'tests/n.yaml', totalSteps: 4,
    }))
    ingest.handler(ev('run-bus', 'testFinished', { testId: 't-1', testIndex: 0, outcome: 'failed' }))

    const member = db.readRunDetailRows(runId)?.members[0]
    expect(member?.name).toBe('Named Test')
    expect(member?.filePath).toBe('tests/n.yaml')
    expect(member?.totalSteps).toBe(4)
    expect(member?.outcome).toBe('failed')
  })

  it('readRunDetailRows answers undefined for a run nothing recorded, and empty arrays for one that projected nothing', () => {
    const runId = 'r_empty-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    // ABSENCE AND EMPTINESS ARE DIFFERENT ANSWERS, and the op turns only the first into a refusal.
    expect(db.readRunDetailRows(runId)).toBeUndefined()

    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: testSource(),
      attributes,
      runId,
      now: () => '2026-08-27T00:00:00.000Z',
    })
    ingest.handler(ev('run-bus', 'runStarted', {}))
    expect(db.readRunDetailRows(runId)).toEqual({
      runId, members: [], steps: [], subActions: [],
    })
  })

  it('the module does not import the core Reporter interface (pure envelope consumption)', () => {
    const source = readFileSync(fileURLToPath(new URL('../dashboard-subscriber.ts', import.meta.url)), 'utf-8')
    expect(source).not.toMatch(/reporter\/types/)
    expect(source).not.toMatch(/\bimplements Reporter\b/)
    expect(source).not.toMatch(/import[^\n]*\bReporter\b[^\n]*agent-qa-core/)
  })
})

describe('the ingest owner stamp', () => {
  it('the ingest stamps its own row', () => {
    const self = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
    const owned = new DashboardDatabase({
      dbPath: ':memory:',
      runOwnership: { self, probe: { isAlive: () => true, incarnationOf: () => undefined } },
    })
    try {
      const insertedId = 'r_insert-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
      const inserted = createDashboardRunIngest({
        db: owned, sourceSnapshot: testSource(), attributes, runId: insertedId,
      })
      inserted.handler(ev(insertedId, 'runStarted', {}))

      const adoptedId = 'r_adopt-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
      owned.insertPendingRun({ id: adoptedId, name: 'Queued', attributes })
      expect(owned.readRunOwner(adoptedId)).toBeUndefined()
      owned.updateRunStatus(adoptedId, 'running')
      const adopted = createDashboardRunIngest({
        db: owned, sourceSnapshot: testSource(), attributes, runId: adoptedId,
      })
      adopted.handler(ev(adoptedId, 'runStarted', {}))

      const mintedId = generateRunId()
      const minted = createDashboardRunIngest({ db: owned, sourceSnapshot: testSource(), attributes, runId: mintedId })
      minted.handler(ev('run-bus', 'runStarted', {}))

      const ids = [insertedId, adoptedId, mintedId]
      expect(ids.every(id => id !== undefined)).toBe(true)
      for (const id of ids) {
        expect(owned.getRun(id!)?.status).toBe('running')
        expect(owned.readRunOwner(id!)).toEqual(self)
      }
    } finally {
      owned.close()
    }
  })
})

describe('the ingest claim', () => {
  const SELF: RunOwner = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
  const OTHER: RunOwner = { pid: 4343, incarnation: 'proc-starttime:9', host: 'h' }
  const PROJECTIONS = ['run_members', 'run_steps', 'run_sub_actions', 'execution_logs', 'run_artifacts']
  let dir: string
  const handles: DashboardDatabase[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-qa-443-ingest-claim-'))
  })

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function handleFor(self: RunOwner): DashboardDatabase {
    const handle = new DashboardDatabase({
      dbPath: join(dir, 'runs.db'),
      runOwnership: { self, probe: { isAlive: () => true, incarnationOf: () => undefined } },
    })
    handles.push(handle)
    return handle
  }

  function rowSnapshot(handle: DashboardDatabase, id: string): Array<Record<string, unknown>> {
    return handle['db'].prepare('SELECT * FROM runs WHERE id = ?').all(id) as Array<Record<string, unknown>>
  }

  function changedColumns(before: Array<Record<string, unknown>>, after: Array<Record<string, unknown>>): string {
    if (before.length !== after.length) return `row count ${before.length} -> ${after.length}`
    const [was, now] = [before[0] ?? {}, after[0] ?? {}]
    const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])]
    return keys.filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key])).join(', ')
  }

  function projectionCounts(handle: DashboardDatabase, id: string): Record<string, number> {
    return Object.fromEntries(PROJECTIONS.map((table) => [
      table,
      (handle['db'].prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(id) as { n: number }).n,
    ]))
  }

  function replayWholeRun(ingest: ReturnType<typeof createDashboardRunIngest>, id: string): void {
    ingest.handler(ev(id, 'runStarted', { memberTestCount: 1 }))
    ingest.handler(ev(id, 'testStarted', { testId: 't-a', testIndex: 0, name: 'Test A', filePath: 'tests/a.yaml' }))
    ingest.handler(ev(id, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'Click Save' }))
    ingest.handler(ev(id, 'stepFinalized', stepFinalized()))
    ingest.handler(ev(id, 'subActionRecorded', subActionRecorded()))
    ingest.handler(ev(id, 'hookFinished', {
      hookExecutionId: 'hook-1', hookName: 'seed', kind: 'hook', phase: 'setup', status: 'passed', durationMs: 5,
    }))
    ingest.handler(ev(id, 'testFinished', { testId: 't-a', testIndex: 0, outcome: 'failed', durationMs: 100 }))
    ingest.handler(ev(id, 'verdict', { verdict: 'failed' }))
    ingest.handler(ev(id, 'runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: seq }))
  }

  it('an ingest for an id another live process owns writes nothing under it', async () => {
    const other = handleFor(OTHER)
    const own = handleFor(SELF)
    const startedAt = '2026-10-16T23:00:00.000Z'
    const foreignId = other.insertRun({
      name: 'Owned elsewhere', status: 'running', duration: 0,
      attributes: { 'agent-qa.trigger': 'mcp' }, startedAt, endedAt: startedAt,
    })
    const before = rowSnapshot(own, foreignId)
    expect(before).toHaveLength(1)

    const created: string[] = []
    const refused = createDashboardRunIngest({
      db: own, runId: foreignId, sourceSnapshot: testSource(), configSnapshot: testConfig(), attributes,
      onRunCreated: (id) => { created.push(id) },
    })
    replayWholeRun(refused, foreignId)
    refused.stageSnapshots({ config: testConfig(), source: testSource() })
    await refused.finalize({ runtime: { status: 'failed' } })

    expect(changedColumns(before, rowSnapshot(own, foreignId)), 'columns rewritten on the foreign row').toBe('')
    expect(own.readRunOwner(foreignId)).toEqual(OTHER)
    const written = Object.entries(projectionCounts(own, foreignId)).filter(([, n]) => n > 0)
    expect(written.map(([table]) => table).join(', '), 'rows were filed under the foreign id').toBe('')
    expect(created.join(', '), 'onRunCreated fired for a refused claim').toBe('')

    const controlId = 'r_control-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const control = createDashboardRunIngest({
      db: own, runId: controlId, sourceSnapshot: testSource(), configSnapshot: testConfig(), attributes,
    })
    replayWholeRun(control, controlId)
    await control.finalize()
    const unwritten = Object.entries(projectionCounts(own, controlId)).filter(([, n]) => n === 0)
    expect(unwritten.map(([table]) => table).join(', '), 'the replay wrote nothing to').toBe('')
  })

  it("the dashboard's queued row is adopted once the queue flipped it", async () => {
    const own = handleFor(SELF)
    const queuedId = own.insertPendingRun({ name: 'Queued', attributes: { 'agent-qa.trigger': 'dashboard' } })
    expect(own.updateRunStatus(queuedId, 'running')).toBe(true)

    const created: string[] = []
    const ingest = createDashboardRunIngest({
      db: own, runId: queuedId, attributes: { 'agent-qa.trigger': 'dashboard' },
      onRunCreated: (id) => { created.push(id) },
    })
    ingest.handler(ev(queuedId, 'runStarted', { memberTestCount: 1 }))
    expect(own.getRun(queuedId)).toMatchObject({ status: 'running', name: 'Queued' })
    expect(own.readRunOwner(queuedId)).toEqual(SELF)
    expect(created).toEqual([queuedId])

    ingest.handler(ev(queuedId, 'testFinished', { testIndex: 0, outcome: 'failed', durationMs: 10 }))
    ingest.handler(ev(queuedId, 'verdict', { verdict: 'failed' }))
    ingest.handler(ev(queuedId, 'runFinished', { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize()
    expect(own.getRun(queuedId)?.status).toBe('failed')
    expect(own.getRuns().map((run) => run.id)).toEqual([queuedId])
  })

  it('an ingest claims a fresh id under this process', () => {
    const own = handleFor(SELF)
    const freshId = 'r_fresh-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const created: string[] = []
    const ingest = createDashboardRunIngest({
      db: own, runId: freshId, sourceSnapshot: testSource(), attributes,
      onRunCreated: (id) => { created.push(id) },
    })
    ingest.handler(ev(freshId, 'runStarted', {}))

    expect(own.getRuns().map((run) => [run.id, run.status])).toEqual([[freshId, 'running']])
    expect(own.readRunOwner(freshId)).toEqual(SELF)
    expect(created).toEqual([freshId])
  })
})

describe('the ingest run id', () => {
  const TABLES = ['run_members', 'run_steps', 'run_sub_actions', 'execution_logs', 'run_artifacts']

  function misfiled(id: string): string {
    const runIds = (db['db'].prepare('SELECT id FROM runs').all() as Array<{ id: string }>).map((row) => row.id)
    const offenders = runIds.join(',') === id ? [] : [`runs: ${runIds.join(',') || 'empty'}`]
    for (const table of TABLES) {
      const filed = (db['db'].prepare(`SELECT DISTINCT run_id FROM ${table}`).all() as Array<{ run_id: string }>)
        .map((row) => row.run_id)
      if (filed.join(',') !== id) offenders.push(`${table}: ${filed.join(',') || 'empty'}`)
    }
    return offenders.join('; ')
  }

  function replayMember(ingest: ReturnType<typeof createDashboardRunIngest>, id: string, testIndex: number): void {
    const name = `Member ${String(testIndex)}`
    ingest.handler(ev(id, 'testStarted', { testId: `t-${String(testIndex)}`, testIndex, name, filePath: 'tests/m.yaml' }))
    ingest.handler(ev(id, 'stepStarted', { testIndex, stepIndex: 0, stepText: 'Click Save' }))
    ingest.handler(ev(id, 'stepFinalized', stepFinalized({ testIndex })))
    ingest.handler(ev(id, 'subActionRecorded', subActionRecorded({ testIndex })))
    ingest.handler(ev(id, 'hookFinished', {
      hookExecutionId: `hook-${String(testIndex)}`, hookName: 'seed', kind: 'hook', phase: 'setup',
      status: 'passed', durationMs: 5, testIndex,
    }))
    ingest.handler(ev(id, 'testFinished', { testId: `t-${String(testIndex)}`, testIndex, outcome: 'passed', durationMs: 10 }))
  }

  it('every row the ingest writes is filed under the id it was built with', async () => {
    const unnamed = (): unknown =>
      // @ts-expect-error a run's own id is required construction data
      createDashboardRunIngest({ db })
    expect(typeof unnamed).toBe('function')

    const builtWith = 'r_built-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db, runId: builtWith, sourceSnapshot: testSource(), configSnapshot: testConfig(), attributes,
    })
    ingest.handler(ev('run-bus', 'runStarted', { memberTestCount: 1 }))
    replayMember(ingest, 'run-bus', 0)
    ingest.handler(ev('run-bus', 'verdict', { verdict: 'passed' }))
    ingest.handler(ev('run-bus', 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize({ runtime: { status: 'passed' } })

    expect(misfiled(builtWith), 'rows filed under another id or missing').toBe('')
    expect(db.getRun(builtWith)?.status).toBe('passed')
  })

  it('an ingest built for a suite files the suite run under the same id', async () => {
    const builtWith = 'r_suitebuilt-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    const ingest = createDashboardRunIngest({
      db,
      runId: builtWith,
      sourceSnapshot: { kind: 'suite', suiteId: 's_smoke', name: 'Smoke Suite', loadStatus: 'loaded' },
      members: [0, 1].map((testIndex) => ({
        testId: `t-${String(testIndex)}`,
        name: `Member ${String(testIndex)}`,
        filePath: 'tests/m.yaml',
        suiteId: 's_smoke',
        suiteName: 'Smoke Suite',
      })),
      configSnapshot: testConfig(),
      attributes,
    })
    ingest.handler(ev('run-bus', 'runStarted', { memberTestCount: 2 }))
    replayMember(ingest, 'run-bus', 0)
    replayMember(ingest, 'run-bus', 1)
    ingest.handler(ev('run-bus', 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize()

    expect(misfiled(builtWith), 'rows filed under another id or missing').toBe('')
    expect(db.getRun(builtWith)).toMatchObject({ name: 'Smoke Suite', suiteId: 's_smoke', status: 'passed' })
    expect(db.readRunDetailRows(builtWith)?.members.map((member) => member.testIndex)).toEqual([0, 1])
  })
})

// The record must learn it owns its row before any write that can throw.
describe('the closing write after a failed artifact write', () => {
  it('an ingest whose artifact write fails after its claim still reports the claimed row', () => {
    const owner: RunOwner = { pid: 4242, incarnation: 'proc-starttime:7', host: 'h' }
    const real = new DashboardDatabase({
      dbPath: ':memory:',
      runOwnership: { self: owner, probe: { isAlive: () => true, incarnationOf: () => undefined } },
    })
    try {
      let thrown = false
      const failing = new Proxy(real, {
        get(subject, property, receiver) {
          const value = Reflect.get(subject, property, receiver) as unknown
          if (property === 'insertRunArtifact' && typeof value === 'function') {
            return (...args: unknown[]) => {
              if (!thrown) {
                thrown = true
                throw new Error('disk I/O error')
              }
              return (value as (...rest: unknown[]) => unknown).apply(subject, args)
            }
          }
          return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(subject) : value
        },
      })
      const id = generateRunId()
      const created: string[] = []
      const ingest = createDashboardRunIngest({
        db: failing, runId: id, sourceSnapshot: testSource(), attributes,
        onRunCreated: (createdId) => { created.push(createdId) },
      })

      expect(() => ingest.handler(ev(id, 'runStarted', {}))).toThrow('disk I/O error')

      expect(thrown, 'the failing write was never reached').toBe(true)
      expect(real.getRun(id)?.status).toBe('running')
      expect(real.isOwnStamp(id, owner), 'the claim left no own stamp').toBe(true)
      expect(created, 'onRunCreated did not report the claimed row').toEqual([id])
    } finally {
      real.close()
    }
  })
})
