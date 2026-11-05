// Each mobile test's stored run artifact names where its device ran, and stores a remote by its
// origin only. The model is unreachable, so a run fails after its session opens.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateSuiteId } from '@vostride/agent-qa-ids'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  REMOTE_DEVICE_NAME,
  REMOTE_DEVICE_REMOTE_NAME,
  REMOTE_DEVICE_TARGET_NAME,
  REMOTE_IOS_DEVICE_NAME,
  REMOTE_IOS_TARGET_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
}

interface FakeAppiumServer {
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: {
    readonly basePath?: string
    readonly requireHeader?: readonly [string, string]
    readonly execute?: Readonly<Record<string, unknown>>
  }) => Promise<FakeAppiumServer>
}

const RUN_BUDGET_MS = 180_000
const FARM_TOKEN = 'farm-token-value-4be1'
const PATH_TOKEN = 'path-token-value-0d97'
const BASE_PATH = `/wd/hub/${PATH_TOKEN}`
const APPIUM_VERSION = '3.4.2'
const REAL_IPHONE = {
  'mobile: deviceInfo': { isSimulator: false, lockdownInfo: { ProductType: 'iPhone17,3' } },
}
const APP_DATA_NOTE =
  `App data was not cleared: device ${REMOTE_IOS_DEVICE_NAME} is a real iPhone, ` +
  `and target ${REMOTE_IOS_TARGET_NAME} has no app.ref to reinstall from.`

const opened: Array<() => Promise<void> | void> = []

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface StoredRun {
  readonly raw: string
  readonly payload: Record<string, any>
  readonly members: Array<{ name: string | undefined; failureSummary: string | undefined }>
}

function onlyRun(project: InProcessFixture, log: string): StoredRun {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    const runs = db.getRuns({})
    expect(runs, log).toHaveLength(1)
    const run = runs[0]!
    const payload = (db.getRunArtifact(run.id)?.payload ?? {}) as unknown as Record<string, any>
    return {
      raw: JSON.stringify(payload),
      payload,
      members: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => ({
        name: member.name,
        failureSummary: member.failureSummary,
      })),
    }
  } finally {
    db.close()
  }
}

interface Ran {
  readonly log: string
  readonly exitCode: unknown
}

// Runs `agent-qa run` in this process; the mocked exit throws, so only the first exit counts.
async function runCli(project: InProcessFixture, args: readonly string[]): Promise<Ran> {
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const printed: string[] = []
  let exited = false
  const keep = (...parts: unknown[]): void => {
    if (!exited) printed.push(plain(parts.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    exited = true
    throw new Error('fixture command exit')
  })
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await program
    .parseAsync(['--config', project.configPath, 'run', ...args], { from: 'user' })
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'fixture command exit')) throw error
    })
  return { log: printed.join('\n'), exitCode: exit.mock.calls[0]?.[0] }
}

async function fakeFarm(
  options: {
    readonly requireHeader?: readonly [string, string]
    readonly execute?: Readonly<Record<string, unknown>>
  } = {},
): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer({ basePath: BASE_PATH, ...options })
  opened.push(() => server.close())
  return server
}

function onFarm(
  server: FakeAppiumServer,
  token: string,
  knobs: Omit<InProcessFixtureInput, 'origin' | 'remoteDevice'> = {},
  device: Partial<NonNullable<InProcessFixtureInput['remoteDevice']>> = {},
): InProcessFixture {
  return createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: {
      url: server.url,
      headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
      model: 'Samsung Galaxy S24',
      os: '14',
      ...device,
    },
    extraSecrets: { FARM_TOKEN: token },
    ...knobs,
  })
}

function newSessions(server: FakeAppiumServer): readonly FakeAppiumRequest[] {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === `${BASE_PATH}/session`,
  )
}

function expectNothingHidden(stored: StoredRun, log: string): void {
  for (const hidden of [PATH_TOKEN, FARM_TOKEN]) {
    expect(stored.raw.includes(hidden), `${hidden} is stored\n${log}`).toBe(false)
  }
}

