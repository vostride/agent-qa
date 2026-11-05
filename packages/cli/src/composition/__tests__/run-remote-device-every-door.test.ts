// The model is unreachable, so a run fails after its session opens; the fake Appium server's
// request log is what proves where the device session went.

import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AndroidHere } from '@vostride/agent-qa-core'
import { AppiumManager, DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  LOCAL_DEVICE_MODEL,
  LOCAL_DEVICE_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: {
    readonly requireHeader?: readonly [string, string]
  }) => Promise<FakeAppiumServer>
}

const RUN_BUDGET_MS = 180_000
const FARM_TOKEN = 'farm-token-value-mark'
const MODEL = 'Samsung Galaxy S24'
const IPHONE_MODEL = 'iPhone 16'

// The phone this machine has in the cells that run here, so no cell runs adb.
const HERE: AndroidHere = {
  attached: [{ serial: '37121FDJH000', state: 'device', model: LOCAL_DEVICE_MODEL, os: '15' }],
  avds: [],
}

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

interface DeviceScene {
  readonly project: InProcessFixture
  readonly server: FakeAppiumServer
  readonly printed: string[]
  readonly acquire: ReturnType<typeof vi.spyOn>
  readonly acquireLease: ReturnType<typeof vi.spyOn>
}

async function onRemoteDevice(
  drive: (scene: DeviceScene) => Promise<void>,
  knobs: {
    readonly device?: Partial<NonNullable<InProcessFixtureInput['remoteDevice']>>
    readonly fixture?: Omit<InProcessFixtureInput, 'origin' | 'remoteDevice'>
  } = {},
): Promise<void> {
  const server = await startFakeAppiumServer({ requireHeader: ['x-farm-token', FARM_TOKEN] })
  opened.push(() => server.close())
  const project = createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: {
      url: server.url,
      headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
      model: MODEL,
      os: '14',
      ...knobs.device,
    },
    extraSecrets: { FARM_TOKEN },
    ...knobs.fixture,
  })
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const printed: string[] = []
  const keep = (...args: unknown[]): void => {
    printed.push(plain(args.map(String).join(' ')))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('fixture command exit')
  })
  const noLocalAppium = (): Promise<never> =>
    Promise.reject(new Error('a remote device starts no Appium here'))
  const acquire = vi.spyOn(AppiumManager.prototype, 'acquire').mockImplementation(noLocalAppium)
  const acquireLease = vi
    .spyOn(AppiumManager.prototype, 'acquireLease')
    .mockImplementation(noLocalAppium)
  await drive({ project, server, printed, acquire, acquireLease })
}

async function runThroughCli(
  project: InProcessFixture,
  args: readonly string[],
  options: { readonly logLevel?: string; readonly here?: AndroidHere } = {},
): Promise<void> {
  const here = options.here
  const program = new Command()
    .option('--config <path>')
    .option('--log-level <level>')
    .addCommand(
      createRunCommand(here === undefined ? {} : { listDevicesHere: async () => here }),
    )
  await expect(
    program.parseAsync(
      [
        '--config',
        project.configPath,
        ...(options.logLevel === undefined ? [] : ['--log-level', options.logLevel]),
        'run',
        ...args,
      ],
      { from: 'user' },
    ),
  ).rejects.toThrow('fixture command exit')
}

function newSessionsOn(server: FakeAppiumServer): readonly FakeAppiumRequest[] {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === '/wd/hub/session',
  )
}

function storedRunners(project: InProcessFixture): unknown[] {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => run.attributes['agent-qa.runner'])
  } finally {
    db.close()
  }
}

