import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, sep } from 'node:path'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AUTH_STATE_SCHEMA_VERSION,
  resolveAuthStatePaths,
  resolveWorkspacePaths,
  writeAuthStateFiles,
  type AuthStateMetadata,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'

import { ConfigManager } from '../config/index.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { extractTestFileMetadata, TestFileManager } from '../tests/test-file-manager.js'
import { generateText } from 'ai'

vi.mock('ai', () => ({
  addToolInputExamplesMiddleware: vi.fn(() => ({})),
  createProviderRegistry: vi.fn(),
  customProvider: vi.fn(),
  extractJsonMiddleware: vi.fn(() => ({})),
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
  parsePartialJson: vi.fn(),
}))

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: vi.fn(() => ({})),
    getProviderOptions: vi.fn(() => undefined),
  }
})

const mockGenerateText = vi.mocked(generateText)

const SEEDED_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SEEDED_TEST_ID_TWO = 't_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const SEEDED_SUITE_ID = 's_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const UNKNOWN_SUITE_ID = 's_brick-cinder-dawn-echo-forest-grove-harvest-isle-jade-kite'
const LEGACY_TEST_ID = 't_amber-birch-coral-delta-ember-falcon'
const LEGACY_SUITE_ID = 's_amber-birch-coral-delta-ember-falcon'

interface MockRun {
  id: string
  name: string
  filePath: string | null
  status: string
  duration: number
  tags: string[] | null
  startedAt: string | null
  endedAt: string | null
  source: string
  platform: string
  metadata: Record<string, unknown> | null
  testFileContent: string | null
  createdAt: string
}

function createMockDatabase() {
  const runs: MockRun[] = []

  function filterRuns(filters: Record<string, unknown> = {}): MockRun[] {
    const {
      statuses,
      name,
      tag,
      from,
      to,
      source,
      platform,
      limit,
      offset,
    } = filters

    let filtered = [...runs]

    if (Array.isArray(statuses) && statuses.length > 0) {
      filtered = filtered.filter((run) => statuses.includes(run.status))
    }
    if (typeof name === 'string') {
      filtered = filtered.filter((run) => run.name.includes(name))
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
      filtered = filtered.filter(() => true)
    }

    const start = typeof offset === 'number' ? offset : 0
    const end = typeof limit === 'number' ? start + limit : undefined
    return filtered.slice(start, end)
  }

  return {
    insertRun(run: Record<string, unknown>) {
      const id = typeof run.id === 'string' ? run.id : randomUUID()
      runs.push({
        id,
        name: String(run.name ?? 'Unnamed Test'),
        filePath: typeof run.filePath === 'string' ? run.filePath : null,
        status: String(run.status ?? 'pending'),
        duration: typeof run.duration === 'number' ? run.duration : 0,
        tags: Array.isArray(run.tags) ? run.tags.filter((tag): tag is string => typeof tag === 'string') : null,
        startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
        endedAt: typeof run.endedAt === 'string' ? run.endedAt : null,
        source: typeof run.source === 'string' ? run.source : 'test',
        platform: typeof run.platform === 'string' ? run.platform : 'web',
        metadata: run.metadata && typeof run.metadata === 'object' ? run.metadata as Record<string, unknown> : null,
        testFileContent: typeof run.testFileContent === 'string' ? run.testFileContent : null,
        createdAt: typeof run.createdAt === 'string'
          ? run.createdAt
          : typeof run.startedAt === 'string'
            ? run.startedAt
            : '2026-03-01T10:00:00Z',
      })
      return id
    },
    getRuns(filters: Record<string, unknown> = {}) {
      return filterRuns(filters)
    },
    getRun(id: string) {
      return runs.find((run) => run.id === id) ?? null
    },
    getStats(filters: Record<string, unknown> = {}) {
      const relevantRuns = filterRuns(filters)
      const totalRuns = relevantRuns.length
      const passed = relevantRuns.filter((run) => run.status === 'passed').length
      const failed = relevantRuns.filter((run) => run.status === 'failed').length
      const avgDuration = totalRuns > 0
        ? relevantRuns.reduce((sum, run) => sum + run.duration, 0) / totalRuns
        : 0

      return {
        totalRuns,
        passed,
        failed,
        flakeRate: 0,
        avgDuration,
        runs: [],
      }
    },
    close() {},
  }
}

let db: ReturnType<typeof createMockDatabase>
let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []

const AUTH_STATE_COOKIE_SECRET = 'route-secret-cookie'
const AUTH_STATE_LOCAL_STORAGE_SECRET = 'route-secret-local-storage'
const AUTH_STATE_INDEXED_DB_SECRET = 'route-secret-indexed-db'

const AUTH_STATE_PAYLOAD = {
  cookies: [{ name: 'sid', value: AUTH_STATE_COOKIE_SECRET, domain: 'staging.example.com', path: '/' }],
  origins: [{
    origin: 'https://staging.example.com',
    localStorage: [{ name: 'token', value: AUTH_STATE_LOCAL_STORAGE_SECRET }],
    indexedDB: [{ name: 'auth-db', value: AUTH_STATE_INDEXED_DB_SECRET }],
  }],
}

function expectAuthStateResponseSafe(serialized: string): void {
  expect(serialized).not.toContain('.agent-qa/auth-states')
  expect(serialized).not.toContain('.json')
  expect(serialized).not.toContain('payloadPath')
  expect(serialized).not.toContain('metadataPath')
  expect(serialized).not.toContain(AUTH_STATE_COOKIE_SECRET)
  expect(serialized).not.toContain(AUTH_STATE_LOCAL_STORAGE_SECRET)
  expect(serialized).not.toContain(AUTH_STATE_INDEXED_DB_SECRET)
}

function insertSampleRun(overrides: Record<string, unknown> = {}) {
  return db.insertRun({
    name: 'Login Test',
    filePath: 'tests/login.yaml',
    status: 'passed',
    duration: 5000,
    tags: ['smoke', 'auth'],
    startedAt: '2026-03-01T10:00:00Z',
    endedAt: '2026-03-01T10:00:05Z',
    ...overrides,
  })
}

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// A mock request that omits `Host` models no real client: HTTP/1.1 requires the header and every
// browser, `curl`, `fetch` and the conformance harness sends it. The display-seam read arms
// (405 CR-01) now refuse a request whose claimed Host is not a loopback name, so the default below
// is what keeps these direct-invoke probes speaking the wire's own shape. An explicit `host` in
// `options.headers` still wins, which is how the refusal itself is exercised.
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
      on() {
        return this
      },
      once() {
        return this
      },
      emit() {
        return false
      },
      removeListener() {
        return this
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

beforeEach(async () => {
  db = createMockDatabase()
  router = createRouter(db as any)
  mockGenerateText.mockClear()
})

afterEach(async () => {
  db?.close()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createConfigWorkspace(configContent: string, hooksContent?: string): Promise<{
  configManager: ConfigManager
  configPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-routes-test-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, configContent, 'utf-8')
  if (hooksContent !== undefined) {
    await writeFile(join(dir, 'hooks.yaml'), hooksContent, 'utf-8')
  }
  return {
    configManager: new ConfigManager(configPath, (text) => text),
    configPath,
  }
}

function createWorkspacePaths(
  workspaceDir: string,
  options: {
    testMatch?: string[]
    suiteMatch?: string[]
  } = {},
): ResolvedWorkspacePaths {
  return resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: options.testMatch ?? ['**/*.yaml'],
        suiteMatch: options.suiteMatch ?? ['**/*.suite.yaml'],
        hooksFile: 'runtime/hooks/custom-hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath: join(workspaceDir, 'agent-qa.config.yaml'),
  })
}

function createWorkspaceManagers(
  workspaceDir: string,
  options: {
    testMatch?: string[]
    suiteMatch?: string[]
  } = {},
): {
  workspacePaths: ResolvedWorkspacePaths
  testFileManager: TestFileManager
  suiteFileManager: SuiteFileManager
} {
  const workspacePaths = createWorkspacePaths(workspaceDir, options)
  const testFileManager = new TestFileManager(workspacePaths)
  return {
    workspacePaths,
    testFileManager,
    suiteFileManager: new SuiteFileManager(workspacePaths, testFileManager),
  }
}

