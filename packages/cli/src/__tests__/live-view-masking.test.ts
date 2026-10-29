// THE RETAINED LIVE-LINK CELL (403 Task 3 · 432-21 D-12/D-13 · C432-RETAINED-LIVE-LINK).
//
// WHAT THIS EXISTS FOR. The run service is tokenless, and the signed live-view link it mints is the
// one credential it still issues. That link keeps its own subject and expiry checks, independent of
// who asked, including for concurrent tokenless mints (EDGE-17). The cell drives the production
// composition over real TCP: `composeLiveView`, `composeRunServicePorts`, `composeDashboardDoor` and
// `createDashboardRunDoor`, exactly as `agent-qa dashboard` composes them.
//
// 2026-10-14 (441-48, D-01): the door-masking cells that used to share this file are deleted with
// their subject. The door holds no secrets of its own for masking, so a minted token is recorded as
// written: `(1) BIND HALF`, `(3) a door with nothing bound still resolves maskingSecrets to
// undefined` and `EDITOR-TOKEN-MASKED` are gone (`(2) CONSUME HALF` went with 441-58).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { RunsLiveUrlResultSchema } from '@vostride/agent-qa-schema'
import { generateTestId } from '@vostride/agent-qa-ids'
import { afterEach, describe, expect, it } from 'vitest'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
} from '../commands/dashboard.js'
import { composeLiveView } from '../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../composition/run-service-session-registry.js'

const openRoots: string[] = []

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-403-01-masking-'))
  openRoots.push(root)
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
            // `local` folds to `mutating-local`, which allows in every execution context — the
            // remote door composes no confirm channel, so a shared target would deny before a run
            // ever started and this cell would measure the gate rather than the link.
            environment: 'local',
          },
        },
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'tests', 'probe.test.yaml'),
    'name: The live-view link probe\n'
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return configPath
}

interface Fixture {
  readonly origin: string
  /** The live-view validator the frame socket uses, by reference (403 D-06). */
  readonly validate: ReturnType<typeof composeLiveView>['validate']
  readonly close: () => Promise<void>
}

const openFixtures: Fixture[] = []

/** The shipped command's composition: every composer here is the production one. */
async function openFixture(): Promise<Fixture> {
  const configPath = fixtureWorkspace()
  const configDir = dirname(resolve(configPath))
  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined

  const sessions = createRunServiceSessionRegistry({ observeSessions: runDoor.observeSessions })

  const composedLiveView = composeLiveView({ sessions, origin: () => boundOrigin })
  // 432-21 (D-12): the tokenless run service, composed as the command composes it.
  const runService = composeRunServicePorts({ door: runDoor, sessions })

  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot: join(configDir, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
    liveView: composedLiveView.liveView,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(host)

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    agentHost,
    executionBackend: runDoor.backend,
    runService: runService.ports,
    runServiceReadiness: runService.readiness,
  })
  const address = (started.server as Server).address()
  if (address === null || typeof address === 'string') throw new TypeError('the server bound no port')
  boundOrigin = `http://127.0.0.1:${String(address.port)}`

  const fixture: Fixture = {
    origin: boundOrigin,
    validate: composedLiveView.validate,
    close: async () => {
      started.close()
      runService.dispose()
      sessions.dispose()
      await host.close()
      db.close()
      rmSync(configDir, { recursive: true, force: true })
    },
  }
  openFixtures.push(fixture)
  return fixture
}

async function startRunOverTheWire(fixture: Fixture): Promise<string> {
  const response = await fetch(`${fixture.origin}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patterns: ['tests/probe.test.yaml'] }),
  })
  expect(response.status).toBe(202)
  const ack = await response.json() as { runId?: string }
  expect(typeof ack.runId, 'the ack names the run this door started').toBe('string')
  return ack.runId as string
}

afterEach(async () => {
  while (openFixtures.length > 0) await openFixtures.pop()?.close().catch(() => undefined)
  while (openRoots.length > 0) rmSync(openRoots.pop() as string, { recursive: true, force: true })
})

// 432-21 (D-12/D-13, EDGE-17): the live-view link is the one credential the run service still
// mints, and its subject and expiry are checked by the validator independently of who asked — no
// bearer, no caller field. Two tokenless mints for two concurrently started runs each bind their own
// subject: neither token opens the other run, and neither outlives its expiry.
describe('a tokenless mint stays bound to its own subject and expiry', () => {
  it('concurrent tokenless mints bind independent subjects, and expiry is enforced', async () => {
    const fixture = await openFixture()
    const [runA, runB] = await Promise.all([startRunOverTheWire(fixture), startRunOverTheWire(fixture)])
    expect(runA).not.toBe(runB)

    const mint = async (runId: string, handle: number) => {
      const response = await fetch(`${fixture.origin}/run/${encodeURIComponent(runId)}/live-url?handle=${String(handle)}`)
      expect(response.status, `the tokenless run service mints for ${runId}`).toBe(200)
      return RunsLiveUrlResultSchema.parse(await response.json())
    }
    const [mintedA, mintedB] = await Promise.all([mint(runA, 0), mint(runB, 0)])
    const tokenA = mintedA.liveUrl.split('#')[1] as string
    const tokenB = mintedB.liveUrl.split('#')[1] as string
    expect(tokenA).not.toBe(tokenB)
    const now = Date.now()

    // Each token validates for its OWN subject, and its claims name exactly that run and handle.
    const okA = fixture.validate(tokenA, { subject: { kind: 'run', id: runA }, now })
    const okB = fixture.validate(tokenB, { subject: { kind: 'run', id: runB }, now })
    if (okA.kind !== 'ok' || okB.kind !== 'ok') throw new Error(`a fresh mint did not validate: ${okA.kind}/${okB.kind}`)
    expect(okA.claims.subject).toEqual({ kind: 'run', runId: runA, handle: 0 })
    expect(okB.claims.subject).toEqual({ kind: 'run', runId: runB, handle: 0 })

    // Neither opens the other run, and neither opens an editor session of the same id.
    expect(fixture.validate(tokenA, { subject: { kind: 'run', id: runB }, now }).kind).toBe('refused')
    expect(fixture.validate(tokenB, { subject: { kind: 'run', id: runA }, now }).kind).toBe('refused')
    expect(fixture.validate(tokenA, { subject: { kind: 'editor', id: runA }, now }).kind).toBe('refused')

    // And neither outlives its expiry.
    expect(fixture.validate(tokenA, { subject: { kind: 'run', id: runA }, now: mintedA.expiresAt + 1 }))
      .toEqual({ kind: 'refused', reason: 'expired' })
    // A tampered token is refused by its signature, not by a caller check.
    const tampered = `${tokenA.slice(0, -2)}${tokenA.endsWith('AA') ? 'BB' : 'AA'}`
    expect(fixture.validate(tampered, { subject: { kind: 'run', id: runA }, now }).kind).toBe('refused')

    // SUBJECT SELECTION is the door's own check, and it stands with no credential behind it: a
    // malformed or ambiguous handle is refused by name and nothing is minted for it.
    for (const query of ['?handle=not-a-handle', '?handle=0&handle=1']) {
      const refused = await fetch(`${fixture.origin}/run/${encodeURIComponent(runA)}/live-url${query}`)
      expect(refused.status, `the door minted for ${query}`).toBe(400)
      expect(await refused.json()).toEqual({ error: 'invalid_handle' })
    }
  }, 180_000)
})
