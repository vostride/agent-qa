// The knowledge maintenance verbs: drain, rebuild-index, rollback, purge.
//
// 2026-08-02 (Phase 387 plan 09, D-20): this file's three firewall-ledger entries are cleared,
// and what happened is an IMPORT-TOPOLOGY migration — no subcommand gained, lost or changed a
// behaviour. Each capability now arrives through an edge a surface is sanctioned to name:
//
//   knowledge root      the CLI's own config helper, which is where every other verb resolves it
//   build ordinals      the local composition's build-ordinal edge (agent-local composition)
//   masking helpers     the agent barrel's re-exports, exactly as the `fn` invoker takes them

import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { renderPromotionLine } from '../curation/promotion-line.js'

import {
  BuildOrdinalReservationError,
  LOCAL_CURATION_CAPABILITIES,
  LOCAL_DAEMON_CAPABILITIES,
  reserveBuildOrdinalForProducts,
  resolveRunExecutionContext,
} from '@vostride/agent-qa-agent-local'
import type {
  CuratorAuthor,
  PurgeAffectedSet,
  PurgeReceipt,
  RebuildReport,
  RollbackAffectedSet,
  RollbackCampaignInput,
  RollbackCurationJobInput,
  RollbackReport,
  WriterLeaseAuthority,
} from '@vostride/agent-qa-agent-local'
import { asRecordId, maskPayloadTree } from '@vostride/agent-qa-schema'
import type { MaskFn, OriginClass } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import pc from 'picocolors'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
} from '../composition/declared-secrets.js'

import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import {
  completedRunsRoot,
  readCurationTailReceipt,
  type CurationTailReceipt,
} from '../curation/curation-tail.js'
import { nudgeDaemon } from '../daemon/client.js'
import {
  appendDrainSessionReceipt,
  readDrainSessionReceipts,
  type DrainSessionReceipt,
} from '../daemon/drain-receipts.js'
import { appendDaemonEvent } from '../daemon/events.js'
import { DRAIN_WAIT_TIMEOUT_MS } from '../daemon/host.js'
import {
  classifyDaemonRegistration,
  removeRegistrationIfOwned,
  type ClassifyDaemonRegistrationOutcome,
  type RemoveRegistrationOutcome,
} from '../daemon/registration.js'
import { daemonSocketOwnershipFor, unlinkDaemonSocket } from '../daemon/server.js'

// The eleven maintenance verbs, taken off the local host's curation capabilities rather than
// imported from the knowledge package directly (D-14). Bound once here so every call site below is
// the line it always was: this phase moves where the verbs come FROM and changes nothing about what
// the command does with them.
const {
  acquireWriterLease,
  purgeAffectedSetFingerprint,
  purgeRecord,
  rebuildIndex,
  refreshWriterLeaseAuthority,
  releaseLease,
  resolvePurgeAffectedSet,
  resolveRollbackAffectedSet,
  rollbackAffectedSetFingerprint,
  rollbackCampaign,
  rollbackCurationJob,
} = LOCAL_CURATION_CAPABILITIES.maintenance
const { drainQueue } = LOCAL_CURATION_CAPABILITIES
const {
  countRemainingCurationWork,
  readWriterLease,
} = LOCAL_DAEMON_CAPABILITIES

interface RebuildOptions {
  json?: boolean
}

interface RollbackOptions {
  job?: string
  fromBuild?: string
  toBuild?: string
  anchorCluster?: string
  originClass?: string
  json?: boolean
}

interface PurgeOptions {
  json?: boolean
}

export interface DrainOptions {
  status?: boolean
  json?: boolean
  /**
   * Quarantined registration paths a routing attempt left behind (WR-03). NOT a CLI flag.
   *
   * It rides the options object because that is the one value every drain exit already receives:
   * a router that computed the evidence next to a single `return` is how three of the four exits
   * came to report nothing, and re-deriving it at each exit would reproduce that by hand.
   */
  quarantined?: readonly string[]
}

interface DrainRunReceiptStatus {
  runId: string
  drainKind: CurationTailReceipt['drainKind']
  handoffHolderPid: number | null
  candidateCount: number
  candidateIds: string[]
}

interface DrainSessionReceiptStatus {
  sessionId: string
  holderPid: number
  candidateCount: number
  candidateIds: string[]
  outcome: DrainSessionReceipt['outcome']
  failures: number
  quarantined: number
  remainingAfter: number
}

interface KnowledgeDrainStatus {
  runReceipts: DrainRunReceiptStatus[]
  sessionReceipts: DrainSessionReceiptStatus[]
  remaining: number
}

export interface KnowledgePaths {
  configPath: string
  knowledgeRoot: string
  runtimeRoot: string
}

type OutputStream = 'stdout' | 'stderr'

type MaintainErrorCode =
  | 'invalid-selector'
  | 'invalid-ordinal'
  | 'invalid-origin-class'
  | 'preview-changed'
  | 'release-refused'

class KnowledgeMaintainCommandError extends Error {
  constructor(
    readonly code: MaintainErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeMaintainCommandError'
  }
}

type LeaseRunOutcome<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'refused' }

type RollbackSelector =
  | { kind: 'job'; curationJobId: string }
  | {
      kind: 'campaign'
      fromOrdinal?: number
      toOrdinal?: number
      anchorClusterKey?: string
      originClass?: OriginClass
    }

type RollbackExecutionOutcome = { kind: 'completed'; report: RollbackReport }

type PurgeExecutionOutcome =
  | { kind: 'completed'; receipt: PurgeReceipt; alreadyPurged: boolean }
  | { kind: 'failed' }

const ORIGIN_CLASSES = new Set<OriginClass>([
  'user',
  'agent-verified',
  'agent-observed',
  'import',
])

/** Short foreground feedback cadence; retune from operational evidence without adding config. */
const DRAIN_WAIT_POLL_MS = 100

export interface DaemonDrainTiming {
  readonly waitTimeoutMs: number
  readonly pollMs: number
}

const DEFAULT_DAEMON_DRAIN_TIMING: DaemonDrainTiming = {
  waitTimeoutMs: DRAIN_WAIT_TIMEOUT_MS,
  pollMs: DRAIN_WAIT_POLL_MS,
}

