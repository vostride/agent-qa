import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  foldBundleTrust,
  normalizeAnchor,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  BundleOutcomeEvent,
  BundleRelation,
  ScreenState,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ARTIFACT_STEP_CAP_BYTES } from '../artifact-copy.js'
import {
  deriveBundleTrust,
  loadBundle,
  verifyBundleIntegrity,
  type LoadedBundle,
  type LoadBundleOutcome,
} from '../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../bundle-publish.test-helper.js'
import {
  makeArtifactFixture,
  makeDiscriminantFixture,
  makeProcedureBundleDraftFixture,
  makeProcedureScreenStateSequenceFixture,
} from './fixtures/bundle-fixture.js'

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function expectLoaded(outcome: LoadBundleOutcome): LoadedBundle {
  expect(outcome.kind).toBe('loaded')
  if (outcome.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${outcome.kind}`)
  return outcome.bundle
}

describe('tar-equivalent bundle self-sufficiency', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-roundtrip-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey,
    }
  }

  function procedureInput(
    screenStates: readonly ScreenState[],
    initialEvents: readonly BundleOutcomeEvent[],
    relation: BundleRelation,
    artifacts: PublishBundleInput['artifacts'],
  ): PublishBundleInput {
    return {
      draft: makeProcedureBundleDraftFixture(),
      discriminant: makeDiscriminantFixture('procedure'),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates,
      initialEvents,
      relations: [relation],
      provenance: {
        mode: 'run-linked',
        runId: 'roundtrip-run',
        testId: 'roundtrip-sign-in',
        stepIndex: 0,
      },
      artifacts,
      evidenceMarkdown: 'The three recorded states preserve the complete procedure sequence.\n',
    }
  }

  it('loads and verifies a full-featured procedure after its source root is removed', () => {
    const screenStates = makeProcedureScreenStateSequenceFixture()
    const initialEvents = [
      BundleOutcomeEventSchema.parse({
        type: 'confirmed',
        evidenceToken: 'roundtrip-confirmed',
        curationJobId: 'roundtrip-job-confirmed',
        buildOrdinal: 42,
        origin: 'agent-verified',
      }),
      BundleOutcomeEventSchema.parse({
        type: 'helpful',
        evidenceToken: 'roundtrip-helpful',
        curationJobId: 'roundtrip-job-helpful',
        buildOrdinal: 43,
        origin: 'agent-verified',
      }),
    ]
    const relation: BundleRelation = {
      type: 'derived-from',
      targetId: 'fact-source-0123456789abcdef',
      addedAtOrdinal: 42,
      curationJobId: 'roundtrip-relation-job',
    }
    const primary = makeArtifactFixture()
    const secondaryBytes = Uint8Array.from(Buffer.from('agent-qa second roundtrip artifact\n'))
    const secondaryRef: ArtifactRef = {
      id: 'bundle-fixture-console-log',
      sha: sha(secondaryBytes),
    }
    const primarySource = join(root, 'decision-screenshot.bin')
    const secondarySource = join(root, 'console-log.txt')
    writeFileSync(primarySource, primary.bytes)
    writeFileSync(secondarySource, secondaryBytes)
    const storeConfig = config('roundtrip-store')
    const input = procedureInput(screenStates, initialEvents, relation, [
      {
        ref: primary.ref,
        sourcePath: primarySource,
        stepIndex: 0,
        role: 'decision-screenshot',
      },
      {
        ref: secondaryRef,
        sourcePath: secondarySource,
        stepIndex: 2,
        role: 'console-log',
      },
    ])

    const published = publishBundle(storeConfig, input)
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected procedure publication')

    const relocatedDir = join(root, 'fresh-machine', published.id)
    cpSync(published.dir, relocatedDir, { recursive: true })
    rmSync(storeConfig.knowledgeRoot, { recursive: true, force: true })
    expect(existsSync(published.dir)).toBe(false)

    const loaded = expectLoaded(loadBundle(relocatedDir))
    const expectedDraft = makeProcedureBundleDraftFixture()
    expect(loaded.frontmatter).toMatchObject({
      id: published.id,
      kind: 'procedure',
      anchors: expectedDraft.anchors.map((raw) => ({ raw, normalized: normalizeAnchor(raw) })),
      scope: expectedDraft.scope,
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      evidenceIncomplete: false,
    })
    expect(loaded.frontmatter).not.toHaveProperty('subtype')
    expect(loaded.manifest.id).toBe(published.id)
    expect(loaded.manifest.identityHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(loaded.manifest.contentHashes)).toEqual(
      expect.arrayContaining([
        'record.md',
        'relations.json',
        'provenance.json',
        'evidence/screenstates/step-0.json',
        'evidence/screenstates/step-1.json',
        'evidence/screenstates/step-2.json',
        'evidence/outcomes.jsonl',
        'artifacts.index.json',
      ]),
    )
    expect(loaded.screenStates).toEqual(screenStates)
    expect(loaded.relations.relations).toEqual([relation])
    expect(loaded.provenance).toEqual({
      schemaVersion: loaded.manifest.schemaVersion,
      mode: 'run-linked',
      originClass: 'agent-verified',
      runId: 'roundtrip-run',
      testId: 'roundtrip-sign-in',
      stepIndex: 0,
    })
    expect(loaded.events).toEqual(initialEvents)
    expect(loaded.artifactsIndex.artifacts).toHaveLength(2)
    for (const artifact of loaded.artifactsIndex.artifacts) {
      const bytes = readFileSync(join(relocatedDir, artifact.relPath))
      expect(bytes.byteLength).toBe(artifact.bytes)
      expect(sha(bytes)).toBe(artifact.sha)
    }
    expect(verifyBundleIntegrity(relocatedDir)).toEqual({ ok: true, violations: [] })
    expect(deriveBundleTrust(loaded)).toEqual(
      foldBundleTrust(initialEvents, {
        originClass: 'agent-verified',
        evidenceIncomplete: false,
        createdAtOrdinal: 42,
      }),
    )
  })

  it('mints overflow as evidence-incomplete without a dangling row and lowers trust', () => {
    const screenStates = makeProcedureScreenStateSequenceFixture()
    const initialEvents = [
      BundleOutcomeEventSchema.parse({
        type: 'confirmed',
        evidenceToken: 'caps-confirmed',
        curationJobId: 'caps-job',
        buildOrdinal: 42,
        origin: 'agent-verified',
      }),
    ]
    const relation: BundleRelation = {
      type: 'relates-to',
      targetId: 'fact-cap-control-0123456789abcdef',
      addedAtOrdinal: 42,
      curationJobId: 'caps-relation-job',
    }
    const oversizedBytes = Buffer.alloc(ARTIFACT_STEP_CAP_BYTES + 1, 97)
    const oversizedSource = join(root, 'oversized-artifact.bin')
    writeFileSync(oversizedSource, oversizedBytes)
    const oversizedRef: ArtifactRef = {
      id: 'oversized-artifact',
      sha: sha(oversizedBytes),
    }
    const cleanInput = procedureInput(screenStates, initialEvents, relation, [])
    const incompleteInput = procedureInput(screenStates, initialEvents, relation, [
      {
        ref: oversizedRef,
        sourcePath: oversizedSource,
        stepIndex: 0,
        role: 'oversized-control',
      },
    ])

    const cleanPublished = publishBundle(config('caps-clean'), cleanInput)
    const incompletePublished = publishBundle(config('caps-incomplete'), incompleteInput)
    expect(cleanPublished.kind).toBe('published')
    expect(incompletePublished.kind).toBe('published')
    if (cleanPublished.kind !== 'published' || incompletePublished.kind !== 'published') {
      throw new Error('expected cap-control bundle publication')
    }

    const clean = expectLoaded(loadBundle(cleanPublished.dir))
    const incomplete = expectLoaded(loadBundle(incompletePublished.dir))
    expect(incomplete.manifest.evidenceIncomplete).toBe(true)
    expect(incomplete.frontmatter.evidenceIncomplete).toBe(true)
    expect(incomplete.artifactsIndex.artifacts).toEqual([])
    expect(existsSync(join(incompletePublished.dir, 'artifacts', oversizedRef.sha))).toBe(false)
    expect(verifyBundleIntegrity(incompletePublished.dir)).toEqual({ ok: true, violations: [] })
    expect(deriveBundleTrust(incomplete).trust).toBeLessThan(deriveBundleTrust(clean).trust)
  })
})
