import type { CurationSnapshot } from '@vostride/agent-qa-schema'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  AUTHORING_DRAFT_EDIT_FUNCTION_ID,
  invokeFunction,
  RUNS_MARK_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import { AuthoringDraftEditOutputSchema } from '@vostride/agent-qa-schema'
import {
  createFeedbackPortForHost,
  KnowledgeWriterLeaseBusyError,
  MarkWriterLeaseBusyError,
  type MarkWriterAuthority,
  type WholeMarkDelegate,
} from '../gates/feedback-host.js'
import { recordMarkEditAhead, type PendingTestWrite } from '../gates/mark-edit-record.js'
import { createFeedbackReadsPortForHost } from '../gates/feedback-read-host.js'
// The run executor lives here because this file already carries the firewall's `core` ledger entry.

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  Document as YamlDocument,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  parse as parseYaml,
} from 'yaml'

import type {
  ConfigFieldSetResult,
  ConfigFileSet,
  ConfigFilesPortLike,
  ConfigPathFacts,
  ConfigReaderPort,
  ConfigValidatePortLike,
  ConfigValidation,
  ConfigValidationIssue,
  FunctionDeps,
  JobModelCapability,
  KnowledgeReaderPort,
  PostRunJobCapabilities,
} from '@vostride/agent-qa-agent'
import {
  composeLocalAgent,
  createKnowledgeReader,
  LOCAL_DAEMON_CAPABILITIES,
  resolveRunExecutionContext,
} from '@vostride/agent-qa-agent-local'
import type {
  CandidateProsePosture,
  ComposeLocalAgentInput,
  DraftAuthoringPort,
  DraftParseOutcome,
  DraftStageOutcome,
  LocalAgentHost,
  RunExecutionContext,
  RunExecutionPort,
  SuiteTextEntry,
} from '@vostride/agent-qa-agent-local'
import {
  AgentQaConfigSchema,
  HooksFileSchema,
  applyPatchSetToTestDoc,
  discoverWorkspaceFiles,
  // Through `core`'s re-export, because cli takes no direct dependency on the ids package.
  generateHookId,
  DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_CACHE_DIR,
  DEFAULT_AGENT_QA_RUNS_DB_PATH,
  parseTestFile,
  parseTestFileWithTokens,
  renderPatchedTestDoc,
  resolveKnowledgeRoot,
  resolveWorkspacePaths,
  workspaceRelativeIdentityPath,
  // Shared with core's `validateConfig`, so the position-only sentence has one spelling.
  yamlParseFailureMessage,
} from '@vostride/agent-qa-core'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import type { RunAttributeTrigger, TestDefinition } from '@vostride/agent-qa-core'
import type {
  ExplicitReviewDelegate,
  ExplicitReviewResult,
} from '@vostride/agent-qa-agent-local'
import type {
  ConfigScaffoldContentPortLike,
} from '@vostride/agent-qa-agent'
// The one scaffold producer; `agent-qa init` renders the same functions.
import { buildScaffoldFileSet } from '../commands/scaffold-content.js'
import { TARGET_GITIGNORE_ENTRIES } from '../commands/init-filesystem.js'
import {
  CONFIG_REVISION_ABSENT,
  CONFIG_SET_DEFAULT_HOOKS_FILE,
  KnowledgeChangeOutputSchema,
  RunsMarkOutcomeSchema,
  enumerateConfigFileSet,
  sha256hexBytes,
} from '@vostride/agent-qa-schema'
import type {
  FeedbackPort,
  FunctionCaller,
  MaskFn,
  RunEventEnvelope,
  RunId,
  RunSession,
  RunsStartInput,
  ScopeKey,
  TestEditPatchSet,
  TestFileWrite,
} from '@vostride/agent-qa-schema'

import {
  loadConfigFile,
  loadEnvOverrides,
  mergeConfigs,
  normalizeConfigForValidation,
  resolveConfig,
} from '../config.js'
import { listTargets, resolveTarget } from '../targets.js'
import { DaemonNotRunningError, invokeViaDaemon } from '../daemon/client.js'
import { classifyDaemonRegistration } from '../daemon/registration.js'
import { resolveCliAnalysisTokenBudget, resolveCliJobModel } from '../llm-utils.js'
import { createCliCapabilityCatalogPort } from '../capability-catalog/explain-port.js'
import { analyticsEvent } from './analytics-host.js'
import type { CliAnalyticsHost } from './analytics-host.js'
// Type-only: a value import would close an ESM cycle with `commands/run.ts` at load time.
import type { InProcessCliRunExecutionOptions } from './in-process-run-execution.js'
import type { RunRecordHostBinding } from '../commands/run.js'
// Type-only: the pump's authority shape, named here because this door's drain leg declares
// what its `takeLease` thunk answered. Erased at emit, so no runtime edge is added.
import type { CurationWriterAuthority } from '../curation/curation-tail.js'
import { buildMaskedResolvedConfig } from './masked-config.js'
import { createDeclaredSecretMask, type DeclaredSecretMask } from './declared-secrets.js'

// Attribution only: every door can call every operation, so no scope set or safe-mode flag.
export const CLI_FUNCTION_CALLER: FunctionCaller = {
  surface: 'cli',
  // The origin belongs to the composition, never the call; receipts and audit rows record it.
  origin: 'human',
}

// `loadAuthPlugins: false` keeps the read a read: resolving a capability must not run plugin code.
export function createConfigReader(configPath: string, mask: MaskFn): ConfigReaderPort {
  return {
    async getMasked() {
      const resolved = await resolveConfig({ configPath, loadAuthPlugins: false })
      return buildMaskedResolvedConfig({
        configPath,
        resolved,
        mask,
        // Ascending precedence, mirroring `resolveConfig`'s own merge order. `cli-flag` is
        // absent because the `fn` invoker passes no configuration flags; `test-file` never
        // participates in a project-level config read.
        layers: [
          { source: 'config-file', values: await loadConfigFile(configPath) },
          { source: 'env', values: loadEnvOverrides() },
        ],
      })
    },
  }
}

// Scoped per request, so a host serving several doors records each run's own trigger.
const runDoorScope = new AsyncLocalStorage<RunAttributeTrigger>()

export function withRunDoor<T>(trigger: RunAttributeTrigger, fn: () => T): T {
  return runDoorScope.run(trigger, fn)
}

export function currentRunDoor(): RunAttributeTrigger | undefined {
  return runDoorScope.getStore()
}

