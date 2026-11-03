// The endpoint closes while the remote browser's first request to the target is in flight.

import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  CountingTarget,
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

interface StoredMember {
  readonly name: string | undefined
  readonly outcome: string | undefined
  readonly failureSummary: string | undefined
}

function storedMembers(project: InProcessFixture): StoredMember[] {
  const db = new DashboardDatabase({ dbPath: join(project.agentQaRoot, 'runs.db') })
  try {
    return db.getRuns({}).flatMap((run) =>
      (db.readRunDetailRows(run.id)?.members ?? []).map((member) => ({
        name: member.name,
        outcome: member.outcome,
        failureSummary: member.failureSummary,
      })),
    )
  } finally {
    db.close()
  }
}

describe('a remote session that drops during a test', () => {
  it("agent-qa run ends a test whose remote session drops with the remote's lost sentence", async () => {
    let dropped: Promise<void> | undefined
    let drop: () => Promise<void> = async () => undefined
    const target = new CountingTarget(() => {
      dropped ??= drop()
    })
    await target.listen()
    const endpoint = await startRemoteBrowserEndpoint()
    drop = () => endpoint.close()
    try {
      const project = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
      })
      vi.stubEnv('HOME', freshUpdateCheckHome())
      const printed: string[] = []
      const stderr: string[] = []
      let exited = false
      const keep = (...args: unknown[]): void => {
        if (!exited) printed.push(plain(args.map(String).join(' ')))
      }
      vi.spyOn(console, 'log').mockImplementation(keep)
      vi.spyOn(console, 'warn').mockImplementation(keep)
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (exited) return
        keep(...args)
        stderr.push(...plain(args.map(String).join(' ')).split('\n'))
      })
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

      const log = printed.join('\n')
      const { port } = new URL(endpoint.wsEndpoint)
      const lost = `The connection to remote grid (playwright ws://127.0.0.1:${port}) was lost while this test ran.`
      expect(exit.mock.calls[0]?.[0], log).toBe(1)
      expect(dropped, log).toBeDefined()
      expect(endpoint.sessions(), log).toBe(1)
      const members = storedMembers(project)
      expect(members, log).toEqual([
        { name: 'the standalone test', outcome: 'failed', failureSummary: lost },
      ])
      expect(members[0]?.failureSummary).not.toBe('The browser closed before this test finished.')
      expect(stderr.filter((line) => /^\s+at /.test(line)), stderr.join('\n')).toEqual([])
    } finally {
      await dropped
      await endpoint.close()
      await target.close()
    }
  }, RUN_BUDGET_MS)
})
