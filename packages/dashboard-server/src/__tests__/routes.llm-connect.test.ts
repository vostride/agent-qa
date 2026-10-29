// A draft model is tested before anything is written; only a pass or `skipTest` lands it.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { ConfigManager } from '../config/index.js'
import { authFromFetch, authFromRuntimeConfig, toModelProfileAndAuth } from '../llm-model-mapping.js'
import { createRouter } from '../server/routes.js'
import {
  clearLLMAuthProviderPlugins,
  readAuth,
  registerLLMAuthProviderPlugin,
  removeAuth,
  resolveLLMAuth,
  writeAuth,
} from '@vostride/agent-qa-core'
import { generateText } from 'ai'

const { authStore, signInFetch } = vi.hoisted(() => ({
  authStore: { current: {} as Record<string, unknown> },
  signInFetch: (async () => new Response('{}')) as typeof globalThis.fetch,
}))

// Core's resolver reads the real auth.json through its own internal binding, so the cells swap it
// for one with the same arms over the in-memory store.
async function resolveFromStore(name: string, config: { provider: string }): Promise<unknown> {
  const entry = authStore.current[name] as
    | { type: 'api'; provider: string; key: string }
    | { type: 'bearer'; provider: string; token: string }
    | { type: 'oauth'; provider: string }
    | undefined
  const compatible = config.provider === 'openai-compatible' || config.provider === 'anthropic-compatible'
  if (!entry) {
    return compatible
      ? { kind: 'unauthenticated', credentialKey: name, provider: config.provider, optional: true, message: 'Testing without a saved credential.' }
      : { kind: 'missing', credentialKey: name, provider: config.provider, required: true, message: 'Save a credential for this config before testing.' }
  }
  if (entry.type === 'api') return { kind: 'api-key', credentialKey: name, provider: config.provider, apiKey: entry.key }
  if (entry.type === 'bearer') return { kind: 'bearer-token', credentialKey: name, provider: config.provider, token: entry.token }
  return { kind: 'auth-fetch', credentialKey: name, provider: config.provider, modelAdapter: 'anthropic-messages', fetch: signInFetch }
}

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    getAgentQaVersion: vi.fn(() => '0.1.13'),
    resolveLLMAuth: vi.fn(resolveFromStore),
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

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: vi.fn(() => ({})),
    getProviderOptions: vi.fn(() => undefined),
  }
})

vi.mock('../llm-model-mapping.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm-model-mapping.js')>()
  return {
    ...actual,
    authFromRuntimeConfig: vi.fn(actual.authFromRuntimeConfig),
    authFromFetch: vi.fn(actual.authFromFetch),
    toModelProfileAndAuth: vi.fn(actual.toModelProfileAndAuth),
  }
})

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
  addToolInputExamplesMiddleware: vi.fn(() => ({})),
  createProviderRegistry: vi.fn(),
  customProvider: vi.fn(),
  extractJsonMiddleware: vi.fn(() => ({})),
  parsePartialJson: vi.fn(),
}))

const mockReadAuth = vi.mocked(readAuth)
const mockWriteAuth = vi.mocked(writeAuth)
const mockRemoveAuth = vi.mocked(removeAuth)
const mockGenerateText = vi.mocked(generateText)
const mockAuthFromRuntimeConfig = vi.mocked(authFromRuntimeConfig)
const mockToModelProfileAndAuth = vi.mocked(toModelProfileAndAuth)
const mockAuthFromFetch = vi.mocked(authFromFetch)
const mockResolveLLMAuth = vi.mocked(resolveLLMAuth)

const SELF_HOST = '127.0.0.1:4317'
const SAME_SITE: IncomingHttpHeaders = { 'content-type': 'application/json', host: SELF_HOST }
const SECRET = 'sk-connect-secret-429-10'
const CONNECT = '/api/llm/connect'

const WORKSPACE = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'services: {}',
]

const USE_TAIL = [
  '  timeout:',
  '    step: 30s',
  '    test: 10m',
  '    navigation: 10s',
  '  mobile:',
  '    appState: preserve',
]

// A project with no model at all: the first connect becomes the default.
const NO_MODEL_CONFIG = [...WORKSPACE, 'registry: {}', 'use:', ...USE_TAIL, ''].join('\n')

// A project whose default names a model that is on disk.
const WITH_DEFAULT_CONFIG = [
  ...WORKSPACE,
  'registry:',
  '  llms:',
  '    - name: existing',
  '      provider: openai-compatible',
  '      model: gpt-4o',
  '      baseURL: https://api.existing.test/v1',
  'use:',
  '  llm: existing',
  ...USE_TAIL,
  '',
].join('\n')

