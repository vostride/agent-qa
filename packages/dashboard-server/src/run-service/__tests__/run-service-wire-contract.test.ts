// Real transport, planted seqs; the expected bytes come from the session's own replay.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import {
  RUN_SERVICE_CONTRACT_VERSION,
  type RunEventEnvelope,
  type RunSession,
  type RunStartAcknowledgement,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '../../db/database.js'
import { startServer } from '../../server/server.js'
import type { RunServicePorts } from '../run-service-routes.js'

const RUN_ID = 'r_wire'

/**
 * The feed, with CHOSEN seqs — non-contiguous, not 1-based, and with a gap the framing cells need.
 *
 * A stream-local counter emits `1, 2, 3 …` for this feed and the envelopes say `4, 9, 10 …`, so
 * every `id:` line below is a real discriminator rather than a coincidence of ordinals.
 */
const FEED: readonly RunEventEnvelope[] = Object.freeze([
  { seq: 4, ts: 40, runId: RUN_ID, type: 'runStarted', payload: { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 2, handles: [2, 5] } },
  { seq: 9, ts: 90, runId: RUN_ID, type: 'testStarted', payload: { testId: 'a', testIndex: 2, name: 'a' } },
  { seq: 10, ts: 100, runId: RUN_ID, type: 'stepStarted', payload: { testIndex: 2, stepIndex: 0, stepText: 'a0' } },
  { seq: 16, ts: 160, runId: RUN_ID, type: 'testStarted', payload: { testId: 'b', testIndex: 5, name: 'b' } },
  { seq: 23, ts: 230, runId: RUN_ID, type: 'runWarning', payload: { code: 'w', message: 'the run said something' } },
  { seq: 24, ts: 240, runId: RUN_ID, type: 'verdict', payload: { verdict: 'failed' } },
  { seq: 25, ts: 250, runId: RUN_ID, type: 'runFinished', payload: { aggregateVerdict: 'failed', disposition: 'detached', finalSeq: 25 } },
] as unknown as readonly RunEventEnvelope[])

/**
 * One session over the feed — the SAME object the door attaches to and the cells read back.
 *
 * `subscribe` delivers synchronously, matching the shipped `RunSession`'s replay contract, and
 * hands out the very envelope objects the door will serialise. That identity is what makes the
 * expected side of the verbatim cells the session's own bytes rather than a second copy.
 */
function sessionOverFeed(): RunSession {
  return {
    id: RUN_ID as RunSession['id'],
    status: 'running',
    executionContext: 'local-headless' as RunSession['executionContext'],
    subscribe(_fromSeq, handler) {
      for (const envelope of FEED) handler(envelope)
      return () => undefined
    },
    // A planted session with no browser declares no stream and hands out no frame subscription.
    subscribeFrames() { return undefined },
    streamCapabilityOf() { return { kind: 'none' } },
    cancel() { /* nothing to cancel on a planted session */ },
    done: Promise.resolve({ verdict: 'failed' } as never),
  }
}

const ACK: RunStartAcknowledgement = {
  runId: RUN_ID as RunStartAcknowledgement['runId'],
  scope: 'main' as unknown as RunStartAcknowledgement['scope'],
  executionContext: 'local-headless' as RunStartAcknowledgement['executionContext'],
  buildOrdinal: 0,
  startedAt: 0,
  testCount: 2,
}

function servicePorts(session: RunSession): RunServicePorts {
  return {
    invokeRunStart: async () => ACK,
    attach: (runId) => runId === RUN_ID ? session : undefined,
    readiness: () => ({
      service: 'up',
      hostComposed: true,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    }),
    // A fixture with no live view answers a mint with 503 by name, never a fabricated token.
    mintLiveUrl: () => Promise.reject(
      Object.assign(new Error('no live-view port is bound on this fixture'), {
        name: 'LiveViewUnavailableError',
      }),
    ),
  }
}

const CONFIG = `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .secrets.local
concurrency: 2
`

let tempDir: string | undefined
let started: { server: Server; port: number; close: () => void } | undefined
let db: DashboardDatabase | undefined

