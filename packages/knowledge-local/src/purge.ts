// Owns local store surfaces only; it runs no git operation and never rewrites repository history.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import {
  canonicalJson,
  committedFileText,
  createVersionGuard,
  recordGraphNode,
} from '@vostride/agent-qa-schema'
import type { RecordId } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import { assertWithinKnowledgeRoot } from './knowledge-containment.js'
import { loadBundle } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import { canaryOutcomePayloadSchema } from './canary-emit.js'
import { fsyncDirectory, fsyncFile } from './durable-fs.js'
import {
  deleteRecordFromAllSchemaVecTables,
  indexDbPath,
  openIndexWriter,
} from './index-open.js'
import { refreshWriterLeaseAuthority } from './lease/writer-lease.js'
import type { WriterLeaseAuthority } from './lease/writer-lease.js'
import { jobStatePath, queueRoot } from './queue/queue-layout.js'
import { curationCandidatePayloadSchema } from './queue/queue-payload.js'
import {
  PURGE_RECEIPT_SCHEMA_VERSION,
  PURGE_SAFE_RECORD_ID as SAFE_RECORD_ID,
  PurgeReceiptSchema,
  guardPurgeReceipt,
  guardPurgeReceiptForFile,
  parseCanonicalPurgeReceiptFileName,
  purgeReceiptRelativePathSchema as receiptRelativePathSchema,
} from './purge-receipt.js'
import type { PurgeReceipt } from './purge-receipt.js'

export {
  PURGE_RECEIPT_SCHEMA_VERSION,
  PurgeReceiptSchema,
  guardPurgeReceipt,
  purgeReceiptSchema,
} from './purge-receipt.js'
export type { PurgeReceipt } from './purge-receipt.js'

/**
 * Queue entries use 64-hex content addresses; prefixed maintenance receipt ids are not queue
 * identities.
 */
const QUEUE_CANDIDATE_ID = /^[0-9a-f]{64}$/
const PURGE_SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface PurgeAffectedBundleTarget {
  product: string
  bundleDir: string
  kind: LoadedBundle['frontmatter']['kind']
  affectedPaths: string[]
}

export interface PurgeAffectedQueueTarget {
  candidateId: string
  candidateDir: string
  jobStatePath: string
}

/**
 * Content-free, deterministic statement of every local surface one purge operation will affect.
 * This is the single planning shape shared by preview, the under-lease recheck, and destructive
 * execution.
 */
export interface PurgeAffectedSet {
  recordId: string
  state: 'live' | 'resume' | 'already-purged' | 'not-found'
  bundles: PurgeAffectedBundleTarget[]
  receiptAffectedPaths: string[]
  projectionTargets: string[]
  embedCacheAction: 'clear-all'
  queueTargets: PurgeAffectedQueueTarget[]
  intentPath: string
  receiptPath: string
}

const PurgeAffectedBundleTargetSchema = z.object({
  product: z.string().min(1),
  bundleDir: receiptRelativePathSchema,
  kind: z.enum(['fact', 'procedure', 'caution', 'unknown', 'policy']),
  affectedPaths: z.array(receiptRelativePathSchema),
}).strict()

const PurgeAffectedQueueTargetSchema = z.object({
  candidateId: z.string().regex(QUEUE_CANDIDATE_ID),
  candidateDir: receiptRelativePathSchema,
  jobStatePath: receiptRelativePathSchema,
}).strict()

const PurgeAffectedSetSchema = z.object({
  recordId: z.string().regex(SAFE_RECORD_ID),
  state: z.enum(['live', 'resume', 'already-purged', 'not-found']),
  bundles: z.array(PurgeAffectedBundleTargetSchema),
  receiptAffectedPaths: z.array(receiptRelativePathSchema),
  projectionTargets: z.array(z.string()),
  embedCacheAction: z.literal('clear-all'),
  queueTargets: z.array(PurgeAffectedQueueTargetSchema),
  intentPath: receiptRelativePathSchema,
  receiptPath: receiptRelativePathSchema,
}).strict()

export const PURGE_INTENT_SCHEMA_VERSION = 2

// Published before the first irreversible step, so a crashed purge replays persisted identities.
export const PurgeIntentSchema = z.object({
  schemaVersion: z.literal(PURGE_INTENT_SCHEMA_VERSION),
  purgedRecordId: z.string().regex(SAFE_RECORD_ID),
  receipt: PurgeReceiptSchema,
  receiptCycle: z.number().int().positive(),
  bundleDirs: z.array(receiptRelativePathSchema).min(1),
  queueCandidateIds: z.array(z.string().regex(QUEUE_CANDIDATE_ID)),
  queuePayloadDirs: z.array(receiptRelativePathSchema),
  affectedSet: PurgeAffectedSetSchema,
}).strict()

/** Lower-camel schema alias follows the existing knowledge-local committed-file convention. */
export const purgeIntentSchema = PurgeIntentSchema
export type PurgeIntent = z.infer<typeof PurgeIntentSchema>

const guardPurgeIntentVersion = createVersionGuard<PurgeIntent>({
  name: 'PurgeIntent',
  current: PURGE_INTENT_SCHEMA_VERSION,
  migrations: {},
})

export function guardPurgeIntent(value: unknown): PurgeIntent {
  return PurgeIntentSchema.parse(guardPurgeIntentVersion(value))
}

export interface PurgeRecordInput {
  knowledgeRoot: string
  recordId: RecordId
  // The confirmed user identity, supplied by the caller.
  initiator: string
  /** Runtime-counter reservation used for a fresh destruction receipt; resumes reuse intent. */
  purgedAtOrdinal?: number
  /** Governed maintenance callers fence this exact lease at every mutation boundary. */
  writerAuthority?: WriterLeaseAuthority
  /** Fingerprint of the caller's preview; drift must fail before any mutation. */
  expectedAffectedSetFingerprint?: string
  /** Test/chaos seam between purge phases; production callers omit it (commit.ts precedent). */
  hooks?: {
    /** Immediately after the durable intent publication. */
    afterIntentWritten?: () => void
    /** After the transactional projection purge. */
    afterProjectionPurge?: () => void
    /** After every committed bundle tree removal. */
    afterBundleRemoval?: () => void
    /** After the queue payload sweep. */
    afterQueueSweep?: () => void
    /** Immediately before the completion receipt publication. */
    beforeReceiptPublish?: () => void
  }
}

