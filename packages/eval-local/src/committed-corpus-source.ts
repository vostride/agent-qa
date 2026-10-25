// The committed-root READ leg (413 D-14/D-08, RESEARCH F6) — the inverse of seedCommittedCorpus.
//
// Composition law (the eval-local ownership rule): every eval filesystem read lives here and the
// derivation lives in eval core. This module loads corpus entries, label records, cassette
// bundles and local blob presence off disk and hands eval core the CommittedCorpusSnapshot its
// pure census folds. It computes nothing.
//
// Refusal posture (mirrors cassette-loader.ts): a committed root is a cross-machine,
// hand-editable, git-tracked document, so NO content failure throws. An unreadable file,
// unparseable JSON, or a guard rejection becomes a typed refusal row and the surrounding read
// survives; an absent root is an empty snapshot with a notice, never an error. Blob presence is
// reported rather than required — `**/blobs/` is gitignored, so a freshly cloned root legitimately
// carries zero blobs (F6) and the census prints `blobs present locally: n/N`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

import {
  activeMarkedCorpusEntries,
  BASELINE_POINTER_SCHEMA_VERSION,
  guardDecisionVectorsDocument,
  guardNoiseFloorArtefact,
  parseCorpusEntry,
  parseStandaloneLabelRecord,
  selectEffectiveLabels,
  partitionManifestSchema,
  runExclusionRecordSchema,
} from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import type {
  CommittedCorpusSnapshot,
  CorpusEntry,
  DecisionVectorsDocument,
  EvalBatchReport,
  LeafCassette,
  NoiseFloorArtefact,
  PartitionManifest,
  RunExclusionRecord,
  StandaloneLabelRecord,
} from '@vostride/agent-qa-eval'
import { z } from 'zod'

import { loadCassetteBundle } from './cassette-loader.js'
import { BLOBS_SUBDIR } from './cassette-store.js'
import {
  COMMITTED_CASSETTES_DIR,
  COMMITTED_CONTRACTS_DIR,
  COMMITTED_CORPUS_DIR,
  COMMITTED_EXCLUSIONS_DIR,
  COMMITTED_LABELS_DIR,
  COMMITTED_NOISE_FLOOR_SUBDIR,
  COMMITTED_REPORTS_DIR,
  PARTITION_MANIFEST_FILE_PREFIX,
  committedPartitionManifestPath,
  committedLabelPath,
  committedReportPath,
} from './committed-root-store.js'
import { listCassetteBundleDirs } from './replay-read.js'
import { readLabelCalibration, type LabelCalibrationRead } from './calibration-source.js'
import { reportMetadataKind } from './report-metadata-guard.js'
import { reportJudgeSchema } from './report-store.js'

/** Gate-side effective view; raw committed history and the proposer reader remain unchanged. */
export function readActiveCommittedCorpus(committedRoot: string, _agentQaRoot: string, calibrationRead?: LabelCalibrationRead): CommittedCorpusRead {
  const read = readCommittedCorpus(committedRoot, calibrationRead)
  const entries = activeMarkedCorpusEntries(read.snapshot, [])
  const activeIds = new Set(entries.map(entry => entry.cassetteId))
  return { ...read, snapshot: { ...read.snapshot, entries },
    retiredMarkedCassetteIds: new Set(read.snapshot.entries.filter(entry => !activeIds.has(entry.cassetteId)).map(entry => entry.cassetteId)),
    notices: [...read.notices, ...(entries.length === read.snapshot.entries.length ? []
      : [`${read.snapshot.entries.length - entries.length} historical or incomplete marked cases excluded`])] }
}

/** Census, baseline pointers and per-profile floors are not batch reports (415 D-04). */
const RESERVED_REPORT_DIRS = new Set(['census', 'baselines', 'noise-floor', 'judge-calibration'])

