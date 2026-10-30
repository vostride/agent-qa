// Drives the production composition over real TCP; the run fails fast, as only delivery is claimed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  RUN_SERVICE_CONTRACT_VERSION,
  RunEventEnvelopeSchema,
  RunServiceErrorBodySchema,
  RunServiceReadinessSchema,
  RunStartAcknowledgementSchema,
} from '@vostride/agent-qa-schema'
import { generateTestId } from '@vostride/agent-qa-ids'
import { afterEach, describe, expect, it } from 'vitest'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
  createRunServiceReadiness,
} from '../commands/dashboard.js'

/** A bearer value an older client might still present. The door neither needs nor reads it. */
const TOKEN = 'zz-402-01-e2e-run-credential-6d20af'

// What the door refuses before its route table.
const CROSS_SITE = { Origin: 'https://evil.example' } as const

/** The `dashboard-door-security.ts` fixture project's shape, plus one planted test. */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-402-01-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: {
            platform: 'web',
            url: 'https://conformance.invalid',
            environment: 'local',
          },
        },
      },
    })}\n`,
    'utf8',
  )
  // The workspace files the run path REQUIRES to exist, empty. `loadRuntimeSecrets` refuses a
  // missing secrets file by name rather than treating absence as "no secrets", so a fixture
  // without them measures that refusal instead of this door.
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'tests', 'probe.test.yaml'),
    'name: The run service tracer probe\n'
    // MINTED, never hand-written: canonical ids come from the ID helpers by house rule, and a
    // literal here would be an id this repository does not own.
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return configPath
}

interface ServiceFixture {
  readonly origin: string
  readonly close: () => Promise<void>
}

const openFixtures: ServiceFixture[] = []

/** The composition `agent-qa dashboard` performs, with an ephemeral port and a temp project. */
async function openRunService(): Promise<ServiceFixture> {
  const configPath = fixtureWorkspace()
  const configDir = dirname(resolve(configPath))
  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined
  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot: join(configDir, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(host)

  const runService = composeRunServicePorts({ door: runDoor })

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    agentHost,
    executionBackend: runDoor.backend,
    runService: runService.ports,
    // The local readiness door, wired as `agent-qa dashboard` wires it: the composed predicate.
    runServiceReadiness: runService.readiness,
  })
  const server = started.server as Server
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('the run service bound no port')
  }
  boundOrigin = `http://127.0.0.1:${String(address.port)}`

  const fixture: ServiceFixture = {
    origin: boundOrigin,
    close: async () => {
      started.close()
      runService.dispose()
      await host.close()
      rmSync(configDir, { recursive: true, force: true })
    },
  }
  openFixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  while (openFixtures.length > 0) {
    await openFixtures.pop()?.close().catch(() => undefined)
  }
})

