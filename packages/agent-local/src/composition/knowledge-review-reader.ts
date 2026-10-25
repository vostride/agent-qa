// The function layer's knowledge READ port, bound over the physically read-only entry
// (Phase 387, KREV-01 / FUNC-04 / D-01).
//
// This file exists so the read half of the review-verb family has a home that CANNOT name the
// writer-gated entry. It is registered in the arch reader carve-out's pinned file list, which
// means the lint fails this file for naming anything but the `/reader` subpath — the same rule
// that already binds `knowledge-read.ts` and the run-scoped serving reader. The alternative,
// leaving the binding inside the composition root (which legitimately names the writer entry,
// because it also binds the curator), would have put five read verbs inside the one file in
// the workspace where a write import is legal. The rule would still have passed and the
// separation would have been discipline rather than structure.
//
// D-01 LIST-VERB SIGHTING. Entity ids discovered by listing and single-record verbs go to the
// injected `sightMemoryEntities` callback. The callback is INJECTED rather than constructed
// here for the reason above: minting reaches the durable addressing ledger, whose module lives
// on the writer-gated entry, so a version of this file that could mint could not be a reader
// file. The composition root — which may name that entry — supplies it. The callback is a side
// effect on the ledger and never on the answer: every projection below is byte-identical
// whether or not one is supplied, which is what keeps the wiring-parity claim true.

import {
  canaryAttributionsFor,
  candidateInjectionFor,
  gateReceiptsFor,
  diffSince,
  inspectRecords,
  listBundles,
  showRecord,
  showRecords,
} from '@vostride/agent-qa-knowledge-local/reader'
import type { KnowledgeReaderPort } from '@vostride/agent-qa-agent'
import type { TrustPriorTable } from '@vostride/agent-qa-schema'

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
  resolveTrustPriors?: () => TrustPriorTable | undefined
  /**
   * Which knowledge root this invocation serves from, resolved per call.
   *
   * A host-supplied resolver rather than a string, on the same reasoning the bundle listing
   * already carried: deciding which configuration file is in force is a decision a daemon
   * makes differently from a terminal.
   */
  resolveKnowledgeRoot: () => Promise<string> | string
  /** The D-01 sighting site. Absent in hosts that bind no addressing ledger. */
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
    // 2026-09-07, 417 D-01: forward the candidate DATA verbatim. Since 441-41 (D-06) nothing here
    // scans it; the chat and MCP doors mask declared values in every op result.
    async candidateInjection({ candidateId }) {
      return candidateInjectionFor({
        ...(input.resolveTrustPriors === undefined ? {} : { priors: input.resolveTrustPriors() }),
        knowledgeRoot: await input.resolveKnowledgeRoot(), candidateId,
      })
    },
    // The caller supplied the identity; forward the reader's answer verbatim.
    async gateReceipts({ candidateId }) {
      return gateReceiptsFor({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        candidateId,
      })
    },
    async listBundles() {
      const rows = listBundles(await input.resolveKnowledgeRoot(), input.resolveTrustPriors?.())
      await sight(rows.map((row) => row.bundleId))
      return rows
    },
    async inspectRecords({ filter }) {
      const records = inspectRecords({
        ...(input.resolveTrustPriors === undefined ? {} : { priors: input.resolveTrustPriors() }),
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
        ...(input.resolveTrustPriors === undefined ? {} : { priors: input.resolveTrustPriors() }),
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
    /**
     * 407 D-08: what became of the canary lines one run served.
     *
     * Resolved per call like its four siblings, and NOT sighted. The caller already holds every
     * candidate id in the tuples it passes — it read them off its own run's evidence — so a
     * sighting here would record that the reader was handed ids rather than that an entity was
     * surfaced to anyone, which is the distinction the ledger exists to keep.
     *
     * The reader entry's answer is forwarded VERBATIM, `skippedBundles` included (407-19, REVIEW
     * WR-03). This binding neither counts nor interprets: how much of the store went unread is a
     * fact only the walk knows, and a composition that dropped it here would hand the op a
     * clean-looking answer over a half-read store.
     */
    async canaryAttributions({ runId, tuples }) {
      return canaryAttributionsFor({
        knowledgeRoot: await input.resolveKnowledgeRoot(),
        runId,
        tuples,
      })
    },
  }
}
