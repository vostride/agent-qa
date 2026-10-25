// The post-verdict step the runner shell awaits (Phase 404 plan 01, D-09 / D-10 / D-11;
// plan 04, D-05 / D-08 / D-09).
//
// WHAT THIS FILE OWNS. Four things and no fifth:
//
//   1. `dispositionOf` — the D-09 DECISION FUNCTION. One total mapping from "what did the durable
//      enqueue and the writer lease say" to the posture `runFinished.disposition` publishes. It is
//      pure, it is the only place the three wire values are chosen, and it is total over the
//      probe's `kind` domain so a new arm cannot silently fall through to a value nobody picked.
//   2. THE ONE DURABLE `analyze-run` ENQUEUE IN THE REPOSITORY (2026-08-26, D-05). It used to live
//      in `commands/run.ts`'s tail, which meant it happened for the CLI door and for NO OTHER: a
//      dashboard, MCP, chat or daemon run reached a verdict and queued nothing, so LIFE-03's
//      posture clause was vacuous for every non-CLI run and a dashboard-only user read `pending`
//      forever. The shell awaits this step on EVERY door, so putting the enqueue here is what makes
//      runner.md §2.1 — "the session's lifecycle ends when the verdict is reached AND its curation
//      candidates are durably enqueued" — structurally true rather than true of one command.
//   3. THE ONE LEASE ACQUISITION BY THIS BOX. `acquireWriterLease` is called AT MOST ONCE here,
//      on the run's own knowledge root, and this file never calls it a second time for a run.
//
//      THAT IS NOT THE SAME CLAIM AS "at most once per process", and this header asserted the
//      stronger one until 2026-08-27 (WR-04). When the probe answers `held` or `refused` the plan
//      stays `none` and `takeAcquiredLease()` hands back `undefined` — at which point the PUMP
//      decides. `post-run-tail.ts`'s `drain()` runs its own `acquireWriterLease` on the
//      `handed === undefined` arm, unless the door asked it not to with `withoutLease: 'skip'`
//      (the `runs.start` door, 404 D-06). Laziness makes that arm MORE common rather than less:
//      every `handedOff`/`refused` run now reaches it, plus every run whose deferred acquire
//      loses the probe→acquire race this header documents below.
//
//      No two-holders defect follows, and the reason is structural rather than lucky: the arm
//      runs PRECISELY when this box acquired nothing, so the pump's consult is a first
//      acquisition and not a second. What is guaranteed is the thing Pitfall 3 is about — no
//      process ever holds two authorities for one run — not a call count.
//   4. THE HANDOFF BOX. What that acquisition produced leaves through `takeAcquiredLease()`, ONCE,
//      to whoever will actually pump the chain.
//
// THE ACQUISITION IS LAZY, AND THAT IS THE POINT (2026-08-26).
//
// `run()` DECIDES the disposition; it does not mutate the lease. The decision is taken from a
// NON-ACQUIRING read — `readWriterLease` + `deriveWriterLeaseFreshness`, the same pair
// `classifyDaemonRegistration` classifies a holder from — and the actual `acquireWriterLease` is
// deferred to `takeAcquiredLease()`, i.e. to the moment a pump asks for the authority.
//
// It was eager first, and eager was measurably wrong. The shell awaits this step on EVERY run,
// including the runs that end above the tail: `in-process-run-execution.ts` re-throws
// `produced.takeFrameworkError()` before `options.afterVerdict`, so a run that dies on "browser
// support is not installed" never reaches `postRunTail.drain({ takeLease: … })`. Acquiring at the
// verdict therefore minted an epoch and a lease file for a chain nobody was going to pump, and the
// no-leak backstop below then released it and printed `post-run lease released untaken` on stderr
// — on ORDINARY runs, which is how `run-parity.e2e.test.ts` caught it. Acquiring nothing costs
// nothing to release and has nothing to warn about: the step that has no pump now leaves the
// lease file exactly as it found it.
//
// WHAT IT DOES NOT OWN. It publishes nothing on the bus — the shell is the single owner of the
// terminal sequence (RESEARCH Pitfall 7), so this file returns a VALUE and the shell decides what
// to say about it. It pumps nothing: the chain drain, its budget and its chip emitter stay with
// `post-run-tail.ts`. It resolves no knowledge root of its own — the producer already resolved the
// root this run used, and a second `resolveKnowledgeRoot` here would be a second answer to "where
// does this run's knowledge live" (the exact class of defect `chainJobIdsForRun` is centralised
// against).
//
// THE FIVE ARMS OF `run()`, IN ORDER, AND WHY THE ORDER IS THE DESIGN (2026-08-26, plan 04):
//
//   (a) D-08 — a run carrying `gateRun: true` or `excludedFromOutcomes: true` enqueues NOTHING and
//       consults no lease. A `write_test` keep-filter probe would otherwise cost a strong-model
//       analysis per gate iteration, push draft evidence into curation, and produce chips about a
//       run nobody will ever open. `detached` with no warning: nothing went wrong.
//   (b) THE ENQUEUE, before the lease. The two are ordered rather than parallel because the lease
//       decision is a promise about draining work that must already EXIST — a `drained` posture
//       over an empty queue is a promise about nothing.
//   (c) An enqueue that FAILED ⇒ `detached` + `post-run-enqueue-failed`, and no lease consult at
//       all. Taking a lease to pump a chain that was never queued is the same empty promise from
//       the other side, and it would leave a lease held for a run with nothing to do.
//   (d) A host that SUPPLIED its own writer authority (the daemon door — Open Q2, Pitfall 8) reads
//       `drained` WITHOUT a second acquisition. A holder that calls `acquireWriterLease` is
//       answered `held` by ITSELF and would hand its own work off to nobody.
//   (e) `--detach` (D-09/Pitfall 8) skips the LEASE only — the enqueue above already ran. Detaching
//       asks this process not to SPEND itself on the work, never to forget the work exists.
//
// Anything else falls through to the 404-01 non-acquiring consult below.
//
// RESEARCH PITFALL 3 BY NAME — TWO LEASE HOLDERS IN ONE PROCESS. A process that holds the writer
// lease and calls `acquireWriterLease` again is answered `held` — by ITSELF — and would hand its
// own work off to nobody: chips never move and the claimed row is left claimed. That is why the
// acquisition happens here at most once and travels to the pump through ONE take, rather than
// each leg consulting the lease for itself. `takeAcquiredLease()` is take-ONCE for the same reason
// in the other direction: two callers each believing they hold the lease is the same defect
// wearing a different hat, and the second caller gets `undefined` instead of a duplicate
// authority.
//
// WHERE THE TAKE IS CALLED IS PART OF THE MITIGATION (2026-08-27, CR-01). Because taking is what
// acquires, a caller that evaluates `takeAcquiredLease()` as an ARGUMENT has minted the lease
// before the callee's first line — outside any `finally` the callee owns, and past the take-once
// flag the backstop below reads. The pump therefore takes it ITSELF, inside the try that releases;
// `post-run-tail.ts`'s `drain()` accepts a thunk for exactly this reason.
//
// WHAT LAZINESS COSTS, STATED. `drained` is the posture "nobody held this run's lease at the
// verdict, so this process will take it and pump" (D-09), and between the verdict and the pump's
// request a daemon may take it first. The pump then receives `undefined`, `drain()` falls back to
// its own consult, is answered `held`, and reports `handed-off` — the work still gets done by the
// holder, and the wire's `drained` is the posture that was true when it was published. D-09 already
// says the field is a posture and never a claim about what became of the chain; that is chip truth
// (`runs.postprocessing`). The reverse corner is the same size: an authority state that only the
// ACQUISITION can see refused (a mutation lock no contender can reclaim, or corrupt epoch bytes
// behind an absent lease file) reads `drained` on the wire and drains nothing. Both were already
// possible with the eager acquisition — a lease acquired at the verdict is no guarantee the pump
// runs — and neither is worth a stderr line on every ordinary run.
//
// Import discipline (FUNC-02): a CLI file may name only `agent`, `agent-local` and `schema` across
// package boundaries. The runner's port vocabulary therefore arrives through `agent-local`'s
// barrel, which re-exports it for exactly this hop, and the lease/daemon capabilities arrive
// through `LOCAL_DAEMON_CAPABILITIES` — the one composition edge that already publishes them.

