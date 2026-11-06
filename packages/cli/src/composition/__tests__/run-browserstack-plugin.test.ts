// agent-qa run drives tests through the built BrowserStack plugin, installed in the project as a
// user installs it, against loopback fakes of BrowserStack's REST APIs and its Appium hub.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateTestId } from '@vostride/agent-qa-ids'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  POPULATED_MODEL_ID,
  startStubModelServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import type { StubModelServer } from '../../__tests__/conformance/populated-run-fixture.js'
import { linkBuiltPlugin, pluginTestModule } from './first-party-plugin-project.js'
import {
  IN_PROCESS_TARGET_NAME,
  REMOTE_DEVICE_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'

interface ApiRequest {
  readonly params: Record<string, string>
  readonly body: unknown
}

interface FakeBrowserStackApi {
  readonly url: string
  readonly requests: readonly ApiRequest[]
  routeCalls(key: string): readonly ApiRequest[]
  dashboardLink(sessionId: string): string
  marks(): { sessionId: string; body: unknown }[]
  webMarks(): { sessionId: string; body: unknown }[]
  uploads(): ApiRequest[]
  close(): Promise<void>
}

interface FakeAppiumRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface FakeAppiumServer {
  readonly url: string
  readonly requests: readonly FakeAppiumRequest[]
  sessionsCreated(): readonly string[]
  sessionsDeleted(): readonly string[]
  close(): Promise<void>
}

const { startFakeBrowserStackApi, uploadedField, RECENT_APPS_ROUTE } = (await import(
  pluginTestModule('browserstack', 'fake-browserstack-api.js')
)) as {
  startFakeBrowserStackApi: () => Promise<FakeBrowserStackApi>
  uploadedField: (request: ApiRequest, name: string) => string | undefined
  RECENT_APPS_ROUTE: string
}

const { startFakeAppiumServer } = (await import(
  new URL('../../../../android/src/__tests__/fixtures/fake-appium-server.js', import.meta.url).href
)) as { startFakeAppiumServer: () => Promise<FakeAppiumServer> }

const RUN_BUDGET_MS = 180_000
const ENTRY_NAME = 'browserstack'
const DEVICE_REMOTE = 'bs-pixel'
const WEB_REMOTE = 'bs-chrome'
const USERNAME = 'bs-e2e-user'
const ACCESS_KEY = 'bsAccessKey7Qm2Zr9Xw'
const APP_PATH = 'apps/shop.apk'
const DEVICE_STEP = 'Wait a moment for the shop to settle'
const WEB_TEST = 'tests/web.yaml'
// Playwright reaches the endpoint only if the plugin answered, so a refusal leaves it unused.
const UNUSED_PLAYWRIGHT_URL = 'ws://127.0.0.1:9/playwright'

const opened: Array<() => Promise<void>> = []

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
  readonly api: FakeBrowserStackApi
  readonly hub: FakeAppiumServer
  readonly model: StubModelServer
}

async function onBrowserStack(): Promise<Scene> {
  const hub = await startFakeAppiumServer()
  opened.push(() => hub.close())
  const api = await startFakeBrowserStackApi()
  opened.push(() => api.close())
  const model = await startStubModelServer({
    plannerTool: { name: 'common_delay', args: { ms: 50 } },
  })
  opened.push(() => model.close())

  const project = createInProcessFixture({
    origin: 'http://127.0.0.1:9',
    environment: 'local',
    stepText: DEVICE_STEP,
    model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
    remoteDevice: { url: hub.url, model: 'Google Pixel 8', os: '14', appPath: APP_PATH },
    extraSecrets: { BROWSERSTACK_USERNAME: USERNAME, BROWSERSTACK_ACCESS_KEY: ACCESS_KEY },
  })
  const { packageName } = linkBuiltPlugin(project.project, 'browserstack')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown; devices: Record<string, { remote?: string }> }
    plugins?: unknown
  }
  config.registry.remotes = [
    { name: DEVICE_REMOTE, plugin: ENTRY_NAME },
    { name: WEB_REMOTE, plugin: ENTRY_NAME },
  ]
  config.registry.devices[REMOTE_DEVICE_NAME]!.remote = DEVICE_REMOTE
  config.plugins = [
    {
      name: ENTRY_NAME,
      package: packageName,
      options: {
        username: '{{secret:BROWSERSTACK_USERNAME}}',
        accessKey: '{{secret:BROWSERSTACK_ACCESS_KEY}}',
        apiUrl: api.url,
        appApiUrl: api.url,
        hubUrl: hub.url,
        playwrightUrl: UNUSED_PLAYWRIGHT_URL,
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
  writeFileSync(
    join(project.project, WEB_TEST),
    [
      `test-id: ${generateTestId()}`,
      'name: the web test',
      `target: ${IN_PROCESS_TARGET_NAME}`,
      'use:',
      '  browser:',
      `    remote: ${WEB_REMOTE}`,
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  vi.stubEnv('HOME', freshUpdateCheckHome())
  return { project, api, hub, model }
}

interface Run {
  readonly exitCode: unknown
  readonly lines: string[]
  readonly log: string
}

async function runAgentQa(project: InProcessFixture, pattern: string): Promise<Run> {
  const lines: string[] = []
  let exited = false
  const keep = (...args: unknown[]): void => {
    if (!exited) lines.push(...plain(args.map(String).join(' ')).split('\n'))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
  ]
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    exited = true
    throw new Error('fixture command exit')
  })
  try {
    const program = new Command().option('--config <path>').addCommand(createRunCommand())
    await expect(
      program.parseAsync(['--config', project.configPath, 'run', pattern], { from: 'user' }),
    ).rejects.toThrow('fixture command exit')
    return { exitCode: exit.mock.calls[0]?.[0], lines, log: lines.join('\n') }
  } finally {
    for (const spy of [...spies, exit]) spy.mockRestore()
  }
}

function storedRuns(project: InProcessFixture): Array<{ outcomes: unknown[]; place: unknown }> {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => {
      const payload = db.getRunArtifact(run.id)?.payload as
        | { config?: { runtime?: { place?: unknown } } }
        | undefined
      return {
        outcomes: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => member.outcome),
        place: payload?.config?.runtime?.place,
      }
    })
  } finally {
    db.close()
  }
}

