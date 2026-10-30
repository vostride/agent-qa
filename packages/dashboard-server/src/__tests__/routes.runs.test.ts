import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'

import {
  CLIENT_WRITABLE_QUEUED_RUN_METADATA_KEYS,
  MAX_QUEUED_EXECUTION_TIMEOUT_MS,
  RESPONSE_SAFE_RUN_METADATA_KEYS,
  RESPONSE_SAFE_RUN_READ_METHODS,
  SERVER_OWNED_RUN_METADATA_KEYS,
  createRouter,
  sanitizeQueuedExecutionTimeout,
} from '../server/routes.js'
import { RUN_ARTIFACT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

interface MockRun {
  id: string
  name: string
  filePath: string | null
  status: string
  duration: number
  attributes: Record<string, string>
  tags: string[] | null
  environment: string | null
  metadata: Record<string, unknown> | null
  startedAt: string | null
  endedAt: string | null
  source: string
  videoPath: string | null
  failureSummary: string | null
  errorLog: string | null
  testId: string | null
  suiteId: string | null
  platform: string
  testFileContent: string | null
  modelName: string | null
  llmProvider: string | null
  parallel: boolean
  createdAt: string
}

function createMockDatabase() {
  const runs: MockRun[] = []
  const executionLogs: Array<{ runId: string; message: string }> = []
  const artifacts = new Map<string, {
    runId: string
    kind: string
    schemaVersion: number
    payload: Record<string, unknown>
    finalizedAt: string | null
    createdAt: string
    updatedAt: string
  }>()

  function filterRuns(filters: Record<string, unknown> = {}): MockRun[] {
    const {
      status,
      name,
      tag,
      from,
      to,
      source,
      platform,
      limit,
      offset,
      attributePredicates,
    } = filters

    // Every row is top-level, so the mock starts from all of them.
    let filtered = [...runs]

    if (typeof status === 'string') {
      filtered = filtered.filter((run) => run.status === status)
    }
    if (typeof name === 'string') {
      filtered = filtered.filter((run) => run.name.includes(name) || run.id.includes(name))
    }
    if (typeof tag === 'string') {
      filtered = filtered.filter((run) => run.tags?.includes(tag))
    }
    if (typeof from === 'string') {
      filtered = filtered.filter((run) => run.startedAt !== null && run.startedAt >= from)
    }
    if (typeof to === 'string') {
      filtered = filtered.filter((run) => run.startedAt !== null && run.startedAt <= to)
    }
    if (typeof source === 'string') {
      filtered = filtered.filter((run) => run.source === source)
    }
    if (typeof platform === 'string') {
      filtered = filtered.filter((run) => run.platform === platform)
    }
    if (Array.isArray(attributePredicates)) {
      filtered = filtered.filter((run) =>
        attributePredicates.every((predicate) => {
          const value = run.attributes[predicate.key]
          if (typeof value !== 'string') return false
          if (predicate.mode === 'regex') return new RegExp(predicate.value).test(value)
          return value === predicate.value
        }),
      )
    }

    const start = typeof offset === 'number' ? offset : 0
    const end = typeof limit === 'number' ? start + limit : undefined
    return filtered.slice(start, end)
  }

  function collectAttributeEntries(key?: string, q?: string) {
    return runs.flatMap((run) => Object.entries(run.attributes))
      .filter(([entryKey, value]) => (!key || entryKey === key) && (!q || value.includes(q) || entryKey.includes(q)))
  }

  return {
    insertRun(run: Partial<MockRun>) {
      const id = run.id ?? randomUUID()
      runs.push({
        id,
        name: run.name ?? 'Unnamed Run',
        filePath: run.filePath ?? null,
        status: run.status ?? 'passed',
        duration: run.duration ?? 0,
        attributes: run.attributes ?? {},
        tags: run.tags ?? null,
        environment: run.environment ?? null,
        metadata: run.metadata ?? null,
        startedAt: run.startedAt ?? '2026-04-18T00:00:00Z',
        endedAt: run.endedAt ?? '2026-04-18T00:00:05Z',
        source: run.source ?? 'dashboard',
        videoPath: run.videoPath ?? null,
        failureSummary: run.failureSummary ?? null,
        errorLog: run.errorLog ?? null,
        testId: run.testId ?? null,
        suiteId: run.suiteId ?? null,
        platform: run.platform ?? 'web',
        testFileContent: run.testFileContent ?? null,
        modelName: run.modelName ?? null,
        llmProvider: run.llmProvider ?? null,
        parallel: run.parallel ?? false,
        createdAt: run.createdAt ?? '2026-04-18T00:00:00Z',
      })
      return id
    },
    getRuns(filters: Record<string, unknown> = {}) {
      return filterRuns(filters)
    },
    getRun(id: string) {
      return runs.find((run) => run.id === id)
    },
    getPendingRuns() {
      return runs.filter((run) => run.status === 'pending')
    },
    getNextPendingRun() {
      return runs.find((run) => run.status === 'pending')
    },
    getRunsByTest(test: { testId?: string }) {
      return runs.filter((run) => run.testId === test.testId)
    },
    getRunsByTestCount(test: { testId?: string }) {
      return runs.filter((run) => run.testId === test.testId).length
    },
    getTestTrends() {
      return []
    },
    getRunsBySuiteId(suiteId: string) {
      return runs.filter((run) => run.suiteId === suiteId)
    },
    getRunsBySuiteIdCount(suiteId: string) {
      return runs.filter((run) => run.suiteId === suiteId).length
    },
    getSuiteTrends() {
      return []
    },
    listRunAttributeKeys(opts: { limit?: number; q?: string } = {}) {
      const counts = new Map<string, number>()
      for (const [key] of collectAttributeEntries(undefined, opts.q)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
        .slice(0, opts.limit ?? 50)
    },
    listRunAttributeValues(key: string, opts: { limit?: number; q?: string } = {}) {
      const counts = new Map<string, number>()
      for (const [, value] of collectAttributeEntries(key, opts.q)) {
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
        .slice(0, opts.limit ?? 50)
    },
    insertRunArtifact(input: { runId: string; kind: string; payload?: Record<string, unknown> }) {
      const artifact = {
        runId: input.runId,
        kind: input.kind,
        schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
        payload: { schemaVersion: RUN_ARTIFACT_SCHEMA_VERSION, ...(input.payload ?? {}) },
        finalizedAt: null,
        createdAt: '2026-04-18T00:00:00Z',
        updatedAt: '2026-04-18T00:00:00Z',
      }
      artifacts.set(input.runId, artifact)
      return artifact
    },
    getRunArtifactBundle(runId: string) {
      // One run's artifact, shaped like the real member's.
      return { artifact: artifacts.get(runId) ?? null }
    },
    // The execution-logs arm crosses the display seam, so the mock answers it via `__plantLog`.
    getExecutionLogs(filters: { runId: string }) {
      return executionLogs.filter((entry) => entry.runId === filters.runId)
    },
    __plantLog(entry: { runId: string; message: string }) {
      executionLogs.push(entry)
    },
    close() {},
  }
}

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// Requests default to a loopback `Host`, because the display-seam read arms refuse any other.
const LOOPBACK_HOST_HEADER = { host: '127.0.0.1:3470' } as const

function createMockRequest(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url
  req.headers = { ...LOOPBACK_HOST_HEADER, ...options.headers }

  process.nextTick(() => {
    if (options.body) {
      req.push(Buffer.from(options.body))
    }
    req.push(null)
  })

  return req
}

async function invokeRoute(
  router: ReturnType<typeof createRouter>,
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = createMockRequest(url, options)
    const headers = new Map<string, string>()
    let status = 200
    let body = ''

    const res = {
      writeHead(statusCode: number, head?: Record<string, string>) {
        status = statusCode
        if (head) {
          for (const [key, value] of Object.entries(head)) {
            headers.set(key.toLowerCase(), value)
          }
        }
        return this
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value)
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase())
      },
      write(chunk: string | Buffer) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        }
        resolve({
          status,
          headers: Object.fromEntries(headers),
          body,
        })
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function createQueueRouter(db: ReturnType<typeof createMockDatabase>) {
  const enqueued: Array<Record<string, unknown>> = []
  const jobQueue = {
    enqueue(input: Record<string, unknown>) {
      enqueued.push(input)
      return `queued-${enqueued.length}`
    },
    getConcurrency() {
      return 1
    },
    getActiveCount() {
      return 0
    },
  }
  return {
    enqueued,
    router: createRouter({
      db: db as never,
      jobQueue: jobQueue as never,
    }),
  }
}

async function postJson(
  router: ReturnType<typeof createRouter>,
  path: string,
  body: Record<string, unknown>,
): Promise<MockResponse> {
  return invokeRoute(router, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST run enqueue trigger attributes', () => {
  let db: ReturnType<typeof createMockDatabase>

  beforeEach(() => {
    db = createMockDatabase()
  })

  it('keeps dashboard-triggered runs labeled as dashboard by default', async () => {
    const { router, enqueued } = createQueueRouter(db)

    const res = await postJson(router, '/api/runs/trigger', {})

    expect(res.status).toBe(202)
    expect(enqueued[0].attributes).toMatchObject({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
    })
  })

  it('keeps external queue API runs labeled as api', async () => {
    const { router, enqueued } = createQueueRouter(db)

    const res = await postJson(router, '/api/queue/enqueue', { name: 'API Run' })

    expect(res.status).toBe(202)
    expect(enqueued[0].attributes).toMatchObject({
      'agent-qa.trigger': 'api',
      'agent-qa.runner': 'local',
    })
  })

  it('labels MCP-triggered dashboard enqueue requests as mcp without copying raw payload fields', async () => {
    const { router, enqueued } = createQueueRouter(db)

    const res = await postJson(router, '/api/runs/trigger', {
      triggerSource: 'mcp',
      file: undefined,
      prompt: 'do not copy me',
      attributes: { 'agent-qa.trigger': 'evil', email: 'user@example.com' },
    })

    expect(res.status).toBe(202)
    expect(enqueued[0].attributes).toEqual({
      'agent-qa.trigger': 'mcp',
      'agent-qa.runner': 'local',
    })
  })

  it('rejects unsupported dashboard trigger sources deterministically', async () => {
    const { router, enqueued } = createQueueRouter(db)

    const res = await postJson(router, '/api/runs/trigger', { triggerSource: 'extension' })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toContain('triggerSource')
    expect(enqueued).toHaveLength(0)
  })
})

// The run trigger and the queue enqueue are same-site only; loopback callers with no `Origin` pass.
const RUN_ROUTES = ['/api/runs/trigger', '/api/queue/enqueue'] as const
const RUN_ROUTE_BODY: Record<(typeof RUN_ROUTES)[number], Record<string, unknown>> = {
  '/api/runs/trigger': {},
  '/api/queue/enqueue': { name: 'API Run' },
}

describe('the run trigger and the queue enqueue refuse a cross-site request', () => {
  const CROSS_SITE_SHAPES: ReadonlyArray<readonly [string, IncomingHttpHeaders]> = [
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['the literal null Origin', { origin: 'null' }],
    ['a cross-site fetch-metadata header', { 'sec-fetch-site': 'cross-site' }],
    ['a non-loopback Host (DNS rebinding)', { host: 'evil.example:3470' }],
  ]

  for (const path of RUN_ROUTES) {
    for (const [label, headers] of CROSS_SITE_SHAPES) {
      it(`${path} refuses ${label} before any run is queued`, async () => {
        const db = createMockDatabase()
        const { router, enqueued } = createQueueRouter(db)
        // A SIMPLE request — `text/plain` — the shape a page can send with no preflight.
        const res = await invokeRoute(router, path, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', ...headers },
          body: JSON.stringify(RUN_ROUTE_BODY[path]),
        })
        expect(res.status).toBe(403)
        expect(JSON.parse(res.body)).toEqual({ error: 'cross_site_refused' })
        expect(res.headers['access-control-allow-origin']).toBeUndefined()
        expect(enqueued).toEqual([])
        expect(db.getPendingRuns()).toEqual([])
      })
    }

    it(`a cross-site preflight to ${path} is refused with no grant`, async () => {
      const db = createMockDatabase()
      const { router, enqueued } = createQueueRouter(db)
      const res = await invokeRoute(router, path, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      })
      expect(res.status).toBe(403)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(res.headers['access-control-allow-methods']).toBeUndefined()
      expect(enqueued).toEqual([])
    })
  }
})