import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import type {
  LocalAgentHost,
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
} from '@vostride/agent-qa-agent-local'
import { AnalyzeRunPayloadSchema } from '@vostride/agent-qa-schema'

import { composeCliLocalAgent } from '../composition/local-agent-host.js'
import { nudgeDaemon } from '../daemon/client.js'
import {
  completedRunHandoffPath,
  curationTailHandoffDigest,
  defaultCurationTailOperations,
  type CurationTailOperations,
  type CurationWriterAuthority,
} from './curation-tail.js'
import { resolvePostRunJobModel } from './post-run-tail.js'
import { readRunCanaryPolicy, writeRunCanaryPolicy } from './canary-run-state.js'
import { createCanaryAblationForHost } from '../gates/canary-ablation-host.js'
import { dirname, join, resolve } from 'node:path'
import { ownPostVerdictContinuation, postVerdictPendingPath, PostVerdictContinuationRefused } from './post-verdict-continuation.js'
import { writeRunConfigRecord } from './run-curation-context.js'
import { ciResumeClause } from './resume-limit.js'
import type { ExecutionContext } from '@vostride/agent-qa-schema'

/**
 * The capability table, stubbable per cell.
 *
 * Named through `LOCAL_DAEMON_CAPABILITIES`'s own members rather than re-declared, so a signature
 * change on the lease API is a compile error here rather than a drifted second spelling.
 *
 * `readWriterLease` + `deriveWriterLeaseFreshness` are the DECISION half and `acquireWriterLease`
 * is the MUTATION half, and they are separate members because the step calls them at different
 * moments: the first pair at the verdict, the second only if a pump asks.
 */
export interface PostVerdictStepOperations {
  ownContinuation: typeof ownPostVerdictContinuation
  recordCanaryPolicy: typeof recordCanaryPolicy
  acquireWriterLease: typeof LOCAL_DAEMON_CAPABILITIES.acquireWriterLease
  releaseLease: typeof LOCAL_DAEMON_CAPABILITIES.releaseLease
  readWriterLease: typeof LOCAL_DAEMON_CAPABILITIES.readWriterLease
  /**
   * CR-01/CR-08: the ONE three-valued freshness verdict. A surface that classified a holder from
   * the lease file alone would read "nobody holds it" out of an epoch it could not read, which is
   * the defect this derivation exists to make unreachable — so `unknown` is named below rather
   * than inherited.
   */
  deriveWriterLeaseFreshness: typeof LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness
  nudgeDaemon: typeof nudgeDaemon
  /**
   * The durable record the enqueue's payload is minted FROM (D-05, relocated from the tail).
   *
   * The shell saved it a few lines before it awaited this step, so it exists by construction on
   * every path that reaches here.
   */
  loadCompletedRunHandoff: CurationTailOperations['loadCompletedRunHandoff']
  /**
   * A host composed over this run's project, opened for the ENQUEUE and closed again.
   *
   * A separate composition from the tail's, deliberately: the tail composes its own host for the
   * drain, with the run's declared mask threaded so `composeHost` can DERIVE `masker-active`
   * from what it HAS. This one folds nothing and prints nothing — it opens the queue, writes one
   * row and closes — so it needs neither, and sharing one handle across the shell's step and a
   * tail that may never run would leave an sqlite handle open on every framework-error exit.
   */
  composeHost(input: { readonly agentQaRoot: string; readonly configPath: string }): LocalAgentHost
  /** The one instant the freshness verdict is taken against. */
  now: () => number
}

