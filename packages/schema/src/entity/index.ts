// The entity addressing vocabulary.
//
// Everything the agent can point at gets one address and one card shape, and both are minted
// HERE rather than in the package that happens to store the entity. That is what
// lets the resolver, the ops, the CLI and — later — chat and MCP share one contract instead
// of four compatible ones.

export {
  ENTITY_FIRST_ORDINAL,
  ENTITY_KINDS,
  ENTITY_ORDINAL_MIN_DIGITS,
  ENTITY_URI_SEGMENTS,
  SLUG_ADDRESSED_ENTITY_KINDS,
  canonicalShortId,
  entityKindForUriSegment,
  entityUriSegmentFor,
  formatEntityOrdinal,
  formatOrdinalShortId,
  formatSlugShortId,
  isEntityKind,
  isSlugAddressedKind,
  parseShortId,
} from './kinds'
export type { EntityKind, EntityUriSegment, ParsedShortId } from './kinds'

export {
  ENTITY_URI_SCHEME,
  EntityUriSchema,
  formatEntityUri,
  isEntityUri,
  parseEntityUri,
} from './uri'
export type { ParsedEntityUri } from './uri'

export {
  ENTITY_DASHBOARD_ROUTES,
  ENTITY_DASHBOARD_ROUTE_GRAINS,
  isRoutedEntityKind,
} from './dashboard-route'
export type { EntityDashboardRoute, EntityDashboardRouteGrain } from './dashboard-route'

export {
  ActionRefSchema,
  ENTITY_CARD_MAX_ACTIONS,
  ENTITY_CARD_MAX_KEY_FACTS,
  ENTITY_IDENTITY_FACT_LABELS,
  ENTITY_STATUSES,
  EntityCardSchema,
  KeyFactSchema,
} from './entity-card'
export type {
  ActionRef,
  EntityCard,
  EntityStatus,
  EntityStatusFor,
  KeyFact,
} from './entity-card'

export {
  ENTITY_URL_ROUTE,
  ENTITY_URL_ROUTE_PARAMS,
  ENTITY_URL_SLUG_MAX_LENGTH,
  entityTitleSlug,
  formatEntityUrl,
} from './url'
export type { EntityUrlInput } from './url'

export {
  ENTITY_EXACT_MATCH_SCORE,
  ENTITY_NO_MATCH_REASONS,
  ENTITY_RESOLUTION_MAX_CANDIDATES,
  EntitiesGetInputSchema,
  EntitiesResolveInputSchema,
  EntityCardResolutionSchema,
  EntityDescriptorSchema,
  EntityResolutionSchema,
} from './resolution'
export type {
  EntitiesGetInput,
  EntitiesResolveInput,
  EntityCardResolution,
  EntityDescriptor,
  EntityNoMatchReason,
  EntityResolution,
} from './resolution'