describe('a test on a remote device runs there from every door', () => {
  it(
    'agent-qa run opens the session on the remote with its resolved header, records the run remote and starts no Appium',
    async () => {
      await onRemoteDevice(async ({ project, server, printed, acquire, acquireLease }) => {
        await runThroughCli(project, [project.testPattern])

        const log = printed.join('\n')
        const newSessions = server.requests.filter(
          (request) => request.method === 'POST' && request.path === '/wd/hub/session',
        )
        expect(newSessions, log).toHaveLength(1)
        const [newSession] = newSessions
        expect(newSession?.headers['x-farm-token']).toBe(FARM_TOKEN)
        const body = newSession?.body as {
          capabilities?: { alwaysMatch?: Record<string, unknown> }
        }
        expect(body.capabilities?.alwaysMatch?.['appium:deviceName']).toBe(MODEL)

        const [sessionId] = server.sessionsCreated()
        expect(sessionId, log).toBeDefined()
        expect(
          server.requests.some(
            (request) =>
              request.method === 'DELETE' &&
              request.path === `/wd/hub/session/${String(sessionId)}`,
          ),
          log,
        ).toBe(true)

        const runners = storedRunners(project)
        expect(runners.length, log).toBeGreaterThan(0)
        expect(new Set(runners), log).toEqual(new Set(['remote']))

        expect(acquire).not.toHaveBeenCalled()
        expect(acquireLease).not.toHaveBeenCalled()
        expect(log).not.toContain(FARM_TOKEN)
      })
    },
    RUN_BUDGET_MS,
  )

  it(
    'agent-qa run opens one session for an iOS device on the remote, asking for no simulator log',
    async () => {
      await onRemoteDevice(
        async ({ project, server, printed, acquire, acquireLease }) => {
          await runThroughCli(project, [project.testPattern])

          const log = printed.join('\n')
          const newSessions = newSessionsOn(server)
          expect(newSessions, log).toHaveLength(1)
          const body = newSessions[0]?.body as {
            capabilities?: { alwaysMatch?: Record<string, unknown> }
          }
          const asked = body.capabilities?.alwaysMatch ?? {}
          expect(asked.platformName, log).toBe('iOS')
          expect(asked['appium:deviceName'], log).toBe(IPHONE_MODEL)
          expect(asked, log).not.toHaveProperty('appium:showIOSLog')
          expect(newSessions[0]?.headers['x-farm-token'], log).toBe(FARM_TOKEN)
          expect(server.sessionsDeleted(), log).toEqual(server.sessionsCreated())
          expect(new Set(storedRunners(project)), log).toEqual(new Set(['remote']))
          expect(acquire).not.toHaveBeenCalled()
          expect(acquireLease).not.toHaveBeenCalled()
        },
        { device: { platform: 'ios', model: IPHONE_MODEL, os: '18.2' } },
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    'a debug run on a device here stays silent when the config lists a remote device, and a remote run after it still opens',
    async () => {
      await onRemoteDevice(
        async ({ project, server, printed }) => {
          const here = await startFakeAppiumServer()
          opened.push(() => here.close())
          vi.stubEnv('AGENT_QA_APPIUM_URL', here.url)
          vi.stubEnv('WDIO_LOG_LEVEL', undefined)
          const wdioLines: string[] = []
          const keepWdio = (...args: unknown[]): void => {
            wdioLines.push(plain(args.map(String).join(' ')))
          }
          vi.spyOn(console, 'info').mockImplementation(keepWdio)
          vi.spyOn(console, 'debug').mockImplementation(keepWdio)
          vi.spyOn(console, 'trace').mockImplementation(keepWdio)

          await runThroughCli(project, [project.testPattern, '--device', LOCAL_DEVICE_NAME], {
            logLevel: 'debug',
            here: HERE,
          })

          const log = printed.join('\n')
          expect(newSessionsOn(here), log).toHaveLength(1)
          expect(process.env.WDIO_LOG_LEVEL ?? 'silent', log).toBe('silent')
          const webdriverLine = /\b(?:webdriver|webdriverio|devtools):/
          expect([...printed, ...wdioLines].filter((line) => webdriverLine.test(line))).toEqual([])

          await runThroughCli(project, [project.testPattern])

          expect(newSessionsOn(server), printed.join('\n')).toHaveLength(1)
        },
        { fixture: { localDevice: true } },
      )
    },
    RUN_BUDGET_MS,
  )
})
