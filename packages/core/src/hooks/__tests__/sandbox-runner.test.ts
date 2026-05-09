import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runHookInSandbox, checkDockerAvailable } from '../sandbox-runner.js'
import type { HookDefinition } from '../types.js'
import { SecretRedactor, SecretStore } from '../../agent/secrets.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdtemp: vi.fn().mockResolvedValue('/tmp/agent-qa-hook-abc123'),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
}))

import { execFile } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'

const mockExecFile = vi.mocked(execFile)
const mockReadFile = vi.mocked(readFile)
const mockMkdir = vi.mocked(mkdir)

function simulateExecFile(stdout: string, stderr: string, exitCode: number | null) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    if (typeof _opts === 'function') {
      callback = _opts
    }
    const err = exitCode !== 0 ? Object.assign(new Error('exit'), { code: exitCode }) : null
    if (callback) callback(err, stdout, stderr)
    return {} as any
  })
}

function makeHook(overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
    name: 'Test Hook',
    runtime: 'node',
    file: '/project/hooks/script.js',
    deps: [],
    timeout: 30000,
    network: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('checkDockerAvailable', () => {
  it('returns true when docker info succeeds', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, 'abc123', '')
      return {} as any
    })
    expect(await checkDockerAvailable()).toBe(true)
  })

  it('returns false when docker info fails', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('docker not found'), '', '')
      return {} as any
    })
    expect(await checkDockerAvailable()).toBe(false)
  })
})

