// Re-exported from runner so core's auth-state consumers resolve through the core barrel.

export {
  AUTH_STATE_HOOK_JSON_ENV,
  AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV,
  AUTH_STATE_HOOK_WORKSPACE_DIR,
  AUTH_STATE_HOOK_STORAGE_STATE_FILENAME,
  AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
  isReservedAuthStateHookEnvKey,
  stripReservedAuthStateHookEnv,
  buildAuthStateHookEnv,
} from '@vostride/agent-qa-runner'