const reportSchema = z
  .object({
    batchKey: z.string(),
    matcherVersion: z.number(),
    judgeIdentity: z.literal('mixed').optional(),
    mixedJudgeModelIds: z.array(z.string()).optional(),
    headline: z
      .object({ perDecisionCost: z.object({ decisionCount: z.number() }).passthrough() })
      .passthrough(),
    honesty: z
      .object({
        unscorableIdentityCounts: z.record(z.string(), z.number()),
        refusalCounts: z.record(z.string(), z.number()),
      })
      .passthrough(),
    judge: reportJudgeSchema.optional(),
  })
  .passthrough().refine(report => report.judgeIdentity !== 'mixed' || report.judge === undefined)

const baselinePointerSchema = z
  .object({
    schemaVersion: z.literal(BASELINE_POINTER_SCHEMA_VERSION),
    profileKey: z.string(),
    batchKey: z.string(),
    fingerprint: z.string(),
    corpusDigest: z.string(),
  })
  .passthrough()

/** One unreadable or unadmittable committed file, attributable by path (D-08). */
export interface CommittedReadRefusal {
  path: string
  reason: string
}

/** The loaded committed root: eval core's snapshot plus everything the read learned about it. */
export interface CommittedCorpusRead {
  /** Guarded ownership including scoring-excluded history, for incurred-cost reports. */
  corpusEntriesById?: ReadonlyMap<string, CorpusEntry>
  calibration?: EvalBatchReport['calibration']
  retiredMarkedCassetteIds?: ReadonlySet<string>
  snapshot: CommittedCorpusSnapshot
  productsSeen: readonly string[]
  notices: string[]
  refusals: readonly CommittedReadRefusal[]
  /**
   * How many committed files declared each schemaVersion, keyed by the declared version as a
   * string. An absent version key means zero files declared it.
   */
  schemaVersionsSeen: Record<string, number>
}

/** Every committed partition manifest under contracts/, and what the read refused (D-05). */
export interface PartitionManifestRead {
  manifests: readonly PartitionManifest[]
  notices: string[]
  refusals: readonly CommittedReadRefusal[]
}

/** Every committed run-exclusion record under exclusions/, and what the read refused (D-02). */
export interface RunExclusionRead {
  exclusions: readonly RunExclusionRecord[]
  refusals: readonly CommittedReadRefusal[]
}

/** One committed batch report keyed by its own dir name. */
export interface CommittedReportEntry {
  batchKey: string
  report: EvalBatchReport
  path: string
}

/** One committed per-profile baseline designation (D-19). */
export interface BaselinePointerEntry {
  schemaVersion: typeof BASELINE_POINTER_SCHEMA_VERSION
  profileKey: string
  batchKey: string
  fingerprint: string
  corpusDigest: string
  path: string
}

export interface NoiseFloorArtefactEntry {
  profileKey: string
  artefact: NoiseFloorArtefact
  path: string
}

export type CommittedDecisionVectorsLoad =
  | { kind: 'loaded'; document: DecisionVectorsDocument; path: string }
  | { kind: 'absent'; path: string }
  | { kind: 'refused'; refusal: CommittedReadRefusal }

export type ResolveMinimumGateSetOutcome =
  | { kind: 'resolved'; minimumGateSet: number; path: string }
  | { kind: 'no-floor' }
  | { kind: 'no-value'; path: string }

/** Read only the per-profile files; the former literal reports/noise-floor.json is invalid. */
export function listNoiseFloorArtefacts(committedRoot: string): {
  artefacts: NoiseFloorArtefactEntry[]
  refusals: CommittedReadRefusal[]
} {
  const reportsRoot = join(committedRoot, COMMITTED_REPORTS_DIR)
  const floorRoot = join(reportsRoot, COMMITTED_NOISE_FLOOR_SUBDIR)
  const artefacts: NoiseFloorArtefactEntry[] = []
  const refusals: CommittedReadRefusal[] = []
  const strayPath = join(reportsRoot, 'noise-floor.json')
  if (existsSync(strayPath)) {
    refusals.push({ path: strayPath, reason: 'noise floor must live under reports/noise-floor/<profile-key>.json' })
  }
  let entries: Dirent[]
  try {
    entries = readdirSync(floorRoot, { withFileTypes: true })
  } catch {
    return { artefacts, refusals }
  }
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(floorRoot, entry.name)
    const read = readJson(path)
    if (!read.ok) {
      refusals.push({ path, reason: read.reason })
      continue
    }
    const guarded = guardNoiseFloorArtefact(read.value)
    if (guarded.kind === 'rejected') {
      refusals.push({ path, reason: `noise floor rejected: ${guarded.reason}` })
      continue
    }
    artefacts.push({ profileKey: guarded.artefact.profileKey, artefact: guarded.artefact, path })
  }
  artefacts.sort((a, b) => a.profileKey < b.profileKey ? -1 : a.profileKey > b.profileKey ? 1 : 0)
  return { artefacts, refusals }
}

