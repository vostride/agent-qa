// 2026-09-07, 418 D-02: the ablation composition. The live decision becomes sample one
// only here; every fresh model call delegates to runCassetteReplay's safety scope.
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  applyBriefDelta,
  buildEvalReport,
  computeCorpusDigest,
  computeDecisionIdentity,
  deriveSampleSeeds,
  assignSplit,
  committedFileText,
  deriveRunSlug,
  extractRunCassettes,
  maskCorpusText,
  projectCorpusEntry,
  projectSilverLabelRecord,
  resolveProductPartition,
  type ExtractedCassette,
  type LeafCassette,
  type SeedingPlan,
  type ReplaySample,
} from '@vostride/agent-qa-eval'
import { BENEFITS, distilledScreenStateDigest, slugBranch, type Benefit, type CrossCheck, type MaskFn } from '@vostride/agent-qa-schema'
import { z } from 'zod'
import { loadCompletedRunHandoff, RUNS_SUBDIR, HANDOFF_FILE } from '@vostride/agent-qa-runner-local'
import { FsRunArtifactSource } from './artifact-source.js'
import { loadCassetteBundle } from './cassette-loader.js'
import { loadCassetteBundles } from './replay-sweep.js'
import { cassetteProductPartition } from './replay-batch-assembly.js'
import { requireCorpusMask, seedCommittedCorpus, type SeedingRefusal, type SeedingBatchReport } from './seeding-composition.js'
import { readCommittedCorpus } from './committed-corpus-source.js'
import {
  locateTargetCassettes,
  removalFlipsOutcome,
  resolveActiveRecordRemoval,
  type ReplayBag,
} from './replay-gate-composition.js'
import { runCassetteReplay } from './replay-composition.js'
import { FsReplayRecordStore } from './replay-record-store.js'
import { FsScoreStore } from './score-store.js'
import { loadScoreRecord } from './replay-read.js'
import { buildRootMarkerValue, COMMITTED_ROOT_MARKER_FILE, committedCassettePath, committedCorpusPath, committedLabelPath, committedBlobPath } from './committed-root-store.js'

export const GATE2_AUDIT_SUBDIR = 'eval/gate2'
export const GATE2_TARGET_SUBDIR = 'target'

// 2026-09-08, 418 D-21: staging is local audit DATA. Only explicit admission calls the seeder.
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
export interface FeedbackStateInput {
  agentQaRoot: string
  committedRoot: string
  product: string
  stateDigest: string
}
export interface StageFeedbackEntryInput extends FeedbackStateInput {
  target: { runId: string; testId: string; stepIndex: number }
  attributedObservationId: string
  benefit: Benefit
  candidateId: string
  /** 441 GAP3-D1: required. The staged cassette is extracted from the masked run. */
  mask: MaskFn
}
export type StageFeedbackEntryResult =
  | { kind: 'staged'; dir: string }
  | { kind: 'already-staged' | 'not-novel' }
  | { kind: 'target-unavailable' | 'write-conflict' }

