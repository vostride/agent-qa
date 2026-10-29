// run_members.outcome has no CHECK, so a word outside the
// vocabulary can be stored. Every member-history reader skips it, as neither a pass nor a fail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DashboardDatabase } from '../db/database.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { startServer } from '../server/server.js'

class IdleBackend extends EventEmitter {
  execute = (): void => undefined
  kill = (): boolean => false
  killAll = (): void => undefined
  getActiveExecutions = (): [] => []
}

const STRAY = { testId: 't_stray', name: 'Stray', filePath: 'tests/stray.yaml' }
const OUTCOMES = ['passed', 'mystery-word', 'failed'] as const

let dir: string
let dbPath: string
let configPath: string
let db: DashboardDatabase
const started: Array<{ close: () => void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-qa-444-unknown-outcome-'))
  dbPath = join(dir, 'runs.db')
  configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'testDir: tests\n')
  db = new DashboardDatabase({ dbPath })
})

afterEach(() => {
  while (started.length > 0) started.pop()?.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function seedStrayHistory(): void {
  for (const [index, outcome] of OUTCOMES.entries()) {
    const startedAt = `2026-10-01T1${String(index)}:00:00.000Z`
    const runId = db.insertRun({
      id: `run_444-stray-${String(index)}`,
      name: STRAY.name,
      status: outcome === 'failed' ? 'failed' : 'passed',
      duration: 1000,
      startedAt,
      endedAt: startedAt,
      testId: STRAY.testId,
      filePath: STRAY.filePath,
    })
    db.upsertRunMember({
      runId,
      testIndex: 0,
      testId: STRAY.testId,
      name: STRAY.name,
      filePath: STRAY.filePath,
      outcome,
    })
  }
}

async function startDashboard(): Promise<string> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db: new DashboardDatabase({ dbPath }),
    port: 0,
    configPath,
    executionBackend: new IdleBackend() as unknown as ExecutionBackend,
  })
  started.push(handle)
  const { port } = handle.server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url)
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

describe('a member outcome outside the vocabulary', () => {
  it('a member outcome outside the vocabulary is skipped by every history reader', () => {
    seedStrayHistory()

    let flaky: ReturnType<DashboardDatabase['getFlakyTests']> | undefined
    expect(() => { flaky = db.getFlakyTests({ minRuns: 1 }) }).not.toThrow()
    expect(flaky).toEqual([
      { name: STRAY.name, filePath: STRAY.filePath, totalRuns: 2, passRate: 0.5, flakyScore: 1 },
    ])

    let trends: ReturnType<DashboardDatabase['getTestTrends']> | undefined
    expect(() => { trends = db.getTestTrends({ testId: STRAY.testId }) }).not.toThrow()
    expect(trends).toMatchObject({ passRate: 0.5, totalRuns: 3 })
    expect(trends!.daily).toEqual([
      expect.objectContaining({ date: '2026-10-01', passed: 1, failed: 1, total: 3 }),
    ])
  })

  it('the tests analytics routes answer 200 beside a stray outcome', async () => {
    seedStrayHistory()
    const origin = await startDashboard()

    const listed = await getJson(`${origin}/api/analytics/tests`)
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body).toEqual({ tests: [] })

    const listedAll = await getJson(`${origin}/api/analytics/tests?minRuns=1`)
    expect(listedAll.status, JSON.stringify(listedAll.body)).toBe(200)
    expect(listedAll.body.tests).toEqual([
      {
        name: STRAY.name,
        filePath: STRAY.filePath,
        totalRuns: 2,
        passRate: 0.5,
        flakyScore: 1,
        isFlaky: true,
      },
    ])

    const viewer = await getJson(`${origin}/api/analytics/tests/Stray?testId=${STRAY.testId}`)
    expect(viewer.status, JSON.stringify(viewer.body)).toBe(200)
    expect(viewer.body.total).toBe(3)
    expect(viewer.body.trends).toMatchObject({ passRate: 0.5, totalRuns: 3 })
    expect(viewer.body.flakyScore).toBe(1)
    expect(viewer.body.isFlaky).toBe(false)
  })
})
