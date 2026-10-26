// The host-neutral run composition (Phase 385 plan 08 — D-13).
//
// This is the dissected majority of what used to be a 1035-line composition helper inside the CLI.
// Nothing here was rewritten: the digest mint, the persistence-port construction, the suite
// lifecycle and the member run-config assembly are the same code, moved.
// What changed is WHERE it lives and what it is allowed to assume, and only one thing was actually
// taken away — the readline default on the confirm seam, which became a presentation port (see
// presentation-ports.ts for the rule that decided every symbol's side of the line). Since 432-13
// nothing reads that port: a run asks nobody, and 432-14 deleted the port with its last producer.
//
// Why it moved: 386's daemon has to build a real RunConfig without importing a CLI. A composition
// that lives inside one surface is a composition every other host has to re-derive, and two hosts
// deriving the same RunConfig differently is the class of bug the dual-host proof exists to
// exclude. So the composition root moves down to where the local host implementations already
// live, and the surface keeps only the parts a terminal is required to run.
//
// Heavy first-party dependencies are legal in this subtree and nowhere else in this package; the
// arch rule named composition-carveout enforces that, so the job store proper stays lean.

import { createHash } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { detectExecutionContext } from '@vostride/agent-qa-safety-local'
import { guardToolOutput } from '@vostride/agent-qa-model'
import type { TokenAccounting } from '@vostride/agent-qa-model'
import type {
  ModelCapabilities,
  RecordedRetrievalRung,
  RecordId,
  ReadTrace,
  ScopeKey,
} from '@vostride/agent-qa-schema'
import {
  FsEventLog,
  FsEvidenceArtifactStore,
  FsHandoffStore,
  FsRunArtifactStore,
  nextBuildOrdinal,
  recordBuildTag,
  RUNS_SUBDIR,
  slugBranch,
  SharpScreenshotCompressor,
} from '@vostride/agent-qa-runner-local'
import type { ScreenshotCompressorLogger } from '@vostride/agent-qa-runner-local'
import {
  coerceRunJSResult,
  createMemoryTools,
  createRecordLedger,
  liveStreamFor,
  resolveSecretEnv,
  resolveSecretTemplatesInValue,
} from '@vostride/agent-qa-runner'
import type {
  Action,
  AccessibilityCheckHandler,
  ActionPlanCache,
  AppiumScriptHandler,
  ConfigDigests,
  EventLogPort,
  EvidenceArtifactStorePort,
  FailureScreenshotWriter,
  HandoffStorePort,
  HookDefinition,
  HookExecutorPort,
  LoopLogger,
  MemberEventSink,
  MemberRunConfig,
  MemberStepSpec,
  MemberTest,
  MemberTestExecutor,
  MemberTestRunContext,
  NonActionToolMap,
  PlannerConfig,
  Planner,
  PlatformAdapter,
  KnowledgeHintReader,
  PostVerdictPort,
  RecordLedger,
  RunArtifactStorePort,
  RunJsHandler,
  RunMemberDescriptor,
  SandboxRunnerOptions,
  ScreenshotCompressor,
  SecretRedactorPort,
  SecretStore,
  StorageStatePort,
  TestResult,
  Verifier,
  WorkingMemoryPort,
} from '@vostride/agent-qa-runner'
import {
  computeKnowledgeBudgets,
  memoryToolGate,
  scaledRecordCap,
  type KnowledgeBudgets,
} from './knowledge-budgets.js'
import { constructKnowledgeReader } from './knowledge-reader.js'
import type { ConstructKnowledgeReaderInput } from './knowledge-reader.js'

// ---- Local structural types -----------------------------------------------------------------

/** Mirror of schema's ExecutionContext union (safety-local's detectExecutionContext returns it). */
export type RunExecutionContext = 'local-interactive' | 'local-headless' | 'ci' | 'cloud'

/**
 * The provider-substrate model handle, named through the runner's own config rather than through
 * the substrate package. It is the identical type — the runner types both model slots with it —
 * and taking it this way keeps a provider-substrate edge off a package whose declared external
 * dependency set is empty and whose whole point is that it installs nothing (JOBQ-02).
 */
type RunLanguageModel = MemberRunConfig['plannerModel']

/** The message shape the token accountant estimates, taken from the accountant's own signature. */
type AccountedMessage = Parameters<TokenAccounting['estimate']>[0][number]

// ---- (0) run-scoped knowledge serving composition (D-01/D-02/D-09/D-15/D-17/D-23) ----------

type KnowledgeAccounting = Pick<TokenAccounting, 'estimate' | 'getCeilings'>

/**
 * 407 D-13/D-17 — the shape of THE retrieval-rung resolver, declared structurally here and
 * INJECTED rather than imported.
 *
 * knowledge-local's main entry has exactly ONE importer in this workspace by ratified rule
 * (385 D-14/SC5, enforced at file granularity by `findKnowledgeWriterSingletonOffenders`), and
 * that importer is `compose-local-agent.ts` — the local composition root. `resolveRetrievalRung`
 * lives on the main entry deliberately (407-03: it opens an index probe and may load a model, so
 * it is not `./reader` material), so naming it from this file would have made a second importer
 * and quietly retired the invariant. The seam keeps the singleton intact while leaving exactly
 * one implementation in the tree: `compose-local-agent.ts` re-exports the real resolver as
 * `resolveHostRetrievalRung`, and both CLI doors pass THAT.
 *
 * It is REQUIRED, not optional-with-a-default. A default would be a second place the production
 * resolver could be chosen from, and an omission at a new door would show up as a run with no
 * rung — a banner that silently says nothing — rather than as a compile error.
 */