async function createSuiteWorkspace(): Promise<{
  testsDir: string
  workspacePaths: ResolvedWorkspacePaths
  suiteFileManager: SuiteFileManager
  testFileManager: TestFileManager
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-suite-routes-'))
  tempDirs.push(dir)
  await writeFile(
    join(dir, 't.yaml'),
    ['name: T', `test-id: ${SEEDED_TEST_ID}`, 'target: web', 'steps:', '  - Open the seeded test', ''].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(dir, 'a.suite.yaml'),
    [
      `suite-id: ${SEEDED_SUITE_ID}`,
      'name: Seed',
      'target: web',
      'tests:',
      '  - test: t.yaml',
      `    id: ${SEEDED_TEST_ID}`,
      '',
    ].join('\n'),
    'utf-8',
  )
  const { workspacePaths, testFileManager, suiteFileManager } = createWorkspaceManagers(dir)
  return { testsDir: dir, workspacePaths, suiteFileManager, testFileManager }
}

async function createDashboardWorkspace(): Promise<{
  artifactsDir: string
  db: DashboardDatabase
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-dashboard-routes-'))
  tempDirs.push(dir)
  const artifactsDir = join(dir, 'artifacts')
  return {
    artifactsDir,
    db: new DashboardDatabase({ dbPath: join(dir, 'dashboard.db') }),
  }
}

