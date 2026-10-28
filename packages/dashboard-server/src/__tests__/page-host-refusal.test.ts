import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

const INDEX_HTML = '<!doctype html><title>dashboard</title>'

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
  uiDir = await mkdtemp(join(tmpdir(), 'agent-qa-page-host-'))
  await writeFile(join(uiDir, 'index.html'), INDEX_HTML, 'utf-8')
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

async function send(method: string, path: string, host: string): Promise<Answer> {
  return await new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { host } },
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

function refusalText(boundPort: number): string {
  const p = String(boundPort)
  return (
    'The agent-qa dashboard answers only at localhost, 127.0.0.1 or [::1].\n'
    + `Open http://localhost:${p}/ on the machine it runs on, or forward the port with `
    + `ssh -L ${p}:localhost:${p} <host>.\n`
  )
}

const PAGE_REQUESTS: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/'],
  ['GET', '/app.js'],
  ['GET', '/runs/abc'],
  ['GET', '/live/r1'],
  ['OPTIONS', '/'],
]

describe('a page under a foreign Host is told which address to open', () => {
  it.each(PAGE_REQUESTS)('%s %s under Host evil.test', async (method, path) => {
    const answer = await send(method, path, 'evil.test')
    expect(answer.status).toBe(403)
    expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(answer.body).toBe(refusalText(port))
    expect(answer.body).not.toContain('evil.test')
  })

  it.each(PAGE_REQUESTS)('%s %s under Host evil.test with the bound port', async (method, path) => {
    const answer = await send(method, path, `evil.test:${String(port)}`)
    expect(answer.status).toBe(403)
    expect(answer.body).toBe(refusalText(port))
    expect(answer.body).not.toContain('evil.test')
  })

  it.each(['127.0.0.1', 'localhost', '[::1]'])('the page answers at %s', async (name) => {
    const answer = await send('GET', '/', `${name}:${String(port)}`)
    expect(answer.status).toBe(200)
    expect(answer.body).toBe(INDEX_HTML)
  })
})
