// 429-09 (D-15/D-16): credentials and sign-ins for a model that is not on disk yet.
//
// auth.json is machine-wide, so every cell runs against an in-memory store behind core's
// readAuth/writeAuth/removeAuth and asserts what the store holds afterwards, not only what the
// route answered.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import {
  clearLLMAuthProviderPlugins,
  readAuth,
  registerLLMAuthProviderPlugin,
  removeAuth,
  writeAuth,
} from '@vostride/agent-qa-core'

const { authStore } = vi.hoisted(() => ({
  authStore: { current: {} as Record<string, unknown> },
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    readAuth: vi.fn(async () => structuredClone(authStore.current)),
    writeAuth: vi.fn(async (name: string, credential: unknown) => {
      authStore.current = { ...authStore.current, [name]: credential }
    }),
    removeAuth: vi.fn(async (name: string) => {
      const next = { ...authStore.current }
      delete next[name]
      authStore.current = next
    }),
  }
})

const mockReadAuth = vi.mocked(readAuth)
const mockWriteAuth = vi.mocked(writeAuth)
const mockRemoveAuth = vi.mocked(removeAuth)

const SELF_HOST = '127.0.0.1:4317'
const SAME_SITE: IncomingHttpHeaders = { 'content-type': 'application/json', host: SELF_HOST }

const draftConfig = [
  'workspace: {}',
  'services: {}',
  'registry:',
  '  llms:',
  '    - name: claude',
  '      provider: anthropic-subscription',
  '      model: claude-sonnet-4-20250514',
  '    - name: remote-openai',
  '      provider: openai-compatible',
  '      model: openrouter/auto',
  '      baseURL: https://openrouter.ai/api/v1',
  'use:',
  '  llm: claude',
  '',
].join('\n')

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []

function createMockRequest(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string },
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url
  req.headers = { host: '127.0.0.1:3470', ...options.headers }
  process.nextTick(() => {
    if (options.body) req.push(Buffer.from(options.body))
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
        for (const [key, value] of Object.entries(head ?? {})) headers.set(key.toLowerCase(), value)
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
        if (chunk) body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        resolve({ status, headers: Object.fromEntries(headers), body })
      },
    } as unknown as ServerResponse
    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

