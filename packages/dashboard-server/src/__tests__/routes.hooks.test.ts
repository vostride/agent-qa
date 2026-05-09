import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRunHookInSandbox } = vi.hoisted(() => ({
  mockRunHookInSandbox: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    runHookInSandbox: (...args: unknown[]) => mockRunHookInSandbox(...args),
  }
})

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import { resolveWorkspacePaths, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'

const SEEDED_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SEEDED_HOOK_ID_TWO = 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'
const ROUTER_DB_STUB = {
  getRuns: vi.fn(() => []),
  insertRun: vi.fn(),
  insertStep: vi.fn(),
  insertExecutionLog: vi.fn(),
} as any

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

let router: ReturnType<typeof createRouter>
let tempDirs: string[] = []

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

async function createConfigWorkspace(
  configContent: string,
  options: {
    hooksContent?: string
    files?: Record<string, string>
  } = {},
): Promise<{
  configManager: ConfigManager
  configPath: string
  workspacePaths: ResolvedWorkspacePaths
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-hooks-routes-'))
  tempDirs.push(dir)

  const normalizedConfigContent = withRequiredWorkspaceConfig(configContent)
  const configPath = join(dir, 'config.yaml')
  await writeFile(configPath, normalizedConfigContent, 'utf-8')

  if (options.hooksContent !== undefined) {
    const hooksFile = normalizedConfigContent.match(/hooksFile:\s*(.+)/)?.[1]?.trim()
    if (!hooksFile) {
      throw new Error('Test workspace config must define workspace.hooksFile')
    }
    const hooksPath = join(dir, hooksFile)
    await mkdir(dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, options.hooksContent, 'utf-8')
  }

  if (options.files) {
    for (const [relativePath, content] of Object.entries(options.files)) {
      const fullPath = join(dir, relativePath)
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
    }
  }

  return {
    configManager: new ConfigManager(configPath),
    configPath,
    workspacePaths: resolveWorkspacePaths({
      config: await new ConfigManager(configPath).read() as any,
      configPath,
    }),
    dir,
  }
}

function withRequiredWorkspaceConfig(configContent: string): string {
  if (!/^workspace:\s*$/m.test(configContent)) {
    return configContent
  }

  const entries = [
    ['testMatch', '  testMatch:\n    - specs/web/**/*.yaml'],
    ['suiteMatch', '  suiteMatch:\n    - cases/**/*.suite.yaml'],
    ['agentRules', '  agentRules: ./agent-rules.md'],
    ['envFile', '  envFile: .env'],
    ['secretsFile', '  secretsFile: .env.secrets.local'],
  ]
    .filter(([key]) => !new RegExp(`^\\s*${key}:`, 'm').test(configContent))
    .map(([, entry]) => entry)

  const normalized = entries.length === 0
    ? configContent
    : configContent.replace(/^workspace:\s*$/m, `workspace:\n${entries.join('\n')}`)
  return /^use:\s*$/m.test(normalized)
    ? normalized
    : `${normalized.trimEnd()}\nuse:\n  mobile:\n    appState: preserve\n`
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

beforeEach(() => {
  vi.clearAllMocks()
  ROUTER_DB_STUB.getRuns.mockReturnValue([])
  mockRunHookInSandbox.mockResolvedValue({
    success: true,
    variables: { TOKEN: 'abc' },
    output: 'ok',
    stdout: 'ok',
    stderr: '',
    duration: 5,
    error: undefined,
  })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

describe('GET /api/hooks', () => {
  it('returns browser-safe catalog rows with authored relative files and file-missing warnings', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          '    network: false',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as any
    expect(data).toEqual({
      hooks: [
        {
          id: SEEDED_HOOK_ID,
          name: 'login',
          runtime: 'node',
          file: './scripts/login.js',
          timeout: 30000,
          network: false,
          fileMissing: false,
        },
        {
          id: SEEDED_HOOK_ID_TWO,
          name: 'cleanup',
          runtime: 'bash',
          file: './scripts/cleanup.sh',
          timeout: 15000,
          network: true,
          fileMissing: true,
        },
      ],
      filePath: './hooks.yaml',
      errors: [],
      missing: false,
    })
    expect(JSON.stringify(data)).not.toContain(dir)
    expect(JSON.stringify(data)).not.toContain(configPath)
    expect(JSON.stringify(data)).not.toContain('console.log("login")')
  })

  it('returns an empty missing state when hooks.yaml does not exist', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      hooks: [],
      filePath: './hooks.yaml',
      errors: ['configured hooks file not found: ./hooks.yaml'],
      missing: true,
    })
  })

  it.each([
    {
      label: 'malformed yaml',
      hooksContent: 'hooks: [',
      expectedError: 'Invalid YAML in hooks file',
    },
    {
      label: 'duplicate hook ids',
      hooksContent: [
        'hooks:',
        `  - id: ${SEEDED_HOOK_ID}`,
        '    name: login',
        '    runtime: node',
        '    file: ./scripts/login.js',
        '    timeout: 30s',
        `  - id: ${SEEDED_HOOK_ID}`,
        '    name: cleanup',
        '    runtime: bash',
        '    file: ./scripts/cleanup.sh',
        '    timeout: 15s',
      ].join('\n'),
      expectedError: 'Duplicate hook id',
    },
    {
      label: 'duplicate hook names',
      hooksContent: [
        'hooks:',
        `  - id: ${SEEDED_HOOK_ID}`,
        '    name: login',
        '    runtime: node',
        '    file: ./scripts/login.js',
        '    timeout: 30s',
        `  - id: ${SEEDED_HOOK_ID_TWO}`,
        '    name: login',
        '    runtime: bash',
        '    file: ./scripts/cleanup.sh',
        '    timeout: 15s',
      ].join('\n'),
      expectedError: 'Duplicate hook name',
    },
  ])('returns blocking catalog errors for $label', async ({ hooksContent, expectedError }) => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      { hooksContent },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks')
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as any
    expect(data.hooks).toEqual([])
    expect(data.filePath).toBe('./hooks.yaml')
    expect(data.missing).toBe(false)
    expect(data.errors.some((message: string) => message.includes(expectedError))).toBe(true)
    expect(JSON.stringify(data)).not.toContain(dir)
    expect(JSON.stringify(data)).not.toContain(configPath)
  })
})