describe("a remote device run's evidence", () => {
  it(
    'a direct test names the remote by its origin, with the Appium version and session id',
    async () => {
      const server = await fakeFarm({ requireHeader: ['x-farm-token', FARM_TOKEN] })
      const project = onFarm(server, FARM_TOKEN)

      const { log } = await runCli(project, [project.testPattern])

      expect(newSessions(server), log).toHaveLength(1)
      const [sessionId] = server.sessionsCreated()
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toMatchObject({
        place: 'remote',
        name: REMOTE_DEVICE_REMOTE_NAME,
        protocol: 'appium',
        origin: server.origin,
        device: REMOTE_DEVICE_NAME,
        appiumVersion: APPIUM_VERSION,
        sessionId,
      })
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expectNothingHidden(stored, log)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a device whose remote refuses the credentials records the auth failure kind, and the run exits 2',
    async () => {
      const server = await fakeFarm({ requireHeader: ['x-farm-token', 'never-sent'] })
      const project = onFarm(server, FARM_TOKEN)

      const { log, exitCode } = await runCli(project, [project.testPattern])

      expect(exitCode, log).toBe(2)
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toEqual({
        place: 'remote',
        name: REMOTE_DEVICE_REMOTE_NAME,
        protocol: 'appium',
        origin: server.origin,
        device: REMOTE_DEVICE_NAME,
        failureKind: 'auth',
      })
      expect(stored.members[0]?.failureSummary, log).toContain(
        `refused the credentials for device ${REMOTE_DEVICE_NAME}`,
      )
      expect(newSessions(server), log).toHaveLength(1)
      expectNothingHidden(stored, log)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a suite on the remote device stores the place of its one session',
    async () => {
      const server = await fakeFarm({ requireHeader: ['x-farm-token', FARM_TOKEN] })
      const project = onFarm(server, FARM_TOKEN, {
        suiteMemberDevices: [undefined, undefined],
        suiteDevice: REMOTE_DEVICE_NAME,
      })

      const { log } = await runCli(project, [project.suitePattern])

      expect(newSessions(server), log).toHaveLength(1)
      const [sessionId] = server.sessionsCreated()
      const stored = onlyRun(project, log)
      expect(stored.payload.source?.kind, log).toBe('suite')
      expect(stored.payload.config?.runtime?.place, log).toMatchObject({
        place: 'remote',
        name: REMOTE_DEVICE_REMOTE_NAME,
        protocol: 'appium',
        origin: server.origin,
        device: REMOTE_DEVICE_NAME,
        appiumVersion: APPIUM_VERSION,
        sessionId,
      })
      expectNothingHidden(stored, log)
    },
    RUN_BUDGET_MS,
  )

  it(
    'every member of two suites on the remote device carries the place of its own suite session',
    async () => {
      const server = await fakeFarm({ requireHeader: ['x-farm-token', FARM_TOKEN] })
      const project = onFarm(server, FARM_TOKEN, {
        suiteMemberDevices: [undefined, undefined],
        suiteDevice: REMOTE_DEVICE_NAME,
      })
      writeFileSync(
        join(project.project, 'suites', 'more.suite.yaml'),
        [
          `suite-id: ${generateSuiteId()}`,
          'name: the other suite',
          `target: ${REMOTE_DEVICE_TARGET_NAME}`,
          'use:',
          `  device: ${REMOTE_DEVICE_NAME}`,
          'tests:',
          '  - test: tests/member.yaml',
          `    id: ${project.memberTestId}`,
          '',
        ].join('\n'),
      )

      const { log } = await runCli(project, [project.suitePattern, 'suites/more.suite.yaml'])

      const sessions = server.sessionsCreated()
      expect(sessions, log).toHaveLength(2)
      const stored = onlyRun(project, log)
      const members = stored.payload.source?.members as Array<Record<string, any>> | undefined
      expect(members?.length, log).toBe(3)
      const places = (members ?? []).map((member) => member.config?.runtime?.place)
      for (const place of places) {
        expect(place, log).toMatchObject({
          place: 'remote',
          name: REMOTE_DEVICE_REMOTE_NAME,
          protocol: 'appium',
          origin: server.origin,
          device: REMOTE_DEVICE_NAME,
          appiumVersion: APPIUM_VERSION,
        })
      }
      expect(places.map((place) => place?.sessionId), log).toEqual([
        sessions[0],
        sessions[0],
        sessions[1],
      ])
      expectNothingHidden(stored, log)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a real iPhone told to reset an app it cannot reinstall says so in the output and the evidence',
    async () => {
      const server = await fakeFarm({ execute: REAL_IPHONE })
      const project = onFarm(
        server,
        FARM_TOKEN,
        {},
        { platform: 'ios', model: 'iPhone 16', os: '18.2', appState: 'reset' },
      )

      const { log } = await runCli(project, [project.testPattern])

      expect(newSessions(server), log).toHaveLength(1)
      expect(log.split('\n').filter((line) => line.trim() === APP_DATA_NOTE), log).toHaveLength(1)
      const stored = onlyRun(project, log)
      expect(stored.payload.config?.runtime?.place, log).toMatchObject({
        place: 'remote',
        protocol: 'appium',
        device: REMOTE_IOS_DEVICE_NAME,
        deviceType: 'real device',
        notes: [APP_DATA_NOTE],
      })
      expectNothingHidden(stored, log)
    },
    RUN_BUDGET_MS,
  )
})
