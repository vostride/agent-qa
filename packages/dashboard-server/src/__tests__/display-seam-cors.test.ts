/**
 * THE RUN-TEXT READS CARRY NO CROSS-ORIGIN READ GRANT AND NO REBINDABLE HOST (405 CR-01).
 *
 * WHAT THESE ARMS ARE. 405-10 put a display-restore walk on the local door's run reads, and CR-01
 * took the wildcard `Access-Control-Allow-Origin` off them, because a page on any origin the
 * operator happens to have open could otherwise `fetch` the run list, read the ids out of it, then
 * `fetch` the artifact and read the run's text. 441-15 (D-07) removed the restore: every arm now
 * serves the text as it was stored, masked at write. The no-grant posture and the Host check stay,
 * because what a run recorded is still not something another origin should read.
 *
 *   PREDICATE A — THE WIRE. Drives the SHIPPED router over a real socket with real Host, Origin
 *   and Sec-Fetch-Site headers, and reads the response headers a browser would read. It is blind
 *   to which source symbol wrote them, so a rename or a second private JSON writer cannot fool it.
 *   It carries a CONTROL — a legacy read that must still answer `*` — so the cell cannot pass by
 *   the header capture having quietly broken.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AgentHost } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { createRouter } from '../server/routes.js'

const RUN_ID = 'run-405-cr01'

/**
 * THE GUARDED RUN-TEXT ARMS. Named here as PATHS rather than as a source list, because what a
 * browser can read is a property of the wire and not of a symbol table.
 */
const RUN_TEXT_READ_PATHS: readonly string[] = [
  '/api/runs',
  `/api/runs/${RUN_ID}`,
  `/api/runs/${RUN_ID}/artifact`,
  `/api/runs/${RUN_ID}/execution-logs`,
  `/api/runs/${RUN_ID}/detail`,
  // 406-01 (D-04): the failure view's read; the verdict sentence quotes the failing step's error.
  `/api/runs/${RUN_ID}/analysis`,
  // 407-01 (D-05): the Knowledge panel's read, over every step's text and served brief line.
  `/api/runs/${RUN_ID}/knowledge`,
]

/** A legacy read that is NOT guarded. Its wildcard is unchanged and this cell says so. */
const LEGACY_READ_PATH = '/api/stats'

function seedDatabase(): DashboardDatabase {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  db.insertRun({
    id: RUN_ID,
    name: 'Checkout',
    filePath: 'tests/checkout.yaml',
    status: 'failed',
    duration: 12,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:00:12.000Z',
  })
  db.insertRunArtifact({ runId: RUN_ID, kind: 'test' })
  db.insertExecutionLog({
    id: `${RUN_ID}-hook-0`,
    runId: RUN_ID,
    type: 'hook',
    name: 'setup',
    phase: 'setup',
    status: 'passed',
    duration: 1,
  })
  return db
}

/**
 * A host that BINDS the run-detail op. Without one `/api/runs/:id/detail` 503s, and a 503 carries
 * no grant either — the shape of vacuity this file's non-vacuity assertions exist to refuse.
 */
function runTextHost(): AgentHost {
  return {
    registry: {},
    caller: { kind: 'test' },
    runsPostProcessingFunctionId: 'test:post-processing',
    runsEventsFunctionId: 'test:events',
    runsDetailFunctionId: 'test:runs-detail',
    runsArtifactFunctionId: 'test:runs-artifact',
    analysisGetFunctionId: 'test:analysis-get',
    // 407-01 (D-05): the sixth dispatched id, widened here so every AgentHost literal in the
    // workspace still satisfies the interface.
    runsKnowledgeFunctionId: 'test:run-knowledge',
    invokeFunction: () => Promise.resolve({
      runId: RUN_ID,
      members: [{ testIndex: 0, attempts: 1 }],
      steps: [],
      subActions: [],
      tokens: { measuredSteps: 0, unmeasuredSteps: 0 },
    }),
  } as unknown as AgentHost
}

interface Probe {
  status: number
  allowOrigin: string | undefined
  body: string
}

let server: Server
let port = 0

beforeAll(async () => {
  const db = seedDatabase()
  const router = createRouter(
    { db, agentHost: runTextHost() } as unknown as Parameters<typeof createRouter>[0],
  )
  server = createServer(router)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => { closed() }))
})

/**
 * One real request, with the Host header under this cell's control.
 *
 * `fetch` refuses to set Host, and Host is exactly the header a DNS-rebinding attacker controls —
 * so the raw client is not a convenience here, it is the only way to pose the question.
 */
async function probe(
  path: string,
  headers: Record<string, string> = {},
): Promise<Probe> {
  return await new Promise<Probe>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${String(port)}`, ...headers } },
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
    req.end()
  })
}

describe('PREDICATE A — the wire', () => {
  it('the CONTROL still grants the wildcard, so an absent grant below is a fact and not a broken probe', async () => {
    const answer = await probe(LEGACY_READ_PATH)
    expect(answer.status).toBe(200)
    expect(answer.allowOrigin).toBe('*')
  })

  it.each(RUN_TEXT_READ_PATHS)('%s answers a same-origin reader and grants NO cross-origin read', async (path) => {
    const answer = await probe(path, {
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
    })
    // Non-vacuous: an arm that 404'd or 503'd would carry no grant either, and would prove nothing.
    expect(answer.status).toBe(200)
    expect(answer.body).toContain(RUN_ID)
    expect(
      answer.allowOrigin,
      `${path} handed a cross-origin reader a grant over a run's stored text`,
    ).toBeUndefined()
  })

  it.each(RUN_TEXT_READ_PATHS)('%s admits the local non-browser drive that sends no Origin', async (path) => {
    // The CLI, `curl` and the conformance harness send no Origin. Refusing them would brick the
    // local drive these arms exist for, so this is a load-bearing admission and not an oversight.
    const answer = await probe(path)
    expect(answer.status).toBe(200)
    expect(answer.body).toContain(RUN_ID)
    expect(answer.allowOrigin).toBeUndefined()
  })

  it.each(RUN_TEXT_READ_PATHS)('%s refuses a page on another origin', async (path) => {
    const answer = await probe(path, { origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' })
    expect(answer.status).toBe(403)
    expect(answer.allowOrigin).toBeUndefined()
    expect(answer.body).not.toContain(RUN_ID)
  })

  it.each(RUN_TEXT_READ_PATHS)('%s refuses a rebound name that resolves to this loopback port', async (path) => {
    // DNS rebinding is the attack the missing header alone does NOT stop: the attacker's own name
    // resolves here, so the browser considers the read same-origin and asks for no grant at all.
    // The Host check is what closes it — and on `/detail`, whose answer never carried a grant to
    // begin with, it is the ONLY rung standing between a rebound page and the run's text.
    const answer = await probe(path, { host: 'evil.test' })
    expect(answer.status).toBe(403)
    expect(answer.body).not.toContain(RUN_ID)
  })
})
