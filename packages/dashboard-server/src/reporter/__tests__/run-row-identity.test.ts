import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType, RunSession } from '@vostride/agent-qa-schema'
import { generateRunId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { DashboardDatabase } from '../../db/database.js'
import {
  createInProcessExecutionBackend,
  runStatusFromEnvelope,
} from '../../execution/in-process-backend.js'
import { createDashboardRunIngest, formatRunTitle, type RunIdentityMember } from '../index.js'

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

function member(name: string, suite?: { suiteId: string; suiteName: string }): RunIdentityMember {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-')
  return { name, testId: generateTestId(), filePath: `tests/${slug}.yaml`, ...(suite ?? {}) }
}

function claim(members: readonly RunIdentityMember[] | undefined) {
  const runId = generateRunId()
  const ingest = createDashboardRunIngest({
    db,
    runId,
    ...(members === undefined ? {} : { members }),
    now: () => '2026-10-17T00:00:00.000Z',
  })
  ingest.handler(ev(runId, 'runStarted', { memberTestCount: members?.length ?? 0 }))
  const row = db.getRun(runId)
  expect(row, 'the claim wrote no row').toBeDefined()
  return {
    runId,
    ingest,
    identity: {
      name: row?.name,
      testId: row?.testId,
      filePath: row?.filePath,
      suiteId: row?.suiteId,
      status: row?.status,
    },
  }
}

describe('C444-RUN-TITLE', () => {
  it('formatRunTitle names two tests, then counts the rest', () => {
    expect(formatRunTitle(['Login', 'Checkout'])).toBe('Login · Checkout')
    expect(formatRunTitle(['Login', 'Checkout', 'Search'])).toBe('Login · Checkout +1 more')
    expect(formatRunTitle(['Login', 'Checkout', 'Search', 'Logout'])).toBe('Login · Checkout +2 more')
    expect(formatRunTitle(['Login'])).toBe('Login')
    expect(formatRunTitle([])).toBe('run')
  })

  it('a multi-test run is titled at the claim and carries no test id or file path', () => {
    const members = [member('Login'), member('Checkout'), member('Search')]
    const { identity } = claim(members)
    expect(identity.name).toBe('Login · Checkout +1 more')
    expect(identity).toEqual({
      name: 'Login · Checkout +1 more',
      testId: null,
      filePath: null,
      suiteId: null,
      status: 'running',
    })
  })

  it("a run claimed with no members keeps the store's default name and no ids", () => {
    for (const members of [undefined, []]) {
      const { identity } = claim(members)
      expect(identity).toEqual({ name: 'run', testId: null, filePath: null, suiteId: null, status: 'running' })
    }
  })
})

describe('C444-SINGLE-TITLE', () => {
  it('a single-test run is titled, identified and filed by its test at the claim', () => {
    const only = member('Login')
    const { identity } = claim([only])
    expect(identity).toEqual({
      name: 'Login',
      testId: only.testId,
      filePath: only.filePath,
      suiteId: null,
      status: 'running',
    })
  })
})

describe('C444-SUITE-TITLE', () => {
  it("a one-suite run keeps the suite's name and id", () => {
    const suite = { suiteId: generateSuiteId(), suiteName: 'Storefront smoke' }
    const { identity } = claim([member('Login', suite), member('Checkout', suite), member('Search', suite)])
    expect(identity).toEqual({
      name: 'Storefront smoke',
      testId: null,
      filePath: null,
      suiteId: suite.suiteId,
      status: 'running',
    })
  })

  it('a run spanning two suites is titled by the suite names and carries no suite id', () => {
    const checkout = { suiteId: generateSuiteId(), suiteName: 'Checkout suite' }
    const login = { suiteId: generateSuiteId(), suiteName: 'Login suite' }
    const search = { suiteId: generateSuiteId(), suiteName: 'Search suite' }
    const two = claim([member('Pay', checkout), member('Sign in', login), member('Refund', checkout)])
    expect(two.identity).toEqual({
      name: 'Checkout suite · Login suite',
      testId: null,
      filePath: null,
      suiteId: null,
      status: 'running',
    })
    const three = claim([
      member('Pay', checkout),
      member('Sign in', login),
      member('Refund', checkout),
      member('Find', search),
    ])
    expect(three.identity.name).toBe('Checkout suite · Login suite +1 more')
    expect(three.identity.suiteId).toBeNull()
  })
})

function ticking(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 9, 17, 0, 0, tick++)).toISOString()
}

function startRun(members: readonly RunIdentityMember[]) {
  const runId = generateRunId()
  const ingest = createDashboardRunIngest({ db, runId, members, now: ticking() })
  ingest.handler(ev(runId, 'runStarted', { memberTestCount: members.length }))
  const read = () => {
    const row = db.getRun(runId)
    return {
      name: row?.name,
      testId: row?.testId,
      suiteId: row?.suiteId,
      status: row?.status,
      endedAt: row?.endedAt,
    }
  }
  const started = (index: number) => {
    const { suiteId, suiteName, ...rest } = members[index]!
    ingest.handler(ev(runId, 'testStarted', {
      ...rest,
      testIndex: index,
      ...(suiteId === undefined ? {} : { suiteId, suiteName }),
    }))
  }
  const finished = (index: number, outcome: string) => {
    ingest.handler(ev(runId, 'testFinished', {
      testId: members[index]!.testId,
      testIndex: index,
      outcome,
      durationMs: 1000 + index,
    }))
  }
  return { runId, ingest, read, started, finished }
}