/** Bring up the SHIPPED dashboard host with the run service mounted over the planted session. */
async function mountShippedHost(session: RunSession): Promise<number> {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-qa-402-06-wire-'))
  const configPath = join(tempDir, 'agent-qa.config.yaml')
  writeFileSync(join(tempDir, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(tempDir, '.env'), '')
  writeFileSync(join(tempDir, '.secrets.local'), '')
  writeFileSync(configPath, CONFIG)

  db = new DashboardDatabase({ dbPath: ':memory:' })
  started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    workspacePaths: resolveWorkspacePaths({ config: parseYaml(CONFIG), configPath }),
    runService: servicePorts(session),
  })
  const address = started.server.address() as AddressInfo | null
  if (address === null) throw new Error('server did not expose an address')
  return address.port
}

afterEach(() => {
  started?.close()
  started = undefined
  db?.close()
  db = undefined
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

/** The whole stream body as it arrived, decoded from the raw bytes and never re-encoded. */
async function readStreamBody(url: string, headers: Record<string, string>): Promise<{
  readonly status: number
  readonly contentType: string | null
  readonly body: string
  readonly headers: Headers
}> {
  const response = await fetch(url, { headers })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: buffer.toString('utf8'),
    headers: response.headers,
  }
}

/** The frames a body carries, split on the SSE record separator. Comment frames included. */
function framesOf(body: string): readonly string[] {
  return body.split('\n\n').filter((frame) => frame.length > 0)
}

describe('SSE framing is the frozen envelope, verbatim', () => {
  it('each record is `id: seq`, `event: type`, `data: the envelope’s own JSON` — byte for byte', async () => {
    const session = sessionOverFeed()
    const port = await mountShippedHost(session)

    // THE EXPECTED SIDE, DERIVED FROM THE SESSION'S OWN REPLAY. Nothing below is written by hand:
    // the same session object the door attached to is subscribed here, and what it delivers is
    // serialised with the same `JSON.stringify` the router uses.
    const replayed: RunEventEnvelope[] = []
    session.subscribe(1, (event) => { replayed.push(event) })
    expect(replayed.length).toBeGreaterThan(0)
    const expectedFrames = replayed.map((event) =>
      `id: ${String(event.seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}`)

    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events`,
      {},
    )
    expect(response.status).toBe(200)
    expect(response.contentType).toContain('text/event-stream')

    const frames = framesOf(response.body)
    // The opening comment frame is the shipped keepalive preamble, then one record per envelope.
    expect(frames[0]).toBe(':ok')
    expect(frames.slice(1)).toEqual(expectedFrames)

    // AND THE SEQS ARE NOT ORDINALS, which is what makes the equality above discriminating: a
    // stream-local counter would have emitted 1..7 and every `id:` line would differ.
    const ids = frames.slice(1).map((frame) => frame.split('\n')[0])
    expect(ids).toEqual(['id: 4', 'id: 9', 'id: 10', 'id: 16', 'id: 23', 'id: 24', 'id: 25'])
    expect(ids).not.toEqual(replayed.map((_event, index) => `id: ${String(index + 1)}`))
  })

  it('adds no field, drops none and renames none — the data line round-trips to the envelope', async () => {
    const session = sessionOverFeed()
    const port = await mountShippedHost(session)
    const replayed: RunEventEnvelope[] = []
    session.subscribe(1, (event) => { replayed.push(event) })

    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events`,
      {},
    )
    const dataLines = framesOf(response.body)
      .slice(1)
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6))

    expect(dataLines.length).toBe(replayed.length)
    for (const [index, line] of dataLines.entries()) {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const source = replayed[index]! as unknown as Record<string, unknown>
      // The KEY SET first, so an added or dropped field is named rather than buried in a diff.
      expect(Object.keys(parsed)).toEqual(Object.keys(source))
      expect(parsed).toEqual(source)
    }
  })
})

