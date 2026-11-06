// agent-qa run drives a web test through the built Kernel plugin, installed in the project as a
// user installs it, against a fake Kernel API whose browsers are a loopback CDP Chromium.

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

interface KernelRequest {
  readonly params: Record<string, string>
  readonly body: unknown
}

interface FakeKernelApi {
  readonly url: string
  routeCalls(key: string): readonly KernelRequest[]
  createdIds(): string[]
  deletedIds(): string[]
  close(): Promise<void>
}

interface CdpBrowser {
  readonly endpoint: string
  close(): Promise<void>
}

const { startFakeKernelApi } = (await import(pluginTestModule('kernel', 'fake-kernel-api.js'))) as {
  startFakeKernelApi: (input: { cdpUrl: string }) => Promise<FakeKernelApi>
}

const { startCdpBrowser } = (await import(
  new URL('../../../../web/src/__tests__/fixtures/remote-browsers.js', import.meta.url).href
)) as { startCdpBrowser: () => Promise<CdpBrowser> }

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'kernel-chrome'
const ENTRY_NAME = 'kernel'
const KEY_NAME = 'KERNEL_API_KEY'
const API_KEY = 'sk_kernel_e2e_5f1c2d9a7b'

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

function placeOnKernel(project: InProcessFixture, api: FakeKernelApi): void {
  const { packageName } = linkBuiltPlugin(project.project, 'kernel')
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

describe('a web test on a remote served by the built Kernel plugin', () => {
  it('agent-qa run creates a Kernel browser, passes on it, deletes it and names the plugin as first-party', async () => {
    const page = await startTargetPageServer()
    const model = await startStubModelServer()
    const cdp = await startCdpBrowser()
    const api = await startFakeKernelApi({ cdpUrl: cdp.endpoint })
    try {
      const project = createInProcessFixture({
        origin: page.url,
        environment: 'local',
        stepText: POPULATED_PASSING_STEP_TEXT,
        model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
        remote: { name: REMOTE_NAME, protocol: 'cdp', url: cdp.endpoint },
        extraSecrets: { [KEY_NAME]: API_KEY },
      })
      placeOnKernel(project, api)
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

      const creates = api.routeCalls('POST /browsers')
      expect(creates, log).toHaveLength(1)
      expect(creates[0]?.body, log).toMatchObject({ headless: true })
      expect(api.createdIds(), log).toEqual(['browser-1'])
      expect(api.deletedIds(), log).toEqual(['browser-1'])

      const runs = storedRuns(project)
      expect(runs.map((run) => run.outcomes), log).toEqual([['passed']])
      expect(runs[0]?.place, log).toMatchObject({
        place: 'remote',
        name: REMOTE_NAME,
        protocol: 'cdp',
        plugin: {
          entry: ENTRY_NAME,
          package: '@vostride/agent-qa-plugin-kernel',
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
