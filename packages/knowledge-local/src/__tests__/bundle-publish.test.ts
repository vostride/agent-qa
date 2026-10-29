import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  committedFileText,
  guardArtifactsIndex,
  guardBundleManifest,
  parseRecordMarkdown,
  slugBranch,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_STEP_CAP_BYTES } from '../artifact-copy.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../bundle-publish.test-helper.js'
import { renderBundleParts } from '../bundle-parts.js'
import { fsyncDirectory } from '../durable-fs.js'
import {
  makeArtifactFixture,
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const paths: string[] = []
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) visit(absolute, relPath)
      else paths.push(relPath)
    }
  }
  visit(root, '')
  return paths.sort()
}

describe('publishBundle staged committed publish', () => {
  let root: string
  let knowledgeRoot: string
  let artifactSource: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-publish-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    artifactSource = join(root, 'fixture-artifact.bin')
    writeFileSync(artifactSource, makeArtifactFixture().bytes)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(overrides: Partial<BundleStoreConfig> = {}): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Example Store / production',
      ...overrides,
    }
  }

  function input(overrides: Partial<PublishBundleInput> = {}): PublishBundleInput {
    const artifact = makeArtifactFixture()
    return {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'publish-confirmed',
          curationJobId: 'publish-job',
          buildOrdinal: 42,
          origin: 'agent-verified',
        }),
      ],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'publish-run',
        testId: 'publish-sign-in',
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
      ...overrides,
    }
  }

  function bundlesDir(): string {
    return join(knowledgeRoot, 'memory', slugBranch(config().productKey), 'bundles')
  }

  it('lazily creates and atomically publishes the complete bundle tree', () => {
    expect(existsSync(join(knowledgeRoot, 'memory'))).toBe(false)

    const outcome = publishBundle(config(), input())

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('expected published outcome')
    expect(outcome.evidenceIncomplete).toBe(false)
    expect(walkFiles(outcome.dir)).toEqual([
      'artifacts.index.json',
      `artifacts/${makeArtifactFixture().sha}`,
      'evidence/evidence.md',
      'evidence/outcomes.jsonl',
      'evidence/screenstates/step-0.json',
      'manifest.json',
      'provenance.json',
      'record.md',
      'relations.json',
    ])

    const manifest = guardBundleManifest(
      JSON.parse(readFileSync(join(outcome.dir, 'manifest.json'), 'utf8')),
    )
    expect(manifest.complete).toBe(true)
    expect(existsSync(join(outcome.dir, 'artifacts.index.json'))).toBe(true)
    expect(existsSync(join(outcome.dir, 'artifacts', 'artifacts.index.json'))).toBe(false)
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('stages a complete reader-invisible tree under the active writer lease', () => {
    let stagedBasename = ''
    const outcome = publishBundle(
      config({
        writerLeaseId: 'lease-alpha',
        writerEpoch: 7,
        hooks: {
          beforePublishRename: () => {
            const stagingRoot = join(bundlesDir(), '.staging')
            const entries = readdirSync(stagingRoot)
            expect(entries).toHaveLength(1)
            stagedBasename = entries[0]!
            expect(stagedBasename).toMatch(/^\.staged-epoch-7-[0-9a-f-]+$/)
            expect(readdirSync(bundlesDir())).toEqual(['.staging'])

            const stagedDir = join(stagingRoot, stagedBasename)
            expect(walkFiles(stagedDir)).toEqual([
              'artifacts.index.json',
              `artifacts/${makeArtifactFixture().sha}`,
              'evidence/evidence.md',
              'evidence/outcomes.jsonl',
              'evidence/screenstates/step-0.json',
              'manifest.json',
              'provenance.json',
              'record.md',
              'relations.json',
            ])
            expect(
              guardBundleManifest(
                JSON.parse(readFileSync(join(stagedDir, 'manifest.json'), 'utf8')),
              ).complete,
            ).toBe(true)
          },
        },
      }),
      input(),
    )

    expect(outcome.kind).toBe('published')
    expect(stagedBasename).not.toBe('')
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it.each(['', '.', '..', '../escape', 'lease/escape', 'lease\\escape'])(
    'rejects unsafe writer lease token %j before staging exists',
    (writerLeaseId) => {
      expect(() => publishBundle(config({ writerLeaseId }), input())).toThrow(
        /writerLeaseId.*path-safe token/i,
      )
      expect(existsSync(join(bundlesDir(), '.staging'))).toBe(false)
    },
  )

  it('classifies an already-exists rename race and durably removes empty staging', () => {
    const outcome = publishBundle(
      config({
        writerLeaseId: 'lease-race',
        hooks: {
          beforePublishRename: () => {
            const stagingRoot = join(bundlesDir(), '.staging')
            const stagedDir = join(stagingRoot, readdirSync(stagingRoot)[0]!)
            const manifest = guardBundleManifest(
              JSON.parse(readFileSync(join(stagedDir, 'manifest.json'), 'utf8')),
            )
            cpSync(stagedDir, join(bundlesDir(), manifest.id), { recursive: true })
          },
        },
      }),
      input(),
    )

    expect(outcome.kind).toBe('already-exists')
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('uses a closed directory-fsync portability allowlist and surfaces every other error', () => {
    for (const code of ['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP']) {
      const error = Object.assign(new Error(code), { code })
      expect(() =>
        fsyncDirectory(root, {
          openSync: () => {
            throw error
          },
          fsyncSync: vi.fn(),
          closeSync: vi.fn(),
        }),
      ).not.toThrow()
    }

    const error = Object.assign(new Error('disk I/O failure'), { code: 'EIO' })
    expect(() =>
      fsyncDirectory(root, {
        openSync: () => {
          throw error
        },
        fsyncSync: vi.fn(),
        closeSync: vi.fn(),
      }),
    ).toThrow(error)
  })

  it('returns already-exists for the same complete content address', () => {
    const first = publishBundle(config(), input())
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')

    expect(publishBundle(config(), input())).toEqual({ kind: 'already-exists', id: first.id })
    expect(readdirSync(bundlesDir())).toEqual([first.id])
  })

  it('refuses a schema-valid but self-inconsistent existing identity hash', () => {
    const first = publishBundle(config(), input())
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')
    const manifestPath = join(first.dir, 'manifest.json')
    const manifest = guardBundleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const replacementFirstHex = manifest.identityHash.startsWith('0') ? '1' : '0'
    const tamperedText = committedFileText({
      ...manifest,
      identityHash: `${replacementFirstHex}${manifest.identityHash.slice(1)}`,
    })
    writeFileSync(manifestPath, tamperedText, 'utf8')

    const outcome = publishBundle(config(), input())

    expect(outcome.kind).toBe('identity-collision')
    if (outcome.kind !== 'identity-collision') throw new Error('expected identity collision')
    expect(outcome.reason).toBe('existing-manifest-corrupt')
    expect(readFileSync(manifestPath, 'utf8')).toBe(tamperedText)
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('refuses a self-consistent foreign bundle at the truncated target id', () => {
    const first = publishBundle(config(), input())
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')
    const foreignInput = input({
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Check out' },
          { t: 'page', route: '/checkout' },
        ],
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: 'Check out' },
      },
    })
    const foreign = publishBundle(config(), foreignInput)
    expect(foreign.kind).toBe('published')
    if (foreign.kind !== 'published') throw new Error('expected foreign publish')
    const foreignManifest = guardBundleManifest(
      JSON.parse(readFileSync(join(foreign.dir, 'manifest.json'), 'utf8')),
    )
    rmSync(first.dir, { recursive: true, force: true })
    cpSync(foreign.dir, first.dir, { recursive: true })
    const occupiedManifestPath = join(first.dir, 'manifest.json')
    const occupiedManifestText = readFileSync(occupiedManifestPath, 'utf8')

    const outcome = publishBundle(config(), input())

    expect(outcome.kind).toBe('identity-collision')
    if (outcome.kind !== 'identity-collision') throw new Error('expected identity collision')
    expect(outcome.reason).toBe('identity-hash-mismatch')
    expect(outcome.existingIdentityHash).toBe(foreignManifest.identityHash)
    expect(readFileSync(occupiedManifestPath, 'utf8')).toBe(occupiedManifestText)
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('returns the canonical identityCore rendered into the manifest', () => {
    const { artifacts: _artifacts, ...renderInput } = input()
    const rendered = renderBundleParts({
      ...renderInput,
      copiedArtifacts: { copied: [], skipped: [], evidenceIncomplete: false },
      evidenceIncomplete: false,
    })
    const manifest = guardBundleManifest(JSON.parse(rendered.parts.at(-1)!.text))

    expect(rendered.identityCore).toEqual(manifest.identityCore)
  })

  it('returns a typed collision for a non-JSON existing manifest', () => {
    const first = publishBundle(config(), input())
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')
    const manifestPath = join(first.dir, 'manifest.json')
    const corruptText = 'not json'
    writeFileSync(manifestPath, corruptText, 'utf8')

    const outcome = publishBundle(config(), input())

    expect(outcome.kind).toBe('identity-collision')
    if (outcome.kind !== 'identity-collision') throw new Error('expected identity collision')
    expect(outcome.reason).toBe('existing-manifest-corrupt')
    expect(outcome.existingIdentityHash).toBeNull()
    expect(readFileSync(manifestPath, 'utf8')).toBe(corruptText)
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('returns a typed collision for an incomplete existing manifest', () => {
    const first = publishBundle(config(), input())
    expect(first.kind).toBe('published')
    if (first.kind !== 'published') throw new Error('expected first publish')
    const manifestPath = join(first.dir, 'manifest.json')
    const manifest = guardBundleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const incompleteText = committedFileText({ ...manifest, complete: false })
    writeFileSync(manifestPath, incompleteText, 'utf8')

    const outcome = publishBundle(config(), input())

    expect(outcome.kind).toBe('identity-collision')
    if (outcome.kind !== 'identity-collision') throw new Error('expected identity collision')
    expect(outcome.reason).toBe('existing-manifest-corrupt')
    expect(readFileSync(manifestPath, 'utf8')).toBe(incompleteText)
    expect(readdirSync(bundlesDir())).not.toContain('.staging')
  })

  it('mints artifact overflow into both immutable markers with no dangling row', () => {
    const bytes = new Uint8Array(ARTIFACT_STEP_CAP_BYTES + 1).fill(97)
    const sourcePath = join(root, 'oversized.bin')
    writeFileSync(sourcePath, bytes)
    const artifactSha = sha(bytes)

    const outcome = publishBundle(
      config(),
      input({
        artifacts: [
          {
            ref: { id: 'oversized-screenshot', sha: artifactSha },
            sourcePath,
            stepIndex: 0,
          },
        ],
      }),
    )

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('expected overflow-marked publish')
    expect(outcome.evidenceIncomplete).toBe(true)
    const manifest = guardBundleManifest(
      JSON.parse(readFileSync(join(outcome.dir, 'manifest.json'), 'utf8')),
    )
    const record = parseRecordMarkdown(readFileSync(join(outcome.dir, 'record.md'), 'utf8'))
    const artifactIndex = guardArtifactsIndex(
      JSON.parse(readFileSync(join(outcome.dir, 'artifacts.index.json'), 'utf8')),
    )

    expect(manifest.evidenceIncomplete).toBe(true)
    expect(record.frontmatter.evidenceIncomplete).toBe(true)
    expect(artifactIndex.artifacts).toEqual([])
    expect(existsSync(join(outcome.dir, 'artifacts', artifactSha))).toBe(false)
  })
})
