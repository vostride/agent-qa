import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase } from '../db/database.js'
import { isLoopbackHost } from '@vostride/agent-qa-core'
import { RUN_SERVICE_CONTRACT_VERSION } from '@vostride/agent-qa-schema'
import { DashboardRemoteBindRefusedError, startServer } from '../server/server.js'

// Cells read `server.address()` off the listening socket; `0.0.0.0` is refused with any config.

const NON_LOOPBACK_HOST = '0.0.0.0'

const roots: string[] = []
const started: Array<{ close: () => void }> = []
const dbs: DashboardDatabase[] = []

afterEach(() => {
  while (started.length > 0) started.pop()?.close()
  while (dbs.length > 0) dbs.pop()?.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function configPathFor(legacyTokens = false): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'agent-qa-bind-guard-'))
  roots.push(tempDir)
  const configPath = join(tempDir, 'agent-qa.config.yaml')
  // A legacy run-service token block nothing reads, so the bind refusal is measured with it.
  writeFileSync(configPath, legacyTokens
    ? [
        'testDir: tests',
        'services:',
        '  dashboard:',
        '    runServiceTokens:',
        '      - name: ci',
        '        tokenEnvVar: AGENT_QA_BIND_GUARD_LEGACY_TOKEN',
        '        trustScope: { project: acme }',
        '',
      ].join('\n')
    : 'testDir: tests\n')
  return configPath
}

type ServicePorts = NonNullable<Parameters<typeof startServer>[0]['runService']>
type Readiness = NonNullable<Parameters<typeof startServer>[0]['runServiceReadiness']>

/**
 * A run-service port set whose readiness is INJECTED by the caller.
 *
 * The bind cells never call any of these; the readiness cells below hand in one function object
 * and then drive both doors, which is what lets an equality cell measure "the same predicate" and
 * not merely "two functions that agree today".
 */
function stubRunServicePorts(readiness: Readiness): ServicePorts {
  return {
    invokeRunStart: () => { throw new Error('the bind cells never start a run') },
    attach: () => undefined,
    readiness,
  } as unknown as ServicePorts
}

const INERT_READINESS: Readiness = () => ({
  service: 'up',
  hostComposed: false,
  contractVersion: RUN_SERVICE_CONTRACT_VERSION,
})

async function start(opts: {
  host?: string
  port?: number
  mountService?: boolean
  readiness?: Readiness
  legacyTokens?: boolean
}): Promise<{ server: Server; port: number; close: () => void }> {
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  dbs.push(db)
  const readiness = opts.readiness ?? INERT_READINESS
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: opts.port ?? 0,
    configPath: configPathFor(opts.legacyTokens === true),
    ...(opts.host === undefined ? {} : { host: opts.host }),
    ...(opts.mountService === true ? { runService: stubRunServicePorts(readiness) } : {}),
    ...(opts.readiness === undefined ? {} : { runServiceReadiness: readiness }),
  })
  started.push(handle)
  return handle
}

/** The address the socket is actually bound to — the only evidence a bind cell may rest on. */
function boundAddress(server: Server): string {
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('the server exposed no address — it is not listening')
  return address.address
}

/** A port nothing holds, released before it is handed on. Used to prove a refusal listened. */
async function reserveFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((ok) => { probe.listen(0, '127.0.0.1', ok) })
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((ok) => { probe.close(() => { ok() }) })
  return port
}

/** True when this process can bind `port` — i.e. nothing else is listening on it. */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer()
  const free = await new Promise<boolean>((ok) => {
    probe.once('error', () => { ok(false) })
    probe.listen(port, '0.0.0.0', () => { ok(true) })
  })
  await new Promise<void>((done) => { probe.close(() => { done() }) })
  return free
}