/** What an ACQUISITION answered — the mutating half of the lease API. */
export type WriterLeaseOutcome = ReturnType<PostVerdictStepOperations['acquireWriterLease']>

/** What the non-mutating READ answered, before any freshness verdict is derived from it. */
export type WriterLeaseReadOutcome = ReturnType<PostVerdictStepOperations['readWriterLease']>

/**
 * The three answers a NON-ACQUIRING lease probe can give, and the domain `dispositionOf` is total
 * over.
 *
 * Deliberately not `AcquireWriterLeaseOutcome`: that union's `acquired` arm is a statement that a
 * lease file was rewritten, and this probe rewrites nothing. `free` is the honest name for what it
 * can observe — "no current-epoch holder is present" — which is a fact about the lease, not about
 * this process.
 */
export type WriterLeaseProbe =
  | { readonly kind: 'held' }
  | { readonly kind: 'free' }
  | { readonly kind: 'refused'; readonly reason: string }

export interface PostVerdictStepOptions {
  readonly maxAblations?: number
  readonly runId: string
  /** `<configDir>/.agent-qa` — what `nudgeDaemon` addresses the daemon registration through. */
  readonly agentQaRoot: string
  /**
   * The run's ALREADY-RESOLVED knowledge root, from the producer that resolved it for the run
   * itself. Passed rather than re-derived: the enqueue, the drain and this consult must address
   * one root, and two derivations are free to disagree.
   */
  readonly knowledgeRoot: string
  /**
   * The resolved project config file the enqueue's host is composed from (D-05).
   *
   * REQUIRED rather than optional: a door that forgot it would compose a host against a project it
   * did not resolve, and the enqueue is the one thing every door owes its run.
   */
  readonly configPath: string
  /**
   * `--detach`: enqueue, then skip the LEASE (D-09, RESEARCH Pitfall 8).
   *
   * Only the literal `true`, on the house rule the markers ride: an absent field is an ABSENT
   * field, never an `undefined` a reader must re-check.
   */
  readonly detach?: true
  /**
   * A writer lease this HOST already holds, handed to the step instead of a second acquisition
   * (Open Q2, RESOLVED → the daemon door).
   *
   * The daemon holds the writer lease for its whole lifetime and dispatches runs into its own
   * process. Its runs read `drained` (D-09: a daemon-launched run drained by the daemon's own pump
   * is drained) — but the step may NOT call `acquireWriterLease` to find that out, because a holder
   * that asks is answered `held` by itself and would hand its own work off to nobody (Pitfall 3).
   * So the door that minted the lease says so.
   */
  readonly writerAuthority?: CurationWriterAuthority
  readonly log: { warn(message: string): void }
  /** 444 D-48: the run's context, so a line about unfinished work never promises a CI resume. */
  readonly executionContext?: ExecutionContext
  /** Focused test seam. Production callers omit it. */
  readonly operations?: Partial<PostVerdictStepOperations>
}

/**
 * The box the acquired lease travels in, from the step to whoever pumps.
 *
 * `outcome` is diagnostic only — the shell already published the posture; this is for a host that
 * wants to know what its own step decided without re-reading the wire.
 */
export interface PostVerdictHandoff {
  readonly outcome: PostVerdictOutcome | undefined
  readonly completion?: Promise<PostVerdictOutcome>
  readonly enqueueState?: PostVerdictEnqueueState
  readonly failureDetail?: string
  readonly pendingPath?: string
  /**
   * ACQUIRE (once) and hand over. This is the call a pump makes, and it is the only thing in this
   * file that mutates the lease file: a step whose run never reaches a pump acquires nothing at
   * all. A second call answers `undefined`, whether or not the first caller did anything with it —
   * see the Pitfall 3 note in this file's header. `undefined` also comes back when the acquisition
   * itself found a holder or refused, in which case the caller's own fallback consult decides.
   *
   * CALL IT WHERE YOU CAN RELEASE IT (2026-08-27, CR-01). This is a mutating call wearing the
   * grammar of a getter, so a caller must invoke it from inside the scope whose `finally` releases
   * — never as an argument to the thing that owns that scope. `post-run-tail.ts`'s `drain()` takes
   * a `takeLease` thunk instead of an authority so that its callers cannot get this wrong.
   */
  takeAcquiredLease(): CurationWriterAuthority | undefined
  /**
   * Take an authority THIS STEP ACQUIRED and nobody claimed, acquiring nothing.
   *
   * The no-leak backstop's accessor, and it is a different verb on purpose: a release path that
   * called `takeAcquiredLease()` would acquire a lease for the sole purpose of releasing it —
   * mint an epoch, rewrite the lease file, release it, and warn about it — which is the ordinary
   * run this step was making noisy in the first place.
   *
   * 2026-08-26 (plan 04): IT NEVER HANDS BACK A SUPPLIED AUTHORITY. When the daemon door passes
   * `writerAuthority` it is passing the lease it is CURRENTLY HOLDING and heartbeating for its own
   * lifetime. Releasing that because no tail claimed it would revoke a live daemon's authority
   * mid-run — every other process would then read the lease as free, take it, and pump under a
   * fence the daemon still believes it owns. A supplied lease belongs to the supplier's lifecycle
   * and leaves through the supplier's own release, never through this backstop.
   */
  takeUnclaimedLease(): CurationWriterAuthority | undefined
}