describe('C444-NO-MEMBER-WRITES', () => {
  it("a member's start writes nothing on the run row", () => {
    const loose = startRun([member('Login'), member('Checkout'), member('Search')])
    const atClaim = loose.read()
    loose.started(0)
    loose.started(1)
    expect(loose.read().name).toBe(atClaim.name)
    expect(loose.read()).toEqual(atClaim)

    const a = { suiteId: generateSuiteId(), suiteName: 'Suite A' }
    const b = { suiteId: generateSuiteId(), suiteName: 'Suite B' }
    const spanning = startRun([member('Pay', a), member('Sign in', b)])
    const spanningAtClaim = spanning.read()
    spanning.started(0)
    expect(spanning.read()).toEqual(spanningAtClaim)
  })

  it("a member's finish leaves the row running with its claim's end time", () => {
    const run = startRun([member('Login'), member('Checkout'), member('Search')])
    const atClaim = run.read()
    run.started(0)
    run.finished(0, 'failed')
    expect(run.read().status).toBe('running')
    expect(run.read().endedAt).toBe(atClaim.endedAt)
  })

  it('the verdict alone moves the row off running', () => {
    const members = [member('Login'), member('Checkout'), member('Search')]
    const run = startRun(members)
    const seen: Array<string | undefined> = []
    members.forEach((_, index) => {
      run.started(index)
      run.finished(index, index === 0 ? 'failed' : 'passed')
      seen.push(run.read().status)
    })
    expect(seen).toEqual(['running', 'running', 'running'])
    run.ingest.handler(ev(run.runId, 'verdict', { verdict: 'failed' }))
    expect(run.read().status).toBe('failed')
  })

  it("member rows keep every member's identity and outcome", () => {
    const members = [member('Login'), member('Checkout'), member('Search')]
    const run = startRun(members)
    const outcomes = ['failed', 'passed', 'passed']
    members.forEach((_, index) => {
      run.started(index)
      run.finished(index, outcomes[index]!)
    })
    const rows = db.readRunDetailRows(run.runId)?.members ?? []
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => [row.testIndex, row.testId, row.name, row.outcome])).toEqual(
      members.map((entry, index) => [index, entry.testId, entry.name, outcomes[index]]),
    )
  })
})

class CountingSession {
  readonly executionContext = 'local-headless' as RunSession['executionContext']
  status: RunSession['status'] = 'running'
  cancels = 0
  readonly done = new Promise<never>(() => {})
  private readonly published: RunEventEnvelope[] = []
  private readonly live = new Set<(event: RunEventEnvelope) => void>()

  constructor(readonly id: RunSession['id']) {}

  publish(envelope: RunEventEnvelope): void {
    this.published.push(envelope)
    for (const handler of [...this.live]) handler(envelope)
  }

  subscribeFrames(): undefined {
    return undefined
  }

  streamCapabilityOf(): { kind: 'none' } {
    return { kind: 'none' }
  }

  subscribe(fromSeq: number, handler: (event: RunEventEnvelope) => void): () => void {
    for (const envelope of this.published) if (envelope.seq >= fromSeq) handler(envelope)
    this.live.add(handler)
    return () => {
      this.live.delete(handler)
    }
  }

  cancel(): void {
    this.cancels += 1
  }
}

describe('C444-BACKEND-RUN-STATUS', () => {
  it('the active list and kill survive member 1 finishing', async () => {
    const runId = generateRunId()
    let session: CountingSession | undefined
    let release: (() => void) | undefined
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        session = new CountingSession(opts.runId as RunSession['id'])
        onSession(session as unknown as RunSession)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    backend.execute({ runId, args: ['tests/login.yaml', 'tests/checkout.yaml'], source: 'dashboard' })
    for (let wait = 0; session === undefined && wait < 200; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(session, 'the starter never named its session').toBeDefined()
    session!.publish(ev(runId, 'runStarted', { memberTestCount: 2 }))
    session!.publish(ev(runId, 'testStarted', { testId: 't-a', testIndex: 0, name: 'Login' }))
    session!.publish(ev(runId, 'testFinished', { testId: 't-a', testIndex: 0, outcome: 'failed' }))
    session!.publish(ev(runId, 'testStarted', { testId: 't-b', testIndex: 1, name: 'Checkout' }))

    expect(backend.getActiveExecutions().map((active) => active.runId)).toEqual([runId])
    expect(backend.kill(runId)).toBe(true)
    expect(session!.cancels).toBe(1)
    release?.()
  })

  it('a handle takes its status from the run-level outcome only', () => {
    const runId = generateRunId()
    expect(runStatusFromEnvelope(ev(runId, 'testFinished', { testIndex: 0, outcome: 'failed' })))
      .toBeUndefined()
    expect(runStatusFromEnvelope(ev(runId, 'testFinished', { testIndex: 0, outcome: 'passed' })))
      .toBeUndefined()
    expect(runStatusFromEnvelope(ev(runId, 'verdict', { verdict: 'failed' }))).toBe('failed')
    expect(runStatusFromEnvelope(ev(runId, 'verdict', { verdict: 'passed' }))).toBe('completed')
    expect(runStatusFromEnvelope(ev(runId, 'runFinished', { aggregateVerdict: 'cancelled' })))
      .toBe('cancelled')
  })
})