function post(url: string, body: unknown, headers: IncomingHttpHeaders = SAME_SITE): Promise<MockResponse> {
  return invokeRoute(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function useConfig(yaml: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-draft-credential-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, yaml, 'utf-8')
  router = createRouter({ db: { getRuns: () => [], close() {} } as any, configManager: new ConfigManager(configPath, (text) => text), configPath })
}

function registerFakeSubscriptionPlugins(): void {
  registerLLMAuthProviderPlugin({
    providerId: 'openai-subscription',
    credentialProviderId: 'openai-subscription-oauth',
    label: 'OpenAI subscription',
    modelAdapter: 'openai-responses',
    dashboardAuth: { mode: 'browser-poll', buttonLabel: 'Login with OpenAI subscription' },
    async startAuth() {
      return {
        authorizeUrl: 'https://auth.example/openai',
        waitForTokens: Promise.resolve({ access: 'openai-access', refresh: 'openai-refresh', expires: 1777675000000 }),
      }
    },
    createAuthFetch() {
      return globalThis.fetch
    },
  })
  registerLLMAuthProviderPlugin({
    providerId: 'anthropic-subscription',
    credentialProviderId: 'anthropic-subscription',
    label: 'Anthropic subscription',
    modelAdapter: 'anthropic-messages',
    dashboardAuth: { mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' },
    async startAuth() {
      return { authorizeUrl: 'https://auth.example/anthropic', sessionState: { verifier: 'v-1' } }
    },
    async exchangeCode(ctx) {
      return { access: `anthropic-${ctx.code}`, refresh: 'anthropic-refresh', expires: 1777675000000 }
    },
    createAuthFetch() {
      return globalThis.fetch
    },
  })
}

const OPENAI_OAUTH = {
  type: 'oauth',
  provider: 'openai-subscription-oauth',
  tokens: { access: 'draft-access', refresh: 'draft-refresh', expires: 1777675000000 },
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearLLMAuthProviderPlugins()
  authStore.current = {}
  await useConfig(draftConfig)
})

afterEach(async () => {
  clearLLMAuthProviderPlugins()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('draft credentials (429-09 Task 2)', () => {
  it('DRAFT-CREDENTIAL-ACCEPTED: a key for a name not in registry.llms is saved and reported created', async () => {
    const res = await post('/api/auth/credential', {
      configName: 'gpt-5.6',
      provider: 'openai-compatible',
      type: 'api-key',
      secret: 'sk-draft',
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true, created: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('gpt-5.6', { type: 'api', provider: 'openai-compatible', key: 'sk-draft' })
    expect(authStore.current['gpt-5.6']).toEqual({ type: 'api', provider: 'openai-compatible', key: 'sk-draft' })
  })

  it('DRAFT-SIGN-IN-ACCEPTED: a sign-in starts for a name not in registry.llms and lands under that name', async () => {
    registerFakeSubscriptionPlugins()

    const start = await post('/api/auth/plugin/anthropic-subscription/start', { configName: 'claude-draft' })
    expect(start.status).toBe(200)
    const started = JSON.parse(start.body) as { sessionId: string; created: boolean; mode: string }
    expect(started).toMatchObject({ created: true, mode: 'manual-code', authorizeUrl: 'https://auth.example/anthropic' })

    const exchange = await post('/api/auth/plugin/anthropic-subscription/exchange', {
      sessionId: started.sessionId,
      code: 'code-1',
    })
    expect(exchange.status).toBe(200)
    expect(authStore.current['claude-draft']).toMatchObject({
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: { access: 'anthropic-code-1' },
    })
  })

  it('CREDENTIAL-CREATED-FLAG: a save over a same-provider entry answers created false', async () => {
    registerFakeSubscriptionPlugins()
    authStore.current = {
      'gpt-5.6': { type: 'api', provider: 'openai-compatible', key: 'sk-old' },
      'codex-draft': OPENAI_OAUTH,
    }

    const save = await post('/api/auth/credential', {
      configName: 'gpt-5.6',
      provider: 'openai-compatible',
      type: 'api-key',
      secret: 'sk-new',
    })
    expect(save.status).toBe(200)
    expect(JSON.parse(save.body)).toEqual({ saved: true, created: false })
    expect(authStore.current['gpt-5.6']).toEqual({ type: 'api', provider: 'openai-compatible', key: 'sk-new' })

    const start = await post('/api/auth/plugin/openai-subscription/start', { configName: 'codex-draft' })
    expect(start.status).toBe(200)
    expect(JSON.parse(start.body)).toMatchObject({ created: false })
  })

  for (const name of ['__proto__', 'GPT-5', '-x']) {
    it(`NAME-INVALID-REFUSED: "${name}" is refused before auth.json is touched`, async () => {
      registerFakeSubscriptionPlugins()

      const save = await post('/api/auth/credential', {
        configName: name,
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-draft',
      })
      expect(save.status).toBe(400)
      expect(JSON.parse(save.body)).toMatchObject({ error: 'name_invalid' })

      const start = await post('/api/auth/plugin/openai-subscription/start', { configName: name })
      expect(start.status).toBe(400)
      expect(JSON.parse(start.body)).toMatchObject({ error: 'name_invalid' })

      expect(mockReadAuth).not.toHaveBeenCalled()
      expect(mockWriteAuth).not.toHaveBeenCalled()
      expect(authStore.current).toEqual({})
    })
  }

  it('NAME-INVALID-REFUSED: a dotted name is accepted', async () => {
    const save = await post('/api/auth/credential', {
      configName: 'gpt-5.6',
      provider: 'openai-compatible',
      type: 'api-key',
      secret: 'sk-draft',
    })
    expect(save.status).toBe(200)
    expect(mockWriteAuth).toHaveBeenCalledTimes(1)
  })

  it('CREDENTIAL-PROVIDER-CONFLICT-REFUSED: another provider\'s credential under the name is never overwritten', async () => {
    registerFakeSubscriptionPlugins()
    const shared = { type: 'bearer', provider: 'anthropic-compatible', token: 'bearer-shared' }
    authStore.current = { shared }

    const save = await post('/api/auth/credential', {
      configName: 'shared',
      provider: 'openai-compatible',
      type: 'api-key',
      secret: 'sk-other',
    })
    expect(save.status).toBe(409)
    expect(JSON.parse(save.body)).toMatchObject({ error: 'credential_provider_conflict' })

    const start = await post('/api/auth/plugin/openai-subscription/start', { configName: 'shared' })
    expect(start.status).toBe(409)
    expect(JSON.parse(start.body)).toMatchObject({ error: 'credential_provider_conflict' })

    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({ shared })
  })

  it('CREDENTIAL-PROVIDER-CONFLICT-REFUSED: an oauth entry compares by its product provider', async () => {
    registerFakeSubscriptionPlugins()
    authStore.current = { 'codex-draft': OPENAI_OAUTH }

    const other = await post('/api/auth/plugin/anthropic-subscription/start', { configName: 'codex-draft' })
    expect(other.status).toBe(409)
    expect(JSON.parse(other.body)).toMatchObject({ error: 'credential_provider_conflict' })

    const same = await post('/api/auth/plugin/openai-subscription/start', { configName: 'codex-draft' })
    expect(same.status).toBe(200)
  })

  it('CREDENTIAL-PROVIDER-CONFLICT-REFUSED: a name on disk keeps the provider-match refusal', async () => {
    const res = await post('/api/auth/credential', {
      configName: 'remote-openai',
      provider: 'anthropic-compatible',
      type: 'api-key',
      secret: 'sk-x',
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'LLM config "remote-openai" uses openai-compatible, not anthropic-compatible',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })
})

describe('moving a draft credential (429-09 Task 2)', () => {
  const MOVE = '/api/auth/credential/move'

  beforeEach(() => {
    registerFakeSubscriptionPlugins()
  })

  it('CREDENTIAL-MOVE: a draft sign-in follows the name to a free name', async () => {
    authStore.current = { 'draft-a': OPENAI_OAUTH, keep: { type: 'api', provider: 'gemini', key: 'g' } }

    const res = await post(MOVE, { from: 'draft-a', to: 'draft-b', provider: 'openai-subscription' })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ moved: true })
    expect(authStore.current).toEqual({ 'draft-b': OPENAI_OAUTH, keep: { type: 'api', provider: 'gemini', key: 'g' } })
  })

  it('CREDENTIAL-MOVE: a name in registry.llms on either side answers name_taken', async () => {
    authStore.current = { 'draft-a': OPENAI_OAUTH, claude: { type: 'oauth', provider: 'anthropic-subscription', tokens: {} } }

    const fromTaken = await post(MOVE, { from: 'claude', to: 'draft-b', provider: 'anthropic-subscription' })
    expect(fromTaken.status).toBe(409)
    expect(JSON.parse(fromTaken.body)).toMatchObject({ error: 'name_taken' })

    const toTaken = await post(MOVE, { from: 'draft-a', to: 'remote-openai', provider: 'openai-subscription' })
    expect(toTaken.status).toBe(409)
    expect(JSON.parse(toTaken.body)).toMatchObject({ error: 'name_taken' })

    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(mockRemoveAuth).not.toHaveBeenCalled()
  })

  it('CREDENTIAL-MOVE: a from with no credential answers credential_missing', async () => {
    const res = await post(MOVE, { from: 'draft-a', to: 'draft-b', provider: 'openai-subscription' })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'credential_missing' })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('CREDENTIAL-MOVE: a from that holds another provider\'s credential answers credential_provider_conflict', async () => {
    authStore.current = { 'draft-a': OPENAI_OAUTH }
    const res = await post(MOVE, { from: 'draft-a', to: 'draft-b', provider: 'anthropic-subscription' })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'credential_provider_conflict' })
    expect(authStore.current).toEqual({ 'draft-a': OPENAI_OAUTH })
  })

  it('CREDENTIAL-MOVE: a to that already holds a credential answers credential_exists', async () => {
    const existing = { type: 'api', provider: 'openai-compatible', key: 'sk-b' }
    authStore.current = { 'draft-a': OPENAI_OAUTH, 'draft-b': existing }
    const res = await post(MOVE, { from: 'draft-a', to: 'draft-b', provider: 'openai-subscription' })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'credential_exists' })
    expect(authStore.current).toEqual({ 'draft-a': OPENAI_OAUTH, 'draft-b': existing })
  })

  it('CREDENTIAL-MOVE: malformed bodies and invalid names are refused', async () => {
    authStore.current = { 'draft-a': OPENAI_OAUTH }

    const malformed = await post(MOVE, { from: 'draft-a', to: 'draft-b' })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(malformed.body)).toMatchObject({ error: 'invalid_setup_input' })

    const invalid = await post(MOVE, { from: 'draft-a', to: '__proto__', provider: 'openai-subscription' })
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body)).toMatchObject({ error: 'name_invalid' })

    expect(authStore.current).toEqual({ 'draft-a': OPENAI_OAUTH })
  })
})

