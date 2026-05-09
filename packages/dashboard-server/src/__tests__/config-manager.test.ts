import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  mockGetCredential,
  mockResolveLLMAuth,
  mockReadAuth,
  mockWriteAuth,
  mockRemoveAuth,
  mockCreateModel,
  mockGetProviderOptions,
  mockGenerateText,
} = vi.hoisted(() => ({
  mockGetCredential: vi.fn(),
  mockResolveLLMAuth: vi.fn(),
  mockReadAuth: vi.fn(),
  mockWriteAuth: vi.fn(),
  mockRemoveAuth: vi.fn(),
  mockCreateModel: vi.fn(),
  mockGetProviderOptions: vi.fn(),
  mockGenerateText: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  const { z } = await import('zod')
  const modelConfigBaseSchema = z.object({
    provider: z.enum([
      'openai-compatible',
      'anthropic-compatible',
      'openai-subscription',
      'anthropic-subscription',
      'gemini',
    ]),
    model: z.string(),
    baseURL: z.string().optional(),
    providerHeaders: z.record(z.string(), z.string()).optional(),
  }).strict()
  const validateModelConfig = (config: { provider?: string; baseURL?: string; providerHeaders?: Record<string, string> }, ctx: { addIssue: (issue: any) => void }) => {
    if (
      (config.provider === 'openai-compatible' || config.provider === 'anthropic-compatible')
      && (!config.baseURL || config.baseURL.trim() === '')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseURL'], message: `Base URL is required for ${config.provider} providers.` })
    }
    if (config.providerHeaders !== undefined && config.provider !== 'anthropic-compatible') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providerHeaders'], message: 'providerHeaders can only be used with anthropic-compatible providers.' })
    }
  }
  const ModelConfigSchema = modelConfigBaseSchema.superRefine(validateModelConfig)
  const NamedLLMConfigSchema = modelConfigBaseSchema.extend({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  }).strict().superRefine(validateModelConfig)
  return {
    ...actual,
    ModelConfigSchema,
    NamedLLMConfigSchema,
    getCredential: (...args: unknown[]) => mockGetCredential(...args),
    resolveLLMAuth: (...args: unknown[]) => mockResolveLLMAuth(...args),
    readAuth: (...args: unknown[]) => mockReadAuth(...args),
    writeAuth: (...args: unknown[]) => mockWriteAuth(...args),
    removeAuth: (...args: unknown[]) => mockRemoveAuth(...args),
    createModel: (...args: unknown[]) => mockCreateModel(...args),
    getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
  }
})

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}))

import { ConfigManager } from '../config/config-manager.js'
import { createRouter } from '../server/routes.js'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dir: string
let configPath: string
let manager: ConfigManager
let router: ReturnType<typeof createRouter>

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const SAMPLE_CONFIG = `# Test config
workspace:
  testMatch:
    - tests/**/*.yaml
  hooksFile: hooks.yaml

services:
  dashboard:
    port: 3470
  cache:
    dir: .cache
    ttl: 7d

registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: openrouter/auto
      baseURL: https://openrouter.ai/api/v1

use:
  healing:
    maxAttempts: 5
  llm: gpt-4
`