describe('the dashboard\'s own Run and a local client still start runs', () => {
  for (const path of RUN_ROUTES) {
    it(`the dashboard page's same-origin POST to ${path} queues one run`, async () => {
      const db = createMockDatabase()
      const { router, enqueued } = createQueueRouter(db)
      const res = await invokeRoute(router, path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:3470',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify(RUN_ROUTE_BODY[path]),
      })
      expect(res.status).toBe(202)
      expect(JSON.parse(res.body)).toMatchObject({ status: 'queued' })
      expect(enqueued).toHaveLength(1)
    })

    it(`a local client with no Origin (CLI, curl, the harness) queues one run on ${path}`, async () => {
      const db = createMockDatabase()
      const { router, enqueued } = createQueueRouter(db)
      const res = await postJson(router, path, RUN_ROUTE_BODY[path])
      expect(res.status).toBe(202)
      expect(enqueued).toHaveLength(1)
    })
  }

  it('a cross-site preflight on /api/runs is refused with no grant', async () => {
    const db = createMockDatabase()
    const { router } = createQueueRouter(db)
    const res = await invokeRoute(router, '/api/runs', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'cross_site_refused' })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('GET /api/runs route contract', () => {
  let db: ReturnType<typeof createMockDatabase>
  let router: ReturnType<typeof createRouter>

  beforeEach(() => {
    db = createMockDatabase()
    router = createRouter(db as never)
  })

  it('enriches test runs with targetName and filters by target', async () => {
    db.insertRun({
      id: 'run-web',
      name: 'Web Login',
      status: 'passed',
      platform: 'web',
      testFileContent: ['name: Web Login', 'target: hn-staging', 'steps: []'].join('\n'),
    })
    db.insertRun({
      id: 'run-android',
      name: 'Android Login',
      status: 'passed',
      platform: 'android',
      testFileContent: ['name: Android Login', 'target: mobile-staging', 'steps: []'].join('\n'),
    })

    const filteredRes = await invokeRoute(router, '/api/runs?target=hn-staging')
    expect(filteredRes.status).toBe(200)

    const filteredData = JSON.parse(filteredRes.body) as {
      runs: Array<{ id: string; targetName: string | null; destination?: string | null }>
      total: number
    }

    expect(filteredData.total).toBe(1)
    expect(filteredData.runs).toHaveLength(1)
    expect(filteredData.runs[0]).toMatchObject({
      id: 'run-web',
      targetName: 'hn-staging',
    })
    expect(filteredData.runs[0]).not.toHaveProperty('destination')
  })

  it('does not filter by legacy destination query parameters', async () => {
    db.insertRun({
      id: 'run-local',
      name: 'Local Run',
      metadata: { runDestination: 'Local' },
      testFileContent: ['name: Local Run', 'target: hn-staging', 'steps: []'].join('\n'),
    })
    db.insertRun({
      id: 'run-remote',
      name: 'Remote Run',
      metadata: { runDestination: 'Remote' },
      testFileContent: ['name: Remote Run', 'target: hn-staging', 'steps: []'].join('\n'),
    })

    const res = await invokeRoute(router, '/api/runs?destination=remote')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as {
      runs: Array<{ id: string; destination?: string | null }>
      total: number
    }

    expect(data.total).toBe(2)
    expect(data.runs.map((run) => run.id).sort()).toEqual(['run-local', 'run-remote'])
    expect(data.runs.every((run) => !('destination' in run))).toBe(true)
  })

  it('does not filter by legacy source query parameters', async () => {
    db.insertRun({ id: 'run-cli', name: 'CLI Run', source: 'cli' })
    db.insertRun({ id: 'run-dashboard', name: 'Dashboard Run', source: 'dashboard' })

    const res = await invokeRoute(router, '/api/runs?source=dashboard')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { runs: Array<{ id: string }>; total: number }
    expect(data.total).toBe(2)
    expect(data.runs.map((run) => run.id).sort()).toEqual(['run-cli', 'run-dashboard'])
  })

  it('filters runs by exact attribute bracket parameters', async () => {
    db.insertRun({
      id: 'run-main',
      name: 'Main Branch',
      attributes: { 'git.branch': 'phase223-main' },
    })
    db.insertRun({
      id: 'run-dev',
      name: 'Dev Branch',
      attributes: { 'git.branch': 'dev' },
    })

    const res = await invokeRoute(router, '/api/runs?attributes[git.branch]=phase223-main')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { runs: Array<{ id: string }>; total: number }
    expect(data.total).toBe(1)
    expect(data.runs[0].id).toBe('run-main')
  })

  it('filters runs by regex attribute bracket parameters', async () => {
    db.insertRun({
      id: 'run-phase',
      name: 'Phase Branch',
      attributes: { 'git.branch': 'phase223-main' },
    })
    db.insertRun({
      id: 'run-main',
      name: 'Main Branch',
      attributes: { 'git.branch': 'main' },
    })
    db.insertRun({
      id: 'run-dev',
      name: 'Dev Branch',
      attributes: { 'git.branch': 'dev' },
    })

    const res = await invokeRoute(router, '/api/runs?attributes[git.branch][regex]=^(phase223-main|main)$')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { runs: Array<{ id: string }>; total: number }
    expect(data.total).toBe(2)
    expect(data.runs.map((run) => run.id).sort()).toEqual(['run-main', 'run-phase'])
  })

  it('rejects invalid attribute regex filters', async () => {
    const res = await invokeRoute(router, '/api/runs?attributes[git.branch][regex]=(')
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toContain('Invalid attribute regex')
  })

  it('suggests run attribute keys and values with counts', async () => {
    db.insertRun({
      id: 'run-a',
      name: 'Run A',
      attributes: { 'git.branch': 'phase223-main', 'user.email': 'CI' },
    })
    db.insertRun({
      id: 'run-b',
      name: 'Run B',
      attributes: { 'git.branch': 'phase223-main' },
    })
    db.insertRun({
      id: 'run-c',
      name: 'Run C',
      attributes: { 'git.branch': 'main' },
    })

    const keysRes = await invokeRoute(router, '/api/runs/attributes/keys?q=git&limit=50')
    expect(keysRes.status).toBe(200)
    expect(JSON.parse(keysRes.body).keys).toEqual([{ key: 'git.branch', count: 3 }])

    const valuesRes = await invokeRoute(router, '/api/runs/attributes/values?key=git.branch&q=phase&limit=50')
    expect(valuesRes.status).toBe(200)
    expect(JSON.parse(valuesRes.body).values).toEqual([{ value: 'phase223-main', count: 2 }])
  })

  // The enrichment must reach a suite row exactly as it reaches a test row, from the same snapshot.
  it('enriches a suite row with the same target contract as a test row, and attaches no member list', async () => {
    db.insertRun({
      id: 'suite-run',
      name: 'Checkout Suite',
      suiteId: 'checkout-suite',
      platform: 'web',
      testFileContent: ['name: Checkout Suite', 'target: sample-target', 'steps: []'].join('\n'),
    })
    db.insertRun({
      id: 'plain-run',
      name: 'Plain Test',
      platform: 'web',
      testFileContent: ['name: Plain Test', 'target: sample-target', 'steps: []'].join('\n'),
    })

    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as {
      runs: Array<{ id: string; targetName: string | null; tests?: unknown }>
      total: number
    }

    expect(data.total).toBe(2)
    const suiteRow = data.runs.find((run) => run.id === 'suite-run')
    const plainRow = data.runs.find((run) => run.id === 'plain-run')
    expect(suiteRow?.targetName).toBe('sample-target')
    expect(plainRow?.targetName).toBe('sample-target')
    // No `tests` key on either — an absent key rather than a structurally empty array.
    expect(suiteRow).not.toHaveProperty('tests')
    expect(plainRow).not.toHaveProperty('tests')
  })

  it('pages at 50 and reports the whole matching count as the total', async () => {
    for (let index = 0; index < 55; index += 1) {
      db.insertRun({
        id: `parent-${index}`,
        name: `Parent ${index}`,
        testFileContent: [`name: Parent ${index}`, `target: target-${index}`, 'steps: []'].join('\n'),
      })
    }

    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as {
      runs: Array<{ id: string }>
      total: number
    }

    expect(data.runs).toHaveLength(50)
    expect(data.total).toBe(55)
  })

  it('returns a quiet null targetName when no parseable target snapshot exists', async () => {
    db.insertRun({
      id: 'no-target',
      name: 'Untargeted Run',
      testFileContent: 'name: Untargeted Run\nsteps: []\n',
    })

    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as {
      runs: Array<{ id: string; targetName: string | null }>
      total: number
    }

    expect(data.total).toBe(1)
    expect(data.runs[0]).toMatchObject({
      id: 'no-target',
      targetName: null,
    })
  })

  it('matches the existing name filter against run ids', async () => {
    db.insertRun({
      id: 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
      name: 'Visible Name Only',
      status: 'passed',
    })
    db.insertRun({
      id: 'r_other-run-id-that-should-not-match-query-value',
      name: 'Another Run',
      status: 'passed',
    })

    const res = await invokeRoute(
      router,
      '/api/runs?name=r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
    )
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as { runs: Array<{ id: string; name: string }>; total: number }
    expect(data.total).toBe(1)
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]).toMatchObject({
      id: 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
      name: 'Visible Name Only',
    })
  })

  it('returns persisted run artifacts without reading source files', async () => {
    db.insertRun({
      id: 'run-artifact',
      name: 'Artifact Run',
      testFileContent: 'name: stale current content',
    })
    db.insertRunArtifact({
      runId: 'run-artifact',
      kind: 'test',
      payload: {
        config: { rawConfigContent: 'registry: {}', envFile: { content: 'TOKEN=abc', variables: { TOKEN: 'abc' }, path: '.env' } },
        source: { kind: 'test', name: 'Artifact Run', rawYaml: 'name: original artifact content' },
      },
    })

    const res = await invokeRoute(router, '/api/runs/run-artifact/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      artifact: { payload: { config: any; source: any } }
      missingSections: string[]
    }

    expect(data.artifact.payload.config.envFile.content).toBe('TOKEN=abc')
    expect(data.artifact.payload.source.rawYaml).toBe('name: original artifact content')
    expect(data.missingSections).toEqual([])
  })

  it('sanitizes secrets metadata and secret placeholders in artifact API responses', async () => {
    const rawSecret = 'phase222-raw-secret-SHOULD-NOT-PERSIST-4f03b7'
    db.insertRun({
      id: 'run-secret-artifact',
      name: 'Secret Artifact Run',
    })
    db.insertRunArtifact({
      runId: 'run-secret-artifact',
      kind: 'test',
      payload: {
        config: {
          secretsFile: {
            path: '.secrets.local',
            status: 'loaded',
            count: 1,
            variables: { loginPassword: rawSecret },
            content: `loginPassword=${rawSecret}`,
          },
        },
        source: {
          kind: 'test',
          name: 'Secret Artifact Run',
          rawYaml: 'steps:\n  - Fill password with {{secret:loginPassword}}',
          resolvedDefinition: {
            steps: ['Fill password with {{secret:loginPassword}}'],
          },
        },
      },
    })

    const res = await invokeRoute(router, '/api/runs/run-secret-artifact/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      artifact: { payload: { config: any; source: any } }
    }
    const serialized = JSON.stringify(data)

    expect(serialized).not.toContain(rawSecret)
    expect(JSON.stringify(data.artifact.payload.config)).not.toContain('loginPassword')
    expect(data.artifact.payload.config.secretsFile).toEqual({
      path: '.secrets.local',
      status: 'loaded',
      count: 1,
    })
    expect(data.artifact.payload.source.rawYaml).toContain('[secret:loginPassword]')
    expect(data.artifact.payload.source.resolvedDefinition.steps[0]).toContain('[secret:loginPassword]')
  })

  it('does not call test or suite file managers when reading artifacts', async () => {
    db.insertRun({ id: 'run-db-only', name: 'DB Only Run' })
    db.insertRunArtifact({
      runId: 'run-db-only',
      kind: 'test',
      payload: {
        config: { rawConfigContent: 'registry: {}' },
        source: { kind: 'test', name: 'DB Only Run', rawYaml: 'name: preserved' },
      },
    })
    const throwIfCalled = () => {
      throw new Error('artifact route should not read live files')
    }
    const dbOnlyRouter = createRouter({
      db: db as never,
      testFileManager: { read: throwIfCalled, findByTestId: throwIfCalled, list: throwIfCalled } as never,
      suiteFileManager: { read: throwIfCalled, findBySuiteId: throwIfCalled, list: throwIfCalled } as never,
    })

    const res = await invokeRoute(dbOnlyRouter, '/api/runs/run-db-only/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { artifact: { payload: { source: { rawYaml: string } } } }
    expect(data.artifact.payload.source.rawYaml).toBe('name: preserved')
  })

  it('reports the artifact sections a run has not written', async () => {
    db.insertRun({ id: 'suite-run', name: 'Suite', source: 'suite' })
    db.insertRunArtifact({
      runId: 'suite-run',
      kind: 'test',
      payload: { source: { kind: 'suite', members: [{ index: 0 }] } },
    })

    const res = await invokeRoute(router, '/api/runs/suite-run/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>

    expect(data).not.toHaveProperty('children')
    expect(data.missingSections).toEqual(['config'])
  })

  it('returns artifact missing when the run has no artifact row', async () => {
    db.insertRun({ id: 'run-no-artifact', name: 'No Artifact' })

    const res = await invokeRoute(router, '/api/runs/run-no-artifact/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { artifact: null; missingSections: string[] }
    expect(data.artifact).toBeNull()
    expect(data.missingSections).toEqual(['artifact'])
  })

  it('returns 404 for nonexistent run artifacts', async () => {
    const res = await invokeRoute(router, '/api/runs/missing/artifact')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Run not found' })
  })
})

// Run-reading responses strip a stored confirm scope, because `json()` lets any origin read them.

const LEAKED_SCOPE = 'run-trigger:cr02-leaked-scope-3f19b2'
/** A metadata key nobody has invented yet — the allowlist's fail-closed proof. */
const FUTURE_FIELD_VALUE = 'cr02-a-field-added-next-phase-8ac41d'

function seedScopedRun(
  db: ReturnType<typeof createMockDatabase>,
  overrides: Partial<Parameters<ReturnType<typeof createMockDatabase>['insertRun']>[0]> = {},
): string {
  return db.insertRun({
    name: 'Scoped Run',
    metadata: {
      args: ['/w/tests/scoped.yaml'],
      confirmScope: LEAKED_SCOPE,
      laterField: FUTURE_FIELD_VALUE,
    },
    ...overrides,
  })
}

describe('no run-reading response hands out the confirm scope', () => {
  let db: ReturnType<typeof createMockDatabase>
  let router: ReturnType<typeof createRouter>

  beforeEach(() => {
    db = createMockDatabase()
    router = createRouter(db as never)
  })

  it('DOOR 1 — GET /api/runs (the list) carries no confirm scope', async () => {
    seedScopedRun(db, { id: 'run-list' })
    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)
    expect(res.body).not.toContain(LEAKED_SCOPE)
    expect(res.body).not.toContain(FUTURE_FIELD_VALUE)
    // The row really was served — an empty list would satisfy the assertion above.
    expect((JSON.parse(res.body) as { runs: unknown[] }).runs).toHaveLength(1)
  })

  it('DOOR 1 (nested) — the list serves no nested run rows at all any more', async () => {
    seedScopedRun(db, { id: 'run-suite-parent', suiteId: 'suite-a' })
    seedScopedRun(db, { id: 'run-suite-sibling', suiteId: 'suite-a' })
    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      runs: Array<Record<string, unknown>>
    }
    // Both rows are served — an empty list would satisfy every assertion below.
    expect(data.runs.map((run) => run.id).sort()).toEqual(['run-suite-parent', 'run-suite-sibling'])
    for (const run of data.runs) {
      expect(run).not.toHaveProperty('tests')
      expect(run.metadata).not.toHaveProperty('confirmScope')
    }
    expect(res.body).not.toContain(LEAKED_SCOPE)
  })

  it('DOOR 2 — GET /api/runs/:id (the detail) carries none, and serves one run row only', async () => {
    seedScopedRun(db, { id: 'run-detail', suiteId: 'suite-b' })
    const res = await invokeRoute(router, '/api/runs/run-detail')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      run: { id: string; metadata: Record<string, unknown> | null }
    }
    expect(Object.keys(data)).toEqual(['run'])
    // The row really was served, so the strip below is a strip and not an empty body.
    expect(data.run.id).toBe('run-detail')
    expect(data.run.metadata).toMatchObject({ args: ['/w/tests/scoped.yaml'] })
    expect(data.run.metadata).not.toHaveProperty('confirmScope')
    expect(res.body).not.toContain(LEAKED_SCOPE)
    expect(res.body).not.toContain(FUTURE_FIELD_VALUE)
  })

  it('DOOR 3 — GET /api/runs/:id/artifact carries none, in `run` AND in the artifact PAYLOAD', async () => {
    // The payload is shaped as the production writer shapes it, or the check could never fail.
    seedScopedRun(db, { id: 'run-artifact-scope' })
    const writerShapedPayload = {
      runtime: { platform: 'web', queued: true },
      source: { name: 'Scoped Run', filePath: '/w/tests/scoped.yaml', loadStatus: 'queued' },
      metadata: {
        args: ['/w/tests/scoped.yaml'],
        confirmScope: LEAKED_SCOPE,
        laterField: FUTURE_FIELD_VALUE,
        attributes: { 'ci.provider': 'local' },
      },
    }
    db.insertRunArtifact({ runId: 'run-artifact-scope', kind: 'test', payload: writerShapedPayload })
    const res = await invokeRoute(router, '/api/runs/run-artifact-scope/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      run: { metadata: Record<string, unknown> | null }
      artifact: { payload: Record<string, unknown> } | null
    }
    expect(data.run.metadata).not.toHaveProperty('confirmScope')
    expect(data).not.toHaveProperty('children')

    // THE PAYLOAD REALLY WAS SERVED before anything is claimed about what it does not contain.
    expect(data.artifact, 'the artifact door served no artifact — the cell would be vacuous').not.toBeNull()
    const served = data.artifact!.payload['metadata'] as Record<string, unknown>
    expect(served, 'the served payload carried no `metadata` object').toBeDefined()
    expect(served).not.toHaveProperty('confirmScope')
    expect(served).not.toHaveProperty('laterField')
    // AN ALLOWLIST APPLIED TO THE CLIENT OBJECT, NOT A DELETE OF THE FIELD: `attributes` is minted
    // by the queue beside the client's keys and the run-detail drawer reads it.
    expect(served['attributes']).toEqual({ 'ci.provider': 'local' })
    expect(served['args']).toEqual(['/w/tests/scoped.yaml'])

    expect(res.body).not.toContain(LEAKED_SCOPE)
    expect(res.body).not.toContain(FUTURE_FIELD_VALUE)
  })

  it('DOOR 4 — GET /api/queue/status carries none, in `pending`, `running` and `recent`', async () => {
    seedScopedRun(db, { id: 'run-pending', status: 'pending' })
    seedScopedRun(db, { id: 'run-running', status: 'running' })
    seedScopedRun(db, { id: 'run-done', status: 'passed' })
    const { router: queueRouter } = createQueueRouter(db)
    const res = await invokeRoute(queueRouter, '/api/queue/status?completed=true')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      pending: { jobs: Array<{ metadata: Record<string, unknown> | null }> }
      running: { jobs: Array<{ metadata: Record<string, unknown> | null }> }
      recent: Array<{ metadata: Record<string, unknown> | null }>
    }
    expect(data.pending.jobs).toHaveLength(1)
    expect(data.running.jobs).toHaveLength(1)
    expect(data.recent).toHaveLength(1)
    expect(data.pending.jobs[0]!.metadata).not.toHaveProperty('confirmScope')
    expect(data.running.jobs[0]!.metadata).not.toHaveProperty('confirmScope')
    expect(data.recent[0]!.metadata).not.toHaveProperty('confirmScope')
    expect(res.body).not.toContain(LEAKED_SCOPE)
  })

  it('DOOR 5 — GET /api/analytics/tests/:name carries none', async () => {
    seedScopedRun(db, { id: 'run-analytics-test', name: 'Checkout', testId: 't_checkout' })
    const res = await invokeRoute(router, '/api/analytics/tests/Checkout?testId=t_checkout')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { runs: Array<{ metadata: Record<string, unknown> | null }> }
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]!.metadata).not.toHaveProperty('confirmScope')
    expect(res.body).not.toContain(LEAKED_SCOPE)
  })

  it('DOOR 6 — GET /api/analytics/suites/:suiteId carries none', async () => {
    seedScopedRun(db, { id: 'run-analytics-suite', suiteId: 'suite-checkout' })
    const suiteRouter = createRouter({
      db: db as never,
      suiteFileManager: {
        findBySuiteId: async (suiteId: string) => ({ suiteId, name: 'Checkout Suite' }),
      } as never,
    })
    const res = await invokeRoute(suiteRouter, '/api/analytics/suites/suite-checkout')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { runs: Array<{ metadata: Record<string, unknown> | null }> }
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0]!.metadata).not.toHaveProperty('confirmScope')
    expect(res.body).not.toContain(LEAKED_SCOPE)
  })

  it('THE ALLOWLIST FAILS CLOSED — a metadata field invented later does not leave either', async () => {
    // The shape decision, measured. A keyed removal of `confirmScope` would pass every cell above
    // and still be one `metadata.x = <secret>` away from the same defect; this is the cell that
    // tells the two shapes apart.
    seedScopedRun(db, { id: 'run-future-field' })
    const res = await invokeRoute(router, '/api/runs/run-future-field')
    expect(res.status).toBe(200)
    expect(res.body).not.toContain(FUTURE_FIELD_VALUE)
    expect(JSON.parse(res.body).run.metadata).not.toHaveProperty('laterField')
  })

  it('A RUN WITH ONLY PUBLISHABLE METADATA IS SERIALIZED UNCHANGED — the no-op control', async () => {
    const publishable = {
      args: ['/w/tests/plain.yaml'],
      isSuite: true,
      timeout: 60_000,
      timeoutSource: 'config',
      timeoutBaseMs: 50_000,
      timeoutBufferMs: 10_000,
      suiteIndex: 2,
    }
    db.insertRun({ id: 'run-plain', name: 'Plain Run', metadata: publishable })
    const res = await invokeRoute(router, '/api/runs/run-plain')
    expect(res.status).toBe(200)
    expect((JSON.parse(res.body) as { run: { metadata: unknown } }).run.metadata).toEqual(publishable)
  })

  it('A RUN WITH NO METADATA AT ALL IS SERIALIZED UNCHANGED — `null` stays `null`', async () => {
    db.insertRun({ id: 'run-null-meta', name: 'No Metadata' })
    const res = await invokeRoute(router, '/api/runs/run-null-meta')
    expect(res.status).toBe(200)
    expect((JSON.parse(res.body) as { run: { metadata: unknown } }).run.metadata).toBeNull()
  })
})