const FALLBACK_CURATOR_AUTHOR: CuratorAuthor = async () => ({
  kind: 'fallback-required',
  reason: 'no-model',
})

/** Five seconds is strictly below the writer lease's fixed 30-second TTL divided by three. */
const WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 5_000

function globalOptions(command: Command): { config?: string } {
  return command.parent?.parent?.opts<{ config?: string }>() ?? {}
}

async function resolveKnowledgePaths(command: Command): Promise<KnowledgePaths> {
  const global = globalOptions(command)
  const configPath = resolve(global.config ?? 'agent-qa.config.yaml')
  const configDir = dirname(configPath)
  const config = await resolveConfig({
    configPath,
    loadAuthPlugins: false,
  })
  const knowledgeRoot = resolveConfiguredKnowledgeRoot(config, configDir)
  const runtimeRoot = resolve(configDir, '.agent-qa')
  return {
    knowledgeRoot,
    runtimeRoot,
    configPath,
  }
}

/**
 * The declared mask for this invocation, read once at start (E3): a secrets file that cannot be
 * read refuses the command before anything else runs.
 */
function declaredMaskFor(command: Command): MaskFn {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  const declaredSecrets = createDeclaredSecretMask(configPath)
  declaredSecrets.redactor()
  return declaredSecrets.mask
}

// 2026-10-14 (441-14, D-07): everything this file prints is masked and never restored; JSON is
// masked leaf by leaf before it is serialized. 2026-10-15 (441-62, IN-A07): keys too.
function emitJson(mask: MaskFn, value: unknown): void {
  console.log(JSON.stringify(maskPayloadTree(value, mask), null, 2))
}

function emitHuman(mask: MaskFn, text: string, stream: OutputStream = 'stdout'): void {
  const rendered = `${mask(text)}\n`
  if (stream === 'stderr') process.stderr.write(rendered)
  else process.stdout.write(rendered)
}

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first !== undefined) console.error(pc.red(first))
  for (const line of rest) console.error(pc.dim(line))
}

