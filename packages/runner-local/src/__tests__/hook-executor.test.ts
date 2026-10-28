import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DockerHookExecutor,
  checkDockerAvailable,
  type DockerHookExecutorConfig,
} from '../hook-executor.js'
import type { HookDefinition, HookExecuteOptions } from '@vostride/agent-qa-runner'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'

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
import { readFile, mkdir, cp } from 'node:fs/promises'

const mockExecFile = vi.mocked(execFile)
const mockReadFile = vi.mocked(readFile)
const mockMkdir = vi.mocked(mkdir)
const mockCp = vi.mocked(cp)

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

/** Base per-call options (env + secretEnv are required on the port). */
function opts(partial: Partial<HookExecuteOptions> = {}): HookExecuteOptions {
  return { env: {}, secretEnv: {}, ...partial }
}

function run(
  hook: HookDefinition,
  partial: Partial<HookExecuteOptions> = {},
  config: Partial<DockerHookExecutorConfig> = {},
) {
  return new DockerHookExecutor({ version: '1.2.3', ...config }).execute(hook, opts(partial))
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

describe('DockerHookExecutor.execute', () => {
  it('names the image tagged with the running version in inspect, pull and run', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      calls.push(args)
      if (args[0] === 'image') cb(new Error('No such image'), '', '')
      else cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook())

    const image = 'vostride/agent-qa-hook-runner-node:1.2.3'
    const inspect = calls.find((a) => a[0] === 'image')
    const pull = calls.find((a) => a[0] === 'pull')
    const runArgs = calls.find((a) => a[0] === 'run')
    expect(inspect?.at(-1)).toBe(image)
    expect(pull?.at(-1)).toBe(image)
    expect(runArgs).toContain(image)
  })

  it('returns success result when container exits 0', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
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

    const result = await run(makeHook())
    expect(result.success).toBe(true)
    expect(result.output).toBe('hook output here')
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  it('reads variables from .env file after container exit', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
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

    const result = await run(makeHook())
    expect(result.success).toBe(true)
    expect(result.variables).toEqual({ TOKEN: 'abc123', USER_ID: '42' })
  })

  it('returns empty variables when hook writes no .env file', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'output\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await run(makeHook())
    expect(result.success).toBe(true)
    expect(result.variables).toEqual({})
  })

  it('stdout is not parsed for ::set-variable', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, '::set-variable TOKEN=abc\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await run(makeHook())
    expect(result.variables).toEqual({})
  })

  it('output is raw stdout (no ::set-variable filtering)', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'line1\n::set-variable X=1\nline2\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await run(makeHook())
    expect(result.output).toBe('line1\n::set-variable X=1\nline2')
  })

  it('uses bind mount instead of tmpfs', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook())
    const bindMounts = dockerArgs.filter((a, i) => dockerArgs[i - 1] === '-v')
    const tmpMount = bindMounts.find((m) => m.includes('/tmp:/tmp'))
    expect(tmpMount).toBeDefined()
    expect(tmpMount).toMatch(/\/tmp\/agent-qa-hook-abc123\/tmp:\/tmp$/)
    expect(dockerArgs).not.toContain('--tmpfs')
  })

  it('creates tmp subdirectory before docker run', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook())
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/agent-qa-hook-abc123/tmp', expect.anything())
  })

  it('returns failure when container exits non-zero', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(Object.assign(new Error('exit'), { code: 1 }), '', 'script error')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await run(makeHook())
    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 1')
  })

  it('passes --network none when hook.network is false', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook({ network: false }))
    expect(dockerArgs).toContain('--network')
    const netIdx = dockerArgs.indexOf('--network')
    expect(dockerArgs[netIdx + 1]).toBe('none')
  })

  it('does not pass --network none when hook.network is true', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook({ network: true }))
    expect(dockerArgs).not.toContain('--network')
  })

  it('applies memory, CPU, pids, and read-only limits', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook())
    expect(dockerArgs).toContain('--memory')
    expect(dockerArgs).toContain('512m')
    expect(dockerArgs).toContain('--cpus')
    expect(dockerArgs).toContain('1')
    expect(dockerArgs).toContain('--pids-limit')
    expect(dockerArgs).toContain('256')
    expect(dockerArgs).toContain('--read-only')
    expect(dockerArgs).toContain('-w')
    expect(dockerArgs).toContain('/workspace')
  })

  it('uses correct runtime command for each runtime', async () => {
    const runtimes: Array<{ runtime: HookDefinition['runtime']; expectedImage: string; expectedCommand: string }> = [
      { runtime: 'node', expectedImage: 'vostride/agent-qa-hook-runner-node:1.2.3', expectedCommand: 'node' },
      { runtime: 'bun', expectedImage: 'vostride/agent-qa-hook-runner-bun:1.2.3', expectedCommand: 'bun' },
      { runtime: 'python', expectedImage: 'vostride/agent-qa-hook-runner-python:1.2.3', expectedCommand: 'python3' },
      { runtime: 'bash', expectedImage: 'vostride/agent-qa-hook-runner-bash:1.2.3', expectedCommand: 'bash' },
    ]

    for (const { runtime, expectedImage, expectedCommand } of runtimes) {
      let dockerArgs: string[] = []
      mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
        if (typeof _o === 'function') cb = _o
        if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
        cb(null, '', '')
        return {} as any
      })
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      await run(makeHook({ runtime, file: `/project/hooks/script.${runtime}` }))
      const imageIdx = dockerArgs.indexOf(expectedImage)
      expect(imageIdx).toBeGreaterThan(-1)
      expect(dockerArgs[imageIdx + 1]).toBe(expectedCommand)
    }
  })

  it('passes env vars to docker container', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook(), { env: { API_KEY: 'secret', DB_URL: 'postgres://...' } })
    const eFlags = dockerArgs.reduce<string[]>((acc, val, i) => {
      if (val === '-e') acc.push(dockerArgs[i + 1])
      return acc
    }, [])
    expect(eFlags).toContain('API_KEY=secret')
    expect(eFlags).toContain('DB_URL=postgres://...')
  })

  it('copies active auth state into the hook workspace and passes container-local env vars', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook(), {
      env: {
        AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH: '/tmp/overridden.json',
      },
      authState: {
        version: 2,
        kind: 'web',
        targetName: 'staging-web',
        stateName: 'admin',
        capturedAt: '2026-05-17T00:00:00.000Z',
        storageStatePath: '/internal/auth/staging-web/admin.json',
      },
    })

    expect(mockMkdir).toHaveBeenCalledWith(
      '/tmp/agent-qa-hook-abc123/.agent-qa-auth-state',
      expect.anything(),
    )
    expect(mockCp).toHaveBeenCalledWith(
      '/internal/auth/staging-web/admin.json',
      '/tmp/agent-qa-hook-abc123/.agent-qa-auth-state/storage-state.json',
    )

    const eFlags = dockerArgs.reduce<string[]>((acc, val, i) => {
      if (val === '-e') acc.push(dockerArgs[i + 1])
      return acc
    }, [])
    const pathEnv = eFlags.find((item) => item.startsWith('AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH='))
    const jsonEnv = eFlags.find((item) => item.startsWith('AGENT_QA_AUTH_STATE_JSON='))
    expect(pathEnv).toBe('AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH=/workspace/.agent-qa-auth-state/storage-state.json')
    expect(jsonEnv).toBeDefined()
    expect(JSON.stringify(eFlags)).not.toContain('/internal/auth/staging-web/admin.json')
    expect(JSON.parse(jsonEnv!.slice('AGENT_QA_AUTH_STATE_JSON='.length))).toEqual({
      version: 2,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
      capturedAt: '2026-05-17T00:00:00.000Z',
      storageStatePath: '/workspace/.agent-qa-auth-state/storage-state.json',
    })
  })

  it('does not expose auth-state env vars when no auth state is selected', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook())

    const eFlags = dockerArgs.reduce<string[]>((acc, val, i) => {
      if (val === '-e') acc.push(dockerArgs[i + 1])
      return acc
    }, [])
    expect(eFlags.join('\n')).not.toContain('AGENT_QA_AUTH_STATE_JSON')
    expect(eFlags.join('\n')).not.toContain('AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH')
  })

  it('filters reserved auth-state variables emitted by hooks', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(null, 'ok\n', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockImplementation((path: any) => {
      if (String(path).includes('agent-qa.env')) {
        return Promise.resolve([
          'SAFE=value',
          'AGENT_QA_AUTH_STATE_JSON={"name":"bad"}',
          'AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH=/tmp/bad.json',
          '',
        ].join('\n')) as any
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    })

    const result = await run(makeHook())
    expect(result.variables).toEqual({ SAFE: 'value' })
  })

  it('overlays secret values over normal env vars in the docker container', async () => {
    let dockerArgs: string[] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') dockerArgs = args
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const secretStore = new SecretStore({ API_KEY: 'runtime-secret' })
    await run(makeHook(), {
      env: { API_KEY: 'normal-env', DB_URL: 'postgres://...' },
      secretEnv: { API_KEY: 'runtime-secret' },
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
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
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
    const result = await run(makeHook(), {
      secretEnv: { API_KEY: 'runtime-secret' },
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('runtime-secret')
    expect(result.stdout).toContain('[secret:API_KEY]')
    expect(result.stderr).toContain('[secret:API_KEY]')
    expect(result.error).toContain('[secret:API_KEY]')
    expect(result.variables).toEqual({ SAFE: 'value' })
  })

  it('pulls image when pullPolicy is always', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args)) calls.push(args)
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook(), {}, { pullPolicy: 'always' })
    const pullCall = calls.find((a) => a[0] === 'pull')
    expect(pullCall).toBeDefined()
  })

  it('skips pull when pullPolicy is never', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args)) calls.push(args)
      cb(null, '', '')
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await run(makeHook(), {}, { pullPolicy: 'never' })
    const pullCall = calls.find((a) => a[0] === 'pull')
    expect(pullCall).toBeUndefined()
  })

  it('resolves a failed exit-124 result on timeout, never throwing', async () => {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(Object.assign(new Error('killed'), { killed: true }), '', '')
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await run(makeHook({ timeout: 1000 }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 124')
  })
})