// Deferred import: a static one would close an ESM cycle with `commands/run.js` at load.
function createComposedRunExecution(input: {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly resolveExecutionContext: ComposeLocalAgentInput['resolveExecutionContext']
  readonly runBridge?: ComposeCliLocalAgentInput['runBridge']
  readonly runTrigger?: RunAttributeTrigger
  readonly analytics?: CliAnalyticsHost
}): RunExecutionPort {
  const composed = {
    async execute(request: RunsStartInput): Promise<{ runId: RunId }> {
      const trigger = currentRunDoor() ?? input.runTrigger ?? 'cli'
      const { createRunRecord, doorRunAttributes, resolveRunInvocationInputs } = await import('../commands/run.js')
      const { runInProcessCliRun } = await import('./in-process-run-execution.js')
      const analytics = input.analytics
      const runSession =
        analytics === undefined ? undefined : await import('../run-session-composition.js')

      // The request may name another config; the drive resolves against exactly this expression, so
      // a preflight read here that used a different one would resolve a different project.
      const configPath = request.configPath ?? input.configPath
      // Both `warn` seams print to stderr locally. Under GitHub Actions they are wrapped, and they
      // stay on stderr when the door's stdout carries JSON or the MCP protocol.
      const warn = (message: string): void => {
        printRunText(message, (line) => console.warn(line))
      }
      const inputs = await resolveRunInvocationInputs({
        configPath,
        ...(request.patterns === undefined ? {} : { patterns: request.patterns }),
        warn,
      })
      const runRecord = createRunRecord({
        attributes: doorRunAttributes(trigger),
        ...(input.runBridge?.record === undefined ? {} : { host: input.runBridge.record }),
        warn,
      })

      // Resolved once, so the run and its tail's exit line read the same context.
      const executionContext =
        (input.resolveExecutionContext?.() ?? resolveRunExecutionContext()) as RunExecutionContext
      let startedRunId: string | undefined
      try {
        const outcome = await runInProcessCliRun(
          {
            configPath,
            agentQaRoot: input.agentQaRoot,
            executionContext,
            inputs,
            // Chained after the local capture, which the `catch` reads to learn if the run started.
            onSession: (session) => {
              startedRunId = session.id as unknown as string
              input.runBridge?.onSession?.(session)
            },
            runRecord,
            // Subscribed directly: `attachRunSubscribers`' wire reporter can print to stdout.
            ...(analytics === undefined || runSession === undefined ? {} : {
              subscribers: ({ session }) => {
                const subscriber = runSession.buildAnalyticsRunSubscriber({
                  analytics,
                  triggerSource: trigger,
                  runner: 'local',
                })
                session.subscribe(runSession.REPLAY_FROM_START, subscriber.handler)
                return { flush: async () => { await subscriber.flush?.() } }
              },
            }),
            ...(input.runBridge?.resolveAppiumUrl === undefined
              ? {}
              : { resolveAppiumUrl: input.runBridge.resolveAppiumUrl }),
            ...(input.runBridge?.resolveRunFlags === undefined
              ? {}
              : { resolveRunFlags: input.runBridge.resolveRunFlags }),
            ...(input.runBridge?.onPostRun === undefined
              ? {}
              : { onPostRun: input.runBridge.onPostRun }),
            // The lease is taken inside the pump's try, so an earlier throw cannot strand it.
            postRunTail: async (context): Promise<void> => {
              const { composeCliPostRunTail } = await import(
                '../curation/post-run-tail-composition.js'
              )
              const tail = composeCliPostRunTail({
                postVerdict: context.postVerdict,
                ...(context.postVerdictDeadlineMs === undefined ? {} : { deadlineMs: context.postVerdictDeadlineMs }),
                runId: context.runId,
                configDir: context.configDir,
                configFilePath: context.configFilePath,
                knowledgeConfig: inputs.config.knowledge,
                mask: context.mask,
                // LOG, NEVER PRINT. The tail's close-out line and digest block are CLI outputs, and
                // this door serves `agent-qa fn --json` (stdout is the JSON document) and the MCP
                // host (stdout IS the JSON-RPC connection). Both go to the same stderr sink the
                // quarantine warning uses, so nothing this door serves can have its channel
                // corrupted by a post-run line.
                log: { warn, info: warn },
                executionContext,
                ...(input.runBridge?.chipRelay === undefined
                  ? {}
                  : { relay: input.runBridge.chipRelay }),
              })
              let lease: CurationWriterAuthority | undefined
              await tail.drain({
                takeLease: () => (lease = context.postVerdict.takeAcquiredLease()),
                withoutLease: 'skip',
              })
              await tail.finish({ detached: lease === undefined })
            },
            warn,
          },
          request,
        )
        // A NON-ZERO EXIT CODE IS A REAL RUN, not an error — the same rule the child's exit code
        // carried. What decides whether a run happened is the durable evidence
        // `createLocalRunInvocation` reads back, which no code here can fake.
        return { runId: outcome.runId as RunId }
      } catch (error) {
        // A started run's framework error still acks: `runs.start` answers a start, not an outcome.
        if (startedRunId === undefined) throw error
        warn(`Run ${startedRunId} failed: ${error instanceof Error ? error.message : String(error)}`)
        return { runId: startedRunId as RunId }
      } finally {
        runRecord.close()
      }
    },
  }
  return {
    // The bridge is handed the execution as it starts, so a host that waits for its runs knows
    // about a run before the run can be seen to finish. `onPostRun` fires before this settles.
    execute: (request: RunsStartInput): Promise<{ runId: RunId }> => {
      const execution = composed.execute(request)
      input.runBridge?.onExecution?.(execution)
      return execution
    },
  }
}

export interface ComposeCliLocalAgentInput {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. */
  agentQaRoot: string
  // Passed through; absent leaves the ambient resolver every other CLI invocation uses.
  resolveExecutionContext?: ComposeLocalAgentInput['resolveExecutionContext']
  // `agent-qa chat` binds it to learn which session is active; absent for every other invocation.
  observeSessionEvent?: ComposeLocalAgentInput['observeSessionEvent']
  // `agent-qa dashboard` overlays the bound origin as `services.dashboard.baseUrl`; the mask stays.
  config?: ComposeLocalAgentInput['config']
  // Absent leaves the engine rendering nothing, as in every non-chat invocation.
  chatPresent?: ComposeLocalAgentInput['chatPresent']
  // Resolved by the caller once per conversation, because this function is synchronous.
  chatModel?: ComposeLocalAgentInput['chatModel']
  chatModelFor?: ComposeLocalAgentInput['chatModelFor']
  chatAccounting?: ComposeLocalAgentInput['chatAccounting']
  // Composition-only: no config key or environment variable may reach it.
  chatReconcile?: ComposeLocalAgentInput['chatReconcile']
  /** The configuration file this invocation resolves against. */
  configPath: string
  // The command's one loader, shared with its emitters.
  declaredSecrets?: DeclaredSecretMask
  // Passed in, never composed here: the opt-out decision belongs to the command's composition root.
  analytics?: CliAnalyticsHost
  // Defaults to the in-process drive; a test substitutes it to run the path without a browser.
  runExecution?: RunExecutionPort
  // Passed through; `onSession` chains onto the door's own capture rather than replacing it.
  runBridge?: {
    readonly onSession?: (session: RunSession) => void
    /** The host's runs.db handle and its queue's rows. */
    readonly record?: RunRecordHostBinding
    /** The Appium this host leased for a named run, if it leases any. */
    readonly resolveAppiumUrl?: InProcessCliRunExecutionOptions['resolveAppiumUrl']
    /** Per-run flags this host's own UI offers that the request DTO has no field for. */
    readonly resolveRunFlags?: InProcessCliRunExecutionOptions['resolveRunFlags']
    // The dashboard's live push channel, handed to `composeCliPostRunTail` as `relay`.
    readonly chipRelay?: (envelope: RunEventEnvelope) => void
    /**
     * Each run's execution, handed over synchronously as the run's execution starts, before any of
     * its events exist. It settles after `onPostRun` has been handed that run's post-run work.
     */
    readonly onExecution?: (execution: Promise<unknown>) => void
    /**
     * Each run's detached post-run work, handed over by the drive the moment it starts that work,
     * whether the run then returns or re-raises a member's framework error.
     */
    readonly onPostRun?: InProcessCliRunExecutionOptions['onPostRun']
  }
  /** The `agent-qa.trigger` this host's runs record outside any `withRunDoor` scope. */
  runTrigger?: RunAttributeTrigger
  // Only the dashboard composes it; without it `runs.liveurl` lists `unbound` by name.
  liveView?: ComposeLocalAgentInput['liveView']
  // Absent, a reader over the configured runs database binds whenever the config parses.
  runDetail?: ComposeLocalAgentInput['runDetail']
  // Defaults to the daemon's `/invoke` transport, calling the change op with the same identity.
  knowledgeChangeDelegate?: ExplicitReviewDelegate
  // Defaults to `delegateMarkViaDaemon`, the daemon's `/invoke` transport.
  wholeMarkDelegate?: WholeMarkDelegate
  // Overridable so a tail that authors through no provider does not resolve credentials eagerly.
  model?: () => JobModelCapability | Promise<JobModelCapability>
  // Defaults to the job model's named-config profile resolution, resolved once at queue open.
  analysisTokenBudget?: ComposeLocalAgentInput['analysisTokenBudget']
  // Passed through: only the run tail already holds the lease, the knowledge root and the author.
  postRun?: {
    curateRun: (input: {
      readonly runId: string
      readonly executionContext: unknown
      readonly deadlineMs?: number
    }) => Promise<{
      readonly curated: number
      readonly deprecated: number
      /** The fold's own completeness, carried rather than dropped. */
      readonly complete: boolean
      readonly snapshot?: CurationSnapshot
      readonly reason?: string
    }>
    // Required wherever the binding is supplied; the shared composition owns the posture's meaning.
    candidateProse: CandidateProsePosture
  }
}

