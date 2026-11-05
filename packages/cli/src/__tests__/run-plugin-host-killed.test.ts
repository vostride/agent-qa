import { existsSync } from 'node:fs'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { refuseWithoutChromium } from '../composition/__tests__/remote-browser-endpoint.js'
import { CLI_DIST, isAlive, parked, startPluginRunRig, until } from './spawned-plugin-run.js'
import type { PluginRunRig } from './spawned-plugin-run.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

const RELEASE_BUDGET_MS = 10_000
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

// SIGKILL and a process's pid going away are POSIX; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')('agent-qa run killed with SIGKILL mid-test', () => {
  it('still has its plugin release the session it held, and the plugin exits', async () => {
    rig = await startPluginRunRig({ tmpdir: pinnedTmpdir!.root })
    const run = rig.spawnRun()
    await parked(rig, run)
    const acquired = rig.ledger().find((line) => line.method === 'acquire')
    const pid = rig.pluginPid()
    expect(pid, run.output()).toBeTypeOf('number')

    const killedAt = Date.now()
    run.child.kill('SIGKILL')
    const exited = await run.exit
    expect(exited.signal).toBe('SIGKILL')

    const current = rig
    await until(
      'the plugin to release its session and exit',
      () => current.ledger().some((line) => line.method === 'release') && !isAlive(pid!),
      RELEASE_BUDGET_MS,
    )
    expect(Date.now() - killedAt).toBeLessThan(RELEASE_BUDGET_MS)
    expect(rig.ledger().map((line) => line.method)).toEqual([
      'initialize',
      'acquire',
      'release',
      'shutdown',
    ])
    expect(rig.ledger().find((line) => line.method === 'release')?.handle).toEqual(
      acquired?.handle,
    )
  }, CELL_BUDGET_MS)
})
