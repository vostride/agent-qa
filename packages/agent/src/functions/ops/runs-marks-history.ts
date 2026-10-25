// 2026-09-15, 423 D-19: every mark on a run in ordinal order, with read-time supersession. Pure
// observation through the feedbackReads port. 2026-09-30, 432-09 (D-04/D-25): each applied knowledge
// fix carries the records it changed, read now; nothing is read from a proposal store.
import {
  RunsMarksHistoryInputSchema, RunsMarksHistoryResultSchema, markAddressKey, maskRecordContent,
} from '@vostride/agent-qa-schema'
import type {
  MarkHistoryChangedRecord, MarkHistoryEntry, MarkReceipt, MaskFn, RunsMarksHistoryInput, RunsMarksHistoryResult,
} from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'
import { requireSecretMask } from './secret-mask.js'

export const RUNS_MARKS_HISTORY_FUNCTION_ID = 'runs.marks.history'

// Joined record content is masked exactly as runs.knowledge masks it; ids and absences stay structural.
function maskChangedRecord(record: MarkHistoryChangedRecord, mask: MaskFn): MarkHistoryChangedRecord {
  return record.recordContent === undefined ? record
    : { ...record, recordContent: maskRecordContent(record.recordContent, mask) }
}

// Only free text crosses the mask. Ids, kinds, counts, paths and addresses stay structural.
function projectEntry(receipt: MarkReceipt, changedRecords: readonly MarkHistoryChangedRecord[] | undefined,
  supersededBy: string | undefined, mask: MaskFn): MarkHistoryEntry {
  return {
    markId: receipt.markId,
    runId: receipt.runId,
    testIndex: receipt.testIndex,
    ...(receipt.testId === undefined ? {} : { testId: receipt.testId }),
    ...(receipt.stepIndex === undefined ? {} : { stepIndex: receipt.stepIndex }),
    kind: receipt.kind,
    origin: receipt.origin,
    ordinal: receipt.ordinal,
    markedAt: receipt.markedAt,
    ...(receipt.note === undefined ? {} : { note: mask(receipt.note) }),
    ...(receipt.rootCause === undefined ? {} : {
      rootCause: { class: receipt.rootCause.class, producer: mask(receipt.rootCause.producer) },
    }),
    ...(receipt.isRerun === undefined ? {} : { isRerun: receipt.isRerun }),
    disposition: receipt.disposition,
    evidence: receipt.evidence,
    ...(receipt.supersedes === undefined ? {} : { supersedes: receipt.supersedes }),
    active: supersededBy === undefined,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(changedRecords === undefined ? {} : { changedRecords: changedRecords.map(record => maskChangedRecord(record, mask)) }),
  }
}

export const runsMarksHistorySpec: FunctionSpec<RunsMarksHistoryInput, RunsMarksHistoryResult> = {
  id: RUNS_MARKS_HISTORY_FUNCTION_ID,
  summary: 'Read every mark on a run in ordinal order with supersession and what each applied fix changed.',
  resultKind: 'unary',
  boundThrough: 'feedbackReads',
  input: RunsMarksHistoryInputSchema,
  output: RunsMarksHistoryResultSchema,
  risk: { name: `fn:${RUNS_MARKS_HISTORY_FUNCTION_ID}`, recognized: true, readOnly: true },
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'history':
        return { status: 'executed', outcome: `history: ${output.entries.length} ${output.entries.length === 1 ? 'mark' : 'marks'}` }
      case 'run-not-found':
        return { status: 'refused', outcome: 'run not found at the requested address' }
      case 'ledger-corrupt':
        return { status: 'failed', outcome: `mark ledger is corrupt at line ${output.line}` }
      case 'ledger-unavailable':
        return { status: 'failed', outcome: 'mark ledger is unavailable' }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps) {
    const { runId } = RunsMarksHistoryInputSchema.parse(input)
    const reads = deps.feedbackReads
    if (reads === undefined) throw new FunctionNotBoundError(RUNS_MARKS_HISTORY_FUNCTION_ID)
    const read = await reads.history(runId)
    if (read.kind !== 'history') return RunsMarksHistoryResultSchema.parse({ ...read, runId })

    // The ledger's line order is the ordinal order; a permuted or foreign read is corrupt, never re-sorted.
    const receipts = read.entries.map(entry => entry.receipt)
    const misplaced = receipts.findIndex((receipt, index) => receipt.ordinal !== index + 1 || receipt.runId !== runId)
    if (misplaced !== -1) return { kind: 'ledger-corrupt', runId, line: misplaced + 1 }

    // Latest-wins per address (419 D-11): a receipt is superseded by the next mark on its address.
    const supersededBy: (string | undefined)[] = []
    const nextOnAddress = new Map<string, string>()
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
      const key = markAddressKey(receipts[index]!)
      supersededBy[index] = nextOnAddress.get(key)
      nextOnAddress.set(key, receipts[index]!.markId)
    }

    const mask = requireSecretMask(deps, RUNS_MARKS_HISTORY_FUNCTION_ID)
    return RunsMarksHistoryResultSchema.parse({
      kind: 'history',
      runId,
      entries: read.entries.map((entry, index) => projectEntry(entry.receipt, entry.changedRecords, supersededBy[index], mask)),
    })
  },
}
