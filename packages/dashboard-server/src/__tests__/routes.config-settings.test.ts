import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import {
  PROVIDER_ERROR_CLASSES,
  providerErrorSentence,
  type ProviderErrorClass,
} from '@vostride/agent-qa-schema'
import {
  clearLLMAuthProviderPlugins,
  readAuth,
  registerLLMAuthProviderPlugin,
  removeAuth,
  writeAuth,
} from '@vostride/agent-qa-core'
import { createModel } from '@vostride/agent-qa-model'
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
    vision: z.boolean().optional(),
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
    name: actual.NameSlugSchema,
    contextWindow: z.union([z.string(), z.number()]).optional(),
  }).strict().superRefine(validateModelConfig)
  const WorkspaceSchema = z.object({
    testMatch: z.array(z.string().min(1)).min(1),
    suiteMatch: z.array(z.string().min(1)).min(1),
    testPathIgnore: z.array(z.string()).optional(),
    hooksFile: z.string().min(1, 'hooksFile is required.'),
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
    getAgentQaVersion: vi.fn(() => '0.1.13'),
    getAgentQaUpdateStatus: mockGetAgentQaUpdateStatus,
    resolveLLMAuth: mockResolveLLMAuth,
    readAuth: vi.fn(() => ({})),
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
const mockReadAuth = vi.mocked(readAuth)
const mockWriteAuth = vi.mocked(writeAuth)
const mockRemoveAuth = vi.mocked(removeAuth)
const mockGenerateText = vi.mocked(generateText)

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

// A loopback caller that names its Host, the way curl, the CLI and the dashboard's own page do.
const LLM_TEST_HOST = '127.0.0.1:4317'
const LLM_TEST_HEADERS: IncomingHttpHeaders = { 'content-type': 'application/json', host: LLM_TEST_HOST }
const LLM_TEST_CREDENTIAL = 'sk-fixture-credential-429-08'

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
    configManager: new ConfigManager(configPath, (text) => text),
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
    envFile: file('.env'),
    secretsFile: file('.env.secrets.local'),
  }
}

async function writeWorkspaceSupportFiles(configPath: string): Promise<void> {
  const configDir = dirname(configPath)
  await Promise.all([
    writeFile(join(configDir, 'hooks.yaml'), 'hooks: []\n', 'utf-8'),
    writeFile(join(configDir, '.env'), '', 'utf-8'),
    writeFile(join(configDir, '.env.secrets.local'), '', 'utf-8'),
  ])
}

