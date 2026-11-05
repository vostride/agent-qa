// Drives the shipped door from the queue's backend through `invokeFunction` to a real run's bus.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import type {
  AppiumProvider,
  ExecuteOptions,
  RunSettledDetails,
} from '@vostride/agent-qa-dashboard'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'

import {
  composeDashboardDoor,
  createDashboardRunDoor,
  partitionDashboardRunArgs,
} from '../dashboard.js'
import { buildPlatformConfig, prepareMobileDevice } from '../run.js'
import type { ResolvedMobileRunConfig } from '@vostride/agent-qa-core'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  runDirs,
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

/** The OP-level gate's rows, which land in the host's own sink rather than the run's. */
function opAuditRows(fixture: Fixture): AuditRow[] {
  const path = join(fixture.agentQaRoot, 'execution_audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditRow)
}

/** An empty browsers root, so a member's failure is a property of the fixture, not of the machine. */
function pinEmptyBrowsersRoot(fixture: Fixture): void {
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
}

interface Settled {
  runId: string
  status: string
  details: RunSettledDetails
}

interface Driven {
  /** The run's OWN bus envelopes, in seq order, recorded off its session. */
  envelopes(runId: string): { seq: number; type: string; runId: string; [key: string]: unknown }[]
  settled: Settled[]
  backend: Awaited<ReturnType<typeof createDashboardRunDoor>>['backend']
  db: DashboardDatabase
  /** The composed door's own per-run Appium provider, readable while a run is in flight. */
  appiumFor(runId: string): AppiumProvider | undefined
}

/** Compose the SHIPPED door pair over a fixture and hand back the surfaces a cell reads. */
async function composeDoor(fixture: Fixture): Promise<Driven> {
  pinEmptyBrowsersRoot(fixture)
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const runDoor = await createDashboardRunDoor({ db })
  const door = composeDashboardDoor({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    boundOrigin: () => undefined,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(door.host)

  const settled: Settled[] = []
  runDoor.backend.on('run-settled', (runId: string, status: string, details: RunSettledDetails) => {
    settled.push({ runId, status, details })
  })

  // `subscribe(1, …)` replays from the first seq, so a recorder set before `execute` sees all.
  const recorded = new Map<string, { seq: number; type: string; runId: string }[]>()
  runDoor.observeSessions((session) => {
    const id = session.id as unknown as string
    const own: { seq: number; type: string; runId: string }[] = []
    recorded.set(id, own)
    session.subscribe(1, (envelope) => { own.push(envelope as unknown as { seq: number; type: string; runId: string }) })
  })

  return {
    envelopes: (runId) => recorded.get(runId) ?? [],
    settled,
    backend: runDoor.backend,
    db,
    appiumFor: (runId) => runDoor.runBridge.appiumFor?.(runId),
  }
}

/** Enqueue a row the way the dashboard's queue does, so the ingest has a real row to adopt. */
function enqueue(db: DashboardDatabase, name: string): string {
  const id = db.insertRun({
    name,
    status: 'pending',
    duration: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    platform: 'web',
  })
  db.updateRunStatus(id, 'running')
  return id
}

async function waitFor(assertion: () => void, timeoutMs = 120_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

/** Drive one run through the backend the queue drives, and wait for it to settle. */
async function runThroughQueue(
  driven: Driven,
  opts: ExecuteOptions,
): Promise<Settled> {
  const before = driven.settled.length
  driven.backend.execute(opts)
  await waitFor(() => { expect(driven.settled.length).toBeGreaterThan(before) })
  return driven.settled[driven.settled.length - 1]!
}

// The ambient channels, varied against the door's own answer.

const shippedExecutionContextResolver = getActiveExecutionContext
let restoreAmbient: (() => void) | undefined

beforeEach(() => { restoreAmbient = undefined })
afterEach(() => {
  restoreAmbient?.()
  restoreAmbient = undefined
})
afterAll(() => { removeInProcessFixtures() })

function pinAmbient(value: 'ci' | 'local-interactive' | 'local-headless', ciMarker: boolean): void {
  const priorGithubActions = process.env.GITHUB_ACTIONS
  setActiveExecutionContextResolver(() => value as never)
  if (ciMarker) process.env.GITHUB_ACTIONS = 'true'
  else delete process.env.GITHUB_ACTIONS
  restoreAmbient = () => {
    setActiveExecutionContextResolver(() => shippedExecutionContextResolver())
    if (priorGithubActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = priorGithubActions
  }
}

describe('a dashboard-triggered run is one more caller of runs.start', () => {
  it('an allowed run happens in process, and neither gate leaves a row', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const driven = await composeDoor(fixture)
      const runId = enqueue(driven.db, 'the parity test')

      const settled = await runThroughQueue(driven, {
        runId,
        args: [fixture.testPattern],
        source: 'dashboard',
      })

      // (a) the run really ran: its own directory, its own event log, the target knocked on once
      expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toContain(runId)
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(buildOrdinalsExist(fixture)).toBe(true)

      expect(opAuditRows(fixture).filter((row) => row.action === 'fn:runs.start')).toEqual([])
      expect((auditRows(fixture) as AuditRow[]).filter((row) => row.action === 'run:start')).toEqual([])

      // (c) the run's own envelopes reached the door's subscribers, whole and in seq order
      const envelopes = driven.envelopes(runId)
      expect(envelopes[0]!.type).toBe('runStarted')
      expect(envelopes.map((event) => event.type)).toContain('runFinished')
      expect(envelopes.every((event) => event.runId === runId)).toBe(true)
      expect(envelopes.map((event) => event.seq)).toEqual(envelopes.map((_, index) => index + 1))

      // (d) The enqueued row is adopted, not duplicated: the run id arrives as construction data.
      expect(driven.db.getRuns({}).map((row) => row.id)).toEqual([runId])
      expect(driven.db.getRun(runId)?.status).not.toBe('pending')
      expect(settled.runId).toBe(runId)
    } finally {
      await target.close()
    }
  }, 180_000)

  it('THE INTERIM POSTURE IS STRUCTURAL — `local-headless` even with the ambient shouting otherwise', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-interactive', true)
      const driven = await composeDoor(fixture)
      const runId = enqueue(driven.db, 'the parity test')

      await runThroughQueue(driven, { runId, args: [fixture.testPattern], source: 'dashboard' })

      const started = driven.envelopes(runId).find((event) => event.type === 'runStarted') as
        { payload?: { executionContext?: string } } | undefined
      expect(started?.payload?.executionContext).toBe('local-headless')
    } finally {
      await target.close()
    }
  }, 180_000)
})

describe('two concurrent dashboard runs are isolated', () => {
  it('OWN RUN DIR, OWN EVENT LOG, OWN DB ROW, OWN BUFFER', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const driven = await composeDoor(fixture)
      const runA = enqueue(driven.db, 'run A')
      const runB = enqueue(driven.db, 'run B')

      // GENUINELY CONCURRENT: both are executed before either settles. A sequential pair would not
      // range the isolation claim at all — every per-run map would look correct with one entry.
      driven.backend.execute({ runId: runA, args: [fixture.testPattern], source: 'dashboard' })
      driven.backend.execute({ runId: runB, args: [fixture.testPattern], source: 'dashboard' })
      await waitFor(() => {
        expect(driven.backend.getActiveExecutions().map((execution) => execution.runId).sort())
          .toEqual([runA, runB].sort())
      })
      await waitFor(() => {
        expect(driven.envelopes(runA).some((event) => event.type === 'runStarted')).toBe(true)
        expect(driven.envelopes(runB).some((event) => event.type === 'runStarted')).toBe(true)
      })

      // Each session carries only its own run's envelopes.
      for (const [runId, other] of [[runA, runB], [runB, runA]] as const) {
        const runIds = new Set(driven.envelopes(runId).map((event) => event.runId))
        expect(runIds).toEqual(new Set([runId]))
        expect(runIds.has(other)).toBe(false)
      }

      await waitFor(() => { expect(driven.settled).toHaveLength(2) })

      // Two run directories, each with its OWN event log, keyed by its own run id.
      const dirs = runDirs(fixture).map((dir) => dir.split('/').pop())
      expect(dirs).toContain(runA)
      expect(dirs).toContain(runB)
      for (const runId of [runA, runB]) {
        const log = join(fixture.agentQaRoot, 'runs', runId, 'events.jsonl')
        const owners = new Set(
          readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => (JSON.parse(line) as { runId: string }).runId),
        )
        expect(owners).toEqual(new Set([runId]))
      }

      // Two db rows, each its own, and no third row minted by either.
      expect(driven.db.getRuns({}).map((row) => row.id).sort()).toEqual([runA, runB].sort())
    } finally {
      await target.close()
    }
  }, 240_000)
})