describe('the read-path census cannot rot', () => {
  // Set equality, so a method dropped from the wrapper reds as loudly as one added to the database.
  it('PREDICATE A (the producer) — the wrapper covers exactly the run reads the database declares', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'database.ts'),
      'utf8',
    )
    const lines = source.split('\n')
    const declared = new Set<string>()
    for (let index = 0; index < lines.length; index++) {
      const opening = /^ {2}(private |protected |static )?([a-zA-Z_$][\w$]*)\s*\(/.exec(lines[index]!)
      if (!opening) continue
      let signature = lines[index]!
      let cursor = index
      while (!signature.trimEnd().endsWith('{') && cursor + 1 < lines.length && cursor - index < 12) {
        cursor++
        signature += ` ${lines[cursor]!.trim()}`
      }
      if (!/\)\s*:\s*[^{]*\b(RunRow|RunArtifactBundle|RunArtifactRow)\b/.test(signature)) continue
      if (opening[1] !== undefined) continue
      if (!/^get/.test(opening[2]!)) continue
      declared.add(opening[2]!)
    }
    expect(declared.size, 'the signature scan found nothing — the predicate has rotted').toBeGreaterThan(3)
    expect([...declared].sort()).toEqual([...RESPONSE_SAFE_RUN_READ_METHODS].sort())
  })

  // A run-named read planted on the database must make construction throw, naming it.
  it('PREDICATE B (the live surface) — an unaccounted run-named read makes the wrapper throw at construction', () => {
    const clean = createMockDatabase()
    expect(() => createRouter(clean as never), 'the shipped database surface must construct').not.toThrow()

    const planted = createMockDatabase() as unknown as Record<string, unknown>
    planted['getRunsByAttribute'] = () => []
    let thrown: unknown
    try {
      createRouter(planted as never)
    } catch (error) {
      thrown = error
    }
    expect(thrown, 'a run-reading method absent from both sets passed through the prototype').toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('getRunsByAttribute')
    expect((thrown as Error).message).toContain('RESPONSE_SAFE_RUN_READ_METHODS')

    // AND IT FINDS ONE REACHED THROUGH THE PROTOTYPE, not merely one hung on the instance — the
    // exact shape `Object.create(db, {…})` used to forward silently.
    const inherited = Object.create({ getRunSecretsRaw: () => null }) as Record<string, unknown>
    Object.assign(inherited, createMockDatabase())
    expect(() => createRouter(inherited as never)).toThrow(/getRunSecretsRaw/)
  })

  /**
   * The `RUN_READS_WITHOUT_ROWS` justification that is a CLAIM ABOUT THIS ROUTER, pinned.
   *
   * `stageRunArtifact` and `finalizeRunArtifact` are excused because they echo a row to the WRITER
   * that supplied it and this router never calls them. That is a fact about `routes.ts`, and facts
   * about a file rot — so it is asserted rather than asserted-in-a-comment.
   */
  it('the excused artifact mutators are not reachable from the router at all', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'routes.ts'),
      'utf8',
    )
    for (const mutator of ['stageRunArtifact', 'finalizeRunArtifact']) {
      expect(
        source.includes(`db.${mutator}(`),
        `${mutator} is excused from the wrapper because this router never calls it — it now does`,
      ).toBe(false)
    }
  })
})

