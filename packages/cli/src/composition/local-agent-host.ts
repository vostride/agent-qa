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
// The CLI's half of the local host (Phase 384 plan 01, superseded in place by 385 plan 09, D-15).
//
// What used to live here — the runs reader, the knowledge listing binding and the registry
// assembly — moved to `composeLocalAgent()` in `@vostride/agent-qa-agent-local`, which 386's daemon
// calls too. What stays is what only THIS host can answer: who the caller is, how a configuration
// file is resolved and masked, which model a job would author with, and — since 385 plan 10 — how
// a run is executed. Each of those is a port the composition takes, so the two hosts share a
// composition rather than each writing one.
//
// 391 PROP-01 bound the interactive confirmation here, because only a surface knows whether a
// person is on the other end. 432-16 (D-14) deleted it with the gate it answered: nothing asks, so
// this host and the daemon compose the same registry with no confirm at all.
//
// The run executor lives HERE rather than in a file of its own for the reason plan 09's model
// binding did: minting a run id needs `@vostride/agent-qa-core`, the FUNC-02 firewall forbids a
// surface naming it without a ledger entry, and the ledger only ever SHRINKS — new surface code
// can never join it. This file already carries that entry, so the placement mints none.

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
  // 395-05: the canonical hook-id mint, through `core`'s re-export beside `generateRunId` rather
  // than from the ids package directly — `packages/cli`'s ownership contract was deliberately
  // emptied of that dependency by 394-11 and this needs no reopening of it.
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
  // 395-14: the position-only yaml-fault sentence, LIFTED out of this file into core. It was a
  // private copy here; the cli loader guard and core's own `validateConfig` arm need the same
  // sentence, and two spellings of one sentence are two things that can drift apart. The bytes this
  // file emits are unchanged — only the definition moved.
  yamlParseFailureMessage,
} from '@vostride/agent-qa-core'
import type { RunAttributeTrigger, TestDefinition } from '@vostride/agent-qa-core'
import type {
  ExplicitReviewDelegate,
  ExplicitReviewResult,
} from '@vostride/agent-qa-agent-local'
import type {
  ConfigScaffoldContentPortLike,
} from '@vostride/agent-qa-agent'
// D-04: the ONE scaffold producer. `agent-qa init` renders these same functions and writes them
// to disk; this host renders them into a proposal's file bytes. No second copy exists.
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
// TYPE-ONLY, and that matters here: `in-process-run-execution.ts` imports `commands/run.ts`'s
// producers statically and `commands/run.ts` imports THIS file, so a VALUE import back would close
// an ESM cycle at module-evaluation time (401-11, Deviations 1). A `import type` is erased, adds no
// runtime edge, and is how this host names the option shapes it merely passes through — the port
// itself is still acquired through the deferred `await import(...)` in `createComposedRunExecution`.
import type { InProcessCliRunExecutionOptions } from './in-process-run-execution.js'
import type { RunRecordHostBinding } from '../commands/run.js'
// Type-only: the pump's authority shape, named here because this door's drain leg declares
// what its `takeLease` thunk answered. Erased at emit, so no runtime edge is added.
import type { CurationWriterAuthority } from '../curation/curation-tail.js'
import { buildMaskedResolvedConfig } from './masked-config.js'
import { createDeclaredSecretMask, type DeclaredSecretMask } from './declared-secrets.js'

/**
 * The CLI's caller record.
 *
 * 2026-10-01 (432-20/432-21, D-12): every door can call every operation, so this record carries no
 * scope set and no safe-mode flag. The full-local-grants list it used to spell — pinned set-equal
 * to `FunctionScopeSchema.options` so a later scope could not be silently omitted — and the reason
 * it gave (an operator at their own terminal already has every power the CLI can exercise) are both
 * what D-12 made true of every caller; nothing reads a grant any more. What stays is attribution.
 */
export const CLI_FUNCTION_CALLER: FunctionCaller = {
  surface: 'cli',
  // A person typed the command. The origin is a property of the composition, never of the call,
  // and nothing downstream may set it. Since 432-20 nothing reads it to decide what may happen; the
  // receipts and audit rows that record a caller's origin still do.
  origin: 'human',
}

// The `config.get` binding: every value crosses into the function layer through the declared mask
// (441-20, D-29). `loadAuthPlugins: false` keeps the read a read: resolving a capability must not
// load and execute plugin code.
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

// 2026-10-17 (443-06, D-24): the door a request arrived on, scoped to that request, so one host
// serving several doors (the dashboard) records each run's own trigger.
const runDoorScope = new AsyncLocalStorage<RunAttributeTrigger>()

export function withRunDoor<T>(trigger: RunAttributeTrigger, fn: () => T): T {
  return runDoorScope.run(trigger, fn)
}

export function currentRunDoor(): RunAttributeTrigger | undefined {
  return runDoorScope.getStore()
}

/**
 * The chat / `fn` / MCP door's run execution: the ONE in-process drive (401-05).
 *
 * D-01 — THIS RETIRED THE SECOND SPAWN FAMILY, and 401-10 deleted what was left of it. The retired
 * `createCliRunExecution` re-entered `agent-qa run` as a child process; every field a caller could
 * not express became a `--` operand and every refusal died in the child's stderr. This door hands
 * the caller the core's refusal with its reason intact, because the run starts in this process.
 *
 * D-07 — THE POSTURE TRAVELS EXPLICITLY, AND IT IS THIS DOOR'S OWN ANSWER. `executionContext` is
 * `input.resolveExecutionContext` when the host supplied one and this process's real TTY/CI
 * detection otherwise, which is exactly what `agent-qa run` resolves. The run records it.
 *
 * NOTHING ASKS (432-13, D-01/D-14/D-15). No confirm port, session trust or standing-approval reader
 * reaches the drive: a non-production run starts in one call from every context, and production
 * is refused by the core before any effect unless the config opts in. The `gate` argument the
 * composition used to hand this port (the dispatch-grant overlay) was deleted in 432-18.
 *
 * THE DOOR READS ITS OWN PREFLIGHT so the config, the env file and the secrets file are read once
 * rather than twice: the resolved inputs are handed to the drive through `inputs`.
 *
 * WHAT IS DELIBERATELY ABSENT, each because an option nothing reads is a stub with a type on it:
 * `produceMembers` (the default
 * dispatcher is MODE-AWARE, which is what makes an argument-less request and a suite pattern both
 * work at this door) and `afterVerdict` (a `runs.start` ack is a START, not an outcome — there is
 * no door-level fold to apply).
 *
 * ═══ 2026-08-26 — Phase 404 D-05: WHAT `afterVerdict`'s ABSENCE USED TO COST ═══
 *
 * It was not merely "no fold to apply". `afterVerdict` was also where `commands/run.ts` performed
 * the durable `analyze-run` ENQUEUE, so every run through this door — the dashboard, MCP and chat
 * doors all reach it — finished its verdict and queued NOTHING. A dashboard-only user's run was
 * analysed and curated by nobody, ever, and read `pending` for as long as they cared to look.
 *
 * The enqueue is now the CORE's: the runner shell awaits a post-verdict step between `verdict` and
 * `runFinished` on every door (`curation/post-verdict-step.ts`), so this door needs no fold to
 * queue its work and the sentence above is once again about folding alone.
 *
 * The DRAIN leg is `postRunTail` below (D-06), and it is deliberately NOT `afterVerdict`. A drain
 * inside `afterVerdict` is inside `execute()`, and `dashboard-server` emits `'run-settled'` — db
 * finalize, Appium release, handle cleanup — when that promise settles, so the runs list would show
 * "running" for a minute after the verdict and a leased device would stay leased (Pitfall 2). The
 * drive starts the tail AFTER `afterVerdict` settles, does not await it, and hands it the run's
 * close-out.
 *
 * WHAT ARRIVES FROM THE HOST SINCE 401-07: `onSession`, `resolveAppiumUrl` and `resolveRunFlags`,
 * all through `runBridge` and all absent unless a host asks. A host that watches its runs needs the
 * first; one that leases devices needs the second. Every run is recorded in runs.db through one
 * record per execute (443-05, D-02); a host holding a runs.db handle lends it as `runBridge.record`.
 *
 * IT IS ACQUIRED THROUGH A DEFERRED IMPORT, and that is load-bearing rather than stylistic.
 * `composition/in-process-run-execution.ts` imports `commands/run.js`'s producers statically — the
 * surface firewall's only legal route for that vocabulary — and a static import back from here would
 * close a cycle at module-evaluation time; an ESM cycle survives only while every edge is call-time.
 * Both of the drive's own call sites and the daemon's composition defer for the same reason.
 */
