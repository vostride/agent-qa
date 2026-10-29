// The card's `url` contract — the M5 route shape, pinned now.
//
// D-10 says the field is CONFIG-DERIVED and ABSENT by default, and that the shape is pinned
// in v52 so M5 builds routes to match the cards rather than the other way round. Pinning it
// here — in `schema`, beside the card contract the field lives on — rather than inside the
// producer is what makes that promise reachable: the M5 route table imports this constant, so
// "the dashboard's routes and the cards' links agree" is one declaration rather than two that
// were written from the same sentence.
//
// The route is a TEMPLATE with named parameters rather than a formatting function's private
// string, because a router consumes the template and a card consumes the rendering, and both
// have to be able to name the same thing.

import { slugBranch } from '../ids/slug'
import { ENTITY_URI_SEGMENTS } from './kinds'
import type { EntityKind } from './kinds'

/**
 * THE canonical entity route (D-10, spec `…/t/<ws>/<kind>/<short-id>/<slug>`).
 *
 * The `:kind` segment is the URI-SEGMENT word (`memory`, not `MEM`), the same vocabulary
 * `agentqa://` uses, so a reader who has seen one address form can read the other. `:slug` is
 * decorative — the address is `:kind` + `:shortId`, and the slug exists so a pasted link says
 * what it points at.
 */
export const ENTITY_URL_ROUTE = '/t/:workspace/:kind/:shortId/:slug'

/** The route's parameters, in the order they appear. Exported so a router can check itself. */
export const ENTITY_URL_ROUTE_PARAMS = ['workspace', 'kind', 'shortId', 'slug'] as const

/**
 * The slug's length cap.
 *
 * A cap rather than no cap because a title is free text and a bundle summary can be a
 * sentence; a link whose decorative tail is longer than the message it was pasted into is
 * worse than one that is truncated. Retune from what real titles look like.
 */
export const ENTITY_URL_SLUG_MAX_LENGTH = 60

/**
 * The title → slug rendering.
 *
 * Delegates to `slugBranch`, which is the repo's ONE security-reviewed path-segment
 * sanitizer. Writing a second one here would be a second answer to
 * "what characters may appear in a segment", and a URL segment is exactly the place a
 * traversal sequence would be worth smuggling. Its `default` fallback for an empty result is
 * kept verbatim for the same reason: one sanitizer, one fallback.
 *
 * Lower-cased after sanitising, and only after: case folding is a display convention for
 * links, while the sanitiser's job is which BYTES are legal, and doing them in one pass would
 * make the security rule depend on the cosmetic one.
 */
export function entityTitleSlug(title: string): string {
  return slugBranch(title).toLowerCase().slice(0, ENTITY_URL_SLUG_MAX_LENGTH)
}

export interface EntityUrlInput {
  /** The configured dashboard base. An origin, or an origin with a path prefix. */
  readonly baseUrl: string
  readonly workspace: string
  readonly kind: EntityKind
  readonly shortId: string
  readonly title: string
}

/**
 * Render one entity's dashboard URL, or `undefined` when the inputs cannot produce an honest
 * one.
 *
 * ABSENCE IS A RESULT, never a throw and never a partial link. D-10's whole point is that a
 * card never shows a dead link, so a base that does not parse, a base with no host, and an
 * empty workspace all come back `undefined` — and the producer then omits the field, which is
 * the same state as "no dashboard is configured". A caller cannot tell the two apart, and
 * deliberately so: both mean "there is no page to send you to".
 *
 * The base's query and fragment are dropped rather than merged. A base carrying either is a
 * configuration mistake, and inheriting it onto every entity link would propagate the mistake
 * to every card instead of to the one place it was written.
 */
export function formatEntityUrl(input: EntityUrlInput): string | undefined {
  if (input.workspace.trim() === '') return undefined

  let base: URL
  try {
    base = new URL(input.baseUrl)
  } catch {
    return undefined
  }
  if (base.host === '') return undefined

  const path = ENTITY_URL_ROUTE
    .replace(':workspace', encodeURIComponent(input.workspace))
    .replace(':kind', ENTITY_URI_SEGMENTS[input.kind])
    .replace(':shortId', encodeURIComponent(input.shortId))
    .replace(':slug', encodeURIComponent(entityTitleSlug(input.title)))

  const prefix = base.pathname.replace(/\/+$/u, '')
  base.pathname = `${prefix}${path}`
  base.search = ''
  base.hash = ''
  return base.toString()
}
