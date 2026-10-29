import { homedir } from 'node:os'
import { join } from 'node:path'

export const MODEL_CACHE_DIR_ENV_VAR = 'AGENT_QA_MODEL_CACHE_DIR'

/**
 * Resolve the shared model cache used by every native embedder acquisition.
 *
 * one download per machine across all projects, with artifacts identified
 * by (model_id, revision). An explicit agent-qa override wins, then the XDG
 * cache root, with the conventional home cache as the final fallback.
 */
export function resolveModelCacheDir(): string {
  const override = process.env[MODEL_CACHE_DIR_ENV_VAR]
  if (override) return override

  const xdgCacheHome = process.env.XDG_CACHE_HOME
  if (xdgCacheHome) return join(xdgCacheHome, 'agent-qa', 'models')

  return join(homedir(), '.cache', 'agent-qa', 'models')
}