export type RetrievalRungResolver = (
  options: { knowledgeRoot: string; agentQaRoot?: string },
) => Promise<RecordedRetrievalRung>

export interface RunKnowledgeComposition {
  reader: KnowledgeHintReader
  budgets: KnowledgeBudgets
  /**
   * 407 D-13 — the HOST's retrieval ladder at THIS run's serve time, started here and awaited
   * exactly once by the first step's evidence recorder. It is a promise rather than a value
   * because the resolver's embedder probe can cost a model load, and overlapping that with run
   * start keeps it off the critical path (T-407-16). Never re-probed per step: a run's rung is a
   * fact about when it was served, not a live indicator of the machine.
   */
  retrievalRung: Promise<RecordedRetrievalRung>
  recordLedger: RecordLedger
  nonActionTools?: NonActionToolMap
  beginMemoryTurn?: (scope?: ScopeKey, exposedIds?: readonly RecordId[]) => void
  drainMemoryReadTraces?: () => ReadTrace[]
}

export interface OpenRunKnowledgeCompositionInput {
  knowledgeRoot: string
  product?: string
  scope: ScopeKey
  /** Known containing scopes for a member (the suite scope on prepared-suite runs). */
  parentScopes?: readonly ScopeKey[]
  asOfBuild: number
  capabilities: ModelCapabilities
  accounting: KnowledgeAccounting
  qaRulesText: string
  workingContextText: string
  /**
   * 407 D-13 — the hosted runtime root (`<configDir>/.agent-qa`) the embedder probe discovers its
   * worker under. Absent falls back to the acquirer's own rule, so a caller that does not know the
   * root still gets an honest answer rather than an error.
   */
  agentQaRoot?: string
  /**
   * 407 D-17 — the injected rung resolver. Production callers pass `resolveHostRetrievalRung`
   * (the composition root's binding of THE one knowledge-local resolver); tests pass a fake and
   * never touch the host. See {@link RetrievalRungResolver} for why it is injected and required.
   */
  resolveRetrievalRung: RetrievalRungResolver
}

/**
 * Open and bind the complete serving stack once per run/planner scope. The composition root can
 * estimate only prompt material it owns, so `qaRulesText` is the run-start capability/rules appendix
 * and `workingContextText` is the resolved suite/test context plus steps. Both ride the same model
 * accounting estimator as planning calls; static runner rules remain covered by the reserved
 * output and conservative fractional allocation rather than a second character heuristic.
 */
export function openRunKnowledgeComposition(
  input: OpenRunKnowledgeCompositionInput,
): RunKnowledgeComposition {
  const ceilings = input.accounting.getCeilings()
  const qaRulesTokens = input.accounting.estimate([
    { role: 'system', content: input.qaRulesText } as AccountedMessage,
  ])
  const workingContextTokens = input.accounting.estimate([
    { role: 'user', content: input.workingContextText } as AccountedMessage,
  ])
  const computed = computeKnowledgeBudgets({
    contextWindow: ceilings.contextWindow,
    reservedOutput: ceilings.maxOutput,
    qaRulesTokens,
    workingContextTokens,
  })
  const budgets: KnowledgeBudgets = {
    ...computed,
    recordCap: scaledRecordCap(input.capabilities),
  }
  const reader = constructKnowledgeReader({
    knowledgeRoot: input.knowledgeRoot,
    ...(input.product === undefined ? {} : { product: input.product }),
    ...(input.parentScopes === undefined ? {} : { parentScopes: input.parentScopes }),
    asOfBuild: input.asOfBuild,
    recordCap: budgets.recordCap,
  })
  // D-13: started HERE, beside the reader that will serve this run, because this is the only place
  // that knows both roots. Nobody awaits it until the first step's recorder does, so a no-op catch
  // is attached now — an unhandled rejection from a probe that merely asks what the host can do
  // must not become a process-level warning (or, under a stricter host, a crash).
  const retrievalRung = input.resolveRetrievalRung({
    knowledgeRoot: input.knowledgeRoot,
    ...(input.agentQaRoot === undefined ? {} : { agentQaRoot: input.agentQaRoot }),
  })
  retrievalRung.catch(() => undefined)
  const channel2Enabled = memoryToolGate(input.capabilities)
  const recordLedger = createRecordLedger({
    cap: budgets.recordCap,
    budget: budgets.brief + budgets.caution + (channel2Enabled ? budgets.searchResults : 0),
    seedRecords: [],
  })

  // D-09/T-380-29: the planner's action slice remains whole under the always-send-all law. The
  // optional non-action slice is composed only for capable models, so non-registration itself is
  // the gate and no model-visible flag can elevate a weak profile into Channel 2.
  const memory = channel2Enabled
    ? createMemoryTools({
        reader,
        scope: input.scope,
        asOfBuild: input.asOfBuild,
        searchResultBudget: budgets.searchResults,
        readBodyBudget: budgets.readBody,
        recordLedger,
        estimateTokens: (text) => input.accounting.estimate([
          { role: 'user', content: text } as AccountedMessage,
        ]),
      })
    : undefined

  return {
    reader,
    budgets,
    retrievalRung,
    recordLedger,
    nonActionTools: memory?.tools,
    beginMemoryTurn: memory?.beginTurn,
    drainMemoryReadTraces: memory?.drainReadTraces,
  }
}

