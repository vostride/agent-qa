import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CurationAuthorship, Delta } from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'

import {
  commitCurationDelta,
  drainQueue,
  enumerateBundleDirs,
  listClaimedLeases,
  listQueuedCandidates,
  loadBundle,
  openIndexReaderConnection,
  readJobState,
  verifyBundleIntegrity,
  type CuratorAuthor,
  type DrainOptions,
} from '../../index.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'

// 2026-10-02 (quick 261002-tmo): the SIGKILL cells' 30 s bound is measured from the kill to the
// recovered, consistent store, which is the recovery it states. It used to start before the child
// was spawned, so it also timed a whole child vitest process booting to the boundary, and the
// marker wait gave that boot 10 s: at load 120-180 the child was still printing vitest's banner
// at 10 s ('timed out waiting for authored-intent marker', quick 261002-tmo forced gate 1). The
// boot now has its own ceiling, and the cell budget covers both.
const RECOVERY_BOUND_MS = 30_000
const CHILD_BOOT_CEILING_MS = 60_000
const SIGKILL_CELL_TIMEOUT_MS = CHILD_BOOT_CEILING_MS + RECOVERY_BOUND_MS + 30_000

type FaultPoint =
  | 'after-emit-before-claim'
  | 'after-claim-before-author'
  | 'after-authored-before-bundling'
  | 'mid-bundling-staged-unpublished'
  | 'after-publish-before-index'
  | 'after-index-before-intent-clear'

type RealSigkillPoint = 'publish-staged' | 'mutable-enrichment'
type SigkillPoint = 'authored-intent' | RealSigkillPoint

interface SigkillBoundaryMarker {
  point: SigkillPoint
  candidateId: string
  leaseId: string
  bundleId?: string
  stagingBasename?: string
  transactionBasename?: string
  replacedRelPath?: string
  enrichedSummary?: string
  enrichedBody?: string
}

type DrainOperations = NonNullable<DrainOptions['operations']>

function projectionInput(seed: string): ArtifactFreeCandidateProjectionInput {
  return {
    sourceRunId: `run-${seed}`,
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name: `Checkout ${seed}` }],
    summarySeed: `Checkout ${seed} selector`,
    bodySeed: `The Checkout ${seed} button was resolved and verified.`,
    distilledObservations: [
      {
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: `checkout-${seed}`, ordinal: 0 },
        platform: 'web',
        element: { naturalKey: `button:checkout-${seed}` },
        observedAtOrdinal: 42,
      },
    ],
    evidenceToken: `evidence-${seed}`,
    attributingObservationId: `run-${seed}:test-0:step-0`,
    emittedAt: '2026-07-15T10:00:00.000Z',
  }
}

function mutableProjectionInput(
  seed: string,
  buildOrdinal: number,
): ArtifactFreeCandidateProjectionInput {
  return {
    sourceRunId: `run-mutable-${seed}`,
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'behavioral',
    anchors: [{ t: 'flow', name: 'Checkout flow' }],
    summarySeed: 'Checkout flow needs richer authoring',
    bodySeed: 'Complete checkout using the observed sequence.',
    distilledObservations: [
      {
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'checkout-submit', ordinal: 0 },
        flow: { name: 'Checkout flow' },
        observedAtOrdinal: buildOrdinal,
      },
    ],
    evidenceToken: `evidence-mutable-${seed}`,
    attributingObservationId: `run-mutable-${seed}:test-0:step-0`,
    emittedAt: `2026-07-15T10:${String(buildOrdinal).padStart(2, '0')}:00.000Z`,
  }
}

function authoredAdd(job: Parameters<CuratorAuthor>[0]): {
  delta: Delta
  authorship: CurationAuthorship
} {
  const authorship: CurationAuthorship = {
    path: 'llm',
    model: { id: 'kill-anywhere-scripted-author' },
    executionContext: job.executionContext,
  }
  return {
    authorship,
    delta: {
      kind: 'Add',
      origin: 'agent',
      scope: job.scope,
      citedIds: [],
      authorship,
      bundle: {
        kind: job.kind,
        ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
        anchors: job.anchors,
        scope: job.scope,
        summary: job.summarySeed,
        body: job.bodySeed,
        distilledEvidenceRef: {
          id: `curation-candidate-${job.candidateId}`,
          sha: job.candidateId,
        },
        originStage: 'run-curation',
      },
    },
  }
}