export function readCommittedDecisionVectors(
  committedRoot: string,
  batchKey: string,
): CommittedDecisionVectorsLoad {
  const path = join(committedRoot, committedReportPath(batchKey, 'decisions.json'))
  if (!existsSync(path)) return { kind: 'absent', path }
  const read = readJson(path)
  if (!read.ok) return { kind: 'refused', refusal: { path, reason: read.reason } }
  const guarded = guardDecisionVectorsDocument(read.value)
  if (guarded.kind === 'rejected') {
    return { kind: 'refused', refusal: { path, reason: `decisions rejected: ${guarded.reason}` } }
  }
  if (guarded.document.batchKey !== batchKey) {
    return { kind: 'refused', refusal: { path, reason: 'decisions batchKey does not match the requested batchKey' } }
  }
  return { kind: 'loaded', document: guarded.document, path }
}

/** 414 D-15 → 417 handoff: resolve the measured integer without changing the pure posture port. */
export function resolveMinimumGateSet(input: {
  committedRoot: string
  profileKey: string
}): ResolveMinimumGateSetOutcome {
  const entry = listNoiseFloorArtefacts(input.committedRoot).artefacts.find(
    candidate => candidate.profileKey === input.profileKey,
  )
  if (entry === undefined) return { kind: 'no-floor' }
  const minimumGateSet = entry.artefact.minimumGateSet.value
  if (minimumGateSet === undefined) return { kind: 'no-value', path: entry.path }
  return { kind: 'resolved', minimumGateSet, path: entry.path }
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Every `*.json` file under dir at any depth, sorted; ENOENT is an empty list. */
function listJsonFiles(dir: string): string[] {
  const found: string[] = []

  function walk(current: string): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path)
    }
  }

  walk(dir)
  return found.sort()
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, reason: `unreadable: ${(error as NodeJS.ErrnoException).message}` }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${(error as Error).message}` }
  }
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ')
}

/** Every `*.json` file directly under dir (no recursion), sorted; ENOENT is an empty list. */
function listJsonFilesShallow(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function bumpCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1
}

/** A blobs/ dir counts as present only when it exists AND holds at least one file (F6). */
function blobsPresent(bundleDir: string): boolean {
  const blobsDir = join(bundleDir, BLOBS_SUBDIR)
  if (!existsSync(blobsDir)) return false
  try {
    return readdirSync(blobsDir).length > 0
  } catch {
    return false
  }
}

/**
 * Load the committed root at `committedRoot` into the snapshot eval core's `deriveCensus` folds.
 * Never throws for content: every parse or guard failure lands in `refusals`, and a missing root
 * yields an empty snapshot with a notice naming it.
 */
export function readCommittedCorpus(committedRoot: string, calibrationRead?: LabelCalibrationRead): CommittedCorpusRead {
  const notices: string[] = []
  const refusals: CommittedReadRefusal[] = []
  const entries: CorpusEntry[] = []
  const schemaVersionsSeen: Record<string, number> = {}
  const labelsById = new Map<string, StandaloneLabelRecord>()
  const labelHistory: unknown[] = []
  const excludedLabelIds = new Set<string>()
  const cassettesById = new Map<string, LeafCassette>()
  const blobPresentById = new Map<string, boolean>()

  if (!existsSync(committedRoot)) {
    notices.push(`committed root absent: ${committedRoot}`)
    return {
      snapshot: { entries, labelsById, cassettesById, blobPresentById, labelHistory, excludedLabelIds },
      productsSeen: [],
      notices,
      refusals,
      schemaVersionsSeen,
    }
  }

  const corpusRoot = join(committedRoot, COMMITTED_CORPUS_DIR)
  const productsSeen = listDirNames(corpusRoot)

  for (const product of productsSeen) {
    for (const path of listJsonFiles(join(corpusRoot, product))) {
      const read = readJson(path)
      if (!read.ok) {
        refusals.push({ path, reason: read.reason })
        continue
      }
      // The one guard in eval core, not a second zod shape here.
      const parsed = parseCorpusEntry(read.value)
      if (!parsed.ok) {
        refusals.push({ path, reason: `corpus entry rejected: ${parsed.issues}` })
        continue
      }
      if (parsed.entry.product !== product) {
        notices.push(
          `corpus dir '${product}' holds an entry declaring product '${parsed.entry.product}' (${parsed.entry.cassetteId}); the entry field is authoritative`,
        )
      }
      entries.push(parsed.entry)
      bumpCounter(schemaVersionsSeen, String(parsed.schemaVersion))
    }
  }

  const labelsRoot = join(committedRoot, COMMITTED_LABELS_DIR)
  const labelOwners = new Map<string, Set<string>>()
  const idsByBasePath = new Map<string, Set<string>>()
  for (const entry of entries) {
    const owners = labelOwners.get(entry.cassetteId) ?? new Set<string>()
    owners.add(slugBranch(entry.product))
    labelOwners.set(entry.cassetteId, owners)
    const path = join(committedRoot, committedLabelPath(entry.product, entry.cassetteId))
    const ids = idsByBasePath.get(path) ?? new Set<string>()
    ids.add(entry.cassetteId)
    idsByBasePath.set(path, ids)
  }
  const readInvalidIds = new Set<string>()
  const validHistory: StandaloneLabelRecord[] = []
  for (const product of listDirNames(labelsRoot)) {
    for (const path of listJsonFiles(join(labelsRoot, product))) {
      const basePath = path.replace(/--revision-[^/]*\.json$/, '.json')
      const pathIds = idsByBasePath.get(basePath) ?? new Set<string>()
      const refuse = (reason: string, cassetteId?: string) => {
        refusals.push({ path, reason })
        for (const id of pathIds) readInvalidIds.add(id)
        if (cassetteId !== undefined) readInvalidIds.add(cassetteId)
      }
      const read = readJson(path)
      if (!read.ok) {
        refuse('label record unreadable or invalid JSON')
        continue
      }
      labelHistory.push(read.value)
      const parsed = parseStandaloneLabelRecord(read.value)
      if (!parsed.ok) {
        const claimedId = typeof read.value === 'object' && read.value !== null && 'cassetteId' in read.value && typeof read.value.cassetteId === 'string' ? read.value.cassetteId : undefined
        refuse(`label record rejected: ${parsed.issues}`, claimedId)
        continue
      }
      const record = parsed.record
      const expectedBase = join(committedRoot, committedLabelPath(product, record.cassetteId))
      const expectedPath = record.revision === undefined ? expectedBase
        : expectedBase.replace(/\.json$/, `--revision-${record.revision.id}.json`)
      const owners = labelOwners.get(record.cassetteId)
      if (path !== expectedPath || (owners !== undefined && (owners.size !== 1 || !owners.has(product)))) {
        refuse('label path or product ownership mismatch', record.cassetteId)
        continue
      }
      validHistory.push(record)
    }
  }
  // Generation-bearing refreshes stay invisible until the guarded publication loader
  // explicitly authorizes their marker. Seed/base revisions require no marker.
  const calibration = calibrationRead ?? readLabelCalibration(committedRoot)
  const authorized = calibration.kind === 'loaded' ? calibration.authorizedRevisionIds : new Set<string>()
  const eligibleHistory = validHistory.filter(record => record.revision?.generationId === undefined || authorized.has(record.revision.id))
  const generations = new Set(eligibleHistory.flatMap(record => record.revision?.generationId ? [record.revision.generationId] : []))
  if (calibration.kind === 'refused') {
    refusals.push({ path: join(labelsRoot, 'calibration.json'), reason: calibration.reason })
    for (const id of calibration.targetCassetteIds ?? []) readInvalidIds.add(id)
    for (const record of validHistory) if (record.revision?.generationId) readInvalidIds.add(record.cassetteId)
  }
  const selected = selectEffectiveLabels(eligibleHistory, { committedGenerationIds: generations })
  for (const [id, label] of selected.effective) {
    if (!readInvalidIds.has(id)) labelsById.set(id, label)
  }
  for (const id of [...readInvalidIds, ...selected.excludedLabelIds]) excludedLabelIds.add(id)
  for (const refusal of selected.refusals) {
    refusals.push({ path: labelsRoot, reason: `label history rejected: ${refusal.reason}` })
  }

  for (const bundleDir of listCassetteBundleDirs(join(committedRoot, COMMITTED_CASSETTES_DIR))) {
    const load = loadCassetteBundle(bundleDir)
    if (load.kind === 'refused') {
      refusals.push({
        path: join(bundleDir, 'cassette.json'),
        reason: `${load.refusal.reason}: ${load.refusal.detail}`,
      })
      continue
    }
    if (load.cassette.granularity !== 'leaf') {
      notices.push(`skipped non-leaf cassette bundle: ${bundleDir}`)
      continue
    }
    cassettesById.set(load.cassette.id, load.cassette)
    blobPresentById.set(load.cassette.id, blobsPresent(bundleDir))
  }

  entries.sort((first, second) =>
    first.cassetteId < second.cassetteId ? -1 : first.cassetteId > second.cassetteId ? 1 : 0,
  )

  return {
    corpusEntriesById: new Map(entries.map(entry => [entry.cassetteId, entry])),
    calibration: calibration.kind === 'loaded' ? {
      status: calibration.artifact.channels['recorded-verdict'].status,
      n_gold: calibration.artifact.channels['recorded-verdict'].n_gold,
      verifierFalsePassRate: calibration.artifact.verifierFalsePassRate,
    } : { status: 'uncalibrated' },
    snapshot: { entries: entries.filter(entry => !excludedLabelIds.has(entry.cassetteId)),
      labelsById, cassettesById, blobPresentById, labelHistory, excludedLabelIds },
    productsSeen,
    notices,
    refusals,
    schemaVersionsSeen,
  }
}

/**
 * Load every committed partition manifest under `contracts/` (414 D-05).
 *
 * Manifests are found by file-name prefix, not by parsing every contract: the dir also holds the
 * D-04 matcher and judge constitution projections, and asking the manifest guard about those would
 * manufacture refusals for documents that are not manifests. An absent `contracts/` is an empty
 * list with no refusal — a root that has never been partitioned is a legitimate root.
 */
export function readPartitionManifests(committedRoot: string): PartitionManifestRead {
  const contractsRoot = join(committedRoot, COMMITTED_CONTRACTS_DIR)
  const manifests: PartitionManifest[] = []
  const notices: string[] = []
  const refusals: CommittedReadRefusal[] = []

  for (const name of listJsonFilesShallow(contractsRoot)) {
    if (!name.startsWith(PARTITION_MANIFEST_FILE_PREFIX)) continue
    const path = join(contractsRoot, name)
    const read = readJson(path)
    if (!read.ok) {
      refusals.push({ path, reason: read.reason })
      continue
    }
    const parsed = partitionManifestSchema.safeParse(read.value)
    if (!parsed.success) {
      refusals.push({ path, reason: `partition manifest rejected: ${issueText(parsed.error)}` })
      continue
    }
    const expected = committedPartitionManifestPath(parsed.data.product)
    if (expected !== `${COMMITTED_CONTRACTS_DIR}/${name}`) {
      notices.push(
        `partition manifest '${name}' declares product '${parsed.data.product}', whose committed path is '${expected}'; the manifest field is authoritative`,
      )
    }
    manifests.push(parsed.data)
  }

  manifests.sort((first, second) =>
    first.product < second.product ? -1 : first.product > second.product ? 1 : 0,
  )
  return { manifests, notices, refusals }
}

/**
 * Load every committed run-exclusion record under `exclusions/<product>/` (414 D-02).
 *
 * Same posture as the corpus walk: a committed root is hand-editable, so an unparseable or
 * unadmittable record is a refusal row naming its path, never a throw. An absent `exclusions/`
 * dir is an empty list with no refusal — a root with nothing excluded is the common case.
 */
export function readRunExclusions(committedRoot: string): RunExclusionRead {
  const exclusionsRoot = join(committedRoot, COMMITTED_EXCLUSIONS_DIR)
  const exclusions: RunExclusionRecord[] = []
  const refusals: CommittedReadRefusal[] = []

  for (const product of listDirNames(exclusionsRoot)) {
    for (const path of listJsonFiles(join(exclusionsRoot, product))) {
      const read = readJson(path)
      if (!read.ok) {
        refusals.push({ path, reason: read.reason })
        continue
      }
      const parsed = runExclusionRecordSchema.safeParse(read.value)
      if (!parsed.success) {
        refusals.push({ path, reason: `run exclusion rejected: ${issueText(parsed.error)}` })
        continue
      }
      exclusions.push(parsed.data)
    }
  }

  return { exclusions, refusals }
}

/**
 * List every committed batch report under `reports/`, one per batchKey dir. The reserved `census/`
 * and `baselines/`, `noise-floor/`, `judge-calibration/` dirs are not batch reports.
 */
export function listCommittedReports(committedRoot: string): {
  reports: CommittedReportEntry[]
  refusals: CommittedReadRefusal[]
} {
  const reportsRoot = join(committedRoot, COMMITTED_REPORTS_DIR)
  const reports: CommittedReportEntry[] = []
  const refusals: CommittedReadRefusal[] = []

  for (const name of listDirNames(reportsRoot)) {
    if (RESERVED_REPORT_DIRS.has(name)) continue
    const path = join(reportsRoot, name, 'report.json')
    if (!existsSync(path)) {
      refusals.push({ path, reason: 'report.json absent' })
      continue
    }
    const read = readJson(path)
    if (!read.ok) {
      refusals.push({ path, reason: read.reason })
      continue
    }
    const parsed = reportSchema.safeParse(read.value)
    if (!parsed.success) {
      refusals.push({ path, reason: `report rejected: ${issueText(parsed.error)}` })
      continue
    }
    if (reportMetadataKind(read.value) === 'invalid') {
      refusals.push({ path, reason: 'report label metadata incomplete or malformed' })
      continue
    }
    reports.push({ batchKey: name, report: parsed.data as unknown as EvalBatchReport, path })
  }

  reports.sort((first, second) =>
    first.batchKey < second.batchKey ? -1 : first.batchKey > second.batchKey ? 1 : 0,
  )
  return { reports, refusals }
}

/** List every committed per-profile baseline pointer under `reports/baselines/`, sorted (D-19). */
export function listBaselinePointers(committedRoot: string): {
  pointers: BaselinePointerEntry[]
  refusals: CommittedReadRefusal[]
} {
  const baselinesRoot = join(committedRoot, COMMITTED_REPORTS_DIR, 'baselines')
  const pointers: BaselinePointerEntry[] = []
  const refusals: CommittedReadRefusal[] = []

  let names: string[]
  try {
    names = readdirSync(baselinesRoot).sort()
  } catch {
    return { pointers, refusals }
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(baselinesRoot, name)
    if (!statSync(path).isFile()) continue
    const read = readJson(path)
    if (!read.ok) {
      refusals.push({ path, reason: read.reason })
      continue
    }
    const parsed = baselinePointerSchema.safeParse(read.value)
    if (!parsed.success) {
      refusals.push({ path, reason: `baseline pointer rejected: ${issueText(parsed.error)}` })
      continue
    }
    pointers.push({
      schemaVersion: parsed.data.schemaVersion,
      profileKey: parsed.data.profileKey,
      batchKey: parsed.data.batchKey,
      fingerprint: parsed.data.fingerprint,
      corpusDigest: parsed.data.corpusDigest,
      path,
    })
  }

  pointers.sort((first, second) =>
    first.profileKey < second.profileKey ? -1 : first.profileKey > second.profileKey ? 1 : 0,
  )
  return { pointers, refusals }
}
