// agent-qa run drives a web test through the built Hyperbrowser plugin, installed in the project
// as a user installs it, against a fake Hyperbrowser API whose sessions are a loopback CDP
// Chromium.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { chromium } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  POPULATED_MODEL_ID,
  POPULATED_PASSING_STEP_TEXT,
  startStubModelServer,
  startTargetPageServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import { linkBuiltPlugin, pluginTestModule } from './first-party-plugin-project.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'
import { refuseWithoutChromium } from './remote-browser-endpoint.js'

interface HyperbrowserRequest {
  readonly params: Record<string, string>
  readonly body: unknown
}

interface FakeHyperbrowserApi {
  readonly url: string
  routeCalls(key: string): readonly HyperbrowserRequest[]
  createdIds(): string[]
  stoppedIds(): string[]
  close(): Promise<void>
}

interface CdpBrowser {
  readonly endpoint: string
  close(): Promise<void>
}

const { startFakeHyperbrowserApi } = (await import(
  pluginTestModule('hyperbrowser', 'fake-hyperbrowser-api.js')
)) as { startFakeHyperbrowserApi: (input: { cdpUrl: string }) => Promise<FakeHyperbrowserApi> }

const { startCdpBrowser } = (await import(
  new URL('../../../../web/src/__tests__/fixtures/remote-browsers.js', import.meta.url).href
)) as { startCdpBrowser: () => Promise<CdpBrowser> }

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'hyper-chrome'
const ENTRY_NAME = 'hyperbrowser'
const KEY_NAME = 'HYPERBROWSER_API_KEY'
const API_KEY = 'hb_e2e_4f9b20c7e815'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => {
  refuseWithoutChromium()
  pinnedTmpdir = pinProcessTmpdir()
})
afterEach(() => {
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

function placeOnHyperbrowser(project: InProcessFixture, api: FakeHyperbrowserApi): void {
  const { packageName } = linkBuiltPlugin(project.project, 'hyperbrowser')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [
    {
      name: ENTRY_NAME,
      package: packageName,
      options: { apiKey: `{{secret:${KEY_NAME}}}`, apiUrl: api.url },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
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

describe('a web test on a remote served by the built Hyperbrowser plugin', () => {
  it('agent-qa run creates a Hyperbrowser session with every page-changing feature off and no keep-alive, passes on it, stops it and names the plugin as first-party', async () => {
    const page = await startTargetPageServer()
    const model = await startStubModelServer()
    const cdp = await startCdpBrowser()
    const api = await startFakeHyperbrowserApi({ cdpUrl: cdp.endpoint })
    try {
      const project = createInProcessFixture({
        origin: page.url,
        environment: 'local',
        stepText: POPULATED_PASSING_STEP_TEXT,
        model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
        remote: { name: REMOTE_NAME, protocol: 'cdp', url: cdp.endpoint },
        extraSecrets: { [KEY_NAME]: API_KEY },
      })
      placeOnHyperbrowser(project, api)
      vi.stubEnv('HOME', freshUpdateCheckHome())
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
      const launch = vi.spyOn(chromium, 'launch')

      const program = new Command().option('--config <path>').addCommand(createRunCommand())
      await expect(
        program.parseAsync(['--config', project.configPath, 'run', project.testPattern], {
          from: 'user',
        }),
      ).rejects.toThrow('fixture command exit')

      const log = printed.join('\n')
      expect(exit.mock.calls[0]?.[0], log).toBe(0)
      expect(launch, log).not.toHaveBeenCalled()

      const creates = api.routeCalls('POST /api/session')
      expect(creates, log).toHaveLength(1)
      const body = creates[0]?.body as Record<string, unknown> | undefined
      expect(body, log).toMatchObject({
        timeoutMinutes: 720,
        useStealth: false,
        useProxy: false,
        solveCaptchas: false,
        adblock: false,
        trackers: false,
        annoyances: false,
        acceptCookies: false,
      })
      expect(body, log).not.toHaveProperty('keepAlive')
      expect(api.createdIds(), log).toHaveLength(1)
      expect(api.stoppedIds(), log).toEqual(api.createdIds())

      const runs = storedRuns(project)
      expect(runs.map((run) => run.outcomes), log).toEqual([['passed']])
      expect(runs[0]?.place, log).toMatchObject({
        place: 'remote',
        name: REMOTE_NAME,
        protocol: 'cdp',
        plugin: {
          entry: ENTRY_NAME,
          package: '@vostride/agent-qa-plugin-hyperbrowser',
          version: getAgentQaVersion(),
          origin: 'first-party',
        },
      })

      expect(log.includes(API_KEY), 'the output holds the API key').toBe(false)
      const records = filesUnder(project.agentQaRoot)
      expect(records.length, log).toBeGreaterThan(0)
      const holders = records.filter((path) =>
        readFileSync(path).toString('latin1').includes(API_KEY),
      )
      expect(holders, 'a record holds the API key').toEqual([])
    } finally {
      await api.close()
      await cdp.close()
      await model.close()
      await page.close()
    }
  }, RUN_BUDGET_MS)
})
