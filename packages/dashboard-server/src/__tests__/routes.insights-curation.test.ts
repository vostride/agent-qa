// C433-INSIGHTS-CURATION (433-42, G-433-13, CR-02, WR-04). A run counts as read only when its
// curation finished, or when its post-processing was skipped by design. Curation that failed
// or has not finished is counted on its own, and runs still queued or running are counted as in
// flight. None of them is folded into "read, nothing changed".

import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'
import { RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const KNOWLEDGE_ID = 'test:planted-run-knowledge-op'
const POST_PROCESSING_ID = 'test:planted-post-processing-op'
const REGISTRY = { planted: 'registry' } as unknown as AgentRegistryHandle
const CALLER = { id: 'planted-caller', grantedScopes: ['read'] } as unknown as AgentHost['caller']
const FROM = '2026-01-01T00:00:00.000Z'

let db: DashboardDatabase

beforeEach(() => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
})

afterEach(() => {
  db.close()
})

function insertRun(id: string, startedAt: string, status = 'passed'): string {
  return db.insertRun({
    id,
    name: `Run ${id}`,
    status,
    duration: 1000,
    startedAt,
    endedAt: startedAt,
  })
}

function insertQueuedRun(id: string): string {
  return db.insertPendingRun({ id, name: `Run ${id}` })
}

type CurationWord = 'pending' | 'running' | 'complete' | 'failed'
type KnowledgeAnswer = 'throw' | 'incomplete' | { curation: CurationWord; changes?: readonly string[] }
type PostProcessingAnswer = 'throw' | { skipped?: 'gate-run' | 'outcome-excluded' }

function plantHost(
  knowledge: Record<string, KnowledgeAnswer>,
  postProcessing: Record<string, PostProcessingAnswer> = {},
) {
  const calls: { functionId: string; input: unknown }[] = []
  const host: AgentHost = {
    registry: REGISTRY,
    caller: CALLER,
    runsPostProcessingFunctionId: POST_PROCESSING_ID,
    runsEventsFunctionId: 'test:planted-events-op',
    runsDetailFunctionId: 'test:planted-run-detail-op',
    runsEvidenceFunctionId: 'test:planted-run-evidence-op',
    runsArtifactFunctionId: 'test:planted-run-artifact-op',
    analysisGetFunctionId: 'test:planted-analysis-get-op',
    runsKnowledgeFunctionId: KNOWLEDGE_ID,
    runsMarkFunctionId: 'test:planted-run-mark-op',
    runsMarksHistoryFunctionId: 'test:planted-run-marks-history-op',
    runsMarkPreviewFunctionId: 'test:planted-run-mark-preview-op',
    invokeFunction: (_registry, functionId, input) => {
      calls.push({ functionId, input })
      const runId = (input as { runId: string }).runId
      if (functionId === POST_PROCESSING_ID) {
        const answer = postProcessing[runId] ?? {}
        if (answer === 'throw') return Promise.reject(new Error('post-processing unreadable'))
        return Promise.resolve({
          runId,
          chips: { analysis: 'complete', curation: 'pending' },
          stageDetails: {
            curation: { attempts: 1, lastFailureKind: 'planted', lastFailureReason: 'planted failure text' },
          },
          ...(answer.skipped === undefined ? {} : { skipped: { reason: answer.skipped } }),
        })
      }
      if (functionId !== KNOWLEDGE_ID) {
        return Promise.reject(new Error(`the fixture plants no answer for ${functionId}`))
      }
      const answer = knowledge[runId] ?? { curation: 'complete' }
      if (answer === 'throw') return Promise.reject(new Error('handoff unreadable'))
      if (answer === 'incomplete') return Promise.resolve({ kind: 'evidence-incomplete', runId })
      return Promise.resolve({
        kind: 'ready',
        runId,
        buildOrdinal: 3,
        knowledgeStore: 'bound',
        steps: [],
        curation: { status: answer.curation },
        learned: {
          changes: (answer.changes ?? []).map((change, index) => ({
            schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
            recordId: `rec_${runId}_${index}`,
            change,
            atOrdinal: 3,
            summary: `planted record text ${index}`,
          })),
          canaryAttributions: [],
        },
      })
    },
  }
  const runIdsFor = (functionId: string) => calls
    .filter((call) => call.functionId === functionId)
    .map((call) => (call.input as { runId: string }).runId)
    .sort()
  return { host, calls, runIdsFor }
}

interface MockResponse {
  status: number
  body: string
  headers: Record<string, string>
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
    const head: Record<string, string> = {}
    let status = 200
    let body = ''
    const res = {
      writeHead(code: number, values?: Record<string, string>) {
        status = code
        for (const [key, value] of Object.entries(values ?? {})) head[key.toLowerCase()] = value
        return this
      },
      setHeader(name: string, value: string) {
        head[name.toLowerCase()] = value
      },
      write(chunk: string | Buffer) {
        body += chunk.toString()
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolve({ status, body, headers: head })
      },
    } as unknown as ServerResponse
    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key)
      collectKeys(item, keys)
    }
  }
  return keys
}

async function readWindow(planted: ReturnType<typeof plantHost>, query = `?from=${encodeURIComponent(FROM)}`) {
  const router = createRouter({ db, agentHost: planted.host })
  const res = await invoke(router, `/api/insights/knowledge-changes${query}`)
  expect(res.status).toBe(200)
  return JSON.parse(res.body) as Record<string, unknown> & { byKind: Record<string, number> }
}

