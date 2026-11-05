import { existsSync } from 'node:fs'

import { PLUGIN_RELEASE_BOUND_MS } from '@vostride/agent-qa-runner'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { refuseWithoutChromium } from '../composition/__tests__/remote-browser-endpoint.js'
import {
  CLI_DIST,
  isAlive,
  parked,
  processGroupOf,
  startPluginRunRig,
  until,
} from './spawned-plugin-run.js'
import type { PluginRunRig, PluginRunRigInput } from './spawned-plugin-run.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

// The URL-remote cells' grace: a run with only quick releases is gone by then.
const CANCEL_GRACE_MS = 3_000
const SLOW_RELEASE_MS = 4_000
const PLUGIN_GONE_MS = 5_000
const CELL_BUDGET_MS = 180_000

let pinnedTmpdir: PinnedTmpdir | undefined
let rig: PluginRunRig | undefined

beforeAll(() => {
  refuseWithoutChromium()
  if (!existsSync(CLI_DIST)) throw new Error(`No built CLI at ${CLI_DIST}; run pnpm build`)
  pinnedTmpdir = pinProcessTmpdir()
})

afterEach(async () => {
  await rig?.close()
  rig = undefined
})

afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

async function startRig(input: Omit<PluginRunRigInput, 'tmpdir'> = {}): Promise<PluginRunRig> {
  rig = await startPluginRunRig({ tmpdir: pinnedTmpdir!.root, ...input })
  return rig
}

// Process groups and their signals are POSIX; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')('agent-qa run on a plugin remote, signalled', () => {
  it("a terminal's Ctrl-C reaches agent-qa and not the plugin, and the run releases, shuts the plugin down and exits 130", async () => {
    const current = await startRig()
    const run = current.spawnRun({ detached: true })
    await parked(current, run)
    const runPid = run.child.pid!
    const pluginPid = current.pluginPid()!
    expect(processGroupOf(runPid)).toBe(runPid)
    expect(processGroupOf(pluginPid)).toBe(pluginPid)

    const signalledAt = Date.now()
    process.kill(-runPid, 'SIGINT')
    const exited = await run.exit

    expect({ code: exited.code, signal: exited.signal }, run.output()).toEqual({
      code: 130,
      signal: null,
    })
    expect(exited.at - signalledAt, run.output()).toBeLessThan(CANCEL_GRACE_MS)
    await until('the plugin to exit', () => !isAlive(pluginPid), PLUGIN_GONE_MS)
    expect(current.ledger().map((line) => line.method), run.output()).toEqual([
      'initialize',
      'acquire',
      'release',
      'shutdown',
    ])
  }, CELL_BUDGET_MS)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`on ${signal}, a plugin that takes four seconds to release gets them before its shutdown, and the run exits 130`, async () => {
      const current = await startRig({ script: { release: { delayMs: SLOW_RELEASE_MS } } })
      const run = current.spawnRun()
      await parked(current, run)
      const pluginPid = current.pluginPid()!

      const signalledAt = Date.now()
      run.child.kill(signal)
      const exited = await run.exit

      expect({ code: exited.code, signal: exited.signal }, run.output()).toEqual({
        code: 130,
        signal: null,
      })
      expect(exited.at - signalledAt, run.output()).toBeGreaterThanOrEqual(SLOW_RELEASE_MS)
      expect(exited.at - signalledAt, run.output()).toBeLessThan(
        PLUGIN_RELEASE_BOUND_MS + CANCEL_GRACE_MS,
      )
      await until('the plugin to exit', () => !isAlive(pluginPid), PLUGIN_GONE_MS)
      expect(current.ledger().map((line) => line.method), run.output()).toEqual([
        'initialize',
        'acquire',
        'release',
        'shutdown',
      ])
    }, CELL_BUDGET_MS)
  }
})