function feedbackDir(input: Omit<FeedbackStateInput, 'committedRoot'>): string {
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
export function isNovelState(input: FeedbackStateInput): boolean {
  const dir = feedbackDir(input)
  requireDirectories(dirname(dir))
  if (pathPresent(dir)) return false
  const { corpus, result } = readDigestSnapshot(input.committedRoot)
  if (result.kind !== 'digest') throw new TypeError('feedback corpus unavailable')
  const bundles = loadCassetteBundles(join(input.committedRoot, 'cassettes'))
  if (Object.keys(bundles.loadRefusals).length > 0) throw new TypeError('feedback cassette unavailable')
  const productIds = new Set(corpus.snapshot.entries.filter(entry => entry.product === input.product).map(entry => entry.cassetteId))
  return !bundles.loaded.some(({ cassette }) => cassette.granularity === 'leaf'
    && (productIds.has(cassette.id) || cassetteProductPartition(cassette) === input.product)
    && distilledScreenStateDigest(cassette.input.stateBefore) === input.stateDigest)
}

export async function stageFeedbackEntry(input: StageFeedbackEntryInput): Promise<StageFeedbackEntryResult> {
  requireCorpusMask(input.mask, 'stageFeedbackEntry')
  let temporary: string | undefined
  try {
    const dir = feedbackDir(input)
    requireDirectories(dirname(dir))
    if (pathPresent(dir)) return { kind: 'already-staged' }
    if (!isNovelState(input)) return { kind: 'not-novel' }
    // Reuse the same pure extraction as Gate2, in memory; the old locator's write leg would
    // publish outside this staging directory.
    const handoff = loadCompletedRunHandoff(join(input.agentQaRoot, RUNS_SUBDIR, slugBranch(input.target.runId), HANDOFF_FILE))
    if (handoff.runId !== input.target.runId || resolveProductPartition(handoff.scope) !== input.product
      || handoff.tests.find(test => test.testId === input.target.testId)?.isRerun === true) return { kind: 'target-unavailable' }
    // 441 GAP3-D1: extract from the masked run. The digest comparisons below stay as they are, so a
    // target whose route or element names hold a declared value answers target-unavailable.
    const extraction = extractRunCassettes({ handoff: maskCorpusText(handoff, input.mask),
      artifacts: new FsRunArtifactSource({ root: input.agentQaRoot, runId: handoff.runId }) })
    const matches = extraction.cassettes.filter((entry): entry is ExtractedCassette & { cassette: LeafCassette } =>
      entry.cassette.granularity === 'leaf' && entry.cassette.runId === input.target.runId
      && entry.cassette.input.testId === input.target.testId && entry.cassette.stepIndex === input.target.stepIndex)
    if (matches.length !== 1) return { kind: 'target-unavailable' }
    const extracted = matches[0]!
    if (distilledScreenStateDigest(extracted.cassette.input.stateBefore) !== input.stateDigest) return { kind: 'target-unavailable' }
    const metadata = feedbackSchema.parse({ schemaVersion: 2, product: input.product, stateDigest: input.stateDigest,
      attributedObservationId: input.attributedObservationId, benefit: input.benefit, candidateId: input.candidateId,
      ...input.target, stagedAt: new Date().toISOString() })
    const texts = [committedFileText(extracted.cassette), committedFileText(metadata)]
    for (const blob of extracted.blobs) {
      if (!/^[0-9a-f]{64}$/.test(blob.sha) || createHash('sha256').update(blob.bytes).digest('hex') !== blob.sha) return { kind: 'target-unavailable' }
    }
    mkdirSync(dirname(dir), { recursive: true })
    temporary = mkdtempSync(join(dirname(dir), '.pending-'))
    writeFileSync(join(temporary, 'cassette.json'), texts[0]!, { flag: 'wx' })
    writeFileSync(join(temporary, 'feedback.json'), texts[1]!, { flag: 'wx' })
    if (extracted.blobs.length) mkdirSync(join(temporary, 'blobs'))
    for (const blob of extracted.blobs) writeFileSync(join(temporary, 'blobs', blob.sha), blob.bytes, { flag: 'wx' })
    // Rename only a fully validated bundle. Existing published bundles are nonempty and
    // cannot be replaced by rename; a competitor is reported without a successful stage count.
    if (pathPresent(dir)) return { kind: 'already-staged' }
    renameSync(temporary, dir)
    temporary = undefined
    return { kind: 'staged', dir }
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return { kind: 'write-conflict' }
    return { kind: 'target-unavailable' }
  } finally {
    if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true })
  }
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

export interface AblateCanaryStepInput {
  agentQaRoot: string
  committedRoot: string
  recordId: string
  target: { runId: string; testId: string; stepIndex: number }
  /** The gate-2 audit sub-tree this ablation writes under. Slugged before it becomes a path. */
  attributedObservationId: string
  k: number
  baseSeed: number
  replay: ReplayBag
  /** Which removal rule authorizes this ablation; absent keeps the opt-in served-canary flag. */
  admission?: {
    servedCanary?: true
  }
}
export type CommittedCorpusDigestRead =
  | { kind: 'digest'; corpusDigest: string }
  | { kind: 'unavailable'; reason: 'corpus-unreadable'; detail: string }
export type AblateCanaryStepResult =
  | {
      kind: 'ablated'
      crossCheck: CrossCheck
      corpusDigest: string
      k: number
      baseSeed: number
      seeds: number[]
      seedHonored: boolean
      spend: { modelCalls: number; screens: number; promptTokens: number; completionTokens: number }
      gate2Dir: string
      notices: string[]
    }
  | {
      kind: 'unavailable'
      reason: 'target-unavailable' | 'brief-line-not-found' | 'no-live-decision' | 'corpus-unreadable'
      detail: string
    }