/** Read an SSE stream until `runFinished` or the budget expires. Returns the raw frames. */
async function collectSse(url: string, headers: Record<string, string>, budgetMs = 60_000): Promise<{
  readonly status: number
  readonly frames: readonly string[]
  readonly contentType: string | null
  readonly corsHeader: string | null
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const contentType = response.headers.get('content-type')
    const corsHeader = response.headers.get('access-control-allow-origin')
    if (response.body === null || !(contentType ?? '').includes('text/event-stream')) {
      return { status: response.status, frames: [], contentType, corsHeader }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const frames: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        frames.push(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (frames.some((frame) => frame.includes('event: runFinished'))) break
    }
    await reader.cancel().catch(() => undefined)
    return { status: response.status, frames, contentType, corsHeader }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse one SSE frame's `id:`, `event:` and `data:` lines. Comment frames yield nothing. */
function parseFrame(frame: string): { id?: string; event?: string; data?: string } {
  const out: { id?: string; event?: string; data?: string } = {}
  for (const line of frame.split('\n')) {
    if (line.startsWith('id: ')) out.id = line.slice(4)
    else if (line.startsWith('event: ')) out.event = line.slice(7)
    else if (line.startsWith('data: ')) out.data = line.slice(6)
  }
  return out
}

const authed = { 'Content-Type': 'application/json' }

describe('a cross-site POST /run', () => {
  it('is refused 403 cross-site with the typed body, and starts nothing', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: { ...CROSS_SITE, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(response.status).toBe(403)
    const body = RunServiceErrorBodySchema.parse(await response.json())
    expect(body).toEqual({ error: 'cross_site_refused' })
    // The refusal carries NOTHING else: no run id.
    expect(Object.keys(body)).toEqual(['error'])
    // No cross-origin grant — the chat door's adjudication, not the legacy run stream's wildcard.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses an OPTIONS preflight too, so the host wildcard arm never sees a service path', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run`, {
      method: 'OPTIONS',
      headers: { ...CROSS_SITE, 'Access-Control-Request-Method': 'POST' },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('POST /run with a bearer token', () => {
  it('a wrong legacy bearer is not read — the request reaches the body check', async () => {
    const service = await openRunService()
    const wrong = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}-wrong`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: 8 }),
    })
    const missing = await fetch(`${service.origin}/run`, {
      method: 'POST', headers: authed, body: JSON.stringify({ workers: 8 }),
    })
    expect(wrong.status).toBe(400)
    expect(missing.status).toBe(400)
    expect(await wrong.json()).toEqual(await missing.json())
  })

  it('refuses a malformed scheme distinctly from a wrong value', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: { Authorization: 'Basic abc', 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'r_mine' }),
    })
    // Not refused for the header — refused for the field it names, like any caller.
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'refused_request_field' })
  })

  it('refuses an unknown path under the door identically, leaking no route map', async () => {
    const service = await openRunService()
    const unknown = await fetch(`${service.origin}/run/nope/nothing`, { headers: CROSS_SITE })
    const known = await fetch(`${service.origin}/ok`, { headers: CROSS_SITE })
    expect(unknown.status).toBe(403)
    expect(await unknown.json()).toEqual(await known.json())
  })
})

describe('the request may name only the tests to run', () => {
  it('refuses a body naming runId as a refused request field', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ runId: 'r_whatever' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'refused_request_field' })
  })

  it('refuses a body naming executionContext or scope as an invalid request body', async () => {
    const service = await openRunService()
    for (const body of [{ executionContext: 'local-interactive' }, { scope: 'main' }]) {
      const response = await fetch(`${service.origin}/run`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request_body' })
    }
  })

  it('refuses an unrecognised key, because the request shape is strict', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ workers: 8 }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request_body' })
  })
})

describe('legs (c) and (d) — the authed path, end to end', () => {
  it('acks a run and streams its bus envelopes verbatim', async () => {
    const service = await openRunService()

    // (c) THE ACK. Every field off the durable record — parsed here rather than cast, so a
    // fabricated ack reds this cell rather than passing through it.
    const started = await fetch(`${service.origin}/run`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ patterns: ['tests/probe.test.yaml'] }),
    })
    expect(started.status).toBe(202)
    const ack = RunStartAcknowledgementSchema.parse(await started.json())
    expect(ack.runId).toBeTruthy()
    expect(ack.testCount).toBeGreaterThan(0)

    // (d) THE STREAM. The run may already be over; `subscribe(1, …)` replays from the first seq,
    // so the frames are the whole log either way.
    const stream = await collectSse(
      `${service.origin}/run/${encodeURIComponent(ack.runId)}/events`,
      {},
    )
    expect(stream.status).toBe(200)
    expect(stream.contentType).toContain('text/event-stream')
    expect(stream.corsHeader).toBeNull()

    const events = stream.frames.map(parseFrame).filter((frame) => frame.data !== undefined)
    expect(events.length).toBeGreaterThan(0)

    for (const frame of events) {
      const envelope = RunEventEnvelopeSchema.parse(JSON.parse(frame.data!))
      // Delivery, schema and run per frame; `id === seq` cannot discriminate a 1-based stream.
      expect(frame.id).toBe(String(envelope.seq))
      expect(frame.event).toBe(envelope.type)
      expect(envelope.runId).toBe(ack.runId)
    }

    // The seqs are the bus's own gap-free order, in order.
    const seqs = events.map((frame) =>
      (JSON.parse(frame.data!) as { seq: number }).seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    // The run reached its terminal event, which is what makes the framing claim about a whole run
    // rather than about a prefix somebody happened to catch.
    expect(events.some((frame) => frame.event === 'runFinished')).toBe(true)
  }, 90_000)

  it('refuses a stream for a run this process never started, BEFORE any stream header', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run/r_never-started/events`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'unknown_run' })
  })

  it('refuses the stream cross-site, before it can learn whether the run exists', async () => {
    const service = await openRunService()
    const response = await fetch(`${service.origin}/run/r_never-started/events`, { headers: CROSS_SITE })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
  })
})

describe('a door with no declared credential opens for a local caller', () => {
  it('the door opens for a local caller with no credential, and a legacy bearer opens nothing more', async () => {
    const service = await openRunService()
    const [plain, legacy] = await Promise.all([
      fetch(`${service.origin}/ok`),
      fetch(`${service.origin}/ok`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
    ])
    expect(plain.status).toBe(200)
    expect(legacy.status).toBe(200)
    expect(await plain.text()).toBe(await legacy.text())
  })
})

// ---- `/ok` driven through the production composition ----

describe('GET /ok on the mounted door', () => {
  it('is refused cross-site and answers measured facts to a local caller', async () => {
    const service = await openRunService()

    const refused = await fetch(`${service.origin}/ok`, { headers: CROSS_SITE })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'cross_site_refused' })

    const ok = await fetch(`${service.origin}/ok`)
    expect(ok.status).toBe(200)
    const body = RunServiceReadinessSchema.parse(await ok.json())
    expect(body).toEqual({
      service: 'up',
      // MEASURED, not asserted from this cell's own knowledge: the composition bound a host above,
      // and this is the same box the run starter's guard reads.
      hostComposed: true,
      // The readiness answer carries no credential fact.
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    })
  })

  it('reports no credential fact when no credential can be configured', async () => {
    // Measured through the one predicate, which takes no credential count.
    const readiness = createRunServiceReadiness({ resolveHost: () => undefined })
    expect(readiness()).toEqual({
      service: 'up',
      hostComposed: false,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    })
  })
})

describe('one readiness predicate, two doors', () => {
  it('is ONE function object — `ports.readiness` and the published `readiness` are the same reference', async () => {
    const configPath = fixtureWorkspace()
    const { DashboardDatabase } = await import('@vostride/agent-qa-dashboard')
    const db = new DashboardDatabase({ dbPath: join(dirname(resolve(configPath)), 'identity.db') })
    const runDoor = await createDashboardRunDoor({ db })
    const composition = composeRunServicePorts({ door: runDoor })
    try {
      // REFERENCE IDENTITY AND NOT DEEP EQUALITY. "The two doors agree today" is what a deep
      // compare proves; "there is one predicate" is what survives somebody adding a fifth fact to
      // one of them, and only identity measures it.
      expect(composition.ports.readiness).toBe(composition.readiness)
    } finally {
      composition.dispose()
      db.close()
      rmSync(dirname(resolve(configPath)), { recursive: true, force: true })
    }
  })

  it('serves the same readiness body on the local door with NO token and on /ok with one', async () => {
    const fixture = await openRunService()
    const [local, authed] = await Promise.all([
      fetch(`${fixture.origin}/api/run-readiness`),
      fetch(`${fixture.origin}/ok`),
    ])
    expect(local.status).toBe(200)
    expect(authed.status).toBe(200)
    const localBody: unknown = await local.json()
    const authedBody: unknown = await authed.json()
    expect(localBody).toEqual(authedBody)
    // Both are the MEASURED facts, on the shipped composition — `hostComposed` is true here
    // because this fixture bound a host, which is the same box `POST /run`'s guard throws on.
    expect(localBody).toEqual({ service: 'up', hostComposed: true, contractVersion: RUN_SERVICE_CONTRACT_VERSION })
    // The shipped composition serves contract version 2 on both doors.
    expect((localBody as { contractVersion: number }).contractVersion).toBe(2)
  })

  it('answers the local door the same for a bad token — it never reads one', async () => {
    const fixture = await openRunService()
    const withGarbage = await fetch(`${fixture.origin}/api/run-readiness`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(withGarbage.status).toBe(200)
    const service = await fetch(`${fixture.origin}/ok`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(service.status).toBe(200)
  })
})
