import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DEFAULT_AGENT_QA_RUNS_DB_PATH, LEGACY_AGENT_QA_DASHBOARD_DB_PATH } from '@vostride/agent-qa-core'

const RUNS_DB_PATH_FALLBACK = DEFAULT_AGENT_QA_RUNS_DB_PATH || '.agent-qa/runs.db'
const LEGACY_DB_PATH_FALLBACK = LEGACY_AGENT_QA_DASHBOARD_DB_PATH || '.agent-qa/dashboard.db'

export interface ResolveDashboardDbPathOptions {
  configDir: string
  configuredDbPath?: string
}

export function resolveDashboardDbPath({
  configDir,
  configuredDbPath,
}: ResolveDashboardDbPathOptions): string {
  const configured = configuredDbPath?.trim()
  if (configured) {
    return resolve(configDir, configured)
  }

  const defaultPath = resolve(configDir, RUNS_DB_PATH_FALLBACK)
  const legacyPath = resolve(configDir, LEGACY_DB_PATH_FALLBACK)

  if (!existsSync(defaultPath) && existsSync(legacyPath)) {
    mkdirSync(dirname(defaultPath), { recursive: true })
    renameSync(legacyPath, defaultPath)
  }

  return defaultPath
}
