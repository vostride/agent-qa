import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFunctionRegistry, invokeFunction, type FunctionDeps } from '@vostride/agent-qa-agent'
import { generateRunId } from '@vostride/agent-qa-ids'
import { asRunId, RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import { expect, it, vi } from 'vitest'
import { DashboardDatabase } from '../db/database.js'
import { createDashboardSqliteDatabase } from '../db/sqlite.js'
import { createDashboardRunDetailReader } from '../run-service/run-detail-reader.js'

it('a run stored without recordings reads each recording as absent, from its rows alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-424-cold-'))
  const dbPath = join(dir, 'history.db')
  const runId = asRunId(generateRunId())
  // 2026-10-16 (442-01, D-03): v3 files are refused, so the recording-less rows are seeded into v5.
  new DashboardDatabase({ dbPath }).close()
  const raw = createDashboardSqliteDatabase(dbPath)
  try {
    raw.prepare('INSERT INTO runs (id, name, status) VALUES (?, ?, ?)')
      .run(runId, 'Historical recording', 'passed')
    for (const testIndex of [0, 1]) {
      raw.prepare('INSERT INTO run_members (run_id, test_index, attempts) VALUES (?, ?, ?)')
        .run(runId, testIndex, 1)
      raw.prepare(`INSERT INTO run_steps (run_id, test_index, step_index, cache_status,
        verifier_verdict, self_heal_occurred, brief_digest) VALUES (?, ?, 0, ?, ?, 0, ?)`)
        .run(runId, testIndex, 'hit', JSON.stringify({ pass: true, reasoning: 'recorded' }), 'digest')
      for (const index of [0, 1]) {
        raw.prepare(`INSERT INTO run_sub_actions (run_id, test_index, step_index,
          sub_action_index, plan, planned_action, result, screen_state_hash)
          VALUES (?, ?, 0, ?, ?, ?, ?, ?)`)
          .run(runId, testIndex, index, 'recorded',
            JSON.stringify({ type: 'navigate', to: 'url', url: 'https://example.invalid' }),
            JSON.stringify({ success: true }), 'recorded')
      }
    }
  } finally { raw.close() }

  const db = new DashboardDatabase({ dbPath })
  try {
    const rows = db.readRunDetailRows(runId)!
    expect(rows.members).toHaveLength(2)
    expect(rows.members.every(member => !Object.hasOwn(member, 'recording'))).toBe(true)
    const forbidden = vi.fn(() => { throw new Error('No handoff, config or byte reconstruction') })
    const registry = createFunctionRegistry({
      deps: { runDetail: createDashboardRunDetailReader(db),
        runs: { get: forbidden }, config: { getMasked: forbidden },
        evidenceBlobs: { read: forbidden },
      } as unknown as FunctionDeps,
    })
    // 2026-10-01 (432-34, D-12): no `resolveExecutionContext` registry option and no `grantedScopes`
    // or `safeMode` on the caller; the registry reads none of them (432-20).
    const output = RunDetailProjectionSchema.parse(await invokeFunction(registry, 'runs.detail',
      { runId }, { surface: 'dashboard', origin: 'human' }))
    expect(output.members.map(member => member.recording)).toEqual([
      { state: 'absent', reason: 'unavailable' }, { state: 'absent', reason: 'unavailable' },
    ])
    expect(output.subActions).toHaveLength(4)
    for (const row of output.subActions) expect(row).not.toHaveProperty('recordingOffsetMs')
    expect(forbidden).not.toHaveBeenCalled()
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
