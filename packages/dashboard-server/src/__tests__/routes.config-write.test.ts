import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { ConfigFileInvalidError, ConfigManager, readConfigValues } from '../config/index.js'
import { createRouter } from '../server/routes.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  }
})

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    getAgentQaVersion: vi.fn(() => '0.1.13'),
    readAuth: vi.fn(() => ({})),
    writeAuth: vi.fn(() => Promise.resolve()),
    removeAuth: vi.fn(() => Promise.resolve()),
  }
})

const mockRename = vi.mocked(rename)
const mockWriteFile = vi.mocked(writeFile)

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const HOST = '127.0.0.1:4317'

let router: ReturnType<typeof createRouter>
const tempDirs: string[] = []

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
  req.headers = { host: '127.0.0.1:3470', ...options.headers }

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
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode: number, head?: Record<string, string | number>) {
        status = statusCode
        if (head) {
          for (const [key, value] of Object.entries(head)) {
            headers.set(key.toLowerCase(), String(value))
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

const baseConfig = [
  '# owner notes: keep the step timeout generous on CI',
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'services: {}',
  'registry: {}',
  'use:',
  '  timeout:',
  '    step: 30s',
  '    test: 10m',
  '    navigation: 10s',
  '  browser:',
  '    name: chromium',
  '    headless: false',
  '  mobile:',
  '    appState: preserve',
  '',
].join('\n')

async function createConfigWorkspace(initialConfig = baseConfig): Promise<{
  configManager: ConfigManager
  configPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-config-write-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, initialConfig, 'utf-8')
  return { configManager: new ConfigManager(configPath, (text) => text), configPath }
}

async function useConfigWorkspace(initialConfig = baseConfig): Promise<string> {
  const { configManager, configPath } = await createConfigWorkspace(initialConfig)
  router = createRouter({
    db: createMockDatabase() as any,
    configManager,
    configPath,
  })
  return configPath
}

function patchConfig(body: unknown, headers: IncomingHttpHeaders = {}): Promise<MockResponse> {
  return invokeRoute('/api/config', {
    method: 'PATCH',
    headers: { host: HOST, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const setStep = (value: unknown) => ({
  changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value }],
})

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('PATCH /api/config', () => {
  it('FIELD-MERGE: an outside edit and a human autosave both survive, comments kept', async () => {
    const configPath = await useConfigWorkspace()
    const outside = (await readFile(configPath, 'utf-8')).replace('headless: false', 'headless: true')
    await writeFile(configPath, outside, 'utf-8')

    const response = await patchConfig(setStep('45s'))

    expect(response.status).toBe(200)
    const text = await readFile(configPath, 'utf-8')
    const parsed = parseYaml(text) as { use: { browser: { headless: boolean }; timeout: Record<string, string> } }
    expect(parsed.use.browser.headless).toBe(true)
    expect(parsed.use.timeout).toEqual({ step: '45s', test: '10m', navigation: '10s' })
    expect(text).toContain('# owner notes: keep the step timeout generous on CI')
  })

  it('PATCH-ONE-ATOMIC-WRITE: one rename onto the config path per request, no direct write', async () => {
    const configPath = await useConfigWorkspace()
    mockRename.mockClear()
    mockWriteFile.mockClear()

    const response = await patchConfig(setStep('45s'))

    expect(response.status).toBe(200)
    expect(mockRename).toHaveBeenCalledTimes(1)
    expect(mockRename.mock.calls[0]?.[1]).toBe(configPath)
    expect(mockWriteFile.mock.calls.some(([target]) => target === configPath)).toBe(false)
  })

  it('INVALID-MERGE-KEEPS-BYTES: a merge that fails whole-config validation answers 422 and writes nothing', async () => {
    const configPath = await useConfigWorkspace()
    const before = await readFile(configPath)
    mockRename.mockClear()

    const response = await patchConfig(setStep(123))

    expect(response.status).toBe(422)
    const body = JSON.parse(response.body) as { error: string; issues: Array<{ path: Array<string | number>; message: string }> }
    expect(body.error).toBe('validation_failed')
    expect(body.issues.some((issue) => issue.path[0] === 'use' && issue.path[1] === 'timeout')).toBe(true)
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()
  })

  it('PATCH-CROSS-SITE-REFUSED: a cross-site caller is refused before the body is read, with no CORS grant', async () => {
    const configPath = await useConfigWorkspace()
    const before = await readFile(configPath)

    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await patchConfig(setStep('45s'), headers)
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body)).toEqual({ error: 'cross_site_refused' })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

    const ok = await patchConfig(setStep('45s'), { origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })
    expect(ok.status).toBe(200)
    expect(ok.headers['access-control-allow-origin']).toBeUndefined()
    const invalid = await patchConfig(setStep(123))
    expect(invalid.status).toBe(422)
    expect(invalid.headers['access-control-allow-origin']).toBeUndefined()
    const malformed = await patchConfig({ changes: [{ op: 'set', path: 'use.timeout.step', value: '1s' }] })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid_write_input' })
    expect(malformed.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('PATCH-RETURNS-REVISION: the answer carries the sha256 of the bytes now on disk', async () => {
    const configPath = await useConfigWorkspace()

    const response = await patchConfig(setStep('45s'))

    expect(response.status).toBe(200)
    const onDisk = await readFile(configPath)
    expect(JSON.parse(response.body)).toEqual({
      revision: createHash('sha256').update(onDisk).digest('hex'),
      baseRevision: createHash('sha256').update(baseConfig).digest('hex'),
    })
  })

  // The answer names the bytes the write merged onto, so a page sees it absorbed an outside edit.
  it('BASE-REVISION-ANSWERED: the answer carries the sha256 of the bytes the write merged onto', async () => {
    const configPath = await useConfigWorkspace()
    const outside = Buffer.from(baseConfig.replace('headless: false', 'headless: true'), 'utf-8')
    await writeFile(configPath, outside)

    const response = await patchConfig(setStep('45s'))

    expect(response.status).toBe(200)
    const onDisk = await readFile(configPath)
    const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
    expect(JSON.parse(response.body)).toEqual({ revision: sha(onDisk), baseRevision: sha(outside) })
    expect(sha(outside)).not.toBe(sha(baseConfig))

    await rm(configPath)
    const whole = parseYaml(baseConfig) as Record<string, unknown>
    const absent = await patchConfig({
      changes: Object.entries(whole).map(([key, value]) => ({ op: 'set', path: [key], value })),
    })
    expect(absent.status, absent.body).toBe(200)
    expect(JSON.parse(absent.body)).toEqual({ revision: sha(await readFile(configPath)), baseRevision: 'absent' })
  })
})

describe('PATCH /api/config concurrency, idempotency and file identity', () => {
  it('TWO-SETTLES-BOTH-LAND: two PATCH requests started together both reach the file', async () => {
    const configPath = await useConfigWorkspace()

    const [step, headless] = await Promise.all([
      patchConfig(setStep('45s')),
      patchConfig({ changes: [{ op: 'set', path: ['use', 'browser', 'headless'], value: true }] }),
    ])

    expect([step.status, headless.status]).toEqual([200, 200])
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as {
      use: { timeout: { step: string }; browser: { headless: boolean } }
    }
    expect(parsed.use.timeout.step).toBe('45s')
    expect(parsed.use.browser.headless).toBe(true)
  })

  it('APPLY-TWICE-IDEMPOTENT: the same change set twice leaves the same bytes and the same revision', async () => {
    const configPath = await useConfigWorkspace()
    const body = {
      changes: [
        { op: 'set', path: ['use', 'timeout', 'step'], value: '45s' },
        { op: 'set', path: ['use', 'browser', 'headless'], value: true },
      ],
    }

    const first = await patchConfig(body)
    const afterFirst = await readFile(configPath)
    const second = await patchConfig(body)

    expect([first.status, second.status]).toEqual([200, 200])
    expect(Buffer.compare(await readFile(configPath), afterFirst)).toBe(0)
    const [one, two] = [first, second].map((response) => JSON.parse(response.body) as { revision: string; baseRevision: string })
    expect(two!.revision).toBe(one!.revision)
    // The second write merged onto exactly what the first one wrote.
    expect(two!.baseRevision).toBe(one!.revision)
  })

  it('MODE-PRESERVED: the rewritten file keeps the mode the owner gave it', async () => {
    const configPath = await useConfigWorkspace()

    for (const [mode, step] of [[0o640, '45s'], [0o664, '50s']] as const) {
      await chmod(configPath, mode)
      const response = await patchConfig(setStep(step))
      expect(response.status).toBe(200)
      expect((await stat(configPath)).mode & 0o777).toBe(mode)
    }
  })

  it('SYMLINK-KEPT: a symlinked config keeps its link and the real file takes the change', async () => {
    const realDir = await mkdtemp(join(tmpdir(), 'agent-qa-config-real-'))
    const linkDir = await mkdtemp(join(tmpdir(), 'agent-qa-config-link-'))
    tempDirs.push(realDir, linkDir)
    const realPath = join(realDir, 'agent-qa.config.yaml')
    const configPath = join(linkDir, 'agent-qa.config.yaml')
    await writeFile(realPath, baseConfig, 'utf-8')
    await symlink(realPath, configPath)
    router = createRouter({ db: createMockDatabase() as any, configManager: new ConfigManager(configPath, (text) => text), configPath })

    const response = await patchConfig(setStep('45s'))

    expect(response.status).toBe(200)
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true)
    const parsed = parseYaml(await readFile(realPath, 'utf-8')) as { use: { timeout: { step: string } } }
    expect(parsed.use.timeout.step).toBe('45s')
  })
})

// Completion and snapshot-computed writes are decided by the file at merge time.
function withoutLines(text: string, lines: readonly string[]): string {
  return text.split('\n').filter((line) => !lines.includes(line)).join('\n')
}

const TIMEOUT_LINES = ['  timeout:', '    step: 30s', '    test: 10m', '    navigation: 10s']
const BROWSER_LINES = ['  browser:', '    name: chromium', '    headless: false']

const modelRegistry = [
  'registry:',
  '  llms:',
  ...['a', 'b', 'c', 'd'].flatMap((name) => [`    - name: ${name}`, '      provider: gemini', '      model: gemini-2.5-flash']),
  '    - name: proxy',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.test/v1',
  '      providerHeaders:',
  '        X-Org: org-secret-value',
].join('\n')

function matchConfig(patterns: readonly string[]): string {
  return baseConfig
    .replace('registry: {}', modelRegistry)
    .replace('  testMatch:\n    - tests/**/*.yaml', ['  testMatch:', ...patterns.map((pattern) => `    - ${pattern}`)].join('\n'))
}

const matchWrite = {
  changes: [
    { op: 'expect', path: ['workspace', 'testMatch'], value: ['a/*.yaml', 'b/*.yaml'] },
    { op: 'expect', path: ['use', 'llm'], value: null },
    { op: 'set', path: ['workspace', 'testMatch'], value: ['a/*.yaml', 'b/*.yaml', 'c/*.yaml'] },
  ],
}

describe('PATCH /api/config set-if-absent and expect', () => {
  it('SET-IF-ABSENT-KEEPS-OUTSIDE-VALUE: completion never replaces a sibling already in the file', async () => {
    const configPath = await useConfigWorkspace()
    const outside = baseConfig.replace('  mobile:', '  planner:\n    maxActions: 99\n    maxPlanningTurns: 99\n    previousStepCount: 77\n  mobile:')
    await writeFile(configPath, outside, 'utf-8')

    const response = await patchConfig({
      changes: [
        { op: 'set', path: ['use', 'planner', 'maxActions'], value: 50 },
        { op: 'set-if-absent', path: ['use', 'planner', 'previousStepCount'], value: 5 },
      ],
    })

    expect(response.status, response.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { use: { planner: unknown } }
    expect(parsed.use.planner).toEqual({ maxActions: 50, maxPlanningTurns: 99, previousStepCount: 77 })
  })

  it('SET-IF-ABSENT-FILLS-ABSENT: into an absent block every set-if-absent sibling is written', async () => {
    const configPath = await useConfigWorkspace(withoutLines(baseConfig, TIMEOUT_LINES))

    const response = await patchConfig({
      changes: [
        { op: 'set', path: ['use', 'timeout', 'step'], value: '45s' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'navigation'], value: '10s' },
      ],
    })

    expect(response.status, response.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { use: { timeout: unknown } }
    expect(parsed.use.timeout).toEqual({ step: '45s', test: '10m', navigation: '10s' })
  })

  it('SET-IF-ABSENT-TWICE-IDEMPOTENT: the same set-if-absent change set twice leaves the same bytes and revision', async () => {
    const configPath = await useConfigWorkspace(withoutLines(baseConfig, TIMEOUT_LINES))
    const body = {
      changes: [
        { op: 'set', path: ['use', 'timeout', 'step'], value: '45s' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'test'], value: '10m' },
        { op: 'set-if-absent', path: ['use', 'timeout', 'navigation'], value: '10s' },
      ],
    }

    const first = await patchConfig(body)
    const afterFirst = await readFile(configPath)
    const second = await patchConfig(body)

    expect([first.status, second.status], second.body).toEqual([200, 200])
    expect(Buffer.compare(await readFile(configPath), afterFirst)).toBe(0)
    const [one, two] = [first, second].map((response) => JSON.parse(response.body) as { revision: string })
    expect(two!.revision).toBe(one!.revision)
  })

  it('LEGACY-HEADLESS-KEPT-ON-COMPLETION: completing use.browser.headless keeps a root use.headless value and drops the legacy key', async () => {
    const legacy = withoutLines(baseConfig, BROWSER_LINES).replace('use:\n', 'use:\n  headless: false\n')
    const configPath = await useConfigWorkspace(legacy)

    const response = await patchConfig({
      changes: [
        { op: 'set', path: ['use', 'browser', 'name'], value: 'firefox' },
        { op: 'set-if-absent', path: ['use', 'browser', 'headless'], value: true },
      ],
    })

    expect(response.status, response.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { use: Record<string, unknown> }
    expect(parsed.use.browser).toEqual({ name: 'firefox', headless: false })
    expect('headless' in parsed.use).toBe(false)
  })

  it('EXPECT-MATCH-WRITES: a write whose expects match the file lands', async () => {
    const configPath = await useConfigWorkspace(matchConfig(['a/*.yaml', 'b/*.yaml']))

    const response = await patchConfig(matchWrite)

    expect(response.status, response.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { workspace: Record<string, unknown> }
    expect(parsed.workspace.testMatch).toEqual(['a/*.yaml', 'b/*.yaml', 'c/*.yaml'])
  })

  it('EXPECT-MISMATCH-REFUSED: a field changed outside refuses the whole set 409 and keeps the bytes', async () => {
    const configPath = await useConfigWorkspace(matchConfig(['a/*.yaml', 'b/*.yaml', 'd/*.yaml']))
    const before = await readFile(configPath)
    mockRename.mockClear()

    const response = await patchConfig(matchWrite)

    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ error: 'field_changed', path: ['workspace', 'testMatch'] })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()
  })

  // No path is classed secret, so an expect on a header is compared like any field.
  it('EXPECT-ON-HEADER-COMPARED: an expect on a header value refuses a wrong guess 409 like any field', async () => {
    const configPath = await useConfigWorkspace(matchConfig(['a/*.yaml', 'b/*.yaml']))
    const before = await readFile(configPath)
    const headerPath = ['registry', 'llms', { name: 'proxy' }, 'providerHeaders', 'X-Org']

    const response = await patchConfig({ changes: [{ op: 'expect', path: headerPath, value: 'guess' }] })
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body)).toEqual({ error: 'field_changed', path: headerPath })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
  })
})

// The page's write door changes only what the page renders a field for.
const policyConfig = baseConfig.replace('registry: {}', [
  'registry:',
  '  llms:',
  '    - name: gpt',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.test/v1',
].join('\n')) + [
  'plugins:',
  '  auth:',
  '    - path: ./auth-plugin.mjs',
  '',
].join('\n')

describe('PATCH /api/config path policy', () => {
  // `safety` is outside the published schema, so its paths are refused as undescribed paths.
  it('WRITE-DOOR-REFUSES-DENIED-ROOTS: plugins and the retired safety root are refused 422 before anything is read or written', async () => {
    const configPath = await useConfigWorkspace(policyConfig)
    const before = await readFile(configPath)
    mockRename.mockClear()
    const denied = [
      { op: 'set', path: ['plugins', 'auth', 0, 'path'], value: './evil.mjs' },
      { op: 'append', path: ['plugins', 'providers'], value: { path: './evil-provider.mjs' } },
      { op: 'set', path: ['safety', 'trustMode'], value: true },
      { op: 'move', from: ['use', 'timeout', 'step'], path: ['plugins', 'auth', 0, 'package'] },
      { op: 'expect', path: ['safety', 'trustMode'], value: false },
    ]

    for (const change of denied) {
      const response = await patchConfig({ changes: [change] })
      expect([change, response.status]).toEqual([change, 422])
      expect(JSON.parse(response.body)).toEqual({ error: 'path_not_writable' })
      expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    }
    // A denied change beside a writable one refuses the whole set.
    const mixed = await patchConfig({
      changes: [setStep('45s').changes[0], { op: 'set', path: ['safety', 'trustMode'], value: true }],
    })
    expect(mixed.status).toBe(422)
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()
  })

  it('WRITE-DOOR-REFUSES-UNKNOWN-PATH: a path the published schema does not describe is refused and nothing is written', async () => {
    const configPath = await useConfigWorkspace(policyConfig)
    const before = await readFile(configPath)
    mockRename.mockClear()

    const response = await patchConfig({ changes: [{ op: 'set', path: ['use', 'bogus'], value: 'x' }] })

    expect(response.status).toBe(422)
    expect(JSON.parse(response.body)).toEqual({ error: 'path_not_writable' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()
  })

  // A provider header and the MCP port stand for the security-relevant writes the page makes.
  it('fields the page renders, security-relevant ones included, still land', async () => {
    const configPath = await useConfigWorkspace(policyConfig)
    const admitted = [
      { op: 'set', path: ['registry', 'llms', { name: 'gpt' }, 'providerHeaders', 'X-Org'], value: 'org-1' },
      { op: 'set', path: ['services', 'mcp', 'port'], value: 3471 },
    ]

    for (const change of admitted) {
      const response = await patchConfig({ changes: [change] })
      expect([change, response.status], response.body).toEqual([change, 200])
    }
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as {
      services: { mcp: unknown }
      registry: { llms: Array<{ providerHeaders?: unknown }> }
    }
    expect(parsed.services.mcp).toEqual({ port: 3471 })
    expect(parsed.registry.llms[0]!.providerHeaders).toEqual({ 'X-Org': 'org-1' })
  })

  it('a page-owned boolean is an ordinary write with Undo, and every retired key path is refused before a write', async () => {
    const configPath = await useConfigWorkspace(policyConfig)
    const before = await readFile(configPath)
    mockRename.mockClear()
    const retired = [
      { op: 'append', path: ['services', 'mcp', 'tokens'], value: { name: 'ci', tokenEnvVar: 'AGENT_QA_MCP_CI_TOKEN', scopes: ['read'] } },
      { op: 'set', path: ['services', 'mcp', 'stdio', 'grantConfigWrite'], value: true },
      { op: 'set', path: ['services', 'mcp', 'stdio'], value: {} },
      { op: 'append', path: ['services', 'dashboard', 'runServiceTokens'], value: { name: 'ci', tokenEnvVar: 'X', trustScope: {} } },
      { op: 'unset', path: ['services', 'mcp', 'tokens', { name: 'ci' }] },
      { op: 'set', path: ['safety'], value: { trustMode: true } },
    ]
    for (const change of retired) {
      const response = await patchConfig({ changes: [change] })
      expect([change, response.status]).toEqual([change, 422])
      expect(JSON.parse(response.body)).toEqual({ error: 'path_not_writable' })
    }
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()

    // A cross-site caller is refused before the body is read.
    const crossSite = await patchConfig(
      { changes: [{ op: 'set', path: ['services', 'recording', 'enabled'], value: false }] },
      { origin: 'https://evil.example' },
    )
    expect(crossSite.status).toBe(403)
    expect(JSON.parse(crossSite.body)).toEqual({ error: 'cross_site_refused' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

    // The boolean lands through the field merge, and only a boolean validates.
    const recording = ['services', 'recording', 'enabled']
    const wrong = await patchConfig({ changes: [{ op: 'set', path: recording, value: 'yes' }] })
    expect(wrong.status).toBe(422)
    expect(JSON.parse(wrong.body).error).toBe('validation_failed')
    const landed = await patchConfig({ changes: [{ op: 'set', path: recording, value: false }], undoable: true })
    expect(landed.status, landed.body).toBe(200)
    const answer = JSON.parse(landed.body) as { undo?: { token: string } }
    expect(answer.undo?.token).toEqual(expect.any(String))
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { services?: { recording?: unknown } }
    expect(parsed.services?.recording).toEqual({ enabled: false })
  })
})

// A page-owned boolean under the field merge's retry and concurrency rules.
describe('PATCH /api/config page-owned fields under retry and concurrency', () => {
  it('a stale expect on a field is refused field_changed, and a fresh one lands', async () => {
    const recording = ['services', 'recording', 'enabled']
    const configPath = await useConfigWorkspace(
      baseConfig.replace('services: {}', 'services:\n  recording:\n    enabled: false'),
    )
    const outside = (await readFile(configPath, 'utf-8')).replace('    enabled: false', '    enabled: true')
    await writeFile(configPath, outside, 'utf-8')
    const before = await readFile(configPath)

    const stale = await patchConfig({ changes: [
      { op: 'expect', path: recording, value: false },
      { op: 'set', path: recording, value: false },
    ] })
    expect(stale.status).toBe(409)
    expect(JSON.parse(stale.body)).toMatchObject({ error: 'field_changed' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

    const fresh = await patchConfig({ changes: [
      { op: 'expect', path: recording, value: true },
      { op: 'set', path: recording, value: false },
    ] })
    expect(fresh.status, fresh.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { services?: { recording?: unknown } }
    expect(parsed.services?.recording).toEqual({ enabled: false })
  })

  it('concurrent writes of a recording field and an MCP field both land, each field merged', async () => {
    const configPath = await useConfigWorkspace()
    const answers = await Promise.all([
      patchConfig({ changes: [{ op: 'set', path: ['services', 'recording', 'enabled'], value: false }] }),
      patchConfig({ changes: [{ op: 'set', path: ['services', 'mcp', 'port'], value: 4100 }] }),
    ])
    expect(answers.map(answer => answer.status)).toEqual([200, 200])
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { services?: { mcp?: unknown; recording?: unknown } }
    expect(parsed.services?.recording).toEqual({ enabled: false })
    expect(parsed.services?.mcp).toEqual({ port: 4100 })
    expect(await readFile(configPath, 'utf-8')).toContain('# owner notes: keep the step timeout generous on CI')
  })
})

// A header rename re-keys the value inside the server.
const HEADER_SECRET = 'sk-header-secret-1'
const headerConfig = baseConfig.replace('registry: {}', [
  'registry:',
  '  llms:',
  '    - name: proxy',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.test/v1',
  '      providerHeaders:',
  `        X-Org: ${HEADER_SECRET} # the org header the proxy bills to`,
].join('\n'))
const HEADERS = ['registry', 'llms', { name: 'proxy' }, 'providerHeaders']

describe('PATCH /api/config move', () => {
  it('MOVE-KEEPS-VALUE-SERVER-SIDE: a header rename lands with its value and comment, and the answer never carries the value', async () => {
    const configPath = await useConfigWorkspace(headerConfig)

    const response = await patchConfig({
      changes: [{ op: 'move', from: [...HEADERS, 'X-Org'], path: [...HEADERS, 'X-Team'] }],
    })

    expect(response.status, response.body).toBe(200)
    expect(response.body).not.toContain(HEADER_SECRET)
    expect(Object.keys(JSON.parse(response.body) as object).sort()).toEqual(['baseRevision', 'revision'])
    const text = await readFile(configPath, 'utf-8')
    const parsed = parseYaml(text) as { registry: { llms: Array<{ providerHeaders: unknown }> } }
    expect(parsed.registry.llms[0]!.providerHeaders).toEqual({ 'X-Team': HEADER_SECRET })
    expect(text).toContain(`X-Team: ${HEADER_SECRET} # the org header the proxy bills to`)
    expect(text).not.toContain('X-Org')
  })

  it('MOVE-SUBTREE-ACROSS-PATHS-LANDS: a block moved to another entry lands whole and leaves its old path', async () => {
    const withRelay = headerConfig.replace('  llms:\n', [
      '  llms:',
      '    - name: relay',
      '      provider: anthropic-compatible',
      '      model: claude-relay',
      '      baseURL: https://relay.example.test/v1',
      '',
    ].join('\n'))
    const configPath = await useConfigWorkspace(withRelay)

    const response = await patchConfig({
      changes: [{ op: 'move', from: HEADERS, path: ['registry', 'llms', { name: 'relay' }, 'providerHeaders'] }],
    })

    expect(response.status, response.body).toBe(200)
    expect(response.body).not.toContain(HEADER_SECRET)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as {
      registry: { llms: Array<{ name: string; providerHeaders?: unknown }> }
    }
    const byName = Object.fromEntries(parsed.registry.llms.map((llm) => [llm.name, llm]))
    expect(byName.relay!.providerHeaders).toEqual({ 'X-Org': HEADER_SECRET })
    expect(byName.proxy).not.toHaveProperty('providerHeaders')
  })

  it('MOVE-FROM-MISSING-REFUSED: a move from a header that is not there is refused 422 and nothing is written', async () => {
    const configPath = await useConfigWorkspace(headerConfig)
    const before = await readFile(configPath)
    mockRename.mockClear()

    const response = await patchConfig({
      changes: [{ op: 'move', from: [...HEADERS, 'X-Absent'], path: [...HEADERS, 'X-Team'] }],
    })

    expect(response.status).toBe(422)
    expect(JSON.parse(response.body)).toEqual({ error: 'path_not_found' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    expect(mockRename).not.toHaveBeenCalled()
  })

  it('MOVE-INTO-ITSELF-REFUSED: a move onto a field inside the one it moves is refused and nothing is written', async () => {
    const configPath = await useConfigWorkspace(headerConfig)
    const before = await readFile(configPath)

    for (const [from, path] of [
      [['use', 'timeout'], ['use', 'timeout', 'step']],
      [['use', 'timeout', 'step'], ['use', 'timeout']],
    ]) {
      const response = await patchConfig({ changes: [{ op: 'move', from, path }] })
      expect([from, response.status]).toEqual([from, 422])
      expect(JSON.parse(response.body)).toEqual({ error: 'path_not_writable' })
    }
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
  })

  it('MOVE-UNDO-RESTORES-BOTH: the priors of a move bring back the old key and remove the new one', async () => {
    const { configManager, configPath } = await createConfigWorkspace(headerConfig)

    const moved = await configManager.applyChanges(
      [{ op: 'move', from: [...HEADERS, 'X-Org'], path: [...HEADERS, 'X-Team'] }],
      { capturePriors: true },
    )
    expect(moved.kind).toBe('ok')
    if (moved.kind !== 'ok') return
    expect(moved.priors).toHaveLength(2)

    expect(await configManager.restorePriors(moved.priors!)).toEqual({ kind: 'ok', revision: expect.any(String) })
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { registry: { llms: Array<{ providerHeaders: unknown }> } }
    expect(parsed.registry.llms[0]!.providerHeaders).toEqual({ 'X-Org': HEADER_SECRET })
  })
})

const CONFIG_MANAGER_SOURCE = new URL('../config/config-manager.ts', import.meta.url)
const FILE_ACCESS = /\b(?:readFile|writeFile|rename|rm|lstat|realpath|stat|chmod|mkdir)\(/

// The ConfigManager class body, from its declaration to the first closing brace at column 0.
function classBody(source: string): string {
  const start = source.indexOf('export class ConfigManager {')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end)
}

describe('one write path to the config file', () => {
  it('LEGACY-WRITE-ROUTES-GONE: a PUT to each retired per-section route is an unknown route and the file is untouched', async () => {
    const configPath = await useConfigWorkspace()
    const before = await readFile(configPath)
    const retired: Array<[string, unknown]> = [
      ['/api/config/settings', { 'use.timeout': { step: '45s', test: '10m', navigation: '10s' } }],
      ['/api/config/llms', {
        llms: [{ name: 'planner', provider: 'gemini', model: 'gemini-2.5-flash' }],
        defaultLLM: 'planner',
      }],
      ['/api/config/default-llm', { llm: 'planner' }],
    ]

    for (const [url, body] of retired) {
      const response = await invokeRoute(url, {
        method: 'PUT',
        headers: { host: HOST, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect([url, response.status]).toEqual([url, 404])
    }
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)

    // The control: the one write route still answers on the same router and file.
    expect((await patchConfig(setStep('45s'))).status).toBe(200)
  })

  // `replaceDocument`, the direct writer's whole-file publication, is a file method in the class.
  it('ONE-WRITE-PATH: the manager exposes only its five file methods, and nothing outside the class touches the file', async () => {
    const source = await readFile(CONFIG_MANAGER_SOURCE, 'utf-8')
    const body = classBody(source)

    const publicMethods = [...body.matchAll(/^ {2}(?:async )?([A-Za-z]\w*)\(/gm)].map((match) => match[1])
    expect(publicMethods.sort()).toEqual(
      ['applyChanges', 'constructor', 'readMasked', 'readWithRevision', 'replaceDocument', 'restorePriors'],
    )
    for (const retired of ['updateSection', 'replaceSection', 'replaceSectionRaw', 'deleteSectionRaw', 'readDocument']) {
      expect(source).not.toMatch(new RegExp(`\\b${retired}\\b`))
    }
    expect(source).not.toMatch(/^ {2}(?:async )?read\(/m)

    // Every direct file access sits inside the class; a module-level reader goes through it.
    const outside = source.replace(body, '')
    expect(outside.split('\n').filter((line) => FILE_ACCESS.test(line) && !line.startsWith('import'))).toEqual([])

    const manager = new ConfigManager(join(tmpdir(), 'agent-qa-one-write-path.yaml'), (text) => text)
    const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(manager))
    for (const retired of ['read', 'updateSection', 'replaceSection', 'replaceSectionRaw', 'deleteSectionRaw', 'readDocument']) {
      expect(prototypeMethods).not.toContain(retired)
    }
  })

  it('VALUES-READ-REFUSES-BROKEN-FILE: a reader that only needs values never gets the part of a broken file yaml recovers', async () => {
    const { configManager, configPath } = await createConfigWorkspace()
    expect(await readConfigValues(configManager)).toEqual(parseYaml(baseConfig))

    await writeFile(configPath, 'a: 1\nb: [1, 2\nc: 3\n', 'utf-8')
    await expect(readConfigValues(configManager)).rejects.toBeInstanceOf(ConfigFileInvalidError)

    await rm(configPath)
    expect(await readConfigValues(configManager)).toEqual({})
  })
})