describe('GET /api/hooks/:hookId', () => {
  it('returns hook source for a readable hook without field errors', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`)
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as any
    expect(data).toEqual({
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: 30000,
        network: true,
        fileMissing: false,
      },
      source: 'console.log("login")\n',
      fieldErrors: [],
    })
    expect(JSON.stringify(data)).not.toContain(dir)
    expect(JSON.stringify(data)).not.toContain(configPath)
  })

  it('returns recoverable file-missing field errors without leaking absolute paths', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`)
    expect(res.status).toBe(200)

    const data = JSON.parse(res.body) as any
    expect(data).toEqual({
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: 30000,
        network: true,
        fileMissing: true,
      },
      source: null,
      fieldErrors: [
        {
          field: 'file',
          code: 'file_missing',
          message: 'Hook file missing',
        },
      ],
    })
    expect(JSON.stringify(data)).not.toContain(dir)
    expect(JSON.stringify(data)).not.toContain(configPath)
  })
})

describe('POST /api/hooks', () => {
  it('creates a hook row and source file, generating a canonical hook id when omitted', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          name: 'login',
          runtime: 'node',
          file: './scripts/login.js',
          timeout: '30s',
          network: false,
        },
        source: 'console.log("login")\n',
      }),
    })

    expect(res.status).toBe(201)
    const data = JSON.parse(res.body) as any
    expect(data.hook.id).toMatch(/^h_/)
    expect(data).toEqual({
      hook: {
        id: data.hook.id,
        name: 'login',
        runtime: 'node',
        file: './scripts/login.js',
        timeout: 30000,
        network: false,
        fileMissing: false,
      },
      source: 'console.log("login")\n',
      fieldErrors: [],
    })
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(`id: ${data.hook.id}`)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
  })

  it('preserves a provided canonical hook id on create', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID_TWO,
          name: 'login',
          runtime: 'node',
          file: './scripts/login.js',
          timeout: '30s',
          network: false,
        },
        source: 'console.log("login")\n',
      }),
    })

    expect(res.status).toBe(201)
    const data = JSON.parse(res.body) as any
    expect(data.hook.id).toBe(SEEDED_HOOK_ID_TWO)
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(`id: ${SEEDED_HOOK_ID_TWO}`)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
  })

  it('returns validation_failed with structured fieldErrors and keeps disk unchanged', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID,
          name: 'login',
          runtime: 'ruby',
          file: '../escape/login.rb',
          timeout: 'later',
          network: 'yes',
        },
        source: 'puts "login"\n',
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'id', code: 'duplicate_id' }),
        expect.objectContaining({ field: 'name', code: 'duplicate_name' }),
        expect.objectContaining({ field: 'runtime', code: 'invalid_runtime' }),
        expect.objectContaining({ field: 'file', code: 'unsafe_path' }),
        expect.objectContaining({ field: 'timeout', code: 'invalid_timeout' }),
        expect.objectContaining({ field: 'network', code: 'invalid_network' }),
      ]),
    })
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(`id: ${SEEDED_HOOK_ID}`)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("login")\n')
    expect(await pathExists(join(dir, 'escape/login.rb'))).toBe(false)
  })
})

