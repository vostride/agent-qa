// `sessionId` is opaque here; the adapter validates it where it becomes a path.

import { z } from 'zod'

import { CLAUSE_RECEIPT_STATUSES } from './turn-receipts'
import { CHAT_TURN_STATUSES } from './session-events'

export const ClauseReceiptSchema = z.object({
  clause: z.string(),
  functionId: z.string(),
  origin: z.string(),
  status: z.enum(CLAUSE_RECEIPT_STATUSES),
  outcome: z.string(),
})

// `payload` is the op's masked result; its contract is that op's own declared output schema.
export const ClauseResultSchema = z.object({
  functionId: z.string().min(1),
  payload: z.unknown(),
})

export type ClauseResult = z.infer<typeof ClauseResultSchema>


/**
 * What a caller asks with.
 *
 * `message` is non-empty because an empty utterance has no clause to route and the honest refusal
 * is at the contract, before a turn id is minted and a session file is touched.
 */
export const AgentAskInputSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
})

export type AgentAskInput = z.infer<typeof AgentAskInputSchema>

// `receipts` is present on every status, empty on `fail_closed`, so nothing-ran is stated.
export const AgentAskResultSchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  status: z.enum(CHAT_TURN_STATUSES),
  answer: z.string().optional(),
  receipts: z.array(ClauseReceiptSchema),
  // Required and in execution order; a fail-closed turn carries `[]`.
  results: z.array(ClauseResultSchema),
  unhandled: z.object({ clause: z.string(), reason: z.string() }).optional(),
  // A count, not the damage report; absent means the log refused nothing.
  refusedLineCount: z.number().int().positive().optional(),
})

export type AgentAskResult = z.infer<typeof AgentAskResultSchema>