describe('the verdict and the run id are settled BEFORE any stream header', () => {
  it('a cross-site request on the stream route gets a JSON refusal and no event-stream header', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events`,
      { Origin: 'https://evil.example' },
    )
    expect(response.status).toBe(403)
    expect(response.contentType).toContain('application/json')
    // A `200 text/event-stream` cannot be told it failed. The absence of that header on the SAME
    // response is the claim — asserting only the status would pass on a response that wrote both.
    expect(response.contentType).not.toContain('text/event-stream')
    expect(JSON.parse(response.body)).toEqual({ error: 'cross_site_refused' })
    // And nothing of the run reached the socket, not even the keepalive preamble.
    expect(response.body).not.toContain(':ok')
    expect(response.body).not.toContain('event: runStarted')
  })

  it('a cross-site fetch metadata likewise, before the run is even looked up', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/r_this-process-never-started-it/events`,
      { 'Sec-Fetch-Site': 'cross-site' },
    )
    expect(response.status).toBe(403)
    expect(response.contentType).toContain('application/json')
    expect(response.contentType).not.toContain('text/event-stream')
    expect(JSON.parse(response.body)).toEqual({ error: 'cross_site_refused' })
  })

  it('an unknown run id gets a JSON 404 and no event-stream header', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/r_this-process-never-started-it/events`,
      {},
    )
    expect(response.status).toBe(404)
    expect(response.contentType).toContain('application/json')
    expect(response.contentType).not.toContain('text/event-stream')
    expect(JSON.parse(response.body)).toEqual({ error: 'unknown_run' })
    expect(response.body).not.toContain(':ok')
  })

  it('a malformed handle gets a JSON 400 and no event-stream header', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const response = await readStreamBody(
      `http://127.0.0.1:${String(port)}/run/${RUN_ID}/events?handle=not-a-number`,
      {},
    )
    expect(response.status).toBe(400)
    expect(response.contentType).toContain('application/json')
    expect(response.contentType).not.toContain('text/event-stream')
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_handle' })
    expect(response.body).not.toContain(':ok')
  })
})

// Every cross-origin header is asserted absent, because a partial grant passes a one-header cell.

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
] as const

function assertNoCrossOriginGrant(headers: Headers, label: string): void {
  for (const header of CORS_HEADERS) {
    expect(headers.get(header), `${label} / ${header}`).toBeNull()
  }
}

describe('no cross-origin grant on any service route, success or refusal', () => {
  it('covers a SUCCESS response — the stream, the ack and readiness', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const origin = `http://127.0.0.1:${String(port)}`

    const stream = await readStreamBody(`${origin}/run/${RUN_ID}/events`, {
      })
    expect(stream.status).toBe(200)
    assertNoCrossOriginGrant(stream.headers, 'GET /run/:id/events 200')

    const ack = await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(ack.status).toBe(202)
    assertNoCrossOriginGrant(ack.headers, 'POST /run 202')

    const ok = await fetch(`${origin}/ok`)
    expect(ok.status).toBe(200)
    assertNoCrossOriginGrant(ok.headers, 'GET /ok 200')
  })

  it('covers a REFUSAL response, including an OPTIONS preflight the host would otherwise answer', async () => {
    const port = await mountShippedHost(sessionOverFeed())
    const origin = `http://127.0.0.1:${String(port)}`

    // A simple cross-site POST (text/plain) needs no preflight, so the guard refuses it.
    const refused = await fetch(`${origin}/run`, {
      method: 'POST', body: '{}', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'cross_site_refused' })
    assertNoCrossOriginGrant(refused.headers, 'POST /run 403')

    // THE PREFLIGHT IS THE ONE THAT MATTERS. The host answers a wildcard `OPTIONS` for its own
    // routes; the run service is consulted ABOVE that arm, so a service path never reaches it.
    const preflight = await fetch(`${origin}/run`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(preflight.status).toBe(403)
    assertNoCrossOriginGrant(preflight.headers, 'OPTIONS /run 403')

    const unknown = await fetch(`${origin}/run/nope/nothing`)
    expect(unknown.status).toBe(404)
    assertNoCrossOriginGrant(unknown.headers, 'GET /run/nope/nothing 404')

    // A CONTROL, so "no header anywhere" is not what this file is measuring: the host's OWN routes
    // are unaffected by the service mount, and the assertion above is about the service's paths.
    const localReadiness = await fetch(`${origin}/api/run-readiness`)
    expect([200, 503]).toContain(localReadiness.status)
  })
})
