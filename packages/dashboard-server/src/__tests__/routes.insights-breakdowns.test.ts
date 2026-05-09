import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type ServerResponse } from 'node:http'
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
let testsDir: string
let tempDirs: string[] = []
let testFileManager: TestFileManager
let suiteFileManager: SuiteFileManager
let workspacePaths: ResolvedWorkspacePaths

function insertRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Checkout flow',
    filePath: 'tests/checkout.yaml',
    status: 'passed',
    duration: 1000,
    startedAt: '2026-04-01T10:00:00Z',
    endedAt: '2026-04-01T10:00:01Z',
    platform: 'web',
    ...overrides,
  })
}

function createMockRequest(
  url: string,
  options: { method?: string; body?: string } = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url

  process.nextTick(() => {
    if (options.body) {
      req.push(Buffer.from(options.body))
    }
    req.push(null)
  })

  return req
}

async function invokeRoute(url: string): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = createMockRequest(url)
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
      end(chunk?: string | Buffer) {
        if (chunk) {
          body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        }
        resolve({ status, headers: Object.fromEntries(headers), body })
      },
      write(chunk: string | Buffer) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        return true
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

async function applyAnalyticsScopeConfig(content: string): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), `agent-qa-insights-scope-${randomUUID()}-`))
  tempDirs.push(configDir)
  const configPath = join(configDir, 'agent-qa.config.yaml')
  await writeFile(configPath, [
    'workspace:',
    '  testMatch:',
    '    - tests/**/*.yaml',
    '  suiteMatch:',
    '    - tests/**/*.suite.yaml',
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
    workspacePaths,
    testFileManager,
    suiteFileManager,
    configManager: new ConfigManager(configPath),
  })
}

beforeEach(async () => {
  testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-insights-routes-'))
  tempDirs.push(testsDir)

  await mkdir(join(testsDir, 'tests'), { recursive: true })
  await writeFile(
    join(testsDir, 'tests', 'checkout.yaml'),
    ['name: Checkout flow', 'test-id: test_checkout', 'target: web', 'steps: []', ''].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(testsDir, 'tests', 'smoke.suite.yaml'),
    [
      'suite-id: suite-smoke',
      'name: Smoke Suite',
      'target: web',
      'tests:',
      '  - test: checkout.yaml',
      '    id: test_checkout',
      '',
    ].join('\n'),
    'utf-8',
  )

  const dbDir = await mkdtemp(join(tmpdir(), 'agent-qa-insights-db-'))
  tempDirs.push(dbDir)
  db = new DashboardDatabase({ dbPath: join(dbDir, 'dashboard.db') })

  workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['tests/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        agentRules: 'agent-rules.md',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
    },
    configPath: join(testsDir, 'agent-qa.config.yaml'),
  })
  testFileManager = new TestFileManager(workspacePaths)
  suiteFileManager = new SuiteFileManager(workspacePaths, testFileManager)

  router = createRouter({
    db,
    workspacePaths,
    testFileManager,
    suiteFileManager,
  })
})

afterEach(async () => {
  db.close()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('GET /api/analytics/tests/:name', () => {
  it('returns scoped test metrics without changing all-run metrics', async () => {
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'passed',
      duration: 1000,
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'failed',
      duration: 1000,
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'failed',
      duration: 1000,
      attributes: { 'git.branch': 'dev' },
    })
    await applyAnalyticsScopeConfig([
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      '      git.branch: phase223-main',
      '',
    ].join('\n'))

    const res = await invokeRoute('/api/analytics/tests/Checkout%20flow')
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
})

describe('GET /api/stats', () => {
  it('applies analytics passRateScope only when requested', async () => {
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'passed',
      duration: 1000,
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'failed',
      duration: 1000,
      attributes: { 'git.branch': 'dev' },
    })
    await applyAnalyticsScopeConfig([
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      '      git.branch: phase223-main',
      '',
    ].join('\n'))

    const allRes = await invokeRoute('/api/stats')
    expect(allRes.status).toBe(200)
    const allData = JSON.parse(allRes.body) as any
    expect(allData.totalRuns).toBe(2)
    expect(allData.scope).toMatchObject({
      configured: true,
      scopedCount: 1,
      totalCount: 2,
    })

    const scopedRes = await invokeRoute('/api/stats?scope=passRate')
    expect(scopedRes.status).toBe(200)
    const scopedData = JSON.parse(scopedRes.body) as any
    expect(scopedData.totalRuns).toBe(1)
    expect(scopedData.passed).toBe(1)
    expect(scopedData.failed).toBe(0)
    expect(scopedData.scope).toMatchObject({
      configured: true,
      scopedCount: 1,
      totalCount: 2,
    })
  })
})

