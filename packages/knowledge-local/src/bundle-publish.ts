// Bundle publication is the D-11/D-12/D-15 store seam beneath KnowledgePort.
// It copies capped artifacts into an invisible sibling staging directory, writes every
// committed text part with manifest.json last (§7.8), then atomically renames.
// BNDL-02/D-05 only treats an occupied target as already-exists after full-identity equality.

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import {
  canonicalJson,
  guardBundleManifest,
  slugBranch,
  verifyManifestIdentity,
} from '@vostride/agent-qa-schema'
import type {
  BundleIdentityCore,
  BundleManifest,
  RecordId,
} from '@vostride/agent-qa-schema'

import { copyArtifacts } from './artifact-copy.js'
import type {
  ArtifactCopyInput,
  ArtifactCopyResult,
  ArtifactCopySkipReason,
  SkippedArtifact,
} from './artifact-copy.js'
import { renderBundleParts } from './bundle-parts.js'
import type { RenderBundlePartsInput } from './bundle-parts.js'
import { durableRename, fsyncDirectory, fsyncTree } from './durable-fs.js'
import { assertWithinKnowledgeRoot } from './knowledge-containment.js'

export interface BundleStoreConfig {
  /** Absolute committed-root path. Deliberately no working-directory default. */
  knowledgeRoot: string
  productKey: string
  /** Active writer identity used to attribute crash-left staging trees. */
  writerLeaseId?: string
  /** Fencing epoch embedded in reader-invisible staging names. */
  writerEpoch?: number
  hooks?: {
    /** Test/chaos seam after all staged bytes exist but before the visibility rename. */
    beforePublishRename?: () => void
    /** Test/chaos seam after each durable mutable-file replacement. */
    afterMutableReplacement?: (targetRelPath: string) => void
  }
}

export interface PublishBundleInput
  extends Omit<RenderBundlePartsInput, 'copiedArtifacts' | 'evidenceIncomplete'> {
  artifacts: readonly ArtifactCopyInput[]
  /** Refusals already decided by the Curator's pre-copy pass. */
  preSkippedArtifacts?: readonly SkippedArtifact<ArtifactCopySkipReason>[]
}

export type PublishBundleOutcome =
  | { kind: 'published'; id: RecordId; dir: string; evidenceIncomplete: boolean }
  | { kind: 'already-exists'; id: RecordId }
  | {
      kind: 'identity-collision'
      id: RecordId
      dir: string
      reason:
        | 'identity-hash-mismatch'
        | 'identity-core-mismatch'
        | 'existing-manifest-corrupt'
      expectedIdentityHash: string
      existingIdentityHash: string | null
    }

export interface StagedBundlePublication {
  kind: 'staged'
  id: RecordId
  finalDir: string
  stagingDir: string
  stagingRoot: string
  bundlesDir: string
  evidenceIncomplete: boolean
  expected: ExpectedBundleIdentity
  beforePublishRename?: () => void
}

export type StageBundleOutcome =
  | StagedBundlePublication
  | Exclude<PublishBundleOutcome, { kind: 'published' }>

const EMPTY_ARTIFACT_COPY: ArtifactCopyResult = {
  copied: [],
  skipped: [],
  evidenceIncomplete: false,
}

// Matches the path-safe token grammar enforced for claimed queue lease directories.
const SAFE_WRITER_LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ExistingBundleTargetClassification =
  | { kind: 'same-identity' }
  | {
      kind: 'collision'
      reason:
        | 'identity-hash-mismatch'
        | 'identity-core-mismatch'
        | 'existing-manifest-corrupt'
      existingIdentityHash: string | null
    }

interface ExpectedBundleIdentity {
  id: RecordId
  identityHash: string
  identityCore: BundleIdentityCore
}

function classifyExistingBundleTarget(
  finalDir: string,
  expected: ExpectedBundleIdentity,
): ExistingBundleTargetClassification {
  let manifest: BundleManifest
  try {
    manifest = guardBundleManifest(
      JSON.parse(readFileSync(join(finalDir, 'manifest.json'), 'utf8')),
    )
  } catch {
    return {
      kind: 'collision',
      reason: 'existing-manifest-corrupt',
      existingIdentityHash: null,
    }
  }

  if (manifest.complete !== true || verifyManifestIdentity(manifest).length > 0) {
    return {
      kind: 'collision',
      reason: 'existing-manifest-corrupt',
      existingIdentityHash: manifest.identityHash,
    }
  }
  if (manifest.identityHash !== expected.identityHash) {
    return {
      kind: 'collision',
      reason: 'identity-hash-mismatch',
      existingIdentityHash: manifest.identityHash,
    }
  }
  if (canonicalJson(manifest.identityCore) !== canonicalJson(expected.identityCore)) {
    return {
      kind: 'collision',
      reason: 'identity-core-mismatch',
      existingIdentityHash: manifest.identityHash,
    }
  }
  return { kind: 'same-identity' }
}

function identityCollisionOutcome(
  finalDir: string,
  expected: ExpectedBundleIdentity,
  collision: Extract<ExistingBundleTargetClassification, { kind: 'collision' }>,
): Extract<PublishBundleOutcome, { kind: 'identity-collision' }> {
  return {
    kind: 'identity-collision',
    id: expected.id,
    dir: finalDir,
    reason: collision.reason,
    expectedIdentityHash: expected.identityHash,
    existingIdentityHash: collision.existingIdentityHash,
  }
}