describe('API Routes', () => {
  describe('test file metadata', () => {
    it('extracts use.parallel false before top-level parallel', () => {
      const metadata = extractTestFileMetadata([
        'name: Local serial',
        'use:',
        '  parallel: false',
        'parallel: true',
        'steps: []',
        '',
      ].join('\n'))

      expect(metadata.parallel).toBe(false)
    })

    it('extracts use.parallel true before config parallel', () => {
      const metadata = extractTestFileMetadata([
        'name: Local parallel',
        'use:',
        '  parallel: true',
        'config:',
        '  parallel: false',
        'steps: []',
        '',
      ].join('\n'))

      expect(metadata.parallel).toBe(true)
    })
  })

  describe('phase 225 live timeline storage guardrails', () => {
    it('keeps live execution timeline state out of durable schema and artifacts', async () => {
      const [schemaSource, databaseSource, routesSource] = await Promise.all([
        readFile('src/db/schema.ts', 'utf-8'),
        readFile('src/db/database.ts', 'utf-8'),
        readFile('src/server/routes.ts', 'utf-8'),
      ])
      const durableSources = `${schemaSource}\n${databaseSource}`

      expect(durableSources).not.toMatch(/\blive_events\b/)
      expect(durableSources).not.toMatch(/\blive_timeline\b/)
      expect(durableSources).not.toMatch(/\bliveEvents\b/)
      expect(durableSources).not.toMatch(/\bliveTimeline\b/)
      // 2026-08-27 (405-07, D-19): this line asserted the live feed's route was PRESENT — the 225
      // guardrail's way of saying "live state lives on the wire, not in the schema". The route is
      // retired, so the assertion is inverted: the wire it names must be absent from this file too.
      // Split needle, so this cell is not itself the grep-clean inventory's hit.
      expect(routesSource).not.toContain('api/' + 'execution/events')
      expect(routesSource).not.toMatch(/\/api\/runs\/[^'"]+\/live[-_]timeline/)
    })
  })

  describe('auth state APIs', () => {
    async function seedAuthState(
      configPath: string,
      targetName: string,
      stateName: string,
      capturedAt: string,
    ): Promise<AuthStateMetadata> {
      const metadata: AuthStateMetadata = {
        version: AUTH_STATE_SCHEMA_VERSION,
        kind: 'web',
        target: targetName,
        name: stateName,
        capturedAt,
      }
      const paths = resolveAuthStatePaths({
        configDir: dirname(configPath),
        authStateDir: '.agent-qa/auth-states',
        targetName,
        stateName,
        platform: 'web',
      })
      await writeAuthStateFiles(paths, {
        payload: AUTH_STATE_PAYLOAD,
        metadata,
      })
      return metadata
    }

    it('lists saved auth-state metadata without exposing paths or payloads', async () => {
      const { configManager, configPath } = await createConfigWorkspace([
        'services:',
        '  authState:',
        '    dir: .agent-qa/auth-states',
        '',
      ].join('\n'))
      const prod = await seedAuthState(configPath, 'prod-web', 'admin', '2026-05-17T09:00:00.000Z')
      const staging = await seedAuthState(configPath, 'staging-web', 'admin', '2026-05-17T10:00:00.000Z')
      router = createRouter({ db: db as any, configManager, configPath })

      const res = await invokeRoute('/api/auth-states')

      expect(res.status).toBe(200)
      expectAuthStateResponseSafe(res.body)
      const data = JSON.parse(res.body) as { authStates: AuthStateMetadata[] }
      expect(data.authStates).toEqual([prod, staging])
      expect(JSON.stringify(data.authStates)).not.toContain('cookie')
      expect(JSON.stringify(data.authStates)).not.toContain('localStorage')
      expect(JSON.stringify(data.authStates)).not.toContain('indexedDB')
      expect(JSON.stringify(data.authStates)).not.toContain('createdAt')
      expect(JSON.stringify(data.authStates)).not.toContain('updatedAt')
      expect(JSON.stringify(data.authStates)).not.toContain('ttl')
      expect(JSON.stringify(data.authStates)).not.toContain('capturedFrom')
    })

    it('filters auth-state metadata by target', async () => {
      const { configManager, configPath } = await createConfigWorkspace([
        'services:',
        '  authState:',
        '    dir: .agent-qa/auth-states',
        '',
      ].join('\n'))
      await seedAuthState(configPath, 'prod-web', 'admin', '2026-05-17T09:00:00.000Z')
      const staging = await seedAuthState(configPath, 'staging-web', 'admin', '2026-05-17T10:00:00.000Z')
      router = createRouter({ db: db as any, configManager, configPath })

      const res = await invokeRoute('/api/auth-states?target=staging-web')

      expect(res.status).toBe(200)
      expectAuthStateResponseSafe(res.body)
      expect(JSON.parse(res.body)).toEqual({ authStates: [staging] })
    })

    it('saves auth state through the live session capture method', async () => {
      const metadata: AuthStateMetadata = {
        version: AUTH_STATE_SCHEMA_VERSION,
        kind: 'web',
        target: 'staging-web',
        name: 'admin',
        capturedAt: '2026-05-17T10:00:00.000Z',
      }
      const captureWebAuthState = vi.fn().mockResolvedValue(metadata)
      const sessionManager = {
        getSession: vi.fn(() => ({
          captureWebAuthState,
          getState: () => ({
            sessionId: 'session-1',
            platform: 'web',
            targetName: 'staging-web',
            status: 'idle',
            currentStep: null,
            currentUrl: null,
            stepsExecuted: 0,
            createdAt: 0,
            interactive: true,
            terminalError: null,
          }),
        })),
      }
      router = createRouter({ db: db as any, sessionManager: sessionManager as any })

      const res = await invokeRoute('/api/live-editor/sessions/session-1/auth-state', {
        method: 'POST',
        body: JSON.stringify({ name: 'admin', replace: true }),
      })

      expect(res.status).toBe(200)
      expect(sessionManager.getSession).toHaveBeenCalledWith('session-1')
      expect(captureWebAuthState).toHaveBeenCalledWith('admin', { replace: true })
      expectAuthStateResponseSafe(res.body)
      expect(JSON.parse(res.body)).toEqual({ authState: metadata })
    })

    it('rejects invalid auth-state names with lowercase slug guidance', async () => {
      const captureWebAuthState = vi.fn()
      const sessionManager = {
        getSession: vi.fn(() => ({ captureWebAuthState })),
      }
      router = createRouter({ db: db as any, sessionManager: sessionManager as any })

      const res = await invokeRoute('/api/live-editor/sessions/session-1/auth-state', {
        method: 'POST',
        body: JSON.stringify({ name: '../admin.json' }),
      })

      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'Auth state name must be a lowercase slug.' })
      expect(captureWebAuthState).not.toHaveBeenCalled()
    })

    it('returns 404 for unknown live sessions', async () => {
      const sessionManager = {
        getSession: vi.fn(() => null),
      }
      router = createRouter({ db: db as any, sessionManager: sessionManager as any })

      const res = await invokeRoute('/api/live-editor/sessions/missing/auth-state', {
        method: 'POST',
        body: JSON.stringify({ name: 'admin' }),
      })

      expect(res.status).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'Session not found' })
    })

    it('returns a path-free conflict message when auth state already exists', async () => {
      const captureWebAuthState = vi.fn().mockRejectedValue(
        new Error(`Auth state "admin" for target "staging-web" already exists. Use replace=true to replace it. .agent-qa/auth-states ${AUTH_STATE_COOKIE_SECRET}`),
      )
      const sessionManager = {
        getSession: vi.fn(() => ({
          captureWebAuthState,
          getState: () => ({ targetName: 'staging-web' }),
        })),
      }
      router = createRouter({ db: db as any, sessionManager: sessionManager as any })

      const res = await invokeRoute('/api/live-editor/sessions/session-1/auth-state', {
        method: 'POST',
        body: JSON.stringify({ name: 'admin' }),
      })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expectAuthStateResponseSafe(res.body)
      expect(JSON.parse(res.body)).toEqual({
        error: 'Auth state "admin" for target "staging-web" already exists. Use replace=true to replace it.',
      })
    })

    it.each([
      'Auth-state capture is only available for web Live Mode sessions.',
      'Live session is not ready for auth-state capture.',
      'Cannot save auth state while the Live Mode session is executing.',
      `EACCES .agent-qa/auth-states/staging-web/admin.json ${AUTH_STATE_INDEXED_DB_SECRET}`,
    ])('sanitizes live-session save failures: %s', async (failureMessage) => {
      const captureWebAuthState = vi.fn().mockRejectedValue(new Error(failureMessage))
      const sessionManager = {
        getSession: vi.fn(() => ({
          captureWebAuthState,
          getState: () => ({ targetName: 'staging-web' }),
        })),
      }
      router = createRouter({ db: db as any, sessionManager: sessionManager as any })

      const res = await invokeRoute('/api/live-editor/sessions/session-1/auth-state', {
        method: 'POST',
        body: JSON.stringify({ name: 'admin' }),
      })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expectAuthStateResponseSafe(res.body)
      expect(JSON.parse(res.body)).toEqual({
        error: 'Could not save auth state "admin" for target "staging-web".',
      })
    })
  })

  describe('auth state in run APIs', () => {
    it('serves the artifact, execution logs and run row with stored auth-state values as written', async () => {
      const { artifactsDir, db: actualDb } = await createDashboardWorkspace()
      const runId = actualDb.insertRun({
        name: 'Auth redaction run',
        status: 'failed',
        duration: 0,
        startedAt: '2026-05-17T10:00:00.000Z',
        endedAt: '2026-05-17T10:00:01.000Z',
      })
      const storagePath = '/internal/auth/staging-web/demo-acc/storage-state.json'
      const storageJson = JSON.stringify(AUTH_STATE_PAYLOAD)
      actualDb.insertRunArtifact({
        runId,
        kind: 'test',
        payload: {
          config: {
            rawConfigContent: 'use:\n  authState: demo-acc\n',
            effectiveConfig: { use: { authState: 'demo-acc' } },
          },
          source: {
            kind: 'test',
            rawYaml: 'use:\n  authState: demo-acc\nsteps: []',
          },
          runtime: {
            storageStatePath: storagePath,
            storageState: AUTH_STATE_PAYLOAD,
          },
        },
      })
      actualDb.insertExecutionLog({
        id: randomUUID(),
        runId,
        type: 'hook',
        name: 'auth hook',
        phase: 'setup',
        status: 'passed',
        duration: 1,
        stdout: '/workspace/.agent-qa-auth-state/storage-state.json',
        stderr: storageJson,
        variables: { SESSION_TOKEN: 'hook-session-token', SAFE_VALUE: 'visible' },
      })
      router = createRouter(actualDb)

      // 2026-10-14 (441-05, D-13): no auth-state redactor; a stored value is served as written.
      const [runRes, artifactRes, logsRes] = await Promise.all([
        invokeRoute(`/api/runs/${runId}`),
        invokeRoute(`/api/runs/${runId}/artifact`),
        invokeRoute(`/api/runs/${runId}/execution-logs`),
      ])

      expect(runRes.status).toBe(200)
      expect(JSON.parse(runRes.body).run.name).toBe('Auth redaction run')
      expect(artifactRes.status).toBe(200)
      const payload = JSON.parse(artifactRes.body).artifact.payload
      expect(payload.config.rawConfigContent).toBe('use:\n  authState: demo-acc\n')
      expect(payload.config.effectiveConfig).toEqual({ use: { authState: 'demo-acc' } })
      expect(payload.runtime).toEqual({ storageStatePath: storagePath, storageState: AUTH_STATE_PAYLOAD })
      expect(logsRes.status).toBe(200)
      expect(JSON.parse(logsRes.body).logs[0]).toMatchObject({
        stdout: '/workspace/.agent-qa-auth-state/storage-state.json',
        stderr: storageJson,
        variables: { SESSION_TOKEN: 'hook-session-token', SAFE_VALUE: 'visible' },
      })

      actualDb.close()
    })
  })

  describe('GET /api/runs', () => {
    it('returns empty runs list', async () => {
      const res = await invokeRoute('/api/runs')
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as any
      expect(data.runs).toEqual([])
      expect(data.total).toBe(0)
    })

    it('returns runs list', async () => {
      insertSampleRun()
      insertSampleRun({ name: 'Signup Test', status: 'failed' })

      const res = await invokeRoute('/api/runs')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(2)
      expect(data.total).toBe(2)
    })

    it('filters by status', async () => {
      insertSampleRun({ status: 'passed' })
      insertSampleRun({ name: 'Fail Test', status: 'failed' })

      const res = await invokeRoute('/api/runs?status=passed')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(1)
      expect(data.runs[0].status).toBe('passed')
    })

    it('filters by name', async () => {
      insertSampleRun({ name: 'Login Test' })
      insertSampleRun({ name: 'Signup Test' })

      const res = await invokeRoute('/api/runs?name=Login')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(1)
      expect(data.runs[0].name).toBe('Login Test')
    })

    it('does not filter by legacy tag query parameters', async () => {
      insertSampleRun({ tags: ['smoke', 'auth'] })
      insertSampleRun({ name: 'No Tags', tags: ['regression'] })

      const res = await invokeRoute('/api/runs?tag=smoke')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(2)
    })

    it('filters by date range', async () => {
      insertSampleRun({ startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ name: 'Old Test', startedAt: '2026-02-01T10:00:00Z' })

      const res = await invokeRoute('/api/runs?from=2026-02-15T00:00:00Z')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(1)
      expect(data.runs[0].name).toBe('Login Test')
    })

    it('supports pagination', async () => {
      for (let i = 0; i < 5; i++) {
        insertSampleRun({ name: `Test ${i}` })
      }

      const res = await invokeRoute('/api/runs?limit=2&offset=0')
      const data = JSON.parse(res.body) as any
      expect(data.runs).toHaveLength(2)
      expect(data.total).toBe(5)

      const res2 = await invokeRoute('/api/runs?limit=2&offset=2')
      const data2 = JSON.parse(res2.body) as any
      expect(data2.runs).toHaveLength(2)
    })

    it('filters by effective platform for target-driven runs instead of raw stored defaults', async () => {
      const configContent = [
        'registry:',
        '  targets:',
        '    maps-android:',
        '      platform: android',
        '      appPackage: com.google.android.apps.maps',
        '    hn-web:',
        '      platform: web',
        '      url: https://news.ycombinator.com',
        '',
      ].join('\n')
      const { configManager, configPath } = await createConfigWorkspace(configContent)
      insertSampleRun({
        id: 'run-mobile',
        name: 'Android map flow',
        platform: 'web',
        testFileContent: ['name: Android map flow', 'target: maps-android', 'steps: []', ''].join('\n'),
      })
      insertSampleRun({
        id: 'run-web',
        name: 'Web home flow',
        platform: 'web',
        testFileContent: ['name: Web home flow', 'target: hn-web', 'steps: []', ''].join('\n'),
      })

      router = createRouter({
        db: db as any,
        configManager,
        configPath,
      })

      const res = await invokeRoute('/api/runs?platform=android')
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as {
        total: number
        runs: Array<{ id: string; targetName: string | null; platform: string }>
      }

      expect(data.total).toBe(1)
      expect(data.runs).toEqual([
        expect.objectContaining({
          id: 'run-mobile',
          targetName: 'maps-android',
          platform: 'android',
        }),
      ])
    })
  })

  describe('GET /api/tests', () => {
    it('returns target metadata and target options for truthful tests-page filters', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-tests-routes-'))
      tempDirs.push(testsDir)
      await writeFile(
        join(testsDir, 'login.yaml'),
        ['name: Login flow', 'test-id: t_login', 'target: web-prod', 'platform: web', 'steps: []', ''].join('\n'),
        'utf-8',
      )
      await writeFile(
        join(testsDir, 'signup.yaml'),
        ['name: Signup flow', 'test-id: t_signup', 'target: android-staging', 'platform: android', 'steps: []', ''].join('\n'),
        'utf-8',
      )

      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
      })

      const res = await invokeRoute('/api/tests')
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as {
        files: Array<{ path: string; targetName: string | null; platform: string | null }>
        targets: string[]
      }

      expect(data.targets).toEqual(expect.arrayContaining(['web-prod', 'android-staging']))
      expect(data.targets).toHaveLength(2)
      expect(data.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'login.yaml',
          targetName: 'web-prod',
          platform: 'web',
        }),
        expect.objectContaining({
          path: 'signup.yaml',
          targetName: 'android-staging',
          platform: 'android',
        }),
      ]))
    })

    it('derives platform metadata from target registry when test YAML omits top-level platform', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-tests-target-platform-'))
      tempDirs.push(testsDir)
      const configContent = [
        'registry:',
        '  targets:',
        '    maps-android:',
        '      platform: android',
        '      appPackage: com.google.android.apps.maps',
        '    hn-web:',
        '      platform: web',
        '      url: https://news.ycombinator.com',
        '',
      ].join('\n')
      const { configManager, configPath } = await createConfigWorkspace(configContent)
      await writeFile(
        join(testsDir, 'android-map.yaml'),
        ['name: Android map flow', 'test-id: t_android', 'target: maps-android', 'steps: []', ''].join('\n'),
        'utf-8',
      )
      await writeFile(
        join(testsDir, 'web-home.yaml'),
        ['name: Web home flow', 'test-id: t_web', 'target: hn-web', 'steps: []', ''].join('\n'),
        'utf-8',
      )

      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        configManager,
        configPath,
      })

      const res = await invokeRoute('/api/tests')
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as {
        files: Array<{ path: string; targetName: string | null; platform: string | null }>
      }

      expect(data.files).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'android-map.yaml',
          targetName: 'maps-android',
          platform: 'android',
        }),
        expect.objectContaining({
          path: 'web-home.yaml',
          targetName: 'hn-web',
          platform: 'web',
        }),
      ]))
    })
  })

  describe('POST /api/tests/validate', () => {
    it('returns the existing { valid, errors } success shape for canonical test content', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute('/api/tests/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: [
            `test-id: ${SEEDED_TEST_ID_TWO}`,
            'name: Login flow',
            'target: web',
            'steps:',
            '  - Open the login page',
            '',
          ].join('\n'),
        }),
      })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ valid: true, errors: [] })
    })

    it('keeps the response shape when shared validation rejects legacy test ids', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute('/api/tests/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: [
            `test-id: ${LEGACY_TEST_ID}`,
            'name: Legacy login flow',
            'target: web',
            'steps:',
            '  - Open the login page',
            '',
          ].join('\n'),
        }),
      })

      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as {
        valid: boolean
        errors: Array<{ message: string }>
      }
      expect(data.valid).toBe(false)
      expect(Array.isArray(data.errors)).toBe(true)
      expect(data.errors[0]?.message).toContain('Test ID must be t_ followed by 10 id-agent words')
    })
  })

  describe('POST /api/suites/validate', () => {
    it('returns the existing { valid, errors } success shape for canonical suite content', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute('/api/suites/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: [
            `suite-id: ${SEEDED_SUITE_ID}`,
            'name: Smoke suite',
            'target: web',
            'tests:',
            '  - test: t.yaml',
            `    id: ${SEEDED_TEST_ID}`,
            '',
          ].join('\n'),
        }),
      })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ valid: true, errors: [] })
    })

    it('keeps the response shape when shared validation rejects legacy suite ids', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute('/api/suites/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: [
            `suite-id: ${LEGACY_SUITE_ID}`,
            'name: Legacy suite',
            'target: web',
            'tests:',
            '  - test: t.yaml',
            `    id: ${LEGACY_TEST_ID}`,
            '',
          ].join('\n'),
        }),
      })

      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as {
        valid: boolean
        errors: Array<{ message: string }>
      }
      expect(data.valid).toBe(false)
      expect(Array.isArray(data.errors)).toBe(true)
      expect(data.errors[0]?.message).toContain('Suite ID must be s_ followed by 10 id-agent words')
    })
  })

  describe('DELETE /api/tests/:t_id', () => {
    it('deletes a test file by test id for the tests-page bottom toolbar', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-tests-delete-'))
      tempDirs.push(testsDir)
      await writeFile(
        join(testsDir, 'login.yaml'),
        ['name: Login flow', 'test-id: t_login', 'target: web-prod', 'steps: []', ''].join('\n'),
        'utf-8',
      )

      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
      })

      const res = await invokeRoute('/api/tests/t_login', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ deleted: true, path: 'login.yaml' })
      await expect(readFile(join(testsDir, 'login.yaml'), 'utf-8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  describe('GET /api/runs/:id', () => {
    // 405-07 (D-03): the body is `{ run }` and nothing else. It used to carry `steps` off a v1
    // projection with no producer and `attempts`/`tests` off a child-run walk over a deleted
    // column — three keys that were structurally empty on every run this build produces. The run's
    // members, steps and sub-actions are `GET /api/runs/:id/detail`'s, through `runs.detail`.
    it('returns the run row, and only the run row', async () => {
      const runId = insertSampleRun()

      const res = await invokeRoute(`/api/runs/${runId}`)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as Record<string, unknown>
      expect(Object.keys(data)).toEqual(['run'])
      expect((data.run as { id: string }).id).toBe(runId)
      expect((data.run as { name: string }).name).toBe('Login Test')
    })

    it('returns 404 for unknown run', async () => {
      const res = await invokeRoute('/api/runs/nonexistent-id')
      expect(res.status).toBe(404)
      const data = JSON.parse(res.body) as any
      expect(data.error).toBe('Run not found')
    })
  })

  // 2026-08-27 (405-07, D-14): the video-serving describe is deleted with the route. Two cells
  // stood here — one served a file under a run-id directory, one refused a flat file through a
  // run-id URL. There is no path-addressed artifact route left and no video surface at all, because
  // no producer mints a recording ref; `routes.traversal.test.ts` holds the containment cells for
  // the ref-addressed route that replaced them.

  describe('DELETE /api/runs/:id', () => {
    // 2026-08-27 (405-07, D-14 · T-405-27): ROWS ONLY, AND THE FILESYSTEM CLAIM IS INVERTED.
    //
    // The cell that stood here seeded a parent/child run tree with screenshot and video
    // directories and asserted the delete REMOVED them. The parent link is gone, the path columns
    // are gone, and the sweep is gone: what lives under a run's directory is the event log and the
    // content-addressed blobs, which are the run's own record and not the dashboard's to delete.
    // So the same fixture now asserts the opposite — every byte on disk survives.
    it('deletes the run rows, preserves token event stats, and touches no file', async () => {
      const { artifactsDir, db: actualDb } = await createDashboardWorkspace()
      const runDir = join(artifactsDir, 'runs', 'suite_run')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'events.jsonl'), '{"seq":1}\n', 'utf-8')

      actualDb.insertRun({
        id: 'suite_run',
        name: 'Suite run',
        status: 'failed',
        duration: 1200,
        startedAt: '2026-04-19T00:00:00.000Z',
        endedAt: '2026-04-19T00:00:01.200Z',
        suiteId: 's_long-suite',
      })
      actualDb.insertRunArtifact({ runId: 'suite_run', kind: 'test' })
      actualDb.upsertRunMember({ runId: 'suite_run', testIndex: 0, name: 'Member A' })
      actualDb.insertTokenEvent({
        modelName: 'gpt-5.4-mini',
        promptTokens: 10,
        completionTokens: 5,
        source: 'test-run',
      })

      router = createRouter({ db: actualDb })

      const res = await invokeRoute('/api/runs/suite_run', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({
        deleted: true,
        deletedRunIds: ['suite_run'],
      })
      expect(actualDb.getRun('suite_run')).toBeUndefined()
      // The cascade reached the run's projected rows and its artifact...
      expect(actualDb.getRunArtifact('suite_run')).toBeNull()
      expect(actualDb.readRunDetailRows('suite_run')).toBeUndefined()
      // ...and did not reach the token events, which are not run-scoped.
      expect(actualDb.getTokenEventStats().totals).toEqual({
        promptTokens: 10,
        completionTokens: 5,
      })
      // The run's own record on disk is untouched.
      await expect(stat(join(runDir, 'events.jsonl')))
        .resolves.toMatchObject({ isFile: expect.any(Function) })

      actualDb.close()
    })

    it('answers 404 for a run that does not exist', async () => {
      const { db: actualDb } = await createDashboardWorkspace()
      router = createRouter({ db: actualDb })

      const res = await invokeRoute('/api/runs/never_existed', { method: 'DELETE' })
      expect(res.status).toBe(404)

      actualDb.close()
    })
  })

  // 2026-08-27 (405-07, D-03): the step-list describe is deleted with the arm. `runs.detail` is
  // the one read for a run's members, steps and sub-actions, and it is proven end-to-end in
  // `run-service/__tests__/run-detail-routes.test.ts`. The absence of this arm — and of the three
  // others the census retired — is pinned in `suite-parent-debris-census.test.ts`, which drives
  // each retired URL against a live router and requires the generic 404.

  describe('POST /api/queue/enqueue', () => {
    it('normalizes queued files under configured workspace.testMatch', async () => {
      const testsDir = join(tmpdir(), `agent-qa-queue-tests-${randomUUID()}`, 'e2e-specs')
      tempDirs.push(dirname(testsDir))
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/15-github-trending.yaml'), 'name: Queued test\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-queue')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue' }]),
      }
      router = createRouter({
        db: queueDb as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Queued test', file: 'web/15-github-trending.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Queued test',
        filePath: 'web/15-github-trending.yaml',
        metadata: expect.objectContaining({
          args: [join(testsDir, 'web/15-github-trending.yaml')],
        }),
      }))
    })

    it('honors non-default workspace test and suite patterns', async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-non-default-'))
      tempDirs.push(workspaceDir)
      await mkdir(join(workspaceDir, 'specs/web'), { recursive: true })
      await mkdir(join(workspaceDir, 'cases'), { recursive: true })
      await writeFile(join(workspaceDir, 'specs/web/login.yaml'), 'name: Login\nsteps: []\n', 'utf-8')
      await writeFile(join(workspaceDir, 'cases/smoke.suite.yaml'), `suite-id: ${SEEDED_SUITE_ID}\nname: Smoke\ntests: []\n`, 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-queue-non-default')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue-non-default' }]),
      }
      router = createRouter({
        db: queueDb as any,
        ...createWorkspaceManagers(workspaceDir, {
          testMatch: ['specs/web/**/*.yaml'],
          suiteMatch: ['cases/**/*.suite.yaml'],
        }),
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Queued non-default test', file: 'specs/web/login.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'specs/web/login.yaml',
        metadata: expect.objectContaining({
          args: [join(workspaceDir, 'specs/web/login.yaml')],
        }),
      }))
    })

    it('accepts user attributes and adds API internal attributes', async () => {
      const enqueue = vi.fn().mockReturnValue('run-queue-attrs')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue-attrs' }]),
      }
      router = createRouter({
        db: queueDb as any,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Queued attrs',
          attributes: { 'git.branch': 'phase223-main' },
        }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        attributes: {
          'agent-qa.trigger': 'api',
          'agent-qa.runner': 'local',
          'git.branch': 'phase223-main',
        },
      }))
    })

    it('rejects protected API attributes', async () => {
      const enqueue = vi.fn().mockReturnValue('run-queue-protected')
      router = createRouter({
        db: db as any,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Protected attrs',
          attributes: { 'agent-qa.trigger': 'evil' },
        }),
      })

      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error).toContain('reserved prefix "agent-qa."')
      expect(enqueue).not.toHaveBeenCalled()
    })

    // ---- G-401-18-CR01 (write half): `metadata` is server-derived -----------------------------
    //
    // THE REJECT/ADMIT PAIR. A control that only shows the door refusing cannot tell an allowlist
    // apart from a route that 400s on every request, and a control that only shows it admitting
    // cannot tell one apart from a route with no validation at all. Both are here, and the ADMIT
    // side is the one that proves the tightening validated the door rather than closing it: a
    // caller's own labels still round-trip, through `attributes`, which is their actual door.

    it('REJECT — a client-supplied metadata key is refused by name, not silently dropped', async () => {
      const enqueue = vi.fn().mockReturnValue('run-queue-metadata')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue-metadata' }]),
      }
      router = createRouter({
        db: queueDb as any,
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Queued metadata test',
          metadata: {
            target: '/tmp/outside.yaml',
            args: ['/tmp/outside.yaml'],
            keep: 'trusted label',
            confirmScope: 'run-trigger:planted-by-a-client',
            timeout: 9_007_199_254_740_991,
          },
        }),
      })

      expect(res.status).toBe(400)
      const error = String((JSON.parse(res.body) as { error: string }).error)
      // NAMED, ALL OF THEM. A message that mentioned only the first offending key would let a
      // caller peel the request one key at a time and never learn the rule.
      for (const key of ['args', 'confirmScope', 'keep', 'target', 'timeout']) {
        expect(error, `the refusal did not name ${key}`).toContain(key)
      }
      expect(error).toContain('attributes')
      // AND NOTHING WAS ENQUEUED — a 400 that still queued the run would be a worse defect than
      // the one this closes.
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('ADMIT — a request with no client metadata queues, and the caller\'s own labels round-trip', async () => {
      const enqueue = vi.fn().mockReturnValue('run-queue-admitted')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue-admitted' }]),
      }
      router = createRouter({
        db: queueDb as any,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Queued admitted',
          metadata: {},
          attributes: { 'git.branch': 'gap-401-23' },
        }),
      })

      expect(res.status).toBe(202)
      // THE SERVER'S OWN METADATA STILL REACHES THE QUEUE. The allowlist refuses what a CLIENT
      // writes; it must not have deleted what this route writes.
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { args: [] },
        attributes: expect.objectContaining({ 'git.branch': 'gap-401-23' }),
      }))
    })

    it('rejects absolute queued files outside configured workspace patterns', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-contained-'))
      const outsideDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-outside-'))
      tempDirs.push(testsDir, outsideDir)
      const enqueue = vi.fn().mockReturnValue('run-queue-outside')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Outside queued test', file: join(outsideDir, 'outside.yaml') }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects queued traversal paths outside the configured workspace', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-contained-'))
      tempDirs.push(testsDir)
      const enqueue = vi.fn().mockReturnValue('run-queue-traversal')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Traversal queued test', file: '../../outside.yaml' }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('normalizes queued suite files against the suite root instead of testsDir', async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-suite-root-'))
      const testsDir = join(workspaceDir, 'tests')
      const suitesDir = join(workspaceDir, 'suites')
      tempDirs.push(workspaceDir)
      await mkdir(testsDir, { recursive: true })
      await mkdir(suitesDir, { recursive: true })
      await writeFile(
        join(suitesDir, 'sample-basic.suite.yaml'),
        [`suite-id: ${SEEDED_SUITE_ID}`, 'name: Sample Basic', 'tests: []', ''].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-queue-suite')
      const queueDb = {
        ...(db as any),
        getPendingRuns: vi.fn(() => [{ id: 'run-queue-suite' }]),
      }
      router = createRouter({
        db: queueDb as any,
        ...createWorkspaceManagers(workspaceDir, {
          testMatch: ['tests/**/*.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
        }),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Queued suite', file: 'suites/sample-basic.suite.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Queued suite',
        filePath: 'suites/sample-basic.suite.yaml',
        // 402-09 (D-11): no parent kind is minted; `metadata.isSuite` still carries the identity.
        kind: 'test',
        metadata: expect.objectContaining({
          args: [join(workspaceDir, 'suites', 'sample-basic.suite.yaml')],
          isSuite: true,
        }),
      }))
      expect(enqueue.mock.calls[0][0].metadata.args[0]).not.toContain(`${sep}tests${sep}suites${sep}`)
    })

    it('rejects queued suite paths outside configured suite patterns', async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-suite-contained-'))
      const outsideDir = await mkdtemp(join(tmpdir(), 'agent-qa-queue-suite-outside-'))
      tempDirs.push(workspaceDir, outsideDir)
      const testsDir = join(workspaceDir, 'tests')
      await mkdir(testsDir, { recursive: true })
      const enqueue = vi.fn().mockReturnValue('run-queue-outside-suite')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(workspaceDir, {
          testMatch: ['tests/**/*.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
        }),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/queue/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Outside queued suite', file: join(outsideDir, 'outside.suite.yaml') }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/runs/trigger', () => {
    function queuedMetadata(enqueue: ReturnType<typeof vi.fn>): Record<string, unknown> {
      return enqueue.mock.calls[0][0].metadata as Record<string, unknown>
    }

    async function createTriggerTimeoutWorkspace(configTestTimeout = '20m'): Promise<{
      testsDir: string
      workspacePaths: ResolvedWorkspacePaths
      configManager: ConfigManager
      configPath: string
      testFileManager: TestFileManager
      suiteFileManager: SuiteFileManager
    }> {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-timeout-'))
      tempDirs.push(testsDir)
      const { configManager, configPath } = await createConfigWorkspace([
        'use:',
        '  timeout:',
        '    step: 30s',
        `    test: ${configTestTimeout}`,
        '    navigation: 30s',
        '',
      ].join('\n'))
      const { workspacePaths, testFileManager, suiteFileManager } = createWorkspaceManagers(testsDir)
      return { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager }
    }

    async function createTriggerParallelWorkspace(configParallel = true): Promise<{
      testsDir: string
      workspacePaths: ResolvedWorkspacePaths
      configManager: ConfigManager
      configPath: string
      testFileManager: TestFileManager
      suiteFileManager: SuiteFileManager
    }> {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-parallel-'))
      tempDirs.push(testsDir)
      const { configManager, configPath } = await createConfigWorkspace([
        'use:',
        `  parallel: ${configParallel ? 'true' : 'false'}`,
        '',
      ].join('\n'))
      const { workspacePaths, testFileManager, suiteFileManager } = createWorkspaceManagers(testsDir)
      return { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager }
    }

    it('resolves test-viewer paths through configured workspace.testMatch', async () => {
      const testsDir = join(tmpdir(), `agent-qa-trigger-tests-${randomUUID()}`, 'e2e-specs')
      tempDirs.push(dirname(testsDir))
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/15-github-trending.yaml'), 'name: Trending\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-1')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'web/15-github-trending.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'web/15-github-trending.yaml',
        metadata: expect.objectContaining({
          args: [join(testsDir, 'web/15-github-trending.yaml')],
        }),
      }))
    })

    it('rejects dashboard-triggered run tags', async () => {
      const enqueue = vi.fn().mockReturnValue('run-tags')
      router = createRouter({
        db: db as any,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags: ['smoke'] }),
      })

      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error).toBe('tags are not supported for dashboard-triggered runs')
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('normalizes trigger patterns against discovered configured workspace tests', async () => {
      const testsDir = join(tmpdir(), `agent-qa-trigger-tests-${randomUUID()}`, 'e2e-specs')
      tempDirs.push(dirname(testsDir))
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/15-github-trending.yaml'), 'name: Trending\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-patterns')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patterns: ['web/*.yaml'] }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          args: [join(testsDir, 'web/15-github-trending.yaml')],
        }),
      }))
    })

    it('uses global use.parallel for dashboard-triggered test files and ignores client parallel', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerParallelWorkspace(true)
      await writeFile(
        join(testsDir, 'global-parallel.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Global parallel', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-global-parallel')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'global-parallel.yaml', parallel: false }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'global-parallel.yaml',
        parallel: true,
      }))
    })

    it('lets test YAML use.parallel false override global use.parallel true', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerParallelWorkspace(true)
      await writeFile(
        join(testsDir, 'serial-local.yaml'),
        [
          `test-id: ${SEEDED_TEST_ID}`,
          'name: Serial local',
          'target: web',
          'use:',
          '  parallel: false',
          'steps:',
          '  - Open the app',
          '',
        ].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-file-parallel')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'serial-local.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'serial-local.yaml',
        parallel: false,
      }))
    })

    it('uses global use.parallel for pattern-triggered dashboard runs', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerParallelWorkspace(true)
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/pattern-parallel.yaml'), 'name: Pattern parallel\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-pattern-parallel')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patterns: ['web/*.yaml'] }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        parallel: true,
        metadata: expect.objectContaining({
          args: [join(testsDir, 'web/pattern-parallel.yaml')],
        }),
      }))
    })

    it('rejects absolute trigger patterns outside configured workspace tests', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-contained-'))
      const outsideDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-outside-'))
      tempDirs.push(testsDir, outsideDir)
      const enqueue = vi.fn().mockReturnValue('run-outside-pattern')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patterns: [join(outsideDir, '*.yaml')] }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects trigger pattern traversal outside the configured workspace', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-contained-'))
      tempDirs.push(testsDir)
      const enqueue = vi.fn().mockReturnValue('run-traversal-pattern')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patterns: ['../*.yaml'] }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('normalizes dashboard list workspace paths before enqueueing the run', async () => {
      const testsDir = join(tmpdir(), `agent-qa-trigger-tests-${randomUUID()}`, 'e2e-specs')
      tempDirs.push(dirname(testsDir))
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/15-github-trending.yaml'), 'name: Trending\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-2')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'web/15-github-trending.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'web/15-github-trending.yaml',
        metadata: expect.objectContaining({
          args: [join(testsDir, 'web/15-github-trending.yaml')],
        }),
      }))
    })

    it('rejects absolute test files outside configured workspace tests', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-contained-'))
      const outsideDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-outside-'))
      tempDirs.push(testsDir, outsideDir)
      const enqueue = vi.fn().mockReturnValue('run-outside')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: join(outsideDir, 'outside.yaml') }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects relative traversal test files outside the configured workspace', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-contained-'))
      tempDirs.push(testsDir)
      const enqueue = vi.fn().mockReturnValue('run-traversal')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: '../../outside.yaml' }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('rejects suite files outside the configured suite root before enqueueing', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-contained-'))
      const outsideDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-outside-'))
      tempDirs.push(testsDir, outsideDir)
      const enqueue = vi.fn().mockReturnValue('run-outside-suite')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: join(outsideDir, 'outside.suite.yaml') }),
      })

      expect(res.status).toBe(400)
      expect(enqueue).not.toHaveBeenCalled()
    })

    it('runs suite files from the suite root without nesting them under testsDir', async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-suite-root-'))
      const testsDir = join(workspaceDir, 'tests')
      const suitesDir = join(workspaceDir, 'suites')
      tempDirs.push(workspaceDir)
      await mkdir(testsDir, { recursive: true })
      await mkdir(suitesDir, { recursive: true })
      const { configManager, configPath } = await createConfigWorkspace([
        'use:',
        '  timeout:',
        '    step: 30s',
        '    test: 20m',
        '    navigation: 30s',
        '',
      ].join('\n'))
      const { workspacePaths, testFileManager, suiteFileManager } = createWorkspaceManagers(workspaceDir, {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
      })
      await writeFile(
        join(testsDir, 'suite-member.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Suite member', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      await writeFile(
        join(suitesDir, 'slow.suite.yaml'),
        [
          `suite-id: ${SEEDED_SUITE_ID}`,
          'name: Workspace suite',
          'target: web',
          'use:',
          '  timeout:',
          '    test: 90m',
          'tests:',
          '  - test: tests/suite-member.yaml',
          `    id: ${SEEDED_TEST_ID}`,
          '',
        ].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-suite-root')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'suites/slow.suite.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Workspace suite',
        filePath: 'suites/slow.suite.yaml',
        // 402-09 (D-11): no parent kind is minted; `metadata.isSuite` still carries the identity.
        kind: 'test',
        metadata: expect.objectContaining({
          args: [join(workspaceDir, 'suites', 'slow.suite.yaml')],
          isSuite: true,
          timeout: 5_460_000,
          timeoutSource: 'suite.use.timeout.test',
          timeoutBaseMs: 5_400_000,
          timeoutBufferMs: 60_000,
        }),
      }))
      expect(enqueue.mock.calls[0][0].metadata.args[0]).not.toContain(`${sep}tests${sep}suites${sep}`)
    })

    it('uses suite YAML use.parallel for dashboard-triggered suite jobs', async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-suite-parallel-'))
      const testsDir = join(workspaceDir, 'tests')
      const suitesDir = join(workspaceDir, 'suites')
      tempDirs.push(workspaceDir)
      await mkdir(testsDir, { recursive: true })
      await mkdir(suitesDir, { recursive: true })
      const { configManager, configPath } = await createConfigWorkspace([
        'use:',
        '  parallel: false',
        '',
      ].join('\n'))
      const { workspacePaths, testFileManager, suiteFileManager } = createWorkspaceManagers(workspaceDir, {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
      })
      await writeFile(
        join(testsDir, 'suite-member.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Suite member', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      await writeFile(
        join(suitesDir, 'parallel.suite.yaml'),
        [
          `suite-id: ${SEEDED_SUITE_ID}`,
          'name: Parallel suite',
          'target: web',
          'use:',
          '  parallel: true',
          'tests:',
          '  - test: tests/suite-member.yaml',
          `    id: ${SEEDED_TEST_ID}`,
          '',
        ].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-suite-parallel')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'suites/parallel.suite.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Parallel suite',
        filePath: 'suites/parallel.suite.yaml',
        // 402-09 (D-11): no parent kind is minted; `metadata.isSuite` still carries the identity.
        kind: 'test',
        parallel: true,
        metadata: expect.objectContaining({ isSuite: true }),
      }))
    })

    it('passes the cache override through to the queued args and labels the run local', async () => {
      const testsDir = join(tmpdir(), `agent-qa-trigger-tests-${randomUUID()}`, 'e2e-specs')
      tempDirs.push(dirname(testsDir))
      await mkdir(join(testsDir, 'web'), { recursive: true })
      await writeFile(join(testsDir, 'web/15-github-trending.yaml'), 'name: Trending\nsteps: []\n', 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-3')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        jobQueue: {
          enqueue,
        } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'web/15-github-trending.yaml',
          noCache: true,
        }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'web/15-github-trending.yaml',
        attributes: {
          'agent-qa.trigger': 'dashboard',
          'agent-qa.runner': 'local',
        },
        metadata: expect.objectContaining({
          args: [
            join(testsDir, 'web/15-github-trending.yaml'),
            '--disable-cache',
          ],
        }),
      }))
      expect(enqueue.mock.calls[0][0].metadata).not.toHaveProperty('runDestination')
    })

    it('derives the queued platform from target metadata when the test file has no top-level platform', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-trigger-target-platform-'))
      tempDirs.push(testsDir)
      const configContent = [
        'registry:',
        '  targets:',
        '    maps-android:',
        '      platform: android',
        '      appPackage: com.google.android.apps.maps',
        '',
      ].join('\n')
      const { configManager, configPath } = await createConfigWorkspace(configContent)
      await writeFile(
        join(testsDir, 'android-only.yaml'),
        ['name: Android-only flow', 'test-id: t_android_only', 'target: maps-android', 'steps: []', ''].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-target-platform')
      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'android-only.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'android-only.yaml',
        platform: 'android',
      }))
    })

    it('derives process timeout metadata from test YAML before config fallback', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerTimeoutWorkspace('20m')
      await writeFile(
        join(testsDir, 'slow-local.yaml'),
        [
          `test-id: ${SEEDED_TEST_ID}`,
          'name: Slow local model',
          'target: web',
          'use:',
          '  timeout:',
          '    test: 100m',
          'steps:',
          '  - Open the app',
          '',
        ].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-timeout-test')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'slow-local.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(queuedMetadata(enqueue)).toMatchObject({
        timeout: 6_060_000,
        timeoutSource: 'test.use.timeout.test',
        timeoutBaseMs: 6_000_000,
        timeoutBufferMs: 60_000,
      })
    })

    it('derives process timeout metadata from suite YAML before config fallback', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerTimeoutWorkspace('20m')
      await writeFile(
        join(testsDir, 'suite-member.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Suite member', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      await writeFile(
        join(testsDir, 'slow.suite.yaml'),
        [
          `suite-id: ${SEEDED_SUITE_ID}`,
          'name: Slow suite',
          'target: web',
          'use:',
          '  timeout:',
          '    test: 90m',
          'tests:',
          '  - test: suite-member.yaml',
          `    id: ${SEEDED_TEST_ID}`,
          '',
        ].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-timeout-suite')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'slow.suite.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(queuedMetadata(enqueue)).toMatchObject({
        timeout: 5_460_000,
        timeoutSource: 'suite.use.timeout.test',
        timeoutBaseMs: 5_400_000,
        timeoutBufferMs: 60_000,
      })
    })

    it('falls back to project config timeout when test YAML has no timeout', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerTimeoutWorkspace('45m')
      await writeFile(
        join(testsDir, 'config-timeout.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Config timeout', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-timeout-config')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'config-timeout.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(queuedMetadata(enqueue)).toMatchObject({
        timeout: 2_760_000,
        timeoutSource: 'config.use.timeout.test',
        timeoutBaseMs: 2_700_000,
        timeoutBufferMs: 60_000,
      })
    })

    it('falls back to project config timeout when draft YAML cannot be parsed', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerTimeoutWorkspace('30m')
      await writeFile(join(testsDir, 'draft.yaml'), ['name: Draft', 'use: [', ''].join('\n'), 'utf-8')
      const enqueue = vi.fn().mockReturnValue('run-timeout-draft')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'draft.yaml' }),
      })

      expect(res.status).toBe(202)
      expect(queuedMetadata(enqueue)).toMatchObject({
        timeout: 1_860_000,
        timeoutSource: 'config.use.timeout.test',
        timeoutBaseMs: 1_800_000,
        timeoutBufferMs: 60_000,
      })
    })

    it('ignores client-provided timeout fields when enqueueing trusted metadata', async () => {
      const { testsDir, workspacePaths, configManager, configPath, testFileManager, suiteFileManager } = await createTriggerTimeoutWorkspace('15m')
      await writeFile(
        join(testsDir, 'trusted-timeout.yaml'),
        [`test-id: ${SEEDED_TEST_ID}`, 'name: Trusted timeout', 'target: web', 'steps:', '  - Open the app', ''].join('\n'),
        'utf-8',
      )
      const enqueue = vi.fn().mockReturnValue('run-timeout-tamper')
      router = createRouter({
        db: db as any,
        workspacePaths,
        testFileManager,
        suiteFileManager,
        configManager,
        configPath,
        jobQueue: { enqueue } as any,
      })

      const res = await invokeRoute('/api/runs/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'trusted-timeout.yaml',
          timeout: 1,
          metadata: { timeout: 1 },
        }),
      })

      expect(res.status).toBe(202)
      expect(queuedMetadata(enqueue)).toMatchObject({
        timeout: 960_000,
        timeoutSource: 'config.use.timeout.test',
        timeoutBaseMs: 900_000,
        timeoutBufferMs: 60_000,
      })
    })
  })

  describe('POST /api/llm/test', () => {
    it('uses a slow-model-aware timeout for localhost compatible provider checks', async () => {
      const res = await invokeRoute('/api/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          configName: `local-openai-${randomUUID()}`,
          provider: 'openai-compatible',
          model: 'local-model',
          baseURL: 'http://127.0.0.1:1234/v1',
        }),
      })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({
        success: true,
        timeoutMs: 120_000,
      })
      expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
      }))
    })

    it('keeps remote compatible provider checks on the remote connectivity timeout', async () => {
      const res = await invokeRoute('/api/llm/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          configName: `remote-openai-${randomUUID()}`,
          provider: 'openai-compatible',
          model: 'remote-model',
          baseURL: 'https://api.example.com/v1',
        }),
      })

      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({
        success: true,
        timeoutMs: 10_000,
      })
    })
  })

  describe('POST /api/cache/purge', () => {
    async function seedCacheWorkspace() {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-cache-purge-tests-'))
      const cacheDir = await mkdtemp(join(tmpdir(), 'agent-qa-cache-purge-cache-'))
      tempDirs.push(testsDir, cacheDir)

      const configContent = [
        'services:',
        '  cache:',
        `    dir: ${cacheDir}`,
        'registry:',
        '  targets:',
        '    web:',
        '      platform: web',
        '      url: https://example.com',
        '',
      ].join('\n')
      const { configManager, configPath } = await createConfigWorkspace(configContent)

      const entries = [
        join(cacheDir, 'main', 'a1b2c3d4e5f60718.json'),
        join(cacheDir, 'feature-x', 'f0e1d2c3b4a59687.json'),
      ]
      for (const entry of entries) {
        await mkdir(dirname(entry), { recursive: true })
        await writeFile(entry, '{"schemaVersion":10}', 'utf-8')
      }

      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        configManager,
        configPath,
      })
      return entries
    }

    it('purges every branch-namespaced cache entry', async () => {
      const entries = await seedCacheWorkspace()

      const res = await invokeRoute('/api/cache/purge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })

      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as { purged: number }
      expect(data.purged).toBe(2)
      for (const entry of entries) {
        await expect(stat(entry)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    })

    it('refuses a purge request without all and deletes nothing', async () => {
      const entries = await seedCacheWorkspace()

      const res = await invokeRoute('/api/cache/purge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'web-flow.yaml' }),
      })

      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'all is required' })
      for (const entry of entries) {
        await expect(stat(entry)).resolves.toBeDefined()
      }
    })

    it('resolves relative services.cache.dir from the config file directory', async () => {
      const testsDir = await mkdtemp(join(tmpdir(), 'agent-qa-cache-purge-tests-'))
      tempDirs.push(testsDir)

      const configContent = [
        'services:',
        '  cache:',
        '    dir: .agent-qa/custom-cache',
        'registry:',
        '  targets:',
        '    web:',
        '      platform: web',
        '      url: https://example.com',
        '',
      ].join('\n')
      const { configManager, configPath } = await createConfigWorkspace(configContent)
      const configDir = dirname(configPath)
      const cacheDir = join(configDir, '.agent-qa/custom-cache')

      const branchDir = join(cacheDir, 'main')
      const cacheEntryPath = join(branchDir, 'a1b2c3d4e5f60718.json')
      await mkdir(branchDir, { recursive: true })
      await writeFile(cacheEntryPath, '{"schemaVersion":10}', 'utf-8')

      router = createRouter({
        db: db as any,
        ...createWorkspaceManagers(testsDir),
        configManager,
        configPath,
      })

      const res = await invokeRoute('/api/cache/purge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })

      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as { purged: number }
      expect(data.purged).toBe(1)
      await expect(stat(cacheEntryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  describe('GET /api/stats', () => {
    it('returns statistics', async () => {
      insertSampleRun({ status: 'passed' })
      insertSampleRun({ name: 'Fail', status: 'failed', duration: 3000 })

      const res = await invokeRoute('/api/stats')
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as any
      expect(data.totalRuns).toBe(2)
      expect(data.passed).toBe(1)
      expect(data.failed).toBe(1)
      expect(typeof data.avgDuration).toBe('number')
      expect(typeof data.flakeRate).toBe('number')
      expect(Array.isArray(data.runs)).toBe(true)
    })

    it('filters stats by date range', async () => {
      insertSampleRun({ startedAt: '2026-03-01T10:00:00Z' })
      insertSampleRun({ name: 'Old', startedAt: '2026-01-01T10:00:00Z' })

      const res = await invokeRoute('/api/stats?from=2026-02-01T00:00:00Z')
      const data = JSON.parse(res.body) as any
      expect(data.totalRuns).toBe(1)
    })
  })

  describe('CORS', () => {
    it('includes CORS headers on the legacy read routes', async () => {
      // MOVED OFF `/api/runs` BY 405 CR-01, and the move is the point. `json()`'s wildcard still
      // serves the legacy reads — that posture is unchanged and this cell still guards it — but
      // `/api/runs` stopped being one of them the moment 405-10 put restored cleartext on its body.
      const res = await invokeRoute('/api/stats')
      expect(res.headers['access-control-allow-origin']).toBe('*')
    })

    it('handles OPTIONS preflight', async () => {
      const res = await invokeRoute('/api/runs', { method: 'OPTIONS' })
      expect(res.status).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('*')
      expect(res.headers['access-control-allow-methods']).toContain('GET')
    })
  })

  describe('unknown routes', () => {
    it('returns 404 for unknown API paths', async () => {
      const res = await invokeRoute('/api/unknown')
      expect(res.status).toBe(404)
    })
  })

  describe('Suite file API by suite-id', () => {
    it('GET /api/suites/:suite-id returns 404 for unknown id', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute(`/api/suites/${encodeURIComponent(UNKNOWN_SUITE_ID)}`)
      expect(res.status).toBe(404)
      const data = JSON.parse(res.body) as any
      expect(data.error).toBe('Suite not found')
    })

    it('GET /api/suites/:suite-id returns 200 with {path, content, suiteId} on hit', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute(`/api/suites/${encodeURIComponent(SEEDED_SUITE_ID)}`)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as any
      expect(data.suiteId).toBe(SEEDED_SUITE_ID)
      expect(data.path).toBe('a.suite.yaml')
      expect(typeof data.content).toBe('string')
      expect(data.content).toContain('name: Seed')
    })

    it('PUT /api/suites/:suite-id returns 404 for unknown id without writing', async () => {
      const { testsDir, workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const res = await invokeRoute(`/api/suites/${encodeURIComponent(UNKNOWN_SUITE_ID)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: [
            `suite-id: ${UNKNOWN_SUITE_ID}`,
            'name: Nope',
            'target: web',
            'tests:',
            '  - test: t.yaml',
            `    id: ${SEEDED_TEST_ID}`,
            '',
          ].join('\n'),
        }),
      })

      expect(res.status).toBe(404)
      const data = JSON.parse(res.body) as any
      expect(data.error).toBe('Suite not found')

      // Verify no new file was written (tests dir still has only the seeded entries)
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(testsDir)
      expect(entries.sort()).toEqual(['a.suite.yaml', 't.yaml'])
    })

    it('PUT /api/suites/:suite-id updates suite by id and writes to internal path', async () => {
      const { testsDir, workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      const newContent = [
        `suite-id: ${SEEDED_SUITE_ID}`,
        'name: Seed Updated',
        'target: web',
        'tests:',
        '  - test: t.yaml',
        `    id: ${SEEDED_TEST_ID}`,
        '',
      ].join('\n')

      const res = await invokeRoute(`/api/suites/${encodeURIComponent(SEEDED_SUITE_ID)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      })

      expect(res.status).toBe(200)
      const data = JSON.parse(res.body) as any
      expect(data.path).toBe('a.suite.yaml')
      expect(data.updated).toBe(true)

      const { readFile } = await import('node:fs/promises')
      const onDisk = await readFile(join(testsDir, 'a.suite.yaml'), 'utf-8')
      expect(onDisk).toContain('name: Seed Updated')
    })

    it('PUT /api/suites/:suite-id returns 400 for invalid suite content', async () => {
      const { workspacePaths, suiteFileManager, testFileManager } = await createSuiteWorkspace()
      router = createRouter({ db: db as any, workspacePaths, suiteFileManager, testFileManager })

      // Missing required `name` field
      const invalidContent = [
        `suite-id: ${SEEDED_SUITE_ID}`,
        'target: web',
        'tests:',
        '  - test: t.yaml',
        `    id: ${SEEDED_TEST_ID}`,
        '',
      ].join('\n')

      const res = await invokeRoute(`/api/suites/${encodeURIComponent(SEEDED_SUITE_ID)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: invalidContent }),
      })

      expect(res.status).toBe(400)
      const data = JSON.parse(res.body) as any
      expect(data.error).toBe('Invalid suite content')
      expect(Array.isArray(data.details)).toBe(true)
    })
  })
})