describe('the write door is an allowlist, and the allowlist is derivable', () => {
  /**
   * THE INVARIANT A FUTURE WIDENING MUST SATISFY.
   *
   * The set is empty today, which makes both clauses vacuous today and is exactly why the cell is
   * worth its line: the moment somebody adds a key, this is the rule they have to have thought
   * about. A key a client may write but no response may carry is write-only dead weight nobody can
   * read back; a key the SERVER writes is one a client must never be able to overwrite — which is
   * the whole of `confirmScope` and `timeout`, the two the escalation turned on.
   */
  it('every client-writable queue-door key is response-safe and not server-owned', () => {
    for (const key of CLIENT_WRITABLE_QUEUED_RUN_METADATA_KEYS) {
      expect(
        RESPONSE_SAFE_RUN_METADATA_KEYS.has(key),
        `${key} can be written by a client but no response may carry it — write-only dead weight`,
      ).toBe(true)
      expect(
        SERVER_OWNED_RUN_METADATA_KEYS.has(key),
        `${key} is written by this server; a client-writable copy lets the client overwrite it`,
      ).toBe(false)
    }
    // THE OTHER SET IS NOT PROSE. Both keys the escalation turned on are named in it, so the
    // clause above is a real refusal rather than a comparison against an empty bag.
    expect(SERVER_OWNED_RUN_METADATA_KEYS.has('confirmScope')).toBe(true)
    expect(SERVER_OWNED_RUN_METADATA_KEYS.has('timeout')).toBe(true)
  })
})