// Parses as YAML but fails whole-config validation, so applyChanges refuses whatever is appended.
const INVALID_SCHEMA_CONFIG = [...WORKSPACE, 'registry: {}', 'use:', ...USE_TAIL, 'bogusTopLevel: 1', ''].join('\n')

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let router: ReturnType<typeof createRouter>
let configPath = ''
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
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode: number, head?: Record<string, string | number>) {
        status = statusCode
        for (const [key, value] of Object.entries(head ?? {})) headers.set(key.toLowerCase(), String(value))
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
      destroy() {
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

function connect(body: unknown, headers: IncomingHttpHeaders = SAME_SITE): Promise<MockResponse> {
  return invokeRoute(CONNECT, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function useConfig(yaml: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-llm-connect-'))
  tempDirs.push(dir)
  configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, yaml, 'utf-8')
  router = createRouter({ db: { getRuns: () => [], close() {} } as any, configManager: new ConfigManager(configPath, (text) => text), configPath })
}

async function fileText(): Promise<string> {
  return readFile(configPath, 'utf-8')
}

async function fileConfig(): Promise<{ registry?: { llms?: Array<Record<string, unknown>> }; use?: { llm?: string } }> {
  return parseYaml(await fileText()) as { registry?: { llms?: Array<Record<string, unknown>> }; use?: { llm?: string } }
}

const keyDraft = (overrides: Record<string, unknown> = {}) => ({
  name: 'gpt-5.6',
  provider: 'openai-compatible',
  model: 'gpt-5.6',
  baseURL: 'https://api.example.test/v1',
  credential: { type: 'api-key', secret: SECRET },
  ...overrides,
})

beforeEach(async () => {
  vi.clearAllMocks()
  authStore.current = {}
  mockGenerateText.mockImplementation(() => Promise.resolve({ text: 'ok' }) as never)
  await useConfig(NO_MODEL_CONFIG)
})

afterEach(async () => {
  clearLLMAuthProviderPlugins()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('POST /api/llm/connect, key mode', () => {
  it('CONNECT-NOTHING-WRITTEN-ON-FAIL: a failed test answers the shared sentence and writes nothing', async () => {
    const before = await fileText()
    mockGenerateText.mockRejectedValueOnce(new Error('401 unauthorized'))

    const res = await connect(keyDraft())

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      success: false,
      errorClass: 'auth_error',
      message: 'Authentication failed. Check the saved credential for this config.',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({})
    expect(await fileText()).toBe(before)
  })

  it('CONNECT-REACHES-AUTH-FROM-RUNTIME-CONFIG: the typed key becomes the model auth through authFromRuntimeConfig', async () => {
    const res = await connect(keyDraft())

    expect(res.status).toBe(200)
    expect(mockAuthFromRuntimeConfig).toHaveBeenCalledWith({ apiKey: SECRET })
    const produced = mockAuthFromRuntimeConfig.mock.results[0]?.value
    expect(produced).toEqual({ kind: 'api-key', apiKey: SECRET })
    expect(mockToModelProfileAndAuth).toHaveBeenCalledTimes(1)
    expect(mockToModelProfileAndAuth.mock.calls[0]?.[1]).toBe(produced)
  })

  it('CONNECT-PASS-SAVES: a pass writes the credential, then the definition and the default in one write', async () => {
    const order: string[] = []
    mockWriteAuth.mockImplementationOnce(async (name: string, credential: unknown) => {
      order.push(`auth:${(await fileConfig()).registry?.llms?.length ?? 0}`)
      authStore.current = { ...authStore.current, [name]: credential }
    })

    const res = await connect(keyDraft())

    expect(res.status).toBe(200)
    const answer = JSON.parse(res.body)
    const text = await fileText()
    expect(answer).toEqual({
      success: true,
      saved: true,
      becameDefault: true,
      usedCredential: true,
      revision: createHash('sha256').update(text, 'utf-8').digest('hex'),
    })
    expect(order).toEqual(['auth:0'])
    expect(mockWriteAuth).toHaveBeenCalledWith('gpt-5.6', { type: 'api', provider: 'openai-compatible', key: SECRET })
    const config = await fileConfig()
    expect(config.registry?.llms).toEqual([
      { name: 'gpt-5.6', provider: 'openai-compatible', model: 'gpt-5.6', baseURL: 'https://api.example.test/v1' },
    ])
    expect(config.use?.llm).toBe('gpt-5.6')
    expect(text).not.toContain(SECRET)
  })

  it('CONNECT-KEEPS-EXISTING-DEFAULT: with a valid default already set, the new model does not take it', async () => {
    await useConfig(WITH_DEFAULT_CONFIG)

    const res = await connect(keyDraft())

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, becameDefault: false, usedCredential: true })
    const config = await fileConfig()
    expect(config.use?.llm).toBe('existing')
    expect(config.registry?.llms?.map((llm) => llm.name)).toEqual(['existing', 'gpt-5.6'])
  })

  it('CONNECT-SKIP-TEST-SAVES: skipTest never calls the provider and writes the credential and definition', async () => {
    mockGenerateText.mockRejectedValue(new Error('401 unauthorized'))

    const res = await connect(keyDraft({ skipTest: true }))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, becameDefault: true, usedCredential: true })
    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(authStore.current['gpt-5.6']).toEqual({ type: 'api', provider: 'openai-compatible', key: SECRET })
    expect((await fileConfig()).registry?.llms?.map((llm) => llm.name)).toEqual(['gpt-5.6'])
  })

  it('CONNECT-WRITE-FAILURE-ROLLS-BACK-CREDENTIAL: a refused config write removes a credential this request created', async () => {
    await useConfig(INVALID_SCHEMA_CONFIG)
    const before = await fileText()

    const res = await connect(keyDraft())

    expect(res.status).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'validation_failed' })
    expect(mockWriteAuth).toHaveBeenCalledTimes(1)
    expect(mockRemoveAuth).toHaveBeenCalledWith('gpt-5.6')
    expect(authStore.current).toEqual({})
    expect(await fileText()).toBe(before)
  })

  it('CONNECT-WRITE-FAILURE-ROLLS-BACK-CREDENTIAL: a credential that existed before is never removed', async () => {
    await useConfig(INVALID_SCHEMA_CONFIG)
    const saved = { type: 'api', provider: 'openai-compatible', key: 'sk-saved-before' }
    authStore.current = { 'gpt-5.6': saved }

    const res = await connect(keyDraft())

    expect(res.status).toBe(422)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'validation_failed' })
    expect(mockRemoveAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({ 'gpt-5.6': saved })
  })
})

