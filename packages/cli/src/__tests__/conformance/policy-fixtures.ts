// The policy fixtures the verdict legs are driven with.
//
// WHAT THIS FILE OWNS. Two things, and neither is an expectation: the CALLERS each policy point is
// exercised under, and the execution context those points are decided in. The parity suite owns the
// verdict comparisons themselves; the scenario table owns which points each row declares. Splitting
// it that way is what keeps the fixtures from quietly encoding the answer they are supposed to be
// measuring.
//
// NO CALLER HOLDS A GRANT. Until the permission wave the covering caller
// held exactly an op's declared scopes and the refusing caller withheld one. Declarations carry no
// scopes and `invokeFunction` reads none, so the covering caller is the tokenless record every door
// now mints, and the refuse point is retired — there is no grant left to withhold. No scope is
// spelled here, and none is read.
//
// THE EXECUTION CONTEXT IS INJECTED AND NEVER READ FROM THE AMBIENT PROCESS (Pitfall 3). The shipped
// resolver answers `ci` whenever CI markers are present, so anything computed against the ambient
// context would be one answer on a laptop and another on a PR. Nothing here calls
// `getActiveExecutionContext`, reads `process.env`, or consults a TTY; the context is a constant this
// file exports and every consumer passes explicitly.

import type { FunctionDeclaration } from '@vostride/agent-qa-agent'
import { CHAT_RESOLVER_CALLER } from '@vostride/agent-qa-agent-local'
import type { ExecutionContext, FunctionCaller } from '@vostride/agent-qa-schema'

import { MCP_FUNCTION_CALLER } from '../../commands/mcp.js'

/**
 * The one execution context every conformance policy decision is taken in.
 *
 * `local-interactive`, fixed. Since 432-19 no decision depends on the context (there is no
 * fail-closed context any more); it is still injected so the surface-dispatch fixtures never read
 * the ambient one.
 */
export const CONFORMANCE_EXECUTION_CONTEXT: ExecutionContext = 'local-interactive'

// `conformanceResolveExecutionContext`, the injected resolver form, is
// deleted. Its only consumer was the registry's retired context option, deleted here too.

/** A caller record in the suite's own surface, so an audit row can never be mistaken for a host's. */
function conformanceCaller(): FunctionCaller {
  return Object.freeze({
    surface: 'conformance',
    // `human`, as before: since 432-20 the origin decides nothing, and keeping the value the suite
    // always used means a re-spelled cell differs from its old self only in the grants.
    origin: 'human',
  })
}

/**
 * The covering caller for an op: the tokenless record, holding no grant at all.
 *
 * Until 432-20 this held exactly the op's declared scopes, so a caller holding every scope could not
 * mask an op whose scopes had silently emptied. With no scopes declared or read, a caller holding
 * NOTHING is the strongest covering caller there is: anything it reaches, every caller reaches.
 */
export function coveringCallerFor(_declaration: FunctionDeclaration): FunctionCaller {
  return conformanceCaller()
}

// `refusingCallerFor` and `RefusingCallerFixture` are deleted. The refuse
// point was "the covering grant minus one scope, named"; no grant is read, so there is nothing to
// withhold and no refusal on that axis to attribute.

// ---- The two surfaces' own caller mints (397-04, legs 3 and 4) ---------------------------------

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

/**
 * The two surfaces' callers, each minted the way its own surface mints today: the chat resolver's
 * record verbatim, and the MCP door's one tokenless caller.
 *
 * They differ in `surface` and `origin`. Since 432-20 neither is read by the function
 * layer to decide anything, and since 432-21 neither record carries a grant field at all, so the two
 * must answer alike for every capability.
 */
export function surfaceShapedCallers(): SurfaceShapedCallers {
  return {
    chat: Object.freeze({ ...CHAT_RESOLVER_CALLER }),
    mcp: Object.freeze({ ...MCP_FUNCTION_CALLER }),
  }
}

/**
 * The same two callers with every field but `surface` harmonised — FUNC-03's claim, isolated: two
 * records that agree on everything else and disagree only on which surface minted them.
 */
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

/**
 * The two surfaces' callers stripped of every grant — the shortest caller each surface could hand
 * the function layer. Used by the retired refuse legs to show nothing refuses them.
 *
 * the caller's `grantedScopes` member is deleted, so the explicit empty
 * grant set is smuggled past the type with a cast — the refuse legs still hand a caller that SAYS it
 * holds nothing, and still prove nothing reads it.
 */
export function grantlessSurfaceCallers(): SurfaceShapedCallers {
  const inert = surfaceInertCallers()
  return {
    chat: Object.freeze({ ...inert.chat, grantedScopes: [] } as FunctionCaller),
    mcp: Object.freeze({ ...inert.mcp, grantedScopes: [] } as FunctionCaller),
  }
}