function createComposedRunExecution(input: {
  readonly configPath: string
  readonly agentQaRoot: string
  readonly resolveExecutionContext: ComposeLocalAgentInput['resolveExecutionContext']
  readonly runBridge?: ComposeCliLocalAgentInput['runBridge']
  readonly runTrigger?: RunAttributeTrigger
  readonly analytics?: CliAnalyticsHost
}): RunExecutionPort {
  return {
    // 432-13: the port's second argument (the retired run gate's standing-approval reader) is not
    // taken. Nothing asks, so there is no approval for a reader to satisfy.
    async execute(request: RunsStartInput): Promise<{ runId: RunId }> {
      const trigger = currentRunDoor() ?? input.runTrigger ?? 'cli'
      const { createRunRecord, doorRunAttributes, resolveRunInvocationInputs } = await import('../commands/run.js')
      const {
        refuseUnhonourableRequestFields,
        runInProcessCliRun,
      } = await import('./in-process-run-execution.js')
      const analytics = input.analytics
      const runSession =
        analytics === undefined ? undefined : await import('../run-session-composition.js')

      // THE REFUSAL COMES FIRST, and at THIS door rather than only inside the drive: the
      // preflight below reads the caller's config and secrets, which a refused call should not
      // cost. It is the drive's own exported predicate over the core's own field set.
      refuseUnhonourableRequestFields(request)

      // The request may name another config; the drive resolves against exactly this expression, so
      // a preflight read here that used a different one would resolve a different project.
      const configPath = request.configPath ?? input.configPath
      // Both `warn` seams, pointed at one place. `console.warn` writes to stderr, which is the only
      // channel free at every door this host serves: `agent-qa fn --json` owns stdout and the MCP
      // host's stdout IS the JSON-RPC connection. Dropping them — the drive's own default — would
      // make this the one door where a quarantine fold happens silently.
      const warn = (message: string): void => { console.warn(message) }
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

      // 444 D-48: resolved once, so the run and its tail's exit line read the same context.
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
            // THE LOCAL CAPTURE FIRST, THEN THE HOST'S BRIDGE (401-07). The capture is what the
            // `catch` below reads to tell a run that STARTED from one that never did, so it can
            // never be REPLACED by a host's hook — it is chained. A bridge that threw here would
            // fail the run, which is correct: a host that asked to watch its runs and cannot is a
            // host whose surface would silently show nothing.
            onSession: (session) => {
              startedRunId = session.id as unknown as string
              input.runBridge?.onSession?.(session)
            },
            runRecord,
            // 2026-10-21 (447-08, D-16): subscribed directly, because `attachRunSubscribers`'
            // wire reporter can print to stdout.
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
            // ═══ 2026-08-26 — Phase 404 D-06: THIS DOOR'S DRAIN LEG ═══
            //
            // `postRunTail` and not `afterVerdict`: the drive starts this AFTER `afterVerdict`
            // settles and does NOT await it, so `execute()` resolves and `dashboard-server`'s
            // `'run-settled'` (db finalize, Appium release, handle cleanup) fires on the verdict's
            // clock rather than on the drain's (RESEARCH Pitfall 2).
            //
            // DRAIN ONLY IF THE LEASE WAS ACTUALLY TAKEABLE. `takeAcquiredLease()` is the step's
            // one acquisition; `undefined` means somebody else holds it (or the posture was
            // `detached`), and this door declines to consult a second time for itself — so it
            // says `withoutLease: 'skip'` and pumps nothing. `finish()` runs on BOTH arms, because
            // the posture that most needs a line about work left queued is the one where nothing
            // drained.
            //
            // THE RULE MOVED INTO THE CALL (2026-08-27, CR-01). It used to be an `if` around
            // `drain({ lease: takeAcquiredLease() })`, which meant the lease was acquired out here
            // — before `drain()` had resolved a root or composed a host, either of which can
            // throw, and neither of which could then release what this line had already minted.
            // The take now happens inside the pump's own try, so the skip has to be stated rather
            // than performed.
            //
            // DEFERRED IMPORT, for the reason the drive's own is: `post-run-tail.ts` imports THIS
            // file statically (`composeCliLocalAgent`), so a static import back would close an
            // ESM cycle at module-evaluation time.
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
        // ONE NARROW CATCH, AND IT CONVERTS EXACTLY ONE THING (D-03).
        //
        // Everything raised before a session exists — a production refusal, a refused field, an
        // input error, a crash — re-throws untouched. What is converted is a run that STARTED and then surfaced a
        // member's framework error: the drive re-raises that to preserve `agent-qa run`'s exit-2
        // contract, but this door is answering `runs.start`, whose ack is a START and not an
        // outcome. The retired child said the same thing by ignoring its own exit code —
        // `createCliRunExecution`'s header: "the child's exit code is deliberately NOT the verdict
        // on whether a run happened". Letting it propagate would reject the acknowledgment for
        // exactly the runs that left a full durable record, and the composition's evidence check
        // (`RunProducedNoEventsError`) is what decides whether one did.
        //
        // Measured: without this, a `runs.start` whose member cannot find a browser binary rejects
        // with the browser error while `events.jsonl` and `handoff.json` sit on disk.
        if (startedRunId === undefined) throw error
        warn(`Run ${startedRunId} failed: ${error instanceof Error ? error.message : String(error)}`)
        return { runId: startedRunId as RunId }
      } finally {
        runRecord.close()
      }
    },
  }
}

