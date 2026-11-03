// A remote that refuses before a test starts prints one sentence, and agent-qa run exits 2.

import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

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
  readonly printed: string[]
  readonly stderr: string[]
  readonly exit: MockInstance
}

// The endpoint wants a header the config never sends, so every connect is refused as auth.
async function onRefusingRemote(
  knobs: Partial<InProcessFixtureInput>,
  drive: (scene: Scene) => Promise<void>,
): Promise<void> {
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
        remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
        ...knobs,
      })
      vi.stubEnv('HOME', freshUpdateCheckHome())
      const printed: string[] = []
      const stderr: string[] = []
      const keep = (...args: unknown[]): void => { printed.push(plain(args.map(String).join(' '))) }
      vi.spyOn(console, 'log').mockImplementation(keep)
      vi.spyOn(console, 'warn').mockImplementation(keep)
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        keep(...args)
        stderr.push(...plain(args.map(String).join(' ')).split('\n'))
      })
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
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
  return scene.exit.mock.calls.at(-1)?.[0]
}

function authSentence(endpoint: RemoteBrowserEndpoint): string {
  const { port } = new URL(endpoint.wsEndpoint)
  return `Remote grid (playwright ws://127.0.0.1:${port}) refused the credentials. Check its headers, query and basicAuth in registry.remotes.`
}

function expectOneLineRefusal(scene: Scene, sentence: string): void {
  const stderr = scene.stderr.join('\n')
  expect(exitCode(scene), stderr).toBe(2)
  expect(scene.stderr.filter((line) => line.includes(sentence)), stderr).toHaveLength(1)
  expect(scene.stderr.filter((line) => /^\s+at /.test(line)), stderr).toEqual([])
  expect(scene.printed.filter((line) => line.includes('Framework error:')), stderr).toEqual([])
}

describe('a remote refused before a test starts', () => {
  it('prints its sentence once on stderr with no stack and no prefix, and exits 2', async () => {
    await onRefusingRemote({}, async (scene) => {
      await runThroughCli(scene, scene.project.testPattern)

      expectOneLineRefusal(scene, authSentence(scene.endpoint))
      expect(scene.endpoint.sessions(), scene.stderr.join('\n')).toBe(0)
    })
  }, RUN_BUDGET_MS)
})