function scriptedAuthor() {
  return vi.fn<CuratorAuthor>(async (job) => {
    const { delta, authorship } = authoredAdd(job)
    return { kind: 'authored', deltas: [delta], authorship }
  })
}

function enqueue(
  knowledgeRoot: string,
  candidateProjection: ArtifactFreeCandidateProjectionInput,
): { candidateId: string } {
  const outcome = enqueueArtifactFreeCandidateProjection({
    knowledgeRoot,
    projectionInput: candidateProjection,
  })
  expect(outcome.kind).toBe('enqueued')
  if (outcome.kind !== 'enqueued') {
    throw new Error(`expected enqueued projection, received ${outcome.kind}`)
  }
  return { candidateId: outcome.candidateId }
}

function walk(root: string): string[] {
  if (!existsSync(root)) return []
  const entries: string[] = []
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name)
      entries.push(relative(root, absolute))
      if (statSync(absolute).isDirectory()) visit(absolute)
    }
  }
  visit(root)
  return entries
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  if (!existsSync(root)) return snapshot
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name)
      if (statSync(absolute).isDirectory()) {
        visit(absolute)
      } else {
        snapshot[relative(root, absolute)] = readFileSync(absolute).toString('base64')
      }
    }
  }
  visit(root)
  return snapshot
}

function canonicalStoreSnapshot(knowledgeRoot: string): {
  bundles: Record<string, string>
  index: string
} {
  const reader = openIndexReaderConnection(knowledgeRoot)
  try {
    const index = {
      records: reader.db.prepare(`
        SELECT bundle_id, product, mutable_state_hash, kind, subtype, scope_tier,
          scope_key, status, trust, confirmed, contradicted, helpful, harmful,
          opened_at_ordinal, closed_at_ordinal, created_at_ordinal, origin_class,
          summary, embedding_input, situating_line, contextual_rendering,
          embed_status, hex(embedding) AS embedding_hex
        FROM records
        ORDER BY bundle_id
      `).all(),
      fts: reader.db.prepare(`
        SELECT rowid, identity, content, context
        FROM fts_records
        ORDER BY rowid
      `).all(),
      anchors: reader.db.prepare(`
        SELECT record_rowid, product, t, raw_json, normalized_json
        FROM anchors
        ORDER BY record_rowid, t, raw_json
      `).all(),
      graphNodes: reader.db.prepare(`
        SELECT node_id, node_type, natural_key_json, product
        FROM graph_nodes
        ORDER BY node_id
      `).all(),
      graphEdges: reader.db.prepare(`
        SELECT src_node_id, edge_type, dst_node_id, record_rowid, product,
          recency_ordinal
        FROM graph_edges
        ORDER BY src_node_id, edge_type, dst_node_id, record_rowid
      `).all(),
    }
    return {
      bundles: treeSnapshot(join(knowledgeRoot, 'memory', 'storefront', 'bundles')),
      index: JSON.stringify(index),
    }
  } finally {
    reader.db.close()
  }
}

function assertIndexMatchesBundle(
  knowledgeRoot: string,
  bundle: Extract<ReturnType<typeof loadBundle>, { kind: 'loaded' }>['bundle'],
): void {
  const reader = openIndexReaderConnection(knowledgeRoot)
  try {
    expect(
      reader.db.prepare(`
        SELECT bundle_id, mutable_state_hash, summary, embedding_input, confirmed
        FROM records
        WHERE bundle_id = ?
      `).get(bundle.manifest.id),
    ).toMatchObject({
      bundle_id: bundle.manifest.id,
      mutable_state_hash: bundle.manifest.mutableStateHash,
      summary: bundle.summary,
      embedding_input: bundle.manifest.embeddingInput,
      confirmed: bundle.events.filter(({ type }) => type === 'confirmed').length,
    })
  } finally {
    reader.db.close()
  }
}