// ---- (1) computeRunConfigDigests — the ONE digest mint (D-20) --------------------------------

/** One member's file inputs to the digest mint. `suiteFileContent` is absent on the single-test path. */
export interface RunDigestMemberInput {
  testFileContent: string
  suiteFileContent?: string
}

/**
 * The per-member cache pair AND the run-level handoff pair, both produced by the SINGLE call
 * below (D-20). The cache-key threading consumes `perMember[i]`; the handoff header carries
 * `runLevel`. Because both draw from one mint, run identity and handoff identity cannot fork.
 */
export interface RunConfigDigests {
  runLevel: ConfigDigests
  perMember: ConfigDigests[]
}

/** 16-hex SHA-256 digest of a UTF-8 string (the 356 A5 `sha256hex16` value; node:crypto here). */
function digest16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Mint the run's config digests ONCE (D-20; RESEARCH A1 pinning).
 *
 * - Per-member cache pair:
 *     suiteConfigDigest = sha256hex16(configContent + '\n' + (suiteFileContent ?? ''))
 *     testConfigDigest  = sha256hex16(testFileContent)
 * - Run-level handoff pair:
 *     suiteConfigDigest = sha256hex16(ordered DISTINCT per-member suite digests joined by '\n')
 *     testConfigDigest  = sha256hex16(ordered per-member test digests joined by '\n')
 *   A single-member run collapses the run-level pair to the member's values.
 *
 * Both consumers (per-member cache, run-level handoff) draw from this one call — identities
 * cannot fork. This is the ONLY digest computation in the composition layer.
 */
export function computeRunConfigDigests(input: {
  configContent: string
  members: readonly RunDigestMemberInput[]
}): RunConfigDigests {
  const perMember: ConfigDigests[] = input.members.map((m) => ({
    suiteConfigDigest: digest16(input.configContent + '\n' + (m.suiteFileContent ?? '')),
    testConfigDigest: digest16(m.testFileContent),
  }))

  if (perMember.length === 1) {
    // Single-member runs collapse the run-level pair to the member values.
    return { runLevel: { ...perMember[0] }, perMember }
  }

  const distinctSuiteDigests: string[] = []
  const seen = new Set<string>()
  for (const pair of perMember) {
    if (!seen.has(pair.suiteConfigDigest)) {
      seen.add(pair.suiteConfigDigest)
      distinctSuiteDigests.push(pair.suiteConfigDigest)
    }
  }

  const runLevel: ConfigDigests = {
    suiteConfigDigest: digest16(distinctSuiteDigests.join('\n')),
    testConfigDigest: digest16(perMember.map((p) => p.testConfigDigest).join('\n')),
  }

  return { runLevel, perMember }
}

// ---- (2) resolveRunExecutionContext — canonical resolver (D-04) ------------------------------

/**
 * Resolve the run's execution context via safety-local's canonical `detectExecutionContext`
 * (RESEARCH Q1.4 recommendation (a) — already tested; an explicit override wins). Carried into
 * `RunConfig.executionContext` and the handoff header.
 */
export function resolveRunExecutionContext(override?: RunExecutionContext): RunExecutionContext {
  return detectExecutionContext(override) as RunExecutionContext
}

// ---- (3) buildRunPorts + buildOrdinal — runner-local persistence tier (D-06/D-17/D-18) -------

/** The durable run ports the shell wires behind `RunConfig.ports` (event log + handoff + artifact). */
export interface RunPersistencePorts {
  eventLog: EventLogPort
  handoffStore: HandoffStorePort
  runArtifactStore: RunArtifactStorePort
  /**
   * CASS-02 run-scoped decision-screenshot store (Plan 13). Constructed once here from the SAME
   * persistence root + runId as the other adapters; the shell hands this exact instance to every
   * member so Plan 12's live-decision producer persists into one durable, run-addressable namespace.
   */
  evidenceArtifacts: EvidenceArtifactStorePort
  /**
   * 403-13 (WR-06, LIVE-03): where a live-frame VIEWER's fault is reported. Declared here as well
   * as on the runner's `RunPorts`, because `assembleCliRun` spreads THIS interface into
   * `RunConfig.ports` — a member declared on only one side is invisible in the type across that
   * hop. Non-durable and off the bus by construction; the run's transcript never records a viewer.
   */
  onSubscriberFault?: (code: string, message: string) => void
  /**
   * 404-01 (D-05/D-10): the host-composed post-verdict step the shell awaits between `verdict` and
   * `runFinished`. Declared here for the SAME reason `onSubscriberFault` is — `assembleCliRun`
   * spreads THIS interface into `RunConfig.ports`, so a member declared on only one side of that
   * hop is invisible in the type and would silently never reach `startRun`.
   *
   * It is NOT built by `buildRunPorts`: this package's runner seam names no queue and no writer
   * lease, and inventing a second spelling of either here is what D-05 exists to prevent. The core
   * threads whatever the HOST handed it (`RunInvocationCoreOptions.postVerdict`) and nothing else.
   */
  postVerdict?: PostVerdictPort
}