describe("a persisted row's execution timeout is validated where it is consumed", () => {
  it('REJECTS every value that would leave the run with no reclamation timer', () => {
    // `in-process-backend.ts:211` is `opts.timeout ?? defaultTimeout` — so a non-nullish invalid
    // value does not fall back, it DISARMS. Each of these is that.
    const refused: unknown[] = [
      -1,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      MAX_QUEUED_EXECUTION_TIMEOUT_MS + 1,
      Number.MAX_SAFE_INTEGER,
      '600000',
      null,
      {},
      [],
    ]
    for (const value of refused) {
      expect(
        sanitizeQueuedExecutionTimeout(value),
        `${JSON.stringify(value) ?? String(value)} reached executionBackend.execute`,
      ).toBeUndefined()
    }
  })

  it('ADMITS a server-computed timeout unchanged, up to and including the ceiling', () => {
    // The shape `toExecutionTimeoutMetadata` writes: a YAML/config timeout plus the dashboard
    // buffer. The feature is validated, not deleted.
    expect(sanitizeQueuedExecutionTimeout(660_000)).toBe(660_000)
    expect(sanitizeQueuedExecutionTimeout(1)).toBe(1)
    expect(sanitizeQueuedExecutionTimeout(MAX_QUEUED_EXECUTION_TIMEOUT_MS))
      .toBe(MAX_QUEUED_EXECUTION_TIMEOUT_MS)
    // Absence round-trips as absence — a row that says nothing about its timeout gets the
    // backend's default, which is what `undefined` means to `execute`.
    expect(sanitizeQueuedExecutionTimeout(undefined)).toBeUndefined()
  })

  /**
   * The seam pin. `run-trigger-confirm.test.ts` drives this guard through the SHIPPED queue and
   * reads the argument the backend was called with — that is the primary. This is the cheap
   * structural backstop against the guard staying correct while its one call site is edited away,
   * and it is labelled as such rather than dressed up as the measurement.
   */
  it('server.ts consumes the row through the guard rather than casting it', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.ts'),
      'utf8',
    )
    expect(source).toContain('timeout: sanitizeQueuedExecutionTimeout(meta.timeout)')
    expect(source).not.toContain('meta.timeout as number')
  })
})