// Bound to the checkout root here, because quarantine readers compare `filePath` with `===`.
export function createQuarantineIdentityMint(configPath: string): (filePath: string) => string {
  // The same derivation the `knowledgeRoot` closure below performs, spelled once per call site.
  const configDir = dirname(resolve(configPath))
  return (filePath: string) => workspaceRelativeIdentityPath(configDir, filePath)
}

// Pre-interpolation: a resolved step can carry the value a `${VAR}` expanded to.
function draftStepTexts(test: TestDefinition): string[] {
  return test.steps.map((step) => (typeof step === 'string' ? step : step.step))
}

/**
 * The one test in a draft file, or the reason there is not one.
 *
 * A draft is ONE test. A file holding several is refused rather than silently evaluated on its
 * first document: the receipt keys on the draft's identity and its digest covers the whole file, so
 * a multi-test file would produce a receipt whose verdict names one test and whose bytes cover
 * several — and the author would have no way to tell which one was kept.
 */
function singleDraftTest(tests: readonly TestDefinition[]): TestDefinition | string {
  if (tests.length === 0) return 'the file parses but holds no test document'
  if (tests.length > 1) {
    return `the file holds ${tests.length} tests; a draft is one test, evaluated as one`
  }
  return tests[0] as TestDefinition
}

// Names every candidate it saw, so the author can write the `scope` that would have worked.
export class AuthoringScopeUnresolvableError extends Error {
  constructor(readonly candidates: readonly string[]) {
    super(
      candidates.length === 0
        ? 'cannot derive a default authoring scope: this project configures no targets, so there '
          + 'is no product to author for. Add a target under registry.targets, or pass `scope` '
          + 'explicitly.'
        : `cannot derive a default authoring scope: ${candidates.length} products are candidates `
          + `(${candidates.join(', ')}). Pass \`scope\` explicitly to choose one.`,
    )
    this.name = 'AuthoringScopeUnresolvableError'
  }
}

// Ambiguity refuses and names its evidence; picking the first would follow config sort order.
export async function deriveDefaultAuthoringScope(configPath: string): Promise<ScopeKey> {
  const config = await resolveConfig({ configPath, loadAuthPlugins: false })
  // Through the shipped `listTargets`, the one enumeration of `registry.targets`.
  const targetNames = listTargets(config).map((target) => target.name)

  const productOfTarget = new Map<string, string>()
  for (const name of targetNames) productOfTarget.set(name, resolveTarget(config, name).product)

  const workspace = resolveWorkspacePaths({ config, configPath })
  const files = await discoverWorkspaceFiles({ workspace, kind: 'test' })
  const exercised = new Set<string>()
  for (const file of files) {
    try {
      const parsed = parseTestFile(readFileSync(file.absolutePath, 'utf8'), file.workspaceRelativePath)
      if (parsed.errors.length > 0) continue
      for (const test of parsed.tests) {
        // A target this config does not declare has no product mapping, so it can neither narrow
        // nor ambiguate — it is a test this project cannot run either.
        const product = productOfTarget.get(test.target)
        if (product !== undefined) exercised.add(product)
      }
    } catch {
      // One unreadable file cannot make authoring unreachable. See the note above.
    }
  }

  const candidates = [...(exercised.size > 0 ? exercised : new Set(productOfTarget.values()))].sort()
  if (candidates.length !== 1) throw new AuthoringScopeUnresolvableError(candidates)
  return { tier: 'product', key: candidates[0] as string }
}