describe('PUT /api/hooks/:hookId', () => {
  it('updates metadata and source, moving the file when the authored path changes', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID,
          name: 'login setup',
          runtime: 'bun',
          file: './moved/login.ts',
          timeout: '45s',
          network: true,
        },
        source: 'export default async function login() {}\n',
      }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      hook: {
        id: SEEDED_HOOK_ID,
        name: 'login setup',
        runtime: 'bun',
        file: './moved/login.ts',
        timeout: 45000,
        network: true,
        fileMissing: false,
      },
      source: 'export default async function login() {}\n',
      fieldErrors: [],
    })
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(false)
    expect(await readFile(join(dir, 'moved/login.ts'), 'utf-8')).toBe('export default async function login() {}\n')
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain('timeout: 45s')
  })

  it('returns validation_failed for id mismatches, collisions, and recoverably recreates missing current files', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/existing.js': 'console.log("existing")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const mismatch = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID_TWO,
          name: 'login',
          runtime: 'node',
          file: './scripts/login.js',
          timeout: '30s',
        },
        source: 'console.log("updated")\n',
      }),
    })

    expect(mismatch.status).toBe(400)
    expect(JSON.parse(mismatch.body)).toEqual({
      error: 'validation_failed',
      fieldErrors: [
        {
          field: 'id',
          code: 'id_mismatch',
          message: 'Hook id in body must match the route parameter',
        },
      ],
    })

    const collision = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID,
          name: 'login',
          runtime: 'node',
          file: './scripts/existing.js',
          timeout: '30s',
        },
        source: 'console.log("updated")\n',
      }),
    })

    expect(collision.status).toBe(400)
    expect(JSON.parse(collision.body)).toEqual({
      error: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'file', code: 'collision' }),
      ]),
    })

    const recover = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook: {
          id: SEEDED_HOOK_ID,
          name: 'login',
          runtime: 'node',
          file: './scripts/login.js',
          timeout: '30s',
        },
        source: 'console.log("recreated")\n',
      }),
    })

    expect(recover.status).toBe(200)
    expect(await readFile(join(dir, 'scripts/login.js'), 'utf-8')).toBe('console.log("recreated")\n')
    expect(await readFile(join(dir, 'scripts/existing.js'), 'utf-8')).toBe('console.log("existing")\n')
  })
})

