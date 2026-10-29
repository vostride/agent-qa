import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GATE_RECEIPT_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  asRecordId,
  guardRecordChange,
  stampReceiptDigest,
  RECORD_CHANGE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  BundleOutcomeEvent,
  RecordChange,
  RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle } from '../bundle-publish.test-helper.js'
import type {
  BundleStoreConfig,
  PublishBundleInput,
} from '../bundle-publish.test-helper.js'
import * as knowledgeLocal from '../index.js'
import { createLocalKnowledgeStore } from '../curator/knowledge-store.js'
import { acquireWriterLease, releaseLease } from '../lease/writer-lease.js'
import { readGateReceipts } from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import { PURGE_RECEIPT_SCHEMA_VERSION } from '../purge-receipt.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

type DiffApi = {
  diffSince?: (options: {
    knowledgeRoot: string
    sinceOrdinal: number
  }) => RecordChange[]
}

function diffSince(knowledgeRoot: string, sinceOrdinal: number): RecordChange[] {
  const diff = (knowledgeLocal as DiffApi).diffSince
  expect(diff, 'diffSince export').toBeDefined()
  return diff!({ knowledgeRoot, sinceOrdinal })
}

function event(
  value: Parameters<typeof BundleOutcomeEventSchema.parse>[0],
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(value)
}