export function createDraftAuthoringPort(configPath: string): DraftAuthoringPort {
  const configDir = dirname(resolve(configPath))

  return {
    // The op's absence path reaches THIS, through the composition — see the function's own header
    // for why there is exactly one derivation and why both hosts must reach it.
    deriveDefaultScope(): Promise<ScopeKey> {
      return deriveDefaultAuthoringScope(configPath)
    },

    parseDraft(filePath: string): Promise<DraftParseOutcome> {
      let identityPath: string
      let absolutePath: string
      try {
        identityPath = workspaceRelativeIdentityPath(configDir, filePath)
        absolutePath = resolve(configDir, identityPath)
      } catch {
        return Promise.resolve({ kind: 'outside-workspace' })
      }

      let stats
      try {
        stats = statSync(absolutePath)
      } catch {
        return Promise.resolve({ kind: 'not-found' })
      }
      if (!stats.isFile()) return Promise.resolve({ kind: 'not-a-file' })

      // Read once as bytes: the later digest hashes raw bytes, and a second read could differ.
      const bytes = readFileSync(absolutePath)
      const content = bytes.toString('utf8')
      // Parsed under the IDENTITY path, so any position a parse error names is the path the author
      // typed rather than an absolute one only this machine can produce.
      const parsed = parseTestFile(content, identityPath)
      if (parsed.errors.length > 0) {
        return Promise.resolve({
          kind: 'unparsable',
          reason: parsed.errors.map((error) => error.message).join('; '),
        })
      }
      const test = singleDraftTest(parsed.tests)
      if (typeof test === 'string') {
        return Promise.resolve({ kind: 'unparsable', reason: test })
      }

      return Promise.resolve({
        kind: 'parsed',
        draft: {
          // The run path's own recipe: an authored `test-id` if there is one, the name otherwise.
          testId: (test as { 'test-id'?: string })['test-id'] ?? test.name,
          filePath: identityPath,
          testName: test.name,
          // The compile stage's vocabulary check reads this, so the parse carries it out.
          target: test.target,
          steps: draftStepTexts(test),
          // An EDITABLE root, so it is carried rather than dropped: the credential gate scans it.
          ...(test.context === undefined ? {} : { context: test.context }),
          // Over the FILE'S BYTES — the bytes themselves, never their decoding — so a receipt
          // cannot be inherited by an edited draft (the whole of what `DraftRefSchema.contentDigest`
          // promises) AND so this value means the same thing as the digest the apply recomputes at
          // the accept. Every byte sequence that is not valid UTF-8 decodes to the same replacement
          // characters, so a digest over the decoding both collapses genuinely different targets
          // together and disagrees with the consumer about a target nobody touched.
          contentDigest: createHash('sha256').update(bytes).digest('hex'),
        },
      })
    },

    // Parsed before any write, under its shelf path, so error positions name where the draft lives.
    async stageDraft(contents: string): Promise<DraftStageOutcome> {
      const contentDigest = createHash('sha256').update(contents).digest('hex')
      const identityPath = `${DRAFT_SHELF_PARENT}/${DRAFT_SHELF_DIR_NAME}/${contentDigest}.yaml`

      const parsed = parseTestFile(contents, identityPath)
      if (parsed.errors.length > 0) {
        return {
          kind: 'unparsable',
          reason: parsed.errors.map((error) => error.message).join('; '),
        }
      }
      const test = singleDraftTest(parsed.tests)
      if (typeof test === 'string') return { kind: 'unparsable', reason: test }

      // Only now. The shelf's own guards still apply — the digest is character-class checked and
      // the join is boundary-checked — so a defect that produced a hostile digest is refused by
      // `DraftShelfOutsideWorkspaceError` rather than by this function's silence.
      const writtenPath = createDraftShelf(configDir).write(contentDigest, contents)
      return {
        kind: 'staged',
        draft: {
          testId: (test as { 'test-id'?: string })['test-id'] ?? test.name,
          filePath: writtenPath,
          testName: test.name,
          // The target guard compares this value from the same parse that accepted the bytes.
          target: test.target,
          steps: draftStepTexts(test),
          // As above: an editable root the gate scans. A stage that dropped it would re-open the
          // blind spot for every patched draft, which is the path a repair patch takes.
          ...(test.context === undefined ? {} : { context: test.context }),
          contentDigest,
        },
      }
    },

    // RFC 6902 patches go through `stageDraft`, so a result that does not parse writes nothing.
    async applyPatchesToDraft(
      draft: { readonly filePath: string },
      patchSet: TestEditPatchSet,
    ): Promise<DraftStageOutcome> {
      let source: string
      try {
        source = readFileSync(resolve(configDir, draft.filePath), 'utf8')
      } catch (error) {
        return {
          kind: 'unparsable',
          reason: `the staged draft could not be read: ${
            error instanceof Error ? error.message : String(error)}`,
        }
      }

      let rendered: string
      try {
        const parsed = parseTestFileWithTokens(source, draft.filePath)
        applyPatchSetToTestDoc(parsed, patchSet)
        rendered = renderPatchedTestDoc(parsed, draft.filePath)
      } catch (error) {
        return {
          kind: 'unparsable',
          reason: error instanceof Error ? error.message : String(error),
        }
      }

      return await this.stageDraft(rendered)
    },

    // The direct final-test writer; see `publishAuthoredTest`.
    publishDraft(request): Promise<TestFileWrite> {
      // In a mark's edit scope the write is recorded first, so a retry answers without re-editing.
      return Promise.resolve(
        publishAuthoredTest({ configPath, request, beforeWrite: recordMarkEditAhead }),
      )
    },

    // Advisory: an unreadable test is omitted, which can only make a draft look more novel.
    async suiteTextCorpus(): Promise<readonly SuiteTextEntry[]> {
      // The SAME resolution the `knowledgeRoot` closure below performs — one config loader per
      // host, never a second parse with its own layering and its own env precedence.
      const config = await resolveConfig({ configPath, loadAuthPlugins: false })
      const workspace = resolveWorkspacePaths({ config, configPath })
      const files = await discoverWorkspaceFiles({ workspace, kind: 'test' })

      const entries: SuiteTextEntry[] = []
      for (const file of files) {
        try {
          const parsed = parseTestFile(
            readFileSync(file.absolutePath, 'utf8'),
            file.workspaceRelativePath,
          )
          if (parsed.errors.length > 0) continue
          for (const test of parsed.tests) {
            entries.push({
              filePath: file.workspaceRelativePath,
              testName: test.name,
              stepsText: draftStepTexts(test),
            })
          }
        } catch {
          // One unreadable file cannot block a verification. See the note above.
        }
      }
      return entries
    },

    // Target names, not products: a target's product can differ from its name.
    async configuredTargetNames(): Promise<readonly string[]> {
      const config = await resolveConfig({ configPath, loadAuthPlugins: false })
      return listTargets(config).map((target) => target.name)
    },
  }
}

// The leading dot hides drafts from discovery (`dot: false`) while `tests/**` admits runs.
export const DRAFT_SHELF_PARENT = 'tests'
export const DRAFT_SHELF_DIR_NAME = '.agent-qa-drafts'

/** The durable name shape, and the in-flight sibling that is never a draft. */
const DRAFT_SUFFIX = '.yaml'
const DRAFT_TEMP_SUFFIX = '.tmp'

// A `contentDigest` becomes a filename, so the shape must exclude separators, `..` and dotfiles.
const SAFE_DRAFT_DIGEST = /^[A-Za-z0-9_-]{1,128}$/

// A digest that names a path and a path that escapes are one failure; `reason` says which fired.
export class DraftShelfOutsideWorkspaceError extends Error {
  constructor(
    readonly reason: 'unsafe-digest' | 'outside-workspace',
    readonly request: string,
    detail: string,
  ) {
    super(
      `draft shelf: refusing to address ${JSON.stringify(request)} — ${detail}. A shelf path's `
      + 'containment and its identity are the same computation, so a path with no '
      + 'workspace-relative identity is exactly a path no run in this workspace could be handed.',
    )
    this.name = 'DraftShelfOutsideWorkspaceError'
  }
}

function shelfIdentity(configDir: string, workspaceRelativePath: string): string {
  try {
    return workspaceRelativeIdentityPath(configDir, workspaceRelativePath)
  } catch (error) {
    throw new DraftShelfOutsideWorkspaceError(
      'outside-workspace',
      workspaceRelativePath,
      (error as Error).message,
    )
  }
}

/** The absolute shelf directory for one workspace. Creates nothing. */
export function draftShelfDir(configDir: string): string {
  return resolve(configDir, shelfIdentity(configDir, `${DRAFT_SHELF_PARENT}/${DRAFT_SHELF_DIR_NAME}`))
}

/** The absolute path one draft's bytes are addressed by. Creates nothing. */
export function shelfPathFor(configDir: string, contentDigest: string): string {
  if (!SAFE_DRAFT_DIGEST.test(contentDigest)) {
    throw new DraftShelfOutsideWorkspaceError(
      'unsafe-digest',
      contentDigest,
      'a draft digest must be 1-128 characters of [A-Za-z0-9_-]',
    )
  }
  return resolve(
    configDir,
    shelfIdentity(
      configDir,
      `${DRAFT_SHELF_PARENT}/${DRAFT_SHELF_DIR_NAME}/${contentDigest}${DRAFT_SUFFIX}`,
    ),
  )
}

/** Hosts may reject directory handles with only these established portability errors. */
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'])

function fsyncPath(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncPath(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === undefined || !UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) throw error
  }
}

// The temp is PID-suffixed, so concurrent writers never rename each other's half-written bytes.
function writeFileAtomically(path: string, contents: string | Buffer): void {
  const temp = `${path}.${process.pid}${DRAFT_TEMP_SUFFIX}`
  try {
    writeFileSync(temp, contents)
    fsyncPath(temp)
    fsyncDirectory(dirname(temp))
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort, and deliberately silent: see the header.
    }
    throw error
  }
  fsyncDirectory(dirname(path))
}

export interface PublishAuthoredTestInput {
  /** The project's config file; its directory is the workspace root. */
  readonly configPath: string
  readonly request: {
    /** The staged draft's workspace-relative shelf path — where the bytes come from. */
    readonly draftPath: string
    /** Where they go. */
    readonly targetPath: string
    /** The digest of the bytes the caller read at `targetPath`; absent means it must not exist. */
    readonly sourceDigest?: string
  }
  /** Injected for tests; defaults to {@link writeFileAtomically}. */
  readonly writeTarget?: (absolutePath: string, bytes: Buffer) => void
  /** Runs after the digest guard and before the write; a throw refuses the write. */
  readonly beforeWrite?: (write: PendingTestWrite) => void
}

