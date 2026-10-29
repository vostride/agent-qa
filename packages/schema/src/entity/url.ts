// Pinned in `schema` so the dashboard's routes and the cards' links are one declaration.

import { slugBranch } from '../ids/slug'
import { ENTITY_URI_SEGMENTS } from './kinds'
import type { EntityKind } from './kinds'

// `:kind` is the URI segment word (`memory`, not `MEM`); `:slug` is decorative, not address.
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

// Lower-cased only after sanitising, so the security rule never depends on the cosmetic one.
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

// A base that cannot produce an honest link yields `undefined`, never a throw or a partial link.
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
