// The REPL and the `ask` verb are clients of this op, so no surface holds a private turn engine.

import { AgentAskInputSchema, AgentAskResultSchema } from '@vostride/agent-qa-schema'
import type { AgentAskInput, AgentAskResult } from '@vostride/agent-qa-schema'

import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'

// The literal appears once; every surface imports this constant.
export const AGENT_ASK_FUNCTION_ID = 'agent.ask'

export const agentAskSpec: FunctionSpec<AgentAskInput, AgentAskResult> = {
  id: AGENT_ASK_FUNCTION_ID,
  // Worded as an entry point, because a summary saying "one turn" made the planner recurse into it.
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
  // Not read-only: a turn can reach any write verb.
  risk: { name: `fn:${AGENT_ASK_FUNCTION_ID}`, recognized: true, readOnly: false },
  // A turn's verdict folds its clauses' receipts, and `fail_closed` is `failed`, never `refused`.
  classify(output): ClauseVerdict {
    switch (output.status) {
      case 'completed': {
        // A refused clause becomes the outer verdict's own word here.
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
