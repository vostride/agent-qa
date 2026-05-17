import type { HookDefinition, HookResult } from './types.js'
import { runHookInSandbox, type SandboxRunnerOptions } from './sandbox-runner.js'
import { stripReservedAuthStateHookEnv } from '../auth-state/hook-env.js'

export interface HookOrchestrationResult {
  results: Map<string, HookResult>
  variables: Record<string, string>
  allPassed: boolean
  duration: number
}

export async function runHooks(
  hooks: HookDefinition[],
  options: SandboxRunnerOptions = {},
): Promise<HookOrchestrationResult> {
  const start = Date.now()
  const results = new Map<string, HookResult>()
  const mergedVars: Record<string, string> = {}

  for (const hook of hooks) {
    const envVars = { ...options.envVars, ...mergedVars }
    const result = await runHookInSandbox(hook, { ...options, envVars })
    results.set(hook.name, result)

    if (result.success) {
      Object.assign(mergedVars, stripReservedAuthStateHookEnv(result.variables))
    } else {
      for (const remaining of hooks.slice(hooks.indexOf(hook) + 1)) {
        results.set(remaining.name, {
          success: false,
          variables: {},
          output: '',
          stdout: '',
          stderr: '',
          duration: 0,
          error: `Skipped: previous hook "${hook.name}" failed`,
        })
      }
      break
    }
  }

  return {
    results,
    variables: mergedVars,
    allPassed: [...results.values()].every((r) => r.success),
    duration: Date.now() - start,
  }
}
