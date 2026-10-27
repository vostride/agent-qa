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
    name: actual.NameSlugSchema,
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
  }
})

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: (...args: unknown[]) => mockCreateModel(...args),
    getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
  }
})

// 2026-10-03 (quick-261003-tsr, WR-12): a write failure is injected at the atomic writer's
// rename rather than with directory permissions, which root (and Windows) ignore. Pass-through
// unless a cell sets the flag.
const fsFault = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => (fsFault.failRename
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied, rename (injected)'), { code: 'EACCES' }))
      : actual.rename(...args)),
  }
})

vi.mock('ai', () => ({
  addToolInputExamplesMiddleware: vi.fn(() => ({})),
  createProviderRegistry: vi.fn(),
  customProvider: vi.fn(),
  extractJsonMiddleware: vi.fn(() => ({})),
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  parsePartialJson: vi.fn(),
}))

import { createHash } from 'node:crypto'
import { ConfigManager } from '../config/config-manager.js'
import { createRouter } from '../server/routes.js'
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'

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
  manager = new ConfigManager(configPath, (text) => text)
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
  mockCreateModel.mockReturnValue({ id: 'model' })
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

const SELF_HOST_HEADERS: IncomingHttpHeaders = { 'content-type': 'application/json', host: '127.0.0.1:4317' }

function patchConfig(changes: unknown[]): Promise<MockResponse> {
  return invokeRoute('/api/config', { method: 'PATCH', headers: SELF_HOST_HEADERS, body: JSON.stringify({ changes }) })
}

async function readConfig(): Promise<Record<string, any>> {
  const read = await manager.readWithRevision()
  if (read.kind !== 'ok') throw new Error(`config read answered ${read.kind}`)
  return read.config as Record<string, any>
}

// A config the whole-config validation accepts, laid out like SAMPLE_CONFIG, for the ordering cells.
const ORDERED_CONFIG = `# Test config
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

services:
  dashboard:
    port: 3470
  cache:
    dir: .cache

registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: openrouter/auto
      baseURL: https://openrouter.ai/api/v1
    - name: claude-sonnet
      provider: gemini
      model: gemini-2.5-flash
    - name: new-model
      provider: gemini
      model: gemini-2.5-pro

use:
  timeout:
    step: 30s
    test: 10m
    navigation: 10s
  llm: planner
  mobile:
    appState: preserve
`

