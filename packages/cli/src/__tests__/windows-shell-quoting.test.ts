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
    expect(windowsShellWord('C:\\Program Files\\nodejs\\pnpm.cmd')).toBe(
      '"C:\\Program Files\\nodejs\\pnpm.cmd"',
    )
  })

  it('quotes a plain command', () => {
    expect(windowsShellWord('pnpm')).toBe('"pnpm"')
  })

  it.each(['say "hi"', '%PATH%', 'a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a!b', 'a\nb'])(
    'refuses %j, which cmd.exe would act on even inside quotes',
    (word) => {
      expect(() => windowsShellWord(word)).toThrow(/^Refusing to pass .* through cmd\.exe/u)
    },
  )
})

describe('spawnRunner on Windows', () => {
  it('hands the shell a manager shim and its arguments as one quoted command line', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    spawn.mockImplementation(closingChild)

    await spawnRunner('pnpm', ['install', '--legacy-peer-deps'], {
      cwd: 'C:\\project',
      env: {},
      stdio: 'capture',
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [line, options] = spawn.mock.calls[0]!
    expect(line).toBe('"pnpm" "install" "--legacy-peer-deps"')
    expect(options).toMatchObject({ shell: true })
  })

  it('starts node.exe directly, so free-form arguments never meet cmd.exe', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    spawn.mockImplementation(closingChild)
    const args = ['cli.js', 'init', '--model', 'say "hi" & echo %PATH%']

    await spawnRunner('C:\\Program Files\\nodejs\\node.exe', args, {
      cwd: 'C:\\project',
      env: {},
      stdio: 'capture',
    })

    const [file, passed, options] = spawn.mock.calls[0]!
    expect(file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(passed).toEqual(args)
    expect(options).toMatchObject({ shell: false })
  })

  it('refuses an argument cmd.exe would act on, and starts nothing', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })

    await expect(
      spawnRunner('npm', ['view', '%TOKEN%'], { cwd: 'C:\\project', env: {}, stdio: 'capture' }),
    ).rejects.toThrow(/^Refusing to pass "%TOKEN%" through cmd\.exe/u)
    expect(spawn).not.toHaveBeenCalled()
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
