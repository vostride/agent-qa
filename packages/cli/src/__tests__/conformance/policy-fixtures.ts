// The context is injected, never read from the process: CI markers would change the answer.

import type { FunctionDeclaration } from '@vostride/agent-qa-agent'
import { CHAT_RESOLVER_CALLER } from '@vostride/agent-qa-agent-local'
import type { ExecutionContext, FunctionCaller } from '@vostride/agent-qa-schema'

import { MCP_FUNCTION_CALLER } from '../../commands/mcp.js'

// Injected so the surface-dispatch fixtures never read the ambient context.
export const CONFORMANCE_EXECUTION_CONTEXT: ExecutionContext = 'local-interactive'

/** A caller record in the suite's own surface, so an audit row can never be mistaken for a host's. */
function conformanceCaller(): FunctionCaller {
  return Object.freeze({
    surface: 'conformance',
    // Origin decides nothing; the value is kept as provenance.
    origin: 'human',
  })
}

// A caller holding nothing is the strongest covering caller: what it reaches, all reach.
export function coveringCallerFor(_declaration: FunctionDeclaration): FunctionCaller {
  return conformanceCaller()
}

// ---- The surfaces' own caller mints ----

/**
 * One capability's caller, as each rostered surface would mint it.
 *
 * BOTH SIDES ARE PRODUCED BY THE SURFACE THAT OWNS THEM, and that is the whole point of this type
 * existing rather than a `surface` argument on one builder. `CHAT_RESOLVER_CALLER` is the frozen
 * record `composeLocalAgent` returns from its own `mint.forStage`; `MCP_FUNCTION_CALLER` is the record
 * `commands/mcp.ts` composes its server with. A parity assertion whose two comparands came out of
 * ONE builder with a different string is a value compared to itself.
 */
export interface SurfaceShapedCallers {
  readonly chat: FunctionCaller
  readonly mcp: FunctionCaller
}

// They differ in `surface` and `origin`, which the function layer never reads; same answers.
export function surfaceShapedCallers(): SurfaceShapedCallers {
  return {
    chat: Object.freeze({ ...CHAT_RESOLVER_CALLER }),
    mcp: Object.freeze({ ...MCP_FUNCTION_CALLER }),
  }
}

// Every field but `surface` harmonised: two records disagreeing only on which surface minted them.
export function surfaceInertCallers(): SurfaceShapedCallers {
  const shaped = surfaceShapedCallers()
  return {
    chat: shaped.chat,
    mcp: Object.freeze({
      ...shaped.mcp,
      origin: shaped.chat.origin,
    }),
  }
}

// The empty grant set rides a cast, so the refuse legs still prove nothing reads it.
export function grantlessSurfaceCallers(): SurfaceShapedCallers {
  const inert = surfaceInertCallers()
  return {
    chat: Object.freeze({ ...inert.chat, grantedScopes: [] } as FunctionCaller),
    mcp: Object.freeze({ ...inert.mcp, grantedScopes: [] } as FunctionCaller),
  }
}