/** The named degrade codes this step can carry to the shell's `runWarning` channel (D-11). */
const WRITER_LEASE_REFUSED = 'writer-lease-refused'
const POST_PROCESSING_UNBOUND = 'post-processing-unbound'
const POST_RUN_ENQUEUE_FAILED = 'post-run-enqueue-failed'

function defaultOperations(): PostVerdictStepOperations {
  const curationDefaults = defaultCurationTailOperations()
  return {
    ownContinuation: ownPostVerdictContinuation,
    recordCanaryPolicy,
    acquireWriterLease: LOCAL_DAEMON_CAPABILITIES.acquireWriterLease,
    releaseLease: LOCAL_DAEMON_CAPABILITIES.releaseLease,
    readWriterLease: LOCAL_DAEMON_CAPABILITIES.readWriterLease,
    deriveWriterLeaseFreshness: LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness,
    nudgeDaemon,
    loadCompletedRunHandoff: curationDefaults.loadCompletedRunHandoff,
    composeHost: (input) => composeCliLocalAgent({
      agentQaRoot: input.agentQaRoot,
      configPath: input.configPath,
      model: () => resolvePostRunJobModel(input.configPath),
    }),
    now: () => Date.now(),
  }
}

/** What the durable hand-off answered. `deduped` is a SUCCESS — see `enqueueAnalyzeRun`. */
export type PostVerdictEnqueueOutcome = 'enqueued' | 'deduped'

/**
 * The composed host has no durable job queue at all.
 *
 * A NAMED class rather than a bare `Error`, because it is the one enqueue failure that is not a
 * failure of the enqueue: nothing is wrong with the run, this host simply cannot queue anything —
 * which is `post-processing-unbound`'s exact meaning on the lease side too. Every other throw is
 * `post-run-enqueue-failed`, and collapsing the two would tell a person to go look for a broken
 * queue on a host that never had one.
 */
export class PostProcessingUnboundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostProcessingUnboundError'
  }
}

/**
 * THE ONE durable `analyze-run` enqueue in this repository (D-05).
 *
 * Relocated from `post-run-tail.ts`'s `enqueue()` leg with its body intact — the same handoff read,
 * the same minted-once digest, the same `AnalyzeRunPayloadSchema.parse`, the same idempotency key
 * (`opts.runId`), the same fence-free write (385 D-02). What changed is WHO calls it: the tail was
 * reachable only from `commands/run.ts`, and this is reachable from every door, because the shell
 * awaits the step that calls it.
 *
 * IT THROWS RATHER THAN REPORTING. The caller maps the throw onto a named `runWarning` code, and
 * that split is deliberate: this function's whole job is "write the row or say why not", and a
 * function that swallowed its own failure into a return value would make the D-11 warning code a
 * decision taken in two places.
 *
 * `deduped` IS A SUCCESS, not a lesser one. A second step run for one run id is exactly what the
 * store's `(kind, idempotency_key)` unique index exists to absorb (385 D-08), and reporting it as a
 * failure would make the store's own guarantee look like an error to every reader.
 *
 * THE HOST IS CLOSED HERE. The tail composes its own for the drain (with the run's declared mask
 * threaded, which this one has no use for), so leaving this handle open would leave an sqlite
 * connection behind on every run that ends above the tail.
 */
