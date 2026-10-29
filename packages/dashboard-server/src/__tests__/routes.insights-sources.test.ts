// Insights counts what the run store holds; a source that could not be read is named, never zeroed.

import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'
import { RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

const KNOWLEDGE_ID = 'test:planted-run-knowledge-op'
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

function insertRun(id: string, startedAt: string, modelName?: string): string {
  return db.insertRun({
    id,
    name: `Run ${id}`,
    status: 'passed',
    duration: 1000,
    startedAt,
    endedAt: startedAt,
    ...(modelName === undefined ? {} : { modelName }),
  })
}

function usage(model: string, promptTokens: number, completionTokens: number) {
  return {
    tokenUsage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    modelUsage: {
      roles: {
        planner: { declared: { provider: 'openai', modelId: model }, respondingModelIds: [model] as [string] },
        verifier: { declared: { provider: 'openai', modelId: model }, respondingModelIds: [model] as [string] },
      },
      calls: { started: 2, succeeded: 2, failed: 0 },
      inputTokens: promptTokens,
      outputTokens: completionTokens,
    },
  }
}

function insertStep(runId: string, stepIndex: number, extra: Record<string, unknown> = {}): void {
  db.insertRunStep({
    runId,
    testIndex: 0,
    stepIndex,
    cacheStatus: 'miss',
    verifierVerdict: { pass: true, reasoning: 'ok' },
    selfHealOccurred: false,
    briefDigest: `step ${stepIndex}`,
    status: 'passed',
    durationMs: 10,
    ...extra,
  })
}

type KnowledgeAnswer = 'throw' | 'incomplete' | readonly string[]

function plantHost(answers: Record<string, KnowledgeAnswer>) {
  const calls: { functionId: string; input: unknown }[] = []
  const host: AgentHost = {
    registry: REGISTRY,
    caller: CALLER,
    runsPostProcessingFunctionId: 'test:planted-post-processing-op',
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
      if (functionId !== KNOWLEDGE_ID) {
        return Promise.reject(new Error(`the fixture plants no answer for ${functionId}`))
      }
      const runId = (input as { runId: string }).runId
      const answer = answers[runId] ?? []
      if (answer === 'throw') return Promise.reject(new Error('handoff unreadable'))
      if (answer === 'incomplete') return Promise.resolve({ kind: 'evidence-incomplete', runId })
      return Promise.resolve({
        kind: 'ready',
        runId,
        buildOrdinal: 3,
        knowledgeStore: 'bound',
        steps: [],
        curation: { status: 'complete' },
        learned: {
          changes: answer.map((change, index) => ({
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
  return { host, calls }
}

interface MockResponse {
  status: number
  body: string
  headers: Record<string, string>
}

async function invoke(
  router: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'
    req.url = url
    req.headers = { host: '127.0.0.1:3470', ...headers }
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

describe('token usage', () => {
  it('run-step tokens count as test-run usage in the window', () => {
    insertRun('r_in_window', '2026-04-01T10:00:00.000Z', 'gpt-5.4')
    insertStep('r_in_window', 0, usage('gpt-5.4-mini', 1000, 40))
    insertStep('r_in_window', 1, usage('gpt-5.4-mini', 2000, 60))
    insertStep('r_in_window', 2)
    insertRun('r_before_window', '2025-12-31T10:00:00.000Z', 'gpt-5.4')
    insertStep('r_before_window', 0, usage('gpt-5.4-mini', 900_000, 900))
    db.insertTokenEvent({ modelName: 'claude-live', promptTokens: 500, completionTokens: 50, source: 'live-editor' })

    const stats = db.getTokenEventStats({ from: FROM }) as ReturnType<DashboardDatabase['getTokenEventStats']>
      & { testRunUnmeasuredSteps?: number }

    expect(stats.bySource['test-run']).toEqual({ promptTokens: 3000, completionTokens: 100 })
    expect(stats.bySource['live-editor']).toEqual({ promptTokens: 500, completionTokens: 50 })
    expect(stats.totals).toEqual({ promptTokens: 3500, completionTokens: 150 })
    expect(stats.byModel).toContainEqual({
      date: '2026-04-01',
      model: 'gpt-5.4-mini',
      promptTokens: 3000,
      completionTokens: 100,
    })
    expect(stats.byModel.some((row) => row.model === 'claude-live')).toBe(true)
    expect(stats.testRunUnmeasuredSteps).toBe(1)
  })

  it('a measured step without a model identity falls back to the run model, then to unattributed', () => {
    insertRun('r_run_model', '2026-04-02T10:00:00.000Z', 'gpt-5.4')
    insertStep('r_run_model', 0, { tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
    insertRun('r_no_model', '2026-04-03T10:00:00.000Z')
    insertStep('r_no_model', 0, { tokenUsage: { promptTokens: 7, completionTokens: 1, totalTokens: 8 } })

    const stats = db.getTokenEventStats({ from: FROM })

    expect(stats.byModel).toContainEqual({ date: '2026-04-02', model: 'gpt-5.4', promptTokens: 10, completionTokens: 2 })
    expect(stats.byModel).toContainEqual({ date: '2026-04-03', model: 'unattributed', promptTokens: 7, completionTokens: 1 })
  })

  it('a step that made no model call is a measured zero, not unmeasured', () => {
    insertRun('r_cached', '2026-04-04T10:00:00.000Z', 'gpt-5.4')
    insertStep('r_cached', 0, {
      cacheStatus: 'hit',
      modelUsage: { roles: {}, calls: { started: 0, succeeded: 0, failed: 0 } },
    })

    const stats = db.getTokenEventStats({ from: FROM }) as ReturnType<DashboardDatabase['getTokenEventStats']>
      & { testRunUnmeasuredSteps?: number }

    expect(stats.testRunUnmeasuredSteps).toBe(0)
  })

  it('no double counting — a legacy test-run token event and run-step tokens are disjoint records, each counted once', () => {
    insertRun('r_legacy_window', '2026-04-05T10:00:00.000Z', 'gpt-5.4')
    insertStep('r_legacy_window', 0, usage('gpt-5.4-mini', 200, 20))
    db.insertTokenEvent({ modelName: 'gpt-4-legacy', promptTokens: 300, completionTokens: 30, source: 'test-run' })

    const stats = db.getTokenEventStats({ from: FROM })

    expect(stats.bySource['test-run']).toEqual({ promptTokens: 500, completionTokens: 50 })
    expect(stats.totals).toEqual({ promptTokens: 500, completionTokens: 50 })
    const promptFor = (model: string) => stats.byModel
      .filter((row) => row.model === model)
      .reduce((sum, row) => sum + row.promptTokens, 0)
    expect(promptFor('gpt-5.4-mini')).toBe(200)
    expect(promptFor('gpt-4-legacy')).toBe(300)
    expect(stats.byModel.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(stats.totals.promptTokens)
  })
})

describe('knowledge changes', () => {
  it('knowledge changes are read per run through the agent host', async () => {
    insertRun('r_curated', '2026-04-01T10:00:00.000Z')
    insertRun('r_quiet', '2026-04-02T10:00:00.000Z')
    insertRun('r_old', '2025-06-01T10:00:00.000Z')
    const planted = plantHost({ r_curated: ['added', 'added', 'confirmed'], r_quiet: [] })
    const router = createRouter({ db, agentHost: planted.host })

    const res = await invoke(router, `/api/insights/knowledge-changes?from=${encodeURIComponent(FROM)}`)

    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 2,
      runsRead: 2,
      runsUnreadable: 0,
    })
    expect((body.byKind as Record<string, number>).added).toBe(2)
    expect((body.byKind as Record<string, number>).confirmed).toBe(1)
    expect(body.truncated).toBeUndefined()
    expect(planted.calls.map((call) => call.functionId)).toEqual([KNOWLEDGE_ID, KNOWLEDGE_ID])
    expect(planted.calls.map((call) => (call.input as { runId: string }).runId).sort()).toEqual(['r_curated', 'r_quiet'])
    const keys = collectKeys(body)
    for (const forbidden of ['summary', 'body', 'recordId', 'changes']) expect(keys.has(forbidden)).toBe(false)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('an unreadable run is counted as unreadable, not as zero', async () => {
    insertRun('r_curated', '2026-04-01T10:00:00.000Z')
    insertRun('r_broken', '2026-04-02T10:00:00.000Z')
    insertRun('r_pruned', '2026-04-03T10:00:00.000Z')
    const planted = plantHost({ r_curated: ['added'], r_broken: 'throw', r_pruned: 'incomplete' })
    const router = createRouter({ db, agentHost: planted.host })

    const res = await invoke(router, `/api/insights/knowledge-changes?from=${encodeURIComponent(FROM)}`)

    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body).toMatchObject({ status: 'read', runsInWindow: 3, runsRead: 1, runsUnreadable: 2 })
    expect((body.byKind as Record<string, number>).added).toBe(1)
  })

  it('no agent host answers unavailable', async () => {
    insertRun('r_curated', '2026-04-01T10:00:00.000Z')
    const router = createRouter({ db })

    const res = await invoke(router, '/api/insights/knowledge-changes')

    expect(res.status).toBe(503)
    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body.status).toBe('unavailable')
    expect(typeof body.reason).toBe('string')
    expect(body.byKind).toBeUndefined()
  })

  it('the read is capped at the latest 200 runs and says so', async () => {
    for (let index = 0; index < 201; index += 1) {
      const minute = String(index % 60).padStart(2, '0')
      const hour = String(Math.floor(index / 60)).padStart(2, '0')
      insertRun(`r_cap_${String(index).padStart(3, '0')}`, `2026-04-01T${hour}:${minute}:00.000Z`)
    }
    const planted = plantHost({})
    const router = createRouter({ db, agentHost: planted.host })

    const res = await invoke(router, `/api/insights/knowledge-changes?from=${encodeURIComponent(FROM)}`)

    const body = JSON.parse(res.body) as Record<string, unknown>
    expect(body).toMatchObject({
      status: 'read',
      runsInWindow: 201,
      runsRead: 200,
      runsUnreadable: 0,
      truncated: { read: 200, total: 201 },
    })
    const read = new Set(planted.calls.map((call) => (call.input as { runId: string }).runId))
    expect(read.size).toBe(200)
    expect(read.has('r_cap_000')).toBe(false)
  })

  it('a cross-site page cannot drive the read', async () => {
    insertRun('r_curated', '2026-04-01T10:00:00.000Z')
    const planted = plantHost({ r_curated: ['added'] })
    const router = createRouter({ db, agentHost: planted.host })

    const res = await invoke(router, '/api/insights/knowledge-changes', { origin: 'https://evil.example' })

    expect(res.status).toBe(403)
    expect(planted.calls).toHaveLength(0)
  })
})