describe('GET /api/analytics/breakdowns', () => {
  it('returns ranked summary rows for dimension=test instead of raw runs', async () => {
    insertRun({ id: randomUUID(), name: 'Checkout flow', status: 'passed', duration: 1200 })
    insertRun({ id: randomUUID(), name: 'Checkout flow', status: 'flaky', duration: 1400 })
    insertRun({ id: randomUUID(), name: 'Login flow', status: 'failed', duration: 2200 })

    const res = await invokeRoute('/api/analytics/breakdowns?dimension=test&limit=1')
    const data = JSON.parse(res.body) as {
      dimension: string
      rows: Array<Record<string, unknown>>
    }

    expect(res.status).toBe(200)
    expect(data.dimension).toBe('test')
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0]).toMatchObject({
      key: 'Checkout flow',
      label: 'Checkout flow',
      runs: 2,
      filePath: 'tests/checkout.yaml',
    })
    expect(data.rows[0]).not.toHaveProperty('id')
  })

  it('rejects invalid dimensions with allow-list validation', async () => {
    const res = await invokeRoute('/api/analytics/breakdowns?dimension=browser')

    expect(res.status).toBe(400)
    expect(res.body).toContain('dimension')
  })

  it('returns suite rows with a stable suite label and bounded limits', async () => {
    insertRun({ id: randomUUID(), filePath: 'tests/smoke.suite.yaml', suiteId: 'suite-smoke', name: 'Checkout flow', status: 'passed', duration: 1000 })
    insertRun({ id: randomUUID(), filePath: 'tests/smoke.suite.yaml', suiteId: 'suite-smoke', name: 'Checkout flow', status: 'failed', duration: 2000 })
    insertRun({ id: randomUUID(), filePath: 'tests/other.suite.yaml', suiteId: 'suite-other', name: 'Other flow', status: 'passed', duration: 500 })

    const res = await invokeRoute('/api/analytics/breakdowns?dimension=suite&limit=1')
    const data = JSON.parse(res.body) as {
      rows: Array<Record<string, unknown>>
    }

    expect(res.status).toBe(200)
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0]).toMatchObject({
      key: 'suite-smoke',
      suiteId: 'suite-smoke',
      label: 'Smoke Suite',
      runs: 2,
    })
  })

  it('is unscoped by default and applies analytics passRateScope when requested', async () => {
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'passed',
      duration: 1000,
      attributes: { 'git.branch': 'phase223-main' },
    })
    insertRun({
      id: randomUUID(),
      name: 'Checkout flow',
      status: 'failed',
      duration: 1000,
      attributes: { 'git.branch': 'dev' },
    })
    await applyAnalyticsScopeConfig([
      'analytics:',
      '  passRateScope:',
      '    attributes:',
      '      git.branch: phase223-main',
      '',
    ].join('\n'))

    const res = await invokeRoute('/api/analytics/breakdowns?dimension=test')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as { rows: Array<{ key: string; runs: number }> }
    expect(data.rows.find((row) => row.key === 'Checkout flow')?.runs).toBe(2)

    const scopedRes = await invokeRoute('/api/analytics/breakdowns?dimension=test&scope=passRate')
    expect(scopedRes.status).toBe(200)
    const scopedData = JSON.parse(scopedRes.body) as { rows: Array<{ key: string; runs: number }>; scope: { configured: boolean; scopedCount: number; totalCount: number } }
    expect(scopedData.rows.find((row) => row.key === 'Checkout flow')?.runs).toBe(1)
    expect(scopedData.scope).toMatchObject({
      configured: true,
      scopedCount: 1,
      totalCount: 2,
    })

    const runsRes = await invokeRoute('/api/runs')
    expect(runsRes.status).toBe(200)
    expect(JSON.parse(runsRes.body).total).toBe(2)
  })
})