export interface ComposeCliLocalAgentInput {
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. */
  agentQaRoot: string
  /**
   * The context every policy decision in this host's registry is taken in (400-01, D-05).
   *
   * A PASSTHROUGH of the shared composition's own new input, and it is here rather than pinned on
   * the process for the reason that field states at length: `setActiveExecutionContextResolver` is
   * a process global, and the dashboard door's posture is a property of a SERVER (its confirm
   * channel is live, or it is not) rather than of the machine the server runs on. Absent leaves
   * the shipped ambient resolver, which is every other CLI invocation.
   */
  resolveExecutionContext?: ComposeLocalAgentInput['resolveExecutionContext']
  /**
   * Notified after one session event has been appended (400-01, D-03), passed through untouched.
   *
   * `agent-qa chat` binds it to learn which session is active; an absent observer is the shipped
   * state for every other CLI invocation. See the shared composition's own field for why this is an
   * observer over the one log rather than a replaceable log.
   */
  observeSessionEvent?: ComposeLocalAgentInput['observeSessionEvent']
  // 2026-10-01 (432-17, D-05): `mintingSurface` is deleted with the proposal records it stamped.
  /**
   * How this host reads configuration, MASKED (400-01, D-16).
   *
   * A passthrough with a default rather than a required argument, because there is exactly one
   * right answer for a CLI — {@link createConfigReader} over this invocation's config path —
   * and one host that needs to say something more: `agent-qa dashboard` composes a host whose
   * `services.dashboard.baseUrl` is the origin the server actually bound, so the entity cards a
   * conversation in that browser renders carry working links with no user setup (387 D-10's config
   * knob, supplied by the second of its two suppliers). It is an OVERLAY over this reader in that
   * host and never a replacement: the declared mask and the layer precedence stay where they are.
   */
  config?: ComposeLocalAgentInput['config']
  /**
   * Where a chat session PRINTS a mid-turn artifact a person reads (395-13, D-14), passed through
   * untouched.
   *
   * The same split as the line above: this host knows whether there is a stream to write on, and
   * the shared composition knows what a turn is. Absent leaves the engine rendering nothing, which
   * is every non-chat CLI invocation.
   */
  chatPresent?: ComposeLocalAgentInput['chatPresent']
  /**
   * What a chat session plans with (392 plan 09, CHAT-06 / D-04), passed through untouched.
   *
   * RESOLVED BY THE CALLER, NOT HERE, and the reason is mechanical rather than stylistic: this
   * function is synchronous, and reaching a provider costs a configuration read and an auth
   * resolution. `resolveCliChatCapabilities` is that resolution, and it is paid once when a
   * conversation opens — never by `agent-qa fn --list`, and never by a host that only lists the
   * registry (the `model` factory's own laziness rule, applied to a surface that cannot defer).
   *
   * All three are conditionally spread, so a project with no usable LLM configuration composes a
   * HEADLESS host: canonical utterances still route deterministically and anything else fails the
   * turn closed by name (D-08). Absence is a posture, not an unconfigured state.
   */
  chatModel?: ComposeLocalAgentInput['chatModel']
  chatModelFor?: ComposeLocalAgentInput['chatModelFor']
  chatAccounting?: ComposeLocalAgentInput['chatAccounting']
  /**
   * The turn engine's reconciliation strategy (392 plan 10, D-16), passed through untouched.
   *
   * A PASSTHROUGH OF A COMPOSITION-ONLY SEAM, and both halves of that matter. `composeLocalAgent`
   * declares this option so the mutation proof can assemble the REAL engine twice — deterministic
   * override on, override off — and read the difference off a named compound scenario. The live
   * arm of that proof needs a real model, and the only resolution that produces one is this
   * host's; without this line the differential would have to re-derive a host beside the one
   * production uses, which is exactly the lookalike-assembly failure the proof exists to exclude.
   *
   * IT IS NOT, AND MUST NEVER BECOME, CONFIG-REACHABLE. No key of the project configuration names
   * it, no environment variable selects it, and `strategy-config-unreachable.test.ts` asserts both.
   * This interface is a CALL SIGNATURE — a caller already holding the code that composes the host
   * — and widening it grants nothing a caller could not do by calling `composeLocalAgent` itself.
   * Absent leaves the shipped deterministic override in place, which is what makes the absence the
   * safe default rather than an unconfigured state.
   */
  chatReconcile?: ComposeLocalAgentInput['chatReconcile']
  /** The configuration file this invocation resolves against. */
  configPath: string
  // 2026-10-14 (441-06, D-08): the command's one loader, shared with its emitters.
  declaredSecrets?: DeclaredSecretMask
  /**
   * The invocation's composed analytics, when this host has any (398-10, D-11/D-18).
   *
   * PASSED IN, never composed here, for the reason every other capability on this interface is:
   * the opt-out decision belongs to the command's composition root and there is one per process.
   * Absent is a real posture — `agent-qa fn --list` composes a host and emits nothing — and the
   * counter hooks below are then simply unbound, which is what they were built to tolerate.
   */
  analytics?: CliAnalyticsHost
  /**
   * How this invocation executes a run (D-16). Defaults to re-entering `agent-qa run`; a test
   * substitutes the child launcher so the whole path — gate, binding, evidence, acknowledgment
   * — is exercised without a browser and a provider behind it.
   */
  runExecution?: RunExecutionPort
  /**
   * The D-09 RUN BRIDGE: what a host that watches its own runs needs from them (401-07, INVK-01).
   *
   * ONE OPTION, because its members are one story — a host that bridges a run's bus to a surface
   * also lends its runs.db handle and, if it leases devices, that run's device. A door that wants
   * none of it passes nothing; the dashboard is the only door that wants any of it today.
   *
   * IT IS A PASS-THROUGH, NOT A DECISION. Every member but `record` is handed to
   * `runInProcessCliRun` as the option of the same name; `record` is lent to the run's record. This
   * host adds nothing and defaults nothing — `onSession` in
   * particular is CHAINED onto the door's own local capture rather than replacing it, because that
   * capture is what the ack-law catch below reads to tell a started run from one that never began.
   */
  runBridge?: {
    /** Fired with each started `RunSession` — the D-09 bridge hook. */
    readonly onSession?: (session: RunSession) => void
    /** The host's runs.db handle and its queue's rows (443-05, D-06). */
    readonly record?: RunRecordHostBinding
    /** The Appium this host leased for a named run, if it leases any. */
    readonly resolveAppiumUrl?: InProcessCliRunExecutionOptions['resolveAppiumUrl']
    /** Per-run flags this host's own UI offers that the request DTO has no field for. */
    readonly resolveRunFlags?: InProcessCliRunExecutionOptions['resolveRunFlags']
    /**
     * This host's SECOND chip sink (404 D-16) — the dashboard's live push channel.
     *
     * A PASS-THROUGH LIKE ITS FOUR SIBLINGS: this composition neither creates nor defaults it. It
     * is handed to `composeCliPostRunTail` as `relay`, which threads it to the chip emitter in
     * 404-05. A host that watches its own runs' chips supplies one; every other door passes
     * nothing and the emitter writes only to `events.jsonl`, exactly as it does today.
     */
    readonly chipRelay?: (envelope: RunEventEnvelope) => void
  }
  /** The `agent-qa.trigger` this host's runs record outside any `withRunDoor` scope (443-06, D-10). */
  runTrigger?: RunAttributeTrigger
  /**
   * 403 D-03: the live-view mint seam, FORWARDED UNTOUCHED to `composeLocalAgent`.
   *
   * A pass-through like `runBridge` above: this host neither creates nor defaults it. The dashboard
   * command composes it (it is the only door with a served origin); every other caller passes
   * nothing and `runs.liveurl` lists `unbound` by name.
   */
  liveView?: ComposeLocalAgentInput['liveView']
  /**
   * 405 D-03: the durable run-detail projection read, FORWARDED UNTOUCHED to `composeLocalAgent`.
   *
   * The dashboard passes the reader over the database it holds. When nothing is passed, this host
   * binds a reader over the configured or default runs database path whenever its config parses; a
   * read made before that file exists answers not recorded in the runs database. A config the
   * resolver refuses binds nothing.
   */
  runDetail?: ComposeLocalAgentInput['runDetail']
  /**
   * 432-12 (D-05): how a direct knowledge change reaches the writer-lease holder when one is alive
   * (387-08 D-18). Defaults to the 386 `/invoke` transport, VERBATIM — no new protocol and no change
   * on the daemon side — invoking the change op on the daemon with the same operation identity. A
   * test substitutes it to exercise the routing without a socket.
   */
  knowledgeChangeDelegate?: ExplicitReviewDelegate
  /**
   * 2026-10-02 (quick 261002-mrk): how a mark reaches a live writer-lease holder. Defaults to
   * {@link delegateMarkViaDaemon} (the 386 `/invoke` transport, the registered `runs.mark` op).
   */
  wholeMarkDelegate?: WholeMarkDelegate
  /**
   * The queue's model capability. Defaults to the project's configured job model.
   *
   * Overridable because the post-run tail (388-02) opens the queue for work that authors
   * through no provider at all, and eagerly resolving credentials it will never use would
   * make "no LLM configured" mean "no post-run chain".
   */
  model?: () => JobModelCapability | Promise<JobModelCapability>
  /**
   * The analyze-run author's compaction budget factory (389-06). Defaults to the SAME
   * named-config profile resolution the job model rides (`resolveCliAnalysisTokenBudget`
   * — one source of truth, 386 D-15), resolved once at queue open by the shared
   * composition. Overridable for the same reason `model` is: a harness substitutes it to
   * exercise the ladder without a configuration file.
   */
  analysisTokenBudget?: ComposeLocalAgentInput['analysisTokenBudget']
  /**
   * What the post-run chain's real handlers may do (388 D-01).
   *
   * A passthrough, deliberately: `curateRun` needs the writer lease, a knowledge root and the
   * run's curation author, and the only place in this process where all three already meet is
   * the run tail that holds them. Composing one here would be a second assembly of the same
   * three facts.
   */
  postRun?: {
    curateRun: (input: {
      readonly runId: string
      readonly executionContext: unknown
      readonly deadlineMs?: number
    }) => Promise<{
      readonly curated: number
      readonly deprecated: number
      /** The fold's own completeness, carried rather than dropped (WR-03). */
      readonly complete: boolean
      readonly snapshot?: CurationSnapshot
      readonly reason?: string
    }>
    /**
     * REQUIRED wherever the binding is supplied (388-10, UF-388-01): what this binding does
     * with candidate prose. Passed through untouched — the shared composition owns what the
     * posture MEANS (see `CandidateProsePosture`), and this host only carries the caller's
     * declaration to it.
     */
    candidateProse: CandidateProsePosture
  }
}