describe('C433-INSIGHTS-CURATION: curation state', () => {
  it('C433-INSIGHTS-CURATION: every window run\'s curation failed: none is read and each is counted as failed', async () => {
    insertRun('r_failed_a', '2026-04-01T10:00:00.000Z')
    insertRun('r_failed_b', '2026-04-02T10:00:00.000Z')
    const planted = plantHost({
      r_failed_a: { curation: 'failed' },
      r_failed_b: { curation: 'failed' },
    })

    const body = await readWindow(planted)

    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 2,
      runsRead: 0,
      runsCurationFailed: 2,
      runsCurationUnfinished: 0,
      runsUnreadable: 0,
      runsInFlight: 0,
    })
    for (const count of Object.values(body.byKind)) expect(count).toBe(0)
  })

  it('C433-INSIGHTS-CURATION: curation still running or queued is unfinished, not read', async () => {
    insertRun('r_curating', '2026-04-01T10:00:00.000Z')
    insertRun('r_curation_queued', '2026-04-02T10:00:00.000Z')
    const planted = plantHost(
      {
        r_curating: { curation: 'running', changes: ['added'] },
        r_curation_queued: { curation: 'pending' },
      },
      { r_curation_queued: {} },
    )

    const body = await readWindow(planted)

    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 2,
      runsRead: 0,
      runsCurationUnfinished: 2,
      runsCurationFailed: 0,
      runsUnreadable: 0,
    })
    expect(body.byKind.added).toBe(0)
    expect(planted.runIdsFor(POST_PROCESSING_ID)).toEqual(['r_curation_queued'])
  })

  it('C433-INSIGHTS-CURATION: a run whose post-processing was skipped reads as complete', async () => {
    insertRun('r_gate', '2026-04-01T10:00:00.000Z')
    const planted = plantHost({ r_gate: { curation: 'pending' } }, { r_gate: { skipped: 'gate-run' } })

    const body = await readWindow(planted)

    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 1,
      runsRead: 1,
      runsCurationUnfinished: 0,
      runsCurationFailed: 0,
      runsUnreadable: 0,
    })
    expect(planted.runIdsFor(POST_PROCESSING_ID)).toEqual(['r_gate'])
  })

  it('C433-INSIGHTS-CURATION: a pending run whose post-processing read throws is unfinished', async () => {
    insertRun('r_pending_unknown', '2026-04-01T10:00:00.000Z')
    const planted = plantHost({ r_pending_unknown: { curation: 'pending' } }, { r_pending_unknown: 'throw' })

    const body = await readWindow(planted)

    expect(body).toMatchObject({ runsRead: 0, runsCurationUnfinished: 1, runsUnreadable: 0 })
  })

  it('C433-INSIGHTS-CURATION: queued and running runs are in flight, not unreadable', async () => {
    insertRun('r_settled', '2026-04-01T10:00:00.000Z')
    insertRun('r_running', '2026-04-02T10:00:00.000Z', 'running')
    insertQueuedRun('r_queued')
    const planted = plantHost({
      r_settled: { curation: 'complete', changes: ['added'] },
      r_running: 'incomplete',
      r_queued: 'incomplete',
    })

    const body = await readWindow(planted, '')

    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 1,
      runsRead: 1,
      runsUnreadable: 0,
      runsInFlight: 2,
    })
    expect(body.byKind.added).toBe(1)
    expect(planted.runIdsFor(KNOWLEDGE_ID)).toEqual(['r_settled'])
  })

  it('C433-INSIGHTS-CURATION: the counts add up and only counts leave the arm', async () => {
    insertRun('r_done', '2026-04-01T10:00:00.000Z')
    insertRun('r_failed', '2026-04-02T10:00:00.000Z')
    insertRun('r_curating', '2026-04-03T10:00:00.000Z')
    insertRun('r_excluded', '2026-04-04T10:00:00.000Z')
    insertRun('r_curation_queued', '2026-04-05T10:00:00.000Z')
    insertRun('r_pruned', '2026-04-06T10:00:00.000Z')
    const planted = plantHost(
      {
        r_done: { curation: 'complete', changes: ['added', 'confirmed'] },
        r_failed: { curation: 'failed', changes: ['added'] },
        r_curating: { curation: 'running', changes: ['added'] },
        r_excluded: { curation: 'pending', changes: ['confirmed'] },
        r_curation_queued: { curation: 'pending', changes: ['added'] },
        r_pruned: 'incomplete',
      },
      { r_excluded: { skipped: 'outcome-excluded' }, r_curation_queued: {} },
    )

    const body = await readWindow(planted)

    const counts = body as unknown as Record<string, number>
    expect(counts.runsRead + counts.runsUnreadable + counts.runsCurationFailed + counts.runsCurationUnfinished)
      .toBe(6)
    expect(body).toMatchObject({
      runsInWindow: 6,
      runsRead: 2,
      runsUnreadable: 1,
      runsCurationFailed: 1,
      runsCurationUnfinished: 2,
      runsInFlight: 0,
    })
    expect(body.byKind.added).toBe(1)
    expect(body.byKind.confirmed).toBe(2)
    const keys = collectKeys(body)
    for (const forbidden of [
      'summary', 'body', 'recordId', 'changes', 'skipped', 'stageDetails', 'lastFailureReason', 'lastFailureKind',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
    expect(JSON.stringify(body)).not.toContain('planted')
  })
})
