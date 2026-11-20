// The built `agent-qa dashboard` command's own terminal lines, read from the child's stdout.
// Run `pnpm build` at the repository root first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'

const FILE_BUDGET_MS = 120_000

let dashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined

beforeAll(async () => {
  const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) {
    throw new Error(`${REBUILD_INSTRUCTION}\n${JSON.stringify(freshness, null, 2)}`)
  }
  const project = dashboardFixtureProject('terminal-lines')
  dashboard = await spawnDashboard(project.root, project.configPath)
}, FILE_BUDGET_MS)

afterAll(async () => {
  await dashboard?.stop()
  cleanupTempRoots()
}, FILE_BUDGET_MS)

describe('the dashboard terminal', () => {
  it('prints its start line as the time, the server tag and the address with its port', () => {
    if (dashboard?.ready !== true) {
      throw new Error(
        `the spawned dashboard never said it was listening:\n${dashboard?.stdout() ?? ''}\n`
          + `${dashboard?.stderr() ?? ''}`,
      )
    }
    const lines = dashboard.stdout().split('\n')
    const start = lines.find((line) => line.includes('Dashboard running at'))
    expect(start, dashboard.stdout()).toMatch(
      new RegExp(
        '^\\d\\d:\\d\\d:\\d\\d  server     Dashboard running at '
          + `http://localhost:${String(dashboard.port)}$`,
        'u',
      ),
    )
    expect(start).not.toContain('\u001b')
  })
})
