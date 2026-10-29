import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { resolveKnowledgeRoot } from '@vostride/agent-qa-core'
import {
  LOCAL_CURATION_CAPABILITIES,
  QUARANTINE_CLASS_DISPOSITIONS,
  QUARANTINE_FLOOR_ELIGIBILITY,
  type LocalCurationCapabilities,
  type OpenServingKnowledgeReaderConfig,
  type QuarantineDisposition,
  type QuarantineFloorEligibility,
} from '@vostride/agent-qa-agent-local'
import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'
import {
  EVENTS_FILE,
  HANDOFF_FILE,
  RUNS_SUBDIR,
  loadCompletedRunHandoff,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import type {
  ExecutionContext,
  CurationSnapshot,
  MaskFn,
} from '@vostride/agent-qa-schema'
import { canonicalJson, sha256hex, CurationSnapshotSchema, CURATION_BREAKDOWN_BUCKETS } from '@vostride/agent-qa-schema'

import { nudgeDaemon } from '../daemon/client.js'
import {
  buildCuratorAuthor,
  type BuildCuratorAuthorDependencies,
} from './curator-author.js'
import { emitCanaryOutcomes, type EmitCanaryOutcomeReport } from './emit-canary-outcomes.js'
import type { CanaryCreditCounters } from './canary-credit.js'
import { NON_SIGNAL_CLASSES } from './emit-canary-outcomes.js'
import { emitCurationCandidates, type EmitReport } from './emit-candidates.js'
import { exercisedAnchors } from './handoff-anchors.js'
import { renderPromotionLine } from './promotion-line.js'
import { resolveRunCurationContext } from './run-curation-context.js'
import { ciResumeClause } from './resume-limit.js'

export const CURATION_TAIL_RECEIPT_FILE = 'curation-tail-receipt.json'
/** The receipt's key set and stamp must match exactly; anything else refolds the run once. */
export const CURATION_TAIL_RECEIPT_SCHEMA_VERSION = 2

export interface CurationTailReceipt {
  /** Fixed successful membership; absent on handed-off receipts and when no validated snapshot was recorded. */
  snapshot?: CurationSnapshot
  /** Counts recorded beside the snapshot. */
  curated?: number
  deprecated?: number
  canary: CanaryCreditCounters
  schemaVersion: typeof CURATION_TAIL_RECEIPT_SCHEMA_VERSION
  runId: string
  handoffDigest: string
  // This only re-runs receipted runs; `reconcileRunOutcomesProjection` re-derives their rows.
  projectionVersion: number
  drainKind: 'drained' | 'handed-off'
  /** The standing writer that accepted the handoff; null when this run drained inline. */
  handoffHolderPid: number | null
  /** Stable run-side provenance, ordered before the receipt bytes are committed. */
  candidateIds: string[]
}

export type CurationTailModelDeps = Pick<
  BuildCuratorAuthorDependencies,
  'profile' | 'auth'
>

export interface CurationTailLogger {
  warn(message: string): void
  // Carries the per-run candidate summary line: diagnosis, never control flow.
  info?(message: string): void
}

export interface CurationTailOperations {
  loadCompletedRunHandoff: typeof loadCompletedRunHandoff
  resolveKnowledgeRoot: typeof resolveKnowledgeRoot
  runSafetyScope: typeof runSafetyScope
  emitCurationCandidates: typeof emitCurationCandidates
  openKnowledgeReader(config: OpenServingKnowledgeReaderConfig): KnowledgeHintReader
  emitCanaryOutcomes: typeof emitCanaryOutcomes
  foldRunOutcomes: LocalCurationCapabilities['foldRunOutcomes']
  reconcileRunOutcomesProjection: LocalCurationCapabilities['reconcileRunOutcomesProjection']
  acquireWriterLease: LocalCurationCapabilities['maintenance']['acquireWriterLease']
  releaseLease: LocalCurationCapabilities['maintenance']['releaseLease']
  buildCuratorAuthor: typeof buildCuratorAuthor
  drainQueue: LocalCurationCapabilities['drainQueue']
  listCompletedRunDirs(agentQaRoot: string): string[]
  readCurationTailReceipt(runDir: string): CurationTailReceipt | undefined
  writeCurationTailReceipt(runDir: string, receipt: CurationTailReceipt): void
  nudgeDaemon: typeof nudgeDaemon
  resolveRunCurationContext: typeof resolveRunCurationContext
}

// With this, the fold acquires no lease: a holder acquiring again is answered `held` by itself.
export interface CurationWriterAuthority {
  leaseId: string
  epoch: number
}

export interface RunCurationTailOptions {
  runId: string
  /** Absolute `.agent-qa` runtime root the run handoff lives under. */
  agentQaRoot: string
  knowledgeConfig: { dir: string }
  configDir: string
  mask?: MaskFn
  /** The exact already-resolved planner profile and auth used by the run. */
  modelDeps?: CurationTailModelDeps
  signal?: AbortSignal
  log: CurationTailLogger
  // The sweep runs under the post-run tail's held lease when there is one.
  authority?: CurationWriterAuthority
  // An absolute wall-clock stop point shared with the one post-run budget.
  deadlineMs?: number
  /** Focused test seam. Production callers omit it. */
  operations?: Partial<CurationTailOperations>
}

function defaultOperations(): CurationTailOperations {
  return {
    loadCompletedRunHandoff,
    resolveKnowledgeRoot,
    runSafetyScope,
    emitCurationCandidates,
    openKnowledgeReader: LOCAL_CURATION_CAPABILITIES.openKnowledgeReader,
    emitCanaryOutcomes,
    foldRunOutcomes: LOCAL_CURATION_CAPABILITIES.foldRunOutcomes,
    reconcileRunOutcomesProjection: LOCAL_CURATION_CAPABILITIES.reconcileRunOutcomesProjection,
    acquireWriterLease: LOCAL_CURATION_CAPABILITIES.maintenance.acquireWriterLease,
    releaseLease: LOCAL_CURATION_CAPABILITIES.maintenance.releaseLease,
    buildCuratorAuthor,
    drainQueue: LOCAL_CURATION_CAPABILITIES.drainQueue,
    listCompletedRunDirs,
    readCurationTailReceipt,
    writeCurationTailReceipt,
    nudgeDaemon,
    resolveRunCurationContext,
  }
}

// Exported because a composition root has no test seam, so the defaults must be nameable outside.
export function defaultCurationTailOperations(): CurationTailOperations {
  return defaultOperations()
}

// `slugBranch` keeps a runId like `../../etc` inside the runs directory; keep this the one join.
export function completedRunDir(agentQaRoot: string, runId: string): string {
  return join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
}

export function completedRunHandoffPath(agentQaRoot: string, runId: string): string {
  return join(completedRunDir(agentQaRoot, runId), HANDOFF_FILE)
}

// Published here because the surface firewall bars the daemon host from naming runner-local.
export function completedRunsRoot(agentQaRoot: string): string {
  return join(agentQaRoot, RUNS_SUBDIR)
}

// `EVENTS_FILE` is the constant the run's writer used, so the chip emitter appends to that file.
export function completedRunEventsPath(agentQaRoot: string, runId: string): string {
  return join(completedRunDir(agentQaRoot, runId), EVENTS_FILE)
}

export function listCompletedRunDirs(agentQaRoot: string): string[] {
  const runsRoot = completedRunsRoot(agentQaRoot)
  if (!existsSync(runsRoot)) return []
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsRoot, entry.name))
    .filter((runDir) => existsSync(join(runDir, HANDOFF_FILE)))
    .sort()
}

function isSortedCandidateIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  if (!value.every((candidateId): candidateId is string => typeof candidateId === 'string')) {
    return false
  }
  return value.every((candidateId, index) => index === 0 || value[index - 1]! <= candidateId)
}

function isCanaryCreditCounters(value: unknown): value is CanaryCreditCounters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !==
    'nonSignal,rerunExcluded,rideAlongUncredited') return false
  const count = (entry: unknown): boolean =>
    typeof entry === 'number' && Number.isInteger(entry) && entry >= 0
  if (!Object.entries(record).every(([key, entry]) => key === 'nonSignal' || count(entry))) return false
  const nonSignal = record.nonSignal
  if (typeof nonSignal !== 'object' || nonSignal === null || Array.isArray(nonSignal)) return false
  return Object.keys(nonSignal).sort().join(',') === [...NON_SIGNAL_CLASSES].sort().join(',')
    && Object.values(nonSignal).every(count)
}

function isCurationTailReceipt(value: unknown): value is CurationTailReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const optional = new Set(['snapshot', 'curated', 'deprecated'])
  return Object.keys(record).filter(key => !optional.has(key)).sort().join(',')
    === 'canary,candidateIds,drainKind,handoffDigest,handoffHolderPid,projectionVersion,runId,schemaVersion'
    && ['curated', 'deprecated'].every(key => record[key] === undefined
      || (typeof record[key] === 'number' && Number.isInteger(record[key]) && record[key] >= 0))
    && (record.snapshot === undefined || (record.drainKind === 'drained'
      && CurationSnapshotSchema.safeParse(record.snapshot).success))
    && isCanaryCreditCounters(record.canary)
    && record.schemaVersion === CURATION_TAIL_RECEIPT_SCHEMA_VERSION
    && typeof record.runId === 'string'
    && record.runId.length > 0
    && typeof record.handoffDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(record.handoffDigest)
    && typeof record.projectionVersion === 'number'
    && Number.isInteger(record.projectionVersion)
    && record.projectionVersion > 0
    && (record.drainKind === 'drained' || record.drainKind === 'handed-off')
    && (
      (record.drainKind === 'drained' && record.handoffHolderPid === null)
      || (
        record.drainKind === 'handed-off'
        && typeof record.handoffHolderPid === 'number'
        && Number.isInteger(record.handoffHolderPid)
        && record.handoffHolderPid > 0
      )
    )
    && isSortedCandidateIds(record.candidateIds)
}

