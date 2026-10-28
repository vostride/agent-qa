// Barrel for the runner-owned hook contracts + orchestration (Phase 363 D-06).
export type { HookRuntime, HookDefinition, HookResult } from './types.js'
export { RUNTIME_IMAGE_MAP, hookRunnerImage } from './types.js'
export { parseEnvFile, serializeEnvFile } from './env-file.js'
export {
  AUTH_STATE_HOOK_JSON_ENV,
  AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV,
  AUTH_STATE_HOOK_WORKSPACE_DIR,
  AUTH_STATE_HOOK_STORAGE_STATE_FILENAME,
  AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
  isReservedAuthStateHookEnvKey,
  stripReservedAuthStateHookEnv,
  buildAuthStateHookEnv,
} from './auth-env.js'
export { runHooks, resolveSecretEnv } from './orchestrator.js'
export type {
  HookOrchestrationResult,
  HookEmitSeam,
  HookRunIdentity,
  RunHooksOptions,
  SandboxRunnerOptions,
} from './orchestrator.js'
