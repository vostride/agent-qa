// A closed union with no best-effort arm, so a surface is never handed a maybe.

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
  // `ambiguous` and `none` are answers, never `refused`; no guardrail fired.
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
    // Read-tier: minting records an address for an existing entity and changes no knowledge.
    const resolution = await deps.entities.resolve(input.ref)
    return renderResolution(
      resolution,
      // Every arm's descriptors, so an ambiguous set reads the ledger once and shares one fold.
      await readEntityCardContext(deps, descriptorsOf(resolution)),
    )
  },
}
