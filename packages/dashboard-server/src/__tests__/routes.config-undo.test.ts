// The restore happens on the server, so the browser never holds or writes back a secret.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import { removeAuth, writeAuth } from '@vostride/agent-qa-core'

const { authStore } = vi.hoisted(() => ({
  authStore: { current: {} as Record<string, unknown> },
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    getAgentQaVersion: vi.fn(() => '0.1.13'),
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

const mockWriteAuth = vi.mocked(writeAuth)
const mockRemoveAuth = vi.mocked(removeAuth)

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const HOST = '127.0.0.1:4317'
const SAME_SITE: IncomingHttpHeaders = { host: HOST, 'content-type': 'application/json' }
// The server keeps a token longer than the page's 10 s Undo link.
const RETENTION_MS = 30_000
const HEADER_SENTINEL = 'hdr-sentinel-7f3a91c2d4'
const MODEL_COMMENT = '# gpt goes through the org proxy'
const INLINE_COMMENT = '# pinned proxy model'

let router: ReturnType<typeof createRouter>
const tempDirs: string[] = []

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

const WORKSPACE = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

const modelsConfig = () => [
  ...WORKSPACE,
  'services: {}',
  'registry:',
  '  llms:',
  '    - name: a',
  '      provider: anthropic-compatible',
  '      model: model-a',
  '      baseURL: https://llm.example.test/v1',
  `    ${MODEL_COMMENT}`,
  '    - name: gpt',
  '      provider: anthropic-compatible',
  `      model: claude-proxy ${INLINE_COMMENT}`,
  '      baseURL: https://llm.example.test/v1',
  '      providerHeaders:',
  `        x-org-route: ${HEADER_SENTINEL}`,
  '    - name: b',
  '      provider: anthropic-compatible',
  '      model: model-b',
  '      baseURL: https://llm.example.test/v1',
  'use:',
  '  llm: a',
  '  mobile:',
  '    appState: preserve',
  '',
].join('\n')

const knowledgeConfig = (knowledge: readonly string[]) => [
  ...WORKSPACE,
  'services: {}',
  ...knowledge,
  'use:',
  '  timeout:',
  '    step: 30s',
  '    test: 10m',
  '    navigation: 10s',
  '  mobile:',
  '    appState: preserve',
  '',
].join('\n')

async function useConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-config-undo-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, yaml, 'utf-8')
  router = createRouter({
    db: { getRuns: () => [], close() {} } as any,
    configManager: new ConfigManager(configPath, (text) => text),
    configPath,
  })
  return configPath
}

function patchConfig(body: unknown, headers: IncomingHttpHeaders = SAME_SITE): Promise<MockResponse> {
  return invokeRoute('/api/config', { method: 'PATCH', headers, body: JSON.stringify(body) })
}

function postUndo(token: unknown, headers: IncomingHttpHeaders = SAME_SITE): Promise<MockResponse> {
  return invokeRoute('/api/config/undo', { method: 'POST', headers, body: JSON.stringify({ token }) })
}

function undoOf(res: MockResponse): { token: string; expiresAt: number } {
  const body = JSON.parse(res.body) as { undo?: { token: string; expiresAt: number } }
  expect(body.undo, 'the answer carries an undo token').toBeDefined()
  return body.undo!
}

async function llmNames(configPath: string): Promise<string[]> {
  const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { registry: { llms: { name: string }[] } }
  return parsed.registry.llms.map((llm) => llm.name)
}

const deleteGpt = { op: 'unset', path: ['registry', 'llms', { name: 'gpt' }] }

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  authStore.current = {}
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('undoable config writes', () => {
  it('UNDO-DELETE-MODEL-RESTORES: Undo puts the deleted model back at its index with its secret and comments', async () => {
    const configPath = await useConfig(modelsConfig())

    const deleted = await patchConfig({ undoable: true, changes: [deleteGpt] })

    expect(deleted.status).toBe(200)
    const undo = undoOf(deleted)
    expect(typeof undo.token).toBe('string')
    expect(undo.expiresAt).toBeGreaterThan(Date.now())
    expect(await llmNames(configPath)).toEqual(['a', 'b'])
    expect(await readFile(configPath, 'utf-8')).not.toContain(HEADER_SENTINEL)

    const restored = await postUndo(undo.token)

    expect(restored.status).toBe(200)
    const onDisk = await readFile(configPath)
    expect(JSON.parse(restored.body)).toEqual({
      restored: true,
      revision: createHash('sha256').update(onDisk).digest('hex'),
    })
    expect(await llmNames(configPath)).toEqual(['a', 'gpt', 'b'])
    const text = onDisk.toString('utf-8')
    const parsed = parseYaml(text) as { registry: { llms: { providerHeaders?: Record<string, string> }[] } }
    expect(parsed.registry.llms[1]?.providerHeaders).toEqual({ 'x-org-route': HEADER_SENTINEL })
    expect(text).toContain(MODEL_COMMENT)
    expect(text).toContain(INLINE_COMMENT)
    expect(text).toBe(modelsConfig())
  })

  it('UNDO-DATA-PATH: Undo of a data-path change restores the previous value', async () => {
    const configPath = await useConfig(knowledgeConfig(['knowledge:', '  dir: agent-qa-knowledge']))
    const before = await readFile(configPath)

    const changed = await patchConfig({ undoable: true, changes: [{ op: 'set', path: ['knowledge', 'dir'], value: 'kb' }] })

    expect(changed.status).toBe(200)
    expect((parseYaml(await readFile(configPath, 'utf-8')) as { knowledge: { dir: string } }).knowledge.dir).toBe('kb')
    const restored = await postUndo(undoOf(changed).token)
    expect(restored.status).toBe(200)
    expect((await readFile(configPath)).toString('utf-8')).toBe(before.toString('utf-8'))
  })

  it('UNDO-DATA-PATH: Undo of a data path that was absent removes the key again', async () => {
    const configPath = await useConfig(knowledgeConfig([]))
    const before = await readFile(configPath, 'utf-8')

    const changed = await patchConfig({ undoable: true, changes: [{ op: 'set', path: ['knowledge', 'dir'], value: 'kb' }] })

    expect(changed.status).toBe(200)
    const restored = await postUndo(undoOf(changed).token)
    expect(restored.status).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as Record<string, unknown>
    expect(parsed.knowledge).toBeUndefined()
    expect(await readFile(configPath, 'utf-8')).toBe(before)
  })

  it('UNDO-TOKEN-SINGLE-USE: a second Undo with the same token answers undo_expired and writes nothing', async () => {
    const configPath = await useConfig(modelsConfig())
    const deleted = await patchConfig({ undoable: true, changes: [deleteGpt] })
    const { token } = undoOf(deleted)
    expect((await postUndo(token)).status).toBe(200)
    const afterUndo = await readFile(configPath)

    const again = await postUndo(token)

    expect(again.status).toBe(410)
    expect(JSON.parse(again.body)).toEqual({ error: 'undo_expired' })
    expect(Buffer.compare(await readFile(configPath), afterUndo)).toBe(0)

    const unknown = await postUndo('00000000-0000-4000-8000-000000000000')
    expect(unknown.status).toBe(410)
    expect(JSON.parse(unknown.body)).toEqual({ error: 'undo_expired' })
  })

  it('UNDO-EXPIRES: a token past the retention window answers undo_expired and writes nothing', async () => {
    const configPath = await useConfig(modelsConfig())
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    const deleted = await patchConfig({ undoable: true, changes: [deleteGpt] })
    const { token, expiresAt } = undoOf(deleted)
    expect(expiresAt).toBe(start + RETENTION_MS)
    const afterDelete = await readFile(configPath)

    clock.mockReturnValue(start + RETENTION_MS + 1)
    const late = await postUndo(token)

    expect(late.status).toBe(410)
    expect(JSON.parse(late.body)).toEqual({ error: 'undo_expired' })
    expect(Buffer.compare(await readFile(configPath), afterDelete)).toBe(0)

    const changed = await patchConfig({ undoable: true, changes: [{ op: 'set', path: ['use', 'llm'], value: 'b' }] })
    clock.mockReturnValue(start + RETENTION_MS + RETENTION_MS - 1)
    expect((await postUndo(undoOf(changed).token)).status).toBe(200)
  })

  it('UNDO-CONFLICT: a model of the deleted name added since the delete is never overwritten', async () => {
    const configPath = await useConfig(modelsConfig())
    const deleted = await patchConfig({ undoable: true, changes: [deleteGpt] })
    const { token } = undoOf(deleted)
    const appended = await patchConfig({
      changes: [{
        op: 'append',
        path: ['registry', 'llms'],
        value: { name: 'gpt', provider: 'anthropic-compatible', model: 'other', baseURL: 'https://llm.example.test/v1' },
      }],
    })
    expect(appended.status).toBe(200)
    const before = await readFile(configPath)

    const conflicted = await postUndo(token)

    expect(conflicted.status).toBe(409)
    expect(JSON.parse(conflicted.body)).toEqual({ error: 'undo_conflict' })
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
  })

  it('UNDO-CONFLICT: a data path changed by an outside write since the change is never overwritten', async () => {
    const configPath = await useConfig(knowledgeConfig(['knowledge:', '  dir: agent-qa-knowledge']))
    const changed = await patchConfig({ undoable: true, changes: [{ op: 'set', path: ['knowledge', 'dir'], value: 'kb' }] })
    const { token } = undoOf(changed)
    const outside = (await readFile(configPath, 'utf-8')).replace('dir: kb', 'dir: kb-outside')
    await writeFile(configPath, outside, 'utf-8')

    const conflicted = await postUndo(token)

    expect(conflicted.status).toBe(409)
    expect(JSON.parse(conflicted.body)).toEqual({ error: 'undo_conflict' })
    expect(await readFile(configPath, 'utf-8')).toBe(outside)
  })

  it('UNDO-NEVER-RETURNS-SECRET: neither the delete answer nor the Undo answer carries the secret', async () => {
    await useConfig(modelsConfig())

    const deleted = await patchConfig({ undoable: true, changes: [deleteGpt] })
    const restored = await postUndo(undoOf(deleted).token)

    expect(deleted.status).toBe(200)
    expect(restored.status).toBe(200)
    expect(deleted.body).not.toContain(HEADER_SENTINEL)
    expect(restored.body).not.toContain(HEADER_SENTINEL)
    expect(deleted.headers['access-control-allow-origin']).toBeUndefined()
    expect(restored.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('UNDO-INPUT: a malformed Undo body is refused and a non-POST method is not allowed', async () => {
    const configPath = await useConfig(modelsConfig())
    const before = await readFile(configPath)

    const malformed = await invokeRoute('/api/config/undo', {
      method: 'POST',
      headers: SAME_SITE,
      body: JSON.stringify({ token: 42 }),
    })
    expect(malformed.status).toBe(400)
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid_write_input' })

    const get = await invokeRoute('/api/config/undo', { method: 'GET', headers: SAME_SITE })
    expect(get.status).toBe(405)
    expect(get.headers['access-control-allow-origin']).toBeUndefined()
    expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
  })
})

// One Undo restores a root `use.headless` that a set-if-absent completion moved under its new key.
describe('undo of a set-if-absent completion', () => {
  it('UNDO-LEGACY-HEADLESS-RESTORED: Undo of a completion that moved a root use.headless puts the root key back and removes the browser keys', async () => {
    const legacy = knowledgeConfig([]).replace('use:\n', 'use:\n  headless: false\n')
    const configPath = await useConfig(legacy)

    const completed = await patchConfig({
      undoable: true,
      changes: [
        { op: 'set', path: ['use', 'browser', 'name'], value: 'firefox' },
        { op: 'set-if-absent', path: ['use', 'browser', 'headless'], value: true },
      ],
    })

    expect(completed.status, completed.body).toBe(200)
    const afterCompletion = parseYaml(await readFile(configPath, 'utf-8')) as { use: Record<string, unknown> }
    expect(afterCompletion.use.browser).toEqual({ name: 'firefox', headless: false })
    expect('headless' in afterCompletion.use).toBe(false)

    const restored = await postUndo(undoOf(completed).token)

    expect(restored.status, restored.body).toBe(200)
    const parsed = parseYaml(await readFile(configPath, 'utf-8')) as { use: Record<string, unknown> }
    expect(parsed.use.headless).toBe(false)
    expect('browser' in parsed.use).toBe(false)
    expect(parsed).toEqual(parseYaml(legacy))
  })
})

const ACCESS_TOKEN = 'oauth-access-fixture-5b1d0e77'
const REFRESH_TOKEN = 'oauth-refresh-fixture-c2a94f10'
const SIGNED_IN = {
  type: 'oauth',
  provider: 'openai-subscription',
  tokens: { access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, expires: 1_777_675_000_000 },
}

function signOut(name: string, headers: IncomingHttpHeaders = SAME_SITE): Promise<MockResponse> {
  return invokeRoute(`/api/auth/${encodeURIComponent(name)}`, { method: 'DELETE', headers })
}

describe('undoable sign-out and key removal', () => {
  it('UNDO-SIGN-OUT-RESTORES-SERVER-SIDE: Undo writes the identical credential back and no answer carries it', async () => {
    await useConfig(modelsConfig())
    authStore.current = { gpt: structuredClone(SIGNED_IN), other: { type: 'api', provider: 'openai-compatible', key: 'sk-other' } }

    const removed = await signOut('gpt')

    expect(removed.status).toBe(200)
    const body = JSON.parse(removed.body) as { deleted: boolean; undo?: { token: string; expiresAt: number } }
    expect(body.deleted).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['deleted', 'undo'])
    expect(typeof body.undo?.token).toBe('string')
    expect(mockRemoveAuth).toHaveBeenCalledWith('gpt')
    expect(authStore.current).not.toHaveProperty('gpt')
    mockWriteAuth.mockClear()

    const restored = await postUndo(body.undo!.token)

    expect(restored.status).toBe(200)
    expect(JSON.parse(restored.body)).toEqual({ restored: true })
    expect(mockWriteAuth).toHaveBeenCalledTimes(1)
    expect(mockWriteAuth).toHaveBeenCalledWith('gpt', SIGNED_IN)
    expect(authStore.current.gpt).toEqual(SIGNED_IN)
    for (const answer of [removed, restored]) {
      expect(answer.body).not.toContain(ACCESS_TOKEN)
      expect(answer.body).not.toContain(REFRESH_TOKEN)
      expect(answer.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('UNDO-SIGN-OUT-RESTORES-SERVER-SIDE: removing a name with no credential answers deleted false and no token', async () => {
    await useConfig(modelsConfig())
    authStore.current = { other: { type: 'api', provider: 'openai-compatible', key: 'sk-other' } }

    const removed = await signOut('gpt')

    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.body)).toEqual({ deleted: false })
    expect(mockRemoveAuth).not.toHaveBeenCalled()
    expect(authStore.current).toEqual({ other: { type: 'api', provider: 'openai-compatible', key: 'sk-other' } })
  })

  it('UNDO-TOKEN-SINGLE-USE: a sign-out Undo token restores once', async () => {
    await useConfig(modelsConfig())
    authStore.current = { gpt: structuredClone(SIGNED_IN) }
    const { token } = undoOf(await signOut('gpt'))
    expect((await postUndo(token)).status).toBe(200)
    mockWriteAuth.mockClear()

    const again = await postUndo(token)

    expect(again.status).toBe(410)
    expect(JSON.parse(again.body)).toEqual({ error: 'undo_expired' })
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('UNDO-CONFLICT: a credential saved under the name since the sign-out is never overwritten', async () => {
    await useConfig(modelsConfig())
    authStore.current = { gpt: structuredClone(SIGNED_IN) }
    const { token } = undoOf(await signOut('gpt'))
    const saved = await invokeRoute('/api/auth/credential', {
      method: 'POST',
      headers: SAME_SITE,
      body: JSON.stringify({ configName: 'gpt', provider: 'anthropic-compatible', type: 'api-key', secret: 'sk-newer' }),
    })
    expect(saved.status).toBe(200)
    const newer = structuredClone(authStore.current.gpt)
    expect(newer).toBeDefined()
    mockWriteAuth.mockClear()

    const conflicted = await postUndo(token)

    expect(conflicted.status).toBe(409)
    expect(JSON.parse(conflicted.body)).toEqual({ error: 'undo_conflict' })
    expect(mockWriteAuth).not.toHaveBeenCalled()
    expect(authStore.current.gpt).toEqual(newer)
  })
})

const FOREIGN_ORIGIN = 'http://evil.example'
const CROSS_SITE_CALLERS: readonly { readonly name: string; readonly headers: IncomingHttpHeaders }[] = [
  { name: 'a foreign Origin', headers: { ...SAME_SITE, origin: FOREIGN_ORIGIN } },
  { name: 'Sec-Fetch-Site cross-site with no Origin', headers: { ...SAME_SITE, 'sec-fetch-site': 'cross-site' } },
  { name: 'a rebound Host', headers: { 'content-type': 'application/json', host: 'evil.example:4317', origin: 'http://evil.example:4317' } },
]

describe('UNDO-SAME-SITE', () => {
  for (const caller of CROSS_SITE_CALLERS) {
    it(`UNDO-SAME-SITE: POST /api/config/undo refuses ${caller.name} and restores nothing`, async () => {
      const configPath = await useConfig(modelsConfig())
      const { token } = undoOf(await patchConfig({ undoable: true, changes: [deleteGpt] }))
      const afterDelete = await readFile(configPath)

      const refused = await postUndo(token, caller.headers)

      expect(refused.status).toBe(403)
      expect(JSON.parse(refused.body)).toEqual({ error: 'cross_site_refused' })
      expect(refused.headers['access-control-allow-origin']).toBeUndefined()
      expect(Buffer.compare(await readFile(configPath), afterDelete)).toBe(0)
      expect((await postUndo(token)).status).toBe(200)
    })

    it(`UNDO-SAME-SITE: POST /api/config/undo refuses ${caller.name} for a sign-out token`, async () => {
      await useConfig(modelsConfig())
      authStore.current = { gpt: structuredClone(SIGNED_IN) }
      const { token } = undoOf(await signOut('gpt'))
      mockWriteAuth.mockClear()

      const refused = await postUndo(token, caller.headers)

      expect(refused.status).toBe(403)
      expect(refused.headers['access-control-allow-origin']).toBeUndefined()
      expect(mockWriteAuth).not.toHaveBeenCalled()
      expect(authStore.current).toEqual({})
    })

    it(`GET /api/config/undo refuses ${caller.name} before the method check`, async () => {
      const configPath = await useConfig(modelsConfig())
      const before = await readFile(configPath)

      const refused = await invokeRoute('/api/config/undo', { method: 'GET', headers: caller.headers })

      expect(refused.status).toBe(403)
      expect(JSON.parse(refused.body)).toEqual({ error: 'cross_site_refused' })
      expect(refused.headers['access-control-allow-origin']).toBeUndefined()
      expect(Buffer.compare(await readFile(configPath), before)).toBe(0)
    })

    it(`UNDO-SAME-SITE: DELETE /api/auth/:configName refuses ${caller.name} and removes nothing`, async () => {
      await useConfig(modelsConfig())
      authStore.current = { gpt: structuredClone(SIGNED_IN) }

      const refused = await signOut('gpt', caller.headers)

      expect(refused.status).toBe(403)
      expect(JSON.parse(refused.body)).toEqual({ error: 'cross_site_refused' })
      expect(refused.headers['access-control-allow-origin']).toBeUndefined()
      expect(mockRemoveAuth).not.toHaveBeenCalled()
      expect(authStore.current).toEqual({ gpt: SIGNED_IN })
    })
  }
})
