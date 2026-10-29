// `agent.ask` — the chat turn entry, as a registered capability.
//
// THIS FILE IS THE L10 ANSWER. §3's "no private powers" law says a surface may not hold a
// capability the function layer does not, and a chat REPL that owned its turn engine directly would
// be the largest such power in the system — an orchestrator that can reach every op, reachable
// itself through nothing the catalogue declares. Registering the turn entry inverts that: the REPL
// and the `ask` verb are CLIENTS of `agent.ask` exactly as they are clients of `runs.list`, 396's
// MCP projection picks it up from the registry with no chat-specific code, and 397's parity suite
// asserts chat ≡ registry without a carve-out.
//
// OP CALLS OP, WHICH IS ORDINARY COMPOSITION. A turn invokes other capabilities, and each of those
// invocations crosses `invokeFunction` on its own with the caller the composition minted for its
// stage — so a clause the turn runs passes the same pipeline as the turn itself: input validation,
// the binding check and output validation, each clause with its own receipt.
//
// NO SCOPE AND NO ORIGIN RULE. This op once declared
// `requiredScopes: ['read']` as the right to START a turn, with the per-clause scope checks and
// `requiresHumanOrigin` deciding each clause's reach. All three are deleted: every door can call
// every operation, so a turn and the clauses it plans are served to any caller alike.
//
// `agent.chat` IS DELIBERATELY NOT HERE. The session-stateful sibling waits for a consumer
// (RESEARCH Open Q3): shipping it now would mint a second entry with no client, and 397's parity
// suite would then require a stub of it on every surface.

import { AgentAskInputSchema, AgentAskResultSchema } from '@vostride/agent-qa-schema'
import type { AgentAskInput, AgentAskResult } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

/**
 * Lowercase dot taxonomy: the `agent.` domain's first verb.
 *
 * The literal appears exactly once, here. Every surface that names it — the `ask` command today,
 * the REPL and the MCP projection later — imports this constant, so the parity suite and the
 * catalogue read the same string as the dispatcher.
 */
export const AGENT_ASK_FUNCTION_ID = 'agent.ask'

export const agentAskSpec: FunctionSpec<AgentAskInput, AgentAskResult> = {
  id: AGENT_ASK_FUNCTION_ID,
  // THE SUMMARY SAYS "ENTRY POINT", and that wording is a fix rather than a flourish (392-09, from
  // the first live gate run). D-07 projects every registry op 1:1 into the planner's tool set, so
  // this op is a tool the planner is offered WHILE IT IS INSIDE ONE OF ITS OWN TURNS. Described as
  // "run one conversational turn", it read to the model as the natural home for any conversational
  // request: a plain request to list runs was planned as `agent.ask` twice out of two live runs,
  // and the recursive turn then failed — so a person asking for a capability in prose got a failed
  // turn instead of the capability. The repair is DESCRIPTION, not exclusion. Hiding a tool would
  // break the always-send-all law and D-07's registry projection, and it would be the wrong
  // diagnosis anyway: the tool was not misclassified, it was misdescribed. Every consumer of this
  // string — the catalogue, `fn --list`, 396's MCP listing, the planner — is better served by the
  // sentence that says what the op is FOR.
  summary: 'The chat entry point: begin ONE new conversational turn from outside a conversation. '
    + 'Surfaces (a REPL, the ask verb, an MCP client) call this to START a turn — it is not a way '
    + 'to carry out a request while a turn is already running. It routes the utterance, executes '
    + 'what it resolves to, and answers with per-clause receipts.',
  resultKind: 'unary',
  // Bound where a composition assembles a turn engine. A host with no engine lists this
  // `unbound` BY NAME rather than answering an empty turn — which would tell a person their
  // request was understood and produced nothing, the one wrong answer that stops them asking.
  boundThrough: 'chatTurn',
  input: AgentAskInputSchema,
  output: AgentAskResultSchema,
  // `readOnly: false`, and the honesty matters more here than on any other op in the catalogue: a
  // turn is a variable-reach capability, so describing it as a read would let a risk ladder treat
  // the door to every write verb as the cheapest thing in the registry. (2026-10-01, 432-26: the
  // descriptor is a classification; no gate reads it to ask or deny.)
  risk: { name: `fn:${AGENT_ASK_FUNCTION_ID}`, recognized: true, readOnly: false },
  /**
   * A TURN's own report of how it went.
   *
   * A TURN IS A COMPOSITION, SO ITS VERDICT IS A FOLD OF ITS CLAUSES' VERDICTS. This used to fold
   * the turn STATUS alone, on the argument that the per-clause verdicts were already receipts and
   * reading them here would be a second opinion. That argument is the recorded belief that produced
   * gap 1: a turn whose only clause was REFUSED by a credential guardrail reported `executed` one
   * composition layer up, and the person reading the outer line was told a blocked mutation had been
   * carried out. The receipts are not a second opinion about the turn — they ARE the turn, and the
   * status is a summary of them. Success is the one claim a fold may never default to (D-03's
   * asymmetry): where the clauses do not support it, the outer word must say what they do support.
   *
   * `fail_closed` IS `failed` AND NOT `refused`. D-02 minted `refused` for a GUARDRAIL declining an
   * op; a fail-closed turn is the ENGINE abandoning the clauses after one of them broke, which is
   * an operation that did not complete. Reporting it `refused` would tell a person a control
   * declined their request when what happened is that something went wrong.
   *
   * AND THERE IS DELIBERATELY NO `failed` SCAN OVER THE RECEIPTS HERE. Post-399.1-09 the
   * engine derives its aggregate from the same vocabulary, so it can no longer answer `completed`
   * over a `failed` receipt; a second mechanism second-guessing the first is the redundant-mechanism
   * failure mode this project has already paid for, and it would hide a regression in the engine
   * rather than surface it.
   */
  classify(output): ClauseVerdict {
    switch (output.status) {
      case 'completed': {
        // THE REFUSAL FACT TRAVELS ON `receipts[]` (D-12 point 3): the turn-status vocabulary stays
        // three members, and this is where a refused clause becomes the outer clause's own word.
        const refused = output.receipts.filter((receipt) => receipt.status === 'refused').length
        if (refused > 0) {
          return {
            status: 'refused',
            outcome:
              `turn completed — ${refused} of ${output.receipts.length} clause(s) refused`,
          }
        }
        return {
          status: 'executed',
          outcome: `turn completed — ${output.results.length} clause result(s)`,
        }
      }
      case 'fail_closed':
        return { status: 'failed', outcome: 'fail_closed: the turn carried nothing out' }
      case 'failed':
        return { status: 'failed', outcome: 'the turn failed' }
      default:
        return output.status satisfies never
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const turn = deps.chatTurn
    // An explicit presence check rather than a try/catch, on the `runs-digest.ts` reasoning:
    // swallowing would also swallow a real failure inside a bound engine.
    if (turn === undefined) {
      throw new FunctionNotBoundError(AGENT_ASK_FUNCTION_ID)
    }
    return turn.runTurn(input)
  },
}
