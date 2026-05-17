import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runHooks } from '../orchestrator.js'
import type { HookDefinition, HookResult } from '../types.js'

vi.mock('../sandbox-runner.js', () => ({
  runHookInSandbox: vi.fn(),
}))

import { runHookInSandbox } from '../sandbox-runner.js'
const mockRunHook = vi.mocked(runHookInSandbox)

function makeHook(name: string, overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    id: `h_${name}-amber-birch-coral-delta-ember-falcon-garden-harbor`,
    name,
    runtime: 'node',
    file: `/project/hooks/${name}.js`,
    deps: [],
    timeout: 30000,
    network: true,
    ...overrides,
  }
}

function successResult(vars: Record<string, string> = {}): HookResult {
  return { success: true, variables: vars, output: 'ok', stdout: '', stderr: '', duration: 100 }
}

function failResult(error: string): HookResult {
  return { success: false, variables: {}, output: '', stdout: '', stderr: '', duration: 50, error }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runHooks', () => {
  it('runs all hooks sequentially and merges variables', async () => {
    mockRunHook
      .mockResolvedValueOnce(successResult({ TOKEN: 'abc' }))
      .mockResolvedValueOnce(successResult({ SESSION: 'xyz' }))

    const result = await runHooks([makeHook('auth'), makeHook('seed')])

    expect(result.allPassed).toBe(true)
    expect(result.variables).toEqual({ TOKEN: 'abc', SESSION: 'xyz' })
    expect(result.results.size).toBe(2)
    expect(mockRunHook).toHaveBeenCalledTimes(2)
  })

  it('passes accumulated variables to subsequent hooks as env vars', async () => {
    mockRunHook
      .mockResolvedValueOnce(successResult({ TOKEN: 'abc' }))
      .mockResolvedValueOnce(successResult({}))

    await runHooks([makeHook('auth'), makeHook('seed')])

    const secondCallOpts = mockRunHook.mock.calls[1][1]
    expect(secondCallOpts?.envVars).toMatchObject({ TOKEN: 'abc' })
  })

  it('does not allow hook-emitted auth-state env vars to chain into later hooks', async () => {
    mockRunHook
      .mockResolvedValueOnce(successResult({
        SAFE: 'value',
        AGENT_QA_AUTH_STATE_JSON: '{"name":"bad"}',
        AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH: '/tmp/bad.json',
      }))
      .mockResolvedValueOnce(successResult({}))

    const result = await runHooks([makeHook('auth'), makeHook('seed')])

    expect(result.variables).toEqual({ SAFE: 'value' })
    const secondCallOpts = mockRunHook.mock.calls[1][1]
    expect(secondCallOpts?.envVars).toEqual({ SAFE: 'value' })
  })

  it('stops on first failure and skips remaining hooks', async () => {
    mockRunHook
      .mockResolvedValueOnce(successResult({ TOKEN: 'abc' }))
      .mockResolvedValueOnce(failResult('script error'))

    const result = await runHooks([
      makeHook('auth'),
      makeHook('seed'),
      makeHook('cleanup'),
    ])

    expect(result.allPassed).toBe(false)
    expect(result.results.size).toBe(3)
    expect(mockRunHook).toHaveBeenCalledTimes(2)

    const cleanupResult = result.results.get('cleanup')!
    expect(cleanupResult.success).toBe(false)
    expect(cleanupResult.error).toContain('Skipped')
    expect(cleanupResult.error).toContain('seed')
  })

  it('returns empty results for empty hooks array', async () => {
    const result = await runHooks([])
    expect(result.allPassed).toBe(true)
    expect(result.variables).toEqual({})
    expect(result.results.size).toBe(0)
  })

  it('later hook variables override earlier ones', async () => {
    mockRunHook
      .mockResolvedValueOnce(successResult({ TOKEN: 'first', SHARED: 'a' }))
      .mockResolvedValueOnce(successResult({ TOKEN: 'second' }))

    const result = await runHooks([makeHook('hook1'), makeHook('hook2')])
    expect(result.variables.TOKEN).toBe('second')
    expect(result.variables.SHARED).toBe('a')
  })

  it('tracks duration', async () => {
    mockRunHook.mockResolvedValue(successResult())
    const result = await runHooks([makeHook('fast')])
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })
})
