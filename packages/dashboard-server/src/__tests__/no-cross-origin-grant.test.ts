import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

let server: Server
let close: () => void
let db: DashboardDatabase
let uiDir = ''
let port = 0

beforeEach(async () => {
  uiDir = await mkdtemp(join(tmpdir(), 'agent-qa-no-grant-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>dashboard</title>', 'utf-8')
  await writeFile(join(uiDir, 'app.js'), 'console.log("app")\n', 'utf-8')
  db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({ db, port: 0, uiDir, declaredSecretMask: (text) => text })
  server = started.server
  close = started.close
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterEach(async () => {
  close()
  await new Promise<void>((closed) => server.close(() => { closed() }))
  db.close()
  await rm(uiDir, { recursive: true, force: true })
})

async function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return await new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function expectNoGrant(answer: Answer): void {
  expect(answer.headers['access-control-allow-origin']).toBeUndefined()
  expect(answer.headers['access-control-allow-methods']).toBeUndefined()
  expect(answer.headers['access-control-allow-headers']).toBeUndefined()
}

describe('no dashboard answer carries a cross-origin grant', () => {
  it('an API read', async () => {
    const answer = await send('GET', '/api/stats')
    expect(answer.status).toBe(200)
    expectNoGrant(answer)
  })

  it('an admitted OPTIONS on an API path gets the router 404', async () => {
    const answer = await send('OPTIONS', '/api/runs')
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toEqual({ error: 'Not found' })
    expectNoGrant(answer)
  })

  it('an OPTIONS on a page path gets a plain 404', async () => {
    const answer = await send('OPTIONS', '/')
    expect(answer.status).toBe(404)
    expect(answer.body).toBe('Not Found')
    expectNoGrant(answer)
  })

  it('a static file', async () => {
    const answer = await send('GET', '/app.js')
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('console.log')
    expectNoGrant(answer)
  })

  it('the SPA fallback', async () => {
    const answer = await send('GET', '/some/spa/path')
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('<title>dashboard</title>')
    expectNoGrant(answer)
  })

  it('an unknown API path', async () => {
    const answer = await send('GET', '/api/nope')
    expect(answer.status).toBe(404)
    expectNoGrant(answer)
  })

  it('a refused cross-site read', async () => {
    const answer = await send('GET', '/api/variables', {
      origin: 'http://evil.test',
      'sec-fetch-site': 'cross-site',
    })
    expect(answer.status).toBe(403)
    expectNoGrant(answer)
  })
})
