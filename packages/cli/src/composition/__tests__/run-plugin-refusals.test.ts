// A remote whose plugin is not installed is refused before its test starts, in one line with the
// install line, while a test that runs here still runs.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand, failedToStartResult } from '../../commands/run.js'
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
import { refuseWithoutChromium } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000
const REMOTE_NAME = 'farm'
const ENTRY_NAME = 'kit'
const UNINSTALLED_PLUGIN = '@vostride/agent-qa-plugin-scripted'

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

function placeOnUninstalledPlugin(project: InProcessFixture): void {
  const config = parseYaml(readFileSync(project.configPath, 'utf8')) as {
    registry: { remotes?: unknown }
    plugins?: unknown
  }
  config.registry.remotes = [{ name: REMOTE_NAME, plugin: ENTRY_NAME }]
  config.plugins = [{ name: ENTRY_NAME, package: UNINSTALLED_PLUGIN }]
  writeFileSync(project.configPath, stringifyYaml(config))
}

function storedMembers(
  project: InProcessFixture,
): Record<string, { outcome: unknown; failureSummary: unknown }> {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    const runs = db.getRuns({})
    expect(runs).toHaveLength(1)
    const members = db.readRunDetailRows(runs[0]!.id)?.members ?? []
    return Object.fromEntries(
      members.map((member) => [
        member.name,
        { outcome: member.outcome, failureSummary: member.failureSummary },
      ]),
    )
  } finally {
    db.close()
  }
}

function storedRootCauses(project: InProcessFixture): Record<string, unknown> {
  const runsDir = join(project.agentQaRoot, 'runs')
  const [runDir] = readdirSync(runsDir)
  const handoff = JSON.parse(readFileSync(join(runsDir, runDir!, 'handoff.json'), 'utf8')) as {
    tests: { testName: string; rootCause?: unknown }[]
  }
  return Object.fromEntries(handoff.tests.map((test) => [test.testName, test.rootCause]))
}

describe('a remote whose plugin cannot serve the run', () => {
  it('refuses only that remote, in one line with the install line, and exits 2', async () => {
    const page = await startTargetPageServer()
    const model = await startStubModelServer()
    try {
      const project = createInProcessFixture({
        origin: page.url,
        environment: 'local',
        stepText: POPULATED_PASSING_STEP_TEXT,
        model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
        remote: { name: REMOTE_NAME, protocol: 'playwright', url: 'ws://127.0.0.1:9' },
        remoteUnpicked: true,
        directTestPick: REMOTE_NAME,
        secondTarget: true,
      })
      placeOnUninstalledPlugin(project)
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
        program.parseAsync(
          [
            '--config',
            project.configPath,
            'run',
            project.testPattern,
            project.secondTestPattern!,
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('fixture command exit')

      const log = printed.join('\n')
      expect(exit.mock.calls[0]?.[0], log).toBe(2)
      const install = `npm install --save-dev --save-exact ${UNINSTALLED_PLUGIN}@${getAgentQaVersion()}`
      const refusalLines = log
        .split('\n')
        .filter((line) => line.includes(`Remote ${REMOTE_NAME} cannot start`))
      expect(refusalLines.length, log).toBeGreaterThan(0)
      expect(refusalLines.every((line) => line.includes(install)), log).toBe(true)
      expect(log).not.toMatch(/^\s+at /m)
      expect(log).not.toContain('Framework error')
      const members = storedMembers(project)
      expect(members['the standalone test']?.outcome, log).toBe('failed')
      expect(members['the standalone test']?.failureSummary, log).toContain(
        `Remote ${REMOTE_NAME} cannot start: Plugin entry ${ENTRY_NAME} names ${UNINSTALLED_PLUGIN}`,
      )
      expect(members["the second target's test"]?.outcome, log).toBe('passed')
      const rootCauses = storedRootCauses(project)
      expect(rootCauses['the standalone test'], log).toMatchObject({
        class: 'environment',
        producer: 'deterministic-classifier',
        evidence: {
          rationale: expect.stringMatching(
            new RegExp(`^remote refused: Remote ${REMOTE_NAME} cannot start: `),
          ),
        },
      })
      expect(rootCauses["the second target's test"], log).toBeUndefined()
    } finally {
      await model.close()
      await page.close()
    }
  }, RUN_BUDGET_MS)
})

describe('a direct member that could not start', () => {
  const member = { testId: 'the-test', name: 'a test', filePath: 'tests/a.yaml' }

  it('records a remote refusal as one', () => {
    const refusal = Object.assign(new Error('Remote farm cannot start: it is gone.'), {
      name: 'RemoteRefusalError',
    })

    expect(failedToStartResult(member, refusal)).toEqual({
      runId: 'the-test',
      name: 'a test',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [],
      duration: 0,
      failureSummary: 'Remote farm cannot start: it is gone.',
      remoteRefusal: true,
    })
  })

  it('records any other error as a framework error, not a remote refusal', () => {
    const result = failedToStartResult(member, new Error('the adapter broke'))

    expect(result.failureSummary).toBe('Framework error: the adapter broke')
    expect(result).not.toHaveProperty('remoteRefusal')
  })
})
