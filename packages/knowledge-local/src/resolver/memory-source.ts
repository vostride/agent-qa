// The MEM entity sighting source (Phase 387, plan 01 — the tracer's one wired kind).
//
// Reads through the same read-only bundle listing `knowledge.bundles.list` serves, so a
// memory entity the catalog shows and a memory entity the resolver can sight are the same
// set by construction rather than by two enumerations that agree today.
//
// Deliberately UNFILTERED by serving lifecycle, matching `listBundles`: a superseded or
// deprecated record still has a permanent address and must still resolve. The card's
// status is what says what happened to it.
//
// That status is derived by the ONE shared mapping in `memory-status.ts`, which is total over
// the complete `BundleStatus` union. This module used to carry its own private table with a
// silent `active` fallback; the fallback hid two members the union does not contain and one it
// does, and the card contradicted the forget receipt as a result.

import { listBundles } from '../list-bundles.js'
import { memoryStatusForBundle } from '../memory-status.js'
import type { EntitySighting, EntitySightingSource } from './resolve.js'

/** Build the MEM sighting source over a knowledge root. */
export function createMemorySightingSource(
  resolveKnowledgeRoot: () => string,
): EntitySightingSource {
  function find(machineId: string): EntitySighting | undefined {
    for (const row of listBundles(resolveKnowledgeRoot())) {
      // EXACT equality. This leg is addressing, not search: a prefix or case-insensitive
      // comparison here would be tier (b) smuggled in below the never-guess contract.
      if (row.bundleId !== machineId) continue
      return {
        machineId: row.bundleId,
        title: row.summary,
        statusSource: memoryStatusForBundle(row.status),
      }
    }
    return undefined
  }

  return {
    kind: 'MEM',
    sight: find,
    // Sighting and hydration are the same lookup for MEM: a bundle id IS the machine id, so
    // there is no second index to consult. They stay two members on the port because for
    // RUN and TST they will not be.
    hydrate: find,
  }
}