function removeEmptyStagingRoot(stagingRoot: string, bundlesDir: string): void {
  let removed = false
  try {
    rmdirSync(stagingRoot)
    removed = true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
  if (removed) fsyncDirectory(bundlesDir)
}

function removeStaging(
  stagingDir: string,
  stagingRoot: string,
  bundlesDir: string,
): void {
  rmSync(stagingDir, { recursive: true, force: true })
  if (existsSync(stagingRoot)) fsyncDirectory(stagingRoot)
  removeEmptyStagingRoot(stagingRoot, bundlesDir)
}

function writePart(stagingDir: string, part: { relPath: string; text: string }): void {
  const target = join(stagingDir, part.relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, part.text, 'utf8')
}

export function stageBundle(
  config: BundleStoreConfig,
  input: PublishBundleInput,
): StageBundleOutcome {
  if (!isAbsolute(config.knowledgeRoot)) {
    throw new TypeError('BundleStoreConfig.knowledgeRoot must be absolute')
  }
  if (
    config.writerLeaseId !== undefined
    && !SAFE_WRITER_LEASE_ID.test(config.writerLeaseId)
  ) {
    throw new TypeError('BundleStoreConfig.writerLeaseId must be a non-empty path-safe token')
  }
  if (
    config.writerEpoch !== undefined
    && (!Number.isSafeInteger(config.writerEpoch) || config.writerEpoch < 0)
  ) {
    throw new TypeError('BundleStoreConfig.writerEpoch must be a nonnegative safe integer')
  }

  const { artifacts, preSkippedArtifacts, ...renderInput } = input
  const identity = renderBundleParts({
    ...renderInput,
    copiedArtifacts: EMPTY_ARTIFACT_COPY,
    evidenceIncomplete: false,
  })
  const bundlesDir = join(
    config.knowledgeRoot,
    'memory',
    slugBranch(config.productKey),
    'bundles',
  )
  const finalDir = join(bundlesDir, identity.id)

  if (existsSync(finalDir)) {
    const existing = classifyExistingBundleTarget(finalDir, identity)
    return existing.kind === 'same-identity'
      ? { kind: 'already-exists', id: identity.id }
      : identityCollisionOutcome(finalDir, identity, existing)
  }

  const stagingRoot = join(bundlesDir, '.staging')
  // a `memory/`, product or `bundles/` linked out of the knowledge root is refused
  // before anything is staged; the rename into `bundlesDir` then stays inside it too.
  assertWithinKnowledgeRoot(config.knowledgeRoot, stagingRoot)
  const stagingBasename = `.staged-epoch-${config.writerEpoch ?? 0}-${randomUUID()}`
  const stagingDir = join(stagingRoot, stagingBasename)
  mkdirSync(stagingDir, { recursive: true })

  try {
    const copiedArtifacts = copyArtifacts(
      artifacts,
      join(stagingDir, 'artifacts'),
      { preSkipped: preSkippedArtifacts },
    )
    const rendered = renderBundleParts({
      ...renderInput,
      copiedArtifacts,
      evidenceIncomplete: copiedArtifacts.evidenceIncomplete,
    })
    const manifest = rendered.parts.at(-1)
    if (manifest?.relPath !== 'manifest.json') {
      throw new TypeError('renderBundleParts must return manifest.json last')
    }
    for (const renderedPart of rendered.parts.slice(0, -1)) {
      writePart(stagingDir, renderedPart)
    }
    writePart(stagingDir, manifest)
    fsyncTree(stagingDir)
    fsyncDirectory(stagingRoot)
    return {
      kind: 'staged',
      id: rendered.id,
      finalDir,
      stagingDir,
      stagingRoot,
      bundlesDir,
      evidenceIncomplete: copiedArtifacts.evidenceIncomplete,
      expected: rendered,
      ...(config.hooks?.beforePublishRename === undefined
        ? {}
        : { beforePublishRename: config.hooks.beforePublishRename }),
    }
  } catch (error) {
    removeStaging(stagingDir, stagingRoot, bundlesDir)
    throw error
  }
}

/** Remove one reader-invisible staged tree after a fenced refusal or failed finalize. */
export function discardStagedBundle(
  staged: StagedBundlePublication,
  removeEmptyBundlesDir = false,
): void {
  removeStaging(staged.stagingDir, staged.stagingRoot, staged.bundlesDir)
  if (!removeEmptyBundlesDir) return
  try {
    rmdirSync(staged.bundlesDir)
    fsyncDirectory(dirname(staged.bundlesDir))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
  }
}

/** Make a complete staged tree visible. Callers that hold writer authority own this boundary. */
export function finalizeStagedBundle(
  staged: StagedBundlePublication,
): PublishBundleOutcome {
  staged.beforePublishRename?.()
  try {
    durableRename(staged.stagingDir, staged.finalDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      (code === 'EEXIST' || code === 'ENOTEMPTY')
      && existsSync(staged.finalDir)
    ) {
      const existing = classifyExistingBundleTarget(staged.finalDir, staged.expected)
      discardStagedBundle(staged)
      return existing.kind === 'same-identity'
        ? { kind: 'already-exists', id: staged.id }
        : identityCollisionOutcome(staged.finalDir, staged.expected, existing)
    }
    throw error
  }
  removeEmptyStagingRoot(staged.stagingRoot, staged.bundlesDir)
  return {
    kind: 'published',
    id: staged.id,
    dir: staged.finalDir,
    evidenceIncomplete: staged.evidenceIncomplete,
  }
}