export async function enqueueAnalyzeRun(input: {
  readonly runId: string
  readonly agentQaRoot: string
  readonly configPath: string
  readonly operations: Pick<PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'>
}): Promise<PostVerdictEnqueueOutcome> {
  const handoff = input.operations.loadCompletedRunHandoff(
    completedRunHandoffPath(input.agentQaRoot, input.runId),
  )
  const host = input.operations.composeHost({
    agentQaRoot: input.agentQaRoot,
    configPath: input.configPath,
  })
  try {
    if (typeof host.jobs !== 'function') {
      throw new PostProcessingUnboundError(
        'The host composed for this run binds no durable job queue, so nothing could be enqueued.',
      )
    }
    const jobs = await host.jobs()
    // WTST-06 / 393 D-20, verbatim from the tail: the payload is MINTED here, schema-validated,
    // and the two run markers are COPIED onto it from the loaded handoff.
    //
    // Copied, never re-derived and never re-digested. `gateRun` and `excludedFromOutcomes` already
    // live inside the handoff whose bytes `handoffDigest` pins, so these fields add no integrity
    // guarantee — what they add is the ability to see what a QUEUED job is without loading the
    // handoff it points at. Anyone who needs the authoritative answer reads the handoff.
    //
    // The conditional spread is the `runs-start.ts:67` idiom and is load-bearing twice over: the
    // carriers are `?: true`, so an unconditional copy would write `undefined` into the payload for
    // every ordinary run, and `AnalyzeRunPayloadSchema` refuses a literal `false`.
    //
    // 2026-08-26: under D-08 the STEP no longer reaches this line for a run carrying either marker,
    // so in this build the two spreads copy from a handoff that a marker-carrying run never gets to
    // — a run marked in the durable record but not on the step input, which is what a re-enqueue
    // from disk would look like. They are kept because the payload's contract is WTST-06's and this
    // is its only producer; a mint that dropped them would make that contract unimplementable the
    // day a second producer appears.
    const payload = AnalyzeRunPayloadSchema.parse({
      runId: input.runId,
      // D-20/D-06: the digest is minted ONCE per run and shared with the receipt. A second mint
      // here would be a second answer to "which bytes were analysed".
      handoffDigest: curationTailHandoffDigest(handoff),
      handoffSchemaVersion: handoff.schemaVersion,
      executionContext: handoff.executionContext,
      ...(handoff.gateRun === undefined ? {} : { gateRun: handoff.gateRun }),
      ...(handoff.excludedFromOutcomes === undefined
        ? {}
        : { excludedFromOutcomes: handoff.excludedFromOutcomes }),
    })
    const outcome = await jobs.queue.enqueue('analyze-run', payload, input.runId)
    return outcome.deduped ? 'deduped' : 'enqueued'
  } finally {
    try {
      await host.close?.()
    } catch {
      // A store handle that will not close is this process's problem, and post-processing may
      // never cost the verdict (JOBQ-06). The next composition opens its own.
    }
  }
}

/** Read the actual deterministic row before recovery can spend, and validate its final bytes. */
async function matchingAnalysisAlreadyQueued(options: PostVerdictStepOptions, operations: PostVerdictStepOperations): Promise<boolean> {
  const host = operations.composeHost(options)
  try {
    const jobs = await host.jobs()
    const id = jobs.idSource.jobIdFor('analyze-run', options.runId)
    const row = (await jobs.store.dumpState()).jobs.find((job) => job.id === id
      || (job.kind === 'analyze-run' && job.idempotencyKey === options.runId))
    if (row === undefined) return false
    const handoff = operations.loadCompletedRunHandoff(completedRunHandoffPath(options.agentQaRoot, options.runId))
    const parsed = AnalyzeRunPayloadSchema.safeParse(row.payload)
    if (row.id !== id || row.kind !== 'analyze-run' || row.idempotencyKey !== options.runId
      || !parsed.success || parsed.data.runId !== options.runId
      || parsed.data.handoffDigest !== curationTailHandoffDigest(handoff)
      || parsed.data.handoffSchemaVersion !== handoff.schemaVersion
      || parsed.data.executionContext !== handoff.executionContext
      || parsed.data.gateRun !== handoff.gateRun
      || parsed.data.excludedFromOutcomes !== handoff.excludedFromOutcomes) {
      throw new PostVerdictContinuationRefused('queue-conflict')
    }
    return true
  } finally { await host.close() }
}

/**
 * The D-07 warning wording, verbatim from the tail it moved out of. Every clause is load-bearing.
 *
 * It names the RUN so the loss is attributable; it says the verdict and exit code are unaffected so
 * nobody reads a post-processing warning as a test result (JOBQ-06 in the one place a user actually
 * meets it); and it names the handoff's PATH, because "the handoff remains on disk" is only
 * actionable if the reader is told where on disk. The handoff is the whole input the analysis
 * needs, so that path IS the manual re-queue path — there is no retry file and no reconciliation
 * sweep in this build (D-07), by decision.
 */
function enqueueFailureWarning(
  runId: string,
  handoffPath: string,
  detail: string,
  executionContext: ExecutionContext | undefined,
): string {
  // 444 D-48: in `ci` and `cloud` the drive's preparation sentence states the resume limit.
  const resumeClause = ciResumeClause(executionContext, 'any-host')
  return `Run ${runId}: preparation/enqueue failed or was refused (${detail}); post-run analysis was not queued. The verdict and exit code are unaffected. `
    + `Handoff: ${handoffPath}. Durable intent, if publication succeeded: ${join(dirname(handoffPath), 'post-verdict-pending.json')}. `
    + (resumeClause !== undefined
      ? `It ${resumeClause}; conflicting or unsafe state remains refused.`
      : 'The next local run or daemon drain resumes eligible pending preparation; conflicting or unsafe state remains refused.')
}

/**
 * Is a CURRENT-EPOCH holder present? Answered without touching the lease file.
 *
 * TOTAL OVER THE FOUR READ KINDS, deliberately as a `switch` with no `default` and no trailing
 * return — `classifyDaemonRegistration`'s own shape, for the same reason: the line this idiom
 * replaces everywhere it appears is `if (read.kind !== 'parsed') …`, which folds "I could not read
 * the authority state" into "nobody holds it".
 *
 *   - `absent` / `malformed` — genuine recovery input. Nobody holds a lease anyone can honour, so
 *     an acquisition would succeed by reclaiming: `free`.
 *   - `unreadable` — a lease that EXISTS and could not be opened (EACCES, EIO, EMFILE). Never
 *     evidence that nobody holds it, and the acquisition refuses on this input with exactly this
 *     reason, so the probe reports the same refusal rather than promising a drain that cannot
 *     happen.
 *   - `parsed` — the freshness verdict decides, and its `unknown` arm answers `refused` for the
 *     same argument the acquisition's `corrupt-epoch-state` refusal is built on.
 */
