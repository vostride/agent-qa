// A structural twin of the agent's `RunDetailReaderPort`, as this package may not import agent.

import type { RunDetailRows, RunId } from '@vostride/agent-qa-schema'

import type { DashboardDatabase } from '../db/database.js'

/**
 * What a run-detail reader is, spelled in this package's own vocabulary.
 *
 * Absence is a RESULT — `undefined` means no run is recorded under that id — and it
 * is deliberately not a refusal: turning it into one is the op's job, so the "not found" word is
 * minted once, in the layer every surface shares, rather than once per adapter.
 */
export interface DashboardRunDetailReader {
  read(runId: RunId): Promise<RunDetailRows | undefined>
  // The row's stored status only, read through the response-safe `getRun`.
  readRecord(runId: RunId): Promise<{ status: string } | undefined>
}

// The id is a bound statement parameter, never joined onto a path.
export function createDashboardRunDetailReader(db: DashboardDatabase): DashboardRunDetailReader {
  return {
    read(runId: RunId): Promise<RunDetailRows | undefined> {
      return Promise.resolve(db.readRunDetailRows(String(runId)))
    },
    readRecord(runId: RunId): Promise<{ status: string } | undefined> {
      const row = db.getRun(String(runId))
      return Promise.resolve(row === undefined ? undefined : { status: row.status })
    },
  }
}
