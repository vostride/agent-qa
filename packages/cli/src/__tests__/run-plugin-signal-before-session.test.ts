import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'

import { refuseWithoutChromium } from '../composition/__tests__/remote-browser-endpoint.js'
import { CLI_DIST, PARKED_BUDGET_MS, startPluginRunRig, until } from './spawned-plugin-run.js'
import type { PluginRunRig, PluginRunRigInput } from './spawned-plugin-run.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

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

function storedRun(root: string): { runs: number; artifact: string; summaries: string } {
  const db = new DashboardDatabase({ dbPath: join(root, '.agent-qa', 'runs.db') })
  try {
    const runs = db.getRuns({})
    return {
      runs: runs.length,
      artifact: runs.map((run) => JSON.stringify(db.getRunArtifact(run.id)?.payload ?? {})).join(),
      summaries: runs
        .flatMap((run) => db.readRunDetailRows(run.id)?.members ?? [])
        .map((member) => member.failureSummary ?? '')
        .join('\n'),
    }
  } finally {
    db.close()
  }
}

const HELD_CALLS = [
  { call: 'acquire', place: 'web' },
  { call: 'uploadApp', place: 'device' },
] as const

// Process signals are POSIX; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')(
  'agent-qa run signalled while its plugin is still acquiring or uploading',
  () => {
    for (const door of ['test', 'suite'] as const) {
      for (const { call, place } of HELD_CALLS) {
        it(`a ${door} run signalled during ${call} exits 130 and records no refusal`, async () => {
          const input: Omit<PluginRunRigInput, 'tmpdir'> = { door, place, script: { [call]: 'hold' } }
          rig = await startPluginRunRig({ tmpdir: pinnedTmpdir!.root, ...input })
          const current = rig
          const run = current.spawnRun()
          await until(
            `the plugin to receive ${call}`,
            () => current.ledger().some((line) => line.method === call),
            PARKED_BUDGET_MS,
            run,
          )

          run.child.kill('SIGINT')
          const exited = await run.exit

          const output = run.output()
          expect({ code: exited.code, signal: exited.signal }, output).toEqual({
            code: 130,
            signal: null,
          })
          expect(output).not.toContain('stopped unexpectedly')
          expect(output).not.toContain('the plugin host has shut down')
          const stored = storedRun(current.root)
          expect(stored.runs, output).toBe(1)
          expect(stored.artifact, output).not.toContain('failureKind')
          expect(stored.artifact, output).not.toContain('remoteRefusal')
          expect(stored.summaries, output).not.toContain('stopped unexpectedly')
          expect(stored.summaries, output).not.toContain('the plugin host has shut down')
        }, CELL_BUDGET_MS)
      }
    }
  },
)