// A refusal raised before the loader exists has nothing to mask with.
function reportErrorLine(line: string, error: unknown, mask: MaskFn | undefined): void {
  process.exitCode = 1
  if (error instanceof DeclaredSecretsUnavailableError) {
    printUnavailable(error)
    return
  }
  if (mask === undefined) {
    process.stderr.write(`${pc.red(line)}\n`)
    return
  }
  try {
    emitHuman(mask, pc.red(line), 'stderr')
  } catch (maskError) {
    if (!(maskError instanceof DeclaredSecretsUnavailableError)) throw maskError
    printUnavailable(maskError)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function readRunReceipts(runtimeRoot: string): CurationTailReceipt[] {
  const runsRoot = completedRunsRoot(runtimeRoot)
  let runDirs: string[]
  try {
    runDirs = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsRoot, entry.name))
      .sort(compareText)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  return runDirs
    .map((runDir) => readCurationTailReceipt(runDir))
    .filter((receipt): receipt is CurationTailReceipt => receipt !== undefined)
    .sort((left, right) => compareText(left.runId, right.runId))
}

function drainStatus(paths: KnowledgePaths): KnowledgeDrainStatus {
  const remainingWork = countRemainingCurationWork(paths.knowledgeRoot)
  return {
    runReceipts: readRunReceipts(paths.runtimeRoot).map((receipt) => ({
      runId: receipt.runId,
      drainKind: receipt.drainKind,
      handoffHolderPid: receipt.handoffHolderPid,
      candidateCount: receipt.candidateIds.length,
      candidateIds: receipt.candidateIds,
    })),
    sessionReceipts: readDrainSessionReceipts(paths.runtimeRoot).map((receipt) => ({
      sessionId: receipt.sessionId,
      holderPid: receipt.holderPid,
      candidateCount: receipt.candidateIds.length,
      candidateIds: receipt.candidateIds,
      outcome: receipt.outcome,
      failures: receipt.failures,
      quarantined: receipt.quarantined,
      remainingAfter: receipt.remainingAfter,
    })),
    remaining: remainingWork.queued
      + remainingWork.claimedNonterminal
      + remainingWork.quarantined,
  }
}

function renderDrainStatus(status: KnowledgeDrainStatus): string {
  const lines = [
    'Knowledge curation queue status',
    `  remaining: ${status.remaining}`,
  ]
  if (status.runReceipts.length === 0) {
    lines.push('  run receipts: none')
  } else {
    lines.push(`  run receipts (${status.runReceipts.length}):`)
    for (const receipt of status.runReceipts) {
      const holder = receipt.handoffHolderPid === null ? 'none' : String(receipt.handoffHolderPid)
      lines.push(
        `    ${receipt.runId}: ${receipt.drainKind}, holder ${holder}, `
        + `candidates ${receipt.candidateCount} [${receipt.candidateIds.join(', ')}]`,
      )
    }
  }
  if (status.sessionReceipts.length === 0) {
    lines.push('  daemon session receipts: none')
  } else {
    lines.push(`  daemon session receipts (${status.sessionReceipts.length}):`)
    for (const receipt of status.sessionReceipts) {
      lines.push(
        `    ${receipt.sessionId}: holder ${receipt.holderPid}, `
        + `${receipt.outcome}, remaining ${receipt.remainingAfter}, `
        + `failures ${receipt.failures}, quarantined ${receipt.quarantined}, `
        + `candidates ${receipt.candidateCount} [${receipt.candidateIds.join(', ')}]`,
      )
    }
  }
  return lines.join('\n')
}

function waitForDrainPoll(delayMs: number): Promise<void> {
  return new Promise((resolvePoll) => setTimeout(resolvePoll, delayMs))
}

type RemainingCurationWork = ReturnType<typeof countRemainingCurationWork>

function remainingTotal(work: RemainingCurationWork): number {
  return work.queued + work.claimedNonterminal + work.quarantined
}

function renderRemainingDisposition(work: RemainingCurationWork): string {
  return `remaining ${remainingTotal(work)} (`
    + `queued ${work.queued}, claimed ${work.claimedNonterminal}, `
    + `quarantined ${work.quarantined})`
}

/**
 * Append the same provenance record a daemon session appends, for a session run inline.
 *
 * D-16's receipt chain answers "who drained what, and what was left". Once the one-shot host
 * can recover a wedged daemon's queue, the chain would be silent about exactly the sessions
 * that mattered most unless the recovering host attests its own.
 */
function recordInlineDrainSession(
  paths: KnowledgePaths,
  report: Awaited<ReturnType<typeof drainQueue>>,
  remaining: number,
  seenCandidateIds: ReadonlySet<string>,
  authority: { leaseId: string; epoch: number } | undefined,
): void {
  if (authority === undefined || seenCandidateIds.size === 0) return
  appendDrainSessionReceipt(paths.runtimeRoot, {
    ts: new Date().toISOString(),
    sessionId: randomUUID(),
    holderPid: process.pid,
    epoch: authority.epoch,
    candidateIds: [...seenCandidateIds].sort(compareText),
    remainingAfter: remaining,
    outcome: report.failures === 0 && report.quarantined === 0 && remaining === 0
      ? 'completed'
      : 'failed',
    failures: report.failures,
    quarantined: report.quarantined,
  })
}

async function drainInline(
  paths: KnowledgePaths,
  options: DrainOptions,
  mask: MaskFn,
): Promise<void> {
  const seenCandidateIds = new Set<string>()
  let inlineAuthority: { leaseId: string; epoch: number } | undefined
  const report = await drainQueue({
    knowledgeRoot: paths.knowledgeRoot,
    author: FALLBACK_CURATOR_AUTHOR,
    executionContext: resolveRunExecutionContext(),
    onJobLifecycle: (event) => {
      seenCandidateIds.add(event.candidateId)
      // The lease is only readable as OURS while the drain holds it, and a durable boundary is
      // the one moment that is guaranteed. A drain that never claimed anything has no session
      // to attest, and a handed-off drain must never mint a receipt for another host's work.
      if (inlineAuthority !== undefined) return
      const lease = readWriterLease(paths.knowledgeRoot)
      if (lease.kind === 'parsed' && lease.lease.pid === process.pid) {
        inlineAuthority = { leaseId: lease.lease.leaseId, epoch: lease.lease.epoch }
      }
    },
  })
  const remainingWork = countRemainingCurationWork(paths.knowledgeRoot)
  const remaining = remainingTotal(remainingWork)
  recordInlineDrainSession(paths, report, remaining, seenCandidateIds, inlineAuthority)
  if (options.json === true) {
    emitJson(mask, { ...report, remaining, remainingWork, ...strandedJsonField(options) })
  } else if (report.kind === 'drained') {
    emitHuman(mask, [
      pc.green(pc.bold('Knowledge curation queue drained inline')),
      `  ${renderRemainingDisposition(remainingWork)}`,
    ].join('\n'))
  } else if (report.kind === 'handed-off') {
    emitHuman(mask, [
      pc.yellow(pc.bold(`Knowledge curation queue handed to pid ${report.holder.pid}`)),
      `  ${renderRemainingDisposition(remainingWork)}`,
    ].join('\n'))
  } else {
    emitHuman(mask, [
      pc.red(pc.bold('Knowledge curation queue drain aborted')),
      `  ${renderRemainingDisposition(remainingWork)}`,
    ].join('\n'))
  }
  if (options.json !== true) {
    for (const entry of report.promotions ?? []) emitHuman(mask, renderPromotionLine(entry))
  }
  if (
    report.kind !== 'drained'
    || report.failures > 0
    || report.quarantined > 0
    || remaining > 0
  ) process.exitCode = 1
}

export async function drainViaDaemon(
  paths: KnowledgePaths,
  options: DrainOptions,
  mask: MaskFn,
  timing: DaemonDrainTiming = DEFAULT_DAEMON_DRAIN_TIMING,
): Promise<void> {
  const startedAtMs = Date.now()
  const deadlineMs = startedAtMs + timing.waitTimeoutMs
  const receiptFloor = readDrainSessionReceipts(paths.runtimeRoot).length
  const nudge = await nudgeDaemon(paths.runtimeRoot, {
    knowledgeRoot: paths.knowledgeRoot,
    deadlineMs,
    requireReceipt: true,
  })
  let lastHumanRemaining: number | undefined

  while (true) {
    const remainingWork = countRemainingCurationWork(paths.knowledgeRoot)
    const remaining = remainingTotal(remainingWork)
    if (options.json !== true && remaining !== lastHumanRemaining) {
      emitHuman(mask, `Knowledge curation queue drain: ${renderRemainingDisposition(remainingWork)}`)
      lastHumanRemaining = remaining
    }

    const receipts = readDrainSessionReceipts(paths.runtimeRoot)
    const matchingIndex = nudge === undefined
      ? receiptFloor
      : receipts.findIndex((receipt) => receipt.sessionId === nudge.sessionId)
    const terminalReceipts = matchingIndex < 0 ? [] : receipts.slice(matchingIndex)
    for (const receipt of terminalReceipts) {
      if (
        receipt.outcome === 'failed'
        || receipt.failures > 0
        || receipt.quarantined > 0
        || receipt.remainingAfter > 0
      ) {
        if (options.json === true) {
          emitJson(mask, {
            mode: 'daemon',
            timedOut: false,
            sessionId: receipt.sessionId,
            receipt,
            remaining,
            remainingWork,
            ...strandedJsonField(options),
          })
        }
        emitHuman(
          mask,
          pc.red(
            `knowledge drain: daemon session ${receipt.sessionId} ended unresolved: `
            + `${renderRemainingDisposition(remainingWork)}; `
            + `failures ${receipt.failures}, quarantined ${receipt.quarantined}`,
          ),
          'stderr',
        )
        process.exitCode = 1
        return
      }
      if (receipt.remainingAfter === 0 && remaining === 0) {
        if (options.json === true) {
          emitJson(mask, {
            mode: 'daemon',
            timedOut: false,
            sessionId: receipt.sessionId,
            receipt,
            remaining,
            remainingWork,
            ...strandedJsonField(options),
          })
        }
        return
      }
    }

    const remainingBudgetMs = deadlineMs - Date.now()
    if (remainingBudgetMs <= 0) {
      if (options.json === true) {
        emitJson(mask, {
          mode: 'daemon',
          timedOut: true,
          unresponsive: true,
          remaining,
          remainingWork,
          ...strandedJsonField(options),
        })
      }
      emitHuman(
        mask,
        pc.red(
          `knowledge drain: daemon unresponsive; timed out at deadline with `
          + renderRemainingDisposition(remainingWork),
        ),
        'stderr',
      )
      process.exitCode = 1
      return
    }
    await waitForDrainPoll(Math.min(timing.pollMs, remainingBudgetMs))
  }
}

type RecoverableDaemonRegistration = Extract<
  ClassifyDaemonRegistrationOutcome,
  { kind: 'unreachable-lease-stale' }
>

function classifyDrainHost(
  paths: KnowledgePaths,
): Promise<ClassifyDaemonRegistrationOutcome> {
  return classifyDaemonRegistration({
    agentQaRoot: paths.runtimeRoot,
    knowledgeRoot: paths.knowledgeRoot,
  })
}

/** Remove exactly the generation that was classified, and nothing else. */
function removeClassifiedDrainRegistration(
  paths: KnowledgePaths,
  classified: RecoverableDaemonRegistration,
): RemoveRegistrationOutcome {
  return removeRegistrationIfOwned(paths.runtimeRoot, classified.registration.instanceId)
}

/**
 * Reclaim the exactly-removed generation's own address, through startup's gate and no other.
 *
 * 386-34 left this socket on disk (WINDOWS #39) because the client had no way to prove a recorded
 * path was safe to delete; 386-38 built that proof and made it `unlinkDaemonSocket`'s own
 * precondition. So this is not a second, drain-local rule — it is the same function, given the
 * same scope, derived by the same helper the daemon's startup recovery uses. A refusal is not an
 * error: the registration is already compare-deleted and the drain has work to finish, so the
 * refusal is recorded as `socketRemoved: false` on the same `registration-recovered` record
 * startup writes, rather than raised or invented as a new event kind.
 */
function reclaimDrainRecoveredSocket(
  paths: KnowledgePaths,
  classified: RecoverableDaemonRegistration,
  mask: MaskFn,
): void {
  const socketPath = classified.registration.socketPath
  let socketRemoved = false
  try {
    socketRemoved = unlinkDaemonSocket(
      socketPath,
      daemonSocketOwnershipFor(paths.runtimeRoot, classified.registration),
    )
  } catch (error) {
    emitHuman(
      mask,
      pc.yellow(`knowledge drain: stale socket cleanup failed (${socketPath}): `
        + errorMessage(error)),
      'stderr',
    )
  }
  appendDaemonEvent(paths.runtimeRoot, {
    kind: 'registration-recovered',
    classification: classified.kind,
    pid: classified.registration.pid,
    instanceId: classified.registration.instanceId,
    socketPath,
    socketRemoved,
  })
}

/** The stranded-evidence names this exit must carry, or an empty list when nothing was parked. */
function strandedQuarantine(options: DrainOptions): readonly string[] {
  return options.quarantined ?? []
}

/**
 * `{ quarantinedRegistrations: [...] }` for a JSON summary; absent when there is no evidence.
 *
 * NOT `quarantined`: that key already means "how many curation CANDIDATES were quarantined" on the
 * drain report and on every drain-session receipt, and the inline exit's summary spreads the
 * report — so the shorter name silently replaced a count with a path list. The registration
 * evidence therefore says what it is.
 */
function strandedJsonField(
  options: DrainOptions,
): { quarantinedRegistrations?: readonly string[] } {
  const stranded = strandedQuarantine(options)
  return stranded.length > 0 ? { quarantinedRegistrations: stranded } : {}
}

/** The one sentence every exit appends; empty when nothing was parked. */
function strandedHumanSuffix(options: DrainOptions): string {
  const stranded = strandedQuarantine(options)
  return stranded.length > 0
    ? `; the classified generation's bytes are preserved at ${stranded.join(', ')}`
    : ''
}

/**
 * Name stranded evidence on the exits whose own summary is not a refusal line.
 *
 * Written to stderr unconditionally, mirroring the contended exit: stdout stays parseable JSON in
 * `--json` mode, and the operator is told either way. Bytes parked under a name nobody reads are
 * the thing that has to be pointed at, whichever route the router finally took.
 */
function reportStrandedQuarantine(options: DrainOptions, mask: MaskFn): void {
  const stranded = strandedQuarantine(options)
  if (stranded.length === 0) return
  emitHuman(
    mask,
    pc.yellow(
      `knowledge drain: a registration removal attempt was contended${strandedHumanSuffix(options)}`,
    ),
    'stderr',
  )
}

/** Accumulate the quarantine path of a removal attempt that parked bytes; ignore the others. */
function collectStrandedQuarantine(
  stranded: string[],
  outcome: RemoveRegistrationOutcome | undefined,
): void {
  if (outcome?.kind === 'changed-under-removal') stranded.push(outcome.quarantinePath)
}

/**
 * Refusals for a host this command must not recover from, and must not guess about.
 *
 * D-14's law in one place: a fresh holder keeps its lease and gets named; registration bytes
 * this command cannot parse select nothing at all. Either refusal also names any quarantined
 * evidence a prior removal attempt left behind (WR-03) — the refusal is the operator's only
 * output on these paths, so it is the only place the parked bytes can be reported.
 */
function refuseDrainRouting(
  outcome: ClassifyDaemonRegistrationOutcome,
  options: DrainOptions,
  mask: MaskFn,
): outcome is Extract<
  ClassifyDaemonRegistrationOutcome,
  { kind: 'malformed' | 'unreachable-lease-fresh' }
> {
  if (outcome.kind === 'malformed') {
    if (options.json === true) {
      emitJson(mask, {
        mode: 'refused',
        reason: 'registration-malformed',
        ...strandedJsonField(options),
      })
    }
    emitHuman(
      mask,
      pc.red(
        'knowledge drain: refusal [registration-malformed]: the daemon registration cannot be '
        + 'parsed, so no drain mode can be chosen from it; inspect .agent-qa/daemon.json'
        + strandedHumanSuffix(options),
      ),
      'stderr',
    )
    process.exitCode = 1
    return true
  }
  if (outcome.kind === 'unreachable-lease-fresh') {
    /**
     * CR-01 (round 5): the holder is absent exactly when the lease bytes could not be read, so
     * this refusal names the errno on the file instead of a pid it never saw. Same verdict, same
     * exit code, same law (a lease that cannot be read is held, never recoverable) — the only
     * difference is which fact the operator is given to act on.
     */
    const holder = outcome.holder
    if (options.json === true) {
      emitJson(mask, {
        mode: 'refused',
        reason: 'writer-lease-held',
        ...(holder === undefined ? { lease: outcome.lease } : { holder }),
        identityFailure: outcome.identityFailure,
        registrationPid: outcome.registration.pid,
        ...strandedJsonField(options),
      })
    }
    const heldDetail = holder === undefined
      ? `unreadable on disk (`
        + `${outcome.lease.kind === 'unreadable' ? outcome.lease.code : outcome.lease.kind})`
      : `held by pid ${holder.pid}, lease ${holder.leaseId}, epoch ${holder.epoch}, `
        + `last renewed ${Math.max(0, Date.now() - holder.heartbeatAtMs)}ms ago`
    emitHuman(
      mask,
      pc.red(
        `knowledge drain: refusal [writer-lease-held]: writer lease is ${heldDetail}; `
        + `the registered daemon (pid ${outcome.registration.pid}) did not answer its identity `
        + `handshake [${outcome.identityFailure}]`
        + strandedHumanSuffix(options),
      ),
      'stderr',
    )
    process.exitCode = 1
    return true
  }
  return false
}

/**
 * Choose a drain mode from authenticated daemon identity and composite lease freshness.
 *
 * Signal-zero liveness chose the mode before this: a SIGSTOPped daemon and an unrelated process
 * that inherited a dead daemon's pid both looked "live", so the command delegated to a host that
 * could never answer and reported it as an error instead of finishing the work itself.
 */
async function routeDrain(
  paths: KnowledgePaths,
  options: DrainOptions,
  mask: MaskFn,
): Promise<void> {
  const classified = await classifyDrainHost(paths)
  if (classified.kind === 'live-confirmed') {
    await drainViaDaemon(paths, options, mask)
    return
  }
  if (refuseDrainRouting(classified, options, mask)) return
  if (classified.kind === 'absent') {
    await drainInline(paths, options, mask)
    return
  }

  /**
   * WR-03: the evidence ledger, hoisted above every exit that can follow a removal attempt.
   *
   * A predecessor's bytes parked under a name nobody reads is a fact about the SYSTEM, not about
   * whichever branch the router happened to take next — so it is accumulated once here and read by
   * the delegate, the two refusals, the contended exit and the inline drain alike.
   */
  const stranded: string[] = []
  const routed = (): DrainOptions => ({ ...options, quarantined: [...stranded] })

  const removal = removeClassifiedDrainRegistration(paths, classified)
  collectStrandedQuarantine(stranded, removal)
  if (removal.kind !== 'removed') {
    // The registration changed between classification and removal. Look once more rather than
    // act on a file this command never classified, and fail closed rather than race a third
    // writer.
    const reclassified = await classifyDrainHost(paths)
    if (reclassified.kind === 'live-confirmed') {
      const delegated = routed()
      reportStrandedQuarantine(delegated, mask)
      await drainViaDaemon(paths, delegated, mask)
      return
    }
    if (refuseDrainRouting(reclassified, routed(), mask)) return
    const retry = reclassified.kind === 'absent'
      ? undefined
      : removeClassifiedDrainRegistration(paths, reclassified)
    collectStrandedQuarantine(stranded, retry)
    if (retry !== undefined && retry.kind !== 'removed') {
      if (options.json === true) {
        emitJson(mask, {
          mode: 'refused',
          reason: 'registration-contended',
          ...strandedJsonField(routed()),
        })
      }
      emitHuman(
        mask,
        pc.red(
          'knowledge drain: refusal [registration-contended]: the daemon registration changed '
          + 'twice while it was being classified; rerun the command'
          + strandedHumanSuffix(routed()),
        ),
        'stderr',
      )
      process.exitCode = 1
      return
    }
    if (retry !== undefined) {
      reclaimDrainRecoveredSocket(paths, reclassified as RecoverableDaemonRegistration, mask)
    }
  } else {
    reclaimDrainRecoveredSocket(paths, classified, mask)
  }
  const inline = routed()
  reportStrandedQuarantine(inline, mask)
  await drainInline(paths, inline, mask)
}

function reportDrainError(error: unknown, mask: MaskFn | undefined): void {
  reportErrorLine(`knowledge drain: error: ${errorMessage(error)}`, error, mask)
}

function reportError(
  verb: 'rebuild-index' | 'rollback' | 'purge',
  error: unknown,
  mask: MaskFn | undefined,
): void {
  const message = error instanceof KnowledgeMaintainCommandError
    ? `knowledge ${verb}: error [${error.code}]: ${error.message}`
    : error instanceof BuildOrdinalReservationError
      ? `knowledge ${verb}: error [${error.code}]: ${error.message}`
      : `knowledge ${verb}: error: ${errorMessage(error)}`
  reportErrorLine(message, error, mask)
}

function renderLeaseRefusal(
  verb: 'rebuild-index' | 'rollback' | 'purge',
  holder: { leaseId: string; pid: number; epoch: number },
): string {
  return pc.red(
    `knowledge ${verb}: refusal [writer-lease-held]: writer lease is held by `
    + `pid ${holder.pid}, lease ${holder.leaseId}, epoch ${holder.epoch}`,
  )
}

async function withWriterLease<T>(
  verb: 'rebuild-index' | 'rollback' | 'purge',
  knowledgeRoot: string,
  mask: MaskFn,
  operation: (writerAuthority: WriterLeaseAuthority) => Promise<T> | T,
): Promise<LeaseRunOutcome<T>> {
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind === 'held') {
    emitHuman(mask, renderLeaseRefusal(verb, lease.holder), 'stderr')
    process.exitCode = 1
    return { kind: 'refused' }
  }
  if (lease.kind === 'refused') {
    emitHuman(
      mask,
      pc.red(`knowledge ${verb}: refusal [${lease.reason}]: ${lease.error.message}`),
      'stderr',
    )
    process.exitCode = 1
    return { kind: 'refused' }
  }

  const writerAuthority: WriterLeaseAuthority = {
    knowledgeRoot,
    leaseId: lease.leaseId,
    epoch: lease.epoch,
  }
  let heartbeatError: unknown
  const heartbeatTimer = setInterval(() => {
    if (heartbeatError !== undefined) return
    try {
      refreshWriterLeaseAuthority(writerAuthority)
    } catch (error) {
      heartbeatError = error
    }
  }, WRITER_LEASE_HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()

  let operationError: unknown
  try {
    const value = await operation(writerAuthority)
    if (heartbeatError !== undefined) throw heartbeatError
    refreshWriterLeaseAuthority(writerAuthority)
    return { kind: 'completed', value }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    clearInterval(heartbeatTimer)
    const release = releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    if (release.kind === 'refused' && operationError === undefined) {
      throw new KnowledgeMaintainCommandError(
        'release-refused',
        `writer lease release was refused (${release.reason})`,
      )
    }
  }
}

// The preview leaves stdout free for `--json`, whose stdout carries only the typed result.
function previewStream(json: boolean): OutputStream {
  return json ? 'stderr' : 'stdout'
}

function renderRebuildReport(report: RebuildReport): string {
  return [
    pc.bold('Knowledge index rebuild complete'),
    `  projected: ${report.projected}`,
    `  removed: ${report.removed}`,
    `  backfilled: ${report.backfilled}`,
    `  vector capability: ${report.vec}`,
    `  pending embeddings: ${report.pendingEmbeddings}`,
    `  maintenance remaining: ${report.maintenanceRemaining ? 'yes' : 'no'}`,
    ...(report.skippedIncomplete === 0
      ? []
      : [`  skipped incomplete bundles: ${report.skippedIncomplete}`]),
    ...(report.scanIssues.length === 0
      ? []
      : [
          `  scan issues (${report.scanIssues.length}):`,
          ...report.scanIssues.map((issue) => `    ${issue}`),
        ]),
  ].join('\n')
}

function parseOrdinal(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new KnowledgeMaintainCommandError(
      'invalid-ordinal',
      `${label} must be a non-negative safe integer`,
    )
  }
  const ordinal = Number(value)
  if (!Number.isSafeInteger(ordinal)) {
    throw new KnowledgeMaintainCommandError(
      'invalid-ordinal',
      `${label} must be a non-negative safe integer`,
    )
  }
  return ordinal
}

