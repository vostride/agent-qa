// The run-start quarantine snapshot.
//
// THIS is where the committed ledger becomes run input: fold it ONCE before `startRun`, hand the
// resolved set to the run as plain data on RunConfig. The runner gains zero ports and stays
// storageNeutral, and the disposition is deterministic for the whole run — a mid-run ledger edit
// can never retroactively change a running build. It mirrors how `executionContext` is resolved
// once at run start.
//
// WHY IT LIVES HERE rather than beside the run command that calls it: the CLI's shipped source no
// longer names the knowledge package at all (2026-08-02, Phase 387 plan 09 D-20 removed it from
// that contract), and the surface firewall ledger only shrinks — a new leak is fixed, not waived.
// The local composition root is the sanctioned home for knowledge access, and this file takes the
// READER entry, beside `knowledge-reader.ts`: the snapshot opens nothing, writes nothing and holds
// no lease. The writer entry keeps its single importer.
//
// One helper serves BOTH `startRun` composition sites (the multi-suite path and the direct
// single-test path) so neither can drift into a second spelling of the rule.
//
// DEGRADATION: a ledger read failure answers an EMPTY set with a printed warning, never
// an abort. A broken or hand-mangled quarantine file must never be able to stop a run — the worst
// it can do is withhold suppression, which fails builds loudly rather than passing them silently.

import { slugBranch } from '@vostride/agent-qa-schema'
import type { QuarantineAppliedEntry } from '@vostride/agent-qa-schema'
import {
  QUARANTINE_LEDGER_FILENAME,
  foldQuarantineLedgerState,
  readQuarantineLedger,
} from '@vostride/agent-qa-knowledge-local/reader'

export interface RunQuarantineSnapshotInput {
  /** The committed knowledge root, already resolved (`resolveKnowledgeRoot`). */
  knowledgeRoot: string
  /** The run's RAW product / scope key; slugged here to match the projection partition law. */
  product: string
  /** Run-start instant as an ISO-8601 string — the ONE clock read, made by the caller. */
  now: string
  warn?: (message: string) => void
}

/**
 * Resolve the entries this run will apply: active (`'quarantined'`) and belonging to this run's
 * product. Expired entries are deliberately EXCLUDED — a lapsed entry's test fails builds again
 * and released entries are gone.
 *
 * Measured consequence worth knowing at THIS seam, because this is where the exclusion is decided:
 * for a test still crossing the threshold that is exactly ONE red build. The snapshot below is
 * taken at run start (entry lapsed ⇒ not applied ⇒ red), and that same run's post-run fold
 * re-enters it with a fresh full-lifetime deadline before the next run takes its own snapshot. No
 * human is scheduled into that loop at any point, and nothing bounds the repetition
 * (measured 2026-08-06).
 */
export function resolveRunQuarantineSnapshot(
  input: RunQuarantineSnapshotInput,
): readonly QuarantineAppliedEntry[] {
  const warn = input.warn ?? ((): void => {})
  const product = slugBranch(input.product)

  let read: ReturnType<typeof readQuarantineLedger>
  try {
    read = readQuarantineLedger(input.knowledgeRoot)
  } catch (error) {
    // Includes the typed version refusal: a ledger this build cannot read is surfaced loudly and
    // then treated as absent for THIS run. Suppressing nothing is the safe direction.
    warn(
      `${QUARANTINE_LEDGER_FILENAME} could not be read (${
        error instanceof Error ? error.message : String(error)
      }); no test is quarantined for this run`,
    )
    return []
  }

  if (read.refusedLines.length > 0) {
    // Refusal-as-data reaching a human: the healthy entries still apply, and the damaged lines are
    // named by line number so they can be fixed in the file they live in.
    warn(
      `${QUARANTINE_LEDGER_FILENAME} has ${read.refusedLines.length} unreadable line(s) — ${read.refusedLines
        .map((refused) => `line ${refused.lineNumber}: ${refused.reason}`)
        .join('; ')}`,
    )
  }

  return foldQuarantineLedgerState(read.events, input.now)
    .filter((entry) => entry.state === 'quarantined' && entry.product === product)
    .map((entry) => ({
      product: entry.product,
      filePath: entry.filePath,
      testName: entry.testName,
      expiresAt: entry.expiresAt,
    }))
}
