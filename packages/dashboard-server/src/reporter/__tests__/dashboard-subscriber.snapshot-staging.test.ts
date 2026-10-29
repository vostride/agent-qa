import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEventEnvelope, RunEventType } from '@vostride/agent-qa-schema'
import { DashboardDatabase } from '../../db/database.js'
import { createRouter } from '../../server/routes.js'
import { createDashboardRunIngest } from '../dashboard-subscriber.js'

// G-433-5 / F-433-15 (433-29). No run on any door stored its test as written or its effective
// config: the dashboard door kept the queue's `loadStatus: 'queued'` source and never got a config,
// and the CLI door's ingest was built without either. The ingest now stages the producer's loaded
// snapshot onto its run's own artifact — once, never over a loaded section, never after finalize.

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

const FIRST_YAML = 'name: Login Test\ntest-id: t_login\ntarget: web\nsteps:\n  - Click Sign in\n'
const SECOND_YAML = 'name: Second Test\ntest-id: t_second\ntarget: web\nsteps:\n  - Click Next\n'

function loadedSource(rawYaml: string, name: string) {
  return {
    kind: 'test' as const,
    testId: `t_${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    filePath: 'tests/login.yaml',
    rawYaml,
    resolvedDefinition: { name, steps: ['Click Sign in'] },
    loadStatus: 'loaded' as const,
  }
}

function loadedConfig(model: string) {
  return {
    rawConfigContent: 'registry: {}\n',
    effectiveConfig: { use: { llm: model } },
    model: { planner: { provider: 'openai', model } },
    runtime: { platform: 'web', targetName: 'web' },
  }
}

// What `JobQueue` writes for a dashboard run it dispatches: a pending row, a queued artifact, then
// the flip to running.
function enqueueLikeTheQueue(name: string): string {
  const runId = db.insertPendingRun({ name, filePath: 'tests/login.yaml' })
  db.insertRunArtifact({
    runId,
    kind: 'test',
    payload: {
      runtime: { platform: 'web', queued: true },
      source: { name, filePath: 'tests/login.yaml', loadStatus: 'queued' },
      metadata: { attributes: {} },
    },
  })
  db.updateRunStatus(runId, 'running')
  return runId
}

async function missingSections(runId: string): Promise<string[]> {
  const router = createRouter(db)
  const body = await new Promise<string>((resolve, reject) => {
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'
    req.url = `/api/runs/${encodeURIComponent(runId)}/artifact`
    req.headers = { host: '127.0.0.1:3470' }
    process.nextTick(() => { req.push(null) })
    let text = ''
    const res = {
      writeHead() { return this },
      setHeader() {},
      getHeader() { return undefined },
      write(chunk: string | Buffer) { text += String(chunk); return true },
      end(chunk?: string | Buffer) { if (chunk) text += String(chunk); resolve(text) },
    } as unknown as ServerResponse
    try { router(req, res) } catch (error) { reject(error) }
  })
  return (JSON.parse(body) as { missingSections: string[] }).missingSections
}

function storedPayload(runId: string): Record<string, any> {
  const artifact = db.getRunArtifact(runId)
  expect(artifact, 'the run has an artifact').not.toBeNull()
  return artifact!.payload as unknown as Record<string, any>
}

describe('staging the loaded snapshot', () => {
  it('the queued source is replaced by the loaded snapshot', async () => {
    const runId = enqueueLikeTheQueue('tests/login.yaml')
    const ingest = createDashboardRunIngest({ db, runId })
    ingest.handler(ev('runStarted', { memberTestCount: 1 }))
    ingest.stageSnapshots({ config: loadedConfig('gpt-first'), source: loadedSource(FIRST_YAML, 'Login Test') })

    const payload = storedPayload(runId)
    expect(payload.source.loadStatus).toBe('loaded')
    expect(payload.source.rawYaml).toBe(FIRST_YAML)
    expect(payload.source.resolvedDefinition).toEqual({ name: 'Login Test', steps: ['Click Sign in'] })
    expect(payload.config.effectiveConfig).toEqual({ use: { llm: 'gpt-first' } })
    expect(await missingSections(runId)).toEqual([])
  })

  it('the first snapshot wins', async () => {
    const runId = enqueueLikeTheQueue('suite run')
    const ingest = createDashboardRunIngest({ db, runId })
    ingest.handler(ev('runStarted', { memberTestCount: 2 }))
    ingest.stageSnapshots({ config: loadedConfig('gpt-first'), source: loadedSource(FIRST_YAML, 'Login Test') })
    ingest.stageSnapshots({ config: loadedConfig('gpt-second'), source: loadedSource(SECOND_YAML, 'Second Test') })

    const payload = storedPayload(runId)
    expect(payload.source.rawYaml).toBe(FIRST_YAML)
    expect(payload.source.name).toBe('Login Test')
    expect(payload.config.effectiveConfig).toEqual({ use: { llm: 'gpt-first' } })
  })

  it('a finalized artifact is never re-staged', async () => {
    const runId = enqueueLikeTheQueue('tests/login.yaml')
    const ingest = createDashboardRunIngest({ db, runId })
    ingest.handler(ev('runStarted', { memberTestCount: 1 }))
    ingest.handler(ev('runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: seq }))
    await ingest.finalize()
    const before = db.getRunArtifact(runId)
    expect(before?.finalizedAt).toBeTruthy()

    ingest.stageSnapshots({ config: loadedConfig('gpt-late'), source: loadedSource(FIRST_YAML, 'Login Test') })

    const after = db.getRunArtifact(runId)
    expect(after?.payload).toEqual(before?.payload)
    expect(after?.updatedAt).toBe(before?.updatedAt)
    expect((after?.payload as unknown as Record<string, any>).source.loadStatus).toBe('queued')
  })

  it('a CLI-door run without a queued row gets both sections', async () => {
    const runId = 'r_cli-door-alpha-bravo-charlie-delta-echo-foxtrot-golf'
    const ingest = createDashboardRunIngest({ db, runId })
    // The member's snapshot can arrive before the bus delivers `runStarted`; it is held.
    ingest.stageSnapshots({ config: loadedConfig('gpt-cli'), source: loadedSource(FIRST_YAML, 'Login Test') })
    expect(db.getRunArtifact(runId)).toBeNull()
    ingest.handler(ev('runStarted', { memberTestCount: 1 }))

    const payload = storedPayload(runId)
    expect(payload.source.loadStatus).toBe('loaded')
    expect(payload.source.rawYaml).toBe(FIRST_YAML)
    expect(payload.config.effectiveConfig).toEqual({ use: { llm: 'gpt-cli' } })
    expect(await missingSections(runId)).toEqual([])
  })
})
