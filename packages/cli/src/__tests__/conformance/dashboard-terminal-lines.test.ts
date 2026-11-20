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

// The time, two spaces, a tag padded so the message starts in column 21, then the message.
const TAGGED_LINE = /^\d\d:\d\d:\d\d {2}[a-z][a-z-]* {2,}(?<=^.{21})\S/u
const CONTINUATION_LINE = /^ {21}/u

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

  it('says the queue is ready as the time, the queue tag and the slot count', () => {
    if (dashboard?.ready !== true) {
      throw new Error(
        `the spawned dashboard never said it was listening:\n${dashboard?.stdout() ?? ''}`,
      )
    }
    const ready = dashboard.stdout().split('\n').filter((line) => line.includes('Ready, '))
    expect(ready, dashboard.stdout()).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\d  queue      Ready, \d+ slots?$/u),
    ])
  })

  // The last two stop the dashboard the cells above read.
  it('says it is shutting down as the time, the server tag and the message once stopped', async () => {
    if (dashboard?.ready !== true) {
      throw new Error(
        `the spawned dashboard never said it was listening:\n${dashboard?.stdout() ?? ''}`,
      )
    }
    await dashboard.stop()
    const shutdown = dashboard
      .stdout()
      .split('\n')
      .filter((line) => line.includes('Shutting down'))
    expect(shutdown, dashboard.stdout()).toEqual([
      expect.stringMatching(/^\d\d:\d\d:\d\d  server     Shutting down dashboard\.\.\.$/u),
    ])
  }, FILE_BUDGET_MS)

  it('prints only tagged lines and their continuation lines on stdout from its start to its stop', async () => {
    if (dashboard?.ready !== true) {
      throw new Error(
        `the spawned dashboard never said it was listening:\n${dashboard?.stdout() ?? ''}`,
      )
    }
    await dashboard.stop()
    const lines = dashboard.stdout().split('\n').filter((line) => line.length > 0)
    expect(lines.filter((line) => TAGGED_LINE.test(line)).length, dashboard.stdout())
      .toBeGreaterThanOrEqual(3)
    const neither = lines.filter((line) => !TAGGED_LINE.test(line) && !CONTINUATION_LINE.test(line))
    expect(neither, dashboard.stdout()).toEqual([])
  }, FILE_BUDGET_MS)
})
