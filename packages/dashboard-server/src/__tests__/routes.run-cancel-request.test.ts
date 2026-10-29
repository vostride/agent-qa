import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunEventEnvelope, RunEventType, RunSession } from '@vostride/agent-qa-schema'

import { DashboardDatabase } from '../db/database.js'
import type { RunOwner, RunOwnerProbe } from '../db/run-owner.js'
import type { ExecutionBackend, RunSettledStatus } from '../execution/execution-backend.js'
import { createInProcessExecutionBackend } from '../execution/in-process-backend.js'
import { JobQueue } from '../queue/job-queue.js'
import { createDashboardRunIngest } from '../reporter/index.js'
import { startServer } from '../server/server.js'

const HOST = 'h'
const SELF: RunOwner = { pid: 1000, incarnation: 'inc-self', host: HOST }
const probe: RunOwnerProbe = {
  isAlive: () => true,
  incarnationOf: () => undefined,
}
const RUN_ENDED_AT = '2026-10-17T12:00:05.000Z'

let dir: string
let dbPath: string
let configPath: string
let reader: DashboardDatabase
let seq = 0
const cleanups: Array<() => void> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-444-cancel-'))
  dbPath = join(dir, 'runs.db')
  configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  reader = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
  seq = 0
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  reader.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function ev(runId: string, type: RunEventType, payload: Record<string, unknown> = {}): RunEventEnvelope {
  seq += 1
  return { seq, ts: Date.now(), runId, type, payload } as RunEventEnvelope
}

class HeldSession {
  readonly executionContext = 'local-headless' as RunSession['executionContext']
  status: RunSession['status'] = 'running'
  cancels = 0
  readonly done = new Promise<never>(() => {})
  private readonly published: RunEventEnvelope[] = []
  private readonly live = new Set<(event: RunEventEnvelope) => void>()

  constructor(
    readonly id: RunSession['id'],
    private readonly onCancel: (session: HeldSession) => void = () => undefined,
  ) {}

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
    this.onCancel(this)
  }
}

function seedOwnRunning(name: string): string {
  const seeding = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
  try {
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const id = seeding.insertRun({ name, status: 'running', duration: 0, startedAt, endedAt: startedAt })
    seeding.insertRunArtifact({ runId: id, kind: 'test' })
    return id
  } finally {
    seeding.close()
  }
}

function snapshotOf(id: string): string {
  return JSON.stringify({ row: reader.getRun(id), artifact: reader.getRunArtifact(id) })
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class RecordingBackend extends EventEmitter {
  readonly killed: string[] = []
  constructor(private readonly delivers: boolean) {
    super()
  }
  execute = (): void => undefined
  kill = (runId: string): boolean => {
    this.killed.push(runId)
    return this.delivers
  }
  killAll = (): void => undefined
  getActiveExecutions = (): [] => []
}

async function startDashboard(backend: ExecutionBackend): Promise<{ origin: string; db: DashboardDatabase }> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const db = new DashboardDatabase({ dbPath, runOwnership: { self: SELF, probe } })
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    executionBackend: backend,
  })
  cleanups.push(() => handle.close())
  const { port } = handle.server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${String(port)}`, db }
}

async function cancelOver(origin: string, id: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch { /* a non-JSON body is compared as text */ }
  return { status: response.status, body }
}

async function enqueueOver(origin: string, name: string): Promise<string> {
  const response = await fetch(`${origin}/api/queue/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(response.status, await response.clone().text()).toBe(202)
  return ((await response.json()) as { runId: string }).runId
}

interface LiveDashboard {
  origin: string
  sessions: Map<string, HeldSession>
  releases: Map<string, () => void>
  settled: Array<{ runId: string; status: RunSettledStatus }>
}

