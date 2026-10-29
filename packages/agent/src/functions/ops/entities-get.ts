// `entities.get` — one exact address in, one card out.
//
// The simple read path. `entities.resolve` answers the hard question ("what did the user
// mean?"); this one answers the easy one ("render the thing at this address"), and keeping
// them apart is what lets 396 project this op onto an MCP Resource Template — a template
// needs a total function of an address, not a union that might come back ambiguous.
//
// It never mints. `resolve` sights and may therefore assign an address; `get` is
// handed an address that already exists, and a `get` that could write would turn every card
// render on every surface into a potential mutation.

import { EntitiesGetInputSchema, EntityCardSchema } from '@vostride/agent-qa-schema'
import type { EntitiesGetInput, EntityCard } from '@vostride/agent-qa-schema'

import { readEntityCardContext } from '../entity-cards/card-context.js'
import { produceEntityCard } from '../entity-cards/produce-card.js'
import { ENTITIES_GET_FUNCTION_ID } from './entities-ids.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export { ENTITIES_GET_FUNCTION_ID }

/**
 * No entity is addressed by this reference.
 *
 * A typed refusal rather than an `undefined` result, on the `RunNotFoundError` precedent: the
 * absence is the ANSWER to a caller who asked for one specific thing, and a surface needs to
 * be able to phrase it. Note what it does not mean — a permanently minted address whose
 * entity has since been tombstoned still RESOLVES, to a card whose status says so.
 * This error is for an address nothing ever minted.
 */
export class EntityNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`No entity is addressed by ${ref}`)
    this.name = 'EntityNotFoundError'
  }
}

export const entitiesGetSpec: FunctionSpec<EntitiesGetInput, EntityCard> = {
  id: ENTITIES_GET_FUNCTION_ID,
  summary: 'Render the entity card for one exact short-ID or agentqa:// URI.',
  resultKind: 'unary',
  input: EntitiesGetInputSchema,
  output: EntityCardSchema as FunctionSpec<EntitiesGetInput, EntityCard>['output'],
  risk: { name: `fn:${ENTITIES_GET_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * A card that came back is a card that was found.
   *
   * Absence is a THROW here (`EntityNotFoundError`), not an arm, so the one returning shape is a
   * hit. THE ADDRESS AND NOTHING ELSE: `kind` and `id` are the card's own name, and every fact on
   * it travels on `results[]`.
   */
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: `found ${output.kind} ${output.id}` }
  },
  async invoke(input, deps) {
    const descriptor = await deps.entities.get(input.ref)
    if (descriptor === undefined) throw new EntityNotFoundError(input.ref)
    // The render context is read HERE, not inside the producer, so the producer stays a pure
    // synchronous function of values. Read after the lookup: an address that names
    // nothing is refused without touching configuration at all.
    return produceEntityCard(descriptor, await readEntityCardContext(deps, [descriptor]))
  },
}
