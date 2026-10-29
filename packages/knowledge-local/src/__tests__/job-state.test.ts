import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireWriterLease,
  claimNextJob,
  claimedCandidateDir,
  claimedLeaseDir,
  jobStatePath,
  listClaimedLeases,
  listQueuedCandidates,
  persistAuthoredCheckpoint,
  readCurationCandidatePayload,
  readJobState,
  requeueClaimed,
  queuedCandidateDir,
  writeJobState,
  type CurationCandidatePayload,
  type CurationJobLifecycle,
  type CurrentWriterAuthority,
} from '../index.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from './fixtures/curation-candidate-fixture.js'

describe('curation queue claim and durable lifecycle', () => {
  let root: string
  let knowledgeRoot: string
  let authority: CurrentWriterAuthority

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-job-state-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected test writer authority')
    authority = { leaseId: acquired.leaseId, epoch: acquired.epoch }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function projectionInput(seed: string): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: seed }],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was resolved and verified.`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: seed, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `button:${seed}` },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      emittedAt: '2026-07-15T10:00:00.000Z',
    }
  }

  function enqueue(seed: string): CurationCandidatePayload {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projectionInput(seed),
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
    const read = readCurationCandidatePayload(
      queuedCandidateDir(knowledgeRoot, outcome.candidateId),
    )
    expect(read.kind).toBe('parsed')
    if (read.kind !== 'parsed') throw new Error('expected parsed projection payload')
    expect(read.payload.candidateId).toBe(outcome.candidateId)
    return read.payload
  }

  it('claims queued candidates in deterministic id order and returns parsed paths', () => {
    const firstInput = enqueue('zulu')
    const secondInput = enqueue('alpha')
    const expectedOrder = [firstInput.candidateId, secondInput.candidateId].sort()

    expect(listQueuedCandidates(knowledgeRoot)).toEqual(expectedOrder)
    const firstClaim = claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })
    expect(firstClaim?.kind).toBe('claimed')
    if (firstClaim?.kind !== 'claimed') throw new Error('expected first claimed job')
    expect(firstClaim.candidateId).toBe(expectedOrder[0])
    expect(firstClaim.payload.candidateId).toBe(expectedOrder[0])
    expect(firstClaim.candidateDir).toBe(
      claimedCandidateDir(knowledgeRoot, authority.leaseId, expectedOrder[0]!),
    )
    expect(firstClaim.payloadPath).toBe(join(firstClaim.candidateDir, 'payload.json'))
    expect(existsSync(queuedCandidateDir(knowledgeRoot, expectedOrder[0]!))).toBe(false)
    expect(existsSync(firstClaim.candidateDir)).toBe(true)

    const secondClaim = claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })
    expect(secondClaim?.candidateId).toBe(expectedOrder[1])
    expect(claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })).toBeUndefined()
    expect(listClaimedLeases(knowledgeRoot)).toEqual([authority.leaseId])
  })

  it('atomically round-trips all five lifecycle values and degrades corrupt state', () => {
    const candidate = enqueue('lifecycle')
    const lifecycles: CurationJobLifecycle[] = [
      'queued',
      'authored',
      'bundling',
      'committing',
    ]
    for (const lifecycle of lifecycles) {
      writeJobState({
        knowledgeRoot,
        candidateId: candidate.candidateId,
        authority,
        lifecycle,
      })
      const read = readJobState(knowledgeRoot, candidate.candidateId)
      expect(read.kind).toBe('parsed')
      if (read.kind !== 'parsed') throw new Error('expected parsed state')
      expect(read.state.lifecycle).toBe(lifecycle)
      expect(read.state.embedCrashCount).toBe(0)
    }

    const claimedDir = claimedCandidateDir(
      knowledgeRoot,
      authority.leaseId,
      candidate.candidateId,
    )
    mkdirSync(claimedDir, { recursive: true })
    writeJobState({
      knowledgeRoot,
      candidateId: candidate.candidateId,
      authority,
      lifecycle: 'done',
    })
    expect(readJobState(knowledgeRoot, candidate.candidateId)).toEqual({
      kind: 'absent',
      present: false,
    })
    expect(existsSync(claimedDir)).toBe(false)

    const stateFile = jobStatePath(knowledgeRoot, candidate.candidateId)
    mkdirSync(join(stateFile, '..'), { recursive: true })
    writeFileSync(stateFile, '{broken-json', 'utf8')
    expect(readJobState(knowledgeRoot, candidate.candidateId)).toEqual({
      kind: 'malformed',
      present: true,
    })
  })

  it('persists the opaque authored checkpoint and durable embed crash count', () => {
    const candidate = enqueue('authored')
    const authored = {
      delta: { kind: 'Add', aliases: [1, 3] },
      neighbors: ['record-a', 'record-b'],
      nested: { preserve: true },
    }
    writeJobState({
      knowledgeRoot,
      candidateId: candidate.candidateId,
      authority,
      lifecycle: 'queued',
      embedCrashCount: 1,
    })

    const persisted = persistAuthoredCheckpoint({
      knowledgeRoot,
      candidateId: candidate.candidateId,
      authority,
      authored,
    })
    expect(persisted.kind).toBe('persisted')
    const read = readJobState(knowledgeRoot, candidate.candidateId)
    expect(read.kind).toBe('parsed')
    if (read.kind !== 'parsed') throw new Error('expected parsed authored state')
    expect(read.state.lifecycle).toBe('authored')
    expect(read.state.authored).toEqual(authored)
    expect(read.state.embedCrashCount).toBe(1)

    writeJobState({
      knowledgeRoot,
      candidateId: candidate.candidateId,
      authority,
      lifecycle: 'bundling',
      embedCrashCount: read.state.embedCrashCount + 1,
      authored: read.state.authored,
    })
    const incremented = readJobState(knowledgeRoot, candidate.candidateId)
    expect(incremented.kind).toBe('parsed')
    if (incremented.kind !== 'parsed') throw new Error('expected incremented state')
    expect(incremented.state.embedCrashCount).toBe(2)
    expect(incremented.state.authored).toEqual(authored)
  })

  it('requeues a claimed candidate while preserving its authored checkpoint', () => {
    const candidate = enqueue('requeue')
    const claim = claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })
    expect(claim?.kind).toBe('claimed')
    if (claim?.kind !== 'claimed') throw new Error('expected claimed job')
    const authored = { delta: { kind: 'Add', body: 'opaque' }, neighborIds: ['record-1'] }
    expect(
      persistAuthoredCheckpoint({
        knowledgeRoot,
        candidateId: candidate.candidateId,
        authority,
        authored,
      }).kind,
    ).toBe('persisted')
    const before = readJobState(knowledgeRoot, candidate.candidateId)
    expect(before.kind).toBe('parsed')
    if (before.kind !== 'parsed') throw new Error('expected authored state')
    writeJobState({
      knowledgeRoot,
      candidateId: candidate.candidateId,
      authority,
      lifecycle: 'bundling',
      embedCrashCount: before.state.embedCrashCount,
      authored: before.state.authored,
    })

    expect(requeueClaimed({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })).toEqual([candidate.candidateId])
    expect(existsSync(queuedCandidateDir(knowledgeRoot, candidate.candidateId))).toBe(true)
    expect(existsSync(claimedLeaseDir(knowledgeRoot, authority.leaseId))).toBe(false)
    const after = readJobState(knowledgeRoot, candidate.candidateId)
    expect(after.kind).toBe('parsed')
    if (after.kind !== 'parsed') throw new Error('expected requeued state')
    expect(after.state.lifecycle).toBe('queued')
    expect(after.state.authored).toEqual(before.state.authored)
    expect(after.state.authored).toEqual(authored)
  })
})