/**
 * Construct the runner-local persistence ports rooted at the run's `.agent-qa` runtime dir (the
 * FsActionCache rooting idiom). `FsEventLog`/`FsHandoffStore`/`FsRunArtifactStore`/
 * `FsEvidenceArtifactStore` all write under the SAME `<configDir>/.agent-qa/runs/<slug(runId)>/…`
 * family (D-08 — one self-contained run dir).
 */
export function buildRunPorts(input: { configDir: string; runId: string }): RunPersistencePorts {
  const root = resolve(input.configDir, '.agent-qa')
  return {
    eventLog: new FsEventLog({ root, runId: input.runId }),
    handoffStore: new FsHandoffStore({ root, runId: input.runId }),
    runArtifactStore: new FsRunArtifactStore({ root, runId: input.runId }),
    evidenceArtifacts: new FsEvidenceArtifactStore({ root, runId: input.runId }),
    // A NAMED, observable, non-durable destination: greppable by code, visible to a test through
    // `process.once('warning', …)`, and no `console.` call in a package that makes none.
    onSubscriberFault: (code, message) => {
      process.emitWarning(message, { code })
    },
  }
}

/**
 * Construct the D-08/Q10 screenshot compressor at the composition root (sharp's host-adapter home).
 * The runner-local `SharpScreenshotCompressor` is injected into every member's runner loop via
 * `RunSuiteConfig.compressor` / `RunTestConfig.compressor` — core no longer constructs one.
 */
export function buildScreenshotCompressor(logger?: ScreenshotCompressorLogger): ScreenshotCompressor {
  return new SharpScreenshotCompressor(logger)
}