export function probeWriterLease(input: {
  readonly knowledgeRoot: string
  readonly operations: Pick<
    PostVerdictStepOperations,
    'readWriterLease' | 'deriveWriterLeaseFreshness' | 'now'
  >
}): WriterLeaseProbe {
  const read: WriterLeaseReadOutcome = input.operations.readWriterLease(input.knowledgeRoot)
  switch (read.kind) {
    case 'absent':
    case 'malformed':
      return { kind: 'free' }
    case 'unreadable':
      return { kind: 'refused', reason: `unreadable-lease-state (${read.code})` }
    case 'parsed': {
      const verdict = input.operations.deriveWriterLeaseFreshness(
        input.knowledgeRoot,
        read.lease,
        input.operations.now(),
      )
      switch (verdict.kind) {
        case 'fresh':
          return { kind: 'held' }
        case 'reclaimable':
          // A stale holder, or one naming a superseded epoch: the acquisition below would reclaim
          // it, so nothing is holding this run's chain up.
          return { kind: 'free' }
        case 'unknown':
          return { kind: 'refused', reason: 'corrupt-epoch-state' }
      }
    }
  }
}

/**
 * What became of the durable enqueue, as `dispositionOf` reads it.
 *
 * `skipped` is D-08's gate-run arm — the enqueue did not fail, it never ran, and those are
 * different facts: one is worth a warning and the other is a decision somebody took.
 */
export type PostVerdictEnqueueState = PostVerdictEnqueueOutcome | 'failed' | 'unbound' | 'skipped'

function safePreparationFailure(error: unknown): string {
  if (error instanceof PostVerdictContinuationRefused) return error.category
  if (error instanceof Error && error.message === 'canary policy invalid') return 'canary policy invalid'
  if (error instanceof Error && /\bSQLITE_BUSY\b/.test(error.message)) return 'SQLITE_BUSY'
  return 'preparation-or-enqueue-error'
}

/**
 * The D-09 decision: what the enqueue and the lease said at the verdict → the posture the wire
 * publishes.
 *
 * TOTAL OVER `kind`, deliberately as a `switch` with no `default`. `WriterLeaseProbe` grows arms
 * over time; a `default` would absorb a new one into whatever value happened to be adjacent, and
 * this is the field 408's embed and every thin client parse.
 *
 * THE ARMS ARE ORDERED, AND THE ORDER IS THE CLAIM (2026-08-26, plan 04 D-05/D-08/D-09):
 *   - `enqueue: 'failed'` — nothing is queued, so no posture about draining it can be honest.
 *     `post-run-enqueue-failed` carries the cause; the lease is never consulted.
 *   - `enqueue: 'unbound'` — this host binds no queue at all. `post-processing-unbound`, the same
 *     code the absent-lease arm uses, because it is the same sentence: nothing will be drained
 *     from here.
 *   - `writerAuthority` — the host HOLDS the lease and said so (the daemon door). `drained`, with
 *     no probe and no acquisition: asking would be answered `held` by this very process.
 *   - `leaseSkipped` — a deliberate skip: D-08's gate-run (which also skipped the enqueue) or
 *     `--detach` (which did not). `detached` with NO warning; nothing went wrong, so nothing is
 *     worth waking anyone for.
 *   - `probe === undefined` and not skipped — no lease capability composed on this host at all.
 *     `post-processing-unbound`: the honest "nothing will be drained from here, and here is why".
 *   - `kind: 'refused'` — an authority state that exists and could not be evaluated.
 *     `writer-lease-refused` carrying the probe's own `reason`, which is the vocabulary every
 *     other lease consumer already renders.
 */
export function dispositionOf(input: {
  readonly enqueue?: PostVerdictEnqueueState
  /** The enqueue failure's own message, carried to the reader rather than flattened. */
  readonly enqueueError?: string
  readonly writerAuthority?: CurationWriterAuthority
  readonly probe?: WriterLeaseProbe
  readonly leaseSkipped: boolean
  readonly executionContext?: ExecutionContext
}): PostVerdictOutcome {
  if (input.enqueue === 'failed') {
    return {
      disposition: 'detached',
      warning: {
        code: POST_RUN_ENQUEUE_FAILED,
        message: input.enqueueError
          ?? 'The post-run analysis could not be queued for this run, so nothing will be drained '
          + 'from this process.',
      },
    }
  }
  if (input.enqueue === 'unbound') {
    return {
      disposition: 'detached',
      warning: {
        code: POST_PROCESSING_UNBOUND,
        message:
          'No durable job queue is composed on this host, so this run\'s post-processing chain '
          + 'was never queued and will not be drained from this process.',
      },
    }
  }
  // The host holds the lease already and told us so. No probe, no acquisition: a holder that asks
  // is answered `held` by itself (RESEARCH Pitfall 3), and its own pump is what drains this chain.
  if (input.writerAuthority !== undefined) return { disposition: 'drained' }
  if (input.leaseSkipped) return { disposition: 'detached' }
  const probe = input.probe
  if (probe === undefined) {
    const resumeClause = ciResumeClause(input.executionContext, 'any-host')
    return {
      disposition: 'detached',
      warning: {
        code: POST_PROCESSING_UNBOUND,
        message:
          'No writer-lease capability is composed on this host, so this run\'s post-processing '
          + 'chain will not be drained from this process. '
          + (resumeClause !== undefined
            ? `It ${resumeClause}.`
            : 'The next local run or `agent-qa daemon` drains it.'),
      },
    }
  }
  switch (probe.kind) {
    case 'held':
      // Somebody else holds a CURRENT-epoch lease and will pump. `handedOff` is a promise about
      // who owns the work, never a claim that the work succeeded (D-09).
      return { disposition: 'handedOff' }
    case 'free':
      // Nobody holds it, so this process is the one that will take it — when its pump asks.
      return { disposition: 'drained' }
    case 'refused':
      return {
        disposition: 'detached',
        warning: {
          code: WRITER_LEASE_REFUSED,
          message:
            `The writer lease could not be evaluated (${probe.reason}), so this run's `
            + 'post-processing chain will not be drained from this process.',
        },
      }
  }
}

