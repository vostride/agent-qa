// C433-HOOK-LOG-IDENTITY (433-41, G-433-12, CR-01, F-433-35). Every run of a hooked test keeps its
// own Setup/Teardown rows in one dashboard database, through the ids the real runHooks mints, and a
// retried member keeps its final attempt's in-attempt hook rows.

import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  runHooks,
  type HookDefinition,
  type HookEmitSeam,
  type HookExecutorPort,
  type HookRunIdentity,
} from '@vostride/agent-qa-runner'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'

import { DashboardDatabase } from '../db/database.js'
import { createDashboardRunIngest, type DashboardRunIngest } from '../reporter/dashboard-subscriber.js'
import { createRouter } from '../server/routes.js'

const RUN_A = 'r_hooked-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const RUN_B = 'r_hooked-juliet-kilo-lima-mike-november-oscar-papa-quebec-romeo'
const SUITE_RUN_A = 'r_suite-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const SUITE_RUN_B = 'r_suite-juliet-kilo-lima-mike-november-oscar-papa-quebec-romeo'
const TEST_ID = 't_hooked-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
const SUITE_ID = 's_hooked-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'

const SEED_HOOK: HookDefinition = {
  id: 'h_seed-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india',
  name: 'seed-db',
  runtime: 'bash',
  file: 'hooks/seed-db.sh',
  deps: [],
  timeout: 30_000,
  network: false,
}

const CLEAN_HOOK: HookDefinition = {
  id: 'h_clean-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india',
  name: 'clean-db',
  runtime: 'bash',
  file: 'hooks/clean-db.sh',
  deps: [],
  timeout: 30_000,
  network: false,
}

const attributes = {
  'agent-qa.trigger': 'cli',
  'agent-qa.runner': 'local',
} as const

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

const executor: HookExecutorPort = {
  async execute(hook) {
    const stdout = `${hook.name} ran`
    return { success: true, output: stdout, stdout, stderr: '', variables: { HOOK: hook.name }, duration: 12 }
  },
}

function seamFor(runId: string, ingest: DashboardRunIngest, minted: string[]): HookEmitSeam {
  return {
    hookStarted(payload) {
      minted.push(payload.hookExecutionId)
      ingest.handler(ev(runId, 'hookStarted', payload as unknown as Record<string, unknown>))
    },
    hookFinished(payload) {
      ingest.handler(ev(runId, 'hookFinished', payload as unknown as Record<string, unknown>))
    },
  }
}

// The CLI calls runHooks once per hook, with the run's emit seam and the member's identity
// (run.ts direct path 4329/4468, suite path 3402/3497).
async function runHook(
  hook: HookDefinition,
  emit: HookEmitSeam,
  identity: HookRunIdentity,
): Promise<void> {
  await runHooks([hook], { executor, emit, identity })
}

async function ingestHookedTestRun(runId: string, minted: string[]): Promise<void> {
  const ingest = createDashboardRunIngest({
    db,
    sourceSnapshot: { kind: 'test', testId: TEST_ID, name: 'Hooked test', filePath: 'tests/hooked.yaml', loadStatus: 'loaded' },
    attributes,
    runId,
    now: () => '2026-10-05T00:00:00.000Z',
  })
  const emit = seamFor(runId, ingest, minted)
  ingest.handler(ev(runId, 'runStarted', {}))
  ingest.handler(ev(runId, 'testStarted', { testId: TEST_ID, testIndex: 0, name: 'Hooked test' }))
  await runHook(SEED_HOOK, emit, { phase: 'setup', scope: 'test', testIndex: 0 })
  await runHook(CLEAN_HOOK, emit, { phase: 'teardown', scope: 'test', testIndex: 0 })
  ingest.handler(ev(runId, 'testFinished', { testId: TEST_ID, testIndex: 0, outcome: 'passed', durationMs: 400 }))
  ingest.handler(ev(runId, 'runFinished', { aggregateVerdict: 'passed' }))
  await ingest.finalize()
}

