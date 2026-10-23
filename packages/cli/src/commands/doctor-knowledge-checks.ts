/**
 * The four knowledge trust rows `agent-qa doctor` prints (407 TRST-02, 416 D-19).
 *
 * WHY THESE THREE EXIST. Before this, none of doctor's rows touched the knowledge substrate at
 * all: a daemon whose embedder worker exits on every boot could run a whole session with no
 * embedder and nothing on the surface said so. `Knowledge store` reports the index face,
 * `Embedder` reports the capability outcome, and `Retrieval rung` reports the fold of the two —
 * the one word the run banner would show for the same host.
 *
 * STATUS DISCIPLINE IS THE LOAD-BEARING PART (D-19). `doctor` sets exit code 1 on a `fail`, so a
 * `fail` for a rung REACHED BY DESIGN would red the CI gate of every deliberately-degraded
 * install — the static floor is the no-budget escape hatch and `lexical-only` means the floor was
 * explicitly disabled. `fail` is therefore reserved for a subsystem that ERRORED: an index file
 * that is present and will not open, or a daemon whose embedder worker never registered. The
 * `Retrieval rung` row can never be `fail` at all; degraded is not failed.
 *
 * ONE FOLD, NOT THREE (D-17). All three rows read `foldRetrievalRung` from knowledge-local — the
 * same function the runner's evidence recorder and the dashboard banner read. Three surfaces
 * folding the same two axes independently is exactly how a banner and a doctor row come to
 * disagree about one machine.
 *
 * THE IMPORT ROUTE IS NOT INCIDENTAL. 385 D-14/SC5 gives knowledge-local's writer entry exactly
 * ONE importer workspace-wide, enforced at file granularity by the `reader-carveout` arch rule.
 * The probes below therefore arrive through `LOCAL_KNOWLEDGE_PROBES`, bound at that one legal
 * composition edge, rather than by naming knowledge-local from the CLI.
 */
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type RecordedRetrievalRung,
  type RetrievalRungReason,
  type PromotionJudgePosture,
} from '@vostride/agent-qa-schema'
import {
  LOCAL_KNOWLEDGE_PROBES,
  type AcquireEmbedderOutcome,
  type IndexFace,
  type ReadEmbedderWorkerRegistrationOutcome,
  type ReadWriterLeaseOutcome,
} from '@vostride/agent-qa-agent-local'

import { buildTrustPriorsResolver, formatTrustPriorDisclosure, type TrustPriorsResolution } from '../curation/trust-priors.js'
import { resolveRawConfigKnowledgeRoot } from '../config.js'
import { buildPromotionPostureResolver, type PromotionPostureResolution } from '../curation/promotion-posture.js'
import { LOCAL_CURATION_CAPABILITIES, latestBuildOrdinal } from '@vostride/agent-qa-agent-local'
import { createReplayGatePortForHost } from '../gates/replay-gate-host.js'
// From the module that OWNS the posture record, never from `post-run-tail.ts`: that file names
// the terminal host composition and the daemon client, and importing it here would pull both into
// every doctor invocation (the host-to-host import trap 422-09 recorded).
import { MISDIRECTION_POSTURE_BOUND_AT_HOST } from '../curation/misdirection-run-state.js'
import { readDaemonEventLedger, type DaemonEvent } from '../daemon/events.js'
import { processIsAlive, readDaemonRegistration } from '../daemon/registration.js'
import type { CheckResult, DoctorCheck } from './doctor.js'

const { foldRetrievalRung, indexDbPath } = LOCAL_KNOWLEDGE_PROBES

/**
 * The closed reason vocabulary rendered for a person, as a TOTAL map rather than a switch with a
 * default: a new `RetrievalRungReason` becomes a compile error here instead of a blank cause
 * printed after an em dash. 407-11 pins this table equal to the dashboard's copy of it — the two
 * surfaces share no UI module, so the labels are defined twice by necessity and asserted equal.
 *
 * 423 D-22: doctor is CURRENT health, so its rows only ever print the three live index causes
 * (not built, locked, corrupt). `index-unavailable` keeps a label solely because the table is
 * shared with recorded runs, where it means a pre-423 scan whose cause was never recorded.
 */
export const RUNG_CAUSE_LABELS: Record<RetrievalRungReason, string> = {
  'native-runtime-unavailable': 'native ONNX runtime unavailable',
  'profile-unresolved': 'embedder profile unresolved (deferred)',
  'model-not-downloaded': 'embedding model not downloaded',
  'embedder-load-failed': 'embedder failed to load',
  'index-unavailable': 'knowledge index unavailable (cause not recorded), scanning bundles',
  'floor-disabled': 'static floor disabled',
  'profile-static-configured': 'static profile configured',
  'index-not-built': 'knowledge index not built yet, scanning bundles',
  'index-locked': 'knowledge index locked by another process, scanning bundles',
  'index-corrupt': 'knowledge index corrupt, rebuild requested, scanning bundles',
}