export type PurgeRecordOutcome =
  | { kind: 'purged'; receipt: PurgeReceipt }
  | { kind: 'already-purged'; receipt: PurgeReceipt }
  | { kind: 'not-found' }

interface ResolvedBundle {
  product: string
  dir: string
  bundle: LoadedBundle
}

export class PurgeTargetChangedError extends Error {
  readonly code = 'purge-target-changed'

  constructor(
    readonly expectedFingerprint: string,
    readonly actualFingerprint: string,
  ) {
    super('purge target set changed after the preview')
    this.name = 'PurgeTargetChangedError'
  }
}

export class PurgeTargetIntegrityError extends Error {
  readonly code = 'purge-target-integrity'

  constructor(readonly targetPath: string, readonly reason: string) {
    super(`purge target ${targetPath} is not safely readable: ${reason}`)
    this.name = 'PurgeTargetIntegrityError'
  }
}

export class PurgeQueueIdentityError extends Error {
  readonly code = 'purge-queue-identity'

  constructor(readonly targetPath: string, readonly reason: string) {
    super(`purge cannot establish queue identity at ${targetPath}: ${reason}`)
    this.name = 'PurgeQueueIdentityError'
  }
}

export class PurgeCompletionVerificationError extends Error {
  readonly code = 'purge-completion-verification'

  constructor(readonly survivingSurface: string) {
    super(`purge completion verification found a surviving surface: ${survivingSurface}`)
    this.name = 'PurgeCompletionVerificationError'
  }
}

export class PurgeChronologyRequiredError extends Error {
  readonly code = 'purge-chronology-required'

  constructor() {
    super('fresh purge requires a runtime-counter purgedAtOrdinal reservation')
    this.name = 'PurgeChronologyRequiredError'
  }
}

function assertInput(input: PurgeRecordInput): void {
  if (!isAbsolute(input.knowledgeRoot)) {
    throw new TypeError('knowledgeRoot must be absolute')
  }
  if (input.initiator.trim() === '') {
    throw new TypeError('initiator must be a non-empty caller-supplied identity')
  }
  if (!SAFE_RECORD_ID.test(input.recordId)) {
    throw new TypeError('recordId must be a safe path segment')
  }
  if (
    input.expectedAffectedSetFingerprint !== undefined
    && !/^[0-9a-f]{64}$/u.test(input.expectedAffectedSetFingerprint)
  ) {
    throw new TypeError('expectedAffectedSetFingerprint must be a lowercase SHA-256 hex digest')
  }
  if (
    input.purgedAtOrdinal !== undefined
    && (!Number.isSafeInteger(input.purgedAtOrdinal) || input.purgedAtOrdinal < 0)
  ) {
    throw new RangeError('purgedAtOrdinal must be a non-negative safe integer')
  }
  if (
    input.writerAuthority !== undefined
    && input.writerAuthority.knowledgeRoot !== input.knowledgeRoot
  ) {
    throw new TypeError('writerAuthority must belong to knowledgeRoot')
  }
}

function fenceWriterAuthority(input: PurgeRecordInput): void {
  if (input.writerAuthority === undefined) return
  if (input.writerAuthority.knowledgeRoot !== input.knowledgeRoot) {
    throw new TypeError('writerAuthority must belong to knowledgeRoot')
  }
  refreshWriterLeaseAuthority(input.writerAuthority)
}

function resolveBundles(knowledgeRoot: string, recordId: RecordId): ResolvedBundle[] {
  const matches: ResolvedBundle[] = []
  const memoryRoot = join(knowledgeRoot, 'memory')
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(memoryRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      entry.name.startsWith('.')
      || entry.name === 'index'
      || entry.name === 'queue'
      || entry.name === 'receipts'
    ) continue
    const targetRelativePath = `memory/${entry.name}/bundles/${recordId}`
    const targetDir = join(knowledgeRoot, targetRelativePath)
    let targetStat
    try {
      targetStat = lstatSync(targetDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (
      !PURGE_SAFE_PATH_SEGMENT.test(entry.name)
      || entry.name === '.'
      || entry.name === '..'
    ) {
      throw new PurgeTargetIntegrityError(targetRelativePath, 'non-canonical product path')
    }
    assertNoSymlinkComponents(knowledgeRoot, targetRelativePath)
    if (!targetStat.isDirectory()) {
      throw new PurgeTargetIntegrityError(targetRelativePath, 'target is not a directory')
    }
    const loaded = loadBundle(targetDir)
    if (loaded.kind !== 'loaded') {
      throw new PurgeTargetIntegrityError(targetRelativePath, loaded.kind)
    }
    if (loaded.bundle.manifest.id !== recordId) {
      throw new PurgeTargetIntegrityError(
        targetRelativePath,
        `manifest identifies ${loaded.bundle.manifest.id}`,
      )
    }
    matches.push({ product: entry.name, dir: targetDir, bundle: loaded.bundle })
  }
  return matches
}

function transaction(operation: () => void, db: ReturnType<typeof openIndexWriter>['db']): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    operation()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the deletion failure that caused the rollback.
    }
    throw error
  }
}

