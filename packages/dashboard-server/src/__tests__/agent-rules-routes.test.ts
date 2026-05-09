import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DashboardDatabase } from '../db/database.js'
import { ConfigManager } from '../config/config-manager.js'
import { createRouter } from '../server/routes.js'
import { resolveWorkspacePaths, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'

let db: DashboardDatabase
let router: ReturnType<typeof createRouter>
let tmpDir: string

const TEST_LLM_CONFIG = `registry:
  llms:
    - name: primary
      provider: openai-compatible
      model: gpt-4o
      baseURL: https://api.openai.com/v1
use:
  llm: primary
`

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
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

async function startRouter(configContent: string) {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-rules-test-'))
  const normalizedConfigContent = withRequiredWorkspaceConfig(configContent)
  const configPath = join(tmpDir, 'agent-qa.config.yaml')
  await writeFile(configPath, normalizedConfigContent, 'utf-8')

  db = new DashboardDatabase({ dbPath: ':memory:' })
  const configManager = new ConfigManager(configPath)
  const workspacePaths = await resolveWorkspaceForTest(configManager, configPath, normalizedConfigContent)
  router = createRouter({
    db,
    configManager,
    configPath,
    workspacePaths,
  })
}

function withRequiredWorkspaceConfig(configContent: string): string {
  if (!/^workspace:\s*$/m.test(configContent)) {
    return configContent
  }

  const entries = [
    ['testMatch', '  testMatch:\n    - specs/web/**/*.yaml'],
    ['suiteMatch', '  suiteMatch:\n    - cases/**/*.suite.yaml'],
    ['hooksFile', '  hooksFile: hooks.yaml'],
    ['envFile', '  envFile: .env'],
    ['secretsFile', '  secretsFile: .env.secrets.local'],
  ]
    .filter(([key]) => !new RegExp(`^\\s*${key}:`, 'm').test(configContent))
    .map(([, entry]) => entry)

  return entries.length === 0
    ? configContent
    : configContent.replace(/^workspace:\s*$/m, `workspace:\n${entries.join('\n')}`)
}

async function resolveWorkspaceForTest(
  configManager: ConfigManager,
  configPath: string,
  configContent: string,
): Promise<ResolvedWorkspacePaths | undefined> {
  if (!/^workspace:\s*$/m.test(configContent)) {
    return undefined
  }
  return resolveWorkspacePaths({
    config: await configManager.read() as any,
    configPath,
  })
}

afterEach(async () => {
  db?.close()
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

describe('Agent Rules API', () => {
  it('GET requires resolved workspace paths', async () => {
    await startRouter(TEST_LLM_CONFIG)
    const res = await invokeRoute('/api/agent-rules')
    expect(res.status).toBe(503)
    const data = JSON.parse(res.body) as any
    expect(data.error).toBe('Workspace path resolution not available')
  })

  it('GET returns content when agentRules file exists', async () => {
    await startRouter(`${TEST_LLM_CONFIG}workspace:\n  agentRules: ./rules.md\n`)
    await writeFile(join(tmpDir, 'rules.md'), '# My Rules\n- rule one', 'utf-8')
    const res = await invokeRoute('/api/agent-rules')
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.content).toBe('# My Rules\n- rule one')
    expect(data.filePath).toBe('rules.md')
    expect(data.error).toBeUndefined()
  })

  it('GET returns workspace.agentRules file_not_found when the configured file is missing', async () => {
    await startRouter(`${TEST_LLM_CONFIG}workspace:\n  agentRules: ./missing.md\n`)
    const res = await invokeRoute('/api/agent-rules')
    expect(res.status).toBe(500)
    const data = JSON.parse(res.body) as any
    expect(data.content).toBeNull()
    expect(data.filePath).toBe('missing.md')
    expect(data.error).toBe('workspace.agentRules file_not_found')
  })

  it('PUT writes content to the configured file', async () => {
    await startRouter(`${TEST_LLM_CONFIG}workspace:\n  agentRules: ./rules.md\n`)
    await writeFile(join(tmpDir, 'rules.md'), '', 'utf-8')
    const res = await invokeRoute('/api/agent-rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Updated Rules' }),
    })
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data).toEqual({ updated: true })
    const written = await readFile(join(tmpDir, 'rules.md'), 'utf-8')
    expect(written).toBe('# Updated Rules')
  })

  it('PUT requires resolved workspace paths', async () => {
    await startRouter(TEST_LLM_CONFIG)
    const res = await invokeRoute('/api/agent-rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(503)
  })

  it('POST /create creates file and sets config key', async () => {
    await startRouter(TEST_LLM_CONFIG)
    const res = await invokeRoute('/api/agent-rules/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.created).toBe(true)
    expect(data.filePath).toBe('./agent-rules.md')
    const fileContent = await readFile(join(tmpDir, 'agent-rules.md'), 'utf-8')
    expect(fileContent).toBe('')
  })

  it('POST /create uses custom fileName', async () => {
    await startRouter(TEST_LLM_CONFIG)
    const res = await invokeRoute('/api/agent-rules/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'custom-rules.md' }),
    })
    expect(res.status).toBe(200)
    const data = JSON.parse(res.body) as any
    expect(data.filePath).toBe('./custom-rules.md')
    const fileContent = await readFile(join(tmpDir, 'custom-rules.md'), 'utf-8')
    expect(fileContent).toBe('')
  })

  it.each([
    '../outside.md',
    'nested/rules.md',
    'nested\\rules.md',
    '/tmp/agent-qa-rules-outside.md',
  ])('POST /create rejects unsafe fileName %s', async (fileName) => {
    await startRouter(TEST_LLM_CONFIG)
    const res = await invokeRoute('/api/agent-rules/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName }),
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'fileName must be a plain file name' })
  })

  it('POST /create does not overwrite an existing rules file', async () => {
    await startRouter(TEST_LLM_CONFIG)
    await writeFile(join(tmpDir, 'existing-rules.md'), 'keep me', 'utf-8')

    const res = await invokeRoute('/api/agent-rules/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'existing-rules.md' }),
    })

    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'Agent rules file already exists' })
    expect(await readFile(join(tmpDir, 'existing-rules.md'), 'utf-8')).toBe('keep me')
  })
})