/** D-16: no knowledge reader bound is not a rung. Every row still prints; none is omitted. */
export const NO_KNOWLEDGE_ROOT_MESSAGE = 'no knowledge root configured'

/**
 * The 399 wording of record (D-20). The folded failure is named by its CAUSE, not its symptom,
 * and the raw worker stderr that carries it never reaches the terminal (T-407-18).
 */
export const EMBEDDER_WORKER_NOT_REGISTERED_TEXT = 'daemon embedder worker not registered: could not resolve profile (deferred)'

const STORE_FIX_PREFIX = 'Rebuild the index with `agent-qa knowledge rebuild-index`, or remove the corrupt file at'
export const EMBEDDER_PROFILE_FIX =
  'v2 does not download the embedding model, and knowledge search works without it. Stop the daemon with `npx agent-qa daemon stop` to clear this row.'
export const EMBEDDER_WORKER_FIX =
  'The daemon starts its embedder worker when a run needs it, so an idle daemon shows this row. Stop the daemon with `npx agent-qa daemon stop` to clear it.'
export const EMBEDDER_CRASH_FIX =
  'The daemon\'s embedder worker exited with an error, and knowledge search works without it. Stop the daemon with `npx agent-qa daemon stop` to clear this row.'
export const EMBEDDER_NO_DAEMON_FIX =
  'No agent-qa daemon is running, so `npx agent-qa daemon stop` cannot clear this row: the knowledge writer lease belongs to another agent-qa process, or to one that did not stop cleanly. Once no agent-qa command is running, start `npx agent-qa daemon`, which takes a stale lease over, and stop it with `npx agent-qa daemon stop`.'
const RUNG_FIX = 'Run the checks above; the rung follows from the store and embedder rows.'
const LEARNING_MODE_FIX =
  'Replay gating is not bound on this host. Seed the eval root and commit a measured noise floor with `agent-qa eval floor --commit`; repair any reported posture refusal.'

/** The fold's index axis held OPEN, so the `Embedder` row reads its own subject's cause. */
const INDEX_PRESENT: IndexFace = { source: 'index' }

const SKIPPED: CheckResult = { status: 'skip', message: NO_KNOWLEDGE_ROOT_MESSAGE }

export interface KnowledgeCheckProbes {
  buildPromotionPosture?: typeof buildPromotionPostureResolver
  classifyIndexFace?: (knowledgeRoot: string, options: { inspectCheckpointedImmutably: true }) => IndexFace
  resolveEmbedderCapability?: (options: {
    preferredProfile: EmbeddingProfile
    allowDownload: false
    agentQaRoot: string
  }) => Promise<AcquireEmbedderOutcome>
  readWriterLease?: (knowledgeRoot: string) => ReadWriterLeaseOutcome
  readEmbedderWorkerRegistration?: (agentQaRoot: string) => ReadEmbedderWorkerRegistrationOutcome
  readDaemonEventLedger?: (agentQaRoot: string) => { events: readonly DaemonEvent[] }
  daemonLive?: (agentQaRoot: string) => boolean
}

export interface CreateKnowledgeChecksInput {
  /** The RAW config doctor loaded; `null` means it could not be read at all. */
  config: Record<string, unknown> | null
  configPath: string
  preferredProfile?: EmbeddingProfile
  probes?: KnowledgeCheckProbes
}

interface DaemonHalf {
  registration: ReadEmbedderWorkerRegistrationOutcome
  lastExit: DaemonEvent | undefined
  live: boolean
}

interface KnowledgeProbe {
  trustPriors: TrustPriorsResolution
  learning: PromotionPostureResolution
  face: IndexFace
  embedder: AcquireEmbedderOutcome
  /** The fold over BOTH axes — the word the banner would show. */
  rung: RecordedRetrievalRung
  /** The same fold with the index axis held open, so the embedder row names its own cause. */
  embedderRung: RecordedRetrievalRung
  /** Consulted only when a daemon lease is live; `undefined` means nobody holds authority. */
  daemon: DaemonHalf | undefined
}