/**
 * Compose this run's post-verdict step: the port the shell awaits, and the box its lease leaves in.
 *
 * `run()` NEVER throws for a lease refusal — that is a decided posture with a named warning, not a
 * failure. An UNEXPECTED throw (a capability that raised rather than returning a refusal) is
 * deliberately allowed to propagate, so the shell's own degrade path — `post-verdict-step-failed` —
 * is a live path rather than dead code nothing can reach.
 */
export async function recordCanaryPolicy(options: Pick<PostVerdictStepOptions, 'agentQaRoot' | 'runId' | 'configPath' | 'maxAblations'>): Promise<void> {
  const runDir = dirname(completedRunHandoffPath(options.agentQaRoot, options.runId))
  if (readRunCanaryPolicy(runDir, options.runId) !== undefined) return
  const caps = await createCanaryAblationForHost({ configPath: options.configPath,
    agentQaRoot: options.agentQaRoot,
    ...(options.maxAblations === undefined ? {} : { maxAblations: options.maxAblations }),
  }).resolveCaps()
  if (!['flag', 'config', 'default'].includes(caps.source)) throw new Error('canary policy source invalid')
  writeRunCanaryPolicy(runDir, { schemaVersion: 2, runId: options.runId,
    maxAblations: caps.maxAblations, source: caps.source as 'flag' | 'config' | 'default' })
}

export function createPostVerdictStep(options: PostVerdictStepOptions): {
  readonly port: PostVerdictPort
  readonly handoff: PostVerdictHandoff
} {
  const ops = (): PostVerdictStepOperations => ({ ...defaultOperations(), ...options.operations })
  let acquired: CurationWriterAuthority | undefined
  let supplied: CurationWriterAuthority | undefined
  let claimed = false
  let decided: PostVerdictOutcome | undefined
  let completion: Promise<PostVerdictOutcome> | undefined
  let enqueue: PostVerdictEnqueueState | undefined
  let enqueueError: string | undefined
  /**
   * What `takeAcquiredLease()` should do when a pump finally asks.
   *
   * `run()` sets it and nothing else does. Three states, and the third is why this is a variable
   * rather than a condition on `acquired`:
   *   - `acquire` — nobody held the lease at the verdict, so the pump's request is what mints it.
   *   - `supplied` — the HOST already holds it (the daemon door). Handed straight through; nothing
   *     is acquired, and the backstop must never release it (see `takeUnclaimedLease`).
   *   - `none` — a holder exists, a refusal happened, or the lease was deliberately skipped.
   */
  let plan: 'acquire' | 'supplied' | 'none' = 'none'

  const execute = async (input: PostVerdictStepInput): Promise<PostVerdictOutcome> => {
      const root = options.knowledgeRoot
      // 2026-10-16 (442-10, D-17): every run, gate runs included, records the config another
      // run's tail must curate it under; without the record every other tail hands it back.
      try {
        writeRunConfigRecord(options.agentQaRoot, options.runId, resolve(options.configPath))
      } catch (error) {
        options.log.warn(`Run ${options.runId}: its config record was not written, so only its own tail `
          + `will curate it (${error instanceof Error ? error.message : String(error)}).`)
      }
      const settle = (outcome: PostVerdictOutcome): PostVerdictOutcome => {
        decided = outcome
        return outcome
      }

      // (a) D-08 — the gate-run / outcomes-excluded skip. No enqueue, no lease, no warning. The
      // markers arrive on the STEP INPUT (the shell copies them off `RunConfig`), not off the
      // handoff: the handoff is loaded by the enqueue, and this arm exists precisely so the
      // enqueue never runs.
      if (input.gateRun === true || input.excludedFromOutcomes === true) {
        enqueue = 'skipped'
        return settle(dispositionOf({ enqueue: 'skipped', leaseSkipped: true }))
      }

      // (b) THE ENQUEUE — the durable record, before any posture about draining it.
      try {
        enqueue = await ops().ownContinuation({ ...options,
          initializePolicy: () => ops().recordCanaryPolicy(options),
          queued: () => matchingAnalysisAlreadyQueued(options, ops()),
          enqueue: async () => {
            return await enqueueAnalyzeRun({ ...options, operations: ops() })
          },
        })
      } catch (error) {
        enqueue = error instanceof PostProcessingUnboundError ? 'unbound' : 'failed'
        enqueueError = enqueueFailureWarning(
          options.runId,
          completedRunHandoffPath(options.agentQaRoot, options.runId),
          safePreparationFailure(error),
          options.executionContext,
        )
      }

      // (c) A run with nothing queued has nothing to promise about, and taking a lease for an
      // empty chain would leave it held for its TTL. No consult at all on this path.
      if (enqueue === 'failed' || enqueue === 'unbound') {
        return settle(dispositionOf({
          enqueue,
          ...(enqueueError === undefined ? {} : { enqueueError }),
          leaseSkipped: false,
        }))
      }

      // (d) The host supplied its own authority (Open Q2 — the daemon door). Stash it for a pump
      // that asks; acquire nothing.
      const authority = options.writerAuthority
      if (authority !== undefined) {
        supplied = authority
        plan = 'supplied'
        return settle(dispositionOf({ enqueue, writerAuthority: authority, leaseSkipped: false }))
      }

      // (e) `--detach` — the enqueue above ran; the LEASE is what detaching skips (Pitfall 8).
      if (options.detach === true) {
        return settle(dispositionOf({ enqueue, leaseSkipped: true }))
      }

      // The 404-01 consult. The DECISION read is non-mutating by construction — see this file's
      // header for why the acquisition is not here.
      const probe = probeWriterLease({ knowledgeRoot: root, operations: ops() })
      if (probe.kind === 'held') {
        // The SHIPPED nudge envelope, verbatim from the tail's own hand-off leg: its handler
        // already calls `requestDrain` and wakes the job dispatcher, and a nudge that never lands
        // is invisible by design because the daemon's own poll is the backstop. Fire-and-forget:
        // this step may not spend the verdict's milliseconds waiting for a daemon to answer.
        void ops().nudgeDaemon(options.agentQaRoot, { knowledgeRoot: root }).catch(() => undefined)
      }
      if (probe.kind === 'free') {
        plan = 'acquire'
      }
      return settle(dispositionOf({ enqueue, probe, leaseSkipped: false }))
  }
  const port: PostVerdictPort = {
    run(input) {
      completion ??= execute(input)
      return completion
    },
  }

  return {
    port,
    handoff: {
      get completion() { return completion },
      get enqueueState() { return enqueue },
      get failureDetail() { return enqueueError },
      get pendingPath() { return postVerdictPendingPath(options) },
      get outcome(): PostVerdictOutcome | undefined {
        return decided
      },
      takeAcquiredLease(): CurationWriterAuthority | undefined {
        if (claimed) return undefined
        claimed = true
        if (plan === 'supplied') {
          const handed = supplied
          supplied = undefined
          return handed
        }
        if (acquired === undefined && plan === 'acquire') {
          // THE one acquisition (see this file's header), made on behalf of the pump that just
          // asked for it. Synchronous by contract — the lease API does its own bounded contention
          // internally. A `held` or `refused` answer hands back `undefined`: the caller's own
          // consult is then the fallback, and this box never acquires again.
          const outcome = ops().acquireWriterLease(options.knowledgeRoot)
          if (outcome.kind === 'acquired') {
            acquired = { leaseId: outcome.leaseId, epoch: outcome.epoch }
          }
        }
        const held = acquired
        acquired = undefined
        return held
      },
      takeUnclaimedLease(): CurationWriterAuthority | undefined {
        if (claimed) return undefined
        claimed = true
        // ONLY what this step itself acquired. A SUPPLIED authority is deliberately not returned:
        // it is the daemon's live, heartbeating lease, and releasing it because no tail claimed it
        // would revoke a running daemon's authority mid-run. See this member's doc on
        // `PostVerdictHandoff`.
        const held = acquired
        acquired = undefined
        return held
      },
    },
  }
}

