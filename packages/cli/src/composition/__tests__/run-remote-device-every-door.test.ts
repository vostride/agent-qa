// The model is unreachable, so a run fails after its session opens; the fake Appium server's
// request log is what proves where the device session went.

import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppiumManager, DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'

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

async function onRemoteDevice(drive: (scene: DeviceScene) => Promise<void>): Promise<void> {
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
    },
    extraSecrets: { FARM_TOKEN },
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

async function runThroughCli(project: InProcessFixture, pattern: string): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', project.configPath, 'run', pattern], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
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
        await runThroughCli(project, project.testPattern)

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
})