async function startLiveDashboard(onCancel: (session: HeldSession) => void): Promise<LiveDashboard> {
  const sessions = new Map<string, HeldSession>()
  const releases = new Map<string, () => void>()
  const settled: Array<{ runId: string; status: RunSettledStatus }> = []
  let serverDb: DashboardDatabase | undefined
  const backend = createInProcessExecutionBackend({
    invokeRun: async ({ opts, onSession }) => {
      const ingest = createDashboardRunIngest({ db: serverDb!, runId: opts.runId, now: () => RUN_ENDED_AT })
      const session = new HeldSession(opts.runId as RunSession['id'], onCancel)
      session.subscribe(1, ingest.handler)
      onSession(session as unknown as RunSession)
      session.publish(ev(opts.runId, 'runStarted', { memberTestCount: 1 }))
      session.publish(ev(opts.runId, 'testStarted', { testId: 't-1', testIndex: 0, name: 'Held test' }))
      sessions.set(opts.runId, session)
      await new Promise<void>((resolve) => releases.set(opts.runId, resolve))
      await ingest.finalize()
    },
  })
  backend.on('run-settled', (runId: string, status: RunSettledStatus) => settled.push({ runId, status }))
  const started = await startDashboard(backend)
  serverDb = started.db
  return { origin: started.origin, sessions, releases, settled }
}

function verdictOnCancel(verdict: string): (session: HeldSession) => void {
  return (session) => {
    setImmediate(() => {
      session.publish(ev(session.id, 'testFinished', { testId: 't-1', testIndex: 0, outcome: verdict }))
      session.publish(ev(session.id, 'verdict', { verdict }))
      session.publish(ev(session.id, 'runFinished', { aggregateVerdict: verdict }))
    })
  }
}

