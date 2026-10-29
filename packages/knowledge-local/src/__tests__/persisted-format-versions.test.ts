import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION, canonicalJson } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  authoredCheckpointSchema,
} from '../curator/author-contract.js'
import {
  ENTITY_INDEX_USER_VERSION,
  EntityIndexSchemaVersionError,
  entityIndexDbPath,
  openEntityIndex,
} from '../entity-index/entity-index.js'
import {
  BUNDLE_MUTATION_JOURNAL_VERSION,
  commitBundleMutation,
  recoverExpiredBundleMutations,
} from '../journal/bundle-mutation.js'
import {
  COMPLETED_EFFECTS_SUBDIR,
  curationEffectReceiptSchema,
  curationObservationSchema,
  effectIdentity,
  listCurationEffectReceipts,
  writeCurationEffectReceipt,
} from '../journal/curation-effect-receipt.js'
import {
  COMMIT_INTENT_SCHEMA_VERSION,
  JOURNAL_SUBDIR,
  listCommitIntents,
  writeCommitIntent,
} from '../journal/intent-journal.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import {
  CURATION_QUARANTINE_FILE,
  CURATION_QUARANTINE_SCHEMA_VERSION,
  claimNextJob,
  quarantineClaimed,
} from '../queue/curation-queue.js'
import {
  CURATION_JOB_STATE_SCHEMA_VERSION,
  persistAuthoredCheckpoint,
  readJobState,
  writeJobState,
} from '../queue/job-state.js'
import { jobStatePath, quarantinedCandidateDir } from '../queue-transport.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function knowledgeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-runtime-stamps-'))
  roots.push(root)
  return join(root, 'agent-qa-knowledge')
}

function writer(root: string): { leaseId: string; epoch: number } {
  const lease = acquireWriterLease(root)
  if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
  return { leaseId: lease.leaseId, epoch: lease.epoch }
}

function restamp(file: string, key: 'schemaVersion' | 'version', stamp: number): void {
  const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, `${canonicalJson({ ...document, [key]: stamp })}\n`, 'utf8')
}

function claimedCandidate(root: string, authority: { leaseId: string; epoch: number }) {
  const enqueued = enqueueArtifactFreeCandidateProjection({
    knowledgeRoot: root,
    projectionInput: {
      sourceRunId: 'run-stamps',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',
      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'stamps' }],
      summarySeed: 'stamps selector',
      bodySeed: 'stamps was resolved and verified.',
      distilledObservations: [{
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'stamps', ordinal: 0 },
        platform: 'web',
        element: { naturalKey: 'button:stamps' },
        observedAtOrdinal: 42,
      }],
      evidenceToken: 'evidence-stamps',
      attributingObservationId: 'observation-stamps',
      emittedAt: new Date(0).toISOString(),
    },
  })
  if (enqueued.kind !== 'enqueued') throw new Error('expected an enqueued candidate')
  const claimed = claimNextJob({ knowledgeRoot: root, leaseId: authority.leaseId, authority })
  if (claimed?.kind !== 'claimed') throw new Error('expected a claimed candidate')
  return claimed
}

const OBSERVATION = {
  sourceRunId: 'run-stamps',
  observationId: 'observation-stamps',
  originalDeltaKind: 'Add' as const,
  appliedDeltaKind: 'Add' as const,
  disposition: 'apply' as const,
}

function receipt(stamp: number) {
  const candidateId = 'a'.repeat(64)
  const effect = {
    recordId: 'fact-stamps',
    product: 'storefront',
    change: 'added' as const,
    atOrdinal: 42,
    evidenceToken: 'evidence-stamps',
  }
  return {
    schemaVersion: stamp as 2,
    candidateId,
    effectId: effectIdentity(candidateId, effect),
    ...effect,
    ...OBSERVATION,
  }
}

