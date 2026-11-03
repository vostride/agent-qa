// `fetch` is refused, so neither the baseline probe nor the model reaches the target: every hit
// the target counts came from the remote browser.

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
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('only the remote browser reaches the target'))
        const launch = vi.spyOn(chromium, 'launch')

        const program = new Command().option('--config <path>').addCommand(createRunCommand())
        await expect(
          program.parseAsync(['--config', fixture.configPath, 'run', fixture.testPattern], { from: 'user' }),
        ).rejects.toThrow('fixture command exit')

        expect(endpoint.sessions(), printed.join('\n')).toBe(1)
        expect(target.hits.length, printed.join('\n')).toBeGreaterThan(0)
        expect(launch).not.toHaveBeenCalled()
      } finally {
        await endpoint.close()
      }
    } finally {
      await target.close()
    }
  }, RUN_BUDGET_MS)
})