// 429-09 Task 3: the five auth doors, driven the way 428-live-editor-doors.test.ts drives the
// live-editor doors, plus the rebound Host a DNS-rebinding page presents.
const FOREIGN_ORIGIN = 'http://evil.example'
const CROSS_SITE_CALLERS: readonly { readonly name: string; readonly headers: IncomingHttpHeaders }[] = [
  { name: 'a foreign Origin', headers: { 'content-type': 'application/json', host: SELF_HOST, origin: FOREIGN_ORIGIN } },
  { name: 'Sec-Fetch-Site cross-site with no Origin', headers: { 'content-type': 'application/json', host: SELF_HOST, 'sec-fetch-site': 'cross-site' } },
  { name: 'a rebound Host', headers: { 'content-type': 'application/json', host: 'evil.example:4317', origin: 'http://evil.example:4317' } },
]

interface AuthDoor {
  readonly name: string
  readonly method: 'POST' | 'DELETE'
  path(sessionId: string): string
  body(sessionId: string): unknown
}

const AUTH_DOORS: readonly AuthDoor[] = [
  {
    name: 'POST /api/auth/credential',
    method: 'POST',
    path: () => '/api/auth/credential',
    body: () => ({ configName: 'gpt-5.6', provider: 'openai-compatible', type: 'api-key', secret: 'sk-planted' }),
  },
  {
    name: 'POST /api/auth/credential/move',
    method: 'POST',
    path: () => '/api/auth/credential/move',
    body: () => ({ from: 'draft-a', to: 'draft-b', provider: 'openai-subscription' }),
  },
  {
    name: 'DELETE /api/auth/:configName',
    method: 'DELETE',
    path: () => '/api/auth/draft-a',
    body: () => undefined,
  },
  {
    name: 'POST /api/auth/plugin/:provider/start',
    method: 'POST',
    path: () => '/api/auth/plugin/anthropic-subscription/start',
    body: () => ({ configName: 'claude-draft' }),
  },
  {
    name: 'POST /api/auth/plugin/:provider/exchange',
    method: 'POST',
    path: () => '/api/auth/plugin/anthropic-subscription/exchange',
    body: (sessionId) => ({ sessionId, code: 'code-planted' }),
  },
]