describe('DELETE /api/hooks/:hookId', () => {
  it('returns hook_in_use with sorted references when the hook is still referenced', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  testMatch:',
        '    - tests/**/*.yaml',
        '  suiteMatch:',
        '    - suites/**/*.suite.yaml',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
          'tests/auth/login.yaml': [
            'name: Login flow',
            'setup:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
          'tests/auth/inline.yaml': [
            'name: Inline login',
            'steps:',
            `  - '{{runHook:"${SEEDED_HOOK_ID}"}} Continue after login'`,
          ].join('\n'),
          'suites/smoke.suite.yaml': [
            'name: Smoke suite',
            'teardown:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}`, { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      error: 'hook_in_use',
      references: [
        {
          kind: 'suite',
          label: 'Smoke suite',
          path: 'suites/smoke.suite.yaml',
          context: 'teardown',
        },
        {
          kind: 'inline-runHook',
          label: 'Inline login',
          path: 'tests/auth/inline.yaml',
          context: 'steps[0]',
        },
        {
          kind: 'test',
          label: 'Login flow',
          path: 'tests/auth/login.yaml',
          context: 'setup',
        },
      ],
    })
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).toContain(SEEDED_HOOK_ID)
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(true)
  })

  it('force deletes the hook only on ?force=true, removes its source file, and echoes references', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  testMatch:',
        '    - tests/**/*.yaml',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/login.js': 'console.log("login")\n',
          'scripts/cleanup.sh': 'echo cleanup\n',
          'tests/auth/login.yaml': [
            'name: Login flow',
            'setup:',
            `  - ${SEEDED_HOOK_ID}`,
          ].join('\n'),
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const blocked = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}?force=1`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)

    const forced = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}?force=true`, { method: 'DELETE' })

    expect(forced.status).toBe(200)
    expect(JSON.parse(forced.body)).toEqual({
      deleted: true,
      references: [
        {
          kind: 'test',
          label: 'Login flow',
          path: 'tests/auth/login.yaml',
          context: 'setup',
        },
      ],
    })
    const hooksYaml = await readFile(join(dir, 'hooks.yaml'), 'utf-8')
    expect(hooksYaml).not.toContain(SEEDED_HOOK_ID)
    expect(hooksYaml).toContain(SEEDED_HOOK_ID_TWO)
    expect(await pathExists(join(dir, 'scripts/login.js'))).toBe(false)
  })

  it('allows force delete when the hook source file is already missing', async () => {
    const { configManager, configPath, workspacePaths, dir } = await createConfigWorkspace(
      'workspace:\n  hooksFile: ./hooks.yaml\n',
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          `  - id: ${SEEDED_HOOK_ID_TWO}`,
          '    name: cleanup',
          '    runtime: bash',
          '    file: ./scripts/cleanup.sh',
          '    timeout: 15s',
        ].join('\n'),
        files: {
          'scripts/cleanup.sh': 'echo cleanup\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}?force=true`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      deleted: true,
      references: [],
    })
    expect(await readFile(join(dir, 'hooks.yaml'), 'utf-8')).not.toContain(SEEDED_HOOK_ID)
  })
})

