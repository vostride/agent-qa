import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION, serializeProcedureBody, type BundleDraft, type Delta } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  acquireWriterLease,
  candidateContentAddress,
  commitCurationDelta,
  enumerateBundleDirs,
  loadBundle,
  openIndexReaderConnection,
  verifyBundleIntegrity,
  type AuthoredDeltaCheckpoint,
  type CommitCurationDependencies,
  type CommitCurationJob,
} from '../../index.js'
import { candidateAddressFixture } from '../../__tests__/fixtures/curation-candidate-fixture.js'
import {
  makeProcedureBodyPayloadFixture,
  makeProcedureBundleDraftFixture,
  makeProcedureScreenStateSequenceFixture,
} from '../../__tests__/fixtures/bundle-fixture.js'

describe('procedure-kind commit mint contract', () => {
  let root: string
  let knowledgeRoot: string
  let epoch: number
  let leaseId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-procedure-commit-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    epoch = lease.epoch
    leaseId = lease.leaseId
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  interface CommitProcedureOptions {
    draft?: BundleDraft
    sourceRunId?: string
    buildOrdinal?: number
    evidenceToken?: string
    attributingObservationId?: string
  }

  function commitProcedure(options: CommitProcedureOptions = {}) {
    const draft = options.draft ?? makeProcedureBundleDraftFixture()
    const sourceRunId = options.sourceRunId ?? 'run-procedure-commit'
    const buildOrdinal = options.buildOrdinal ?? 81
    const evidenceToken = options.evidenceToken ?? 'procedure-evidence'
    const attributingObservationId =
      options.attributingObservationId ?? 'run-procedure-commit:test-sign-in:step-0'
    const screenStates = makeProcedureScreenStateSequenceFixture()
    const artifacts = screenStates.map((_, stepIndex) => {
      const role = stepIndex === 1 ? 'dom-snapshot' as const : 'opaque-evidence' as const
      const originalName = stepIndex === 1
        ? 'procedure-step-1.dom.json'
        : `procedure-step-${stepIndex}.txt`
      const bytes = Buffer.from(
        stepIndex === 1
          ? '{"role":"textbox","name":"Password"}\n'
          : `procedure capture ${stepIndex}\n`,
      )
      return {
        bytes,
        sha: createHash('sha256').update(bytes).digest('hex'),
        stepIndex,
        role,
        originalName,
      }
    })
    const fields = candidateAddressFixture({
      schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
      sourceRunId,
      scope: draft.scope,
      buildOrdinal,
      executionContext: 'local-interactive',      kind: 'procedure',
      anchors: draft.anchors,
      summarySeed: draft.summary,
      bodySeed: draft.body,
      distilledObservations: screenStates.map((_, stepIndex) => ({
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: ['enter-email', 'enter-password', 'submit'][stepIndex]!, ordinal: stepIndex },
        platform: 'web',
        test: { id: 'sign-in-test' },
        procedure: { id: 'sign-in-flow' },
        flow: {
          name: 'Sign in flow',
          ...(stepIndex === 0 ? {} : { precedes: ['enter-email', 'enter-password'][stepIndex - 1]! }),
        },
        surface: { kind: 'page', naturalKey: '/login' },
        // Candidacy needs resolved-element evidence on every covered step.
        element: {
          naturalKey: ['textbox:email', 'textbox:password', 'button:sign in'][stepIndex]!,
        },
        observedAtOrdinal: buildOrdinal + stepIndex,
      })),
      evidenceToken,
      attributingObservationId,
      artifactInventory: artifacts.map(({ bytes, sha, stepIndex, role, originalName }) => ({
        relativePath: `artifacts/${sha}`,
        sha256: sha,
        bytes: bytes.byteLength,
        stepIndex,
        role,
        originalName,
      })),
      emittedAt: '2026-07-15T10:00:00.000Z',
    })
    expect(
      fields.artifactInventory.map(({ stepIndex, role, originalName }) => ({
        stepIndex,
        role,
        originalName,
      })),
    ).toEqual([
      { stepIndex: 0, role: 'opaque-evidence', originalName: 'procedure-step-0.txt' },
      { stepIndex: 1, role: 'dom-snapshot', originalName: 'procedure-step-1.dom.json' },
      { stepIndex: 2, role: 'opaque-evidence', originalName: 'procedure-step-2.txt' },
    ])
    const candidateId = candidateContentAddress(fields)
    const candidateDir = join(root, 'claimed', candidateId)
    const artifactsDir = join(candidateDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    for (const artifact of artifacts) {
      writeFileSync(join(artifactsDir, artifact.sha), artifact.bytes)
    }
    const job: CommitCurationJob = {
      kind: 'claimed',
      candidateId,
      leaseId,
      payload: { candidateId, ...fields },
      candidateDir,
      payloadPath: join(candidateDir, 'payload.json'),
      artifactsDir,
      screenStates,
    }
    const delta: Delta = {
      kind: 'Add',
      origin: 'agent',
      scope: draft.scope,
      citedIds: [],
      authorship: {
        path: 'llm',
        model: { id: 'procedure-fixture' },
        executionContext: 'local-interactive',
      },
      bundle: draft,
    }
    const checkpoint: AuthoredDeltaCheckpoint = {
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      delta,
      neighborIds: [],
      preconditions: [],
      authorship: delta.authorship!,
    }
    const dependencies: CommitCurationDependencies = {
      knowledgeRoot,
      epoch,
      profile: { mode: 'drain-to-active' },
      drainState: { supersedesSeenByAnchorKey: new Map() },
    }
    return commitCurationDelta(dependencies, job, checkpoint)
  }

  it('publishes manifest, procedure frontmatter, ordered ScreenStates, per-step artifacts, and index row', () => {
    const outcome = commitProcedure()
    expect(outcome.kind).toBe('applied')
    if (outcome.kind !== 'applied') throw new Error('expected applied procedure')

    const loaded = loadBundle(outcome.bundleDir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected loaded procedure')
    expect(loaded.bundle.manifest.complete).toBe(true)
    expect(loaded.bundle.frontmatter.kind).toBe('procedure')
    expect(loaded.bundle.screenStates).toHaveLength(3)
    expect(loaded.bundle.artifactsIndex.artifacts.map(({ stepIndex }) => stepIndex)).toEqual([0, 1, 2])

    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db.prepare('SELECT bundle_id FROM records WHERE bundle_id = ?').get(outcome.bundleId),
      ).toMatchObject({ bundle_id: outcome.bundleId })
    } finally {
      reader.db.close()
    }
  })

  it('round-trips as a self-sufficient, integrity-valid committed bundle', () => {
    const outcome = commitProcedure()
    if (outcome.kind !== 'applied') throw new Error('expected applied procedure')

    expect(verifyBundleIntegrity(outcome.bundleDir)).toEqual({ ok: true, violations: [] })
    const roundTrip = loadBundle(outcome.bundleDir)
    expect(roundTrip.kind).toBe('loaded')
    if (roundTrip.kind !== 'loaded') throw new Error('expected procedure round-trip')
    expect(roundTrip.bundle.manifest.id).toBe(outcome.bundleId)
    expect(roundTrip.bundle.provenance).toMatchObject({
      mode: 'run-linked',
      curationJobId: expect.any(String),
      sourceBuildOrdinal: 81,
    })
  })

  it('refuses an unparseable procedure body without minting a bundle', () => {
    const outcome = commitProcedure({
      draft: makeProcedureBundleDraftFixture({ body: 'not a committed procedure body' }),
    })

    expect(outcome).toEqual({ kind: 'noop', reason: 'procedure-body-unparseable' })
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(0)
  })

  it('keeps equal-prose procedures with different structural guards in distinct bundles', () => {
    const originalPayload = makeProcedureBodyPayloadFixture()
    const firstStep = originalPayload.steps[0]!
    const structurallyDistinctPayload = makeProcedureBodyPayloadFixture({
      steps: [
        {
          ...firstStep,
          guard: {
            ...firstStep.guard,
            target: { ...firstStep.guard.target, nameNormalized: 'username' },
          },
        },
        ...originalPayload.steps.slice(1),
      ],
    })
    const first = commitProcedure({
      draft: makeProcedureBundleDraftFixture({
        body: serializeProcedureBody(originalPayload),
      }),
    })
    const second = commitProcedure({
      draft: makeProcedureBundleDraftFixture({
        body: serializeProcedureBody(structurallyDistinctPayload),
      }),
      sourceRunId: 'run-procedure-commit-guard-variant',
      buildOrdinal: 82,
      evidenceToken: 'procedure-evidence-guard-variant',
      attributingObservationId: 'run-procedure-commit-guard-variant:test-sign-in:step-0',
    })

    expect(first.kind).toBe('applied')
    expect(second.kind).toBe('applied')
    if (first.kind !== 'applied' || second.kind !== 'applied') {
      throw new Error('expected structurally distinct procedures to apply')
    }
    expect(second.bundleId).not.toBe(first.bundleId)
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(2)
  })

  it('coalesces an identical structural re-extraction and appends Confirm evidence', () => {
    const first = commitProcedure()
    const second = commitProcedure({
      sourceRunId: 'run-procedure-commit-reextraction',
      buildOrdinal: 82,
      evidenceToken: 'procedure-evidence-reextraction',
      attributingObservationId: 'run-procedure-commit-reextraction:test-sign-in:step-0',
    })

    expect(first.kind).toBe('applied')
    expect(second.kind).toBe('converted-confirm')
    if (first.kind !== 'applied' || second.kind !== 'converted-confirm') {
      throw new Error('expected identical procedure re-extraction to convert to Confirm')
    }
    expect(second.bundleId).toBe(first.bundleId)
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(1)

    const loaded = loadBundle(second.bundleDir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected coalesced procedure bundle')
    expect(loaded.bundle.events.filter((event) => event.type === 'confirmed')).toHaveLength(2)
  })
})
