import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

import { ConfigManager } from '../config/index.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'

const ENV_CONTENT = 'PLANTED_KEY=planted-value\n'

interface Answer {
  status: number
  allowOrigin: string | undefined
  body: string
}

interface Probe {
  method: string
  path: string
  body?: unknown
}

let server: Server
let port = 0
let workspaceDir = ''
let envFile = ''
let db: DashboardDatabase

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-same-site-guard-'))
  const configPath = join(workspaceDir, 'agent-qa.config.yaml')
  await writeFile(configPath, 'workspace:\n  envFile: .env\n', 'utf-8')
  envFile = join(workspaceDir, '.env')
  await writeFile(envFile, ENV_CONTENT, 'utf-8')
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

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => { closed() }))
  db.close()
  await rm(workspaceDir, { recursive: true, force: true })
})

async function send(probe: Probe, headers: Record<string, string>): Promise<Answer> {
  const payload = probe.body === undefined ? undefined : JSON.stringify(probe.body)
  return await new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: probe.path,
        method: probe.method,
        headers: {
          host: `127.0.0.1:${String(port)}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => {
          const allowOrigin = res.headers['access-control-allow-origin']
          resolve({
            status: res.statusCode ?? 0,
            allowOrigin: typeof allowOrigin === 'string' ? allowOrigin : undefined,
            body,
          })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const REFUSED_CALLERS: ReadonlyArray<[string, Record<string, string>]> = [
  ['a foreign Origin', { origin: 'http://evil.test' }],
  ['the null Origin', { origin: 'null' }],
  ['a cross-site fetch with no Origin', { 'sec-fetch-site': 'cross-site' }],
  ['a foreign Host', { host: 'evil.test' }],
]

const REQUESTS: readonly Probe[] = [
  { method: 'GET', path: '/api/variables' },
  { method: 'PUT', path: '/api/variables', body: { key: 'PLANTED_KEY', value: 'overwritten' } },
  { method: 'POST', path: '/api/hooks/setup/run', body: {} },
  { method: 'POST', path: '/api/runs/some-run/cancel', body: {} },
  { method: 'GET', path: '/api/nope' },
]

const CASES = REFUSED_CALLERS.flatMap(([caller, headers]) =>
  REQUESTS.map((probe) => [caller, `${probe.method} ${probe.path}`, headers, probe] as const),
)

describe('a page on another site or under a foreign Host cannot reach the API', () => {
  it.each(CASES)('%s is refused on %s with no cross-origin grant', async (_caller, _route, headers, probe) => {
    const answer = await send(probe, headers)
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'cross_site_refused' })
    expect(answer.allowOrigin).toBeUndefined()
    expect(answer.body).not.toContain('planted-value')
    expect(await readFile(envFile, 'utf-8')).toBe(ENV_CONTENT)
  })
})

describe('the dashboard\'s own page and a local client still read the variables', () => {
  function expectVariables(answer: Answer): void {
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({
      variables: [{ key: 'PLANTED_KEY', value: 'planted-value' }],
    })
  }

  it('the page on its own origin reads them', async () => {
    expectVariables(await send({ method: 'GET', path: '/api/variables' }, {
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
    }))
  })

  it('a client that sends no Origin reads them', async () => {
    expectVariables(await send({ method: 'GET', path: '/api/variables' }, {}))
  })

  it.each(['127.0.0.1', 'localhost', '[::1]'])('a client naming the server as %s reads them', async (name) => {
    expectVariables(await send({ method: 'GET', path: '/api/variables' }, {
      host: `${name}:${String(port)}`,
    }))
  })
})
