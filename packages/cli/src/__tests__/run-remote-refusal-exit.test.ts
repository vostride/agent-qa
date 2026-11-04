// A remote that refuses before a test starts prints one sentence, and agent-qa run exits 2.

import { join } from 'node:path'

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'

import { createRunCommand } from '../commands/run.js'
import {
  CountingTarget,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import type {
  InProcessFixture,
  InProcessFixtureInput,
} from '../composition/__tests__/in-process-run-fixture.js'
import {
  refuseWithoutChromium,
  startRemoteBrowserEndpoint,
} from '../composition/__tests__/remote-browser-endpoint.js'
import type { RemoteBrowserEndpoint } from '../composition/__tests__/remote-browser-endpoint.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

const RUN_BUDGET_MS = 180_000

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
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

interface Scene {
  readonly project: InProcessFixture
  readonly endpoint: RemoteBrowserEndpoint
  readonly target: CountingTarget
  // What the command printed up to its first exit; the mocked exit throws into the door's catch.
  readonly printed: string[]
  readonly stderr: string[]
  readonly exit: MockInstance
}

interface SceneInput {
  // Without it, the config names no remote and every test launches here.
  readonly remote?: false
  readonly knobs?: Partial<InProcessFixtureInput>
}

// The endpoint wants a header the config never sends, so every connect is refused as auth.
async function onScene(input: SceneInput, drive: (scene: Scene) => Promise<void>): Promise<void> {
  refuseWithoutChromium()
  const target = new CountingTarget()
  await target.listen()
  try {
    const endpoint = await startRemoteBrowserEndpoint({
      requireHeader: ['authorization', 'Bearer never-sent'],
    })
    try {
      const project = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        ...(input.remote === false
          ? {}
          : { remote: { name: 'grid', protocol: 'playwright' as const, url: endpoint.wsEndpoint } }),
        ...input.knobs,
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
      await drive({ project, endpoint, target, printed, stderr, exit })
    } finally {
      await endpoint.close()
    }
  } finally {
    await target.close()
  }
}

async function runThroughCli(scene: Scene, ...patterns: string[]): Promise<void> {
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', scene.project.configPath, 'run', ...patterns], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
}

function exitCode(scene: Scene): unknown {
  return scene.exit.mock.calls[0]?.[0]
}

function authSentence(endpoint: RemoteBrowserEndpoint): string {
  const { port } = new URL(endpoint.wsEndpoint)
  return `Remote grid (playwright ws://127.0.0.1:${port}) refused the credentials. Check its headers, query and basicAuth in registry.remotes.`
}

function expectNoStack(scene: Scene): void {
  expect(scene.stderr.filter((line) => /^\s+at /.test(line)), scene.stderr.join('\n')).toEqual([])
}

function expectOneLineRefusal(scene: Scene, sentence: string): void {
  const stderr = scene.stderr.join('\n')
  expect(exitCode(scene), stderr).toBe(2)
  expect(scene.stderr.filter((line) => line.includes(sentence)), stderr).toHaveLength(1)
  expectNoStack(scene)
  expect(scene.printed.filter((line) => line.includes('Framework error:')), stderr).toEqual([])
}

interface StoredMember {
  readonly name: string | undefined
  readonly outcome: string | undefined
  readonly failureSummary: string | undefined
}

// Every member of every run the command recorded, as the dashboard reads them back.
function storedMembers(scene: Scene): StoredMember[] {
  const db = new DashboardDatabase({ dbPath: join(scene.project.agentQaRoot, 'runs.db') })
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

function storedMember(scene: Scene, name: string): StoredMember {
  const members = storedMembers(scene)
  const found = members.find((member) => member.name === name)
  expect(found, JSON.stringify(members)).toBeDefined()
  return found as StoredMember
}

describe('a remote refused before a test starts', () => {
  it('prints its sentence once on stderr with no stack and no prefix, and exits 2', async () => {
    await onScene({}, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern)

      expectOneLineRefusal(scene, authSentence(scene.endpoint))
      expect(scene.endpoint.sessions(), scene.stderr.join('\n')).toBe(0)
    })
  }, RUN_BUDGET_MS)

  it('is connected to once for two tests on that remote, and both carry its sentence', async () => {
    await onScene({ knobs: { secondTarget: true } }, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern, scene.project.secondTestPattern!)

      const sentence = authSentence(scene.endpoint)
      expectOneLineRefusal(scene, sentence)
      const log = scene.printed.join('\n')
      expect(scene.endpoint.refusals(), log).toBe(1)
      expect(scene.endpoint.sessions(), log).toBe(0)
      for (const name of ['the standalone test', "the second target's test"]) {
        expect(storedMember(scene, name), name).toMatchObject({
          outcome: 'failed',
          failureSummary: sentence,
        })
      }
    })
  }, RUN_BUDGET_MS)

  it('leaves a test that launches here running, and still exits 2', async () => {
    await onScene({ knobs: { secondTarget: true, secondTestPick: 'local' } }, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern, scene.project.secondTestPattern!)

      const sentence = authSentence(scene.endpoint)
      expectOneLineRefusal(scene, sentence)
      const log = scene.printed.join('\n')
      expect(scene.endpoint.refusals(), log).toBe(1)
      expect(scene.target.hits.filter((hit) => hit.startsWith('/the-second-thing')), log)
        .not.toEqual([])
      expect(scene.target.hits.filter((hit) => hit.startsWith('/in-process-thing')), log)
        .toEqual([])
      expect(storedMember(scene, 'the standalone test').failureSummary, log).toBe(sentence)
      // The fixture's model is unreachable, so a test that ran its step fails at planning.
      expect(storedMember(scene, "the second target's test"), log).toMatchObject({
        outcome: 'failed',
        failureSummary: expect.stringContaining('LLM planning failed'),
      })
    })
  }, RUN_BUDGET_MS)

  it('still skips and names the later tests when a test fails to start for another reason', async () => {
    await onScene({ remote: false, knobs: { secondTarget: true } }, async (scene) => {
      vi.spyOn(WebPlatformAdapter.prototype, 'setup')
        .mockRejectedValueOnce(new Error('fixture launch failure'))
      await runThroughCli(scene, scene.project.testPattern, scene.project.secondTestPattern!)

      const stderr = scene.stderr.join('\n')
      expect(exitCode(scene), stderr).toBe(2)
      expect(scene.stderr.filter((line) => line.includes('Framework error: fixture launch failure')), stderr)
        .toHaveLength(1)
      const members = storedMembers(scene)
      const failed = members.find((member) => member.outcome === 'failed')
      expect(failed?.failureSummary, JSON.stringify(members)).toBe('Framework error: fixture launch failure')
      const skipped = members.filter((member) => member.outcome === 'skipped')
      expect(skipped.map((member) => member.failureSummary), JSON.stringify(members)).toEqual([
        `Not run: "${String(failed?.name)}" could not start. Framework error: fixture launch failure`,
      ])
    })
  }, RUN_BUDGET_MS)
})