describe('the dashboard bind contract', () => {
  it('binds LOOPBACK by default — read off the listening socket, not off the options', async () => {
    const { server } = await start({})
    expect(boundAddress(server)).toBe('127.0.0.1')
  })

  it('announces and resolves the port the socket holds when asked for port 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { server, port } = await start({ port: 0 })
      const bound = (server.address() as AddressInfo).port
      expect(bound).toBeGreaterThan(0)
      expect(port).toBe(bound)
      expect(log.mock.calls.map((call) => String(call[0])))
        .toContain(`Dashboard running at http://localhost:${String(bound)}`)
    } finally {
      log.mockRestore()
    }
  })

  it.each(['localhost', '127.0.0.1', '::1'])(
    'binds the loopback spelling %s with no credential declared',
    async (host) => {
      const { server } = await start({ host })
      // `localhost` resolves to whichever loopback address this host prefers; both are loopback and
      // the cell accepts either rather than pinning one machine's resolver order.
      expect(['127.0.0.1', '::1']).toContain(boundAddress(server))
    },
  )

  it('REFUSES an explicit non-loopback host when zero run-service credentials are declared', async () => {
    const port = await reserveFreePort()
    await expect(start({ host: NON_LOOPBACK_HOST, port }))
      .rejects.toBeInstanceOf(DashboardRemoteBindRefusedError)
    // NOTHING LISTENED. The refusal is pre-listen, so the port it was handed is still free — the
    // assertion that distinguishes "threw after binding and then tore down" from "never bound".
    await expect(portIsFree(port)).resolves.toBe(true)
  })

  it('names the host and the config key that governs it, and never a token value', async () => {
    const error = await start({ host: NON_LOOPBACK_HOST }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DashboardRemoteBindRefusedError)
    const message = (error as Error).message
    expect(message).toContain(NON_LOOPBACK_HOST)
    expect(message).toContain('services.dashboard.host')
  })

  it('the bind refusal tells a person to forward the port with ssh', async () => {
    const error = await start({ host: NON_LOOPBACK_HOST, port: 0 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DashboardRemoteBindRefusedError)
    const message = (error as Error).message
    expect(message).toContain(
      'forward its port with ssh -L 3470:localhost:3470 <host> and open http://localhost:3470/.',
    )
    expect(message).toContain('services.dashboard.host')
    expect(message).not.toContain('proxy')
  })

  it('the bind refusal names the requested port in the ssh forward', async () => {
    const error = await start({ host: NON_LOOPBACK_HOST, port: 4123 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DashboardRemoteBindRefusedError)
    const message = (error as Error).message
    expect(message).toContain('ssh -L 4123:localhost:4123 <host>')
    expect(message).toContain('http://localhost:4123/')
  })

  // A credential guards only the run-service paths, so it never makes a non-loopback bind safe.
  it('REFUSES a non-loopback host EVEN WITH the authed run service mounted', async () => {
    const port = await reserveFreePort()
    await expect(start({ host: NON_LOOPBACK_HOST, port, mountService: true }))
      .rejects.toBeInstanceOf(DashboardRemoteBindRefusedError)
    await expect(portIsFree(port)).resolves.toBe(true)
  })

  it('refuses a non-loopback host that MOUNTED a service with a zero count', async () => {
    await expect(start({ host: NON_LOOPBACK_HOST, mountService: true }))
      .rejects.toBeInstanceOf(DashboardRemoteBindRefusedError)
  })

  it('offers no remedy that would publish the anonymous surface', async () => {
    // Declaring a credential is what opens the hole, so the refusal must not suggest it.
    const error = await start({ host: NON_LOOPBACK_HOST }).catch((e: unknown) => e)
    const message = (error as Error).message
    expect(message).not.toContain('runServiceTokens')
    expect(message).toContain('services.dashboard.host')
  })

  it('still binds every LOOPBACK spelling, with and without credentials', async () => {
    for (const [host, mountService] of [['127.0.0.1', false], ['localhost', true]] as const) {
      const { server } = await start({ host, mountService })
      expect(isLoopbackHost(boundAddress(server) ?? '')).toBe(true)
    }
  })

  it('refuses a non-loopback bind with and without a legacy token block, and an ordinary local start serves', async () => {
    for (const legacyTokens of [false, true]) {
      const port = await reserveFreePort()
      await expect(start({ host: NON_LOOPBACK_HOST, port, mountService: true, legacyTokens }),
        `legacy token block ${String(legacyTokens)}`)
        .rejects.toBeInstanceOf(DashboardRemoteBindRefusedError)
      await expect(portIsFree(port)).resolves.toBe(true)
    }
    const error = await start({ host: NON_LOOPBACK_HOST, legacyTokens: true }).catch((e: unknown) => e)
    expect((error as Error).message).not.toMatch(/runServiceTokens|credential declared|declare a/u)

    const { server } = await start({ mountService: true, legacyTokens: true })
    expect(boundAddress(server)).toBe('127.0.0.1')
    const port = (server.address() as AddressInfo).port
    const ok = await fetch(`http://127.0.0.1:${String(port)}/ok`)
    expect(ok.status).toBe(200)
  })
})

