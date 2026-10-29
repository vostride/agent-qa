// The `agent.ask` op's input and output contracts.
//
// D-24 is why these are here at all: the turn entry is a REGISTERED function-layer op, and
// the REPL, the one-shot `ask` verb, 396's MCP projection and 397's parity suite are all clients of
// it. An op needs declared contracts, and a contract several surfaces render needs one spelling.
//
// `sessionId` IS OPAQUE TO THIS CONTRACT and validated where it becomes a path — the adapter checks
// it against the same safe-segment class the job checkpoint store uses, and an unknown id is a
// typed refusal rather than a silent create. A shape check here that looked like validation would
// be the more dangerous kind of guard: it would make a reader believe the string had been
// authorized when it had only been spelled acceptably.

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

/**
 * What ONE executed clause produced, on its way to a person.
 *
 * THE RECEIPT IS THE MAP AND THIS IS THE TERRITORY. `ClauseReceiptSchema` above is a five-string
 * one-line record by charter, and 392's `explainAnswerLines` comment defends that seat at
 * length — so the op's own result could not travel on it, and for forty ops it travelled nowhere at
 * all: chat executed them and printed `<op> completed`. This member is that missing
 * channel made structural rather than a second carrier bolted onto the receipt.
 *
 * `payload` IS `unknown` BY INTENTION. Forty-three ops declare forty-three output contracts, and a
 * turn result that tried to name them would either enumerate them here — a second registry, free to
 * drift from the one that dispatches — or normalise them, which is the render defect this member
 * exists to close. The op that produced it is named by `functionId`, and the contract for those
 * bytes is that op's own declared output schema, which the registry already publishes.
 *
 * THE PAYLOAD IS MASKED, AND THAT IS A CONTRACT RATHER THAN AN OBSERVATION (D-04/D-05, and the
 * 2026-08-20 D-10 adjudication's binding corollary). It carries the value the function layer
 * returned, masked, and every path this contract travels — the prompt, the cache, the session event
 * log, any `agent.ask` client — keeps it that way. Each surface prints what the declared mask
 * produced, and nothing restores a value. An unmasked value here would put op-result credentials
 * into a persisted trail, minting a new instance of a cleartext-at-rest class that has already been
 * named.
 */
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

/**
 * What a turn answers with.
 *
 * `receipts` is present on EVERY status including `fail_closed`, where it is empty — and the
 * emptiness is the assertion D-10 asks for. A fail-closed turn that omitted the field would leave
 * "nothing ran" and "the field is not reported here" as the same bytes, and `executed == 0` is the
 * exact claim the compound scenarios make.
 *
 * `unhandled` names the clause the turn could not route. It is the message D-08 requires: a turn
 * that fails closed must say WHICH part of what the person asked for it could not do.
 */
export const AgentAskResultSchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  status: z.enum(CHAT_TURN_STATUSES),
  answer: z.string().optional(),
  receipts: z.array(ClauseReceiptSchema),
  /**
   * What the clauses that RAN produced, in clause execution order (399.1, D-05).
   *
   * REQUIRED, AND A SIBLING OF `receipts` RATHER THAN A MEMBER OF ONE, on `receipts`' own argument:
   * a turn that omitted the field would leave "nothing produced a result" and "this build does not
   * report results" as the same bytes, and "the refused turn ran nothing" is precisely the claim a
   * fail-closed turn makes. So a fail-closed turn carries `[]` and says so.
   *
   * ONE ENTRY PER EXECUTED CLAUSE, so a compound turn's second op is not silently the first's. The
   * ORDER is the order the engine ran them in, which is the order the person typed them — the
   * property this whole engine preserves everywhere else.
   */
  results: z.array(ClauseResultSchema),
  // no `denials` channel. It carried what the execution gate refused,
  // with the gate's remedies; there is no gate, so nothing is refused that way.
  unhandled: z.object({ clause: z.string(), reason: z.string() }).optional(),
  /**
   * Lines of this session's log the open path could not read (392 plan 08, discharging 392-03).
   *
   * SURFACED RATHER THAN SWALLOWED. A resumed session with permanent mid-file damage comes back
   * with a non-empty list, and a surface that ignored it would re-create exactly the swallow plan
   * 03 removed — a person continuing a conversation that is quietly missing part of itself. One
   * line of output is enough, which is why this is a COUNT of what could not be read rather than
   * the damage report: the report is the file, and `chat --list` is what names the file.
   *
   * OPTIONAL, and absent means the log had nothing to refuse — which every healthy session is, so
   * a required field would put a zero on every turn of every conversation forever.
   */
  refusedLineCount: z.number().int().positive().optional(),
})

export type AgentAskResult = z.infer<typeof AgentAskResultSchema>
