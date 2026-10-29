// `entities.resolve` — any reference in, a typed resolution out.
//
// The reference may be a short-ID, an `agentqa://` URI, or free text a human typed; the
// answer is one of exactly three arms — a hit, a small disambiguation set, or an honest miss.
// There is no fourth "best effort" arm, and that closed union is the never-guess contract in
// type form: a surface cannot render a maybe, because it is never handed one.
//
// The op does no resolution of its own. The injected directory port decides WHAT the answer
// is; this file's whole contribution is turning the store layer's descriptors into cards
// through the one producer, which is what makes the ENTY-02 claim hold at every surface that
// calls it (chat in 392, MCP in 396, the CLI here and now).

import {
  EntitiesResolveInputSchema,
  EntityCardResolutionSchema,
} from '@vostride/agent-qa-schema'
import type {
  EntitiesResolveInput,
  EntityCardResolution,
  EntityDescriptor,
  EntityResolution,
} from '@vostride/agent-qa-schema'

import { readEntityCardContext } from '../entity-cards/card-context.js'
import type { EntityCardContext } from '../entity-cards/card-context.js'
import { produceEntityCard } from '../entity-cards/produce-card.js'
import { ENTITIES_RESOLVE_FUNCTION_ID } from './entities-ids.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export { ENTITIES_RESOLVE_FUNCTION_ID }

/**
 * Descriptor union → card union, arm for arm.
 *
 * Written as an exhaustive switch rather than a spread-and-patch so a fourth arm added to the
 * resolution vocabulary later is a compile error here instead of a silently unrendered case.
 */
function renderResolution(
  resolution: EntityResolution,
  context: EntityCardContext,
): EntityCardResolution {
  switch (resolution.kind) {
    case 'resolved':
      return {
        kind: 'resolved',
        card: produceEntityCard(resolution.descriptor, context),
        score: resolution.score,
      }
    case 'ambiguous':
      return {
        kind: 'ambiguous',
        // The SAME context for every candidate — a disambiguation set whose members were
        // rendered under different contexts would put two spellings of one system's state
        // side by side in the one place a human is choosing between them.
        candidates: resolution.candidates.map((candidate) => ({
          card: produceEntityCard(candidate.descriptor, context),
          score: candidate.score,
        })),
      }
    case 'none':
      return resolution
  }
}

/**
 * Every descriptor a resolution will render a card for — the SAME exhaustive shape as
 * `renderResolution`, so the set the context is built for cannot drift from the set that is
 * rendered. A fourth resolution arm is a compile error here too.
 */
function descriptorsOf(resolution: EntityResolution): readonly EntityDescriptor[] {
  switch (resolution.kind) {
    case 'resolved':
      return [resolution.descriptor]
    case 'ambiguous':
      return resolution.candidates.map((candidate) => candidate.descriptor)
    case 'none':
      return []
  }
}

export const entitiesResolveSpec: FunctionSpec<EntitiesResolveInput, EntityCardResolution> = {
  id: ENTITIES_RESOLVE_FUNCTION_ID,
  summary: 'Resolve any entity reference to a card, a disambiguation set, or an honest miss.',
  resultKind: 'unary',
  input: EntitiesResolveInputSchema,
  output: EntityCardResolutionSchema,
  risk: { name: `fn:${ENTITIES_RESOLVE_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * THREE ARMS, ALL ANSWERS (399.1 D-01, plan 03's razor).
   *
   * `ambiguous` and `none` are the resolver refusing to GUESS, which is the never-guess contract
   * doing exactly what it promises — a resolution it will not invent is the answer to the question
   * asked, not a control declining an act. Reporting either as `refused` would send a person
   * looking for a guardrail that never fired.
   */
  classify(output): ClauseVerdict {
    switch (output.kind) {
      case 'resolved':
        return { status: 'executed', outcome: `resolved to ${output.card.id}` }
      case 'ambiguous':
        return {
          status: 'executed',
          outcome: `ambiguous — ${output.candidates.length} candidates, none picked`,
        }
      case 'none':
        return { status: 'executed', outcome: `none: ${output.reason}` }
      default:
        return output satisfies never
    }
  },
  async invoke(input, deps) {
    // Read-tier despite D-01's lazy mint, and the distinction is deliberate: minting records
    // an ADDRESS for something that already existed. It creates no entity, changes no
    // knowledge, and is invisible in every projection except the one that hands out names.
    const resolution = await deps.entities.resolve(input.ref)
    return renderResolution(
      resolution,
      // The descriptors this render is ABOUT to produce cards for — every arm of them, so an
      // ambiguous set containing one test reads the ledger once and every candidate is rendered
      // against the same fold (390). A `none` arm renders nothing and reads nothing.
      await readEntityCardContext(deps, descriptorsOf(resolution)),
    )
  },
}
