// One receipt line for chat and `ask`; the outcome renders for every receipt, never a payload.

import type { ClauseReceipt, ClauseReceiptStatus } from '@vostride/agent-qa-schema'
import pc from 'picocolors'

/**
 * One receipt line: what ran, how it went, the op's own name — and what it cost.
 *
 * The outcome rides a second indented line rather than the tail of the first, because the sentence
 * it carries is a full clause on the ops that have something to report and would push the clause a
 * person typed off the edge of a terminal on the ones that do not.
 */
export function receiptLine(receipt: ClauseReceipt): string {
  return `  ${STATUS_STYLE[receipt.status](receipt.status)}  ${pc.bold(receipt.functionId)}`
    + `  ${pc.dim(receipt.clause)}\n    ${pc.dim(receipt.outcome)}`
}

// A total record, so a new status fails to compile; `refused` is yellow, apart from the rest.
const STATUS_STYLE = {
  executed: pc.green,
  failed: pc.red,
  refused: pc.yellow,
  'not-run': pc.dim,
} as const satisfies Record<ClauseReceiptStatus, (text: string) => string>

