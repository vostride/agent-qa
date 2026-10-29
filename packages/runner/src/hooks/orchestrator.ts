// Sequential, fail-fast, later hooks see earlier variables; the Docker body is an injected port.

import type {
  HookStartedPayload,
  HookFinishedPayload,
} from '@vostride/agent-qa-schema'
import type { HookDefinition, HookResult } from './types.js'
import type { HookExecutorPort } from '../run/ports.js'
import type { SecretRedactorPort } from '../loop/ports.js'
import type { RuntimeAuthStateConfig } from '../platform.js'
import type { SecretStore } from '../loop/secrets.js'
import { stripReservedAuthStateHookEnv } from './auth-env.js'

/** Structural secret source (SecretStore satisfies it) — used to resolve container secretEnv. */
interface SecretEnvSource {
  forEachSecret(callback: (name: string, value: string) => void): void
}

// The port only ever sees the resolved map, never the secret store itself.
export function resolveSecretEnv(store?: SecretEnvSource): Record<string, string> {
  if (!store) return {}
  const out: Record<string, string> = {}
  store.forEachSecret((name, value) => {
    out[name] = value
  })
  return out
}

// `dockerBin` and `pullPolicy` are kept for source compatibility; the executor owns them.
export interface SandboxRunnerOptions {
  executor: HookExecutorPort
  dockerBin?: string
  pullPolicy?: 'always' | 'if-not-present' | 'never'
  envVars?: Record<string, string>
  secretStore?: SecretStore
  secretRedactor?: SecretRedactorPort
  authState?: RuntimeAuthStateConfig
}

export interface HookOrchestrationResult {
  results: Map<string, HookResult>
  variables: Record<string, string>
  allPassed: boolean
  duration: number
}

// Both legs are fire-and-forget; the sink applies the run mask the orchestration does not.
export interface HookEmitSeam {
  hookStarted(payload: HookStartedPayload): void
  hookFinished(payload: HookFinishedPayload): void
}

/** Identity fields locating this hook batch in the run tree (payload provenance). */
export interface HookRunIdentity {
  phase: HookStartedPayload['phase']
  scope?: HookStartedPayload['scope']
  testIndex?: number
  stepIndex?: number
}

export interface RunHooksOptions {
  // The injected executor, runner-local `DockerHookExecutor`.
  executor: HookExecutorPort
  /** User env + CLI/suite variables the first hook starts from. */
  env?: Record<string, string>
  /** Carrier-compat alias for {@link env} (the old `SandboxRunnerOptions.envVars` field). */
  envVars?: Record<string, string>
  /** Already-resolved secret name→value pairs for container injection. */
  secretEnv?: Record<string, string>
  /** Runner-owned secret store; the orchestrator resolves {@link secretEnv} from it. */
  secretStore?: SecretEnvSource
  /** Structural secret redactor for stdout/stderr/error redaction. */
  secretRedactor?: SecretRedactorPort
  /** Active auth-state mounted + injected per hook. */
  authState?: RuntimeAuthStateConfig
  /** Tolerated carrier fields (the executor owns docker config now; ignored by orchestration). */
  dockerBin?: string
  pullPolicy?: 'always' | 'if-not-present' | 'never'
  /** Optional lifecycle emit seam; requires {@link identity} to emit. */
  emit?: HookEmitSeam
  /** Payload provenance; when present alongside {@link emit}, every executed hook emits. */
  identity?: HookRunIdentity
}

export async function runHooks(
  hooks: HookDefinition[],
  options: RunHooksOptions,
): Promise<HookOrchestrationResult> {
  const start = Date.now()
  const results = new Map<string, HookResult>()
  const mergedVars: Record<string, string> = {}
  const { executor, emit, identity } = options
  const baseEnv = options.env ?? options.envVars ?? {}
  const secretEnv = { ...resolveSecretEnv(options.secretStore), ...options.secretEnv }
  let execCounter = 0

  for (const hook of hooks) {
    const env = { ...baseEnv, ...mergedVars }
    const hookExecutionId = makeExecutionId(hook, identity, execCounter++)

    if (emit && identity) {
      emit.hookStarted(buildStartedPayload(hook, identity, hookExecutionId))
    }

    const result = await executor.execute(hook, {
      env,
      secretEnv,
      secretRedactor: options.secretRedactor,
      authState: options.authState,
    })
    results.set(hook.name, result)

    if (emit && identity) {
      emit.hookFinished(
        buildFinishedPayload(hook, identity, hookExecutionId, result, result.success ? 'passed' : 'failed'),
      )
    }

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

function makeExecutionId(
  hook: HookDefinition,
  identity: HookRunIdentity | undefined,
  counter: number,
): string {
  const parts: Array<string | number> = [identity?.phase ?? 'hook', hook.id]
  if (identity?.testIndex !== undefined) parts.push(`t${identity.testIndex}`)
  if (identity?.stepIndex !== undefined) parts.push(`s${identity.stepIndex}`)
  parts.push(counter)
  return parts.join(':')
}

function buildStartedPayload(
  hook: HookDefinition,
  identity: HookRunIdentity,
  hookExecutionId: string,
): HookStartedPayload {
  const payload: HookStartedPayload = {
    hookName: hook.name,
    phase: identity.phase,
    hookExecutionId,
    hookId: hook.id,
  }
  if (identity.scope !== undefined) payload.scope = identity.scope
  if (identity.testIndex !== undefined) payload.testIndex = identity.testIndex
  if (identity.stepIndex !== undefined) payload.stepIndex = identity.stepIndex
  return payload
}

function buildFinishedPayload(
  hook: HookDefinition,
  identity: HookRunIdentity,
  hookExecutionId: string,
  result: HookResult,
  status: HookFinishedPayload['status'],
): HookFinishedPayload {
  const payload: HookFinishedPayload = {
    ...buildStartedPayload(hook, identity, hookExecutionId),
    status,
    durationMs: result.duration,
    stdout: result.stdout,
    stderr: result.stderr,
    variables: result.variables,
    kind: 'hook',
  }
  if (result.error !== undefined) payload.error = result.error
  return payload
}