// The local door's human reads serve stored text, masked at write, with or without an agent host.

const STORED_MARKER = '[secret:PW_KEY]'
const OLD_PLACEHOLDER = '<SECRET_0>'
const STORED_TEXT = `failed near ${STORED_MARKER} and ${OLD_PLACEHOLDER}`

function plainHost(): unknown {
  return {
    registry: {},
    caller: { origin: 'human', surface: 'dashboard' },
    runsPostProcessingFunctionId: 'runs.postprocessing',
    runsEventsFunctionId: 'runs.events',
    runsDetailFunctionId: 'runs.detail',
    runsArtifactFunctionId: 'runs.artifact',
    analysisGetFunctionId: 'analysis.get',
    runsKnowledgeFunctionId: 'runs.knowledge',
    invokeFunction: () => Promise.resolve({}),
  }
}

const HUMAN_RUN_READS = [
  '/api/runs',
  '/api/runs/run-alpha',
  '/api/runs/run-alpha/execution-logs',
  '/api/runs/run-alpha/artifact',
] as const

describe('the local door serves stored run text unchanged on every human run read', () => {
  let db: ReturnType<typeof createMockDatabase>

  beforeEach(() => {
    db = createMockDatabase()
    db.insertRun({ id: 'run-alpha', name: 'Alpha', failureSummary: STORED_TEXT })
    db.insertRunArtifact({
      runId: 'run-alpha',
      kind: 'run',
      payload: { config: { rawConfigContent: `token: ${STORED_TEXT}` } },
    })
    ;(db as unknown as { __plantLog(entry: { runId: string; message: string }): void })
      .__plantLog({ runId: 'run-alpha', message: `seeded with ${STORED_TEXT}` })
  })

  it.each(HUMAN_RUN_READS)('%s serves a stored marker and an old placeholder as the text they are', async (path) => {
    const response = await invokeRoute(
      createRouter({ db: db as never, agentHost: plainHost() as never }),
      path,
    )

    expect(response.status).toBe(200)
    expect(response.body).toContain(STORED_TEXT)
  })

  it('answers exactly as before when the composition binds no agent host', async () => {
    const router = createRouter(db as never)

    for (const path of HUMAN_RUN_READS) {
      const response = await invokeRoute(router, path)
      expect(response.status, path).toBe(200)
      expect(response.body, path).toContain(STORED_TEXT)
    }
  })
})