/** Resolve D-16 build-tag precedence without reading ambient process state. */
export function resolveBuildTagSetting(input: {
  flag?: string
  env?: string
  use?: { buildTag?: string }
}): string | undefined {
  for (const value of [input.flag, input.env, input.use?.buildTag]) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Advance the per-product buildOrdinal counter under the same `.agent-qa` root (D-18), then
 * record D-14/D-16's first-seen tag mapping beside it when supplied. Both files are lock-free,
 * best-effort runtime truth; the resolved ordinal rides `RunConfig.buildOrdinal` into the handoff.
 */
export async function resolveRunBuildOrdinal(input: {
  configDir: string
  product: string
  buildTag?: string
}): Promise<number> {
  const root = resolve(input.configDir, '.agent-qa')
  const ordinal = await nextBuildOrdinal({ root, product: input.product })
  if (input.buildTag !== undefined) {
    await recordBuildTag({
      root,
      product: input.product,
      tag: input.buildTag,
      ordinal,
    })
  }
  return ordinal
}

// ---- (4) createSuiteLifecycle — lazy per-suite setup/teardown --------------------------------

/**
 * The ONE exclusive lane every suite member declares (402-02, D-09). The runner's bounded member
 * pool never runs two members of the same lane concurrently, and the suite path needs that for two
 * independent reasons, either of which alone would be sufficient:
 *
 *  1. Every member of a suite drives the ONE `PlatformAdapter` its suite set up — one browser, one
 *     page. Two members on it at once would interleave navigations and clicks on a shared surface.
 *     D-09 requires each concurrent member its own browser/CDP handle; the suite path does not
 *     supply that today, so it does not get concurrency today.
 *  2. `createSuiteLifecycle` admits ONE ACTIVE SUITE at a time. Two suites live at once is a
 *     lifecycle violation, not a scheduling preference.
 *
 * A single lane string (rather than one lane per suite) is what encodes BOTH: it serializes within
 * a suite and across suites. When a producer starts handing each member its own session AND the
 * lifecycle admits concurrent suites, this becomes a per-suite key — or disappears — and the shell
 * needs no argument re-litigated for that to be safe.
 *
 * STATUS 2026-08-24 (402-02): reason (2) is CLOSED — `createSuiteLifecycle` below is now a
 * once-latch with member reference counting, so two members of one suite merge into one setup and
 * a boundary crossed while members are live is a named error rather than a mid-flight teardown.
 * Reason (1) is OPEN and is what still holds the lane: `suiteConfig.adapter` is per-SUITE, so
 * within-suite concurrency would still put two tests on one browser page. Giving each suite member
 * its own session is a change to what a suite MEANS (suite setup navigates once and members
 * inherit that page state, per-test hooks run against it, auth state is captured from it) and is
 * not this plan's to make. Do not drop this lane until that is decided.
 */
export const SUITE_LIFECYCLE_LANE = 'suite-lifecycle'

/** The setup/teardown pair a suite runs when it first becomes active / when it is torn down. */
export interface SuiteLifecycleHooks {
  /** Suite-level setup: setup hooks + adapter.setup + suite-URL navigation. */
  setup(): Promise<void>
  /** Suite-level teardown: teardown hooks + auth-state capture (when all passed) + adapter.cleanup. */
  teardown(): Promise<void>
}

/**
 * One member's hold on the active suite (402-02). Held from the moment `ensureReady` admits the
 * member until the member settles; the suite cannot be torn down while any hold is outstanding.
 */
export interface SuiteMemberLease {
  /** Drop this member's hold. Idempotent — a double release never double-decrements. */
  release(): void
}

/**
 * Thrown when `ensureReady` is asked for a suite while a DIFFERENT suite still has live members
 * (402-02). This is the one-active-suite invariant made loud. The alternative — tearing the live
 * suite down to make room — closes the browser out from under a test that is still running in it,
 * and does so silently. The shell's exclusive lane (`SUITE_LIFECYCLE_LANE`) means no shipped
 * composition can reach this, so it reads as an assertion rather than a runtime condition; that is
 * exactly the point of naming it instead of assuming it.
 */
export class SuiteBoundaryWhileLiveError extends Error {
  constructor(
    readonly activeSuiteKey: string,
    readonly requestedSuiteKey: string,
    readonly liveMembers: number,
  ) {
    super(
      `Cannot enter suite "${requestedSuiteKey}": suite "${activeSuiteKey}" still has ` +
        `${liveMembers} live member(s). Suite boundaries are serialized.`,
    )
    this.name = 'SuiteBoundaryWhileLiveError'
  }
}

export interface SuiteLifecycle {
  /**
   * Admit a member to `suiteKey` and resolve once the suite is ready. The FIRST member to arrive
   * starts the suite's setup; every other member of that suite awaits the SAME setup promise
   * rather than starting a second one. Crossing a suite boundary tears down the previous suite —
   * but only once its last member has released; a boundary crossed while members are live is a
   * {@link SuiteBoundaryWhileLiveError}, never a silent teardown.
   *
   * The returned {@link SuiteMemberLease} MUST be released when the member settles (pass or fail);
   * `buildSuiteMemberExecutor` does it in a `finally`.
   */
  ensureReady(suiteKey: string, hooks: SuiteLifecycleHooks): Promise<SuiteMemberLease>
  /** Tear down the last active suite (if any). Called once at run end after `session.done`. */
  finalize(): Promise<void>
}

/**
 * A lazy, CONCURRENCY-SAFE suite-lifecycle manager (the Q1.2 "pre/post-run composition" rows,
 * redesigned for the 402-02 member pool). A wholly SKIPPED suite never sets up — the shell only
 * invokes the executor (hence `ensureReady`) for non-skipped members, so a suite whose members are
 * all fail-fast/cancel skips is never touched.
 *
 * WHAT CHANGED AND WHY. The pre-402 version read the active key, awaited `hooks.setup()`, and THEN
 * assigned the key — three steps with awaits between them. Under a `for` loop that is fine because
 * only one member is ever inside it. Under a pool, two members of one suite both observe "no active
 * suite" and both run setup: two browsers for one suite, and the second teardown handle silently
 * overwriting the first, so the first suite's browser is never closed. The fix is not a lock; it is
 * to make the state transition SYNCHRONOUS and let the promise be the shared thing:
 *
 *  - the once-latch: `activeKey`, `activeTeardown` and `activeSetup` are all assigned in the same
 *    synchronous region, BEFORE any await, so there is no window in which a second member can
 *    observe the pre-setup state. Every later member of the suite awaits `activeSetup` itself.
 *  - member reference counting: the count is incremented before awaiting setup, so a concurrent
 *    boundary crossing sees the hold. Teardown fires at a BOUNDARY (or at `finalize`) and only
 *    when the count is zero — never merely because it hit zero, which would tear the suite down
 *    and set it back up between every pair of members.
 *  - a failed setup poisons the suite: the rejected latch is kept and re-thrown to every later
 *    member, so setup is attempted exactly once and no member half-starts against a suite that
 *    never came up. Such a suite is never torn down — nothing came up to take down.
 */
export function createSuiteLifecycle(): SuiteLifecycle {
  let activeKey: string | undefined
  let activeSetup: Promise<void> | undefined
  let activeTeardown: (() => Promise<void>) | undefined
  let liveMembers = 0

  const tearDownActive = async (): Promise<void> => {
    const teardown = activeTeardown
    activeKey = undefined
    activeSetup = undefined
    activeTeardown = undefined
    liveMembers = 0
    if (teardown) await teardown()
  }

  return {
    async ensureReady(suiteKey, hooks) {
      if (activeKey !== undefined && activeKey !== suiteKey) {
        if (liveMembers > 0) {
          throw new SuiteBoundaryWhileLiveError(activeKey, suiteKey, liveMembers)
        }
        await tearDownActive()
      }

      if (activeKey !== suiteKey) {
        // THE ONCE-LATCH. All three assignments are synchronous and happen before the setup body
        // can suspend, so the check above and the state below can never be split by an await.
        activeKey = suiteKey
        activeTeardown = hooks.teardown
        activeSetup = (async () => {
          try {
            await hooks.setup()
          } catch (error) {
            // A suite that never came up has nothing to take down, and the latch stays rejected so
            // every later member of this suite inherits the same failure instead of retrying.
            activeTeardown = undefined
            throw error
          }
        })()
      }

      const setup = activeSetup
      // Counted BEFORE the await: a boundary crossing that races this member must see the hold.
      liveMembers += 1
      let released = false
      const lease: SuiteMemberLease = {
        release() {
          if (released) return
          released = true
          liveMembers -= 1
        },
      }
      try {
        await setup
      } catch (error) {
        lease.release()
        throw error
      }
      return lease
    },
    async finalize() {
      await tearDownActive()
    },
  }
}

// ---- (5) buildSuiteMemberExecutor — the MemberTestExecutor closure (D-01) ---------------------

/**
 * One prepared suite member: its suite key + lifecycle hooks (setup runs on the first member of
 * that suite) and a `run(ctx)` that builds the member's bound `SuiteMemberInput` around core's
 * per-test machinery and returns `executeSuiteMember(...)` with the shell-provided ctx seams
 * (abortSignal, events, per-member configDigests) threaded in.
 */
export interface SuiteMemberBinding {
  suiteKey: string
  hooks: SuiteLifecycleHooks
  /**
   * 403 D-05: the suite's ONE adapter, read only for its live-stream declaration. Present so the
   * executor can register the capability AFTER `ensureReady` has resolved the suite's `setup()`
   * (which is where `adapter.setup()` runs, so `this.page` exists) and BEFORE the first step.
   */
  adapter?: PlatformAdapter
  run(ctx: MemberTestRunContext): Promise<TestResult>
}

/**
 * Declare (or withdraw) a member's live stream on the shell-provided context (403 D-05), by the one
 * selection rule `liveStreamFor` (428 D-11/D-12). A continuous stream is registered with the
 * labelled 1s snapshot producer over `screenshot()` as its fallback, which the hub starts when the
 * stream fails to start. An adapter with no continuous stream but a `screenshot()` registers the
 * snapshot producer itself; an adapter whose own stream is already a snapshot registers that alone;
 * an adapter with neither registers `undefined` and its handle reads `{ kind: 'none' }`.
 * The `ctx.registerLiveStream?.()` call is itself optional so a composition that predates the port
 * is a no-op rather than a crash.
 */
export function registerAdapterLiveStream(
  ctx: MemberTestRunContext,
  adapter: PlatformAdapter | undefined,
): void {
  const registration = liveStreamFor(adapter)
  ctx.registerLiveStream?.(registration?.capability, registration?.fallback)
}

/**
 * Build the injected `MemberTestExecutor` (D-01). Per member the closure looks up the prepared
 * binding by the shell-derived `testIndex` (array position — authoritative), calls
 * `lifecycle.ensureReady(...)` to lazily set up / cross-boundary tear down the member's suite,
 * then runs the member behind `executeSuiteMember`. Wrapping ONE audited function instead of
 * replicating the loop body.
 */
export function buildSuiteMemberExecutor(input: {
  lifecycle: SuiteLifecycle
  bindings: readonly SuiteMemberBinding[]
}): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext): Promise<TestResult> => {
    const binding = input.bindings[ctx.testIndex]
    if (!binding) {
      throw new Error(`No suite-member binding for testIndex ${ctx.testIndex} (testId ${member.testId})`)
    }
    const lease = await input.lifecycle.ensureReady(binding.suiteKey, binding.hooks)
    try {
      // 403 D-05: the suite is up (adapter.setup() resolved inside `ensureReady`), so the member's
      // live stream is declarable now and before its first step.
      registerAdapterLiveStream(ctx, binding.adapter)
      return await binding.run(ctx)
    } finally {
      // The hold is dropped on EVERY exit, throw included — a leaked hold would block the next
      // suite's boundary forever with a SuiteBoundaryWhileLiveError.
      lease.release()
    }
  }
}

