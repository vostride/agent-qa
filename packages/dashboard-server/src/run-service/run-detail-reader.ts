// The dashboard's run-detail READ ADAPTER.
//
// Reads over `DashboardDatabase.readRunDetailRows` and `getRun`, handed to the CLI composition so
// the function layer's ops can answer without this package ever seeing a registry.
//
// THE PORT TYPE IS DECLARED HERE, LOCALLY, AND THAT IS NOT A CONVENIENCE.
// `packages/dashboard-server` may not import `@vostride/agent-qa-agent` — `validate:arch` forbids
// the edge, and it forbids a TYPE-ONLY import too, because a type-only edge is still a dependency
// on another package's declaration file and still has to be resolvable at build time. It is the
// same rule that makes `AgentHost.runsDetailFunctionId` travel as a string rather than as an
// imported constant.
//
// So the shape below is a structural TWIN of `RunDetailReaderPort`, built out of types both
// packages legitimately share (`RunId` and `RunDetailRows` live in `@vostride/agent-qa-schema`,
// which dashboard-server already depends on). The CLI composition passes this object where
// `ComposeLocalAgentInput.runDetail` expects the port, and TypeScript's structural typing is the
// seam: if the two shapes ever diverge, the COMPOSITION fails to compile — which is exactly where
// a mismatch should surface, in the one file that holds both.

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
  // the row's stored status only, read through the response-safe getRun.
  readRecord(runId: RunId): Promise<{ status: string } | undefined>
}

/**
 * Bind a reader to THIS server's one database handle.
 *
 * The read is synchronous underneath (better-sqlite3) and the method is `async` anyway, because
 * the port's contract is a promise and a composition root that had to know which implementations
 * were synchronous would be a composition root that knows too much.
 *
 * THE ID IS NEVER JOINED ONTO A PATH. It is a bound parameter of a prepared statement, resolved
 * against rows the database already holds — the T-405-01 mitigation, and the same law
 * `RunsReaderPort.get` states for the handoff store.
 */
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
