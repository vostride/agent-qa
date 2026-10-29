// The run composition both hosts build a `RunConfig` from, without importing a CLI.

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

// The runner's own model type, which keeps a provider-substrate edge off this package.
type RunLanguageModel = MemberRunConfig['plannerModel']

/** The message shape the token accountant estimates, taken from the accountant's own signature. */
type AccountedMessage = Parameters<TokenAccounting['estimate']>[0][number]

// ---- (0) run-scoped knowledge serving composition ----------

type KnowledgeAccounting = Pick<TokenAccounting, 'estimate' | 'getCeilings'>

// Injected, because a second importer of knowledge-local's main entry breaks the singleton rule.
export type RetrievalRungResolver = (
  options: { knowledgeRoot: string; agentQaRoot?: string },
) => Promise<RecordedRetrievalRung>

export interface RunKnowledgeComposition {
  reader: KnowledgeHintReader
  budgets: KnowledgeBudgets
  // A promise awaited once by the first recorder; the rung dates the serve and is never re-probed.
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
  // The runtime root the embedder probe finds its worker under; absent uses the acquirer's rule.
  agentQaRoot?: string
  // Production passes `resolveHostRetrievalRung`; tests pass a fake and never touch the host.
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
  // A no-op catch, because nothing awaits the probe until the first step's recorder does.
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

  // Non-action memory registers only for capable models; no model-visible flag enables Channel 2.
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

// ---- (1) computeRunConfigDigests — the ONE digest mint --------------------------------

/** One member's file inputs to the digest mint. `suiteFileContent` is absent on the single-test path. */
export interface RunDigestMemberInput {
  testFileContent: string
  suiteFileContent?: string
}

// Both pairs come from one call, so run identity and handoff identity cannot fork.
export interface RunConfigDigests {
  runLevel: ConfigDigests
  perMember: ConfigDigests[]
}

/** 16-hex SHA-256 digest of a UTF-8 string, the `sha256hex16` value. */
function digest16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

// Run-level digests hash the ordered member digests; a single-member run keeps the member's values.
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

// ---- (2) resolveRunExecutionContext — canonical resolver ------------------------------

// An explicit override wins over safety-local's `detectExecutionContext`.
export function resolveRunExecutionContext(override?: RunExecutionContext): RunExecutionContext {
  return detectExecutionContext(override) as RunExecutionContext
}

// ---- (3) buildRunPorts + buildOrdinal — runner-local persistence tier -------

/** The durable run ports the shell wires behind `RunConfig.ports` (event log + handoff + artifact). */
export interface RunPersistencePorts {
  eventLog: EventLogPort
  handoffStore: HandoffStorePort
  runArtifactStore: RunArtifactStorePort
  // Built once from the same root and run id: the one instance every member persists into.
  evidenceArtifacts: EvidenceArtifactStorePort
  // Declared here too, because `assembleCliRun` spreads this interface into `RunConfig.ports`.
  onSubscriberFault?: (code: string, message: string) => void
  // Declared here for the same spread, and threaded from the host; `buildRunPorts` never builds it.
  postVerdict?: PostVerdictPort
}

// All four stores write under one `<configDir>/.agent-qa/runs/<slug(runId)>/` directory.
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

// Built at the composition root, the sharp host adapter's home, and injected into every member.
export function buildScreenshotCompressor(logger?: ScreenshotCompressorLogger): ScreenshotCompressor {
  return new SharpScreenshotCompressor(logger)
}

// Resolves build-tag precedence without reading ambient process state.
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

// Both files are lock-free, best-effort runtime state; the ordinal rides `RunConfig.buildOrdinal`.
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

// One lane for all suites: members share their suite's single adapter page, so they cannot overlap.
export const SUITE_LIFECYCLE_LANE = 'suite-lifecycle'

/** The setup/teardown pair a suite runs when it first becomes active / when it is torn down. */
export interface SuiteLifecycleHooks {
  /** Suite-level setup: setup hooks + adapter.setup + suite-URL navigation. */
  setup(): Promise<void>
  /** Suite-level teardown: teardown hooks + auth-state capture (when all passed) + adapter.cleanup. */
  teardown(): Promise<void>
}

// Held from admission until the member settles; the suite cannot tear down while a hold is out.
export interface SuiteMemberLease {
  /** Drop this member's hold. Idempotent — a double release never double-decrements. */
  release(): void
}

// Tearing down the live suite instead would close the browser under a running test.
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

// Key, teardown and setup latch are assigned synchronously before any await, so setup runs once.
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

// ---- (5) buildSuiteMemberExecutor — the MemberTestExecutor closure ---------------------

/**
 * One prepared suite member: its suite key + lifecycle hooks (setup runs on the first member of
 * that suite) and a `run(ctx)` that builds the member's bound `SuiteMemberInput` around core's
 * per-test machinery and returns `executeSuiteMember(...)` with the shell-provided ctx seams
 * (abortSignal, events, per-member configDigests) threaded in.
 */
export interface SuiteMemberBinding {
  suiteKey: string
  hooks: SuiteLifecycleHooks
  // Read only to declare its live stream, after `ensureReady` runs `setup()`, before step one.
  adapter?: PlatformAdapter
  run(ctx: MemberTestRunContext): Promise<TestResult>
}

// A continuous stream gets the labelled 1s snapshot fallback; with neither, nothing registers.
export function registerAdapterLiveStream(
  ctx: MemberTestRunContext,
  adapter: PlatformAdapter | undefined,
): void {
  const registration = liveStreamFor(adapter)
  ctx.registerLiveStream?.(registration?.capability, registration?.fallback)
}

// Looks the binding up by `testIndex`, the authoritative array position, then readies its suite.
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
      // The suite is up, so the member's live stream is declarable before its first step.
      registerAdapterLiveStream(ctx, binding.adapter)
      return await binding.run(ctx)
    } finally {
      // The hold is dropped on EVERY exit, throw included — a leaked hold would block the next
      // suite's boundary forever with a SuiteBoundaryWhileLiveError.
      lease.release()
    }
  }
}