const subscriptionConfig = [
  'workspace: {}',
  'services:',
  '  vision:',
  '    screenshotSize: 256k',
  '    effectiveResolution: 768',
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

// 429-32 D-19: the settings, model-list and default-model claims the per-section PUT routes proved,
// each driven through the one field-merge write (PATCH /api/config) or the draft-model connect.
const SETTINGS_WORKSPACE_LINES = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

const MOBILE_USE_LINES = ['  mobile:', '    appState: preserve']

function settingsConfig(useLines: string[] = MOBILE_USE_LINES, registryLines: string[] = ['registry: {}']): string {
  return [...SETTINGS_WORKSPACE_LINES, 'services: {}', ...registryLines, 'use:', ...useLines, ''].join('\n')
}

async function useSettingsWorkspace(initialConfig = settingsConfig()): Promise<{
  configManager: ConfigManager
  configPath: string
}> {
  const workspace = await createConfigWorkspace(initialConfig)
  router = createRouter({ db: createMockDatabase() as any, ...workspace })
  return workspace
}

type WriteIssue = { path: Array<string | number>; message: string }

const set = (path: Array<string | number>, value: unknown) => ({ op: 'set', path, value })

function patchConfig(changes: unknown[]): Promise<MockResponse> {
  return invokeRoute('/api/config', {
    method: 'PATCH',
    headers: LLM_TEST_HEADERS,
    body: JSON.stringify({ changes }),
  })
}

function connectModel(body: Record<string, unknown>): Promise<MockResponse> {
  return invokeRoute('/api/llm/connect', {
    method: 'POST',
    headers: LLM_TEST_HEADERS,
    body: JSON.stringify(body),
  })
}

async function readConfig(configManager: ConfigManager): Promise<Record<string, any>> {
  const read = await configManager.readWithRevision()
  if (read.kind !== 'ok') throw new Error(`config read answered ${read.kind}`)
  return read.config as Record<string, any>
}

const dotted = (issue: WriteIssue): string => issue.path.map(String).join('.')

async function expectValidationRefused(res: MockResponse, configPath: string, before: Buffer): Promise<WriteIssue[]> {
  expect(res.status).toBe(422)
  const data = JSON.parse(res.body) as { error: string; issues?: WriteIssue[] }
  expect(data.error).toBe('validation_failed')
  expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
  return data.issues ?? []
}

async function expectPatchRefused(changes: unknown[], initialConfig?: string): Promise<WriteIssue[]> {
  const { configPath } = await useSettingsWorkspace(initialConfig)
  const before = await readFile(configPath)
  return expectValidationRefused(await patchConfig(changes), configPath, before)
}

describe('settings writes through PATCH /api/config (429-32)', () => {
  it('persists the missing latest-schema sections through segment config paths', async () => {
    const { configManager } = await useSettingsWorkspace()

    const res = await patchConfig([
      set(['workspace', 'hooksFile'], './hooks.yaml'),
      set(['workspace', 'testMatch'], ['tests/**/*.yaml']),
      set(['workspace', 'suiteMatch'], ['suites/**/*.suite.yaml']),
      set(['workspace', 'envFile'], './.env.local'),
      set(['workspace', 'secretsFile'], './.env.secrets.local'),
      set(['knowledge'], {
        dir: 'agent-qa-knowledge',
      }),
      set(['services', 'vision'], {
        screenshotSize: '512k',
        effectiveResolution: 768,
      }),
      set(['registry', 'targets', 'staging'], {
        platform: 'web',
        url: 'https://staging.example.com',
        product: 'webapp',
      }),
      set(['registry', 'devices', 'simulator'], {
        platform: 'ios',
        match: {
          udid: 'iphone-17',
          bundleId: 'com.example.app',
        },
      }),
      set(['analytics', 'passRateScope'], {
        attributes: {
          'git.branch': { regex: '^(main|master)$' },
          'user.email': 'ci@example.com',
        },
      }),
      set(['use', 'mobile', 'appState'], 'reset'),
      set(['use', 'browser', 'headless'], true),
      set(['use', 'browser', 'name'], 'chromium'),
      set(['use', 'parallel'], false),
    ])

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toHaveProperty('revision')

    const config = await readConfig(configManager)
    expect(config).toMatchObject({
      workspace: {
        hooksFile: './hooks.yaml',
        envFile: './.env.local',
        secretsFile: './.env.secrets.local',
      },
      knowledge: {
        dir: 'agent-qa-knowledge',
      },
      services: {
        vision: {
          screenshotSize: '512k',
          effectiveResolution: 768,
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
            match: {
              udid: 'iphone-17',
              bundleId: 'com.example.app',
            },
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
    expect(config.use.headless).toBeUndefined()
    expect(Object.keys(config).filter((key) => key.includes('.'))).toEqual([])
  })

  it('persists shared services.vision settings', async () => {
    const { configManager } = await useSettingsWorkspace()

    const res = await patchConfig([
      set(['services', 'vision'], {
        screenshotSize: '384k',
        effectiveResolution: 640,
      }),
    ])

    expect(res.status).toBe(200)
    const config = await readConfig(configManager)
    expect(config.services?.vision).toEqual({
      screenshotSize: '384k',
      effectiveResolution: 640,
    })
  })

  it('rejects unknown services.vision keys', async () => {
    const issues = await expectPatchRefused([
      set(['services', 'vision'], {
        screenshotSize: '384k',
        cropMode: 'center',
      }),
    ])

    expect(issues.some((issue) =>
      dotted(issue).startsWith('services.vision')
      && issue.message.includes('cropMode'),
    )).toBe(true)
  })

  it('persists use.mobile.appState scalar updates', async () => {
    const { configManager } = await useSettingsWorkspace()

    const res = await patchConfig([set(['use', 'mobile', 'appState'], 'reset')])

    expect(res.status).toBe(200)
    const config = await readConfig(configManager)
    expect(config.use.mobile).toEqual({ appState: 'reset' })
  })

  it('rejects invalid use.mobile.appState values', async () => {
    const issues = await expectPatchRefused([set(['use', 'mobile', 'appState'], 'fresh')])

    expect(issues.some((issue) => dotted(issue) === 'use.mobile.appState')).toBe(true)
  })

  it('rejects removed global use.device settings', async () => {
    const { configManager, configPath } = await useSettingsWorkspace()
    const before = await readFile(configPath)

    // 429-44: the door refuses the retired leaf by path; inside a container value it still meets validation.
    const refused = await patchConfig([set(['use', 'device'], 'ios-sim')])
    expect(refused.status).toBe(422)
    expect(JSON.parse(refused.body)).toEqual({ error: 'path_not_writable' })
    const issues = await expectValidationRefused(
      await patchConfig([set(['use'], { device: 'ios-sim' })]),
      configPath,
      before,
    )

    expect(issues.some((issue) => dotted(issue).startsWith('use') && issue.message.includes('device'))).toBe(true)
    const config = await readConfig(configManager)
    expect(config.use.device).toBeUndefined()
  })

  it('saves browser headless scalar without dropping browser siblings', async () => {
    const { configManager } = await useSettingsWorkspace(settingsConfig([
      '  browser:',
      '    name: chromium',
      '    viewport:',
      '      width: 1280',
      '      height: 720',
      '  parallel: true',
      ...MOBILE_USE_LINES,
    ]))

    const res = await patchConfig([
      set(['use', 'browser', 'headless'], true),
      set(['use', 'parallel'], false),
    ])

    expect(res.status).toBe(200)
    const config = await readConfig(configManager)
    expect(config.use.browser).toMatchObject({
      name: 'chromium',
      headless: true,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect(config.use.parallel).toBe(false)
    expect(config.use.headless).toBeUndefined()
  })

  it('migrates legacy root headless to browser headless when nested value is absent', async () => {
    const { configManager } = await useSettingsWorkspace(settingsConfig([
      '  headless: true',
      '  browser:',
      '    name: chromium',
      '    viewport:',
      '      width: 1280',
      '      height: 720',
      ...MOBILE_USE_LINES,
    ]))

    const res = await patchConfig([
      set(['use', 'browser', 'headless'], true),
      set(['use', 'parallel'], false),
    ])

    expect(res.status).toBe(200)
    const config = await readConfig(configManager)
    expect(config.use.headless).toBeUndefined()
    expect(config.use.browser).toMatchObject({
      name: 'chromium',
      headless: true,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect(config.use.parallel).toBe(false)
  })

  it('keeps nested browser headless and removes legacy root headless when both exist', async () => {
    const { configManager } = await useSettingsWorkspace(settingsConfig([
      '  headless: true',
      '  browser:',
      '    name: chromium',
      '    headless: false',
      '    viewport:',
      '      width: 1280',
      '      height: 720',
      ...MOBILE_USE_LINES,
    ]))

    const res = await patchConfig([
      set(['use', 'browser', 'headless'], false),
      set(['use', 'parallel'], false),
    ])

    expect(res.status).toBe(200)
    const config = await readConfig(configManager)
    expect(config.use.headless).toBeUndefined()
    expect(config.use.browser).toMatchObject({
      name: 'chromium',
      headless: false,
      viewport: {
        width: 1280,
        height: 720,
      },
    })
    expect(config.use.parallel).toBe(false)
  })

  it.each(['hooksFile', 'envFile', 'secretsFile'])('rejects an empty workspace.%s value', async (field) => {
    const issues = await expectPatchRefused([set(['workspace', field], '')])

    expect(issues.some((issue) => dotted(issue) === `workspace.${field}`)).toBe(true)
  })

  it.each(['testMatch', 'suiteMatch'])('rejects an empty workspace.%s array', async (field) => {
    const issues = await expectPatchRefused([set(['workspace', field], [])])

    expect(issues.some((issue) => dotted(issue).startsWith(`workspace.${field}`))).toBe(true)
  })

  it('rejects services.dashboard.testsDir', async () => {
    const { configPath } = await useSettingsWorkspace()
    const before = await readFile(configPath)
    // 429-44: the door refuses the retired leaf by path; inside a container value it still meets validation.
    const refused = await patchConfig([set(['services', 'dashboard', 'testsDir'], './tests')])
    expect(refused.status).toBe(422)
    expect(JSON.parse(refused.body)).toEqual({ error: 'path_not_writable' })
    const issues = await expectValidationRefused(
      await patchConfig([set(['services', 'dashboard'], { testsDir: './tests' })]),
      configPath,
      before,
    )

    expect(issues.map((issue) => `${dotted(issue)}: ${issue.message}`).join('\n')).toContain('testsDir')
  })

  it('rejects empty knowledge.dir', async () => {
    const issues = await expectPatchRefused([set(['knowledge', 'dir'], '')])

    expect(issues.some((issue) => dotted(issue) === 'knowledge.dir')).toBe(true)
  })

  it('rejects an absolute knowledge.dir (repo-relative refine, T-373-06)', async () => {
    const issues = await expectPatchRefused([set(['knowledge', 'dir'], '/etc/knowledge')])

    expect(issues.some((issue) => dotted(issue) === 'knowledge.dir')).toBe(true)
  })

  it('rejects invalid analytics pass rate scope predicates', async () => {
    const issues = await expectPatchRefused([
      set(['analytics', 'passRateScope'], {
        attributes: {
          'git.branch': { regex: '' },
        },
      }),
    ])

    expect(issues.some((issue) =>
      dotted(issue).startsWith('analytics.passRateScope.attributes.git.branch'),
    )).toBe(true)
  })

  it('rejects invalid web targets with segment validation paths', async () => {
    const issues = await expectPatchRefused([
      set(['registry', 'targets', 'bad-web'], {
        platform: 'web',
      }),
    ])

    expect(issues.map((issue) => `${dotted(issue)}: ${issue.message}`))
      .toContain('registry.targets.bad-web: Web targets must have a url')
  })

  it('persists mobile target app install fields', async () => {
    const { configManager } = await useSettingsWorkspace()

    const res = await patchConfig([
      set(['registry', 'targets', 'release-android'], {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
        app: {
          path: 'apps/wikipedia-alpha.apk',
        },
      }),
    ])

    expect(res.status).toBe(200)

    const config = await readConfig(configManager)
    expect(config).toMatchObject({
      registry: {
        targets: {
          'release-android': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            appActivity: 'org.wikipedia.main.MainActivity',
            app: {
              path: 'apps/wikipedia-alpha.apk',
            },
          },
        },
      },
    })
  })

  it('rejects absolute mobile target app path', async () => {
    const issues = await expectPatchRefused([
      set(['registry', 'targets', 'bad-android'], {
        platform: 'android',
        app: {
          path: '/tmp/wikipedia.apk',
        },
      }),
    ])

    expect(issues.map((issue) => `${dotted(issue)}: ${issue.message}`))
      .toContain('registry.targets.bad-android.app.path: app.path must be relative')
  })

  it('rejects unknown mobile target app keys', async () => {
    const issues = await expectPatchRefused([
      set(['registry', 'targets', 'bad-android'], {
        platform: 'android',
        app: {
          path: 'apps/wikipedia.apk',
          fallback: 'installed',
        },
      }),
    ])

    expect(issues.some((issue) =>
      dotted(issue).startsWith('registry.targets.bad-android.app')
      && issue.message.includes('fallback'),
    )).toBe(true)
  })

  it('rejects invalid device match fields with segment validation paths', async () => {
    const issues = await expectPatchRefused([
      set(['registry', 'devices', 'iosSimulator'], {
        platform: 'ios',
        match: {
          serial: 'android-only',
        },
      }),
    ])

    expect(issues.map((issue) => `${dotted(issue)}: ${issue.message}`)).toContain(
      'registry.devices.iosSimulator.match.serial: Match field "serial" is not valid for an ios device. Allowed: udid, bundleId, automationName, platformVersion',
    )
  })
})

const PLANNER_DEFINITION = {
  name: 'planner',
  provider: 'openai-compatible',
  model: 'openrouter/auto',
  baseURL: 'https://openrouter.ai/api/v1',
}

// A model-list write the connect route refuses by name is also refused when appended through the
// field-merge write, so neither path can land the definition.
async function expectModelRefusedBothWays(
  draft: Record<string, unknown>,
  connectRefusal: string,
): Promise<{ connectBody: { error: string; issues?: WriteIssue[] }; patchIssues: WriteIssue[] }> {
  const { configPath } = await useSettingsWorkspace()
  const before = await readFile(configPath)

  const connected = await connectModel({ ...draft, skipTest: true })
  expect(connected.status).toBe(400)
  const connectBody = JSON.parse(connected.body) as { error: string; issues?: WriteIssue[] }
  expect(connectBody.error).toBe(connectRefusal)
  expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

  const patchIssues = await expectValidationRefused(
    await patchConfig([
      { op: 'append', path: ['registry', 'llms'], value: draft },
      set(['use', 'llm'], draft.name),
    ]),
    configPath,
    before,
  )
  expect(mockWriteAuth).not.toHaveBeenCalled()
  return { connectBody, patchIssues }
}

describe('model list and default model writes through connect and PATCH (429-32)', () => {
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

    const res = await invokeRoute('/api/config', { headers: { host: LLM_TEST_HOST } })

    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as Record<string, unknown>
    expect(data).toHaveProperty('config')
    expect(data).toHaveProperty('provider', 'openai-compatible')
    expect(data).not.toHaveProperty('authMethod')
  })

  it('accepts exactly the five LLM provider modes in registry.llms', async () => {
    registerTestSubscriptionPlugins()
    const { configManager } = await useSettingsWorkspace()

    const drafts = [
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
    ]
    for (const draft of drafts) {
      const res = await connectModel({ ...draft, skipTest: true })
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true })
    }

    const config = await readConfig(configManager)
    expect((config.registry.llms as Array<{ provider: string }>).map((llm) => llm.provider)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'openai-subscription',
      'anthropic-subscription',
      'gemini',
    ])
    expect(config.use.llm).toBe('openai-compatible')
  })

  it('rejects product-facing authMethod in registry.llms', async () => {
    const { patchIssues } = await expectModelRefusedBothWays(
      { ...PLANNER_DEFINITION, authMethod: 'key' },
      'invalid_setup_input',
    )

    expect(patchIssues.map((issue) => `${dotted(issue)}: ${issue.message}`).join('\n')).toContain('authMethod')
  })

  it('writes compatible configs without inline API keys', async () => {
    const { configManager, configPath } = await useSettingsWorkspace()

    const res = await connectModel({
      ...PLANNER_DEFINITION,
      credential: { type: 'api-key', secret: LLM_TEST_CREDENTIAL },
      skipTest: true,
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ success: true, saved: true, becameDefault: true })

    const config = await readConfig(configManager)
    expect(config).toMatchObject({
      registry: {
        llms: [PLANNER_DEFINITION],
      },
      use: {
        llm: 'planner',
      },
    })
    expect(config.registry.llms[0] as Record<string, unknown>).not.toHaveProperty('apiKey')
    expect(await readFile(configPath, 'utf-8')).not.toContain(LLM_TEST_CREDENTIAL)
    expect(mockWriteAuth).toHaveBeenCalledWith('planner', {
      type: 'api',
      provider: 'openai-compatible',
      key: LLM_TEST_CREDENTIAL,
    })
  })

  it('rejects openai-compatible configs without baseURL', async () => {
    const { connectBody, patchIssues } = await expectModelRefusedBothWays(
      { name: 'planner', provider: 'openai-compatible', model: 'openrouter/auto' },
      'invalid_setup_input',
    )

    const connectDetails = (connectBody.issues ?? []).map((issue) => `${dotted(issue)}: ${issue.message}`).join('\n')
    expect(connectDetails).toContain('baseURL')
    expect(connectDetails).toContain('Base URL is required')
    expect(patchIssues.some((issue) => issue.path.includes('baseURL'))).toBe(true)
  })

  it('rejects inline openai-compatible API keys before persistence', async () => {
    const { patchIssues } = await expectModelRefusedBothWays(
      { ...PLANNER_DEFINITION, apiKey: 'sk-test' },
      'invalid_setup_input',
    )

    expect(patchIssues.map((issue) => `${dotted(issue)}: ${issue.message}`).join('\n')).toContain('apiKey')
  })

  it('rejects providerHeaders on non-anthropic-compatible configs', async () => {
    const { connectBody, patchIssues } = await expectModelRefusedBothWays(
      { ...PLANNER_DEFINITION, providerHeaders: { 'x-extra': 'not-allowed' } },
      'invalid_setup_input',
    )

    expect((connectBody.issues ?? []).some((issue) => issue.path.includes('providerHeaders'))).toBe(true)
    expect(patchIssues.some((issue) => issue.path.includes('providerHeaders'))).toBe(true)
  })

  it('rejects removed provider values through generic schema validation', async () => {
    const { connectBody, patchIssues } = await expectModelRefusedBothWays(
      { name: 'legacy', provider: 'ollama', model: 'llama3', baseURL: 'http://localhost:11434/v1' },
      'invalid_setup_input',
    )

    expect(patchIssues.some((issue) => issue.path.includes('provider'))).toBe(true)
    const messages = [connectBody, ...patchIssues].map((item) => JSON.stringify(item)).join('\n')
    expect(messages).not.toMatch(/migration|deprecated|legacy provider/i)
  })

  it('switches the default model with a PATCH set of use.llm, and refuses a name registry.llms does not hold', async () => {
    const registryLines = [
      'registry:',
      '  llms:',
      '    - name: planner',
      '      provider: openai-compatible',
      '      model: openrouter/auto',
      '      baseURL: https://openrouter.ai/api/v1',
      '    - name: fast',
      '      provider: gemini',
      '      model: gemini-2.5-flash',
    ]
    const { configManager, configPath } = await useSettingsWorkspace(
      settingsConfig(['  llm: planner', ...MOBILE_USE_LINES], registryLines),
    )

    const switched = await patchConfig([set(['use', 'llm'], 'fast')])
    expect(switched.status).toBe(200)
    expect((await readConfig(configManager)).use.llm).toBe('fast')

    const before = await readFile(configPath)
    const issues = await expectValidationRefused(await patchConfig([set(['use', 'llm'], 'missing')]), configPath, before)
    expect(issues.some((issue) => dotted(issue) === 'use.llm')).toBe(true)
    expect((await readConfig(configManager)).use.llm).toBe('fast')
  })
})

describe('dashboard LLM auth and test routes', () => {
  it('saves api-key credentials by config name', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true, created: true })
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        type: 'bearer-token',
        secret: 'bearer-remote',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true, created: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('remote-anthropic', {
      type: 'bearer',
      provider: 'anthropic-compatible',
      token: 'bearer-remote',
    })
  })

  it('rejects credential save without configName', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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

  // 429-09 D-15: re-targeted from "rejects credential save for unknown config names" — a name
  // not yet in registry.llms is a draft, and its credential is accepted.
  it('accepts credential save for a draft name not yet in registry.llms', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: 'provider-fallback',
        provider: 'openai-compatible',
        type: 'api-key',
        secret: 'sk-remote',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true, created: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('provider-fallback', {
      type: 'api',
      provider: 'openai-compatible',
      key: 'sk-remote',
    })
  })

  it('rejects credential save when config provider does not match the request provider', async () => {
    await useConfigWorkspace(credentialConfig)

    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'services:',
      '  vision:',
      '    screenshotSize: 256k',
      '    effectiveResolution: 768',
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
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
      // 428 D-08: the live-editor doors run the same-site guard, which refuses an absent Host.
      headers: { 'content-type': 'application/json', host: '127.0.0.1:3470' },
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
        vision: {
          screenshotSize: 262144,
          effectiveResolution: 768,
        },
      }),
      authFetch,
    }), undefined)
  })

  it('rejects plugin auth starts for non-matching named subscription configs and accepts a draft name', async () => {
    await useConfigWorkspace(subscriptionConfig)
    registerTestSubscriptionPlugins()

    const blankRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: '   ',
      }),
    })
    expect(blankRes.status).toBe(400)
    expect(JSON.parse(blankRes.body)).toEqual({ error: 'configName is required' })

    const mismatchRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: 'claude',
      }),
    })
    expect(mismatchRes.status).toBe(400)
    expect(JSON.parse(mismatchRes.body)).toEqual({
      error: 'LLM config "claude" uses anthropic-subscription, not openai-subscription',
    })
    expect(mockWriteAuth).not.toHaveBeenCalled()

    // 429-09 D-15: a name missing from registry.llms is a draft, and its sign-in starts.
    const missingRes = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
      body: JSON.stringify({
        configName: 'codex-draft',
      }),
    })
    expect(missingRes.status).toBe(200)
    expect(JSON.parse(missingRes.body)).toMatchObject({
      authorizeUrl: 'https://auth.example/openai',
      mode: 'browser-poll',
      created: true,
    })
  })

  it('reports plugin auth config read failures as server errors', async () => {
    const { configManager, configPath } = await createConfigWorkspace(subscriptionConfig)
    vi.spyOn(configManager, 'readWithRevision').mockRejectedValue(new Error('config read failed'))
    router = createRouter({
      db: createMockDatabase() as any,
      configManager,
      configPath,
    })
    registerTestSubscriptionPlugins()

    const res = await invokeRoute('/api/auth/plugin/openai-subscription/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: LLM_TEST_HOST },
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
    mockReadAuth.mockResolvedValue({
      'remote-openai': { type: 'api', provider: 'openai-compatible', key: 'sk-remote' },
    })
    const res = await invokeRoute('/api/auth/remote-openai', {
      method: 'DELETE',
      headers: { host: LLM_TEST_HOST },
    })

    expect(res.status).toBe(200)
    // 429-11 D-24: the removal answers an Undo token and never the credential it removed.
    expect(JSON.parse(res.body)).toEqual({
      deleted: true,
      undo: { token: expect.any(String), expiresAt: expect.any(Number) },
    })
    expect(res.body).not.toContain('sk-remote')
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
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
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

    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic-compatible',
        headers: {
          'anthropic-beta': 'messages-2023-12-15',
        },
      }),
      { kind: 'api-key', apiKey: 'sk-anthropic' },
      expect.any(Function),
    )

    mockCreateModel.mockClear()
    const invalidHeadersRes = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
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
      headers: LLM_TEST_HEADERS,
      body: JSON.stringify({
        configName: 'remote-anthropic',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
      }),
    })

    expect(res.status).toBe(200)
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
      }),
      { kind: 'bearer-token', token: 'bearer-remote' },
      expect.any(Function),
    )
  })

  it('returns auth_error copy for authentication failures', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: LLM_TEST_CREDENTIAL,
    })
    mockGenerateText.mockRejectedValueOnce(Object.assign(new Error('invalid API key'), {
      statusCode: 401,
    }))

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: LLM_TEST_HEADERS,
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
      message: providerErrorSentence('auth_error', 'invalid API key'),
    })
    expect(res.body).not.toContain(LLM_TEST_CREDENTIAL)
  })

  it('returns model_not_found for missing model responses', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: LLM_TEST_CREDENTIAL,
    })
    mockGenerateText.mockRejectedValueOnce(Object.assign(new Error('model not found'), {
      statusCode: 404,
    }))

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: LLM_TEST_HEADERS,
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
      message: providerErrorSentence('model_not_found', 'model not found'),
    })
    expect(res.body).not.toContain(LLM_TEST_CREDENTIAL)
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
      headers: LLM_TEST_HEADERS,
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
      message: providerErrorSentence('network_error', 'fetch failed'),
      unauthenticated: true,
      authMessage: 'Testing without a saved credential.',
    })
    expect(res.body).not.toContain(LLM_TEST_CREDENTIAL)
  })

  // One provider rejection per class, each one's message chosen so the shared classifier's
  // first-match order lands on exactly that class.
  const REJECTION_PER_CLASS: Record<ProviderErrorClass, { message: string; statusCode?: number }> = {
    auth_error: { message: 'invalid API key', statusCode: 401 },
    model_not_found: { message: 'model not found', statusCode: 404 },
    rate_limit: { message: 'Too many requests, slow down', statusCode: 429 },
    network_error: { message: 'fetch failed' },
    invalid_request: { message: 'bad request: messages must be non-empty', statusCode: 400 },
    provider_error: { message: 'upstream exploded', statusCode: 500 },
  }

  async function testWithSavedCredential(headers: IncomingHttpHeaders = LLM_TEST_HEADERS) {
    return await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        configName: 'remote-openai',
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    })
  }

  it('TEST-ROUTE-SENTENCE-EVERY-CLASS: every provider-error class answers the shared sentence', async () => {
    expect(Object.keys(REJECTION_PER_CLASS).sort()).toEqual([...PROVIDER_ERROR_CLASSES].sort())
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: LLM_TEST_CREDENTIAL,
    })

    for (const errorClass of PROVIDER_ERROR_CLASSES) {
      const rejection = REJECTION_PER_CLASS[errorClass]
      mockGenerateText.mockRejectedValueOnce(Object.assign(new Error(rejection.message), {
        ...(rejection.statusCode ? { statusCode: rejection.statusCode } : {}),
      }))

      const res = await testWithSavedCredential()

      expect(res.status, errorClass).toBe(200)
      const answer = JSON.parse(res.body)
      expect(answer, errorClass).toMatchObject({ success: false, error: errorClass })
      expect(answer.message, errorClass).toBe(providerErrorSentence(errorClass, rejection.message))
      expect(res.body, errorClass).not.toContain(LLM_TEST_CREDENTIAL)
    }
    expect(mockGenerateText).toHaveBeenCalledTimes(PROVIDER_ERROR_CLASSES.length)
  })

  it('LLM-TEST-SAME-SITE: a cross-site caller is refused and no answer carries a wildcard grant', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      apiKey: LLM_TEST_CREDENTIAL,
    })
    const callers: Array<{ name: string; headers: IncomingHttpHeaders }> = [
      {
        name: 'a foreign Origin',
        headers: { ...LLM_TEST_HEADERS, origin: 'http://evil.example' },
      },
      {
        name: 'Sec-Fetch-Site cross-site with no Origin',
        headers: { ...LLM_TEST_HEADERS, 'sec-fetch-site': 'cross-site' },
      },
      { name: 'a rebound Host', headers: { 'content-type': 'application/json', host: 'evil.test' } },
    ]

    for (const caller of callers) {
      const refused = await testWithSavedCredential(caller.headers)
      expect(refused.status, caller.name).toBe(403)
      expect(JSON.parse(refused.body), caller.name).toEqual({ error: 'cross_site_refused' })
      expect(refused.headers['access-control-allow-origin'], caller.name).toBeUndefined()
    }
    expect(mockResolveLLMAuth).not.toHaveBeenCalled()
    expect(mockGenerateText).not.toHaveBeenCalled()

    const sameSite = { ...LLM_TEST_HEADERS, origin: `http://${LLM_TEST_HOST}`, 'sec-fetch-site': 'same-origin' }
    const connected = await testWithSavedCredential(sameSite)
    expect(connected.status).toBe(200)
    expect(JSON.parse(connected.body)).toMatchObject({ success: true })

    mockGenerateText.mockRejectedValueOnce(new Error('upstream exploded'))
    const failed = await testWithSavedCredential()
    expect(JSON.parse(failed.body)).toMatchObject({ success: false, error: 'provider_error' })

    const inlineKey = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: LLM_TEST_HEADERS,
      body: JSON.stringify({ provider: 'openai-compatible', model: 'm', apiKey: 'sk-inline' }),
    })
    expect(inlineKey.status).toBe(400)

    const notJson = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: LLM_TEST_HEADERS,
      body: '{not json',
    })
    expect(notJson.status).toBe(400)

    mockResolveLLMAuth.mockResolvedValueOnce({
      kind: 'missing',
      credentialKey: 'remote-openai',
      provider: 'openai-compatible',
      required: true,
      message: 'Save an API key for this config before testing.',
    })
    const missing = await testWithSavedCredential()
    expect(JSON.parse(missing.body)).toMatchObject({ success: false, error: 'missing_credential' })

    for (const answer of [connected, failed, inlineKey, notJson, missing]) {
      expect(answer.headers['access-control-allow-origin']).toBeUndefined()
      expect(answer.body).not.toContain(LLM_TEST_CREDENTIAL)
    }
  })
})
