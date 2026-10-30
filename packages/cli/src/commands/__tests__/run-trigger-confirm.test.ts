// A click on Run starts the run through the shipped queue and door; nothing asks or parks.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

import { composeDashboardDoor, createDashboardRunDoor } from '../dashboard.js'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { AuditRow } from '../../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type Fixture = ReturnType<typeof createInProcessFixture>

/** `packages/cli/src/commands/__tests__` → the `agent-qa` repo root, five levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** The OP-level gate's rows, which land in the host's own sink rather than the run's. */
function opAuditRows(fixture: Fixture): AuditRow[] {
  const path = join(fixture.agentQaRoot, 'execution_audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditRow)
}

/**
 * Every `run:start` decision this project recorded, IN THE ORDER THEY WERE TAKEN.
 *
 * SORTED, AND THE SORT IS LOAD-BEARING. Each run writes to its OWN run-scoped sink, so
 * `auditRows` concatenates one file per run directory in whatever order the directory listing
 * yields — which is not chronological, and is stable enough to look chronological in a one-run
 * cell. A two-run cell that indexed positionally would read the second run's verdict off the first
 * run's row roughly half the time; measured, in the always-arm cell below, before this existed.
 */
function runStartRows(fixture: Fixture): AuditRow[] {
  return (auditRows(fixture) as AuditRow[])
    .filter((row) => row.action === 'run:start')
    .sort((left, right) => String(left.ts).localeCompare(String(right.ts)))
}

interface Scene {
  readonly origin: string
  readonly fixture: Fixture
  readonly db: DashboardDatabase
  settled(): { runId: string; status: string; details: Record<string, unknown> }[]
  // The run's own bus envelopes, in seq order, recorded off its session.
  buffered(runId: string): Record<string, unknown>[]
  /**
   * Every `ExecuteOptions` the queue handed the SHIPPED execution backend, in order.
   *
   * THE SEAM ITSELF, not a projection of it. `server.ts` reads `meta.timeout` off the persisted row
   * and passes it into `executionBackend.execute` — so a cell that wants to know what a planted
   * timeout does has to read the argument the backend was actually called with. Recorded by
   * patching the instance method the queue already holds a reference to, which leaves the backend's
   * own behaviour (and its emitter) untouched.
   */
  executed(): Record<string, unknown>[]
  close(): Promise<void>
}

const openScenes: Scene[] = []

// The dashboard as the shipped command starts it, over a project the fixture wrote.
async function openScene(input: {
  readonly fixture: Fixture
}): Promise<Scene> {
  const { fixture } = input
  // AN EMPTY BROWSERS ROOT, so a member's failure is a property of the fixture rather than of the
  // machine — `dashboard-run-door.test.ts`'s own pin, for its own reason. Without it an APPROVED
  // run launches a real browser and knocks on the counting target a second time, and every
  // "nobody knocked" / "knocked once" assertion starts measuring what is installed here.
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const runDoor = await createDashboardRunDoor({ db })
  const door = composeDashboardDoor({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    boundOrigin: () => undefined,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(door.host)

  const executed: Record<string, unknown>[] = []
  const backendExecute = runDoor.backend.execute.bind(runDoor.backend)
  ;(runDoor.backend as unknown as { execute: (opts: Record<string, unknown>) => unknown }).execute = (
    opts: Record<string, unknown>,
  ) => {
    executed.push(opts)
    return backendExecute(opts as never)
  }

  const settled: { runId: string; status: string; details: Record<string, unknown> }[] = []
  runDoor.backend.on(
    'run-settled',
    (runId: string, status: string, details: Record<string, unknown>) => {
      settled.push({ runId, status, details })
    },
  )

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath: fixture.configPath,
    workspacePaths: resolveWorkspacePaths({
      config: parseYaml(readFileSync(fixture.configPath, 'utf8')) as never,
      configPath: fixture.configPath,
    }),
    executionBackend: runDoor.backend,
    agentHost: door.agentHost,
  })

  // `subscribe(1, …)` replays from the first seq, so a recorder here sees every envelope.
  const recordedEnvelopes = new Map<string, Record<string, unknown>[]>()
  runDoor.observeSessions((session) => {
    const id = session.id as unknown as string
    const own: Record<string, unknown>[] = []
    recordedEnvelopes.set(id, own)
    session.subscribe(1, (envelope) => { own.push(envelope as unknown as Record<string, unknown>) })
  })

  // `startServer` echoes back the port it was ASKED for, so an ephemeral bind (`port: 0`) has to be
  // read off the socket — `server.appium-ownership.test.ts` does the same, for the same reason.
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new TypeError('the server bound no port')

  const scene: Scene = {
    origin: `http://127.0.0.1:${String(address.port)}`,
    fixture,
    db,
    settled: () => settled,
    buffered: (runId) => recordedEnvelopes.get(runId) ?? [],
    executed: () => executed,
    close: async () => {
      started.close()
      await door.host.close()
    },
  }
  openScenes.push(scene)
  return scene
}

afterEach(async () => {
  while (openScenes.length > 0) {
    const scene = openScenes.pop()!
    await scene.close()
  }
})
afterAll(() => { removeInProcessFixtures() })

// Click Run through the shipped trigger route; `strayScope` is an older page's field nobody reads.
async function triggerRun(scene: Scene, strayScope?: string): Promise<string> {
  const response = await fetch(`${scene.origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file: scene.fixture.testPattern,
      ...(strayScope === undefined ? {} : { ['confirm' + 'Scope']: strayScope }),
    }),
  })
  const body = await response.json() as { runId?: string; error?: string }
  expect(body.error, 'the trigger route refused before any run existed').toBeUndefined()
  expect(body.runId, 'the trigger route minted no run id').toBeTruthy()
  return body.runId!
}


async function waitFor(assertion: () => void, timeoutMs = 180_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((settle) => setTimeout(settle, 25))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

/** The execution context the run published on its own `runStarted` envelope. */
function startedContext(scene: Scene, runId: string): unknown {
  const started = scene.buffered(runId).find((event) => event['type'] === 'runStarted') as
    { payload?: { executionContext?: unknown } } | undefined
  return started?.payload?.executionContext
}

describe('the run button never asks: a click starts the run', () => {
  it('DENY ON SILENCE — nothing is asked, so nothing is reaped: the run starts with the channel open', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const runId = await triggerRun(scene)

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })

      expect(runStartRows(fixture)).toEqual([])
      expect(opAuditRows(fixture).filter((r) => r.action === 'fn:runs.start')).toEqual([])
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(scene.buffered(runId).map((event) => event['type'])).toContain('runStarted')
      // The door names nobody, so the run records the one context it answers.
      expect(startedContext(scene, runId)).toBe('local-headless')
    } finally {
      await target.close()
    }
  }, 240_000)

  it('the queue still addresses the triggering browser, and no read-path response hands the scope back', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const historical = `run-trigger:${randomUUID()}`
      const testPath = join(fixture.project, 'tests', 'direct.yaml')
      const runId = scene.db.insertPendingRun({
        name: 'written-before',
        filePath: testPath,
        metadata: { args: [testPath], ['confirm' + 'Scope']: historical },
      })

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })
      expect(scene.db.getRun(runId)?.metadata?.['confirm' + 'Scope'], 'the planted row is vacuous').toBe(historical)
      expect(scene.executed().find((opts) => opts['runId'] === runId)).not.toHaveProperty('confirm' + 'Scope')

      for (const path of [`/api/runs/${runId}`, '/api/runs']) {
        const response = await fetch(`${scene.origin}${path}`)
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body, `${path} still hands out the confirm scope`).not.toContain(historical)
      }
      const detail = await (await fetch(`${scene.origin}/api/runs/${runId}`)).json() as {
        run: { id: string; metadata: Record<string, unknown> | null }
      }
      expect(detail.run.id).toBe(runId)
      expect(detail.run.metadata).not.toHaveProperty('confirm' + 'Scope')
    } finally {
      await target.close()
    }
  }, 240_000)

  it('ALWAYS — there is no mint to make: two runs on one channel both start, and neither is asked', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })

      const firstRun = await triggerRun(scene)
      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })
      const secondRun = await triggerRun(scene)
      await waitFor(() => { expect(scene.settled()).toHaveLength(2) })

      expect(firstRun).not.toBe(secondRun)
      expect(runStartRows(fixture)).toEqual([])
      for (const runId of [firstRun, secondRun]) {
        expect(scene.buffered(runId).map((event) => event['type'])).toContain('runStarted')
      }
      expect(existsSync(join(fixture.project, 'agent-qa-knowledge', 'grants.jsonl'))).toBe(false)
    } finally {
      await target.close()
    }
  }, 300_000)

  it('closing the tab denies nothing: the run it triggered still starts', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const channel = await fetch(`${scene.origin}/api/run-confirm/channel`)
      expect(channel.status).toBe(404)
      const runId = await triggerRun(scene)

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })

      expect(runStartRows(fixture)).toEqual([])
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(scene.buffered(runId).map((event) => event['type'])).toContain('runStarted')
    } finally {
      await target.close()
    }
  }, 240_000)

  it('NO LIVE CHANNEL — the trigger is headless, nobody is asked, and the run starts', async () => {
    // With no channel held the trigger claims no interactivity, and that does not gate the start.
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const runId = await triggerRun(scene)

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })

      expect(runStartRows(fixture)).toEqual([])
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(startedContext(scene, runId)).toBe('local-headless')
    } finally {
      await target.close()
    }
  }, 240_000)
})

describe('a dashboard trigger starts its run directly', () => {
  it('one trigger request starts the run, and a stray scope field is neither kept nor forwarded', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })

      const controller = new AbortController()
      const channel = await fetch(`${scene.origin}/api/run-confirm/channel`, { signal: controller.signal })
      const channelStatus = channel.status
      controller.abort()
      expect(channelStatus, 'the retired run-confirm channel is still served').toBe(404)

      const stray = `run-trigger:${randomUUID()}`
      const runId = await triggerRun(scene, stray)
      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })

      const dispatched = scene.executed().filter((opts) => opts['runId'] === runId)
      expect(dispatched, 'the queue did not dispatch the click exactly once').toHaveLength(1)
      expect(dispatched[0]).not.toHaveProperty('confirm' + 'Scope')
      expect(scene.db.getRun(runId)?.metadata ?? {}).not.toHaveProperty('confirm' + 'Scope')
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(startedContext(scene, runId)).toBe('local-headless')
    } finally {
      await target.close()
    }
  }, 240_000)
})

// Every GET that serializes a run row or a run artifact payload, where `enqueue` stores `metadata`.
function runMetadataBearingReads(runId: string): readonly string[] {
  return [
    `/api/runs/${runId}`,
    '/api/runs',
    '/api/queue/status?completed=true',
    `/api/runs/${runId}/artifact`,
  ]
}

describe('the confirm scope leaves on no door and can be planted on no run', () => {
  it('a run driven through JobQueue.enqueue hands its scope back on none of the metadata-bearing GETs', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const historical = `run-trigger:${randomUUID()}`
      const testPath = join(fixture.project, 'tests', 'direct.yaml')
      const metadata = { args: [testPath], ['confirm' + 'Scope']: historical }
      const runId = scene.db.insertPendingRun({ name: 'written-before', filePath: testPath, metadata })
      scene.db.insertRunArtifact({
        runId,
        kind: 'test',
        payload: {
          runtime: { platform: 'web', queued: true },
          source: { name: 'written-before', filePath: testPath, loadStatus: 'queued' },
          metadata: { ...metadata, attributes: {} },
        },
      })
      const stream = { scopeId: historical }

      // THE SCOPE REALLY IS ON BOTH PERSISTENCE SITES. Asserted FIRST and off the RAW handle, or
      // every absence below would be a statement about a run that never carried the value —
      // which is exactly the shape the vacuous DOOR 3 cell had.
      await waitFor(() => {
        expect(scene.db.getRun(runId)?.metadata?.['confirm' + 'Scope']).toBe(stream.scopeId)
      })
      expect(
        (scene.db.getRunArtifact(runId)?.payload as { metadata?: Record<string, unknown> } | undefined)?.metadata,
        'the artifact payload does not carry the scope — this cell would be vacuous',
      ).toMatchObject({ ['confirm' + 'Scope']: stream.scopeId })

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })

      // Assert the artifact carries this run's payload first, or every absence below is vacuous.
      const bundle = await (await fetch(`${scene.origin}/api/runs/${runId}/artifact`)).json() as {
        run: { id: string }
        artifact: { payload: Record<string, unknown> } | null
      }
      expect(bundle.run.id).toBe(runId)
      expect(bundle.artifact, 'the artifact door served no artifact').not.toBeNull()
      const servedMetadata = bundle.artifact!.payload['metadata'] as Record<string, unknown> | undefined
      expect(servedMetadata, 'the served payload carried no `metadata` object').toBeDefined()
      // AND THE STRIP IS AN ALLOWLIST APPLIED TO A CLIENT OBJECT, NOT A DELETE OF THE WHOLE FIELD:
      // `attributes` is minted by the queue (`job-queue.ts:77`) and the run-detail drawer reads it.
      expect(servedMetadata).toHaveProperty('attributes')

      // EVERY DOOR IN ONE PASS, COLLECTED RATHER THAN SHORT-CIRCUITED, and asserted as a SET so the
      // failure names WHICH doors leak. The split — one door of four — is the evidence that the
      // fixture is sound and the door is not; a broken fixture reds all four or none.
      const leaking: string[] = []
      for (const path of runMetadataBearingReads(runId)) {
        const response = await fetch(`${scene.origin}${path}`)
        expect(response.status, `${path} did not answer`).toBe(200)
        if ((await response.text()).includes(stream.scopeId)) leaking.push(path)
      }
      expect(
        leaking,
        'a run-reading GET still hands out the triggering browser\'s confirm scope',
      ).toEqual([])

      expect(servedMetadata).not.toHaveProperty('confirm' + 'Scope')
    } finally {
      await target.close()
    }
  }, 240_000)

  it('WRITE HALF — POST /api/queue/enqueue cannot plant a confirm scope on a persisted run', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })

      // A FOREIGN SCOPE OF EXACTLY THE MINTED SHAPE. `run-trigger:<uuid>` is what
      // `mintRunTriggerConfirmScope` produces, so a refusal here cannot be coming from the value
      // looking wrong — the queue door has no business accepting the key at all.
      const planted = `run-trigger:${randomUUID()}`
      const response = await fetch(`${scene.origin}/api/queue/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'planted',
          file: fixture.testPattern,
          metadata: { confirmScope: planted },
        }),
      })
      expect(
        response.status,
        'the queue door accepted a client-supplied `confirmScope`',
      ).toBe(400)

      // AND NO ROW ANYWHERE CARRIES IT — the refusal is the control, this is the fact. Read off the
      // RAW handle, because the response projection would hide a planted value that really landed.
      const planted_rows = scene.db.getRuns({ limit: 100 })
        .filter((run) => (run.metadata as Record<string, unknown> | null)?.['confirmScope'] === planted)
      expect(planted_rows, 'a client-planted confirm scope reached a persisted run row').toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('WRITE HALF — POST /api/queue/enqueue cannot plant an execution timeout either', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })

      const response = await fetch(`${scene.origin}/api/queue/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'planted-timeout',
          file: fixture.testPattern,
          metadata: { timeout: 9_007_199_254_740_991 },
        }),
      })
      expect(
        response.status,
        'the queue door accepted a client-supplied `timeout` — the run-reclamation knob',
      ).toBe(400)

      const timed = scene.db.getRuns({ limit: 100 })
        .filter((run) => (run.metadata as Record<string, unknown> | null)?.['timeout'] !== undefined)
      expect(timed, 'a client-planted execution timeout reached a persisted run row').toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE CONSUMER SEAM — a bad `metadata.timeout` on a row never reaches executionBackend.execute, a good one does', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin })
      const scene = await openScene({ fixture })
      const testPath = join(fixture.project, 'tests', 'direct.yaml')

      // THE PRECONDITION-GUARDED PAIR, ON THE SHIPPED SEAM. The rejected value is not merely
      // "large": `-1` is the interesting one, because `in-process-backend.ts:211` reads
      // `opts.timeout ?? this.options.defaultTimeout` — a non-nullish invalid value SKIPS the
      // default and leaves the run with NO reclamation timer at all. The admitted value is a
      // server-computed one of exactly the shape `toExecutionTimeoutMetadata` writes, so the cell
      // shows the guard validating the feature rather than deleting it.
      const rejected = scene.db.insertPendingRun({
        name: 'bad-timeout',
        filePath: testPath,
        metadata: { args: [testPath], timeout: -1 },
      })
      const admitted = scene.db.insertPendingRun({
        name: 'good-timeout',
        filePath: testPath,
        metadata: { args: [testPath], timeout: 660_000, timeoutSource: 'config.use.timeout.test' },
      })

      const executedFor = (runId: string): Record<string, unknown> | undefined =>
        scene.executed().find((opts) => opts['runId'] === runId)

      await waitFor(() => {
        expect(executedFor(rejected), 'the queue never dispatched the bad-timeout run').toBeDefined()
        expect(executedFor(admitted), 'the queue never dispatched the good-timeout run').toBeDefined()
      }, 60_000)

      expect(
        executedFor(rejected)!['timeout'],
        'a `-1` off the persisted row reached the backend, which skips the default timer for any '
        + 'non-nullish value — the run would never have been reclaimed',
      ).toBeUndefined()
      expect(
        executedFor(admitted)!['timeout'],
        'the guard deleted the server-computed timeout instead of validating it',
      ).toBe(660_000)

      // BOTH RUNS ARE DRAINED BEFORE THE SCENE CLOSES. The queue polls its own database; a run
      // still in flight when `close()` drops the connection settles into a closed handle and
      // surfaces as an unhandled `ERR_INVALID_STATE`, which is this cell's litter, not a defect.
      await waitFor(() => { expect(scene.settled().length).toBeGreaterThanOrEqual(2) }, 120_000)
    } finally {
      await target.close()
    }
  }, 180_000)
})

describe('the door publishes no per-scope posture', () => {
  it('THE TRIGGER RULE IS RETIRED — neither the door nor its host publishes a context resolver or a trigger scope', async () => {
    const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1' })
    const door = composeDashboardDoor({
      agentQaRoot: fixture.agentQaRoot,
      configPath: fixture.configPath,
      boundOrigin: () => undefined,
    })
    try {
      for (const retired of ['resolveExecution' + 'Context', 'enterRunTrigger' + 'Scope']) {
        expect(retired in door, `the door still publishes ${retired}`).toBe(false)
        expect(retired in door.agentHost, `the host still carries ${retired}`).toBe(false)
      }
    } finally {
      await door.host.close()
    }
  })

  it('THE CONVERSATION RULE IS RETIRED — the host carries no confirms member a conversation could watch', async () => {
    const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1' })
    const door = composeDashboardDoor({
      agentQaRoot: fixture.agentQaRoot,
      configPath: fixture.configPath,
      boundOrigin: () => undefined,
    })
    try {
      expect('con' + 'firms' in door.agentHost).toBe(false)
    } finally {
      await door.host.close()
    }
  })
})

describe('no first-party source parks a run trigger behind a question', () => {
  const FIRST_PARTY = ['packages/cli/src', 'packages/dashboard-server/src']

  function sourceFiles(): string[] {
    const roots = FIRST_PARTY.map((dir) => resolve(REPO_ROOT, dir))
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue
          walk(full)
          continue
        }
        if (entry.name.endsWith('.ts')) found.push(full)
      }
    }
    for (const root of roots) walk(root)
    return found
  }

  it('no call site builds a confirm registry', () => {
    const files = sourceFiles()
    // A floor, not a pin: a walker that found nothing would make every claim below vacuous.
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => file.endsWith('commands/dashboard.ts'))).toBe(true)

    const callers = files.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return text.includes('createConfirm' + 'Registry(')
    })
    expect(
      callers.map((file) => file.slice(REPO_ROOT.length + 1)),
      'a composition builds a confirm registry again — there is no route left to answer it on',
    ).toEqual([])
  })

  it('no module can turn silence into a denial', () => {
    // Shares no vocabulary with the cell above. It asks which modules hold a timer and can answer
    // `deny` — the mechanical shape of a reaper — so a parking lot written by hand, with no factory
    // to name, is found here even though the cell above cannot see it.
    const reapers = sourceFiles().filter((file) => {
      const text = readFileSync(file, 'utf8')
      return text.includes('setTimeout') && text.includes("'deny'")
    })
    expect(
      reapers.map((file) => file.slice(REPO_ROOT.length + 1)),
      'a module reaps a question into a denial again — there is no question left to reap',
    ).toEqual([])
  })
})