describe('C444-CANCEL-REQUEST', () => {
  it("a cancel on this dashboard's running run asks it to stop and writes nothing", async () => {
    const asked: string[] = []
    const queue = new JobQueue({
      db: reader,
      requestStop: (runId: string) => {
        asked.push(runId)
        return true
      },
    })
    cleanups.push(() => queue.stop())
    const byQueue = queue.enqueue({ name: 'Own run, queue' })
    queue.processNext()
    expect(reader.getRun(byQueue)?.status).toBe('running')
    const before = snapshotOf(byQueue)

    expect(queue.cancel(byQueue)).toEqual({ kind: 'stop-requested' })
    expect(asked).toEqual([byQueue])
    expect(snapshotOf(byQueue)).toBe(before)
    const row = reader.getRun(byQueue)!
    expect(row.status).toBe('running')
    expect(row.failureSummary ?? null).toBeNull()
    expect(reader.getRunArtifact(byQueue)?.finalizedAt ?? null).toBeNull()

    const byRoute = seedOwnRunning('Own run, route')
    const routeBefore = snapshotOf(byRoute)
    const backend = new RecordingBackend(true)
    const { origin } = await startDashboard(backend as unknown as ExecutionBackend)
    const answer = await cancelOver(origin, byRoute)
    expect(answer.status).toBe(202)
    expect((answer.body as { outcome?: string }).outcome).toBe('stop-requested')
    expect(backend.killed).toEqual([byRoute])
    expect(snapshotOf(byRoute)).toBe(routeBefore)
  })

  it("the row takes the run's own verdict after the stop", async () => {
    const live = await startLiveDashboard(verdictOnCancel('cancelled'))
    const runId = await enqueueOver(live.origin, 'Held run')
    await waitFor(() => live.sessions.has(runId), 'the run to start')
    expect(reader.getRun(runId)?.status).toBe('running')

    const answer = await cancelOver(live.origin, runId)
    expect(answer.status).toBe(202)
    expect(live.sessions.get(runId)!.cancels).toBe(1)
    await waitFor(() => reader.getRun(runId)?.status !== 'running', 'the run to reach its verdict')
    expect(reader.getRun(runId)?.endedAt).toBe(RUN_ENDED_AT)
    live.releases.get(runId)!()
    await waitFor(() => live.settled.length === 1, 'the run to settle')

    const row = reader.getRun(runId)!
    expect(row.status).toBe('cancelled')
    expect(row.endedAt).toBe(RUN_ENDED_AT)
    expect(row.failureSummary ?? null).toBeNull()
    expect(live.settled).toEqual([{ runId, status: 'cancelled' }])
    const errors = reader.getRunArtifact(runId)?.payload.errors ?? []
    expect(errors).toEqual([])
  })

  it('a run that reached passed before the stop landed keeps passed', async () => {
    const live = await startLiveDashboard(verdictOnCancel('passed'))
    const runId = await enqueueOver(live.origin, 'Run that passes anyway')
    await waitFor(() => live.sessions.has(runId), 'the run to start')

    const answer = await cancelOver(live.origin, runId)
    expect(answer.status).toBe(202)
    await waitFor(() => reader.getRun(runId)?.status !== 'running', 'the run to reach its verdict')
    live.releases.get(runId)!()
    await waitFor(() => live.settled.length === 1, 'the run to settle')

    const row = reader.getRun(runId)!
    expect(row.status).toBe('passed')
    expect(row.endedAt).toBe(RUN_ENDED_AT)
    expect(row.failureSummary ?? null).toBeNull()
    expect(live.settled).toEqual([{ runId, status: 'completed' }])
  })

  it('a pending row is cancelled by the queue itself', () => {
    const asked: string[] = []
    const queue = new JobQueue({
      db: reader,
      requestStop: (runId: string) => {
        asked.push(runId)
        return true
      },
    })
    cleanups.push(() => queue.stop())
    const pending = queue.enqueue({ name: 'Queued' })

    expect(queue.cancel(pending)).toEqual({ kind: 'cancelled' })
    expect(asked).toEqual([])
    const row = reader.getRun(pending)!
    expect(row.status).toBe('cancelled')
    expect(row.endedAt).toBeTruthy()
    expect(reader.getRunArtifact(pending)?.payload.errors).toEqual([
      { code: 'cancelled', phase: 'queue', message: 'Run cancelled before execution' },
    ])
  })

  it("the backend's kill leaves the handle's status to the run", async () => {
    const runId = 'run-kill-status'
    let session: HeldSession | undefined
    let release: (() => void) | undefined
    const settled: RunSettledStatus[] = []
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        session = new HeldSession(opts.runId as RunSession['id'])
        onSession(session as unknown as RunSession)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
    backend.on('run-settled', (_id: string, status: RunSettledStatus) => settled.push(status))
    backend.execute({ runId, args: [], source: 'dashboard' })
    await waitFor(() => session !== undefined, 'the session')
    session!.publish(ev(runId, 'runStarted', { memberTestCount: 1 }))

    expect(backend.kill(runId)).toBe(true)
    expect(session!.cancels).toBe(1)
    const statusOf = () => backend.getActiveExecutions().find((active) => active.runId === runId)?.status
    expect(statusOf()).toBe('running')

    session!.publish(ev(runId, 'verdict', { verdict: 'cancelled' }))
    expect(statusOf()).toBeUndefined()
    release?.()
    await waitFor(() => settled.length === 1, 'the settle')
    expect(settled).toEqual(['cancelled'])
  })
})

function finishOwnRow(id: string, status: string): void {
  reader.updateRun(id, {
    status,
    endedAt: '2026-10-17T12:00:09.000Z',
    duration: 4321,
  })
}

