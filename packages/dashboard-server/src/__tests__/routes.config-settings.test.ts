import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import {
  clearLLMAuthProviderPlugins,
  createModel,
  readAuth,
  registerLLMAuthProviderPlugin,
  removeAuth,
  writeAuth,
} from '@vostride/agent-qa-core'
import { generateText } from 'ai'

const { mockGetAgentQaUpdateStatus, mockResolveLLMAuth } = vi.hoisted(() => ({
  mockGetAgentQaUpdateStatus: vi.fn(),
  mockResolveLLMAuth: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  const { z } = await import('zod')
  const providerHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
    const seen = new Set<string>()
    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const key = rawKey.trim()
      const value = rawValue.trim()
      const normalizedKey = key.toLowerCase()
      if (!key) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider header keys cannot be empty.' })
      }
      if (seen.has(normalizedKey)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate provider header "${key}" is not allowed.` })
      }
      seen.add(normalizedKey)
      if (/[\x00-\x1F\x7F]/.test(key) || /[\x00-\x1F\x7F]/.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Provider header "${key}" cannot contain control characters.` })
      }
      const sensitive = ['authorization', 'cookie', 'x-api-key', 'api-key', 'token', 'secret']
        .find((term) => normalizedKey.includes(term))
      if (sensitive) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Provider header "${key}" cannot contain auth-like term "${sensitive}".` })
      }
    }
  })
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
    providerHeaders: providerHeadersSchema.optional(),
    screenshotSize: z.union([z.string(), z.number()]).optional(),
    effectiveResolution: z.number().positive().int().optional(),
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
    contextWindow: z.union([z.string(), z.number()]).optional(),
  }).strict().superRefine(validateModelConfig)
  const WorkspaceSchema = z.object({
    testMatch: z.array(z.string().min(1)).min(1),
    suiteMatch: z.array(z.string().min(1)).min(1),
    testPathIgnore: z.array(z.string()).optional(),
    hooksFile: z.string().min(1, 'hooksFile is required.'),
    agentRules: z.string().min(1, 'agentRules is required.'),
    envFile: z.string().min(1, 'envFile is required.'),
    secretsFile: z.string().min(1, 'secretsFile is required.'),
  }).strict()
  const DashboardConfigSchema = z.object({
    port: z.number().optional(),
    dbPath: z.string().optional(),
    artifactsDir: z.string().optional(),
  }).strict()
  return {
    ...actual,
    ModelConfigSchema,
    NamedLLMConfigSchema,
    WorkspaceSchema,
    DashboardConfigSchema,
    createModel: vi.fn(() => ({})),
    getAgentQaVersion: vi.fn(() => '0.1.13'),
    getAgentQaUpdateStatus: mockGetAgentQaUpdateStatus,
    getProviderOptions: vi.fn(() => undefined),
    resolveLLMAuth: mockResolveLLMAuth,
    readAuth: vi.fn(() => ({})),
    writeAuth: vi.fn(() => Promise.resolve()),
    removeAuth: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

const mockCreateModel = vi.mocked(createModel)
const mockReadAuth = vi.mocked(readAuth)
const mockWriteAuth = vi.mocked(writeAuth)
const mockRemoveAuth = vi.mocked(removeAuth)
const mockGenerateText = vi.mocked(generateText)

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []

function createMockDatabase() {
  return {
    getRuns() {
      return []
    },
    close() {},
  }
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

async function createConfigWorkspace(initialConfig = ''): Promise<{
  configManager: ConfigManager
  configPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-config-settings-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(
    configPath,
    initialConfig || [
      'workspace: {}',
      'services: {}',
      'registry: {}',
      'use: {}',
      '',
    ].join('\n'),
    'utf-8',
  )
  return {
    configManager: new ConfigManager(configPath),
    configPath,
  }
}

async function useConfigWorkspace(initialConfig: string): Promise<void> {
  const { configManager, configPath } = await createConfigWorkspace(initialConfig)
  router = createRouter({
    db: createMockDatabase() as any,
    configManager,
    configPath,
  })
}

function buildResolvedWorkspacePaths(configPath: string) {
  const configDir = dirname(configPath)
  const file = (workspaceRelativePath: string) => ({
    configuredPath: workspaceRelativePath,
    absolutePath: join(configDir, workspaceRelativePath),
    workspaceRelativePath,
  })
  return {
    configPath,
    configDir,
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['suites/**/*.suite.yaml'],
    testPathIgnore: [],
    hooksFile: file('hooks.yaml'),
    agentRules: file('agent-rules.md'),
    envFile: file('.env'),
    secretsFile: file('.env.secrets.local'),
  }
}

async function writeWorkspaceSupportFiles(configPath: string): Promise<void> {
  const configDir = dirname(configPath)
  await Promise.all([
    writeFile(join(configDir, 'hooks.yaml'), 'hooks: []\n', 'utf-8'),
    writeFile(join(configDir, 'agent-rules.md'), '# agent-qa rules\n', 'utf-8'),
    writeFile(join(configDir, '.env'), '', 'utf-8'),
    writeFile(join(configDir, '.env.secrets.local'), '', 'utf-8'),
  ])
}

const subscriptionConfig = [
  'workspace: {}',
  'services: {}',
  'registry:',
  '  llms:',
  '    - name: codex',
  '      provider: openai-subscription',
  '      model: gpt-5.3-codex',
  '    - name: claude',
  '      provider: anthropic-subscription',
  '      model: claude-sonnet-4-20250514',
  '    - name: planner',
  '      provider: anthropic-subscription',
  '      model: claude-sonnet-4-20250514',
  'use:',
  '  llm: codex',
  '',
].join('\n')

function registerTestSubscriptionPlugins(options: {
  browserTokens?: Promise<{ access: string; refresh: string; expires: number }>
  exchangeCode?: (code: string, sessionState: unknown) => Promise<{ access: string; refresh: string; expires: number }>
} = {}): void {
  registerLLMAuthProviderPlugin({
    providerId: 'openai-subscription',
    credentialProviderId: 'openai-subscription-oauth',
    label: 'OpenAI subscription',
    modelAdapter: 'openai-responses',
    dashboardAuth: { mode: 'browser-poll', buttonLabel: 'Login with OpenAI subscription' },
    async startAuth() {
      return {
        authorizeUrl: 'https://auth.example/openai',
        waitForTokens: options.browserTokens ?? Promise.resolve({
          access: 'openai-access',
          refresh: 'openai-refresh',
          expires: 1777675000000,
        }),
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
      return {
        authorizeUrl: 'https://auth.example/anthropic',
        sessionState: { verifier: 'verifier-1' },
      }
    },
    async exchangeCode(ctx) {
      return options.exchangeCode
        ? options.exchangeCode(ctx.code, ctx.sessionState)
        : {
            access: `anthropic-${ctx.code}`,
            refresh: 'anthropic-refresh',
            expires: 1777675000000,
          }
    },
    createAuthFetch() {
      return globalThis.fetch
    },
  })
}

const credentialConfig = [
  'workspace: {}',
  'services: {}',
  'registry:',
  '  llms:',
  '    - name: remote-openai',
  '      provider: openai-compatible',
  '      model: openrouter/auto',
  '      baseURL: https://openrouter.ai/api/v1',
  '    - name: remote-anthropic',
  '      provider: anthropic-compatible',
  '      model: claude-sonnet-4-20250514',
  '      baseURL: https://gateway.example.com/anthropic',
  '    - name: gemini-fast',
  '      provider: gemini',
  '      model: gemini-2.5-flash',
  'use:',
  '  llm: remote-openai',
  '',
].join('\n')

beforeEach(async () => {
  vi.clearAllMocks()
  clearLLMAuthProviderPlugins()
  mockCreateModel.mockReturnValue({} as any)
  mockGenerateText.mockResolvedValue({ text: 'ok' } as any)
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
  mockGetAgentQaUpdateStatus.mockResolvedValue({
    installedVersion: '0.1.13',
    latestVersion: '0.1.13',
    updateAvailable: false,
  })

  const { configManager, configPath } = await createConfigWorkspace()
  router = createRouter({
    db: createMockDatabase() as any,
    configManager,
    configPath,
  })
})

afterEach(async () => {
  clearLLMAuthProviderPlugins()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('GET /api/app-metadata', () => {
  const forbiddenFields = [
    'installedVersion',
    'updateAvailable',
    'checkedAt',
    'cachePath',
    'registry',
    'response',
    'error',
    'config',
    'provider',
    'authMethod',
    'path',
    'database',
    'analytics',
    'environment',
    'metadata',
    'logs',
    'tests',
    'memory',
    'credentials',
  ]

  function expectNoForbiddenFields(data: Record<string, unknown>) {
    for (const field of forbiddenFields) {
      expect(data).not.toHaveProperty(field)
    }
  }

  it('returns only version and update.latestVersion when an update is available', async () => {
    mockGetAgentQaUpdateStatus.mockResolvedValueOnce({
      installedVersion: '0.1.13',
      latestVersion: '0.1.18',
      updateAvailable: true,
      checkedAt: '2026-05-24T00:00:00.000Z',
    })

    const res = await invokeRoute('/api/app-metadata')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>
    expect(data).toEqual({ version: '0.1.13', update: { latestVersion: '0.1.18' } })
    expectNoForbiddenFields(data)
  })

  it('returns exactly version when no update is available', async () => {
    mockGetAgentQaUpdateStatus.mockResolvedValueOnce({
      installedVersion: '0.1.13',
      latestVersion: '0.1.13',
      updateAvailable: false,
    })

    const res = await invokeRoute('/api/app-metadata')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>
    expect(data).toEqual({ version: '0.1.13' })
    expectNoForbiddenFields(data)
  })

  it('returns exactly version when the update helper rejects', async () => {
    mockGetAgentQaUpdateStatus.mockRejectedValueOnce(new Error('registry unavailable'))

    const res = await invokeRoute('/api/app-metadata')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>
    expect(data).toEqual({ version: '0.1.13' })
    expectNoForbiddenFields(data)
  })
})

describe('PUT /api/config/settings', () => {
  it('persists the missing latest-schema sections through dotted config paths', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'workspace.hooksFile': './hooks.yaml',
        'workspace.testMatch': ['tests/**/*.yaml'],
        'workspace.suiteMatch': ['suites/**/*.suite.yaml'],
        'workspace.agentRules': './agent-rules.md',
        'workspace.envFile': './.env.local',
        'workspace.secretsFile': './.env.secrets.local',
        'services.memory': {
          enabled: true,
          provider: 'local',
          dir: '.agent-qa/custom-memory',
          minTrust: 0.4,
          maxInjections: 4,
        },
        'registry.targets': {
          staging: {
            platform: 'web',
            url: 'https://staging.example.com',
            product: 'webapp',
          },
        },
        'registry.devices': {
          simulator: {
            platform: 'ios',
            transport: 'local',
            match: {
              udid: 'iphone-17',
              bundleId: 'com.example.app',
            },
          },
        },
        'registry.providers': {
          browserstack: {
            project: 'agent-qa',
            retries: 2,
          },
        },
        'analytics.passRateScope': {
          attributes: {
            'git.branch': { regex: '^(main|master)$' },
            'user.email': 'ci@example.com',
          },
        },
        'use.mobile.appState': 'reset',
        'use.browser.headless': true,
        'use.parallel': false,
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ updated: true })

    const config = await configManager.read()
    expect(config).toMatchObject({
      workspace: {
        hooksFile: './hooks.yaml',
        agentRules: './agent-rules.md',
        envFile: './.env.local',
        secretsFile: './.env.secrets.local',
      },
      services: {
        memory: {
          enabled: true,
          provider: 'local',
          dir: '.agent-qa/custom-memory',
          minTrust: 0.4,
          maxInjections: 4,
        },
      },
      registry: {
        targets: {
          staging: {
            platform: 'web',
            url: 'https://staging.example.com',
            product: 'webapp',
          },
        },
        devices: {
          simulator: {
            platform: 'ios',
            transport: 'local',
            match: {
              udid: 'iphone-17',
              bundleId: 'com.example.app',
            },
          },
        },
        providers: {
          browserstack: {
            project: 'agent-qa',
            retries: 2,
          },
        },
      },
      analytics: {
        passRateScope: {
          attributes: {
            'git.branch': { regex: '^(main|master)$' },
            'user.email': 'ci@example.com',
          },
        },
      },
      use: {
        mobile: {
          appState: 'reset',
        },
        browser: {
          headless: true,
        },
        parallel: false,
      },
    })
    expect((config.use as any).headless).toBeUndefined()
  })

  it('persists use.mobile.appState scalar updates', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.mobile.appState': 'reset',
      }),
    })

    expect(res.status).toBe(200)
    const config = await configManager.read()
    expect((config.use as any).mobile).toEqual({ appState: 'reset' })
  })

  it('rejects invalid use.mobile.appState values', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.mobile.appState': 'fresh',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) => detail.startsWith('use.mobile.appState:'))).toBe(true)
  })

  it('rejects removed global use.device settings', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.device': 'ios-sim',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Unsupported setting path')
    expect(data.details).toContain('use.device')
    const config = await configManager.read()
    expect((config.use as any).device).toBeUndefined()
  })

  it('saves browser headless scalar without dropping browser siblings', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry: {}',
      'use:',
      '  browser:',
      '    name: chromium',
      '    viewport:',
      '      width: 1280',
      '      height: 720',
      '  parallel: true',
      '',
    ].join('\n'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.browser.headless': true,
        'use.parallel': false,
      }),
    })

    expect(res.status).toBe(200)
    const config = await configManager.read()
    expect((config.use as any).browser).toMatchObject({
      name: 'chromium',
      headless: true,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect((config.use as any).parallel).toBe(false)
    expect((config.use as any).headless).toBeUndefined()
  })

  it('migrates legacy root headless to browser headless when nested value is absent', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry: {}',
      'use:',
      '  headless: true',
      '  browser:',
      '    name: chromium',
      '    viewport:',
      '      width: 1280',
      '      height: 720',
      '',
    ].join('\n'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.parallel': false,
      }),
    })

    expect(res.status).toBe(200)
    const config = await configManager.read()
    expect((config.use as any).headless).toBeUndefined()
    expect((config.use as any).browser).toMatchObject({
      name: 'chromium',
      headless: true,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect((config.use as any).parallel).toBe(false)
  })

  it('keeps nested browser headless and removes legacy root headless when both exist', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry: {}',
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
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'use.parallel': false,
      }),
    })

    expect(res.status).toBe(200)
    const config = await configManager.read()
    expect((config.use as any).headless).toBeUndefined()
    expect((config.use as any).browser).toMatchObject({
      name: 'chromium',
      headless: false,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect((config.use as any).parallel).toBe(false)
  })

  it.each([
    ['workspace.hooksFile', 'hooksFile is required'],
    ['workspace.agentRules', 'agentRules is required'],
    ['workspace.envFile', 'envFile is required'],
    ['workspace.secretsFile', 'secretsFile is required'],
  ])('rejects an empty %s value', async (field, message) => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [field]: '',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) =>
      detail.startsWith(`${field}:`)
      && detail.includes(message),
    )).toBe(true)
  })

  it.each(['workspace.testMatch', 'workspace.suiteMatch'])('rejects an empty %s array', async (field) => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [field]: [],
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) => detail.startsWith(`${field}:`))).toBe(true)
  })

  it('rejects services.dashboard.testsDir', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'services.dashboard': {
          testsDir: './tests',
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.join('\n')).toContain('testsDir')
  })

  it('rejects empty services.memory.dir', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'services.memory': {
          enabled: true,
          provider: 'local',
          dir: '',
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) => detail.startsWith('services.memory.dir:'))).toBe(true)
  })

  it('rejects invalid analytics pass rate scope predicates', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'analytics.passRateScope': {
          attributes: {
            'git.branch': { regex: '' },
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) =>
      detail.startsWith('analytics.passRateScope.attributes.git.branch.regex:'),
    )).toBe(true)
  })

  it('rejects invalid web targets with dotted validation paths', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'registry.targets': {
          'bad-web': {
            platform: 'web',
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details).toContain('registry.targets.bad-web: Web targets must have a url')
  })

  it('persists mobile target app install fields', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'registry.targets': {
          'release-android': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            appActivity: 'org.wikipedia.main.MainActivity',
            app: {
              path: 'apps/wikipedia-alpha.apk',
              browserstack: 'bs://uploaded-app',
            },
          },
        },
      }),
    })

    expect(res.status).toBe(200)

    const config = await configManager.read()
    expect(config).toMatchObject({
      registry: {
        targets: {
          'release-android': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            appActivity: 'org.wikipedia.main.MainActivity',
            app: {
              path: 'apps/wikipedia-alpha.apk',
              browserstack: 'bs://uploaded-app',
            },
          },
        },
      },
    })
  })

  it('rejects absolute mobile target app path', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'registry.targets': {
          'bad-android': {
            platform: 'android',
            app: {
              path: '/tmp/wikipedia.apk',
            },
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details).toContain('registry.targets.bad-android.app.path: app.path must be relative')
  })

  it('rejects unknown mobile target app keys', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'registry.targets': {
          'bad-android': {
            platform: 'android',
            app: {
              path: 'apps/wikipedia.apk',
              fallback: 'installed',
            },
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) =>
      detail.startsWith('registry.targets.bad-android.app:')
      && detail.includes('fallback'),
    )).toBe(true)
  })

  it('rejects invalid local device match fields with dotted validation paths', async () => {
    const res = await invokeRoute('/api/config/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'registry.devices': {
          iosSimulator: {
            platform: 'ios',
            transport: 'local',
            match: {
              serial: 'android-only',
            },
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details).toContain(
      'registry.devices.iosSimulator.match.serial: Match field "serial" is not valid for ios local transport. Allowed: udid, bundleId, automationName, platformVersion',
    )
  })
})

describe('PUT /api/config/llms', () => {
  it('omits product-facing authMethod from GET /api/config', async () => {
    const { configManager, configPath } = await createConfigWorkspace([
      'workspace: {}',
      'services: {}',
      'registry:',
      '  llms:',
      '    - name: planner',
      '      provider: openai-compatible',
      '      model: openrouter/auto',
      '      baseURL: https://openrouter.ai/api/v1',
      '      authMethod: key',
      'use:',
      '  llm: planner',
      '',
    ].join('\n'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config')

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>
    expect(data).toHaveProperty('config')
    expect(data).toHaveProperty('provider', 'openai-compatible')
    expect(data).not.toHaveProperty('authMethod')
  })

  it('accepts exactly the five LLM provider modes in registry.llms', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [
          {
            name: 'openai-compatible',
            provider: 'openai-compatible',
            model: 'openrouter/auto',
            baseURL: 'https://openrouter.ai/api/v1',
          },
          {
            name: 'anthropic-compatible',
            provider: 'anthropic-compatible',
            model: 'claude-remote',
            baseURL: 'https://anthropic-proxy.example/messages',
            providerHeaders: {
              'anthropic-beta': 'messages-2023-12-15',
            },
          },
          { name: 'openai-subscription', provider: 'openai-subscription', model: 'gpt-5.3-codex' },
          { name: 'anthropic-subscription', provider: 'anthropic-subscription', model: 'claude-sonnet-4-20250514' },
          { name: 'gemini', provider: 'gemini', model: 'gemini-2.5-flash' },
        ],
        defaultLLM: 'openai-compatible',
      }),
    })

    expect(res.status).toBe(200)
    const config = await configManager.read()
    expect(((config.registry as any).llms as Array<{ provider: string }>).map((llm) => llm.provider)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'openai-subscription',
      'anthropic-subscription',
      'gemini',
    ])
  })

  it('rejects product-facing authMethod in registry.llms', async () => {
    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
          authMethod: 'key',
        }],
        defaultLLM: 'planner',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { details: string[] }
    expect(data.details.join('\n')).toContain('authMethod')
  })

  it('writes compatible configs without inline API keys', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })

    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
        }],
        defaultLLM: 'planner',
      }),
    })

    expect(res.status).toBe(200)

    const config = await configManager.read()
    expect(config).toMatchObject({
      registry: {
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
        }],
      },
      use: {
        llm: 'planner',
      },
    })
    expect(((config.registry as any).llms[0] as Record<string, unknown>)).not.toHaveProperty('apiKey')
  })

  it('rejects openai-compatible configs without baseURL', async () => {
    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
        }],
        activeLlm: 'planner',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.join('\n')).toContain('baseURL')
    expect(data.details.join('\n')).toContain('Base URL is required')
  })

  it('rejects inline openai-compatible API keys before persistence', async () => {
    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-test',
        }],
        activeLlm: 'planner',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.join('\n')).toContain('apiKey')
  })

  it('rejects providerHeaders on non-anthropic-compatible configs', async () => {
    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'openrouter/auto',
          baseURL: 'https://openrouter.ai/api/v1',
          providerHeaders: {
            'x-extra': 'not-allowed',
          },
        }],
        activeLlm: 'planner',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.join('\n')).toContain('providerHeaders')
  })

  it('rejects removed provider values through generic schema validation', async () => {
    const res = await invokeRoute('/api/config/llms', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        llms: [{
          name: 'legacy',
          provider: 'ollama',
          model: 'llama3',
          baseURL: 'http://localhost:11434/v1',
        }],
        activeLlm: 'legacy',
      }),
    })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; details: string[] }
    expect(data.error).toBe('Validation failed')
    expect(data.details.some((detail) => detail.startsWith('provider:'))).toBe(true)
    expect(data.details.join('\n')).not.toMatch(/migration|deprecated|legacy provider/i)
  })
})

describe('dashboard LLM auth and test routes', () => {
  it('saves api-key credentials by config name', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('remote-openai', {
      type: 'api',
      provider: 'openai-compatible',
      key: 'sk-remote',
    })
  })

  it('saves bearer-token credentials by config name for anthropic-compatible', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        type: 'bearer-token',
        secret: 'bearer-remote',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('remote-anthropic', {
      type: 'bearer',
      provider: 'anthropic-compatible',
      token: 'bearer-remote',
    })
  })

  it('rejects credential save without configName', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'configName is required',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('rejects credential save for unknown config names', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'provider-fallback',
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'LLM config "provider-fallback" not found',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('rejects credential save when config provider does not match the request provider', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'LLM config "remote-anthropic" uses anthropic-compatible, not openai-compatible',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('rejects typed secret saves for subscription modes', async () => {
    registerTestSubscriptionPlugins()
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'claude-subscription',
        provider: 'anthropic-subscription',
        type: 'api-key',
        secret: 'sk-not-allowed',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Subscription providers use OAuth login',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('lists built-in and plugin LLM provider metadata', async () => {
    registerTestSubscriptionPlugins()

    const res = await invokeRoute('/api/llm/providers')

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: 'openai-compatible',
          auth: expect.objectContaining({ kind: 'api-key' }),
        }),
        expect.objectContaining({
          id: 'openai-subscription',
          label: 'OpenAI subscription',
          auth: {
            kind: 'oauth-plugin',
            mode: 'browser-poll',
            buttonLabel: 'Login with OpenAI subscription',
          },
          modelAdapter: 'openai-responses',
        }),
        expect.objectContaining({
          id: 'anthropic-subscription',
          label: 'Anthropic subscription',
          auth: {
            kind: 'oauth-plugin',
            mode: 'manual-code',
            buttonLabel: 'Login with Anthropic subscription',
          },
          modelAdapter: 'anthropic-messages',
        }),
      ]),
    })
  })

  it('starts browser-poll plugin auth and saves OAuth credentials server-side', async () => {
    await useConfigWorkspace(subscriptionConfig)
    registerTestSubscriptionPlugins()

    const startRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'codex',
      }),
    })

    expect(startRes.status).toBe(200)
    const started = JSON.parse(startRes.body) as { authorizeUrl: string; sessionId: string; mode: string }
    expect(started).toMatchObject({
      authorizeUrl: 'https://auth.example/openai',
      mode: 'browser-poll',
    })

    await vi.waitFor(() => {
      expect(mockWriteAuth).toHaveBeenCalledWith('codex', {
        type: 'oauth',
        provider: 'openai-subscription-oauth',
        tokens: {
          access: 'openai-access',
          refresh: 'openai-refresh',
          expires: 1777675000000,
        },
      })
    })

    const resultRes = await invokeRoute(`/api/auth/plugin/openai-subscription/result?session=${started.sessionId}`)
    expect(resultRes.status).toBe(200)
    expect(JSON.parse(resultRes.body)).toEqual({ status: 'completed', saved: true })

    const replayResultRes = await invokeRoute(`/api/auth/plugin/openai-subscription/result?session=${started.sessionId}`)
    expect(replayResultRes.status).toBe(404)
    expect(JSON.parse(replayResultRes.body)).toEqual({ error: 'Auth session not found' })
  })

  it('starts manual-code plugin auth and exchanges codes server-side', async () => {
    await useConfigWorkspace(subscriptionConfig)
    const exchangeCode = vi.fn(async (code: string, sessionState: unknown) => {
      expect(code).toBe('anthropic-code')
      expect(sessionState).toEqual({ verifier: 'verifier-1' })
      return {
        access: 'anthropic-access',
        refresh: 'anthropic-refresh',
        expires: 1777675000000,
      }
    })
    registerTestSubscriptionPlugins({ exchangeCode })

    const startRes = await invokeRoute('/api/auth/plugin/anthropic-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configName: 'claude' }),
    })
    expect(startRes.status).toBe(200)
    const started = JSON.parse(startRes.body) as { authorizeUrl: string; sessionId: string; mode: string }
    expect(started).toMatchObject({
      authorizeUrl: 'https://auth.example/anthropic',
      mode: 'manual-code',
    })

    const exchangeRes = await invokeRoute('/api/auth/plugin/anthropic-subscription/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: started.sessionId,
        code: 'anthropic-code',
      }),
    })

    expect(exchangeRes.status).toBe(200)
    expect(JSON.parse(exchangeRes.body)).toEqual({ status: 'completed', saved: true })
    expect(exchangeCode).toHaveBeenCalledTimes(1)
    expect(mockWriteAuth).toHaveBeenCalledWith('claude', {
      type: 'oauth',
      provider: 'anthropic-subscription',
      tokens: {
        access: 'anthropic-access',
        refresh: 'anthropic-refresh',
        expires: 1777675000000,
      },
    })

    const replayRes = await invokeRoute('/api/auth/plugin/anthropic-subscription/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: started.sessionId,
        code: 'anthropic-code',
      }),
    })

    expect(replayRes.status).toBe(404)
    expect(JSON.parse(replayRes.body)).toEqual({ error: 'Auth session not found' })
    expect(exchangeCode).toHaveBeenCalledTimes(1)
  })

  it('creates live sessions with current plugin auth after dashboard OAuth without restart', async () => {
    const config = [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  agentRules: agent-rules.md',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'services: {}',
      'registry:',
      '  llms:',
      '    - name: codex',
      '      provider: openai-subscription',
      '      model: gpt-5.3-codex',
      'use:',
      '  llm: codex',
      '',
    ].join('\n')
    const { configManager, configPath } = await createConfigWorkspace(config)
    await writeWorkspaceSupportFiles(configPath)
    const createSession = vi.fn(async () => ({ sessionId: 'live-1', sessionNumber: 7 }))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
      workspacePaths: buildResolvedWorkspacePaths(configPath) as any,
      sessionManager: {
        createSession,
        listSessions: vi.fn(() => []),
        terminateSession: vi.fn(),
      } as any,
    })
    registerTestSubscriptionPlugins()

    const startRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configName: 'codex' }),
    })
    expect(startRes.status).toBe(200)
    await vi.waitFor(() => expect(mockWriteAuth).toHaveBeenCalledWith('codex', expect.objectContaining({
      type: 'oauth',
      provider: 'openai-subscription-oauth',
    })))

    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockResolveLLMAuth.mockResolvedValueOnce({
      kind: 'auth-fetch',
      credentialKey: 'codex',
      provider: 'openai-subscription',
      modelAdapter: 'openai-responses',
      fetch: authFetch,
    })

    const liveRes = await invokeRoute('/api/live-editor/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'web',
        url: 'https://example.com',
      }),
    })

    expect(liveRes.status).toBe(201)
    expect(JSON.parse(liveRes.body)).toEqual({ sessionId: 'live-1', sessionNumber: 7 })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('codex', expect.objectContaining({
      provider: 'openai-subscription',
      model: 'gpt-5.3-codex',
    }))
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      llmConfig: expect.objectContaining({
        provider: 'openai-subscription',
        model: 'gpt-5.3-codex',
        modelAdapter: 'openai-responses',
      }),
      authFetch,
    }), undefined)
  })

  it('rejects plugin auth starts for non-matching or missing named subscription configs', async () => {
    await useConfigWorkspace(subscriptionConfig)
    registerTestSubscriptionPlugins()

    const blankRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: '   ',
      }),
    })
    expect(blankRes.status).toBe(400)
    expect(JSON.parse(blankRes.body)).toEqual({ error: 'configName is required' })

    const mismatchRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'claude',
      }),
    })
    expect(mismatchRes.status).toBe(400)
    expect(JSON.parse(mismatchRes.body)).toEqual({
      error: 'LLM config "claude" uses anthropic-subscription, not openai-subscription',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('reports plugin auth config read failures as server errors', async () => {
    const { configManager, configPath } = await createConfigWorkspace(subscriptionConfig)
    vi.spyOn(configManager, 'read').mockRejectedValue(new Error('config read failed'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })
    registerTestSubscriptionPlugins()

    const res = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'codex',
      }),
    })

    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({
      error: 'config read failed',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('lists api bearer and oauth credentials by config name using plugin product labels', async () => {
    registerTestSubscriptionPlugins()
    mockReadAuth.mockResolvedValue({
      'remote-openai': { type: 'api', provider: 'openai-compatible', key: 'sk-remote' },
      'remote-anthropic': { type: 'bearer', provider: 'anthropic-compatible', token: 'bearer-remote' },
      'codex-subscription': {
        type: 'oauth',
        provider: 'openai-subscription-oauth',
        tokens: {
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 1777675000000,
        },
      },
    } as any)

    const res = await invokeRoute('/api/auth/status')

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      credentials: [
        {
          type: 'api',
          provider: 'openai-compatible',
          configName: 'remote-openai',
          expires: null,
          source: 'auth-store',
        },
        {
          type: 'bearer',
          provider: 'anthropic-compatible',
          configName: 'remote-anthropic',
          expires: null,
          source: 'auth-store',
        },
        {
          type: 'oauth',
          provider: 'openai-subscription',
          configName: 'codex-subscription',
          expires: 1777675000000,
          source: 'auth-store',
        },
      ],
    })
  })

  it('deletes credentials by config name', async () => {
    const res = await invokeRoute('/api/auth/remote-openai', {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ deleted: true })
    expect(mockRemoveAuth).toHaveBeenCalledWith('remote-openai')
  })

  it('tests openai-compatible without a saved credential', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      unauthenticated: true,
      message: 'Testing without a saved credential.',
    })
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('remote-openai', expect.objectContaining({
      provider: 'openai-compatible',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
    }))
  })

  it('tests anthropic-compatible without a saved credential', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'remote-anthropic',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      unauthenticated: true,
      message: 'Testing without a saved credential.',
    })
    expect(mockGenerateText).toHaveBeenCalled()
  })

  it('reports gemini missing credential by config name', async () => {
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
        configName: 'gemini-fast',
        provider: 'gemini',
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
  })

  it('passes providerHeaders through only for anthropic-compatible tests', async () => {
    mockResolveLLMAuth.mockResolvedValueOnce({
      kind: 'api-key',
      credentialKey: 'remote-anthropic',
      provider: 'anthropic-compatible',
      apiKey: 'sk-anthropic',
    })

    await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
        providerHeaders: {
          'anthropic-beta': 'messages-2023-12-15',
        },
      }),
    })

    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic-compatible',
      providerHeaders: {
        'anthropic-beta': 'messages-2023-12-15',
      },
    }))

    mockCreateModel.mockClear()
    const invalidHeadersRes = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
        providerHeaders: {
          'x-openai-extra': 'ignored',
        },
      }),
    })

    expect(invalidHeadersRes.status).toBe(400)
    expect(JSON.parse(invalidHeadersRes.body)).toMatchObject({
      success: false,
      error: 'invalid_request',
    })
    expect(JSON.parse(invalidHeadersRes.body).message).toMatch(/providerHeaders/)
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('rejects auth-like providerHeaders', async () => {
    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
        providerHeaders: {
          Authorization: 'Bearer secret',
          'x-api-key': 'sk-secret',
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'invalid_request',
    })
    expect(JSON.parse(res.body).message).toMatch(/providerHeaders/i)
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('rejects inline apiKey in LLM connection test requests', async () => {
    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-inline',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'invalid_request',
    })
    expect(JSON.parse(res.body).message).toMatch(/apiKey/i)
    expect(mockResolveLLMAuth).not.toHaveBeenCalled()
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('maps resolver bearer-token auth to runtime authToken', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'bearer-token',
      credentialKey: 'remote-anthropic',
      provider: 'anthropic-compatible',
      token: 'bearer-remote',
    })

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
      }),
    })

    expect(res.status).toBe(200)
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic-compatible',
      authToken: 'bearer-remote',
    }))
    expect(mockCreateModel).toHaveBeenCalledWith(expect.not.objectContaining({
      apiKey: expect.anything(),
    }))
  })

  it('returns auth_error copy for authentication failures', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: 'sk-bad',
    })
    mockGenerateText.mockRejectedValueOnce(Object.assign(new Error('invalid API key'), {
      statusCode: 401,
    }))

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'auth_error',
      message: 'Authentication failed. Check the saved credential for this config.',
    })
  })

  it('returns model_not_found for missing model responses', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: 'sk-remote',
    })
    mockGenerateText.mockRejectedValueOnce(Object.assign(new Error('model not found'), {
      statusCode: 404,
    }))

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'missing-model',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'model_not_found',
      message: 'Model not found. Check the model name.',
    })
  })

  it('returns network_error for base URL failures', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    mockGenerateText.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://offline.example/api/v1',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      error: 'network_error',
      message: 'Network error. Check the exact base URL and try again.',
      unauthenticated: true,
      authMessage: 'Testing without a saved credential.',
    })
  })
})