describe('a suite refused on its remote ends only its members while a local test runs', () => {
  it('runs the local tests, ends the suite member with the sentence and exits 2', async () => {
    await onScene({ knobs: { remoteUnpicked: true, suitePick: 'grid' } }, async (scene) => {
      await runThroughCli(scene, '--all')

      const sentence = authSentence(scene.endpoint)
      const stderr = scene.stderr.join('\n')
      const log = scene.printed.join('\n')
      expect(exitCode(scene), log).toBe(2)
      expect(scene.stderr.filter((line) => line.includes(sentence)), stderr).toHaveLength(1)
      expectNoStack(scene)
      expect(scene.endpoint.refusals(), log).toBe(1)
      expect(scene.endpoint.sessions(), log).toBe(0)
      const members = storedMembers(scene)
      const suiteMember = members.filter((member) => member.name === 'the suite member')
      expect(suiteMember.map((member) => member.failureSummary), JSON.stringify(members))
        .toContain(sentence)
      // The fixture's model is unreachable, so a test that ran its step fails at planning.
      expect(storedMember(scene, 'the standalone test'), log).toMatchObject({
        outcome: 'failed',
        failureSummary: expect.stringContaining('LLM planning failed'),
      })
    })
  }, RUN_BUDGET_MS)

  it("connects once across one command's suite and its tests on that remote", async () => {
    await onScene({ knobs: { secondTarget: true, secondTestPick: 'local' } }, async (scene) => {
      await runThroughCli(scene, '--all')

      const sentence = authSentence(scene.endpoint)
      const log = scene.printed.join('\n')
      expect(exitCode(scene), log).toBe(2)
      expect(scene.stderr.filter((line) => line.includes(sentence)), log).not.toEqual([])
      expectNoStack(scene)
      expect(scene.endpoint.refusals(), log).toBe(1)
      expect(scene.endpoint.sessions(), log).toBe(0)
      expect(scene.target.hits.filter((hit) => hit.startsWith('/the-second-thing')), log)
        .not.toEqual([])
      expect(scene.target.hits.filter((hit) => hit.startsWith('/in-process-thing')), log)
        .toEqual([])
      const members = storedMembers(scene)
      for (const name of ['the suite member', 'the standalone test']) {
        const named = members.filter((member) => member.name === name)
        expect(named.length, JSON.stringify(members)).toBeGreaterThan(0)
        expect(named.map((member) => member.failureSummary), JSON.stringify(members))
          .toEqual(named.map(() => sentence))
      }
    })
  }, RUN_BUDGET_MS)

  it('exits 2 with the sentence when the run is the suite alone', async () => {
    await onScene({}, async (scene) => {
      await runThroughCli(scene, scene.project.suitePattern)

      expectOneLineRefusal(scene, authSentence(scene.endpoint))
      expect(scene.endpoint.refusals(), scene.printed.join('\n')).toBe(1)
      expect(scene.target.hits, scene.printed.join('\n')).toEqual([])
      expect(storedMember(scene, 'the suite member'), scene.printed.join('\n')).toMatchObject({
        outcome: 'failed',
        failureSummary: authSentence(scene.endpoint),
      })
    })
  }, RUN_BUDGET_MS)

  it('ends every member of the refused suite with its sentence, from one connect', async () => {
    await onScene({ knobs: { secondSuiteMember: true } }, async (scene) => {
      await runThroughCli(scene, scene.project.suitePattern)

      const sentence = authSentence(scene.endpoint)
      const log = scene.printed.join('\n')
      expectOneLineRefusal(scene, sentence)
      expect(scene.endpoint.refusals(), log).toBe(1)
      expect(scene.target.hits, log).toEqual([])
      for (const name of ['the suite member', 'the second suite member']) {
        expect(storedMember(scene, name), name).toMatchObject({
          outcome: 'failed',
          failureSummary: sentence,
        })
      }
    })
  }, RUN_BUDGET_MS)
})
