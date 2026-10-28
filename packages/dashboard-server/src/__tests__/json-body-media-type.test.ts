import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

import { ConfigManager } from '../config/index.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'

const ENV_CONTENT = 'PLANTED_KEY=planted-value\n'
const OVERWRITE = JSON.stringify({ key: 'PLANTED_KEY', value: 'overwritten' })

interface Answer {
  status: number
  body: string
}

let server: Server
let port = 0
let workspaceDir = ''
let envFile = ''
let db: DashboardDatabase

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-json-body-'))
  const configPath = join(workspaceDir, 'agent-qa.config.yaml')
  await writeFile(configPath, 'workspace:\n  envFile: .env\n', 'utf-8')
  envFile = join(workspaceDir, '.env')
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['**/*.yaml'],
        suiteMatch: ['**/*.suite.yaml'],
        hooksFile: 'runtime/hooks/custom-hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath,
  })
  db = new DashboardDatabase({ dbPath: ':memory:' })
  const router = createRouter({
    db,
    workspacePaths,
    configManager: new ConfigManager(configPath, (text) => text),
    configPath,
  } as unknown as Parameters<typeof createRouter>[0])
  server = createServer(router)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

beforeEach(async () => {
  await writeFile(envFile, ENV_CONTENT, 'utf-8')
})

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => { closed() }))
  db.close()
  await rm(workspaceDir, { recursive: true, force: true })
})

async function putVariables(headers: Record<string, string>): Promise<Answer> {
  return await new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/variables',
        method: 'PUT',
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      },
    )
    req.on('error', reject)
    req.end(OVERWRITE)
  })
}

describe('the dashboard refuses a body that is not JSON', () => {
  it.each([
    ['a text/plain body', { 'content-type': 'text/plain' }],
    ['a body with no Content-Type', {}],
  ] as const)('refuses %s with 415 before the route reads it', async (_case, headers) => {
    const answer = await putVariables(headers)
    expect(answer.status).toBe(415)
    expect(JSON.parse(answer.body)).toEqual({ error: 'unsupported_media_type' })
    expect(await readFile(envFile, 'utf-8')).toBe(ENV_CONTENT)
  })

  it('reads a body sent as application/json with a charset', async () => {
    const answer = await putVariables({ 'content-type': 'application/json; charset=utf-8' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ updated: true })
    expect(await readFile(envFile, 'utf-8')).toContain('PLANTED_KEY=overwritten')
  })

  it('handles a body-less POST without asking for a Content-Type', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/runs/some-run/cancel`, {
      method: 'POST',
    })
    expect(response.status).not.toBe(415)
    expect(await response.json()).toEqual({ error: 'Queue not available' })
  })

  it('refuses a cross-site text/plain body as cross-site, not as the wrong media type', async () => {
    const answer = await putVariables({
      'content-type': 'text/plain',
      origin: 'http://evil.test',
    })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'cross_site_refused' })
    expect(await readFile(envFile, 'utf-8')).toBe(ENV_CONTENT)
  })
})