async function ingestHookedSuiteRun(runId: string, minted: string[]): Promise<void> {
  const ingest = createDashboardRunIngest({
    db,
    sourceSnapshot: { kind: 'suite', suiteId: SUITE_ID, name: 'Hooked suite', loadStatus: 'loaded' },
    attributes,
    runId,
    now: () => '2026-10-05T00:00:00.000Z',
  })
  const emit = seamFor(runId, ingest, minted)
  ingest.handler(ev(runId, 'runStarted', { memberTestCount: 2 }))
  ingest.handler(ev(runId, 'testStarted', { testId: 't-a', testIndex: 0, name: 'A', suiteId: SUITE_ID, suiteName: 'Hooked suite' }))
  ingest.handler(ev(runId, 'testFinished', { testId: 't-a', testIndex: 0, outcome: 'passed', durationMs: 100 }))
  ingest.handler(ev(runId, 'testStarted', { testId: 't-b', testIndex: 1, name: 'B', suiteId: SUITE_ID, suiteName: 'Hooked suite' }))
  // run.ts:3407's spelling: scope 'test' with the member's suite index.
  await runHook(SEED_HOOK, emit, { phase: 'setup', scope: 'test', testIndex: 1 })
  ingest.handler(ev(runId, 'testFinished', { testId: 't-b', testIndex: 1, outcome: 'passed', durationMs: 100 }))
  ingest.handler(ev(runId, 'runFinished', { aggregateVerdict: 'passed' }))
  await ingest.finalize()
}

interface MockResponse {
  status: number
  body: string
}

async function invoke(
  router: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'
    req.url = url
    req.headers = { host: '127.0.0.1:3470' }
    process.nextTick(() => req.push(null))
    let status = 200
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      setHeader() {},
      write(chunk: string | Buffer) {
        body += chunk.toString()
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolve({ status, body })
      },
    } as unknown as ServerResponse
    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function summary(runId: string) {
  return db.getExecutionLogs({ runId }).map((log) => ({
    name: log.name,
    phase: log.phase,
    status: log.status,
    testIndex: log.testIndex,
  })).sort((a, b) => `${a.phase}:${a.name}`.localeCompare(`${b.phase}:${b.name}`))
}

