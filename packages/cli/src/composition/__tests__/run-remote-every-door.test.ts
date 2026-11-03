// `fetch` is refused, so the model never reaches the target: every hit the target counts came from
// the remote browser. A member on a remote gets no baseline probe from this machine at all.

import { Command } from 'commander'
import { chromium } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createRunCommand } from '../../commands/run.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import {
  CountingTarget,
  createInProcessFixture,
  freshUpdateCheckHome,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { refuseWithoutChromium, startRemoteBrowserEndpoint } from './remote-browser-endpoint.js'

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

describe('a web test placed on a remote runs there from every door', () => {
  it('agent-qa run connects a direct test to the Playwright server its config names', async () => {
    refuseWithoutChromium()
    const target = new CountingTarget()
    await target.listen()
    try {
      const endpoint = await startRemoteBrowserEndpoint()
      try {
        const fixture = createInProcessFixture({
          origin: target.origin,
          environment: 'local',
          remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
        })
        vi.stubEnv('HOME', freshUpdateCheckHome())
        const printed: string[] = []
        const keep = (...args: unknown[]): void => { printed.push(plain(args.map(String).join(' '))) }
        vi.spyOn(console, 'log').mockImplementation(keep)
        vi.spyOn(console, 'warn').mockImplementation(keep)
        vi.spyOn(console, 'error').mockImplementation(keep)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
        const fetched = vi.spyOn(globalThis, 'fetch')
          .mockRejectedValue(new Error('only the remote browser reaches the target'))
        const launch = vi.spyOn(chromium, 'launch')

        const program = new Command().option('--config <path>').addCommand(createRunCommand())
        await expect(
          program.parseAsync(['--config', fixture.configPath, 'run', fixture.testPattern], { from: 'user' }),
        ).rejects.toThrow('fixture command exit')

        expect(endpoint.sessions(), printed.join('\n')).toBe(1)
        expect(target.hits.length, printed.join('\n')).toBeGreaterThan(0)
        expect(launch).not.toHaveBeenCalled()
        const probes = fetched.mock.calls.filter(([url]) => String(url).startsWith(target.origin))
        expect(probes, printed.join('\n')).toEqual([])
      } finally {
        await endpoint.close()
      }
    } finally {
      await target.close()
    }
  }, RUN_BUDGET_MS)

  it("agent-qa run runs a suite's members on its remote through one session", async () => {
    refuseWithoutChromium()
    const target = new CountingTarget()
    await target.listen()
    try {
      const endpoint = await startRemoteBrowserEndpoint()
      try {
        const fixture = createInProcessFixture({
          origin: target.origin,
          environment: 'local',
          remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
          secondSuiteMember: true,
        })
        vi.stubEnv('HOME', freshUpdateCheckHome())
        const printed: string[] = []
        const keep = (...args: unknown[]): void => { printed.push(plain(args.map(String).join(' '))) }
        vi.spyOn(console, 'log').mockImplementation(keep)
        vi.spyOn(console, 'warn').mockImplementation(keep)
        vi.spyOn(console, 'error').mockImplementation(keep)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
        const fetched = vi.spyOn(globalThis, 'fetch')
          .mockRejectedValue(new Error('only the remote browser reaches the target'))
        const launch = vi.spyOn(chromium, 'launch')

        const program = new Command().option('--config <path>').addCommand(createRunCommand())
        await expect(
          program.parseAsync(['--config', fixture.configPath, 'run', fixture.suitePattern], { from: 'user' }),
        ).rejects.toThrow('fixture command exit')

        expect(endpoint.sessions(), printed.join('\n')).toBe(1)
        expect(target.hits.length, printed.join('\n')).toBeGreaterThan(0)
        expect(launch).not.toHaveBeenCalled()
        const probes = fetched.mock.calls.filter(([url]) => String(url).startsWith(target.origin))
        expect(probes, printed.join('\n')).toEqual([])
      } finally {
        await endpoint.close()
      }
    } finally {
      await target.close()
    }
  }, RUN_BUDGET_MS)

  it('agent-qa run refuses a test whose remote pick is unknown before it starts', async () => {
    refuseWithoutChromium()
    const target = new CountingTarget()
    await target.listen()
    try {
      const endpoint = await startRemoteBrowserEndpoint()
      try {
        const fixture = createInProcessFixture({
          origin: target.origin,
          environment: 'local',
          remote: { name: 'grid', protocol: 'playwright', url: endpoint.wsEndpoint },
          directTestPick: 'nope',
        })
        vi.stubEnv('HOME', freshUpdateCheckHome())
        const stderr: string[] = []
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
          stderr.push(...plain(args.map(String).join(' ')).split('\n'))
        })
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('fixture command exit')
        })

        const program = new Command().option('--config <path>').addCommand(createRunCommand())
        await expect(
          program.parseAsync(['--config', fixture.configPath, 'run', fixture.testPattern], { from: 'user' }),
        ).rejects.toThrow('fixture command exit')

        expect(exit).toHaveBeenCalledWith(2)
        const refusal =
          'Unknown remote "nope" in tests/direct.yaml. registry.remotes lists: grid.'
        expect(stderr.filter((line) => line.includes(refusal)), stderr.join('\n')).toHaveLength(1)
        expect(stderr.filter((line) => /^\s+at /.test(line)), stderr.join('\n')).toEqual([])
        expect(endpoint.sessions(), stderr.join('\n')).toBe(0)
      } finally {
        await endpoint.close()
      }
    } finally {
      await target.close()
    }
  }, RUN_BUDGET_MS)
})
