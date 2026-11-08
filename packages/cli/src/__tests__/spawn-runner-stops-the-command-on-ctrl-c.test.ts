import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { wasCancelled } from '../commands/package-manager.js'
import { spawnRunner } from '../commands/project-host.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'

// Exits 0 on its own after 10 s, so only a Ctrl-C ends it sooner and with another result.
const WAITS = 'setTimeout(() => process.exit(0), 10_000)'

// Handles its own Ctrl-C and exits 130 before agent-qa's listener hears anything.
const OWN_CTRL_C = [
  "process.on('SIGINT', () => process.exit(130))",
  WAITS,
  "if (process.platform === 'win32') process.emit('SIGINT')",
  "else process.kill(process.pid, 'SIGINT')",
].join('\n')

function sigintListeners(): ((signal: NodeJS.Signals) => void)[] {
  return process.listeners('SIGINT') as ((signal: NodeJS.Signals) => void)[]
}

afterEach(() => {
  cleanupTempProjects()
})

describe('spawnRunner and Ctrl-C', () => {
  it('a Ctrl-C stops the command, reports the run cancelled and removes its listener', async () => {
    const { root } = tempProject('spawn-runner-ctrl-c')
    const before = sigintListeners()

    const started = Date.now()
    const run = spawnRunner(process.execPath, ['-e', WAITS], {
      cwd: root,
      env: process.env,
      stdio: 'capture',
    })
    const added = sigintListeners().filter((listener) => !before.includes(listener))
    expect(added).toHaveLength(1)
    added[0]!('SIGINT')
    const result = await run

    expect(result.cancelled).toBe(true)
    expect(wasCancelled(result)).toBe(true)
    expect(result.code).not.toBe(0)
    if (process.platform !== 'win32') expect(result.signal).toBe('SIGINT')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(sigintListeners()).toEqual(before)
  }, 20_000)

  it('a command that exits 130 from its own Ctrl-C handler reads as cancelled', async () => {
    const { root } = tempProject('spawn-runner-own-ctrl-c')
    const before = sigintListeners()

    const started = Date.now()
    const result = await spawnRunner(process.execPath, ['-e', OWN_CTRL_C], {
      cwd: root,
      env: process.env,
      stdio: 'capture',
    })

    expect(result).toMatchObject({ code: 130, signal: null })
    expect(result.cancelled).toBeUndefined()
    expect(wasCancelled(result)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(sigintListeners()).toEqual(before)
  }, 20_000)

  it('exit 130 is a cancel and any other exit is not', () => {
    expect(wasCancelled({ code: 130, signal: null, output: '' })).toBe(true)
    expect(wasCancelled({ code: 1, signal: null, output: '' })).toBe(false)
    expect(wasCancelled({ code: 0, signal: null, output: '' })).toBe(false)
  })

  it('a command that ends by itself is not cancelled and removes its listener', async () => {
    const { root } = tempProject('spawn-runner-ends')
    const before = sigintListeners()

    const result = await spawnRunner(
      process.execPath,
      ['-e', 'process.stdout.write("installed"); process.stderr.write("checked")'],
      { cwd: root, env: process.env, stdio: 'capture' },
    )

    expect(result).toMatchObject({ code: 0, signal: null })
    expect(result.cancelled).toBeUndefined()
    expect(result.output).toContain('installed')
    expect(result.output).toContain('checked')
    expect(sigintListeners()).toEqual(before)
  })

  it('a command that is not there is reported missing and removes its listener', async () => {
    const { root } = tempProject('spawn-runner-missing')
    const before = sigintListeners()

    // An absolute .exe starts without a shell on Windows too, so the missing file is seen directly.
    const result = await spawnRunner(join(root, 'no-such-manager.exe'), ['install'], {
      cwd: root,
      env: process.env,
      stdio: 'capture',
    })

    expect(result).toEqual({ code: null, signal: null, output: '', missing: true })
    expect(sigintListeners()).toEqual(before)
  })
})
