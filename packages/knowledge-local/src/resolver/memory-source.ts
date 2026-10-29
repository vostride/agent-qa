// Unfiltered by lifecycle, like `listBundles`: a superseded record still resolves, with its status.

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
    // Sighting and hydration are one lookup for MEM, because a bundle id is the machine id.
    hydrate: find,
  }
}