describe('POST /api/hooks/:hookId/run', () => {
  it('merges workspace .env with override rows, runs the prepared hook, and does not persist dashboard run history', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
          '    network: false',
        ].join('\n'),
        files: {
          '.env': 'FROM_ENV=base\nSHARED=from-env\n',
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrides: [
          { key: 'ADHOC', value: 'yes' },
          { key: 'SHARED', value: 'from-override' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(mockRunHookInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SEEDED_HOOK_ID,
        runtime: 'node',
        network: false,
      }),
      {
        envVars: {
          FROM_ENV: 'base',
          SHARED: 'from-override',
          ADHOC: 'yes',
        },
      },
    )
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      status: 'passed',
      executedAt: expect.any(String),
      duration: 5,
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      error: null,
      variables: { TOKEN: 'abc' },
      sandbox: {
        runtime: 'node',
        image: 'vostride/agent-qa-hook-runner-node',
        networkMode: 'disabled',
        dockerVersion: null,
        networkLogsAvailable: false,
        networkLogs: [],
      },
    })
    expect(ROUTER_DB_STUB.insertRun).not.toHaveBeenCalled()
    expect(ROUTER_DB_STUB.insertStep).not.toHaveBeenCalled()
    expect(ROUTER_DB_STUB.insertExecutionLog).not.toHaveBeenCalled()
  })

  it('returns hook_not_runnable when the hook has recoverable authoring issues', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          '.env': 'FROM_ENV=base\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: [] }),
    })

    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      error: 'hook_not_runnable',
      fieldErrors: [
        {
          field: 'file',
          code: 'file_missing',
          message: 'Hook file missing',
        },
      ],
    })
    expect(mockRunHookInSandbox).not.toHaveBeenCalled()
  })

  it('returns hook_registry_error when the hooks registry is blocking', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: 'hooks: [',
        files: {
          '.env': 'FROM_ENV=base\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: [] }),
    })

    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      error: 'hook_registry_error',
      message: expect.stringContaining('Invalid YAML in hooks file'),
    })
    expect(mockRunHookInSandbox).not.toHaveBeenCalled()
  })

  it('returns bun sandbox metadata when the hook runtime is bun', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: bun',
          '    file: ./scripts/login.ts',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          '.env': 'FROM_ENV=base\n',
          'scripts/login.ts': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: [] }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(expect.objectContaining({
      sandbox: {
        runtime: 'bun',
        image: 'vostride/agent-qa-hook-runner-bun',
        networkMode: 'enabled',
        dockerVersion: null,
        networkLogsAvailable: false,
        networkLogs: [],
      },
    }))
    expect(mockRunHookInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'bun' }),
      expect.objectContaining({ envVars: { FROM_ENV: 'base' } }),
    )
  })

  it('returns validation_failed for invalid override payloads', async () => {
    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          '.env': 'FROM_ENV=base\n',
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrides: [
          { key: 'SHARED', value: 'first' },
          { key: 'SHARED', value: 'second' },
          { key: '', value: 'blank' },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'validation_failed',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'registry', code: 'duplicate_override_key' }),
        expect.objectContaining({ field: 'registry', code: 'invalid_override_key' }),
      ]),
    })
    expect(mockRunHookInSandbox).not.toHaveBeenCalled()
  })

  it('returns capability-aware network telemetry only when the sandbox result includes it', async () => {
    mockRunHookInSandbox.mockResolvedValueOnce({
      success: true,
      variables: { TOKEN: 'abc' },
      output: 'ok',
      stdout: 'ok',
      stderr: '',
      duration: 5,
      error: undefined,
      networkLogs: [
        {
          url: 'https://example.com/api/login',
          method: 'POST',
          status: 201,
          startTime: 100,
          endTime: 145,
        },
      ],
    })

    const { configManager, configPath, workspacePaths } = await createConfigWorkspace(
      [
        'workspace:',
        '  hooksFile: ./hooks.yaml',
        '  envFile: ./.env',
      ].join('\n'),
      {
        hooksContent: [
          'hooks:',
          `  - id: ${SEEDED_HOOK_ID}`,
          '    name: login',
          '    runtime: node',
          '    file: ./scripts/login.js',
          '    timeout: 30s',
        ].join('\n'),
        files: {
          '.env': 'FROM_ENV=base\n',
          'scripts/login.js': 'console.log("login")\n',
        },
      },
    )
    router = createRouter({ db: ROUTER_DB_STUB, configManager, configPath, workspacePaths })

    const res = await invokeRoute(`/api/hooks/${SEEDED_HOOK_ID}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: [] }),
    })

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(expect.objectContaining({
      sandbox: expect.objectContaining({
        networkLogsAvailable: true,
        networkLogs: [
          {
            id: 'network-1',
            method: 'POST',
            url: 'https://example.com/api/login',
            statusCode: 201,
            durationMs: 45,
            error: null,
          },
        ],
      }),
    }))
  })
})