describe('knowledge-local runtime stamps', () => {
  it('stamps a fresh entity index 2 and refuses one stamped 1 with EntityIndexSchemaVersionError', () => {
    const fresh = knowledgeRoot()
    const handle = openEntityIndex({ path: entityIndexDbPath(fresh), knowledgeRoot: fresh })
    const stamped = handle.connection.db.prepare('PRAGMA user_version').get()?.user_version
    handle.close()
    expect(ENTITY_INDEX_USER_VERSION).toBe(2)
    expect(Number(stamped)).toBe(2)

    const older = knowledgeRoot()
    const path = entityIndexDbPath(older)
    mkdirSync(join(older, 'memory', 'index'), { recursive: true })
    const planted = new DatabaseSync(path)
    planted.exec('PRAGMA user_version = 1')
    planted.close()

    let refusal: unknown
    try {
      openEntityIndex({ path, knowledgeRoot: older }).close()
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(EntityIndexSchemaVersionError)
    expect(refusal).toMatchObject({ foundVersion: 1, supportedVersion: 2 })
    expect(existsSync(path)).toBe(true)
  })

  it('writes a mutation journal at 2 and refuses to recover one stamped 1', () => {
    const root = knowledgeRoot()
    const bundleId = 'fact-stamps-0123456789abcdef'
    const bundleDir = join(root, 'memory', 'storefront', 'bundles', bundleId)
    const leaseId = 'expired-lease'
    mkdirSync(bundleDir, { recursive: true })
    expect(() => commitBundleMutation({
      knowledgeRoot: root,
      bundleDir,
      bundleId,
      writerLeaseId: leaseId,
      replacements: [
        { targetRelPath: 'record.md', text: 'record\n' },
        { targetRelPath: 'manifest.json', text: '{}\n' },
      ],
      afterMutableReplacement: () => {
        throw new Error('writer stopped mid-mutation')
      },
    })).toThrow('writer stopped mid-mutation')
    const stagingRoot = join(bundleDir, '..', '.staging')
    const [transaction] = readdirSync(stagingRoot)
    const journalFile = join(stagingRoot, transaction!, 'mutation.json')
    expect(BUNDLE_MUTATION_JOURNAL_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(journalFile, 'utf8'))).toMatchObject({ version: 2 })

    restamp(journalFile, 'version', 1)
    expect(() => recoverExpiredBundleMutations(root, [leaseId])).toThrow()
    expect(existsSync(journalFile)).toBe(true)

    restamp(journalFile, 'version', 2)
    expect(recoverExpiredBundleMutations(root, [leaseId])).toEqual({
      mutationsRecovered: 1,
      recoveredBundleIds: [bundleId],
    })
  })

  it('writes a commit intent at 2 and lists one stamped 1 as malformed', () => {
    const root = knowledgeRoot()
    const candidateId = 'b'.repeat(64)
    writeCommitIntent(root, {
      schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
      candidateId,
      bundleId: 'fact-stamps',
      deltaKind: 'Add',
      epoch: 1,
      observation: { schemaVersion: 2, ...OBSERVATION, effects: [] },
    })
    const file = join(root, JOURNAL_SUBDIR, `${candidateId}.intent.json`)
    expect(COMMIT_INTENT_SCHEMA_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      observation: { schemaVersion: 2 },
    })
    expect(listCommitIntents(root)).toEqual([{ parsed: expect.any(Object) }])

    restamp(file, 'schemaVersion', 1)
    expect(listCommitIntents(root)).toEqual([{ malformed: true, candidateId }])
  })

  it('lists a commit intent whose observation is stamped 1 as malformed', () => {
    const root = knowledgeRoot()
    const candidateId = 'c'.repeat(64)
    const file = join(root, JOURNAL_SUBDIR, `${candidateId}.intent.json`)
    mkdirSync(join(root, JOURNAL_SUBDIR), { recursive: true })
    writeFileSync(file, `${canonicalJson({
      schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
      candidateId,
      bundleId: 'fact-stamps',
      deltaKind: 'Add',
      epoch: 1,
      observation: { schemaVersion: 1, ...OBSERVATION, effects: [] },
    })}\n`, 'utf8')

    expect(listCommitIntents(root)).toEqual([{ malformed: true, candidateId }])
  })

  it('writes a job state at 2 and reads one stamped 1 as malformed', () => {
    const root = knowledgeRoot()
    const authority = writer(root)
    const claimed = claimedCandidate(root, authority)
    writeJobState({
      knowledgeRoot: root,
      authority,
      candidateId: claimed.candidateId,
      lifecycle: 'bundling',
    })
    const file = jobStatePath(root, claimed.candidateId)
    expect(CURATION_JOB_STATE_SCHEMA_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 2 })

    restamp(file, 'schemaVersion', 1)
    expect(readJobState(root, claimed.candidateId)).toEqual({ kind: 'malformed', present: true })
    expect(persistAuthoredCheckpoint({
      knowledgeRoot: root,
      authority,
      candidateId: claimed.candidateId,
      authored: {},
    })).toEqual({ kind: 'malformed-state', present: true })
  })

  it('quarantines a claimed candidate whose job state is stamped 1 and writes its reason at 2', () => {
    const root = knowledgeRoot()
    const authority = writer(root)
    const claimed = claimedCandidate(root, authority)
    writeJobState({
      knowledgeRoot: root,
      authority,
      candidateId: claimed.candidateId,
      lifecycle: 'bundling',
    })
    restamp(jobStatePath(root, claimed.candidateId), 'schemaVersion', 1)

    const quarantined = quarantineClaimed({
      knowledgeRoot: root,
      leaseId: authority.leaseId,
      candidateId: claimed.candidateId,
      authority,
      reason: 'malformed-job-state',
    })
    expect(quarantined).toBe(quarantinedCandidateDir(root, claimed.candidateId))
    expect(CURATION_QUARANTINE_SCHEMA_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(join(quarantined, CURATION_QUARANTINE_FILE), 'utf8')))
      .toMatchObject({ schemaVersion: 2, reason: 'malformed-job-state' })
    expect(readJobState(root, claimed.candidateId)).toEqual({ kind: 'absent', present: false })
  })

  it('refuses an authored checkpoint stamped 1 at its strict schema', () => {
    const checkpoint = {
      deltas: [{ kind: 'Noop', origin: 'agent', scope: { tier: 'product', key: 'storefront' }, citedIds: [] }],
      neighborIds: [],
      preconditions: [],
      authorship: { path: 'llm', model: { id: 'curator-model' }, executionContext: 'local-interactive' },
    }
    expect(AUTHORED_CHECKPOINT_SCHEMA_VERSION).toBe(2)
    expect(authoredCheckpointSchema.safeParse({ ...checkpoint, schemaVersion: 2 }).success).toBe(true)
    expect(authoredCheckpointSchema.safeParse({ ...checkpoint, schemaVersion: 1 }).success).toBe(false)
  })

  it('refuses a curation observation stamped 1 at its strict schema', () => {
    const observation = { ...OBSERVATION, effects: [] }
    expect(curationObservationSchema.safeParse({ ...observation, schemaVersion: 2 }).success).toBe(true)
    expect(curationObservationSchema.safeParse({ ...observation, schemaVersion: 1 }).success).toBe(false)
  })

  it('writes a curation effect receipt at 2 and refuses to list one stamped 1', () => {
    const root = knowledgeRoot()
    const authority = writer(root)
    writeCurationEffectReceipt({ knowledgeRoot: root, authority, receipt: receipt(2) })
    const dir = join(root, COMPLETED_EFFECTS_SUBDIR)
    const file = join(dir, readdirSync(dir)[0]!)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 2 })
    expect(listCurationEffectReceipts(root)).toEqual([receipt(2)])

    expect(curationEffectReceiptSchema.safeParse(receipt(1)).success).toBe(false)
    restamp(file, 'schemaVersion', 1)
    expect(() => listCurationEffectReceipts(root)).toThrow('invalid curation effect receipt')
  })
})