/**
 * Compose the local host as the CLI supplies it.
 *
 * The four arguments are the four host decisions the shared composition refuses to make on a
 * host's behalf: which configuration is in force and how it is masked, where knowledge is served
 * from, which model a job authors with, and how a run is executed. Everything else — the runs
 * reader, the knowledge listing, the registry, the queue, the store — is the shared function, so
 * the CLI and 386's daemon cannot drift.
 *
 * The fourth is what makes `runs.start` BOUND in this host (D-16). Withhold it and the very same
 * composition lists the capability as `unbound` and refuses it by name, which is D-09's visible
 * state expressed as a fact about a host rather than as a literal on a spec.
 */
/**
 * The quarantine ledger's identity mint, pre-bound to one workspace's config directory (390-12).
 *
 * The committed `quarantine.jsonl` keys entries on a workspace-relative `filePath` and every reader
 * compares it with `===`, so the two human write verbs need the SAME recipe the run path mints with
 * — `workspaceRelativeIdentityPath`, resolved against the checkout root. The verbs cannot know that
 * root, so it is bound here, once, by the layer that does.
 *
 * IT LIVES IN THIS FILE ON PURPOSE, and the reason is the one this module's head already states for
 * the run-id minting beside it: the mint needs `@vostride/agent-qa-core`, the FUNC-02 surface
 * firewall forbids a `packages/cli` file naming core without an exact (file, specifier) ledger
 * entry, and that ledger only ever SHRINKS — new surface code can never join it. This file already
 * carries the entry (`surface-firewall-ledger.ts`, cleared by 395), so the placement mints no new
 * debt. The daemon host reaches it through the same deferred import it already uses for the run
 * executor, which also keeps the CLI composition graph out of a configPath-less legacy host.
 *
 * The returned closure throws for a path that escapes the config directory — the mint's own
 * contract — and the verbs surface that as `QuarantineIdentityRefusedError`.
 */
export function createQuarantineIdentityMint(configPath: string): (filePath: string) => string {
  // The same derivation the `knowledgeRoot` closure below performs, spelled once per call site.
  const configDir = dirname(resolve(configPath))
  return (filePath: string) => workspaceRelativeIdentityPath(configDir, filePath)
}

/**
 * A parsed test's NL step text, pre-interpolation.
 *
 * PRE-interpolation and never post: a resolved step can carry the value a `${VAR}` expanded to, and
 * both the receipt's step table and gate 3's text lane are read by humans and stored on disk
 * (D-19 / T-393-02). The parser's step is `string | { step, ... }`; the object form's own `step`
 * field is the same sentence, so both narrow to one text.
 */
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

/**
 * The host half of `authoring.draft.verify` (393 D-01), pre-bound to one workspace.
 *
 * IT LIVES IN THIS FILE ON PURPOSE, for the reason the identity mint above and the run-id minting
 * before it already state: both verbs need `@vostride/agent-qa-core` — `parseTestFile`,
 * `workspaceRelativeIdentityPath`, `resolveWorkspacePaths`/`discoverWorkspaceFiles` — the FUNC-02
 * surface firewall forbids a `packages/cli` file naming core without an exact (file, specifier)
 * ledger entry, and that ledger only ever SHRINKS: new surface code can never join it. This file
 * already carries the entry (cleared by 395), so the placement mints no new debt. The daemon host
 * reaches this factory through the same deferred import it already uses for the run executor and
 * the identity mint.
 *
 * THE BOUNDARY CHECK IS `workspaceRelativeIdentityPath` AND NOTHING ELSE (T-393-01). It resolves
 * the caller's path against the checkout root and THROWS when the result escapes, so the refusal
 * and the identity are the same computation — a draft whose identity cannot be minted is exactly a
 * draft that is not in this workspace, and there is no second rule to keep in step. That the mint
 * is also the spelling the runner records on `PerTestOutcome.filePath` is what makes gates 1-2 able
 * to find the draft's own member at all.
 */
/**
 * A scope-less authoring call the host cannot answer unambiguously (394-26, WINDOWS 110 · D-19).
 *
 * IT NAMES EVERY CANDIDATE IT SAW, which is the whole difference between this and returning
 * `undefined`. A refusal that says only "ambiguous" leaves the author with no way to write the
 * `scope` that would have worked, and the host is the only side that knows what the alternatives
 * were. Zero candidates uses the same class: "this project configures no targets" and "it
 * configures several" are both answers of the form "there is no unique product here".
 */
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

/**
 * WHICH PRODUCT THIS PROJECT AUTHORS FOR, when the caller named no scope (394-26, WINDOWS 110).
 *
 * THE ONE DERIVATION, and both hosts reach exactly it: the CLI `fn` surface and the chat/daemon
 * host both build their authoring capability from `createDraftAuthoringPort` below, which
 * delegates here. A second resolver — a planner-side default, an utterance parser, a chat-side
 * stamp — would be a redundant mechanism second-guessing this one, and the two would be free to
 * answer differently for one workspace.
 *
 * THE PRODUCT MAPPING IS `agent-qa run`'S OWN. `resolveTarget` answers a target's `product` when
 * it has one and the target name otherwise, so the scope a draft is authored for is the scope its
 * gate runs are attributed under. A mapping spelled here would be a second arithmetic for one
 * number.
 *
 * THE WORKSPACE NARROWS THE CONFIG, and only when it has something to say. A project may declare
 * several targets and commit tests against one of them; that project has an unambiguous answer
 * the config alone cannot give. A project with nothing committed falls back to the configured
 * targets, which is what makes the very first authored test in a fresh checkout reachable at all.
 *
 * DISCOVERY IS ADVISORY, on `suiteTextCorpus`'s stated posture one function down: an unreadable
 * or unparsable file is omitted rather than raised, because one broken test must not make
 * authoring unreachable. The direction the omission moves the candidate set is the safe one — it
 * can only shrink it, and a shrunken set still has to survive the singleton check below.
 *
 * AMBIGUITY REFUSES AND NAMES ITS EVIDENCE (D-19). A unique candidate binds; zero or several
 * throw {@link AuthoringScopeUnresolvableError}. Picking the first would author a test for
 * whichever product happened to sort first in a config file.
 */
