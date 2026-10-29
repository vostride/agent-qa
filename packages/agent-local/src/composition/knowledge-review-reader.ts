// On the reader carve-out list, so this file cannot name the writer entry; sighting is injected.

import {
  canaryAttributionsFor,
  gateReceiptsFor,
  diffSince,
  inspectRecords,
  listBundles,
  showRecord,
  showRecords,
} from '@vostride/agent-qa-knowledge-local/reader'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'

/**
 * Hand every entity id an output surfaced to the addressing ledger's sighting seam.
 *
 * Fire-and-forget by contract: it resolves when the sighting is recorded, and a rejection is
 * not the read's problem. An address is a permanent fact about an entity and a listing is a
 * question about the store; failing the question because the bookkeeping failed would let the
 * ledger take down the answer it exists to annotate.
 */
export type SightMemoryEntities = (bundleIds: readonly string[]) => Promise<void>

export interface ConstructKnowledgeReaderPortInput {
  /**
   * Which knowledge root this invocation serves from, resolved per call.
   *
   * A host-supplied resolver rather than a string, on the same reasoning the bundle listing
   * already carried: deciding which configuration file is in force is a decision a daemon
   * makes differently from a terminal.
   */
  resolveKnowledgeRoot: () => Promise<string> | string
  // The sighting site; absent in hosts that bind no addressing ledger.
  sightMemoryEntities?: SightMemoryEntities
}

export function createKnowledgeReaderPort(
  input: ConstructKnowledgeReaderPortInput,
): KnowledgeReaderPort {
  async function sight(bundleIds: readonly string[]): Promise<void> {
    if (input.sightMemoryEntities === undefined || bundleIds.length === 0) return
    try {
      await input.sightMemoryEntities(bundleIds)
    } catch {
      // See `SightMemoryEntities`: the read already answered.
    }
  }

  return {
    // The caller supplied the identity; forward the reader's answer verbatim.
    async gateReceipts({ candidateId }) {
      return gateReceiptsFor({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        candidateId,
      })
    },
    async listBundles() {
      const rows = listBundles(await input.resolveKnowledgeRoot())
      await sight(rows.map((row) => row.bundleId))
      return rows
    },
    async inspectRecords({ filter }) {
      const records = inspectRecords({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        filter,
      })
      await sight(records.map((record) => record.recordId))
      return records
    },
    async diffSince({ sinceOrdinal }) {
      const changes = diffSince({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        sinceOrdinal,
      })
      // A change list names records by id including ones whose bundle is gone (a purge
      // change). Those simply are not sighted: the sighting seam requires a source to
      // RECOGNISE the id, so a purged record mints nothing and the ledger stays a record of
      // entities that were actually seen rather than of ids that were mentioned.
      await sight(changes.map((change) => change.recordId))
      return changes
    },
    async showRecord({ recordId }) {
      const result = showRecord({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        recordId,
      })
      await sight(result.kind === 'found' ? [result.record.recordId] : [])
      return result
    },
    // Caller-supplied union IDs are already known, like canary tuples below. Forward
    // the maintenance batch without address-ledger sightings or per-record scans.
    async showRecords({ recordIds }) {
      return showRecords({ knowledgeRoot: await input.resolveKnowledgeRoot(), recordIds })
    },
    // Not sighted; `skippedBundles` is forwarded verbatim so a half-read store never looks clean.
    async canaryAttributions({ runId, tuples }) {
      return canaryAttributionsFor({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        runId,
        tuples,
      })
    },
  }
}
