import type { RuntimeAuthStateConfig } from '../types/platform.js'

export const AUTH_STATE_HOOK_JSON_ENV = 'AGENT_QA_AUTH_STATE_JSON'
export const AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV = 'AGENT_QA_AUTH_STATE_STORAGE_STATE_PATH'
export const AUTH_STATE_HOOK_WORKSPACE_DIR = '.agent-qa-auth-state'
export const AUTH_STATE_HOOK_STORAGE_STATE_FILENAME = 'storage-state.json'
export const AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH =
  `/workspace/${AUTH_STATE_HOOK_WORKSPACE_DIR}/${AUTH_STATE_HOOK_STORAGE_STATE_FILENAME}`

const RESERVED_AUTH_STATE_HOOK_ENV_KEYS = new Set([
  AUTH_STATE_HOOK_JSON_ENV,
  AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV,
])

export function isReservedAuthStateHookEnvKey(key: string): boolean {
  return RESERVED_AUTH_STATE_HOOK_ENV_KEYS.has(key)
}

export function stripReservedAuthStateHookEnv(
  variables: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).filter(([key]) => !isReservedAuthStateHookEnvKey(key)),
  )
}

export function buildAuthStateHookEnv(
  authState: RuntimeAuthStateConfig | undefined,
  storageStatePath = AUTH_STATE_HOOK_CONTAINER_STORAGE_STATE_PATH,
): Record<string, string> {
  if (!authState) return {}

  const metadata = {
    version: authState.version,
    kind: authState.kind,
    target: authState.targetName,
    name: authState.stateName,
    capturedAt: authState.capturedAt,
    storageStatePath,
  }

  return {
    [AUTH_STATE_HOOK_JSON_ENV]: JSON.stringify(metadata),
    [AUTH_STATE_HOOK_STORAGE_STATE_PATH_ENV]: storageStatePath,
  }
}
