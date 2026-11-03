// The config is parsed for real; only the adapter's setup is stopped, after it records what it got.

import { WebPlatformAdapter } from '@vostride/agent-qa-web'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createRunCommand } from '../commands/run.js'
import {
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import type { InProcessFixture } from '../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

type SetupConfig = Parameters<WebPlatformAdapter['setup']>[0]

const RUN_BUDGET_MS = 120_000

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  removeInProcessFixtures()
})
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface DoorRun {
  readonly lines: readonly string[]
  readonly setups: readonly SetupConfig[]
  readonly exitCodes: readonly unknown[]
}

async function runDoor(fixture: InProcessFixture, args: readonly string[]): Promise<DoorRun> {
  vi.stubEnv('HOME', freshUpdateCheckHome())
  const lines: string[] = []
  const keep = (...parts: unknown[]): void => {
    lines.push(...plain(parts.map(String).join(' ')).split('\n'))
  }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('fixture command exit')
  })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this cell'))
  const setups: SetupConfig[] = []
  vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockImplementation(async (config) => {
    setups.push(structuredClone(config))
    throw new Error('setup stops here')
  })

  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(
    program.parseAsync(['--config', fixture.configPath, 'run', ...args], { from: 'user' }),
  ).rejects.toThrow('fixture command exit')
  return { lines, setups, exitCodes: exit.mock.calls.map((call) => call[0]) }
}

describe('run --browser', () => {
  it("gives a direct test's adapter the flag's engine through the real config parse", async () => {
    const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })

    const run = await runDoor(fixture, ['--browser', 'firefox', fixture.testPattern])

    const output = run.lines.join('\n')
    expect(run.setups.map((config) => config.browser?.name), output).toEqual(['firefox'])
    expect(run.lines.filter((line) => /unrecognized key/i.test(line)), output).toEqual([])
  }, RUN_BUDGET_MS)

  it("gives a suite's adapter the flag's engine through the real config parse", async () => {
    const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })

    const run = await runDoor(fixture, ['--browser', 'firefox', fixture.suitePattern])

    const output = run.lines.join('\n')
    expect(run.setups.map((config) => config.browser?.name), output).toEqual(['firefox'])
    expect(run.lines.filter((line) => /unrecognized key/i.test(line)), output).toEqual([])
  }, RUN_BUDGET_MS)

  it('refuses firefox on a cdp remote before any test or suite member starts', async () => {
    for (const pick of ['test', 'suite'] as const) {
      const fixture = createInProcessFixture({
        origin: 'http://127.0.0.1:1',
        environment: 'local',
        remote: { name: 'grid', protocol: 'cdp', url: 'ws://127.0.0.1:1/chromium' },
      })
      const pattern = pick === 'test' ? fixture.testPattern : fixture.suitePattern

      const run = await runDoor(fixture, ['--browser', 'firefox', pattern])

      const output = `${pick}\n${run.lines.join('\n')}`
      expect(run.exitCodes, output).toEqual([2])
      const refusal = 'Remote grid serves Chromium only; this test asks for firefox.'
      expect(run.lines.filter((line) => line.trim().length > 0), output).toEqual([refusal])
      expect(run.setups, output).toEqual([])
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    }
  }, RUN_BUDGET_MS)

  it('refuses an engine it does not know', async () => {
    const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
    const program = new Command()
      .exitOverride()
      .option('--config <path>')
      .addCommand(createRunCommand().exitOverride().configureOutput({ writeErr: () => undefined }))

    const args = ['--config', fixture.configPath, 'run', '--browser', 'opera', fixture.testPattern]
    await expect(program.parseAsync(args, { from: 'user' })).rejects.toThrow(
      /argument 'opera' is invalid/,
    )
  })
})
