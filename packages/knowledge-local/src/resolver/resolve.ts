// Only free text matching no address or machine id falls through; an unknown address stops here.

import {
  ENTITY_EXACT_MATCH_SCORE,
  canonicalShortId,
  formatEntityUri,
  parseEntityUri,
  parseShortId,
} from '@vostride/agent-qa-schema'
import type { EntityDescriptor, EntityKind, EntityResolution } from '@vostride/agent-qa-schema'

import type { AddressingLedger } from '../addressing/ledger.js'
import type { EmbedderPort } from '../embedder-port.js'
import { refreshEntity, type EntityIndexHandle } from '../entity-index/entity-index.js'
import { resolveHybrid } from './hybrid.js'

// A port, not a switch over kinds, because each kind's machine ids live in a different store.
export interface EntitySightingSource {
  readonly kind: EntityKind
  /** The entity with this exact machine id, or `undefined`. Never a fuzzy match. */
  sight(machineId: string): EntitySighting | undefined
  /** The entity a minted address maps back to, for rendering a ledger hit. */
  hydrate(machineId: string): EntitySighting | undefined
}

/** What a store reports about one of its entities. Facts only — no card, no address. */
export interface EntitySighting {
  readonly machineId: string
  readonly title: string
  // Validated against the kind's closed union at the card boundary, not here.
  readonly statusSource: string
}

export interface ResolveEntityRefDeps {
  readonly ledger: AddressingLedger
  readonly sources: readonly EntitySightingSource[]
  // Optional: without an index only tier (a) and the honest `none` arm answer.
  readonly entityIndex?: EntityIndexHandle
  /** Test/integration seam for tier (b)'s dense leg; omission runs the acquisition ladder. */
  readonly embedder?: EmbedderPort
}

function describe(
  kind: EntityKind,
  shortId: string,
  sighting: EntitySighting,
  deps: ResolveEntityRefDeps,
): EntityDescriptor {
  // Read at describe time: the ledger holds the rename after the config has forgotten the old slug.
  const successor = deps.ledger.lookupTargetRename(sighting.machineId)
  return {
    kind,
    shortId,
    uri: formatEntityUri(kind, shortId),
    machineId: sighting.machineId,
    title: sighting.title,
    statusSource: sighting.statusSource,
    ...(kind === 'TGT' && successor !== undefined
      ? { successorMachineId: successor.toSlug }
      : {}),
  }
}

// Projection failure is not fatal: the index is disposable and a rebuild heals it.
function sighted(descriptor: EntityDescriptor, deps: ResolveEntityRefDeps): EntityDescriptor {
  if (deps.entityIndex === undefined) return descriptor
  try {
    refreshEntity(deps.entityIndex, descriptor)
  } catch {
    // Projection is best-effort; the ledger already answered.
  }
  return descriptor
}

function sourceFor(
  sources: readonly EntitySightingSource[],
  kind: EntityKind,
): EntitySightingSource | undefined {
  return sources.find((source) => source.kind === kind)
}

/**
 * Resolve one already-minted address, or say why it does not resolve.
 *
 * Shared by the short-ID arm and the URI arm so the two spellings of one address cannot
 * diverge — the URI leg canonicalises to a short-ID and then joins this path, rather than
 * running a second, parallel lookup that could drift.
 */
function resolveMintedAddress(
  shortId: string,
  kind: EntityKind,
  deps: ResolveEntityRefDeps,
): EntityResolution {
  const address = deps.ledger.lookupByShortId(shortId)
  if (address === undefined) return { kind: 'none', reason: 'unknown-address' }

  const source = sourceFor(deps.sources, kind)
  const sighting = source?.hydrate(address.machineId)
  if (sighting === undefined) {
    // A known address its source cannot describe answers `none` with the address as suggestion.
    return { kind: 'none', reason: 'unknown-address', closestSuggestion: address.shortId }
  }

  return {
    kind: 'resolved',
    descriptor: sighted(describe(kind, address.shortId, sighting, deps), deps),
    score: ENTITY_EXACT_MATCH_SCORE,
  }
}

// Reads the ledger, never the index, so a rebuild cannot preserve the index's own state.
export function describeAllEntities(deps: ResolveEntityRefDeps): EntityDescriptor[] {
  return deps.ledger.listAddresses().flatMap((address) => {
    const sighting = sourceFor(deps.sources, address.kind)?.hydrate(address.machineId)
    return sighting === undefined
      ? []
      : [describe(address.kind, address.shortId, sighting, deps)]
  })
}

// Exact machine-id equality only; a prefix match would be fuzzy matching below never-guess.
export function sightEntity(
  machineId: string,
  deps: ResolveEntityRefDeps,
): EntityResolution | undefined {
  for (const source of deps.sources) {
    const sighting = source.sight(machineId)
    if (sighting === undefined) continue
    // Idempotent in the ledger, so a re-sighting returns the published address.
    const address = deps.ledger.mint(source.kind, sighting.machineId)
    return {
      kind: 'resolved',
      descriptor: sighted(describe(source.kind, address.shortId, sighting, deps), deps),
      score: ENTITY_EXACT_MATCH_SCORE,
    }
  }
  return undefined
}

// Addresses before machine ids, so a machine id shaped like a short-ID cannot shadow an address.
export async function resolveEntityRef(
  ref: string,
  deps: ResolveEntityRefDeps,
): Promise<EntityResolution> {
  const trimmed = ref.trim()
  if (trimmed === '') return { kind: 'none', reason: 'no-match' }

  const uri = parseEntityUri(trimmed)
  if (uri !== undefined) return resolveMintedAddress(uri.shortId, uri.kind, deps)

  const shortId = parseShortId(trimmed)
  if (shortId !== undefined) {
    const canonical = canonicalShortId(trimmed)
    if (canonical !== undefined) return resolveMintedAddress(canonical, shortId.kind, deps)
  }

  // The sighting leg, which the list verbs also reach directly.
  const sightedOutcome = sightEntity(trimmed, deps)
  if (sightedOutcome !== undefined) return sightedOutcome

  // With no projection bound, free text stays an honest miss rather than a guess.
  if (deps.entityIndex === undefined) return { kind: 'none', reason: 'no-match' }
  return resolveHybrid(trimmed, {
    index: deps.entityIndex,
    // The ledger describes the winner, never the index, which may hold a stale row.
    describe: (candidateShortId) => {
      const candidateKind = parseShortId(candidateShortId)?.kind
      if (candidateKind === undefined) return undefined
      const outcome = resolveMintedAddress(candidateShortId, candidateKind, deps)
      return outcome.kind === 'resolved' ? outcome.descriptor : undefined
    },
    ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
  })
}

/**
 * `entities.get`'s read path: the descriptor for an EXACT address, or `undefined`.
 *
 * Deliberately narrower than `resolveEntityRef` — it neither mints nor consults the sighting
 * leg. `get` means "I already have the address", and a `get` that could mint would make every
 * card render a potential write.
 */
export function getEntityDescriptor(
  ref: string,
  deps: ResolveEntityRefDeps,
): EntityDescriptor | undefined {
  const trimmed = ref.trim()
  const uri = parseEntityUri(trimmed)
  const shortId = uri?.shortId ?? canonicalShortId(trimmed)
  const kind = uri?.kind ?? parseShortId(trimmed)?.kind
  if (shortId === undefined || kind === undefined) return undefined

  // Reaches `resolveMintedAddress`, never the sighting leg, so no `get` can mint.
  const outcome = resolveMintedAddress(shortId, kind, deps)
  return outcome.kind === 'resolved' ? outcome.descriptor : undefined
}
