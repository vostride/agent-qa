// Folded once before `startRun`; a ledger read failure answers an empty set with a warning.

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

// Active entries of this product only; a lapsed entry fails a build before the fold re-enters it.
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