function rollbackSelector(options: RollbackOptions): RollbackSelector {
  const campaignSelected = options.fromBuild !== undefined
    || options.toBuild !== undefined
    || options.anchorCluster !== undefined
    || options.originClass !== undefined

  if (options.job !== undefined && campaignSelected) {
    throw new KnowledgeMaintainCommandError(
      'invalid-selector',
      '--job cannot be combined with campaign selectors',
    )
  }
  if (options.job !== undefined) {
    if (options.job.trim() === '') {
      throw new KnowledgeMaintainCommandError('invalid-selector', '--job must be non-empty')
    }
    return { kind: 'job', curationJobId: options.job }
  }
  if (!campaignSelected) {
    throw new KnowledgeMaintainCommandError(
      'invalid-selector',
      'provide --job or at least one campaign selector',
    )
  }

  let originClass: OriginClass | undefined
  if (options.originClass !== undefined) {
    if (!ORIGIN_CLASSES.has(options.originClass as OriginClass)) {
      throw new KnowledgeMaintainCommandError(
        'invalid-origin-class',
        '--origin-class must be user|agent-verified|agent-observed|import',
      )
    }
    originClass = options.originClass as OriginClass
  }

  return {
    ...(options.fromBuild === undefined
      ? {}
      : { fromOrdinal: parseOrdinal(options.fromBuild, '--from-build')! }),
    ...(options.toBuild === undefined
      ? {}
      : { toOrdinal: parseOrdinal(options.toBuild, '--to-build')! }),
    ...(options.anchorCluster === undefined
      ? {}
      : { anchorClusterKey: options.anchorCluster }),
    ...(originClass === undefined ? {} : { originClass }),
    kind: 'campaign',
  }
}