/** Reuse removeMissingBundles' total five-statement deletion set for one known record. */
function purgeIndexSurfaces(
  knowledgeRoot: string,
  recordId: RecordId,
  kind?: LoadedBundle['frontmatter']['kind'],
): void {
  if (!existsSync(indexDbPath(knowledgeRoot))) return

  const writer = openIndexWriter(knowledgeRoot)
  try {
    const row = writer.db
      .prepare('SELECT record_rowid, kind FROM records WHERE bundle_id = ?')
      .get(recordId)
    // A resume over destroyed bundles derives the graph identity from the projection row; when
    // both are gone the pre-removal projection purge already committed and only the idempotent
    // orphan-node and cache cleanup remains.
    const resolvedKind =
      kind
      ?? (row === undefined
        ? undefined
        : (String(row.kind) as LoadedBundle['frontmatter']['kind']))
    const recordNode =
      resolvedKind === undefined ? undefined : recordGraphNode(resolvedKind, recordId)

    transaction(() => {
      if (row !== undefined && recordNode !== undefined) {
        const recordRowid = Number(row.record_rowid)
        deleteRecordFromAllSchemaVecTables(writer.db, recordRowid)
        writer.db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
        writer.db.prepare('DELETE FROM anchors WHERE record_rowid = ?').run(recordRowid)
        writer.db.prepare(`
          DELETE FROM graph_edges
          WHERE record_rowid = ? OR src_node_id = ? OR dst_node_id = ?
        `).run(recordRowid, recordNode.nodeId, recordNode.nodeId)
        writer.db.prepare('DELETE FROM records WHERE record_rowid = ?').run(recordRowid)
      } else if (recordNode !== undefined) {
        // A stale graph projection can outlive a missing records row; remove both directions.
        writer.db.prepare(`
          DELETE FROM graph_edges
          WHERE src_node_id = ? OR dst_node_id = ?
        `).run(recordNode.nodeId, recordNode.nodeId)
      }

      writer.db.exec(`
        DELETE FROM graph_nodes
        WHERE node_id NOT IN (
          SELECT src_node_id FROM graph_edges
          UNION
          SELECT dst_node_id FROM graph_edges
        )
      `)

      // Clears the whole cache instead of guessing old rendering hashes; it rebuilds itself.
      const cachePresent = writer.db
        .prepare(`
          SELECT 1
          FROM sqlite_master
          WHERE type = 'table' AND name = 'embed_cache'
        `)
        .get()
      if (cachePresent !== undefined) {
        writer.db.prepare('DELETE FROM embed_cache').run()
      }
    }, writer.db)
  } finally {
    writer.close()
  }
}

function payloadDirectories(root: string): string[] {
  const found: string[] = []

  function visit(dir: string): void {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    if (entries.some((entry) => entry.isFile() && entry.name === 'payload.json')) {
      found.push(dir)
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(dir, entry.name))
    }
  }

  visit(root)
  return found.sort()
}

function removeEmptyQueueParents(
  candidateDir: string,
  root: string,
  beforeMutation?: () => void,
): void {
  let current = dirname(candidateDir)
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    try {
      beforeMutation?.()
      rmdirSync(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        current = dirname(current)
        continue
      }
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return
      throw error
    }
    current = dirname(current)
  }
}

/** One exact queue deletion decided before any destruction. */
export interface QueueSweepTarget {
  candidateDir: string
  /** Queue-entry identity used by the transport and job-state store, not payload lineage. */
  candidateId: string
}

function lineageCandidateIds(matches: readonly ResolvedBundle[]): Set<string> {
  const ids = new Set<string>(matches.map(({ bundle }) => bundle.manifest.id))
  for (const { bundle } of matches) {
    const jobIds = [
      ...(bundle.provenance.mode === 'run-linked'
        && bundle.provenance.curationJobId !== undefined
        ? [bundle.provenance.curationJobId]
        : []),
      ...bundle.events.map((event) => event.curationJobId),
      ...bundle.relations.relations.map((relation) => relation.curationJobId),
    ]
    for (const jobId of jobIds) {
      if (QUEUE_CANDIDATE_ID.test(jobId)) ids.add(jobId)
    }
  }
  return ids
}

function contentSeeds(matches: readonly ResolvedBundle[]): Set<string> {
  const seeds = new Set<string>()
  for (const { bundle } of matches) {
    if (bundle.summary !== '') seeds.add(bundle.summary)
    if (bundle.body !== '') seeds.add(bundle.body)
  }
  return seeds
}

function artifactDigests(matches: readonly ResolvedBundle[]): Set<string> {
  const digests = new Set<string>()
  for (const { bundle } of matches) {
    for (const digest of Object.values(bundle.manifest.contentHashes)) {
      digests.add(digest)
    }
  }
  return digests
}

function looselyCarriesPurgedContent(
  payload: unknown,
  seeds: ReadonlySet<string>,
  digests: ReadonlySet<string>,
): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const loose = payload as Record<string, unknown>
  const seedMatch = [loose['summarySeed'], loose['bodySeed']].some(
    (seed) => typeof seed === 'string' && seeds.has(seed),
  )
  const inventory: unknown[] = Array.isArray(loose['artifactInventory'])
    ? loose['artifactInventory']
    : []
  return seedMatch || inventory.some((artifact) => {
    if (typeof artifact !== 'object' || artifact === null) return false
    const digest = (artifact as Record<string, unknown>)['sha256']
    return typeof digest === 'string' && digests.has(digest)
  })
}

// A queue payload is destroyed only on content or job lineage; anchor overlap never selects it.
export function resolveQueueSweepTargets(
  knowledgeRoot: string,
  matches: readonly ResolvedBundle[],
): QueueSweepTarget[] {
  const lineage = lineageCandidateIds(matches)
  const seeds = contentSeeds(matches)
  const digests = artifactDigests(matches)

  const targets: QueueSweepTarget[] = []
  for (const candidateDir of payloadDirectories(queueRoot(knowledgeRoot))) {
    const candidateId = basename(candidateDir)
    if (!QUEUE_CANDIDATE_ID.test(candidateId)) {
      throw new PurgeQueueIdentityError(candidateDir, 'non-canonical candidate directory')
    }
    if (lineage.has(candidateId)) {
      targets.push({ candidateDir, candidateId })
      continue
    }

    let payload: unknown
    try {
      payload = JSON.parse(readFileSync(join(candidateDir, 'payload.json'), 'utf8'))
    } catch (error) {
      throw new PurgeQueueIdentityError(
        candidateDir,
        error instanceof Error ? error.message : 'malformed JSON payload',
      )
    }

    const curationCandidate = curationCandidatePayloadSchema.safeParse(payload)
    if (curationCandidate.success) {
      const {
        candidateId: lineageId,
        summarySeed,
        bodySeed,
        artifactInventory,
      } = curationCandidate.data
      const carriesPurgedIdentity =
        lineage.has(lineageId)
        || seeds.has(summarySeed)
        || seeds.has(bodySeed)
        || artifactInventory.some((artifact) => digests.has(artifact.sha256))
      if (carriesPurgedIdentity) targets.push({ candidateDir, candidateId })
      continue
    }

    const canaryOutcome = canaryOutcomePayloadSchema.safeParse(payload)
    if (canaryOutcome.success && lineage.has(canaryOutcome.data.candidateId)) {
      targets.push({ candidateDir, candidateId })
      continue
    }

    const payloadCandidateId = (
      typeof payload === 'object'
      && payload !== null
      && 'candidateId' in payload
      && typeof payload.candidateId === 'string'
    ) ? payload.candidateId : undefined
    if (payloadCandidateId !== undefined && lineage.has(payloadCandidateId)) {
      targets.push({ candidateDir, candidateId })
      continue
    }

    // A payload matching no current schema, including one stamped at another version, is read
    // loosely for the purged content and otherwise left in place.
    if (
      !curationCandidate.success
      && !canaryOutcome.success
      && looselyCarriesPurgedContent(payload, seeds, digests)
    ) {
      targets.push({ candidateDir, candidateId })
    }
  }
  return targets.sort((left, right) =>
    left.candidateDir < right.candidateDir
      ? -1
      : left.candidateDir > right.candidateDir
        ? 1
        : 0,
  )
}

