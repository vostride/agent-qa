// A plugin's answer is a credential: the run records the place by its origin, the plugin's
// identity and the session's link, and the values the answer asks to mask are masked from then on.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { writeScriptedPlugin } from '@vostride/agent-qa-plugin-kit/testing'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  POPULATED_MODEL_ID,
  POPULATED_PASSING_STEP_TEXT,
  startStubModelServer,
  startTargetPageServer,
} from '../../__tests__/conformance/populated-run-fixture.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const TOKEN = 'tok-abc123'
const HEADER_VALUE = 'hdr-xyz789'
const LINK = 'https://dashboard.invalid/s/1'

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

function answerUrl(endpoint: RemoteBrowserEndpoint): string {
  return `${endpoint.wsEndpoint}?token=${TOKEN}`
}

// The answer lives in a file the plugin reads at acquire, so the config never holds its values.
function placeOnPlugin(project: InProcessFixture, endpoint: RemoteBrowserEndpoint): void {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), { methods: [], version: '2.4.1' })
  const answerFile = join(project.project, 'plugin-answer.json')
  writeFileSync(
    answerFile,
    JSON.stringify({
      protocol: 'playwright',
      url: answerUrl(endpoint),
      headers: { 'x-session': HEADER_VALUE },
      mask: [TOKEN],
      link: LINK,
    }),
  )
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [{ name: ENTRY_NAME, path: `./tools/${ENTRY_NAME}`, options: { answerFile } }]
  writeFileSync(project.configPath, stringifyYaml(config))
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function storedPlace(project: InProcessFixture): unknown {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    const runs = db.getRuns({})
    expect(runs).toHaveLength(1)
    const payload = db.getRunArtifact(runs[0]!.id)?.payload as Record<string, any> | undefined
    return payload?.config?.runtime?.place
  } finally {
    db.close()
  }
}

interface PluginRun {
  exitCode: unknown
  log: string
  place: unknown
  origin: string
  sessions: number
  refusals: number
  records: Array<{ path: string; text: string }>
}

async function runOnPlugin(): Promise<PluginRun> {
  const page = await startTargetPageServer()
  const endpoint = await startRemoteBrowserEndpoint({ requireHeader: ['x-session', HEADER_VALUE] })
  // The model repeats the session's url, as a model reading a page that shows it would.
  const stub = await startStubModelServer({
    plannerOutcome: 'stepFailed',
    plannerNote: `The session url is ${answerUrl(endpoint)} here.`,
  })
  try {
    const project = createInProcessFixture({
      origin: page.url,
      environment: 'local',
      stepText: POPULATED_PASSING_STEP_TEXT,
      model: { baseUrl: stub.baseUrl, id: POPULATED_MODEL_ID },
      remote: { name: REMOTE_NAME, protocol: 'playwright', url: endpoint.wsEndpoint },
    })
    placeOnPlugin(project, endpoint)
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

    const program = new Command().option('--config <path>').addCommand(createRunCommand())
    await expect(
      program.parseAsync(['--config', project.configPath, 'run', project.testPattern], {
        from: 'user',
      }),
    ).rejects.toThrow('fixture command exit')

    return {
      exitCode: exit.mock.calls[0]?.[0],
      log: printed.join('\n'),
      place: storedPlace(project),
      origin: `ws://127.0.0.1:${new URL(endpoint.wsEndpoint).port}`,
      sessions: endpoint.sessions(),
      refusals: endpoint.refusals(),
      records: filesUnder(project.agentQaRoot).map((path) => ({
        path,
        text: readFileSync(path).toString('latin1'),
      })),
    }
  } finally {
    await endpoint.close()
    await stub.close()
    await page.close()
  }
}

describe('a test on a plugin remote', () => {
  it("records the place by the answer's origin, the plugin that served it and the session's link, and masks the answer's values", async () => {
    const run = await runOnPlugin()

    expect(run.exitCode, run.log).toBe(1)
    expect(run.sessions, run.log).toBe(1)
    expect(run.refusals, run.log).toBe(0)
    expect(run.place, run.log).toMatchObject({
      place: 'remote',
      name: REMOTE_NAME,
      protocol: 'playwright',
      origin: run.origin,
      plugin: {
        entry: ENTRY_NAME,
        path: `./tools/${ENTRY_NAME}`,
        version: '2.4.1',
        protocol: 1,
        origin: 'path',
      },
      link: LINK,
    })
    expect(run.place, run.log).not.toHaveProperty('plugin.package')

    expect(run.log).toContain('[secret:PLUGIN_LAB]')
    expect(run.records.length, run.log).toBeGreaterThan(0)
    for (const leaked of new Set([TOKEN, encodeURIComponent(TOKEN), HEADER_VALUE])) {
      expect(run.log.includes(leaked), 'the output holds an answer value').toBe(false)
      const holders = run.records.filter((record) => record.text.includes(leaked))
      expect(
        holders.map((record) => record.path),
        'a record holds an answer value',
      ).toEqual([])
    }
  }, RUN_BUDGET_MS)
})
