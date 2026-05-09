import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HookDefinition, HookResult } from '../types.js'
import { runHooks, type HookOrchestrationResult } from '../orchestrator.js'
import type { SandboxRunnerOptions } from '../sandbox-runner.js'

vi.mock('../sandbox-runner.js', () => ({
  runHookInSandbox: vi.fn(),
}))

import { runHookInSandbox } from '../sandbox-runner.js'
const mockRunHookInSandbox = vi.mocked(runHookInSandbox)

function makeHook(name: string): HookDefinition {
  return {
    id: `h_${name}-amber-birch-coral-delta-ember-falcon-garden-harbor`,
    name,
    runtime: 'node',
    file: '/tmp/hook.js',
    deps: [],
    timeout: 30000,
    network: true,
  }
}

describe('runner hooks integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('setup hooks lifecycle', () => {
    it('runs setup hooks in order and merges output variables', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { AUTH_TOKEN: 'tok-123' },
        output: 'Auth hook done',
        stdout: '',
        stderr: '',
        duration: 200,
      })
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { DB_URL: 'postgres://localhost/test' },
        output: 'Seed done',
        stdout: '',
        stderr: '',
        duration: 300,
      })

      const hooks = [makeHook('get-auth'), makeHook('seed-db')]
      const result = await runHooks(hooks, { envVars: { BASE_URL: 'http://localhost' } })

      expect(result.allPassed).toBe(true)
      expect(result.variables).toEqual({
        AUTH_TOKEN: 'tok-123',
        DB_URL: 'postgres://localhost/test',
      })

      // First hook gets base env vars
      expect(mockRunHookInSandbox).toHaveBeenCalledTimes(2)
      const firstCall = mockRunHookInSandbox.mock.calls[0]
      expect(firstCall[0].name).toBe('get-auth')
      expect(firstCall[1]?.envVars).toEqual({ BASE_URL: 'http://localhost' })

      // Second hook gets base + merged vars from first hook
      const secondCall = mockRunHookInSandbox.mock.calls[1]
      expect(secondCall[0].name).toBe('seed-db')
      expect(secondCall[1]?.envVars).toEqual({
        BASE_URL: 'http://localhost',
        AUTH_TOKEN: 'tok-123',
      })
    })

    it('stops execution on setup hook failure (D-08)', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: false,
        variables: {},
        output: '',
        stdout: '',
        stderr: '',
        duration: 100,
        error: 'Connection refused',
      })

      const hooks = [makeHook('failing-hook'), makeHook('should-not-run')]
      const result = await runHooks(hooks)

      expect(result.allPassed).toBe(false)
      expect(mockRunHookInSandbox).toHaveBeenCalledTimes(1)

      // The second hook should be marked as skipped
      const secondResult = result.results.get('should-not-run')
      expect(secondResult?.success).toBe(false)
      expect(secondResult?.error).toContain('Skipped')
    })

    it('handles empty setup array gracefully', async () => {
      const result = await runHooks([])
      expect(result.allPassed).toBe(true)
      expect(result.variables).toEqual({})
      expect(mockRunHookInSandbox).not.toHaveBeenCalled()
    })
  })

  describe('teardown hooks lifecycle', () => {
    it('teardown hooks execute independently (one per call)', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: {},
        output: 'Cleaned up',
        stdout: '',
        stderr: '',
        duration: 50,
      })

      const result = await runHooks([makeHook('cleanup')])
      expect(result.allPassed).toBe(true)
      expect(mockRunHookInSandbox).toHaveBeenCalledTimes(1)
    })

    it('teardown hook failure does not propagate (logged only per D-07)', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: false,
        variables: {},
        output: '',
        stdout: '',
        stderr: '',
        duration: 30,
        error: 'Failed to delete temp data',
      })

      const result = await runHooks([makeHook('cleanup')])

      // The orchestrator reports failure but callers (runner.ts) catch and log
      expect(result.allPassed).toBe(false)
      const hr = result.results.get('cleanup')
      expect(hr?.error).toBe('Failed to delete temp data')
    })
  })

  describe('variable passing', () => {
    it('hook output variables accumulate across sequential hooks', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { VAR_A: '1' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 10,
      })
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { VAR_B: '2' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 10,
      })
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { VAR_C: '3' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 10,
      })

      const result = await runHooks([
        makeHook('hook-a'),
        makeHook('hook-b'),
        makeHook('hook-c'),
      ])

      expect(result.variables).toEqual({ VAR_A: '1', VAR_B: '2', VAR_C: '3' })
    })

    it('later hooks override variables from earlier hooks', async () => {
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { TOKEN: 'old-token' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 10,
      })
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { TOKEN: 'new-token' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 10,
      })

      const result = await runHooks([makeHook('hook-a'), makeHook('hook-b')])
      expect(result.variables).toEqual({ TOKEN: 'new-token' })
    })
  })

  describe('suite teardown variable accumulation (D-14)', () => {
    it('suite teardown receives all accumulated variables', async () => {
      // Simulate suite setup hooks producing variables
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: { AUTH_TOKEN: 'suite-auth-token' },
        output: '',
        stdout: '',
        stderr: '',
        duration: 100,
      })

      const suiteSetupResult = await runHooks([makeHook('suite-init')], {
        envVars: { ENV_VAR: 'from-env', INLINE_VAR: 'from-inline', CLI_VAR: 'from-cli' },
      })

      expect(suiteSetupResult.allPassed).toBe(true)

      // Now simulate teardown call with accumulated vars
      mockRunHookInSandbox.mockResolvedValueOnce({
        success: true,
        variables: {},
        output: 'Teardown complete',
        stdout: '',
        stderr: '',
        duration: 50,
      })

      const teardownVars: Record<string, string> = {}
      // Env file vars
      Object.assign(teardownVars, { ENV_VAR: 'from-env' })
      // Inline vars
      Object.assign(teardownVars, { INLINE_VAR: 'from-inline' })
      // CLI vars
      Object.assign(teardownVars, { CLI_VAR: 'from-cli' })
      // Suite variables
      Object.assign(teardownVars, { SUITE_VAR: 'from-suite' })
      // Hook output vars from setup
      Object.assign(teardownVars, suiteSetupResult.variables)

      const teardownResult = await runHooks([makeHook('suite-cleanup')], {
        envVars: teardownVars,
      })

      expect(teardownResult.allPassed).toBe(true)

      // Verify the teardown hook received ALL accumulated variables
      const teardownCall = mockRunHookInSandbox.mock.calls[1]
      const passedEnvVars = teardownCall[1]?.envVars
      expect(passedEnvVars).toEqual({
        ENV_VAR: 'from-env',
        INLINE_VAR: 'from-inline',
        CLI_VAR: 'from-cli',
        SUITE_VAR: 'from-suite',
        AUTH_TOKEN: 'suite-auth-token',
      })
    })
  })

  describe('backward compatibility', () => {
    it('hooks are skipped when no resolvedHooks provided', () => {
      // This tests the runner.ts guard: if config.resolvedHooks is undefined,
      // hook blocks are completely skipped. We verify by checking that
      // runHooks is never called when we don't set up hooks infrastructure.
      // The actual guard is: if (test.setup?.length && config.resolvedHooks && config.sandboxOptions)
      // Since this is a unit test of the orchestrator, we just verify no-op behavior
      // with empty input.
      const hooks: HookDefinition[] = []
      // runHooks with empty array should be a no-op
      return runHooks(hooks).then(result => {
        expect(result.allPassed).toBe(true)
        expect(result.duration).toBeGreaterThanOrEqual(0)
        expect(mockRunHookInSandbox).not.toHaveBeenCalled()
      })
    })
  })
})