describe('the queue’s argv operands, read rather than forwarded', () => {
  it('PATHS BECOME PATTERNS AND `--disable-cache` BECOMES A FLAG', () => {
    expect(partitionDashboardRunArgs(['tests/a.yaml', '--disable-cache', 'tests/b.yaml']))
      .toEqual({
        patterns: ['tests/a.yaml', 'tests/b.yaml'],
        flags: { disableCache: true },
        unsupported: [],
      })
  })

  it('AN UNRECOGNISED FLAG IS REPORTED, NOT SILENTLY GLOBBED', () => {
    const partition = partitionDashboardRunArgs(['tests/a.yaml', '--headed'])
    expect(partition.unsupported).toEqual(['--headed'])
    expect(partition.patterns).toEqual(['tests/a.yaml'])
  })

  it('AND THE DOOR REFUSES SUCH A RUN BY NAME rather than running a different one', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const driven = await composeDoor(fixture)
      const runId = enqueue(driven.db, 'unsupported flag')

      const settled = await runThroughQueue(driven, {
        runId,
        args: [fixture.testPattern, '--headed'],
        source: 'dashboard',
      })

      expect(settled.status).toBe('failed')
      expect(settled.details.reason).toContain('--headed')
      // Nothing ran: a refused operand must not become a run that quietly ignored it.
      expect(eventTypes(fixture)).toEqual([])
      expect(target.hits).toEqual([])
    } finally {
      await target.close()
    }
  }, 180_000)
})

