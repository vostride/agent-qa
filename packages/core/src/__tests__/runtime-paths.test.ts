import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_QA_ARTIFACTS_DIR,
  DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_CACHE_DIR,
  DEFAULT_AGENT_QA_RUNS_DB_PATH,
  DEFAULT_AGENT_QA_RUNTIME_DIR,
  DEFAULT_AGENT_QA_SCREENSHOTS_DIR,
  DEFAULT_AGENT_QA_VIDEOS_DIR,
  LEGACY_AGENT_QA_DASHBOARD_DB_PATH,
} from '../runtime-paths.js'

describe('runtime path defaults', () => {
  it('keeps generated runtime output under .agent-qa', () => {
    expect(DEFAULT_AGENT_QA_RUNTIME_DIR).toBe('.agent-qa')
    expect(DEFAULT_AGENT_QA_CACHE_DIR).toBe('.agent-qa/cache')
    expect(DEFAULT_AGENT_QA_AUTH_STATES_DIR).toBe('.agent-qa/auth-states')
    expect(DEFAULT_AGENT_QA_ARTIFACTS_DIR).toBe('.agent-qa/artifacts')
    expect(DEFAULT_AGENT_QA_AUTH_STATES_DIR.startsWith(`${DEFAULT_AGENT_QA_RUNTIME_DIR}/`)).toBe(true)
  })

  it('keeps screenshots and videos under the artifacts tree', () => {
    expect(DEFAULT_AGENT_QA_SCREENSHOTS_DIR).toBe('.agent-qa/artifacts/screenshots')
    expect(DEFAULT_AGENT_QA_VIDEOS_DIR).toBe('.agent-qa/artifacts/videos')
    expect(DEFAULT_AGENT_QA_SCREENSHOTS_DIR.startsWith(`${DEFAULT_AGENT_QA_ARTIFACTS_DIR}/`)).toBe(true)
    expect(DEFAULT_AGENT_QA_VIDEOS_DIR.startsWith(`${DEFAULT_AGENT_QA_ARTIFACTS_DIR}/`)).toBe(true)
  })

  it('names the durable run database separately from the legacy dashboard DB', () => {
    expect(DEFAULT_AGENT_QA_RUNS_DB_PATH).toBe('.agent-qa/runs.db')
    expect(LEGACY_AGENT_QA_DASHBOARD_DB_PATH).toBe('.agent-qa/dashboard.db')
  })
})
