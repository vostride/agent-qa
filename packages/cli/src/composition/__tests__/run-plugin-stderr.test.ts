// A path plugin writes a planted secret to stderr while it acquires: agent-qa run shows it masked,
// under its entry, at --log-level debug, and nowhere at the default level.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

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
  PLANTED_SECRET_NAME,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const PLANTED = 'zq7-stderr-planted-secret'
const LOGGED = 'signed in to the lab with ' + PLANTED

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

function placeOnPlugin(project: InProcessFixture, wsEndpoint: string): void {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), { methods: [] })
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [
    {
      name: ENTRY_NAME,
      path: `./tools/${ENTRY_NAME}`,
      options: {
        answer: { protocol: 'playwright', url: wsEndpoint },
        stderr: { acquire: LOGGED },
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
}

interface StderrRun {
  exitCode: unknown
  log: string
  stderr: string
}

async function runWithStderr(globalArgs: readonly string[]): Promise<StderrRun> {
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
      plantedSecret: PLANTED,
    })
    placeOnPlugin(project, endpoint.wsEndpoint)
    vi.stubEnv('HOME', freshUpdateCheckHome())
    const printed: string[] = []
    const written: string[] = []
    let exited = false
    const keep = (...args: unknown[]): void => {
      if (!exited) printed.push(plain(args.map(String).join(' ')))
    }
    vi.spyOn(console, 'log').mockImplementation(keep)
    vi.spyOn(console, 'warn').mockImplementation(keep)
    vi.spyOn(console, 'error').mockImplementation(keep)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(plain(String(chunk)))
      return true
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      exited = true
      throw new Error('fixture command exit')
    })

    const program = new Command()
      .option('--config <path>')
      .option('--log-level <level>')
      .addCommand(createRunCommand())
    await expect(
      program.parseAsync(
        [...globalArgs, '--config', project.configPath, 'run', project.testPattern],
        { from: 'user' },
      ),
    ).rejects.toThrow('fixture command exit')

    return { exitCode: exit.mock.calls[0]?.[0], log: printed.join('\n'), stderr: written.join('') }
  } finally {
    await endpoint.close()
    await model.close()
    await page.close()
  }
}

describe("a plugin's stderr during agent-qa run", () => {
  it("shows a plugin's stderr line, masked and under its entry, as a DEBUG line on stderr at --log-level debug", async () => {
    const run = await runWithStderr(['--log-level', 'debug'])

    expect(run.exitCode, run.log).toBe(0)
    expect(run.stderr).toMatch(
      new RegExp(
        `DEBUG\\s+\\[adapter\\] plugin lab: signed in to the lab with \\[secret:${PLANTED_SECRET_NAME}\\]`,
      ),
    )
    expect(run.stderr).not.toContain(PLANTED)
    expect(run.log).not.toContain(PLANTED)
    expect(run.log).not.toContain('signed in to the lab')
  }, RUN_BUDGET_MS)

  it('shows no plugin stderr line at the default level', async () => {
    const run = await runWithStderr([])

    expect(run.exitCode, run.log).toBe(0)
    expect(run.stderr).not.toContain('signed in to the lab')
    expect(run.log).not.toContain('signed in to the lab')
  }, RUN_BUDGET_MS)
})
