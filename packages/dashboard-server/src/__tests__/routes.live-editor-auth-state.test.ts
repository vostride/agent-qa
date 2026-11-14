import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_STATE_SCHEMA_VERSION,
  resolveAuthStatePaths,
  resolveWorkspacePaths,
  writeAuthStateFiles,
} from '@vostride/agent-qa-core'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

const CAPTURED_AT = '2026-11-14T09:30:00.000Z'
const FIXTURE_COOKIE_VALUE = 'made-up-cookie-value-for-the-door'

interface MockResponse {
  status: number
  body: string
}

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function createMockRequest(url: string, headers: IncomingHttpHeaders, body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1:3470', ...headers }
  process.nextTick(() => {
    req.push(Buffer.from(body))
    req.push(null)
  })
  return req
}

function invoke(router: ReturnType<typeof createRouter>, body: Record<string, unknown>): Promise<MockResponse> {
  return new Promise((resolve) => {
    let status = 200
    let text = ''
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      setHeader() {},
      getHeader() {
        return undefined
      },
      write(chunk: string | Buffer) {
        text += chunk.toString()
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) text += chunk.toString()
        resolve({ status, body: text })
      },
    } as unknown as ServerResponse
    const req = createMockRequest(
      '/api/live-editor/sessions',
      { 'content-type': 'application/json', host: '127.0.0.1:3470' },
      JSON.stringify(body),
    )
    router(req, res)
  })
}

async function workspace(options: { authStateDir?: string } = {}): Promise<{
  dir: string
  router: ReturnType<typeof createRouter>
  createSession: ReturnType<typeof vi.fn>
  authStateDir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-live-auth-door-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      ...(options.authStateDir === undefined
        ? ['services: {}']
        : ['services:', '  authState:', `    dir: ${options.authStateDir}`]),
      'registry:',
      '  targets:',
      '    shop:',
      '      platform: web',
      '      url: https://shop.example.test',
      '    phone:',
      '      platform: android',
      '      appPackage: com.example.shop',
      '',
    ].join('\n'),
    'utf-8',
  )
  await Promise.all([
    writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n', 'utf-8'),
    writeFile(join(dir, '.env'), '', 'utf-8'),
    writeFile(join(dir, '.env.secrets.local'), '', 'utf-8'),
  ])
  await mkdir(join(dir, 'tests'), { recursive: true })
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath,
  })
  const testFileManager = new TestFileManager(workspacePaths)
  const createSession = vi.fn(async () => ({ sessionId: 'live-1', sessionNumber: 3 }))
  const router = createRouter({
    db: { getRuns: () => [], close() {} } as any,
    configManager: new ConfigManager(configPath, (text) => text),
    configPath,
    workspacePaths,
    testFileManager,
    suiteFileManager: new SuiteFileManager(workspacePaths, testFileManager),
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-20250514',
      baseURL: 'https://anthropic-proxy.example/messages',
    } as any,
    sessionManager: {
      createSession,
      listSessions: vi.fn(() => []),
      terminateSession: vi.fn(),
    } as any,
  })
  return {
    dir,
    router,
    createSession,
    authStateDir: options.authStateDir ?? '.agent-qa/auth-states',
  }
}

async function saveState(
  ws: { dir: string; authStateDir: string },
  name: string,
  payload: unknown = {
    cookies: [{ name: 'sid', value: FIXTURE_COOKIE_VALUE, domain: 'shop.example.test', path: '/' }],
    origins: [],
  },
) {
  const paths = resolveAuthStatePaths({
    configDir: ws.dir,
    authStateDir: ws.authStateDir,
    targetName: 'shop',
    stateName: name,
    target: { platform: 'web' },
  })
  await writeAuthStateFiles(paths, {
    payload,
    metadata: {
      version: AUTH_STATE_SCHEMA_VERSION,
      kind: 'web',
      target: 'shop',
      name,
      capturedAt: CAPTURED_AT,
    },
  })
  return paths
}

function sessionConfig(createSession: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>
}

const webRequest = { platform: 'web', targetName: 'shop', url: 'https://shop.example.test' }