const FARM = {
  name: 'farm',
  protocol: 'appium' as const,
  url: 'https://farm.example.com/wd/hub',
  connectTimeoutMs: 300_000,
}

const PIXEL_HERE: ResolvedMobileRunConfig = {
  platform: 'android',
  targetName: 'shop-android',
  deviceName: 'pixel',
  device: { name: 'pixel', platform: 'android', model: 'Pixel 8' },
  plan: { kind: 'here', search: { model: 'Pixel 8' } },
  app: { sourceTrace: {} },
  appState: 'preserve',
  appium: {},
  sourceTrace: [],
}

const PIXEL_ON_FARM: ResolvedMobileRunConfig = {
  ...PIXEL_HERE,
  device: { ...PIXEL_HERE.device, remote: FARM },
  plan: { kind: 'remote', remote: FARM },
}

// The phone this machine has in these cells, so no cell runs adb.
const listPixelHere = async () => ({
  attached: [{ serial: 'R58M41ABCDE', state: 'device', model: 'Pixel 8', os: '15' }],
  avds: [],
})

// A stand-in for the dashboard's lease that records each ask.
function recordingProvider(url: string): AppiumProvider & { asked: Array<'android' | 'ios'> } {
  const asked: Array<'android' | 'ios'> = []
  return {
    asked,
    acquire: async (platform) => {
      asked.push(platform)
      return url
    },
  }
}

// A member on a device here, prepared the way the producers prepare it, reading the variable.
async function platformConfigHere(hostAppium: AppiumProvider | undefined) {
  const prepared = await prepareMobileDevice({
    resolved: PIXEL_HERE,
    envUrl: process.env.AGENT_QA_APPIUM_URL,
    ...(hostAppium === undefined ? {} : { hostAppium }),
    startAppium: async () => {
      throw new Error('a dashboard run starts no Appium of its own')
    },
    listDevicesHere: listPixelHere,
  })
  return buildPlatformConfig(
    'android',
    PIXEL_HERE.device,
    undefined,
    undefined,
    undefined,
    PIXEL_HERE,
    undefined,
    prepared,
  )
}

