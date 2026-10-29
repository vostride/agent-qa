// `not-run` keeps a clause the engine never attempted apart from one that failed.

// `refused` means a guardrail declined the op: nothing failed and nothing was carried out.
export const CLAUSE_RECEIPT_STATUSES = ['executed', 'failed', 'not-run', 'refused'] as const

export type ClauseReceiptStatus = (typeof CLAUSE_RECEIPT_STATUSES)[number]

// `outcome` is a one-line summary; a failure carries the function layer's own refusal name.
export interface ClauseReceipt {
  clause: string
  functionId: string
  origin: string
  status: ClauseReceiptStatus
  outcome: string
}

// `failed` stays outside: it covers both a pre-dispatch refusal and a mid-flight throw.
export function clauseReachedCapability(status: ClauseReceiptStatus): boolean {
  return status === 'executed' || status === 'refused'
}