describe('live create door auth state', () => {
  it('a captured state is resolved for the target and handed to the session, and the reply holds ids only', async () => {
    const ws = await workspace()
    const paths = await saveState(ws, 'buyer')

    const res = await invoke(ws.router, { ...webRequest, authState: 'buyer' })

    expect(res.status).toBe(201)
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(['sessionId', 'sessionNumber'])
    expect(res.body).not.toContain(FIXTURE_COOKIE_VALUE)
    expect(res.body).not.toContain(paths.payloadPath)
    expect(sessionConfig(ws.createSession).authState).toEqual({
      name: 'buyer',
      load: true,
      resolved: {
        version: AUTH_STATE_SCHEMA_VERSION,
        kind: 'web',
        targetName: 'shop',
        stateName: 'buyer',
        capturedAt: CAPTURED_AT,
        storageStatePath: paths.payloadPath,
      },
    })
    const inTarget = relative(join(ws.dir, '.agent-qa', 'auth-states', 'shop'), paths.payloadPath)
    expect(inTarget.startsWith('..') || inTarget.includes(sep)).toBe(false)
  })

  it('a state under services.authState.dir is resolved from that folder', async () => {
    const ws = await workspace({ authStateDir: 'saved-sign-ins' })
    await saveState(ws, 'buyer')

    const res = await invoke(ws.router, { ...webRequest, authState: { name: 'buyer' } })

    expect(res.status).toBe(201)
    const authState = sessionConfig(ws.createSession).authState as { resolved: { storageStatePath: string } }
    expect(authState.resolved.storageStatePath).toBe(join(ws.dir, 'saved-sign-ins', 'shop', 'buyer.json'))
  })

  it('a name that was never captured opens the session signed out', async () => {
    const ws = await workspace()

    const res = await invoke(ws.router, { ...webRequest, authState: 'never-captured' })

    expect(res.status).toBe(201)
    expect(sessionConfig(ws.createSession).authState).toEqual({ name: 'never-captured', load: true })
  })

  it('a state whose payload cannot be read opens the session signed out', async () => {
    const ws = await workspace()
    const paths = await saveState(ws, 'buyer')
    await writeFile(paths.payloadPath, 'not json {', 'utf-8')

    const res = await invoke(ws.router, { ...webRequest, authState: 'buyer' })

    expect(res.status).toBe(201)
    expect(sessionConfig(ws.createSession).authState).toEqual({ name: 'buyer', load: true })
  })

  it('load false names the state and loads nothing, though it exists', async () => {
    const ws = await workspace()
    await saveState(ws, 'buyer')

    const res = await invoke(ws.router, { ...webRequest, authState: { name: 'buyer', load: false } })

    expect(res.status).toBe(201)
    expect(sessionConfig(ws.createSession).authState).toEqual({ name: 'buyer', load: false })
  })

  it('a request with no auth state hands the session none', async () => {
    const ws = await workspace()

    const res = await invoke(ws.router, webRequest)

    expect(res.status).toBe(201)
    expect('authState' in sessionConfig(ws.createSession)).toBe(false)
  })

  it('a mobile request that names a state to load is refused with the sentence a run gives', async () => {
    const ws = await workspace()

    const res = await invoke(ws.router, { platform: 'android', targetName: 'phone', authState: 'buyer' })

    expect(res.status).toBe(400)
    const { error } = JSON.parse(res.body) as { error: string }
    expect(error).toContain('auth state is only supported for web targets.')
    expect(error).toContain('use.mobile.appState: preserve')
    expect(ws.createSession).not.toHaveBeenCalled()
  })

  it('a mobile request whose state has load false mounts nothing and opens', async () => {
    const ws = await workspace()

    const res = await invoke(ws.router, {
      platform: 'android',
      targetName: 'phone',
      authState: { name: 'buyer', load: false },
    })

    expect(res.status).toBe(201)
    expect('authState' in sessionConfig(ws.createSession)).toBe(false)
  })

  it('a mobile request whose state is to be captured is refused, as a run refuses it', async () => {
    const ws = await workspace()

    const res = await invoke(ws.router, {
      platform: 'android',
      targetName: 'phone',
      authState: { name: 'buyer', load: false, capture: true },
    })

    expect(res.status).toBe(400)
    expect((JSON.parse(res.body) as { error: string }).error).toContain('auth state is only supported for web targets.')
    expect(ws.createSession).not.toHaveBeenCalled()
  })

  it.each([
    ['an uppercase name', 'Buyer'],
    ['a path', '../../etc/passwd'],
    ['an object with a key the schema refuses', { name: 'buyer', path: '/x' }],
    ['a number', 42],
  ])('%s is refused with 400 naming use.authState and no session', async (_label, authState) => {
    const ws = await workspace()

    const res = await invoke(ws.router, { ...webRequest, authState })

    expect(res.status).toBe(400)
    const { error } = JSON.parse(res.body) as { error: string }
    expect(error).toContain('use.authState')
    expect(ws.createSession).not.toHaveBeenCalled()
  })

  it('a target name that is not valid is refused with 400 and no session', async () => {
    const ws = await workspace()
    await saveState(ws, 'buyer')

    const res = await invoke(ws.router, { ...webRequest, targetName: '../x', authState: 'buyer' })

    expect(res.status).toBe(400)
    const { error } = JSON.parse(res.body) as { error: string }
    expect(error).toContain('"buyer"')
    expect(error).not.toContain(FIXTURE_COOKIE_VALUE)
    expect(ws.createSession).not.toHaveBeenCalled()
  })
})