// The digest re-check and the rename are not atomic; nothing locks against a writer between them.
export function publishAuthoredTest(input: PublishAuthoredTestInput): TestFileWrite {
  const { request } = input
  const configDir = dirname(resolve(input.configPath))
  const writeTarget = input.writeTarget ?? writeFileAtomically
  const refused = (
    reason: 'outside-workspace' | 'target-changed' | 'write-failed',
    detail?: string,
  ): TestFileWrite => ({
    kind: 'not-written',
    targetPath: request.targetPath,
    reason,
    ...(detail === undefined ? {} : { detail }),
  })

  let identityPath: string
  let absoluteTarget: string
  let absoluteDraft: string
  try {
    identityPath = workspaceRelativeIdentityPath(configDir, request.targetPath)
    absoluteTarget = resolve(configDir, identityPath)
    absoluteDraft = resolve(configDir, workspaceRelativeIdentityPath(configDir, request.draftPath))
    const realConfigDir = realpathSync(configDir)
    if (
      !resolvesInsideWorkspace(realConfigDir, absoluteTarget)
      || !resolvesInsideWorkspace(realConfigDir, absoluteDraft)
    ) {
      return refused('outside-workspace')
    }
  } catch {
    return refused('outside-workspace')
  }

  let draftBytes: Buffer
  let existing: Buffer | undefined
  try {
    draftBytes = readFileSync(absoluteDraft)
    existing = readTargetIfPresent(absoluteTarget)
  } catch (error) {
    return refused('write-failed', errorText(error))
  }

  const foundDigest = existing === undefined
    ? undefined
    : createHash('sha256').update(existing).digest('hex')
  if (foundDigest !== request.sourceDigest) return refused('target-changed')

  const contentDigest = createHash('sha256').update(draftBytes).digest('hex')
  try {
    input.beforeWrite?.({
      filePath: identityPath,
      ...(foundDigest === undefined ? {} : { sourceDigest: foundDigest }),
      contentDigest,
    })
    mkdirSync(dirname(absoluteTarget), { recursive: true })
    writeTarget(absoluteTarget, draftBytes)
  } catch (error) {
    return refused('write-failed', errorText(error))
  }
  return { kind: 'written', filePath: identityPath, contentDigest }
}

export interface DraftShelf {
  /** Stage one draft's bytes; answers the WORKSPACE-RELATIVE path a run can be handed. */
  write(contentDigest: string, contents: string): string
  /** Every staged draft, sorted, as workspace-relative paths. Never an in-flight temp. */
  list(): readonly string[]
}

/**
 * Bind the shelf over one workspace.
 *
 * LAZY, exactly as the receipts store is: nothing opens and nothing is created until the first
 * write, which is what lets a composition root bind this unconditionally without deciding whether
 * a project has ever authored a draft — an absent directory and an empty shelf are one answer.
 */
