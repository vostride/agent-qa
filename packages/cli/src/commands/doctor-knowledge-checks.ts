/**
 * The three knowledge rows `agent-qa doctor` prints. `Knowledge store` reports the index face,
 * `Embedder` reports the capability outcome, and `Retrieval rung` reports the fold of the two,
 * the word the run banner would show for the same host.
 *
 * `doctor` sets exit code 1 on a `fail`, so `fail` is reserved for a subsystem that errored: an
 * index file that is present and will not open, or a daemon whose embedder worker never
 * registered. A rung reached by design (the static floor, or `lexical-only` when the floor is
 * disabled) is a warning, and the `Retrieval rung` row is never `fail`.
 *
 * All three rows read `foldRetrievalRung` from knowledge-local, the same fold the runner's evidence
 * recorder and the dashboard banner read. The probes arrive through `LOCAL_KNOWLEDGE_PROBES`
 * because the `reader-carveout` arch rule allows knowledge-local's writer entry one importer.
 */
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type RecordedRetrievalRung,
  type RetrievalRungReason,
} from '@vostride/agent-qa-schema'
import {
  LOCAL_KNOWLEDGE_PROBES,
  type AcquireEmbedderOutcome,
  type IndexFace,
  type ReadEmbedderWorkerRegistrationOutcome,
  type ReadWriterLeaseOutcome,
} from '@vostride/agent-qa-agent-local'

import { resolveRawConfigKnowledgeRoot } from '../config.js'
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

/** The fold's index axis held OPEN, so the `Embedder` row reads its own subject's cause. */
const INDEX_PRESENT: IndexFace = { source: 'index' }

const SKIPPED: CheckResult = { status: 'skip', message: NO_KNOWLEDGE_ROOT_MESSAGE }

export interface KnowledgeCheckProbes {
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
  knowledgeRoot: string | null
  relativeRoot: string
  relativeIndexPath: string
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

/**
 * The three rows over one shared, lazy, memoised read-only probe, so every row sees the same host
 * state even if a drain lands between them.
 */
export function createKnowledgeChecks(
  input: CreateKnowledgeChecksInput,
): [DoctorCheck, DoctorCheck, DoctorCheck] {
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

  let pending: Promise<KnowledgeProbe> | undefined

  async function runProbe(root: string): Promise<KnowledgeProbe> {
    // Asking must not change the knowledge root: a checkpointed index is opened immutably, so the
    // probe creates no SQLite -wal/-shm beside it (quick 261002-hyg, 432-09 #5).
    const face = classify(root, { inspectCheckpointedImmutably: true })

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
      face,
      embedder,
      rung: foldRetrievalRung(face, embedder, preferredProfile),
      embedderRung: foldRetrievalRung(INDEX_PRESENT, embedder, preferredProfile),
      daemon,
    }
  }

  const context: KnowledgeCheckContext = {
    knowledgeRoot,
    relativeRoot: knowledgeRoot === null ? '' : displayPath(knowledgeRoot),
    relativeIndexPath: knowledgeRoot === null ? '' : displayPath(indexDbPath(knowledgeRoot)),
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
  ]
}
