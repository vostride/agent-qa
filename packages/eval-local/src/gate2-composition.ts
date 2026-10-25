// Staged canary feedback: its reader, its admission into the committed corpus, and the
// committed corpus digest.
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import {
  computeCorpusDigest,
  assignSplit,
  committedFileText,
  deriveRunSlug,
  projectCorpusEntry,
  projectSilverLabelRecord,
  type ExtractedCassette,
  type LeafCassette,
  type SeedingPlan,
} from '@vostride/agent-qa-eval'
import { BENEFITS, distilledScreenStateDigest, slugBranch, type MaskFn } from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { loadCassetteBundle } from './cassette-loader.js'
import { requireCorpusMask, seedCommittedCorpus, type SeedingRefusal, type SeedingBatchReport } from './seeding-composition.js'
import { readCommittedCorpus } from './committed-corpus-source.js'
import { buildRootMarkerValue, COMMITTED_ROOT_MARKER_FILE, committedCassettePath, committedCorpusPath, committedLabelPath, committedBlobPath } from './committed-root-store.js'

export const FEEDBACK_STAGING_SUBDIR = 'eval/feedback'
const feedbackSchema = z.object({
  schemaVersion: z.literal(2), product: z.string().min(1), stateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  attributedObservationId: z.string().min(1), benefit: z.enum(BENEFITS), candidateId: z.string().min(1),
  runId: z.string().min(1), testId: z.string().min(1), stepIndex: z.number().int().nonnegative(),
  stagedAt: z.iso.datetime(),
}).strict()
type FeedbackMetadata = z.infer<typeof feedbackSchema>
export interface StagedFeedbackEntry extends FeedbackMetadata {
  dir: string
  extracted: ExtractedCassette & { cassette: LeafCassette }
}
function feedbackDir(input: { agentQaRoot: string; product: string; stateDigest: string }): string {
  if (!/^[0-9a-f]{64}$/.test(input.stateDigest)) throw new TypeError('invalid feedback state digest')
  return join(realpathSync(input.agentQaRoot), FEEDBACK_STAGING_SUBDIR, slugBranch(input.product), input.stateDigest)
}
function pathPresent(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
/** Refuse links/wrong-kind ancestors rather than following local audit paths out of their root. */
function requireDirectories(path: string): void {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) requireDirectories(parent)
  if (pathPresent(absolute) && !lstatSync(absolute).isDirectory()) throw new TypeError('unsafe feedback directory')
}
function directoryNames(path: string): string[] {
  requireDirectories(path)
  if (!pathPresent(path)) return []
  return readdirSync(path, { withFileTypes: true }).map(entry => {
    if (!entry.isDirectory()) throw new TypeError('unexpected feedback path')
    return entry.name
  }).sort()
}
export function listStagedFeedback(input: { agentQaRoot: string; product?: string }): StagedFeedbackEntry[] {
  if (!pathPresent(input.agentQaRoot)) return []
  const root = join(realpathSync(input.agentQaRoot), FEEDBACK_STAGING_SUBDIR)
  const products = input.product === undefined ? directoryNames(root) : [slugBranch(input.product)]
  const entries: StagedFeedbackEntry[] = []
  for (const productSlug of products) for (const stateDigest of directoryNames(join(root, productSlug))) {
    if (stateDigest.startsWith('.pending-')) continue
    const dir = feedbackDir({ agentQaRoot: input.agentQaRoot, product: productSlug, stateDigest })
    for (const name of ['feedback.json', 'cassette.json']) {
      if (!lstatSync(join(dir, name)).isFile()) throw new TypeError('unsafe feedback file')
    }
    const metadata = feedbackSchema.parse(JSON.parse(readFileSync(join(dir, 'feedback.json'), 'utf8')))
    if (slugBranch(metadata.product) !== productSlug || metadata.stateDigest !== stateDigest
      || (input.product !== undefined && input.product !== metadata.product)) throw new TypeError('feedback path identity mismatch')
    const bundle = loadCassetteBundle(dir)
    if (bundle.kind !== 'loaded' || bundle.cassette.granularity !== 'leaf') throw new TypeError('feedback cassette unavailable')
    const cassette = bundle.cassette
    if (cassette.runId !== metadata.runId || cassette.input.testId !== metadata.testId || cassette.stepIndex !== metadata.stepIndex
      || distilledScreenStateDigest(cassette.input.stateBefore) !== stateDigest) throw new TypeError('feedback provenance mismatch')
    const blobs = directoryNamesForBlobs(join(dir, 'blobs'))
    entries.push({ ...metadata, dir, extracted: { cassette, blobs } })
  }
  return entries
}
function directoryNamesForBlobs(dir: string): ExtractedCassette['blobs'] {
  requireDirectories(dir)
  if (!pathPresent(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).map(entry => {
    if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) throw new TypeError('invalid feedback blob')
    const bytes = readFileSync(join(dir, entry.name))
    if (createHash('sha256').update(bytes).digest('hex') !== entry.name) throw new TypeError('feedback blob mismatch')
    return { sha: entry.name, bytes }
  })
}

