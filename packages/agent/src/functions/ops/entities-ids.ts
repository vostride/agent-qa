// The `entities.` domain's function ids.
//
// A new domain in the fixed dot-namespaced taxonomy, exactly as `knowledge.` was in 384 —
// two read-tier verbs over which every surface's entity resolution and rendering flows.
//
// The two consts live in their own module for a structural reason rather than a stylistic
// one: the card producer advertises `entities.get` as a registry action, and the
// `entities.get` op renders through the producer. Declaring the ids beside either op would
// close that loop into an import cycle; declaring them here means the id is one value with
// one definition, and both files import it in one direction.

export const ENTITIES_RESOLVE_FUNCTION_ID = 'entities.resolve'

export const ENTITIES_GET_FUNCTION_ID = 'entities.get'