describe('C444-CANCEL-ANSWERS', () => {
  it('a pending run answers 200 cancelled before it started', async () => {
    const backend = new RecordingBackend(true)
    const { origin } = await startDashboard(backend as unknown as ExecutionBackend)
    const first = await enqueueOver(origin, 'Holds the queue')
    const second = await enqueueOver(origin, 'Waits its turn')
    await waitFor(() => reader.getRun(first)?.status === 'running', 'the first run to start')
    expect(reader.getRun(second)?.status).toBe('pending')

    expect(await cancelOver(origin, second)).toEqual({
      status: 200,
      body: { outcome: 'cancelled', message: 'Run cancelled before it started.' },
    })
    expect(reader.getRun(second)?.status).toBe('cancelled')
    expect(backend.killed).toEqual([])
  })

  it('a running run here answers 202 stop requested', async () => {
    const backend = new RecordingBackend(true)
    const { origin } = await startDashboard(backend as unknown as ExecutionBackend)
    const id = seedOwnRunning('Own run')
    const before = snapshotOf(id)

    expect(await cancelOver(origin, id)).toEqual({
      status: 202,
      body: { outcome: 'stop-requested', message: 'Stop requested. The run will end with its own verdict.' },
    })
    expect(backend.killed).toEqual([id])
    expect(snapshotOf(id)).toBe(before)
  })

  it('a running run this dashboard cannot reach answers 409 and writes nothing', async () => {
    const backend = new RecordingBackend(false)
    const { origin } = await startDashboard(backend as unknown as ExecutionBackend)
    const id = seedOwnRunning('Own run started by POST /run')
    const before = snapshotOf(id)

    expect(await cancelOver(origin, id)).toEqual({
      status: 409,
      body: {
        error: "This run can't be stopped from the dashboard. Stop it where it was started.",
        reason: 'not-stoppable-here',
      },
    })
    expect(backend.killed).toEqual([id])
    expect(snapshotOf(id)).toBe(before)
    expect(reader.getRun(id)?.status).toBe('running')
  })

  it('a finished run answers 200 with its verdict and writes nothing', async () => {
    const backend = new RecordingBackend(true)
    const { origin } = await startDashboard(backend as unknown as ExecutionBackend)
    const id = seedOwnRunning('Own run that passed')
    finishOwnRow(id, 'passed')
    const before = snapshotOf(id)
    const row = reader.getRun(id)!
    expect([row.status, row.endedAt, row.duration, row.failureSummary ?? null])
      .toEqual(['passed', '2026-10-17T12:00:09.000Z', 4321, null])

    expect(await cancelOver(origin, id)).toEqual({
      status: 200,
      body: { outcome: 'finished', status: 'passed', message: 'This run already finished: passed.' },
    })
    expect(backend.killed).toEqual([])
    expect(snapshotOf(id)).toBe(before)
  })
})

describe('C444-NO-CAUSE-GUESS', () => {
  it('a settled run whose output says the browser closed is written failed, never cancelled', async () => {
    const backend = new RecordingBackend(true)
    await startDashboard(backend as unknown as ExecutionBackend)
    const lines = [
      'Error: page.click: Target page, context or browser has been closed',
      'Error: The browser closed before this test finished.',
    ]
    const ids = lines.map((line) => {
      const id = seedOwnRunning(`Closed browser: ${line}`)
      backend.emit('run-settled', id, 'failed', { output: ['debug line', line] })
      return id
    })

    expect(ids.map((id) => {
      const row = reader.getRun(id)!
      return { status: row.status, failureSummary: row.failureSummary }
    })).toEqual(lines.map((line) => ({ status: 'failed', failureSummary: line })))
    for (const id of ids) {
      expect(reader.getRunArtifact(id)?.payload.errors?.map((error) => error.code))
        .toEqual(['process-close'])
    }
  })

  it('the settle handler never rewrites a row the run already finished', async () => {
    const backend = new RecordingBackend(true)
    await startDashboard(backend as unknown as ExecutionBackend)
    const id = seedOwnRunning('Own run the run cancelled itself')
    finishOwnRow(id, 'cancelled')
    const before = snapshotOf(id)

    backend.emit('run-settled', id, 'cancelled', { output: [] })

    expect(snapshotOf(id)).toBe(before)
    const row = reader.getRun(id)!
    expect([row.status, row.endedAt, row.duration]).toEqual(['cancelled', '2026-10-17T12:00:09.000Z', 4321])
  })
})