// One function object serves both doors, so the equality is about one predicate, not two copies.
describe('the local readiness door', () => {
  /** A readiness whose facts MOVE, so a door that snapshotted rather than called is visible. */
  function movingReadiness(): { fn: Readiness; flip: () => void } {
    let hostComposed = false
    return {
      fn: () => ({
        service: 'up' as const,
        hostComposed,
        contractVersion: RUN_SERVICE_CONTRACT_VERSION,
      }),
      flip: () => { hostComposed = true },
    }
  }

  async function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{
    status: number
    body: unknown
  }> {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { headers })
    return { status: response.status, body: await response.json().catch(() => undefined) }
  }

  it('serves the SAME body the authed /ok serves, for one composed state, under both doors', async () => {
    const { fn, flip } = movingReadiness()
    const { server } = await start({ mountService: true, readiness: fn })
    const port = (server.address() as AddressInfo).port

    const before = await Promise.all([
      get(port, '/api/run-readiness'),
      get(port, '/ok'),
    ])
    expect(before[0].status).toBe(200)
    expect(before[1].status).toBe(200)
    expect(before[0].body).toEqual(before[1].body)
    expect(before[0].body).toEqual({
      service: 'up',
      hostComposed: false,
      contractVersion: RUN_SERVICE_CONTRACT_VERSION,
    })

    // THE STATE MOVES. Both doors must move with it — a door that answered from a value captured
    // at mount time would now disagree, and the equality above alone could not see that.
    flip()
    const after = await Promise.all([
      get(port, '/api/run-readiness'),
      get(port, '/ok'),
    ])
    expect(after[0].body).toEqual(after[1].body)
    expect(after[0].body).toMatchObject({ hostComposed: true })
  })

  it('answers BOTH doors with no token at all — the bind guard is what keeps them local', async () => {
    const { fn } = movingReadiness()
    const { server } = await start({ mountService: true, readiness: fn })
    const port = (server.address() as AddressInfo).port

    await expect(get(port, '/api/run-readiness')).resolves.toMatchObject({ status: 200 })
    await expect(get(port, '/ok')).resolves.toMatchObject({ status: 200 })
    await expect(get(port, '/ok', { origin: 'https://evil.example' }))
      .resolves.toMatchObject({ status: 403, body: { error: 'cross_site_refused' } })
  })

  it('answers honestly with NO run service mounted — never a 404', async () => {
    // An in-process mount with no service still hands over the producer, so preflight is answered.
    const { server } = await start({
      readiness: () => ({
        service: 'up',
        hostComposed: true,
        contractVersion: RUN_SERVICE_CONTRACT_VERSION,
      }),
    })
    const port = (server.address() as AddressInfo).port
    const local = await get(port, '/api/run-readiness')
    expect(local.status).toBe(200)
    expect(local.body).toEqual({ service: 'up', hostComposed: true, contractVersion: RUN_SERVICE_CONTRACT_VERSION })
    // …and the authed door genuinely is not mounted on this arm.
    await expect(get(port, '/ok')).resolves.toMatchObject({ status: 404 })
  })

  it('answers 503 BY NAME on a mount that was given no predicate — not a fabricated answer', async () => {
    const { server } = await start({})
    const port = (server.address() as AddressInfo).port
    await expect(get(port, '/api/run-readiness')).resolves.toMatchObject({ status: 503 })
  })
})