beforeEach(async () => {
  dir = join(tmpdir(), `config-manager-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, SAMPLE_CONFIG)
  manager = new ConfigManager(configPath)
  router = createRouter({
    db: {
      getRuns: vi.fn(() => []),
      close: vi.fn(),
    } as any,
    configManager: manager,
    configPath,
  })

  mockGetCredential.mockReset()
  mockResolveLLMAuth.mockReset()
  mockReadAuth.mockReset()
  mockWriteAuth.mockReset()
  mockRemoveAuth.mockReset()
  mockCreateModel.mockReset()
  mockGetProviderOptions.mockReset()
  mockGenerateText.mockReset()

  mockGetCredential.mockResolvedValue(null)
  mockResolveLLMAuth.mockResolvedValue({
    kind: 'unauthenticated',
    credentialKey: 'default',
    provider: 'openai-compatible',
    optional: true,
    message: 'Testing without a saved credential.',
  })
  mockReadAuth.mockResolvedValue({})
  mockWriteAuth.mockResolvedValue(undefined)
  mockRemoveAuth.mockResolvedValue(undefined)
  mockCreateModel.mockResolvedValue({ id: 'model' })
  mockGetProviderOptions.mockReturnValue(undefined)
  mockGenerateText.mockResolvedValue({ text: 'ok' })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

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

describe('ConfigManager', () => {
  describe('key ordering preservation', () => {
    it('replaceSection preserves key position in YAML', async () => {
      await manager.replaceSection('use.healing', { maxAttempts: 10 })
      const content = await readFile(configPath, 'utf-8')
      const healingIdx = content.indexOf('healing:')
      const llmIdx = content.indexOf('llm:')
      expect(healingIdx).toBeGreaterThan(-1)
      expect(llmIdx).toBeGreaterThan(-1)
      expect(healingIdx).toBeLessThan(llmIdx)
    })

    it('replaceSectionRaw preserves scalar key position', async () => {
      await manager.replaceSectionRaw('use.llm', 'claude-sonnet')
      const content = await readFile(configPath, 'utf-8')
      const healingIdx = content.indexOf('healing:')
      const llmIdx = content.indexOf('llm: claude-sonnet')
      expect(healingIdx).toBeLessThan(llmIdx)
      // llm should still be inside the use block, not at root
      expect(content).not.toMatch(/^use\.llm:/m)
      expect(content).toMatch(/^\s+llm: claude-sonnet/m)
    })

    it('replaceSection for services.cache keeps it before use block', async () => {
      await manager.replaceSection('services.cache', { dir: '.new-cache', ttl: '30d' })
      const content = await readFile(configPath, 'utf-8')
      const servicesIdx = content.indexOf('services:')
      const useIdx = content.indexOf('use:')
      expect(servicesIdx).toBeLessThan(useIdx)
    })

    it('replaceSection persists services.memory dir with the rest of the memory block', async () => {
      await manager.replaceSection('services.memory', {
        enabled: true,
        provider: 'local',
        curatorEnabled: true,
        dir: '.agent-qa/custom-memory',
      })

      const config = await manager.read()
      expect((config.services as any)?.memory).toMatchObject({
        enabled: true,
        provider: 'local',
        curatorEnabled: true,
        dir: '.agent-qa/custom-memory',
      })
    })

    it('replaceSectionRaw for array preserves position', async () => {
      await manager.replaceSectionRaw('workspace.testMatch', ['tests/web/**/*.yaml', 'tests/mobile/**/*.yaml'])
      const content = await readFile(configPath, 'utf-8')
      const workspaceIdx = content.indexOf('workspace:')
      const servicesIdx = content.indexOf('services:')
      const testMatchIdx = content.indexOf('testMatch:')
      expect(testMatchIdx).toBeGreaterThan(workspaceIdx)
      expect(testMatchIdx).toBeLessThan(servicesIdx)
    })
  })

  describe('dotted path handling', () => {
    it('replaceSection splits dotted path into nested keys', async () => {
      await manager.replaceSection('services.dashboard', { port: 4000 })
      const config = await manager.read()
      expect((config.services as any).dashboard.port).toBe(4000)
    })

    it('replaceSectionRaw writes nested scalar via dotted path', async () => {
      await manager.replaceSectionRaw('use.llm', 'new-model')
      const config = await manager.read()
      expect((config.use as any).llm).toBe('new-model')
      // must not create a literal "use.llm" top-level key
      expect(Object.keys(config)).not.toContain('use.llm')
    })

    it('deleteSectionRaw removes a dotted path without deleting nested browser settings', async () => {
      await writeFile(configPath, [
        'use:',
        '  headless: true',
        '  browser:',
        '    name: chromium',
        '    headless: false',
        '    viewport:',
        '      width: 1280',
        '      height: 720',
        '',
      ].join('\n'))

      await manager.deleteSectionRaw('use.headless')

      const config = await manager.read()
      expect((config.use as any).headless).toBeUndefined()
      expect((config.use as any).browser).toMatchObject({
        name: 'chromium',
        headless: false,
        viewport: {
          width: 1280,
          height: 720,
        },
      })
    })
  })

  describe('comments preservation', () => {
    it('preserves YAML comments after updates', async () => {
      await manager.replaceSectionRaw('use.llm', 'claude')
      const content = await readFile(configPath, 'utf-8')
      expect(content).toContain('# Test config')
    })
  })
})

describe('dashboard compatible auth routes', () => {
  it('stores openai-compatible API keys under the named LLM config key', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        configName: 'planner',
        type: 'api-key',
        secret: 'sk-router',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('planner', {
      type: 'api',
      provider: 'openai-compatible',
      key: 'sk-router',
    })
  })

  it('rejects openai-compatible API key saves without configName', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-router',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'configName is required',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('tests compatible configs by reading only the named config credential key', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        configName: 'planner',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      unauthenticated: true,
      message: 'Testing without a saved credential.',
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledTimes(1)
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', expect.objectContaining({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    }))
    expect(mockCreateModel).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })
  })

  it('does not fall back to the provider key when compatible configName is absent', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: '',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      unauthenticated: true,
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('', expect.objectContaining({
      provider: 'openai-compatible',
    }))
    expect(mockCreateModel).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })
  })

  it('keeps the no-key compatible indicator when the provider rejects auth', async () => {
    const providerError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockGenerateText.mockRejectedValue(providerError)

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        configName: 'planner',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'auth_error',
      message: 'Authentication failed. Check the saved credential for this config.',
      unauthenticated: true,
      authMessage: 'Testing without a saved credential.',
    })
  })

  it('keeps first-party missing-key behavior unchanged', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'gemini-fast',
      provider: 'gemini',
      required: true,
      message: 'Save a Gemini API key for this config before testing.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'gemini',
        configName: 'gemini-fast',
        model: 'gemini-2.5-flash',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'missing_credential',
      message: 'Save a Gemini API key for this config before testing.',
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('gemini-fast', expect.objectContaining({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    }))
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('does not use subscription auth fetch for compatible providers', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        configName: 'planner',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      unauthenticated: true,
    })
    expect(mockCreateModel).toHaveBeenCalledWith({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    })
  })
})