function rollbackInput(
  selector: RollbackSelector,
  paths: KnowledgePaths,
  resolvedAtOrdinal: number,
  writerAuthority?: WriterLeaseAuthority,
  expectedAffectedSetFingerprint?: string,
): RollbackCurationJobInput | RollbackCampaignInput {
  const base = {
    knowledgeRoot: paths.knowledgeRoot,
    resolvedAtOrdinal,
    ...(writerAuthority === undefined ? {} : { writerAuthority }),
    ...(expectedAffectedSetFingerprint === undefined
      ? {}
      : { expectedAffectedSetFingerprint }),
  }
  return selector.kind === 'job'
    ? { ...base, curationJobId: selector.curationJobId }
    : {
        ...base,
        ...(selector.fromOrdinal === undefined ? {} : { fromOrdinal: selector.fromOrdinal }),
        ...(selector.toOrdinal === undefined ? {} : { toOrdinal: selector.toOrdinal }),
        ...(selector.anchorClusterKey === undefined
          ? {}
          : { anchorClusterKey: selector.anchorClusterKey }),
        ...(selector.originClass === undefined ? {} : { originClass: selector.originClass }),
      }
}

async function rollbackOrdinal(
  paths: KnowledgePaths,
  affected: RollbackAffectedSet,
  writerAuthority: WriterLeaseAuthority,
): Promise<number> {
  if (!rollbackNeedsOrdinal(affected)) return 0
  return (await reserveBuildOrdinalForProducts({
    root: paths.runtimeRoot,
    products: affected.products,
    beforePersist: () => refreshWriterLeaseAuthority(writerAuthority),
  })) ?? 0
}

