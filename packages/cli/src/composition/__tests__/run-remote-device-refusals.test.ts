// Each refusal runs through `agent-qa run` with marks planted in the remote's url path, its basic
// auth password, its declared header token and the server's own reply. None may reach the output,
// runs.db or anything else the run writes under .agent-qa.

import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppiumManager } from '@vostride/agent-qa-dashboard'

import {
  REMOTE_RELEASE_BOUND_MS,
  createRunCommand,
  releaseRemoteSessions,
} from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  REMOTE_DEVICE_NAME,
  REMOTE_DEVICE_TARGET_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
}

type NewSessionScript =
  | 'ok'
  | 'hold'
  | { readonly status: number; readonly json: unknown }
  | { readonly status: number; readonly text: string }

interface FakeAppiumServer {
  readonly url: string
  readonly origin: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as {
  startFakeAppiumServer: (options?: {
    readonly basePath?: string
    readonly newSession?: readonly NewSessionScript[]
    readonly hold?: RegExp
  }) => Promise<FakeAppiumServer>
}

const RUN_BUDGET_MS = 180_000
const PATH_MARK = 'path-token-mark'
const QUERY_MARK = 'query-secret-mark'
const BODY_MARK = 'response-body-mark'
const TOKEN_MARK = 'declared-token-mark'
const PASSWORD_MARK = 'basic-password-mark'
const BASIC_USER = 'farmer'
const ENCODED_CREDENTIALS = Buffer.from(`${BASIC_USER}:${PASSWORD_MARK}`).toString('base64')
const LEAK_MARKS = [
  PATH_MARK,
  QUERY_MARK,
  BODY_MARK,
  TOKEN_MARK,
  PASSWORD_MARK,
  ENCODED_CREDENTIALS,
]
const BASE_PATH = `/wd/hub/${PATH_MARK}`
const ELSEWHERE = `https://farm.internal/wd/hub/${PATH_MARK}?key=${QUERY_MARK}`

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

async function fakeFarm(
  options: { readonly newSession?: readonly NewSessionScript[]; readonly hold?: RegExp } = {},
): Promise<FakeAppiumServer> {
  const server = await startFakeAppiumServer({ basePath: BASE_PATH, ...options })
  opened.push(() => server.close())
  return server
}

// A port that answered once and is closed now, so nothing listens there.
async function closedPortUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((closed) => server.close(() => closed()))
  return `http://127.0.0.1:${String(port)}${BASE_PATH}`
}

function onFarm(
  url: string,
  device: Partial<NonNullable<InProcessFixtureInput['remoteDevice']>> = {},
): InProcessFixture {
  return createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    remoteDevice: {
      url,
      headers: { 'x-farm-token': '{{secret:FARM_TOKEN}}' },
      basicAuth: { user: BASIC_USER, password: '{{secret:FARM_KEY}}' },
      model: 'Samsung Galaxy S24',
      os: '14',
      ...device,
    },
    extraSecrets: { FARM_TOKEN: TOKEN_MARK, FARM_KEY: PASSWORD_MARK },
  })
}

interface Ran {
  // What went through console, and on which stream; the run's summary is written to stdout.
  readonly lines: readonly string[]
  readonly stderr: readonly string[]
  readonly log: string
  readonly exitCode: unknown
}

interface Running {
  readonly done: Promise<Ran>
}

// Runs `agent-qa run` in this process; the mocked exit throws, so only the first exit counts.
function startCli(project: InProcessFixture, args: readonly string[]): Running {
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const lines: string[] = []
  const stderr: string[] = []
  let exited = false
  const keep =
    (into: string[][]) =>
    (...parts: unknown[]): void => {
      if (exited) return
      const text = plain(parts.map(String).join(' ')).split('\n')
      for (const target of into) target.push(...text)
    }
  vi.spyOn(console, 'log').mockImplementation(keep([lines]))
  vi.spyOn(console, 'warn').mockImplementation(keep([lines]))
  vi.spyOn(console, 'error').mockImplementation(keep([lines, stderr]))
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    exited = true
    throw new Error('fixture command exit')
  })
  const written = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')]
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  const done = program
    .parseAsync(['--config', project.configPath, 'run', ...args], { from: 'user' })
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'fixture command exit')) throw error
    })
    .then(() => {
      const streams = written.flatMap((spy) =>
        spy.mock.calls.map(([chunk]) => plain(String(chunk))),
      )
      return {
        lines,
        stderr,
        log: [...lines, ...streams].join('\n'),
        exitCode: exit.mock.calls[0]?.[0],
      }
    })
  return { done }
}

