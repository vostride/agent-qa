// A path plugin reports its farm queue while it acquires: agent-qa run prints each change of that
// line once, masked, before the session's link, and the run's event log keeps it for its member.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  runDirs,
} from './in-process-run-fixture.js'
import type { InProcessFixture, InProcessFixtureInput } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'lab-chrome'
const ENTRY_NAME = 'lab'
const LINK = 'https://lab.invalid/sessions/1'
const PLANTED = 'zq7-progress-planted-secret'
const FIRST = `queued, 3 ahead on pool ${PLANTED}`
const SECOND = 'queued, 1 ahead'

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

// The fixture's url remote becomes a remote that names a path plugins entry, whose acquire
// reports each queue position twice.
function placeOnPlugin(project: InProcessFixture, wsEndpoint: string): void {
  writeScriptedPlugin(join(project.project, 'tools', ENTRY_NAME), { methods: ['started'] })
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
        started: { link: LINK },
        progress: [
          { message: FIRST, queued: 3 },
          { message: FIRST, queued: 3 },
          { message: SECOND, queued: 1 },
          { message: SECOND, queued: 1 },
        ],
      },
    },
  ]
  writeFileSync(project.configPath, stringifyYaml(config))
}

interface ProgressRun {
  exitCode: unknown
  log: string
  printed: readonly string[]
  project: InProcessFixture
}

async function runWithProgress(
  pattern: (project: InProcessFixture) => string,
  knobs: Partial<InProcessFixtureInput> = {},
): Promise<ProgressRun> {
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
      ...knobs,
    })
    placeOnPlugin(project, endpoint.wsEndpoint)
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
      program.parseAsync(['--config', project.configPath, 'run', pattern(project)], {
        from: 'user',
      }),
    ).rejects.toThrow('fixture command exit')

    return { exitCode: exit.mock.calls[0]?.[0], log: printed.join('\n'), printed, project }
  } finally {
    await endpoint.close()
    await model.close()
    await page.close()
  }
}

function progressEvents(project: InProcessFixture): unknown[] {
  return runDirs(project).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; payload: unknown })
      .filter((event) => event.type === 'remoteProgress')
      .map((event) => event.payload)
  })
}

const MASKED_FIRST = `Remote ${REMOTE_NAME}: queued, 3 ahead on pool [secret:${PLANTED_SECRET_NAME}]`
const SHOWN_SECOND = `Remote ${REMOTE_NAME}: ${SECOND}`
const LINK_NOTE = `Remote ${REMOTE_NAME}: ${LINK}`

describe("a plugin's progress while it acquires", () => {
  it('prints each change of the queue line once, masked, before the session link', async () => {
    const run = await runWithProgress((project) => project.testPattern)

    expect(run.exitCode, run.log).toBe(0)
    const first = run.printed.filter((line) => line.trim() === MASKED_FIRST)
    const second = run.printed.filter((line) => line.trim() === SHOWN_SECOND)
    expect(first, run.log).toHaveLength(1)
    expect(second, run.log).toHaveLength(1)
    expect(run.log).not.toContain(PLANTED)
    const at = (text: string) => run.printed.findIndex((line) => line.trim() === text)
    expect(at(MASKED_FIRST), run.log).toBeLessThan(at(SHOWN_SECOND))
    expect(at(SHOWN_SECOND), run.log).toBeLessThan(at(LINK_NOTE))
  }, RUN_BUDGET_MS)
})

describe("a plugin's progress on the run's bus", () => {
  it("is recorded once per change for a direct test, masked, under that test's index", async () => {
    const run = await runWithProgress((project) => project.testPattern)

    expect(run.exitCode, run.log).toBe(0)
    const events = progressEvents(run.project)
    expect(events, run.log).toEqual([
      {
        remote: REMOTE_NAME,
        message: `queued, 3 ahead on pool [secret:${PLANTED_SECRET_NAME}]`,
        testIndex: 0,
        queued: 3,
      },
      { remote: REMOTE_NAME, message: SECOND, testIndex: 0, queued: 1 },
    ])
    expect(JSON.stringify(events)).not.toContain(PLANTED)
  }, RUN_BUDGET_MS)

  it("is recorded with no member for a suite's shared session, so every handle receives it", async () => {
    const run = await runWithProgress((project) => project.suitePattern)

    expect(run.exitCode, run.log).toBe(0)
    expect(progressEvents(run.project), run.log).toEqual([
      {
        remote: REMOTE_NAME,
        message: `queued, 3 ahead on pool [secret:${PLANTED_SECRET_NAME}]`,
        queued: 3,
      },
      { remote: REMOTE_NAME, message: SECOND, queued: 1 },
    ])
  }, RUN_BUDGET_MS)
})