// ---- (6) masking seed pipeline: deleted 441-19 (D-12). A run masks only through its producer's
// `SecretRedactor`, built from the declared secrets; nothing seeds from the environment or auth state.

// ---- (7) per-run stamped audit sink: deleted 441-43 (D-15). Neither a run nor a curation fold
// writes a guardrail audit row, so a run directory holds no audit file beside its events.

/**
 * The one composition of a run's own directory (401-20, CR-04).
 *
 * EXTRACTED RATHER THAN COPIED, and that is the whole point of it existing. The core's collision
 * refusal has to ask "does this id already name a run", and the only honest way to ask is against
 * the SAME path the run's artifacts are written to. A second spelling of
 * `runs/<slugBranch(runId)>/` would be free to drift from this one, and a refusal that looked in
 * the wrong place would be green while a colliding id walked past it — path forking is the failure
 * mode this function's own caller already warns about.
 */
export function runDirFor(input: { configDir: string; runId: string }): string {
  return resolve(input.configDir, '.agent-qa', RUNS_SUBDIR, slugBranch(input.runId))
}

// ---- (9) member-run-config builder — the D-05 cutover onto runMemberTest (363-11) ------------
//
// Both startRun sites (suite + single-test) execute each member through the runner-owned
// `runMemberTest` (Plan 10). The executor closure at each site composes core-owned memory
// init/curator/destroy AROUND this member run and returns the member `TestResult` to the shell.
// `buildMemberRunConfig` is the ONE place (Pitfall 8 — no per-site drift) that maps the resolved
// host impls into a `MemberRunConfig`, constructing the adapter-backed injected handlers the runner
// stays neutral about: runJS (web `page.evaluate` + `coerceRunJSResult`), appium (adapter execute
// with secret resolution), the accessibility check (dynamic web-package load), the failure
// screenshot writer, and the store-neutral secret resolver. Adapter internals are legal HERE — this
// is the composition root (D-05). Core's `runTest`/`runTestWithRetry` per-test wrapper is gone;
// its responsibilities live in `runMemberTest` (runner) and in the memory/curator composition here.

