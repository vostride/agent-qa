import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import treeKill from 'tree-kill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { killTree } from '../kill-tree'

vi.mock('tree-kill')

const mockTreeKill = vi.mocked(treeKill)
const procs: string[] = []

// A /proc with a stat file for each process, written the way the Linux kernel writes it.
function fakeProc(processes: ReadonlyArray<readonly [pid: number, parent: number, name: string]>) {
  const proc = mkdtempSync(join(tmpdir(), 'kill-tree-proc-'))
  procs.push(proc)
  mkdirSync(join(proc, 'self'))
  for (const [pid, parent, name] of processes) {
    mkdirSync(join(proc, String(pid)))
    writeFileSync(
      join(proc, String(pid), 'stat'),
      `${pid} (${name}) S ${parent} ${pid} ${pid} 0 -1`,
    )
  }
  return proc
}

const killedPids = (kill: { mock: { calls: unknown[][] } }) =>
  kill.mock.calls.map(([pid]) => pid as number).sort((a, b) => a - b)

beforeEach(() => {
  mockTreeKill.mockReset()
  mockTreeKill.mockImplementation((_pid, _signal, callback) => callback?.())
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const proc of procs.splice(0)) rmSync(proc, { recursive: true, force: true })
})

describe('killTree', () => {
  it('on Linux kills the process and every process under it, read from the parent links in /proc, and no other', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const proc = fakeProc([
      [500, 1, 'node'],
      [501, 500, 'node (appium) main'],
      [502, 501, 'adb'],
      [503, 1, 'bash'],
      [504, 502, 'qemu-system'],
      [505, 503, 'sleep'],
    ])

    await killTree(500, { platform: 'linux', proc })

    expect(killedPids(kill)).toEqual([500, 501, 502, 504])
    expect(kill.mock.calls.every(([, signal]) => signal === 'SIGKILL')).toBe(true)
    expect(mockTreeKill).not.toHaveBeenCalled()
  })

  it('on Linux kills the rest of the tree when one of its processes has already ended', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 601) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    })
    const proc = fakeProc([
      [600, 1, 'node'],
      [601, 600, 'adb'],
      [602, 600, 'emulator'],
    ])

    await expect(killTree(600, { platform: 'linux', proc })).resolves.toBeUndefined()
    expect(killedPids(kill)).toEqual([600, 601, 602])
  })

  it('elsewhere kills the tree through tree-kill and settles once its callback runs', async () => {
    let signalled: () => void = () => {}
    mockTreeKill.mockImplementationOnce((_pid, _signal, callback) => {
      signalled = () => callback?.()
    })

    const killing = killTree(700, { platform: 'darwin' })
    const early = await Promise.race([
      killing.then(() => 'settled'),
      new Promise((wait) => setTimeout(() => wait('waiting'), 20)),
    ])

    expect(early).toBe('waiting')
    expect(mockTreeKill).toHaveBeenCalledWith(700, 'SIGKILL', expect.any(Function))
    signalled()
    await expect(killing).resolves.toBeUndefined()
  })

  it('elsewhere settles when tree-kill reports an error', async () => {
    mockTreeKill.mockImplementationOnce((_pid, _signal, callback) =>
      callback?.(new Error('kill failed')),
    )

    await expect(killTree(700, { platform: 'darwin' })).resolves.toBeUndefined()
  })
})