function rollbackNeedsOrdinal(affected: RollbackAffectedSet): boolean {
  return affected.plannedEffects.some((effect) =>
    effect.kind === 'deprecate-bundle'
    || effect.kind === 'retract-counter'
    || effect.kind === 'retract-window-close'
    || effect.kind === 'retract-promotion',
  )
}

function rollbackPreviewFingerprint(affected: RollbackAffectedSet): string {
  return rollbackAffectedSetFingerprint(affected)
}

function renderRollbackPreview(affected: RollbackAffectedSet): string {
  return [
    pc.bold('Rollback preview'),
    `  minted bundles (${affected.mintedBundleIds.length}):`,
    ...(affected.mintedBundleIds.length === 0
      ? ['    none']
      : affected.mintedBundleIds.map((recordId) => `    ${recordId}`)),
    `  counter events (${affected.counterEvents.length}):`,
    ...(affected.counterEvents.length === 0
      ? ['    none']
      : affected.counterEvents.map((event) => (
          `    ${event.type} ${event.recordId} `
          + `(job ${event.curationJobId}, evidence ${event.evidenceToken})`
        ))),
    `  complete inverse effects (${affected.plannedEffects.length}):`,
    ...(affected.plannedEffects.length === 0
      ? ['    none']
      : affected.plannedEffects.map((effect) => (
          effect.kind === 'deprecate-bundle'
            ? `    ${effect.kind} ${effect.product}/${effect.recordId}`
            : `    ${effect.kind} ${effect.product}/${effect.recordId} (${effect.eventKey})`
        ))),
  ].join('\n')
}