export interface AdmitStagedFeedbackResult {
  entries: StagedFeedbackEntry[]
  admitted: StagedFeedbackEntry[]
  refusals: (SeedingRefusal & { product: string; runId: string })[]
  previousCorpusDigest: string
  nextCorpusDigest?: string
  writesStarted: boolean
  failures: {
    phase: 'write' | 'cleanup' | 'final-digest'
    reason: 'seeding-unavailable' | 'staging-cleanup-failed' | 'corpus-unavailable'
    cassetteId?: string
    product?: string
    runId?: string
  }[]
}
export async function admitStagedFeedback(input: {
  agentQaRoot: string; committedRoot: string; product?: string; dryRun: boolean
  /** 441 GAP3-D1: required. A staged case still holding a declared value is refused by the writer. */
  mask: MaskFn
}): Promise<AdmitStagedFeedbackResult> {
  requireCorpusMask(input.mask, 'admitStagedFeedback')
  const previous = readCommittedCorpusDigest(input)
  if (previous.kind !== 'digest') throw new TypeError('feedback corpus unavailable')
  const entries = listStagedFeedback(input)
  const batches = entries.map(entry => {
    const cassette = entry.extracted.cassette
    const plan: SeedingPlan = { product: entry.product, runId: entry.runId, runSlug: deriveRunSlug(entry.runId),
      cases: [{ cassetteId: cassette.id, labelRecord: projectSilverLabelRecord({ cassette, runId: entry.runId }),
        corpusEntry: projectCorpusEntry({ cassette, product: entry.product, runId: entry.runId,
          assignment: assignSplit({ cassetteId: cassette.id, isFeedbackEntry: true }),
          feedback: { attributedObservationId: entry.attributedObservationId, benefit: entry.benefit } }) }],
      pairSkips: [], silverExclusions: [], pairCounts: { total: 0, sameState: 0, differingState: 0 }, proceduresExcludedCount: 0 }
    return { plan, cassettes: [entry.extracted] }
  })
  const result: AdmitStagedFeedbackResult = { entries, admitted: [], refusals: [], previousCorpusDigest: previous.corpusDigest, writesStarted: false, failures: [] }
  if (input.dryRun) return result
  if (entries.length) {
    result.writesStarted = true
    let seeded: SeedingBatchReport | undefined
    try {
      seeded = seedCommittedCorpus({ batches, committedRoot: input.committedRoot, mask: input.mask })
    } catch {
      result.failures.push({ phase: 'write', reason: 'seeding-unavailable' })
    }
    // Even an interrupted bulk writer can have published cases. Verify each case's bytes;
    // neither aggregate counts nor a late exception are evidence of rollback.
    for (const [index, entry] of entries.entries()) {
      const report = seeded?.reports[index]
      result.refusals.push(...(report?.refusals ?? []).map(refusal => ({ ...refusal, product: entry.product, runId: entry.runId })))
      if (report?.refusals.length) continue
      const planCase = batches[index]!.plan.cases[0]!
      const id = entry.extracted.cassette.id
      const textParts = [
        [committedCassettePath(entry.product, id), entry.extracted.cassette],
        [committedCorpusPath(entry.product, id), planCase.corpusEntry],
        [committedLabelPath(entry.product, id), planCase.labelRecord],
      ] as const
      let verified = false
      try {
        verified = textParts.every(([path, value]) => readFileSync(join(input.committedRoot, path), 'utf8') === committedFileText(value))
          && entry.extracted.blobs.every(blob => readFileSync(join(input.committedRoot, committedBlobPath(entry.product, id, blob.sha))).equals(blob.bytes))
      } catch { /* A missing or unreadable part is not admission; retain its staged source. */ }
      if (!verified) {
        result.refusals.push({ cassetteId: id, kind: 'write-conflict', path: committedCorpusPath(entry.product, id), product: entry.product, runId: entry.runId })
        continue
      }
      result.admitted.push(entry)
      try { rmSync(entry.dir, { recursive: true }) } catch {
        result.failures.push({ phase: 'cleanup', reason: 'staging-cleanup-failed',
          cassetteId: id, product: entry.product, runId: entry.runId })
      }
    }
  }
  try {
    const next = readCommittedCorpusDigest(input)
    if (next.kind !== 'digest') throw new TypeError('feedback corpus unavailable')
    result.nextCorpusDigest = next.corpusDigest
  } catch {
    result.failures.push({ phase: 'final-digest', reason: 'corpus-unavailable' })
  }
  return result
}

export type CommittedCorpusDigestRead =
  | { kind: 'digest'; corpusDigest: string }
  | { kind: 'unavailable'; reason: 'corpus-unreadable'; detail: string }
function readDigestSnapshot(committedRoot: string) {
  const corpus = readCommittedCorpus(committedRoot)
  // The general census reader accepts an absent tree as empty data. A digest citation must
  // establish the root itself, or a broken host could mint an empty digest.
  try {
    const marker = JSON.parse(readFileSync(join(committedRoot, COMMITTED_ROOT_MARKER_FILE), 'utf8'))
    if (marker?.schemaVersion !== buildRootMarkerValue().schemaVersion) {
      throw new Error('invalid eval root marker schemaVersion')
    }
  } catch (error) {
    return { corpus, result: { kind: 'unavailable', reason: 'corpus-unreadable',
      detail: error instanceof Error ? error.message : String(error),
    } as const }
  }
  const result: CommittedCorpusDigestRead =
    corpus.refusals.length > 0
      ? {
          kind: 'unavailable',
          reason: 'corpus-unreadable',
          detail: corpus.refusals.map((row) => `${row.path}: ${row.reason}`).join('\n'),
        }
      : { kind: 'digest', corpusDigest: computeCorpusDigest(corpus.snapshot.entries) }
  return { corpus, result }
}

/** The same committed corpus definition the posture resolver cites, including negatives. */
export function readCommittedCorpusDigest(input: {
  committedRoot: string
}): CommittedCorpusDigestRead {
  return readDigestSnapshot(input.committedRoot).result
}
