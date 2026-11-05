// The model is unreachable, so a run fails after its session opens; the fake Appium server's
// request log is what proves where a device session went.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppiumManager, DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  LOCAL_DEVICE_NAME,
  REMOTE_DEVICE_NAME,
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
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: () => Promise<FakeAppiumServer> }

const RUN_BUDGET_MS = 180_000

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

interface Scene {
  readonly project: InProcessFixture
  readonly server: FakeAppiumServer
  readonly log: () => string
  readonly exitCode: () => unknown
  readonly acquire: ReturnType<typeof vi.spyOn>
}

async function scene(
  knobs: Omit<InProcessFixtureInput, 'origin' | 'remoteDevice'>,
): Promise<Scene> {
  const server = await startFakeAppiumServer()
  opened.push(() => server.close())
  const project = createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: { url: server.url, model: 'Samsung Galaxy S24', os: '14' },
    ...knobs,
  })
  vi.stubEnv('HOME', freshUpdateCheckHome())
  vi.stubEnv('AGENT_QA_APPIUM_URL', '')
  const printed: string[] = []
  let exited = false
  const keep = (...args: unknown[]): void => {
    if (!exited) printed.push(plain(args.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    exited = true
    throw new Error('fixture command exit')
  })
  const acquire = vi
    .spyOn(AppiumManager.prototype, 'acquire')
    .mockImplementation(() => Promise.reject(new Error('no Appium starts in this cell')))
  return {
    project,
    server,
    log: () => printed.join('\n'),
    exitCode: () => exit.mock.calls[0]?.[0],
    acquire,
  }
}

async function runThroughCli(project: InProcessFixture, args: readonly string[]): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', project.configPath, 'run', ...args], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
}

function storedRunners(project: InProcessFixture): unknown[] {
  const dbPath = join(project.agentQaRoot, 'runs.db')
  if (!existsSync(dbPath)) return []
  const db = new DashboardDatabase({ dbPath })
  try {
    return db.getRuns({}).map((run) => run.attributes['agent-qa.runner'])
  } finally {
    db.close()
  }
}

function newSessions(server: FakeAppiumServer): readonly FakeAppiumRequest[] {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === '/wd/hub/session',
  )
}

describe('where a mobile test runs is chosen from its files before the run is recorded', () => {
  it(
    "a test whose target names a remote device runs on that remote and records the run remote",
    async () => {
      const { project, server, log, acquire } = await scene({ deviceOnTarget: true })

      await runThroughCli(project, [project.testPattern])

      expect(newSessions(server), log()).toHaveLength(1)
      const runners = storedRunners(project)
      expect(runners.length, log()).toBeGreaterThan(0)
      expect(new Set(runners), log()).toEqual(new Set(['remote']))
      expect(acquire).not.toHaveBeenCalled()
    },
    RUN_BUDGET_MS,
  )

  it(
    '--device naming a remote device is refused in one line with exit 2, before any run or session',
    async () => {
      const { project, server, log, exitCode } = await scene({})

      await runThroughCli(project, [project.testPattern, '--device', REMOTE_DEVICE_NAME])

      expect(exitCode(), log()).toBe(2)
      expect(log()).toContain(
        'Device galaxy-farm runs on remote farm; --device picks a device on this machine. ' +
          'Set use.device: galaxy-farm in a suite or test to run there.',
      )
      expect(storedRunners(project), log()).toEqual([])
      expect(server.requests, log()).toEqual([])
    },
    RUN_BUDGET_MS,
  )

  it(
    '--device naming a device here runs a test that picks a remote device on this machine',
    async () => {
      const { project, server, log, acquire } = await scene({ localDevice: true })

      await runThroughCli(project, [project.testPattern, '--device', LOCAL_DEVICE_NAME])

      expect(acquire, log()).toHaveBeenCalledTimes(1)
      expect(server.requests, log()).toEqual([])
      const runners = storedRunners(project)
      expect(runners.length, log()).toBeGreaterThan(0)
      expect(new Set(runners), log()).toEqual(new Set(['local']))
    },
    RUN_BUDGET_MS,
  )

  it(
    'a suite whose members pick different devices and names none is refused with exit 2',
    async () => {
      const { project, server, log, exitCode } = await scene({
        localDevice: true,
        suiteMemberDevices: [REMOTE_DEVICE_NAME, LOCAL_DEVICE_NAME],
      })

      await runThroughCli(project, [project.suitePattern])

      expect(exitCode(), log()).toBe(2)
      expect(log()).toContain(
        'Suite the in-process suite runs its tests on one device, but tests/member.yaml picks ' +
          'galaxy-farm and tests/member-2.yaml picks pixel. ' +
          'Set use.device in the suite or make the tests agree.',
      )
      expect(storedRunners(project), log()).toEqual([])
      expect(server.requests, log()).toEqual([])
    },
    RUN_BUDGET_MS,
  )

  it(
    'a suite that picks a remote device runs its members there in one session',
    async () => {
      const { project, server, log, acquire } = await scene({
        suiteMemberDevices: [undefined, undefined],
        suiteDevice: REMOTE_DEVICE_NAME,
      })

      await runThroughCli(project, [project.suitePattern])

      expect(newSessions(server), log()).toHaveLength(1)
      const runners = storedRunners(project)
      expect(runners.length, log()).toBeGreaterThan(0)
      expect(new Set(runners), log()).toEqual(new Set(['remote']))
      expect(acquire).not.toHaveBeenCalled()
    },
    RUN_BUDGET_MS,
  )
})
