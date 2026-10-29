import { homedir } from 'node:os'
import { join } from 'node:path'

export const MODEL_CACHE_DIR_ENV_VAR = 'AGENT_QA_MODEL_CACHE_DIR'

// One download per machine: an explicit override wins, then the XDG cache, then the home cache.
export function resolveModelCacheDir(): string {
  const override = process.env[MODEL_CACHE_DIR_ENV_VAR]
  if (override) return override

  const xdgCacheHome = process.env.XDG_CACHE_HOME
  if (xdgCacheHome) return join(xdgCacheHome, 'agent-qa', 'models')

  return join(homedir(), '.cache', 'agent-qa', 'models')
}
