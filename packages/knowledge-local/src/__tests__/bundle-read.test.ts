import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLE_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  committedFileText,
  foldBundleTrust,
  guardBundleManifest,
} from '@vostride/agent-qa-schema'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

function flipFirstByte(file: string): void {
  const bytes = readFileSync(file)
  bytes[0] = bytes[0]! ^ 1
  writeFileSync(file, bytes)
}

function differentHexDigest(digest: string): string {
  return `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`
}

function differentIdentitySuffix(id: string): string {
  return id.replace(/[0-9a-f]{16}$/, (suffix) =>
    [...suffix].map((character) => (character === 'f' ? '0' : 'f')).join(''),
  )
}

function expectLoaded(outcome: LoadBundleOutcome): LoadedBundle {
  expect(outcome.kind).toBe('loaded')
  if (outcome.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${outcome.kind}`)
  return outcome.bundle
}

describe('bundle read, integrity, and disk-driven trust', () => {
  let root: string
  let bundleDir: string
  let screenState: ScreenState
  let artifactSha: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-read-'))
    const artifact = makeArtifactFixture()
    artifactSha = artifact.sha
    const artifactSource = join(root, 'fixture-artifact.bin')
    writeFileSync(artifactSource, artifact.bytes)
    screenState = makeScreenStateFixture()
    const config: BundleStoreConfig = {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey: 'Example Store / production',
    }
    const input: PublishBundleInput = {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [screenState],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'read-confirmed',
          curationJobId: 'read-job',
          buildOrdinal: 42,
          origin: 'agent-verified',
        }),
      ],
      relations: [
        {
          type: 'derived-from',
          targetId: 'fact-source-0123456789abcdef',
          addedAtOrdinal: 42,
          curationJobId: 'read-job',
        },
      ],
      provenance: {
        mode: 'run-linked',
        runId: 'read-run',
        testId: 'read-sign-in',
        stepIndex: 0,
      },
      artifacts: [
        {
          ref: artifact.ref,
          sourcePath: artifactSource,
          stepIndex: 0,
          role: 'decision-screenshot',
          originalName: 'sign-in.png',
        },
      ],
      evidenceMarkdown: 'Recorded from the sign-in decision.\n',
    }
    const published = publishBundle(config, input)
    if (published.kind !== 'published') throw new Error('expected fixture bundle publication')
    bundleDir = published.dir
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function manifest() {
    return guardBundleManifest(
      JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')),
    )
  }

  it('strictly loads every self-sufficient bundle part and derives trust from disk', () => {
    const loaded = expectLoaded(loadBundle(bundleDir))

    expect(loaded.frontmatter.id).toBe(loaded.manifest.id)
    expect(loaded.summary).toBe(makeBundleDraftFixture().summary)
    expect(loaded.body).toBe(makeBundleDraftFixture().body)
    expect(loaded.provenance).toMatchObject({ mode: 'run-linked', originClass: 'agent-verified' })
    expect(loaded.relations.relations).toHaveLength(1)
    expect(loaded.events).toHaveLength(1)
    expect(loaded.artifactsIndex.artifacts).toHaveLength(1)
    expect(loaded.screenStates).toEqual([screenState])
    expect(verifyBundleIntegrity(bundleDir)).toEqual({ ok: true, violations: [] })
    expect(deriveBundleTrust(loaded)).toEqual(
      foldBundleTrust(loaded.events, {
        originClass: loaded.provenance.originClass,
        evidenceIncomplete: loaded.manifest.evidenceIncomplete,
        createdAtOrdinal: loaded.manifest.createdAtOrdinal,
      }),
    )
  })

  it('names a byte-tampered committed file, including a ScreenState snapshot', () => {
    const relationsPath = join(bundleDir, 'relations.json')
    const relationsBefore = readFileSync(relationsPath)
    flipFirstByte(relationsPath)
    expect(verifyBundleIntegrity(bundleDir)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining('relations.json')]),
    })

    writeFileSync(relationsPath, relationsBefore)
    const snapshotRelPath = 'evidence/screenstates/step-0.json'
    flipFirstByte(join(bundleDir, snapshotRelPath))
    expect(verifyBundleIntegrity(bundleDir)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining(snapshotRelPath)]),
    })
  })

  it('rejects a schema-valid manifest identityHash swap', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({
        ...current,
        identityHash: differentHexDigest(current.identityHash),
      }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('identityHash')]),
    )
  })

  it('rejects a schema-valid manifest id suffix swap', () => {
    const current = manifest()
    const changedId = differentIdentitySuffix(current.id)
    expect(changedId).not.toBe(current.id)
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({ ...current, id: changedId }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(expect.arrayContaining([expect.stringContaining('id')]))
  })

  it('rejects a schema-valid evidenceIncomplete flip', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({
        ...current,
        evidenceIncomplete: !current.evidenceIncomplete,
      }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('evidenceIncomplete')]),
    )
  })

  it('rejects a schema-valid createdAtOrdinal edit', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({
        ...current,
        createdAtOrdinal: current.createdAtOrdinal + 1,
      }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('createdAtOrdinal')]),
    )
  })

  it('rejects a schema-valid originClass edit against record and provenance', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({ ...current, originClass: 'import' }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/record\.md:.*originClass/),
        expect.stringMatching(/provenance\.json:.*originClass/),
      ]),
    )
  })

  it('rejects a schema-valid identityCore scope edit', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({
        ...current,
        identityCore: {
          ...current.identityCore,
          scope: {
            ...current.identityCore.scope,
            key: `${current.identityCore.scope.key}-tampered`,
          },
        },
      }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('scope')]),
    )
  })

  it('rejects a schema-valid embeddingInput edit', () => {
    const current = manifest()
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({
        ...current,
        embeddingInput: `${current.embeddingInput}\nforged`,
      }),
    )

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('embeddingInput')]),
    )
  })

  it('reports a deleted copied artifact as a dangling reference', () => {
    const artifactRelPath = `artifacts/${artifactSha}`
    rmSync(join(bundleDir, artifactRelPath))

    const report = verifyBundleIntegrity(bundleDir)

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`${artifactRelPath}.*dangling|dangling.*${artifactRelPath}`),
        ),
      ]),
    )
  })

  it('refuses incomplete, missing, dot-prefixed, and invalid bundles with typed outcomes', () => {
    expect(loadBundle(join(root, 'missing-bundle'))).toEqual({ kind: 'not-found' })
    const hiddenCopy = join(root, '.staging-copy')
    cpSync(bundleDir, hiddenCopy, { recursive: true })
    expect(loadBundle(hiddenCopy)).toEqual({ kind: 'not-found' })

    const manifestPath = join(bundleDir, 'manifest.json')
    writeFileSync(manifestPath, committedFileText({ ...manifest(), complete: false }))
    expect(loadBundle(bundleDir)).toEqual({ kind: 'incomplete' })

    writeFileSync(manifestPath, committedFileText({ ...manifest(), complete: true }))
    writeFileSync(join(bundleDir, 'relations.json'), 'not json\n')
    const invalid = loadBundle(bundleDir)
    expect(invalid.kind).toBe('invalid')
    if (invalid.kind !== 'invalid') throw new Error('expected invalid bundle')
    expect(invalid.reason).toContain('relations.json')
  })

  it('returns a typed version error for a future manifest schema', () => {
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      committedFileText({ ...manifest(), schemaVersion: BUNDLE_SCHEMA_VERSION + 1 }),
    )

    const outcome = loadBundle(bundleDir)

    expect(outcome.kind).toBe('version-error')
    if (outcome.kind !== 'version-error') throw new Error('expected version error')
    expect(outcome.reason).toContain('manifest.json')
  })

  it('loads, verifies, and derives identically after recursive relocation', () => {
    const relocatedDir = join(root, 'relocated-bundle')
    cpSync(bundleDir, relocatedDir, { recursive: true })

    const original = expectLoaded(loadBundle(bundleDir))
    const relocated = expectLoaded(loadBundle(relocatedDir))

    expect(relocated).toEqual(original)
    expect(verifyBundleIntegrity(relocatedDir)).toEqual({ ok: true, violations: [] })
    expect(deriveBundleTrust(relocated)).toEqual(deriveBundleTrust(original))
  })
})