interface KnowledgeCheckContext {
  agentQaRoot: string
  knowledgeRoot: string | null
  relativeRoot: string
  relativeIndexPath: string
  priors: () => TrustPriorsResolution
  panel: () => Promise<string>
  /**
   * The 422 adversarial half of the Learning mode row, memoised beside the panel half.
   *
   * It takes the eval-root predicate rather than resolving one, because the row it joins has
   * already answered that question and a second answer could disagree with the first.
   */
  adversarial: (evalRootPresent: boolean) => Promise<{ text: string; unreadable: boolean }>
  probe: () => Promise<KnowledgeProbe>
}

/**
 * D-16/D-19's "no knowledge root configured" predicate.
 *
 * A VALIDATED config always materialises `knowledge.dir` (the schema defaults it), and doctor
 * loads the RAW config — so "the key is absent" cannot be the test. The two facts that can make
 * this host have no store are: the config could not be read or named a root at all, or the
 * directory it names is not on disk.
 */
function resolveKnowledgeRootOnDisk(
  config: Record<string, unknown> | null,
  configPath: string,
): string | null {
  const root = resolveRawConfigKnowledgeRoot(config, configPath)
  if (root === null) return null
  return existsSync(root) ? root : null
}

/**
 * Printed relative to the cwd so it stays short and copy-pasteable — but its length is NOT
 * bounded: a deeper project, or a run from the filesystem root, widens it without limit.
 *
 * This docstring used to claim the reason WORD was the only variable-length segment of a row.
 * The 407 UAT measured that false: at `COLUMNS=80` the `Knowledge store` FAIL row came to 113
 * columns with a 7-character reason word, and the reason vocabulary is a closed four-value enum
 * capped at 14 characters (`absent|corrupt|locked|schema-version`), so the length came from the
 * PATH. What bounds a row now is the RENDERER — `formatCheckRow` in `doctor.ts` — which is where
 * the budget belongs, because no message length can overrun a width the renderer enforces.
 */
function displayPath(absolute: string): string {
  return relative(process.cwd(), absolute) || '.'
}

function lastEmbedderWorkerExit(events: readonly DaemonEvent[]): DaemonEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'embedder-worker-exit') return event
  }
  return undefined
}

// The first two checks `daemon stop` makes: a parsed registration whose pid is alive.
function registeredDaemonLive(agentQaRoot: string): boolean {
  const outcome = readDaemonRegistration(agentQaRoot)
  return outcome.kind === 'parsed' && processIsAlive(outcome.registration.pid)
}