const FOREIGN_ORIGIN = 'http://evil.example'
const CROSS_SITE_CALLERS: readonly { readonly name: string; readonly headers: IncomingHttpHeaders }[] = [
  { name: 'a foreign Origin', headers: { ...SAME_SITE, origin: FOREIGN_ORIGIN } },
  { name: 'Sec-Fetch-Site cross-site with no Origin', headers: { ...SAME_SITE, 'sec-fetch-site': 'cross-site' } },
  { name: 'a rebound Host', headers: { 'content-type': 'application/json', host: 'evil.example:4317', origin: 'http://evil.example:4317' } },
]

describe('the connect door', () => {
  for (const caller of CROSS_SITE_CALLERS) {
    it(`CONNECT-SAME-SITE: ${caller.name} is refused with 403 and no cross-origin grant`, async () => {
      const before = await fileText()

      const res = await connect(keyDraft(), caller.headers)

      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'cross_site_refused' })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(mockReadAuth).not.toHaveBeenCalled()
      expect(mockGenerateText).not.toHaveBeenCalled()
      expect(mockWriteAuth).not.toHaveBeenCalled()
      expect(await fileText()).toBe(before)
    })
  }

  it('CONNECT-SAME-SITE: an admitted answer carries no cross-origin grant', async () => {
    const res = await connect(keyDraft())
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('CONNECT-NO-SECRET-IN-ANSWER: no answer and no console line ever holds the typed secret', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined))
    try {
      const bodies: string[] = []
      mockGenerateText.mockRejectedValueOnce(new Error(`Upstream echoed ${SECRET} back`))
      bodies.push((await connect(keyDraft())).body)
      mockGenerateText.mockRejectedValueOnce(new Error('401 unauthorized'))
      bodies.push((await connect(keyDraft())).body)
      bodies.push((await connect(keyDraft({ name: 'Bad Name' }))).body)
      bodies.push((await connect(keyDraft({ provider: 'openai-subscription' }))).body)
      bodies.push((await connect(keyDraft())).body)
      bodies.push((await connect(keyDraft())).body)

      expect(bodies).toHaveLength(6)
      expect(JSON.parse(bodies[0]!)).toMatchObject({ success: false, errorClass: 'provider_error' })
      expect(JSON.parse(bodies[4]!)).toMatchObject({ success: true })
      for (const body of bodies) expect(body).not.toContain(SECRET)
      for (const spy of spies) {
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET)
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

function registerFakeClaudeSignIn(): void {
  registerLLMAuthProviderPlugin({
    providerId: 'anthropic-subscription',
    credentialProviderId: 'anthropic-subscription',
    label: 'Anthropic subscription',
    modelAdapter: 'anthropic-messages',
    dashboardAuth: { mode: 'manual-code', buttonLabel: 'Login with Anthropic subscription' },
    async startAuth() {
      return { authorizeUrl: 'https://auth.example/anthropic', sessionState: { verifier: 'v-1' } }
    },
    async exchangeCode() {
      return { access: 'anthropic-access', refresh: 'anthropic-refresh', expires: 1777675000000 }
    },
    createAuthFetch() {
      return signInFetch
    },
  })
}

describe('POST /api/llm/connect, saved credentials and sign-in', () => {
  it('CONNECT-EXISTING-CREDENTIAL: a same-provider key saved under the name is tested and nothing is written to auth.json', async () => {
    const saved = { type: 'api', provider: 'openai-compatible', key: 'sk-saved-elsewhere' }
    authStore.current = { 'gpt-5.6': saved }

    const res = await connect(keyDraft({ credential: undefined }))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, usedCredential: true })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('gpt-5.6', expect.objectContaining({ provider: 'openai-compatible', model: 'gpt-5.6' }))
    expect(mockToModelProfileAndAuth.mock.calls[0]?.[1]).toEqual({ kind: 'api-key', apiKey: 'sk-saved-elsewhere' })
    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({ 'gpt-5.6': saved })
    expect((await fileConfig()).registry?.llms?.map((llm) => llm.name)).toEqual(['gpt-5.6'])
  })

  it('CONNECT-SIGN-IN-MODE: a completed sign-in under the draft name composes auth as the live session does', async () => {
    registerFakeClaudeSignIn()
    const tokens = { type: 'oauth', provider: 'anthropic-subscription', tokens: { access: 'a', refresh: 'r', expires: 1777675000000 } }
    authStore.current = { 'claude-draft': tokens }

    const res = await connect({ name: 'claude-draft', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, becameDefault: true, usedCredential: true })
    expect(mockAuthFromFetch).toHaveBeenCalledWith('anthropic-subscription', signInFetch)
    const produced = mockAuthFromFetch.mock.results[0]?.value
    expect(mockAuthFromRuntimeConfig).toHaveBeenCalledWith({}, produced)
    expect(mockToModelProfileAndAuth.mock.calls[0]?.[1]).toMatchObject({ kind: 'auth-fetch', modelAdapter: 'anthropic-messages', fetch: signInFetch })
    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({ 'claude-draft': tokens })
    const config = await fileConfig()
    expect(config.registry?.llms).toEqual([{ name: 'claude-draft', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' }])
    expect(config.use?.llm).toBe('claude-draft')
  })

  it('CONNECT-CREDENTIAL-OPTIONAL: a credential-optional endpoint with no key typed or saved is tested without auth', async () => {
    const res = await connect(keyDraft({ credential: undefined, baseURL: 'http://127.0.0.1:1234/v1' }))

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, usedCredential: false })
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(mockToModelProfileAndAuth.mock.calls[0]?.[1]).toEqual({ kind: 'none' })
    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({})
    expect((await fileConfig()).registry?.llms?.map((llm) => llm.name)).toEqual(['gpt-5.6'])
  })
})

interface RefusalCase {
  readonly word: string
  readonly status: number
  readonly config?: string
  readonly store?: Record<string, unknown>
  readonly body: unknown
}

const REFUSAL_CASES: readonly RefusalCase[] = [
  { word: 'invalid_setup_input', status: 400, body: { name: 'gpt-5.6', provider: 'openai-compatible' } },
  { word: 'invalid_setup_input', status: 400, body: { ...keyDraft(), apiKey: SECRET } },
  { word: 'invalid_setup_input', status: 400, body: keyDraft({ baseURL: undefined }) },
  { word: 'name_invalid', status: 400, body: keyDraft({ name: '__proto__' }) },
  { word: 'name_invalid', status: 400, body: keyDraft({ name: 'GPT-5' }) },
  { word: 'name_taken', status: 409, config: WITH_DEFAULT_CONFIG, body: keyDraft({ name: 'existing' }) },
  {
    word: 'credential_provider_conflict',
    status: 409,
    store: { 'gpt-5.6': { type: 'api', provider: 'gemini', key: 'gemini-key' } },
    body: keyDraft(),
  },
  {
    word: 'credential_not_accepted',
    status: 400,
    body: { name: 'claude-draft', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6', credential: { type: 'api-key', secret: SECRET } },
  },
  { word: 'credential_not_accepted', status: 400, body: keyDraft({ credential: { type: 'bearer-token', secret: SECRET } }) },
  { word: 'credential_missing', status: 400, body: { name: 'gemini-draft', provider: 'gemini', model: 'gemini-2.5-pro' } },
]

describe('CONNECT-REFUSALS', () => {
  for (const refusal of REFUSAL_CASES) {
    it(`CONNECT-REFUSALS: ${refusal.word} (${JSON.stringify(refusal.body).slice(0, 80)}) writes nothing`, async () => {
      if (refusal.config) await useConfig(refusal.config)
      if (refusal.store) authStore.current = structuredClone(refusal.store)
      const storeBefore = structuredClone(authStore.current)
      const before = await fileText()

      const res = await connect(refusal.body)

      expect(res.status).toBe(refusal.status)
      expect(JSON.parse(res.body)).toMatchObject({ error: refusal.word })
      expect(res.body).not.toContain(SECRET)
      expect(mockGenerateText).not.toHaveBeenCalled()
      expect(mockWriteAuth).not.toHaveBeenCalled()
      expect(mockRemoveAuth).not.toHaveBeenCalled()
      expect(authStore.current).toEqual(storeBefore)
      expect(await fileText()).toBe(before)
    })
  }
})

describe('repeats, races and the one name', () => {
  it('CONNECT-TWICE-NO-DUPLICATE: a second connect for a name that just saved answers name_taken', async () => {
    const first = await connect(keyDraft())
    expect(JSON.parse(first.body)).toMatchObject({ success: true })
    const afterFirst = await fileText()

    const second = await connect(keyDraft())

    expect(second.status).toBe(409)
    expect(JSON.parse(second.body)).toMatchObject({ error: 'name_taken' })
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect(mockWriteAuth).toHaveBeenCalledTimes(1)
    expect(await fileText()).toBe(afterFirst)
    expect((await fileConfig()).registry?.llms?.filter((llm) => llm.name === 'gpt-5.6')).toHaveLength(1)
  })

  it('CONNECT-CONCURRENT-ONE-WINS: two connects for one name started together save exactly one model', async () => {
    mockGenerateText.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { text: 'ok' } as never
    })

    const answers = await Promise.all([connect(keyDraft()), connect(keyDraft())])

    const bodies = answers.map((answer) => JSON.parse(answer.body) as Record<string, unknown>)
    expect(bodies.filter((body) => body.success === true)).toHaveLength(1)
    const refused = answers.filter((answer) => answer.status === 409)
    expect(refused).toHaveLength(1)
    expect(JSON.parse(refused[0]!.body)).toEqual({ error: 'name_taken' })
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    expect((await fileConfig()).registry?.llms?.filter((llm) => llm.name === 'gpt-5.6')).toHaveLength(1)
  })

  it('CONNECT-CONCURRENT-ONE-WINS: the name is free again once a connect in flight has answered', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('401 unauthorized'))
    const failed = await connect(keyDraft())
    expect(JSON.parse(failed.body)).toMatchObject({ success: false })

    const retried = await connect(keyDraft())
    expect(JSON.parse(retried.body)).toMatchObject({ success: true })
  })

  for (const name of ['gpt-5.6', 'team.models.claude-4.6']) {
    it(`CONNECT-ROUND-TRIP-NAME: "${name}" is the auth.json key, the registry.llms name and use.llm`, async () => {
      const res = await connect(keyDraft({ name }))

      expect(JSON.parse(res.body)).toMatchObject({ success: true, becameDefault: true })
      expect(mockWriteAuth).toHaveBeenCalledTimes(1)
      const authKey = mockWriteAuth.mock.calls[0]?.[0]
      const config = await fileConfig()
      expect(Object.keys(authStore.current)).toEqual([name])
      expect(authKey).toBe(name)
      expect(config.registry?.llms?.map((llm) => llm.name)).toEqual([name])
      expect(config.use?.llm).toBe(name)
    })
  }
})
