import { readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import {
  RECORD_CHANGE_SCHEMA_VERSION,
  RecordChangeSchema,
  survivingOutcomeEvents,
  isPromotionReceipt,
  strongestPromotionPath,
} from '@vostride/agent-qa-schema'
import type {
  BundleOutcomeEvent,
  BundleProvenance,
  RecordChange,
} from '@vostride/agent-qa-schema'

import {
  enumerateMaintenanceBundleDirs,
  KnowledgeMaintenanceScanError,
  loadMaintenanceBundle,
} from './maintenance-scan.js'
import {
  guardPurgeReceiptForFile,
  parseCanonicalPurgeReceiptFileName,
} from './purge-receipt.js'
import { readGateReceipts } from './bundle-read.js'

export interface DiffSinceOptions {
  knowledgeRoot: string
  sinceOrdinal: number
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

// Only job ids built from the bundle's own candidate link a run; a wrong run is worse than none.
function linkedRunId(
  event: BundleOutcomeEvent,
  provenance: BundleProvenance,
): string | undefined {
  if (provenance.mode !== 'run-linked' || provenance.curationJobId === undefined) return undefined
  return event.curationJobId === provenance.curationJobId
    || event.curationJobId === `promote:${provenance.curationJobId}`
    ? provenance.runId
    : undefined
}

/**
 * The two run links, spread onto every change a surviving event produces.
 *
 * `observationId` is a DIFFERENT axis from `sourceRunId` rather than a fallback for it: a canary
 * outcome is attributed by an id the consumer recomputes from the run's own served tuples, while a
 * commit or promotion is attributed by run id. Absent keys, never nulls — a change written before
 * this field existed and a change for which nothing is derivable must read identically.
 */
function runLinks(
  event: BundleOutcomeEvent,
  provenance: BundleProvenance,
): { sourceRunId?: string; observationId?: string } {
  const runId = linkedRunId(event, provenance)
  return {
    ...(runId === undefined ? {} : { sourceRunId: runId }),
    ...(event.observationId === undefined ? {} : { observationId: event.observationId }),
  }
}

function directChange(
  recordId: string,
  event: BundleOutcomeEvent,
  provenance: BundleProvenance,
): RecordChange | undefined {
  switch (event.type) {
    case 'confirmed':
    case 'deprecated':
    case 'promoted':
      return RecordChangeSchema.parse({
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId,
        change: event.type,
        atOrdinal: event.buildOrdinal,
        evidenceToken: event.evidenceToken,
        ...runLinks(event, provenance),
      })
    case 'superseded':
      return RecordChangeSchema.parse({
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId,
        change: event.type,
        atOrdinal: event.buildOrdinal,
        evidenceToken: event.evidenceToken,
        byRecordId: event.byRecordId,
        ...runLinks(event, provenance),
      })
    default:
      return undefined
  }
}

function purgeChanges(knowledgeRoot: string, sinceOrdinal: number): RecordChange[] {
  const receiptsDir = join(knowledgeRoot, 'memory', 'receipts')
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(receiptsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new KnowledgeMaintenanceScanError(
      'directory-read',
      receiptsDir,
      error instanceof Error ? error.message : String(error),
    )
  }

  const changes: RecordChange[] = []
  const identities = new Set<string>()
  const files = entries
    .filter((entry) => (
      entry.name.startsWith('purge-')
      && entry.name.endsWith('.json')
      && !entry.name.endsWith('.intent.json')
    ))
    .sort((left, right) => compareText(left.name, right.name))
  for (const file of files) {
    const path = join(receiptsDir, file.name)
    if (!file.isFile()) {
      throw new KnowledgeMaintenanceScanError(
        'receipt-invalid',
        path,
        'canonical receipt entry is not a regular file',
      )
    }
    const name = parseCanonicalPurgeReceiptFileName(file.name)
    if (name === undefined) {
      throw new KnowledgeMaintenanceScanError(
        'receipt-invalid',
        path,
        'purge-prefixed JSON does not use a canonical receipt filename',
      )
    }
    const identity = `${name.recordId}:${name.cycle}`
    if (identities.has(identity)) continue
    identities.add(identity)

    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      throw new KnowledgeMaintenanceScanError(
        'receipt-read',
        path,
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      const receipt = guardPurgeReceiptForFile(JSON.parse(raw), file.name)
      if (receipt.purgedAtOrdinal <= sinceOrdinal) continue
      changes.push(RecordChangeSchema.parse({
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: receipt.purgedRecordId,
        change: 'purged',
        atOrdinal: receipt.purgedAtOrdinal,
      }))
    } catch (error) {
      throw new KnowledgeMaintenanceScanError(
        'receipt-invalid',
        path,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  return changes
}

/** Pure build-ordinal fold over committed bundle outcomes and content-free purge receipts. */
export function diffSince(options: DiffSinceOptions): RecordChange[] {
  if (!Number.isInteger(options.sinceOrdinal) || options.sinceOrdinal < 0) {
    throw new TypeError('sinceOrdinal must be a non-negative integer')
  }

  const changes: RecordChange[] = []
  for (const entry of enumerateMaintenanceBundleDirs(options.knowledgeRoot)) {
    const bundle = loadMaintenanceBundle(entry)
    const survivingEvents = survivingOutcomeEvents(bundle.events)
    const earliestOrdinal = survivingEvents.reduce(
      (earliest, event) => Math.min(earliest, event.buildOrdinal),
      bundle.manifest.createdAtOrdinal,
    )
    let eventLowerBound = options.sinceOrdinal
    if (earliestOrdinal > options.sinceOrdinal) {
      changes.push(RecordChangeSchema.parse({
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: bundle.manifest.id,
        change: 'added',
        atOrdinal: earliestOrdinal,
        // A run-linked bundle's appearance is the run's doing; a standalone bundle gets no run key.
        ...(bundle.provenance.mode === 'run-linked'
          ? { sourceRunId: bundle.provenance.runId }
          : {}),
      }))
      eventLowerBound = earliestOrdinal
    }

    for (const event of survivingEvents) {
      if (event.buildOrdinal <= options.sinceOrdinal) continue
      const receipts = event.type === 'promoted' ? readGateReceipts(entry.dir, bundle.manifest.id) ?? [] : []
      const promotion = receipts.filter(isPromotionReceipt)
        .reverse().find(line => line.producedAtOrdinal === event.buildOrdinal)
      // A synchronous mark commit and promotion share an ordinal. Its persisted promotion
      // receipt makes that event distinct from the added row; legacy receipt-less rows retain
      // their historical suppression at the creation ordinal.
      if (event.buildOrdinal <= eventLowerBound && promotion === undefined) continue
      const change = directChange(bundle.manifest.id, event, bundle.provenance)
      if (change !== undefined) {
        const promotionPath = promotion === undefined ? undefined : strongestPromotionPath(receipts)
        changes.push(promotionPath === undefined ? change : RecordChangeSchema.parse({
          ...change, promotionPath, promotionReceiptDigest: promotion!.receiptDigest,
        }))
      }
    }
  }

  changes.push(...purgeChanges(options.knowledgeRoot, options.sinceOrdinal))
  return changes.sort((left, right) => (
    compareText(left.recordId, right.recordId)
    || left.atOrdinal - right.atOrdinal
    || compareText(left.change, right.change)
    || compareText(left.evidenceToken ?? '', right.evidenceToken ?? '')
    || compareText(left.byRecordId ?? '', right.byRecordId ?? '')
  ))
}
