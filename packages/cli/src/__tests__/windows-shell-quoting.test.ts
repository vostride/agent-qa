import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))

import { spawnRunner, windowsShellWord } from '../commands/project-host.js'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  spawn.mockReset()
})

function closingChild(): EventEmitter {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('close', 0, null))
  return child
}

describe('windowsShellWord', () => {
  it('keeps a command with spaces as one quoted word', () => {
    expect(windowsShellWord('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    )
  })

  it('quotes a plain command', () => {
    expect(windowsShellWord('pnpm')).toBe('"pnpm"')
  })

  it('escapes a double quote inside an argument', () => {
    expect(windowsShellWord('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('spawnRunner on Windows', () => {
  it('hands the shell the command quoted like its arguments', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    spawn.mockImplementation(closingChild)

    await spawnRunner('C:\\Program Files\\nodejs\\node.exe', ['cli.js', 'init'], {
      cwd: 'C:\\project',
      env: {},
      stdio: 'capture',
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [file, args, options] = spawn.mock.calls[0]!
    expect(file).toBe('"C:\\Program Files\\nodejs\\node.exe"')
    expect(args).toEqual(['"cli.js"', '"init"'])
    expect(options).toMatchObject({ shell: true })
  })

  it('passes the command and arguments unquoted without a shell elsewhere', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    spawn.mockImplementation(closingChild)

    await spawnRunner('/opt/node bin/node', ['cli.js'], {
      cwd: '/project',
      env: {},
      stdio: 'capture',
    })

    const [file, args, options] = spawn.mock.calls[0]!
    expect(file).toBe('/opt/node bin/node')
    expect(args).toEqual(['cli.js'])
    expect(options).toMatchObject({ shell: false })
  })
})