export async function deriveDefaultAuthoringScope(configPath: string): Promise<ScopeKey> {
  const config = await resolveConfig({ configPath, loadAuthPlugins: false })
  // THROUGH THE SHIPPED ENUMERATION (394-37, IN-03). This read used to be an untyped cast of its
  // own, which made three spellings of `registry.targets` in one file — and `configuredTargetNames`
  // below already imports `listTargets` and argues, in its own doc block, that a second walk of the
  // config is a second answer to what a target may be called.
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

      // READ ONCE, AS BYTES (394-29, CR-02). The digest below is the ONE value the apply's own
      // re-check is compared against, and that re-check hashes the target's raw bytes — so this
      // side reads bytes too and the decoding is derived FROM them for the parse alone. Reading the
      // file twice (once decoded, once raw) would be a second read of a file that can change
      // between them; deriving the string from these bytes cannot disagree with them.
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
          // Read here since 394-15 and DROPPED until 394-37: the compile stage's vocabulary check
          // is the one consumer, and it can only exist if the parse carries the value out.
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

    /**
     * Stage a compiled draft: PARSE first, WRITE second, and nothing at all when the parse fails
     * (394 D-01 · T-394-06).
     *
     * The order is the whole verb. What arrives here is bytes an LLM produced from a free-text
     * intent — the one input on the authoring path no schema at the op boundary can vet — so it is
     * put through the SAME `parseTestFile` + `singleDraftTest` pair a committed draft goes through
     * above, and only bytes that survived that become a file. A caller cannot reverse the two,
     * because there is only the one verb.
     *
     * PARSED UNDER THE PATH IT WILL LIVE AT, which is why the digest is computed before the parse
     * rather than after: the shelf path is minted from the digest, and the parser is handed that
     * path so any position an error names — and the `filePath` gates 1-2 later join on — is the
     * path the draft actually occupies. Parsing under a placeholder and re-parsing after the write
     * would be two parses of one file with two chances to disagree.
     */
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
          // The value WR-04's guard compares, off the same parse that decided these bytes are a
          // test at all — so the check runs against what the shelf really wrote, not against what
          // the model's text appeared to say.
          target: test.target,
          steps: draftStepTexts(test),
          // As above: an editable root the gate scans. A stage that dropped it would re-open the
          // blind spot for every patched draft, which is the path a repair patch takes.
          ...(test.context === undefined ? {} : { context: test.context }),
          contentDigest,
        },
      }
    },

    /**
     * Apply an RFC-6902 patch set to a staged draft and stage the result (394-06 D-09/D-20).
     *
     * THE ONE APPLIER, AND THE ONLY PLACE IT IS REACHED FROM THE AUTHORING PATH. `agent` declares
     * the capability as a shelf verb because it may not depend on `core`; this is where the
     * dependency actually exists, which is the same reason `stageDraft` above lives here.
     *
     * IT GOES THROUGH `stageDraft`, not around it. The rendered bytes are handed back to the
     * same parse-then-write verb a fresh compile uses, so a patched document that no longer
     * parses is refused with nothing written, and the new draft's digest is over the bytes that
     * were actually stored — which is the whole of `DraftRef.contentDigest`'s promise that a later
     * edit cannot inherit an earlier receipt.
     *
     * EVERY REFUSAL THE APPLIER RAISES BECOMES `unparsable` DATA. A pointer outside the editable
     * region, an unresolvable path, a collection where a scalar was required: all of them are
     * things a MODEL emitted, so they are ordinary answers rather than faults of this host, and
     * the repair loop's own accounting is what decides what to do about one.
     */
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

    /** 432 D-06/D-07: the direct final-test writer — see {@link publishAuthoredTest}. */
    publishDraft(request): Promise<TestFileWrite> {
      // 261002-mrk: inside a mark's edit scope the write is recorded ahead, so a retry of that mark
      // answers it instead of editing the file again. Outside one this records nothing.
      return Promise.resolve(
        publishAuthoredTest({ configPath, request, beforeWrite: recordMarkEditAhead }),
      )
    },

    /**
     * The authored-test universe as text — gate 3's text-lane population before the derived index
     * subtracts the identities it has evidence for (D-16).
     *
     * ADVISORY BY CONSTRUCTION, exactly as `discoverAuthoringKnownTests` is: an unreadable or
     * malformed file is omitted rather than raised, because one broken test file in a repository
     * must not make every draft unverifiable. The direction that omission moves gate 3 is the safe
     * one — a smaller corpus can only make a draft look MORE novel, never less, and the gate's
     * primary lane is unaffected.
     *
     * Resolved per call rather than cached: an evaluation is rare and a stale suite listing would
     * compare a draft against a repository that no longer exists.
     */
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

    /**
     * The `target` vocabulary stage 3 chooses from (394-33, WR-07).
     *
     * `listTargets` AND NOT A SECOND ENUMERATION. It is the same read `agent-qa targets` prints
     * and the same `registry.targets` map `resolveTarget` resolves against, so the names a model
     * is offered are exactly the names a run can be started for. A second walk of the config here
     * would be a second answer to "what may a `target` say", free to drift from the one the runner
     * actually honours — and drift is precisely what WR-07 is about.
     *
     * NAMES, NOT PRODUCTS, and the distinction is the defect. `deriveDefaultAuthoringScope` above
     * answers a PRODUCT (`resolveTarget(...).product`, i.e. `target.product ?? targetName`), and
     * on a project where a target declares a product under a different name the two differ — so a
     * stage that read the scope key as a target would emit a value this config does not declare.
     *
     * Resolved per call, on `suiteTextCorpus`'s stated reason one function up: authoring is rare
     * and a cached target list would serve a vocabulary the config no longer has.
     */
    async configuredTargetNames(): Promise<readonly string[]> {
      const config = await resolveConfig({ configPath, loadAuthPlugins: false })
      return listTargets(config).map((target) => target.name)
    },
  }
}

// THE DRAFT SHELF: where an authored draft lives so that a run can actually verify it (394,
// WTST-01). `tests/.agent-qa-drafts/`, and deliberately NOT `.agent-qa/drafts/`. The location is
// forced by a TWO-SIDED admission property that only a dot-directory inside the workspace's own
// test patterns satisfies, and both sides were measured against the in-tree glob@13.0.6 on
// 2026-08-11:
//
//   ADMITTED BY A RUN. `runs.start` hands its `patterns` to `resolveWorkspaceFileTarget`, which
//   THROWS `Workspace test file is not matched by configured workspace patterns` for anything
//   `workspace.testMatch` does not match. Against the house pattern tests/**/*.yaml, `globToRegex`
//   compiles the globstar segment to `(?:.*/)?` and the star to `[^/]*`, giving
//   ^tests/(?:.*/)?[^/]*\.yaml$ — which MATCHES tests/.agent-qa-drafts/<digest>.yaml. A shelf
//   under .agent-qa/ matches nothing, so the loop could never verify a draft there at all.
//
//   INVISIBLE TO DISCOVERY. `discoverWorkspaceFiles` calls glob(patterns, {cwd, ignore, absolute,
//   nodir}) and passes NO `dot` option; glob@13.0.6 defaults dot:false. Measured on one workspace
//   holding both files: ['tests/real/t.yaml'] without it, and both paths with dot:true. THE
//   LEADING DOT IS THE WHOLE MECHANISM — suite discovery, gate 3's corpus enumeration and a bare
//   `agent-qa run` never see a draft because of it. If dot:true is ever passed at that call site,
//   drafts join the suite and this shelf has to move.
//
// It lives in THIS file for the reason the draft port above already states: the boundary check is
// `workspaceRelativeIdentityPath`, that needs `@vostride/agent-qa-core`, and the FUNC-02 ledger
// entry this file already carries is the only one that will ever exist for it.
export const DRAFT_SHELF_PARENT = 'tests'
export const DRAFT_SHELF_DIR_NAME = '.agent-qa-drafts'

/** The durable name shape, and the in-flight sibling that is never a draft. */
const DRAFT_SUFFIX = '.yaml'
const DRAFT_TEMP_SUFFIX = '.tmp'

/**
 * The digest shapes this shelf will turn into a path.
 *
 * IN-03 applied where the joining happens, verbatim from `draft-receipts-store.ts`: a
 * `contentDigest` arrives from a caller and becomes a filename two lines later, so a value
 * carrying `../` would be a caller-supplied arbitrary-path primitive. Wider than sha256-hex
 * because the DTO promises only a non-empty string, narrow enough that no member can name a path
 * separator, a parent directory or a hidden file.
 */
const SAFE_DRAFT_DIGEST = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The shelf's one named refusal (T-394-02).
 *
 * ONE class for both rules because they are one rule seen twice: a digest that can name a path and
 * a path that escapes the workspace are the same failure — an address this workspace cannot own.
 * `reason` says which check fired without splitting the vocabulary a caller has to handle.
 */
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

/**
 * Write bytes atomically: full content to a PID-suffixed sibling, fsync, durable rename.
 *
 * The proposals-store / receipts-store posture wholesale, and the pid is the same load-bearing
 * detail — a shared temp name would make the rename's atomicity irrelevant, because the bytes
 * being renamed could be half of another process's draft. Two concurrent `authoring.draft.write`
 * calls in one workspace therefore never collide and never expose a half-written draft to a run.
 *
 * ONE PRIMITIVE, TWO CALLERS (394-23). The draft shelf and the one-commit apply's target write are
 * the same obligation — the bytes appear whole or they do not appear — and a second implementation
 * of it beside this one is the shape every other header in this file argues against. `string |
 * Buffer` because the apply is byte-true end to end (WR-04) while the shelf writes text; the
 * encoding argument is gone, so a Buffer is written as itself and a string as UTF-8.
 *
 * THE TEMP IS REMOVED ON EVERY FAILURE PATH, and it matters more for the apply than for the shelf.
 * The shelf lives in a gitignored directory; the target's sibling temp would sit UNTRACKED next to
 * a person's committed test suite, showing up in their `git status` as litter this product left
 * behind immediately after telling them nothing had been written. Best-effort, because a cleanup
 * that threw would replace the error that says why the write failed with one about the tidying up.
 */
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
  /** Runs after the digest guard and before the write; a throw refuses the write (261002-mrk). */
  readonly beforeWrite?: (write: PendingTestWrite) => void
}