function renderRollbackReport(report: RollbackReport): string {
  return [
    pc.green(pc.bold('Rollback complete')),
    `  receipt: ${report.receiptId}`,
    `  inverse events appended: ${report.inverseCount}`,
    `  deprecated bundles: ${report.deprecatedBundles.join(', ') || 'none'}`,
    `  restored victims: ${report.restoredVictims.join(', ') || 'none'}`,
    `  retracted promotions: ${report.retractedPromotions.join(', ') || 'none'}`,
  ].join('\n')
}

function renderPurgePreview(affected: PurgeAffectedSet): string {
  return [
    pc.bold(`Purge preview for ${affected.recordId}`),
    `  state: ${affected.state}`,
    `  bundle trees (${affected.bundles.length}):`,
    ...(affected.bundles.length === 0
      ? ['    none']
      : affected.bundles.flatMap((bundle) => [
          `    ${bundle.bundleDir} (product ${bundle.product}, kind ${bundle.kind})`,
          ...bundle.affectedPaths.map((path) => `      ${path}`),
        ])),
    `  receipt-named affected paths (${affected.receiptAffectedPaths.length}):`,
    ...(affected.receiptAffectedPaths.length === 0
      ? ['    none']
      : affected.receiptAffectedPaths.map((path) => `    ${path}`)),
    `  queue targets (${affected.queueTargets.length}):`,
    ...(affected.queueTargets.length === 0
      ? ['    none']
      : affected.queueTargets.flatMap((target) => [
          `    payload: ${target.candidateDir} (${target.candidateId})`,
          `    job state: ${target.jobStatePath}`,
        ])),
    `  projections: ${affected.projectionTargets.join(', ')}`,
    `  embed cache: ${affected.embedCacheAction}`,
    `  intent: ${affected.intentPath}`,
    `  receipt: ${affected.receiptPath}`,
  ].join('\n')
}

async function purgeOrdinal(
  paths: KnowledgePaths,
  affected: PurgeAffectedSet,
  writerAuthority: WriterLeaseAuthority,
): Promise<number | undefined> {
  if (affected.state !== 'live') return undefined
  const ordinal = await reserveBuildOrdinalForProducts({
    root: paths.runtimeRoot,
    products: affected.bundles.map(({ product }) => product),
    beforePersist: () => refreshWriterLeaseAuthority(writerAuthority),
  })
  if (ordinal === undefined) {
    throw new KnowledgeMaintainCommandError(
      'invalid-ordinal',
      'live purge affected no product ordinal counters',
    )
  }
  return ordinal
}

function assertPreviewUnchanged(verb: 'rollback' | 'purge', before: string, after: string): void {
  if (before === after) return
  throw new KnowledgeMaintainCommandError(
    'preview-changed',
    `${verb} target changed after the preview; rerun the command to see the new preview`,
  )
}

function renderPurgeReceipt(receipt: PurgeReceipt, alreadyPurged: boolean): string {
  return [
    pc.green(pc.bold(alreadyPurged ? 'Record already purged' : 'Purge complete')),
    `  record: ${receipt.purgedRecordId}`,
    `  purge ordinal: ${receipt.purgedAtOrdinal}`,
    `  initiator: ${receipt.initiator}`,
    '',
    pc.bold('Git history rewrite guidance'),
    '  The working-tree purge does not remove prior Git history.',
    `  The record first appeared at build ordinal ${receipt.firstCommittedOrdinal}.`,
    '  If repository history must also be rewritten, review these receipt-named paths:',
    ...receipt.affectedPaths.map((path) => `    ${path}`),
    '  Coordinate the history rewrite and any force-push with every repository consumer.',
  ].join('\n')
}