function readDigestSnapshot(committedRoot: string) {
  const corpus = readCommittedCorpus(committedRoot)
  // 418 D-08: the general census reader accepts an absent tree as empty data. A gate
  // citation must establish the root itself, or a broken host could mint an empty digest.
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

/** D-07: the same committed corpus definition the posture resolver cites, including negatives. */
export function readCommittedCorpusDigest(input: {
  committedRoot: string
}): CommittedCorpusDigestRead {
  return readDigestSnapshot(input.committedRoot).result
}

export async function ablateCanaryStep(
  input: AblateCanaryStepInput,
): Promise<AblateCanaryStepResult> {
  // Validate before extraction or spend, using the canonical odd-k contract.
  deriveSampleSeeds(input.baseSeed, input.k)
  // One resolution, shared by sample one and by every subsequent sample (418 D-02): a second
  // spelling here would let the first arm admit a removal the rest of the cross-check refuses.
  const admission = input.admission ?? { servedCanary: true as const }
  const gate2Dir = join(
    input.agentQaRoot,
    GATE2_AUDIT_SUBDIR,
    slugBranch(input.attributedObservationId),
  )
  const { corpus, result: digest } = readDigestSnapshot(input.committedRoot)
  if (digest.kind === 'unavailable') return digest
  const located = await locateTargetCassettes({
    committedRoot: input.committedRoot,
    agentQaRoot: input.agentQaRoot,
    gate1Dir: gate2Dir,
    corpusEntries: corpus.snapshot.entries,
    target: input.target,
    source: 'handoff',
  })
  if (located.kind === 'unavailable')
    return {
      kind: 'unavailable',
      reason:
        located.detail.reason === 'no live decision at target'
          ? 'no-live-decision'
          : 'target-unavailable',
      detail: JSON.stringify(located.detail),
    }
  // The input identifies a step, not a sub-action. Never guess which decision earned credit.
  if (located.cassettes.length !== 1)
    return {
      kind: 'unavailable',
      reason: 'target-unavailable',
      detail: 'ambiguous live step: multiple recorded decisions',
    }
  const target = located.cassettes[0]!
  const { cassette, artifacts } = target
  // Extraction's sidecar.goldAction is the exact recorded SubActionEvidence.plannedAction.
  const action = cassette.sidecar.goldAction
  if (action === undefined)
    return { kind: 'unavailable', reason: 'no-live-decision', detail: 'recorded planned action absent' }
  const withRecord: ReplaySample = {
    sampleIndex: 0,
    durationMs: 0,
    outcome: {
      kind: 'decision',
      action,
      identity: computeDecisionIdentity(action, cassette.input.stateBefore.elements),
    },
  }
  const removal = resolveActiveRecordRemoval({
    cassette,
    recordId: input.recordId,
    ...(admission.servedCanary === undefined ? {} : { servedCanary: admission.servedCanary }),
  })
  if (removal.kind === 'unavailable')
    return { kind: 'unavailable', reason: 'brief-line-not-found', detail: removal.reason }
  const outputDir = join(gate2Dir, 'cross-check', 'without', 'sample-0', 'replays')
  let modelCalls = 0
  const firstReplay = await runCassetteReplay({
    ...input.replay,
    cassette: { ...cassette, input: applyBriefDelta(cassette.input, removal.delta) },
    artifacts,
    declaredBriefDelta: removal.delta,
    k: 1,
    seed: input.baseSeed,
    modelCallObservation: {
      onProviderCall: () => {
        modelCalls++
        input.replay.modelCallObservation?.onProviderCall?.()
      },
    },
    recordStore: new FsReplayRecordStore({ root: gate2Dir, outputDir }),
    scoreStore: new FsScoreStore({ root: gate2Dir, outputDir }),
  })
  const firstSample =
    'granularity' in firstReplay && firstReplay.granularity === 'leaf'
      ? firstReplay.samples[0]
      : undefined
  const withoutRecord: ReplaySample = firstSample ?? {
    sampleIndex: 0,
    durationMs: 0,
    outcome: { kind: 'harness-error', message: 'replay produced no sample' },
  }
  const score = loadScoreRecord(join(outputDir, ...cassette.id.split('/').map(slugBranch)))
  const judgeCost =
    score.kind === 'loaded' && firstSample !== undefined
      ? buildEvalReport([
          { cassetteId: cassette.id, outcome: firstReplay, score: score.record.score },
        ]).honesty.judge.cost
      : { inputTokens: 0, outputTokens: 0 }
  const checked = await removalFlipsOutcome({
    recordId: input.recordId,
    cassettes: [target],
    mode: {
      kind: 'active-record',
      ...(admission.servedCanary === undefined ? {} : { servedCanary: admission.servedCanary }),
    },
    k: input.k,
    baseSeed: input.baseSeed,
    existing: { withRecord, withoutRecord },
    replay: input.replay,
    gate1Dir: gate2Dir,
  })
  if (
    checked.crossCheck === 'inconclusive' &&
    checked.notices.some((line) => line.startsWith('brief-line-not-found:'))
  )
    return { kind: 'unavailable', reason: 'brief-line-not-found', detail: checked.notices.join('\n') }
  return {
    kind: 'ablated',
    crossCheck: checked.crossCheck,
    corpusDigest: digest.corpusDigest,
    k: input.k,
    baseSeed: input.baseSeed,
    seeds: checked.seeds,
    seedHonored: checked.seedHonored,
    spend: {
      modelCalls: modelCalls + checked.modelCalls,
      screens: 1 + checked.screens,
      promptTokens:
        (withoutRecord.tokenUsage?.promptTokens ?? 0) + judgeCost.inputTokens + checked.promptTokens,
      completionTokens:
        (withoutRecord.tokenUsage?.completionTokens ?? 0) + judgeCost.outputTokens + checked.completionTokens,
    },
    gate2Dir,
    notices: [
      'with-record sample 1 is the recorded live decision; its seed was not replayed or verified. seedHonored describes fresh replay samples only.',
      ...checked.notices,
      ...(!checked.seedHonored
        ? ['seedHonored=false: fresh samples measure repeat variance on this provider']
        : []),
    ],
  }
}