function stringField(event: DaemonEvent | undefined, field: string): string | undefined {
  const value = event?.[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * `reason` is absent IFF the rung is `memidex`, and every caller below has already returned on
 * that arm. The fallback exists only to keep the lookup total; no row can reach it.
 */
function causeLabel(rung: RecordedRetrievalRung): string {
  return RUNG_CAUSE_LABELS[rung.reason ?? 'index-unavailable']
}

function createKnowledgeStoreCheck(context: KnowledgeCheckContext): DoctorCheck {
  return {
    name: 'Knowledge store',
    fixInstructions: `${STORE_FIX_PREFIX} ${context.relativeIndexPath} and re-run.`,
    check: async (): Promise<CheckResult> => {
      if (context.knowledgeRoot === null) return SKIPPED
      const { face } = await context.probe()
      if (face.source === 'index') {
        return { status: 'pass', message: `index open at ${context.relativeRoot} (memidex)` }
      }
      // Present-but-unopenable is the ERRORED subsystem D-19 reserves `fail` for. The reason WORD
      // goes to the terminal; the driver's own text (which quotes paths) stays out of it (T-407-18).
      if (face.filePresent) {
        return {
          status: 'fail',
          message: `index at ${context.relativeIndexPath} could not be opened: ${face.reason}`,
        }
      }
      return {
        status: 'warn',
        message: `no index at ${context.relativeRoot} — scanning bundles (${RUNG_CAUSE_LABELS['index-not-built']})`,
      }
    },
  }
}

function createEmbedderCheck(context: KnowledgeCheckContext): DoctorCheck {
  let failState: 'profile' | 'worker' | 'crash' | 'no-daemon' = 'worker'
  const fixes = {
    profile: EMBEDDER_PROFILE_FIX,
    worker: EMBEDDER_WORKER_FIX,
    crash: EMBEDDER_CRASH_FIX,
    'no-daemon': EMBEDDER_NO_DAEMON_FIX,
  }
  return {
    name: 'Embedder',
    get fixInstructions() {
      return fixes[failState]
    },
    check: async (): Promise<CheckResult> => {
      if (context.knowledgeRoot === null) return SKIPPED
      const { embedder, embedderRung, daemon } = await context.probe()

      // D-20's second half, consulted FIRST when it exists: an in-process probe answers "what can
      // this process do", which is not the same question as "does the standing daemon actually
      // have an embedder". A host can resolve native in-process while the daemon has been serving
      // every run of the day with none.
      if (daemon !== undefined && daemon.registration.kind !== 'parsed') {
        const stderr = stringField(daemon.lastExit, 'stderr') ?? ''
        const exitReason = stringField(daemon.lastExit, 'reason')
        if (stderr.includes('could not resolve profile')) {
          failState = daemon.live ? 'profile' : 'no-daemon'
          return { status: 'fail', message: EMBEDDER_WORKER_NOT_REGISTERED_TEXT }
        }
        failState = !daemon.live
          ? 'no-daemon'
          : exitReason === 'crash' || exitReason === 'start-error' ? 'crash' : 'worker'
        const reason = exitReason ?? 'no registration published'
        return { status: 'fail', message: `embedder worker failed to start: ${reason}` }
      }

      if (embedder.kind === 'ready' && embedder.rung === 'native') {
        return { status: 'pass', message: `native (${embedder.profile.model_id})` }
      }
      const label = causeLabel(embedderRung)
      if (embedderRung.rung === 'static-floor') {
        return { status: 'warn', message: `static floor — ${label}` }
      }
      return { status: 'warn', message: `none — ${label}` }
    },
  }
}

function createRetrievalRungCheck(context: KnowledgeCheckContext): DoctorCheck {
  return {
    name: 'Retrieval rung',
    fixInstructions: RUNG_FIX,
    check: async (): Promise<CheckResult> => {
      if (context.knowledgeRoot === null) return SKIPPED
      const { rung } = await context.probe()
      // D-19: never a failure. A lower rung is a rung reached by design, and this row is the one
      // that would otherwise red the CI gate of every host running on the floor on purpose.
      if (rung.rung === 'memidex') return { status: 'pass', message: 'memidex' }
      return { status: 'warn', message: `${rung.rung} — ${causeLabel(rung)}` }
    },
  }
}

function createLearningModeCheck(context: KnowledgeCheckContext): DoctorCheck {
  const check = createLearningAvailabilityCheck(context)
  return { ...check,
    get fixInstructions() {
      return context.priors().kind === 'refused'
        ? `Inspect the calibration marker and its referenced revisions in the selected committed eval root ${displayPath(resolve(dirname(context.agentQaRoot), 'agent-qa-eval'))} without changing them. Follow https://vostride.com/docs/agent-qa/self-improvement/evals#if-calibration-is-refused; marker replacement is a separate explicit operator action.`
        : check.fixInstructions
    },
    check: async () => {
    const probe = context.knowledgeRoot === null ? undefined : await context.probe()
    const priors = probe === undefined ? context.priors() : probe.trustPriors
    const row = await check.check()
    // 422-27: absent eval roots still disclose the build's circularity binding, without
    // consulting the probe or staging stores. A host with no knowledge root keeps its
    // existing skipped message; it has no learning subsystem to describe.
    const evalRootPresent = probe !== undefined && probe.learning.kind !== 'no-eval-root'
    const disclosure = priors.kind === 'refused'
      ? 'label calibration: invalid or unavailable; trust priors: unavailable'
      : `${priors.calibration}; ${formatTrustPriorDisclosure(priors.disclosure)}`
    const adversarial = context.knowledgeRoot === null
      ? { text: '', unreadable: false }
      : await context.adversarial(evalRootPresent)
    // Two independent escalations onto the SAME `skip` carve-out the prior escalation already
    // uses. A tampered adversarial staging store is exactly D-19's ERRORED subsystem — present
    // and refusing to be read — and a `warn` for a rung reached by design must not be allowed to
    // mask it: the two say different things and the more serious one wins. `skip` is preserved
    // because a host with no knowledge root has nothing to report either way, which is the same
    // reason the refused-prior arm preserves it.
    const status = row.status !== 'skip' && (priors.kind === 'refused' || adversarial.unreadable)
      ? 'fail'
      : row.status
    return { ...row, status,
      message: `${row.message}; ${disclosure}${await context.panel()}${adversarial.text}` }
  } }
}

/**
 * The adversarial half of the Learning mode row (422 D-09 / D-14 / D-19).
 *
 * THREE FACTS, EACH FROM ITS OWN SOURCE, AND NONE OF THEM INFERRED FROM AN ABSENCE:
 *
 *   1. The PROBE GAP. Resolved exactly as `refreshAdversarialSplit` resolves it — local config,
 *      local credential presence, local family arithmetic, ZERO provider calls — so the row
 *      names the same closed `NoProbeModelReason` the staging report would. A host with no
 *      declared pool short-circuits to `panel-not-configured` without resolving a session at
 *      all, which is the first arm `resolveAdversarialProbeCapability` takes for the same reason.
 *   2. The STAGED REPORT. The staging root's own manifests plus the durable refresh records
 *      behind them. A root that holds no batch for any product has NOT staged zero — nothing
 *      recorded a refresh — and the row says `not recorded`, never `staged 0`.
 *   3. The CIRCULARITY BACKING, which is a fact about this BUILD rather than about this host:
 *      see MISDIRECTION_POSTURE_BOUND_AT_HOST. Both production hosts bind the recorded posture,
 *      and agent-local forwards it to analysis: D-19's absent-root declaration is applied while
 *      broken and unrecorded postures stay fail-closed. The row names that shipped binding.
 *
 * A READ THAT FAILED IS A ROW THAT SAYS SO. `listStagedAdversarial` refuses a tampered batch by
 * throwing, and a diagnostic that swallowed that into `not recorded` would report healthy about a
 * subsystem it could not read — which is the one thing `doctor` may never do.
 *
 * Credentials never reach it: the capability's `entries` diagnostics are masked and are not
 * rendered here at all, and no seed id, cassette id, digest or authored text is printed.
 */
async function doctorAdversarialDisclosure(
  input: CreateKnowledgeChecksInput,
  agentQaRoot: string,
  evalRootPresent: boolean,
): Promise<{ text: string; unreadable: boolean }> {
  const backing = MISDIRECTION_POSTURE_BOUND_AT_HOST
    ? 'circularity backing: recorded posture applied'
    : 'circularity backing: fail-closed eval-root (no host binds the recorded posture)'
  if (!evalRootPresent) return { text: `; ${backing}`, unreadable: false }
  const staged = await readStagedAdversarialSummary(agentQaRoot)
  return {
    text: `; adversarial: ${await probeGapDisclosure(input)}; ${staged.text}; ${backing}`,
    unreadable: staged.unreadable,
  }
}

/**
 * The probe gap, resolved locally and for free (D-09).
 *
 * The empty-pool arm short-circuits BEFORE any session resolution, exactly as
 * `resolveAdversarialProbeCapability` does — a host with no declared judge pool learns its gap
 * without touching a registry, a credential store or the filesystem, and a doctor row must not be
 * the one surface that pays for an answer everything else gets free.
 *
 * A resolution that THREW is `not determined` rather than a reason word. The three reasons are a
 * closed vocabulary describing a host that was successfully inspected; borrowing one of them for
 * an inspection that failed would put a diagnosis where there is none.
 */
async function probeGapDisclosure(input: CreateKnowledgeChecksInput): Promise<string> {
  try {
    const { selectedEvalJudgeNames, resolveEvalSession } =
      await import('../eval-session-composition.js')
    const evalConfig = (input.config?.eval ?? {}) as import('../eval-session-composition.js').EvalCliConfig
    if (selectedEvalJudgeNames(evalConfig).length === 0) {
      return 'no-probe-model: panel-not-configured'
    }
    const session = await resolveEvalSession({ configPath: input.configPath, keyOnly: true })
    // The preflight masks its diagnostics; a key-only session cannot, so it takes the declared mask.
    session.mask = (await import('../composition/declared-secrets.js')).createDeclaredSecretMask(input.configPath).mask
    const { resolveAdversarialProbeCapability } =
      await import('../adversarial-probe-preflight.js')
    const capability = await resolveAdversarialProbeCapability(session)
    return capability.kind === 'probe-author'
      ? 'probe author available'
      : `no-probe-model: ${capability.reason}`
  } catch {
    return 'probe author not determined'
  }
}

/**
 * The staged report, counted from what is actually on disk (D-14).
 *
 * PRODUCTS COME FROM THE STAGING ROOT ITSELF, not from a configured list: a product that never
 * staged a batch has published no refresh record either, and asking for one by name would turn an
 * empty answer into a count. A root with no batch at all is `not recorded` — not `staged 0`, which
 * would claim a refresh ran and derived nothing.
 *
 * A THROW IS REPORTED, NEVER SWALLOWED. `listStagedAdversarial` refuses a batch whose manifest
 * digest does not recompute and `readAdversarialRefreshRecords` refuses a record whose content
 * address does not match its file name; both are tamper checks, and a diagnostic that answered
 * `not recorded` over one would report health about a subsystem it could not read.
 *
 * BOTH READERS ARRIVE BY DEFERRED IMPORT THROUGH `eval-session-composition.ts` — the ONE CLI file
 * the surface-firewall ledger clears for `@vostride/agent-qa-eval-local`, and a ledger that only
 * ever shrinks. It is also what keeps the eval composition graph out of every `agent-qa doctor`
 * invocation, which is the same cost `doctorPanelDisclosure` defers for.
 */
async function readStagedAdversarialSummary(
  agentQaRoot: string,
): Promise<{ text: string; unreadable: boolean }> {
  let listStagedAdversarial: typeof import('../eval-session-composition.js')['listStagedAdversarial']
  let readAdversarialRefreshRecords:
    typeof import('../eval-session-composition.js')['readAdversarialRefreshRecords']
  let batches: ReturnType<typeof listStagedAdversarial>
  try {
    ({ listStagedAdversarial, readAdversarialRefreshRecords } =
      await import('../eval-session-composition.js'))
    batches = listStagedAdversarial({ agentQaRoot })
  } catch {
    return { text: 'staged unreadable', unreadable: true }
  }
  if (batches.length === 0) return { text: 'staged not recorded', unreadable: false }
  const products = [...new Set(batches.map(batch => batch.manifest.product))].sort()
  const cases = batches.reduce((sum, batch) => sum + batch.manifest.cases.length, 0)
  const tuples = { derived: 0, refused: 0, inapplicable: 0 }
  let refreshes = 0
  let deferred = 0
  try {
    for (const product of products) {
      for (const record of readAdversarialRefreshRecords({ agentQaRoot, product })) {
        refreshes += 1
        deferred += record.excessSeeds
        for (const tuple of record.tuples) tuples[tuple.outcome] += 1
      }
    }
  } catch {
    return { text: 'staged unreadable', unreadable: true }
  }
  return {
    text: `staged ${cases} in ${batches.length} batch(es) over ${products.length} product(s); `
      + `refreshes ${refreshes} (derived ${tuples.derived}, refused ${tuples.refused}, `
      + `inapplicable ${tuples.inapplicable}, cap-deferred ${deferred})`,
    unreadable: false,
  }
}

/** Independent of floor and knowledge availability; presence is local, never authentication.
 * Only family vocabulary and guarded summary values reach the row, never binding DATA. */
async function doctorPanelDisclosure(input: CreateKnowledgeChecksInput): Promise<string> {
  const unavailable = '; judge panel: calibration: uncalibrated n=0 (unavailable)'
  try {
    const { selectedEvalJudgeNames, resolveEvalSession, preflightJudgePanel,
      computeReplayProfileFingerprintFor,
      projectMatcherConfigContract, readJudgeCalibration,
    } = await import('../eval-session-composition.js')
    const names = selectedEvalJudgeNames((input.config?.eval ?? {}) as import('../eval-session-composition.js').EvalCliConfig)
    if (names.length === 0) return '; judge panel: capability gap: panel-not-configured'
    if (names.length === 1) return ''
    const session = await resolveEvalSession({ configPath: input.configPath, keyOnly: true })
    // Key-only resolution avoids auth plugins and execution setup; the preflight masks its
    // diagnostics with the declared secrets.
    session.mask = (await import('../composition/declared-secrets.js')).createDeclaredSecretMask(input.configPath).mask
    const preflight = await preflightJudgePanel(session)
    const families = preflight.entries.map(entry => entry.families.join('+') || 'unknown').join(', ')
    const prefix = `; judge panel: ${names.length} members (${families}) · calibration: `
    if (preflight.kind === 'capability-gap') return `${prefix}capability gap: ${preflight.reason}`
    const replayProfile = preflight.replayProfile
    const fingerprint = computeReplayProfileFingerprintFor({ profile: replayProfile,
      seedPolicy: 'declared' })
    const read = readJudgeCalibration({ committedRoot: resolve(session.configDir, 'agent-qa-eval'),
      agentQaRoot: resolve(session.configDir, '.agent-qa'), identity: preflight.identity,
      profile: { plannerModelId: replayProfile.model, fingerprint,
        matcherVersion: projectMatcherConfigContract().version,
        judgeModelId: preflight.identity.judgeModelId, judgeVersion: preflight.identity.judgeVersion } })
    if (read.kind !== 'loaded') return `${prefix}uncalibrated n=0 (unavailable)`
    const artifact = read.artifact
    return prefix + (artifact.status === 'capability-gap' ? `capability gap: ${artifact.reason}`
      : `${artifact.status} n=${artifact.n}`)
  } catch { return unavailable }
}

function createLearningAvailabilityCheck(context: KnowledgeCheckContext): DoctorCheck {
  return {
    name: 'Learning mode',
    fixInstructions: LEARNING_MODE_FIX,
    check: async (): Promise<CheckResult> => {
      if (context.knowledgeRoot === null) return SKIPPED
      const { learning } = await context.probe()
      if (learning.kind === 'no-eval-root') {
        return { status: 'warn', message: `deterministic-verdict-floor — no eval root at ${displayPath(learning.committedRoot)}` }
      }
      if (learning.kind === 'no-noise-floor') {
        return { status: 'warn', message: `deterministic-verdict-floor — eval root at ${displayPath(learning.committedRoot)} has no noise floor yet` }
      }
      if (learning.kind === 'unavailable') {
        const panel = learning.judge?.panelSize === undefined ? '' : `; judge ${judgeLabelOf(learning.judge)}`
        return { status: 'fail', message: `posture-unavailable — ${learningRefusalLabel(learning.refusals[0])}${panel}` }
      }
      const { replayGateAvailable, judge, canary } = learning.host
      const judgeLabel = judgeLabelOf(judge)
      if (replayGateAvailable) {
        const evidence = canary.kind === 'provided' ? canary.attributedRows ?? 'not reported' : 'none'
        // Reuse the tail's validated reader and completed-run census; never guess old receipts.
        const { listCompletedRunDirs, readCurationTailReceipt } = await import('../curation/curation-tail.js')
        const totals = { rideAlong: 0, capExceeded: 0, staged: 0 }
        for (const dir of listCompletedRunDirs(context.agentQaRoot)) {
          const receipt = readCurationTailReceipt(dir)
          if (receipt === undefined) continue
          totals.rideAlong += receipt.canary.rideAlongUncredited
          totals.capExceeded += receipt.canary.ablationCapExceeded
          totals.staged += receipt.canary.staged
        }
        const shares = learning.host.lowerTrustShares
          .map(({ product, active, lowerTrust }) => `${lowerTrust}/${active} active in ${product}`)
          .join(', ') || 'none'
        return {
          status: 'pass',
          message: `gated (Gate 1 bound; judge ${judgeLabel}; canary evidence ${evidence}; ride-along ${totals.rideAlong}; cap-exceeded ${totals.capExceeded}; lower-trust ${shares}; staged ${totals.staged})`,
        }
      }
      if (judge.reason === 'no-eligible-judge') {
        return {
          status: 'warn',
          message: `deterministic-verdict-floor — no replay gate bound; configured judge ${judgeLabel}`,
        }
      }
      return {
        status: 'warn',
        message: judge.reason === 'no-judge-configured'
          ? 'deterministic-verdict-floor — no replay gate bound, no judge configured'
          : `deterministic-verdict-floor — no replay gate bound; judge ${judgeLabel} configured`,
      }
    },
  }
}

/** Copy the complete declared family list; never infer an eligible subset for display. */
function judgeLabelOf(judge: PromotionJudgePosture): string {
  if (judge.reason === 'no-eligible-judge' && judge.panelSize !== undefined) {
    const families = judge.members?.map(member => member.judgeFamily || 'unknown').join(', ') ?? 'unknown'
    return `ineligible (panel: ${families})`
  }
  return judge.judgeFamily ?? (judge.reason === 'no-judge-configured' ? 'none'
    : judge.reason === 'no-eligible-judge' ? 'ineligible' : 'not reported')
}

/** Refusals retain diagnostic detail internally; this row never echoes arbitrary input. */
function learningRefusalLabel(refusal: string | undefined): string {
  if (refusal?.startsWith('noise-floor: no artefact for profile ')) {
    return 'noise-floor: no artefact for the active profile'
  }
  if (refusal?.startsWith('noise-floor: no minimumGateSet value at ')) {
    return 'noise-floor: no minimumGateSet value'
  }
  return 'eval posture could not be resolved'
}

/**
 * The four rows, over ONE shared read-only probe.
 *
 * The probe is memoised because the rows are views of one host state:
 * probing per row could report an index face to the store row and a different one to the rung row
 * if a drain landed between them, which is the disagreement this whole design exists to prevent.
 * It is also lazy; an absent knowledge root probes only calibration disclosure.
 */
export function createKnowledgeChecks(
  input: CreateKnowledgeChecksInput,
): [DoctorCheck, DoctorCheck, DoctorCheck, DoctorCheck] {
  const knowledgeRoot = resolveKnowledgeRootOnDisk(input.config, input.configPath)
  const agentQaRoot = resolve(dirname(resolve(input.configPath)), '.agent-qa')
  const preferredProfile = input.preferredProfile ?? DEFAULT_EMBEDDING_PROFILE

  const probes = input.probes ?? {}
  const classify = probes.classifyIndexFace ?? LOCAL_KNOWLEDGE_PROBES.classifyIndexFace
  const capability = probes.resolveEmbedderCapability ?? LOCAL_KNOWLEDGE_PROBES.resolveEmbedderCapability
  const lease = probes.readWriterLease ?? LOCAL_KNOWLEDGE_PROBES.readWriterLease
  const registration =
    probes.readEmbedderWorkerRegistration ?? LOCAL_KNOWLEDGE_PROBES.readEmbedderWorkerRegistration
  const ledger = probes.readDaemonEventLedger ?? readDaemonEventLedger
  const daemonLive = probes.daemonLive ?? registeredDaemonLive
  const buildPosture = probes.buildPromotionPosture ?? buildPromotionPostureResolver

  let pending: Promise<KnowledgeProbe> | undefined
  let cachedPriors: TrustPriorsResolution | undefined
  let pendingPanel: Promise<string> | undefined
  let pendingAdversarial: Promise<{ text: string; unreadable: boolean }> | undefined
  const priors = () => cachedPriors ??= buildTrustPriorsResolver({ configPath: input.configPath, inspectCalibration: true })

  async function runProbe(root: string): Promise<KnowledgeProbe> {
    const trustPriors = priors()
    // Asking must not change the knowledge root: a checkpointed index is opened immutably, so the
    // probe creates no SQLite -wal/-shm beside it (quick 261002-hyg, 432-09 #5).
    const face = classify(root, { inspectCheckpointedImmutably: true })
    let learning: PromotionPostureResolution
    try {
      if (trustPriors.kind === 'refused') throw new Error(trustPriors.reason)
      const resolveTrustPriors = trustPriors.resolve
      learning = await buildPosture({ configPath: input.configPath,
        knowledgeRoot: root, agentQaRoot,
        canaryFacts: facts => LOCAL_CURATION_CAPABILITIES.readCanaryPostureFacts({ ...facts, resolveTrustPriors }),
        lowerTrustShares: facts => LOCAL_CURATION_CAPABILITIES.readLowerTrustShares({ ...facts, resolveTrustPriors }),
        currentBuildOrdinal: product => latestBuildOrdinal({ root: agentQaRoot, product }),
        replayGate: createReplayGatePortForHost({ configPath: input.configPath, agentQaRoot, resolveTrustPriors }),
      })
    } catch (error) {
      const refusals = [error instanceof Error ? error.message : String(error)]
      learning = {
        kind: 'unavailable',
        committedRoot: resolve(dirname(resolve(input.configPath)), 'agent-qa-eval'),
        refusals,
        resolve: () => ({ kind: 'unavailable', replayGateAvailable: false, refusals }),
      }
    }

    let embedder: AcquireEmbedderOutcome
    try {
      // `allowDownload: false` is not an option this surface offers: a probe that fetched a model
      // would CHANGE the answer by asking the question (T-407-19).
      embedder = await capability({ preferredProfile, allowDownload: false, agentQaRoot })
    } catch {
      embedder = { kind: 'deferred', reason: 'load-failure' }
    }

    let daemon: DaemonHalf | undefined
    if (lease(root).kind === 'parsed') {
      let events: readonly DaemonEvent[] = []
      try {
        events = ledger(agentQaRoot).events
      } catch {
        events = []
      }
      daemon = {
        registration: registration(agentQaRoot),
        lastExit: lastEmbedderWorkerExit(events),
        live: daemonLive(agentQaRoot),
      }
    }

    return {
      learning,
      trustPriors,
      face,
      embedder,
      rung: foldRetrievalRung(face, embedder, preferredProfile),
      embedderRung: foldRetrievalRung(INDEX_PRESENT, embedder, preferredProfile),
      daemon,
    }
  }

  const context: KnowledgeCheckContext = {
    agentQaRoot,
    knowledgeRoot,
    relativeRoot: knowledgeRoot === null ? '' : displayPath(knowledgeRoot),
    relativeIndexPath: knowledgeRoot === null ? '' : displayPath(indexDbPath(knowledgeRoot)),
    priors,
    panel: () => pendingPanel ??= doctorPanelDisclosure(input),
    adversarial: evalRootPresent =>
      pendingAdversarial ??= doctorAdversarialDisclosure(input, agentQaRoot, evalRootPresent),
    probe: () => {
      if (knowledgeRoot === null) throw new TypeError('no knowledge root to probe')
      pending ??= runProbe(knowledgeRoot)
      return pending
    },
  }

  return [
    createKnowledgeStoreCheck(context),
    createEmbedderCheck(context),
    createRetrievalRungCheck(context),
    createLearningModeCheck(context),
  ]
}
