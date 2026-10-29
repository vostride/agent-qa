// Entity renderings for the D-06 projection, under the §5.3 embed-human-renderings law.
//
// Two audiences, one descriptor, and keeping them apart is the whole point.
//
// The DENSE leg indexes MEANING. What it must be able to answer is "the test where we buy
// something" -> the checkout test, and the only text that can support that is text a human
// would recognise: the kind said in words, the title as somebody wrote it. An opaque machine
// id contributes nothing an embedding model can use and actively costs — it is a long token
// of noise sitting inside a vector that has a fixed budget of meaning.
//
// The LEXICAL leg indexes IDENTITY. `TST-001`, the URI and the machine id are exact handles:
// they either match or they do not, and BM25 over the identity column is exactly the right
// instrument for that. They live there and nowhere else.
//
// The one deliberate crossing is slug-addressed kinds: a target's machine id ALREADY is
// the human name its config gave it, so `checkout-web` is meaning, not a digest. Its words are
// split out and embedded, because refusing to would make the one kind whose machine id is
// readable the one kind semantic phrasing could not find.

import { ENTITY_URI_SEGMENTS, isSlugAddressedKind } from '@vostride/agent-qa-schema'
import type { EntityDescriptor } from '@vostride/agent-qa-schema'

/** The four columns one entity projects onto: three FTS fields plus the embedded text. */
export interface EntityRendering {
  /** Exact handles, weighted highest by the lexical leg. Never embedded. */
  readonly identity: string
  /** The human title, as the owning store reports it. */
  readonly content: string
  /** Situating words: the kind said in words, plus slug words where the id is a name. */
  readonly context: string
  /** The §5.3 human rendering the dense leg embeds. */
  readonly embedding: string
}

/**
 * Split a slug into the words a reader would say.
 *
 * `checkout-web` is two words to a human and one token to the FTS tokenizer, whose
 * `tokenchars` deliberately keep `-` inside a token so that `MEM-001` stays one address. That
 * is right for identity and wrong for meaning, so meaning gets the split form.
 */
function slugWords(slug: string): string[] {
  return slug.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')
}

function meaningWords(descriptor: EntityDescriptor): string[] {
  return isSlugAddressedKind(descriptor.kind) ? slugWords(descriptor.machineId) : []
}

/**
 * The text embedded for one entity (§5.3).
 *
 * The kind word comes from the URI-segment table rather than a second vocabulary spelled here:
 * `memory` is already the word this system uses for `MEM` in a path a human reads, and two
 * tables naming the same five kinds is two tables to keep in step.
 *
 * The status is deliberately absent. Nearly every entity is `active`, so embedding it would
 * add one high-frequency token to every vector in the corpus — carrying no signal while
 * diluting the ones that do. A caller who wants "the quarantined tests" is asking a filter
 * question, not a similarity question.
 */
export function renderEntityForEmbedding(descriptor: EntityDescriptor): string {
  return [
    ENTITY_URI_SEGMENTS[descriptor.kind],
    descriptor.title,
    ...meaningWords(descriptor),
  ].filter((part) => part !== '').join(' ')
}

/** Project one descriptor onto its four indexed columns. */
export function renderEntity(descriptor: EntityDescriptor): EntityRendering {
  const identity = [descriptor.shortId, descriptor.uri, descriptor.machineId]
  // A recorded rename keeps the predecessor findable by the successor's handle too, which is
  // what makes an old CI log's short-ID an explanation rather than a dead end.
  if (descriptor.successorMachineId !== undefined) identity.push(descriptor.successorMachineId)

  return {
    identity: identity.join(' '),
    content: descriptor.title,
    context: [ENTITY_URI_SEGMENTS[descriptor.kind], ...meaningWords(descriptor)].join(' '),
    embedding: renderEntityForEmbedding(descriptor),
  }
}
