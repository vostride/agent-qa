// Auth-state hook env plumbing moved to @vostride/agent-qa-runner so the
// hook orchestration (runner) and DockerHookExecutor (runner-local) share it without importing
// core. Re-exported here so core's other auth-state consumers keep resolving through the core
// barrel until they re-point.

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