describe("the dashboard's Appium is a provider each run asks only for a device here", () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it("ORDER — a device's remote, then AGENT_QA_APPIUM_URL, then the host's Appium, then the one agent-qa starts", async () => {
    const asked: string[] = []
    const prepare = (
      resolved: ResolvedMobileRunConfig,
      envUrl: string | undefined,
      host: string | undefined,
    ) =>
      prepareMobileDevice({
        resolved,
        envUrl,
        ...(host === undefined
          ? {}
          : {
              hostAppium: {
                acquire: async () => {
                  asked.push('host')
                  return host
                },
              },
            }),
        startAppium: async () => {
          asked.push('start')
          return 'http://127.0.0.1:4723'
        },
        listDevicesHere: listPixelHere,
      })

    // 1. A device with a remote uses it, whatever the environment and the host offer.
    expect((await prepare(PIXEL_ON_FARM, 'http://127.0.0.1:4724', 'http://127.0.0.1:4800')).remote)
      .toEqual(FARM)
    expect(asked).toEqual([])
    // 2. A device here takes AGENT_QA_APPIUM_URL before the host's Appium.
    expect((await prepare(PIXEL_HERE, 'http://127.0.0.1:4724', 'http://127.0.0.1:4800')).appiumUrl)
      .toBe('http://127.0.0.1:4724/')
    expect(asked).toEqual([])
    // 3. Then the host's Appium, such as the dashboard's lease.
    expect((await prepare(PIXEL_HERE, undefined, 'http://127.0.0.1:4800')).appiumUrl)
      .toBe('http://127.0.0.1:4800')
    expect(asked).toEqual(['host'])
    // 4. Then the one agent-qa starts, which only this process manages.
    const started = await prepare(PIXEL_HERE, undefined, undefined)
    expect(started.appiumUrl).toBe('http://127.0.0.1:4723')
    expect(started.managed).toBe(true)
    expect(asked).toEqual(['host', 'start'])
  })

  it('with AGENT_QA_APPIUM_URL set, a device here dials it and asks the provider nothing', async () => {
    vi.stubEnv('AGENT_QA_APPIUM_URL', 'http://127.0.0.1:4799')
    const provider = recordingProvider('http://localhost:4723')

    const platformConfig = await platformConfigHere(provider)

    expect(platformConfig.appiumUrl).toBe('http://127.0.0.1:4799/')
    expect(platformConfig.device?.here).toEqual({ udid: 'R58M41ABCDE', os: '15' })
    // Never asked, so the dashboard neither starts Appium nor leases it for this run.
    expect(provider.asked).toEqual([])
  })

  it('without the variable, a device here asks its run’s provider once and dials what it answers', async () => {
    vi.stubEnv('AGENT_QA_APPIUM_URL', undefined)
    const provider = recordingProvider('http://localhost:4723')

    const platformConfig = await platformConfigHere(provider)

    expect(platformConfig.appiumUrl).toBe('http://localhost:4723')
    expect(provider.asked).toEqual(['android'])
  })

  it('TWO CONCURRENT RUNS EACH HOLD THEIR OWN PROVIDER — a lease belongs to one run', async () => {
    vi.stubEnv('AGENT_QA_APPIUM_URL', undefined)
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      const driven = await composeDoor(fixture)
      const runA = enqueue(driven.db, 'mobile A')
      const runB = enqueue(driven.db, 'mobile B')

      // Before either run exists the door knows about neither — the entry is per run and is created
      // by the starter, so a provider that answered for the process would be visible right here.
      expect(driven.appiumFor(runA)).toBeUndefined()

      const providerA = recordingProvider('http://localhost:4723')
      const providerB = recordingProvider('http://localhost:4723')
      driven.backend.execute({
        runId: runA,
        args: [fixture.testPattern],
        source: 'dashboard',
        appium: providerA,
      })
      driven.backend.execute({
        runId: runB,
        args: [fixture.testPattern],
        source: 'dashboard',
        appium: providerB,
      })

      await waitFor(() => {
        expect(driven.appiumFor(runA)).toBe(providerA)
        expect(driven.appiumFor(runB)).toBe(providerB)
      })
      // Run A's member asks through the provider the door serves for run A, and only that one.
      await platformConfigHere(driven.appiumFor(runA))
      expect(providerA.asked).toEqual(['android'])
      expect(providerB.asked).toEqual([])

      await waitFor(() => { expect(driven.settled).toHaveLength(2) }, 240_000)
      // And the entry is released when the run is over, so a later run cannot inherit it.
      expect(driven.appiumFor(runA)).toBeUndefined()
      expect(driven.appiumFor(runB)).toBeUndefined()
    } finally {
      await target.close()
    }
  }, 240_000)
})