function spyAppium(): { acquire: ReturnType<typeof vi.spyOn>; lease: ReturnType<typeof vi.spyOn> } {
  const noLocalAppium = (): Promise<never> =>
    Promise.reject(new Error('a remote device starts no Appium here'))
  return {
    acquire: vi.spyOn(AppiumManager.prototype, 'acquire').mockImplementation(noLocalAppium),
    lease: vi.spyOn(AppiumManager.prototype, 'acquireLease').mockImplementation(noLocalAppium),
  }
}

function newSessions(server: FakeAppiumServer): readonly FakeAppiumRequest[] {
  return server.requests.filter(
    (request) => request.method === 'POST' && request.path === `${BASE_PATH}/session`,
  )
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// The sentence is one line, the run exits 2 with no stack trace, and no mark is written anywhere.
function expectOneCleanRefusal(project: InProcessFixture, ran: Ran, sentence: string): void {
  const { log } = ran
  expect(ran.exitCode, log).toBe(2)
  expect(ran.lines.filter((line) => line.includes(sentence)), log).toHaveLength(1)
  expect(ran.stderr.filter((line) => line.includes(sentence)), log).toHaveLength(1)
  expect(log.split('\n').filter((line) => /^\s+at /.test(line)), log).toEqual([])
  const written = filesUnder(project.agentQaRoot)
  expect(written.some((file) => file.endsWith('runs.db')), log).toBe(true)
  for (const mark of LEAK_MARKS) {
    expect(log.includes(mark), `${mark} was printed\n${log}`).toBe(false)
    for (const file of written) {
      expect(readFileSync(file, 'latin1').includes(mark), `${mark} is in ${file}`).toBe(false)
    }
  }
}

function labelOf(url: string): string {
  return `farm (appium ${new URL(url).origin})`
}

describe('a remote device refused before its test starts', () => {
  it(
    'refused credentials name the device, the origin and the secrets to check',
    async () => {
      const server = await fakeFarm({
        newSession: [
          {
            status: 401,
            json: {
              value: {
                error: 'session not created',
                message: `bad key ${TOKEN_MARK}\n${BODY_MARK}`,
              },
            },
          },
        ],
      })
      const project = onFarm(server.url)
      const { acquire, lease } = spyAppium()

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(server.url)} refused the credentials for device ${REMOTE_DEVICE_NAME}. Check FARM_TOKEN and FARM_KEY in .env.secrets.local.`,
      )
      expect(newSessions(server), ran.log).toHaveLength(1)
      expect(acquire).not.toHaveBeenCalled()
      expect(lease).not.toHaveBeenCalled()
    },
    RUN_BUDGET_MS,
  )

  it(
    "a refused session follows the sentence with the first line of the server's JSON message",
    async () => {
      const server = await fakeFarm({
        newSession: [
          {
            status: 500,
            json: {
              value: {
                error: 'session not created',
                message: `no device matches at ${ELSEWHERE} for ${TOKEN_MARK}\n${BODY_MARK}`,
              },
            },
          },
        ],
      })
      const project = onFarm(server.url)

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(server.url)} refused a session for device ${REMOTE_DEVICE_NAME}: no device matches at https://farm.internal:443 for [secret:FARM_TOKEN].`,
      )
      expect(newSessions(server), ran.log).toHaveLength(1)
    },
    RUN_BUDGET_MS,
  )

  it(
    "a refused session with a text reply follows the sentence with the reply's first line",
    async () => {
      const server = await fakeFarm({
        newSession: [
          { status: 500, text: `no free device at ${ELSEWHERE} for ${TOKEN_MARK}\n${BODY_MARK}` },
        ],
      })
      const project = onFarm(server.url)

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(server.url)} refused a session for device ${REMOTE_DEVICE_NAME}: no free device at https://farm.internal:443 for [secret:FARM_TOKEN].`,
      )
      expect(newSessions(server), ran.log).toHaveLength(1)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a server that does not answer names the url to check',
    async () => {
      const url = await closedPortUrl()
      const project = onFarm(url)

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(url)} did not answer for device ${REMOTE_DEVICE_NAME}. Check its url and that the server is running.`,
      )
    },
    RUN_BUDGET_MS,
  )

  it(
    "a session that does not open within the remote's connectTimeout names the bound",
    async () => {
      const server = await fakeFarm({ newSession: ['hold'] })
      const project = onFarm(server.url, { connectTimeout: '1s' })

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(server.url)} did not open a session for device ${REMOTE_DEVICE_NAME} within 1s. Raise its connectTimeout or check the service.`,
      )
      expect(newSessions(server), ran.log).toHaveLength(1)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a server with no free device says to lower the workers',
    async () => {
      const server = await fakeFarm({
        newSession: [
          {
            status: 429,
            json: { value: { error: 'session not created', message: `busy ${BODY_MARK}` } },
          },
        ],
      })
      const project = onFarm(server.url)

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Remote ${labelOf(server.url)} has no free device for ${REMOTE_DEVICE_NAME}. Lower use.workers or raise the service's limit.`,
      )
      expect(newSessions(server), ran.log).toHaveLength(1)
    },
    RUN_BUDGET_MS,
  )

  it(
    'a target with only app.path is refused for a remote device without asking the server',
    async () => {
      const server = await fakeFarm()
      const project = onFarm(server.url, { appPath: 'builds/shop.apk' })

      const ran = await startCli(project, [project.testPattern]).done

      expectOneCleanRefusal(
        project,
        ran,
        `Device ${REMOTE_DEVICE_NAME} runs on remote farm, and target ${REMOTE_DEVICE_TARGET_NAME} has only app.path. Set app.ref to the app the server installs.`,
      )
      expect(newSessions(server), ran.log).toEqual([])
    },
    RUN_BUDGET_MS,
  )

  it(
    'a remote that refused once in a run is not asked again for the next test',
    async () => {
      const server = await fakeFarm({
        newSession: [
          { status: 401, json: { value: { error: 'session not created', message: 'bad key' } } },
        ],
      })
      const project = onFarm(server.url, { secondTest: true })
      expect(project.secondDirectTestPattern).toBeDefined()

      const ran = await startCli(project, [
        project.testPattern,
        project.secondDirectTestPattern!,
      ]).done

      expect(ran.exitCode, ran.log).toBe(2)
      expect(newSessions(server), ran.log).toHaveLength(1)
      expect(server.sessionsCreated(), ran.log).toEqual([])
    },
    RUN_BUDGET_MS,
  )
})

describe('a remote device session open when the run is stopped', () => {
  it(
    'is deleted within the release bound and the server keeps answering',
    async () => {
      const held = /\/session\/[^/]+\/./
      const server = await fakeFarm({ hold: held })
      const project = onFarm(server.url)

      const running = startCli(project, [project.testPattern])
      const deadline = Date.now() + RUN_BUDGET_MS
      while (
        !server.requests.some((request) => held.test(`${request.method} ${request.path}`))
      ) {
        if (Date.now() > deadline) throw new Error('the session never sent a command')
        await new Promise((tick) => setTimeout(tick, 50))
      }
      expect(server.sessionsCreated()).toHaveLength(1)
      expect(server.sessionsDeleted()).toEqual([])

      const started = Date.now()
      await releaseRemoteSessions(REMOTE_RELEASE_BOUND_MS)

      expect(Date.now() - started).toBeLessThan(REMOTE_RELEASE_BOUND_MS)
      expect(server.sessionsDeleted()).toEqual(server.sessionsCreated())
      const status = await fetch(`${server.url}/status`)
      expect(status.status).toBe(200)

      await server.close()
      await running.done
    },
    RUN_BUDGET_MS,
  )
})
