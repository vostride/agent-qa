// Never mints: `get` takes an existing address, so rendering a card never writes.

import { EntitiesGetInputSchema, EntityCardSchema } from '@vostride/agent-qa-schema'
import type { EntitiesGetInput, EntityCard } from '@vostride/agent-qa-schema'

import { readEntityCardContext } from '../entity-cards/card-context.js'
import { produceEntityCard } from '../entity-cards/produce-card.js'
import { ENTITIES_GET_FUNCTION_ID } from './entities-ids.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export { ENTITIES_GET_FUNCTION_ID }

// For an address nothing minted; a tombstoned entity still resolves to a card saying so.
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
  // Absence throws, so the only returning shape is a hit.
  classify(output): ClauseVerdict {
    return { status: 'executed', outcome: `found ${output.kind} ${output.id}` }
  },
  async invoke(input, deps) {
    const descriptor = await deps.entities.get(input.ref)
    if (descriptor === undefined) throw new EntityNotFoundError(input.ref)
    // Read after the lookup, so an address naming nothing is refused without reading config.
    return produceEntityCard(descriptor, await readEntityCardContext(deps, [descriptor]))
  },
}