describe('runHookInSandbox', () => {
  it('returns success result when container exits 0', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'image') {
        cb(null, '', '')
      } else if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'hook output here\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runHookInSandbox(makeHook())
    expect(result.success).toBe(true)
    expect(result.output).toBe('hook output here')
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  it('reads variables from .env file after container exit', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'some output\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockImplementation((path: any) => {
      if (String(path).includes('agent-qa.env')) {
        return Promise.resolve('TOKEN=abc123\nUSER_ID=42\n') as any
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const result = await runHookInSandbox(makeHook())
    expect(result.success).toBe(true)
    expect(result.variables).toEqual({ TOKEN: 'abc123', USER_ID: '42' })
  })

  it('returns empty variables when hook writes no .env file', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'output\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runHookInSandbox(makeHook())
    expect(result.success).toBe(true)
    expect(result.variables).toEqual({})
  })

  it('stdout is not parsed for ::set-variable', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, '::set-variable TOKEN=abc\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runHookInSandbox(makeHook())
    expect(result.variables).toEqual({})
  })

  it('output is raw stdout (no ::set-variable filtering)', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'line1\n::set-variable X=1\nline2\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runHookInSandbox(makeHook())
    expect(result.output).toBe('line1\n::set-variable X=1\nline2')
  })

  it('uses bind mount instead of tmpfs', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook())
    const vIdx = dockerArgs.indexOf('-v')
    const bindMounts = dockerArgs.filter((a, i) => dockerArgs[i - 1] === '-v')
    const tmpMount = bindMounts.find((m) => m.includes('/tmp:/tmp'))
    expect(tmpMount).toBeDefined()
    expect(tmpMount).toMatch(/\/tmp\/agent-qa-hook-abc123\/tmp:\/tmp$/)
    expect(dockerArgs).not.toContain('--tmpfs')
  })

  it('creates tmp subdirectory before docker run', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook())
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/agent-qa-hook-abc123/tmp', expect.anything())
  })

  it('returns failure when container exits non-zero', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(Object.assign(new Error('exit'), { code: 1 }), '', 'script error')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runHookInSandbox(makeHook())
    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 1')
  })

  it('passes --network none when hook.network is false', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook({ network: false }))
    expect(dockerArgs).toContain('--network')
    const netIdx = dockerArgs.indexOf('--network')
    expect(dockerArgs[netIdx + 1]).toBe('none')
  })

  it('does not pass --network none when hook.network is true', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook({ network: true }))
    expect(dockerArgs).not.toContain('--network')
  })

  it('applies memory and CPU limits', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook())
    expect(dockerArgs).toContain('--memory')
    expect(dockerArgs).toContain('512m')
    expect(dockerArgs).toContain('--cpus')
    expect(dockerArgs).toContain('1')
    expect(dockerArgs).toContain('--read-only')
  })

  it('uses correct runtime command for each runtime', async () => {
    const runtimes: Array<{ runtime: HookDefinition['runtime']; expectedImage: string; expectedCommand: string }> = [
      { runtime: 'node', expectedImage: 'vostride/agent-qa-hook-runner-node', expectedCommand: 'node' },
      { runtime: 'bun', expectedImage: 'vostride/agent-qa-hook-runner-bun', expectedCommand: 'bun' },
      { runtime: 'python', expectedImage: 'vostride/agent-qa-hook-runner-python', expectedCommand: 'python3' },
      { runtime: 'bash', expectedImage: 'vostride/agent-qa-hook-runner-bash', expectedCommand: 'bash' },
    ]

    for (const { runtime, expectedImage, expectedCommand } of runtimes) {
      let dockerArgs: string[] = []
      mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        if (typeof _opts === 'function') cb = _opts
        if (Array.isArray(args) && args[0] === 'run') {
          dockerArgs = args
        }
        cb(null, '', '')
        return {} as any
      })
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      await runHookInSandbox(makeHook({ runtime, file: `/project/hooks/script.${runtime}` }))
      const imageIdx = dockerArgs.indexOf(expectedImage)
      expect(imageIdx).toBeGreaterThan(-1)
      expect(dockerArgs[imageIdx + 1]).toBe(expectedCommand)
    }
  })

  it('passes env vars to docker container', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook(), { envVars: { API_KEY: 'secret', DB_URL: 'postgres://...' } })
    const eFlags = dockerArgs.reduce<string[]>((acc, val, i) => {
      if (val === '-e') acc.push(dockerArgs[i + 1])
      return acc
    }, [])
    expect(eFlags).toContain('API_KEY=secret')
    expect(eFlags).toContain('DB_URL=postgres://...')
  })

  it('overlays secret values over normal env vars in the docker container', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        dockerArgs = args
      }
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const secretStore = new SecretStore({ API_KEY: 'runtime-secret' })
    await runHookInSandbox(makeHook(), {
      envVars: { API_KEY: 'normal-env', DB_URL: 'postgres://...' },
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    const eFlags = dockerArgs.reduce<string[]>((acc, val, i) => {
      if (val === '-e') acc.push(dockerArgs[i + 1])
      return acc
    }, [])
    expect(eFlags).toContain('API_KEY=runtime-secret')
    expect(eFlags).not.toContain('API_KEY=normal-env')
    expect(eFlags).toContain('DB_URL=postgres://...')
  })

  it('redacts hook output and omits variables that equal known secrets', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args) && args[0] === 'run') {
        cb(Object.assign(new Error('exit'), { code: 1 }), 'stdout runtime-secret\n', 'stderr runtime-secret')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockImplementation((path: any) => {
      if (String(path).includes('agent-qa.env')) {
        return Promise.resolve('LEAKED=runtime-secret\nSAFE=value\n') as any
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const secretStore = new SecretStore({ API_KEY: 'runtime-secret' })
    const result = await runHookInSandbox(makeHook(), {
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('runtime-secret')
    expect(result.stdout).toContain('[secret]')
    expect(result.stderr).toContain('[secret]')
    expect(result.error).toContain('[secret]')
    expect(result.variables).toEqual({ SAFE: 'value' })
  })

  it('pulls image when pullPolicy is always', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args)) calls.push(args)
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook(), { pullPolicy: 'always' })
    const pullCall = calls.find((a) => a[0] === 'pull')
    expect(pullCall).toBeDefined()
  })

  it('skips pull when pullPolicy is never', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      if (typeof _opts === 'function') cb = _opts
      if (Array.isArray(args)) calls.push(args)
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await runHookInSandbox(makeHook(), { pullPolicy: 'never' })
    const pullCall = calls.find((a) => a[0] === 'pull')
    expect(pullCall).toBeUndefined()
  })
})
