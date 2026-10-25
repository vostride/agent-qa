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
  ResolvePromotionPosture,
  ScopeKey,
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
import { renderPromotionLine } from './promotion-posture.js'
import type { ResolveTrustPriors } from './trust-priors.js'
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
  /**
   * Run-outcome projection component: a version bump refolds already-receipted runs.
   *
   * This field alone only re-RUNS them (393 CR-02). The per-run fold behind it short-circuits on
   * the durable applied-runs marker, so what actually re-derives the rows at a new version is the
   * once-per-sweep `reconcileRunOutcomesProjection` below; the receipts then rewrite here at the
   * new version through this same sweep.
   */
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
  /** 381-50: carries the per-run candidate summary line — diagnosis, never control flow. */
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

/**
 * Writer authority the CALLER already holds (388-02, Pitfall 7).
 *
 * The fold acquires no lease of its own when this is present. That is not an optimisation: a
 * process holding the writer lease that calls `acquireWriterLease` again is told `held` — by
 * itself — and would hand its own work off to nobody (the 387-08 D-18 shape).
 */
export interface CurationWriterAuthority {
  leaseId: string
  epoch: number
}

export interface RunCurationTailOptions {
  resolveTrustPriors?: ResolveTrustPriors
  /** Built once by the caller; synchronous per candidate inside writer authority. */
  resolvePromotionPosture?: ResolvePromotionPosture
  /** 418 D-13: reuse prepared identity but bind each swept handoff's own ordinal. */
  resolvePromotionPostureForRun?: (buildOrdinal: number, scope?: ScopeKey) => Promise<ResolvePromotionPosture | undefined>
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
  /** 388-02: the sweep runs under the post-run tail's held lease when there is one. */
  authority?: CurationWriterAuthority
  /** 388-02 (D-03): absolute wall-clock stop point shared with the one post-run budget. */
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

/**
 * The shipped operation table, for callers that drive the PER-RUN fold directly (388-02).
 *
 * `curate-memory`'s handler reaches this fold through a capability bound at a composition
 * root, and a composition root has no test seam to thread — so the defaults have to be
 * nameable from outside this module rather than only reachable through `runCurationTail`.
 */
export function defaultCurationTailOperations(): CurationTailOperations {
  return defaultOperations()
}

/**
 * The one runs-dir derivation, published (388-02).
 *
 * `slugBranch` is what makes a runId of `../../etc` address nothing outside the runs directory
 * (T-361-01), and a second site spelling this join would be a second thing to keep traversal-safe.
 * Published from HERE rather than re-imported at each caller because the FUNC-02 surface firewall
 * forbids new CLI files from naming `@vostride/agent-qa-runner-local` at all — so one derivation
 * is not merely tidier, it is the only shape the boundary permits.
 */
export function completedRunDir(agentQaRoot: string, runId: string): string {
  return join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
}

export function completedRunHandoffPath(agentQaRoot: string, runId: string): string {
  return join(completedRunDir(agentQaRoot, runId), HANDOFF_FILE)
}

/**
 * The runs SCAN root — the same derivation minus the per-run leaf, published on exactly the terms
 * above (393 round 6, CR-02-daemon). The daemon host needs it to reconcile the run-outcome
 * projection once per acquired lease, and the surface firewall forbids that file from naming
 * `@vostride/agent-qa-runner-local` at all; publishing here is what keeps `RUNS_SUBDIR` the single
 * spelling of 'runs' instead of a literal copied into a second host.
 */
export function completedRunsRoot(agentQaRoot: string): string {
  return join(agentQaRoot, RUNS_SUBDIR)
}

/**
 * The run's own event log, published for the same reason and on the same terms (388-04).
 *
 * `EVENTS_FILE` is the runner-local constant the writer that CREATED this file used, so the
 * post-run chip emitter appends to the file the run wrote rather than to a name that merely
 * matches it today.
 */
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

/**
 * 381-50 (F-381-48-1): one additive, value-free line per swept run naming every kind's
 * projected count and outcome split — kinds, counts, and candidate content-address ids
 * only, never seed/observation/provenance content. The procedure kind always renders,
 * even at zero projected, so "nothing projected" reads from the line alone. Ids are
 * listed only for non-enqueued (queue-silent) outcomes to keep the line bounded.
 */
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

/**
 * Where this fold's learned changes went, in one line (432-40, D-08 / D-24).
 *
 * A local run applies what curation learned to the knowledge root in the fold. A `ci` or `cloud`
 * run records it as candidates it never promotes, and keeps a supersession proposed (444 D-57). A
 * change that delta validation refused is downgraded anywhere. `committed` counts both, so the
 * recorded share is `committed - downgraded`. The caller passes only the changes the breakdown
 * buckets count, never canary evidence events (444.1 D-25). Silent when there are none, and it
 * never points at a review step: there is none.
 */
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

// 444 D-48: the context is the run's persisted one (SAFE-01); in `ci` and `cloud` the line states
// curation's resume limit instead of promising the next run.
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

/** 444 D-48: the run command's own line when its curation tail throws unexpectedly. */
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
  resolveTrustPriors?: ResolveTrustPriors
  resolvePromotionPosture?: ResolvePromotionPosture
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
  /** Bundles this fold committed — the `curated` half of the D-11 notification counts. */
  curated: number
  /** Committed `Deprecate` deltas — the `deprecated` half. */
  deprecated: number
  /** Whether the receipt was written, i.e. whether this run needs folding again. */
  complete: boolean
  drainKind: 'drained' | 'handed-off' | 'aborted'
  /** The same field list the incomplete warning renders; present only when incomplete. */
  incompleteDetails?: string
  /**
   * The candidates the COMMITTED receipt names, forwarded to the proposal stage (422 D-13).
   *
   * The receipt's own `candidateIds` and never a second projection of the emit report: the
   * receipt is what a later reader can check this claim against, and a fold that wrote no
   * receipt has nothing to name. So this is present exactly when `complete` is `true`, and its
   * ABSENCE on an incomplete fold is the honest answer rather than an empty list — `[]` would
   * say the fold reported that there were none.
   */
  candidateIds?: readonly string[]
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

/**
 * Render the fold's quarantine disposition (390 D-08, Pitfall 4).
 *
 * Silent unless there is something a human must know. Loud in three cases, each of which is a
 * fact that would otherwise be invisible:
 *
 *  - lifecycle events landed (a test entered or left quarantine),
 *  - an escalation was class-gated AWAY from auto-quarantine — the D-05 anti-silencing surfacing,
 *    which is exactly the case that appends nothing and would otherwise pass unremarked,
 *  - the ledger read was REFUSED, whole or by line. A ledger that loses an `entered` event in
 *    silence is the defect class this warning exists for; it is never swallowed by a bare catch.
 *
 * Flags alone stay quiet: a suspected-flaky rung fires every second failure and its home is the
 * recurrence sentence, not the drain log.
 */
function logQuarantineDisposition(
  runId: string,
  // Reached THROUGH the capability the CLI already owns: 387 D-20 removed knowledge-local from
  // this package's dependency contract, and the surface firewall ledger only ever shrinks. The
  // report type is the fold capability's own return, so naming it costs no new import.
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
    // THE PRODUCER REACHES THE LINE (390-22 / WR-03). It was carried onto the sighting in 390-16
    // so an operator could tell two refusal causes apart HERE, and it was never printed — the
    // field's claim was true of the shape and false of the operator, which is the defect class
    // 390-22 closed.
    //
    // WHAT THE `producer` FIELD TELLS THE OPERATOR. 390-19 enumerated the causes on
    // `QuarantineDetectionSighting.producer`, and this render is reduced to that enumeration
    // rather than paraphrasing it:
    //   `analyze-run`               — a verdict WAS authored and the class is still not
    //                                 auto-quarantinable. Re-running analysis will not change it.
    //   `deterministic-classifier`  — the crossing was withheld for one of FOUR causes, below.
    //
    // THE UNAUTHORED SIDE HAS FOUR CAUSES, NOT THREE, AND THEY DO NOT SHARE ONE REMEDY (390-30,
    // round-5 gap 2). The earlier enumeration here named three and concluded that all of them
    // converge on the next-applied-run remedy. The cause it omitted is the one that breaks the
    // convergence: the gate can refuse the CLASS OUTRIGHT, and no run supplies a class. Read the
    // four against `autoQuarantines`' own conjunct order (`detection.ts`):
    //   (1) DISPOSITION REFUSAL — QUARANTINE_CLASS_DISPOSITIONS says `escalate-only`. Refused at the
    //       FIRST conjunct, before eligibility is consulted. NO later run and no authored verdict
    //       admits it; the class itself is the refusal. `unknown` — `classifyRootCause`'s terminal
    //       arm, and so the dominant shape on a project with no analysis budget — lives here.
    //   (2) ELIGIBILITY REFUSAL — the class may auto-quarantine, but QUARANTINE_FLOOR_ELIGIBILITY
    //       says `authored-required`: its evidence is run-scoped (a health probe), so a same-build
    //       signature never makes it per-test and the floor arm refuses it FOREVER. It needs an
    //       ANALYST, not another run. `environment` lives here.
    //   (3) MISSING SIGNATURE — floor-eligible class, but this crossing carries no per-test
    //       same-build pass∧fail.
    //   (4) SPENT CAP — floor-eligible class WITH the signature, but the run's per-run floor cap was
    //       already spent (390-19's third cause).
    // ONLY (3) AND (4) SHARE THE NEXT-APPLIED-RUN REMEDY: the NEXT applied run's fold re-evaluates
    // this crossing and may admit it THEN. That is the per-run floor cap's own vocabulary in
    // `detection.ts` — "It crosses again on the next applied run and may be admitted THEN" — and it
    // is true by execution: a capped/withheld identity IS admitted on a later evaluation, measured
    // 2/2/2 across three consecutive folds (round-4 verification). The sighting still cannot tell (3)
    // from (4), and no field was added to carry the distinction — 390-19's residual, unchanged,
    // D-05 posture. It does not have to: they have the SAME remedy, which is why the line collapses
    // exactly those two and no others.
    //
    // The remedy is therefore branched on ADMISSIBILITY, read from the same two total tables the
    // gate refuses on rather than from the producer alone. Reading the line's promise and the gate's
    // refusal out of ONE vocabulary is what stops them drifting apart per class — a promise of
    // admission a fold will never grant sends a human to wait for relief that cannot come.
    //
    // AND THIS RUN IS SETTLED — which is why no re-run of anything is named here. The arm used to
    // tell the operator to run a command, and that was false three separately checkable ways:
    //   (1) REGISTRY — the top-level `program.addCommand` block in `cli.ts` exposes no such verb,
    //       under any subcommand. `analyze-run` is a JOB KIND enqueued programmatically at
    //       `post-run-tail.ts:425`, not something an operator can type.
    //   (2) CHAIN POSITION — this line is emitted inside the fold that runs AFTER analysis has had
    //       its turn in the chain, so any THIS-run remedy is false by position alone.
    //   (3) IDEMPOTENCY (D-08) — `applyRunOutcomes` answers
    //       `{ kind: 'not-evaluated', reason: 'already-applied' }` (run-outcomes.ts:424, :792), so
    //       a refold of an applied run re-decides no crossing, whatever ran in between.
    // Those three falsifications are why no CLI invocation appears on ANY arm below, and they hold
    // for all four: none of the sentences names a command, because none of the remedies is one. Note
    // what 390-30 changes and what it does not — the remedy is still TEMPORAL rather than imperative
    // on causes (3) and (4), and on causes (1) and (2) it is not temporal EITHER, which is precisely
    // the correction: for those two, relief does not begin at a later run at all.
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

/**
 * Fold ONE completed run (388-02 D-01).
 *
 * Extracted verbatim from the sweep's inner body so `curate-memory`'s handler and the tail's
 * prior-run janitor drive the same code rather than two spellings of it. The split is
 * per-run/multi-run and nothing else (Pitfall 11): everything about a single run — the safety
 * scope, candidates, canaries, the outcome fold, the drain and the receipt — is here; the
 * enumeration of which runs still need it stays in `runCurationTail`.
 *
 * `authority` is what makes the extraction correct rather than merely tidy. The post-run tail
 * holds the writer lease while it pumps the chain, so the fold running INSIDE a claimed job
 * must borrow that authority; a fold that acquired its own would be told `held` by the very
 * process asking.
 */
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
      complete: true, drainKind: previous.drainKind, candidateIds: previous.candidateIds,
      snapshot: previous.snapshot }
  }
  let curated = 0
  let deprecated = 0
  let drainKind: CurateCompletedRunReport['drainKind'] = 'aborted'
  let complete = false
  let completedReceipt: CurationTailReceipt | undefined
  let incompleteDetails: string | undefined
  let projectionFailed = false
  const tailStartedAtMs = Date.now()
  // D-03: one budget for the whole post-run tail. A caller that already spent part of it hands
  // in its absolute deadline and the drain gets what is LEFT — never a second knob's worth.
  const budgetMs = input.deadlineMs === undefined
    ? undefined
    : Math.max(0, input.deadlineMs - tailStartedAtMs)
  await operations.runSafetyScope(
    {
      // SAFE-01: posture is persisted run truth, never an ambient re-detection.
      executionContext: input.handoff.executionContext,
    },
    async () => {
      const candidates = operations.emitCurationCandidates({
        handoff: input.handoff,
        runDir: input.runDir,
        knowledgeRoot: input.knowledgeRoot,
        ...(input.mask === undefined ? {} : { mask: input.mask }),
      })
      // 381-50: visibility never gates — the summary line is additive diagnosis
      // beside (never inside) the noop warn and the complete predicate below.
      input.log.info?.(candidateSummaryLine(receiptIdentity.runId, candidates))
      // D-20: candidate and canary drops share this scope and crash boundary.
      const reader = operations.openKnowledgeReader({ knowledgeRoot: input.knowledgeRoot,
        priors: input.resolveTrustPriors?.() })
      const canaries = await operations.emitCanaryOutcomes({
        handoff: input.handoff,
        knowledgeRoot: input.knowledgeRoot,
        runDir: input.runDir,
        emit: reader.emitCanaryOutcome.bind(reader),
      })
      // D-14: the run-outcome fold shares this crash boundary and the SAME extended
      // receipt as candidate/canary emit — never a second marker file. The durable
      // handoff marker is the sole exclusion authority for current and sibling runs.
      // A fold failure is isolated (counted below) and never blocks the drain; the
      // withheld receipt refolds it on the next run, safe because the fold is idempotent.
      // 390 D-09: `runDir` lets the fold read this run's `analysis.json`, so the counters and
      // fingerprint windows key off RESOLVED verdicts rather than the deterministic floor. It is
      // the same dir the canary fold above already reads — no new input crosses this boundary.
      // 390 D-08: detection runs INSIDE this fold, under the writer lease the tail already holds
      // (positional serialization — the ledger module takes no lock of its own). `now` is read
      // once, here, and threaded down as data so the fold and the ladder stay clock-free.
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
          // 2026-10-14 (441-10, decision 10): a tail with no mask runs only on a 'no-masker' host,
          // which may not claim the kind that folds.
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
        priors: input.resolveTrustPriors?.(),
        ...(input.resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture: input.resolvePromotionPosture }),
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
      // 2026-09-30, 432-10 D-05: a gate-inconsistent hold is its held line; nothing is filed.
      for (const entry of drain.promotions ?? []) input.log.info?.(renderPromotionLine(entry))
      const outcomeLine = curationOutcomeLine({
        executionContext: input.handoff.executionContext,
        committed: drain.committed - (drain.evidenceCommitted ?? 0),
        downgraded: drain.downgraded,
      })
      if (outcomeLine !== undefined) input.log.info?.(outcomeLine)
      // A commit noop is visible but never fatal (G-381-1): legitimate reasons such as
      // evidence-token dedup would otherwise wedge a healthy tail into the retry loop.
      // The complete predicate below is deliberately unchanged.
      if (drain.noops > 0) {
        // 381-47: the empty-delta cause renders inside the existing parenthetical;
        // the count-anchored prefix stays byte-identical for the ladder extractor.
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
          // WR-08: the counts travel beside the snapshot, which is exactly when the rerun short-circuit
          // answers from this receipt; a handed-off receipt has no counts of its own to record.
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
  // 422 D-13: the receipt's OWN array, read back off the value that was just committed rather
  // than re-projected from the emit report. The two are equal today by construction, and that is
  // exactly why the second projection must not exist: a later reader can check this claim against
  // the receipt on disk, and it can only do that while the claim IS the receipt.
  return {
    curated,
    deprecated,
    complete: true,
    drainKind,
    candidateIds: completedReceipt.candidateIds,
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
    // Phase 374 deliberately left this composition seam unwired. The Curator tail is its first
    // runtime caller and resolves the validated repo-relative root exactly once at the boundary.
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

  // 393 CR-02: ONCE per sweep, before any per-run fold. The projection version is a fact about the
  // whole derived family, not about one run, and the rebuild it can trigger clears that family —
  // so running it inside the loop would re-clear rows the loop had just folded.
  //
  // ISOLATED on the fold-failure posture two hundred lines down: a reconcile that throws warns and
  // the sweep continues. The per-run folds behind it are marker-safe with or without it, and a
  // backfill that cannot run is a projection that stays stale, never a curation that stops. The
  // 'rebuilt' arm logs its counts because a silent rebuild of the derived index is exactly the
  // kind of work an operator should be able to see happen.
  let acquiredReconcileLease: CurationWriterAuthority | undefined
  try {
    // The post-run host lends its lease. A direct sweep acquires only for this synchronous
    // reconcile, never re-acquiring an authority it already holds (418-12 WR-03).
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
    // What a thrown reconcile actually leaves behind — for EVERY throw that can reach here, which
    // is the part the round-6 wording got wrong (393 round 7, WARN-TEXT-CLASS). TWO classes arrive:
    // one raised BEFORE any DELETE (`openIndexWriter`, `ensureRunOutcomeTables`,
    // `readStoredProjectionVersion` all run ahead of `rebuildRunOutcomes`), which leaves the family
    // intact under whatever stamp it already had — and if that stamp is current, the next reconcile
    // answers 'current' and does not rebuild at all; and one raised AFTER them, including the
    // projection/write throws that now propagate, which leaves the family unstamped and possibly
    // partial. "Failed partway, will rebuild again" was flatly false of the first class, so the
    // text below states both outcomes as alternatives and promises neither unconditionally. The
    // same body is printed by the daemon arm, because the same two classes reach both catches.
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
      const resolvePromotionPosture = opts.resolvePromotionPostureForRun === undefined
        ? opts.resolvePromotionPosture : await opts.resolvePromotionPostureForRun(handoff.buildOrdinal, handoff.scope)
      const folded = await curateCompletedRun({
        resolveTrustPriors: opts.resolveTrustPriors,
        ...(resolvePromotionPosture === undefined ? {} : { resolvePromotionPosture }),
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
  /**
   * The durable hand-off, run BEFORE the detach short-circuit (388-02, D-03 / Pitfall 3).
   *
   * `--detach` means "do not spend this process on the work", not "do not record that the
   * work exists". The enqueue is the record; the drain is the spending. Putting it inside
   * `runTail` would have made a detached run the one posture that silently loses its
   * analysis, which is the opposite of what detaching asks for.
   */
  enqueue?(): Promise<void>
  runTail(): Promise<void>
  /**
   * The user-facing close-out, run on BOTH paths (388-04, D-08).
   *
   * The detach short-circuit below returns before `runTail`, and the one posture that most
   * needs a line about work left queued is exactly that one — so this cannot live inside the
   * tail. It is told which gate was applied rather than inferring it, because the gate is
   * this function's own knowledge and nothing downstream can see it.
   */
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