function newSessionCapabilities(hub: FakeAppiumServer): Array<Record<string, unknown>> {
  return hub.requests
    .filter((request) => request.method === 'POST' && request.path.endsWith('/session'))
    .map((request) => {
      const body = request.body as { capabilities?: { alwaysMatch?: Record<string, unknown> } }
      return body.capabilities?.alwaysMatch ?? {}
    })
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

describe('tests on remotes served by the built BrowserStack plugin', () => {
  it(
    "agent-qa run uploads the target's app, opens the device session on it, prints and records the session's link and marks it passed",
    async () => {
      const { project, api, hub } = await onBrowserStack()

      const run = await runAgentQa(project, project.testPattern)

      expect(run.exitCode, run.log).toBe(0)
      const uploads = api.uploads()
      expect(uploads, run.log).toHaveLength(1)
      expect(uploadedField(uploads[0]!, 'custom_id'), run.log).toMatch(/^agent-qa-[0-9a-f]{32}$/)

      const [asked] = newSessionCapabilities(hub)
      expect(asked?.['appium:app'], run.log).toBe('bs://uploaded-1')
      expect(asked?.['bstack:options'], run.log).toMatchObject({ appiumVersion: '3.5.2' })

      const [sessionId] = hub.sessionsCreated()
      expect(sessionId, run.log).toBeDefined()
      expect(hub.sessionsDeleted(), run.log).toEqual([sessionId])
      const link = api.dashboardLink(sessionId!)
      expect(
        run.lines.map((line) => line.trim()),
        run.log,
      ).toContain(`Remote ${DEVICE_REMOTE}: ${link}`)
      expect(api.marks(), run.log).toEqual([{ sessionId, body: { status: 'passed' } }])

      const runs = storedRuns(project)
      expect(runs.map((stored) => stored.outcomes), run.log).toEqual([['passed']])
      expect(runs[0]?.place, run.log).toMatchObject({
        place: 'remote',
        name: DEVICE_REMOTE,
        device: REMOTE_DEVICE_NAME,
        appiumVersion: '3.5.2',
        link,
        plugin: {
          entry: ENTRY_NAME,
          package: '@vostride/agent-qa-plugin-browserstack',
          version: getAgentQaVersion(),
          origin: 'first-party',
        },
      })

      expect(run.log.includes(ACCESS_KEY), 'the output holds the access key').toBe(false)
      const holders = filesUnder(project.agentQaRoot).filter((path) =>
        readFileSync(path).toString('latin1').includes(ACCESS_KEY),
      )
      expect(holders, 'a record holds the access key').toEqual([])
    },
    RUN_BUDGET_MS,
  )

  it(
    'a second agent-qa run of the same app finds its upload through recent_apps and uploads nothing',
    async () => {
      const { project, api, hub } = await onBrowserStack()

      const first = await runAgentQa(project, project.testPattern)
      expect(first.exitCode, first.log).toBe(0)
      const second = await runAgentQa(project, project.testPattern)
      expect(second.exitCode, second.log).toBe(0)

      expect(api.uploads(), second.log).toHaveLength(1)
      const lookups = api.routeCalls(RECENT_APPS_ROUTE)
      expect(lookups, second.log).toHaveLength(2)
      expect(lookups[1]?.params.customId, second.log).toBe(
        uploadedField(api.uploads()[0]!, 'custom_id'),
      )
      expect(
        newSessionCapabilities(hub).map((asked) => asked['appium:app']),
        second.log,
      ).toEqual(['bs://uploaded-1', 'bs://uploaded-1'])
      expect(
        api.marks().map((mark) => mark.body),
        second.log,
      ).toEqual([{ status: 'passed' }, { status: 'passed' }])
    },
    RUN_BUDGET_MS,
  )

  it(
    "agent-qa run refuses a web test on BrowserStack before it starts, with BrowserStack's Playwright versions, and exits 2",
    async () => {
      const { project, api, model } = await onBrowserStack()

      const run = await runAgentQa(project, WEB_TEST)

      expect(run.exitCode, run.log).toBe(2)
      const refusals = run.lines.filter((line) =>
        line.includes('BrowserStack lists Playwright 1.59 to 1.63, not 1.64'),
      )
      expect(refusals, run.log).toHaveLength(1)
      expect(refusals[0], run.log).toContain(
        'so web tests cannot run there yet; run this test here or on another remote.',
      )
      expect(model.requests, run.log).toEqual([])
      expect(api.webMarks(), run.log).toEqual([])
    },
    RUN_BUDGET_MS,
  )
})