export function readCurationTailReceipt(runDir: string): CurationTailReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8'),
    )
    return isCurationTailReceipt(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function fsyncFile(file: string): void {
  const fd = openSync(file, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeCurationTailReceipt(runDir: string, receipt: CurationTailReceipt): void {
  if (!isCurationTailReceipt(receipt)) throw new TypeError('invalid curation tail receipt')
  const file = join(runDir, CURATION_TAIL_RECEIPT_FILE)
  const staged = join(runDir, `.${CURATION_TAIL_RECEIPT_FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(staged, `${canonicalJson(receipt)}\n`, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(staged)
    renameSync(staged, file)
    fsyncFile(runDir)
  } finally {
    rmSync(staged, { force: true })
  }
}

export function curationTailHandoffDigest(handoff: unknown): string {
  return sha256hex(canonicalJson(handoff))
}

type CurationTailReceiptIdentity = Pick<
  CurationTailReceipt,
  'schemaVersion' | 'runId' | 'handoffDigest' | 'projectionVersion'
>

function receiptIdentityForHandoff(handoff: { runId: unknown }): CurationTailReceiptIdentity {
  return {
    schemaVersion: CURATION_TAIL_RECEIPT_SCHEMA_VERSION,
    runId: String(handoff.runId),
    handoffDigest: curationTailHandoffDigest(handoff),
    projectionVersion: LOCAL_CURATION_CAPABILITIES.runOutcomesProjectionVersion,
  }
}

function receiptMatches(
  receipt: CurationTailReceipt | undefined,
  expected: CurationTailReceiptIdentity,
): boolean {
  return receipt?.schemaVersion === expected.schemaVersion
    && receipt.runId === expected.runId
    && receipt.handoffDigest === expected.handoffDigest
    && receipt.projectionVersion === expected.projectionVersion
}

function sortedCandidateIds(report: EmitReport): string[] {
  return report.details
    .flatMap((detail) => detail.candidateId === undefined ? [] : [detail.candidateId])
    .sort()
}

const CANDIDATE_LINE_KINDS = ['fact', 'measurement', 'caution', 'procedure'] as const
const CANDIDATE_LINE_OUTCOMES = ['enqueued', 'coalesced', 'cap-exceeded', 'refused'] as const

// Value-free: kinds, counts and ids of non-enqueued outcomes; the procedure kind always renders.
function candidateSummaryLine(runId: string, report: EmitReport): string {
  const segments = CANDIDATE_LINE_KINDS.flatMap((kind) => {
    const details = report.details.filter((detail) => detail.kind === kind)
    if (details.length === 0) return kind === 'procedure' ? ['procedure 0 projected'] : []
    const split = CANDIDATE_LINE_OUTCOMES.flatMap((outcomeKind) => {
      const rows = details.filter((detail) => detail.outcome.kind === outcomeKind)
      if (rows.length === 0) return []
      const ids = outcomeKind === 'enqueued'
        ? []
        : rows.flatMap((row) => (row.candidateId === undefined ? [] : [row.candidateId]))
      return [`${rows.length} ${outcomeKind}${ids.length === 0 ? '' : `: ${ids.join(', ')}`}`]
    }).join(', ')
    return [`${kind} ${details.length} projected (${split})`]
  })
  return `Knowledge curation candidates for ${runId}: ${segments.join('; ')}.`
}

// `committed` includes downgraded changes, so the recorded share is `committed - downgraded`.
export function curationOutcomeLine(input: {
  readonly executionContext: ExecutionContext | undefined
  readonly committed: number
  readonly downgraded: number
}): string | undefined {
  if (input.committed <= 0) return undefined
  const proposed = Math.min(Math.max(input.downgraded, 0), input.committed)
  const recorded = input.committed - proposed
  if (input.executionContext === 'ci' || input.executionContext === 'cloud') {
    return `curation: ${recorded} learned change(s) recorded, ${proposed} kept proposed `
      + `(${input.executionContext} runs never promote learned knowledge)`
  }
  return `curation: ${recorded} learned change(s) applied, ${proposed} kept proposed `
    + '(local runs apply learned knowledge to the knowledge root)'
}

/** Fixed text: the warning names no row content. */
const SNAPSHOT_NOT_RECORDED_WARNING =
  'curation snapshot could not be validated and was not recorded; committed bundles are unaffected'

// The context is the run's persisted one; in `ci` and `cloud` the line states the resume limit.
function incompleteWarning(
  runId: string,
  executionContext: ExecutionContext | undefined,
  details?: string,
): string {
  const diagnostic = details === undefined ? '' : ` (${details})`
  const resumeClause = ciResumeClause(executionContext, 'masked-leg-only')
  return `Post-verdict knowledge curation incomplete for ${runId}${diagnostic}; `
    + (resumeClause !== undefined ? `it ${resumeClause}.` : 'it will resume on the next run.')
}

// The run command's own line when its curation tail throws unexpectedly.
export function unexpectedCurationTailWarning(executionContext: ExecutionContext | undefined): string {
  const resumeClause = ciResumeClause(executionContext, 'masked-leg-only')
  return resumeClause !== undefined
    ? `Post-verdict knowledge curation incomplete; it ${resumeClause}.`
    : 'Post-verdict knowledge curation incomplete; it will resume on the next run.'
}

/** The author `drainQueue` accepts, named off the capability so no second import declares it. */
type CurationAuthorCapability =
  Parameters<LocalCurationCapabilities['drainQueue']>[0]['author']

export interface CurateCompletedRunInput {
  /** The run's own directory (`<agentQaRoot>/runs/<slug>`), derived by the caller. */
  runDir: string
  /** The already-loaded, already-guarded handoff for THAT directory. */
  handoff: ReturnType<typeof loadCompletedRunHandoff>
  knowledgeRoot: string
  agentQaRoot: string
  mask?: MaskFn
  modelDeps?: CurationTailModelDeps
  /** An already-resolved author wins over `modelDeps`; a standing host holds one per process. */
  author?: CurationAuthorCapability
  authority?: CurationWriterAuthority
  deadlineMs?: number
  signal?: AbortSignal
  log: CurationTailLogger
  operations?: Partial<CurationTailOperations>
}

export interface CurateCompletedRunReport {
  /** Only complete folds carry the fixed five-bucket authority. */
  snapshot?: CurationSnapshot
  // Bundles this fold committed, the `curated` count of the notification.
  curated: number
  /** Committed `Deprecate` deltas — the `deprecated` half. */
  deprecated: number
  /** Whether the receipt was written, i.e. whether this run needs folding again. */
  complete: boolean
  drainKind: 'drained' | 'handed-off' | 'aborted'
  /** The same field list the incomplete warning renders; present only when incomplete. */
  incompleteDetails?: string
}

/**
 * The withheld line's remedy, as a function of the crossing's ADMISSIBILITY.
 *
 * Branch order is AUTHORED, then disposition, then eligibility. Each of the four sentences is TRUE
 * for every (verdictClass, producer) pair that can reach it, which is the whole point: the shipped
 * line branched on the producer alone and told every `deterministic-classifier` sighting that a
 * later fold might admit it — false for `environment` (authored-required forever) and for `unknown`
 * (escalate-only, and `classifyRootCause`'s terminal arm, so the dominant real-world case on a
 * project with no analysis budget).
 */
function remedyFor(crossing: {
  authored: boolean
  disposition: QuarantineDisposition
  floorEligibility: QuarantineFloorEligibility
}): string {
  if (crossing.authored) {
    return 'a verdict was already authored for this run, so re-running analysis '
      + 'will not change the answer.'
  }
  if (crossing.disposition === 'escalate-only') {
    return 'this class is never auto-quarantined, so no later run admits this crossing - '
      + 'only a verdict reclassifying it can, and this run has none.'
  }
  if (crossing.floorEligibility === 'authored-required') {
    return 'auto-quarantine for this class requires an authored verdict rather than '
      + 'another run - its evidence is run-scoped, so no fold admits it on the '
      + 'deterministic floor\'s word.'
  }
  return 'no verdict was authored for this run - the next applied run\'s fold '
    + 're-evaluates this crossing and may admit it then.'
}

// Silent unless lifecycle events land, an escalation is class-gated or the ledger read is refused.
function logQuarantineDisposition(
  runId: string,
  // Typed through the fold capability, because this package does not depend on knowledge-local.
  outcome: ReturnType<LocalCurationCapabilities['foldRunOutcomes']>['quarantine'],
  log: CurationTailLogger,
): void {
  if (outcome.kind === 'not-evaluated') return
  if (outcome.kind === 'ledger-unreadable') {
    log.warn(`Quarantine detection skipped for ${runId}: ${outcome.reason}`)
    return
  }

  const entered = outcome.events.filter((event) => event.kind === 'entered').length
  const released = outcome.events.filter((event) => event.kind === 'released-auto').length
  if (entered > 0 || released > 0 || outcome.escalatedNotQuarantined.length > 0) {
    log.info?.(
      `quarantine: ${String(entered)} entered, ${String(released)} released-auto, `
      + `${String(outcome.escalatedNotQuarantined.length)} escalated-not-quarantined `
      + `(${String(outcome.flagged.length)} flagged)`,
    )
  }
  for (const sighting of outcome.escalatedNotQuarantined) {
    // Only a missing signature and a spent cap await the next applied run; no arm names a command.
    const authored = sighting.producer === 'analyze-run'
    const disposition = QUARANTINE_CLASS_DISPOSITIONS[sighting.verdictClass]
    const floorEligibility = QUARANTINE_FLOOR_ELIGIBILITY[sighting.verdictClass]
    log.warn(
      `Quarantine withheld for ${sighting.testName} (${sighting.filePath}): `
      + `${sighting.verdictClass} recurred at ${String(sighting.occurrenceOrdinals)} of the last `
      + `${String(sighting.windowOrdinals)} failing builds and will keep failing this build. `
      + `Verdict producer: ${sighting.producer} — `
      + remedyFor({ authored, disposition, floorEligibility }),
    )
  }
  if (outcome.refusedLines.length > 0) {
    log.warn(
      `Quarantine ledger has ${String(outcome.refusedLines.length)} unreadable line(s) for `
      + `${runId}: ${outcome.refusedLines
        .map((line) => `line ${String(line.lineNumber)} (${line.reason})`)
        .join(', ')}.`,
    )
  }
}

// `authority` lets a fold inside a claimed job borrow the held lease instead of being told `held`.
export async function curateCompletedRun(
  input: CurateCompletedRunInput,
): Promise<CurateCompletedRunReport> {
  const operations: CurationTailOperations = {
    ...defaultOperations(),
    ...input.operations,
  }
  const receiptIdentity = receiptIdentityForHandoff(input.handoff)
  const previous = operations.readCurationTailReceipt(input.runDir)
  if (previous?.snapshot !== undefined && receiptMatches(previous, receiptIdentity)) {
    return { curated: previous.curated ?? 0, deprecated: previous.deprecated ?? 0,
      complete: true, drainKind: previous.drainKind, snapshot: previous.snapshot }
  }
  let curated = 0
  let deprecated = 0
  let drainKind: CurateCompletedRunReport['drainKind'] = 'aborted'
  let complete = false
  let completedReceipt: CurationTailReceipt | undefined
  let incompleteDetails: string | undefined
  let projectionFailed = false
  const tailStartedAtMs = Date.now()
  // One budget for the whole tail: a caller hands in its deadline and the drain gets what is left.
  const budgetMs = input.deadlineMs === undefined
    ? undefined
    : Math.max(0, input.deadlineMs - tailStartedAtMs)
  await operations.runSafetyScope(
    {
      // Posture is persisted run truth, never an ambient re-detection.
      executionContext: input.handoff.executionContext,
    },
    async () => {
      const candidates = operations.emitCurationCandidates({
        handoff: input.handoff,
        runDir: input.runDir,
        knowledgeRoot: input.knowledgeRoot,
        ...(input.mask === undefined ? {} : { mask: input.mask }),
      })
      // Visibility never gates: the summary line sits beside the noop warn and the complete check.
      input.log.info?.(candidateSummaryLine(receiptIdentity.runId, candidates))
      // Candidate and canary drops share this scope and crash boundary.
      const reader = operations.openKnowledgeReader({ knowledgeRoot: input.knowledgeRoot })
      const canaries = await operations.emitCanaryOutcomes({
        handoff: input.handoff,
        knowledgeRoot: input.knowledgeRoot,
        runDir: input.runDir,
        emit: reader.emitCanaryOutcome.bind(reader),
      })
      // Detection runs here under the tail's lease, because the ledger module takes no lock.
      try {
        const fold = operations.foldRunOutcomes({
          knowledgeRoot: input.knowledgeRoot,
          handoff: input.handoff,
          runDir: input.runDir,
          extractAnchors: exercisedAnchors,
          quarantine: {
            now: new Date(tailStartedAtMs).toISOString(),
          },
        })
        logQuarantineDisposition(receiptIdentity.runId, fold.quarantine, input.log)
      } catch {
        projectionFailed = true
      }
      const author = input.author
        ?? (input.modelDeps === undefined
          ? async () => ({
              kind: 'fallback-required' as const,
              reason: 'no-model' as const,
            })
          // A maskless tail runs only on a `no-masker` host, which cannot claim the folding kind.
          : operations.buildCuratorAuthor({
              ...input.modelDeps,
              mask: input.mask ?? ((text) => text),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            }))
      const drain = await operations.drainQueue({
        sourceRunId: String(input.handoff.runId),
        observationIds: (canaries.details ?? []).flatMap(row => row.candidateId === undefined
          || row.outcome.kind !== 'emitted' ? [] : [LOCAL_CURATION_CAPABILITIES.canaryOutcomeObservationId({
            candidateId: row.candidateId, runId: input.handoff.runId,
            testId: row.testId, testIndex: row.testIndex, stepIndex: row.stepIndex,
          })]),
        knowledgeRoot: input.knowledgeRoot,
        author,
        executionContext: input.handoff.executionContext,
        ...(input.authority === undefined ? {} : { lease: input.authority }),
        ...(budgetMs === undefined ? {} : { budgetMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      curated = drain.committed
      deprecated = drain.deprecated ?? 0
      if (drain.kind === 'handed-off') {
        drainKind = 'handed-off'
        input.log.info?.(`curation: handed to daemon (pid ${drain.holder.pid})`)
      } else if (drain.kind === 'drained') {
        drainKind = 'drained'
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - tailStartedAtMs) / 1_000))
        input.log.info?.(`curation: drained inline (${elapsedSeconds}s)`)
      }
      for (const entry of drain.promotions ?? []) input.log.info?.(renderPromotionLine(entry))
      const outcomeLine = curationOutcomeLine({
        executionContext: input.handoff.executionContext,
        committed: drain.committed - (drain.evidenceCommitted ?? 0),
        downgraded: drain.downgraded,
      })
      if (outcomeLine !== undefined) input.log.info?.(outcomeLine)
      // A commit noop is visible but never fatal, or evidence-token dedup would wedge the tail.
      if (drain.noops > 0) {
        // The count-anchored prefix stays byte-identical for the ladder extractor.
        input.log.warn(
          `Knowledge curation drain produced ${drain.noops} commit noop(s) for ${receiptIdentity.runId}: ${drain.noopDetails
            .map((noop) =>
              `${noop.candidateId} (${noop.reason}${
                noop.emptyDeltaCause === undefined ? '' : `: ${noop.emptyDeltaCause}`
              })`)
            .join(', ')}.`,
        )
      }
      complete = candidates.refused === 0
        && candidates.capExceeded === 0
        && canaries.refused === 0
        && canaries.unresolved === 0
        && !projectionFailed
        && (drain.kind === 'drained' || drain.kind === 'handed-off')
        && drain.failures === 0
        && drain.requeued === 0
        && (drain.kind === 'handed-off' || drain.remaining === undefined || drain.remaining === 0)
      if (complete && (drain.kind === 'drained' || drain.kind === 'handed-off')) {
        // The bundles already committed, so a snapshot that cannot be validated is omitted rather
        // than failing the fold; it is never repaired, refolded or zero-filled.
        const validated = drain.kind !== 'drained' || drain.snapshot === undefined
          ? undefined
          : CurationSnapshotSchema.safeParse(drain.snapshot)
        if ((drain.kind === 'drained' && drain.snapshotFoldFailed === true)
          || (validated !== undefined && !validated.success)) {
          input.log.warn(SNAPSHOT_NOT_RECORDED_WARNING)
        }
        completedReceipt = {
          ...receiptIdentity,
          canary: canaries.canary,
          drainKind: drain.kind,
          handoffHolderPid: drain.kind === 'handed-off' ? drain.holder.pid : null,
          candidateIds: sortedCandidateIds(candidates),
          // Counts travel with the snapshot, when the rerun short-circuit answers from the receipt.
          ...(validated?.success === true ? { snapshot: validated.data, curated, deprecated } : {}),
        }
      }
      if (!complete) {
        incompleteDetails = [
          `candidate-refused=${candidates.refused}`,
          `candidate-cap-exceeded=${candidates.capExceeded}`,
          `canary-refused=${canaries.refused}`,
          `canary-unresolved=${canaries.unresolved}`,
          `projection-failed=${projectionFailed ? 1 : 0}`,
          `drain-kind=${drain.kind}`,
          `drain-failures=${drain.failures}`,
          `drain-requeued=${drain.requeued}`,
          `drain-noops=${drain.noops}`,
        ].join(', ')
      }
    },
  )

  if (!complete || completedReceipt === undefined) {
    input.log.warn(incompleteWarning(receiptIdentity.runId, input.handoff.executionContext, incompleteDetails))
    return {
      curated,
      deprecated,
      complete: false,
      drainKind,
      ...(incompleteDetails === undefined ? {} : { incompleteDetails }),
    }
  }
  operations.writeCurationTailReceipt(input.runDir, completedReceipt)
  if (completedReceipt.snapshot !== undefined) {
    const breakdown = completedReceipt.snapshot.breakdown
    input.log.info?.(`curation: ${CURATION_BREAKDOWN_BUCKETS.map(bucket =>
      `${bucket} ${breakdown[bucket]}`).join(', ')}`)
  }
  if (completedReceipt.drainKind === 'handed-off') {
    void operations.nudgeDaemon(
      input.agentQaRoot,
      { knowledgeRoot: input.knowledgeRoot },
    ).catch(() => undefined)
  }
  return {
    curated,
    deprecated,
    complete: true,
    drainKind,
    ...(completedReceipt.snapshot === undefined ? {} : { snapshot: completedReceipt.snapshot }),
  }
}

/**
 * Run the post-verdict curation fold. The caller fixes its exit code before awaiting this function;
 * every failure is logged here and intentionally resolves so learning can never change the verdict.
 */
export async function runCurationTail(opts: RunCurationTailOptions): Promise<void> {
  const operations: CurationTailOperations = {
    ...defaultOperations(),
    ...opts.operations,
  }
  const currentRunDir = completedRunDir(opts.agentQaRoot, opts.runId)
  let currentHandoff: ReturnType<typeof loadCompletedRunHandoff>
  try {
    currentHandoff = operations.loadCompletedRunHandoff(
      join(currentRunDir, HANDOFF_FILE),
    )
  } catch {
    opts.log.warn(
      'Skipping post-verdict knowledge curation: the completed run handoff is missing or malformed.',
    )
    return
  }

  let knowledgeRoot: string
  let runDirs: string[]
  try {
    // The tail resolves the validated repo-relative knowledge root once, at this boundary.
    knowledgeRoot = operations.resolveKnowledgeRoot(
      opts.knowledgeConfig,
      opts.configDir,
    )
    runDirs = [...new Set([
      ...operations.listCompletedRunDirs(opts.agentQaRoot),
      currentRunDir,
    ])].sort()
  } catch {
    opts.log.warn(incompleteWarning(String(currentHandoff.runId), currentHandoff.executionContext))
    return
  }

  // Once per sweep, before any per-run fold, because its rebuild clears rows the loop would fold.
  let acquiredReconcileLease: CurationWriterAuthority | undefined
  try {
    // The post-run host lends its lease; a direct sweep acquires only for this reconcile.
    let authority = opts.authority
    if (authority === undefined) {
      const acquired = operations.acquireWriterLease(knowledgeRoot)
      if (acquired.kind === 'acquired') {
        authority = acquiredReconcileLease = { leaseId: acquired.leaseId, epoch: acquired.epoch }
      }
    }
    const reconcile = operations.reconcileRunOutcomesProjection({
      knowledgeRoot,
      ...(authority === undefined ? {} : { authority }),
      runsRoot: completedRunsRoot(opts.agentQaRoot),
      extractAnchors: exercisedAnchors,
    })
    if (reconcile.kind === 'skipped') {
      opts.log.warn('curation: run-outcome projection not reconciled (no writer authority)')
    } else if (reconcile.kind === 'rebuilt') {
      opts.log.info?.(
        'curation: run-outcome projection rebuilt at version '
        + `${LOCAL_CURATION_CAPABILITIES.runOutcomesProjectionVersion} `
        + `(folded ${reconcile.report.folded}, `
        + `skipped ${reconcile.report.skippedHandoffs} handoff, `
        + `${reconcile.report.skippedArtifacts} artifact)`,
      )
    }
  } catch (error) {
    // A reconcile can throw before or after its deletes, so the warning promises neither outcome.
    opts.log.warn(
      'Post-verdict knowledge curation: the run-outcome projection reconcile did not complete. '
      + 'If the rebuild write phase had already begun, the projection family is left unstamped and possibly'
      + ' partial, and the next reconcile rebuilds it; if it stopped before that, the family and'
      + ' its previous stamp are untouched. Continuing this sweep. '
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  } finally {
    if (acquiredReconcileLease !== undefined) {
      try {
        const released = operations.releaseLease({ knowledgeRoot, leaseId: acquiredReconcileLease.leaseId })
        if (released.kind !== 'released') {
          opts.log.warn('curation: run-outcome projection writer lease release refused')
        }
      } catch {
        opts.log.warn('curation: run-outcome projection writer lease release failed')
      }
    }
  }

  for (const runDir of runDirs) {
    let handoff: ReturnType<typeof loadCompletedRunHandoff>
    try {
      handoff = runDir === currentRunDir
        ? currentHandoff
        : operations.loadCompletedRunHandoff(join(runDir, HANDOFF_FILE))
    } catch {
      opts.log.warn(`Skipping post-verdict knowledge curation for ${runDir}: handoff is malformed.`)
      continue
    }

    const receiptIdentity = receiptIdentityForHandoff(handoff)
    try {
      const priorReceipt = operations.readCurationTailReceipt(runDir)
      if (receiptMatches(priorReceipt, receiptIdentity)) continue
      let runMask = opts.mask
      if (runDir !== currentRunDir) {
        const context = await operations.resolveRunCurationContext({
          agentQaRoot: opts.agentQaRoot,
          runId: String(handoff.runId),
          drainerKnowledgeRoot: knowledgeRoot,
        })
        if ('handBack' in context) {
          opts.log.warn(`Skipping post-verdict knowledge curation for ${runDir}: ${context.handBack}`)
          continue
        }
        runMask = context.mask
      }
      const folded = await curateCompletedRun({
        runDir,
        handoff,
        knowledgeRoot,
        agentQaRoot: opts.agentQaRoot,
        ...(runMask === undefined ? {} : { mask: runMask }),
        ...(opts.modelDeps === undefined ? {} : { modelDeps: opts.modelDeps }),
        ...(opts.authority === undefined ? {} : { authority: opts.authority }),
        ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        log: opts.log,
        operations: {
          ...operations,
          // The sweep already read this exact path; standalone folds still read for themselves.
          readCurationTailReceipt: (requestedRunDir) => requestedRunDir === runDir
            ? priorReceipt : operations.readCurationTailReceipt(requestedRunDir),
        },
      })
      if (!folded.complete) {
        if (opts.signal?.aborted === true) return
        continue
      }
    } catch {
      opts.log.warn(incompleteWarning(receiptIdentity.runId, currentHandoff.executionContext))
      if (opts.signal?.aborted === true) return
    }
  }
}

export interface RunVerdictFirstCurationTailOptions {
  /** The complete verdict-derived process code, fixed before the tail begins. */
  exitCode: number
  detach: boolean
  // Runs before the detach short-circuit: detaching skips the drain, never the durable enqueue.
  enqueue?(): Promise<void>
  runTail(): Promise<void>
  // Runs on both paths, because the detached path returns before `runTail` and needs the line most.
  finish?(input: { detached: boolean }): Promise<void>
  /** Defensive call-site boundary; runCurationTail itself already never rejects. */
  onUnexpectedError?(error: unknown): void
}

/** Await the optional tail without permitting it to replace the already-fixed verdict code. */
export async function runVerdictFirstCurationTail(
  opts: RunVerdictFirstCurationTailOptions,
): Promise<number> {
  if (opts.enqueue !== undefined) {
    try {
      await opts.enqueue()
    } catch (error) {
      opts.onUnexpectedError?.(error)
    }
  }
  const finish = async (detached: boolean): Promise<void> => {
    if (opts.finish === undefined) return
    try {
      await opts.finish({ detached })
    } catch (error) {
      opts.onUnexpectedError?.(error)
    }
  }
  if (opts.detach) {
    await finish(true)
    return opts.exitCode
  }
  try {
    await opts.runTail()
  } catch (error) {
    opts.onUnexpectedError?.(error)
  }
  await finish(false)
  return opts.exitCode
}
