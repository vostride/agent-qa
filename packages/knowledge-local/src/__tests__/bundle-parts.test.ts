import { createHash } from 'node:crypto'

import {
  BUNDLE_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  committedFileText,
  computeMutableStateHash,
  guardArtifactsIndex,
  guardBundleManifest,
  parseRecordMarkdown,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { ArtifactCopyResult } from '../artifact-copy.js'
import { renderBundleParts, type RenderBundlePartsInput } from '../bundle-parts.js'
import { MUTABLE_BUNDLE_TARGETS } from '../journal/bundle-mutation'
import {
  makeArtifactFixture,
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function makeInput(): RenderBundlePartsInput {
  const artifact = makeArtifactFixture()
  const copiedArtifacts: ArtifactCopyResult = {
    copied: [
      {
        ref: artifact.ref,
        relPath: `artifacts/${artifact.sha}`,
        bytes: artifact.bytes.byteLength,
        stepIndex: 2,
        role: 'decision-screenshot',
        originalName: 'sign-in.png',
      },
    ],
    skipped: [
      {
        ref: { id: 'pruned-video', sha: 'b'.repeat(64) },
        stepIndex: 2,
        reason: 'pruned-source',
      },
    ],
    evidenceIncomplete: true,
  }

  return {
    draft: makeBundleDraftFixture({ kind: 'procedure' }),
    discriminant: makeDiscriminantFixture('procedure'),
    originClass: 'agent-verified',
    createdAtOrdinal: 42,
    screenStates: [
      makeScreenStateFixture(0),
      makeScreenStateFixture(1),
      makeScreenStateFixture(2),
    ],
    initialEvents: [
      BundleOutcomeEventSchema.parse({
        type: 'confirmed',
        evidenceToken: 'fixture-confirmed',
        curationJobId: 'fixture-job-1',
        buildOrdinal: 42,
        origin: 'agent-verified',
      }),
      BundleOutcomeEventSchema.parse({
        type: 'helpful',
        evidenceToken: 'fixture-helpful',
        curationJobId: 'fixture-job-2',
        buildOrdinal: 43,
        observationOrdinal: 7,
        origin: 'agent-verified',
      }),
    ],
    relations: [
      {
        type: 'derived-from',
        targetId: 'fact-el-sign-in-source-0123456789abcdef',
        addedAtOrdinal: 42,
        curationJobId: 'fixture-job-1',
      },
    ],
    provenance: {
      mode: 'run-linked',
      runId: 'fixture-run',
      testId: 'fixture-sign-in',
      stepIndex: 2,
    },
    copiedArtifacts,
    evidenceIncomplete: true,
    evidenceMarkdown: 'Observed a stable three-step sign-in flow.\n',
  }
}

function part(input: ReturnType<typeof renderBundleParts>, relPath: string) {
  const found = input.parts.find((candidate) => candidate.relPath === relPath)
  if (found === undefined) throw new Error(`missing rendered part: ${relPath}`)
  return found
}

describe('renderBundleParts committed layout', () => {
  it('declares exactly the seven mutable bundle targets, in declaration order', () => {
    expect([...MUTABLE_BUNDLE_TARGETS]).toEqual([
      'record.md',
      'provenance.json',
      'evidence/outcomes.jsonl',
      'evidence/measurements.json',
      'evidence/gates.jsonl',
      'relations.json',
      'manifest.json',
    ])
  })

  it('never renders the optional gates part at publish', () => {
    expect(renderBundleParts(makeInput()).parts.map(({ relPath }) => relPath))
      .not.toContain('evidence/gates.jsonl')
  })

  it('renders every committed text part in deterministic order with manifest last', () => {
    const rendered = renderBundleParts(makeInput())

    expect(rendered.parts.map(({ relPath }) => relPath)).toEqual([
      'record.md',
      'provenance.json',
      'relations.json',
      'evidence/screenstates/step-0.json',
      'evidence/screenstates/step-1.json',
      'evidence/screenstates/step-2.json',
      'evidence/outcomes.jsonl',
      'evidence/evidence.md',
      'artifacts.index.json',
      'manifest.json',
    ])
    expect(rendered.parts.at(-1)?.relPath).toBe('manifest.json')
  })

  it('hashes every non-manifest part exactly and agrees on mutable state identity', () => {
    const rendered = renderBundleParts(makeInput())
    const manifest = guardBundleManifest(JSON.parse(part(rendered, 'manifest.json').text))
    const nonManifestParts = rendered.parts.slice(0, -1)

    expect(manifest.contentHashes).toEqual(
      Object.fromEntries(nonManifestParts.map(({ relPath, text }) => [relPath, textSha(text)])),
    )
    expect(manifest.mutableStateHash).toBe(
      computeMutableStateHash({
        outcomes: textSha(part(rendered, 'evidence/outcomes.jsonl').text),
        relations: textSha(part(rendered, 'relations.json').text),
        artifactsIndex: textSha(part(rendered, 'artifacts.index.json').text),
      }),
    )
    expect(manifest.complete).toBe(true)
    expect(manifest.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION)
  })

  it('commits each recorded ScreenState verbatim with no pruning', () => {
    const input = makeInput()
    const rendered = renderBundleParts(input)

    input.screenStates.forEach((screenState, stepIndex) => {
      expect(part(rendered, `evidence/screenstates/step-${stepIndex}.json`).text).toBe(
        committedFileText(screenState),
      )
    })
  })

  it('lists only artifacts that were actually copied and echoes the immutable marker', () => {
    const rendered = renderBundleParts(makeInput())
    const index = guardArtifactsIndex(JSON.parse(part(rendered, 'artifacts.index.json').text))
    const record = parseRecordMarkdown(part(rendered, 'record.md').text)

    expect(index.artifacts).toHaveLength(1)
    expect(index.artifacts[0]?.id).toBe('bundle-fixture-screenshot')
    expect(index.artifacts.some(({ id }) => id === 'pruned-video')).toBe(false)
    expect(record.frontmatter.evidenceIncomplete).toBe(true)
  })

  it('renders the same input byte-identically', () => {
    const input = makeInput()

    expect(renderBundleParts(input)).toEqual(renderBundleParts(input))
  })
})