/** Capture a best-effort failure screenshot from the adapter (re-homed from the deleted core
 * reporter/screenshot.ts). Returns undefined when the adapter exposes no screenshot capability or
 * capture throws — never fails the step. */
async function captureFailureScreenshotFromAdapter(adapter: PlatformAdapter): Promise<Buffer | undefined> {
  try {
    const shot = (adapter as { screenshot?: () => Promise<Buffer> }).screenshot
    if (typeof shot !== 'function') return undefined
    return await shot.call(adapter)
  } catch {
    return undefined
  }
}

/** Build the injected runJS handler (Q-2). Web-only, mirroring the deleted core runjs-inline
 * execution half: resolve the page from the adapter, `page.evaluate`, coerce the result. Non-web /
 * page-less returns a `[runJS error: …]` value the runner splices in (the same self-describing text
 * core produced). */
function buildRunJsHandler(adapter: PlatformAdapter): RunJsHandler {
  return async (code, ctx) => {
    if (adapter.platform !== 'web') {
      return { value: '[runJS error: runJS is only supported on web platform]', error: 'runJS is only supported on web platform' }
    }
    const page = 'getPage' in adapter
      ? (adapter as { getPage: () => { evaluate: (c: string) => Promise<unknown> } | undefined }).getPage()
      : undefined
    if (!page) {
      return { value: '[runJS error: no browser page available]', error: 'no browser page available' }
    }
    void ctx
    const raw = await page.evaluate(code)
    return { value: coerceRunJSResult(raw) }
  }
}

/** Build the injected appium handler (Q-2). Resolves secret templates in the action, then executes
 * it on the adapter (the core appium-inline execution half). */
function buildAppiumScriptHandler(adapter: PlatformAdapter, secretStore?: SecretStore): AppiumScriptHandler {
  return async (action) => adapter.execute(resolveSecretTemplatesInValue(action as Action, secretStore) as Action)
}

/** Build the injected accessibility-check handler (Q-4). Web-only; resolves the page and runs the
 * dynamically-loaded `@vostride/agent-qa-web` `runAccessibilityCheck` (the composition root is the
 * dynamic-load host — resolves Open Q-4 as move-now). A lost page is a capture failure,
 * never a successful zero-violation check. */
function buildAccessibilityCheckHandler(adapter: PlatformAdapter): AccessibilityCheckHandler {
  return async (opts) => {
    const page = 'getPage' in adapter ? (adapter as { getPage: () => unknown }).getPage() : undefined
    if (!page) throw new Error('Accessibility capture requires an active browser page')
    const web = await import('@vostride/agent-qa-web')
    return web.runAccessibilityCheck(page as any, opts)
  }
}

/** Build the injected failure-screenshot writer. Captures from the adapter into the member's
 * `result.screenshot` (in-run buffer, the same artifact the reporter subscribers persist beside the
 * run dir). */
function buildFailureScreenshotWriter(adapter: PlatformAdapter): FailureScreenshotWriter {
  return async () => captureFailureScreenshotFromAdapter(adapter)
}

/** The runner-owned `MemberTest` shape derived from a resolved (already suite-patched) TestDefinition.
 * `filePath` is the member's own file. A suite-patched test carries no `url` (the suite owns nav), so
 * `runMemberTest` skips the per-test navigate for suite members. */
export function toMemberTest(test: any, filePath: string): MemberTest {
  return {
    testId: (test['test-id'] as string | undefined) ?? test.name,
    name: test.name,
    filePath,
    url: test.url as string | undefined,
    context: test.context as string | undefined,
    steps: test.steps as Array<string | MemberStepSpec>,
    meta: test.meta as MemberTest['meta'],
  }
}

/** Everything both executor closures resolve at the composition root and hand to
 * {@link buildMemberRunConfig}. The adapter-backed injected handlers are constructed here from
 * `adapter` + `secretStore` so the two sites never drift (Pitfall 8). */