describe('diffSince deterministic maintenance history', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-diff-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'shop',
    }
  }

  it.each([3, 6])('promoted rows copy sovereign path and digest at ordinal %s, including immediate promotion', async ordinal => {
    const recordId = publishFact('Sovereign checkout', 'shop', 3, [])
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture lease unavailable')
    try {
      const store = createLocalKnowledgeStore({ knowledgeRoot,
        executionContext: 'local-interactive', writerLeaseId: lease.leaseId, epoch: lease.epoch,
        sourceBuildOrdinal: ordinal })
      await store.promote(recordId, [stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3,
        candidateId: recordId, verdict: 'pass', producedAtOrdinal: ordinal,
        producedBy: { opId: 'knowledge.proposal.apply' }, runId: 'diff-mark-run', mark: 'false-fail' })])
      const rows = diffSince(knowledgeRoot, 0)
      const promoted = rows.find(row => row.change === 'promoted')!
      expect(promoted).toMatchObject({ recordId, promotionPath: 'user-sovereign', atOrdinal: ordinal,
        promotionReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
      const dir = enumerateBundleDirs(knowledgeRoot)[0]!.dir
      const line = readGateReceipts(dir, recordId)!.find(line => 'kind' in line && line.kind === 'promotion')!
      expect(promoted.promotionReceiptDigest).toBe(line.receiptDigest)
      const added = rows.find(row => row.change === 'added')!
      expect(added).not.toHaveProperty('promotionPath')
      expect(added).not.toHaveProperty('promotionReceiptDigest')
      expect(diffSince(knowledgeRoot, ordinal)).toEqual([])
    } finally { releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
  })

  function publishFact(
    name: string,
    scope: string,
    createdAtOrdinal: number,
    initialEvents: readonly BundleOutcomeEvent[],
    provenance: PublishBundleInput['provenance'] = {
      mode: 'run-linked',
      runId: `diff-${scope}`,
      testId: 'diff-since',
      stepIndex: 0,
    },
  ): RecordId {
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        anchors: [{ t: 'el', role: 'Button', name }],
        scope: { tier: 'product', key: scope },
        summary: `${name} fact`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [...initialEvents],
      relations: [],
      provenance,
      artifacts: [],
    })

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
    return outcome.id
  }

  function seedStore(): {
    confirmedId: string
    supersededId: string
    addedId: string
    retractedId: string
  } {
    const confirmedId = publishFact('Confirmed', 'confirmed', 5, [
      event({
        type: 'confirmed',
        evidenceToken: 'confirmed-at-11',
        curationJobId: 'confirmation-job',
        buildOrdinal: 11,
        origin: 'agent-verified',
      }),
    ])
    const supersededId = publishFact('Superseded', 'superseded', 5, [
      event({
        type: 'superseded',
        evidenceToken: 'superseded-at-12',
        curationJobId: 'supersession-job',
        buildOrdinal: 12,
        byRecordId: confirmedId,
      }),
    ])
    const addedId = publishFact('Added', 'added', 13, [
      event({
        type: 'confirmed',
        evidenceToken: 'added-confirmation',
        curationJobId: 'added-job',
        buildOrdinal: 13,
        origin: 'agent-verified',
      }),
    ])
    const retractedId = publishFact('Retracted', 'retracted', 5, [
      event({
        type: 'confirmed',
        evidenceToken: 'retracted-confirmation',
        curationJobId: 'retracted-target-job',
        buildOrdinal: 11,
        origin: 'agent-verified',
      }),
      event({
        type: 'retracted',
        evidenceToken: 'rollback-at-12',
        curationJobId: 'rollback-job',
        buildOrdinal: 12,
        retractsEvidenceToken: 'retracted-confirmation',
        retractsCurationJobId: 'retracted-target-job',
        rollbackReceiptId: 'rollback-receipt-1',
      }),
    ])

    return { confirmedId, supersededId, addedId, retractedId }
  }

  it('maps surviving post-reference events and classifies newly added records', () => {
    const { confirmedId, supersededId, addedId, retractedId } = seedStore()

    const changes = diffSince(knowledgeRoot, 10)

    expect(changes.map(guardRecordChange)).toEqual(changes)
    expect(changes).toContainEqual({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: confirmedId,
      change: 'confirmed',
      atOrdinal: 11,
      evidenceToken: 'confirmed-at-11',
    })
    expect(changes).toContainEqual({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: supersededId,
      change: 'superseded',
      atOrdinal: 12,
      evidenceToken: 'superseded-at-12',
      byRecordId: confirmedId,
    })
    // 407-04 (LERN-02, D-10): the synthetic `added` change carries the bundle's OWN run link,
    // which every fixture here publishes with `mode: 'run-linked'`. The lifecycle changes above
    // do not, because this fixture's provenance names no `curationJobId` for their events to
    // match — which is the point of the rule and not an omission in the fixture.
    expect(changes).toContainEqual({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: addedId,
      change: 'added',
      atOrdinal: 13,
      sourceRunId: 'diff-added',
    })
    expect(changes.some((change) => change.recordId === retractedId)).toBe(false)
    expect(diffSince(knowledgeRoot, 11).some((change) => (
      change.recordId === confirmedId && change.change === 'confirmed'
    ))).toBe(false)
  })

  it('preserves later lifecycle transitions for records added after the reference', () => {
    const addedId = publishFact('Added then deprecated', 'added-transition', 11, [
      event({
        type: 'confirmed',
        evidenceToken: 'creation-confirmation',
        curationJobId: 'creation-job',
        buildOrdinal: 11,
        origin: 'agent-verified',
      }),
      event({
        type: 'deprecated',
        evidenceToken: 'deprecated-at-14',
        curationJobId: 'deprecation-job',
        buildOrdinal: 14,
        reason: 'superseded operating guidance',
      }),
    ])

    const first = diffSince(knowledgeRoot, 10).map(guardRecordChange)
    const second = diffSince(knowledgeRoot, 10).map(guardRecordChange)

    expect(first.filter((change) => change.recordId === addedId)).toEqual([
      {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: addedId,
        change: 'added',
        atOrdinal: 11,
        sourceRunId: 'diff-added-transition',
      },
      {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: addedId,
        change: 'deprecated',
        atOrdinal: 14,
        evidenceToken: 'deprecated-at-14',
      },
    ])
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('observes a real purge after the immediately prior product ordinal', () => {
    const purgedId = publishFact('Purged after peer change', 'purged-after-peer', 12, [
      event({
        type: 'confirmed',
        evidenceToken: 'purged-target-at-12',
        curationJobId: 'purged-target-job',
        buildOrdinal: 12,
        origin: 'agent-verified',
      }),
    ])
    publishFact('Product chronology peer', 'product-peer', 5, [
      event({
        type: 'promoted',
        evidenceToken: 'product-peer-at-20',
        curationJobId: 'product-peer-job',
        buildOrdinal: 20,
      }),
    ])

    const purged = knowledgeLocal.purgeRecord({
      knowledgeRoot,
      recordId: purgedId,
      initiator: 'test-operator',
      purgedAtOrdinal: 21,
    })

    expect(purged.kind).toBe('purged')
    if (purged.kind !== 'purged') throw new Error('expected purge to complete')
    expect(purged.receipt.purgedAtOrdinal).toBe(21)
    expect(diffSince(knowledgeRoot, 20)).toEqual([
      {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: purgedId,
        change: 'purged',
        atOrdinal: 21,
      },
    ])
  })

  it('observes a later cross-record purge after the earlier high-ordinal bundle is gone', () => {
    const recordA = publishFact('Cross-record purge A', 'cross-record-a', 100, [
      event({
        type: 'confirmed',
        evidenceToken: 'cross-record-a-at-100',
        curationJobId: 'cross-record-a-job',
        buildOrdinal: 100,
        origin: 'agent-verified',
      }),
    ])
    const recordB = publishFact('Cross-record purge B', 'cross-record-b', 20, [
      event({
        type: 'confirmed',
        evidenceToken: 'cross-record-b-at-20',
        curationJobId: 'cross-record-b-job',
        buildOrdinal: 20,
        origin: 'agent-verified',
      }),
    ])

    const firstPurge = knowledgeLocal.purgeRecord({
      knowledgeRoot,
      recordId: recordA,
      initiator: 'test-operator',
      purgedAtOrdinal: 101,
    })
    expect(firstPurge.kind).toBe('purged')
    if (firstPurge.kind !== 'purged') throw new Error('expected record A purge to complete')
    expect(firstPurge.receipt.purgedAtOrdinal).toBe(101)

    const secondPurge = knowledgeLocal.purgeRecord({
      knowledgeRoot,
      recordId: recordB,
      initiator: 'test-operator',
      purgedAtOrdinal: 102,
    })
    expect(secondPurge.kind).toBe('purged')
    if (secondPurge.kind !== 'purged') throw new Error('expected record B purge to complete')
    expect(secondPurge.receipt.purgedAtOrdinal).toBeGreaterThan(101)

    const firstDiff = diffSince(knowledgeRoot, 101).map(guardRecordChange)
    const secondDiff = diffSince(knowledgeRoot, 101).map(guardRecordChange)
    expect(firstDiff).toEqual([
      {
        schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
        recordId: recordB,
        change: 'purged',
        atOrdinal: secondPurge.receipt.purgedAtOrdinal,
      },
    ])
    expect(firstDiff.some((change) => change.recordId === recordA)).toBe(false)
    expect(JSON.stringify(secondDiff)).toBe(JSON.stringify(firstDiff))
  })

  it('includes canonical purge receipts after the reference ordinal', () => {
    seedStore()
    const receiptsDir = join(knowledgeRoot, 'memory', 'receipts')
    mkdirSync(receiptsDir, { recursive: true })
    writeFileSync(
      join(receiptsDir, 'purge-purged-record.json'),
      `${JSON.stringify({
        schemaVersion: PURGE_RECEIPT_SCHEMA_VERSION,
        purgedRecordId: 'purged-record',
        purgedAtOrdinal: 14,
        initiator: 'test-operator',
        affectedPaths: ['memory/shop/bundles/purged-record'],
        firstCommittedOrdinal: 2,
      })}\n`,
      'utf8',
    )

    expect(diffSince(knowledgeRoot, 10)).toContainEqual({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: 'purged-record',
      change: 'purged',
      atOrdinal: 14,
    })
    expect(diffSince(knowledgeRoot, 14).some((change) => change.change === 'purged'))
      .toBe(false)
  })

  it('rejects copied, malformed, and non-canonical purge receipt truth', () => {
    const receiptsDir = join(knowledgeRoot, 'memory', 'receipts')
    mkdirSync(receiptsDir, { recursive: true })
    const receipt = {
      schemaVersion: PURGE_RECEIPT_SCHEMA_VERSION,
      purgedRecordId: 'record-a',
      purgedAtOrdinal: 14,
      initiator: 'test-operator',
      affectedPaths: ['memory/shop/bundles/record-a'],
      firstCommittedOrdinal: 2,
    }
    writeFileSync(
      join(receiptsDir, 'purge-record-b.json'),
      `${JSON.stringify(receipt)}\n`,
      'utf8',
    )
    expect(() => diffSince(knowledgeRoot, 10)).toThrowError(
      knowledgeLocal.KnowledgeMaintenanceScanError,
    )

    rmSync(join(receiptsDir, 'purge-record-b.json'))
    writeFileSync(join(receiptsDir, 'purge-record-a.01.json'), '{}\n', 'utf8')
    expect(() => diffSince(knowledgeRoot, 10)).toThrow(/canonical receipt filename/i)

    rmSync(join(receiptsDir, 'purge-record-a.01.json'))
    writeFileSync(join(receiptsDir, 'purge-record-a.json'), 'not-json\n', 'utf8')
    expect(() => diffSince(knowledgeRoot, 10)).toThrowError(
      knowledgeLocal.KnowledgeMaintenanceScanError,
    )
  })

  it('fails closed when receipt history cannot be enumerated', () => {
    const receiptsPath = join(knowledgeRoot, 'memory', 'receipts')
    mkdirSync(join(knowledgeRoot, 'memory'), { recursive: true })
    writeFileSync(receiptsPath, 'not a directory', 'utf8')

    expect(() => diffSince(knowledgeRoot, 0)).toThrowError(
      knowledgeLocal.KnowledgeMaintenanceScanError,
    )
    expect(() => diffSince(knowledgeRoot, 0)).toThrow(/scan incomplete/i)
  })

  it('is stable in record-id, ordinal, and change-kind order', () => {
    seedStore()

    const first = diffSince(knowledgeRoot, 10)
    const second = diffSince(knowledgeRoot, 10)
    const sorted = [...first].sort((left, right) => (
      left.recordId.localeCompare(right.recordId)
      || left.atOrdinal - right.atOrdinal
      || left.change.localeCompare(right.change)
    ))

    expect(second).toEqual(first)
    expect(first).toEqual(sorted)
  })

  // 407-04 (LERN-02 · D-10 as reconciled by 407-01). The run link is stamped from the two places
  // it is DURABLE — the bundle's own `run-linked` provenance and the outcome event's observation
  // id — and nowhere else. A change attributed to the wrong run is worse than one attributed to
  // no run at all, because a person reading "this run deprecated that fact" acts on it.
  describe('the run link', () => {
    it("stamps the bundle's own run on the synthetic added change", () => {
      const recordId = publishFact('Run linked added', 'run-linked-added', 3, [], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      const changes = diffSince(knowledgeRoot, 0).map(guardRecordChange)

      expect(changes).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'added',
          atOrdinal: 3,
          sourceRunId: 'run-A',
        },
      ])
    })

    it("stamps the run on a commit event carrying the bundle's own candidate id", () => {
      const recordId = publishFact('Own candidate commit', 'own-candidate', 3, [
        event({
          type: 'confirmed',
          evidenceToken: 'own-candidate-at-5',
          curationJobId: 'cand-1',
          buildOrdinal: 5,
          origin: 'agent-verified',
        }),
      ], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      expect(diffSince(knowledgeRoot, 4).map(guardRecordChange)).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'confirmed',
          atOrdinal: 5,
          evidenceToken: 'own-candidate-at-5',
          sourceRunId: 'run-A',
        },
      ])
    })

    it('stamps the run on a promotion event stamped promote:<candidateId>', () => {
      const recordId = publishFact('Promoted candidate', 'promoted-candidate', 3, [
        event({
          type: 'promoted',
          evidenceToken: 'promoted-at-6',
          curationJobId: 'promote:cand-1',
          buildOrdinal: 6,
        }),
      ], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      expect(diffSince(knowledgeRoot, 4).map(guardRecordChange)).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'promoted',
          atOrdinal: 6,
          evidenceToken: 'promoted-at-6',
          sourceRunId: 'run-A',
        },
      ])
    })

    it("leaves a NEIGHBOURING candidate's event unattributed — no sourceRunId key at all", () => {
      const recordId = publishFact('Neighbour job', 'neighbour-job', 3, [
        event({
          type: 'confirmed',
          evidenceToken: 'neighbour-at-5',
          curationJobId: 'cand-9',
          buildOrdinal: 5,
          origin: 'agent-verified',
        }),
      ], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      const changes = diffSince(knowledgeRoot, 4).map(guardRecordChange)

      expect(changes).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'confirmed',
          atOrdinal: 5,
          evidenceToken: 'neighbour-at-5',
        },
      ])
      expect(Object.hasOwn(changes[0]!, 'sourceRunId')).toBe(false)
    })

    it('carries the observation id of the event the change came from', () => {
      const recordId = publishFact('Canary attributed', 'canary-attributed', 3, [
        event({
          type: 'confirmed',
          evidenceToken: 'canary-at-5',
          curationJobId: 'cand-1',
          buildOrdinal: 5,
          observationId: 'canary-outcome:abc',
          origin: 'agent-verified',
        }),
      ], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      expect(diffSince(knowledgeRoot, 4).map(guardRecordChange)).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'confirmed',
          atOrdinal: 5,
          evidenceToken: 'canary-at-5',
          sourceRunId: 'run-A',
          observationId: 'canary-outcome:abc',
        },
      ])
    })

    it('a standalone bundle yields the pre-change shape byte for byte — no new keys appear', () => {
      const recordId = publishFact('Standalone', 'standalone-fact', 3, [
        event({
          type: 'confirmed',
          evidenceToken: 'standalone-at-5',
          curationJobId: 'cand-1',
          buildOrdinal: 5,
          origin: 'agent-verified',
        }),
      ], {
        mode: 'standalone',
        sourceDescription: 'imported by hand',
      })

      const changes = diffSince(knowledgeRoot, 0).map(guardRecordChange)

      expect(JSON.stringify(changes)).toBe(JSON.stringify([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'added',
          atOrdinal: 3,
        },
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'confirmed',
          atOrdinal: 5,
          evidenceToken: 'standalone-at-5',
        },
      ]))
      expect(JSON.stringify(changes)).not.toContain('sourceRunId')
      expect(JSON.stringify(changes)).not.toContain('observationId')
    })

    it("carries the observation id even when the event's job matches no run link", () => {
      const recordId = publishFact('Unlinked observation', 'unlinked-observation', 3, [
        event({
          type: 'deprecated',
          evidenceToken: 'unlinked-at-5',
          curationJobId: 'cand-9',
          buildOrdinal: 5,
          observationId: 'canary-outcome:def',
          reason: 'contradicted by a later run',
        }),
      ], {
        mode: 'standalone',
        sourceDescription: 'imported by hand',
      })

      expect(diffSince(knowledgeRoot, 4).map(guardRecordChange)).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'deprecated',
          atOrdinal: 5,
          evidenceToken: 'unlinked-at-5',
          observationId: 'canary-outcome:def',
        },
      ])
    })

    it('stamps the superseded arm too — the run link is not a per-change-kind exception', () => {
      const victimId = publishFact('Supersession victim', 'supersession-victim', 3, [], {
        mode: 'standalone',
        sourceDescription: 'the victim',
      })
      const recordId = publishFact('Supersession source', 'supersession-source', 3, [
        event({
          type: 'superseded',
          evidenceToken: 'superseded-at-5',
          curationJobId: 'cand-1',
          buildOrdinal: 5,
          byRecordId: victimId,
        }),
      ], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })

      expect(diffSince(knowledgeRoot, 4).map(guardRecordChange)).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId,
          change: 'superseded',
          atOrdinal: 5,
          evidenceToken: 'superseded-at-5',
          byRecordId: victimId,
          sourceRunId: 'run-A',
        },
      ])
    })

    it('stamps nothing on a purge change — a receipt carries no run and none is invented', () => {
      publishFact('Purge subject', 'purge-subject', 3, [], {
        mode: 'run-linked',
        runId: 'run-A',
        testId: 'attribution',
        stepIndex: 0,
        curationJobId: 'cand-1',
      })
      const receiptsDir = join(knowledgeRoot, 'memory', 'receipts')
      mkdirSync(receiptsDir, { recursive: true })
      writeFileSync(
        join(receiptsDir, 'purge-purged-record.json'),
        `${JSON.stringify({
          schemaVersion: PURGE_RECEIPT_SCHEMA_VERSION,
          purgedRecordId: 'purged-record',
          purgedAtOrdinal: 14,
          initiator: 'test-operator',
          affectedPaths: ['memory/shop/bundles/purged-record'],
          firstCommittedOrdinal: 2,
        })}\n`,
        'utf8',
      )

      const purged = diffSince(knowledgeRoot, 10).filter((change) => change.change === 'purged')

      expect(purged).toEqual([
        {
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
          recordId: 'purged-record',
          change: 'purged',
          atOrdinal: 14,
        },
      ])
    })
  })
})

// 407-04: the canary observation identity moved to `serving/canary-observation-id.ts` so the
// READER entry may import it — `curator/disposition.ts` names the writer-side bundle store, the
// egress checkpoint and the queue payloads, none of which a read may reach. The move is only
// safe if it is a MOVE: the writer stamps this id onto the event it appends and the reader
// recomputes it to find that event again, so a second spelling would be a silent attribution
// failure rather than a compile error.
describe('canaryOutcomeObservationId has exactly one implementation', () => {
  it('is the SAME function reference through both module paths, for the same bytes', async () => {
    const serving = await import('../serving/canary-observation-id.js')
    const curator = await import('../curator/disposition.js')

    expect(serving.canaryOutcomeObservationId).toBeTypeOf('function')
    expect(curator.canaryOutcomeObservationId).toBe(serving.canaryOutcomeObservationId)

    const tuple = {
      candidateId: asRecordId('cand-1'),
      runId: 'run-A',
      testId: 't',
      testIndex: 0,
      stepIndex: 2,
    }
    const id = serving.canaryOutcomeObservationId(tuple)
    expect(id).toMatch(/^canary-outcome:[0-9a-f]{64}$/)
    expect(curator.canaryOutcomeObservationId(tuple)).toBe(id)
  })
})