describe('ConfigManager', () => {
  it.each([undefined, {}, { keepFailuresOnly: true }, { keepFailuresOnly: false }, { enabled: true }, { enabled: false }])(
    'keeps authored recording omissions through GET, no-op and unrelated saves: %j', async recording => {
      const source = {
        workspace: {
          testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.yaml'],
          hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'preserve' } },
        ...(recording === undefined ? {} : { services: { recording } }),
      }
      await writeFile(configPath, stringifyYaml(source))
      const response = await invokeRoute('/api/config', { headers: { host: SELF_HOST_HEADERS.host } })
      expect(response.status).toBe(200)
      const authored = JSON.parse(response.body).config
      expect(authored).toEqual(source)
      expect(AgentQaConfigSchema.parse(authored).services?.recording)
        .toEqual({ enabled: true, ...recording })
      const section = authored.services?.recording as Record<string, unknown> | undefined
      // The no-op save re-sends each authored leaf as it stands; an absent block is unset again.
      const noOp = section === undefined
        ? [{ op: 'unset', path: ['services', 'recording'] }]
        : Object.keys(section).length === 0
          ? [{ op: 'set', path: ['services', 'recording'], value: {} }]
          : Object.entries(section).map(([key, value]) => ({ op: 'set', path: ['services', 'recording', key], value }))
      for (const changes of [noOp, [{ op: 'set', path: ['services', 'logging', 'level'], value: 'warn' }]]) {
        expect((await patchConfig(changes)).status).toBe(200)
        const saved = parseYaml(await readFile(configPath, 'utf8'))
        expect(saved.services?.recording).toEqual(recording)
        expect(AgentQaConfigSchema.parse(saved).services?.recording)
          .toEqual({ enabled: true, ...recording })
      }
      const beforeInvalid = await readFile(configPath, 'utf8')
      // 429-44: the door refuses a path the schema does not describe; inside a container value
      // the same key still meets whole-config validation.
      const invalid = await patchConfig([{ op: 'set', path: ['services', 'recording', 'videoDir'], value: 'videos' }])
      expect(invalid.status).toBe(422)
      expect(JSON.parse(invalid.body)).toEqual({ error: 'path_not_writable' })
      const nested = await patchConfig([{ op: 'set', path: ['services', 'recording'], value: { videoDir: 'videos' } }])
      expect(nested.status).toBe(422)
      expect(JSON.parse(nested.body)).toMatchObject({ error: 'validation_failed' })
      expect(await readFile(configPath, 'utf8')).toBe(beforeInvalid)
    },
  )

  describe('key ordering preservation', () => {
    beforeEach(async () => {
      await writeFile(configPath, ORDERED_CONFIG)
    })

    it('applyChanges preserves key position in YAML', async () => {
      expect((await manager.applyChanges([
        { op: 'set', path: ['use', 'timeout'], value: { step: '45s', test: '10m', navigation: '10s' } },
      ])).kind).toBe('ok')
      const content = await readFile(configPath, 'utf-8')
      const timeoutIdx = content.indexOf('timeout:')
      const llmIdx = content.indexOf('llm:')
      expect(timeoutIdx).toBeGreaterThan(-1)
      expect(llmIdx).toBeGreaterThan(-1)
      expect(timeoutIdx).toBeLessThan(llmIdx)
      expect(content).toContain('step: 45s')
    })

    it('applyChanges preserves scalar key position', async () => {
      expect((await manager.applyChanges([{ op: 'set', path: ['use', 'llm'], value: 'claude-sonnet' }])).kind).toBe('ok')
      const content = await readFile(configPath, 'utf-8')
      const timeoutIdx = content.indexOf('timeout:')
      const llmIdx = content.indexOf('llm: claude-sonnet')
      expect(timeoutIdx).toBeGreaterThan(-1)
      expect(timeoutIdx).toBeLessThan(llmIdx)
      // llm should still be inside the use block, not at root
      expect(content).not.toMatch(/^use\.llm:/m)
      expect(content).toMatch(/^\s+llm: claude-sonnet/m)
    })

    it('applyChanges for services.cache keeps it before use block', async () => {
      expect((await manager.applyChanges([
        { op: 'set', path: ['services', 'cache'], value: { dir: '.new-cache' } },
      ])).kind).toBe('ok')
      const content = await readFile(configPath, 'utf-8')
      const servicesIdx = content.indexOf('services:')
      const useIdx = content.indexOf('use:')
      expect(content).toContain('dir: .new-cache')
      expect(servicesIdx).toBeLessThan(useIdx)
    })

    it('applyChanges persists the knowledge block as one unit', async () => {
      expect((await manager.applyChanges([
        { op: 'set', path: ['knowledge'], value: { dir: 'agent-qa-knowledge' } },
      ])).kind).toBe('ok')

      const config = await readConfig()
      expect(config.knowledge).toMatchObject({
        dir: 'agent-qa-knowledge',
      })
    })

    it('applyChanges for array preserves position', async () => {
      expect((await manager.applyChanges([
        { op: 'set', path: ['workspace', 'testMatch'], value: ['tests/web/**/*.yaml', 'tests/mobile/**/*.yaml'] },
      ])).kind).toBe('ok')
      const content = await readFile(configPath, 'utf-8')
      const workspaceIdx = content.indexOf('workspace:')
      const servicesIdx = content.indexOf('services:')
      const testMatchIdx = content.indexOf('testMatch:')
      expect(content).toContain('tests/mobile/**/*.yaml')
      expect(testMatchIdx).toBeGreaterThan(workspaceIdx)
      expect(testMatchIdx).toBeLessThan(servicesIdx)
    })
  })

  describe('segment path handling', () => {
    beforeEach(async () => {
      await writeFile(configPath, ORDERED_CONFIG)
    })

    it('applyChanges writes a nested key from its segment path', async () => {
      expect((await manager.applyChanges([{ op: 'set', path: ['services', 'dashboard', 'port'], value: 4000 }])).kind).toBe('ok')
      const config = await readConfig()
      expect(config.services.dashboard.port).toBe(4000)
    })

    it('applyChanges writes a nested scalar and never a dotted top-level key', async () => {
      expect((await manager.applyChanges([{ op: 'set', path: ['use', 'llm'], value: 'new-model' }])).kind).toBe('ok')
      const config = await readConfig()
      expect(config.use.llm).toBe('new-model')
      // must not create a literal "use.llm" top-level key
      expect(Object.keys(config)).not.toContain('use.llm')
    })

    it('applyChanges unset removes a nested path without deleting nested browser settings', async () => {
      await writeFile(configPath, [
        ...WRITE_BASE_LINES,
        'use:',
        '  headless: true',
        '  browser:',
        '    name: chromium',
        '    headless: false',
        '    viewport:',
        '      width: 1280',
        '      height: 720',
        '  mobile:',
        '    appState: preserve',
        '',
      ].join('\n'))

      expect((await manager.applyChanges([{ op: 'unset', path: ['use', 'headless'] }])).kind).toBe('ok')

      const config = await readConfig()
      expect(config.use.headless).toBeUndefined()
      expect(config.use.browser).toMatchObject({
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
      await writeFile(configPath, ORDERED_CONFIG)
      expect((await manager.applyChanges([{ op: 'set', path: ['use', 'llm'], value: 'claude-sonnet' }])).kind).toBe('ok')
      const content = await readFile(configPath, 'utf-8')
      expect(content).toContain('# Test config')
    })
  })
})

const WRITE_BASE_LINES = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

const WRITE_MODELS_LINES = [
  'registry:',
  '  llms:',
  '    - name: planner',
  '      provider: openai-compatible',
  '      model: openrouter/auto',
  '      baseURL: https://openrouter.ai/api/v1',
  '    - name: gpt-5.6',
  '      provider: openai-compatible',
  '      model: gpt-5.6-base',
  '      baseURL: https://api.example.test/v1',
]

const WRITE_USE_LINES = [
  'use:',
  '  llm: planner',
  '  mobile:',
  '    appState: preserve',
]

const WRITE_MOBILE_LINES = ['use:', '  mobile:', '    appState: preserve']

function writeConfig(...blocks: string[][]): string {
  return [...blocks.flat(), ''].join('\n')
}

type LlmEntry = { name: string; model: string }

function llmsOf(text: string): LlmEntry[] {
  return (parseYaml(text) as { registry: { llms: LlmEntry[] } }).registry.llms
}

describe('ConfigManager.applyChanges ops and selectors (429-05)', () => {
  it('UNSET-PRUNES-EMPTY-PARENTS: an unset prunes every ancestor map it empties, and keeps a sibling', async () => {
    await writeFile(configPath, writeConfig(
      WRITE_BASE_LINES,
      ['services:', '  recording:', '    keepFailuresOnly: true'],
      WRITE_MOBILE_LINES,
    ))

    const pruned = await manager.applyChanges([
      { op: 'unset', path: ['services', 'recording', 'keepFailuresOnly'] },
    ])

    expect(pruned.kind).toBe('ok')
    const afterPrune = parseYaml(await readFile(configPath, 'utf-8')) as Record<string, unknown>
    expect(afterPrune).not.toHaveProperty('services')

    await writeFile(configPath, writeConfig(
      WRITE_BASE_LINES,
      ['services:', '  recording:', '    keepFailuresOnly: true', '    enabled: true'],
      WRITE_MOBILE_LINES,
    ))

    const kept = await manager.applyChanges([
      { op: 'unset', path: ['services', 'recording', 'keepFailuresOnly'] },
    ])

    expect(kept.kind).toBe('ok')
    const afterKeep = parseYaml(await readFile(configPath, 'utf-8')) as { services: { recording: unknown } }
    expect(afterKeep.services.recording).toEqual({ enabled: true })
  })

  it('APPEND-CREATES-SEQ: an append to an absent sequence creates it with one entry', async () => {
    await writeFile(configPath, writeConfig(WRITE_BASE_LINES, WRITE_MOBILE_LINES))

    // 432-22: re-spelled from the deleted `services.mcp.tokens` list onto a retained absent sequence.
    const outcome = await manager.applyChanges([
      { op: 'append', path: ['workspace', 'testPathIgnore'], value: 'tests/skip/**' },
    ])

    expect(outcome.kind).toBe('ok')
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { workspace: { testPathIgnore: unknown[] } }
    expect(parsed.workspace.testPathIgnore).toEqual(['tests/skip/**'])
  })

  it('NAME-SELECTOR-RESOLVES: a { name } segment changes only that entry', async () => {
    await writeFile(configPath, writeConfig(WRITE_BASE_LINES, WRITE_MODELS_LINES, WRITE_USE_LINES))

    const outcome = await manager.applyChanges([
      { op: 'set', path: ['registry', 'llms', { name: 'gpt-5.6' }, 'model'], value: 'gpt-5.6-pro' },
    ])

    expect(outcome.kind).toBe('ok')
    expect(llmsOf(await readFile(configPath, 'utf-8')).map(({ name, model }) => [name, model])).toEqual([
      ['planner', 'openrouter/auto'],
      ['gpt-5.6', 'gpt-5.6-pro'],
    ])
  })

  it('REORDERED-SEQ-HITS-RIGHT-ENTRY: after an outside reorder the same change still hits gpt-5.6', async () => {
    const reversed = [
      'registry:',
      '  llms:',
      ...WRITE_MODELS_LINES.slice(6),
      ...WRITE_MODELS_LINES.slice(2, 6),
    ]
    await writeFile(configPath, writeConfig(WRITE_BASE_LINES, reversed, WRITE_USE_LINES))

    const outcome = await manager.applyChanges([
      { op: 'set', path: ['registry', 'llms', { name: 'gpt-5.6' }, 'model'], value: 'gpt-5.6-pro' },
    ])

    expect(outcome.kind).toBe('ok')
    expect(llmsOf(await readFile(configPath, 'utf-8')).map(({ name, model }) => [name, model])).toEqual([
      ['gpt-5.6', 'gpt-5.6-pro'],
      ['planner', 'openrouter/auto'],
    ])
  })

  it('NAME-SELECTOR-MISSING-REFUSED: an unknown name, or a { name } outside a named array, refuses and writes nothing', async () => {
    await writeFile(configPath, writeConfig(WRITE_BASE_LINES, WRITE_MODELS_LINES, WRITE_USE_LINES))
    const before = await readFile(configPath)

    const missing = await manager.applyChanges([
      { op: 'set', path: ['registry', 'llms', { name: 'missing' }, 'model'], value: 'x' },
    ])
    const outside = await manager.applyChanges([
      { op: 'set', path: ['workspace', 'testMatch', { name: 'tests/**/*.yaml' }], value: 'x' },
    ])

    expect(missing).toEqual({ kind: 'refused', error: 'path_not_found' })
    expect(outside).toEqual({ kind: 'refused', error: 'path_not_found' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

    // The control: the same selector on a name that is present resolves, so the refusal above
    // is about the missing entry and not about { name } segments as such.
    const present = await manager.applyChanges([
      { op: 'set', path: ['registry', 'llms', { name: 'gpt-5.6' }, 'model'], value: 'gpt-5.6-pro' },
    ])
    expect(present.kind).toBe('ok')
  })

  it('LEGACY-HEADLESS-MIGRATED: setting use.browser.headless removes a root use.headless in the same write', async () => {
    await writeFile(configPath, writeConfig(
      WRITE_BASE_LINES,
      ['use:', '  headless: true', '  browser:', '    name: chromium', '  mobile:', '    appState: preserve'],
    ))

    const outcome = await manager.applyChanges([
      { op: 'set', path: ['use', 'browser', 'headless'], value: false },
    ])

    expect(outcome.kind).toBe('ok')
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { use: Record<string, unknown> }
    expect(parsed.use.browser).toEqual({ name: 'chromium', headless: false })
    expect(parsed.use).not.toHaveProperty('headless')
  })
})

const BROKEN_YAML = 'a: 1\nb: [1, 2\nc: 3\n'

describe('ConfigManager broken files, missing files and the mask guard (429-05)', () => {
  it('FILE-INVALID-REFUSED: a file that does not parse is refused and never rewritten', async () => {
    await writeFile(configPath, BROKEN_YAML)

    const outcome = await manager.applyChanges([
      { op: 'set', path: ['use', 'mobile', 'appState'], value: 'preserve' },
    ])

    expect(outcome).toEqual({ kind: 'refused', error: 'file_invalid' })
    expect(await readFile(configPath, 'utf-8')).toBe(BROKEN_YAML)
  })

  it('READ-REFUSES-BROKEN-FILE: a revisioned read names a broken file instead of serving part of it', async () => {
    await writeFile(configPath, BROKEN_YAML)
    const broken = await manager.readWithRevision()
    expect(broken.kind).toBe('file_invalid')
    expect(broken.kind === 'file_invalid' ? broken.message : '').not.toBe('')

    const valid = writeConfig(WRITE_BASE_LINES, WRITE_MOBILE_LINES)
    await writeFile(configPath, valid)
    expect(await manager.readWithRevision()).toEqual({
      kind: 'ok',
      config: parseYaml(valid),
      raw: valid,
      revision: createHash('sha256').update(valid).digest('hex'),
    })

    await rm(configPath)
    expect(await manager.readWithRevision()).toEqual({ kind: 'absent' })
  })

  it('ENOENT-STARTS-EMPTY-DOCUMENT: a missing file is built through the same path, with no dotted top-level key', async () => {
    await rm(configPath)

    await expect(manager.applyChanges([
      {
        op: 'set',
        path: ['workspace'],
        value: {
          testMatch: ['tests/**/*.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
      },
      { op: 'set', path: ['use', 'timeout', 'step'], value: '30s' },
      { op: 'set', path: ['use', 'timeout', 'test'], value: '10m' },
      { op: 'set', path: ['use', 'timeout', 'navigation'], value: '10s' },
      { op: 'set', path: ['use', 'mobile', 'appState'], value: 'preserve' },
    ])).resolves.toMatchObject({ kind: 'ok' })

    const text = await readFile(configPath, 'utf-8')
    expect((parseYaml(text) as { use: { timeout: unknown } }).use.timeout)
      .toEqual({ step: '30s', test: '10m', navigation: '10s' })
    expect(text).not.toMatch(/^use\.timeout:/m)
  })
})

describe('dashboard compatible auth routes', () => {
  it('stores openai-compatible API keys under the named LLM config key', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        configName: 'planner',
        type: 'api-key',
        secret: 'sk-router',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ saved: true, created: true })
    expect(mockWriteAuth).toHaveBeenCalledWith('planner', {
      type: 'api',
      provider: 'openai-compatible',
      key: 'sk-router',
    })
  })

  it('rejects openai-compatible API key saves without configName', async () => {
    const res = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
      { kind: 'none' },
      expect.any(Function),
    )
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
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
      { kind: 'none' },
      expect.any(Function),
    )
  })

  it('keeps the no-key compatible indicator when the provider rejects auth', async () => {
    const providerError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockGenerateText.mockRejectedValue(providerError)

    const res = await invokeRoute('/api/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
      headers: { 'content-type': 'application/json', host: '127.0.0.1:4317' },
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
    expect(mockCreateModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'openrouter/auto',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
      { kind: 'none' },
      expect.any(Function),
    )
  })
})

function declaredMask(value: string, name: string): (text: string) => string {
  return (text) => text.split(value).join(`[secret:${name}]`)
}

describe('ConfigManager masked read (441-21)', () => {
  it('READ-MASKED-ALIASES-FAIL-CLOSED: an alias never carries a declared value past the mask', async () => {
    await writeFile(configPath, [
      'workspace:',
      '  secretsFile: &secret secret-DO-NOT-LEAK.local',
      '  envFile: &plain plain-anchor.env',
      'knowledge:',
      '  dir: *secret',
      'registry:',
      '  llms:',
      '    - name: router',
      '      provider: anthropic-compatible',
      '      model: claude-proxy',
      '      baseURL: https://llm.example.invalid/v1',
      '      providerHeaders:',
      '        x-access: *plain',
      '',
    ].join('\n'))

    const read = await new ConfigManager(configPath, declaredMask('DO-NOT-LEAK', 'LEAK')).readMasked()

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    const config = read.config as { workspace: Record<string, string>; knowledge: { dir: string }; registry: any }
    expect(config.workspace.secretsFile).toBe('secret-[secret:LEAK].local')
    expect(config.knowledge.dir).toBe('secret-[secret:LEAK].local')
    expect(config.registry.llms[0].providerHeaders['x-access']).toBe('plain-anchor.env')
    expect(config.workspace.envFile).toBe('plain-anchor.env')
    expect(JSON.stringify(read)).not.toContain('DO-NOT-LEAK')
  })
})

describe('C441-CONFIG', () => {
  it('the config editor shows an undeclared credential as written and a declared value as its marker', async () => {
    await writeFile(configPath, [
      'registry:',
      '  llms:',
      '    - name: router',
      '      provider: anthropic-compatible',
      '      model: claude',
      '      baseURL: https://example.test/v1',
      '      providerHeaders:',
      '        X-Api-Key: plain-441-value',
      'use:',
      '  buildTag: Hunter-42-zz',
      '',
    ].join('\n'))

    const read = await new ConfigManager(configPath, declaredMask('Hunter-42-zz', 'PW_441')).readMasked()

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    const config = read.config as { registry: { llms: Array<{ providerHeaders: Record<string, string> }> }; use: Record<string, unknown> }
    expect(config.registry.llms[0]!.providerHeaders['X-Api-Key']).toBe('plain-441-value')
    expect(config.use.buildTag).toBe('[secret:PW_441]')
    expect(read.lines).toContainEqual({ n: 8, text: '        X-Api-Key: plain-441-value' })
    expect(read.lines).toContainEqual({ n: 10, text: '  buildTag: [secret:PW_441]' })
    expect(read.lines.every((line) => !('class' in line))).toBe(true)
    expect(JSON.stringify(read)).not.toContain('Hunter-42-zz')
  })

  it('a validation message shows a declared value as its marker', async () => {
    const declared = new ConfigManager(configPath, declaredMask('Hunter-42-zz', 'PW_441'))
    await writeFile(configPath, ORDERED_CONFIG.replace('  llm: planner', '  llm: Hunter-42-zz'))

    const read = await declared.readMasked()

    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    const readMessages = read.fileIssues.map((issue) => issue.message)
    expect(JSON.stringify(read.fileIssues)).not.toContain('Hunter-42-zz')
    expect(readMessages.some((message) => message.includes('[secret:PW_441]')), JSON.stringify(readMessages)).toBe(true)

    await writeFile(configPath, ORDERED_CONFIG)
    const refused = await declared.applyChanges([{ op: 'set', path: ['use', 'llm'], value: 'Hunter-42-zz' }])
    expect(refused.kind).toBe('refused')
    if (refused.kind !== 'refused') return
    const writeMessages = (refused.issues ?? []).map((issue) => issue.message)
    expect(JSON.stringify(refused)).not.toContain('Hunter-42-zz')
    expect(writeMessages.some((message) => message.includes('[secret:PW_441]')), JSON.stringify(writeMessages)).toBe(true)

    await writeFile(configPath, ORDERED_CONFIG.replace('  llm: planner', '  llm: q7'))
    const short = await declared.readMasked()
    expect(short.kind).toBe('ok')
    if (short.kind !== 'ok') return
    expect(short.fileIssues.some((issue) => issue.message.includes('q7')), JSON.stringify(short.fileIssues)).toBe(true)

    await writeFile(configPath, 'a: b: compact\n')
    const broken = await new ConfigManager(configPath, declaredMask('compact', 'PW_441')).readMasked()
    expect(broken.kind).toBe('file_invalid')
    if (broken.kind !== 'file_invalid') return
    expect(broken.message).toContain('[secret:PW_441]')
    expect(broken.message).not.toContain('compact')
    const unloadable = await new ConfigManager(configPath, () => { throw new Error('a: b: compact') }).readMasked()
    expect(unloadable).toMatchObject({ kind: 'file_invalid', message: 'The config file is not valid YAML.' })
  })

  it('there is no reveal route', async () => {
    await writeFile(configPath, ORDERED_CONFIG.replace(
      'registry:\n  llms:\n',
      'registry:\n  llms:\n    - name: router\n      provider: anthropic-compatible\n      model: claude-proxy\n'
        + '      baseURL: https://llm.example.invalid/v1\n      providerHeaders:\n        x-access: Hunter-42-zz\n',
    ))

    // Composed, so no package source spells the retired route (441-49's grep).
    const answer = await invokeRoute(['/api/config', 'reveal'].join('/'), {
      method: 'POST',
      headers: { ...SELF_HOST_HEADERS, origin: `http://${SELF_HOST_HEADERS.host}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ path: ['registry', 'llms', 0, 'providerHeaders', 'x-access'] }),
    })

    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toEqual({ error: 'Not found' })
    expect(answer.body).not.toContain('Hunter-42-zz')
  })
})

// 2026-09-30, 432-07 D-05/D-07 (EDGE-12): the transaction queue belongs to the resolved config path,
// so every ConfigManager in this process (the dashboard's and a co-hosted direct writer's) takes
// turns. It is not a cross-process lock.
describe('C432-CONFIG-PATH-QUEUE: co-hosted writers of one config path share one queue', () => {
  const QUEUE_CONFIG = writeConfig(
    ['# The owner keeps this comment.'],
    WRITE_BASE_LINES,
    WRITE_MODELS_LINES,
    WRITE_USE_LINES,
  )

  type Targets = Record<string, { platform: string; url: string }>

  function targetsOf(text: string): Targets {
    return (parseYaml(text) as { registry: { targets?: Targets } }).registry.targets ?? {}
  }

  function targetChange(index: number) {
    return {
      op: 'set' as const,
      path: ['registry', 'targets', `t${index}`],
      value: { platform: 'web', url: `http://127.0.0.1:${4100 + index}/` },
    }
  }

  beforeEach(async () => {
    await writeFile(configPath, QUEUE_CONFIG)
  })

  it('two managers, one through a directory alias, merge every overlapping disjoint write', async () => {
    const alias = `${dir}-alias`
    await symlink(dir, alias)
    try {
      const first = new ConfigManager(configPath, (text) => text)
      const second = new ConfigManager(join(alias, 'agent-qa.config.yaml'), (text) => text)
      const outcomes = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          (index % 2 === 0 ? first : second).applyChanges([targetChange(index)])),
      )
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(Array.from({ length: 24 }, () => 'ok'))
      const saved = await readFile(configPath, 'utf-8')
      expect(Object.keys(targetsOf(saved)).sort()).toEqual(
        Array.from({ length: 24 }, (_, index) => `t${index}`).sort(),
      )
      expect(saved).toContain('# The owner keeps this comment.')
    } finally {
      await rm(alias, { force: true })
    }
  })

  it('a stale same-field expectation from the second writer refuses once the first has changed it', async () => {
    const first = new ConfigManager(configPath, (text) => text)
    const second = new ConfigManager(configPath, (text) => text)
    const [landed, stale] = await Promise.all([
      first.applyChanges([
        { op: 'expect', path: ['use', 'llm'], value: 'planner' },
        { op: 'set', path: ['use', 'llm'], value: 'gpt-5.6' },
      ]),
      second.applyChanges([
        { op: 'expect', path: ['use', 'llm'], value: 'planner' },
        { op: 'set', path: ['use', 'llm'], value: 'planner' },
        targetChange(1),
      ]),
    ])
    expect(landed.kind).toBe('ok')
    expect(stale).toEqual({ kind: 'refused', error: 'field_changed', path: ['use', 'llm'] })
    const saved = parseYaml(await readFile(configPath, 'utf-8')) as { use: { llm: string } }
    expect(saved.use.llm).toBe('gpt-5.6')
    expect(targetsOf(await readFile(configPath, 'utf-8'))).toEqual({})
  })

  it('a transaction that fails releases the queue for the writers behind it', async () => {
    const { serializeConfigWrite } = await import('../config/config-manager.js')
    expect(typeof serializeConfigWrite).toBe('function')
    const failed = serializeConfigWrite(configPath, async () => {
      throw new Error('queued failure')
    })
    const successor = new ConfigManager(configPath, (text) => text).applyChanges([targetChange(2)])
    await expect(failed).rejects.toThrow('queued failure')
    expect((await successor).kind).toBe('ok')
    expect(Object.keys(targetsOf(await readFile(configPath, 'utf-8')))).toEqual(['t2'])
  })

  it('a queued write reads the file inside its turn, so an outside edit made while it waited survives', async () => {
    const { serializeConfigWrite } = await import('../config/config-manager.js')
    expect(typeof serializeConfigWrite).toBe('function')
    let release!: () => void
    const held = serializeConfigWrite(configPath, () => new Promise<void>((resolve) => { release = resolve }))
    const queued = manager.applyChanges([targetChange(3)])
    const outside = QUEUE_CONFIG.replace('appState: preserve', 'appState: reset') + '# Added outside.\n'
    await writeFile(configPath, outside)
    release()
    await held
    const outcome = await queued
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    const saved = await readFile(configPath, 'utf-8')
    expect(outcome.baseRevision).toBe(createHash('sha256').update(outside).digest('hex'))
    expect(saved).toContain('appState: reset')
    expect(saved).toContain('# Added outside.')
    expect(Object.keys(targetsOf(saved))).toEqual(['t3'])
  })

  it('dashboard Undo still restores its own field after a co-hosted writer changed a different one', async () => {
    const dashboard = new ConfigManager(configPath, (text) => text)
    const coHosted = new ConfigManager(configPath, (text) => text)
    const change = await dashboard.applyChanges(
      [{ op: 'set', path: ['use', 'mobile', 'appState'], value: 'reset' }],
      { capturePriors: true },
    )
    expect(change.kind).toBe('ok')
    if (change.kind !== 'ok' || change.priors === undefined) throw new Error('fixture: priors')
    expect((await coHosted.applyChanges([targetChange(4)])).kind).toBe('ok')
    expect(await dashboard.restorePriors(change.priors)).toMatchObject({ kind: 'ok' })
    const saved = await readFile(configPath, 'utf-8')
    expect(saved).toContain('appState: preserve')
    expect(Object.keys(targetsOf(saved))).toEqual(['t4'])
    expect(saved).toContain('# The owner keeps this comment.')
  })

  it('the PATCH autosave route and a co-hosted writer overlap on one path and every change lands', async () => {
    const coHosted = new ConfigManager(configPath, (text) => text)
    const [llm, appState, ...targets] = await Promise.all([
      patchConfig([{ op: 'set', path: ['use', 'llm'], value: 'gpt-5.6' }]),
      patchConfig([{ op: 'set', path: ['use', 'mobile', 'appState'], value: 'reset' }]),
      ...Array.from({ length: 10 }, (_, index) => coHosted.applyChanges([targetChange(10 + index)])),
    ])
    expect([llm.status, appState.status], llm.body + appState.body).toEqual([200, 200])
    expect(targets.map((outcome) => outcome.kind)).toEqual(Array.from({ length: 10 }, () => 'ok'))
    const saved = await readFile(configPath, 'utf-8')
    const parsed = parseYaml(saved) as { use: { llm: string; mobile: { appState: string } } }
    expect(parsed.use).toMatchObject({ llm: 'gpt-5.6', mobile: { appState: 'reset' } })
    expect(Object.keys(targetsOf(saved)).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `t${10 + index}`).sort(),
    )
  })

  it('a write that fails inside its turn rejects, writes nothing, and the next writer still gets the path', async () => {
    // The temp file is written and only its rename fails, so the cleanup that keeps "writes
    // nothing" true is on the measured road (WR-12).
    fsFault.failRename = true
    try {
      const failed = new ConfigManager(configPath, (text) => text).applyChanges([targetChange(6)])
      await expect(failed).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      fsFault.failRename = false
    }
    expect(await readFile(configPath, 'utf-8')).toBe(QUEUE_CONFIG)
    expect((await manager.applyChanges([targetChange(7)])).kind).toBe('ok')
    expect(Object.keys(targetsOf(await readFile(configPath, 'utf-8')))).toEqual(['t7'])
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp')), 'the failed write left its temp file')
      .toEqual([])
  })

  it('a whole-document replacement publishes only over the revision it was built from', async () => {
    const replacement = new TextEncoder().encode(QUEUE_CONFIG.replace('llm: planner', 'llm: gpt-5.6'))
    const current = createHash('sha256').update(QUEUE_CONFIG).digest('hex')
    expect(await manager.replaceDocument('absent', replacement)).toEqual({
      kind: 'refused', error: 'file_changed', revision: current,
    })
    expect(await manager.replaceDocument('0'.repeat(64), replacement)).toEqual({
      kind: 'refused', error: 'file_changed', revision: current,
    })
    expect(await readFile(configPath, 'utf-8')).toBe(QUEUE_CONFIG)
    expect(await manager.replaceDocument(current, replacement)).toEqual({
      kind: 'ok', baseRevision: current, revision: createHash('sha256').update(replacement).digest('hex'),
    })
    expect(await readFile(configPath, 'utf-8')).toBe(QUEUE_CONFIG.replace('llm: planner', 'llm: gpt-5.6'))

    const created = join(dir, 'nested', 'hooks.yaml')
    expect(await new ConfigManager(created, (text) => text).replaceDocument('absent', new TextEncoder().encode('hooks: []\n')))
      .toMatchObject({ kind: 'ok', baseRevision: 'absent' })
    expect(await readFile(created, 'utf-8')).toBe('hooks: []\n')
  })

  it('a queued write through a symlinked config keeps the link, the destination mode and the comments', async () => {
    const realPath = join(dir, 'real.config.yaml')
    const linkPath = join(dir, 'linked.config.yaml')
    await writeFile(realPath, QUEUE_CONFIG)
    await chmod(realPath, 0o600)
    await symlink(realPath, linkPath)
    const outcome = await new ConfigManager(linkPath, (text) => text).applyChanges([targetChange(5)])
    expect(outcome.kind).toBe('ok')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    expect((await stat(realPath)).mode & 0o777).toBe(0o600)
    const saved = await readFile(realPath, 'utf-8')
    expect(saved).toContain('# The owner keeps this comment.')
    expect(Object.keys(targetsOf(saved))).toEqual(['t5'])
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