describe('C433-HOOK-LOG-IDENTITY', () => {
  it('C433-HOOK-LOG-IDENTITY: two runs of the same hooked test each keep their setup and teardown rows', async () => {
    const mintedA: string[] = []
    const mintedB: string[] = []
    await ingestHookedTestRun(RUN_A, mintedA)
    const runARowsBefore = db.getExecutionLogs({ runId: RUN_A })
    await ingestHookedTestRun(RUN_B, mintedB)

    // The producer mints the same ids for both runs; the store must still keep both.
    expect(mintedA).toHaveLength(2)
    expect(mintedB).toEqual(mintedA)

    const expected = [
      { name: 'seed-db', phase: 'setup', status: 'passed', testIndex: 0 },
      { name: 'clean-db', phase: 'teardown', status: 'passed', testIndex: 0 },
    ]
    expect(summary(RUN_A)).toEqual(expected)
    expect(summary(RUN_B)).toEqual(expected)
    expect(db.getExecutionLogs({ runId: RUN_A })).toEqual(runARowsBefore)

    const router = createRouter({ db })
    for (const runId of [RUN_A, RUN_B]) {
      const response = await invoke(router, `/api/runs/${runId}/execution-logs`)
      expect(response.status).toBe(200)
      const { logs } = JSON.parse(response.body) as { logs: Array<{ name: string; phase: string; runId: string }> }
      expect(logs.map((log) => [log.runId, log.name, log.phase]).sort()).toEqual([
        [runId, 'clean-db', 'teardown'],
        [runId, 'seed-db', 'setup'],
      ])
    }
  })

  it("C433-HOOK-LOG-IDENTITY: a suite member's hook keeps its row in a second suite run", async () => {
    const mintedA: string[] = []
    const mintedB: string[] = []
    await ingestHookedSuiteRun(SUITE_RUN_A, mintedA)
    await ingestHookedSuiteRun(SUITE_RUN_B, mintedB)

    expect(mintedB).toEqual(mintedA)
    const expected = [{ name: 'seed-db', phase: 'setup', status: 'passed', testIndex: 1 }]
    expect(summary(SUITE_RUN_A)).toEqual(expected)
    expect(summary(SUITE_RUN_B)).toEqual(expected)
  })

  it('C433-HOOK-LOG-IDENTITY: two hook rows without an execution id in one millisecond both persist', () => {
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: { kind: 'test', testId: TEST_ID, name: 'Hooked test', filePath: 'tests/hooked.yaml', loadStatus: 'loaded' },
      attributes,
      runId: RUN_A,
      now: () => '2026-10-05T00:00:00.000Z',
    })
    ingest.handler(ev(RUN_A, 'runStarted', {}))
    ingest.handler(ev(RUN_A, 'testStarted', { testId: TEST_ID, testIndex: 0 }))
    for (const hookName of ['first-hook', 'second-hook']) {
      ingest.handler(ev(RUN_A, 'hookFinished', {
        hookName,
        phase: 'setup',
        scope: 'test',
        testIndex: 0,
        status: 'passed',
        durationMs: 5,
        stdout: '',
        stderr: '',
        variables: {},
      }))
    }

    expect(db.getExecutionLogs({ runId: RUN_A }).map((log) => log.name).sort()).toEqual(['first-hook', 'second-hook'])
  })

  it("C433-HOOK-LOG-IDENTITY: a retried member keeps the final attempt's inline hook rows and its setup row", async () => {
    const ingest = createDashboardRunIngest({
      db,
      sourceSnapshot: { kind: 'test', testId: TEST_ID, name: 'Hooked test', filePath: 'tests/hooked.yaml', loadStatus: 'loaded' },
      attributes,
      runId: RUN_A,
      now: () => '2026-10-05T00:00:00.000Z',
    })
    const emit = seamFor(RUN_A, ingest, [])
    ingest.handler(ev(RUN_A, 'runStarted', {}))
    ingest.handler(ev(RUN_A, 'testStarted', { testId: TEST_ID, testIndex: 0, name: 'Hooked test' }))
    await runHook(SEED_HOOK, emit, { phase: 'setup', scope: 'test', testIndex: 0 })

    // member-runner mints in-attempt ids per attempt, so both attempts send `hook-t0-0`.
    const inline = (status: 'passed' | 'failed') => ev(RUN_A, 'hookFinished', {
      hookName: 'inline-check',
      phase: 'inline',
      hookExecutionId: 'hook-t0-0',
      hookId: CLEAN_HOOK.id,
      testIndex: 0,
      stepIndex: 0,
      status,
      durationMs: 7,
      stdout: `attempt ${status}`,
      stderr: '',
      variables: {},
      kind: 'hook',
    })
    ingest.handler(inline('failed'))
    ingest.handler(ev(RUN_A, 'testRetryScheduled', { testId: TEST_ID, testIndex: 0, attempt: 1, maxAttempts: 2 }))
    ingest.handler(inline('passed'))
    ingest.handler(ev(RUN_A, 'testFinished', { testId: TEST_ID, testIndex: 0, outcome: 'passed', durationMs: 400 }))

    const logs = db.getExecutionLogs({ runId: RUN_A })
    const inlineRows = logs.filter((log) => log.phase === 'inline' && log.testIndex === 0 && log.stepIndex === 0)
    expect(inlineRows.map((log) => [log.status, log.stdout])).toEqual([['passed', 'attempt passed']])
    expect(logs.filter((log) => log.phase === 'setup').map((log) => [log.name, log.status, log.testIndex]))
      .toEqual([['seed-db', 'passed', 0]])
  })
})