/**
 * Release a lease nobody took, and say so.
 *
 * The structural no-leak rule for a door whose tail never ran: if an authority is sitting in the
 * box unclaimed it must not be left to expire on its TTL while every other process reads the run
 * as handed off to a holder that is not pumping. Warn-only — the exit code froze long before this
 * line, and a lease this process cannot release expires on its own.
 *
 * IT ACQUIRES NOTHING. Under the lazy step above, an ordinary run that never reaches a pump has an
 * empty box here, so this is a silent no-op rather than the `released untaken` line it used to
 * print on every framework-error exit.
 *
 * IT ALSO RELEASES NOTHING THE HOST SUPPLIED (2026-08-26, plan 04). The daemon door hands the step
 * the lease it is currently holding and heartbeating; `takeUnclaimedLease()` deliberately refuses
 * to hand that back, because releasing a live daemon's authority because no tail claimed it would
 * let every other process take the lease while the daemon still believed it owned the fence. What
 * this backstop exists for is the OTHER filler: a producer that puts a lease THIS STEP ACQUIRED
 * into the box ahead of a pump that never comes — a leaked writer lease being exactly the failure
 * nobody notices until the next run is told the chain is handed off to a process that has exited.
 */
export function releaseUntakenPostVerdictLease(input: {
  readonly handoff: PostVerdictHandoff
  readonly knowledgeRoot: string
  readonly runId: string
  readonly log: { warn(message: string): void }
  readonly operations?: Partial<Pick<PostVerdictStepOperations, 'releaseLease'>>
}): void {
  const authority = input.handoff.takeUnclaimedLease()
  if (authority === undefined) return
  const release = input.operations?.releaseLease ?? LOCAL_DAEMON_CAPABILITIES.releaseLease
  try {
    release({ knowledgeRoot: input.knowledgeRoot, leaseId: authority.leaseId })
  } catch {
    // Same posture as the tail's own release: a lease this process cannot release expires on its
    // TTL, and failing a finished run over cleanup would spend the verdict-first guarantee.
  }
  input.log.warn(
    `Run ${input.runId}: post-run lease released untaken — the post-verdict step acquired the `
    + 'writer lease but no post-run tail claimed it, so nothing was drained from this process.',
  )
}