async function callDoor(door: AuthDoor, sessionId: string, headers: IncomingHttpHeaders): Promise<MockResponse> {
  const body = door.body(sessionId)
  return invokeRoute(door.path(sessionId), {
    method: door.method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function startSameSiteSession(): Promise<string> {
  const start = await post('/api/auth/plugin/anthropic-subscription/start', { configName: 'claude-pending' })
  expect(start.status).toBe(200)
  return (JSON.parse(start.body) as { sessionId: string }).sessionId
}

describe('AUTH-DOORS-SAME-SITE (429-09 Task 3)', () => {
  beforeEach(() => {
    registerFakeSubscriptionPlugins()
    authStore.current = { 'draft-a': OPENAI_OAUTH }
  })

  for (const door of AUTH_DOORS) {
    for (const caller of CROSS_SITE_CALLERS) {
      it(`AUTH-DOORS-SAME-SITE: ${door.name} refuses ${caller.name}`, async () => {
        const sessionId = await startSameSiteSession()
        vi.clearAllMocks()

        const res = await callDoor(door, sessionId, caller.headers)

        expect(res.status).toBe(403)
        expect(JSON.parse(res.body)).toEqual({ error: 'cross_site_refused' })
        expect(res.headers['access-control-allow-origin']).toBeUndefined()
        expect(mockWriteAuth).not.toHaveBeenCalled()
        expect(mockRemoveAuth).not.toHaveBeenCalled()
        expect(authStore.current).toEqual({ 'draft-a': OPENAI_OAUTH })
      })
    }
  }

  it('AUTH-DOORS-SAME-SITE: an admitted caller is answered with no wildcard grant', async () => {
    const admitted: readonly IncomingHttpHeaders[] = [
      SAME_SITE,
      { ...SAME_SITE, origin: `http://${SELF_HOST}`, 'sec-fetch-site': 'same-origin' },
    ]
    for (const headers of admitted) {
      for (const door of AUTH_DOORS) {
        authStore.current = { 'draft-a': OPENAI_OAUTH }
        const sessionId = await startSameSiteSession()
        const res = await callDoor(door, sessionId, headers)
        expect(res.status, door.name).not.toBe(403)
        expect(res.status, door.name).toBeLessThan(300)
        expect(res.headers['access-control-allow-origin'], door.name).toBeUndefined()
      }
    }
  })

  it('AUTH-DOORS-SAME-SITE: refusals on the doors carry no wildcard grant either', async () => {
    const refused = await post('/api/auth/credential', { configName: '__proto__', provider: 'openai-compatible', type: 'api-key', secret: 'k' })
    expect(refused.status).toBe(400)
    expect(refused.headers['access-control-allow-origin']).toBeUndefined()

    const unknownPlugin = await post('/api/auth/plugin/not-a-plugin/start', { configName: 'x' })
    expect(unknownPlugin.status).toBe(404)
    expect(unknownPlugin.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('CREDENTIAL-WRITES-SERIALIZED (429-09 Task 3)', () => {
  it('CREDENTIAL-WRITES-SERIALIZED: two credential saves never interleave their auth.json writes', async () => {
    const events: string[] = []
    const slowWrite = async (name: string, credential: unknown) => {
      events.push(`start:${name}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      authStore.current = { ...authStore.current, [name]: credential }
      events.push(`end:${name}`)
    }
    mockWriteAuth.mockImplementationOnce(slowWrite as never).mockImplementationOnce(slowWrite as never)

    const [a, b] = await Promise.all([
      post('/api/auth/credential', { configName: 'model-a', provider: 'openai-compatible', type: 'api-key', secret: 'sk-a' }),
      post('/api/auth/credential', { configName: 'model-b', provider: 'openai-compatible', type: 'api-key', secret: 'sk-b' }),
    ])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(events).toHaveLength(4)
    const [first, second, third, fourth] = events
    expect(first?.startsWith('start:')).toBe(true)
    expect(second).toBe(first?.replace('start:', 'end:'))
    expect(third?.startsWith('start:')).toBe(true)
    expect(fourth).toBe(third?.replace('start:', 'end:'))
    expect(Object.keys(authStore.current).sort()).toEqual(['model-a', 'model-b'])
  })

  it('CREDENTIAL-WRITES-SERIALIZED: a delete waits for an in-flight save', async () => {
    const events: string[] = []
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    mockWriteAuth.mockImplementationOnce((async (name: string, credential: unknown) => {
      events.push(`write-start:${name}`)
      markWriteStarted()
      await writeGate
      authStore.current = { ...authStore.current, [name]: credential }
      events.push(`write-end:${name}`)
    }) as never)
    mockRemoveAuth.mockImplementationOnce((async (name: string) => {
      events.push(`remove:${name}`)
      const next = { ...authStore.current }
      delete next[name]
      authStore.current = next
    }) as never)

    const save = post('/api/auth/credential', { configName: 'model-a', provider: 'openai-compatible', type: 'api-key', secret: 'sk-a' })
    await writeStarted
    const removal = invokeRoute('/api/auth/model-a', { method: 'DELETE', headers: SAME_SITE })
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseWrite()
    await Promise.all([save, removal])

    expect(events).toEqual(['write-start:model-a', 'write-end:model-a', 'remove:model-a'])
    expect(authStore.current).toEqual({})
  })
})
