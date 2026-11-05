// A path plugin built with the kit answers acquire with a loopback Playwright server, and the run
// connects its web test there through the one web adapter.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { chromium } from 'playwright-core'
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

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'

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

// The fixture's url remote becomes a remote that names a path plugins entry under the same pick.
function placeOnPlugin(project: InProcessFixture, wsEndpoint: string): string {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), { methods: [] })
  const ledgerFile = join(project.project, 'plugin-ledger.jsonl')
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [
    {
      name: ENTRY_NAME,
      path: `./tools/${ENTRY_NAME}`,
      options: { answer: { protocol: 'playwright', url: wsEndpoint }, ledgerFile },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
  return ledgerFile
}

function ledgerMethods(ledgerFile: string): string[] {
  if (!existsSync(ledgerFile)) return []
  return readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

function storedRuns(project: InProcessFixture): Array<{ runner: unknown; outcomes: unknown[] }> {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).map((run) => ({
      runner: run.attributes['agent-qa.runner'],
      outcomes: (db.readRunDetailRows(run.id)?.members ?? []).map((member) => member.outcome),
    }))
  } finally {
    db.close()
  }
}

describe('a web test on a remote that names a plugins entry', () => {
  it('agent-qa run connects to the server the plugin answered and hands the session back', async () => {
    const page = await startTargetPageServer()
    const model = await startStubModelServer()
    const endpoint = await startRemoteBrowserEndpoint()
    try {
      const project = createInProcessFixture({
        origin: page.url,
        environment: 'local',
        stepText: POPULATED_PASSING_STEP_TEXT,
        model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
        remote: { name: REMOTE_NAME, protocol: 'playwright', url: endpoint.wsEndpoint },
      })
      const ledgerFile = placeOnPlugin(project, endpoint.wsEndpoint)
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
      expect(storedRuns(project), log).toEqual([{ runner: 'remote', outcomes: ['passed'] }])
      expect(endpoint.sessions(), log).toBe(1)
      expect(launch, log).not.toHaveBeenCalled()
      expect(ledgerMethods(ledgerFile), log).toEqual([
        'initialize',
        'acquire',
        'release',
        'shutdown',
      ])
    } finally {
      await endpoint.close()
      await model.close()
      await page.close()
    }
  }, RUN_BUDGET_MS)
})