const sigkillFixturePath = fileURLToPath(
  new URL('./fixtures/sigkill-drain-child.test.ts', import.meta.url),
)
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const vitestPath = join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')

function startSigkillChild(input: {
  point: SigkillPoint
  knowledgeRoot: string
  markerPath: string
}): { child: ChildProcess; output: () => string } {
  const child = spawn(
    process.execPath,
    [
      vitestPath,
      'run',
      sigkillFixturePath,
      '--pool=threads',
      '--maxWorkers=1',
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        AGENT_QA_SIGKILL_CHILD: '1',
        AGENT_QA_SIGKILL_POINT: input.point,
        AGENT_QA_SIGKILL_KNOWLEDGE_ROOT: input.knowledgeRoot,
        AGENT_QA_SIGKILL_MARKER: input.markerPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.stdout === null || child.stderr === null) {
    throw new Error('SIGKILL fixture pipes were not created')
  }
  let childOutput = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    childOutput += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    childOutput += chunk
  })
  return { child, output: () => childOutput }
}

function requiredMarkerString(
  marker: Record<string, unknown>,
  key: string,
): string {
  const value = marker[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`SIGKILL marker omitted ${key}`)
  }
  return value
}

async function waitForBoundaryMarker(
  markerPath: string,
  expectedPoint: SigkillPoint,
  child: ChildProcess,
  output: () => string,
): Promise<SigkillBoundaryMarker> {
  const markerDeadline = Date.now() + CHILD_BOOT_CEILING_MS
  while (!existsSync(markerPath) && Date.now() < markerDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`SIGKILL fixture exited before ${expectedPoint} marker:\n${output()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!existsSync(markerPath)) {
    throw new Error(`timed out waiting for ${expectedPoint} marker:\n${output()}`)
  }

  const raw = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>
  const point = requiredMarkerString(raw, 'point')
  if (point !== expectedPoint) {
    throw new Error(`SIGKILL marker reached ${point}, expected ${expectedPoint}`)
  }
  return {
    point: expectedPoint,
    candidateId: requiredMarkerString(raw, 'candidateId'),
    leaseId: requiredMarkerString(raw, 'leaseId'),
    ...(typeof raw.bundleId === 'string' ? { bundleId: raw.bundleId } : {}),
    ...(typeof raw.stagingBasename === 'string'
      ? { stagingBasename: raw.stagingBasename }
      : {}),
    ...(typeof raw.transactionBasename === 'string'
      ? { transactionBasename: raw.transactionBasename }
      : {}),
    ...(typeof raw.replacedRelPath === 'string'
      ? { replacedRelPath: raw.replacedRelPath }
      : {}),
    ...(typeof raw.enrichedSummary === 'string'
      ? { enrichedSummary: raw.enrichedSummary }
      : {}),
    ...(typeof raw.enrichedBody === 'string'
      ? { enrichedBody: raw.enrichedBody }
      : {}),
  }
}

async function sendRealSigkill(child: ChildProcess): Promise<void> {
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
  const exited = once(child, 'exit')
  expect(child.kill('SIGKILL')).toBe(true)
  const [code, signal] = await exited
  expect(code).toBeNull()
  expect(signal).toBe('SIGKILL')
}

async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

function expireKilledLease(knowledgeRoot: string, expectedLeaseId: string): void {
  const leasePath = join(knowledgeRoot, '.lease')
  const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>
  expect(lease.leaseId).toBe(expectedLeaseId)
  writeFileSync(leasePath, `${JSON.stringify({ ...lease, heartbeatAtMs: 0 })}\n`, 'utf8')
}

function hasIndexRow(knowledgeRoot: string, bundleId: string): boolean {
  const reader = openIndexReaderConnection(knowledgeRoot)
  try {
    return reader.db
      .prepare('SELECT 1 FROM records WHERE bundle_id = ?')
      .get(bundleId) !== undefined
  } finally {
    reader.db.close()
  }
}

function assertConsistent(
  knowledgeRoot: string,
  candidateId: string,
): { bundleId: string; bundleTree: string } {
  const bundles = enumerateBundleDirs(knowledgeRoot)
  expect(bundles).toHaveLength(1)
  const bundle = bundles[0]!
  const loaded = loadBundle(bundle.dir)
  expect(loaded.kind).toBe('loaded')
  if (loaded.kind !== 'loaded') throw new Error('expected one readable committed bundle')
  expect(verifyBundleIntegrity(bundle.dir)).toEqual({ ok: true, violations: [] })
  expect(hasIndexRow(knowledgeRoot, loaded.bundle.manifest.id)).toBe(true)
  expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
  expect(listClaimedLeases(knowledgeRoot)).toEqual([])
  expect(readJobState(knowledgeRoot, candidateId).kind).toBe('absent')

  const residualPaths = walk(knowledgeRoot)
  expect(residualPaths.filter((entry) => entry.split('/').includes('.staging'))).toEqual([])
  expect(residualPaths.filter((entry) => entry.endsWith('.intent.json'))).toEqual([])
  return { bundleId: loaded.bundle.manifest.id, bundleTree: dirname(bundle.dir) }
}

function options(
  knowledgeRoot: string,
  author: CuratorAuthor,
  operations?: DrainOperations,
): DrainOptions {
  return {
    knowledgeRoot,
    author,
    executionContext: 'local-interactive',
    ...(operations === undefined ? {} : { operations }),
  }
}

function operationsForFault(
  point: FaultPoint,
  knowledgeRoot: string,
  observed: { value: boolean },
): DrainOperations {
  if (point === 'after-claim-before-author') {
    return {
      readJobState: () => {
        observed.value = listClaimedLeases(knowledgeRoot).length === 1
        throw new Error('injected crash after claim before author')
      },
    }
  }
  if (point === 'after-authored-before-bundling') {
    return {
      commitCurationDelta: () => {
        observed.value = true
        throw new Error('injected crash after authored checkpoint')
      },
    }
  }
  if (point === 'mid-bundling-staged-unpublished') {
    return {
      commitCurationDelta: (deps, job, checkpoint) =>
        commitCurationDelta(
          {
            ...deps,
            hooks: {
              beforePublishRename: () => {
                observed.value = walk(knowledgeRoot).some((entry) =>
                  entry.split('/').includes('.staging'),
                )
                throw new Error('injected crash with staged unpublished bundle')
              },
            },
          },
          job,
          checkpoint,
        ),
    }
  }
  if (point === 'after-publish-before-index') {
    return {
      commitCurationDelta: (deps, job, checkpoint) =>
        commitCurationDelta(
          {
            ...deps,
            hooks: {
              afterBundlePublished: () => {
                observed.value = enumerateBundleDirs(knowledgeRoot).length === 1
                throw new Error('injected crash after publish before index')
              },
            },
          },
          job,
          checkpoint,
        ),
    }
  }
  if (point === 'after-index-before-intent-clear') {
    return {
      commitCurationDelta: (deps, job, checkpoint) =>
        commitCurationDelta(
          {
            ...deps,
            hooks: {
              afterIndexApplied: (bundleId) => {
                observed.value = hasIndexRow(knowledgeRoot, bundleId)
                throw new Error('injected crash after index before intent clear')
              },
            },
          },
          job,
          checkpoint,
        ),
    }
  }
  return {}
}

async function proveRealSigkillBoundary(point: RealSigkillPoint): Promise<void> {
  if (point === 'publish-staged') {
    await provePublishStagingSigkill()
    return
  }
  await proveMutableEnrichmentSigkill()
}

async function provePublishStagingSigkill(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-sigkill-publish-'))
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const markerPath = join(root, 'child-publish-staged.marker')
  const candidate = enqueue(
    knowledgeRoot,
    projectionInput('sigkill-publish-staged'),
  )
  let running: ReturnType<typeof startSigkillChild> | undefined

  try {
    running = startSigkillChild({
      point: 'publish-staged',
      knowledgeRoot,
      markerPath,
    })
    const marker = await waitForBoundaryMarker(
      markerPath,
      'publish-staged',
      running.child,
      running.output,
    )
    expect(marker.candidateId).toBe(candidate.candidateId)
    expect(marker.bundleId).toBeDefined()
    expect(marker.stagingBasename).toBeDefined()
    const stagingDir = join(
      knowledgeRoot,
      'memory',
      'storefront',
      'bundles',
      '.staging',
      marker.stagingBasename!,
    )
    expect(marker.stagingBasename).toMatch(/^\.staged-epoch-\d+-[0-9a-f-]+$/)
    expect(existsSync(stagingDir)).toBe(true)
    expect(enumerateBundleDirs(knowledgeRoot)).toEqual([])
    expect(verifyBundleIntegrity(stagingDir)).toEqual({ ok: true, violations: [] })
    expect(readJobState(knowledgeRoot, candidate.candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'committing' },
    })

    const killedAt = Date.now()
    await sendRealSigkill(running.child)
    expireKilledLease(knowledgeRoot, marker.leaseId)
    expect(listClaimedLeases(knowledgeRoot)).toContain(marker.leaseId)
    expect(existsSync(stagingDir)).toBe(true)
    expect(marker.stagingBasename).toContain('.staged-epoch-')

    const recoveryAuthor = scriptedAuthor()
    const recovery = await drainQueue(options(knowledgeRoot, recoveryAuthor))
    expect(recovery).toMatchObject({
      kind: 'drained',
      failures: 0,
      // Epoch acquisition now revokes the stale publication stage before reconciliation.
      reconcile: { orphansRemoved: 0, mutationsRecovered: 0 },
    })
    const consistent = assertConsistent(knowledgeRoot, candidate.candidateId)
    expect(consistent.bundleId).toBe(marker.bundleId)
    expect(recoveryAuthor).not.toHaveBeenCalled()
    const bundleDir = enumerateBundleDirs(knowledgeRoot)[0]!.dir
    const loaded = loadBundle(bundleDir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected recovered publish bundle')
    assertIndexMatchesBundle(knowledgeRoot, loaded.bundle)

    const beforeSecondRecovery = canonicalStoreSnapshot(knowledgeRoot)
    await drainQueue(options(knowledgeRoot, recoveryAuthor))
    expect(canonicalStoreSnapshot(knowledgeRoot)).toEqual(beforeSecondRecovery)
    expect(recoveryAuthor).not.toHaveBeenCalled()
    expect(Date.now() - killedAt).toBeLessThan(RECOVERY_BOUND_MS)
  } finally {
    if (running !== undefined) await killIfRunning(running.child)
    rmSync(root, { recursive: true, force: true })
  }
}

async function proveMutableEnrichmentSigkill(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-sigkill-mutable-'))
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const markerPath = join(root, 'child-mutable-enrichment.marker')
  let running: ReturnType<typeof startSigkillChild> | undefined

  try {
    const fallbackCandidate = enqueue(
      knowledgeRoot,
      mutableProjectionInput('fallback', 42),
    )
    const fallbackAuthor = vi.fn<CuratorAuthor>(async () => ({
      kind: 'fallback-required',
      reason: 'no-model',
    }))
    const fallbackReport = await drainQueue(
      options(knowledgeRoot, fallbackAuthor),
    )
    expect(fallbackReport).toMatchObject({ committed: 1, failures: 0 })
    expect(fallbackAuthor).toHaveBeenCalledOnce()
    const fallbackDirs = enumerateBundleDirs(knowledgeRoot)
    expect(fallbackDirs).toHaveLength(1)
    const fallbackLoaded = loadBundle(fallbackDirs[0]!.dir)
    expect(fallbackLoaded.kind).toBe('loaded')
    if (fallbackLoaded.kind !== 'loaded') throw new Error('expected fallback seed bundle')
    expect(fallbackLoaded.bundle.provenance).toMatchObject({
      needsEnrichment: true,
      authorship: { path: 'deterministic-fallback' },
    })
    const originalBundleId = fallbackLoaded.bundle.manifest.id

    const capableCandidate = enqueue(
      knowledgeRoot,
      mutableProjectionInput('capable', 43),
    )
    running = startSigkillChild({
      point: 'mutable-enrichment',
      knowledgeRoot,
      markerPath,
    })
    const marker = await waitForBoundaryMarker(
      markerPath,
      'mutable-enrichment',
      running.child,
      running.output,
    )
    expect(marker.candidateId).toBe(capableCandidate.candidateId)
    expect(marker.bundleId).toBe(originalBundleId)
    expect(marker.replacedRelPath).toBe('record.md')
    expect(marker.transactionBasename).toBeDefined()
    expect(marker.enrichedSummary).toBeDefined()
    expect(marker.enrichedBody).toBeDefined()
    const transactionDir = join(
      dirname(fallbackDirs[0]!.dir),
      '.staging',
      marker.transactionBasename!,
    )
    expect(marker.transactionBasename).toMatch(
      new RegExp(`^${marker.leaseId}-mutation-${originalBundleId}-`),
    )
    expect(walk(transactionDir)).toEqual([
      'mutation.json',
      'recovery',
      'recovery/0000',
      'recovery/0001',
      'recovery/0002',
      'recovery/0003',
    ])
    const partial = loadBundle(fallbackDirs[0]!.dir)
    expect(partial.kind).toBe('loaded')
    if (partial.kind !== 'loaded') throw new Error('expected partial enrichment bundle')
    expect(partial.bundle.summary).toBe(marker.enrichedSummary)
    expect(partial.bundle.provenance).toMatchObject({
      needsEnrichment: true,
      authorship: { path: 'deterministic-fallback' },
    })
    expect(verifyBundleIntegrity(fallbackDirs[0]!.dir).ok).toBe(false)

    const killedAt = Date.now()
    await sendRealSigkill(running.child)
    expireKilledLease(knowledgeRoot, marker.leaseId)
    expect(listClaimedLeases(knowledgeRoot)).toContain(marker.leaseId)
    expect(existsSync(transactionDir)).toBe(true)

    const recoveryAuthor = scriptedAuthor()
    const recovery = await drainQueue(options(knowledgeRoot, recoveryAuthor))
    expect(recovery).toMatchObject({
      kind: 'drained',
      failures: 0,
      reconcile: {
        intentsCleared: 1,
        intentsReplayed: 1,
        mutationsRecovered: 1,
      },
    })
    const consistent = assertConsistent(knowledgeRoot, capableCandidate.candidateId)
    expect(consistent.bundleId).toBe(originalBundleId)
    expect(recoveryAuthor).not.toHaveBeenCalled()
    const enrichedDirs = enumerateBundleDirs(knowledgeRoot)
    expect(enrichedDirs).toHaveLength(1)
    expect(enrichedDirs[0]!.dir).toBe(fallbackDirs[0]!.dir)
    const enriched = loadBundle(enrichedDirs[0]!.dir)
    expect(enriched.kind).toBe('loaded')
    if (enriched.kind !== 'loaded') throw new Error('expected recovered enrichment bundle')
    expect(enriched.bundle.manifest.id).toBe(originalBundleId)
    expect(enriched.bundle.summary).toBe(marker.enrichedSummary)
    expect(enriched.bundle.body).toBe(marker.enrichedBody)
    expect(enriched.bundle.provenance).toMatchObject({
      needsEnrichment: false,
      authorship: {
        path: 'llm',
        model: { id: 'sigkill-child-scripted-author' },
      },
    })
    expect(enriched.bundle.events).toHaveLength(2)
    expect(
      enriched.bundle.events.filter(
        (event) =>
          event.type === 'confirmed'
          && event.curationJobId === capableCandidate.candidateId,
      ),
    ).toHaveLength(1)
    assertIndexMatchesBundle(knowledgeRoot, enriched.bundle)

    const beforeSecondRecovery = canonicalStoreSnapshot(knowledgeRoot)
    await drainQueue(options(knowledgeRoot, recoveryAuthor))
    expect(canonicalStoreSnapshot(knowledgeRoot)).toEqual(beforeSecondRecovery)
    expect(recoveryAuthor).not.toHaveBeenCalled()
    expect(Date.now() - killedAt).toBeLessThan(RECOVERY_BOUND_MS)
  } finally {
    if (running !== undefined) await killIfRunning(running.child)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('kill-anywhere recovery across memory.md §8.7 lifecycle boundaries', () => {
  const matrix: readonly FaultPoint[] = [
    'after-emit-before-claim',
    'after-claim-before-author',
    'after-authored-before-bundling',
    'mid-bundling-staged-unpublished',
    'after-publish-before-index',
    'after-index-before-intent-clear',
  ]

  it.each(matrix)('recovers %s exactly once without post-checkpoint re-authoring', async (point) => {
    const root = mkdtempSync(join(tmpdir(), `knowledge-kill-${point}-`))
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const candidate = enqueue(knowledgeRoot, projectionInput(point))
    const author = scriptedAuthor()
    const observed = { value: point === 'after-emit-before-claim' }

    try {
      if (point === 'after-emit-before-claim') {
        const controller = new AbortController()
        controller.abort()
        const first = await drainQueue({
          ...options(knowledgeRoot, author),
          signal: controller.signal,
        })
        expect(first.kind).toBe('aborted')
      } else if (point === 'after-claim-before-author') {
        await expect(
          drainQueue(
            options(
              knowledgeRoot,
              author,
              operationsForFault(point, knowledgeRoot, observed),
            ),
          ),
        ).rejects.toThrow('injected crash after claim before author')
      } else {
        const first = await drainQueue(
          options(
            knowledgeRoot,
            author,
            operationsForFault(point, knowledgeRoot, observed),
          ),
        )
        expect(first.failures).toBeGreaterThanOrEqual(1)
      }

      expect(observed.value).toBe(true)
      const callsAtRecoveryStart = author.mock.calls.length
      if (point === 'after-authored-before-bundling'
        || point === 'mid-bundling-staged-unpublished'
        || point === 'after-publish-before-index'
        || point === 'after-index-before-intent-clear') {
        expect(callsAtRecoveryStart).toBe(1)
      }

      await drainQueue(options(knowledgeRoot, author))
      const consistent = assertConsistent(knowledgeRoot, candidate.candidateId)
      expect(author).toHaveBeenCalledTimes(1)

      const beforeSecondRecovery = treeSnapshot(consistent.bundleTree)
      await drainQueue(options(knowledgeRoot, author))
      expect(treeSnapshot(consistent.bundleTree)).toEqual(beforeSecondRecovery)
      expect(enumerateBundleDirs(knowledgeRoot).map(({ dir }) => dir)).toHaveLength(1)
      expect(author).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers a real SIGKILL after authored intent in under 30 seconds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-sigkill-'))
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const markerPath = join(root, 'child-at-intent.marker')
    const candidate = enqueue(knowledgeRoot, projectionInput('sigkill'))
    const running = startSigkillChild({
      point: 'authored-intent',
      knowledgeRoot,
      markerPath,
    })

    try {
      const marker = await waitForBoundaryMarker(
        markerPath,
        'authored-intent',
        running.child,
        running.output,
      )
      expect(marker.candidateId).toBe(candidate.candidateId)
      const killedAt = Date.now()
      await sendRealSigkill(running.child)
      expireKilledLease(knowledgeRoot, marker.leaseId)

      const recoveryAuthor = scriptedAuthor()
      await drainQueue(options(knowledgeRoot, recoveryAuthor))
      assertConsistent(knowledgeRoot, candidate.candidateId)
      expect(recoveryAuthor).not.toHaveBeenCalled()
      expect(Date.now() - killedAt).toBeLessThan(RECOVERY_BOUND_MS)
    } finally {
      await killIfRunning(running.child)
      rmSync(root, { recursive: true, force: true })
    }
  }, SIGKILL_CELL_TIMEOUT_MS)

  it('recovers a real SIGKILL from durable publish staging without re-authoring', async () => {
    await proveRealSigkillBoundary('publish-staged')
  }, SIGKILL_CELL_TIMEOUT_MS)

  it('recovers a real SIGKILL from partial mutable enrichment without re-authoring', async () => {
    await proveRealSigkillBoundary('mutable-enrichment')
  }, SIGKILL_CELL_TIMEOUT_MS)
})
