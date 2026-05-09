import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import { ConfigManager } from '../config/config-manager.js'
import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'
import { resolveWorkspacePaths, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let db: DashboardDatabase
let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []
let testsDir: string
let suiteFileManager: SuiteFileManager
let testFileManager: TestFileManager
let workspacePaths: ResolvedWorkspacePaths

function insertSuiteRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Alpha Suite',
    filePath: 'suites/alpha.suite.yaml',
    status: 'passed',
    duration: 1200,
    startedAt: '2026-03-02T08:00:00Z',
    endedAt: '2026-03-02T08:00:01Z',
    platform: 'web',
    suiteId: 's_alpha',
    ...overrides,
  })
}

function seedSuiteAnalyticsRuns() {
  const firstRunId = insertSuiteRun({
    id: 'suite-alpha-1',
    status: 'passed',
    duration: 1200,
    startedAt: '2026-03-02T08:00:00Z',
    endedAt: '2026-03-02T08:00:01Z',
  })
  const secondRunId = insertSuiteRun({
    id: 'suite-alpha-2',
    status: 'failed',
    duration: 2400,
    startedAt: '2026-03-02T09:00:00Z',
    endedAt: '2026-03-02T09:00:02Z',
  })
  const thirdRunId = insertSuiteRun({
    id: 'suite-alpha-3',
    status: 'passed',
    duration: 3600,
    startedAt: '2026-03-03T10:00:00Z',
    endedAt: '2026-03-03T10:00:03Z',
  })

  db.insertRun({
    id: 'suite-alpha-child',
    name: 'Child Attempt',
    filePath: 'tests/alpha-child.yaml',
    status: 'failed',
    duration: 600,
    startedAt: '2026-03-02T09:30:00Z',
    endedAt: '2026-03-02T09:30:01Z',
    platform: 'web',
    suiteId: 's_alpha',
    parentRunId: secondRunId,
    testId: 't_alpha-child',
  })

  db.insertRun({
    id: 'suite-alpha-standalone-test',
    name: 'Standalone Alpha Test',
    filePath: 'tests/alpha-standalone.yaml',
    status: 'passed',
    duration: 500,
    startedAt: '2026-03-03T11:00:00Z',
    endedAt: '2026-03-03T11:00:01Z',
    platform: 'web',
    testId: 't_alpha-standalone',
  })

  db.insertRun({
    id: 'suite-beta-1',
    name: 'Beta Suite',
    filePath: 'suites/beta.suite.yaml',
    status: 'passed',
    duration: 1800,
    startedAt: '2026-03-04T08:00:00Z',
    endedAt: '2026-03-04T08:00:02Z',
    platform: 'web',
    suiteId: 's_beta',
  })

  return { firstRunId, secondRunId, thirdRunId }
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

async function createSuiteWorkspace(): Promise<{
  testsDir: string
  workspacePaths: ResolvedWorkspacePaths
  suiteFileManager: SuiteFileManager
  testFileManager: TestFileManager
}> {
  const dir = await mkdtemp(join(tmpdir(), `agent-qa-suite-analytics-${randomUUID()}-`))
  tempDirs.push(dir)
  await mkdir(join(dir, 'tests'), { recursive: true })
  await mkdir(join(dir, 'suites'), { recursive: true })

  await writeFile(
    join(dir, 'tests', 'alpha-test.yaml'),
    ['name: Alpha Test', 'test-id: t_alpha', 'target: web', 'steps: []', ''].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(dir, 'suites', 'alpha.suite.yaml'),
    [
      'suite-id: s_alpha',
      'name: Alpha Suite',
      'target: web',
      'tests:',
      '  - test: tests/alpha-test.yaml',
      '    id: t_alpha',
      '',
    ].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(dir, 'suites', 'empty.suite.yaml'),
    [
      'suite-id: s_empty',
      'name: Empty Suite',
      'target: web',
      'tests:',
      '  - test: tests/alpha-test.yaml',
      '    id: t_alpha',
      '',
    ].join('\n'),
    'utf-8',
  )

  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/*.yaml'],
        suiteMatch: ['suites/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        agentRules: 'agent-rules.md',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    },
    configPath: join(dir, 'agent-qa.config.yaml'),
  })
  const testFileManager = new TestFileManager(workspacePaths)
  const suiteFileManager = new SuiteFileManager(workspacePaths, testFileManager)

  return { testsDir: dir, workspacePaths, suiteFileManager, testFileManager }
}

async function applyAnalyticsScopeConfig(content: string): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), `agent-qa-suite-scope-${randomUUID()}-`))
  tempDirs.push(configDir)
  const configPath = join(configDir, 'agent-qa.config.yaml')
  await writeFile(configPath, [
    'workspace:',
    '  testMatch:',
    '    - tests/*.yaml',
    '  suiteMatch:',
    '    - suites/*.suite.yaml',
    '  hooksFile: hooks.yaml',
    '  agentRules: agent-rules.md',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'use:',
    '  mobile:',
    '    appState: preserve',
    content,
  ].join('\n'), 'utf-8')
  router = createRouter({
    db,
    suiteFileManager,
    testFileManager,
    workspacePaths,
    configManager: new ConfigManager(configPath),
  })
}

beforeEach(async () => {
  db = new DashboardDatabase({ dbPath: ':memory:' })
  ;({ testsDir, workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace())
  router = createRouter({ db, suiteFileManager, testFileManager, workspacePaths })
})

afterEach(async () => {
  db.close()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('GET /api/analytics/suites/:suiteId', () => {
  it('returns 404 with Suite not found for unknown suite ids', async () => {
    const res = await invokeRoute('/api/analytics/suites/s_missing')

    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Suite not found' })
  })

  it('returns a zero-state payload for a known suite with no matching runs', async () => {
    const res = await invokeRoute('/api/analytics/suites/s_empty')

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      suiteId: 's_empty',
      runs: [],
      total: 0,
      trends: {
        daily: [],
        passRate: 0,
        totalRuns: 0,
        avgDuration: 0,
      },
      isFlaky: false,
      flakyScore: 0,
      scope: {
        configured: false,
        predicates: [],
        scopedCount: 0,
        totalCount: 0,
      },
    })
  })

  it('returns populated suite analytics and pages only top-level suite runs', async () => {
    const runIds = seedSuiteAnalyticsRuns()

    const res = await invokeRoute('/api/analytics/suites/s_alpha?limit=2&offset=0')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data).toMatchObject({
      suiteId: 's_alpha',
      total: 3,
      trends: {
        totalRuns: 3,
        passRate: 2 / 3,
      },
      isFlaky: true,
      flakyScore: 1,
    })
    expect(data.runs.map((run: { id: string }) => run.id)).toEqual([
      runIds.thirdRunId,
      runIds.secondRunId,
    ])
  })

  it('applies limit and offset against the suite-only run list, never child runs', async () => {
    const runIds = seedSuiteAnalyticsRuns()

    const res = await invokeRoute('/api/analytics/suites/s_alpha?limit=2&offset=1')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.total).toBe(3)
    expect(data.runs.map((run: { id: string }) => run.id)).toEqual([
      runIds.secondRunId,
      runIds.firstRunId,
    ])
  })

  it('returns exact scoped suite metrics without changing all-run metrics', async () => {
    insertSuiteRun({
      id: 'suite-scope-pass',
      status: 'passed',
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertSuiteRun({
      id: 'suite-scope-fail',
      status: 'failed',
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertSuiteRun({
      id: 'suite-scope-dev',
      status: 'failed',
      attributes: { 'git.branch': 'dev' },
    })
    await applyAnalyticsScopeConfig([
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      '      git.branch: phase223-main',
      '',
    ].join('\n'))

    const res = await invokeRoute('/api/analytics/suites/s_alpha')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.trends.passRate).toBe(1 / 3)
    expect(data.scopedTrends.passRate).toBe(1 / 2)
    expect(data.scope).toMatchObject({
      configured: true,
      scopedCount: 2,
      totalCount: 3,
      predicates: [{ key: 'git.branch', value: 'phase223-main', mode: 'exact' }],
    })
  })

  it('returns regex scoped suite metrics', async () => {
    insertSuiteRun({
      id: 'suite-regex-phase',
      status: 'passed',
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertSuiteRun({
      id: 'suite-regex-main',
      status: 'failed',
      attributes: { 'git.branch': 'main' },
    })
    insertSuiteRun({
      id: 'suite-regex-dev',
      status: 'failed',
      attributes: { 'git.branch': 'dev' },
    })
    await applyAnalyticsScopeConfig([
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      '      git.branch:',
      '        regex: "^(phase223-main|main)$"',
      '',
    ].join('\n'))

    const res = await invokeRoute('/api/analytics/suites/s_alpha')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.trends.passRate).toBe(1 / 3)
    expect(data.scopedTrends.passRate).toBe(1 / 2)
    expect(data.scope).toMatchObject({
      configured: true,
      scopedCount: 2,
      totalCount: 3,
      predicates: [{ key: 'git.branch', value: '^(phase223-main|main)$', mode: 'regex' }],
    })
  })
})
