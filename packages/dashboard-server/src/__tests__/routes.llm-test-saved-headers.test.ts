import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import { createModel } from '@vostride/agent-qa-model'
import { generateText } from 'ai'

const { mockResolveLLMAuth } = vi.hoisted(() => ({ mockResolveLLMAuth: vi.fn() }))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    resolveLLMAuth: mockResolveLLMAuth,
    readAuth: vi.fn(() => Promise.resolve({})),
    writeAuth: vi.fn(() => Promise.resolve()),
    removeAuth: vi.fn(() => Promise.resolve()),
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

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
  addToolInputExamplesMiddleware: vi.fn(() => ({})),
  createProviderRegistry: vi.fn(),
  customProvider: vi.fn(),
  extractJsonMiddleware: vi.fn(() => ({})),
  parsePartialJson: vi.fn(),
}))

const mockCreateModel = vi.mocked(createModel)
const mockGenerateText = vi.mocked(generateText)

const LLM_TEST_HOST = '127.0.0.1:4317'
const LLM_TEST_HEADERS: IncomingHttpHeaders = { 'content-type': 'application/json', host: LLM_TEST_HOST }
const SAVED_HEADER_SECRET = 'sk-header-secret-1'
const SAVED_BASE_URL = 'https://proxy.example/v1'

const savedProxyConfig = [
  'workspace: {}',
  'services: {}',
  'registry:',
  '  llms:',
  '    - name: proxy',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  `      baseURL: ${SAVED_BASE_URL}`,
  '      providerHeaders:',
  `        X-Org: ${SAVED_HEADER_SECRET}`,
  '        X-Trace: t-1',
  'use:',
  '  llm: proxy',
  '',
].join('\n')

let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

async function invokeRoute(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket())
    req.method = options.method ?? 'GET'
    req.url = url
    req.headers = { host: '127.0.0.1:3470', ...options.headers }
    process.nextTick(() => {
      if (options.body) req.push(Buffer.from(options.body))
      req.push(null)
    })
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

async function createConfigWorkspace(initialConfig: string): Promise<{ configManager: ConfigManager; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-llm-test-headers-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, initialConfig, 'utf-8')
  return { configManager: new ConfigManager(configPath, (text) => text), configPath }
}

async function testConnection(body: Record<string, unknown>): Promise<MockResponse> {
  return await invokeRoute('/api/llm/test', {
    method: 'POST',
    headers: LLM_TEST_HEADERS,
    body: JSON.stringify(body),
  })
}

function sentHeaders(): Record<string, string> | undefined {
  expect(mockCreateModel).toHaveBeenCalledTimes(1)
  const profile = mockCreateModel.mock.calls[0]?.[0] as { headers?: Record<string, string> }
  return profile.headers
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockCreateModel.mockReturnValue({} as any)
  mockGenerateText.mockResolvedValue({ text: 'ok' } as any)
  mockResolveLLMAuth.mockResolvedValue({
    kind: 'unauthenticated',
    credentialKey: 'proxy',
    provider: 'anthropic-compatible',
    optional: true,
    message: 'Testing without a saved credential.',
  })
  const { configManager, configPath } = await createConfigWorkspace(savedProxyConfig)
  router = createRouter({ db: { getRuns: () => [], close() {} } as any, configManager, configPath })
})

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('POST /api/llm/test with a saved model\'s headers', () => {
  it('SAVED-HEADERS-SENT-BY-NAME: the saved model\'s headers are sent, and an unmasked body header overrides its namesake', async () => {
    const res = await testConnection({
      configName: 'proxy',
      provider: 'anthropic-compatible',
      model: 'claude-proxy',
      baseURL: SAVED_BASE_URL,
      providerHeaders: { 'X-Trace': 't-2' },
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true })
    expect(sentHeaders()).toEqual({ 'X-Org': SAVED_HEADER_SECRET, 'X-Trace': 't-2' })
    expect(res.body).not.toContain(SAVED_HEADER_SECRET)
  })

  it('SAVED-HEADERS-ONLY-TO-SAVED-ENDPOINT: a different baseURL or provider gets no saved header', async () => {
    const own = await testConnection({
      configName: 'proxy',
      provider: 'anthropic-compatible',
      model: 'claude-proxy',
      baseURL: SAVED_BASE_URL,
    })
    expect(own.status).toBe(200)
    expect(sentHeaders()?.['X-Org']).toBe(SAVED_HEADER_SECRET)

    mockCreateModel.mockClear()
    const elsewhere = await testConnection({
      configName: 'proxy',
      provider: 'anthropic-compatible',
      model: 'claude-proxy',
      baseURL: 'https://elsewhere.example/v1',
      providerHeaders: { 'X-Trace': 't-2' },
    })
    expect(elsewhere.status).toBe(200)
    expect(sentHeaders()).toEqual({ 'X-Trace': 't-2' })

    mockCreateModel.mockClear()
    const otherProvider = await testConnection({
      configName: 'proxy',
      provider: 'openai-compatible',
      model: 'claude-proxy',
      baseURL: SAVED_BASE_URL,
    })
    expect(otherProvider.status).toBe(200)
    expect(sentHeaders()).toBeUndefined()
    for (const answer of [elsewhere, otherProvider]) {
      expect(answer.body).not.toContain(SAVED_HEADER_SECRET)
    }
  })

  // The model row leaves out a header it showed as `[secret:<name>]`, so the saved value is sent.
  it('MASK-HEADER-NEVER-SENT: a header the row showed as a marker is left out, and the saved value is sent', async () => {
    const res = await testConnection({
      configName: 'proxy',
      provider: 'anthropic-compatible',
      model: 'claude-proxy',
      baseURL: SAVED_BASE_URL,
      providerHeaders: { 'X-Trace': 't-3' },
    })

    expect(res.status).toBe(200)
    const headers = sentHeaders()
    expect(headers).toEqual({ 'X-Org': SAVED_HEADER_SECRET, 'X-Trace': 't-3' })
    expect(JSON.stringify(headers)).not.toContain('[secret:')
    expect(res.body).not.toContain(SAVED_HEADER_SECRET)
  })

  it('SAVED-HEADER-NEVER-ECHOED: a provider error echoing a saved header value answers [redacted] in its place', async () => {
    mockGenerateText.mockRejectedValueOnce(Object.assign(
      new Error(`bad request: header X-Org=${SAVED_HEADER_SECRET} is not a known organisation`),
      { statusCode: 400 },
    ))

    const res = await testConnection({
      configName: 'proxy',
      provider: 'anthropic-compatible',
      model: 'claude-proxy',
      baseURL: SAVED_BASE_URL,
    })

    expect(res.status).toBe(200)
    const answer = JSON.parse(res.body) as { success: boolean; message?: string; details?: string }
    expect(answer.success).toBe(false)
    expect(answer.message ?? '').not.toContain(SAVED_HEADER_SECRET)
    expect(answer.details ?? '').not.toContain(SAVED_HEADER_SECRET)
    expect(res.body).not.toContain(SAVED_HEADER_SECRET)
    expect(res.body).toContain('[redacted]')
    expect(sentHeaders()).toEqual({ 'X-Org': SAVED_HEADER_SECRET, 'X-Trace': 't-1' })
  })
})