export interface BuildMemberRunConfigInput {
  // loop host impls
  adapter: PlatformAdapter
  planner: Planner
  verifier: Verifier
  cache?: ActionPlanCache
  workingMemory?: WorkingMemoryPort
  storageState?: StorageStatePort
  compressor?: ScreenshotCompressor
  knowledgeReader?: KnowledgeHintReader
  /** 407 D-13 — the composed rung, carried through untouched to the loop's evidence recorder. */
  knowledgeRetrievalRung?: Promise<RecordedRetrievalRung>
  knowledgeBudgets?: KnowledgeBudgets
  knowledgeAsOfBuild?: number
  recordLedger?: RecordLedger
  beginMemoryTurn?: (scope?: ScopeKey, exposedIds?: readonly RecordId[]) => void
  drainMemoryReadTraces?: () => ReadTrace[]
  configDigests?: ConfigDigests
  // models
  plannerModel: RunLanguageModel
  verifierModel: RunLanguageModel
  stepModelScope?: MemberRunConfig['stepModelScope']
  // variable seeds
  envFileVars?: Record<string, string>
  inlineVars?: Record<string, string>
  suiteVars?: Record<string, string>
  cliVars?: Record<string, string>
  hookSetupVars?: Record<string, string>
  // inline hooks
  inlineHookDefs?: Map<string, HookDefinition>
  sandboxOptions?: SandboxRunnerOptions
  // secrets — the concrete SecretStore (superset of SecretResolver); resolveSecretEnv needs forEachSecret.
  secretStore?: SecretStore
  secretRedactor?: SecretRedactorPort
  // per-member ctx (bound by the run shell)
  sink: MemberEventSink
  testIndex: number
  abortSignal: AbortSignal
  /** CASS-02 run-scoped evidence store the shell threads onto the member ctx (Plan 13). */
  evidenceArtifacts?: EvidenceArtifactStorePort
  // run config
  captureScreenshots?: boolean
  accessibility?: MemberRunConfig['accessibility']
  timeouts?: MemberRunConfig['timeouts']
  plannerConfig?: PlannerConfig
  logger?: LoopLogger
  logCapture?: { console?: boolean; network?: boolean }
  vision?: { screenshotSize?: number; effectiveResolution?: number }
  visionGate?: { attachImage: boolean; captureMode: 'full' | 'textOnly'; promptNote: string }
  contextWindow?: number
  suiteContext?: string
  /** The member's own file, for the core-parity fileUpload path resolver. */
  filePath: string
}

/**
 * Assemble the {@link MemberRunConfig} `runMemberTest` slots behind, wiring the adapter-backed
 * injected handlers (runJS/appium/a11y/failure-shot), the store-neutral secret resolver, and the
 * fileUpload path resolver — reproducing core's `runTest` per-test behavior on runner soil (D-05).
 */
export function buildMemberRunConfig(input: BuildMemberRunConfigInput): MemberRunConfig {
  const sandbox = input.sandboxOptions
  return {
    adapter: input.adapter,
    planner: input.planner,
    verifier: input.verifier,
    cache: input.cache,
    workingMemory: input.workingMemory,
    storageState: input.storageState,
    // CTXB-06: model's canonical compaction (compactLogs for log bursts, guardBlob
    // otherwise) replaces the runner-local ceiling fallback on every tool-output value.
    guardBlob: guardToolOutput,
    compressor: input.compressor,
    knowledgeReader: input.knowledgeReader,
    knowledgeRetrievalRung: input.knowledgeRetrievalRung,
    knowledgeBudgets: input.knowledgeBudgets,
    knowledgeAsOfBuild: input.knowledgeAsOfBuild,
    recordLedger: input.recordLedger,
    beginMemoryTurn: input.beginMemoryTurn,
    drainMemoryReadTraces: input.drainMemoryReadTraces,
    configDigests: input.configDigests,

    plannerModel: input.plannerModel,
    verifierModel: input.verifierModel,
    stepModelScope: input.stepModelScope,

    envFileVars: input.envFileVars,
    inlineVars: input.inlineVars,
    suiteVars: input.suiteVars,
    cliVars: input.cliVars,
    hookSetupVars: input.hookSetupVars,

    // Inline hooks: the runner-local DockerHookExecutor + sandbox env/authState come off the resolved
    // sandbox options; the per-run secret env is resolved store-side (never crosses into the runner).
    hookExecutor: sandbox?.executor as HookExecutorPort | undefined,
    inlineHookDefs: input.inlineHookDefs,
    hookEnvVars: sandbox?.envVars,
    hookSecretEnv: resolveSecretEnv(input.secretStore),
    hookAuthState: sandbox?.authState,

    runJs: buildRunJsHandler(input.adapter),
    appiumScript: buildAppiumScriptHandler(input.adapter, input.secretStore),
    accessibilityCheck: 'getPage' in input.adapter && typeof input.adapter.getPage === 'function'
      ? buildAccessibilityCheckHandler(input.adapter)
      : undefined,
    persistFailureScreenshot: buildFailureScreenshotWriter(input.adapter),

    resolveSecrets: (text: string) => resolveSecretTemplatesInValue(text, input.secretStore),
    secretStore: input.secretStore,
    secretRedactor: input.secretRedactor,

    sink: input.sink,
    testIndex: input.testIndex,
    abortSignal: input.abortSignal,
    evidenceArtifacts: input.evidenceArtifacts,

    captureScreenshots: input.captureScreenshots,
    accessibility: input.accessibility,
    timeouts: input.timeouts,
    plannerConfig: input.plannerConfig,
    logger: input.logger,
    logCapture: input.logCapture,
    vision: input.vision,
    visionGate: input.visionGate,
    contextWindow: input.contextWindow,
    suiteContext: input.suiteContext,
    resolveUploadPath: (rawPath: string) =>
      isAbsolute(rawPath) ? rawPath : resolve(dirname(input.filePath), rawPath),
  }
}