export function registerKnowledgeMaintainCommands(command: Command): void {
  command
    .command('drain')
    .description('Drain pending curation work or inspect its receipt chain')
    .option('--status', 'show curation receipts and remaining depth without draining')
    .option('--json', 'output the drain result as JSON')
    .addHelpText(
      'after',
      '\nagent-qa keeps three work lanes; this command drains the second only:\n'
      + '  run queue        test executions dispatched by the dashboard server\n'
      + '  curation queue   knowledge curation work drained by this command\n'
      + '  agent job queue  durable background agent jobs in .agent-qa/agent-jobs.db\n',
    )
    .action(async (options: DrainOptions, drainCommand: Command) => {
      let mask: MaskFn | undefined
      try {
        mask = declaredMaskFor(drainCommand)
        const paths = await resolveKnowledgePaths(drainCommand)
        if (options.status === true) {
          const status = drainStatus(paths)
          if (options.json === true) emitJson(mask, status)
          else emitHuman(mask, renderDrainStatus(status))
          return
        }

        await routeDrain(paths, options, mask)
      } catch (error) {
        reportDrainError(error, mask)
      }
    })

  command
    .command('rebuild-index')
    .description('Rebuild derived knowledge index projections')
    .option('--json', 'output the typed RebuildReport as masked JSON')
    .action(async (options: RebuildOptions, rebuildCommand: Command) => {
      let mask: MaskFn | undefined
      try {
        mask = declaredMaskFor(rebuildCommand)
        const paths = await resolveKnowledgePaths(rebuildCommand)
        const result = await withWriterLease('rebuild-index', paths.knowledgeRoot, mask, (writerAuthority) => (
          rebuildIndex({ knowledgeRoot: paths.knowledgeRoot, writerAuthority })
        ))
        if (result.kind === 'refused') return
        if (options.json === true) emitJson(mask, result.value)
        else emitHuman(mask, renderRebuildReport(result.value))
      } catch (error) {
        reportError('rebuild-index', error, mask)
      }
    })

  command
    .command('rollback')
    .description('Append inverse events for a curation job or provenance campaign')
    .option('--job <id>', 'rollback one curation job')
    .option('--from-build <n>', 'campaign lower build ordinal (inclusive)')
    .option('--to-build <n>', 'campaign upper build ordinal (inclusive)')
    .option('--anchor-cluster <key>', 'campaign canonical 64-hex anchor cluster key')
    .option('--origin-class <class>', 'campaign origin: user|agent-verified|agent-observed|import')
    .option('--json', 'output the typed RollbackReport as masked JSON')
    .action(async (options: RollbackOptions, rollbackCommand: Command) => {
      let mask: MaskFn | undefined
      try {
        mask = declaredMaskFor(rollbackCommand)
        const selector = rollbackSelector(options)
        const paths = await resolveKnowledgePaths(rollbackCommand)
        // Running the command is the intent (Phase 432 D-14). The preview is still resolved and
        // shown outside the lease, and the lease rechecks it before the first write.
        const previewInput = rollbackInput(selector, paths, 0)
        const previewAffected = resolveRollbackAffectedSet(previewInput)
        const previewFingerprint = rollbackPreviewFingerprint(previewAffected)
        emitHuman(mask, renderRollbackPreview(previewAffected), previewStream(options.json === true))

        const leaseResult = await withWriterLease(
          'rollback',
          paths.knowledgeRoot,
          mask,
          async (writerAuthority): Promise<RollbackExecutionOutcome> => {
            const affected = resolveRollbackAffectedSet(previewInput)
            assertPreviewUnchanged(
              'rollback',
              previewFingerprint,
              rollbackPreviewFingerprint(affected),
            )
            const resolvedAtOrdinal = await rollbackOrdinal(paths, affected, writerAuthority)
            const input = rollbackInput(
              selector,
              paths,
              resolvedAtOrdinal,
              writerAuthority,
              rollbackPreviewFingerprint(affected),
            )
            const report = selector.kind === 'job'
              ? rollbackCurationJob(input as RollbackCurationJobInput)
              : rollbackCampaign(input as RollbackCampaignInput)
            return { kind: 'completed', report }
          },
        )
        if (leaseResult.kind === 'refused') return
        if (options.json === true) emitJson(mask, leaseResult.value.report)
        else emitHuman(mask, renderRollbackReport(leaseResult.value.report))
      } catch (error) {
        reportError('rollback', error, mask)
      }
    })

  command
    .command('purge')
    .description('Irreversibly purge a knowledge record from local store surfaces')
    .argument('<record-id>', 'record id to purge')
    .option('--json', 'output the typed PurgeReceipt as masked JSON')
    .action(async (recordIdValue: string, options: PurgeOptions, purgeCommand: Command) => {
      let mask: MaskFn | undefined
      try {
        const purgeMask = declaredMaskFor(purgeCommand)
        mask = purgeMask
        const recordId = asRecordId(recordIdValue)
        const paths = await resolveKnowledgePaths(purgeCommand)
        // The explicit record id is the whole selection (Phase 432 D-14): no repeated id, no
        // prompt. A target that changes between this preview and the lease is refused below.
        const preview = resolvePurgeAffectedSet({
          knowledgeRoot: paths.knowledgeRoot,
          recordId,
        })
        const previewFingerprint = purgeAffectedSetFingerprint(preview)
        emitHuman(mask, renderPurgePreview(preview), previewStream(options.json === true))

        const leaseResult = await withWriterLease(
          'purge',
          paths.knowledgeRoot,
          mask,
          async (writerAuthority): Promise<PurgeExecutionOutcome> => {
            const underLeaseAffectedSet = resolvePurgeAffectedSet({
              knowledgeRoot: paths.knowledgeRoot,
              recordId,
            })
            const underLeaseFingerprint = purgeAffectedSetFingerprint(underLeaseAffectedSet)
            assertPreviewUnchanged(
              'purge',
              previewFingerprint,
              underLeaseFingerprint,
            )
            const purgedAtOrdinal = await purgeOrdinal(
              paths,
              underLeaseAffectedSet,
              writerAuthority,
            )
            const outcome = purgeRecord({
              knowledgeRoot: paths.knowledgeRoot,
              recordId,
              initiator: `cli:${userInfo().username}`,
              writerAuthority,
              expectedAffectedSetFingerprint: underLeaseFingerprint,
              ...(purgedAtOrdinal === undefined ? {} : { purgedAtOrdinal }),
            })
            switch (outcome.kind) {
              case 'purged':
                return { kind: 'completed', receipt: outcome.receipt, alreadyPurged: false }
              case 'already-purged':
                return { kind: 'completed', receipt: outcome.receipt, alreadyPurged: true }
              case 'not-found':
                emitHuman(
                  purgeMask,
                  pc.red(`knowledge purge: error [not-found]: record ${recordId} was not found`),
                  'stderr',
                )
                process.exitCode = 1
                return { kind: 'failed' }
            }
          },
        )
        if (leaseResult.kind === 'refused' || leaseResult.value.kind !== 'completed') return
        if (options.json === true) emitJson(mask, leaseResult.value.receipt)
        else emitHuman(
          mask,
          renderPurgeReceipt(
            leaseResult.value.receipt,
            leaseResult.value.alreadyPurged,
          ),
        )
      } catch (error) {
        reportError('purge', error, mask)
      }
    })
}
