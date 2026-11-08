import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as VersionRefreshSpawnModule from '../version-refresh-spawn.js'
import { CLI_ENTRY, REBUILD_INSTRUCTION, buildFreshness } from './conformance/spawned-chat.js'

interface SpawnCall {
  command: string
  args: string[]
  options: Record<string, unknown>
  unrefs: number
  errorListeners: number
}

const spawns = vi.hoisted(() => [] as SpawnCall[])

// No child starts: the stand-in records how the refresh child would be started.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      const call: SpawnCall = { command, args, options, unrefs: 0, errorListeners: 0 }
      spawns.push(call)
      const child = new EventEmitter()
      return Object.assign(child, {
        unref: () => {
          call.unrefs += 1
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === 'error') call.errorListeners += 1
          return EventEmitter.prototype.on.call(child, event, listener)
        },
      })
    },
  }
})

// The setup guard replaces this module's default spawn, so the real one is loaded past it.
async function realModule(): Promise<typeof VersionRefreshSpawnModule> {
  return await vi.importActual<typeof VersionRefreshSpawnModule>('../version-refresh-spawn.js')
}

afterEach(() => {
  spawns.length = 0
})

describe('the registry refresh child', () => {
  it("runs the refresh entry with this node, detached, silent, hidden and unref'd", async () => {
    const real = await realModule()

    real.spawnVersionRefresh('/home/someone')

    expect(spawns).toEqual([
      {
        command: process.execPath,
        args: [real.versionRefreshEntryPath(), '/home/someone'],
        options: { detached: true, stdio: 'ignore', windowsHide: true },
        unrefs: 1,
        errorListeners: 1,
      },
    ])
  })

  it('finds the refresh entry beside the module that starts it', async () => {
    const real = await realModule()

    const source = fileURLToPath(new URL('../version-refresh-spawn.ts', import.meta.url))

    expect(real.versionRefreshEntryPath()).toBe(join(dirname(source), 'version-refresh.js'))
  })

  it('the built CLI ships the refresh entry beside its bundle', () => {
    const freshness = buildFreshness()
    expect(
      { missing: freshness.missing, stale: freshness.stale },
      `this cell reads the built CLI: ${REBUILD_INSTRUCTION}`,
    ).toEqual({ missing: [], stale: [] })

    expect(existsSync(join(dirname(CLI_ENTRY), 'version-refresh.js'))).toBe(true)
  })
})