/** Pure destruction pass over the pre-resolved exact deletion set. */
function sweepQueuePayloads(
  input: PurgeRecordInput,
  targets: readonly QueueSweepTarget[],
): void {
  const root = queueRoot(input.knowledgeRoot)
  for (const target of targets) {
    // Never delete through a queue directory linked out of the knowledge root.
    assertWithinKnowledgeRoot(input.knowledgeRoot, target.candidateDir)
    assertWithinKnowledgeRoot(input.knowledgeRoot,
      dirname(jobStatePath(input.knowledgeRoot, target.candidateId)))
    fenceWriterAuthority(input)
    rmSync(target.candidateDir, { recursive: true, force: true })
    fenceWriterAuthority(input)
    rmSync(jobStatePath(input.knowledgeRoot, target.candidateId), { force: true })
    removeEmptyQueueParents(
      target.candidateDir,
      root,
      () => fenceWriterAuthority(input),
    )
  }
}

function assertPurgePathAbsent(knowledgeRoot: string, relativePath: string): void {
  try {
    lstatSync(join(knowledgeRoot, relativePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new PurgeCompletionVerificationError(relativePath)
}

function verifyPurgedIndexSurfaces(knowledgeRoot: string, recordId: RecordId): void {
  if (!existsSync(indexDbPath(knowledgeRoot))) return
  const writer = openIndexWriter(knowledgeRoot)
  try {
    if (writer.db.prepare('SELECT 1 FROM records WHERE bundle_id = ?').get(recordId)) {
      throw new PurgeCompletionVerificationError(`index records/${recordId}`)
    }
    const nodeIds = ['fact', 'procedure', 'caution', 'unknown', 'policy']
      .map((kind) => recordGraphNode(
        kind as LoadedBundle['frontmatter']['kind'],
        recordId,
      ).nodeId)
    for (const nodeId of nodeIds) {
      if (writer.db.prepare('SELECT 1 FROM graph_nodes WHERE node_id = ?').get(nodeId)) {
        throw new PurgeCompletionVerificationError(`index graph_nodes/${nodeId}`)
      }
      if (writer.db.prepare(`
        SELECT 1 FROM graph_edges WHERE src_node_id = ? OR dst_node_id = ?
      `).get(nodeId, nodeId)) {
        throw new PurgeCompletionVerificationError(`index graph_edges/${nodeId}`)
      }
    }
  } finally {
    writer.close()
  }
}

/** Fail closed immediately before receipt publication if any selected surface still exists. */
function verifyPurgeCompletion(input: PurgeRecordInput, intent: PurgeIntent): void {
  const rediscoveredBundles = resolveBundles(input.knowledgeRoot, input.recordId)
  if (rediscoveredBundles.length > 0) {
    throw new PurgeCompletionVerificationError(
      toReceiptPath(input.knowledgeRoot, rediscoveredBundles[0]!.dir),
    )
  }
  for (const path of intent.bundleDirs) assertPurgePathAbsent(input.knowledgeRoot, path)
  for (const path of intent.queuePayloadDirs) assertPurgePathAbsent(input.knowledgeRoot, path)
  for (const candidateId of intent.queueCandidateIds) {
    assertPurgePathAbsent(
      input.knowledgeRoot,
      `memory/queue/jobs/${candidateId}.state.json`,
    )
  }
  const candidateIds = new Set(intent.queueCandidateIds)
  for (const dir of payloadDirectories(queueRoot(input.knowledgeRoot))) {
    if (candidateIds.has(basename(dir))) {
      throw new PurgeCompletionVerificationError(toReceiptPath(input.knowledgeRoot, dir))
    }
  }
  verifyPurgedIndexSurfaces(input.knowledgeRoot, input.recordId)
}

/**
 * The append-only receipt series: cycle 1 IS the pre-existing base receipt path, cycle N >= 2
 * lives beside it with the cycle number suffixed. Each destruction of a record id is its own
 * auditable event; earlier cycles' bytes never change.
 */
function receiptCycleRelativePath(recordId: RecordId, cycle: number): string {
  return cycle === 1
    ? `memory/receipts/purge-${recordId}.json`
    : `memory/receipts/purge-${recordId}.${cycle}.json`
}

function receiptCyclePath(knowledgeRoot: string, recordId: RecordId, cycle: number): string {
  const fileName = receiptCycleRelativePath(recordId, cycle).split('/').at(-1)!
  return join(knowledgeRoot, 'memory', 'receipts', fileName)
}

/** The intent lives beside the receipt series it completes into. */
function intentPath(knowledgeRoot: string, recordId: RecordId): string {
  return join(knowledgeRoot, 'memory', 'receipts', `purge-${recordId}.intent.json`)
}

function readReceiptAtCycle(
  knowledgeRoot: string,
  recordId: RecordId,
  cycle: number,
): PurgeReceipt | undefined {
  const file = receiptCyclePath(knowledgeRoot, recordId, cycle)
  if (!existsSync(file)) return undefined
  return guardPurgeReceiptForFile(
    JSON.parse(readFileSync(file, 'utf8')),
    basename(file),
    { recordId, cycle },
  )
}

interface ReceiptSeries {
  /** The most recent destruction receipt, undefined when the series is empty. */
  latestReceipt: PurgeReceipt | undefined
  /** The first free cycle slot; cycles are dense from 1 by construction. */
  nextCycle: number
}

/**
 * Probe the durable series upward from the base path. Cycles are published exclusively and in
 * order, so the first missing slot is the next cycle and the slot before it holds the latest
 * receipt — the derivation is deterministic over store state alone.
 */
function resolveReceiptSeries(knowledgeRoot: string, recordId: RecordId): ReceiptSeries {
  let cycle = 1
  while (existsSync(receiptCyclePath(knowledgeRoot, recordId, cycle))) cycle += 1
  const latestCycle = cycle - 1
  return {
    latestReceipt:
      latestCycle === 0
        ? undefined
        : readReceiptAtCycle(knowledgeRoot, recordId, latestCycle),
    nextCycle: cycle,
  }
}

function assertCanonicalPurgeReceiptHistory(knowledgeRoot: string): void {
  const receiptsDir = join(knowledgeRoot, 'memory', 'receipts')
  let files: string[]
  try {
    files = readdirSync(receiptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  for (const file of files) {
    const canonicalName = parseCanonicalPurgeReceiptFileName(file)
    if (canonicalName === undefined) continue
    guardPurgeReceiptForFile(
      JSON.parse(readFileSync(join(receiptsDir, file), 'utf8')),
      file,
      canonicalName,
    )
  }
}

function assertNoSymlinkComponents(knowledgeRoot: string, relativePath: string): void {
  let current = knowledgeRoot
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new TypeError(`purge authority path crosses a symbolic link: ${relativePath}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicate identities`)
  }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function assertSameIdentities(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertUnique(actual, label)
  assertUnique(expected, label)
  if (canonicalJson(sorted(actual)) !== canonicalJson(sorted(expected))) {
    throw new TypeError(`${label} does not match the executable purge identities`)
  }
}

function bundleAuthority(
  relativePath: string,
  recordId: RecordId,
): { product: string; bundleDir: string } {
  const segments = relativePath.split('/')
  if (
    segments.length !== 4
    || segments[0] !== 'memory'
    || !PURGE_SAFE_PATH_SEGMENT.test(segments[1]!)
    || segments[1] === '.'
    || segments[1] === '..'
    || segments[2] !== 'bundles'
    || segments[3] !== recordId
  ) {
    throw new TypeError(
      `purge bundle authority must be memory/<product>/bundles/${recordId}`,
    )
  }
  return { product: segments[1]!, bundleDir: relativePath }
}

function queueAuthority(relativePath: string): { candidateId: string } {
  const segments = relativePath.split('/')
  const queued = segments.length === 4
    && segments[0] === 'memory'
    && segments[1] === 'queue'
    && segments[2] === 'queued'
  const claimed = segments.length === 5
    && segments[0] === 'memory'
    && segments[1] === 'queue'
    && segments[2] === 'claimed'
    && PURGE_SAFE_PATH_SEGMENT.test(segments[3]!)
    && segments[3] !== '.'
    && segments[3] !== '..'
  const candidateId = segments.at(-1) ?? ''
  if ((!queued && !claimed) || !QUEUE_CANDIDATE_ID.test(candidateId)) {
    throw new TypeError('purge queue authority must name one canonical queued/claimed candidate')
  }
  return { candidateId }
}

function assertBundleAffectedPaths(
  bundleDir: string,
  paths: readonly string[],
  label: string,
): void {
  if (paths.length === 0 || paths.some((path) => (
    path !== bundleDir && !path.startsWith(`${bundleDir}/`)
  ))) {
    throw new TypeError(`${label} must stay within its canonical bundle directory`)
  }
  assertUnique(paths, label)
}

/**
 * Convert schema-valid persisted bytes into deletion authority only after every redundant
 * identity agrees with the requested record and canonical filesystem layout.
 */
function guardPurgeIntentForRequest(
  knowledgeRoot: string,
  requestedRecordId: RecordId,
  value: unknown,
): PurgeIntent {
  const intent = guardPurgeIntent(value)
  if (
    intent.purgedRecordId !== requestedRecordId
    || intent.receipt.purgedRecordId !== requestedRecordId
  ) {
    throw new TypeError('purge intent record identity does not match the requested record')
  }

  assertUnique(intent.bundleDirs, 'purge intent bundleDirs')
  for (const path of intent.bundleDirs) bundleAuthority(path, requestedRecordId)
  const queueTargets = intent.queuePayloadDirs.map((path) => ({
    ...queueAuthority(path),
    candidateDir: path,
  }))
  assertSameIdentities(
    queueTargets.map(({ candidateId }) => candidateId),
    intent.queueCandidateIds,
    'purge intent queue candidates',
  )
  for (const path of [
    ...intent.bundleDirs,
    ...intent.queuePayloadDirs,
    ...intent.queueCandidateIds.map((candidateId) =>
      `memory/queue/jobs/${candidateId}.state.json`,
    ),
    receiptCycleRelativePath(requestedRecordId, intent.receiptCycle),
  ]) {
    assertNoSymlinkComponents(knowledgeRoot, path)
  }
  for (const path of intent.receipt.affectedPaths) {
    const owner = intent.bundleDirs.find((bundleDir) => (
      path === bundleDir || path.startsWith(`${bundleDir}/`)
    ))
    if (owner === undefined) {
      throw new TypeError('purge receipt affectedPaths escape the persisted bundle authorities')
    }
  }

  const affected = intent.affectedSet
  if (affected.recordId !== requestedRecordId || affected.state !== 'resume') {
    throw new TypeError('purge affected set does not identify the resumable requested record')
  }
  if (
    affected.intentPath !== `memory/receipts/purge-${requestedRecordId}.intent.json`
    || affected.receiptPath
      !== receiptCycleRelativePath(requestedRecordId, intent.receiptCycle)
  ) {
    throw new TypeError('purge affected-set audit paths do not match the requested receipt slot')
  }
  assertSameIdentities(
    affected.bundles.map(({ bundleDir }) => bundleDir),
    intent.bundleDirs,
    'purge affected-set bundles',
  )
  for (const bundle of affected.bundles) {
    const authority = bundleAuthority(bundle.bundleDir, requestedRecordId)
    if (bundle.product !== authority.product) {
      throw new TypeError('purge affected-set product does not match its bundle path')
    }
    assertBundleAffectedPaths(
      bundle.bundleDir,
      bundle.affectedPaths,
      'purge affected-set bundle paths',
    )
  }
  assertSameIdentities(
    affected.bundles.flatMap(({ affectedPaths }) => affectedPaths),
    intent.receipt.affectedPaths,
    'purge affected-set bundle contents',
  )
  assertSameIdentities(
    affected.receiptAffectedPaths,
    intent.receipt.affectedPaths,
    'purge affected-set receipt paths',
  )
  const expectedQueueTargets = queueTargets.map(({ candidateId, candidateDir }) =>
    canonicalJson({
      candidateId,
      candidateDir,
      jobStatePath: `memory/queue/jobs/${candidateId}.state.json`,
    }),
  )
  assertSameIdentities(
    affected.queueTargets.map((target) => canonicalJson(target)),
    expectedQueueTargets,
    'purge affected-set queue targets',
  )
  assertSameIdentities(
    affected.projectionTargets,
    PURGE_PROJECTION_TARGETS,
    'purge affected-set projections',
  )
  return intent
}

function readExistingIntent(knowledgeRoot: string, recordId: RecordId): PurgeIntent | undefined {
  const file = intentPath(knowledgeRoot, recordId)
  if (!existsSync(file)) return undefined
  assertNoSymlinkComponents(
    knowledgeRoot,
    `memory/receipts/purge-${recordId}.intent.json`,
  )
  return guardPurgeIntentForRequest(
    knowledgeRoot,
    recordId,
    JSON.parse(readFileSync(file, 'utf8')),
  )
}

function toReceiptPath(knowledgeRoot: string, absolutePath: string): string {
  return relative(knowledgeRoot, absolutePath).split(sep).join('/')
}

function affectedPaths(knowledgeRoot: string, matches: readonly ResolvedBundle[]): string[] {
  const paths = new Set<string>()
  for (const match of matches) {
    const bundleDir = toReceiptPath(knowledgeRoot, match.dir)
    paths.add(bundleDir)
    for (const relPath of Object.keys(match.bundle.manifest.contentHashes)) {
      paths.add(`${bundleDir}/${relPath}`)
    }
    paths.add(`${bundleDir}/manifest.json`)
  }
  return [...paths].sort()
}

const PURGE_PROJECTION_TARGETS = ['records', 'anchors', 'fts', 'vec', 'graph'] as const

interface ResolvedPurgeTargets {
  affectedSet: PurgeAffectedSet
  intent: PurgeIntent | undefined
  matches: ResolvedBundle[]
  queueSweepTargets: QueueSweepTarget[]
  series: ReceiptSeries | undefined
}

function baseAffectedSet(
  knowledgeRoot: string,
  recordId: RecordId,
  state: PurgeAffectedSet['state'],
  receiptCycle: number,
): PurgeAffectedSet {
  return {
    recordId,
    state,
    bundles: [],
    receiptAffectedPaths: [],
    projectionTargets: [...PURGE_PROJECTION_TARGETS],
    embedCacheAction: 'clear-all',
    queueTargets: [],
    intentPath: toReceiptPath(knowledgeRoot, intentPath(knowledgeRoot, recordId)),
    receiptPath: receiptCycleRelativePath(recordId, receiptCycle),
  }
}

/**
 * The sole selector for purge preview and execution. New resolutions inspect every loadable
 * bundle and matching queue payload; resumptions use only the durable plan embedded in the
 * standing intent, even when some selected paths have already disappeared.
 */
function resolvePurgeTargets(
  knowledgeRoot: string,
  recordId: RecordId,
): ResolvedPurgeTargets {
  assertCanonicalPurgeReceiptHistory(knowledgeRoot)
  const persistedIntent = readExistingIntent(knowledgeRoot, recordId)
  if (persistedIntent !== undefined) {
    return {
      affectedSet: persistedIntent.affectedSet,
      intent: persistedIntent,
      matches: [],
      queueSweepTargets: [],
      series: undefined,
    }
  }

  const matches = resolveBundles(knowledgeRoot, recordId)
  const series = resolveReceiptSeries(knowledgeRoot, recordId)
  if (matches.length === 0) {
    const state = series.latestReceipt === undefined ? 'not-found' : 'already-purged'
    const receiptCycle = series.latestReceipt === undefined
      ? series.nextCycle
      : series.nextCycle - 1
    return {
      affectedSet: baseAffectedSet(knowledgeRoot, recordId, state, receiptCycle),
      intent: undefined,
      matches,
      queueSweepTargets: [],
      series,
    }
  }

  const queueSweepTargets = resolveQueueSweepTargets(knowledgeRoot, matches)
  const affectedSet: PurgeAffectedSet = {
    ...baseAffectedSet(knowledgeRoot, recordId, 'live', series.nextCycle),
    bundles: matches
      .map((match) => ({
        product: match.product,
        bundleDir: toReceiptPath(knowledgeRoot, match.dir),
        kind: match.bundle.frontmatter.kind,
        affectedPaths: affectedPaths(knowledgeRoot, [match]),
      }))
      .sort((left, right) => left.bundleDir.localeCompare(right.bundleDir)),
    receiptAffectedPaths: affectedPaths(knowledgeRoot, matches),
    queueTargets: queueSweepTargets
      .map((target) => ({
        candidateId: target.candidateId,
        candidateDir: toReceiptPath(knowledgeRoot, target.candidateDir),
        jobStatePath: toReceiptPath(
          knowledgeRoot,
          jobStatePath(knowledgeRoot, target.candidateId),
        ),
      }))
      .sort((left, right) => left.candidateDir.localeCompare(right.candidateDir)),
  }
  return {
    affectedSet: PurgeAffectedSetSchema.parse(affectedSet) as PurgeAffectedSet,
    intent: undefined,
    matches,
    queueSweepTargets,
    series,
  }
}

export function resolvePurgeAffectedSet(input: {
  knowledgeRoot: string
  recordId: RecordId
}): PurgeAffectedSet {
  if (!isAbsolute(input.knowledgeRoot)) {
    throw new TypeError('knowledgeRoot must be absolute')
  }
  if (!SAFE_RECORD_ID.test(input.recordId)) {
    throw new TypeError('recordId must be a safe path segment')
  }
  const resolved = resolvePurgeTargets(input.knowledgeRoot, input.recordId)
  return resolved.affectedSet
}

export function purgeAffectedSetFingerprint(affectedSet: PurgeAffectedSet): string {
  return createHash('sha256').update(canonicalJson(affectedSet)).digest('hex')
}

function assertExpectedAffectedSet(
  expectedFingerprint: string | undefined,
  affectedSet: PurgeAffectedSet,
): void {
  if (expectedFingerprint === undefined) return
  const actualFingerprint = purgeAffectedSetFingerprint(affectedSet)
  if (actualFingerprint !== expectedFingerprint) {
    throw new PurgeTargetChangedError(expectedFingerprint, actualFingerprint)
  }
}

function firstCommittedOrdinal(matches: readonly ResolvedBundle[]): number {
  return Math.min(...matches.map(({ bundle }) =>
    bundle.provenance.mode === 'run-linked'
      ? (bundle.provenance.sourceBuildOrdinal ?? bundle.manifest.createdAtOrdinal)
      : bundle.manifest.createdAtOrdinal,
  ))
}

function freshPurgeOrdinal(input: PurgeRecordInput): number {
  if (input.purgedAtOrdinal === undefined) throw new PurgeChronologyRequiredError()
  return input.purgedAtOrdinal
}

function buildReceipt(
  input: PurgeRecordInput,
  matches: readonly ResolvedBundle[],
  occurrenceOrdinal: number,
): PurgeReceipt {
  return PurgeReceiptSchema.parse({
    schemaVersion: PURGE_RECEIPT_SCHEMA_VERSION,
    purgedRecordId: input.recordId,
    purgedAtOrdinal: occurrenceOrdinal,
    initiator: input.initiator,
    affectedPaths: affectedPaths(input.knowledgeRoot, matches),
    firstCommittedOrdinal: firstCommittedOrdinal(matches),
  })
}

/**
 * Publish one complete durable artifact without exposing partial bytes and without ever
 * overwriting an existing audit fact. The hard link is the exclusive atomic visibility step; the
 * temp file is fsynced first and resides in the same directory. Intent and receipt publication
 * share this one pattern.
 */
function writeDurableExclusive(
  finalPath: string,
  text: string,
  beforeMutation?: () => void,
): 'written' | 'already-exists' {
  const directory = dirname(finalPath)
  beforeMutation?.()
  mkdirSync(directory, { recursive: true })
  const temporary = `${finalPath}.tmp-${randomUUID()}`
  try {
    beforeMutation?.()
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
    fsyncFile(temporary)
    fsyncDirectory(directory)
    try {
      beforeMutation?.()
      linkSync(temporary, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'already-exists'
      throw error
    }
    fsyncDirectory(directory)
    return 'written'
  } finally {
    rmSync(temporary, { force: true })
    fsyncDirectory(directory)
  }
}

/** Persist the complete destruction authority as one deterministically sorted intent payload. */
function buildIntent(
  input: PurgeRecordInput,
  receipt: PurgeReceipt,
  receiptCycle: number,
  matches: readonly ResolvedBundle[],
  targets: readonly QueueSweepTarget[],
  affectedSet: PurgeAffectedSet,
): PurgeIntent {
  return PurgeIntentSchema.parse({
    schemaVersion: PURGE_INTENT_SCHEMA_VERSION,
    purgedRecordId: input.recordId,
    receipt,
    receiptCycle,
    bundleDirs: matches
      .map((match) => toReceiptPath(input.knowledgeRoot, match.dir))
      .sort(),
    queueCandidateIds: targets.map((target) => target.candidateId).sort(),
    queuePayloadDirs: targets
      .map((target) => toReceiptPath(input.knowledgeRoot, target.candidateDir))
      .sort(),
    affectedSet: {
      ...affectedSet,
      state: 'resume',
    },
  })
}

/** Remove the fulfilled intent; the durable receipt is now the sole audit fact. */
function retireIntent(input: PurgeRecordInput): void {
  const file = intentPath(input.knowledgeRoot, input.recordId)
  if (!existsSync(file)) return
  fenceWriterAuthority(input)
  rmSync(file, { force: true })
  fsyncDirectory(dirname(file))
}

/** Publish the completion receipt exclusively at its cycle path, then retire the intent. */
function publishReceiptAndRetire(
  input: PurgeRecordInput,
  receiptText: string,
  receipt: PurgeReceipt,
  receiptCycle: number,
): PurgeRecordOutcome {
  input.hooks?.beforeReceiptPublish?.()
  // A `memory/receipts/` linked out of the knowledge root is refused before writing.
  assertWithinKnowledgeRoot(input.knowledgeRoot,
    dirname(receiptCyclePath(input.knowledgeRoot, input.recordId, receiptCycle)))
  const writeOutcome = writeDurableExclusive(
    receiptCyclePath(input.knowledgeRoot, input.recordId, receiptCycle),
    receiptText,
    () => fenceWriterAuthority(input),
  )
  if (writeOutcome === 'already-exists') {
    const racedReceipt = readReceiptAtCycle(input.knowledgeRoot, input.recordId, receiptCycle)
    if (racedReceipt === undefined) {
      throw new Error('purge receipt disappeared during exclusive publication')
    }
    retireIntent(input)
    return { kind: 'already-purged', receipt: racedReceipt }
  }
  retireIntent(input)
  return { kind: 'purged', receipt }
}

/**
 * A crash at or after the intent may leave any prefix of the bundle removals applied. Any
 * surviving intent bundle still carries the record kind for the projection purge; when none
 * survives, bundle removal started, which proves the preceding projection purge committed.
 */
function survivingBundleKind(
  knowledgeRoot: string,
  intent: PurgeIntent,
): LoadedBundle['frontmatter']['kind'] | undefined {
  for (const dir of intent.bundleDirs) {
    const loaded = loadBundle(join(knowledgeRoot, dir))
    if (loaded.kind === 'loaded') return loaded.bundle.frontmatter.kind
  }
  return undefined
}

/**
 * Replay the irreversible phase from the intent's persisted identities only — never a second
 * resolution over destroyed state. Every deletion is idempotent and the receipt publishes
 * byte-identically from the embedded payload at the intent's OWN receiptCycle (never recomputed).
 *
 * A fulfilled intent (its receipt already published; a crash lost only the retirement) resolves
 * here too: the exclusive publish returns already-exists at the exact cycle path, yielding
 * already-purged plus intent retirement. A revival racing into that tiny publish-to-retirement
 * window may be swept by this resume — that sweep is still truthfully receipted, because the
 * content address means the revived bundle occupies the identical paths the intent persisted.
 */
function resumeFromIntent(input: PurgeRecordInput, intent: PurgeIntent): PurgeRecordOutcome {
  fenceWriterAuthority(input)
  purgeIndexSurfaces(
    input.knowledgeRoot,
    input.recordId,
    survivingBundleKind(input.knowledgeRoot, intent),
  )
  input.hooks?.afterProjectionPurge?.()
  for (const dir of intent.bundleDirs) {
    assertWithinKnowledgeRoot(input.knowledgeRoot, join(input.knowledgeRoot, dir))
    fenceWriterAuthority(input)
    rmSync(join(input.knowledgeRoot, dir), { recursive: true, force: true })
    input.hooks?.afterBundleRemoval?.()
  }
  const root = queueRoot(input.knowledgeRoot)
  for (const dir of intent.queuePayloadDirs) {
    const candidateDir = join(input.knowledgeRoot, dir)
    assertWithinKnowledgeRoot(input.knowledgeRoot, candidateDir)
    fenceWriterAuthority(input)
    rmSync(candidateDir, { recursive: true, force: true })
    removeEmptyQueueParents(candidateDir, root, () => fenceWriterAuthority(input))
  }
  for (const candidateId of intent.queueCandidateIds) {
    fenceWriterAuthority(input)
    rmSync(jobStatePath(input.knowledgeRoot, candidateId), { force: true })
  }
  input.hooks?.afterQueueSweep?.()
  verifyPurgeCompletion(input, intent)
  return publishReceiptAndRetire(
    input,
    committedFileText(intent.receipt),
    intent.receipt,
    intent.receiptCycle,
  )
}

// Nothing irreversible precedes the durable intent, so a retry replays to the identical receipt.
export function purgeRecord(input: PurgeRecordInput): PurgeRecordOutcome {
  assertInput(input)

  // Preview and execution share this one resolution. The caller's preview fingerprint is
  // checked before durable intent creation or destructive mutation.
  const resolved = resolvePurgeTargets(input.knowledgeRoot, input.recordId)
  assertExpectedAffectedSet(input.expectedAffectedSetFingerprint, resolved.affectedSet)

  // An existing intent is the standing durable destruction authority — resume it before any
  // fresh work (this also retires fulfilled intents left by a crash after publication).
  if (resolved.intent !== undefined) return resumeFromIntent(input, resolved.intent)

  // Resolve live surfaces BEFORE consulting the receipt series, so every attestation below
  // reflects actually-resolved state, never a stale audit fact.
  const matches = resolved.matches
  const series = resolved.series!
  if (matches.length === 0) {
    // Verified-dead surfaces: attest already-purged carrying the LATEST series receipt, or
    // not-found when no destruction was ever receipted. Nothing mutates on this path.
    return series.latestReceipt === undefined
      ? { kind: 'not-found' }
      : { kind: 'already-purged', receipt: series.latestReceipt }
  }

  // Live surfaces run a fresh destruction cycle REGARDLESS of existing receipts (option a).
  const receiptCycle = series.nextCycle
  const occurrenceOrdinal = freshPurgeOrdinal(input)
  const receipt = buildReceipt(input, matches, occurrenceOrdinal)
  const receiptText = committedFileText(receipt)
  const kind = matches[0]!.bundle.frontmatter.kind

  // The exact queue deletion set came from the same canonical resolution shown to the caller.
  const queueSweepTargets = resolved.queueSweepTargets

  // The intent publication is the last act before the first irreversible mutation.
  const intent = buildIntent(
    input,
    receipt,
    receiptCycle,
    matches,
    queueSweepTargets,
    resolved.affectedSet,
  )
  assertWithinKnowledgeRoot(input.knowledgeRoot, dirname(intentPath(input.knowledgeRoot, input.recordId)))
  const intentOutcome = writeDurableExclusive(
    intentPath(input.knowledgeRoot, input.recordId),
    committedFileText(intent),
    () => fenceWriterAuthority(input),
  )
  if (intentOutcome === 'already-exists') {
    // A concurrent purge published its intent first; that durable authority wins.
    const publishedIntent = readExistingIntent(input.knowledgeRoot, input.recordId)
    if (publishedIntent === undefined) {
      throw new Error('purge intent disappeared during exclusive publication')
    }
    assertExpectedAffectedSet(
      input.expectedAffectedSetFingerprint,
      publishedIntent.affectedSet,
    )
    return resumeFromIntent(input, publishedIntent)
  }
  input.hooks?.afterIntentWritten?.()

  // Projection cleanup must prove every materialized vec table was writable before any
  // irreversible bundle, queue, or receipt mutation can attest success.
  fenceWriterAuthority(input)
  purgeIndexSurfaces(input.knowledgeRoot, input.recordId, kind)
  input.hooks?.afterProjectionPurge?.()

  // Capture metadata above before the only true-delete operation removes the committed tree.
  for (const match of matches) {
    assertWithinKnowledgeRoot(input.knowledgeRoot, match.dir)
    fenceWriterAuthority(input)
    rmSync(match.dir, { recursive: true, force: true })
    input.hooks?.afterBundleRemoval?.()
  }

  sweepQueuePayloads(input, queueSweepTargets)
  input.hooks?.afterQueueSweep?.()

  verifyPurgeCompletion(input, intent)
  return publishReceiptAndRetire(input, receiptText, receipt, receiptCycle)
}