export function createDraftShelf(configDir: string): DraftShelf {
  const directory = draftShelfDir(configDir)

  return {
    write(contentDigest: string, contents: string): string {
      const path = shelfPathFor(configDir, contentDigest)
      mkdirSync(directory, { recursive: true })
      writeFileAtomically(path, contents)
      return `${DRAFT_SHELF_PARENT}/${DRAFT_SHELF_DIR_NAME}/${contentDigest}${DRAFT_SUFFIX}`
    },

    list(): readonly string[] {
      let names: readonly string[]
      try {
        names = readdirSync(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      // DETERMINISTIC ORDER, and an in-flight temp is NOISE rather than a draft: it sits beside a
      // durable name that either is already in this listing or is about to be.
      return [...names]
        .sort()
        .filter(name => !name.endsWith(DRAFT_TEMP_SUFFIX) && name.endsWith(DRAFT_SUFFIX))
        .map(name => `${DRAFT_SHELF_PARENT}/${DRAFT_SHELF_DIR_NAME}/${name}`)
    },
  }
}

/** An unknown throw as one readable sentence. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The enumeration lives in `schema` because `agent` reads the same answer and may not import `cli`.

// Reads the config because `workspace.hooksFile` can name any file.
async function resolvePinnedConfigSet(configPath: string): Promise<{
  readonly configIdentity: string
  readonly hooksFile: string
  readonly members: readonly string[]
}> {
  const configDir = dirname(resolve(configPath))
  const configIdentity = workspaceRelativeIdentityPath(configDir, configPath)
  const fileConfig = await loadConfigFile(configPath) as { workspace?: { hooksFile?: unknown } }
  const named = typeof fileConfig.workspace?.hooksFile === 'string'
    ? fileConfig.workspace.hooksFile
    : undefined

  // THE ONE ENUMERATION, imported. Deduplication, ordering and the default hooks file are all its
  // business, so no consumer of this answer can disagree about which files are config.
  const members = enumerateConfigFileSet({
    configFile: configIdentity,
    ...(named === undefined ? {} : { hooksFile: named }),
  })

  return {
    configIdentity,
    // Named, not matched: the validator picks the hooks schema by this member.
    hooksFile: named === undefined || named === '' ? CONFIG_SET_DEFAULT_HOOKS_FILE : named,
    members,
  }
}

// `parseDocument`, `setIn`, `toString` keep comments; an object round trip would strip them all.
export function createConfigFilesPort(configPath: string): ConfigFilesPortLike {
  const configDir = dirname(resolve(configPath))
  const configIdentity = workspaceRelativeIdentityPath(configDir, configPath)

  return {
    async read(): Promise<ConfigFileSet> {
      const { hooksFile, members } = await resolvePinnedConfigSet(configPath)

      return {
        configFile: configIdentity,
        hooksFile,
        files: members.map((path) => {
          const bytes = readTargetIfPresent(resolve(configDir, path))
          // ABSENT MEANS ABSENT. A zero-length stand-in would make "there is no hooks file" and
          // "there is an empty hooks file" the same fact, and the apply's `baseDigest` re-check
          // reads exactly that distinction.
          return bytes === undefined ? { path } : { path, bytes: Uint8Array.from(bytes) }
        }),
      }
    },

    // Shape only, never values: answering values would make this an unmasked config reader.
    inspect({ bytes, paths }): Promise<readonly ConfigPathFacts[]> {
      const document = bytes === undefined
        ? new YamlDocument({})
        : parseDocument(Buffer.from(bytes).toString('utf8'))
      return Promise.resolve(paths.map((path) => {
        const node = document.getIn(path.split('.'), true)
        if (node === undefined || node === null) return { path, present: false }
        if (isSeq(node)) return { path, present: true, kind: 'sequence' as const, length: node.items.length }
        if (isMap(node)) {
          return {
            path,
            present: true,
            kind: 'map' as const,
            // DOCUMENT ORDER, not sorted: these names are read back to a person as "did you mean",
            // and the order they appear in the file is the order they will be looked for in it.
            keys: node.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)),
          }
        }
        return { path, present: true, kind: 'scalar' as const }
      }))
    },

    // A host fact: `agent` may not depend on the ids package or read randomness.
    mintHookId(): string {
      return generateHookId()
    },

    setField({ bytes, path, value }): Promise<ConfigFieldSetResult> {
      const document = bytes === undefined
        ? new YamlDocument({})
        : parseDocument(Buffer.from(bytes).toString('utf8'))
      const segments = path.split('.')
      // Read through the same document first, so the classifier sees the value this edit replaces.
      const previous = document.getIn(segments) as unknown
      document.setIn(segments, value)
      const mutated = Uint8Array.from(Buffer.from(document.toString(), 'utf8'))
      return Promise.resolve(
        typeof previous === 'string'
          || typeof previous === 'number'
          || typeof previous === 'boolean'
          ? { bytes: mutated, previousValue: previous }
          : { bytes: mutated },
      )
    },
  }
}

// Validates every member of the file set by its own schema; `.gitignore` is skipped.
export function createConfigValidatePort(): ConfigValidatePortLike {
  return {
    validate({ configFile, hooksFile, files }): Promise<ConfigValidation> {
      const issues: ConfigValidationIssue[] = []

      for (const member of files) {
        if (member.bytes === undefined) continue
        // WHICH SCHEMA IS DECIDED BY WHICH MEMBER THIS IS, and the config file is named by the set
        // rather than matched by extension: a project whose config is `agent-qa.yml` is still that
        // project's config, and the hooks file is whatever `workspace.hooksFile` said it was.
        const isConfig = member.path === configFile
        const isHooks = !isConfig && member.path === hooksFile
        if (!isConfig && !isHooks) continue

        let parsed: unknown
        try {
          parsed = parseYaml(Buffer.from(member.bytes).toString('utf8'))
        } catch (error) {
          // Position only: the yaml library's message quotes the person's source line.
          issues.push({ path: member.path, message: yamlParseFailureMessage(error) })
          continue
        }

        if (isConfig) {
          // Merged with env overrides first, as a run does: the schema describes a complete config.
          const merged = mergeConfigs(parsed ?? {}, loadEnvOverrides(), {})
          const result = AgentQaConfigSchema.safeParse(normalizeConfigForValidation(merged))
          // The validator's OWN words, joined to a path. This layer reports issues; it does not
          // classify them, because a closed issue vocabulary here would be a second, weaker copy of
          // core's refinements, out of date the first time one is added.
          if (!result.success) {
            // The path is the file; the dotted config path stays inside the message.
            issues.push(...result.error.issues.map((issue) => ({
              path: member.path,
              message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
            })))
          }
          continue
        }

        // An EMPTY hooks file is a hooks file with no hooks, which is legal and common; `parseYaml`
        // answers `null` for one, and refusing that would refuse every project that has the file and
        // has not written a hook yet.
        if (parsed === null || parsed === undefined) continue
        const hooks = HooksFileSchema.safeParse(parsed)
        if (!hooks.success) {
          issues.push(...hooks.error.issues.map((issue) => ({
            path: member.path,
            message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          })))
        }
      }

      return Promise.resolve(issues.length === 0 ? { ok: true } : { ok: false, issues })
    },
  }
}

type ConfigWritePort = NonNullable<FunctionDeps['configWrite']>
type ConfigFilePublishOutcome = Awaited<ReturnType<ConfigWritePort['publishFiles']>>

// True when the file, or the nearest ancestor that exists, resolves inside the real config
// directory, so a symlink cannot carry a publication out of the workspace.
function resolvesInsideWorkspace(realConfigDir: string, absolutePath: string): boolean {
  let probe = absolutePath
  let rest = ''
  for (;;) {
    let real: string
    try {
      real = realpathSync(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) return false
      rest = rest === '' ? basename(probe) : join(basename(probe), rest)
      probe = parent
      continue
    }
    const inside = relative(realConfigDir, rest === '' ? real : join(real, rest))
    return inside !== '' && !isAbsolute(inside) && inside.split(sep)[0] !== '..'
  }
}

async function dashboardConfigManager(path: string, mask: MaskFn) {
  const { ConfigManager } = await import('@vostride/agent-qa-dashboard')
  return new ConfigManager(path, mask)
}

// Field changes take the path's shared write turn; whole files are digest-checked first.
export function createConfigWritePort(configPath: string, mask: MaskFn): ConfigWritePort {
  const absoluteConfigPath = resolve(configPath)
  const configDir = dirname(absoluteConfigPath)
  const configIdentity = workspaceRelativeIdentityPath(configDir, absoluteConfigPath)

  return {
    async applyFields({ changes }) {
      const outcome = await (await dashboardConfigManager(absoluteConfigPath, mask)).applyChanges(changes)
      if (outcome.kind === 'ok') {
        return {
          kind: 'applied',
          file: configIdentity,
          revision: outcome.revision,
          baseRevision: outcome.baseRevision,
        }
      }
      return {
        kind: 'refused',
        file: configIdentity,
        error: outcome.error,
        ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
        ...(outcome.path === undefined ? {} : { path: outcome.path }),
      }
    },

    async publishFiles({ files }): Promise<ConfigFilePublishOutcome> {
      if (files.length === 0) return { kind: 'refused', reason: 'no-files', written: [] }
      const { ConfigManager } = await import('@vostride/agent-qa-dashboard')
      const realConfigDir = realpathSync(configDir)
      const planned: { identity: string; absolutePath: string; expected: string; bytes: Uint8Array }[] = []
      for (const file of files) {
        let identity: string
        try {
          identity = workspaceRelativeIdentityPath(configDir, file.path)
        } catch {
          return { kind: 'refused', reason: 'outside-workspace', path: file.path, written: [] }
        }
        if (planned.some((entry) => entry.identity === identity)) {
          return { kind: 'refused', reason: 'duplicate-path', path: file.path, written: [] }
        }
        const absolutePath = resolve(configDir, identity)
        if (!resolvesInsideWorkspace(realConfigDir, absolutePath)) {
          return { kind: 'refused', reason: 'outside-workspace', path: file.path, written: [] }
        }
        const existing = readTargetIfPresent(absolutePath)
        if ((existing === undefined ? undefined : sha256hexBytes(existing)) !== file.baseDigest) {
          return { kind: 'refused', reason: 'file-changed', path: file.path, written: [] }
        }
        // Every planned file is checked before any is written.
        if (ConfigManager.addsShownMarker(existing, file.bytes)) {
          return { kind: 'refused', reason: 'marker_written_back', path: file.path, written: [] }
        }
        planned.push({
          identity,
          absolutePath,
          expected: file.baseDigest ?? CONFIG_REVISION_ABSENT,
          bytes: file.bytes,
        })
      }

      const written: string[] = []
      for (const [index, file] of planned.entries()) {
        const unwritten = planned.slice(index + 1).map((entry) => entry.identity)
        let replaced: Awaited<ReturnType<Awaited<ReturnType<typeof dashboardConfigManager>>['replaceDocument']>>
        try {
          const manager = await dashboardConfigManager(file.absolutePath, mask)
          replaced = await manager.replaceDocument(file.expected, file.bytes)
        } catch (error) {
          return {
            kind: 'interrupted',
            written,
            failed: { path: file.identity, reason: 'write-failed', message: errorText(error) },
            unwritten,
          }
        }
        const markerRefused = replaced.kind === 'refused' && replaced.error === 'marker_written_back'
        if (markerRefused && written.length === 0) {
          return { kind: 'refused', reason: 'marker_written_back', path: file.identity, written: [] }
        }
        if (replaced.kind === 'refused') {
          return {
            kind: 'interrupted',
            written,
            failed: { path: file.identity, reason: 'file-changed' },
            unwritten,
          }
        }
        written.push(file.identity)
      }
      return { kind: 'published', written }
    },
  }
}

// `agent-qa init` renders these same functions, so a scaffold has one producer.
export function createScaffoldContentPort(): ConfigScaffoldContentPortLike {
  return {
    render({ targetName, baseUrl, existingGitignore, existingConfig }) {
      // No model entries: a from-zero request carries a domain only, so `registry.llms` stays bare.
      const files = buildScaffoldFileSet({
        targetName,
        baseUrl,
        // Host defaults resolved here, because `scaffold-content.ts` may not name core.
        cacheDir: DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache',
        authStatesDir: DEFAULT_AGENT_QA_AUTH_STATES_DIR || '.agent-qa/auth-states',
        gitignoreEntries: TARGET_GITIGNORE_ENTRIES,
        ...(existingGitignore === undefined
          ? {}
          : { existingGitignore: Buffer.from(existingGitignore).toString('utf8') }),
        // Decoded here because the port speaks bytes; paths cross in the pinned set's own spelling.
        ...(existingConfig === undefined
          ? {}
          : {
            existingConfig: {
              path: existingConfig.path,
              text: Buffer.from(existingConfig.bytes).toString('utf8'),
              hooksPath: existingConfig.hooksPath,
              hooksPresent: existingConfig.hooksPresent,
            },
          }),
      })
      return Promise.resolve(files.map((file) => ({
        path: file.path,
        bytes: Uint8Array.from(Buffer.from(file.text, 'utf8')),
      })))
    },
  }
}

// Raw bytes, no decoding: the digest over this value is compared with one over the file's bytes.
function readTargetIfPresent(absolutePath: string): Buffer | undefined {
  try {
    return readFileSync(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The runs database `agent-qa run` writes and `agent-qa dashboard` reads for this config: the
 * configured path, else the default. A legacy dashboard.db is never bound here, because the writer
 * renames it and a reader holding it open across that rename would read a moved WAL database; it
 * answers not recorded until a writer has renamed it. A config `resolveConfig` refuses binds nothing.
 */
function projectRunsDbPath(configPath: string): string | undefined {
  try {
    const merged = mergeConfigs(parseYaml(readFileSync(configPath, 'utf8')) ?? {}, loadEnvOverrides(), {})
    const config = AgentQaConfigSchema.parse(normalizeConfigForValidation(merged))
    const configured = config.services?.dashboard?.dbPath?.trim()
    return resolve(dirname(resolve(configPath)), configured || DEFAULT_AGENT_QA_RUNS_DB_PATH)
  } catch {
    return undefined
  }
}

export function composeCliLocalAgent(input: ComposeCliLocalAgentInput): LocalAgentHost {
  // Narrowed once, here, so the hook closures below close over a value TypeScript knows is present
  // rather than re-reading an optional field at call time.
  const analytics = input.analytics
  const knowledgeRoot = async (): Promise<string> => {
    const config = await resolveConfig({ configPath: input.configPath, loadAuthPlugins: false })
    return resolveKnowledgeRoot(config.knowledge, dirname(resolve(input.configPath)))
  }

  // Bound whenever the config parses; a read before the runs database exists creates nothing.
  let projectRunDetail: ReturnType<typeof import('../commands/dashboard.js').openProjectRunDetailReader> | undefined
  const runsDbPath = input.runDetail === undefined ? projectRunsDbPath(input.configPath) : undefined
  const openRunDetail = (dbPath: string): NonNullable<typeof projectRunDetail> | undefined => {
    if (projectRunDetail === undefined) {
      if (!existsSync(dbPath)) return undefined
      // A failed open is not remembered: the next read tries again.
      const pending = import('../commands/dashboard.js')
        .then(({ openProjectRunDetailReader }) => openProjectRunDetailReader(dbPath))
      projectRunDetail = pending
      pending.catch(() => { if (projectRunDetail === pending) projectRunDetail = undefined })
    }
    return projectRunDetail
  }
  const runDetail: ComposeCliLocalAgentInput['runDetail'] = input.runDetail
    ?? (runsDbPath !== undefined
      ? {
          read: async (runId) => {
            const opened = openRunDetail(runsDbPath)
            return opened === undefined ? undefined : (await opened).reader.read(runId)
          },
          readRecord: async (runId) => {
            const opened = openRunDetail(runsDbPath)
            return opened === undefined ? undefined : (await opened).reader.readRecord(runId)
          },
        }
      : undefined)

  const declaredSecrets = input.declaredSecrets ?? createDeclaredSecretMask(input.configPath)
  const host = composeLocalAgent({
    mask: declaredSecrets.mask,
    feedback: createFeedbackPortForHost({
      configPath: input.configPath, agentQaRoot: input.agentQaRoot, randomUuid: randomUUID,
      invokeAuthoringDraftEdit: async draftInput => AuthoringDraftEditOutputSchema.parse(
        await invokeFunction(host.registry, AUTHORING_DRAFT_EDIT_FUNCTION_ID, draftInput, CLI_FUNCTION_CALLER),
      ),
      // A mark made while a live daemon holds the writer lease goes to that daemon whole.
      wholeMarkDelegate: input.wholeMarkDelegate ?? delegateMarkViaDaemon({
        agentQaRoot: input.agentQaRoot,
        resolveKnowledgeRoot: knowledgeRoot,
      }),
    }),
    // A dedicated read host, so history never reaches the writer's lock, lease or draft path.
    feedbackReads: createFeedbackReadsPortForHost({ agentQaRoot: input.agentQaRoot, configPath: input.configPath,
      canDraftTestEdit: true }),
    agentQaRoot: input.agentQaRoot,
    mintQuarantineIdentityPath: createQuarantineIdentityMint(input.configPath),
    // The in-process drive is the default; `input.runExecution` is the override cells substitute.
    runExecution: input.runExecution ?? createComposedRunExecution({
      configPath: input.configPath,
      agentQaRoot: input.agentQaRoot,
      resolveExecutionContext: input.resolveExecutionContext,
      ...(input.runBridge === undefined ? {} : { runBridge: input.runBridge }),
      ...(input.runTrigger === undefined ? {} : { runTrigger: input.runTrigger }),
      ...(analytics === undefined ? {} : { analytics }),
    }),
    // The live-view mint seam, forwarded untouched.
    ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
    // The run-detail projection read, spread only when present.
    ...(runDetail === undefined ? {} : { runDetail }),
    // Always bound, because a CLI always has a config path.
    draftAuthoring: createDraftAuthoringPort(input.configPath),
    // The config editor's ports, bound unconditionally because a CLI always has a config path.
    configFiles: createConfigFilesPort(input.configPath),
    configValidate: createConfigValidatePort(),
    // Bound unconditionally: a pure render of the producer `agent-qa init` writes from.
    scaffoldContent: createScaffoldContentPort(),
    // The direct config writer every config change op writes through.
    configWrite: createConfigWritePort(input.configPath, declaredSecrets.mask),
    // The chat host's model is handed through, so explain never builds a second unmasked model.
    capabilityCatalog: createCliCapabilityCatalogPort({
      agentQaRoot: input.agentQaRoot,
      ...(input.chatModel === undefined ? {} : { model: input.chatModel }),
      ...(analytics === undefined ? {} : {
        onAnswered: () => {
          analytics.port.capture(analyticsEvent(analytics, 'agent-qa.explain.answered', {}))
        },
        onAbstained: (counts) => {
          analytics.port.capture(analyticsEvent(analytics, 'agent-qa.explain.abstained', {
            suggested_row_count: counts.suggestedRowCount,
            catalog_empty: counts.catalogEmpty,
          }))
        },
      }),
    }),
    config: input.config ?? createConfigReader(input.configPath, declaredSecrets.mask),
    knowledgeRoot,
    // Spread only when present, so a host supplying nothing composes unchanged.
    ...(input.resolveExecutionContext === undefined
      ? {}
      : { resolveExecutionContext: input.resolveExecutionContext }),
    ...(input.observeSessionEvent === undefined
      ? {}
      : { observeSessionEvent: input.observeSessionEvent }),
    // A knowledge change under a live daemon's lease goes to it as the same op and identity.
    knowledgeChangeDelegate: input.knowledgeChangeDelegate ?? delegateKnowledgeChangeViaDaemon({
      agentQaRoot: input.agentQaRoot,
      resolveKnowledgeRoot: knowledgeRoot,
    }),
    // Deferred, and never called by a host that only invokes a function op: the queue is opened by
    // `jobs()` and nothing else resolves a provider handle.
    model: input.model ?? (() => resolveCliJobModel(input.configPath)),
    // The author's compaction budget, from the same profile resolution as the model, resolved once.
    analysisTokenBudget:
      input.analysisTokenBudget ?? (() => resolveCliAnalysisTokenBudget(input.configPath)),
    ...(input.postRun === undefined
      ? {}
      : {
          postRun: {
            curateRun: input.postRun.curateRun,
            candidateProse: input.postRun.candidateProse,
          },
        }),
    ...(input.chatPresent === undefined ? {} : { chatPresent: input.chatPresent }),
    // Already built through `createModel`; absent leaves the composition's headless posture.
    ...(input.chatModel === undefined ? {} : { chatModel: input.chatModel }),
    ...(input.chatModelFor === undefined ? {} : { chatModelFor: input.chatModelFor }),
    ...(input.chatAccounting === undefined ? {} : { chatAccounting: input.chatAccounting }),
    // Absent must stay absent: the composition's own `??` default is where the safe strategy lives.
    ...(input.chatReconcile === undefined ? {} : { chatReconcile: input.chatReconcile }),
  })
  const closeHost = host.close.bind(host)
  return Object.assign(host, {
    close: async () => {
      try {
        await closeHost()
      } finally {
        await projectRunDetail?.then(opened => opened.close(), () => undefined)
      }
    },
  })
}

// A non-daemon holder refuses at once: knowledge-local calls this inside its held-lease branch.
export function delegateKnowledgeChangeViaDaemon(input: {
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => string | Promise<string>
}): ExplicitReviewDelegate {
  return async ({ request, operationId }) => {
    if (request.verb === 'mark') {
      throw new TypeError('a mark changes knowledge through runs.mark, never through a change op')
    }
    const knowledgeRoot = await input.resolveKnowledgeRoot()
    const lease = LOCAL_DAEMON_CAPABILITIES.readWriterLease(knowledgeRoot)
    const holderPid = lease.kind === 'parsed' ? lease.lease.pid : undefined
    const daemon = await classifyDaemonRegistration({ agentQaRoot: input.agentQaRoot, knowledgeRoot })
    if (daemon.kind !== 'live-confirmed') {
      if ((daemon.kind === 'unreachable-lease-fresh' || daemon.kind === 'unreachable-lease-stale')
        && daemon.registration.pid === holderPid) {
        throw new DaemonNotRunningError(daemon.kind)
      }
      throw new KnowledgeWriterLeaseBusyError(holderPid)
    }
    const answer = KnowledgeChangeOutputSchema.parse(await invokeViaDaemon({
      agentQaRoot: input.agentQaRoot,
      knowledgeRoot,
      // The verb's own change op: `knowledge.accept`, `knowledge.reject` or `knowledge.forget`.
      functionId: `knowledge.${request.verb}`,
      input: { ...request.input, operationId },
    }))
    return explicitResultOf(answer, operationId)
  }
}

// Non-daemon holds last one curation or change, so this covers them without feeling like a hang.
export const MARK_LEASE_HOLDER_RELEASE_BUDGET_MS = 10_000
const MARK_LEASE_HOLDER_POLL_MS = 100

// Decided before the mark takes any lock, lease or write, from the lease and daemon registration.
export function delegateMarkViaDaemon(input: {
  readonly agentQaRoot: string
  readonly resolveKnowledgeRoot: () => string | Promise<string>
  readonly holderReleaseBudgetMs?: number
  readonly pollIntervalMs?: number
}): WholeMarkDelegate {
  const budgetMs = input.holderReleaseBudgetMs ?? MARK_LEASE_HOLDER_RELEASE_BUDGET_MS
  const pollMs = input.pollIntervalMs ?? MARK_LEASE_HOLDER_POLL_MS
  return async (mark) => {
    const knowledgeRoot = await input.resolveKnowledgeRoot()
    const startedAt = Date.now()
    while (true) {
      const lease = LOCAL_DAEMON_CAPABILITIES.readWriterLease(knowledgeRoot)
      if (lease.kind !== 'parsed') return undefined
      const freshness = LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness(
        knowledgeRoot,
        lease.lease,
        Date.now(),
      )
      if (freshness.kind !== 'fresh') return undefined
      const daemon = await classifyDaemonRegistration({
        agentQaRoot: input.agentQaRoot,
        knowledgeRoot,
      })
      if (daemon.kind === 'live-confirmed') {
        return RunsMarkOutcomeSchema.parse(await invokeViaDaemon({
          agentQaRoot: input.agentQaRoot,
          knowledgeRoot,
          functionId: RUNS_MARK_FUNCTION_ID,
          input: mark,
        }))
      }
      if ((daemon.kind === 'unreachable-lease-fresh' || daemon.kind === 'unreachable-lease-stale')
        && daemon.registration.pid === lease.lease.pid) {
        throw new DaemonNotRunningError(daemon.kind)
      }
      const waitedMs = Date.now() - startedAt
      if (waitedMs >= budgetMs) throw new MarkWriterLeaseBusyError(lease.lease.pid, waitedMs)
      const pauseMs = Math.min(pollMs, budgetMs - waitedMs)
      await new Promise(resolveWait => setTimeout(resolveWait, pauseMs))
    }
  }
}

// The daemon's mark host: it commits with the held authority and binds no delegate.
export function createLeaseHolderFeedbackPort(input: {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly writerAuthority: MarkWriterAuthority
  readonly registry: () => FunctionRegistry
  readonly caller: FunctionCaller
}): FeedbackPort {
  return createFeedbackPortForHost({
    configPath: input.configPath,
    agentQaRoot: input.agentQaRoot,
    randomUuid: randomUUID,
    writerAuthority: input.writerAuthority,
    invokeAuthoringDraftEdit: async draftInput => AuthoringDraftEditOutputSchema.parse(
      await invokeFunction(
        input.registry(),
        AUTHORING_DRAFT_EDIT_FUNCTION_ID,
        draftInput,
        input.caller,
      ),
    ),
  })
}

/** The daemon's public answer to a delegated knowledge change, read back as the writer's result. */
function explicitResultOf(
  answer: ReturnType<typeof KnowledgeChangeOutputSchema.parse>,
  operationId: string,
): ExplicitReviewResult {
  const changeId = `prop_${operationId.toLowerCase()}`
  switch (answer.outcome) {
    case 'applied':
      return {
        outcome: 'applied',
        verb: answer.verb,
        changeId,
        recordIds: answer.recordIds,
        ...(answer.forgetReceipt === undefined ? {} : { forgetReceipt: answer.forgetReceipt }),
        ...(answer.commitReceipt === undefined ? {} : { commitReceipt: answer.commitReceipt }),
      }
    case 'target-not-found':
      return { outcome: 'target-not-found', verb: answer.verb, changeId, target: answer.target }
    case 'refused':
      return { outcome: 'policy-materialize-refused', verb: answer.verb, changeId }
    default:
      return answer satisfies never
  }
}