/**
 * Write a final authored test straight to its target (432 D-06/D-07). No git, no commit, no stage.
 *
 * THE GUARDS ARE THE ONES THE RETIRED ONE-COMMIT APPLY CHECKED, minus the ones that were about git.
 * The target's boundary is `workspaceRelativeIdentityPath` plus the real path, so neither `..` nor a
 * symlinked directory carries a write out of the workspace. The target must still hold exactly the
 * bytes the caller read — raw bytes, never their decoding (394-29's rule) — or, for a new test, not
 * exist at all. There is no dirty-tree refusal and no need for a repository: the result is a plain
 * uncommitted edit that `git status` shows and `git restore` or deleting the file reverts.
 *
 * THE WRITE IS {@link writeFileAtomically}: a sibling temp, fsync, rename, the temp removed on
 * every failure. So a failed write leaves the target as it was, and it is answered as `not-written`
 * with the writer's own error text — never as `written`.
 *
 * WHAT IS NOT CLAIMED: the digest re-check and the rename are not one atomic step, and nothing here
 * locks against a concurrent writer between them — the same lock-free assumption the apply made.
 */
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

// 395-04: the pinned config file SET's enumeration MOVED to `schema`
// (`config-mutation/file-set.ts`), and the move is the point rather than tidiness. Three packages
// read that one answer — this port enumerates the files it reads bytes for, `agent`'s cross-boundary
// classifier decides `out-of-set-path` against it, and 395-06's apply porcelain scoped its check to
// it until 432-16 deleted the apply — and `agent` may not import `cli`. A copy on either side would fail in the PERMISSIVE
// direction and silently, the day the set grew a member. The two names and the retune note live
// beside the function.

/**
 * This workspace's pinned config set, resolved per read (395-06).
 *
 * `createConfigFilesPort` reads bytes for these members and hands their paths to the classifier as
 * `pinnedFileSet`. The one-commit apply that scoped its preserve commit to the same answer is
 * deleted (432-16, D-07), so this is its only caller.
 *
 * IT READS THE CONFIG BECAUSE THE SET DEPENDS ON THE CONFIG. `workspace.hooksFile` can name
 * anything, so the enumeration's second member is a fact only a parse can supply.
 */
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
    // NAMED, NOT MATCHED (395-05). `config.hook.add` writes this member and the validator picks its
    // schema by it. The default is read from the SAME enumeration, so a project that names no hooks
    // file and one that names `hooks.yaml` explicitly answer identically here.
    hooksFile: named === undefined || named === '' ? CONFIG_SET_DEFAULT_HOOKS_FILE : named,
    members,
  }
}