describe('C441-HOOK-OUTPUT', () => {
  const authState = {
    version: 1 as const,
    kind: 'web' as const,
    targetName: 'staging-web',
    stateName: 'admin',
    capturedAt: '2026-05-17T00:00:00.000Z',
    storageStatePath: '/internal/auth/staging-web/admin.json',
  }

  function hookPrints(stdout: string, stderr: string, exitCode: number) {
    mockExecFile.mockImplementation((_cmd: any, args: any, _o: any, cb: any) => {
      if (typeof _o === 'function') cb = _o
      if (Array.isArray(args) && args[0] === 'run') {
        cb(exitCode === 0 ? null : Object.assign(new Error('exit'), { code: exitCode }), stdout, stderr)
      } else {
        cb(null, '', '')
      }
      return {} as any
    })
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  }

  it('hook output masks a declared value by name', async () => {
    hookPrints('pw=q^7\n', 'pw=q^7', 1)

    const result = await run(makeHook(), {
      secretRedactor: new SecretRedactor(new SecretStore({ SHORT: 'q^7' })),
      authState,
    })

    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toContain('q^7')
    expect(result.stdout).toBe('pw=[secret:SHORT]\n')
    expect(result.output).toBe('pw=[secret:SHORT]')
    expect(result.error).toBe('Hook exited with code 1: pw=[secret:SHORT]')
  })

  it('hook output keeps an undeclared auth-state value and auth-like keys', async () => {
    const storageStateJson = JSON.stringify({
      cookies: [{ name: 'sid', value: 'hook-cookie-value' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'hook-local-value' }] }],
    })
    const stdout = [
      'cookie hook-cookie-value',
      'token=abc',
      'Authorization: Bearer xyz',
      '/workspace/.agent-qa-auth-state/storage-state.json',
      storageStateJson,
    ].join('\n')
    const stderr = 'AGENT_QA_AUTH_STATE_JSON={"name":"admin","storageStatePath":"/workspace/.agent-qa-auth-state/storage-state.json"}'
    hookPrints(stdout, stderr, 1)

    const result = await run(makeHook(), {
      secretRedactor: new SecretRedactor(new SecretStore({ SHORT: 'q^7' })),
      authState,
    })

    expect(result.stdout).toBe(stdout)
    expect(result.output).toBe(stdout)
    expect(result.stderr).toBe(stderr)
    expect(result.error).toBe(`Hook exited with code 1: ${stderr}`)
  })
})
