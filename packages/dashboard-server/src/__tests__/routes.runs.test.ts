import { randomUUID } from 'node:crypto'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, it, expect, beforeEach } from 'vitest'

import { createRouter } from '../server/routes.js'

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
  memoryLog: string | null
  testId: string | null
  suiteId: string | null
  platform: string
  testFileContent: string | null
  modelName: string | null
  llmProvider: string | null
  parallel: boolean
  parentRunId: string | null
  attemptNumber: number
  retryCount: number
  maxRetries: number
  createdAt: string
}

function createMockDatabase() {
  const runs: MockRun[] = []
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

    let filtered = runs.filter((run) => run.parentRunId === null)

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
        memoryLog: run.memoryLog ?? null,
        testId: run.testId ?? null,
        suiteId: run.suiteId ?? null,
        platform: run.platform ?? 'web',
        testFileContent: run.testFileContent ?? null,
        modelName: run.modelName ?? null,
        llmProvider: run.llmProvider ?? null,
        parallel: run.parallel ?? false,
        parentRunId: run.parentRunId ?? null,
        attemptNumber: run.attemptNumber ?? 1,
        retryCount: run.retryCount ?? 0,
        maxRetries: run.maxRetries ?? 0,
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
    getRunsByParent(parentRunId: string) {
      return runs.filter((run) => run.parentRunId === parentRunId)
    },
    getPendingRuns() {
      return runs.filter((run) => run.status === 'pending')
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
        schemaVersion: 1,
        payload: { schemaVersion: 1, ...(input.payload ?? {}) },
        finalizedAt: null,
        createdAt: '2026-04-18T00:00:00Z',
        updatedAt: '2026-04-18T00:00:00Z',
      }
      artifacts.set(input.runId, artifact)
      return artifact
    },
    getRunArtifactBundle(runId: string) {
      return {
        artifact: artifacts.get(runId) ?? null,
        children: runs
          .filter((run) => run.parentRunId === runId)
          .map((run) => ({ run, artifact: artifacts.get(run.id) ?? null })),
      }
    },
    close() {},
  }
}

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function createMockRequest(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url
  req.headers = options.headers ?? {}

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
      metadata: { runDestination: 'BrowserStack' },
      testFileContent: ['name: Remote Run', 'target: hn-staging', 'steps: []'].join('\n'),
    })

    const res = await invokeRoute(router, '/api/runs?destination=browserstack')
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

  it('enriches suite parent rows and child rows with the same target contract', async () => {
    db.insertRun({
      id: 'suite-run',
      name: 'Checkout Suite',
      suiteId: 'checkout-suite',
      platform: 'web',
    })
    db.insertRun({
      id: 'suite-child-1',
      parentRunId: 'suite-run',
      suiteId: 'checkout-suite',
      name: 'Child 1',
      platform: 'web',
      metadata: { runDestination: 'Local' },
      testFileContent: ['name: Child 1', 'target: sample-target', 'steps: []'].join('\n'),
    })
    db.insertRun({
      id: 'suite-child-2',
      parentRunId: 'suite-run',
      suiteId: 'checkout-suite',
      name: 'Child 2',
      platform: 'web',
      metadata: { runDestination: 'Local' },
      testFileContent: ['name: Child 2', 'target: sample-target', 'steps: []'].join('\n'),
    })

    const res = await invokeRoute(router, '/api/runs')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as {
      runs: Array<{
        id: string
        targetName: string | null
        tests?: Array<{ id: string; targetName: string | null }>
      }>
      total: number
    }

    expect(data.total).toBe(1)
    expect(data.runs[0]).toMatchObject({
      id: 'suite-run',
      targetName: 'sample-target',
      tests: [
        expect.objectContaining({ id: 'suite-child-1', targetName: 'sample-target' }),
        expect.objectContaining({ id: 'suite-child-2', targetName: 'sample-target' }),
      ],
    })
  })

  it('paginates top-level parent runs only and does not count child suite rows toward total', async () => {
    for (let index = 0; index < 55; index += 1) {
      db.insertRun({
        id: `parent-${index}`,
        name: `Parent ${index}`,
        testFileContent: [`name: Parent ${index}`, `target: target-${index}`, 'steps: []'].join('\n'),
      })
    }
    db.insertRun({
      id: 'child-a',
      parentRunId: 'parent-0',
      name: 'Nested Child',
      testFileContent: ['name: Nested Child', 'target: target-0', 'steps: []'].join('\n'),
    })

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
        memory: { log: { added: 1, confirmed: 0, deprecated: 0, deleted: 0, errors: [], curatorDuration: 1, deltas: [] } },
      },
    })

    const res = await invokeRoute(router, '/api/runs/run-artifact/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      artifact: { payload: { config: any; source: any; memory: any } }
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
        memory: { log: { added: 0, confirmed: 0, deprecated: 0, deleted: 0, errors: [], curatorDuration: 0, deltas: [] } },
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

  it('returns suite parent artifact children and missing artifact sections', async () => {
    db.insertRun({ id: 'suite-run', name: 'Suite', source: 'suite' })
    db.insertRun({ id: 'suite-child', name: 'Child', parentRunId: 'suite-run', source: 'suite' })
    db.insertRunArtifact({
      runId: 'suite-run',
      kind: 'suite-parent',
      payload: {
        source: { kind: 'suite', members: [{ index: 0, childRunId: 'suite-child' }] },
      },
    })

    const res = await invokeRoute(router, '/api/runs/suite-run/artifact')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as {
      children: Array<{ run: { id: string }; artifact: null }>
      missingSections: string[]
    }

    expect(data.children).toHaveLength(1)
    expect(data.children[0].run.id).toBe('suite-child')
    expect(data.children[0].artifact).toBeNull()
    expect(data.missingSections).toEqual(['config', 'memory'])
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
