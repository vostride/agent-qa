// The entity resolver's tier ladder.
//
//   (a) EXACT — an anchored address parse plus a ledger hit, or an exact machine-id
//       sighting. Deterministic, no ranking, no model, score 1.0. THIS FILE.
//   (b) a strong hit over the hybrid entity index, and
//   (c) a top-3 disambiguation set — both in `hybrid.ts`, reached only from the ONE place
//       tier (a) admits it cannot answer exactly.
//
// The order is fixed and the fall-through is deliberately narrow. Only free text that matched
// no address and no machine id reaches the fuzzy tiers; a well-formed address that names
// nothing stops HERE with `unknown-address`, because answering an address with whatever text
// happened to rank is the silent guess this whole mechanism exists to prevent. ENTY-01 names
// mis-linking a failing run to the wrong entity as the QA hazard, and a resolver that answered
// "probably that one" would have shipped exactly that hazard behind a confident-looking card.
//
// Nothing in this file consults a model, a clock-dependent ordering, or any nondeterministic
// tie-break, and tier (b) inherits the same discipline: two calls over the same ledger, the
// same sources and the same projection answer identically.
//
// D-01's lazy mint lives here: an entity gets its permanent address the first time something
// SIGHTS it, which is this function. No creation path anywhere calls the ledger.

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

/**
 * One store's answer to "do you own an entity with exactly this machine id?".
 *
 * A port rather than a switch over kinds, because each kind's machine ids live behind a
 * different store and the tracer wires only one of them. 387-03 adds sources for the
 * remaining kinds and neither this function nor its callers change.
 */
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
  /**
   * The status as the OWNING store reports it. Validated against the kind's closed union at
   * the card boundary, not here: this layer reports, the producer renders, and the
   * schema refuses. Three responsibilities, three places.
   */
  readonly statusSource: string
}

export interface ResolveEntityRefDeps {
  readonly ledger: AddressingLedger
  readonly sources: readonly EntitySightingSource[]
  /**
   * The D-06 projection, maintained by USE.
   *
   * Optional, and that is the degradation ladder rather than a convenience: a composition that
   * supplies no index gets tier (a) and the honest `none` arm, which is exactly what 387-01
   * shipped. Nothing here silently becomes a guess when the projection is absent.
   */
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
  // Read at describe time rather than carried on the sighting, because a rename is a fact the
  // LEDGER holds and the owning store does not: the config that named the target has already
  // forgotten the old slug by the time anybody resolves it, which is exactly why the rename
  // had to be recorded.
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

/**
 * Project a sighted entity into the index and hand the descriptor back.
 *
 * The four sighting sites D-01 names — a resolver hit, a card render, verdict authoring, a
 * list verb — all reach the ledger through THIS function, so routing the projection refresh
 * here makes the index maintained by the same act that mints. There is no separate
 * "index an entity" call anybody has to remember, and therefore no drift between what has an
 * address and what can be found by name.
 *
 * A failure to project is deliberately not fatal. The index is disposable and a rebuild heals
 * it; refusing to resolve an entity because its projection could not be written would let a
 * disposable file take down the durable answer.
 */
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
    // D-04's honest-status half is 387-07's: a permanent address whose entity is gone must
    // still resolve, to a card whose status says what happened. Until that landing this build
    // says it cannot describe the entity rather than inventing a status for it. It never
    // reports the address as unknown — the address IS known, and saying otherwise would be
    // the dead link D-04 forbids.
    return { kind: 'none', reason: 'unknown-address', closestSuggestion: address.shortId }
  }

  return {
    kind: 'resolved',
    descriptor: sighted(describe(kind, address.shortId, sighting, deps), deps),
    score: ENTITY_EXACT_MATCH_SCORE,
  }
}

/**
 * Every entity the ledger has ever addressed and a source can still describe.
 *
 * This is the set `rebuildEntityIndex` is rebuilt FROM and the set the daemon sweep re-renders
 * It reads the LEDGER, never the index: a projection rebuilt from itself would
 * preserve exactly the state a rebuild is run to be rid of.
 *
 * An address whose source can no longer describe it is skipped rather than projected as a
 * husk. The address keeps resolving through tier (a) either way — D-04's permanence lives in
 * the ledger — but a row with no title is not something fuzzy text should ever match.
 */
export function describeAllEntities(deps: ResolveEntityRefDeps): EntityDescriptor[] {
  return deps.ledger.listAddresses().flatMap((address) => {
    const sighting = sourceFor(deps.sources, address.kind)?.hydrate(address.machineId)
    return sighting === undefined
      ? []
      : [describe(address.kind, address.shortId, sighting, deps)]
  })
}

/**
 * THE sighting leg: exact machine-id equality, mint, project, describe.
 *
 * Extracted so the resolver's own leg and the LIST VERBS' sighting site are one mechanism
 * rather than two that mint the same way today. D-01 names four sighting sites — a resolver
 * hit, a card render, verdict authoring, a list verb — and a second minting path written for
 * the fourth would be a second place where "first sighting mints" could stop being true, with
 * nothing comparing them.
 *
 * `undefined` means no registered source recognises the id at all.
 *
 * EXACT equality, always. A prefix or case-insensitive comparison here would be tier (b)
 * smuggled in below the never-guess contract. Sources are consulted in registered order so
 * the answer does not depend on iteration accidents.
 */
export function sightEntity(
  machineId: string,
  deps: ResolveEntityRefDeps,
): EntityResolution | undefined {
  for (const source of deps.sources) {
    const sighting = source.sight(machineId)
    if (sighting === undefined) continue
    // First sighting mints. Idempotent in the ledger, so a re-sighting returns the
    // address that is already published rather than a second one.
    const address = deps.ledger.mint(source.kind, sighting.machineId)
    return {
      kind: 'resolved',
      descriptor: sighted(describe(source.kind, address.shortId, sighting, deps), deps),
      score: ENTITY_EXACT_MATCH_SCORE,
    }
  }
  return undefined
}

/**
 * Resolve a reference through the three tiers, minting on first sighting.
 *
 * Order matters and is fixed: URI, then short-ID, then exact machine id, then — for free text
 * only — the hybrid tiers. Addresses are tried before machine ids because an address is
 * unambiguous by construction, and a machine id that happened to LOOK like a short-ID would
 * otherwise be able to shadow a published address.
 *
 * ASYNC because tier (b)'s dense leg is: an embedding query cannot be made synchronous, and
 * the alternative — a second, synchronous entry that quietly answers with tier (a) only —
 * would be a resolver that under-answers depending on which function a caller happened to
 * import. The PORT this reaches surfaces through was already asynchronous, so no composition
 * edge changes shape.
 */
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

  // THE fall-through, and the only one. Free text that matched no address and no machine id
  // is what tiers (b)/(c) exist for; with no projection bound this stays the honest miss that
  // 387-01 shipped, rather than becoming a guess the moment a dependency is optional.
  if (deps.entityIndex === undefined) return { kind: 'none', reason: 'no-match' }
  return resolveHybrid(trimmed, {
    index: deps.entityIndex,
    // The LEDGER describes the winner, never the projection: a disposable index may hold a
    // stale row, and a stale title in front of a user is the failure D-06 keeps it out of.
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
