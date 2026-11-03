// The stub model completes each member's one step, so both members run their step on the remote.

import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { InProcessFixture } from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'

const RUN_BUDGET_MS = 180_000

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

function storedOutcomes(project: InProcessFixture): Array<{ name?: string; outcome?: string }> {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).flatMap((run) =>
      (db.readRunDetailRows(run.id)?.members ?? []).map((member) => ({
        name: member.name,
        outcome: member.outcome,
      })),
    )
  } finally {
    db.close()
  }
}

describe('a suite placed on a remote', () => {
  it('runs both of its members on one remote session', async () => {
    const page = await startTargetPageServer()
    const model = await startStubModelServer()
    const endpoint = await startRemoteBrowserEndpoint()
    try {
      const project = createInProcessFixture({
        origin: page.url,
        environment: 'local',
        stepText: POPULATED_PASSING_STEP_TEXT,
        secondSuiteMember: true,
        model: { baseUrl: model.baseUrl, id: POPULATED_MODEL_ID },
        remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
      })
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
        program.parseAsync(['--config', project.configPath, 'run', project.suitePattern], {
          from: 'user',
        }),
      ).rejects.toThrow('fixture command exit')

      const log = printed.join('\n')
      expect(exit.mock.calls[0]?.[0], log).toBe(0)
      expect(storedOutcomes(project), log).toEqual([
        { name: 'the suite member', outcome: 'passed' },
        { name: 'the second suite member', outcome: 'passed' },
      ])
      const planned = model.requests.filter((request) => request.kind === 'planner')
      expect(planned.length, log).toBeGreaterThanOrEqual(2)
      expect(endpoint.sessions(), log).toBe(1)
    } finally {
      await endpoint.close()
      await model.close()
      await page.close()
    }
  }, RUN_BUDGET_MS)
})