// The run directory, extracted so the collision refusal asks the same path the artifacts use.
export function runDirFor(input: { configDir: string; runId: string }): string {
  return resolve(input.configDir, '.agent-qa', RUNS_SUBDIR, slugBranch(input.runId))
}

// ---- (9) member-run-config builder --------------------------------------------------

// Best-effort: `undefined` when the adapter cannot screenshot or capture throws.
async function captureFailureScreenshotFromAdapter(adapter: PlatformAdapter): Promise<Buffer | undefined> {
  try {
    const shot = (adapter as { screenshot?: () => Promise<Buffer> }).screenshot
    if (typeof shot !== 'function') return undefined
    return await shot.call(adapter)
  } catch {
    return undefined
  }
}

// Web-only: a page-less adapter returns a `[runJS error: …]` value the runner splices in.
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

// Resolves secret templates in the action before executing it on the adapter.
function buildAppiumScriptHandler(adapter: PlatformAdapter, secretStore?: SecretStore): AppiumScriptHandler {
  return async (action) => adapter.execute(resolveSecretTemplatesInValue(action as Action, secretStore) as Action)
}

// A lost page is a capture failure, never a successful zero-violation check.
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

// Handlers are built here from `adapter` and `secretStore`, so the two executor sites cannot drift.
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
  // The composed rung, carried untouched to the loop's evidence recorder.
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
  // The run-scoped evidence store the shell threads onto the member context.
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

// Wires the adapter-backed handlers and the secret and upload-path resolvers for `runMemberTest`.
export function buildMemberRunConfig(input: BuildMemberRunConfigInput): MemberRunConfig {
  const sandbox = input.sandboxOptions
  return {
    adapter: input.adapter,
    planner: input.planner,
    verifier: input.verifier,
    cache: input.cache,
    workingMemory: input.workingMemory,
    storageState: input.storageState,
    // The model's canonical compaction applies to every tool-output value.
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
