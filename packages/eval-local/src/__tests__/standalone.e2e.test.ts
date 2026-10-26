import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractRunCassettes, guardCassette } from '@vostride/agent-qa-eval'
import {
  FsEvidenceArtifactStore,
  FsHandoffStore,
  HANDOFF_FILE,
  loadCompletedRunHandoff,
  RUNS_SUBDIR,
  RUN_EVIDENCE_BLOBS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import { HandoffVersionError } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { FsRunArtifactSource } from '../artifact-source.js'
import { BLOBS_SUBDIR, CASSETTE_FILE, FsCassetteStore } from '../cassette-store.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  LOCAL_FIXTURE_RUN_ID,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('standalone cassette pipeline (CASS-02)', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  function runDirPath(runRoot: string): string {
    return join(runRoot, RUNS_SUBDIR, slugBranch(LOCAL_FIXTURE_RUN_ID))
  }

  function runBlobPath(runRoot: string, sha: string): string {
    return join(runDirPath(runRoot), RUN_EVIDENCE_BLOBS_SUBDIR, sha)
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  function runPipeline(options: { runRoot: string; bundleRoot: string }) {
    const loaded = loadCompletedRunHandoff(
      join(options.runRoot, RUNS_SUBDIR, slugBranch(LOCAL_FIXTURE_RUN_ID), HANDOFF_FILE),
    )
    const extraction = extractRunCassettes({
      handoff: loaded,
      artifacts: new FsRunArtifactSource({ root: options.runRoot, runId: LOCAL_FIXTURE_RUN_ID }),
    })
    const store = new FsCassetteStore({ root: options.bundleRoot })
    return {
      extraction,
      written: extraction.cassettes.map(cassette => store.write(cassette)),
    }
  }

  it('resolves typed leaf and procedure screenshot refs after the source run is removed', async () => {
    const runRoot = await tempRoot('eval-local-run-')
    const bundleRoot = await tempRoot('eval-local-bundles-')
    const copiedRoot = await tempRoot('eval-local-copied-')

    const ref = new FsEvidenceArtifactStore({
      root: runRoot,
      runId: LOCAL_FIXTURE_RUN_ID,
    }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
    expect(ref.sha).toBe(LOCAL_FIXTURE_BLOB_SHA)
    new FsHandoffStore({ root: runRoot, runId: LOCAL_FIXTURE_RUN_ID }).save(
      makeLocalV2Handoff({}, ref),
    )

    const { extraction, written } = runPipeline({ runRoot, bundleRoot })
    const leafIndex = extraction.cassettes.findIndex(entry => entry.cassette.granularity === 'leaf')
    const procedureIndex = extraction.cassettes.findIndex(
      entry => entry.cassette.granularity === 'procedure',
    )
    expect(leafIndex).toBeGreaterThanOrEqual(0)
    expect(procedureIndex).toBeGreaterThanOrEqual(0)

    const leafBundle = join(copiedRoot, 'leaf')
    const procedureBundle = join(copiedRoot, 'procedure')
    await cp(written[leafIndex]!.dir, leafBundle, { recursive: true })
    await cp(written[procedureIndex]!.dir, procedureBundle, { recursive: true })

    // Everything the copied bundles could still borrow from is destroyed before verification.
    await rm(runDirPath(runRoot), { recursive: true, force: true })
    expect(await exists(runDirPath(runRoot))).toBe(false)

    for (const bundle of [leafBundle, procedureBundle]) {
      const raw = await readFile(join(bundle, CASSETTE_FILE), 'utf8')
      const cassette = guardCassette(JSON.parse(raw))

      const typedRef =
        cassette.granularity === 'leaf'
          ? cassette.input.decisionScreenshotRef
          : cassette.steps
              .flatMap(record => (record.kind === 'decision' ? [record.record.input] : []))[0]!
              .decisionScreenshotRef
      const auxiliary =
        cassette.granularity === 'leaf'
          ? cassette.input.auxiliaryArtifactRefs
          : cassette.steps
              .flatMap(record => (record.kind === 'decision' ? [record.record.input] : []))[0]!
              .auxiliaryArtifactRefs

      expect(typedRef).toEqual({ id: ref.id, sha: ref.sha })
      expect(cassette.blobs).toEqual([ref.sha])
      expect(cassette.blobs).toContain(typedRef!.sha)
      expect(auxiliary ?? []).not.toContainEqual(typedRef)
      expect(cassette.completeness.status).toBe('complete')

      const bytes = await readFile(join(bundle, BLOBS_SUBDIR, typedRef!.sha))
      expect(bytes).toEqual(Buffer.from(LOCAL_FIXTURE_BLOB_BYTES))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(typedRef!.sha)

      expect(raw).not.toContain(runRoot)
      expect(raw).not.toContain(bundleRoot)
      expect(raw).not.toContain(copiedRoot)
    }
  })

  it('writes every affected cassette as evidence-incomplete after source-blob GC', async () => {
    const runRoot = await tempRoot('eval-local-gc-run-')
    const bundleRoot = await tempRoot('eval-local-gc-bundles-')

    const ref = new FsEvidenceArtifactStore({
      root: runRoot,
      runId: LOCAL_FIXTURE_RUN_ID,
    }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
    new FsHandoffStore({ root: runRoot, runId: LOCAL_FIXTURE_RUN_ID }).save(
      makeLocalV2Handoff({}, ref),
    )
    await unlink(runBlobPath(runRoot, ref.sha))

    const { extraction, written } = runPipeline({ runRoot, bundleRoot })
    const affected = extraction.cassettes
      .map((entry, index) => ({ entry, written: written[index]! }))
      .filter(({ entry }) => entry.cassette.blobs.includes(ref.sha))

    expect(affected).toHaveLength(2)
    for (const item of affected) {
      expect(item.entry.cassette.completeness).toEqual({
        status: 'evidence-incomplete',
        missingBlobShas: [ref.sha],
      })
      const persisted = guardCassette(
        JSON.parse(await readFile(join(item.written.dir, CASSETTE_FILE), 'utf8')),
      )
      expect(persisted.completeness).toEqual({
        status: 'evidence-incomplete',
        missingBlobShas: [ref.sha],
      })
      expect(item.written.writtenBlobShas).toEqual([])
      expect(await exists(join(item.written.dir, BLOBS_SUBDIR))).toBe(false)
    }
  })

  it('marks leaf and procedure evidence-incomplete when a full capture omits its ref', async () => {
    const runRoot = await tempRoot('eval-local-noref-run-')
    const bundleRoot = await tempRoot('eval-local-noref-bundles-')

    // Full-capture screenshot bytes exist, but the decision omits its required identity.
    new FsEvidenceArtifactStore({
      root: runRoot,
      runId: LOCAL_FIXTURE_RUN_ID,
    }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
    new FsHandoffStore({ root: runRoot, runId: LOCAL_FIXTURE_RUN_ID }).save(
      makeLocalV2Handoff({}, null),
    )

    const { extraction, written } = runPipeline({ runRoot, bundleRoot })
    const missingIdentity = [{ kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 }]
    const byGranularity = new Map(
      extraction.cassettes.map((entry, index) => [
        entry.cassette.granularity,
        { entry, written: written[index]! },
      ]),
    )

    for (const granularity of ['leaf', 'procedure'] as const) {
      const item = byGranularity.get(granularity)!
      expect(item.entry.cassette.completeness.status).toBe('evidence-incomplete')
      expect(item.entry.cassette.completeness.missingEvidence).toEqual(missingIdentity)

      const persisted = guardCassette(
        JSON.parse(await readFile(join(item.written.dir, CASSETTE_FILE), 'utf8')),
      )
      expect(persisted.completeness.status).toBe('evidence-incomplete')
      expect(persisted.completeness.missingEvidence).toEqual(missingIdentity)
    }
  })

  it('rejects a pre-instrumentation handoff through the typed runner-local guard', async () => {
    const runRoot = await tempRoot('eval-local-v1-run-')
    new FsHandoffStore({ root: runRoot, runId: LOCAL_FIXTURE_RUN_ID }).save(
      makeLocalV2Handoff({ schemaVersion: 1 }),
    )
    const file = join(runRoot, RUNS_SUBDIR, slugBranch(LOCAL_FIXTURE_RUN_ID), HANDOFF_FILE)

    expect(() => loadCompletedRunHandoff(file)).toThrowError(HandoffVersionError)
  })
})