/**
 * Read the committed config set as RAW BYTES, and perform the comment-preserving field edit.
 *
 * THE READ IS BYTES AND NEVER TEXT (D-17). A decode between the file and the digest taken over it
 * is 394's CR-02 defect class in its original form.
 *
 * THE EDIT LIVES HERE rather than in the construction pipeline because the `yaml` Document API is
 * an external dependency `packages/agent`'s ownership contract does not admit — its
 * `externalDependencies` are exactly `['ai', 'zod']`, reconciled against package.json by
 * `validate:arch`. Admitting one so the edit could move in-layer would have widened a boundary
 * rather than respected it, and the edit is a fact about the FILE FORMAT, which this host already
 * owns.
 *
 * `parseDocument` → `setIn` → `toString` is the shipped `agent-qa config set` idiom
 * (`commands/config.ts:71-82`) and it is load-bearing rather than stylistic: a
 * parse→object→stringify round trip destroys every comment in the comment-dense house config and
 * widens the rendered diff past the point a person can review it — which is the whole of what
 * CFGM-01 asks a proposal to be.
 */
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

    /**
     * The document's SHAPE at each path, from ONE parse (395-05).
     *
     * SHAPE AND NEVER CONTENT. `keys` and `length` describe the container so a create can refuse a
     * collision, an edit can list the names that exist and an append can land past the end; the
     * values inside are not returned, because a port that answered "what is at this path" would be
     * the unmasked config reader `ConfigReaderPort`'s header says must not exist, reached through
     * the back door of a mutation helper.
     */
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

    /**
     * A fresh canonical hook id, from the ONE mint `isCanonicalHookId` accepts (395-05).
     *
     * A HOST FACT because `@vostride/agent-qa-ids` is not among `packages/agent`'s internal
     * dependencies and because the mint draws randomness, which nothing in that package may read.
     * Calling `generateHookId` rather than formatting `h_` plus ten words here is the difference
     * between an id the hooks schema accepts and one it refuses at the next run.
     */
    mintHookId(): string {
      return generateHookId()
    },

    setField({ bytes, path, value }): Promise<ConfigFieldSetResult> {
      const document = bytes === undefined
        ? new YamlDocument({})
        : parseDocument(Buffer.from(bytes).toString('utf8'))
      const segments = path.split('.')
      // READ BEFORE WRITE, THROUGH THE SAME DOCUMENT (395-04, D-02). The classifier compares the
      // value this edit replaces against the one it writes — a base URL pointing at a NEW origin is
      // the case no per-op map can see — and the alternative to reading it here was a second parse
      // of the same bytes, free to disagree with the one that actually applied the edit.
      //
      // SCALARS ONLY, and the narrowing is honest rather than lossy: `getIn` with `keepScalar` false
      // answers a JS value, which for a map or a sequence is an object. "There was no scalar there"
      // is the true statement about what a wholesale subtree replacement replaced, and such an edit
      // is flagged on its own grounds (secret-adjacency) rather than by pretending it had one.
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

/**
 * Whole-config validation, run BEFORE a proposal surfaces (CFGM-01).
 *
 * IT VALIDATES THE ENTIRE CANDIDATE, not the changed field, and that is D-03's other half: the
 * settable-field whitelist was refused because a rule that can only refuse what it can NAME cannot
 * be driven to zero by naming more things, so the guard has to be whole-input by construction. This
 * one is: `AgentQaConfigSchema` is the project's own schema including its cross-field refinements,
 * so a mutation that is locally plausible and globally wrong — a `use.llm` naming a registry entry
 * that does not exist — is refused here rather than at the next run.
 *
 * A PORT because the schema lives in `@vostride/agent-qa-core` and `packages/agent` does not depend
 * on it; `validate:arch` reds that edge with no legal repair. The `draftApply` idiom exactly.
 *
 * 395-05: THE CANDIDATE IS THE WHOLE FILE SET, NOT THE CONFIG YAML. `config.hook.add` changes only
 * the hooks file, and a validator that only ever read the config yaml would have declared that
 * proposal valid without looking at the one artifact it wrote — the whole-input law satisfied on
 * paper and violated in fact. Each member is validated against the schema that OWNS it: the config
 * yaml against `AgentQaConfigSchema`, the hooks file against `core`'s `HooksFileSchema` (which is
 * where the canonical `h_` id rule and the duplicate-id/duplicate-name refinements live). A member
 * with no schema — `.gitignore` is in the set — is passed over rather than guessed at.
 *
 * A CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: a project whose committed hooks file is
 * already invalid now has every config proposal blocked with that file's issues, not only its hook
 * additions. That is the same posture D-12 takes for a secret a human committed — the whole input is
 * the whole input — and the blocked record names the file, so the person is told what to fix.
 */
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
          // A yaml the parser cannot read is a validation failure and not a crash: the candidate
          // came from a mutation this product made, so the person is owed the reason rather than a
          // stack trace out of a library.
          //
          // WHERE, NEVER WHAT (395-10 · GAP 1). This line used to interpolate the thrown error's
          // own text, and the vendored `yaml` package pretty-prints a parse error with an excerpt of
          // the offending source line and a caret under the column. That excerpt is the person's own
          // file content, it reaches the blocked refusal every surface prints (and, before 432-11,
          // the persisted blocked record), and it was measured carrying a planted credential onto
          // all three surfaces. The error's
          // POSITION is the one fact this product chose to publish, so the position is the only
          // thing read off the error — not its message, not its code, not its stringification.
          issues.push({ path: member.path, message: yamlParseFailureMessage(error) })
          continue
        }

        if (isConfig) {
          // THE SAME THREE STEPS A REAL RUN TAKES — merge, normalize, parse (`resolveConfig`'s own
          // sequence). Validating the raw file against the resolved schema instead was measured
          // wrong during 395-01: `AgentQaConfigSchema` describes a COMPLETE configuration, so a
          // candidate that omitted the env layer would be refused for keys a run supplies. The env
          // overrides are included deliberately — "is this configuration valid" means valid for the
          // process that will read it, and a proposal refused for a key the environment provides
          // would be refusing a change that works.
          const merged = mergeConfigs(parsed ?? {}, loadEnvOverrides(), {})
          const result = AgentQaConfigSchema.safeParse(normalizeConfigForValidation(merged))
          // The validator's OWN words, joined to a path. This layer reports issues; it does not
          // classify them, because a closed issue vocabulary here would be a second, weaker copy of
          // core's refinements, out of date the first time one is added.
          if (!result.success) {
            // THE PATH IS THE FILE, the dotted config path stays inside the message. A schema issue
            // is about a key in a document, and the document is the config yaml member — which is
            // the fact the blocked record's `paths` needs (WR-11). Putting the dotted path there
            // instead would name something that is not a file and cannot be opened.
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

/**
 * The direct config writer (2026-09-30, 432-07 D-05/D-07): the only way a config change is written
 * since the one-commit apply it replaced was deleted (432-16).
 *
 * FIELD CHANGES go through the dashboard's `ConfigManager`, whose transaction rereads the file in
 * the config path's shared write turn: a co-hosted dashboard autosave and this writer take turns,
 * an outside edit to another field is kept, and a stale `expect` refuses. WHOLE FILES are checked
 * first (inside the workspace, not repeated, digest unchanged) and then written one by one, each
 * atomically and over the digest it was built from; a later failure reports exactly the files
 * already written. Nothing here runs git, stages or commits, so a dirty tree, staged work and a
 * directory with no repository are all ordinary.
 *
 * The dashboard package is imported when a write happens, not when a host is composed.
 */
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
        // 441 GAP3-D5: every planned file is checked before any is written.
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

/**
 * The shared scaffold CONTENT, rendered for the propose path (395-08, D-04 · CFGM-05).
 *
 * ONE PRODUCER, TWO WRITE PATHS, AND THIS IS THE SECOND ONE. `agent-qa init` calls the very same
 * functions and then writes the bytes to disk through its own filesystem machinery; this port calls
 * them and hands the bytes back so they can become a proposal's diff. There is no second copy of
 * the scaffold's substance anywhere, which is what makes D-04's no-drift claim a property of the
 * module graph rather than a promise — and it is why this lives in `cli` rather than in `agent`,
 * which may not import it.
 *
 * THE ENTRIES ARE `TARGET_GITIGNORE_ENTRIES`, IMPORTED. That constant is the default
 * `upsertManagedGitignoreBlock` writes, so a project scaffolded by proposal and one scaffolded by
 * `init` get the same managed block by construction. It is imported rather than restated for the
 * reason the whole module exists.
 *
 * NOTHING HERE TOUCHES THE FILESYSTEM. The existing `.gitignore`'s bytes arrive from the caller,
 * which read them through `ConfigFilesPortLike.read` — the same read the digests are taken over, so
 * the upsert composes against the bytes the apply will re-check rather than against a second read.
 */
export function createScaffoldContentPort(): ConfigScaffoldContentPortLike {
  return {
    render({ targetName, baseUrl, existingGitignore, existingConfig }) {
      // NO MODEL ENTRIES (2026-10-03, quick 261003-cpv, 432 review IN-09). The request carries a
      // domain only and a from-zero project has no model anywhere to read; D-13 forbids inventing
      // one. A from-zero scaffold is bare of `registry.llms`/`use.llm`; merge mode keeps the
      // person's own.
      const files = buildScaffoldFileSet({
        targetName,
        baseUrl,
        // THE HOST DEFAULTS, READ HERE (FUNC-02). `scaffold-content.ts` may not name
        // `@vostride/agent-qa-core`; this file is ledgered for it, so the two directory defaults
        // are resolved on this side and handed over — the same two values `init` passes.
        cacheDir: DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache',
        authStatesDir: DEFAULT_AGENT_QA_AUTH_STATES_DIR || '.agent-qa/auth-states',
        gitignoreEntries: TARGET_GITIGNORE_ENTRIES,
        ...(existingGitignore === undefined
          ? {}
          : { existingGitignore: Buffer.from(existingGitignore).toString('utf8') }),
        // 395-12: the MERGE mode's bytes, decoded here for the reason the gitignore's are — the
        // port speaks bytes because the digests are taken over bytes, and the content module is
        // text. The paths cross unchanged: they are the pinned set's own spelling, and a producer
        // that re-derived them could name a file outside the set.
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

/**
 * The target's RAW BYTES, or `undefined` for no such file (394-23, WR-04).
 *
 * NO ENCODING, and that is the whole content of this function beyond the ENOENT triage. The digest
 * taken over this value is compared against one the caller took over a file's bytes — a decode
 * here would make it a claim about a DECODING of the person's file rather than about the file.
 */
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
  // 432-13/432-16 (D-14): NO CONFIRM IS BUILT, and the input has no field to carry one. This host
  // used to resolve a door confirm for the op gate and the run gate — a terminal prompt by default.

  // Bound whenever the config parses; a read before the runs database exists answers not recorded in it and opens or creates nothing.
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
      // 2026-10-02 (quick 261002-mrk, 432-13 #1): a mark made while a live daemon holds the
      // writer lease goes to that daemon whole. The daemon's mark host binds no delegate.
      wholeMarkDelegate: input.wholeMarkDelegate ?? delegateMarkViaDaemon({
        agentQaRoot: input.agentQaRoot,
        resolveKnowledgeRoot: knowledgeRoot,
      }),
    }),
    // 423 D-19: a dedicated read host, so history never reaches the writer's lock, lease or draft path.
    // 423 D-16: its preview plans against this project's knowledge root with read capabilities only. The
    // writer above binds the authoring draft edit, so the preview reports a test edit where runs.mark drafts one.
    feedbackReads: createFeedbackReadsPortForHost({ agentQaRoot: input.agentQaRoot, configPath: input.configPath,
      canDraftTestEdit: true }),
    agentQaRoot: input.agentQaRoot,
    mintQuarantineIdentityPath: createQuarantineIdentityMint(input.configPath),
    // 401-05 (D-01/D-07): the default is the in-process policy-gated drive, and since 401-10 it is
    // the ONLY one — `createCliRunExecution`, the child spawn this host used to compose, is deleted
    // rather than merely unreferenced. `input.runExecution` stays the injectable override, which is
    // what cells substitute.
    runExecution: input.runExecution ?? createComposedRunExecution({
      configPath: input.configPath,
      agentQaRoot: input.agentQaRoot,
      resolveExecutionContext: input.resolveExecutionContext,
      ...(input.runBridge === undefined ? {} : { runBridge: input.runBridge }),
      ...(input.runTrigger === undefined ? {} : { runTrigger: input.runTrigger }),
      ...(analytics === undefined ? {} : { analytics }),
    }),
    // 403 D-03: the live-view mint seam, forwarded untouched on the same house rule.
    ...(input.liveView === undefined ? {} : { liveView: input.liveView }),
    // 405 D-03: the run-detail projection read, spread on the same house rule.
    ...(runDetail === undefined ? {} : { runDetail }),
    // 393 D-01: the keep-gate evaluator's host half, bound UNCONDITIONALLY on this host — a CLI
    // always has a config path, therefore a checkout root, therefore both verbs. Together with the
    // run executor one line up, this is what makes `authoring.draft.verify` read `bound` in this
    // composition's catalog; a host missing either would list it `unbound` BY NAME instead.
    draftAuthoring: createDraftAuthoringPort(input.configPath),
    // 432-16 (D-07): NO APPLY, UNDO-SOURCE OR TEST-DRAFT COMMIT PORT IS BOUND. agent-qa makes no git
    // commits: `draftApply`, `configApply` and `configUndoSource` were the one-commit writes and the
    // git-history read behind the pre-432 accept, apply and undo verbs, which 432-17 deleted.
    // Changes are written by the direct writers bound here.
    //
    // 395-01 D-01/D-03/D-17 · CFGM-01/03/04: the config editor's host ports, bound unconditionally
    // — a CLI always has a config path. They answer different questions: what bytes are on disk and
    // whether a candidate config is valid at all.
    configFiles: createConfigFilesPort(input.configPath),
    configValidate: createConfigValidatePort(),
    // 395-08 D-04 · CFGM-05: the shared scaffold content, bound unconditionally. It needs no
    // filesystem and no repository — it is a pure render of the one producer `agent-qa init` writes
    // from — so there is no host posture in which a CLI has it unavailable.
    scaffoldContent: createScaffoldContentPort(),
    // 432-07 D-05/D-07: the direct config writer every config change op writes through.
    configWrite: createConfigWritePort(input.configPath, declaredSecrets.mask),
    // 398 D-09/D-11 · XPLN-02: the catalog port `agent.explain` binds through, constructed HERE
    // and bound unconditionally — a CLI always ships beside the committed capability catalog, so
    // there is no CLI posture in which the capability is genuinely unavailable. Binding it here is
    // what puts `agent.explain` in every cli-hosted composition at once (385 D-15): the REPL, the
    // conformance census caller and the daemon reach one implementation, so "what can you do" has
    // one answer rather than one per surface.
    //
    // THE MODEL IS THE ONE THE CHAT HOST ALREADY RESOLVED, handed through rather than resolved
    // again — CHAT-06's rule, which is why the field is spread from `input.chatModel` instead of
    // calling a resolver. A second construction site would be a model call that skipped the
    // masking middleware and the profile resolution `createModel` owns. Its absence is a real
    // posture and not an unconfigured one: a project with no usable LLM configuration composes a
    // host whose explain cannot cite, so it abstains and SAYS SO, which is the honest answer.
    //
    // 398-10 (D-11/D-18): the counter hooks, bound to the composed port when this host has one.
    //
    // COUNTS ONLY, AND THE PORT'S SHAPE IS WHAT MAKES THAT TRUE RATHER THAN THIS COMMENT.
    // `onAnswered` takes nothing at all — `recordAnswered()` has no parameters, so this host is
    // never told how many rows were cited and cannot report a number nobody counted; the union's
    // `cited_row_count` is optional precisely so the omission is representable. `onAbstained` is
    // handed two values and neither is text: a suggestion count and whether the catalog loaded
    // empty. The QUERY does not reach here and there is no field it could reach — it stays in the
    // local coverage log under `.agent-qa/`, which is the whole of D-11's arrangement.
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
    // 400-01 (D-05): forwarded untouched, conditionally spread on this file's own absent-field
    // rule so that a host supplying nothing composes exactly as it did before the option existed.
    ...(input.resolveExecutionContext === undefined
      ? {}
      : { resolveExecutionContext: input.resolveExecutionContext }),
    ...(input.observeSessionEvent === undefined
      ? {}
      : { observeSessionEvent: input.observeSessionEvent }),
    // 2026-10-01 (432-17, D-05/D-22): the proposal apply's delegate is deleted with the op. The
    // DAEMON's own composition supplies no delegate: it holds the lease, so its changes take the
    // in-process branch, and delegation cannot recurse by construction rather than by a guard.
    //
    // 432-12 (D-05): a direct knowledge change made while a live daemon holds the writer lease is
    // handed to that daemon as the SAME change op with the SAME operation identity, over the same
    // socket, and its answer is read back. Nothing is filed or claimed on either side; the daemon
    // applies with the authority it holds, and a retried identity lands once there too.
    knowledgeChangeDelegate: input.knowledgeChangeDelegate ?? delegateKnowledgeChangeViaDaemon({
      agentQaRoot: input.agentQaRoot,
      resolveKnowledgeRoot: knowledgeRoot,
    }),
    // Deferred, and never called by a host that only invokes a function op: the queue is opened by
    // `jobs()` and nothing else resolves a provider handle.
    model: input.model ?? (() => resolveCliJobModel(input.configPath)),
    // 389-06: the author's compaction budget, from the SAME profile resolution as the model
    // binding one line up (386 D-15) — deferred identically, resolved once at queue open,
    // and degrading to `undefined` (no ladder) when no LLM is configured.
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
    // 392 plan 09, CHAT-06: the chat model arrives ALREADY BUILT, through `createModel` at the
    // resolution one layer up. Conditionally spread, so a host without
    // one leaves the field ABSENT and the composition's own headless posture is what answers.
    ...(input.chatModel === undefined ? {} : { chatModel: input.chatModel }),
    ...(input.chatModelFor === undefined ? {} : { chatModelFor: input.chatModelFor }),
    ...(input.chatAccounting === undefined ? {} : { chatAccounting: input.chatAccounting }),
    // 392 plan 10, D-16: the reconciliation strategy, conditionally spread on the exact idiom of
    // the three chat options above. ABSENT must stay absent, because the composition's own
    // `?? deterministicOverrideStrategy` is where the safe default lives and a present-undefined
    // field would be a second place it could be decided.
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

/**
 * 432-12 (D-05): the CLI's delegate for a direct knowledge change a live daemon's lease covers.
 *
 * It invokes the verb's own change op on the daemon over the 386 `/invoke` socket, with the same
 * operation identity, and reads the daemon's answer back as the writer's result. The daemon holds
 * the lease and applies with its own authority; nothing is filed or claimed on either side. A mark
 * never reaches here: it changes knowledge through `runs.mark`.
 *
 * 2026-10-02 (quick 261002-hyg): the holder is classified first, as `delegateMarkViaDaemon` does.
 * A live daemon is invoked; a lease naming a registered daemon nobody answers for refuses with
 * `DaemonNotRunningError`; any other holder is another agent-qa process that is writing, and the
 * change refuses at once with `KnowledgeWriterLeaseBusyError`. It does not wait: knowledge-local
 * calls this from inside its held-lease branch, which cannot fall back to a local apply.
 */
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

/**
 * 2026-10-02 (261002-mrk follow-up): how long a mark waits for a writer lease held by an agent-qa
 * process that is not a daemon (a dashboard's post-run curation, another terminal's knowledge
 * change) before it refuses. Those holds last the length of one curation or one change, a few
 * seconds on a normal run, so 10 s covers them without making a stuck holder feel like a hang.
 */
export const MARK_LEASE_HOLDER_RELEASE_BUDGET_MS = 10_000
const MARK_LEASE_HOLDER_POLL_MS = 100

/**
 * 2026-10-02 (quick 261002-mrk, 432-13 #1): the CLI's delegate for a whole mark.
 *
 * Decided before the mark takes any lock, lease or write, from the writer lease and the daemon
 * registration:
 *  - no fresh lease: `undefined`, and the mark runs locally;
 *  - the holder is a live daemon: the same `runs.mark` call goes over `/invoke` and its answer is
 *    returned unchanged (the retry identity is the mark intent in the shared run ledger);
 *  - the lease names a registered daemon nobody answers for: `DaemonNotRunningError`;
 *  - any other holder is another agent-qa process: waited out for a bounded time, then the mark
 *    runs locally, or refuses with `MarkWriterLeaseBusyError` if the holder outlasts the budget.
 */
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

/**
 * 2026-10-02 (quick 261002-mrk): the mark host the writer-lease holder (the daemon) composes. Its
 * evidence and its fix commit with the held authority, and it binds no delegate.
 */
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
